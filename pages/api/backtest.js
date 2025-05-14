import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Your config ranges for testing
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

// Simulate random result (replace this later with TradingView data)
function simulateResult(config) {
  const totalTrades = Math.floor(Math.random() * 10 + 5);
  let wins = 0;
  let pnl = 0;

  for (let i = 0; i < totalTrades; i++) {
    const win = Math.random() < 0.52;
    const gain = Math.random() * 20;
    if (win) {
      wins++;
      pnl += gain;
    } else {
      pnl -= gain * 0.9;
    }
  }

  const winRate = wins / totalTrades;
  return {
    config,
    win_rate: parseFloat(winRate.toFixed(3)),
    pnl: parseFloat(pnl.toFixed(2)),
    trades: totalTrades
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const results = [];
  let counter = 0;

  for (const config of generateCombinations(configRanges)) {
    const result = simulateResult(config);
    results.push(result);
    counter++;

    // Save each result to Supabase
    const { error } = await supabase.from("backtest_results").insert([
      {
        config: result.config,
        strategy: "QQE-ATR",
        version: "v1.0",
        win_rate: result.win_rate,
        pnl: result.pnl,
        trades: result.trades
      }
    ]);

    if (error) {
      console.error("Insert error for config", config, error.message);
    }
  }

  const top = results
    .sort((a, b) => b.win_rate - a.win_rate)
    .slice(0, 5);

  return res.status(200).json({ top, totalTested: counter });
}
