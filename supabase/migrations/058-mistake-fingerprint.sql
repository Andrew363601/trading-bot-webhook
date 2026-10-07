-- Migration 058: PUSH AM61 — repetition-aware mistake learning.
--
-- Adds a structured mistake fingerprint to hermes_core_memory so autopsies can
-- tag WHY a trade failed (WALL_REJECTION, NEGATIVE_FLOW_ENTRY, LATE_TRAIL,
-- THIN_BOOK_ENTRY, ...). The wake path counts same-tag lessons within 14d and
-- injects a REPEATED-MISTAKE block; the recall scorer reserves a slot for the
-- newest same-regime lesson.
--
-- tags is a jsonb ARRAY of tag strings (multi-tag ready). The GIN index backs
-- the containment query (tags @> '["WALL_REJECTION"]').
--
-- ADDITIVE ONLY (no destructive changes). No uuid-ossp dependency.

alter table hermes_core_memory
  add column if not exists tags jsonb;

comment on column hermes_core_memory.tags is
  'AM61 mistake fingerprint: jsonb array of structured mistake tags assigned by the autopsy grader (e.g. ["WALL_REJECTION"]). Descriptive-only lessons carry ["DESCRIPTIVE_ONLY"].';

create index if not exists idx_hermes_core_memory_tags
  on hermes_core_memory using gin (tags);
