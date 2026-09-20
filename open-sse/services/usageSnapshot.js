/**
 * In-memory usage snapshot cache.
 *
 * The quota-weighted scheduler needs each account's live allowance list, but the only
 * places that already pay for those upstream usage calls are GET /api/usage/[connectionId]
 * (the dashboard polls it) and the auto-ping tick. Rather than adding yet another poller
 * with its own rate-limit budget, the usage handler PUBLISHES its result here and the
 * scheduler reads it back — zero extra upstream traffic.
 *
 * Best-effort and process-local by design, exactly like the antigravity quota cache: a
 * miss just means the scorer falls back to the static snapshot on the connection
 * (see resolveAccountQuota in sse/services/auth.js).
 */

/**
 * Snapshots older than this are ignored. A stale balance is worse than no balance: it
 * would keep steering traffic at an account that has already been drained, and the
 * upstream 429 path would have to clean up after it.
 */
export const USAGE_SNAPSHOT_MAX_AGE_MS = 60 * 60 * 1000;

/** Hard cap so a very large install cannot grow this map without bound. */
const MAX_ENTRIES = 5000;

const snapshots = new Map(); // connectionId -> { provider, quotas, capturedAtMs }

function pruneIfNeeded() {
  if (snapshots.size <= MAX_ENTRIES) return;
  // Map preserves insertion order, so the oldest keys are the first ones out.
  const excess = snapshots.size - MAX_ENTRIES;
  let removed = 0;
  for (const key of snapshots.keys()) {
    snapshots.delete(key);
    if (++removed >= excess) break;
  }
}

/**
 * Publish a successful usage result.
 *
 * @param {string} connectionId
 * @param {string|null} provider
 * @param {object|null} quotas  Provider quota map: `{ [rowName]: row }`.
 */
export function setUsageSnapshot(connectionId, provider, quotas) {
  if (!connectionId) return;
  if (!quotas || typeof quotas !== "object") return;
  if (Object.keys(quotas).length === 0) return;

  snapshots.delete(connectionId);
  snapshots.set(connectionId, {
    provider: provider || null,
    quotas,
    capturedAtMs: Date.now(),
  });
  pruneIfNeeded();
}

/**
 * Read a snapshot, or null when it is missing/too old.
 * @param {string} connectionId
 * @param {number} [now]
 */
export function getUsageSnapshot(connectionId, now = Date.now()) {
  if (!connectionId) return null;
  const entry = snapshots.get(connectionId);
  if (!entry) return null;
  if (now - entry.capturedAtMs > USAGE_SNAPSHOT_MAX_AGE_MS) {
    snapshots.delete(connectionId);
    return null;
  }
  return entry;
}

export function clearUsageSnapshot(connectionId) {
  if (!connectionId) return;
  snapshots.delete(connectionId);
}

export function clearAllUsageSnapshots() {
  snapshots.clear();
}

/** Diagnostics: age and package count per connection, without leaking balances. */
export function snapshotUsageCache(now = Date.now()) {
  const byConnection = {};
  for (const [id, entry] of snapshots) {
    byConnection[id] = {
      provider: entry.provider,
      ageMs: now - entry.capturedAtMs,
      rows: Object.keys(entry.quotas).length,
    };
  }
  return { connections: snapshots.size, byConnection };
}
