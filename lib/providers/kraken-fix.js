// lib/providers/kraken-fix.js
// 🟢 AM65 — UNIFIED FIX LANE: the Kraken private transport swaps from the apiv3 REST
// door (futures.kraken.com — GEO-BLOCKED for the operator's account, Kraken agent
// verbatim: "Futures access is currently unavailable for this Kraken account… not an
// API-credential issue") to the Unified FIX API (fix.kraken.com), which the operator's
// pro.kraken.com key opens. Docs verbatim: "It covers both Spot and Derivatives
// markets via a single Spot FIX API Key" and "a FIX key is created as a Spot key,
// even when used for Derivatives trading."
//
// SPEC: AM65_UNIFIED_FIX_LANE.md (validated 2026-10-17 against Kraken's live docs:
// guides/fix/{introduction,authentication,checksums} +
// api-reference/unified-fix/{logon,nos,er}). Field maps below are receipts, not
// guesses. The offline vector gate scripts/am65-fix-vectors.mjs byte-verifies the
// wire format against Kraken's OWN published examples.
//
// 🟢 AM68 — VERDICT ADDENDUM (Oct 18 2026, Kraken specialist on ticket). The DRV FIX
// onboarding request was answered: the Derivatives FIX session serves the
// INTERNATIONAL platform, geo-restricted for the operator's account; a DRV
// SenderCompID cannot be issued to an ineligible account; PF_* instruments belong to
// that same platform and are NOT the KDUS/Bitnomial products; US-futures API = a
// Tradovate account, not Kraken. SPOT FIX onboarding is routed SEPARATELY (operator
// confirmed interest; pending). This lane ships DORMANT for the operator
// (transport=rest default) and remains CORRECT for eligible tenants/future geo
// changes. The AM65 spec file was never committed to origin — this addendum is the
// on-origin record (full text: repo memory /memories/repo/push-am65-unified-fix-lane.md).
//
// ═══════════════════════════════════════════════════════════════════════════
// DOC-PINNED CONTRACT (every line traceable to a Kraken docs page)
// ═══════════════════════════════════════════════════════════════════════════
// SESSION (guides/fix/introduction + api-reference/unified-fix/logon):
//   - TCP + TLS 1.3 (docs: "Connections must use TCP SSL with TLS 1.3"). DNS
//     resolved AT CONNECT (docs: 5-minute TTL, "do not bind to static IPs").
//   - Hosts: fix.kraken.com (prod) / fix.uat.kraken.com (UAT). Ports:
//     Derivatives Trading 4003, Derivatives Market Data 4002.
//   - TargetCompID: KRAKEN-DRV-TRD (trading) / KRAKEN-DRV-MD (market data).
//     SenderCompID: Kraken-assigned, DRV suffix for derivatives (onboarding).
//   - Logon (35=A) MUST be the first message: 98=0, 108=60 (recommended), 553=FIX
//     key, 554=HMAC password, 5025=nonce (ms epoch), 141=Y (both sides reset seq
//     to 1 — no durable seq store; the daily 22:00 UTC rollover resets server-side
//     anyway). 8674 (CancelOrdersOnDisconnect) left UNSET → docs default 0 =
//     cancel all session orders on disconnect (safety-first posture).
//   - Password chain (docs verbatim): base64( HMAC-SHA512( base64decode(API_Secret),
//     SHA256(MessageInput + Nonce) ) ) where MessageInput = SOH-joined
//     "35=A|34=<MsgSeqNum>|49=<SenderCompID>|56=<TargetCompID>|553=<API_Key>".
//     ⚠️ The docs' code examples hardcode 56=KRAKEN-TRD (Spot) — derivatives
//     sessions MUST use the ACTUAL target of the session (KRAKEN-DRV-TRD).
//   - Nonce (5025) must be within ±5 SECONDS of Kraken server time (docs warning:
//     "Clock drift is the most common cause of logon failures"). The ±120s window
//     belongs to the COMB ClOrdID, NOT the logon nonce.
//   - Heartbeat 108=60; TestRequest at 1.5× silence, session destroyed at 2.5×
//     (engineering choice — docs only recommend the 60s interval).
//   - Rate limits are SESSION-level on derivatives + an error-rate safeguard
//     (too many errors/s → disconnect). Our lanes NEVER retry on rejects.
//
// NOS (35=D) — api-reference/unified-fix/nos, Futures examples byte-pinned:
//   - Field order: 11|55|54|40|[44|99]|38|59|18|60 (V7/V8/V9 byte-exact).
//   - 11 ClOrdID: COMB UUID MANDATORY for futures (timestamp-first v4; first 48
//     bits = ms×100 in 10-μs units since epoch; server validates ±120s).
//   - 55 symbol: PF_* (Kraken's own examples: PF_XBTUSD, PF_ETHUSD).
//   - 40 type: 1 market · 2 limit · 3 stop-loss · 4 stop-loss-limit · R
//     take-profit · T take-profit-limit · U trailing-stop (V = Spot only).
//   - 44 limit price / 99 stop trigger — quote currency.
//   - 38 qty: BASE-ASSET denominated (docs: 0.001 BTC at 84000 → $84 notional =
//     ER 381=84). Callers convert contracts × contract_size.
//   - 59 TIF: GTC(1) / IOC(3) only on derivatives; FOK(4)/GTD(6) are Spot-only —
//     REFUSED here (never silently downgraded).
//   - 18 ExecInst: "s" single-fee MANDATORY on derivatives (docs verbatim:
//     "Mandatory and only supported fee option for derivatives"); E reduce-only,
//     P post-only supported (space-separated multi-values allowed).
//   - 60 TransactTime: REQUIRED, YYYYMMDD-HH:MM:SS.uuu UTC.
//   - 388 DiscretionInst (trigger reference): index=1 / last=5, default 5. There
//     is NO 'mark' option on FIX (the apiv3 lane pins triggerSignal 'mark').
//     OPERATOR DECISION (D1): accept the default + LOUD log on every conditional
//     verdict; verify actual trigger behavior at the UAT probe before LIVE.
//
// ER (35=8) — api-reference/unified-fix/er:
//   - 150 ExecType: 0 New · 4 Canceled · 5 Replaced · A PendingNew · C Expired ·
//     D Restated · F Trade · I OrderStatus. ⚠️ "8 Rejected" is NOT in Kraken's
//     documented enum — post-ack business failures arrive as ExecType=4 with 58
//     text. Unknown ExecType → log loud + continue (never assume 8-semantics).
//   - 39 OrdStatus: 0 New · 1 Partially Filled · 2 Filled · 4 Canceled · 5
//     Replaced · A Pending New · C Expired · E Pending Replace.
//   - Fill fields: 31 LastPx · 32 LastQty · 14 CumQty · 151 LeavesQty · 6 AvgPx ·
//     381 GrossTradeAmt · 118 NetMoney · 1003 TradeID · 5050 LiquidityInd.
//   - Fees: 136 NoMiscFee group → 137 MiscFeeAmt ⚠️ CUMULATIVE from previous
//     trades ("Fees are cumulative from the previous trades") — per-fill fee =
//     137_now − 137_prev per ClOrdID (session-tracked). 138 MiscFeeCurr (asset),
//     139 MiscFeeType (4 = Exchange Fee), 891 MiscFeeBasis (2 = Percentage).
//   - 11/37 ids, 58 text. Post-ack business-rule failure = ER with unsolicited
//     cancel status — same channel, logged loud.
//
// REJECT SEMANTICS (docs "Order Validation"):
//   - FIX field-level validation failure → session-level reject (35=3).
//   - Business-rule failure → business-level reject (35=j).
//   - After ack: further business-rule failure → ER with unsolicited cancel.
//   All three: logged verbatim, surfaced in the verdict, NEVER retried in a loop,
//   NEVER silently substituted (invisible-fallback doctrine).
//
// CANCELS (guides/fix/introduction warning):
//   - 35=F OrderCancelRequest: SAME-SESSION orders only (docs warning).
//   - 35=q OrderMassCancelRequest type 7: account-wide, any origin.
//   - FIX-placed orders can ONLY be cancelled on FIX (or mass-cancel).
//
// POSITION STATE (OPERATOR DECISION D2): FIX has NO position message (ER covers
// orders/fills only, session-scoped). With /openpositions geo-blocked, fix-mode
// derives position existence from the session ER fill ledger (net filled qty per
// symbol). Manual/UI/REST fills are a documented blind spot — the watchdog alerts
// LOUD when state is unknown rather than assuming flat.
//
// BALANCE: no balance message exists over FIX — the CONFIGURED-balance fallback
// (post-hotfix-3 behavior) stays. Never a Coinbase substitution.
//
// ARCHITECTURE (E6 — the spec hole this file closes): execute-trade-mcp runs in
// BOTH the Next.js server AND the swarm process. A module-level session Map is
// PER-PROCESS → two FIX sessions on one SenderCompID → the second logon kicks the
// first → CoD (default ON) cancels resident TP/SL brackets. Therefore:
//   - The SWARM process is the SINGLE session owner (it hosts the watchdog, the
//     liveness supervisor). Enabled via env KRF_FIX_SESSION_OWNER=1.
//   - Non-owner processes (Next.js API routes) proxy private FIX calls to the
//     owner over the EXISTING mcp-gateway HTTP surface (app.post('/mcp/execute')
//     pattern) — no second session is ever opened.
//   - The probe route REFUSES to open a session when one is already live.
//
// CONFIG — resolution order (inside the provider; callers never hold secrets):
//   1. api_keys_vault.fix_sender_comp_id (per-tenant, migration 063) →
//   2. env KRAKEN_FIX_SENDER_COMPID (single-tenant/dev fallback) →
//   3. BOTH ABSENT → loud [AM65] refusal naming the exact missing piece.
//      Never silent, never a Coinbase substitution.
//
// INERT: NOTHING behavior-bearing imports this module yet (Commit A). Commit B
// binds it at the kraken-futures.js transport dispatch seam.

