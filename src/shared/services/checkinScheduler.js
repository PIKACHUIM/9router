// Daily check-in scheduler: automatically signs in supported providers once per day
// when the user enables it per-account in the UI (settings[settingsKey].connections[connId]).
import "open-sse/index.js";

import { getSettings, getProviderConnections, updateProviderConnection } from "@/lib/localDb";
import { checkinCodebuddyAccount } from "open-sse/services/checkin/codebuddy-cn.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { refreshAndUpdateCredentials } from "@/app/api/usage/[connectionId]/route.js";
import { CHECKIN_CONFIG } from "@/shared/constants/config";

const C = CHECKIN_CONFIG;

// Survive Next.js hot reload and keep one scheduler per server process.
const g = (global.__checkinScheduler ??= {
  interval: null,
  running: false,
  lastDailyKey: {},   // connId -> "YYYY-MM-DD" already checked in this process
  failureCache: {},   // connId -> timestamp of last failure
});

function todayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function shouldSkipAfterFailure(state, key, nowMs = Date.now()) {
  const failedAt = state.failureCache[key];
  return failedAt && nowMs - failedAt < C.failureCooldownMs;
}

function isInCheckWindow(now = new Date()) {
  return now.getHours() >= (C.checkWindowStartHour ?? 0);
}

async function checkinConnection(conn, providerConfig, deps, state = g) {
  const key = conn.id;

  // Already successfully handled today in this process — nothing to do.
  if (state.lastDailyKey[key] === todayKey()) return;

  if (shouldSkipAfterFailure(state, key)) return;

  let proxyOptions = null;
  try {
    const proxyCfg = await deps.resolveConnectionProxyConfig(conn.providerSpecificData);
    proxyOptions = {
      connectionProxyEnabled: proxyCfg.connectionProxyEnabled === true,
      connectionProxyUrl: proxyCfg.connectionProxyUrl || "",
      connectionNoProxy: proxyCfg.connectionNoProxy || "",
      vercelRelayUrl: proxyCfg.vercelRelayUrl || "",
      strictProxy: false,
    };
  } catch (e) {
    console.warn(`[Checkin] ${providerConfig.provider}:${conn.id}: proxy resolve failed: ${e.message}`);
  }

  const refreshFn = async (c) => {
    const { connection: updated } = await deps.refreshAndUpdateCredentials(c, true, proxyOptions);
    return updated;
  };

  let result;
  try {
    result = await deps.checkinCodebuddyAccount(conn, { refreshFn, proxyOptions });
  } catch (e) {
    state.failureCache[key] = Date.now();
    console.warn(`[Checkin] ${providerConfig.provider}:${conn.id}: ${e.message}`);
    return;
  }

  if (result.status === "ok" || result.status === "already") {
    delete state.failureCache[key];
    state.lastDailyKey[key] = todayKey();
    await deps.updateProviderConnection(conn.id, {
      lastCheckinAt: new Date().toISOString(),
      lastCheckinStatus: result.status,
      lastCheckinStreak: result.streak_days ?? null,
      updatedAt: new Date().toISOString(),
    });
    console.log(`[Checkin] ${providerConfig.provider}:${conn.id}: ${result.status} (${result.message || ""})`);
  } else if (result.status === "skip") {
    // Nothing actionably wrong; do not cooldown but do not retry within this tick either.
    console.log(`[Checkin] ${providerConfig.provider}:${conn.id}: skip (${result.message || ""})`);
  } else {
    state.failureCache[key] = Date.now();
    console.warn(`[Checkin] ${providerConfig.provider}:${conn.id}: ${result.status} (${result.message || ""})`);
  }
}

function createDefaultDeps() {
  return {
    getSettings,
    getProviderConnections,
    updateProviderConnection,
    resolveConnectionProxyConfig,
    refreshAndUpdateCredentials,
    checkinCodebuddyAccount,
  };
}

export async function runCheckinTick(deps = createDefaultDeps(), state = g) {
  if (state.running) return;
  state.running = true;
  try {
    if (!isInCheckWindow()) return;

    const settings = await deps.getSettings();

    for (const [provider, providerConfig] of Object.entries(C.providers)) {
      const enabledMap = settings?.[providerConfig.settingsKey]?.connections || {};
      if (Object.keys(enabledMap).length === 0) continue;

      const conns = await deps.getProviderConnections({ provider, isActive: true });
      const targets = conns.filter((conn) => enabledMap[conn.id] === true);

      for (const conn of targets) {
        try {
          await checkinConnection(conn, { ...providerConfig, provider }, deps, state);
        } catch (e) {
          state.failureCache[conn.id] = Date.now();
          console.warn(`[Checkin] ${provider}:${conn.id}: ${e.message}`);
        }
      }
    }
  } catch (e) {
    console.warn("[Checkin] tick error:", e.message);
  } finally {
    state.running = false;
  }
}

export function startCheckinScheduler() {
  if (g.interval) return;
  console.log("[Checkin] scheduler started");
  runCheckinTick().catch(() => {});
  g.interval = setInterval(() => { runCheckinTick().catch(() => {}); }, C.tickIntervalMs);
  if (g.interval.unref) g.interval.unref();
}

export function stopCheckinScheduler() {
  if (!g.interval) return;
  clearInterval(g.interval);
  g.interval = null;
  console.log("[Checkin] scheduler stopped");
}

export function configureCheckinScheduler(settings) {
  const enabled = Object.values(C.providers).some((providerConfig) =>
    Object.values(settings?.[providerConfig.settingsKey]?.connections || {}).some(Boolean)
  );
  if (enabled) startCheckinScheduler();
  else stopCheckinScheduler();
}
