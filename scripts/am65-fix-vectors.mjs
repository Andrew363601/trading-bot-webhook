// scripts/am65-fix-vectors.mjs
// 🟢 AM65 — OFFLINE VECTOR GATE for the Unified FIX lane. NO network. Every vector
// byte-verifies our wire format against Kraken's OWN published examples (docs
// pulled + parsed 2026-10-17):
//   V1  — guides/fix/checksums SecurityListRequest example (9=90 · 10=026)
//   V2  — guides/fix/authentication password chain (SHA256(MessageInput+Nonce) →
//         HMAC-SHA512(b64dec(secret)) → base64), incl. a DRV-target vector
//   V3  — TCP-fragmentation reassembly (ER frame split mid-stream parses whole;
//         fee tags 137/138 recovered)
//   V5  — NOS field order 11|55|54|40|44|38|59|18|60 with mandatory 18=s +
//         required 60; FOK/GTD refused on derivatives; ExecInst without s refused
//   V7  — futures NOS Limit example byte-exact (9=183 · 10=163)
//   V8  — futures NOS Market example byte-exact (9=173 · 10=179)
//   V9  — futures NOS Stop-Loss example byte-exact (9=183 · 10=157)
//   V10 — COMB UUID semantics: timestamp-first v4, 10-μs units (ms×100) in the
//         first 48 bits; docs example a17d49af-1186 → 177559467882990
//
// Run: node scripts/am65-fix-vectors.mjs   (exit 0 = all green)

import {
  fixTrailer, buildFixMessage, parseFixStream, parseFixFields,
  fixLogonPassword, combClOrdId, buildNosBody, fixTransactTime,
} from '../lib/providers/kraken-fix.js';
import crypto from 'node:crypto';

const SOH = '\x01';
let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

console.log('AM65 FIX vectors — offline gate (no network)\n');

// ── V1: byte-exact SecurityListRequest (guides/fix/checksums) ───────────────
console.log('V1 — SecurityListRequest checksum example');
{
  // Docs example (pipe-separated here for readability; wire is SOH):
  // 8=FIX.4.4|9=90|35=x|34=3|49=CLIENT|52=20231012-09:54:15.316|56=KRAKEN-MD|55=BTC/USD|320=SLS1000002|559=0|10=026|
  const body = [
    '35=x', '34=3', '49=CLIENT', '52=20231012-09:54:15.316', '56=KRAKEN-MD',
    '55=BTC/USD', '320=SLS1000002', '559=0',
  ].join(SOH);
  const { bodyLength, checksum } = fixTrailer(body);
  check('V1 BodyLength 9=90', bodyLength === 90, `got ${bodyLength}`);
  check('V1 checksum 10=026', checksum === '026', `got ${checksum}`);
  const full = buildFixMessage(body);
  check('V1 full frame matches the docs example byte-for-byte',
    full === `8=FIX.4.4${SOH}9=90${SOH}${body}${SOH}10=026${SOH}`);
}

// ── V2: logon password chain (guides/fix/authentication) ────────────────────
console.log('V2 — logon password chain');
{
  // Independent replication of the docs' Python snippet (NOT our code path):
  //   message_input = "35=A\x01" + "34=<seq>\x01" + "49=<sender>\x01"
  //                 + "56=KRAKEN-TRD\x01" + "553=<key>\x01"
  //   sha256(message_input + nonce) → hmac_sha512(b64decode(secret)) → base64
  const secret = 'AAAA'.repeat(16) + '=='; // 64-char base64-ish test secret
  const apiKey = 'test-fix-key';
  const sender = 'CLIENT';
  const target = 'KRAKEN-TRD';
  const seq = '1';
  const nonce = '1700000000000';

  const messageInput = `35=A${SOH}34=${seq}${SOH}49=${sender}${SOH}56=${target}${SOH}553=${apiKey}${SOH}`;
  const expected = crypto.createHmac('sha512', Buffer.from(secret, 'base64'))
    .update(crypto.createHash('sha256').update(messageInput + nonce, 'utf8').digest())
    .digest('base64');

  const { password } = fixLogonPassword({ msgSeqNum: seq, senderCompId: sender, targetCompId: target, apiKey, apiSecret: secret, nonce });
  check('V2 password == independent docs replication (Spot target)', password === expected);

  // DRV-target vector: the derivatives session MUST hash 56=KRAKEN-DRV-TRD.
  const drvTarget = 'KRAKEN-DRV-TRD';
  const drvInput = `35=A${SOH}34=${seq}${SOH}49=${sender}${SOH}56=${drvTarget}${SOH}553=${apiKey}${SOH}`;
  const drvExpected = crypto.createHmac('sha512', Buffer.from(secret, 'base64'))
    .update(crypto.createHash('sha256').update(drvInput + nonce, 'utf8').digest())
    .digest('base64');
  const drv = fixLogonPassword({ msgSeqNum: seq, senderCompId: sender, targetCompId: drvTarget, apiKey, apiSecret: secret, nonce });
  check('V2 DRV-target password == independent replication', drv.password === drvExpected);
  check('V2 DRV password differs from Spot-target password', drv.password !== expected);
}

