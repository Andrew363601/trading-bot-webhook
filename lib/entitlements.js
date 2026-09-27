// lib/entitlements.js
// Gating doctrine: Access = tenants.billing_tier IN ('PRO', 'ENTERPRISE', 'INSTITUTIONAL', 'ADMIN').
// Read tenants.billing_tier (server-side), NOT tenant_users.role.

export const STUDIO_TIERS = ['PRO', 'ENTERPRISE', 'INSTITUTIONAL', 'ADMIN'];

export async function getBillingTier(supabase, tenantId) {
  if (!supabase || !tenantId) return null;
  const { data, error } = await supabase
    .from('tenants')
    .select('billing_tier')
    .eq('id', tenantId)
    .single();
  if (error) {
    throw new Error(`Tier lookup failed: ${error.message}`);
  }
  return data?.billing_tier || null;
}

export function hasStudioAccess(tier) {
  if (!tier) return false;
  return STUDIO_TIERS.includes(String(tier).toUpperCase());
}
