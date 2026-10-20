// pages/api/available-assets.js
import { createClient } from '@supabase/supabase-js';
import { cbRequest, generateCoinbaseToken } from '../../lib/providers/coinbase.js';
import { withTenantAuth } from '../../lib/auth-middleware';
import { retrieveAPIKey } from '../../lib/secrets-manager.js';
// 🟢 PUSH AM63 (Push 5) — Kraken Futures (apiv3) catalogue via the provider (public).
import { getKrakenInstruments, getKrakenTickers } from '../../lib/providers/kraken-futures.js';
// 🟢 AM68 — Kraken SPOT (+ margin) catalogue via the one-door provider (public).
import { getKrakenSpotInstruments, getKrakenSpotTickers } from '../../lib/providers/kraken-spot.js';
// 🟢 AM69 hotfix 1 — catalog head protection (the coinbase TOP_RANK precedent,
// extracted so the spot + KRX branches can guarantee the majors survive the cut).
import { PRIORITY_BASES, guaranteePriorityHead } from '../../lib/catalog-head.js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { tenantId } = req.tenant;

  // 🟢 PUSH AM63 (Push 3) — venue switch. Absent/`coinbase` → the EXISTING path
  // (byte-identical: CFM fallback, top-rank map, dedupe, 100-cap). `kraken` → the
  // Bitnomial US perps catalogue. Any OTHER venue is refused LOUD — a caller that
  // names a venue must get that venue or an error (never a silent Coinbase fallback).
  // 🟢 PUSH AM63 (Push 5) — `krakenfutures` → the REAL Kraken Futures (apiv3) perps.
  const exchange = String(req.query.exchange || 'coinbase').toLowerCase();
  if (exchange === 'kraken') {
    return handleKraken(res);
  }
  if (exchange === 'krakenfutures') {
    return handleKrakenFutures(res);
  }
  if (exchange === 'krakenspot') {
    return handleKrakenSpot(res);
  }
  if (exchange !== 'coinbase') {
    return res.status(400).json({ error: `[AM63] unsupported exchange '${exchange}'` });
  }

  try {
    // Top 15 Perpetual Futures assets (Hardcoded fallback for speed)
    const topAssets = [
      'BTC-PERP-INTX', 'ETH-PERP-INTX', 'SOL-PERP-INTX', 'DOGE-PERP-INTX',
      'LINK-PERP-INTX', 'AVAX-PERP-INTX', 'LTC-PERP-INTX', 'BCH-PERP-INTX',
      'BCP-20DEC30-CDE',
      'XRP-PERP-INTX', 'ADA-PERP-INTX', 'DOT-PERP-INTX', 'MATIC-PERP-INTX',
      'UNI-PERP-INTX', 'SHIB-PERP-INTX', 'NEAR-PERP-INTX'
    ];

    let futuresProducts = [];
    try {
      // 1. Fetch unauthenticated PERP-INTX products
      try {
        const response = await fetch('https://api.exchange.coinbase.com/products', {
          headers: { 'User-Agent': 'Nexus-Terminal' },
          next: { revalidate: 3600 } // Cache for 1 hour
        });

        if (response.ok) {
          const allProducts = await response.json();
          futuresProducts = allProducts
            .filter(p => 
              (p.product_type === 'PERPETUAL_FUTURES' || p.id.includes('PERP')) && 
              !p.trading_disabled
            )
            .map(p => ({
              id: p.id,
              name: p.id,
              base: p.base_currency,
              price: parseFloat(p.price) || 0,
              volume_24h: parseFloat(p.volume_24h) || 0,
              price_percentage_change_24h: parseFloat(p.price_percentage_change_24h) || 0
            }));
        }
      } catch (publicErr) {
        console.error(`[AVAILABLE ASSETS WARN][exchange=${exchange}]: Public product fetch failed:`, publicErr.message);
      }

      // 2. Fetch authenticated US Regulated Futures (CFM -CDE)
      let apiKeyName = process.env.COINBASE_API_KEY;
      let apiSecret = process.env.COINBASE_API_SECRET || "";

      if (tenantId) {
        try {
          const secrets = await retrieveAPIKey(supabase, tenantId, 'COINBASE');
          if (secrets && secrets.apiKey && secrets.apiSecret) {
            apiKeyName = secrets.apiKey;
            apiSecret = secrets.apiSecret;
          }
        } catch (e) {
          console.log(`[AVAILABLE ASSETS WARN][exchange=${exchange}]: Could not load tenant API key for CFM fetch. Falling back to global.`);
        }
      }

      apiSecret = apiSecret.replace(/\\n/g, '\n');
      if (apiSecret.startsWith('"') && apiSecret.endsWith('"')) apiSecret = apiSecret.slice(1, -1);
      
      if (apiKeyName && apiSecret) {
        // Parse-guard: a bad PEM must skip the authenticated fetch, not throw.
        let keyOk = false;
        try {
          generateCoinbaseToken('GET', '/api/v3/brokerage/products', apiKeyName, apiSecret);
          keyOk = true;
        } catch (cryptoErr) {
          console.error(`[AVAILABLE ASSETS ERROR][exchange=${exchange}]: Failed to parse private key (CFM fetch will be skipped):`, cryptoErr.message);
        }
        
        if (keyOk) {
          // Fetch both FUTURE and PERPETUAL_FUTURE for better coverage and pricing
          const productTypes = ['FUTURE', 'PERPETUAL_FUTURE'];
          
          for (const type of productTypes) {
            try {
              const path = `/api/v3/brokerage/products?product_type=${type}`;
              const cbToken = generateCoinbaseToken('GET', path, apiKeyName, apiSecret);

              const cfmResponse = await cbRequest({ token: cbToken, method: 'GET', path });

              if (cfmResponse.ok) {
                const cfmData = await cfmResponse.json();
                const cfmProducts = (cfmData.products || [])
                  .filter(p => !p.trading_disabled && p.product_id)
                  .map(p => ({
                    id: p.product_id,
                    name: p.product_id,
                    base: p.base_currency_id,
                    price: parseFloat(p.price) || 0,
                    volume_24h: parseFloat(p.volume_24h) || 0,
                    price_percentage_change_24h: parseFloat(p.price_percentage_change_24h) || 0,
                    // 🟢 PUSH AM64 — venue-native contract facts (Instrument Card).
                    // Mapped DEFENSIVELY from the authed v3 record: any field the
                    // payload does not carry stays undefined (honest-absent — the UI
                    // renders '—', never a fabricated default). PROBE-FIRST: the first
                    // PERPETUAL_FUTURE record is logged once below so the field list
                    // can be verified against this map (spec validation step).
                    contract_size: p.contract_size != null ? parseFloat(p.contract_size) : undefined,
                    contract_root_unit: p.contract_root_unit,
                    contract_expiry_type: p.contract_expiry_type,
                    product_venue: p.product_venue,
                    base_increment: p.base_increment != null ? parseFloat(p.base_increment) : undefined,
                    quote_increment: p.quote_increment != null ? parseFloat(p.quote_increment) : undefined,
                    min_market_base_size: p.min_market_base_size != null ? parseFloat(p.min_market_base_size) : undefined,
                    max_market_base_size: p.max_market_base_size != null ? parseFloat(p.max_market_base_size) : undefined
                  }));

                // 🟢 PUSH AM64 — PROBE-FIRST receipt (spec §1): log ONE raw record per
                // product_type ONCE per process so the field list can be diffed against
                // the map above. Never logs secrets; the record is public product data.
                const probeSample = (cfmData.products || [])[0];
                if (probeSample && !globalThis.__AM64_PRODUCT_PROBE_LOGGED__) {
                  globalThis.__AM64_PRODUCT_PROBE_LOGGED__ = true;
                  console.log(`[AM64 PROBE][exchange=${exchange}][type=${type}] raw product record:`, JSON.stringify(probeSample));
                }

                // Merge and deduplicate
                cfmProducts.forEach(newP => {
                  const existingIdx = futuresProducts.findIndex(p => p.id === newP.id);
                  if (existingIdx >= 0) {
                    // Update with better data from authenticated API if price was 0
                    if (futuresProducts[existingIdx].price === 0) {
                      futuresProducts[existingIdx] = newP;
                    }
                  } else {
                    futuresProducts.push(newP);
                  }
                });
                console.log(`[AVAILABLE ASSETS INFO][exchange=${exchange}]: Fetched ${cfmProducts.length} ${type} products via Advanced Trade API.`);
              }
            } catch (innerErr) {
              console.error(`[AVAILABLE ASSETS ERROR][exchange=${exchange}]: Failed to fetch ${type} products:`, innerErr.message);
            }
          }
        }
      }
    } catch (e) {
      console.error(`[AVAILABLE ASSETS ERROR][exchange=${exchange}]: Coinbase fetch exception:`, e.message);
    }

    // Combine and deduplicate. Mark our priority list so we can guarantee it
    // is NEVER sliced off the end (previous behaviour: zero-volume entries got
    // pushed to the bottom and dropped by .slice(0, 100), which is why the
    // user only saw ETH-PERP and DOGE-PERP in the picker).
    const TOP_RANK = new Map(topAssets.map((id, idx) => [id, idx]));
    const combined = [...futuresProducts];
    topAssets.forEach(id => {
      if (!combined.find(p => p.id === id)) {
        combined.push({ id, name: id, base: id.split('-')[0], price: 0, volume_24h: 0, price_percentage_change_24h: 0 });
      }
    });

    // Sort by: (1) is-priority asc by priority rank → priority list always wins;
    // then (2) volume desc inside each bucket.
    const sorted = combined.sort((a, b) => {
      const aRank = TOP_RANK.has(a.id) ? TOP_RANK.get(a.id) : Infinity;
      const bRank = TOP_RANK.has(b.id) ? TOP_RANK.get(b.id) : Infinity;
      if (aRank !== bRank) return aRank - bRank;
      return (b.volume_24h || 0) - (a.volume_24h || 0);
    });

    const finalSelection = sorted.slice(0, 100);

    return res.status(200).json({
      count: finalSelection.length,
      products: finalSelection
    });
  } catch (error) {
    console.error(`[AVAILABLE ASSETS FATAL ERROR][exchange=${exchange}]: Uncaught error in available-assets API:`, error.message);
    return res.status(500).json({ error: error.message });
  }
}

