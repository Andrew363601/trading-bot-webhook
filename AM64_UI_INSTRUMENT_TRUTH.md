# AM64 — INSTRUMENT TRUTH: venue-native contract facts in the UI (ONE push)

Operator directive (Oct 16, 2026): "If I trade Coinbase I need the REAL asset to populate with
all its margin/contract info. In futures exchange for spot margin AND derivatives same shit."
UI feels like "every other AI dashboard". Due diligence + validate twice + no bugs. This spec
is written AFTER a full review of origin `af5989c` (pages/, components/, styles/, the
available-assets data layer) and LIVE PROBES of all three venue payloads on Oct 16. Field maps
below are receipts, not guesses — the implementer must NOT freestyle shapes.

## OPERATOR APPROVAL — design preview ratified (Oct 16)

The operator APPROVED the interactive preview `nexus-ui-preview.html` (same repo root —
commit it alongside this spec; it is the VISUAL SOURCE OF TRUTH for this push's UI work).
Per that preview, the following move INTO this push's scope (they were shown in the preview
the operator ratified; deferring them would ship something other than what he approved):

- **Venue accent system (scanner panel only)**: extend `VENUE_META` with an `accent` color
  per venue — coinbase `#0B6BFF`, kraken `#FF8A3C`, krakenfutures `#7C5CFF` — applied via a
  CSS custom property (`--acc`) on the panel root; consume it for: selected-row border +
  wash, active tab underline, venue-dot, notional line accent, primary button. NO global
  theme change — scoped to MarketScanner.js this push.
- **KRX "mark pending" chip**: amber mono chip (`⏳ mark pending`) instead of `$0.00` when
  `price === 0` on kraken rows (preview shows the exact treatment).
- **Instrument Card visual form**: follow the preview's facts-grid (2-col, 1px separators,
  9px uppercase labels, mono values, small muted sub-labels) and the dashed notional strip
  with inline qty input. Content stays the field maps above; the preview shows layout.
- **Toast**: follow the preview's bottom-center toast (border-tinted by kind, auto-dismiss).

STILL AM65 (NOT this push): global typography scale, site-wide color system, landing page,
motion, studio-wide restyle. This push's visual changes stay inside MarketScanner.js (+ the
two small studio.js text changes already scoped).

## FINDINGS (receipt-backed, from origin af5989c)

- **F1 — Asset rows are id + price, nothing else.** `components/MarketScanner.js` L519-523:
  the only data shown per asset is `asset.id` and `asset.price`. No contract size, no tick
  size, no margin facts, no funding, no notional context. This is the core operator complaint.
- **F2 — The Coinbase branch of `pages/api/available-assets.js` throws away derivative
  fields.** L118-127 maps the authenticated v3 products response down to
  `id/name/base/price/volume_24h/price_percentage_change_24h` — every contract field the
  authenticated payload carries is dropped at the mapping step. Note: the PUBLIC
  `api.exchange.coinbase.com/products` does NOT serve INTX perps (probed Oct 16:
  `GET /products/BTC-PERP-INTX` → 404; `/products` has 842 products, zero INTX perps) — the
  INTX truth arrives only through the EXISTING authenticated v3 fetch (L107-146). The
  enrichment therefore rides the authenticated payload that is ALREADY in hand.
- **F3 — Bitnomial (kraken) branch forwards 4 of ~20 fields.** The public specs payload
  (probed Oct 16, full record captured below) carries margin_unit, settlement_method,
  max_order_quantity, min_block_size, price_limit_percentage, funding_interval_hours,
  funding bounds, daily open/settle times — the branch maps only contract_size/unit,
  price_increment, product_id, native_symbol.
- **F4 — Kraken Futures (krakenfutures) branch forwards 2 of ~15 fields.** The public
  instruments payload carries **marginLevels (tiered initial/maintenance margin — tier 0:
  initialMargin 0.01 = 1% = 100x effective at base tier)**, maxPositionSize,
  fundingRateCoefficient, maxRelativeFundingRate, contractValueTradePrecision, category —
  all dropped today.
- **F5 — Venue copy is Coinbase-hardcoded.** L497 "Syncing with Coinbase..." renders on
  kraken/krakenfutures venues too. "Attempting to map futures matrix" likewise.
- **F6 — The LIVE gate contradicts the server.** `subscribeToStrategy` L256-264 blocks LIVE
  unless `isCDEAsset(selectedAsset.id)` — but Push 7 shipped the KRF LIVE lane server-side
  and the cortex deploys KRF LIVE today. UI says blocked; server says allowed. The gate must
  become venue-aware: coinbase → CDE + COINBASE keys (unchanged); krakenfutures → requires a
  KRAKENFUTURES vault row (same `.eq('exchange','KRAKENFUTURES')` uppercase vault read
  pattern — asymmetry by design, do NOT unify); kraken → PAPER-only with honest copy
  ("Bitnomial live execution arrives in Push 8").
