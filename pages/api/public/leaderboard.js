// pages/api/public/leaderboard.js
// Public rolling leaderboard API (no auth required)
// Rate limited: 30 requests per 60s per IP.

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── In-memory rate limiter (per IP, 30 req / 60s) ──
const rateMap = new Map();
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60000;

function checkRateLimit(ip) {
  const now = Date.now();
  const entries = rateMap.get(ip) || [];
  const recent = entries.filter(t => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) return false;
  recent.push(now);
  rateMap.set(ip, recent);
  return true;
}

const WINDOWS = { '1D': 1, '7D': 7, '30D': 30, '90D': 90 };

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // Rate limit
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many requests. Try again in a minute.' });
  }

  // Set edge caching
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');

  const rawMode = String(req.query.mode || 'LIVE').toUpperCase();
  const mode = rawMode === 'PAPER' ? 'PAPER' : 'LIVE';

  const rawWindow = String(req.query.window || '30D').toUpperCase();
  const days = WINDOWS[rawWindow] || 30;
  const windowKey = WINDOWS[rawWindow] ? rawWindow : '30D';

  const sinceDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  try {
    // Query 1: trade_logs where exit_price NOT NULL, created_at >= (now - period)
    const { data: trades, error: tradeErr } = await supabase
      .from('trade_logs')
      .select('id, tenant_id, symbol, side, entry_price, exit_price, tp_price, sl_price, pnl, qty, execution_mode, exit_time')
      .not('exit_price', 'is', null)
      .gte('created_at', sinceDate)
      .eq('execution_mode', mode);

    if (tradeErr) {
      console.error('[LEADERBOARD_API] Trade query error:', tradeErr);
      return res.status(500).json({ error: 'Failed to fetch leaderboard data' });
    }

    // Query 2: public_profiles where opt_in = true
    const { data: profiles, error: profileErr } = await supabase
      .from('public_profiles')
      .select('tenant_id, alias')
      .eq('opt_in', true);

    if (profileErr) {
      console.error('[LEADERBOARD_API] Profile query error:', profileErr);
      return res.status(500).json({ error: 'Failed to fetch public profiles' });
    }

    const tenantToAlias = new Map();
    (profiles || []).forEach(p => {
      if (p.tenant_id && p.alias) {
        tenantToAlias.set(p.tenant_id, p.alias);
      }
    });

    // Group & Aggregate by alias & mode
    const statsMap = new Map();

    (trades || []).forEach(t => {
      const alias = tenantToAlias.get(t.tenant_id);
      if (!alias) return; // Drop trades with no opted-in profile

      const execMode = String(t.execution_mode || mode).toUpperCase();
      const groupKey = `${alias}::${execMode}`;

      if (!statsMap.has(groupKey)) {
        statsMap.set(groupKey, {
          alias,
          mode: execMode,
          trades: 0,
          wins: 0,
          totalR: 0,
          totalPnl: 0,
          bestR: -Infinity
        });
      }

      const stat = statsMap.get(groupKey);
      stat.trades += 1;
      const pnl = Number(t.pnl) || 0;
      if (pnl > 0) stat.wins += 1;
      stat.totalPnl += pnl;

      // Risk calculation: Math.abs(entry - sl) * qty (skip R when sl/qty missing or 0)
      const entry = Number(t.entry_price);
      const sl = Number(t.sl_price);
      const qty = Number(t.qty);

      if (!isNaN(entry) && !isNaN(sl) && !isNaN(qty) && qty > 0 && Math.abs(entry - sl) > 0) {
        const risk = Math.abs(entry - sl) * qty;
        if (risk > 0) {
          const r = pnl / risk;
          stat.totalR += r;
          if (r > stat.bestR) {
            stat.bestR = r;
          }
        }
      }
    });

    // Filter >= 5 trades and format rows
    const rows = [];
    for (const stat of statsMap.values()) {
      if (stat.trades >= 5) {
        const winRate = stat.trades > 0 ? (stat.wins / stat.trades) : 0;
        rows.push({
          alias: stat.alias,
          mode: stat.mode,
          trades: stat.trades,
          winRate: Number(winRate.toFixed(4)),
          totalR: Number(stat.totalR.toFixed(2)),
          totalPnl: Number(stat.totalPnl.toFixed(2)),
          bestR: stat.bestR === -Infinity ? 0 : Number(stat.bestR.toFixed(2))
        });
      }
    }

    // Sort by totalR desc
    rows.sort((a, b) => b.totalR - a.totalR);

    // Limit to top 50
    const top50 = rows.slice(0, 50);

    return res.status(200).json({
      generatedAt: new Date().toISOString(),
      window: windowKey,
      mode,
      rows: top50
    });
  } catch (err) {
    console.error('[LEADERBOARD_API] Unexpected error:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
