// pages/api/available-assets.js
// Fetch all available FUTURES trading pairs from Coinbase

import jwt from 'jsonwebtoken';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // Verify JWT from Authorization header
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  try {
    const token = authHeader.split(' ')[1];
    jwt.verify(token, process.env.JWT_SECRET || 'your-supabase-jwt-secret');
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  try {
    // Fetch all products from Coinbase
    const response = await fetch('https://api.exchange.coinbase.com/products');
    
    if (!response.ok) {
      throw new Error(`Coinbase API returned ${response.status}`);
    }

    const allProducts = await response.json();

    // Filter for FUTURES products only
    const futuresProducts = allProducts
      .filter(p => 
        p.product_type === 'PERPETUAL_FUTURES' && 
        p.quote_currency === 'USD' &&
        p.trading_disabled === false
      )
      .map(p => ({
        id: p.id,
        name: p.id,
        base: p.base_currency,
        quote: p.quote_currency,
        price: parseFloat(p.price) || 0,
        volume_24h: parseFloat(p.volume_24h) || 0,
        price_percentage_change_24h: parseFloat(p.price_percentage_change_24h) || 0,
        product_type: p.product_type
      }))
      .sort((a, b) => b.volume_24h - a.volume_24h); // Sort by volume descending

    return res.status(200).json({
      count: futuresProducts.length,
      products: futuresProducts
    });
  } catch (error) {
    console.error('[AVAILABLE ASSETS ERROR]:', error.message);
    return res.status(500).json({ error: error.message });
  }
}
