// /pages/api/get-active-strategy.js
import { createClient } from '@supabase/supabase-js';
import { jwtVerify, createRemoteJWKSet } from 'jose';

const JWKS = createRemoteJWKSet(new URL('https://wsrioyxzhxxrtzjncfvn.supabase.co/auth/v1/.well-known/jwks.json'));

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  let tenantId;
  try {
    const token = authHeader.split(' ')[1];
    const { payload } = await jwtVerify(token, JWKS, { algorithms: ['ES256'] });
    
    const { data: tenantUser } = await supabase
      .from('tenant_users')
      .select('tenant_id')
      .eq('auth_user_id', payload.sub)
      .single();
    
    if (!tenantUser) return res.status(401).json({ error: 'Tenant not found' });
    tenantId = tenantUser.tenant_id;
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  const { data, error } = await supabase
    .from('strategy_config')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('is_active', true)
    .single();

  if (error) {
    if (error.code === 'PGRST116') { // No rows found for .single()
      return res.status(200).json(null);
    }
    console.error('Supabase error fetching active strategy:', error.message);
    return res.status(500).json({ error: error.message });
  }

  res.status(200).json(data);
}