import crypto from 'node:crypto';
import tls from 'node:tls';
import net from 'node:net';

const SOH = '\x01';

// ── endpoint constants (endpoint-map rows 1, 2, 10) ─────────────────────────
export const KRF_FIX_HOST = process.env.KRAKEN_FIX_HOST || 'fix.kraken.com';
export const KRF_FIX_UAT_HOST = 'fix.uat.kraken.com';
export const KRF_FIX_PORT_DRV_TRD = parseInt(process.env.KRAKEN_FIX_PORT_DRV_TRD || '4003', 10);
export const KRF_FIX_PORT_DRV_MD = 4002;
export const KRF_FIX_TARGET_TRD = 'KRAKEN-DRV-TRD';
export const KRF_FIX_TARGET_MD = 'KRAKEN-DRV-MD';

// Transport switch (Commit B reads this; default 'rest' until the probe is green).
export function fixTransportEnabled() {
  return String(process.env.KRF_PRIVATE_TRANSPORT || 'rest').toLowerCase() === 'fix';
}

// The ONE session-owner flag (E6). Only the swarm service sets it.
export function isSessionOwnerProcess() {
  return process.env.KRF_FIX_SESSION_OWNER === '1';
}

// ── FIX 4.4 codec ────────────────────────────────────────────────────────────