// ── V3: TCP-fragmentation reassembly + fee tags ─────────────────────────────
console.log('V3 — TCP fragmentation reassembly');
{
  // A futures Trade ER (shape from api-reference/unified-fix/er Futures tab,
  // fee group 136/137/138/139 present) split mid-stream across two chunks.
  const erBody = [
    '35=8', '34=5', '49=KRAKEN-DRV-TRD', '56=CLIENT-DRV', '52=20260407-14:32:05.122',
    '6=84000', '11=a17d4971-f00d-4f67-94d1-e7d604104ed2', '14=0.001',
    '17=6B2NDTNHRQAAB:TRD001', '31=84000', '32=0.001',
    '37=9e58120f-40e0-44dc-beec-6d1b5ea9136c', '38=0.001', '39=2', '40=2', '44=84000',
    '54=1', '55=PF_XBTUSD', '59=1', '60=20260407-14:32:05.122', '118=84', '136=1',
    '137=0.042', '138=USD', '139=4', '150=F', '151=0', '381=84',
  ].join(SOH);
  const frame = buildFixMessage(erBody);
  const splitAt = Math.floor(frame.length / 3); // mid-field cut
  const chunk1 = frame.slice(0, splitAt);
  const chunk2 = frame.slice(splitAt);

  let acc = '';
  let parsed = [];
  acc += chunk1;
  parsed = parsed.concat(parseFixStream(acc).messages);
  acc = parseFixStream(acc).rest;
  acc += chunk2;
  parsed = parsed.concat(parseFixStream(acc).messages);
  acc = parseFixStream(acc).rest;

  check('V3 split frame parses as exactly ONE message', parsed.length === 1, `got ${parsed.length}`);
  const f = parsed.length === 1 ? parseFixFields(parsed[0]) : {};
  check('V3 fee tag 137 recovered', f['137'] === '0.042', `got ${f['137']}`);
  check('V3 fee tag 138 recovered', f['138'] === 'USD', `got ${f['138']}`);
  check('V3 ExecType F recovered', f['150'] === 'F');
  check('V3 no residual bytes', acc === '');
}

// ── V5: NOS field order + guards ────────────────────────────────────────────
console.log('V5 — NOS field order + derivative guards');
{
  const args = {
    clOrdId: 'a17d4971-f00d-4f67-94d1-e7d604104ed2', symbol: 'PF_XBTUSD', side: 'buy',
    orderType: 'lmt', limitPrice: 84000, qty: 0.001, tif: '1',
    transactTime: '20260407-14:32:05.000',
  };
  const { body } = buildNosBody(args);
  const tags = body.split(SOH).map((x) => x.split('=')[0]);
  check('V5 field order 11|55|54|40|44|38|59|18|60',
    tags.join('|') === '11|55|54|40|44|38|59|18|60', `got ${tags.join('|')}`);
  check('V5 18=s mandatory', body.includes(`${SOH}18=s${SOH}`) || body.endsWith('18=s'));
  check('V5 60 present', tags.includes('60'));

  // reduce-only adds E as a space-separated value (docs: multi-values allowed).
  const ro = buildNosBody({ ...args, reduceOnly: true }).body;
  check('V5 reduce-only → 18="s E"', ro.includes('18=s E'));

  // FOK/GTD refused on derivatives (docs: Spot-only).
  let fokThrew = false;
  try { buildNosBody({ ...args, orderType: 'fok' }); } catch { fokThrew = true; }
  check('V5 FOK refused', fokThrew);
  let gtdThrew = false;
  try { buildNosBody({ ...args, orderType: 'gtd' }); } catch { gtdThrew = true; }
  check('V5 GTD refused', gtdThrew);

  // Bad TIF refused.
  let badTifThrew = false;
  try { buildNosBody({ ...args, tif: '4' }); } catch { badTifThrew = true; }
  check('V5 TIF 4 (FOK) refused', badTifThrew);

  // Limit without 44 refused.
  let noPxThrew = false;
  try { buildNosBody({ ...args, limitPrice: undefined }); } catch { noPxThrew = true; }
  check('V5 limit without 44 refused', noPxThrew);
}

