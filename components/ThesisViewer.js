// components/ThesisViewer.js
// 🟢 PUSH AM36 — structured thesis viewer shared by demo-index, performance.js
// and audit.js so all pages read oracle_reasoning the same way.
//
// REALITY CHECK (validated against producers): oracle_reasoning is free-form
// LLM prose (decisionJson.working_thesis) or short status strings — there are
// NO enforced section markers in stored data. So this component parses
// best-effort:
//   * DECISION badge from leading VETO:/APPROVE:/HOLD:/CLOSE keywords (or the
//     isVeto prop when the text carries no decision marker).
//   * PARAMETER GEOMETRY chips via regex on the text (TP/SL %, Tripwire,
//     Trail), falling back to sim_params when present.
//   * Section cards (MARKET CONTEXT / ALPHA / EXIT CONDITIONS / RE-EVALUATION)
//     only when those keyword headers actually appear in the text.
//   * Dollar figures ($X,XXX) and % moves (X.X%) bolded.
// Fallback: if nothing parses, the raw text renders verbatim — never lose
// content.

import React, { useState } from 'react';
import { BrainCircuit, ChevronDown, ChevronUp } from 'lucide-react';

const DECISION_PATTERNS = [
  { key: 'VETO', re: /^\s*\[?\s*VETO\b/i, cls: 'bg-red-500/20 text-red-400 border border-red-500/30', label: 'VETO' },
  { key: 'APPROVE', re: /^\s*\[?\s*APPROVE\b/i, cls: 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30', label: 'APPROVE' },
  { key: 'HOLD', re: /^\s*\[?\s*HOLD\b/i, cls: 'bg-amber-500/20 text-amber-400 border border-amber-500/30', label: 'HOLD' },
  { key: 'CLOSE', re: /^\s*\[?\s*CLOSE\b/i, cls: 'bg-slate-500/20 text-slate-300 border border-slate-500/30', label: 'CLOSE' },
];

// Section keyword headers — matched anywhere in the text (case-insensitive).
const SECTION_DEFS = [
  { key: 'context', label: 'Market Context', re: /(?:^|\n)\s*\[?\s*(?:MARKET\s+CONTEXT|CONTEXT)\s*\]?\s*[:\-]/i },
  { key: 'alpha', label: 'Alpha Thesis', re: /(?:^|\n)\s*\[?\s*(?:ALPHA(?:\s+THESIS)?|THESIS)\s*\]?\s*[:\-]/i },
  { key: 'exit', label: 'Exit Conditions', re: /(?:^|\n)\s*\[?\s*(?:EXIT\s+CONDITIONS?|EXIT\s+PLAN)\s*\]?\s*[:\-]/i },
  { key: 'reEval', label: 'Re-Evaluation', re: /(?:^|\n)\s*\[?\s*(?:RE-?EVALUATION|RE-?EVAL)\s*\]?\s*[:\-]/i },
];

// Extract a section's body: from the end of its header match to the start of
// the next known header (or end of text).
function extractSection(text, def, allDefs) {
  const m = text.match(def.re);
  if (!m) return null;
  const start = m.index + m[0].length;
  let end = text.length;
  for (const other of allDefs) {
    if (other.key === def.key) continue;
    const om = text.slice(start).match(other.re);
    if (om) end = Math.min(end, start + om.index);
  }
  const body = text.slice(start, end).trim();
  return body || null;
}

// Parameter geometry chips — regex over the thesis text, sim_params fallback.
function extractParams(text, simParams) {
  const chips = [];
  const push = (label, value) => { if (value != null && value !== '') chips.push({ label, value }); };

  const tpPct = text.match(/\bTP\s*(?:@|:)?\s*([\d.]+)\s*%/i);
  const slPct = text.match(/\bSL\s*(?:@|:)?\s*([\d.]+)\s*%/i);
  const trip = text.match(/\bTripwire\s*(?:@|:)?\s*([\d.]+)\s*%/i);
  const trail = text.match(/\bTrail\s*(?:step)?\s*([\d.]+)\s*%(?:\s*\/\s*lev(?:el)?\s*([\d.]+))?/i);

  const tpPrice = text.match(/\bTP\s*(?:@|:)?\s*\$?([\d,]+(?:\.\d+)?)/i);
  const slPrice = text.match(/\bSL\s*(?:@|:)?\s*\$?([\d,]+(?:\.\d+)?)/i);

  const sp = simParams && typeof simParams === 'object' ? simParams : {};
  const num = (v) => (v != null && Number.isFinite(parseFloat(v)) ? parseFloat(v) : null);

  push('TP', tpPct ? `${tpPct[1]}%` : (num(sp.tp_dist) != null ? `${(num(sp.tp_dist) * 100).toFixed(2)}%` : null));
  push('TP $', tpPrice ? `$${tpPrice[1]}` : (num(sp.tp_price) != null ? `$${num(sp.tp_price).toFixed(2)}` : null));
  push('SL', slPct ? `${slPct[1]}%` : (num(sp.sl_dist) != null ? `${(num(sp.sl_dist) * 100).toFixed(2)}%` : null));
  push('SL $', slPrice ? `$${slPrice[1]}` : (num(sp.sl_price) != null ? `$${num(sp.sl_price).toFixed(2)}` : null));
  push('Tripwire', trip ? `${trip[1]}%` : (num(sp.tripwire) != null ? `${(num(sp.tripwire) * 100).toFixed(2)}%` : null));
  push('Trail', trail ? `${trail[1]}%${trail[2] ? `/lev ${trail[2]}` : ''}` : (num(sp.trail_step) != null ? `${(num(sp.trail_step) * 100).toFixed(2)}%` : null));

  return chips.filter(c => c.value != null);
}

// Bold dollar figures and % moves inside a text chunk.
function highlightFigures(text) {
  const parts = String(text).split(/(\$[\d,]+(?:\.\d+)?|-?\d+(?:\.\d+)?%)/g);
  return parts.map((part, i) => {
    if (/^\$[\d,]+(?:\.\d+)?$/.test(part) || /^-?\d+(?:\.\d+)?%$/.test(part)) {
      return <span key={i} className="font-bold text-slate-200">{part}</span>;
    }
    return part;
  });
}

export default function ThesisViewer({ reasoning, simParams, isVeto, score }) {
  const [expandedSections, setExpandedSections] = useState({});

  if (!reasoning || typeof reasoning !== 'string') {
    // No reasoning at all — still show sim_params chips if we have them.
    const fallbackChips = simParams && Object.keys(simParams).length > 0 ? extractParams('', simParams) : [];
    if (fallbackChips.length === 0) {
      return <p className="text-xs text-slate-500 italic">No rationalization notes recorded.</p>;
    }
    return (
      <div className="border-l-2 border-purple-500/30 pl-4 py-1">
        <div className="flex flex-wrap gap-1.5">
          {fallbackChips.map((c, i) => (
            <span key={i} className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-slate-800/60 border border-white/10 text-slate-300">
              {c.label} <span className="text-indigo-300">{c.value}</span>
            </span>
          ))}
        </div>
      </div>
    );
  }

  const text = reasoning;

  // DECISION badge: leading keyword, else isVeto prop.
  let decision = null;
  for (const d of DECISION_PATTERNS) {
    if (d.re.test(text)) { decision = d; break; }
  }
  if (!decision && isVeto) {
    decision = DECISION_PATTERNS[0]; // VETO styling
  }

  const chips = extractParams(text, simParams);

  // Parse sections (only render cards for headers that actually exist).
  const sections = SECTION_DEFS
    .map(def => ({ ...def, body: extractSection(text, def, SECTION_DEFS) }))
    .filter(s => s.body);

  // Anything before the first section header = preamble (rendered raw).
  const firstHeaderIdx = sections.length > 0
    ? text.match(sections[0].re).index
    : -1;
  const preamble = firstHeaderIdx > 0 ? text.slice(0, firstHeaderIdx).trim() : (sections.length === 0 ? text : '');

  const toggle = (key) => setExpandedSections(prev => ({ ...prev, [key]: !prev[key] }));

  return (
    <div className={`border-l-2 pl-4 py-1 ${decision?.key === 'VETO' ? 'border-red-500/30' : 'border-amber-500/30'}`}>
      <h4 className={`text-[10px] font-black uppercase tracking-widest flex items-center gap-2 mb-2 ${decision?.key === 'VETO' ? 'text-red-400' : 'text-amber-400'}`}>
        <BrainCircuit size={12} /> Oracle Analysis {score != null && score !== '' && `(Score: ${score})`}
      </h4>

      {/* DECISION badge first */}
      {decision && (
        <div className="mb-2">
          <span className={`px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-widest ${decision.cls}`}>
            {decision.label}
          </span>
        </div>
      )}

      {/* PARAMETER GEOMETRY chips */}
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {chips.map((c, i) => (
            <span key={i} className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-slate-800/60 border border-white/10 text-slate-300">
              {c.label} <span className="text-indigo-300">{c.value}</span>
            </span>
          ))}
        </div>
      )}

      {/* Preamble / raw fallback */}
      {preamble && (
        <div className="bg-black/20 p-3 rounded-xl border border-white/5 mb-2">
          <p className="text-[12px] text-slate-400 leading-relaxed italic whitespace-pre-wrap break-words">
            {highlightFigures(preamble)}
          </p>
        </div>
      )}

      {/* Section cards */}
      {sections.map(s => {
        const isLong = s.body.length > 220;
        const defaultOpen = s.key === 'context' || !isLong;
        const open = expandedSections[s.key] !== undefined ? expandedSections[s.key] : defaultOpen;
        const isReEval = s.key === 'reEval';
        return (
          <div key={s.key} className={`bg-black/20 rounded-xl border mb-2 ${s.key === 'reEval' ? 'border-amber-500/30' : 'border-white/5'}`}>
            <button
              type="button"
              onClick={() => toggle(s.key)}
              className="w-full flex items-center justify-between px-3 py-2 text-left"
            >
              <span className={`text-[9px] font-black uppercase tracking-widest ${s.key === 'reEval' ? 'text-amber-400' : 'text-slate-400'}`}>
                {s.label}
                {s.key === 'reEval' && ' ⏱'}
              </span>
              <span className="text-slate-500">
                {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              </span>
            </button>
            {open && (
              <div className="px-3 pb-3">
                <p className={`text-[11px] leading-relaxed whitespace-pre-wrap break-words ${s.key === 'reEval' ? 'text-amber-200/90' : 'text-slate-400 italic'}`}>
                  {highlightFigures(s.body)}
                </p>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}