-- 🟢 PUSH U: One autopsy lesson per trade, enforced by the database.
-- The AUTOPSKIP pre-check in hermes-brain.js closes most races, but the
-- execute-trade close path and the watchdog bracket/heartbeat paths can still
-- POST /api/autopsy for the same trade within seconds of each other. This
-- partial unique index makes the DB the final authority — the losing insert
-- degrades to a skip instead of a duplicate memory.
-- NOTE: if this fails on existing duplicates, dedupe first, e.g. the
-- historical 3107 pair: DELETE FROM hermes_core_memory WHERE id = 1389;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_core_memory_trade_log
  ON hermes_core_memory (trade_log_id)
  WHERE trade_log_id IS NOT NULL;
