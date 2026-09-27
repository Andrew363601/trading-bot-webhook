// lib/strategy-resolver.js
//
// Resolves a strategy name to either a built-in (statically imported in
// strategy-router.js) or a tenant-owned / public row in strategy_library.
// Used on the worker hot path -> in-module cache with 60s TTL.

import { createClient } from '@supabase/supabase-js';
import { BUILT_IN_STRATEGIES } from './strategy-router.js';

// Service-role client: the router runs inside workers with no request-scoped
// supabase; RLS is bypassed deliberately (same pattern as deploy-strategy.js).
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const CACHE_TTL_MS = 60_000;
const resolveCache = new Map(); // key: `${name}|${tenantId}` -> { value, expiresAt }

function cacheGet(key) {
  const hit = resolveCache.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.expiresAt) {
    resolveCache.delete(key);
    return undefined;
  }
  return hit.value;
}

function cacheSet(key, value) {
  resolveCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

/**
 * Resolve a strategy name to its source.
 * @param {string} strategyName
 * @param {string|null} tenantId - owning tenant (null = built-ins + public only)
 * @returns {Promise<{source:'builtin'} | {source:'library', code:string, version:number, library_id:string} | {source:'none'}>}
 */
export async function resolveStrategy(strategyName, tenantId = null) {
  const cleanName = String(strategyName || '').trim().toLowerCase();
  if (!cleanName) return { source: 'none' };

  // 1. Built-ins first — never let a library row shadow them.
  if (BUILT_IN_STRATEGIES.has(cleanName.toUpperCase())) {
    return { source: 'builtin' };
  }

  // 2. Library lookup (cached on the hot path).
  const cacheKey = `${cleanName}|${tenantId || 'public'}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  let query = supabase
    .from('strategy_library')
    .select('id, code, version, visibility, tenant_id')
    .eq('name', cleanName)
    .order('version', { ascending: false })
    .limit(1);

  // Tenant rows take priority; fall back to public rows from other tenants.
  if (tenantId) {
    query = query.or(`tenant_id.eq.${tenantId},visibility.eq.public`);
  } else {
    query = query.eq('visibility', 'public');
  }

  const { data, error } = await query.maybeSingle();

  if (error) {
    console.error(`[STRATEGY_RESOLVER] Lookup failed for '${cleanName}':`, error.message);
    return { source: 'none' };
  }

  if (!data) {
    const result = { source: 'none' };
    cacheSet(cacheKey, result);
    return result;
  }

  const result = {
    source: 'library',
    code: data.code,
    version: data.version,
    library_id: data.id
  };
  cacheSet(cacheKey, result);
  return result;
}
