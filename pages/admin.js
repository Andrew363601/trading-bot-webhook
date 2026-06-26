// pages/admin.js
// Protected admin page for editing landing-page content.
// Replaces Wix CMS — all sections editable via JSON textareas.

import React, { useState, useEffect } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { useSupabaseClient, useSession } from '@supabase/auth-helpers-react';
import { FALLBACK_CONTENT } from '../lib/site-content';

const SECTIONS = ['hero', 'features', 'testimonials', 'differentiators', 'pricing'];

export default function AdminPage() {
  const supabase = useSupabaseClient();
  const session = useSession();

  const [activeTab, setActiveTab] = useState('hero');
  const [contentMap, setContentMap] = useState({ ...FALLBACK_CONTENT });
  const [editJson, setEditJson] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null); // { type: 'success'|'error', message }

  // Fetch current content from Supabase on mount
  useEffect(() => {
    if (!supabase) return;
    (async () => {
      try {
        const { data, error } = await supabase
          .from('site_content')
          .select('section_key, content');
        if (!error && data && data.length > 0) {
          const map = { ...FALLBACK_CONTENT };
          data.forEach(row => {
            map[row.section_key] = row.content;
          });
          setContentMap(map);
        }
      } catch (e) {
        console.warn('[ADMIN] Could not fetch content:', e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [supabase]);

  // Sync textarea when tab changes
  useEffect(() => {
    setEditJson(JSON.stringify(contentMap[activeTab], null, 2));
  }, [activeTab, contentMap]);

  const showToast = (type, message) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 4000);
  };

  const handleSave = async () => {
    if (!session) {
      showToast('error', 'Not authenticated. Please log in.');
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(editJson);
    } catch {
      showToast('error', 'Invalid JSON. Please fix syntax errors.');
      return;
    }

    setSaving(true);
    try {
      const res = await fetch('/api/admin/site-content', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ section_key: activeTab, content: parsed }),
      });

      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Save failed');

      // Update local state so the textarea reflects the saved value
      setContentMap(prev => ({ ...prev, [activeTab]: parsed }));
      showToast('success', `"${activeTab}" saved successfully.`);
    } catch (e) {
      showToast('error', e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    const fallback = FALLBACK_CONTENT[activeTab];
    setContentMap(prev => ({ ...prev, [activeTab]: fallback }));
    setEditJson(JSON.stringify(fallback, null, 2));
    showToast('success', `"${activeTab}" reset to default. Save to persist.`);
  };

  // --- Not authenticated ---
  if (!session) {
    return (
      <div className="min-h-screen bg-[#020617] flex items-center justify-center">
        <Head><title>Admin — Nexus</title></Head>
        <div className="text-center space-y-4">
          <h1 className="text-2xl font-bold text-white">Admin Panel</h1>
          <p className="text-slate-400">Please log in to access the admin panel.</p>
          <Link
            href="/auth"
            className="inline-block px-6 py-3 bg-indigo-600 text-white rounded-lg hover:bg-indigo-500 transition"
          >
            Go to Login
          </Link>
        </div>
      </div>
    );
  }

  // --- Loading ---
  if (loading) {
    return (
      <div className="min-h-screen bg-[#020617] flex items-center justify-center">
        <p className="text-slate-400">Loading content...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#020617] text-white">
      <Head><title>Admin — Nexus</title></Head>

      {/* Toast */}
      {toast && (
        <div className="fixed top-4 right-4 z-50">
          <div
            className={`px-4 py-3 rounded-lg shadow-lg text-sm font-medium ${
              toast.type === 'success'
                ? 'bg-emerald-600 text-white'
                : 'bg-red-600 text-white'
            }`}
          >
            {toast.message}
          </div>
        </div>
      )}

      <div className="max-w-4xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold">Admin Panel</h1>
          <Link
            href="/demo-index"
            target="_blank"
            className="text-sm text-indigo-400 hover:text-indigo-300 transition"
          >
            View Landing Page →
          </Link>
        </div>

        {/* Tab Bar */}
        <div className="flex flex-wrap gap-1 mb-6 border-b border-slate-700 pb-0">
          {SECTIONS.map(section => (
            <button
              key={section}
              onClick={() => setActiveTab(section)}
              className={`px-4 py-2 text-sm font-medium rounded-t-lg transition ${
                activeTab === section
                  ? 'bg-slate-800 text-white border border-slate-700 border-b-slate-800 -mb-px'
                  : 'text-slate-400 hover:text-white hover:bg-slate-800/50'
              }`}
            >
              {section.charAt(0).toUpperCase() + section.slice(1)}
            </button>
          ))}
        </div>

        {/* Editor */}
        <div className="space-y-4">
          <textarea
            value={editJson}
            onChange={e => setEditJson(e.target.value)}
            rows={16}
            className="w-full bg-slate-900 border border-slate-700 rounded-lg p-4 text-sm text-slate-200 font-mono focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 resize-y"
            spellCheck={false}
          />

          {/* Buttons */}
          <div className="flex gap-3">
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-5 py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed transition"
            >
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
            <button
              onClick={handleReset}
              className="px-5 py-2.5 bg-slate-700 text-slate-200 text-sm font-medium rounded-lg hover:bg-slate-600 transition"
            >
              Reset to Default
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}