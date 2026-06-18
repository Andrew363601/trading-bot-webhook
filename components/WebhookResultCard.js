// components/WebhookResultCard.js
// Reusable card for displaying a copyable webhook URL + TradingView JSON payload.
// Used by the dashboard onboarding banner after magic-link login auto-creates
// the webhook strategy.

import { useState } from 'react';
import { Copy, Check } from 'lucide-react';

export default function WebhookResultCard({ webhookUrl, tradingViewPayload, strategy, onDismiss }) {
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [copiedPayload, setCopiedPayload] = useState(false);

  const copyToClipboard = async (text, setter) => {
    try {
      await navigator.clipboard.writeText(text);
      setter(true);
      setTimeout(() => setter(false), 2000);
    } catch {
      // Fallback for older browsers
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setter(true);
      setTimeout(() => setter(false), 2000);
    }
  };

  return (
    <div className="bg-gradient-to-r from-cyan-600/10 to-purple-600/10 border border-cyan-500/30 rounded-2xl p-6 mb-6">
      <div className="flex items-center gap-3 mb-4">
        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-cyan-400 to-purple-500 flex items-center justify-center text-white font-bold text-sm">
          ✅
        </div>
        <div>
          <h3 className="text-lg font-bold text-white">Webhook Strategy Activated!</h3>
          <p className="text-sm text-slate-400">
            Your {strategy?.strategy || 'webhook'} strategy for {strategy?.asset || 'CDE'} is ready in {strategy?.execution_mode || 'PAPER'} mode.
          </p>
        </div>
      </div>

      <div className="space-y-4">
        {/* Webhook URL */}
        <div>
          <label className="text-xs text-slate-400 uppercase tracking-wider font-bold mb-1 block">
            Webhook URL
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              readOnly
              value={webhookUrl}
              className="flex-1 bg-slate-800 text-cyan-300 text-xs font-mono px-3 py-2 rounded-lg border border-white/10"
              onClick={(e) => e.target.select()}
            />
            <button
              onClick={() => copyToClipboard(webhookUrl, setCopiedUrl)}
              className="bg-cyan-500 hover:bg-cyan-400 text-slate-900 px-4 py-2 rounded-lg text-xs font-bold flex items-center gap-1 transition-colors"
            >
              {copiedUrl ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
              {copiedUrl ? 'Copied!' : 'Copy'}
            </button>
          </div>
        </div>

        {/* TradingView JSON Payload */}
        <div>
          <label className="text-xs text-slate-400 uppercase tracking-wider font-bold mb-1 block">
            TradingView Alert Payload (paste in &quot;Message&quot; field)
          </label>
          <div className="bg-slate-800 border border-white/10 rounded-lg p-3 relative">
            <pre className="text-xs text-slate-300 font-mono whitespace-pre-wrap overflow-x-auto">
              {tradingViewPayload}
            </pre>
            <button
              onClick={() => copyToClipboard(tradingViewPayload, setCopiedPayload)}
              className="absolute top-2 right-2 bg-slate-700 hover:bg-slate-600 text-white px-2 py-1 rounded text-xs transition-colors"
            >
              {copiedPayload ? 'Copied!' : 'Copy'}
            </button>
          </div>
        </div>

        <div className="bg-cyan-500/10 border border-cyan-500/20 rounded-lg px-4 py-3">
          <p className="text-xs text-cyan-300">
            <strong>Next step:</strong> Paste the URL and JSON into your TradingView alert, then fire a test signal.
            Nexus AI will receive it and route it to your AI execution desk for evaluation.
          </p>
        </div>

        {onDismiss && (
          <button
            onClick={onDismiss}
            className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
          >
            Dismiss
          </button>
        )}
      </div>
    </div>
  );
}
