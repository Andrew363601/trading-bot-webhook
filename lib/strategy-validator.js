// lib/strategy-validator.js
import vm from 'node:vm';

/**
 * Validates strategy code safety and structure without execution.
 * 1. Syntax check: compiles via node:vm new vm.Script(code, { filename: 'strategy.js' }) inside try/catch.
 * 2. Shape check: asserts the source defines a `run` function taking 3 parameters (macroCandles, triggerCandles, parameters).
 *
 * @param {string} code - The raw JavaScript code of the strategy.
 * @returns {{ ok: boolean, errors?: string[] }}
 */
export function validateStrategyCode(code) {
  const errors = [];

  if (typeof code !== 'string' || !code.trim()) {
    return { ok: false, errors: ['Strategy code is empty or not a string.'] };
  }

  // 1. Syntax check via vm.Script compile (NEVER execute)
  try {
    // Wrap as module / script. To tolerate ES module syntax (import/export),
    // we can strip or mock imports/exports if compiling via vm.Script, or test compile.
    // In node vm.Script, 'import' and 'export' tokens cause SyntaxError: Cannot use import statement outside a module.
    // We normalize export/import statements for syntax checking if needed.
    let scriptCode = code;
    // Replace import statements with harmless declarations for syntax test
    scriptCode = scriptCode.replace(/^\s*import\s+[^;]+;?/gm, '// [import stripped for syntax check]');
    // Replace export statements (export async function, export function, export const, export default)
    scriptCode = scriptCode.replace(/^\s*export\s+(default\s+)?/gm, '');

    new vm.Script(scriptCode, { filename: 'strategy.js' });
  } catch (err) {
    errors.push(`Syntax error: ${err.message}`);
  }

  // 2. Shape check: assert run function takes 3 parameters
  // Patterns supported:
  // - async function run(macroCandles, triggerCandles, parameters)
  // - function run(a, b, c)
  // - export async function run(...)
  // - const run = async (a, b, c) => ...
  // - const run = (a, b, c) => ...
  // - let run = ... / var run = ...
  const runPattern = /(?:(?:export\s+)?(?:async\s+)?function\s+run\s*\(([^)]*)\)|(?:const|let|var)\s+run\s*=\s*(?:async\s*)?(?:\(([^)]*)\)|([a-zA-Z0-9_$]+))\s*=>)/;
  const match = code.match(runPattern);

  if (!match) {
    errors.push("Missing required entrypoint: strategy must define a 'run' function (e.g. `export async function run(macroCandles, triggerCandles, parameters)`).");
  } else {
    const rawParams = (match[1] !== undefined ? match[1] : match[2] !== undefined ? match[2] : match[3] || '').trim();
    const params = rawParams.length > 0 ? rawParams.split(',').map(p => p.trim()).filter(Boolean) : [];
    if (params.length < 3) {
      errors.push(`Invalid 'run' signature: expected 3 parameters (macroCandles, triggerCandles, parameters), but detected ${params.length} parameter(s).`);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true };
}
