// scripts/am63-seam-check.mjs
// 🟢 AM63 CI GATE — the Coinbase transport seam is enforced, not accidental.
//
// Read-only. Exit 1 (with a loud list) on any violation. Runs after every future
// push; a new adapter file gets added to the allowlist in its own push, never by
// accident.
//
// R1  jwt.sign( appears ONLY in lib/providers/coinbase.js.
// R2  No Coinbase-host fetch call expression outside the provider carries an
//     Authorization header. (Non-Coinbase Bearer calls — e.g. OpenRouter in
//     genetic-optimizer.js — are irrelevant. Public Coinbase fetches with no auth
//     are allowed.)
// R3  No file contains more than one JWT signing block.
// R4  Report per-file counts + PASS/FAIL.
//
// Scope: repo *.js/*.mjs, excluding node_modules, .next, .git, and scripts/
// (scripts hold test mocks / this gate itself).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROVIDER = path.join('lib', 'providers', 'coinbase.js');
const EXCLUDE_DIRS = new Set(['node_modules', '.next', '.git', 'scripts', '.vercel']);
const COINBASE_HOST = /api\.coinbase\.com|api\.exchange\.coinbase\.com/;

const files = [];
(function walk(dir) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (EXCLUDE_DIRS.has(ent.name)) continue;
      walk(path.join(dir, ent.name));
    } else if (/\.(js|mjs)$/.test(ent.name)) {
      files.push(path.join(dir, ent.name));
    }
  }
})(ROOT);

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

// --- call-expression scanner (skips comments, strings, and regex literals so the
//     host + Authorization test sees only real code) ---
const skipString = (s, j) => { const q = s[j]; for (j++; j < s.length; j++) { if (s[j] === '\\') { j++; continue; } if (s[j] === q) return j + 1; } return j; };
const skipTmpl = (s, j) => { for (j++; j < s.length; j++) { if (s[j] === '\\') { j++; continue; } if (s[j] === '`') return j + 1; if (s[j] === '$' && s[j + 1] === '{') { let d = 0; j++; for (; j < s.length; j++) { const c = s[j]; if (c === '{') d++; else if (c === '}') { d--; if (d === 0) break; } } } } return j + 1; };
const bracketEnd = (s, j) => {
  const o = s[j], c = o === '{' ? '}' : (o === '(' ? ')' : ']');
  let d = 0;
  for (; j < s.length; j++) {
    const ch = s[j];
    if (ch === '`') { j = skipTmpl(s, j) - 1; continue; }
    if (ch === "'" || ch === '"') { j = skipString(s, j) - 1; continue; }
    if (ch === '/' && s[j + 1] === '/') { while (j < s.length && s[j] !== '\n') j++; continue; }
    if (ch === '/' && s[j + 1] === '*') { j += 2; while (j < s.length && !(s[j] === '*' && s[j + 1] === '/')) j++; j++; continue; }
    if (ch === o) d++; else if (ch === c) { d--; if (d === 0) return j + 1; }
  }
  return -1;
};

// Returns [{ line, auth, call }] for every fetch/fetchWithBackoff COINBASE-host call.
function scanHostFetches(src) {
  const out = [];
  const isRegexStart = (prev) => prev === '' || '(,=:[!&|?{};+-*%~^<>'.includes(prev);
  let i = 0, prev = '';
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === "'" || c === '"') { i = skipString(src, i); prev = 'v'; continue; }
    if (c === '`') { i = skipTmpl(src, i); prev = 'v'; continue; }
    if (c === '/' && isRegexStart(prev)) {
      i++; let inClass = false;
      while (i < src.length) { const ch = src[i]; if (ch === '\\') { i += 2; continue; } if (ch === '[') inClass = true; else if (ch === ']') inClass = false; else if (ch === '/' && !inClass) { i++; break; } else if (ch === '\n') break; i++; }
      prev = 'v'; continue;
    }
    const fn = src.startsWith('fetchWithBackoff(', i) ? 'fetchWithBackoff' : (src.startsWith('fetch(', i) ? 'fetch' : null);
    if (fn) {
      const end = bracketEnd(src, i + fn.length);
      if (end > 0) {
        const call = src.slice(i, end);
        if (COINBASE_HOST.test(call)) out.push({ line: src.slice(0, i).split('\n').length, auth: call.includes('Authorization'), call });
        i = end; prev = 'v'; continue;
      }
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

const v1 = []; // jwt.sign outside the provider
const v2 = []; // Coinbase-host fetch with Authorization outside the provider
const v3 = []; // file with >1 signing block
const report = [];

for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const file = rel(f);
  const isProvider = file === rel(path.join(ROOT, PROVIDER));

  const signBlocks = (src.match(/jwt\.sign\(/g) || []).length;
  if (!isProvider && signBlocks > 0) v1.push(`${file} (${signBlocks})`);
  if (signBlocks > 1) v3.push(`${file} (${signBlocks})`);

  // R2: scan fetch call expressions
  const hostedCalls = scanHostFetches(src);
  const hosted = hostedCalls.length;
  for (const h of hostedCalls) {
    if (h.auth && !isProvider) v2.push(`${file}:${h.line}`);
  }
  if (signBlocks > 0 || hosted > 0) report.push(`${file}: signers=${signBlocks} coinbase-host-fetches=${hosted}`);
}

const fail = v1.length + v2.length + v3.length;
console.log('AM63 seam check');
console.log('---------------');
console.log(`\nScanned ${files.length} files.\n`);
if (report.length) { console.log('Per-file counts:'); for (const r of report) console.log(`  ${r}`); console.log(''); }

if (v1.length) {
  console.log('❌ R1 — jwt.sign( found outside lib/providers/coinbase.js:');
  for (const x of v1) console.log(`   - ${x}`);
}
if (v2.length) {
  console.log('❌ R2 — Coinbase-host fetch with Authorization outside the provider:');
  for (const x of v2) console.log(`   - ${x}`);
}
if (v3.length) {
  console.log('❌ R3 — file has more than one JWT signing block:');
  for (const x of v3) console.log(`   - ${x}`);
}

const R1 = v1.length === 0, R2 = v2.length === 0, R3 = v3.length === 0;
console.log(`\nR1 jwt.sign confined to provider : ${R1 ? 'PASS' : 'FAIL'}`);
console.log(`R2 no auth'd Coinbase fetch outside provider : ${R2 ? 'PASS' : 'FAIL'}`);
console.log(`R3 one signing block per file : ${R3 ? 'PASS' : 'FAIL'}`);

if (fail > 0) {
  console.error(`\nFAIL — ${fail} violation(s).`);
  process.exit(1);
}
console.log('\nPASS — Coinbase transport seam intact.');
