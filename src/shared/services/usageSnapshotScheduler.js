// Usage snapshot warm-up scheduler.
//
// Keeps the quota-weighted scheduler's allowance cache populated without requiring
// anybody to open the usage page. See USAGE_SNAPSHOT_CONFIG for the throttling rules and
// open-sse/services/usageSnapshot.js for the cache itself.
import "open-sse/index.js";

import { getSettings, getProviderConnections } from "@/lib/localDb";
import { getUsageForProvider } from "open-sse/services/usage.js";
import { setUsageSnapshot } from "open-sse/services/usageSnapshot.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { refreshAndUpdateCredentials } from "@/app/api/usage/[connectionId]/route.js";
import { USAGE_APIKEY_PROVIDERS } from "@/shared/constants/providers";
import { USAGE_SNAPSHOT_CONFIG } from "@/shared/constants/config";

const C = USAGE_SNAPSHOT_CONFIG;

// Survive Next.js hot reload and keep one scheduler per server process.
const g = (global.__usageSnapshotWarmup ??= {
  interval: null,
  running: false,
  lastAttemptAt: {}, // connectionId -> ms
  failureUntil: {},  // connectionId -> ms
});

/**
 * Whether the usage endpoint can be read for this connection.
 *
 * Mirrors the gate in GET /api/usage/[connectionId]: OAuth connections are always
 * eligible, API-key connections only for providers whose key is accepted by their usage
 * API. Keeping the two in sync matters — this loop must never poke an endpoint the
 * dashboard itself refuses to call.
 */
export function isUsageEligible(connection) {
  if (!connection?.provider || connection.isActive === false) return false;
  const authType = connection.authType;
  if (authType === "oauth") return true;
  if (authType === "apikey" || authType === "api_key") {
    return USAGE_APIKEY_PROVIDERS.includes(connection.provider);
  }
  return false;
}

function buildProxyOptions(cfg) {
  return {
    connectionProxyEnabled: cfg.connectionProxyEnabled === true,
    connectionProxyUrl: cfg.connectionProxyUrl || "",
    connectionNoProxy: cfg.connectionNoProxy || "",
    vercelRelayUrl: cfg.vercelRelayUrl || "",
    strictProxy: false,
  };
}

/**
 * Read one account's allowance list. Returns the provider quota map, or null when the
 * call produced nothing usable (error message, empty quotas, unsupported provider).
 */
async function fetchAllowances(conn, deps) {
  const proxyCfg = await deps.resolveConnectionProxyConfig(conn.providerSpecificData || {});
  const proxyOptions = buildProxyOptions(proxyCfg);

  let connection = conn;
  if (conn.authType === "oauth") {
    // Reuse the app's own refresh path so an expiring token is renewed exactly the way a
    // dashboard request would renew it. Not forced: refreshAndUpdateCredentials decides
    // from the stored expiry, so an account with a healthy token costs no extra call.
    const refreshed = await deps.refreshAndUpdateCredentials(connection, false, proxyOptions);
    connection = refreshed?.connection || connection;
  }

  const usage = await deps.getUsageForProvider(connection, proxyOptions);
  const quotas = usage?.quotas;
  if (!quotas || typeof quotas !== "object" || Object.keys(quotas).length === 0) return null;
  return quotas;
}

/**
 * One warm-up pass. Exported for tests, which inject `deps`/`state`.
 *
 * Accounts are visited least-recently-attempted first, so a large install covers every
 * account within perConnectionMinIntervalMs rather than re-reading the same head of the
 * list every tick.
 */
export async function runUsageSnapshotTick(deps = createDefaultDeps(), state = g) {
  if (state.running) return { skipped: "in-flight" };
  state.running = true;

  try {
    const settings = await deps.getSettings();
    if (settings?.usageSnapshotWarmupEnabled === false) return { skipped: "disabled" };

    const connections = await deps.getProviderConnections({ isActive: true });
    const eligible = connections.filter(isUsageEligible);

    const now = Date.now();
    const due = eligible
      .filter((conn) => {
        if ((state.failureUntil[conn.id] || 0) > now) return false;
        return now - (state.lastAttemptAt[conn.id] || 0) >= C.perConnectionMinIntervalMs;
      })
      .sort((a, b) => (state.lastAttemptAt[a.id] || 0) - (state.lastAttemptAt[b.id] || 0));

    const batch = due.slice(0, C.perTickLimit);
    let published = 0;
    let failed = 0;

    for (const conn of batch) {
      // Record the attempt up front: a provider that throws or returns nothing must not
      // be retried on the very next tick.
      state.lastAttemptAt[conn.id] = Date.now();
      try {
        const quotas = await fetchAllowances(conn, deps);
        if (quotas) {
          deps.setUsageSnapshot(conn.id, conn.provider, quotas);
          delete state.failureUntil[conn.id];
          published += 1;
        } else {
          state.failureUntil[conn.id] = Date.now() + C.failureCooldownMs;
          failed += 1;
        }
      } catch (e) {
        state.failureUntil[conn.id] = Date.now() + C.failureCooldownMs;
        failed += 1;
        if (failed === 1) console.warn(`[UsageWarmup] ${conn.provider}:${conn.id}: ${e.message}`);
      }
    }

    // Quiet when healthy: only failures are worth a line, and they are batched so a
    // broken provider cannot flood the log once per tick.
    if (failed > 0) {
      console.warn(`[UsageWarmup] ${published} updated, ${failed} unavailable of ${batch.length} attempted (${eligible.length} eligible)`);
    }

    return { eligible: eligible.length, due: due.length, attempted: batch.length, published, failed };
  } catch (e) {
    console.warn("[UsageWarmup] tick error:", e.message);
    return { error: e.message };
  } finally {
    state.running = false;
  }
}

function createDefaultDeps() {
  return {
    getSettings,
    getProviderConnections,
    resolveConnectionProxyConfig,
    refreshAndUpdateCredentials,
    getUsageForProvider,
    setUsageSnapshot,
  };
}

export function startUsageSnapshotWarmup() {
  if (g.interval) return;
  console.log("[UsageWarmup] scheduler started");
  runUsageSnapshotTick().catch(() => {});
  g.interval = setInterval(() => { runUsageSnapshotTick().catch(() => {}); }, C.tickIntervalMs);
  if (g.interval.unref) g.interval.unref();
}

export function stopUsageSnapshotWarmup() {
  if (!g.interval) return;
  clearInterval(g.interval);
  g.interval = null;
  console.log("[UsageWarmup] scheduler stopped");
}

/** Apply the settings flag: keeps the timer absent entirely when warm-up is off. */
export function configureUsageSnapshotWarmup(settings) {
  if (settings?.usageSnapshotWarmupEnabled === false) stopUsageSnapshotWarmup();
  else startUsageSnapshotWarmup();
}

/** Test helper. */
export function resetUsageSnapshotWarmupState() {
  g.lastAttemptAt = {};
  g.failureUntil = {};
  g.running = false;
}