// 🟢 PUSH AM63 (Push 3) — Kraken (Bitnomial US perps) catalogue. Public, no auth.
// Mirrors the Coinbase public path's 1-hour cache (Bitnomial limit: 200 req / 5 min).
//
// IDENTITY: id = `${BASE}-PERP-KRX-${contract_size}` (e.g. BTC-PERP-KRX-0.01).
//   - `base` comes from contract_size_unit — base_symbol is POLLUTED with the size
//     letter ('BTCUC', 'ADAUK'), so it is NOT the coin.
//   - Every base lists exactly 2 contract sizes, so the numeric contract_size suffix
//     is REQUIRED for uniqueness.
//   - This id is the STABLE, venue-qualified identity that Push 4's adapter resolves
//     to the CURRENT native Bitnomial symbol (e.g. PBTCUCZ50). NEVER store native
//     expiry-suffixed symbols as ids.
async function handleKraken(res) {
  try {
    const response = await fetch('https://bitnomial.com/exchange/api/v1/prod/product/specs/?active=true', {
      headers: { 'User-Agent': 'Nexus-Terminal' },
      next: { revalidate: 3600 } // Cache for 1 hour
    });

    if (!response.ok) {
      console.error(`[AVAILABLE ASSETS ERROR][exchange=kraken]: Bitnomial specs fetch failed: HTTP ${response.status}`);
      return res.status(502).json({ error: `[AM63] Kraken catalog unavailable (Bitnomial HTTP ${response.status})` });
    }

    const allProducts = await response.json();
    // 🟢 AM69 hotfix 1 — NOTE: the Bitnomial active set carries calendar spreads +
    // options too; the `type === 'perpetual'` filter is CORRECT — do NOT widen it.
    // DOGE → PDOGUKZ50 is confirmed live (id 218's contract is not delisted).
    const products = (Array.isArray(allProducts) ? allProducts : [])
      .filter(p => p.type === 'perpetual' && p.product_status === 'active')
      .map(p => {
        const base = p.contract_size_unit;                 // clean coin ('BTC', 'ADA', …)
        const id = `${base}-PERP-KRX-${p.contract_size}`;  // stable venue-qualified identity
        return {
          id,
          name: id,
          base,
          price: 0,                        // specs carries NO prices (no 2nd endpoint)
          volume_24h: 0,
          price_percentage_change_24h: 0,
          native_symbol: p.symbol,         // current native symbol Push 4 resolves from `id`
          contract_size: p.contract_size,
          contract_size_unit: p.contract_size_unit,
          price_increment: p.price_increment,
          product_id: p.product_id,
          // 🟢 PUSH AM64 — venue-native contract facts (Instrument Card). Forwarded
          // from the SAME specs record — no second fetch. Absent → undefined
          // (honest-absent; the UI renders '—', never a fabricated default).
          margin_unit: p.margin_unit,                    // 'USD' — collateral basis
          settlement_method: p.settlement_method,        // 'Cash Settled'
          max_order_quantity: p.max_order_quantity,
          min_block_size: p.min_block_size,
          price_limit_percentage: p.price_limit_percentage, // % move band (0.5 = 0.5%)
          funding_interval_hours: p.funding_interval_hours,
          funding_rate_upper_bound: p.funding_rate_upper_bound,
          funding_rate_lower_bound: p.funding_rate_lower_bound,
          daily_open_time: p.daily_open_time,
          daily_settle_time: p.daily_settle_time,
          price_quotation_unit: p.price_quotation_unit,  // 'USD per SOL' — notional line
          product_status: p.product_status,              // 'active' (already filtered)
          exchange: 'kraken'
        };
      });

    // 🟢 AM69 hotfix 1 — HEAD PROTECTION (the coinbase TOP_RANK precedent). The specs
    // payload carries NO volume, so the sort is alphabetical — a priority base whose
    // perp id sorts late could be cut. Guarantee each priority base's perp is present
    // (pushed at head if absent), then sort priority-bucket-first, id asc inside.
    const ranked = guaranteePriorityHead(
      products,
      PRIORITY_BASES,
      (p) => p.base,
      (a, b) => a.id.localeCompare(b.id),
      (base) => ({
        id: `${base}-PERP-KRX-0.01`, name: `${base}-PERP-KRX-0.01`, base,
        price: 0, volume_24h: 0, price_percentage_change_24h: 0,
        native_symbol: null, contract_size: 0.01, contract_size_unit: base,
        price_increment: null, product_id: null, margin_unit: null,
        settlement_method: null, max_order_quantity: null, min_block_size: null,
        price_limit_percentage: null, funding_interval_hours: null,
        funding_rate_upper_bound: null, funding_rate_lower_bound: null,
        daily_open_time: null, daily_settle_time: null, price_quotation_unit: null,
        product_status: 'active', exchange: 'kraken',
      }),
    );
    const finalSelection = ranked.slice(0, 100);

    return res.status(200).json({ count: finalSelection.length, products: finalSelection });
  } catch (e) {
    console.error('[AVAILABLE ASSETS ERROR][exchange=kraken]:', e.message);
    return res.status(502).json({ error: `[AM63] Kraken catalog fetch exception: ${e.message}` });
  }
}