/**
 * Compute the FIX trailer: BodyLength (9) + checksum (10).
 * BodyLength counts EVERYTHING between "9=<n>" + SOH and "10=" — INCLUSIVE of
 * the trailing SOH after the last body field (standard FIX semantics; verified
 * byte-exact against Kraken's published examples: V1 9=90, V7 9=183, V8 9=173,
 * V9 9=183). Checksum = sum of all bytes from "8=FIX.4.4" through the SOH
 * immediately before "10=" (which includes the "9=<n>" digits themselves),
 * mod 256, zero-padded to 3 digits.
 * @param {string} body - message fields WITHOUT 9/10 (starts at 35= or 8=)
 * @returns {{bodyLength: number, checksum: string}}
 */
export function fixTrailer(body) {
  const bodyLength = Buffer.byteLength(body, 'utf8') + 1; // + trailing SOH
  let sum = 0;
  const prefix = `8=FIX.4.4${SOH}9=${bodyLength}${SOH}${body}${SOH}`;
  for (const ch of prefix) sum += ch.charCodeAt(0);
  const checksum = String(sum % 256).padStart(3, '0');
  return { bodyLength, checksum };
}

/**
 * Build a complete FIX message: 8=FIX.4.4 | 9=<len> | <body> | 10=<checksum>.
 * @param {string} body - SOH-joined fields WITHOUT 8/9/10
 * @returns {string} the full wire message (SOH-separated, trailing 10=xxx+SOH)
 */
export function buildFixMessage(body) {
  const { bodyLength, checksum } = fixTrailer(body);
  return `8=FIX.4.4${SOH}9=${bodyLength}${SOH}${body}${SOH}10=${checksum}${SOH}`;
}

/**
 * Parse a stream buffer into complete FIX messages (TCP-fragmentation safe — V3).
 * Splits on the trailing "10=xxx" + SOH terminator; returns { messages, rest }.
 * @param {string} buf - accumulated stream text (may contain partial frames)
 * @returns {{messages: string[], rest: string}}
 */
export function parseFixStream(buf) {
  const messages = [];
  let rest = String(buf || '');
  // A complete frame ends with 10=<3 digits> + SOH. Scan for that terminator.
  const checksumRe = new RegExp(`^(\\d{3})${SOH}`);
  for (;;) {
    const idx = rest.indexOf(`${SOH}10=`);
    if (idx === -1) break;
    const after = rest.slice(idx + 4); // past "10="
    const m = checksumRe.exec(after);
    if (!m) break; // checksum digits not fully arrived yet
    const end = idx + 4 + 3 + 1; // + SOH
    messages.push(rest.slice(0, end));
    rest = rest.slice(end);
  }
  return { messages, rest };
}

/** Split a FIX message into a tag→value map (last occurrence wins for repeats). */
export function parseFixFields(msg) {
  const out = {};
  for (const field of String(msg || '').split(SOH)) {
    if (!field) continue;
    const eq = field.indexOf('=');
    if (eq === -1) continue;
    out[field.slice(0, eq)] = field.slice(eq + 1);
  }
  return out;
}

// ── logon password chain (V2-verified; docs verbatim) ───────────────────────

/**
 * The ONE FIX logon password. base64(HMAC-SHA512(base64decode(apiSecret),
 * SHA256(MessageInput + Nonce))) where MessageInput = SOH-joined
 * "35=A|34=<seq>|49=<sender>|56=<target>|553=<apiKey>".
 * ⚠️ target MUST be the session's actual TargetCompID (KRAKEN-DRV-TRD for
 * derivatives — the docs' code examples hardcode the Spot target).
 * @param {object} o
 * @param {string} o.msgSeqNum - the Logon's MsgSeqNum (34) — usually '1' (141=Y)
 * @param {string} o.senderCompId - tag 49 (Kraken-assigned, DRV suffix)
 * @param {string} o.targetCompId - tag 56 (KRAKEN-DRV-TRD)
 * @param {string} o.apiKey - the FIX API key (tag 553)
 * @param {string} o.apiSecret - base64 API secret (vault)
 * @param {string} o.nonce - ms epoch string (tag 5025) — SAME value in both places
 * @returns {{password: string}} tag 554 value
 */
export function fixLogonPassword({ msgSeqNum, senderCompId, targetCompId, apiKey, apiSecret, nonce }) {
  const messageInput =
    `35=A${SOH}` +
    `34=${msgSeqNum}${SOH}` +
    `49=${senderCompId}${SOH}` +
    `56=${targetCompId}${SOH}` +
    `553=${apiKey}${SOH}`;
  const sha256 = crypto.createHash('sha256').update(messageInput + nonce, 'utf8').digest();
  const password = crypto.createHmac('sha512', Buffer.from(String(apiSecret || ''), 'base64'))
    .update(sha256).digest('base64');
  return { password };
}

// ── COMB UUID (V10-verified; docs verbatim) ─────────────────────────────────