// ── V7/V8/V9: byte-exact futures NOS examples (api-reference/unified-fix/nos) ──
console.log('V7/V8/V9 — futures NOS examples byte-exact');
{
  // V7 — Limit (COMB UUID + ExecInst=s):
  // 8=FIX.4.4|9=183|35=D|34=2|49=CLIENT-DRV|56=KRAKEN-DRV-TRD|52=20260407-14:32:05.000|
  // 11=a17d4971-f00d-4f67-94d1-e7d604104ed2|55=PF_XBTUSD|54=1|40=2|44=84000|38=0.001|
  // 59=1|18=s|60=20260407-14:32:05.000|10=163|
  const v7Body = [
    '35=D', '34=2', '49=CLIENT-DRV', '56=KRAKEN-DRV-TRD', '52=20260407-14:32:05.000',
    '11=a17d4971-f00d-4f67-94d1-e7d604104ed2', '55=PF_XBTUSD', '54=1', '40=2', '44=84000',
    '38=0.001', '59=1', '18=s', '60=20260407-14:32:05.000',
  ].join(SOH);
  const v7 = buildFixMessage(v7Body);
  check('V7 BodyLength 9=183', fixTrailer(v7Body).bodyLength === 183, `got ${fixTrailer(v7Body).bodyLength}`);
  check('V7 checksum 10=163', fixTrailer(v7Body).checksum === '163', `got ${fixTrailer(v7Body).checksum}`);

  // Our builder must produce the SAME body for the same inputs.
  const ours7 = buildNosBody({
    clOrdId: 'a17d4971-f00d-4f67-94d1-e7d604104ed2', symbol: 'PF_XBTUSD', side: 'buy',
    orderType: 'lmt', limitPrice: 84000, qty: 0.001, tif: '1',
    transactTime: '20260407-14:32:05.000',
  }).body;
  const ours7Full = [
    '35=D', '34=2', '49=CLIENT-DRV', '56=KRAKEN-DRV-TRD', '52=20260407-14:32:05.000',
    ours7,
  ].join(SOH);
  check('V7 our NOS body == docs example body', ours7Full === v7Body,
    `\n    ours: ${ours7Full.split(SOH).join('|')}\n    docs: ${v7Body.split(SOH).join('|')}`);
  check('V7 our full frame == docs frame', buildFixMessage(ours7Full) === v7);

  // V8 — Market:
  // 8=FIX.4.4|9=173|35=D|34=3|49=CLIENT-DRV|56=KRAKEN-DRV-TRD|52=20260407-14:32:05.000|
  // 11=a17d4972-1001-4abc-def0-1234567890ab|55=PF_ETHUSD|54=2|40=1|38=0.01|59=1|18=s|
  // 60=20260407-14:32:05.000|10=179|
  const v8Body = [
    '35=D', '34=3', '49=CLIENT-DRV', '56=KRAKEN-DRV-TRD', '52=20260407-14:32:05.000',
    '11=a17d4972-1001-4abc-def0-1234567890ab', '55=PF_ETHUSD', '54=2', '40=1', '38=0.01',
    '59=1', '18=s', '60=20260407-14:32:05.000',
  ].join(SOH);
  const v8 = buildFixMessage(v8Body);
  check('V8 BodyLength 9=173', fixTrailer(v8Body).bodyLength === 173, `got ${fixTrailer(v8Body).bodyLength}`);
  check('V8 checksum 10=179', fixTrailer(v8Body).checksum === '179', `got ${fixTrailer(v8Body).checksum}`);
  const ours8 = buildNosBody({
    clOrdId: 'a17d4972-1001-4abc-def0-1234567890ab', symbol: 'PF_ETHUSD', side: 'sell',
    orderType: 'mkt', qty: 0.01, tif: '1', transactTime: '20260407-14:32:05.000',
  }).body;
  const ours8Full = [
    '35=D', '34=3', '49=CLIENT-DRV', '56=KRAKEN-DRV-TRD', '52=20260407-14:32:05.000', ours8,
  ].join(SOH);
  check('V8 our NOS body == docs example body', ours8Full === v8Body,
    `\n    ours: ${ours8Full.split(SOH).join('|')}\n    docs: ${v8Body.split(SOH).join('|')}`);
  check('V8 our full frame == docs frame', buildFixMessage(ours8Full) === v8);

  // V9 — Stop-Loss:
  // 8=FIX.4.4|9=183|35=D|34=4|49=CLIENT-DRV|56=KRAKEN-DRV-TRD|52=20260407-14:32:05.000|
  // 11=a17d4973-1001-4abc-def0-1234567890ab|55=PF_XBTUSD|54=2|40=3|99=80000|38=0.001|
  // 59=1|18=s|60=20260407-14:32:05.000|10=157|
  const v9Body = [
    '35=D', '34=4', '49=CLIENT-DRV', '56=KRAKEN-DRV-TRD', '52=20260407-14:32:05.000',
    '11=a17d4973-1001-4abc-def0-1234567890ab', '55=PF_XBTUSD', '54=2', '40=3', '99=80000',
    '38=0.001', '59=1', '18=s', '60=20260407-14:32:05.000',
  ].join(SOH);
  const v9 = buildFixMessage(v9Body);
  check('V9 BodyLength 9=183', fixTrailer(v9Body).bodyLength === 183, `got ${fixTrailer(v9Body).bodyLength}`);
  check('V9 checksum 10=157', fixTrailer(v9Body).checksum === '157', `got ${fixTrailer(v9Body).checksum}`);
  const ours9 = buildNosBody({
    clOrdId: 'a17d4973-1001-4abc-def0-1234567890ab', symbol: 'PF_XBTUSD', side: 'sell',
    orderType: 'stp', stopPrice: 80000, qty: 0.001, tif: '1',
    transactTime: '20260407-14:32:05.000',
  }).body;
  const ours9Full = [
    '35=D', '34=4', '49=CLIENT-DRV', '56=KRAKEN-DRV-TRD', '52=20260407-14:32:05.000', ours9,
  ].join(SOH);
  check('V9 our NOS body == docs example body', ours9Full === v9Body,
    `\n    ours: ${ours9Full.split(SOH).join('|')}\n    docs: ${v9Body.split(SOH).join('|')}`);
  check('V9 our full frame == docs frame', buildFixMessage(ours9Full) === v9);
}

