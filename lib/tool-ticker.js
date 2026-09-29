// lib/tool-ticker.js
// PUSH AM52b2 — shared tool-ticker formatter for the chat endpoint.
//
// The chat API is NOT streaming, so the ticker is POST-HOC: one dim mono line
// per tool call is collected during the run and prepended to the final text.
// Both execution branches (streamText + the manual OpenRouter loop) use this.

/**
 * Format one tool call as a ticker line, echoing the key args.
 * @param {string} toolName
 * @param {object} [args]
 * @returns {string} e.g. "[⟳ runBacktest · BTC-USD · sma_cross]"
 */
export function formatToolTicker(toolName, args) {
  const a = args && typeof args === 'object' ? args : {};
  const bits = [];
  if (a.product) bits.push(String(a.product));
  if (a.strategy_name) bits.push(String(a.strategy_name));
  else if (a.strategy) bits.push(String(a.strategy));
  if (a.asset) bits.push(String(a.asset));
  const echo = bits.length ? ` · ${bits.join(' · ')}` : '';
  return `[⟳ ${toolName}${echo}]`;
}

/**
 * Collapse consecutive duplicate ticker lines (the model sometimes repeats a
 * tool call within a turn).
 * @param {string[]} lines
 * @returns {string[]}
 */
export function dedupeTickerLines(lines) {
  const out = [];
  for (const l of lines) if (out[out.length - 1] !== l) out.push(l);
  return out;
}

const toolTicker = { formatToolTicker, dedupeTickerLines };
export default toolTicker;