/**
 * COMB ClOrdID — MANDATORY for futures orders (tag 11). Timestamp-first v4 UUID:
 * the first 48 bits (first two UUID fields) encode the current timestamp in
 * 10-MICROSECOND units since the Unix epoch. Server validates ±120s.
 * Docs example: a17d49af-1186-… (their prose decimal is internally inconsistent
 * with their own hex — 0xa17d49af1186 = 177559479193990; the hex is wire-truth).
 * GRANULARITY: this generator is whole-ms (units = ms × 100) — a valid value in
 * 10-μs units; the ±120s window makes sub-ms precision unnecessary, and the
 * random tail guarantees uniqueness within the same ms.
 * @param {number} [nowMs] - override for tests
 * @returns {string} e.g. "a17d49af-112c-4984-bd10-29b8f232ee4d"
 */
export function combClOrdId(nowMs = Date.now()) {
  const units = BigInt(Math.round(nowMs)) * 100n; // ms → 10-μs units (whole-ms)
  const hex = units.toString(16).padStart(12, '0'); // 48 bits = 12 hex chars
  const tsHex = hex.slice(0, 8);   // time_low
  const tsMid = hex.slice(8, 12);  // time_mid
  // Version 4 + variant bits in the remaining fields (crypto-random).
  const rand = crypto.randomBytes(8);
  const b0 = (rand[0] & 0x0f) | 0x40; // version 4
  const b1 = (rand[2] & 0x3f) | 0x80; // variant 10
  const hex2 = (n) => n.toString(16).padStart(2, '0');
  return `${tsHex}-${tsMid}-4${hex2(rand[1] & 0x0f)}-${hex2(b0)}${hex2(rand[3])}-${hex2(b1)}${hex2(rand[4])}${hex2(rand[5])}${hex2(rand[6])}${hex2(rand[7])}`;
}

// ── NOS builder (V7/V8/V9-verified field order) ─────────────────────────────

// apiv3 orderType → FIX 40 + TIF. FOK/GTD are Spot-only on FIX — REFUSED loud.
const ORDER_TYPE_MAP = {
  mkt: { type: '1' },
  lmt: { type: '2', tif: '1' },
  ioc: { type: '2', tif: '3' },
  stp: { type: '3' },
  stp_limit: { type: '4' },
  take_profit: { type: 'R' },
  take_profit_limit: { type: 'T' },
  trailing_stop: { type: 'U' },
};

/**
 * Build the NOS (35=D) body for a derivatives order. Field order is BYTE-PINNED
 * (V7/V8/V9): 11|55|54|40|[44|99]|38|59|18|60. 18 always contains "s" (mandatory
 * on derivatives) plus E (reduce-only) / P (post-only) when requested.
 * @param {object} o
 * @param {string} o.clOrdId - COMB UUID (bare — NO prefix; prefixing breaks the
 *        server's COMB timestamp validation)
 * @param {string} o.symbol - PF_* native symbol
 * @param {'buy'|'sell'} o.side
 * @param {string} o.orderType - apiv3-style: mkt|lmt|ioc|stp|take_profit|trailing_stop
 * @param {number} [o.limitPrice] - quote currency (44) — limit-like orders
 * @param {number} [o.stopPrice] - quote currency (99) — stop-like orders
 * @param {number} o.qty - BASE-ASSET denominated (contracts × contract_size)
 * @param {'1'|'3'} [o.tif] - GTC(1)/IOC(3); derived from orderType when omitted
 * @param {boolean} [o.reduceOnly]
 * @param {boolean} [o.postOnly]
 * @param {string} o.transactTime - YYYYMMDD-HH:MM:SS.uuu UTC (REQUIRED)
 * @returns {{body: string}} the SOH-joined NOS body (35=D added by the caller)
 */
export function buildNosBody({ clOrdId, symbol, side, orderType, limitPrice, stopPrice, qty, tif, reduceOnly, postOnly, transactTime }) {
  const mapped = ORDER_TYPE_MAP[String(orderType || '').toLowerCase()];
  if (!mapped) throw new Error(`[AM65] buildNosBody: unsupported orderType '${orderType}'`);
  if (String(orderType).toLowerCase() === 'fok' || String(orderType).toLowerCase() === 'gtd') {
    throw new Error('[AM65] FOK/GTD are Spot-only on FIX — refused on derivatives');
  }
  const resolvedTif = tif || mapped.tif;
  if (resolvedTif !== '1' && resolvedTif !== '3') {
    throw new Error(`[AM65] TIF '${resolvedTif}' is not GTC(1)/IOC(3) — refused on derivatives`);
  }
  const isLimitLike = mapped.type === '2' || mapped.type === '4' || mapped.type === 'T';
  const isStopLike = ['3', '4', 'R', 'T', 'U'].includes(mapped.type);
  if (isLimitLike && (limitPrice === undefined || limitPrice === null)) {
    throw new Error(`[AM65] orderType '${orderType}' requires limitPrice (44)`);
  }
  if (isStopLike && (stopPrice === undefined || stopPrice === null)) {
    throw new Error(`[AM65] orderType '${orderType}' requires stopPrice (99)`);
  }
  // ExecInst: "s" is MANDATORY on derivatives; E/P ride as space-separated extras.
  let execInst = 's';
  if (reduceOnly) execInst += ' E';
  if (postOnly) execInst += ' P';
  const fields = [
    `11=${clOrdId}`,
    `55=${symbol}`,
    `54=${side === 'buy' ? '1' : '2'}`,
    `40=${mapped.type}`,
  ];
  if (limitPrice !== undefined && limitPrice !== null) fields.push(`44=${limitPrice}`);
  if (stopPrice !== undefined && stopPrice !== null) fields.push(`99=${stopPrice}`);
  fields.push(
    `38=${qty}`,
    `59=${resolvedTif}`,
    `18=${execInst}`,
    `60=${transactTime}`,
  );
  return { body: fields.join(SOH) };
}

