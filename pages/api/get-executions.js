// /pages/api/get-executions.js
import { createClient } from '@supabase/supabase-js'
import { jwtVerify, createRemoteJWKSet } from 'jose';

const JWKS = createRemoteJWKSet(new URL('https://wsrioyxzhxxrtzjncfvn.supabase.co/auth/v1/.well-known/jwks.json'));

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  let tenantId;
  try {
    const token = authHeader.split(' ')[1];
    const { payload } = await jwtVerify(token, JWKS, { algorithms: ['ES256'] });
    
    // Get actual tenant_id
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
    .from('executions')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('timestamp', { ascending: false })
    .limit(50)

  if (error) return res.status(500).json({ error })
  res.status(200).json(data)
}
