// pages/api/webhook.js
import { createClient } from '@supabase/supabase-js';
import { executeTradeMCP } from '../../lib/execute-trade-mcp.js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Simple in-memory idempotency cache (per-process, best-effort)
const _idempotencyCache = new Map();
function _cleanupIdem(key) {
  const ts = _idempotencyCache.get(key);
  if (!ts) return;
  if (Date.now() - ts > 60 * 1000) {
    _idempotencyCache.delete(key);
  } else {
    setTimeout(() => _cleanupIdem(key), 30 * 1000);
  }
}

// 🟢 AM72 — LOUD-fail helpers. This handler previously had NO alert/log surface,
// which is exactly how a strategy trade could be silently demoted to PAPER on a
// config lookup miss. Both are best-effort (never throw into the request path).
async function sendDiscordAlert(tenantId, { title, description, color }) {
  if (!tenantId) return;
  try {
    const { data: settings } = await supabase
      .from('tenant_settings')
      .select('notification_webhook_url')
      .eq('tenant_id', tenantId)
      .single();
    const webhookUrl = settings?.notification_webhook_url || process.env.DISCORD_WEBHOOK_URL;
    if (!webhookUrl) return;
    const embed = { title, color, timestamp: new Date().toISOString() };
    // Discord embed description hard limit = 4096 chars.
    let desc = description || '';
    if (desc.length > 3800) {
      desc = desc.slice(0, 2000) + '\n\n…[truncated]…\n\n' + desc.slice(-1600);
    }
    embed.description = desc;
    await fetch(webhookUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    });
  } catch (e) {
    console.error('[WEBHOOK DISCORD ALERT] Failed:', e.message);
  }
}

async function logAgentActivity(tenantId, agentName, asset, logMessage, logType = 'ERROR') {
  try {
    await supabase.from('agent_session_logs').insert([{
      tenant_id: tenantId, agent_name: agentName, asset, log_message: logMessage,
      log_type: logType, timestamp: new Date().toISOString(),
    }]);
  } catch (e) {
    console.error('[WEBHOOK AGENT LOG] Failed:', e.message);
  }
}

export default async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).send("🛰️ Nexus Webhook Online.");

  if (req.method === 'POST') {
    try {
      let data = req.body;
      // Idempotency key handling: allow clients to supply a per-request key to avoid duplicate processing
      const idempotencyKey = (req.headers && req.headers['idempotency-key']) || data?.idempotency_key;
      if (idempotencyKey) {
        // Check in-memory cache to prevent duplicates (best-effort)
        if (_idempotencyCache.has(idempotencyKey)) {
          return res.status(200).json({ status: 'duplicate', idempotency_key: idempotencyKey, note: 'Duplicate within short window' });
        }
        _idempotencyCache.set(idempotencyKey, Date.now());
        _cleanupIdem(idempotencyKey);
      }
      const { tenant_id } = req.query; // Support multi-tenant isolation via query param

      if (!tenant_id) {
        console.error("[WEBHOOK ERROR]: Missing tenant_id in request query.");
        return res.status(400).json({ error: "Missing tenant_id in query parameters." });
      }

      // 1. Determine Mode from Dashboard for specific tenant and strategy
      const { data: config, error: configErr } = await supabase
        .from('strategy_config')
        .select('execution_mode')
        .eq('tenant_id', tenant_id)
        .eq('asset', data.symbol || data.ticker) // TradingView sometimes uses ticker
        .eq('strategy', data.strategy_id || 'MANUAL')
        .eq('is_active', true)
        .maybeSingle();

      if (configErr) {
          console.error("[WEBHOOK ERROR]: Could not fetch execution mode:", configErr.message);
          throw new Error("Could not fetch execution mode.");
      }

      // 🟢 AM72 — INVISIBLE-FALLBACK GUARD (the actual incident mechanism).
      // A STRATEGY trade (strategy_id present and != 'MANUAL') whose config lookup
      // MISSES must NEVER be silently demoted to PAPER. A miss means an asset-id
      // form mismatch, a strategy-name mismatch, or a stale duplicate — all of which
      // must fail LOUD so the operator sees it, not trade paper invisibly.
      // Manual/token trades without a strategy keep the PAPER default.
      const isStrategyTrade = !!data.strategy_id && data.strategy_id !== 'MANUAL';
      if (isStrategyTrade && !config) {
        const detail = `Webhook strategy trade could not resolve its strategy_config row — REFUSING to default to PAPER.\n**Tenant:** ${tenant_id}\n**Asset:** ${data.symbol || data.ticker}\n**Strategy:** ${data.strategy_id}\n**Cause:** no active strategy_config row matched (asset-id form mismatch, strategy-name mismatch, or stale duplicate).`;
        console.error(`[WEBHOOK config_not_found] ${detail}`);
        await sendDiscordAlert(tenant_id, {
          title: `🚨 Webhook config_not_found — trade REFUSED: ${data.symbol || data.ticker}`,
          description: detail,
          color: 15158332,
        });
        await logAgentActivity(tenant_id, 'Webhook', data.symbol || data.ticker, detail, 'CONFIG_NOT_FOUND');
        return res.status(200).json({
          status: 'config_not_found',
          reason: 'Strategy trade has no active strategy_config row; refusing to default to PAPER.',
          asset: data.symbol || data.ticker,
          strategy_id: data.strategy_id,
        });
      }

      const mode = config?.execution_mode || "PAPER";
      data.execution_mode = mode; 
      data.tenant_id = tenant_id; // Pass tenant_id to the engine

      // 🛡️ PHASE M: Ensure a stable idempotency key flows to the execute engine.
      // Order of preference:
      //   1. Explicit `Idempotency-Key` header (TradingView template can set this).
      //   2. data.idempotency_key already in the payload.
      //   3. Derived bucket key: tenant_id + strategy_id + symbol + side + 60s window.
      // The engine (executeTradeMCP) uses this to build a deterministic Coinbase
      // client_order_id so duplicate retries are rejected exchange-side.
      if (!data.idempotency_key) {
        if (idempotencyKey) {
          data.idempotency_key = idempotencyKey;
        } else {
          const sym = (data.symbol || 'NA').toString().toUpperCase().replace(/[^A-Z0-9]/g, '');
          const strat = (data.strategy_id || 'MANUAL').toString().toUpperCase().replace(/[^A-Z0-9]/g, '');
          const sd = (data.side || 'NA').toString().toUpperCase().replace(/[^A-Z0-9]/g, '');
          const bucket = Math.floor(Date.now() / 60000); // 60-second bucket
          // Hash-style compact key; the engine truncates to 24 safe chars for client_order_id.
          data.idempotency_key = `${tenant_id?.slice(0, 6) || 'tn'}_${strat.slice(0, 4)}_${sym.slice(0, 6)}_${sd[0] || 'X'}_${bucket}`;
        }
      }

      // 2. Direct call to Coinbase Engine (no HTTP, no exposed endpoint)
      console.log(`[ROUTER] Executing trade for ${data.symbol} (Tenant: ${tenant_id}, Mode: ${mode}, IdemKey: ${data.idempotency_key})`);

      const engineResult = await executeTradeMCP(data);

      return res.status(200).json({ 
        status: "success", 
        mode: mode, 
        engine_response: engineResult 
      });

    } catch (err) {
      console.error("[WEBHOOK FAULT]:", err.message);
      return res.status(500).json({ error: err.message });
    }
  }
}