// 🟢 PUSH AM63 (Push 5) — Kraken Futures (apiv3) catalogue. Public, no auth.
//
// IDENTITY: id = `${BASE}-PERP-KRF` (e.g. BTC-PERP-KRF). apiv3 has ONE perp per base,
// so there is NO size suffix (unlike Bitnomial's -KRX-<size>). The provider owns the
// host + the PF_ filter; this handler only shapes the payload for the venue matrix.
//
// PRICE: unlike Bitnomial's specs, Kraken carries REAL marks — the matrix shows live
// prices (markPrice primary, last fallback). ALL PF_ instruments are surfaced (crypto,
// equities, commodities, indices, pre-IPO) — the matrix is venue-truthful.
//
// CACHE: 60 s (NOT the 3600 s the Coinbase/kraken branches use) — these are live marks.
async function handleKrakenFutures(res) {
  try {
    const [instruments, tickers] = await Promise.all([
      getKrakenInstruments(),
      getKrakenTickers(),
    ]);

    if (!instruments) {
      console.error('[AVAILABLE ASSETS ERROR][exchange=krakenfutures]: instruments unavailable');
      return res.status(502).json({ error: '[AM63] Kraken Futures catalog unavailable (instruments)' });
    }

    const products = Object.values(instruments).map((inst) => {
      const t = tickers ? tickers[inst.nativeSymbol] : null;
      const mark = t ? (t.markPrice ?? t.last) : null;
      const price = parseFloat(mark);
      const vol = t ? parseFloat(t.vol24h) : NaN;
      return {
        id: inst.id,
        name: inst.id,
        base: inst.base,
        price: Number.isFinite(price) ? price : 0,   // venue mark (real, unlike KRX)
        volume_24h: Number.isFinite(vol) ? vol : 0,
        price_percentage_change_24h: 0,              // not in the tickers payload
        native_symbol: inst.nativeSymbol,
        contract_size: inst.contractSize,
        tick_size: inst.tickSize,
        // 🟢 PUSH AM64 — venue-native contract facts (Instrument Card). Tier-0
        // marginLevels (initialMargin 0.01 = 1% = 100× at base tier) is the retail
        // display source. funding_interval_hours: the apiv3 instruments payload does
        // NOT carry an interval — 8h is the KRF standard for flexible perps, hardcoded
        // per spec (ONLY field allowed a default; bounds stay honest-absent).
        initial_margin: inst.initialMargin,            // 0.01 = 1% (tier 0)
        maintenance_margin: inst.maintenanceMargin,    // 0.005 = 0.5% (tier 0)
        max_position_size: inst.maxPositionSize,
        funding_interval_hours: 8,
        max_relative_funding_rate: inst.maxRelativeFundingRate,
        category: inst.category,                       // 'Layer 1' — grouping
        exchange: 'krakenfutures',
      };
    })
      // Sort by 24 h volume desc (real venue liquidity), then id asc for stability.
      .sort((a, b) => (b.volume_24h - a.volume_24h) || a.id.localeCompare(b.id))
      .slice(0, 100);

    return res.status(200).json({ count: products.length, products });
  } catch (e) {
    console.error('[AVAILABLE ASSETS ERROR][exchange=krakenfutures]:', e.message);
    return res.status(502).json({ error: `[AM63] Kraken Futures catalog fetch exception: ${e.message}` });
  }
}

