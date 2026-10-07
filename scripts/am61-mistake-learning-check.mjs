// scripts/am61-mistake-learning-check.mjs
// 🟢 PUSH AM61 — unit checks for lib/mistake-learning.js.
// Run: node scripts/am61-mistake-learning-check.mjs
import {
  MISTAKE_TAGS, DESCRIPTIVE_ONLY_TAG,
  normalizeTags, hasMistakeTag,
  buildRepeatedMistakeBlock, rebalanceRecall, decayBonusPoints,
  gradeLessonRule, buildStreakBlock,
} from '../lib/mistake-learning.js';

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.error(`  ❌ ${name}`); }
}

const DAY = 86400000;
const now = Date.parse('2026-10-07T12:00:00Z');
const ago = d => new Date(now - d * DAY).toISOString();

console.log('\n[1] normalizeTags / hasMistakeTag');
{
  ok('array passes through', JSON.stringify(normalizeTags(['WALL_REJECTION'])) === '["WALL_REJECTION"]');
  ok('lowercase normalized', JSON.stringify(normalizeTags(['wall_rejection'])) === '["WALL_REJECTION"]');
  ok('unknown dropped', normalizeTags(['NOPE']).length === 0);
  ok('null -> []', normalizeTags(null).length === 0);
  ok('string coerced', JSON.stringify(normalizeTags('LATE_TRAIL')) === '["LATE_TRAIL"]');
  ok('descriptive-only has no mistake tag', hasMistakeTag([DESCRIPTIVE_ONLY_TAG]) === false);
  ok('real tag detected', hasMistakeTag(['WALL_REJECTION']) === true);
}

console.log('\n[2] buildRepeatedMistakeBlock — seed 3 same-tag lessons -> fires count=3');
{
  const lessons = [
    { id: 'a', tags: ['WALL_REJECTION'], win_loss: 'LOSS', pnl: -50, created_at: ago(1) },
    { id: 'b', tags: ['WALL_REJECTION'], win_loss: 'LOSS', pnl: -30, created_at: ago(5) },
    { id: 'c', tags: ['WALL_REJECTION'], win_loss: 'LOSS', pnl: -20, created_at: ago(9) },
  ];
  const r = buildRepeatedMistakeBlock(lessons, now);
  ok('block fires', r !== null);
  ok('count = 3', r?.matches?.[0]?.count === 3);
  ok('tag correct', r?.matches?.[0]?.tag === 'WALL_REJECTION');
  ok('ids present', r?.matches?.[0]?.ids.join(',') === 'a,b,c');
  ok('text mentions count', /failed 3 times/.test(r?.text || ''));
  ok('text is context-only (HOLD favored)', /HOLD favored/.test(r?.text || ''));
}

console.log('\n[3] buildRepeatedMistakeBlock — below threshold / outside window -> null');
{
  const one = [{ id: 'a', tags: ['WALL_REJECTION'], win_loss: 'LOSS', pnl: -50, created_at: ago(1) }];
  ok('single lesson -> null', buildRepeatedMistakeBlock(one, now) === null);
  const stale = [
    { id: 'a', tags: ['LATE_TRAIL'], win_loss: 'LOSS', pnl: -50, created_at: ago(20) },
    { id: 'b', tags: ['LATE_TRAIL'], win_loss: 'LOSS', pnl: -30, created_at: ago(25) },
  ];
  ok('outside 14d window -> null', buildRepeatedMistakeBlock(stale, now) === null);
  const desc = [
    { id: 'a', tags: [DESCRIPTIVE_ONLY_TAG], win_loss: 'LOSS', pnl: -50, created_at: ago(1) },
    { id: 'b', tags: [DESCRIPTIVE_ONLY_TAG], win_loss: 'LOSS', pnl: -30, created_at: ago(2) },
  ];
  ok('descriptive-only never counts', buildRepeatedMistakeBlock(desc, now) === null);
}

console.log('\n[4] rebalanceRecall — recency slot returns newest same-regime lesson');
{
  const scored = [
    { id: 'old', score: 300, created_at: ago(21) },
    { id: 'mid', score: 200, created_at: ago(10) },
    { id: 'new', score: 50, created_at: ago(1) },
  ];
  const newest = { id: 'newest', score: 10, created_at: ago(0.5) };
  const picked = rebalanceRecall(scored, newest);
  ok('3 slots', picked.length === 3);
  ok('newest same-regime reserved', picked.some(m => m.id === 'newest'));
  ok('top-2 by score kept', picked.some(m => m.id === 'old') && picked.some(m => m.id === 'mid'));
  ok('low-score non-reserved dropped', !picked.some(m => m.id === 'new'));
  // newest already in top-2 -> no duplicate, backfill from remaining
  const picked2 = rebalanceRecall(scored, { id: 'old', score: 300, created_at: ago(21) });
  ok('no duplicate when newest already picked', picked2.filter(m => m.id === 'old').length === 1);
  ok('backfills to 3', picked2.length === 3);
}

console.log('\n[5] decayBonusPoints — old bonus shrinks, fresh bonus intact');
{
  const fresh = decayBonusPoints(50, ago(0), now);
  const old = decayBonusPoints(50, ago(28), now);
  ok('fresh ~ full', Math.abs(fresh - 50) < 0.5);
  ok('28d (2 half-lives) ~ 12.5', Math.abs(old - 12.5) < 1);
  ok('old < fresh', old < fresh);
}

console.log('\n[6] gradeLessonRule — descriptive-only downgraded');
{
  ok('IF/THEN passes', gradeLessonRule('IF price rejects the wall THEN skip the entry').ok === true);
  ok('WHEN/THEN passes', gradeLessonRule('WHEN CVD flips negative THEN stand down').ok === true);
  const d = gradeLessonRule('The trade lost because the market moved against us.');
  ok('descriptive downgraded', d.downgraded === true && d.ok === false);
  ok('empty downgraded', gradeLessonRule('').downgraded === true);
  ok('non-string downgraded', gradeLessonRule(null).downgraded === true);
}

console.log('\n[7] buildStreakBlock — kth consecutive loss');
{
  const trades = [
    { symbol: 'BTC-PERP', regime_at_entry: 'CHOP', pnl: -10, exit_time: ago(0.2) },
    { symbol: 'BTC-PERP', regime_at_entry: 'CHOP', pnl: -20, exit_time: ago(1) },
    { symbol: 'BTC-PERP', regime_at_entry: 'CHOP', pnl: -5, exit_time: ago(2) },
    { symbol: 'BTC-PERP', regime_at_entry: 'CHOP', pnl: 40, exit_time: ago(3) },
  ];
  const r = buildStreakBlock(trades);
  ok('streak = 3', r?.streak === 3);
  ok('text mentions 3rd', /3rd consecutive loss/.test(r?.text || ''));
  ok('text names asset+regime', /BTC-PERP, CHOP/.test(r?.text || ''));
  const win = [{ symbol: 'BTC-PERP', pnl: 5, exit_time: ago(0.2) }];
  ok('win breaks streak -> null', buildStreakBlock(win) === null);
  const one = [{ symbol: 'BTC-PERP', pnl: -5, exit_time: ago(0.2) }];
  ok('single loss below min -> null', buildStreakBlock(one) === null);
}

console.log('\n[8] constants');
{
  ok('MISTAKE_TAGS non-empty', MISTAKE_TAGS.length >= 10);
  ok('DESCRIPTIVE_ONLY not in MISTAKE_TAGS', !MISTAKE_TAGS.includes(DESCRIPTIVE_ONLY_TAG));
}

console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
