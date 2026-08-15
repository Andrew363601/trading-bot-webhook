// components/AiModelSelector.js
import React, { useState, useEffect } from 'react';
import { Cpu, CheckCircle2, AlertCircle, Save, Zap, Search } from 'lucide-react';
import { useSupabaseClient, useSession } from '@supabase/auth-helpers-react';

export default function AiModelSelector() {
  const supabase = useSupabaseClient();
  const session = useSession();

  const [provider, setProvider] = useState('gemini');
  const [model, setModel] = useState('gemini-3-flash-preview');
  const [availableModels, setAvailableModels] = useState([]);
  const [envStatus, setEnvStatus] = useState({ has_gemini_key: false, has_openrouter_key: false });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState(null);
  const [modelSearch, setModelSearch] = useState('');

  useEffect(() => {
    fetchSettings();
  }, [session]);

  const fetchSettings = async () => {
    if (!session?.access_token) return;
    setLoading(true);
    try {
      const resp = await fetch('/api/admin/ai-settings', {
        headers: { 'Authorization': `Bearer ${session.access_token}` }
      });
      if (resp.ok) {
        const data = await resp.json();
        setProvider(data.ai_provider || 'gemini');
        setModel(data.ai_model || 'gemini-3-flash-preview');
        setAvailableModels(data.available_models || []);
        setEnvStatus(data.env || {});
      }
    } catch (err) {
      console.error('[AI SELECTOR] Failed to load settings:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!session?.access_token) return;
    setSaving(true);
    setStatus(null);
    try {
      const resp = await fetch('/api/admin/ai-settings', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`
        },
        body: JSON.stringify({ ai_provider: provider, ai_model: model })
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Failed to save settings');
      setStatus({ type: 'success', message: `Global AI provider set to ${provider} (${model})` });
    } catch (err) {
      setStatus({ type: 'error', message: err.message });
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    if (!session?.access_token) return;
    setTesting(true);
    setStatus(null);
    try {
      const resp = await fetch('/api/admin/ai-settings?action=test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`
        },
        body: JSON.stringify({ ai_provider: provider, ai_model: model })
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Test connection failed');
      setStatus({ type: 'success', message: data.message || 'Connection test successful!' });
    } catch (err) {
      setStatus({ type: 'error', message: `Test failed: ${err.message}` });
    } finally {
      setTesting(false);
    }
  };

  const filteredModels = availableModels.filter(m => 
    m.id.toLowerCase().includes(modelSearch.toLowerCase()) || 
    m.name.toLowerCase().includes(modelSearch.toLowerCase())
  );

  if (loading) {
    return (
      <div className="bg-slate-900/50 border border-white/5 p-8 rounded-3xl backdrop-blur-xl animate-pulse">
        <div className="h-6 w-48 bg-slate-800 rounded mb-4" />
        <div className="h-10 bg-slate-800 rounded" />
      </div>
    );
  }

  return (
    <div className="bg-slate-900/50 border border-white/5 p-8 rounded-3xl space-y-6 backdrop-blur-xl">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-3">
          <Cpu className="w-5 h-5 text-emerald-400" />
          <h2 className="text-xl font-black uppercase tracking-tight">AI Provider & Model Router</h2>
        </div>
        <span className="text-[9px] font-black uppercase px-2 py-1 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
          Admin Only
        </span>
      </div>

      <p className="text-[11px] text-slate-400 leading-relaxed">
        Configure the global LLM engine across all 5 AI subsystems (Chat, Demo Chat, Genetic Optimizer, Trade Oracle, and Hermes Cortex).
      </p>

      {/* Provider Toggle */}
      <div className="space-y-2">
        <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Active AI Provider</label>
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => {
              setProvider('gemini');
              if (provider !== 'gemini') setModel('gemini-3-flash-preview');
            }}
            className={`py-3 px-4 rounded-xl text-xs font-black uppercase tracking-wider border transition-all ${
              provider === 'gemini'
                ? 'bg-indigo-600 border-indigo-500 text-white shadow-lg shadow-indigo-600/20'
                : 'bg-slate-950 border-white/5 text-slate-400 hover:text-white'
            }`}
          >
            Google Gemini
          </button>
          <button
            type="button"
            onClick={() => {
              setProvider('openrouter');
              if (provider !== 'openrouter') setModel(availableModels[0]?.id || 'openai/gpt-4o');
            }}
            className={`py-3 px-4 rounded-xl text-xs font-black uppercase tracking-wider border transition-all ${
              provider === 'openrouter'
                ? 'bg-purple-600 border-purple-500 text-white shadow-lg shadow-purple-600/20'
                : 'bg-slate-950 border-white/5 text-slate-400 hover:text-white'
            }`}
          >
            OpenRouter
          </button>
        </div>
      </div>

      {/* Model Selection */}
      <div className="space-y-2">
        <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">
          {provider === 'gemini' ? 'Gemini Model Identifier' : 'OpenRouter Model'}
        </label>
        
        {provider === 'gemini' ? (
          <input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="gemini-3-flash-preview"
            className="w-full bg-slate-950 border border-white/5 rounded-xl px-4 py-3 text-white focus:ring-2 focus:ring-indigo-500/50 outline-none transition-all font-mono text-sm"
          />
        ) : (
          <div className="space-y-2">
            {availableModels.length > 8 && (
              <div className="relative">
                <Search className="w-4 h-4 text-slate-500 absolute left-3 top-3.5" />
                <input
                  type="text"
                  placeholder="Filter OpenRouter models..."
                  value={modelSearch}
                  onChange={(e) => setModelSearch(e.target.value)}
                  className="w-full bg-slate-950/80 border border-white/5 rounded-xl pl-9 pr-4 py-2 text-xs text-white focus:ring-2 focus:ring-purple-500/50 outline-none font-mono"
                />
              </div>
            )}
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full bg-slate-950 border border-white/5 rounded-xl px-4 py-3 text-white focus:ring-2 focus:ring-purple-500/50 outline-none transition-all font-mono text-sm"
            >
              {filteredModels.length > 0 ? (
                filteredModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} ({m.id})
                  </option>
                ))
              ) : (
                <option value={model}>{model || 'No models found'}</option>
              )}
            </select>
          </div>
        )}
      </div>

      {/* Action Buttons */}
      <div className="flex gap-3 pt-2">
        <button
          type="button"
          disabled={saving || testing}
          onClick={handleSave}
          className="flex-1 bg-white text-black hover:bg-slate-200 font-black py-3 rounded-xl transition-all flex items-center justify-center gap-2 uppercase text-xs tracking-widest"
        >
          {saving ? <div className="w-4 h-4 border-2 border-black/20 border-t-black rounded-full animate-spin" /> : <Save className="w-4 h-4" />}
          Save Settings
        </button>
        <button
          type="button"
          disabled={saving || testing}
          onClick={handleTest}
          className="bg-slate-800 hover:bg-slate-700 text-slate-300 font-black px-6 py-3 rounded-xl transition-all flex items-center justify-center gap-2 uppercase text-xs tracking-widest"
        >
          {testing ? <div className="w-4 h-4 border-2 border-white/20 border-t-white rounded-full animate-spin" /> : <Zap className="w-4 h-4 text-amber-400" />}
          Test
        </button>
      </div>

      {status && (
        <div className={`p-4 rounded-xl border flex items-center gap-3 ${
          status.type === 'success' ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' : 'bg-red-500/10 border-red-500/20 text-red-400'
        }`}>
          {status.type === 'success' ? <CheckCircle2 className="w-5 h-5 shrink-0" /> : <AlertCircle className="w-5 h-5 shrink-0" />}
          <span className="text-xs font-bold uppercase tracking-wide">{status.message}</span>
        </div>
      )}
    </div>
  );
}
