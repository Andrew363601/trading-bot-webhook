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

    const { trade_id, symbol, side, qty, price } = req.body;

    // Validate required fields
    if (!trade_id || !symbol || !side || !qty) {
      return res.status(400).json({ error: 'Missing required fields: trade_id, symbol, side, qty' });
    }

    // Verify trade ownership - fetch trade and check tenant_id
    const { data: trade, error: tradeError } = await supabase
      .from('trade_logs')
      .select('*')
      .eq('id', trade_id)
      .eq('tenant_id', tenantId)
      .single();

    if (tradeError || !trade) {
      console.warn(`[CLOSE-POSITION] Unauthorized access attempt for trade ${trade_id} by tenant ${tenantId}`);
      return res.status(403).json({ error: 'Trade not found or access denied' });
    }

    // Verify trade is still open
    if (trade.exit_price !== null) {
      return res.status(400).json({ error: 'Trade is already closed' });
    }

    console.log(`[CLOSE-POSITION API] Closing trade ${trade_id} for ${symbol} (Tenant: ${tenantId})`);

    // Fetch current market price if not provided by user
    let exitPrice = price;
    if (!exitPrice || exitPrice === 0) {
      const currentPrice = await getCurrentMarketPrice(symbol);
      if (currentPrice) {
        exitPrice = currentPrice;
        console.log(`[CLOSE-POSITION API] Using market price: $${exitPrice} (trade ${trade_id})`);
      } else {
        console.warn(`[CLOSE-POSITION API] Could not fetch current market price for ${symbol}. Falling back to user-provided price.`);
        exitPrice = price || 0;
      }
    }

    // Call executeTradeMCP directly
    const closePayload = {
      symbol,
      strategy_id: trade.strategy_id || 'MANUAL',
      version: trade.version || 'v1.0',
      side,
      execution_mode: trade.execution_mode || 'PAPER',
      qty,
      price: exitPrice,
      leverage: trade.leverage || 1,
      market_type: trade.market_type || 'FUTURES',
      order_type: 'MARKET',
      trade_id,
      reason: 'MANUAL_UI_CLOSE',
      tenant_id: tenantId
    };

    const result = await executeTradeMCP(closePayload);

    return res.status(200).json({
      success: true,
      message: 'Position closed successfully',
      trade_id,
      data: result
    });

  } catch (error) {
    console.error('[CLOSE-POSITION API ERROR]:', error.message);
    return res.status(500).json({
      error: error.message || 'Position close failed'
    });
  }
}
