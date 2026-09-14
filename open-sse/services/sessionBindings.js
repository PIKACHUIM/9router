/**
 * Session → Account binding store.
 *
 * Goal: keep a single client conversation (session id) pinned to one upstream
 * account so that (a) the provider-side prompt cache stays warm, which is the
 * whole reason to prefer session binding over naive round-robin, and (b) several
 * concurrent client requests from DIFFERENT sessions spread across accounts
 * instead of all stampeding the same one.
 *
 * This is intentionally an in-process Map with a TTL sweep. It does NOT need to be
 * durable: a lost binding at process restart merely costs one cache miss. Keeping it
 * in memory avoids per-request DB writes on the hot path.
 *
 * Invariants:
 *   - One session id maps to at most one connectionId per provider.
 *   - A connection has at most `maxSessionsPerAccount` sessions (soft or hard cap).
 *   - Idle sessions are released so an account can serve new sessions.
 *   - When a binding's account becomes unavailable, the binding is moved (not left
 *     dangling) AND its load slot is drained so no phantom concurrency remains.
 */

import { drainLoad, getLoad } from "./accountLoad.js";

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_SWEEP_MS = 5 * 60 * 1000;

// sessionKey (providerId + "\u0000" + sessionId) -> { connectionId, providerId, sessionId, lastSeenAt, createdAt }
const bindings = new Map();
// connectionId -> Set<sessionKey>
const byConnection = new Map();

let lastSeenMap = new WeakMap(); // reserved for future use
void lastSeenMap;

let sweepTimer = null;
let sweepTtlMs = DEFAULT_TTL_MS;

function sessionKey(providerId, sessionId) {
  return `${providerId}\u0000${sessionId}`;
}

function touch(entry) {
  entry.lastSeenAt = Date.now();
}

/**
 * Look up the account currently bound to a session.
 * @returns {string|null} connectionId
 */
export function getBoundConnection(providerId, sessionId) {
  if (!providerId || !sessionId) return null;
  const key = sessionKey(providerId, sessionId);
  const entry = bindings.get(key);
  if (!entry) return null;
  touch(entry);
  return entry.connectionId;
}

/**
 * How many sessions are currently bound to a connection.
 */
export function getSessionCount(connectionId) {
  return byConnection.get(connectionId)?.size || 0;
}

/**
 * Bind a session to a connection, replacing any previous binding.
 * If the session was previously bound elsewhere, the old connection's session set
 * is cleaned up. If the old connection now has zero sessions AND zero in-flight
 * load, its load slot is drained to avoid a phantom.
 *
 * @returns {{ connectionId: string, moved: boolean, previousConnectionId: string|null }}
 */
export function bindSession(providerId, sessionId, connectionId) {
  if (!providerId || !sessionId || !connectionId) {
    return { connectionId: connectionId || null, moved: false, previousConnectionId: null };
  }
  const key = sessionKey(providerId, sessionId);
  const existing = bindings.get(key);
  const previousConnectionId = existing?.connectionId || null;

  if (previousConnectionId && previousConnectionId !== connectionId) {
    const set = byConnection.get(previousConnectionId);
    if (set) {
      set.delete(key);
      if (set.size === 0) {
        byConnection.delete(previousConnectionId);
        // No sessions left on the old account: drop any leftover load accounting
        // so a later acquire() is not blocked by a stale count.
        if (getLoad(previousConnectionId) === 0) drainLoad(previousConnectionId);
      }
    }
  }

  const now = Date.now();
  bindings.set(key, {
    connectionId,
    providerId,
    sessionId,
    lastSeenAt: now,
    createdAt: existing?.createdAt || now,
  });

  let set = byConnection.get(connectionId);
  if (!set) {
    set = new Set();
    byConnection.set(connectionId, set);
  }
  set.add(key);

  return { connectionId, moved: !!previousConnectionId && previousConnectionId !== connectionId, previousConnectionId };
}

/**
 * Remove a session binding explicitly (e.g. its account got locked and the caller
 * cannot find a replacement right now).
 */
export function unbindSession(providerId, sessionId) {
  if (!providerId || !sessionId) return false;
  const key = sessionKey(providerId, sessionId);
  const entry = bindings.get(key);
  if (!entry) return false;
  bindings.delete(key);
  const set = byConnection.get(entry.connectionId);
  if (set) {
    set.delete(key);
    if (set.size === 0) byConnection.delete(entry.connectionId);
  }
  return true;
}

/**
 * Release every binding pointing at a connection (used when an account is frozen
 * or deleted). Returns the affected session keys so callers can re-route them.
 */
export function releaseConnectionBindings(connectionId) {
  const set = byConnection.get(connectionId);
  if (!set) return [];
  const released = [...set];
  for (const key of released) bindings.delete(key);
  byConnection.delete(connectionId);
  drainLoad(connectionId);
  return released;
}

/** Sweep bindings idle for longer than ttlMs. Returns count evicted. */
export function sweepIdleBindings(ttlMs = sweepTtlMs) {
  const now = Date.now();
  let evicted = 0;
  for (const [key, entry] of bindings) {
    if (now - entry.lastSeenAt > ttlMs) {
      bindings.delete(key);
      const set = byConnection.get(entry.connectionId);
      if (set) {
        set.delete(key);
        if (set.size === 0) byConnection.delete(entry.connectionId);
      }
      evicted += 1;
    }
  }
  return evicted;
}

/** Start the periodic idle sweep (idempotent). */
export function startSessionBindingSweeper(ttlMs = DEFAULT_TTL_MS, intervalMs = DEFAULT_SWEEP_MS) {
  sweepTtlMs = ttlMs > 0 ? ttlMs : DEFAULT_TTL_MS;
  if (sweepTimer) return;
  const every = intervalMs > 0 ? intervalMs : DEFAULT_SWEEP_MS;
  sweepTimer = setInterval(() => {
    try {
      sweepIdleBindings();
    } catch {
      /* never let the sweeper crash the process */
    }
  }, every);
  if (typeof sweepTimer.unref === "function") sweepTimer.unref();
}

export function stopSessionBindingSweeper() {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

/** Diagnostics snapshot. */
export function snapshotBindings() {
  const byConn = {};
  for (const [cid, set] of byConnection) byConn[cid] = set.size;
  return { totalSessions: bindings.size, connections: Object.keys(byConn).length, byConnection: byConn };
}

/** Test helper. */
export function resetBindings() {
  bindings.clear();
  byConnection.clear();
}