/** UTC TransactTime in the docs' format: YYYYMMDD-HH:MM:SS.uuu */
export function fixTransactTime(nowMs = Date.now()) {
  const d = new Date(nowMs);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}`;
}

// ── config resolution (loud, never silent) ──────────────────────────────────

/**
 * Resolve the FIX session config for a tenant. Order: vault fix_sender_comp_id →
 * env KRAKEN_FIX_SENDER_COMPID → LOUD refusal naming the missing piece.
 * The FIX key/secret ride the EXISTING 'krakenfutures' vault row (the FIX key is
 * a Spot key even when used for derivatives — same credential pair).
 * @param {object} o
 * @param {object} o.supabase
 * @param {string} o.tenantId
 * @param {object} o.creds - { apiKey, apiSecret } from retrieveAPIKey('krakenfutures')
 * @returns {Promise<{senderCompId:string, apiKey:string, apiSecret:string, source:string}>}
 */
export async function resolveFixConfig({ supabase, tenantId, creds }) {
  let senderCompId = null;
  let source = null;
  if (supabase && tenantId) {
    try {
      const { data } = await supabase
        .from('api_keys_vault')
        .select('fix_sender_comp_id')
        .eq('tenant_id', tenantId)
        .eq('exchange', 'KRAKENFUTURES')
        .eq('is_active', true)
        .single();
      if (data?.fix_sender_comp_id) {
        senderCompId = String(data.fix_sender_comp_id).trim();
        source = 'vault';
      }
    } catch (e) {
      console.warn(`[AM65] resolveFixConfig: vault read failed for tenant ${tenantId}: ${e.message}`);
    }
  }
  if (!senderCompId && process.env.KRAKEN_FIX_SENDER_COMPID) {
    senderCompId = String(process.env.KRAKEN_FIX_SENDER_COMPID).trim();
    source = 'env';
  }
  if (!senderCompId) {
    throw new Error('[AM65] KRF FIX not provisioned: no SenderCompID on file (api_keys_vault.fix_sender_comp_id or KRAKEN_FIX_SENDER_COMPID). Ask your Kraken agent for the DRV SenderCompID, then set it in Settings.');
  }
  if (!creds || !creds.apiKey || !creds.apiSecret) {
    throw new Error('[AM65] KRF FIX not provisioned: no FIX API key/secret on the krakenfutures vault row.');
  }
  return { senderCompId, apiKey: creds.apiKey, apiSecret: creds.apiSecret, source };
}

// ── session (owner process only) ─────────────────────────────────────────────

const HEARTBEAT_SECONDS = 60;
const TESTREQUEST_AT_MS = HEARTBEAT_SECONDS * 1000 * 1.5;   // 1.5× silence
const DESTROY_AT_MS = HEARTBEAT_SECONDS * 1000 * 2.5;       // 2.5× silence

/**
 * One FIX trading session (owner process only). TLS 1.3, logon with 141=Y,
 * heartbeat + TestRequest supervision, ER dispatch, fill ledger (D2).
 * NEVER constructed for the same tenant twice — the Map below enforces it.
 * Exported for the probe route's THROWAWAY session (a probe must never register
 * in the owner's session Map — peekFixSession stays null afterwards).
 */
export class KrakenFixSession {
  /**
   * @param {object} o
   * @param {string} o.tenantId
   * @param {string} o.senderCompId
   * @param {string} o.apiKey
   * @param {string} o.apiSecret
   */
  constructor({ tenantId, senderCompId, apiKey, apiSecret }) {
    this.tenantId = tenantId;
    this.senderCompId = senderCompId;
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.targetCompId = KRF_FIX_TARGET_TRD;
    this.seqNum = 1;               // 141=Y resets BOTH sides every connect
    this.socket = null;
    this.loggedIn = false;
    this.streamBuf = '';
    this.lastRecvAt = 0;
    this.heartbeatTimer = null;
    this.waiters = new Map();      // clOrdId → { resolve, timer }
    this.erHistory = [];           // bounded ER log (forensics)
    this.fillLedger = new Map();   // symbol → { netQty, lastCumFee137 }
    this.rejects = [];             // bounded 35=3 / 35=j log
    this.destroyed = false;
  }

  /** TLS connect + logon. Resolves DNS AT CONNECT (5-min TTL doctrine). */
  async connect() {
    if (this.destroyed) throw new Error('[AM65] session already destroyed');
    const host = KRF_FIX_HOST;
    await new Promise((resolve, reject) => {
      const socket = tls.connect({
        host,
        port: KRF_FIX_PORT_DRV_TRD,
        // TLS 1.3 per docs. UAT may skip verification; prod must NOT.
        minVersion: 'TLSv1.3',
        rejectUnauthorized: process.env.KRF_FIX_TLS_SKIP_VERIFY === '1' ? false : true,
        servername: host,
      }, () => {
        this.socket = socket;
        resolve();
      });
      socket.on('error', (e) => { if (!this.socket) reject(e); else this._onSocketError(e); });
      socket.setNoDelay(true);
      socket.on('data', (chunk) => this._onData(chunk));
      socket.on('close', () => this._onClose());
      socket.setTimeout(15000, () => { if (!this.socket) { socket.destroy(); reject(new Error(`[AM65] TLS connect timeout to ${host}:${KRF_FIX_PORT_DRV_TRD}`)); } });
    });
    await this._logon();
    this.lastRecvAt = Date.now();
    this.heartbeatTimer = setInterval(() => this._heartbeatTick(), 5000);
    if (typeof this.heartbeatTimer.unref === 'function') this.heartbeatTimer.unref();
  }

  async _logon() {
    const nonce = String(Date.now()); // ±5s window — fresh at connect (E2)
    const { password } = fixLogonPassword({
      msgSeqNum: String(this.seqNum),
      senderCompId: this.senderCompId,
      targetCompId: this.targetCompId,
      apiKey: this.apiKey,
      apiSecret: this.apiSecret,
      nonce,
    });
    const body = [
      `35=A`,
      `34=${this.seqNum}`,
      `49=${this.senderCompId}`,
      `56=${this.targetCompId}`,
      // 52 SendingTime
      `52=${fixTransactTime()}`,
      `98=0`,
      `108=${HEARTBEAT_SECONDS}`,
      `553=${this.apiKey}`,
      `554=${password}`,
      `5025=${nonce}`,
      `141=Y`,
      // 8674 UNSET → CoD default 0 = cancel session orders on disconnect (safety).
    ].join(SOH);
    this.seqNum += 1;
    this._send(buildFixMessage(body));
    // Await the server Logon ack (35=A back) or Logout (35=5).
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('[AM65] logon timed out (no ack in 15s)')), 15000);
      this._logonWaiter = { resolve, reject, timer };
    });
  }

  _send(msg) {
    if (!this.socket || this.destroyed) throw new Error('[AM65] session socket is not open');
    this.socket.write(msg, 'utf8');
  }

  _onData(chunk) {
    this.lastRecvAt = Date.now();
    this.streamBuf += chunk.toString('utf8');
    const { messages, rest } = parseFixStream(this.streamBuf);
    this.streamBuf = rest;
    for (const msg of messages) this._dispatch(parseFixFields(msg), msg);
  }

  _dispatch(f, raw) {
    const type = f['35'];
    if (type === 'A') { // logon ack
      if (this._logonWaiter) { clearTimeout(this._logonWaiter.timer); this._logonWaiter.resolve(); this._logonWaiter = null; }
      this.loggedIn = true;
      return;
    }
    if (type === '5') { // Logout — log LOUD, destroy
      console.error(`[AM65] FIX Logout received for tenant ${this.tenantId}: 58=${f['58'] || 'no text'}`);
      this.loggedIn = false;
      if (this._logonWaiter) { clearTimeout(this._logonWaiter.timer); this._logonWaiter.reject(new Error(`[AM65] logon rejected: 58=${f['58'] || 'logout'}`)); this._logonWaiter = null; }
      this.destroy().catch(() => {});
      return;
    }
    if (type === '3') { // session-level reject
      this.rejects.push({ at: Date.now(), raw });
      console.error(`[AM65] FIX session-level reject (35=3) for tenant ${this.tenantId}: ${raw}`);
      return;
    }
    if (type === 'j') { // business-level reject
      this.rejects.push({ at: Date.now(), raw });
      const clOrdId = f['11'] || null;
      console.error(`[AM65] FIX business-level reject (35=j) for tenant ${this.tenantId}: 58=${f['58'] || ''} 11=${clOrdId || 'n/a'}`);
      const waiter = clOrdId ? this.waiters.get(clOrdId) : null;
      if (waiter) {
        clearTimeout(waiter.timer);
        this.waiters.delete(clOrdId);
        waiter.resolve({ rejected: true, reason: f['58'] || 'business reject', raw });
      }
      return;
    }
    if (type === '2') { // ResendRequest — we never replay (141=Y doctrine): respond GapFill
      const gapFill = buildFixMessage([
        `35=4`, `34=${this.seqNum}`, `49=${this.senderCompId}`, `56=${this.targetCompId}`,
        `52=${fixTransactTime()}`, `123=Y`, `36=${f['7'] || this.seqNum}`, `10=x`,
      ].join(SOH).replace(`${SOH}10=x`, '')); // buildFixMessage adds 10
      this.seqNum += 1;
      try { this._send(gapFill); } catch { /* socket closing */ }
      return;
    }
    if (type === '1') { // TestRequest — respond Heartbeat
      try {
        this.seqNum += 1;
        this._send(buildFixMessage([
          `35=0`, `34=${this.seqNum}`, `49=${this.senderCompId}`, `56=${this.targetCompId}`,
          `52=${fixTransactTime()}`,
        ].join(SOH)));
      } catch { /* socket closing */ }
      return;
    }
    if (type === '0') return; // Heartbeat — liveness only
    if (type === '8') { this._onExecutionReport(f, raw); return; }
    if (type === 'y') { // SecurityList (probe path)
      if (this._slrWaiter) { this._slrWaiter.push(raw); }
      return;
    }
    // Unknown admin/message type — log loud, never crash the session.
    console.warn(`[AM65] FIX unhandled message type 35=${type} for tenant ${this.tenantId}`);
  }

  _onExecutionReport(f, raw) {
    const clOrdId = f['11'] || null;
    const execType = f['150'] || null;
    const symbol = f['55'] || null;
    this.erHistory.push({ at: Date.now(), f });
    if (this.erHistory.length > 500) this.erHistory.shift();
    // Fill ledger (D2): ExecType=F updates net filled qty per symbol.
    if (execType === 'F' && symbol) {
      const side = f['54'] === '1' ? 1 : -1;
      const lastQty = parseFloat(f['32']) || 0;
      const ledger = this.fillLedger.get(symbol) || { netQty: 0, lastCumFee137: null };
      ledger.netQty += side * lastQty;
      // E3: tag 137 is CUMULATIVE — per-fill fee = delta vs the previous trade.
      const cum137 = f['137'] != null ? parseFloat(f['137']) : null;
      let fillFee = null;
      if (cum137 != null) {
        fillFee = ledger.lastCumFee137 == null ? cum137 : Math.max(0, cum137 - ledger.lastCumFee137);
        ledger.lastCumFee137 = cum137;
      }
      ledger.lastFill = {
        at: Date.now(), price: parseFloat(f['31']) || null, qty: lastQty,
        fee: fillFee, feeCurrency: f['138'] || null, cumQty: parseFloat(f['14']) || null,
        avgPx: parseFloat(f['6']) || null, grossTradeAmt: parseFloat(f['381']) || null,
        ordStatus: f['39'] || null, text: f['58'] || null, execId: f['17'] || null,
      };
      this.fillLedger.set(symbol, ledger);
    }
    // Unsolicited cancel after ack = post-ack business failure (docs) — LOUD.
    if (execType === '4' && f['39'] === '4' && clOrdId && this.waiters.has(clOrdId)) {
      console.error(`[AM65] FIX unsolicited cancel (post-ack business failure) for ${clOrdId}: 58=${f['58'] || ''}`);
    }
    const waiter = clOrdId ? this.waiters.get(clOrdId) : null;
    if (waiter) {
      // Terminal states: Filled(2)/Canceled(4)/Expired(C) on 39, or any F trade
      // when the caller only needs the fill. Non-terminal → keep waiting.
      const ordStatus = f['39'];
      const terminal = ordStatus === '2' || ordStatus === '4' || ordStatus === 'C';
      if (execType === 'F' || terminal) {
        clearTimeout(waiter.timer);
        this.waiters.delete(clOrdId);
        waiter.resolve({
          rejected: false,
          execType, ordStatus,
          lastPx: f['31'] != null ? parseFloat(f['31']) : null,
          lastQty: f['32'] != null ? parseFloat(f['32']) : null,
          cumQty: f['14'] != null ? parseFloat(f['14']) : null,
          avgPx: f['6'] != null ? parseFloat(f['6']) : null,
          leavesQty: f['151'] != null ? parseFloat(f['151']) : null,
          orderId: f['37'] || null,
          text: f['58'] || null,
          raw,
        });
      }
    }
  }

  _heartbeatTick() {
    if (this.destroyed || !this.socket) return;
    const silence = Date.now() - this.lastRecvAt;
    if (silence >= DESTROY_AT_MS) {
      console.error(`[AM65] FIX session silence ${Math.round(silence / 1000)}s ≥ 2.5× heartbeat — destroying session for tenant ${this.tenantId}`);
      this.destroy().catch(() => {});
      return;
    }
    if (silence >= TESTREQUEST_AT_MS) {
      try {
        this.seqNum += 1;
        this._send(buildFixMessage([
          `35=1`, `34=${this.seqNum}`, `49=${this.senderCompId}`, `56=${this.targetCompId}`,
          `52=${fixTransactTime()}`, `112=${this.seqNum}`,
        ].join(SOH)));
      } catch { /* socket closing */ }
    }
  }

  _onSocketError(e) {
    console.error(`[AM65] FIX socket error for tenant ${this.tenantId}: ${e.message}`);
  }

  _onClose() {
    this.loggedIn = false;
    // CoD (8674 unset → default 0) already cancelled session orders exchange-side.
    // LOUD: the watchdog supervises liveness and alerts on logon loss.
    console.error(`[AM65] FIX session CLOSED for tenant ${this.tenantId} (CoD default-ON cancelled session orders exchange-side).`);
    for (const [clOrdId, waiter] of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve({ rejected: true, reason: 'session closed', raw: null });
    }
    this.waiters.clear();
  }

  /**
   * Send a NOS and await its terminal ER (promise + timeout — AM59 receipt
   * semantics preserved at the caller).
   * @param {object} nosArgs - buildNosBody args
   * @param {number} [timeoutMs]
   * @returns {Promise<object>} terminal ER summary or { rejected, reason }
   */
  async newOrderSingle(nosArgs, timeoutMs = 10000) {
    const body = buildNosBody(nosArgs).body;
    const full = [`35=D`, `34=${this.seqNum}`, `49=${this.senderCompId}`, `56=${this.targetCompId}`, `52=${fixTransactTime()}`, body].join(SOH);
    this.seqNum += 1;
    const waiter = { resolve: null, timer: null };
    const promise = new Promise((resolve) => { waiter.resolve = resolve; });
    waiter.timer = setTimeout(() => {
      this.waiters.delete(nosArgs.clOrdId);
      waiter.resolve({ rejected: false, timeout: true, reason: `ER wait timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    this.waiters.set(nosArgs.clOrdId, waiter);
    this._send(buildFixMessage(full));
    return promise;
  }

  /** 35=F cancel (same-session orders only — docs warning). */
  async cancelOrder({ clOrdId, orderId }, timeoutMs = 10000) {
    const fields = [
      `35=F`, `34=${this.seqNum}`, `49=${this.senderCompId}`, `56=${this.targetCompId}`,
      `52=${fixTransactTime()}`,
      `41=${clOrdId || orderId}`, // OrigClOrdID
      `11=${combClOrdId()}`,      // new ClOrdID for the cancel request itself
      `37=${orderId || ''}`,
      `55=`, // symbol optional on cancel; Kraken matches on 41/37
    ].filter((x) => !x.endsWith('=')).join(SOH);
    this.seqNum += 1;
    this._send(buildFixMessage(fields));
    // The cancel's outcome arrives as an ER (ExecType=4) on the ORIGINAL ClOrdID.
    if (!clOrdId) return { sent: true };
    const waiter = { resolve: null, timer: null };
    const promise = new Promise((resolve) => { waiter.resolve = resolve; });
    waiter.timer = setTimeout(() => {
      this.waiters.delete(clOrdId);
      waiter.resolve({ rejected: false, timeout: true, reason: 'cancel ER wait timed out' });
    }, timeoutMs);
    this.waiters.set(clOrdId, waiter);
    return promise;
  }

  /** 35=q MassCancel type 7 — account-wide, any origin (the dead-man analog). */
  async massCancelAll(timeoutMs = 10000) {
    const fields = [
      `35=q`, `34=${this.seqNum}`, `49=${this.senderCompId}`, `56=${this.targetCompId}`,
      `52=${fixTransactTime()}`,
      `530=7`,          // MassCancelRequestType 7 = cancel all orders (docs)
      `11=${combClOrdId()}`,
    ].join(SOH);
    this.seqNum += 1;
    this._send(buildFixMessage(fields));
    // MassCancelReport (35=r) is not awaited — fire-and-forget with a loud log on
    // the next reject. The watchdog's liveness supervision covers delivery.
    return { sent: true };
  }

  /** SecurityListRequest (35=x) — the probe's instrument-universe read. */
  async securityList({ symbol } = {}, timeoutMs = 10000) {
    const fields = [
      `35=x`, `34=${this.seqNum}`, `49=${this.senderCompId}`, `56=${this.targetCompId}`,
      `52=${fixTransactTime()}`,
      `320=SLS${Date.now()}`,
      `559=0`,
    ];
    if (symbol) fields.push(`55=${symbol}`);
    this.seqNum += 1;
    this._slrWaiter = [];
    this._send(buildFixMessage(fields.join(SOH)));
    await new Promise((r) => setTimeout(r, Math.min(timeoutMs, 4000)));
    const out = this._slrWaiter;
    this._slrWaiter = null;
    return out;
  }

  /** Net filled qty per symbol from the session ER ledger (D2). */
  getPositionEstimate(symbol) {
    const ledger = this.fillLedger.get(symbol);
    if (!ledger) return { known: false, netQty: 0 };
    return { known: true, netQty: ledger.netQty, lastFill: ledger.lastFill || null };
  }

  async destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.socket) {
      try {
        // Polite Logout before teardown.
        this._send(buildFixMessage([
          `35=5`, `34=${this.seqNum}`, `49=${this.senderCompId}`, `56=${this.targetCompId}`,
          `52=${fixTransactTime()}`, `58=client shutdown`,
        ].join(SOH)));
      } catch { /* already closing */ }
      this.socket.destroy();
      this.socket = null;
    }
  }
}

