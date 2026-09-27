// pages/api/strategy-library.js
import { withTenantAuth } from '../../lib/auth-middleware.js';
import { hasStudioAccess } from '../../lib/entitlements.js';
import { validateStrategyCode } from '../../lib/strategy-validator.js';

const NAME_REGEX = /^[a-z0-9_]{3,64}$/;

async function handler(req, res) {
  const { tenantId, tier, supabase } = req.tenant;

  if (req.method === 'GET') {
    const { name } = req.query;

    if (name) {
      const cleanName = String(name).trim().toLowerCase();
      // Fetch single strategy: must be owned by tenant OR public
      const { data, error } = await supabase
        .from('strategy_library')
        .select(`
          id, tenant_id, name, display_name, description, code, version, visibility, status, latest_backtest, created_at, updated_at
        `)
        .eq('name', cleanName)
        .or(`tenant_id.eq.${tenantId},visibility.eq.public`)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) {
        return res.status(500).json({ error: `Lookup failed: ${error.message}` });
      }
      if (!data) {
        return res.status(404).json({ error: `Strategy '${cleanName}' not found.` });
      }

      // Also fetch version history for the selected strategy
      const { data: versions } = await supabase
        .from('strategy_library_versions')
        .select('id, version, code, change_note, created_at')
        .eq('library_id', data.id)
        .order('version', { ascending: false });

      return res.status(200).json({ strategy: data, versions: versions || [] });
    }

    // List: own rows (all) + public rows from other tenants
    const { data: strategies, error } = await supabase
      .from('strategy_library')
      .select('id, tenant_id, name, display_name, description, version, visibility, status, latest_backtest, created_at, updated_at')
      .or(`tenant_id.eq.${tenantId},visibility.eq.public`)
      .order('updated_at', { ascending: false });

    if (error) {
      return res.status(500).json({ error: `List failed: ${error.message}` });
    }

    const own = [];
    const publicLib = [];

    (strategies || []).forEach(row => {
      if (row.tenant_id === tenantId) {
        own.push(row);
      } else {
        publicLib.push(row);
      }
    });

    return res.status(200).json({ my_strategies: own, public_library: publicLib });
  }

  // GATING DOCTRINE: POST/PUT require hasStudioAccess(tier)
  if (!hasStudioAccess(tier)) {
    return res.status(403).json({
      error: 'Strategy Studio requires a PRO plan or higher',
      upgrade: '/plans'
    });
  }

  if (req.method === 'POST') {
    const { name, display_name, description, code, overwrite, visibility } = req.body || {};

    const cleanName = (name || '').toString().trim().toLowerCase();
    if (!NAME_REGEX.test(cleanName)) {
      return res.status(400).json({
        error: `Invalid strategy name '${cleanName}'. Name must match lowercase letters, numbers, and underscores (3-64 chars).`
      });
    }

    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: 'Code is required and must be a string.' });
    }

    const validation = validateStrategyCode(code);
    if (!validation.ok) {
      return res.status(400).json({
        error: 'Strategy code validation failed.',
        errors: validation.errors
      });
    }

    const cleanVisibility = visibility === 'public' ? 'public' : 'private';

    // Check if (tenant_id, name) already exists
    const { data: existing, error: checkError } = await supabase
      .from('strategy_library')
      .select('id, name, version')
      .eq('tenant_id', tenantId)
      .eq('name', cleanName)
      .maybeSingle();

    if (checkError) {
      return res.status(500).json({ error: `Failed checking existing strategy: ${checkError.message}` });
    }

    if (existing && !overwrite) {
      return res.status(409).json({
        error: `Strategy '${cleanName}' already exists with version ${existing.version}. Pass overwrite: true to overwrite.`,
        existing: { name: existing.name, version: existing.version }
      });
    }

    if (existing && overwrite) {
      // Bumping version and updating
      const newVersion = (existing.version || 1) + 1;
      const { data: updated, error: updateErr } = await supabase
        .from('strategy_library')
        .update({
          display_name: display_name || cleanName,
          description: description || null,
          code,
          version: newVersion,
          visibility: cleanVisibility,
          updated_at: new Date().toISOString()
        })
        .eq('id', existing.id)
        .eq('tenant_id', tenantId)
        .select()
        .single();

      if (updateErr) {
        return res.status(500).json({ error: `Failed updating strategy: ${updateErr.message}` });
      }

      await supabase
        .from('strategy_library_versions')
        .insert([{
          library_id: existing.id,
          version: newVersion,
          code,
          change_note: 'Overwrite via POST'
        }]);

      return res.status(200).json({
        saved: true,
        strategy: updated,
        version: newVersion,
        studio_url: `/studio?strategy=${cleanName}`
      });
    }

    // New strategy insertion
    const { data: inserted, error: insertError } = await supabase
      .from('strategy_library')
      .insert([{
        tenant_id: tenantId,
        name: cleanName,
        display_name: display_name || cleanName,
        description: description || null,
        code,
        version: 1,
        visibility: cleanVisibility,
        status: 'draft'
      }])
      .select()
      .single();

    if (insertError) {
      return res.status(500).json({ error: `Failed saving strategy: ${insertError.message}` });
    }

    // Insert version 1 into versions table
    await supabase
      .from('strategy_library_versions')
      .insert([{
        library_id: inserted.id,
        version: 1,
        code,
        change_note: 'Initial version'
      }]);

    return res.status(201).json({
      saved: true,
      strategy: inserted,
      version: 1,
      studio_url: `/studio?strategy=${cleanName}`
    });
  }

  if (req.method === 'PUT') {
    const { id, code, description, display_name, visibility, change_note } = req.body || {};

    if (!id) {
      return res.status(400).json({ error: 'Missing strategy id in request body.' });
    }

    // Owner-only check
    const { data: existing, error: fetchErr } = await supabase
      .from('strategy_library')
      .select('id, tenant_id, name, version, code, display_name, description, visibility')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .single();

    if (fetchErr || !existing) {
      return res.status(404).json({ error: 'Strategy not found or unauthorized.' });
    }

    const updates = {
      updated_at: new Date().toISOString()
    };
    if (description !== undefined) updates.description = description;
    if (display_name !== undefined) updates.display_name = display_name;
    if (visibility !== undefined) {
      updates.visibility = visibility === 'public' ? 'public' : 'private';
    }

    let codeChanged = false;
    let newVersion = existing.version;

    if (code !== undefined && code !== existing.code) {
      const validation = validateStrategyCode(code);
      if (!validation.ok) {
        return res.status(400).json({
          error: 'Strategy code validation failed.',
          errors: validation.errors
        });
      }
      codeChanged = true;
      newVersion = existing.version + 1;
      updates.code = code;
      updates.version = newVersion;
    }

    const { data: updated, error: updateErr } = await supabase
      .from('strategy_library')
      .update(updates)
      .eq('id', existing.id)
      .eq('tenant_id', tenantId)
      .select()
      .single();

    if (updateErr) {
      return res.status(500).json({ error: `Update failed: ${updateErr.message}` });
    }

    if (codeChanged) {
      // Append new version
      await supabase
        .from('strategy_library_versions')
        .insert([{
          library_id: existing.id,
          version: newVersion,
          code,
          change_note: change_note || `Bumped to version ${newVersion}`
        }]);
    }

    return res.status(200).json({
      saved: true,
      strategy: updated,
      version: newVersion,
      studio_url: `/studio?strategy=${existing.name}`
    });
  }

  res.setHeader('Allow', ['GET', 'POST', 'PUT']);
  return res.status(405).json({ error: `Method ${req.method} not allowed` });
}

export default withTenantAuth(handler);
