# AM63 — Push 5: The Real Kraken (apiv3 futures, paper-first) + the Dashboard Matrix

**Goal:** the user's Kraken account trades spot/margin/perps/futures (unified,
non-US-gated experience) — this push brings the REAL Kraken Futures (apiv3) into
the platform paper-first, AND extends the venue pattern to the dashboard asset
matrix so "select venue → the whole matrix populates" applies everywhere, not just
Studio. LIVE Kraken Futures refuses loud until Push 6 (apiv3 sendorder + AM59 fill
doctrine), exactly like Bitnomial did in Push 4.

NAMING DECISION (do not churn): the routing literal `'kraken'` STAYS = Bitnomial
(Kraken Derivatives US). The new venue literal is **`'krakenfutures'`**. UI labels
disambiguate — nobody sees raw literals. Asset ids: Kraken Futures uses
**`${BASE}-PERP-KRF`** (INTX=Coinbase, KRX=Bitnomial, KRF=Kraken Futures). No
size suffix — apiv3 has ONE perp per base (probed: 207 PF_, dup bases NONE).

## LIVE-PROBED RECEIPTS (2026-10-15, public, no auth)

1. `GET https://futures.kraken.com/derivatives/api/v3/instruments` →
   `{ result:'success', instruments:[…] }`, 229 rows. Per-instrument keys include:
   `symbol` (PF_XBTUSD style), `type` ('futures_inverse'|'flexible_futures'),
   `base` (XBT — clean field, unlike Bitnomial's polluted base_symbol), `quote`
   (USD), `contractSize`, `tickSize`, `tradeable`, `suspended`, `isExpired`,
   `maxPositionSize`, `marginLevels`, `feeScheduleUid`, `openingDate`,
   `countriesBanned`, `postOnly`, `tags`.
2. `GET /derivatives/api/v3/tickers` → `{ result:'success', tickers:[…] }`, 229
   rows, keys: `symbol, markPrice, last, bid, ask, bidSize, askSize, high24h,
   low24h, open24h, change24h, vol24h, volumeQuote, vwap24h, openInterest,
   fundingRate, fundingRatePrediction, relativeFundingRate, indexPrice, postOnly,
   suspended, tag, lastTime`. ONE call = the whole stats surface.
   **NOTE:** `indexPrice` was NOT observed in the live payload → mapped defensively.
3. Charts (phase-0 verified): `https://futures.kraken.com/api/charts/v1/trade/{sym}/{res}`
   — public OHLC, 2000 bars/call. **PROBE RESULT (2026-10-15):** 1m/5m/15m/30m/1h/4h/1d
   EXIST; 2h and 6h return HTTP 400. `time` is epoch MILLISECONDS; OHLC+volume are
   STRINGS. This decided the chart/structure wiring in Commit B.
4. Demo env: same paths under `https://demo-futures.kraken.com` (identical shapes,
   free signup). Provider gains a host override knob so the operator can aim at
   demo without code changes. No auth anywhere in THIS push (public endpoints
   only) — the apiv3 private layer (HMAC-SHA512: Authent = Base64(HMAC-SHA512(
   b64decode(secret), SHA256(urlencoded-postData + nonce + endpointPath)), Oct-2025
   hashing change) is Push 6.
5. Rate limits: apiv3 is a COST budget (500/10s shared; sendorder costs 10 — n/a
   until Push 6). Public reads are cheap; still route EVERY apiv3 call through the
   provider's own budgeted limiter (loud `[AM63]` on self-throttle; never fire-and-forget).

## Commit A (inert) — the provider

`lib/providers/kraken-futures.js` (crate-parity with kraken-bitnomial.js/coinbase.js):

1. `kfRequest({ method, path, query })` → RAW fetch Response; `globalThis.fetch`
   at call time; NO new AbortSignal.timeouts; every call draws from a shared
   cost-budget limiter `'kfRateLimiter'`; retry 429-style budget errors with the
   same shape as btFetch. NO credentials in this file at all (public-only — Push 6
   adds the signer; say so in a header comment so no one "completes" it early).
2. `KF_HOST` constant (default prod) + optional env override for demo; the ONE
   place the hostname appears outside config (seam doctrine mirrors: gate scan
   covers `futures.kraken.com` exclusivity like `bitnomial`).
3. `getKrakenTickers()` — ONE `/tickers` call, ≥15s cache →
   `{ [symbol]: {markPrice,last,bid,ask,indexPrice,fundingRate,openInterest,vol24h,lastTime} }`.
   Price rule: `markPrice` primary, `last` fallback (same discipline as KRX).
4. `getKrakenInstruments()` — ONE `/instruments` call, ≥1h cache, filtered to
   `symbol.startsWith('PF_') && tradeable && !suspended && !isExpired` → id-keyed
   map `{ [id]: { id, nativeSymbol, base (XBT→BTC normalized), quote, contractSize,
   tickSize, maxPositionSize } }`. BASE = instrument.base with the XBT→BTC display
   normalization; native_symbol preserved.
5. `resolveKrakenFuturesProduct(id)` — the ONE id→instrument door (call-time
   resolve, unknown → loud `{error}`), same contract as `resolveKrakenProduct`.
6. NOTHING behavior-bearing imports this module yet (INERT scan same as Push 4).

## Commit B (enforcing) — paper + the populate-everything matrix

1. **catalog** — `available-assets.js:#exchange=krakenfutures` → branch to a
   handler that maps instruments+tickers to the Studio/matrix shape:
   `{ id:'BTC-PERP-KRF', name, base:'BTC', price:markPrice (venue price, NOT 0 —
   Kraken has real marks unlike KRX), volume_24h:vol24h,
   price_percentage_change_24h:change24h, native_symbol, contract_size:contractSize,
   tick_size, exchange:'krakenfutures' }`, sort by vol24h desc, cap 100. Unknown
   venue → 400 `[AM63]` (existing rule). **ALL PF_ instruments surfaced** (crypto,
   equities, commodities, indices, pre-IPO) — the matrix is venue-truthful.
2. **router** — `assertExchangeSupported` allowlist widens to
   `['coinbase','kraken','krakenfutures']` (body-only; exports stay 2; push2-check
   evolves in-commit: krakenfutures passes, 'bybit' still throws — negative control
   doctrine).
3. **execute-trade krakenfutures lane** — mirror of the kraken lane:
   `resolvedExchange === 'krakenfutures'` (or id `-PERP-KRF` suffix detection for
   cross-field typos) → LIVE refuses `[AM63] Kraken Futures live execution arrives
   in Push 6 (apiv3 sendorder). Venue runs paper-only until then.` ; PAPER entry
   priced at `getKrakenTickers` mark for the resolved instrument, tick-rounded with
   the instrument's OWN tickSize (do NOT round with a coinbase-derived tick — the
   KRX polish gap must not repeat here), multiplier = contractSize, risk-validator
   assetSpecs carries krakenfutures contract_size, native symbol telemetry-only.
4. **Watchdog sweep** — same lane shape as KRX: venue mark from tickers (missing
   row / null payload → loud skip + agent-log row `KRF_STATS_UNAVAILABLE`,
   catch-and-continue), getAssetMetrics venue branch (multiplier+tick from
   instrument), buildWatchdogChart: kr-futures → REAL candles via the new chart
   route (probe confirmed 1m/5m/15m/30m/1h/4h/1d).
5. **Candle bridge (`lib/candles.js` + `pages/api/chart-data.js`)** — the KRF
   real-OHLC route: `fetchCandles` gains a `-PERP-KRF` backend hitting
   `/api/charts/v1/trade/{symbol}/{res}` (unauthenticated, via the provider's
   kfRequest). Maps our granularity enums to their res codes (probe-proven set),
   loud-empty unknown granularities (2h/6h). `chart-data.js` routes `-PERP-KRF` ids
   to this backend so the DASHBOARD CHART PANEL works for the real Kraken (this is
   the piece that makes the matrix feel real instead of names-on-a-list).
   **reevaluate-trade**: kr-futures trades SKIP the loud refuse because the candle
   probe proved the needed granularities exist — the oracle path runs on venue
   candles (structure_direction computed from REAL Kraken OHLC — a first for the
   multi-venue program).
6. **Dashboard matrix (components/MarketScanner.js)** — the user's headline ask:
   - Venue select FIRST in the header: COINBASE | Kraken US (Bitnomial) |
     Kraken Futures. Values lowercase literals. Reuse the AM63 stale-race pattern
     (`fetchedVenueRef`-style) for the matrix fetch.
   - Matrix fetch honors `?exchange=` (both Coinbase byte-identical when venue is
     absent/coinbase; kraken venues repopulate the WHOLE matrix).
   - On swap: clear selection + favorites view + deploy panel (no cross-venue carry).
   - Tab filters venue-aware: PERPS = id contains `-PERP-` (works for all venues),
     FUTURES (-CDE) = Coinbase-only tab (empty-loud on kraken venues),
     FAVORITES/ACTIVE_STRATEGIES per-venue scoped.
   - Deploy matrix POST adds `exchange: venue` (subscribe-strategy already
     normalizes lowercase — zero backend change).
   - Chart panel + scan widgets: KRF = real OHLC route; KRX = honest empty-state;
     Coinbase unchanged.
7. **Favorites per venue — migration 062**: `alter table favorite_assets add
   column if not exists venue text not null default 'coinbase'` — fresh column,
   so default+NOT NULL IMMEDIATELY (no one-way-door risk; the 061 lesson is
   documented). Favorite toggle/uniqueness keys become (tenant_id, asset, venue).
   UI favorites read/write the venue of the CURRENT matrix venue.
8. **Studio** — the BACKTEST Venue select gains the third option
   (`Kraken Futures`); backtest itself still refuses loudly (`backtest-service`
   guard classes cover any non-coinbase) — Studio catalog just exposes the universe.
9. **Settings** — vault gains `KRAKENFUTURES` option (labels: "API Key (apiv3)" /
   "API Secret (base64)" placeholders; stored for Push 6; no backend change).
10. **shadow-portfolio** — extend the Coinbase-lane skip to `-PERP-KRF` ids
    (kr-futures strategies shadow-skipped loudly, parity deferred).
11. **close-position** — a krakenfutures branch mirroring the kraken venue branch
    (venue mark; null on failure → user price fallback). Without it a KRF close
    would fall through to the Coinbase spot ticker (wrong price).
12. **deploy-strategy** — `KNOWN_EXCHANGES` widens to
    `['coinbase','kraken','krakenfutures']` so Studio can deploy the KRF universe.

## Migrations

**062-favorites-venue.sql** (paste BEFORE Commit B deploy, Option A precedent):
fresh column + default + NOT NULL + (idempotent normalize step for any crafted
values — none exist today) + a (tenant_id, asset, venue) unique index. No
strategy_config/trade_logs changes (exchange column already exists and carries
lowercase 'krakenfutures' writes freely).

## Gate: `scripts/am63-push5-check.mjs` (new)

Provider pins (host exclusivity for futures.kraken.com + demo override, no
credentials in provider, limiter-wraps-egress, raw Response, cache TTLs, id pattern
`-PERP-KRF` no-size, base normalization), catalog branch (+ price≠0 for KRF),
router allowlist (3 venues; 'bybit' still throws), execute-trade/lane semantics
(paper mark entry, tick from instrument, live refusal text), watchdog + chart
route + reevaluate branch AS SHIPPED (reports the probe outcome it pinned),
MarketScanner venue wiring + stale-race + favorites-venue + deploy exchange carry,
062 shape, seam/push2/push3/push4 invariants intact (push4's KRX door untouched).

## Verification battery

push5 58/58 · push4 48/48 (KRX door intact) · push3 38/38 · push2 23/23 · seam PASS ·
am62b 44/44 · am53c 15/15 + 4/4 · am55 9/3 known · am59 22/0 · eslint 0 ·
node --check 0 · npx next build Compiled successfully.
Manual: dashboard → venue Kraken Futures → 100 KRF assets with live prices grid →
open a KRF asset → chart panel shows REAL Kraken OHLC (30m rifle) → deploy a
strategy on BTC-PERP-KRF → paper trade opens at venue mark with venue-native
telemetry → LIVE kr-futures refuses with the Push 6 message → favorites persist per
venue → Studio shows the same third option.

## Rollback

Revert Commit B → matrices return to Coinbase-only + krak-futures ids refuse; the
062 venue column is additive and stays (older clients read venue='coinbase' rows
fine). Commit A can stay (inert). No destructive DB ops.

## Explicitly excluded (Push 6+)

apiv3 private layer (HMAC-SHA512 signer, APIKey/Authent/Nonce), sendorder +
`sendStatus` phantom-confirmation doctrine (result:'success' ≠ placed), AM59
fill-verified closes for kr-futures LIVE, dead-man (`cancelallordersafter`),
Kraken-venue BACKTESTS (real OHLC makes them POSSIBLE — separate scoping with the
operator: historical depth + fees + funding-in-backtest decisions), fee-value
enrichment (feeSchedule endpoints deprecated; Spot GetTradeVolume needs a spot
key — decide at live push), inverse PI_ / dated FF_ instruments (perps only pushes).
