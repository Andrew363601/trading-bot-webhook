// lib/worker-registry.js
// PUSH AM35 — burst containment primitives.
//
// 1) Interval/stop-hook registry: workers record their setInterval handles here
//    so the tenant manager can TEARDOWN (not just halt) workers for tenants
//    that fail the billing check on each 60s sync. A lapsed trial must not
//    keep a janitor + sniper alive until process restart.
//
// 2) getInstanceHash(): stable per-instance identifier for first-sweep
//    staggering (instanceHash % 30s) so multiple instances booting at once
//    don't stampede the same exchange endpoints (ETIMEDOUT burst containment).

import crypto from 'crypto';

const timers = new Map();   // key => Set<timeout/interval id>
const stopHooks = new Map(); // key => Set<fn> (e.g. close WebSocket)

let _instanceHash = null;

/**
 * Stable per-instance hash (0..255). Uses RENDER_INSTANCE_ID / HOSTNAME /
 * machine id when available; falls back to a per-process random value.
 */
export function getInstanceHash() {
    if (_instanceHash === null) {
        const seed = process.env.RENDER_INSTANCE_ID
            || process.env.HOSTNAME
            || process.env.COMPUTERNAME
            || crypto.randomUUID();
        _instanceHash = crypto.createHash('md5').update(String(seed)).digest()[0];
    }
    return _instanceHash;
}

/** Staggered first-run delay in ms: 0..29999, stable per instance. */
export function firstSweepDelayMs() {
    return getInstanceHash() % 30 * 1000;
}

export function registerTimer(key, id) {
    if (!timers.has(key)) timers.set(key, new Set());
    timers.get(key).add(id);
}

export function registerStopHook(key, fn) {
    if (!stopHooks.has(key)) stopHooks.set(key, new Set());
    stopHooks.get(key).add(fn);
}

/**
 * Clears all timers + runs stop hooks registered under key.
 * Returns true if anything was torn down.
 */
export function stopWorkerTimers(key) {
    let stopped = false;
    const ids = timers.get(key);
    if (ids) {
        for (const id of ids) { clearTimeout(id); clearInterval(id); stopped = true; }
        timers.delete(key);
    }
    const hooks = stopHooks.get(key);
    if (hooks) {
        for (const fn of hooks) { try { fn(); } catch (e) { console.error(`[WORKER-REG] stop hook failed for ${key}:`, e.message); } stopped = true; }
        stopHooks.delete(key);
    }
    return stopped;
}