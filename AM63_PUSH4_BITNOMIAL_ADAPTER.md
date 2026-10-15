# AM63 — Push 4: The Bitnomial Adapter (paper-first, REST-only)

**Goal:** a Kraken config on the platform TRULY trades in PAPER on real Bitnomial
marks — entry priced at venue, exits evaluated at venue, paper closes booked with
venue-native symbols — while LIVE Kraken execution refuses loud until Push 5 (BTP
order entry). Execution stays human-gated as always. No DB migration this push.

Grounding receipts are LIVE-PROBED or cited from bitnomial.com/exchange/docs
(fetched Oct 2026). Anything marked PROBE-AT-BUILD must be live-verified before
the code that depends on it is written.

## Verified external contracts (do not re-guess)

1. **Auth (REST private)** — headers `BTNL-AUTH-TIMESTAMP` (ISO 8601 in the STRICT
   form `YYYY-MM-DDTHH:MM:SS.SSSZ`, ±30 s skew), `BTNL-CONNECTION-ID` (hex string
   as-is), `BTNL-SIGNATURE` = base64(HMAC-SHA256(prehash, authTokenHex-as-utf8)).
   Prehash = `METHOD + requestPath + queryString + headersBlock + body` where:
   - queryString ALWAYS includes `?`, even when empty;
   - headersBlock = `'BTNL-AUTH-TIMESTAMP' + ts + 'BTNL-CONNECTION-ID' + connectionId`
     (name/value concatenated, nothing else);
   - body = raw request body string, empty string when no body.
   Their reference JS uses `CryptoJS.HmacSHA256(prehash, btnlAuthToken)` — the 64-hex
   AuthToken string is used AS BYTES, not hex-decoded. Source:
   bitnomial.com/exchange/docs/api/rest/authentication (their example output
   signature was generated from an AuthToken they did NOT publish — treat our
   local re-implementation as verified by shape + first live call, not by their
   printed signature).
2. **Connection semantics** (docs: connection-ids + btp/login): ConnectionId hex
   → uint64 for BTP; AuthToken 64 hex chars → 32 raw bytes for BTP. One connection
   supports ONE order-entry gateway + ONE pricefeed simultaneously, nothing more.
   A connection sees only its own orders (REST /orders filters by connection).
   **Cancel-on-disconnect is the DEFAULT session behavior** — the loss of a dead-man
   switch endpoint is mitigated, but watchdog isolation remains mandatory.
3. **Order reality (docs: btp/order-entry)** — BTP v4 body, ALL orders are LIMIT
   orders; NO market/stop/stop-limit; TIF = Day | IOC only. `orderId` customer
   unique per connection; `ackId` engine-generated; `(ackId, orderId)` identifies
   an accepted order. → Push 4 does NOT place orders. Push 5's entries/exits are
   marketable IOC limits; resting TP brackets become watchdog-managed Day limits.
4. **Fill schema (docs: rest/fills)** — `GET /fills` (cursor pagination, filters
   begin_time/end_time/symbol/product_id/...): `Fill{ symbol, product_id,
   order_id, connection_id, time, side: 'Bid'|'Ask', price, quantity_requested,
   quantity_filled, liquidity: 'Add'|'Remove'|'SpreadLeg', ack_id, account_id }`.
   This is the AM59 fill-verification source: terminal fill = row with
   `quantity_filled > 0` for the order in question.
5. **REST orders read-side (docs: rest/orders)** — `GET /orders` (history,
   paginated) + `GET /orders/working` (resting; NO pagination; 400 if >10k match).
   Same auth. Read-only — placement does NOT exist in REST.
6. **Market data (live-probed Push 3 + docs)** — public, no auth:
   `/product/specs/?active=true` (catalog; type==='perpetual' ∩ product_status==='active';
   base from `contract_size_unit`, NEVER `base_symbol`) and `/product/data/?active=true`
   (513 rows of stats incl. `last_price`, `mark_price`, `open_interest`, by `product_id`).
   200 req / 5 min bucket for REST. Public JSON WS exists at
   `wss://bitnomial.com/exchange/ws` (subscribe within 10 s; channels trade/book/
   block/status) — **OUT OF SCOPE this push** (stub-free decision: paper pricing
   uses REST stats polls; WS rides with Push 5 where BTP needs a socket stack anyway).
