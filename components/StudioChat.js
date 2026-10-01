import React, { useState, useEffect, useRef } from 'react';
import { Terminal as TerminalIcon, Send, RotateCw, Sparkles, AlertCircle } from 'lucide-react';
import StudioTheater from './StudioTheater.js';

export default function StudioChat({ session, strategyName, onStrategyUpdated }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const chatEndRef = useRef(null);

  // Auto-scroll on new message
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || loading) return;

    setError('');
    const userMsg = {
      id: Date.now().toString(),
      role: 'user',
      content: trimmed
    };

    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput('');
    setLoading(true);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: session?.access_token ? `Bearer ${session.access_token}` : ''
        },
        body: JSON.stringify({
          messages: newMessages,
          studio_context: strategyName ? { strategy_name: strategyName } : undefined
        })
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Chat error (${res.status})`);
      }

      // Stream reader identical to dashboard chat
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let parsedContent = '';

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          parsedContent += decoder.decode(value, { stream: true });
        }
      } else {
        parsedContent = await res.text();
      }

      const assistantMsg = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: parsedContent || 'No response generated'
      };

      setMessages((prev) => [...prev, assistantMsg]);

      // If response mentions updating code or running backtest, notify parent if callback provided
      if (onStrategyUpdated && (parsedContent.includes('Strategy updated') || parsedContent.includes('saveStrategyCode'))) {
        onStrategyUpdated();
      }
    } catch (err) {
      console.error('[STUDIO CHAT ERROR]:', err);
      setError(err.message || 'Chat request failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-slate-950 border border-white/10 rounded-2xl overflow-hidden shadow-2xl">
      {/* Header */}
      <div className="px-4 py-3 border-b border-white/5 bg-slate-900/40 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <TerminalIcon size={14} className="text-indigo-400" />
          <span className="text-[11px] font-black uppercase tracking-wider text-slate-300">
            Nexus Quant Architect
          </span>
          {strategyName && (
            <span className="text-[9px] font-mono px-2 py-0.5 rounded bg-indigo-500/10 text-indigo-300 border border-indigo-500/20 truncate max-w-[130px]">
              {strategyName}
            </span>
          )}
        </div>
        <button
          onClick={() => setMessages([])}
          className="text-[9px] font-bold text-slate-500 hover:text-red-400 transition-colors px-2 py-0.5 rounded hover:bg-red-500/10 uppercase tracking-widest"
          title="Clear chat history"
        >
          Clear
        </button>
      </div>

      {/* Messages */}
      <div className="p-4 overflow-y-auto custom-scrollbar font-mono text-xs space-y-3 flex-grow min-h-[300px]">
        {messages.length === 0 && (
          <div className="text-center py-10 space-y-2">
            <Sparkles className="w-6 h-6 text-indigo-400 mx-auto opacity-40" />
            <p className="text-[11px] text-slate-500 max-w-[240px] mx-auto">
              Ask Nexus to read results, optimize parameters, or iterate strategy code.
            </p>
            {strategyName && (
              <div className="pt-2 flex flex-col gap-1.5 max-w-[260px] mx-auto text-[10px]">
                <button
                  type="button"
                  onClick={() => setInput(`Read the latest backtest results for ${strategyName}`)}
                  className="px-2.5 py-1.5 rounded-lg bg-slate-900 border border-white/5 text-slate-400 hover:text-white hover:border-white/20 text-left transition-all"
                >
                  ?? &quot;Read the latest backtest results&quot;
                </button>
                <button
                  type="button"
                  onClick={() => setInput(`Suggest parameter improvements for ${strategyName}`)}
                  className="px-2.5 py-1.5 rounded-lg bg-slate-900 border border-white/5 text-slate-400 hover:text-white hover:border-white/20 text-left transition-all"
                >
                  ? &quot;Suggest parameter improvements&quot;
                </button>
              </div>
            )}
          </div>
        )}

        {messages.map((m) => (
          <div
            key={m.id}
            className={`flex flex-col gap-1.5 ${m.role === 'user' ? 'items-end' : 'items-start'}`}
          >
            {m.role === 'assistant' ? (
              (() => {
                // PUSH AM52b2 — split the post-hoc tool ticker (dim mono lines)
                // from the assistant body.
                const lines = String(m.content || '').split('\n');
                const ticker = [];
                let i = 0;
                while (i < lines.length && lines[i].startsWith('[⟳')) { ticker.push(lines[i]); i++; }
                while (i < lines.length && lines[i].trim() === '') i++;
                const body = lines.slice(i).join('\n');
                return (
                  <>
                    {ticker.length > 0 && (
                      <div className="flex flex-col gap-0.5 max-w-[90%]">
                        {ticker.map((t, idx) => (
                          <span key={idx} className="text-[10px] font-mono text-slate-500/80 leading-tight">{t}</span>
                        ))}
                      </div>
                    )}
                    <div className="max-w-[90%] rounded-xl px-3.5 py-2.5 whitespace-pre-wrap break-words leading-relaxed text-[11px] bg-slate-900/90 text-cyan-300 border border-white/5 shadow-sm">
                      {body}
                    </div>
                    {/* PUSH AM57b — inline Episode Theater card when the reply
                        carries a studio_url with a run id. */}
                    {(() => {
                      const match = String(m.content || '').match(/\/studio\?strategy=[a-z0-9_]+&run=([0-9a-fA-F-]{36})/);
                      if (!match) return null;
                      return (
                        <div className="w-full max-w-[90%]">
                          <StudioTheater session={session} runId={match[1]} visible={true} />
                        </div>
                      );
                    })()}
                  </>
                );
              })()
            ) : (
              <div className="max-w-[90%] rounded-xl px-3.5 py-2.5 whitespace-pre-wrap break-words leading-relaxed text-[11px] bg-indigo-600/20 text-indigo-200 border border-indigo-500/30">
                {m.content}
              </div>
            )}
          </div>
        ))}

        {loading && (
          <div className="flex items-center gap-2 text-slate-500 text-[11px] italic">
            <RotateCw className="w-3.5 h-3.5 animate-spin text-indigo-400" />
            <span>Nexus iterating...</span>
          </div>
        )}

        {error && (
          <div className="p-2.5 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-[11px] flex items-center gap-2">
            <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div ref={chatEndRef} />
      </div>

      {/* Input */}
      <form onSubmit={handleSubmit} className="p-3 border-t border-white/5 bg-slate-900/30 flex gap-2">
        <input
          type="text"
          className="flex-1 bg-black/60 border border-white/10 rounded-xl px-3 py-2 text-xs font-mono text-white focus:outline-none focus:border-indigo-500/60 transition-colors"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={strategyName ? `Ask about ${strategyName}...` : "Command Nexus..."}
          disabled={loading}
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="px-3.5 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white rounded-xl text-xs font-bold transition-all flex items-center justify-center active:scale-95"
        >
          {loading ? <RotateCw className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
        </button>
      </form>
    </div>
  );
}