// ── per-tenant session registry (OWNER process only — E6) ───────────────────
const sessions = new Map(); // tenantId → KrakenFixSession

/**
 * Get-or-create the tenant's FIX session. Owner process ONLY — non-owner callers
 * must proxy through the gateway (E6). A second live session on the same
 * SenderCompID kicks the first (CoD then cancels its resident orders).
 * @param {object} o
 * @param {string} o.tenantId
 * @param {{senderCompId:string, apiKey:string, apiSecret:string}} o.config - resolveFixConfig output
 * @returns {Promise<KrakenFixSession>}
 */
export async function getFixSession({ tenantId, config }) {
  if (!isSessionOwnerProcess()) {
    throw new Error('[AM65] getFixSession called in a non-owner process — proxy through the gateway instead (E6).');
  }
  const existing = sessions.get(tenantId);
  if (existing && existing.loggedIn && !existing.destroyed) return existing;
  if (existing && !existing.destroyed) await existing.destroy().catch(() => {});
  const session = new KrakenFixSession({ tenantId, ...config });
  await session.connect();
  sessions.set(tenantId, session);
  return session;
}

/** Peek a live session without creating one (watchdog liveness + probe guard). */
export function peekFixSession(tenantId) {
  const s = sessions.get(tenantId);
  return s && s.loggedIn && !s.destroyed ? s : null;
}

