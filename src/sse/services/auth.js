import { getProviderConnections, validateApiKey, updateProviderConnection, getSettings, getProxyPools } from "@/lib/localDb";
import { resolveConnectionProxyConfig, pickProxyPoolId } from "@/lib/network/connectionProxy";
import { formatRetryAfter, checkFallbackError, isModelLockActive, buildModelLockUpdate, getEarliestModelLockUntil } from "open-sse/services/accountFallback.js";
import { MAX_RATE_LIMIT_COOLDOWN_MS } from "open-sse/config/errorConfig.js";
import { resolveProviderId, FREE_PROVIDERS } from "@/shared/constants/providers.js";
import { getAntigravityQuotaCache } from "./antigravityQuota.js";
import { acquire as acquireAccountSlot, release as releaseAccountSlotInternal, DEFAULT_MAX_CONCURRENT_PER_ACCOUNT } from "open-sse/services/accountLoad.js";
import { getBoundConnection, bindSession, getSessionCount, startSessionBindingSweeper } from "open-sse/services/sessionBindings.js";
import { pickQuotaWeighted, withOptimisticDiscount, recordConsumption } from "open-sse/services/quotaScheduler.js";
import * as log from "../utils/logger.js";

// Mutex to prevent race conditions during account selection.
//
// Sharded per-provider: a single global mutex serialised selection across ALL
// providers, so a slow provider (DNS/DB round-trips inside the section) blocked
// unrelated providers. One promise chain per provider keeps ordering guarantees
// where they matter (same-provider lastUsedAt / use-count updates) without the
// cross-provider head-of-line blocking (audit item #8).
const selectionMutexes = new Map(); // providerId -> Promise

function acquireSelectionMutex(providerId) {
  const key = providerId || "__global__";
  const current = selectionMutexes.get(key) || Promise.resolve();
  let release;
  const next = new Promise((resolve) => { release = resolve; });
  selectionMutexes.set(key, next);
  return { current, release };
}

let sessionSweeperStarted = false;
function ensureSessionSweeper(settings) {
  if (sessionSweeperStarted) return;
  sessionSweeperStarted = true;
  startSessionBindingSweeper(
    settings?.sessionIdleTtlMs || 30 * 60 * 1000,
    settings?.sessionBindingSweepIntervalMs || 5 * 60 * 1000
  );
}

/**
 * Resolve a comparable quota descriptor for an account, for quota-weighted
 * scheduling. Sources, in order:
 *   1. Antigravity live quota cache (per-model remaining percentage + resetAt)
 *   2. providerSpecificData.quota snapshot ({"remaining","total","resetAt"})
 * Returns null when nothing is known — the scheduler then scores it neutral.
 */
function resolveAccountQuota(connection, providerId, model) {
  if (providerId === "antigravity" && model) {
    const cache = getAntigravityQuotaCache();
    const q = cache?.get(connection.id)?.[model];
    if (q) {
      const resetAtMs = q.resetAt ? new Date(q.resetAt).getTime() : NaN;
      return {
        remaining: Number.isFinite(q.remainingPercentage) ? q.remainingPercentage : NaN,
        total: 100,
        resetAtMs,
      };
    }
  }
  const snap = connection.providerSpecificData?.quota;
  if (snap && typeof snap === "object") {
    const resetAtMs = snap.resetAt ? new Date(snap.resetAt).getTime() : NaN;
    const remaining = Number(snap.remaining);
    if (Number.isFinite(remaining)) {
      return { remaining, total: Number(snap.total) || null, resetAtMs };
    }
  }
  return null;
}

const GITHUB_MONTHLY_USAGE_LIMIT = "you've reached your additional usage limit for your plan";

function githubMonthlyResetMs(status, errorText, provider) {
  if (resolveProviderId(provider) !== "github" || Number(status) !== 402) return null;
  if (!String(errorText || "").toLowerCase().includes(GITHUB_MONTHLY_USAGE_LIMIT)) return null;
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
}

/**
 * Get provider credentials from localDb
 * Filters out unavailable accounts and returns the selected account based on strategy
 * @param {string} provider - Provider name
 * @param {Set<string>|string|null} excludeConnectionIds - Connection ID(s) to exclude (for retry with next account)
 * @param {string|null} model - Model name for per-model rate limit filtering
 */
