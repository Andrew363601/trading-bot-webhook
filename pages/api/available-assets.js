// pages/api/available-assets.js
import { createClient } from '@supabase/supabase-js';
import { cbRequest, generateCoinbaseToken } from '../../lib/providers/coinbase.js';
import { withTenantAuth } from '../../lib/auth-middleware';
import { retrieveAPIKey } from '../../lib/secrets-manager.js';
// 🟢 PUSH AM63 (Push 5) — Kraken Futures (apiv3) catalogue via the provider (public).
import { getKrakenInstruments, getKrakenTickers } from '../../lib/providers/kraken-futures.js';

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
                    price_percentage_change_24h: parseFloat(p.price_percentage_change_24h) || 0
                  }));
                
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
          exchange: 'kraken'
        };
      })
      // No volume on the specs payload → sort by symbol/id asc for a stable order.
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, 100);

    return res.status(200).json({ count: products.length, products });
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

export default withTenantAuth(handler);