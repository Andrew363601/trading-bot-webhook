// lib/strategy-executor.js
//
// Shared sandboxed compile+execute shim for user-authored strategies.
// Used by the live router (strategy-router.js) and the backtester so that
// backtest <-> live execution is byte-for-byte the same code path.
//
// Sandbox doctrine: strategy code runs inside a node:vm context with a strict
// allowlist { technicalindicators, Math, JSON }. NO fs, NO net, NO process.
// Per-call execution is time-boxed; a hung strategy throws, never blocks the worker.

import vm from 'node:vm';
import * as technicalindicators from 'technicalindicators';

// Strip ES module syntax exactly like lib/strategy-validator.js so the code
// can compile as a classic vm.Script. Line-anchored regexes (same limitation
// as the validator: indented/multiline import statements are not stripped).
function stripModuleSyntax(code) {
  return code
    .replace(/^\s*import\s+[^;]+;?/gm, '// [import stripped for sandbox compile]')
    .replace(/^\s*export\s+(default\s+)?/gm, '');
}

/**
 * Compile strategy source into an executable run reference.
 * @param {string} code - raw strategy JS (may contain import/export)
 * @returns {{ ok: true, runRef: Function } | { ok: false, errors: string[] }}
 */
export function compileStrategy(code) {
  if (typeof code !== 'string' || !code.trim()) {
    return { ok: false, errors: ['Strategy code is empty or not a string.'] };
  }

  let scriptCode;
  try {
    scriptCode = stripModuleSyntax(code);
  } catch (e) {
    return { ok: false, errors: [`Code normalization failed: ${e.message}`] };
  }

  let compiled;
  try {
    compiled = new vm.Script(scriptCode, { filename: 'strategy.js' });
  } catch (err) {
    return { ok: false, errors: [`Syntax error: ${err.message}`] };
  }

  // Sandbox context: allowlist only. No require, no globals from the host.
  // AM48b: import the technicalindicators module directly (globalThis lookup is
  // undefined in Node ESM) and spread it so bare EMA/SMA/ATR/RSI references work.
  const sandbox = {
    Math,
    JSON,
    technicalindicators,
    ...technicalindicators, // unpack EMA, SMA, ATR, ... for bare references
    console: { log: () => {}, error: () => {}, warn: () => {} }
  };
  const context = vm.createContext(sandbox);

  let runRef;
  try {
    compiled.runInContext(context, { timeout: 1000 });
    runRef = sandbox.run;
  } catch (err) {
    return { ok: false, errors: [`Execution during compile failed: ${err.message}`] };
  }

  if (typeof runRef !== 'function') {
    return { ok: false, errors: ["Strategy must define a 'run' function (e.g. `export async function run(macroCandles, triggerCandles, parameters)`)."] };
  }

  return { ok: true, runRef };
}

/**
 * Execute a compiled strategy run reference with a per-call timeout.
 * @param {Function} runRef
 * @param {Array} macroCandles
 * @param {Array} triggerCandles
 * @param {Object} parameters
 * @param {number} timeoutMs
 * @returns {Promise<{signal: string|null, telemetry?: Object}>}
 * @throws on timeout or strategy error
 */
export async function execStrategy(runRef, macroCandles, triggerCandles, parameters, timeoutMs = 1000) {
  const result = await Promise.race([
    Promise.resolve(runRef(macroCandles, triggerCandles, parameters)),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Strategy execution timed out after ${timeoutMs}ms`)), timeoutMs)
    )
  ]);

  if (!result || typeof result !== 'object') {
    throw new Error('Strategy run() returned no result object.');
  }

  return {
    signal: result.signal ?? null,
    telemetry: result.telemetry || {}
  };
}
