// lib/phase3-mode.js
// In-memory phase 3 mode prompt state (per tenant + asset)

let store = new Map();

function _key(tenantId, asset) {
  return `${tenantId}::${asset}`;
}

export function setPendingMode(tenantId, asset, mode) {
  store.set(_key(tenantId, asset), { mode, when: Date.now() });
}
export function consumePendingMode(tenantId, asset) {
  const k = _key(tenantId, asset);
  const v = store.get(k);
  if (!v) return null;
  store.delete(k);
  return v.mode;
}
export function isPendingMode(tenantId, asset) {
  return store.has(_key(tenantId, asset));
}
export function clearPendingMode(tenantId, asset) {
  store.delete(_key(tenantId, asset));
}