- **F7 — `alert()` native dialogs** on favorite/subscribe errors and success (L221, 245,
  306, 322). Jarring, ugly, feels unfinished.
- **F8 — The look IS the generic AI dashboard.** body `#020617` + slate-200
  (styles/globals.css L47), indigo→cyan gradient italic headline (studio.js L430),
  `text-[8px]`/`text-[9px]`/`text-[10px] font-black uppercase tracking-widest` as the
  universal type scale. Nothing is wrong technically — it's just every dashboard.
- **F9 — "Leverage (1-10x)" is a hardcoded label** (studio.js L971) while venue margin
  reality differs per venue (KRF tier-0 initial margin 1%; KRX margin_unit USD; INTX
  per-product). Sizing UI should speak the venue's language.
- **F10 — KRX rows render `$0.00`** (specs carries no prices; payload sets `price: 0`,
  available-assets L219). Confusing for end users.

## SCOPE — this push (Instrument Truth), ONE coherent change

### 1. `pages/api/available-assets.js` — forward the venue-native fields (no new endpoints)

**krakenfutures** (`handleKrakenFutures`): add to the mapped object (fields EXIST in
`getKrakenInstruments()` output — verify the provider mapping first; extend the provider
mapping if the field is dropped there, never re-fetch inside the route):
- `contract_size` (have), `tick_size` (have) — keep
- `initial_margin` = instruments marginLevels[0].initialMargin (0.01 = 1%)
- `maintenance_margin` = marginLevels[0].maintenanceMargin
- `max_position_size` = maxPositionSize
- `funding_interval_hours` = 8 for flex perps (KRF standard) — hardcode ONLY if not present
  in payload; otherwise forward
- `max_relative_funding_rate` = maxRelativeFundingRate
- `category` = category ("Layer 1") — nice for grouping
- `tradeable` / `suspended` — for status chips

**kraken** (`handleKraken`): forward from the SAME specs record (already fetched, just map):
- `margin_unit` ("USD"), `settlement_method` ("Cash Settled")
- `max_order_quantity`, `min_block_size`
- `price_limit_percentage` (0.5 = % move band)
- `funding_interval_hours`, `funding_rate_upper_bound`, `funding_rate_lower_bound`
- `daily_open_time`, `daily_settle_time`
- `price_quotation_unit` ("USD per SOL") — powers the "notional per contract" line
- `product_status` (already filtered, forward for the chip)

**coinbase**: the authenticated v3 products call already returns full records. **PROBE
FIRST**: before mapping, log ONE raw product record (`console.log(JSON.stringify(sample))`)
of a PERPETUAL_FUTURE and paste the field list into this spec's validation section — then map
what exists (expected candidates per CDP docs: contract_size / contract_root_unit /
contract_expiry_type / product_venue / base+quote increments / min-max order sizes). If a
field is absent in the real payload, DO NOT invent it — honest absence. Keep the public
fetch (unauth) as-is for the price-only rows; enrichment rides the authed records.

**All venues**: `notional_hint` may be COMPUTED client-side (qty × contract_size × mark) —
do NOT compute notional server-side into the catalog (price staleness × cache = wrong math in
a payload that outlives its price).

Honest-absent rule: any field the venue doesn't provide is `undefined` — never a fabricated
default. UI renders "—" for absent facts. (Invisible-fallback doctrine, UI edition.)

### 2. `components/MarketScanner.js` — the Instrument Card

- **Venue-aware loading/empty copy**: derive a `VENUE_META` const map:
  `coinbase → { sync: 'Syncing with Coinbase...', matrixName: 'Coinbase INTX matrix' }`,
  `kraken → { sync: 'Syncing with Kraken US (Bitnomial)...', ... }`,
  `krakenfutures → { sync: 'Syncing with Kraken Futures...', ... }`. Replace the hardcoded
  strings (L497-498). Same treatment for "Empty Matrix" → venue-aware.
- **KRX price display**: when `price === 0` on a kraken row, render `"mark pending"` instead
  of `$0.00` (F10) — honest, not broken-looking. (Real prices arrive with the Push 8
  market-data push; do not fake them.)
- **Instrument Card** (NEW): when an asset is selected, render a compact facts panel ABOVE
  the deploy matrix (it replaces nothing, it informs the deploy):
  - Contract: `{contract_size} {contract_size_unit}` (KRX: "5 SOL per contract"; KRF:
    "1 SOL per contract")
  - Tick: `{tick_size}` / `{price_increment}`
  - Margin (venue-honest): KRF → "Initial 1.0% · Maint 0.5% (tier 1)"; KRX → "Margin unit:
    USD · {settlement_method}"; coinbase → whatever the probe yielded, else "—"
  - Limits: max order size (venue-native units)
  - Funding: KRF/KRX → interval + bounds; coinbase → absent → "—"
  - **Notional preview line**: live math `qty × contract_size × price` bound to the qty
    input the user is about to deploy with — the single most valuable comprehension line:
    "10 contracts ≈ $1,036 notional". Price = the row's price; when 0/absent → hide the
    line, never fake it.
