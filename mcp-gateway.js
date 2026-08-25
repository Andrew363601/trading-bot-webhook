// mcp-gateway.js
import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { executeTradeMCP } from './lib/execute-trade-mcp.js';
import { getMarketStateMCP } from './lib/get-market-state-mcp.js';
import { getAtrLevels } from './lib/get-atr-levels-mcp.js';
import { getDailyPnlMCP } from './lib/get-daily-pnl-mcp.js';

const app = express();
app.use(express.json());

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Audit helper
async function logToolCall({ tool, args, result, duration, status, error }) {
  try {
    const summary = error
      ? String(error).substring(0, 500)
      : JSON.stringify(result).substring(0, 500);
    await supabase.from('agent_tool_calls').insert([{
      tenant_id: args?.tenant_id || null,
      trade_id: args?.trade_id || null,
      scan_id: args?.scan_id || null,
      tool_name: tool,
      params_snapshot: args ? JSON.stringify(args) : null,
      response_summary: summary,
      duration_ms: duration,
      status: status || 'success'
    }]);
  } catch (e) {
    console.warn(`[TOOL LOG] Insert failed:`, e.message);
  }
}

// Map each tool to its parameter schema (positional arguments for module calls)
const COINGLASS_PARAMS = {
  coinglass_oi_momentum_v4: ['symbol', 'n_minutes', 'interval'],
  coinglass_funding_rate_reversion_v4: ['symbol', 'k_minutes', 'interval'],
  coinglass_aggregated_liquidation_map_v4: ['symbol', 'range_percent'],
  coinglass_liquidation_heatmap_v4: ['symbol', 'interval'],
  coinglass_aggregated_orderbook_depth_v4: ['symbol'],
  coinglass_orderbook_depth_imbalance_v4: ['symbol'],
  coinglass_large_limit_order_tracker_v4: ['symbol'],
  coinglass_large_limit_order_history_v4: ['symbol'],
  coinglass_etf_net_flow_momentum_v4: ['asset', 'k_days'],
  coinglass_exchange_balance_reserve_v4: ['symbol'],
  coinglass_exchange_balance_trend_v4: ['symbol', 'k_days'],
  coinglass_exchange_wallet_assets_v4: ['exchange'],
  coinglass_global_long_short_sentiment_v4: ['symbol', 'k_hours', 'interval'],
  coinglass_top_position_long_short_v4: ['symbol'],
  coinglass_top_account_long_short_v4: ['symbol'],
  coinglass_taker_buy_sell_ratio_v4: ['symbol', 'interval'],
  coinglass_spot_cvd_divergence_v4: ['symbol', 'interval'],
  coinglass_pair_liquidation_velocity_v4: ['symbol', 'm_periods', 'interval'],
  coinglass_grayscale_holdings_premium_v4: ['asset'],
  coinglass_bitcoin_profitable_days_v4: [],
  coinglass_hyperliquid_whale_momentum_v4: ['symbol'],
  coinglass_cross_exchange_funding_spread_v4: ['symbol'],
  coinglass_cumulative_funding_regime_v4: ['symbol'],
  coinglass_oi_weighted_funding_v4: ['symbol'],
  coinglass_oi_exchange_dispersion_v4: ['symbol'],
  coinglass_vol_weighted_funding_v4: ['symbol'],
  coinglass_option_vs_futures_leverage_v4: ['symbol'],
  coinglass_options_max_pain_pin_v4: ['symbol'],
  coinglass_options_strike_distribution_v4: ['symbol'],
  coinglass_options_exchange_oi_trend_v4: ['symbol'],
  coinglass_options_exchange_volume_trend_v4: ['symbol'],
};

