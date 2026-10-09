-- Migration 059: PUSH AM62 (consolidated) — Learning Loop + structure_direction
-- + entry-adjust toggle + lesson score. ADDITIVE ONLY (no destructive changes).
-- No uuid-ossp dependency.
--
-- THREE independent additive columns, bundled because all four AM62 commits
-- depend on them and the 057 lesson applies: code deployed before its column =
-- inserts fail (silently on LIVE, loudly on PAPER). PASTE THIS IN THE SUPABASE
-- SQL EDITOR *BEFORE* THE AM62 DEPLOY.
--
-- (1) trade_logs.structure_direction
--     Market-structure bias captured at ENTRY and CLOSE, derived from the regime
--     oracle (macro_regime_oracle) + the sign of CVD. Values: LONG | SHORT |
--     NEUTRAL. NULL on legacy rows is expected and allowed (NULL passes a CHECK).
--     Feeds the AM61 mistake tags (enables the COUNTER_TREND_SCALP class), the
--     empirical priors, and the Learning Loop panel. Also mirrored inside
--     params_context (jsonb) so it survives the entry->close merge.
--
-- (2) tenant_settings.agent_open_trade_entry_adjust
--     New agent toggle, DEFAULT false (OFF). When ON, the brain's ENTRY decision
--     accepts APPROVE_WITH_PARAMS and may propose this entry's tp/sl/tripwire/
--     trail geometry, clamped to bounds. Sits alongside the other
--     agent_open_trade_* keys from migration 016.
--
-- (3) hermes_core_memory.lesson_score
--     Persisted recall score (0-100+) computed AT AUTOPSY WRITE TIME, so the
--     Learning Loop panel can bucket "avg score per week" without re-deriving the
--     score from workers/sniper.js getScoredMemories on every read. NULL on rows
--     written before this migration (historical weeks show null, not zero).

-- ── (1) trade_logs.structure_direction ──────────────────────────────────────
ALTER TABLE trade_logs
  ADD COLUMN IF NOT EXISTS structure_direction text
  CHECK (structure_direction IN ('LONG', 'SHORT', 'NEUTRAL'));

COMMENT ON COLUMN trade_logs.structure_direction IS
  'AM62 market-structure bias at entry/close (regime oracle + CVD sign): LONG | SHORT | NEUTRAL. NULL on legacy rows. Mirrored in params_context.structure_direction.';

CREATE INDEX IF NOT EXISTS idx_trade_logs_tenant_structure
  ON trade_logs (tenant_id, structure_direction);

-- ── (2) tenant_settings.agent_open_trade_entry_adjust ───────────────────────
ALTER TABLE tenant_settings
  ADD COLUMN IF NOT EXISTS agent_open_trade_entry_adjust BOOLEAN DEFAULT false;

COMMENT ON COLUMN tenant_settings.agent_open_trade_entry_adjust IS
  'AM62: when true, the ENTRY decision may return APPROVE_WITH_PARAMS and propose this entry''s tp/sl/tripwire/trail geometry (bounded). Default false.';

-- ── (3) hermes_core_memory.lesson_score ─────────────────────────────────────
ALTER TABLE hermes_core_memory
  ADD COLUMN IF NOT EXISTS lesson_score integer;

COMMENT ON COLUMN hermes_core_memory.lesson_score IS
  'AM62: recall score snapshot computed at autopsy write time (mirrors workers/sniper.js getScoredMemories). NULL on pre-059 rows.';