// 🟢 AM68 — Kraken SPOT (+ margin) catalogue. Public, no auth.
//
// IDENTITY: id = `${BASE}-SPOT-KRS` (e.g. SOL-SPOT-KRS); BASE is the CANONICAL coin
// (BTC — NOT the Kraken altname base XBT). native_symbol = the Kraken altname
// (SOLUSD, XBTUSD) used by the private/order/OHLC calls.
//
// PRICE: the Kraken Ticker carries REAL last prices → the matrix shows live prices.
// MARGIN: quote=EUR pairs are margin-ineligible (TX restriction) → `margin:false`
// (honest-absent; the UI must not offer leverage on them).
//
// CACHE: the provider owns short TTLs (≥1h instruments / ≥15s tickers) — no Next
// revalidate pin, so the matrix stays fresh.
async function handleKrakenSpot(res) {
  try {
    const [catalog, tickers] = await Promise.all([
      getKrakenSpotInstruments(),
      getKrakenSpotTickers(),
    ]);

    if (!catalog || !catalog.byId) {
      console.error('[AVAILABLE ASSETS ERROR][exchange=krakenspot]: instruments unavailable');
      return res.status(502).json({ error: '[AM68] Kraken Spot catalog unavailable (AssetPairs)' });
    }

    const products = Object.values(catalog.byId).map((inst) => {
      const t = tickers ? tickers[inst.nativeSymbol] : null;
      const price = t ? parseFloat(t.last) : NaN;
      return {
        id: inst.id,
        name: inst.id,
        base: inst.base,
        quote: inst.quote,
        price: Number.isFinite(price) ? price : 0,
        volume_24h: t && Number.isFinite(t.volume) ? t.volume : 0,
        price_percentage_change_24h: 0,               // not in the Ticker payload
        native_symbol: inst.nativeSymbol,
        lot_decimals: inst.lot_decimals,
        pair_decimals: inst.pair_decimals,
        ordermin: inst.ordermin,                       // min base volume
        costmin: inst.costmin,                         // min notional
        tick_size: inst.tick_size,
        // 🟢 AM68 — margin surfaces. `margin:false` for quote=EUR (TX restriction).
        margin: inst.margin,
        leverage_buy: inst.leverage_buy,
        leverage_sell: inst.leverage_sell,
        contract_size: 1,                              // SPOT: qty = base asset directly
        exchange: 'krakenspot',
      };
    });

    // 🟢 AM69 hotfix 1 — HEAD PROTECTION (the coinbase TOP_RANK precedent). Volume
    // sort health must NEVER decide whether the majors are visible: guarantee every
    // priority base's best-volume pair is present (pushed at head if absent), then
    // sort priority-bucket-first, volume desc inside. A dark ticker can no longer
    // sink BTC/ETH/XRP below the .slice(0, 100) cut.
    const ranked = guaranteePriorityHead(
      products,
      PRIORITY_BASES,
      (p) => p.base,
      (a, b) => (b.volume_24h - a.volume_24h) || a.id.localeCompare(b.id),
      (base) => ({
        id: `${base}-SPOT-KRS`, name: `${base}-SPOT-KRS`, base, quote: 'USD',
        price: 0, volume_24h: 0, price_percentage_change_24h: 0,
        native_symbol: null, lot_decimals: null, pair_decimals: null,
        ordermin: null, costmin: null, tick_size: null,
        margin: null, leverage_buy: null, leverage_sell: null,
        contract_size: 1, exchange: 'krakenspot',
      }),
    );
    const finalSelection = ranked.slice(0, 100);

    return res.status(200).json({ count: finalSelection.length, products: finalSelection });
  } catch (e) {
    console.error('[AVAILABLE ASSETS ERROR][exchange=krakenspot]:', e.message);
    return res.status(502).json({ error: `[AM68] Kraken Spot catalog fetch exception: ${e.message}` });
  }
}

export default withTenantAuth(handler);