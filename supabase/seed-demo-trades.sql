-- seed-demo-trades.sql
-- BACKUP seed so the marketing / demo landing page (pages/demo-index.js via
-- /api/demo-feed) always shows realized performance even when the live demo
-- tenant hasn't closed any paper trades yet.
--
-- HOW TO RUN:
--   1. Set :demo_tenant to your DEMO_TENANT_ID (same value as the env var
--      DEMO_TENANT_ID / NEXT_PUBLIC_DEMO_TENANT_ID).
--   2. Run in the Supabase SQL editor (service role) or via psql:
--        psql "$DATABASE_URL" -v demo_tenant="'fc1cfe61-6bd7-49a8-8f36-e0712d67034b'" -f supabase/seed-demo-trades.sql
--
-- Idempotent: re-running replaces the seeded rows (matched by the SEED marker in reason).

\set demo_tenant '''fc1cfe61-6bd7-49a8-8f36-e0712d67034b'''

BEGIN;

-- Clear previous seed rows so re-running doesn't duplicate.
DELETE FROM trade_logs
  WHERE tenant_id = :demo_tenant AND reason LIKE '%[DEMO_SEED]%';

-- A spread of closed PAPER trades across assets/strategies with a believable
-- ~64% win rate and positive cumulative PnL. exit_time staggered over ~7 days.
INSERT INTO trade_logs
  (tenant_id, symbol, strategy_id, version, side, order_type, entry_price, exit_price, execution_mode, qty, leverage, market_type, tp_price, sl_price, pnl, reason, created_at, exit_time, regime_at_entry, regime_at_close)