/** Destroy a tenant's session (watchdog supervision / operator action). */
export async function destroyFixSession(tenantId) {
  const s = sessions.get(tenantId);
  if (s) {
    await s.destroy().catch(() => {});
    sessions.delete(tenantId);
  }
}

// ── gateway proxy (non-owner processes — E6) ────────────────────────────────

/**
 * Proxy a private FIX operation to the owner process over the EXISTING
 * mcp-gateway HTTP surface (app.post('/mcp/execute') pattern). The gateway adds
 * the AM65 tool in Commit B; this client posts to it.
 * @param {object} o
 * @param {'nos'|'cancel'|'mass_cancel'|'position'|'liveness'} o.op
 * @param {object} o.payload - op-specific args (already tenant-scoped by the caller)
 * @returns {Promise<object>} the owner's verdict
 */
export async function proxyFixOp({ op, payload }) {
  const base = process.env.KRF_FIX_GATEWAY_URL || `http://127.0.0.1:${process.env.MCP_GATEWAY_PORT || '8000'}`;
  const resp = await fetch(`${base}/mcp/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: 'krf_fix_private', arguments: { op, ...payload } }),
    signal: AbortSignal.timeout(20000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`[AM65] FIX proxy HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  const json = await resp.json();
  return json?.result ?? json;
}
