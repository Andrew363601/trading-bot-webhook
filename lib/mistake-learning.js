// lib/mistake-learning.js
// 🟢 PUSH AM61 — repetition-aware mistake learning (PURE, no I/O).
//
// Extracted so the wake-injection / recall-rebalance / grader logic is unit
// testable without booting the sniper or the brain (mirrors lib/regime-params.js
// from AM53). Workers import these functions; nothing here touches Supabase.
//
// Doctrine: every block produced here is CONTEXT ONLY. The agent still decides
// (AM8 two-lane doctrine held) — we raise the approval bar, we never hard-block.

// ── Mistake fingerprint vocabulary ─────────────────────────────────────────
// The autopsy grader assigns ONE of these to a real LOSS lesson. Descriptive
// lessons that state no actionable rule get DESCRIPTIVE_ONLY instead.
export const MISTAKE_TAGS = [
  'WALL_REJECTION',        // entry into a known order-book wall that held
  'NEGATIVE_FLOW_ENTRY',   // entered against CVD / taker-flow direction
  'LATE_TRAIL',            // trail ratcheted too late, gave back open profit
  'THIN_BOOK_ENTRY',       // entered into a liquidity vacuum / thin depth
  'CHASED_EXTENSION',      // entered after the move already extended
  'FADED_BREAKOUT',        // breakout failed to hold, reverted
  'COUNTER_TREND_ENTRY',   // fought the macro regime
  'STOP_TOO_TIGHT',        // structural stop inside the noise band
  'EARLY_EXIT',            // exited a valid thesis prematurely
  'REGIME_MISMATCH',       // setup belonged to a different regime
  'OVERLEVERAGED',         // size/leverage exceeded the setup's edge
  'NO_INVALIDATION',       // thesis had no falsifiable invalidation condition
];

export const DESCRIPTIVE_ONLY_TAG = 'DESCRIPTIVE_ONLY';

// Tunables (kept here so tests and callers share one source of truth).
export const REPEAT_WINDOW_DAYS = 14;
export const REPEAT_MIN_COUNT = 2;
export const RECALL_SLOTS = 3;
export const BONUS_HALF_LIFE_DAYS = 14;
export const STREAK_MIN = 2;

const DAY_MS = 86400000;

// Coerce a stored tags value into a clean array of known tags.
// Accepts: null, a string, or an array. Unknown tags are dropped.
export function normalizeTags(tags) {
  const arr = Array.isArray(tags) ? tags : (tags == null ? [] : [tags]);
  const allowed = new Set([...MISTAKE_TAGS, DESCRIPTIVE_ONLY_TAG]);
  return arr
    .map(t => (typeof t === 'string' ? t.trim().toUpperCase() : ''))
    .filter(t => t && allowed.has(t));
}

// True when a lesson carries at least one real mistake tag (not descriptive-only).
export function hasMistakeTag(tags) {
  return normalizeTags(tags).some(t => t !== DESCRIPTIVE_ONLY_TAG);
}

// ── 1. REPEATED-MISTAKE injection block ────────────────────────────────────
// lessons: memory rows [{ id, tags, win_loss, pnl, created_at, asset }]
// now: epoch ms. Returns null when no tag repeats >= REPEAT_MIN_COUNT within
// the window, else { text, matches: [{ tag, count, days, ids, outcomes }] }.
export function buildRepeatedMistakeBlock(lessons, now = Date.now(), opts = {}) {
  const windowDays = opts.windowDays ?? REPEAT_WINDOW_DAYS;
  const minCount = opts.minCount ?? REPEAT_MIN_COUNT;
  const cutoff = now - windowDays * DAY_MS;

  const rows = (Array.isArray(lessons) ? lessons : []).filter(m => {
    if (!m) return false;
    const ts = m.created_at ? new Date(m.created_at).getTime() : NaN;
    if (!isFinite(ts) || ts < cutoff) return false;
    return hasMistakeTag(m.tags);
  });

  // Group by tag — a lesson may carry several tags.
  const byTag = new Map();
  for (const m of rows) {
    for (const tag of normalizeTags(m.tags)) {
      if (tag === DESCRIPTIVE_ONLY_TAG) continue;
      if (!byTag.has(tag)) byTag.set(tag, []);
      byTag.get(tag).push(m);
    }
  }

  const matches = [];
  for (const [tag, group] of byTag) {
    if (group.length < minCount) continue;
    // Newest first for stable, readable output.
    group.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    const newest = new Date(group[0].created_at).getTime();
    const oldest = new Date(group[group.length - 1].created_at).getTime();
    const days = Math.max(1, Math.round((newest - oldest) / DAY_MS));
    const ids = group.map(m => m.id).filter(v => v != null);
    const outcomes = group.map(m => {
      const pnl = parseFloat(m.pnl);
      const label = m.win_loss || (isFinite(pnl) ? (pnl >= 0 ? 'WIN' : 'LOSS') : '?');
      return isFinite(pnl) ? `${label} ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}` : label;
    });
    matches.push({ tag, count: group.length, days, ids, outcomes });
  }

  if (matches.length === 0) return null;
  matches.sort((a, b) => b.count - a.count);

  const lines = matches.map(m =>
    `This setup pattern (${m.tag}) failed ${m.count} times in ${m.days} days ` +
    `(ids: ${m.ids.join(', ') || 'n/a'}; outcomes: ${m.outcomes.join(', ')}).`
  );
  const text =
    `\n\n--- REPEATED-MISTAKE ALERT (AM61) ---\n` +
    lines.join('\n') +
    `\nCurrent thesis matches the same pattern — approval bar materially higher; ` +
    `HOLD favored unless the invalidation condition is demonstrably gone.`;

  return { text, matches };
}

