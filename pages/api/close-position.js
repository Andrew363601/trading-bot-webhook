// pages/api/close-position.js
// Secure endpoint for closing/liquidating positions with session validation
import { createClient } from '@supabase/supabase-js';
import { executeTradeMCP } from '../../lib/execute-trade-mcp.js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Helper to fetch current market price from Coinbase public API
async function getCurrentMarketPrice(symbol) {
  try {
    // Normalize symbol (e.g., "ETH-PERP-INTX" → "ETH" for spot ticker)
    const baseAsset = symbol.split('-')[0].toUpperCase();
    const spotMap = { 
      'ETP': 'ETH', 'BIT': 'BTC', 'BIP': 'BTC', 'SLP': 'SOL', 'DOP': 'DOGE',
      'LCP': 'LTC', 'AVP': 'AVAX', 'LNP': 'LINK', 'XPP': 'XRP'
    };
    const spotBase = spotMap[baseAsset] || baseAsset;
    
    const resp = await fetch(`https://api.exchange.coinbase.com/products/${spotBase}-USD/ticker`, { timeout: 5000 });
    if (!resp.ok) {
      console.warn(`[CLOSE-POSITION] Price fetch failed for ${spotBase}-USD: ${resp.status}`);
      return null;
    }
    
    const data = await resp.json();
    const price = parseFloat(data.price);
    
    if (!price || isNaN(price) || price <= 0) {
      console.warn(`[CLOSE-POSITION] Invalid price returned for ${spotBase}: ${data.price}`);
      return null;
    }
    
    console.log(`[CLOSE-POSITION] Current market price for ${baseAsset}: $${price}`);
    return price;
  } catch (err) {
    console.error(`[CLOSE-POSITION] Market price fetch error: ${err.message}`);
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Get tenant_id from session or authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid authorization' });
    }

    const token = authHeader.substring(7);
    
    // Verify token and extract tenant_id (using Supabase JWT)
    let tenantId;
    try {
      const { data: { user }, error: userError } = await supabase.auth.getUser(token);
      if (userError || !user) {
        return res.status(401).json({ error: 'Invalid token' });
      }

      const { data: tenantUserLink, error: tenantLinkError } = await supabase
        .from('tenant_users')
        .select('tenant_id')
        .eq('auth_user_id', user.id)
        .single();

      if (tenantLinkError || !tenantUserLink) {
        return res.status(401).json({ error: 'User not linked to a tenant' });
      }
      tenantId = tenantUserLink.tenant_id;
    } catch (tokenErr) {
      return res.status(401).json({ error: 'Token verification failed' });
    }

    const { trade_id, symbol, side, qty, price, is_live_exchange, execution_mode } = req.body;

    // A "live exchange" position is one the broker reports as open but which has
    // no corresponding trade_logs row (e.g. opened outside the agent, or a
    // synthesized live position in the dashboard). Those have no trade_id, so we
    // close them by symbol/side/qty (reduce-only) WITHOUT a trade_logs lookup.
    const isLiveExchange = is_live_exchange === true || execution_mode === 'LIVE (EXCHANGE)';

    // Validate required fields. trade_id is only required for tracked (paper /
    // agent) trades — live exchange positions are identified by symbol/side/qty.
    if (!symbol || !side || !qty || (!isLiveExchange && !trade_id)) {
      const need = isLiveExchange ? 'symbol, side, qty' : 'trade_id, symbol, side, qty';
      return res.status(400).json({ error: `Missing required fields: ${need}` });
    }

    let trade = null;
    if (!isLiveExchange) {
      // Verify trade ownership - fetch trade and check tenant_id
      const { data: tradeRow, error: tradeError } = await supabase
        .from('trade_logs')
        .select('*')
        .eq('id', trade_id)
        .eq('tenant_id', tenantId)
        .single();

      if (tradeError || !tradeRow) {
        console.warn(`[CLOSE-POSITION] Unauthorized access attempt for trade ${trade_id} by tenant ${tenantId}`);
        return res.status(403).json({ error: 'Trade not found or access denied' });
      }

      // Verify trade is still open
      if (tradeRow.exit_price !== null) {
        return res.status(400).json({ error: 'Trade is already closed' });
      }
      trade = tradeRow;
    }

    console.log(`[CLOSE-POSITION API] Closing ${isLiveExchange ? 'LIVE EXCHANGE position' : `trade ${trade_id}`} for ${symbol} (Tenant: ${tenantId})`);

    // Fetch current market price if not provided by user
    let exitPrice = price;
    if (!exitPrice || exitPrice === 0) {
      const currentPrice = await getCurrentMarketPrice(symbol);
      if (currentPrice) {
        exitPrice = currentPrice;
        console.log(`[CLOSE-POSITION API] Using market price: $${exitPrice} for ${symbol}`);
      } else {
        console.warn(`[CLOSE-POSITION API] Could not fetch current market price for ${symbol}. Falling back to user-provided price.`);
        exitPrice = price || 0;
      }
    }

    // Call executeTradeMCP directly. For live exchange positions there's no
    // trade row, so we fall back to sane defaults and force LIVE execution with
    // reduce_only so we only ever flatten the existing position.
    const closePayload = {
      symbol,
      strategy_id: trade?.strategy_id || 'MANUAL',
      version: trade?.version || 'v1.0',
      side,
      execution_mode: isLiveExchange ? 'LIVE' : (trade?.execution_mode || 'PAPER'),
      qty,
      price: exitPrice,
      leverage: trade?.leverage || 1,
      market_type: trade?.market_type || 'FUTURES',
      order_type: 'MARKET',
      reduce_only: true,
      trade_id: trade_id || null,
      reason: 'MANUAL_UI_CLOSE',
      tenant_id: tenantId
    };

    const result = await executeTradeMCP(closePayload);

    return res.status(200).json({
      success: true,
      message: 'Position closed successfully',
      trade_id: trade_id || null,
      data: result
    });

  } catch (error) {
    console.error('[CLOSE-POSITION API ERROR]:', error.message);
    return res.status(500).json({
      error: error.message || 'Position close failed'
    });
  }
}
