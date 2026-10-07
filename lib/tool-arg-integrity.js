// lib/tool-arg-integrity.js
// 🟢 PUSH AM54 — tool-arg integrity helpers.
//
// WHY: the manual OpenRouter tool loop (pages/api/chat.js) does NOT enforce zod,
// so tool arguments arrive as raw JSON. Two proven-live failure modes:
//   1. `parameters` arrives as a JSON STRING -> a truthy string passes
//      `parameters || {}`, the strategy's destructuring gets nothing, and the
//      backtest silently replicates defaults byte-for-byte (tuning channel
//      appears dead).
//   2. saveStrategyCode/updateStrategyCode take `name`, but the model is primed
//      by readStrategyLogic to send `strategy_name` -> "Strategy '' not found"
//      instead of a loud param error.
//
// These are PURE helpers (no I/O) so both the chat tools and the backtest
// service share ONE source of truth, and so they are unit-testable directly.

/**
 * Normalize a `parameters` tool argument into a plain object.
 * Accepts: undefined/null (-> {}), a plain object (-> as-is), or a JSON string
 * (-> parsed). Rejects arrays and non-object primitives LOUDLY.
 *
 * @param {*} raw the raw `parameters` value as received
 * @returns {{ ok: true, parameters: object, normalizedFromString: boolean, receivedType: string }
 *          | { ok: false, error: string, receivedType: string }}
 */
export function normalizeParametersArg(raw) {
  const receivedType = Array.isArray(raw) ? 'array' : typeof raw;

  // Absent -> empty override set (feature simply unused).
  if (raw === undefined || raw === null) {
    return { ok: true, parameters: {}, normalizedFromString: false, receivedType };
  }

  let parameters = raw;
  let normalizedFromString = false;

  if (typeof parameters === 'string') {
    try {
      parameters = JSON.parse(parameters);
      normalizedFromString = true;
    } catch {
      return {
        ok: false,
        receivedType,
        error: 'parameters arrived as an unparseable JSON string — send a JSON object of overrides.'
      };
    }
  }

  if (typeof parameters !== 'object' || Array.isArray(parameters)) {
    return {
      ok: false,
      receivedType,
      error: 'parameters must be a JSON object of overrides (e.g. {"key_value": 5.0}). Received: ' + typeof parameters + '.'
    };
  }

  return { ok: true, parameters, normalizedFromString, receivedType };
}

/**
 * Resolve a strategy identifier from tool args, accepting the `strategy_name`
 * alias the model is primed to send. An empty identifier is a PARAM error —
 * never a lookup result ("Strategy '' not found" must never be emitted).
 *
 * @param {object} args the raw tool args object
 * @returns {{ ok: true, name: string } | { ok: false, error: string }}
 */
export function resolveStrategyIdentifier(args) {
  const a = args || {};
  const rawName = a.name || a.strategy_name || '';
  if (!String(rawName).trim()) {
    return {
      ok: false,
      error: 'name is required — pass the library slug as `name` (e.g. "ut_bot_replica_v1"). Received: ' + typeof a.name + '/' + typeof a.strategy_name
    };
  }
  return { ok: true, name: String(rawName).trim() };
}

const toolArgIntegrity = { normalizeParametersArg, resolveStrategyIdentifier };
export default toolArgIntegrity;
