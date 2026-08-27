/**
 * Tier Mapping — maps Coinglass v4 tool names to SKILL.md tiers, stages, and reasons.
 * 
 * Based on SYSTEM ARCHITECTURE: MULTI-DIMENSIONAL QUANTUM CONFLUENCE ARCHITECTURE
 * and TOOL SELECTION PROTOCOL from SKILL.md
 * 
 * Tier 1: Macro Cycle & Institutional Flows (The Gravity Well)
 * Tier 2: Microstructure Support & Resistance (The Terrain)
 * Tier 3: Derivatives Leverage & Positioning (The Energy State)
 * Tier 4: Order Flow & Aggression (The Present Momentum)
 * Tier 5: Depth Intent & Spoofing Defense (The Order Book)
 * 
 * Stages:
 *   1 = Mandatory Quick Scan
 *   2 = Conditional Validation
 *   3 = Deep Dive
 *   4 = Session Refresh
 *   SYSTEM = Core / system tools (always available)
 *   EXECUTION = Trade execution
 */

const TIER_MAP = {
  // Stage 1: MANDATORY QUICK SCAN
  coinglass_oi_momentum_v4: {
    tier: 3, tierLabel: 'Tier 3: Energy (Derivatives)', tierColor: '#f59e0b',
    stage: 1, stageLabel: 'Stage 1: Quick Scan', timeframe: 'MACRO_TIMEFRAME',
    reason: 'OI momentum confirms capital is backing the price move (ΔOI × sign(ΔP))',
    description: 'Open Interest momentum — is capital flowing into this move?'
  },
  coinglass_funding_rate_reversion_v4: {
    tier: 3, tierLabel: 'Tier 3: Energy (Derivatives)', tierColor: '#f59e0b',
    stage: 1, stageLabel: 'Stage 1: Quick Scan', timeframe: 'MACRO_TIMEFRAME',
    reason: 'Funding rate Z-score checks for extreme positioning (Z > 2.5 = crowded)',
    description: 'Funding rate reversion — is positioning extreme?'
  },
  coinglass_taker_buy_sell_ratio_v4: {
    tier: 4, tierLabel: 'Tier 4: Momentum (Order Flow)', tierColor: '#06b6d4',
    stage: 1, stageLabel: 'Stage 1: Quick Scan', timeframe: 'TRIGGER_TIMEFRAME',
    reason: 'Taker buy/sell ratio reveals who is aggressively driving price right now',
    description: 'Taker aggression — who is in control?'
  },

  // Stage 2: CONDITIONAL VALIDATION
  coinglass_oi_exchange_dispersion_v4: {
    tier: 3, tierLabel: 'Tier 3: Energy (Derivatives)', tierColor: '#f59e0b',
    stage: 2, stageLabel: 'Stage 2: Conditional Validation', timeframe: 'MACRO_TIMEFRAME',
    reason: 'OI concentrated on one exchange? HHI ≥ 0.35 = concentrated liquidation risk',
    description: 'OI exchange dispersion — is leverage concentrated dangerously?'
  },
  coinglass_cumulative_funding_regime_v4: {
    tier: 3, tierLabel: 'Tier 3: Energy (Derivatives)', tierColor: '#f59e0b',
    stage: 2, stageLabel: 'Stage 2: Conditional Validation', timeframe: 'MACRO_TIMEFRAME',
    reason: 'Cumulative funding cost over intended hold period — is the carry sustainable?',
    description: 'Cumulative funding regime — what is the carry cost?'
  },
  coinglass_cross_exchange_funding_spread_v4: {
    tier: 3, tierLabel: 'Tier 3: Energy (Derivatives)', tierColor: '#f59e0b',
    stage: 2, stageLabel: 'Stage 2: Conditional Validation', timeframe: 'MACRO_TIMEFRAME',
    reason: 'Funding divergence between exchanges signals arbitrage / manipulation',
    description: 'Cross-exchange funding spread — arbitrage signal?'
  },
  coinglass_spot_cvd_divergence_v4: {
    tier: 4, tierLabel: 'Tier 4: Momentum (Order Flow)', tierColor: '#06b6d4',
    stage: 2, stageLabel: 'Stage 2: Conditional Validation', timeframe: 'TRIGGER_TIMEFRAME',
    reason: 'Spot CVD diverging from price? Bearish divergence = VETO longs',
    description: 'Spot CVD divergence — is price diverging from real demand?'
  },
  coinglass_global_long_short_sentiment_v4: {
    tier: 3, tierLabel: 'Tier 3: Energy (Derivatives)', tierColor: '#f59e0b',
    stage: 2, stageLabel: 'Stage 2: Conditional Validation', timeframe: 'MACRO_TIMEFRAME',
    reason: 'Global long/short ratio — what position is the crowd holding?',
    description: 'Global long/short sentiment — crowd positioning check'
  },
  coinglass_top_account_long_short_v4: {
    tier: 3, tierLabel: 'Tier 3: Energy (Derivatives)', tierColor: '#f59e0b',
    stage: 2, stageLabel: 'Stage 2: Conditional Validation', timeframe: 'MACRO_TIMEFRAME',
    reason: 'Largest accounts positioning — follow the smart money?',
    description: 'Top account long/short — what are whales doing?'
  },
  coinglass_orderbook_depth_imbalance_v4: {
    tier: 5, tierLabel: 'Tier 5: Depth (Order Book)', tierColor: '#a855f7',
    stage: 2, stageLabel: 'Stage 2: Conditional Validation', timeframe: 'TRIGGER_TIMEFRAME',
    reason: 'Passive support/resistance in the order book — is the bid/ask walled?',
    description: 'Order book depth imbalance — passive support or resistance?'
  },
  coinglass_large_limit_order_tracker_v4: {
    tier: 5, tierLabel: 'Tier 5: Depth (Order Book)', tierColor: '#a855f7',
    stage: 2, stageLabel: 'Stage 2: Conditional Validation', timeframe: 'TRIGGER_TIMEFRAME',
    reason: 'Large resting orders that validate or threaten the thesis',
    description: 'Large limit order tracker — are there institutional walls?'
  },
  coinglass_aggregated_orderbook_depth_v4: {
    tier: 5, tierLabel: 'Tier 5: Depth (Order Book)', tierColor: '#a855f7',
    stage: 2, stageLabel: 'Stage 2: Conditional Validation', timeframe: 'TRIGGER_TIMEFRAME',
    reason: 'Full aggregated depth picture across exchanges',
    description: 'Aggregated order book depth — complete liquidity picture'
  },

  // Stage 3: DEEP DIVE
  coinglass_aggregated_liquidation_map_v4: {
    tier: 5, tierLabel: 'Tier 5: Depth (Order Book)', tierColor: '#a855f7',
    stage: 3, stageLabel: 'Stage 3: Deep Dive', timeframe: 'MIXED',
    reason: 'Liquidation cluster mapping — target below clusters for short entries',
    description: 'Aggregated liquidation map — where are the liquidation clusters?'
  },
  coinglass_pair_liquidation_velocity_v4: {
    tier: 5, tierLabel: 'Tier 5: Depth (Order Book)', tierColor: '#a855f7',
    stage: 3, stageLabel: 'Stage 3: Deep Dive', timeframe: 'MIXED',
    reason: 'Is liquidation pressure accelerating? Velocity confirms cascade risk',
    description: 'Pair liquidation velocity — acceleration check'
  },
  coinglass_hyperliquid_whale_momentum_v4: {
    tier: 3, tierLabel: 'Tier 3: Energy (Derivatives)', tierColor: '#f59e0b',
    stage: 3, stageLabel: 'Stage 3: Deep Dive', timeframe: 'MIXED',
    reason: 'Hyperliquid whale directional bias — follow or fade the largest DEX?',
    description: 'Hyperliquid whale momentum — what are sophisticated whales doing?'
  },
  coinglass_options_strike_distribution_v4: {
    tier: 3, tierLabel: 'Tier 3: Energy (Derivatives)', tierColor: '#f59e0b',
    stage: 3, stageLabel: 'Stage 3: Deep Dive', timeframe: 'MACRO_TIMEFRAME',
    reason: 'Option strike walls blocking the move at resistance',
    description: 'Options strike distribution — are there option walls?'
  },
  coinglass_options_max_pain_pin_v4: {
    tier: 3, tierLabel: 'Tier 3: Energy (Derivatives)', tierColor: '#f59e0b',
    stage: 3, stageLabel: 'Stage 3: Deep Dive', timeframe: 'MACRO_TIMEFRAME',
    reason: 'Max Pain pinning price? VETO if within 1% of max pain',
    description: 'Options max pain — gravitational pin check'
  },
  coinglass_option_vs_futures_leverage_v4: {
    tier: 3, tierLabel: 'Tier 3: Energy (Derivatives)', tierColor: '#f59e0b',
    stage: 3, stageLabel: 'Stage 3: Deep Dive', timeframe: 'MACRO_TIMEFRAME',
    reason: 'Leverage skewed toward futures? Dangerous if Z-score ≤ -2.2',
    description: 'Options vs futures leverage — skew check'
  },
  coinglass_oi_weighted_funding_v4: {
    tier: 3, tierLabel: 'Tier 3: Energy (Derivatives)', tierColor: '#f59e0b',
    stage: 3, stageLabel: 'Stage 3: Deep Dive', timeframe: 'MACRO_TIMEFRAME',
    reason: 'OI-weighted funding rate — more accurate than raw FR for bias estimation',
    description: 'OI-weighted funding — precision read'
  },
  coinglass_vol_weighted_funding_v4: {
    tier: 3, tierLabel: 'Tier 3: Energy (Derivatives)', tierColor: '#f59e0b',
    stage: 3, stageLabel: 'Stage 3: Deep Dive', timeframe: 'MACRO_TIMEFRAME',
    reason: 'Volume-weighted funding rate — accuracy refinement',
    description: 'Volume-weighted funding — volume-contextualized read'
  },
  coinglass_top_position_long_short_v4: {
    tier: 3, tierLabel: 'Tier 3: Energy (Derivatives)', tierColor: '#f59e0b',
    stage: 3, stageLabel: 'Stage 3: Deep Dive', timeframe: 'MACRO_TIMEFRAME',
    reason: 'Position-level granularity on crowd bias — granular check after losses',
    description: 'Top position long/short — granular crowd bias'
  },

  // Stage 4: SESSION REFRESH
  coinglass_etf_net_flow_momentum_v4: {
    tier: 1, tierLabel: 'Tier 1: Gravity (Macro)', tierColor: '#10b981',
    stage: 4, stageLabel: 'Stage 4: Session Refresh', timeframe: 'MACRO_TIMEFRAME',
    reason: 'ETF net flow momentum — institutional direction (5-day accumulation)',
    description: 'ETF net flow — institutional accumulation/distribution'
  },
  coinglass_exchange_balance_reserve_v4: {
    tier: 1, tierLabel: 'Tier 1: Gravity (Macro)', tierColor: '#10b981',
    stage: 4, stageLabel: 'Stage 4: Session Refresh', timeframe: 'MACRO_TIMEFRAME',
    reason: 'Exchange balance reserve — coins leaving exchanges = supply squeeze',
    description: 'Exchange balance reserve — supply squeeze signal'
  },
  coinglass_exchange_balance_trend_v4: {
    tier: 1, tierLabel: 'Tier 1: Gravity (Macro)', tierColor: '#10b981',
    stage: 4, stageLabel: 'Stage 4: Session Refresh', timeframe: 'MACRO_TIMEFRAME',
    reason: 'Multi-day exchange balance trend — structural supply/demand shift',
    description: 'Exchange balance trend — multi-day flow direction'
  },
  coinglass_exchange_wallet_assets_v4: {
    tier: 1, tierLabel: 'Tier 1: Gravity (Macro)', tierColor: '#10b981',
    stage: 4, stageLabel: 'Stage 4: Session Refresh', timeframe: 'MACRO_TIMEFRAME',
    reason: 'Wallet-level exchange holdings — granular reserve verification',
    description: 'Exchange wallet assets — wallet-level holdings'
  },
  coinglass_bitcoin_profitable_days_v4: {
    tier: 1, tierLabel: 'Tier 1: Gravity (Macro)', tierColor: '#10b981',
    stage: 4, stageLabel: 'Stage 4: Session Refresh', timeframe: 'MACRO_TIMEFRAME',
    reason: 'Bitcoin profitable days ratio — secular bull/bear cycle positioning',
    description: 'Bitcoin profitable days — macro cycle location'
  },
  coinglass_grayscale_holdings_premium_v4: {
    tier: 1, tierLabel: 'Tier 1: Gravity (Macro)', tierColor: '#10b981',
    stage: 4, stageLabel: 'Stage 4: Session Refresh', timeframe: 'MACRO_TIMEFRAME',
    reason: 'GBTC/ETHE premium or discount — institutional sentiment proxy',
    description: 'Grayscale holdings premium — institutional mood ring'
  },
  coinglass_large_limit_order_history_v4: {
    tier: 5, tierLabel: 'Tier 5: Depth (Order Book)', tierColor: '#a855f7',
    stage: 4, stageLabel: 'Stage 4: Session Refresh', timeframe: 'MACRO_TIMEFRAME',
    reason: '24h cancellation rate — spoof detection (>80% cancel rate = VETO)',
    description: 'Large limit order history — spoofing defense baseline'
  },
  coinglass_options_exchange_oi_trend_v4: {
    tier: 3, tierLabel: 'Tier 3: Energy (Derivatives)', tierColor: '#f59e0b',
    stage: 4, stageLabel: 'Stage 4: Session Refresh', timeframe: 'MACRO_TIMEFRAME',
    reason: 'Options OI trend across exchanges — positional bias in options market',
    description: 'Options OI trend — derivative positioning delta'
  },
  coinglass_options_exchange_volume_trend_v4: {
    tier: 3, tierLabel: 'Tier 3: Energy (Derivatives)', tierColor: '#f59e0b',
    stage: 4, stageLabel: 'Stage 4: Session Refresh', timeframe: 'MACRO_TIMEFRAME',
    reason: 'Options volume trend — surge in activity signals hedging/positioning',
    description: 'Options volume trend — activity surge signal'
  },

  // Core System Tools
  get_market_state: {
    tier: 'SYSTEM', tierLabel: 'System Tool', tierColor: '#64748b',
    stage: 'SYSTEM', stageLabel: 'Core System', timeframe: null,
    reason: 'Current market state snapshot — price, volume, OHLCV for thesis context',
    description: 'Market state snapshot'
  },
  get_daily_pnl: {
    tier: 'SYSTEM', tierLabel: 'System Tool', tierColor: '#64748b',
    stage: 'SYSTEM', stageLabel: 'Core System', timeframe: null,
    reason: 'Daily PnL and bankroll check — adjust aggression based on distance to target',
    description: 'Daily PnL check'
  },
  get_volume_nodes: {
    tier: 2, tierLabel: 'Tier 2: Terrain (S/R)', tierColor: '#3b82f6',
    stage: 'SYSTEM', stageLabel: 'Core System', timeframe: 'TRIGGER_TIMEFRAME',
    reason: 'Volume profile mapping — identify HVNs (support) and LVNs (targets)',
    description: 'Volume profile — HVN/LVN mapping'
  },
  get_atr_levels: {
    tier: 2, tierLabel: 'Tier 2: Terrain (S/R)', tierColor: '#3b82f6',
    stage: 'SYSTEM', stageLabel: 'Core System', timeframe: 'TRIGGER_TIMEFRAME',
    reason: 'ATR-based volatility measurement — 1.5x–3x ATR stop buffer, HVN-based TP targeting',
    description: 'ATR levels — volatility-based stops and targets'
  },
  execute_order: {
    tier: 'EXECUTION', tierLabel: 'Trade Execution', tierColor: '#ef4444',
    stage: 'EXECUTION', stageLabel: 'Execution', timeframe: null,
    reason: 'Order placement and trade execution — market or limit entry',
    description: 'Order execution'
  },
};

function normalizeToolName(name) {
  if (!name) return name;
  return name.toLowerCase().trim();
}

export function getTierInfo(toolName) {
  const key = normalizeToolName(toolName);
  return TIER_MAP[key] || {
    tier: '?', tierLabel: 'Unknown', tierColor: '#6b7280',
    stage: '?', stageLabel: 'Unknown', timeframe: null,
    reason: 'Tool not found in SKILL.md tier mapping',
    description: toolName
  };
}

export function getStageColor(stage) {
  switch (stage) {
    case 1: return '#10b981';
    case 2: return '#f59e0b';
    case 3: return '#ef4444';
    case 4: return '#8b5cf6';
    case 'SYSTEM': return '#64748b';
    case 'EXECUTION': return '#ef4444';
    default: return '#6b7280';
  }
}