// 🟢 1. THE TOOL REGISTRY (What Hermes reads)
const TOOLS = {
    execute_order: {
        description: "Physically place a trade on the exchange. You MUST use this to execute your thesis. Also used internally for ADJUST_TP_SL bracket swaps when reason contains '[ADJUST_TP_SL]'.",
        parameters: {
            symbol: "string (e.g., ETH-PERP)",
            side: "string (BUY or SELL)",
            price: "number (Limit price, or current price for MARKET)",
            order_type: "string (LIMIT or MARKET)",
            qty: "number (Position size)",
            tp_price: "number (Take profit limit)",
            sl_price: "number (Stop loss trigger)",
            reason: "string (Your Oracle rationale and working thesis)"
        }
    },
    get_market_state: {
        description: "Fetch live X-Ray telemetry, Micro/Macro CVD, and historical nodes to evaluate a setup.",
        parameters: { 
            symbol: "string (e.g., ETH-PERP)" 
        }
    },
    get_atr_levels: {
        description: "Calculate ATR-based Stop Loss and Take Profit levels with 50% ATR front-run protection.",
        parameters: {
            triggerCandles: "array of {open, high, low, close, volume} (trigger TF)",
            triggerTimeframe: "string (e.g., '5M', '15M', '1H')",
            options: "object {regime: 'TREND'|'CHOP', macroCandles: [], sweepLow: number, targetPrice: number, side: 'BUY'|'SELL'}"
        }
    },
    get_daily_pnl: {
        description: "Fetch the current day's realized PnL (paper + live) to track progress toward the $1,000 daily target. Use this for bankroll awareness before making decisions.",
        parameters: {
            tenant_id: "string (UUID of the tenant)"
        }
    },
    // 31 Coinglass v4 Tools
    coinglass_oi_momentum_v4: {
        description: "Is capital backing this price move? (ΔOI × sign(ΔP)) — Macro Trend-Following, Short-Squeeze Regime. Use MACRO_TF interval.",
        parameters: { symbol: "string (e.g., ETH or BTC)", n_minutes: "number (optional, default 15)", interval: "string (optional, e.g., '30m' or '1h')" },
        tier: 3, timeframe: "macro"
    },
    coinglass_funding_rate_reversion_v4: {
        description: "Is positioning extreme? (Z-score: FR deviation from 24h mean) — Extreme Positioning, Mean-Reversion. Use MACRO_TF interval.",
        parameters: { symbol: "string", k_minutes: "number (optional)", interval: "string (optional)" },
        tier: 3, timeframe: "macro"
    },
    coinglass_taker_buy_sell_ratio_v4: {
        description: "Who is aggressive right now? (buy vol / sell vol) — Taker Aggression / Order Flow Dominance. Use TRIGGER_TF interval.",
        parameters: { symbol: "string", interval: "string (optional)" },
        tier: 4, timeframe: "trigger"
    },
    coinglass_oi_exchange_dispersion_v4: {
        description: "Is OI concentrated on one exchange? (HHI ≥ 0.35 = concentrated risk) — Herfindahl Open Interest Dispersion. Use MACRO_TF interval.",
        parameters: { symbol: "string" },
        tier: 3, timeframe: "macro"
    },
    coinglass_cumulative_funding_regime_v4: {
        description: "What's the carry cost over your intended hold period? — Cumulative Carry Cost Regime. Use MACRO_TF interval.",
        parameters: { symbol: "string" },
        tier: 3, timeframe: "macro"
    },
    coinglass_cross_exchange_funding_spread_v4: {
        description: "Are different exchanges pricing funding differently? (arb signal) — Cross-Venue Arbitrage Disparity. Use MACRO_TF interval.",
        parameters: { symbol: "string" },
        tier: 3, timeframe: "macro"
    },
    coinglass_spot_cvd_divergence_v4: {
        description: "Is spot CVD diverging from price? (bearish divergence = VETO longs) — Spot Cumulative Volume Delta Divergence. Use TRIGGER_TF interval.",
        parameters: { symbol: "string", interval: "string (optional)" },
        tier: 4, timeframe: "trigger"
    },
    coinglass_global_long_short_sentiment_v4: {
        description: "What position is the crowd holding? — Retail Account Long/Short Ratio. Use MACRO_TF interval.",
        parameters: { symbol: "string", k_hours: "number (optional)", interval: "string (optional)" },
        tier: 1, timeframe: "macro"
    },
    coinglass_top_account_long_short_v4: {
        description: "What are the largest accounts doing? — Smart Money Account Positioning. Use MACRO_TF interval.",
        parameters: { symbol: "string" },
        tier: 1, timeframe: "macro"
    },
    coinglass_orderbook_depth_imbalance_v4: {
        description: "Is there passive support/resistance in the book? — Bid/Ask Depth Imbalance. Use TRIGGER_TF interval.",
        parameters: { symbol: "string" },
        tier: 5, timeframe: "trigger"
    },
    coinglass_large_limit_order_tracker_v4: {
        description: "Are there large resting orders that validate or threaten? — Large Limit Order Tracker. Use TRIGGER_TF interval.",
        parameters: { symbol: "string" },
        tier: 5, timeframe: "trigger"
    },
    coinglass_aggregated_orderbook_depth_v4: {
        description: "Full depth picture across exchanges — Aggregated Orderbook Depth. Use TRIGGER_TF interval.",
        parameters: { symbol: "string" },
        tier: 5, timeframe: "trigger"
    },
    coinglass_aggregated_liquidation_map_v4: {
        description: "Where are the liquidation clusters? (target below the cluster) — Aggregated Liquidation Map. Use TRIGGER_TF interval.",
        parameters: { symbol: "string", range_percent: "number (optional)" },
        tier: 2, timeframe: "trigger"
    },
    coinglass_pair_liquidation_velocity_v4: {
        description: "Is liquidation pressure accelerating? — Liquidation Burst Velocity. Use TRIGGER_TF interval.",
        parameters: { symbol: "string", m_periods: "number (optional)", interval: "string (optional)" },
        tier: 2, timeframe: "trigger"
    },
    coinglass_hyperliquid_whale_momentum_v4: {
        description: "What are Hyperliquid whales doing? — Hyperliquid Whale Net Long/Short Flow. Use TRIGGER_TF interval.",
        parameters: { symbol: "string" },
        tier: 2, timeframe: "trigger"
    },
    coinglass_options_strike_distribution_v4: {
        description: "Are there option walls blocking the move? — Options Open Interest Strike Distribution. Use MACRO_TF interval.",
        parameters: { symbol: "string" },
        tier: 3, timeframe: "macro"
    },
    coinglass_options_max_pain_pin_v4: {
        description: "Is Max Pain pinning price? (VETO if within 1% of max pain) — Options Max Pain Pin Price. Use MACRO_TF interval.",
        parameters: { symbol: "string" },
        tier: 3, timeframe: "macro"
    },
    coinglass_option_vs_futures_leverage_v4: {
        description: "Is leverage skewed dangerously toward futures? — Options vs Futures Leverage Skew. Use MACRO_TF interval.",
        parameters: { symbol: "string" },
        tier: 3, timeframe: "macro"
    },
    coinglass_oi_weighted_funding_v4: {
        description: "Funding weighted by open interest (more accurate than raw FR) — OI-Weighted Funding Rate. Use MACRO_TF interval.",
        parameters: { symbol: "string" },
        tier: 3, timeframe: "macro"
    },
    coinglass_vol_weighted_funding_v4: {
        description: "Funding weighted by volume — Volume-Weighted Funding Rate. Use MACRO_TF interval.",
        parameters: { symbol: "string" },
        tier: 3, timeframe: "macro"
    },
    coinglass_top_position_long_short_v4: {
        description: "Position-level granularity on crowd bias — Smart Money Top Position Ratio. Use MACRO_TF interval.",
        parameters: { symbol: "string" },
        tier: 1, timeframe: "macro"
    },
    coinglass_etf_net_flow_momentum_v4: {
        description: "Institutional flow direction (5-day accumulation) — Spot Bitcoin/Ethereum ETF Net Flows. Use MACRO_TF interval.",
        parameters: { asset: "string", k_days: "number (optional)" },
        tier: 1, timeframe: "macro"
    },
    coinglass_exchange_balance_reserve_v4: {
        description: "Are coins leaving exchanges? (supply squeeze signal) — Exchange Reserves & Netflow. Use MACRO_TF interval.",
        parameters: { symbol: "string" },
        tier: 1, timeframe: "macro"
    },
    coinglass_exchange_balance_trend_v4: {
        description: "Multi-day trend in exchange balances — Multi-Day Exchange Balance Trend. Use MACRO_TF interval.",
        parameters: { symbol: "string", k_days: "number (optional)" },
        tier: 1, timeframe: "macro"
    },
    coinglass_exchange_wallet_assets_v4: {
        description: "Wallet-level exchange holdings — Exchange Wallet Asset Breakdown. Use MACRO_TF interval.",
        parameters: { exchange: "string (optional)" },
        tier: 1, timeframe: "macro"
    },
    coinglass_bitcoin_profitable_days_v4: {
        description: "Macro cycle positioning (secular bull/bear) — Bitcoin Profitable Days Ratio. Use MACRO_TF interval.",
        parameters: {},
        tier: 1, timeframe: "macro"
    },
    coinglass_grayscale_holdings_premium_v4: {
        description: "GBTC/ETHE premium or discount — Grayscale Trust Premium/Discount. Use MACRO_TF interval.",
        parameters: { asset: "string (optional)" },
        tier: 1, timeframe: "macro"
    },
    coinglass_large_limit_order_history_v4: {
        description: "24h cancellation rate (spoof detection, >80% = VETO) — Orderbook Spoofing Detection. Use TRIGGER_TF interval.",
        parameters: { symbol: "string" },
        tier: 5, timeframe: "trigger"
    },
    coinglass_options_exchange_oi_trend_v4: {
        description: "Options OI trend across exchanges — Options Open Interest Exchange Breakdown. Use MACRO_TF interval.",
        parameters: { symbol: "string" },
        tier: 3, timeframe: "macro"
    },
    coinglass_options_exchange_volume_trend_v4: {
        description: "Options volume trend — Options Trading Volume Exchange Breakdown. Use MACRO_TF interval.",
        parameters: { symbol: "string" },
        tier: 3, timeframe: "macro"
    },
    coinglass_liquidation_heatmap_v4: {
        description: "Liquidation Heatmap Raster — Dense Liquidation Map. Use TRIGGER_TF interval.",
        parameters: { symbol: "string", interval: "string (optional)" },
        tier: 2, timeframe: "trigger"
    }
};

