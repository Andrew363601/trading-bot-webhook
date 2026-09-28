// lib/clamp-message.js
// 🟢 PUSH AM55 — pure clamp-message builder.
//
// WHY: both clamp blocks in lib/execute-trade-mcp.js reassigned slPrice/orderQty
// BEFORE building the "clamped from X to Y" string, so the alert always printed
// X→X (e.g. "from $2680.18 to $2680.18" for a clamp that actually moved
// $2668.47 → $2680.18). This helper takes the ORIGINALS explicitly so the
// message is always truthful. Pure (no I/O) so it is unit-testable directly.

/**
 * Build the human-readable clamp detail strings for the Risk Adjustment alert.
 *
 * @param {Object} p
 * @param {number|string} p.originalSl  SL price BEFORE clamping
 * @param {number|string} p.originalQty qty BEFORE clamping
 * @param {number|null} p.clampedSl     clamped SL (null when not clamped)
 * @param {number|null} p.clampedQty    clamped qty (null when not clamped)
 * @returns {string[]} e.g. ["SL clamped from $2668.47 to $2680.18"]
 */
export function buildClampDetails({ originalSl, originalQty, clampedSl, clampedQty }) {
  const details = [];
  if (clampedSl !== null && clampedSl !== undefined) {
    details.push(`SL clamped from $${originalSl} to $${clampedSl}`);
  }
  if (clampedQty !== null && clampedQty !== undefined) {
    details.push(`Qty clamped from ${originalQty} to ${clampedQty}`);
  }
  return details;
}

export default { buildClampDetails };