export async function getProviderCredentials(provider, excludeConnectionIds = null, model = null, options = {}) {
  // Normalize to Set for consistent handling
  const excludeSet = excludeConnectionIds instanceof Set
    ? excludeConnectionIds
    : (excludeConnectionIds ? new Set([excludeConnectionIds]) : new Set());
  const preferredConnectionId = options?.preferredConnectionId || null;
  // Optional session identity for affinity binding. `sessionId` must be a stable
  // per-conversation id (see open-sse/utils/sessionManager.js resolveSessionIdentity).
  const sessionId = options?.sessionId || null;
  // Whether the caller wants a concurrency slot reserved for this selection.
  // Retries / internal fan-out may pass reserveSlot=false to avoid double-counting.
  const reserveSlot = options?.reserveSlot !== false;
  // Resolve alias to provider ID (e.g., "kc" -> "kilocode") BEFORE taking the lock
  // so the shard key is stable regardless of alias spelling.
  const providerId = resolveProviderId(provider);
  // Acquire per-provider mutex to prevent race conditions within one provider
  const { current: currentMutex, release: resolveMutex } = acquireSelectionMutex(providerId);

  try {
    await currentMutex;

    // Inject a virtual connection for no-auth free providers (with optional proxy pool from settings)
    if (FREE_PROVIDERS[providerId]?.noAuth) {
      const settings = await getSettings();
      const override = (settings.providerStrategies || {})[providerId] || {};
      const strategy = override.rotateStrategy || "none";
      let pickedId = override.proxyPoolId || null;
      if (strategy !== "none") {
        const allPools = await getProxyPools({ isActive: true });
        const poolIds = allPools.filter(p => p.proxyUrl).map(p => p.id);
        pickedId = pickProxyPoolId(poolIds, strategy, providerId);
      }
      const resolvedProxy = await resolveConnectionProxyConfig({ proxyPoolId: pickedId || "" });
      return {
        id: "noauth",
        connectionName: "Public",
        isActive: true,
        accessToken: "public",
        providerSpecificData: {
          connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
          connectionProxyUrl: resolvedProxy.connectionProxyUrl,
          connectionNoProxy: resolvedProxy.connectionNoProxy,
          connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
          vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
        },
      };
    }

    const connections = await getProviderConnections({ provider: providerId, isActive: true });
    log.debug("AUTH", `${provider} | total connections: ${connections.length}, excludeIds: ${excludeSet.size > 0 ? [...excludeSet].join(",") : "none"}, model: ${model || "any"}`);

    if (connections.length === 0) {
      log.warn("AUTH", `No credentials for ${provider}`);
      return null;
    }

    // Antigravity quota cache is lazy: only populated after that account returns 409/429.
    const isAntigravity = providerId === "antigravity";
    const antigravityQuotaCache = isAntigravity && model ? getAntigravityQuotaCache() : null;

    // Filter out model-locked, excluded, and Antigravity quota-exhausted connections.
    const availableConnections = connections.filter(c => {
      if (excludeSet.has(c.id)) return false;
      if (isModelLockActive(c, model)) return false;
      // Antigravity: skip if live quota exhausted for this model
      if (isAntigravity && model && antigravityQuotaCache) {
        const quota = antigravityQuotaCache.get(c.id)?.[model];
        if (quota && quota.remainingPercentage <= 0 && quota.resetAt && new Date(quota.resetAt).getTime() > Date.now()) {
          const account = c.id?.slice(0, 8) || "unknown";
          log.info("AG_QUOTA", `${account} | CACHE_BLOCK ${model} — skip upstream until ${quota.resetAt}`);
          return false;
        }
      }
      return true;
    });

    log.debug("AUTH", `${provider} | available: ${availableConnections.length}/${connections.length}`);
    connections.forEach(c => {
      const excluded = excludeSet.has(c.id);
      const locked = isModelLockActive(c, model);
      if (excluded || locked) {
        const lockUntil = getEarliestModelLockUntil(c);
        log.debug("AUTH", `  → ${c.id?.slice(0, 8)} | ${excluded ? "excluded" : ""} ${locked ? `modelLocked(${model}) until ${lockUntil}` : ""}`);
      }
    });

    if (availableConnections.length === 0) {
      // Find earliest persistent lock or lazy Antigravity quota-cache reset for retry timing.
      const lockedConns = connections.filter(c => isModelLockActive(c, model));
      const expiries = lockedConns.map(c => getEarliestModelLockUntil(c)).filter(Boolean);
      if (isAntigravity && model && antigravityQuotaCache) {
        connections.forEach((c) => {
          const resetAt = antigravityQuotaCache.get(c.id)?.[model]?.resetAt;
          if (resetAt && new Date(resetAt).getTime() > Date.now()) expiries.push(resetAt);
        });
      }
      const earliest = expiries.sort()[0] || null;
      if (earliest) {
        const earliestConn = lockedConns[0];
        log.warn("AUTH", `${provider} | all ${connections.length} accounts locked for ${model || "all"} (${formatRetryAfter(earliest)}) | lastError=${earliestConn?.lastError?.slice(0, 50)}`);
        return {
          allRateLimited: true,
          retryAfter: earliest,
          retryAfterHuman: formatRetryAfter(earliest),
          lastError: earliestConn?.lastError || null,
          lastErrorCode: earliestConn?.errorCode || null
        };
      }
      log.warn("AUTH", `${provider} | all ${connections.length} accounts unavailable`);
      return null;
    }

    const settings = await getSettings();
    ensureSessionSweeper(settings);
    // Per-provider strategy overrides global setting
    const providerOverride = (settings.providerStrategies || {})[providerId] || {};
    // New scheduling mode wins over the legacy fallbackStrategy when explicitly set
    // to something other than the legacy values.
    const legacyStrategy = providerOverride.fallbackStrategy || settings.fallbackStrategy || "fill-first";
    const schedulingMode = providerOverride.schedulingMode
      || settings.schedulingMode
      || legacyStrategy;
    const strategy = schedulingMode === "quota-weighted" ? "quota-weighted" : legacyStrategy;

    // ---- Concurrency gate + session affinity candidate pruning ----
    const sessionBindingEnabled = providerOverride.sessionBindingEnabled ?? settings.sessionBindingEnabled ?? true;
    const maxSessions = providerOverride.maxSessionsPerAccount ?? settings.maxSessionsPerAccount ?? 0;
    const overflowPolicy = providerOverride.sessionOverflowPolicy || settings.sessionOverflowPolicy || "soft";
    const maxConcurrent = providerOverride.maxConcurrentPerAccount
      ?? settings.maxConcurrentPerAccount
      ?? DEFAULT_MAX_CONCURRENT_PER_ACCOUNT;

    let candidates = availableConnections;
    let boundConnectionId = null;

    if (sessionBindingEnabled && sessionId) {
      boundConnectionId = getBoundConnection(providerId, sessionId);
      if (boundConnectionId) {
        const bound = candidates.find((c) => c.id === boundConnectionId);
        if (bound) {
          // HARD preference: a live session stays on its account — this is what
          // preserves the provider-side prompt cache.
          candidates = [bound];
          log.debug("AUTH", `${provider} | session ${String(sessionId).slice(0, 8)} → bound ${boundConnectionId.slice(0, 8)}`);
        } else {
          // Bound account became unavailable/excluded → drop the stale binding and
          // re-select. bindSession() later will move the session.
          log.info("AUTH", `${provider} | session ${String(sessionId).slice(0, 8)} bound account ${boundConnectionId.slice(0, 8)} unavailable → rebind`);
        }
      }
    }

    let connection;
    // Pin to preferred connection if specified and available.
    // Precedence (audit item #10): an explicit hard pin (preferredConnectionId) is a
    // caller instruction and outranks session affinity; session binding only applies
    // when no hard pin was requested.
    if (preferredConnectionId) {
      connection = candidates.find((c) => c.id === preferredConnectionId)
        || availableConnections.find((c) => c.id === preferredConnectionId);
      if (connection) {
        log.info("AUTH", `${provider} | pinned to ${connection.id?.slice(0, 8)} (${connection.name || connection.email || "unnamed"})`);
      }
    }

    if (!connection && strategy === "quota-weighted") {
      const { connection: picked, detail } = pickQuotaWeighted(candidates, {
        // Apply the short-lived optimistic discount so concurrent selectors within
        // the decay window do not all converge on the same "best" account against a
        // stale snapshot (audit item #6, snapshot lag stampede).
        getQuota: withOptimisticDiscount((c) => resolveAccountQuota(c, providerId, model)),
        weightRemaining: providerOverride.quotaWeightRemaining ?? settings.quotaWeightRemaining ?? 1.0,
        weightExpiry: providerOverride.quotaWeightExpiry ?? settings.quotaWeightExpiry ?? 0.5,
        preferEarlierExpiry: providerOverride.quotaPreferEarlierExpiry ?? settings.quotaPreferEarlierExpiry ?? true,
      });
      connection = picked;
      if (connection && detail) {
        log.debug("AUTH", `${provider} | quota-weighted pick ${connection.id?.slice(0, 8)} score=${detail.score.toFixed(3)} remaining=${detail.remaining ?? "n/a"} msToExpiry=${detail.msUntilExpiry ?? "n/a"}`);
      }
    }

    if (connection) {
      // skip strategy (pinned or quota-weighted already chose)
    } else if (strategy === "round-robin") {
      const stickyLimit = providerOverride.stickyRoundRobinLimit || settings.stickyRoundRobinLimit || 3;

      // Sort by lastUsed (most recent first) to find current candidate
      const byRecency = [...candidates].sort((a, b) => {
        if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
        if (!a.lastUsedAt) return 1;
        if (!b.lastUsedAt) return -1;
        return new Date(b.lastUsedAt) - new Date(a.lastUsedAt);
      });

      const current = byRecency[0];
      const currentCount = current?.consecutiveUseCount || 0;

      if (current && current.lastUsedAt && currentCount < stickyLimit) {
        // Stay with current account
        connection = current;
        // Update lastUsedAt and increment count (await to ensure persistence)
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: (connection.consecutiveUseCount || 0) + 1
        });
      } else {
        // Pick the least recently used (excluding current if possible)
        const sortedByOldest = [...candidates].sort((a, b) => {
          if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
          if (!a.lastUsedAt) return -1;
          if (!b.lastUsedAt) return 1;
          return new Date(a.lastUsedAt) - new Date(b.lastUsedAt);
        });

        connection = sortedByOldest[0];

        // Update lastUsedAt and reset count to 1 (await to ensure persistence)
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: 1
        });
      }
    } else {
      // Default: fill-first (already sorted by priority in getProviderConnections).
      // Respect the per-account session cap so one account does not absorb every
      // session; fall through to the next candidate when it is at capacity.
      if (sessionBindingEnabled && sessionId && maxSessions > 0) {
        const underCap = candidates.find((c) => getSessionCount(c.id) < maxSessions);
        if (underCap) {
          connection = underCap;
        } else if (overflowPolicy === "hard") {
          connection = null;
        } else {
          // soft: allow overflow onto the least-loaded account, but warn.
          const leastLoaded = [...candidates].sort((a, b) => getSessionCount(a.id) - getSessionCount(b.id))[0];
          connection = leastLoaded || candidates[0];
          if (connection) {
            log.warn("AUTH", `${provider} | all ${candidates.length} accounts at session cap ${maxSessions} (soft overflow) → ${connection.id?.slice(0, 8)} now holds ${getSessionCount(connection.id) + 1}`);
          }
        }
      } else {
        connection = candidates[0];
      }
    }

    // ---- HARD failure: no account could satisfy the (hard-cap) constraints ----
    if (!connection) {
      log.warn("AUTH", `${provider} | no account within session/overflow constraints (mode=${strategy}, cap=${maxSessions}, policy=${overflowPolicy})`);
      return {
        allRateLimited: true,
        retryAfter: null,
        retryAfterHuman: "session capacity",
        lastError: `all accounts at maxSessionsPerAccount=${maxSessions}`,
        lastErrorCode: "SESSION_CAPACITY",
        sessionCapacityExceeded: true,
      };
    }

    // ---- Concurrency gate (audit items #2 & #7) ----
    // Reserved INSIDE the per-provider mutex via a SYNCHRONOUS acquire so two
    // concurrent selectors cannot both observe "count < max" and both succeed
    // (the original TOCTOU). If the chosen account is full, walk to the next
    // candidate that still has a free slot.
    let slotAcquired = false;
    if (reserveSlot && connection.id && connection.id !== "noauth") {
      let gate = acquireAccountSlot(connection.id, maxConcurrent);
      if (!gate.ok) {
        log.debug("AUTH", `${provider} | ${connection.id.slice(0, 8)} at concurrency ceiling ${maxConcurrent} → try next candidate`);
        const alt = candidates
          .filter((c) => c.id !== connection.id)
          .map((c) => ({ c, ok: acquireAccountSlot(c.id, maxConcurrent) }))
          .find((x) => x.ok);
        if (alt) {
          connection = alt.c;
          gate = alt.ok;
          slotAcquired = true;
        } else {
          // Every candidate is saturated right now: this is a concurrency
          // contention condition, NOT quota exhaustion. Surface it as retryable
          // so the caller can back off briefly instead of locking accounts.
          log.warn("AUTH", `${provider} | all ${candidates.length} accounts at concurrency ceiling ${maxConcurrent}`);
          return {
            allRateLimited: true,
            retryAfter: null,
            retryAfterHuman: "concurrency",
            lastError: `all accounts at maxConcurrentPerAccount=${maxConcurrent}`,
            lastErrorCode: "CONCURRENCY_LIMITED",
            concurrencyLimited: true,
          };
        }
      } else {
        slotAcquired = true;
      }
    }

    // Optimistic consumption: discount this account's apparent remaining quota for
    // the next few seconds so a concurrent burst spreads instead of converging.
    if (connection.id && connection.id !== "noauth") {
      recordConsumption(connection.id, 1);
    }

    // ---- Record / refresh the session binding ----
    // Only when the caller actually got a slot (or the account is virtual) so a
    // failed selection never creates a binding that was never used.
    if (sessionBindingEnabled && sessionId && connection.id && connection.id !== "noauth" && (slotAcquired || !reserveSlot)) {
      const { moved } = bindSession(providerId, sessionId, connection.id);
      if (moved) {
        log.info("AUTH", `${provider} | session ${String(sessionId).slice(0, 8)} rebound → ${connection.id.slice(0, 8)}`);
      }
    }

    const resolvedProxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});

    return {
      authType: connection.authType,
      apiKey: connection.apiKey,
      accessToken: connection.accessToken,
      refreshToken: connection.refreshToken,
      idToken: connection.idToken,
      expiresAt: connection.expiresAt,
      expiresIn: connection.expiresIn,
      lastRefreshAt: connection.lastRefreshAt,
      projectId: connection.projectId,
      connectionName: connection.displayName || connection.name || connection.email || connection.id,
      copilotToken: connection.providerSpecificData?.copilotToken,
      providerSpecificData: {
        ...(connection.providerSpecificData || {}),
        connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
        connectionProxyUrl: resolvedProxy.connectionProxyUrl,
        connectionNoProxy: resolvedProxy.connectionNoProxy,
        connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
        vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
      },
      connectionId: connection.id,
      // Include current status for optimization check
      testStatus: connection.testStatus,
      lastError: connection.lastError,
      // True when this selection reserved an in-flight concurrency slot that the
      // caller MUST release (in a finally block) via releaseAccountSlot().
      slotReserved: slotAcquired,
      // Pass full connection for clearAccountError to read modelLock_* keys
      _connection: connection
    };
  } finally {
    if (resolveMutex) resolveMutex();
  }
}

