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

      // 1. Determine Mode from Dashboard for specific tenant
      const { data: config, error: configErr } = await supabase
        .from('strategy_config')
        .select('execution_mode')
        .eq('tenant_id', tenant_id)
        .eq('is_active', true)
        .single();

      if (configErr && configErr.code !== 'PGRST116') {
          console.error("[WEBHOOK ERROR]: Could not fetch execution mode:", configErr.message);
          throw new Error("Could not fetch execution mode.");
      }

      const mode = config?.execution_mode || "PAPER";
      data.execution_mode = mode; 
      data.tenant_id = tenant_id; // Pass tenant_id to the engine

      // 2. Direct call to Coinbase Engine (no HTTP, no exposed endpoint)
      console.log(`[ROUTER] Executing trade for ${data.symbol} (Tenant: ${tenant_id}, Mode: ${mode})`);

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