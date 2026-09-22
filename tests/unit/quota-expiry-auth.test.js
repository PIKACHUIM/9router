import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getSettings: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getSettings: mocks.getSettings,
  getProxyPools: vi.fn(),
  validateApiKey: vi.fn(),
  updateProviderConnection: vi.fn(),
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
  pickProxyPoolId: vi.fn(),
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  resolveProviderId: (provider) => provider,
}));
vi.mock("@/sse/services/antigravityQuota.js", () => ({ getAntigravityQuotaCache: () => new Map() }));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

import { getProviderCredentials, releaseAccountSlot } from "@/sse/services/auth.js";
import { recordConsumption, resetOptimistic } from "open-sse/services/quotaScheduler.js";
import { setUsageSnapshot, clearAllUsageSnapshots } from "open-sse/services/usageSnapshot.js";
import { acquire, getLoad, resetLoad } from "open-sse/services/accountLoad.js";
import { bindSession, getBoundConnection, getSessionCount, resetBindings, stopSessionBindingSweeper } from "open-sse/services/sessionBindings.js";

const PROVIDER = "codebuddy-cn";
const DAY = 86400000;
let settings;
let accounts;

function publish(id, packages) {
  setUsageSnapshot(id, PROVIDER, Object.fromEntries(packages.map((p, i) => [
    `pack-${i}`, {
      total: p.total ?? p.remaining,
      used: (p.total ?? p.remaining) - p.remaining,
      resetAt: new Date(Date.now() + p.days * DAY).toISOString(),
      recurring: false,
    },
  ])));
}

function select(options = {}, excluded = null) {
  return getProviderCredentials(PROVIDER, excluded, "model", options);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-22T00:00:00Z"));
  vi.clearAllMocks();
  resetOptimistic();
  resetLoad();
  resetBindings();
  clearAllUsageSnapshots();
  settings = { schedulingMode: "quota-weighted", quotaPreferEarlierExpiry: true, sessionBindingEnabled: true };
  accounts = [
    { id: "later", priority: 1, isActive: true },
    { id: "soon", priority: 99, isActive: true },
  ];
  mocks.getSettings.mockImplementation(async () => settings);
  mocks.getProviderConnections.mockImplementation(async () => accounts);
  mocks.resolveConnectionProxyConfig.mockResolvedValue({});
  publish("later", [{ remaining: 100000, days: 15 }]);
  publish("soon", [{ remaining: 1, days: 1 }, { remaining: 100, days: 30 }]);
});

afterEach(() => {
  stopSessionBindingSweeper();
  resetBindings();
  resetLoad();
  resetOptimistic();
  clearAllUsageSnapshots();
  vi.useRealTimers();
});