// ── 2. Recall rebalance ────────────────────────────────────────────────────
// Reserve 1 of the RECALL_SLOTS for the MOST RECENT same-regime lesson, so a
// stale high-bonus lesson cannot permanently crowd out yesterday's lesson.
// scored: array of memory rows with a numeric `score` (any order).
// newestSameRegime: the newest same-regime memory row, or null.
// Returns the final top-N array (length <= slots).
export function rebalanceRecall(scored, newestSameRegime, opts = {}) {
  const slots = opts.slots ?? RECALL_SLOTS;
  const list = (Array.isArray(scored) ? scored : []).filter(Boolean);
  const sorted = [...list].sort((a, b) => (b.score || 0) - (a.score || 0));

  const picked = sorted.slice(0, Math.max(0, slots - 1));
  if (newestSameRegime && !picked.some(m => m.id === newestSameRegime.id)) {
    picked.push(newestSameRegime);
  }
  // Backfill from the remaining scored rows if the reserved slot was empty.
  if (picked.length < slots) {
    for (const m of sorted) {
      if (picked.length >= slots) break;
      if (!picked.some(p => p.id === m.id)) picked.push(m);
    }
  }
  return picked.slice(0, slots);
}

// Exponential decay applied to the BONUS portion of a score (own-tenant, LIVE,
// loss, thesis-accuracy). Recency already decays in the scorer; this stops the
// permanent bonuses from outshouting fresh lessons. Returns decayed points.
export function decayBonusPoints(bonusPoints, createdAt, now = Date.now(), opts = {}) {
  const halfLife = opts.halfLifeDays ?? BONUS_HALF_LIFE_DAYS;
  const ts = createdAt ? new Date(createdAt).getTime() : NaN;
  if (!isFinite(ts) || !isFinite(bonusPoints)) return bonusPoints;
  const ageDays = Math.max(0, (now - ts) / DAY_MS);
  const factor = Math.pow(0.5, ageDays / halfLife);
  return bonusPoints * factor;
}

// ── 3. Decision-rule gate ──────────────────────────────────────────────────
// A lesson must state an actionable rule: "IF <condition> THEN <different
// action>" (WHEN ... THEN also accepted). Descriptive-only text is downgraded.
// Returns { ok, downgraded }.
export function gradeLessonRule(text) {
  const s = typeof text === 'string' ? text : '';
  const ok = /\b(if|when)\b[\s\S]{3,}\bthen\b/i.test(s);
  return { ok, downgraded: !ok };
}

// ── 4. Streak guard ────────────────────────────────────────────────────────
// trades: last N closed trades for asset+regime, newest first (or any order —
// we sort by exit_time/created_at). Counts consecutive losses from the most
// recent close. Returns null when the streak is below STREAK_MIN, else
// { text, streak }.
export function buildStreakBlock(trades, opts = {}) {
  const min = opts.minStreak ?? STREAK_MIN;
  const list = (Array.isArray(trades) ? trades : []).filter(Boolean);
  if (list.length === 0) return null;

  const tsOf = t => {
    const v = t.exit_time || t.created_at || t.entry_time;
    const ts = v ? new Date(v).getTime() : NaN;
    return isFinite(ts) ? ts : 0;
  };
  const sorted = [...list].sort((a, b) => tsOf(b) - tsOf(a));

  let streak = 0;
  for (const t of sorted) {
    const pnl = parseFloat(t.pnl);
    if (!isFinite(pnl)) break;
    if (pnl < 0) streak++;
    else break;
  }

  if (streak < min) return null;
  const asset = sorted[0].symbol || sorted[0].asset || 'this asset';
  const regime = sorted[0].regime_at_entry || sorted[0].regime_at_close || 'this regime';
  const text =
    `\n\n--- STREAK GUARD (AM61) ---\n` +
    `This is the ${streak}${ordinalSuffix(streak)} consecutive loss with this setup ` +
    `(${asset}, ${regime}). Treat the pattern as live until a close proves otherwise.`;
  return { text, streak };
}

function ordinalSuffix(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}