7. **Charts** — REST `/web/charts/price/:id` is a DRAFT daily-OHLC API. Not
   intraday → unsuitable for trigger TFs. Charts stay Coinbase in the UI; Kraken
   chart stays the honest empty state. Backtests stay Coinbase-only.
8. **Rate limit** — 200 req / 5 min shared. The limiter is per-exchange, token-bucket,
   process-local; EVERY outbound Bitnomial REST call (public or private) draws from it.

## Commit A (inert) — the provider

`lib/providers/kraken-bitnomial.js` (seam-to-seam parity with coinbase.js):

1. `signBtRequest({ method, path, query, body, timestamp, connectionId, authToken })`
   → `{ timestamp, signature }` exactly per contract (1). Pure function; export it.
   Include a fixture test in the gate script: sign the doc's GET /fills prehash
   with SHA(repro) and pin the EXPECTED prehash string byte-for-byte in the test
   (we cannot pin their printed signature without their secret — pin OUR prehash
   construction and the header serialization instead, plus a fixed-temperature
   HMAC determinism check).
2. `btRequest({ method, path, query, body, supabase, tenantId, label })` —
   resolves creds via `retrieveAPIKey(supabase, tenantId, 'kraken')` (uppercases to
   `'KRAKEN'` upstream — documented vault asymmetry), signs, sends, **returns the
   RAW fetch Response** (same contract class as `cbRequest`); NO new
   AbortSignal.timeouts where none existed; resolves `globalThis.fetch` at call
   time (AM55/AM59 stub parity). The RSA/JWT doctrine from coinbase.js maps here:
   this file is the ONE place the `BTNL-` header strings + HMAC recipe live.
3. `class BtRateLimiter` — 200 req/5min, shared process-local instance, `acquire()`
   waits/throws on exhaustion with a loud `[AM63]` reason; every Bitnomial HTTP
   call inside the provider flows through it.
4. `getMarketStats({ productIds })` → normalized `{ productId → { last_price,
   mark_price, last_price_time } }` from `/product/data/?active=true` (single call,
   cache ≥15 s per process; the 200/5min bucket makes per-trade single-product
   polling wasteful — always ONE call + cache).
5. `resolveKrakenProduct(id)` — the one-way id map: `BTC-PERP-KRX-0.01` →
   `{ nativeSymbol, productId, contractSize, priceIncrement, base }` resolved
   AT CALL TIME from the specs catalog (cached ≥1 h). The id is identity; the
   native symbol (`PBTCUCZ50`) rolls by quarter and must be re-resolved, never
   stored long-term. Unknown id → loud `null` + reason.
6. NOTHING in this commit may be imported by behavior-bearing code paths (inert):
   guard `available-assets.js` / `execute-trade-mcp.js` etc. stay untouched.

## Commit B (enforcing) — paper on real marks

1. **`execute-trade-mcp.js`:** after `resolvedExchange` (L523-class site):
   - `'kraken' + PAPER` → proceed. Entry `entry_price` = provider
     `getMarketStats([id])` mark/last (loud 502 if unknown); paper trade inserted
     with the SAME vx shape as today, `exchange: 'kraken'`; do NOT touch the
     live-coinbase OCO path for any other venue.
   - `'kraken' + LIVE` → refuse LOUD: `[AM63] Kraken live execution arrives in Push 5
     (BTP order entry). Venue runs paper-only until then.` — never fall back to coinbase.