/**
 * Mark account+model as unavailable — locks modelLock_${model} in DB.
 * All errors (429, 401, 5xx, etc.) lock per model, not per account.
 * @param {string} connectionId
 * @param {number} status - HTTP status code from upstream
 * @param {string} errorText
 * @param {string|null} provider
 * @param {string|null} model - The specific model that triggered the error
 * @returns {{ shouldFallback: boolean, cooldownMs: number }}
 */
export async function markAccountUnavailable(connectionId, status, errorText, provider = null, model = null, resetsAtMs = null) {
  if (!connectionId || connectionId === "noauth") return { shouldFallback: false, cooldownMs: 0 };
  const connections = await getProviderConnections({ provider });
  const conn = connections.find(c => c.id === connectionId);
  const backoffLevel = conn?.backoffLevel || 0;

  // GitHub premium-request exhaustion is account-wide until the next UTC month.
  const githubResetAtMs = githubMonthlyResetMs(status, errorText, provider);

  // Provider-specific precise cooldown (e.g. codex usage_limit_reached resets_at) overrides backoff
  let shouldFallback, cooldownMs, newBackoffLevel;
  if (githubResetAtMs) {
    shouldFallback = true;
    cooldownMs = githubResetAtMs - Date.now();
    newBackoffLevel = 0;
  } else if (resetsAtMs && resetsAtMs > Date.now()) {
    shouldFallback = true;
    // Antigravity quota API provides exact per-model resetAt. Do not truncate it.
    cooldownMs = resolveProviderId(provider) === "antigravity"
      ? resetsAtMs - Date.now()
      : Math.min(resetsAtMs - Date.now(), MAX_RATE_LIMIT_COOLDOWN_MS);
    newBackoffLevel = 0;
  } else {
    const verdict = checkFallbackError(status, errorText, backoffLevel);
    ({ shouldFallback, cooldownMs, newBackoffLevel } = verdict);
    // A 429 classified as concurrency contention must NOT lock the account; the
    // caller retries the same account after a short delay instead.
    if (verdict.concurrencyLimited) return { shouldFallback: false, cooldownMs: 0, concurrencyLimited: true };
  }
  if (!shouldFallback) return { shouldFallback: false, cooldownMs: 0 };

  const reason = typeof errorText === "string" ? errorText.slice(0, 100) : "Provider error";
  const lockUpdate = buildModelLockUpdate(githubResetAtMs ? null : model, cooldownMs);

  await updateProviderConnection(connectionId, {
    ...lockUpdate,
    testStatus: "unavailable",
    lastError: reason,
    errorCode: status,
    lastErrorAt: new Date().toISOString(),
    backoffLevel: newBackoffLevel ?? backoffLevel
  });

  const lockKey = Object.keys(lockUpdate)[0];
  const connName = conn?.displayName || conn?.name || conn?.email || connectionId.slice(0, 8);
  log.warn("AUTH", `${connName} locked ${lockKey} for ${Math.round(cooldownMs / 1000)}s [${status}]`);

  if (provider && status && reason) {
    console.error(`❌ ${provider} [${status}]: ${reason}`);
  }

  return { shouldFallback: true, cooldownMs };
}

