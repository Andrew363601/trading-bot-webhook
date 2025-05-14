// pages/api/backtest.js
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Define strategy ranges
const configRanges = {
  atr_mult: { min: 0.5, max: 1.5, step: 0.1 },
  tp_mult: { min: 0.8, max: 2.0, step: 0.2 },
  qqe_rsi_len: { min: 10, max: 20, step: 2 },
  qqe_smooth: { min: 2, max: 10, step: 2 }
};

function* generateCombinations(ranges) {
  for (let atr = ranges.atr_mult.min; atr <= ranges.atr_mult.max; atr += ranges.atr_mult.step) {
    for (let tp = ranges.tp_mult.min; tp <= ranges.tp_mult.max; tp += ranges.tp_mult.step) {
      for (let rsi = ranges.qqe_rsi_len.min; rsi <= ranges.qqe_rsi_len.max; rsi += ranges.qqe_rsi_len.step) {
        for (let smooth = ranges.qqe_smooth.min; smooth <= ranges.qqe_smooth.max; smooth += ranges.qqe_smooth.step) {
          yield {
            atr_mult: parseFloat(atr.toFixed(2)),
            tp_mult: parseFloat(tp.toFixed(2)),
            qqe_rsi_len: rsi,
            qqe_smooth: smooth
          };
        }
      }
    }
  }
}

function simulateTrades(alerts, config) {
  let wins = 0, losses = 0;
  let pnl = 0;

  for (const alert of alerts) {
    const win = Math.random() < 0.52; // simulate based on past success rate
    const gain = alert.price * config.tp_mult * (win ? 1 : -0.8);
    pnl += gain;
    win ? wins++ : losses++;
  }

  return {
    config,
    winRate: wins / (wins + losses),
    pnl: pnl.toFixed(2),
    trades: wins + losses
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { data: alerts, error } = await supabase
      .from("alerts")
      .select("symbol, side, price")
      .not("symbol", "is", null)
      .not("price", "is", null)
      .not("side", "is", null);

    if (error || alerts.length === 0) {
      return res.status(500).json({ error: "No alerts to test", detail: error });
    }

    const results = [];
    for (const config of generateCombinations(configRanges)) {
      const result = simulateTrades(alerts, config);
      results.push(result);
    }

    results.sort((a, b) => b.winRate - a.winRate);

    return res.status(200).json({ top: results.slice(0, 5), totalTested: results.length });

  } catch (err) {
    console.error("❌ Backtest error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}