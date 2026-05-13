// pages/api/get-strategies-for-asset.js
// Get all available strategies that can be deployed for a given asset

import { jwtVerify, createRemoteJWKSet } from 'jose';
import fs from 'fs';
import path from 'path';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const JWKS = createRemoteJWKSet(new URL(`${supabaseUrl}/auth/v1/.well-known/jwks.json`));

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { asset } = req.query;

  if (!asset) {
    return res.status(400).json({ error: 'Missing asset parameter' });
  }

  // Verify JWT from Authorization header
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  try {
    const token = authHeader.split(' ')[1];
    await jwtVerify(token, JWKS, { algorithms: ['ES256'] });
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  try {
    // Scan lib/strategies/ directory for available strategy files
    const strategiesDir = path.join(process.cwd(), 'lib', 'strategies');
    const files = fs.readdirSync(strategiesDir).filter(f => f.endsWith('.js'));

    const strategies = files
      .map(file => {
        const name = file.replace('.js', '');
        const filePath = path.join(strategiesDir, file);
        
        // Read file to extract metadata (in production, you'd parse JSDoc or comments)
        const content = fs.readFileSync(filePath, 'utf8');
        
        // Extract strategy description from comments
        const descriptionMatch = content.match(/\/\/\s*Strategy:\s*(.+)/);
        const description = descriptionMatch ? descriptionMatch[1] : `${name} Strategy`;

        return {
          id: name,
          name: name.replace(/_/g, ' ').replace(/v\d+/, '').trim(),
          version: 'v1',
          description,
          asset,
          product_type: 'FUTURES',
          supported_exchanges: ['COINBASE'],
          parameters: {
            quantity: { default: 0.01, type: 'number', label: 'Trade Quantity' },
            leverage: { default: 1, type: 'number', label: 'Leverage', min: 1, max: 10 },
            stop_loss_pct: { default: 2, type: 'number', label: 'Stop Loss %', min: 0.5, max: 10 },
            take_profit_pct: { default: 5, type: 'number', label: 'Take Profit %', min: 1, max: 50 }
          }
        };
      });

    return res.status(200).json({
      asset,
      count: strategies.length,
      strategies
    });
  } catch (error) {
    console.error('[GET STRATEGIES ERROR]:', error.message);
    return res.status(500).json({ error: error.message });
  }
}