- **Venue-aware LIVE gate** (F6): the matrix above; KRF LIVE requires KRAKENFUTURES vault
  row check (add a `hasKrakenFuturesKeys` sibling of `hasCoinbaseKeys` L160-181 — uppercase
  vault literal, same do-not-unify comment); kraken → blocking popup with honest copy.
- **Replace `alert()` with a small inline toast** (F7): local component state + a fixed
  bottom toast, auto-dismiss ~4s, error variant red / success variant emerald. NO new
  dependency — ~30 lines in-file.

### 3. `pages/studio.js` — venue-honest sizing language

- Leverage label (L971): replace hardcoded "Leverage (1-10x)" with venue-aware margin
  language: coinbase → unchanged; krakenfutures → "Margin (venue min 1% initial)" with the
  instrument's `initial_margin` shown; kraken → "Margin (USD, {settlement_method})". The
  DATA comes from the same available-assets payload (studio already fetches
  `availableAssets` — check L81/85 context and thread the selected asset's enriched fields
  through).
- Add the notional preview line near the qty input ("10 contracts ≈ $X notional") using the
  same math as the scanner card — ONE formula, stated in both places, implemented twice is
  acceptable (different files, tiny), but the formula must be IDENTICAL: `qty ×
  contract_size × price`, formatted with `Intl.NumberFormat` USD.

### 4. Gate — `scripts/am64-check.mjs`

Behavioral pins (established style — source-string + fixture assertions):
1. Per-venue field-map pins: each enriched field name appears in the correct handler.
2. Honest-absence: no `?? 0` / fabricated defaults on the new fields; the "—" render path
   exists for absent facts.
3. Venue copy literals: the three `VENUE_META` entries exist; "Syncing with Coinbase" no
   longer appears outside the coinbase entry.
4. LIVE-gate matrix: CDE gate scoped to coinbase; KRF branch requires KRAKENFUTURES vault
   check; kraken → PAPER-only popup copy present.
5. Notional formula pin: `qty * contract_size * price` (or the exact implemented expression)
   appears in both files, and no server-side notional computation exists in
   available-assets.js.
6. Toast: zero `alert(` occurrences remain in MarketScanner.js.
7. All prior gates stay green (battery unchanged + am64).

## EXPLICIT NON-GOALS (next push, not this one)

- No layout rewrite, no global color/typography system change, no landing-page redesign, no
  motion pass. The "identity" redesign is its own push (AM65 — design language) AFTER
  instrument truth ships; mixing them makes both unreviewable.
- No Bitnomial price backfill (arrives with Push 8 market-data).
- No changes to deploy-strategy/subscribe-strategy server contracts beyond what the gate
  needs.

## VALIDATE-TWICE PROTOCOL (operator directive)

1. This spec is written against origin `af5989c` + live venue probes (Oct 16). Line anchors
   were read this session, not assumed.
2. Agent implements → assistant validates on an origin worktree: battery + am64 + a FIELD
   DIFF — re-probe each venue's raw payload and diff against what the API now forwards, so
   no invented field slips through.
3. Only then deploy. Any anchor that moved (lines shift) must be re-located by the agent and
   noted in the commit message.

## RAW PAYLOAD RECEIPTS (Oct 16 probes — ground truth for field maps)

Bitnomial PSOLUSZ50 (perp, active): `product_id 5609, margin_unit "USD",
settlement_method "Cash Settled", max_order_quantity 100000, min_block_size 500,
contract_size 5, contract_size_unit "SOL", price_increment 0.01,
price_quotation_unit "USD per SOL", quote_asset "USD", quote_base_unit "SOL",
price_band_variation 516, price_limit_percentage 0.5, first_trading_day "2026-05-16",
daily_open_time "16:00:00", daily_settle_time "16:00:00",
daily_first_funding_interval_end "03:00:00", funding_interval_hours 8,
funding_rate_upper_bound 0.0005, funding_rate_lower_bound -0.0005,
symbol "PSOLUSZ50", base_symbol "SOLUS" (POLLUTED — use contract_size_unit),
product_status "active"`.

Kraken Futures PF_SOLUSD: `type flexible_futures, tickSize 0.01, contractSize 1, tradeable
true, impactMidSize 130.0, maxPositionSize 280000.0, marginLevels[0] {initialMargin 0.01,
maintenanceMargin 0.005} (8 tiers total), fundingRateCoefficient 8, maxRelativeFundingRate
0.005, contractValueTradePrecision 2, category "Layer 1", base "SOL", quote "USD"`,
`marginSchedules` per-jurisdiction (IGNORE for now — retail top-level marginLevels is the
display source; jurisdictions are a later concern).

Coinbase INTX: public exchange API does NOT serve INTX perps (404 on BTC-PERP-INTX probed);
truth arrives via the authenticated `/api/v3/brokerage/products?product_type=PERPETUAL_FUTURE`
already wired at available-assets.js L107-146. Probe-first step REQUIRED (see §1).
