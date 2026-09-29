// pages/api/get-results.js
// PUSH AM52i — migrated to withTenantAuth (drops manual JWT parsing).
import { withTenantAuth } from '../../lib/auth-middleware';

async function handler(req, res) {
  const { tenantId, supabase } = req.tenant;

  const { data, error } = await supabase
    .from("backtest_results")
    .select("*")
    .eq('tenant_id', tenantId)
    .order("win_rate", { ascending: false })
    .limit(100);

  if (error) return res.status(500).json({ error });

  return res.status(200).json(data);
}

export default withTenantAuth(handler);