/**
 * Clear account error status on successful request.
 * - Clears modelLock_${model} (the model that just succeeded)
 * - Lazy-cleans any other expired modelLock_* keys
 * - Resets error state only if no active locks remain
 * @param {string} connectionId
 * @param {object} currentConnection - credentials object (has _connection) or raw connection
 * @param {string|null} model - model that succeeded
 */
export async function clearAccountError(connectionId, currentConnection, model = null) {
  if (!connectionId || connectionId === "noauth") return;
  const conn = currentConnection._connection || currentConnection;
  const now = Date.now();
  const allLockKeys = Object.keys(conn).filter(k => k.startsWith("modelLock_"));

  if (!conn.testStatus && !conn.lastError && allLockKeys.length === 0) return;

  // Keys to clear: current model's lock + all expired locks
  const keysToClear = allLockKeys.filter(k => {
    if (model && k === `modelLock_${model}`) return true; // succeeded model
    if (model && k === "modelLock___all") return true;    // account-level lock
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() <= now;   // expired
  });

  if (keysToClear.length === 0 && conn.testStatus !== "unavailable" && !conn.lastError) return;

  // Check if any active locks remain after clearing
  const remainingActiveLocks = allLockKeys.filter(k => {
    if (keysToClear.includes(k)) return false;
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() > now;
  });

  const clearObj = Object.fromEntries(keysToClear.map(k => [k, null]));

  // Only reset error state if no active locks remain
  if (remainingActiveLocks.length === 0) {
    Object.assign(clearObj, {
      testStatus: "active",
      lastError: null,
      errorCode: null,
      lastErrorAt: null,
      backoffLevel: 0
    });
  }

  await updateProviderConnection(connectionId, clearObj);
}

/**
 * Release an account concurrency slot previously reserved by getProviderCredentials.
 * Safe to call unconditionally: it is a no-op when the credentials never reserved a
 * slot, and the underlying counter clamps at 0 (idempotent on double release).
 * @param {object|null} credentials - the object returned by getProviderCredentials
 */
export function releaseAccountSlot(credentials) {
  if (!credentials || !credentials.slotReserved) return;
  const connectionId = credentials.connectionId || credentials.id;
  if (!connectionId || connectionId === "noauth") return;
  releaseAccountSlotInternal(connectionId);
  credentials.slotReserved = false;
}

/**
 * Extract API key from request headers
 */
export function extractApiKey(request) {
  // Check Authorization header first
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  // Check Anthropic x-api-key header
  const xApiKey = request.headers.get("x-api-key");
  if (xApiKey) {
    return xApiKey;
  }

  return null;
}

/**
 * Validate API key (optional - for local use can skip)
 */
export async function isValidApiKey(apiKey) {
  if (!apiKey) return false;
  return await validateApiKey(apiKey);
}