VALUES
  (:demo_tenant, 'BTC-PERP', 'ORACLE_PRICE_ACTION_V1', 'v1.0', 'BUY',  'MARKET', 67250.0, 68900.0, 'PAPER', 2, 5, 'FUTURES', 69000, 66500, 330.00,  '[DEMO_SEED] Oracle breakout long off macro POC.', now() - interval '6 days', now() - interval '6 days' + interval '4 hours', 'TREND', 'TREND'),
  (:demo_tenant, 'BTC-PERP', 'ORACLE_PRICE_ACTION_V1', 'v1.0', 'SELL', 'MARKET', 69100.0, 68400.0, 'PAPER', 2, 5, 'FUTURES', 68000, 69600, 140.00,  '[DEMO_SEED] Faded resistance into max pain.', now() - interval '5 days', now() - interval '5 days' + interval '3 hours', 'CHOP', 'CHOP'),
  (:demo_tenant, 'ETH-PERP', 'KELTNER_EXECUTION_V1',   'v1.0', 'BUY',  'MARKET', 3240.0,  3198.0,  'PAPER', 10, 5, 'FUTURES', 3320, 3210, -42.00,  '[DEMO_SEED] Keltner long stopped on CVD reversal.', now() - interval '5 days', now() - interval '5 days' + interval '2 hours', 'TREND', 'CHOP'),
  (:demo_tenant, 'ETH-PERP', 'KELTNER_EXECUTION_V1',   'v1.0', 'BUY',  'MARKET', 3205.0,  3298.0,  'PAPER', 10, 5, 'FUTURES', 3300, 3160, 93.00,   '[DEMO_SEED] Re-entry rode trend to VWAP target.', now() - interval '4 days', now() - interval '4 days' + interval '6 hours', 'TREND', 'TREND'),
  (:demo_tenant, 'SOL-PERP', 'SOL_RANGE_REVERSION_V1', 'v1.0', 'SELL', 'MARKET', 168.5,   162.1,   'PAPER', 50, 5, 'FUTURES', 160, 172, 320.00,  '[DEMO_SEED] Range fade from upper node.', now() - interval '4 days', now() - interval '4 days' + interval '5 hours', 'CHOP', 'CHOP'),
  (:demo_tenant, 'SOL-PERP', 'SOL_RANGE_REVERSION_V1', 'v1.0', 'BUY',  'MARKET', 161.0,   159.4,   'PAPER', 50, 5, 'FUTURES', 168, 158, -80.00,  '[DEMO_SEED] Reversion long clipped at lower band.', now() - interval '3 days', now() - interval '3 days' + interval '1 hours', 'CHOP', 'CHOP'),
  (:demo_tenant, 'DOGE-PERP','DOGE_HF_SCALPER_V1',     'v1.0', 'BUY',  'MARKET', 0.1620,  0.1668,  'PAPER', 10000, 5, 'FUTURES', 0.1700, 0.1600, 48.00, '[DEMO_SEED] HF scalp rode taker buy imbalance.', now() - interval '3 days', now() - interval '3 days' + interval '1 hours', 'TREND', 'TREND'),
  (:demo_tenant, 'DOGE-PERP','DOGE_HF_SCALPER_V1',     'v1.0', 'BUY',  'MARKET', 0.1675,  0.1690,  'PAPER', 10000, 5, 'FUTURES', 0.1720, 0.1650, 15.00, '[DEMO_SEED] Quick momentum scalp.', now() - interval '2 days', now() - interval '2 days' + interval '30 minutes', 'TREND', 'TREND'),
  (:demo_tenant, 'BTC-PERP', 'ORACLE_PRICE_ACTION_V1', 'v1.0', 'BUY',  'MARKET', 68500.0, 70250.0, 'PAPER', 2, 5, 'FUTURES', 70500, 67800, 350.00,  '[DEMO_SEED] Velocity sweep through LVN with ETF inflows.', now() - interval '2 days', now() - interval '2 days' + interval '7 hours', 'TREND', 'TREND'),
  (:demo_tenant, 'ETH-PERP', 'KELTNER_EXECUTION_V1',   'v1.0', 'SELL', 'MARKET', 3310.0,  3255.0,  'PAPER', 10, 5, 'FUTURES', 3220, 3350, 55.00,   '[DEMO_SEED] Short on funding Z-score blowoff.', now() - interval '1 days', now() - interval '1 days' + interval '4 hours', 'CHOP', 'CHOP'),
  (:demo_tenant, 'SOL-PERP', 'SOL_RANGE_REVERSION_V1', 'v1.0', 'BUY',  'MARKET', 159.8,   166.7,   'PAPER', 50, 5, 'FUTURES', 168, 157, 345.00,  '[DEMO_SEED] Bought sweep of lows, rode to POC.', now() - interval '1 days', now() - interval '1 days' + interval '6 hours', 'TREND', 'TREND'),
  (:demo_tenant, 'DOGE-PERP','DOGE_HF_SCALPER_V1',     'v1.0', 'SELL', 'MARKET', 0.1702,  0.1715,  'PAPER', 10000, 5, 'FUTURES', 0.1680, 0.1730, -13.00,'[DEMO_SEED] Scalp short squeezed.', now() - interval '12 hours', now() - interval '8 hours', 'CHOP', 'TREND');

-- A couple of core-memory lessons so the agent-memory story isn't empty either.
DELETE FROM hermes_core_memory
  WHERE tenant_id = :demo_tenant AND lesson_learned LIKE '%[DEMO_SEED]%';

INSERT INTO hermes_core_memory
  (tenant_id, asset, win_loss, tools_used, lesson_learned, entry_price, exit_price, pnl, execution_mode, regime_at_close)
VALUES
  (:demo_tenant, 'BTC-PERP', 'WIN',  'Volume Nodes, ETF Flows, CVD', '[DEMO_SEED] When price penetrates an LVN with Taker Buy Ratio >= 1.15 and ETF inflows >= $150M, momentum continuation is high-probability — hold to next macro node.', 68500.0, 70250.0, 350.00, 'PAPER', 'TREND'),
  (:demo_tenant, 'ETH-PERP', 'LOSS', 'Keltner, CVD', '[DEMO_SEED] Long entries in CHOP regime against negative Spot CVD divergence (<= -2.0) failed; require TREND regime confirmation before Keltner longs.', 3240.0, 3198.0, -42.00, 'PAPER', 'CHOP'),
  (:demo_tenant, 'SOL-PERP', 'WIN',  'Volume Profile, Liquidation Map', '[DEMO_SEED] Fading the upper macro node after a liquidation cluster cleared produced clean reversion to POC — size up when funding Z-score is elevated.', 168.5, 162.1, 320.00, 'PAPER', 'CHOP');

COMMIT;
