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

const WINDOWS = { '1D': 1, '7D': 7, '30D': 30 };

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
      .select('id, tenant_id, symbol, side, entry_price, exit_price, tp_price, sl_price, pnl, qty, execution_mode, created_at')
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
          bestR: -Infinity,
          grossProfit: 0,
          grossLoss: 0,
          exitDays: new Set(),
          tradeList: []   // { pnl, symbol } for category records
        });
      }

      const stat = statsMap.get(groupKey);
      stat.trades += 1;
      const pnl = Number(t.pnl) || 0;
      if (pnl > 0) { stat.wins += 1; stat.grossProfit += pnl; }
      else if (pnl < 0) { stat.grossLoss += Math.abs(pnl); }
      stat.totalPnl += pnl;
      // Distinct UTC exit dates
      const exitTs = t.created_at;
      if (exitTs) stat.exitDays.add(String(exitTs).slice(0, 10));
      stat.tradeList.push({ pnl, symbol: t.symbol });

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

    // Filter >= 5 trades and format rows (alias-only privacy output)
    const rankedGroups = [];
    for (const stat of statsMap.values()) {
      if (stat.trades >= 5) {
        const winRate = stat.trades > 0 ? (stat.wins / stat.trades) : 0;
        const profitFactor = stat.grossLoss > 0
          ? Number((stat.grossProfit / stat.grossLoss).toFixed(2))
          : null;
        rankedGroups.push({
          stat,
          row: {
            alias: stat.alias,
            mode: stat.mode,
            trades: stat.trades,
            winRate: Number(winRate.toFixed(4)),
            profitFactor,
            days: stat.exitDays.size,
            totalR: Number(stat.totalR.toFixed(2)),
            totalPnl: Number(stat.totalPnl.toFixed(2)),
            bestR: stat.bestR === -Infinity ? 0 : Number(stat.bestR.toFixed(2))
          }
        });
      }
    }

    // Sort by totalR desc, top 50 rows
    rankedGroups.sort((a, b) => b.row.totalR - a.row.totalR);
    const top50 = rankedGroups.slice(0, 50).map(g => g.row);

    // Category records: top 5 lists built from ranked groups' trades only (alias-only)
    const allTrades = [];
    rankedGroups.forEach(g => {
      g.stat.tradeList.forEach(tr => allTrades.push({ alias: g.stat.alias, ...tr }));
    });
    const byPnlDesc = [...allTrades].sort((a, b) => b.pnl - a.pnl);
    const byPnlAsc = [...allTrades].sort((a, b) => a.pnl - b.pnl);

    const records = {
      largestWin: byPnlDesc.slice(0, 5).map(t => ({ alias: t.alias, value: Number(t.pnl.toFixed(2)), symbol: t.symbol })),
      largestLoss: byPnlAsc.slice(0, 5).map(t => ({ alias: t.alias, value: Number(t.pnl.toFixed(2)), symbol: t.symbol })),
      mostDays: rankedGroups
        .slice()
        .sort((a, b) => b.stat.exitDays.size - a.stat.exitDays.size)
        .slice(0, 5)
        .map(g => ({ alias: g.stat.alias, days: g.stat.exitDays.size })),
      highestVolume: rankedGroups
        .slice()
        .sort((a, b) => b.stat.trades - a.stat.trades)
        .slice(0, 5)
        .map(g => ({ alias: g.stat.alias, trades: g.stat.trades }))
    };

    return res.status(200).json({
      generatedAt: new Date().toISOString(),
      window: windowKey,
      mode,
      rows: top50,
      records
    });
  } catch (err) {
    console.error('[LEADERBOARD_API] Unexpected error:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