2. **Paper close/exit pricing bridge (the invisible-fallback trap):** every site
   that computes a paper/PAPER-close price from a candle/ticker fetch must
   branch on the trade's exchange BEFORE calling a Coinbase path:
   - `workers/watchdog.js` sweep: for open PAPER trades with `exchange='kraken'`,
     evaluate tripwire/trail/TP/SL against provider `getMarketStats` mark (price
     in USD; ROE math uses the SAME unit discipline — tripwire/trail in ROE %,
     TP/SL in price %); a rate-limited or empty stats read = skip + loud
     `[AM63] kraken stats unavailable` (never a silent Coinbase-price substitute).
   - `pages/api/reevaluate-trade.js` + any studio path that closes/pnl-prices:
     same branch. Grep `candles|ticker|chart` around paper-close code and list
     the sites in the spec reply for review.
3. **`resolveKrakenProduct` is the ONLY id→symbol door.** Any display/UI string
   keeps the stable `${BASE}-PERP-KRX-${size}` id. trade_logs keeps `symbol` =
   the platform id (parity with coinbase products); the NATIVE symbol goes in
   telemetry params context only (no UI leak, mirror of the CDE precedent).
4. **Settings/creds**: unchanged (Push 3 shipped the KRAKEN vault row + labels).
   Adapter reads via `retrieveAPIKey(..., 'kraken')` only.
5. **Studio UX**: the Kraken hint copy stays; the push adds nothing to charts.

## Doors that stay closed

- No BTP/FIX socket code (Push 5). No Kraken candles/charts (empty-state holds).
- No backtests for kraken (`backtest-service` guard already refuses; message path
  already wired).
- No Kraken entries into market-scanner LIVE gates (`subscribe-strategy` writes
  lowercase; no venue widened beyond the allowlist).
- Portfolio/balance pages stay Coinbase (a Kraken balance surface is Push 5+).

## Gate

`scripts/am63-push4-check.mjs` (new) asserts: provider exists w/ exports
(signBtRequest, btRequest, getMarketStats, resolveKrakenProduct, rate limiter),
prehash/headers shape pins, rate limiter wraps every fetch in the provider,
raw-Response contract, retrieveAPIKey('kraken') usage, execute-trade's kraken
branch (paper proceeds / live refuses with the exact `[AM63]` text), watchdog +
reevaluate pricing branches, zero imports of the provider by inert files in
Commit A, and seam/push2/push3 checks all still pass (R2 must NOT flag Bitnomial
URLs — per-call-expression rule already handles non-Coinbase hosts).

## Verification battery

node scripts/am63-push4-check.mjs → 0; am63-seam-check, am63-push2-check,
am63-push3-check → 0; eslint touched files → 0; node --check plain JS → 0;
npx next build → 0; am53c 4/4 · am55 9/3 (known) · am59 22/0 · am62b 43/43.
Manual: deploy a kraken-paper config end-to-end on the operator's tenant.
First live-signed call (GET /fills 200) happens in the operator smoke, masked
output only — credentials never appear in logs ([REDACTED] doctrine).

## PROBE-AT-BUILD list (live-verify before writing dependents)

- WS trade message schema + whether `product_codes` accepts bare bases ('BTC').
- Fee schedule for perps (docs: market-operations/customer-roles + portal) — only
  needed for PAPER fee parity; if unrestolvable this push, keep the Coinbase
  16bps constant with a TODO(+documented assumption).
- The rest of the BTP order-entry page (Ack/Fill/Closed/Reject/Cancel/Modify
  bodies) — Push 5 groundwork, read + append to the skill's venue-intel file.
- Funding interval math (8h ticks at 00/08/16 UTC) if paper PnL must show carry
  — default: OUT of scope, note only.

## Rollback

Revert Commit B → kraken configs refuse again (paper TRADE rows already inserted
keep their venue stamps; no data rewrite needed). Commit A is inert and can stay.
No destructive DB ops; nothing to paste.

## Explicitly excluded (Push 5)

BTP login `L` (uint64 connId + 32B token), OE message bodies, cancel-on-disconnect
session mgmt, live kraken entries + watchdog-managed IOC exits, balance/positions
UI, WS pricefeed stack, Kraken candles/backtests if a stable OHLC source lands.