// 🟢 2. THE DISCOVERY ENDPOINT
app.get('/mcp/tools', (req, res) => {
    res.json({ tools: TOOLS });
});

// 🟢 3. THE EXECUTION ENDPOINT (Where Hermes sends commands)
app.post('/mcp/execute', async (req, res) => {
    const { tool, arguments: args } = req.body;

    try {
        if (tool === 'execute_order') {
            console.log(`[MCP GATEWAY] Hermes Agent invoked execute_order for ${args?.symbol}`);
            const result = await executeTradeMCP(args);
            return res.json({ result });
        }
        
        if (tool === 'get_market_state') {
            console.log(`[MCP GATEWAY] Hermes Agent analyzing market state for ${args?.symbol}`);
            const result = await getMarketStateMCP(args); 
            return res.json({ result });                  
        }

        if (tool === 'get_atr_levels') {
            console.log(`[MCP GATEWAY] Hermes Agent calculating ATR levels`);
            const result = await getAtrLevels(args?.triggerCandles, args?.triggerTimeframe, args?.options);
            return res.json({ result });
        }

        if (tool === 'get_daily_pnl') {
            console.log(`[MCP GATEWAY] Hermes Agent fetching daily PnL for tenant ${args?.tenant_id}`);
            const result = await getDailyPnlMCP(args);
            return res.json({ result });
        }

        if (tool && tool.startsWith('coinglass_')) {
            const start = Date.now();
            try {
                const mod = await import(`./lib/${tool}.js`);
                const paramNames = COINGLASS_PARAMS[tool] || Object.keys(args || {});
                const callArgs = paramNames.map(pn => args?.[pn]);
                const result = await mod[tool](...callArgs);
                const duration = Date.now() - start;
                // Log tool call — fire and forget
                logToolCall({ tool, args, result, duration, status: 'success' }).catch(() => {});
                return res.json({ result });
            } catch (e) {
                const duration = Date.now() - start;
                logToolCall({ tool, args, error: e.message, duration, status: 'error' }).catch(() => {});
                return res.status(500).json({ error: e.message });
            }
        }

        return res.status(404).json({ error: `[MCP FAULT] Tool ${tool} not recognized by Gateway.` });

    } catch (error) {
        console.error(`[MCP GATEWAY FAULT]:`, error.message);
        return res.status(500).json({ error: error.message });
    }
});

// 🟢 4. THE BOOT SEQUENCE
export function startMCPGateway() {
    const PORT = process.env.MCP_PORT || 4000;
    app.listen(PORT, () => {
        console.log(`[MCP GATEWAY] Online. Hermes translation layer listening on port ${PORT}`);
    });
}