// pages/api/available-assets.js force push
import { jwtVerify, createRemoteJWKSet } from 'jose';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    console.error("[AVAILABLE ASSETS ERROR]: Missing or invalid Authorization header.");
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  try {
    const token = authHeader.split(' ')[1];
    console.log("[AVAILABLE ASSETS DEBUG]: Attempting ES256 JWT verification using JOSE and JWKS.");

    const JWKS = createRemoteJWKSet(new URL('https://wsrioyxzhxxrtzjncfvn.supabase.co/auth/v1/.well-known/jwks.json'));

    // The 'jose' library automatically handles fetching and caching the public key from the JWKS.
    await jwtVerify(token, JWKS, { algorithms: ['ES256'] });

    console.log("[AVAILABLE ASSETS INFO]: JWT token verified successfully with ES256 public key from JWKS.");
  } catch (err) {
    console.error("[AVAILABLE ASSETS ERROR]: JWT verification failed:", err.message);
    console.error("[AVAILABLE ASSETS ERROR]: JWT full error object:", err);
    return res.status(401).json({ error: 'Invalid token', details: err.message });
  }

  // ... (rest of your API route code from the previous interaction remains here)
  try {
    // Top 15 Perpetual Futures assets (Hardcoded fallback for speed)
    const topAssets = [
      'BTC-PERP-INTX', 'ETH-PERP-INTX', 'SOL-PERP-INTX', 'DOGE-PERP-INTX',
      'LINK-PERP-INTX', 'AVAX-PERP-INTX', 'LTC-PERP-INTX', 'BCH-PERP-INTX',
      'XRP-PERP-INTX', 'ADA-PERP-INTX', 'DOT-PERP-INTX', 'MATIC-PERP-INTX',
      'UNI-PERP-INTX', 'SHIB-PERP-INTX', 'NEAR-PERP-INTX'
    ];

    let futuresProducts = [];
    try {
      const response = await fetch('https://api.exchange.coinbase.com/products', {
        headers: { 'User-Agent': 'Nexus-Terminal' },
        next: { revalidate: 3600 } // Cache for 1 hour
      });
      
      console.log(`[AVAILABLE ASSETS INFO]: Coinbase /products API response status: ${response.status} (${response.statusText})`);

      if (response.ok) {
        const allProducts = await response.json();
        futuresProducts = allProducts
          .filter(p => 
            (p.product_type === 'PERPETUAL_FUTURES' || p.product_type === 'FUTURE' || p.id.includes('PERP') || p.id.includes('-CDE')) && 
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
        console.log(`[AVAILABLE ASSETS INFO]: Successfully fetched ${futuresProducts.length} futures products from Coinbase.`);
      } else {
        const errorText = await response.text();
        console.error(`[AVAILABLE ASSETS ERROR]: Coinbase /products API call failed with status ${response.status}: ${errorText}`);
      }
    } catch (e) {
      console.error('[AVAILABLE ASSETS ERROR]: Coinbase fetch exception:', e.message);
      console.warn('[AVAILABLE ASSETS WARN]: Coinbase fetch failed, using hardcoded fallback assets.');
    }

    // Combine and deduplicate
    const combined = [...futuresProducts];
    topAssets.forEach(id => {
      if (!combined.find(p => p.id === id)) {
        combined.push({ id, name: id, base: id.split('-')[0], price: 0, volume_24h: 0, price_percentage_change_24h: 0 });
      }
    });

    const finalSelection = combined
      .sort((a, b) => (b.volume_24h || 0) - (a.volume_24h || 0))
      .slice(0, 20);

    return res.status(200).json({
      count: finalSelection.length,
      products: finalSelection
    });
  } catch (error) {
    console.error('[AVAILABLE ASSETS FATAL ERROR]: Uncaught error in available-assets API:', error.message);
    return res.status(500).json({ error: error.message });
  }
}