// ── V10: COMB UUID semantics ────────────────────────────────────────────────
console.log('V10 — COMB UUID semantics');
{
  // Docs: "a17d49af-1186-4984-bd10-29b8f232ee4d, where a17d49af-1186 encodes the
  // timestamp 177559467882990 (= 10-μs units for a given moment)."
  // ⚠️ TWO docs inconsistencies, both resolved in favor of the HEX (wire-truth):
  //   (a) 0xa17d49af1186 = 177559479193990, NOT the prose's ...67882990.
  //   (b) ...93990 is NOT a whole number of ms (990/100 = 9.9 ms remainder) —
  //       a whole-ms clock cannot reproduce field 2 = 1186 deterministically.
  // Our generator is whole-ms (units = ms×100) — a VALID 10-μs-unit timestamp
  // (the server validates ±120s, not sub-ms precision). Pins:
  //   1. Semantics: our units at a whole-ms input decode back to ms×100 exactly.
  //   2. Proximity: our units at the docs' implied ms are within 100 units (1 ms)
  //      of the docs' hex value — same second, same 48-bit timestamp semantics.
  const docsUnits = BigInt('0xa17d49af1186'); // 177559479193990 (hex = wire-truth)
  const docsMs = Number(docsUnits / 100n);    // 1775594791939 (floor)
  const id = combClOrdId(docsMs);
  const [tlo, tmid] = id.split('-');
  // 1. Exact round-trip at a whole-ms input.
  const decoded = BigInt(`0x${tlo}${tmid}`);
  check('V10 units == ms×100 (exact round-trip)', decoded === BigInt(docsMs) * 100n, `got ${decoded}`);
  // 2. Within 1 ms of the docs' hex timestamp (sub-ms remainder is the only gap).
  const delta = docsUnits - decoded;
  check('V10 within 100 units (1 ms) of the docs hex', delta >= 0n && delta < 100n, `delta ${delta}`);
  check('V10 first field == a17d49af', tlo === 'a17d49af', `got ${tlo}`);
  // Version nibble is 4 (v4 UUID).
  check('V10 version 4', id.split('-')[2].startsWith('4'));
  // Two calls at the same ms still differ (random tail).
  const id2 = combClOrdId(docsMs);
  check('V10 unique per call', id !== id2);
}

// ── TransactTime format ─────────────────────────────────────────────────────
console.log('T — TransactTime format');
{
  const t = fixTransactTime(Date.UTC(2026, 3, 7, 14, 32, 5, 0));
  check('T format YYYYMMDD-HH:MM:SS.uuu', t === '20260407-14:32:05.000', `got ${t}`);
}

console.log(`\n${pass} pass · ${fail} fail`);
if (fail > 0) {
  console.error(`FAILED: ${failures.join(' · ')}`);
  process.exit(1);
}