describe("expiry-first credential selection", () => {
  it("chooses the earliest package regardless of priority and balance weights", async () => {
    Object.assign(settings, { quotaWeightRemaining: 10, quotaWeightExpiry: 0, quotaFairShareWeight: 10 });
    recordConsumption("soon", 1000);
    await expect(select()).resolves.toMatchObject({ connectionId: "soon" });
  });

  it("moves a bound conversation to an account with an earlier package", async () => {
    bindSession(PROVIDER, "conversation", "later");
    await expect(select({ sessionId: "conversation" })).resolves.toMatchObject({ connectionId: "soon" });
    expect(getBoundConnection(PROVIDER, "conversation")).toBe("soon");
    expect(getSessionCount("later")).toBe(0);
  });

  it("switches to another account after the current early package is reported exhausted", async () => {
    await expect(select({ sessionId: "conversation" })).resolves.toMatchObject({ connectionId: "soon" });
    publish("soon", [{ remaining: 0, total: 1, days: 1 }, { remaining: 100, days: 30 }]);
    await expect(select({ sessionId: "conversation" })).resolves.toMatchObject({ connectionId: "later" });
    expect(getBoundConnection(PROVIDER, "conversation")).toBe("later");
  });

  it("preserves affinity when the earliest deadlines are equal", async () => {
    publish("later", [{ remaining: 100000, days: 1 }]);
    bindSession(PROVIDER, "conversation", "soon");
    recordConsumption("soon", 1000);
    await expect(select({ sessionId: "conversation" })).resolves.toMatchObject({ connectionId: "soon" });
  });

  it("preserves affinity when no account has a known expiring allowance", async () => {
    clearAllUsageSnapshots();
    bindSession(PROVIDER, "conversation", "later");
    await expect(select({ sessionId: "conversation" })).resolves.toMatchObject({ connectionId: "later" });
  });

  it("does not treat optimistic request counts as actual exhaustion of a fractional package", async () => {
    publish("soon", [{ remaining: 0.1, days: 1 }]);
    recordConsumption("soon", 1000);
    await expect(select()).resolves.toMatchObject({ connectionId: "soon" });
    await expect(select()).resolves.toMatchObject({ connectionId: "soon" });
  });

  it("follows deadline order on concurrency fallback rather than reverting to priority order", async () => {
    accounts.push({ id: "middle", priority: 100, isActive: true });
    publish("middle", [{ remaining: 10, days: 2 }]);
    settings.maxConcurrentPerAccount = 1;
    bindSession(PROVIDER, "conversation", "later");
    acquire("soon", 1);
    const credentials = await select({ sessionId: "conversation", reserveSlot: true });
    expect(credentials.connectionId).toBe("middle");
    expect(getLoad("soon")).toBe(1);
    expect(getLoad("middle")).toBe(1);
    expect(getLoad("later")).toBe(0);
    releaseAccountSlot(credentials);
    expect(getLoad("middle")).toBe(0);
  });

  it("still skips excluded and model-locked accounts", async () => {
    await expect(select({}, new Set(["soon"]))).resolves.toMatchObject({ connectionId: "later" });
    accounts[1].modelLock_model = new Date(Date.now() + DAY).toISOString();
    await expect(select()).resolves.toMatchObject({ connectionId: "later" });
  });

  it("does not move a conversation into another account that is at its session cap", async () => {
    settings.maxSessionsPerAccount = 1;
    settings.sessionOverflowPolicy = "hard";
    bindSession(PROVIDER, "other", "soon");
    bindSession(PROVIDER, "conversation", "later");
    await expect(select({ sessionId: "conversation" })).resolves.toMatchObject({ connectionId: "later" });
    expect(getSessionCount("soon")).toBe(1);
  });

  it("allows reuse of an early bound account at its cap", async () => {
    settings.maxSessionsPerAccount = 1;
    settings.sessionOverflowPolicy = "hard";
    bindSession(PROVIDER, "conversation", "soon");
    await expect(select({ sessionId: "conversation" })).resolves.toMatchObject({ connectionId: "soon" });
  });

  it("refuses a new session when every account is at its hard cap", async () => {
    settings.maxSessionsPerAccount = 1;
    settings.sessionOverflowPolicy = "hard";
    bindSession(PROVIDER, "one", "soon");
    bindSession(PROVIDER, "two", "later");
    await expect(select({ sessionId: "new" })).resolves.toMatchObject({ sessionCapacityExceeded: true });
  });

  it("honours an explicit connection choice", async () => {
    bindSession(PROVIDER, "conversation", "soon");
    await expect(select({ sessionId: "conversation", preferredConnectionId: "later" }))
      .resolves.toMatchObject({ connectionId: "later" });
  });

  it("retains legacy affinity when earliest-expiry preference is disabled", async () => {
    settings.quotaPreferEarlierExpiry = false;
    bindSession(PROVIDER, "conversation", "later");
    await expect(select({ sessionId: "conversation" })).resolves.toMatchObject({ connectionId: "later" });
  });

  it("honours provider-specific expiry preference overrides", async () => {
    settings.providerStrategies = { [PROVIDER]: { quotaPreferEarlierExpiry: false } };
    bindSession(PROVIDER, "conversation", "later");
    await expect(select({ sessionId: "conversation" })).resolves.toMatchObject({ connectionId: "later" });
    settings.providerStrategies[PROVIDER].quotaPreferEarlierExpiry = true;
    await expect(select({ sessionId: "conversation" })).resolves.toMatchObject({ connectionId: "soon" });
  });

  it("does not change fill-first scheduling unless quota scheduling is enabled", async () => {
    settings.schedulingMode = "fill-first";
    settings.fallbackStrategy = "fill-first";
    await expect(select()).resolves.toMatchObject({ connectionId: "later" });
    settings.providerStrategies = { [PROVIDER]: { schedulingMode: "quota-weighted" } };
    await expect(select()).resolves.toMatchObject({ connectionId: "soon" });
  });
});
