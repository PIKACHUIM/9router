/**
 * Account Load Registry — per-account in-flight request accounting.
 *
 * Purpose: when several concurrent client requests are routed to the SAME upstream
 * account (a very likely outcome right after switching fill-first → session binding),
 * the account can be saturated and start returning 429s. This module tracks how many
 * requests are currently in flight per connection so the selector can:
 *
 *   - skip an account that is already at its per-account concurrency ceiling;
 *   - prefer the least-loaded account when several are equally valid;
 *   - report load so the caller can log / expose it.
 *
 * The registry is in-process and intentionally tiny: a Map<connectionId, count>.
 * It is NOT authoritative across processes — a multi-process deployment should move
 * this to a shared store later. `acquire`/`release` are pure synchronous Map ops so
 * that they can be called INSIDE the selection mutex without introducing awaits
 * (an await inside the mutex would reopen the TOCTOU window we are closing).
 */

const load = new Map(); // connectionId -> { count, lastAcquiredAt }

/** Default ceiling when the caller does not specify one (0 / null = unlimited). */
export const DEFAULT_MAX_CONCURRENT_PER_ACCOUNT = 0;

/**
 * Atomically reserve one in-flight slot on `connectionId`.
 *
 * @param {string} connectionId
 * @param {number} max - ceiling to enforce; <= 0 means unlimited
 * @returns {{ ok: boolean, count: number, max: number }}
 *          ok=false when the account is already at the ceiling (caller must pick
 *          another account); count is the load BEFORE this acquire on failure and
 *          AFTER it on success.
 */
export function acquire(connectionId, max = DEFAULT_MAX_CONCURRENT_PER_ACCOUNT) {
  if (!connectionId || connectionId === "noauth") {
    // Virtual / stateless accounts have no meaningful ceiling.
    return { ok: true, count: 0, max: 0 };
  }
  const entry = load.get(connectionId) || { count: 0, lastAcquiredAt: 0 };
  const ceiling = Number(max) > 0 ? Number(max) : 0;
  if (ceiling > 0 && entry.count >= ceiling) {
    load.set(connectionId, entry);
    return { ok: false, count: entry.count, max: ceiling };
  }
  entry.count += 1;
  entry.lastAcquiredAt = Date.now();
  load.set(connectionId, entry);
  return { ok: true, count: entry.count, max: ceiling };
}

/**
 * Release a previously acquired slot. Idempotent by contract only when balanced;
 * the counter is clamped at 0 so an accidental double release cannot drive it
 * negative and permanently blacklist an account.
 */
export function release(connectionId) {
  if (!connectionId || connectionId === "noauth") return 0;
  const entry = load.get(connectionId);
  if (!entry) return 0;
  entry.count = Math.max(0, entry.count - 1);
  if (entry.count === 0) {
    // Drop empty entries so the Map does not grow without bound.
    load.delete(connectionId);
    return 0;
  }
  load.set(connectionId, entry);
  return entry.count;
}

/** Current in-flight count for a connection (0 when unknown). */
export function getLoad(connectionId) {
  if (!connectionId) return 0;
  return load.get(connectionId)?.count || 0;
}

/** Snapshot of all non-zero loads (for logging / diagnostics). */
export function snapshotLoad() {
  const out = {};
  for (const [id, entry] of load) out[id] = entry.count;
  return out;
}

/** Clear all accounting (test helper / explicit reset). */
export function resetLoad() {
  load.clear();
}

/**
 * Release slots for a connection that is being frozen / removed, and return how
 * many were dropped. Used by the session-binding layer so that moving a binding
 * away from an account cannot leave a permanent phantom load behind.
 */
export function drainLoad(connectionId) {
  const entry = load.get(connectionId);
  if (!entry) return 0;
  load.delete(connectionId);
  return entry.count;
}
