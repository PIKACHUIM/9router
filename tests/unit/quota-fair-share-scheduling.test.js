import { beforeEach, describe, expect, it } from "vitest";
import {
  scoreAccounts,
  recordConsumption,
  releaseConsumption,
  resetOptimistic,
  getFairShareServed,
} from "../../open-sse/services/quotaScheduler.js";
import {
  packagesFromQuotas,
  pickActivePackage,
  normalizeQuota,
  aggregatePackages,
  summarizePackages,
} from "../../open-sse/services/quotaPackages.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Build the descriptor the auth layer produces for a multi-package account. */
function accountQuota(packages) {
  return aggregatePackages(packages.map((p) => ({
    name: p.name ?? null,
    remaining: p.remaining,
    total: p.total ?? p.remaining,
    resetAtMs: p.resetAtMs,
    recurring: p.recurring !== false,
  })));
}

// ---------------------------------------------------------------------------
// Package extraction
// ---------------------------------------------------------------------------

describe("packagesFromQuotas", () => {
  it("keeps every CodeBuddy package with its own deadline and recurring flag", () => {
    const now = 1_000_000_000_000;
    const packages = packagesFromQuotas({
      Monthly: { used: 6.54, total: 500, resetAt: new Date(now + 5 * DAY).toISOString(), recurring: true },
      "Bonus Pack 1": { used: 10, total: 200, resetAt: new Date(now + 30 * DAY).toISOString(), recurring: false },
      "Bonus Pack 2": { used: 0, total: 300, resetAt: new Date(now + 45 * DAY).toISOString(), recurring: false },
    });

    expect(packages).toHaveLength(3);
    expect(packages[0]).toMatchObject({ name: "Monthly", total: 500, recurring: true });
    expect(packages[0].remaining).toBeCloseTo(493.46, 2);
    expect(packages[1]).toMatchObject({ name: "Bonus Pack 1", remaining: 190, recurring: false });
    expect(packages[2]).toMatchObject({ name: "Bonus Pack 2", remaining: 300, recurring: false });
  });

  it("drops unlimited sentinels and empty placeholder rows", () => {
    const packages = packagesFromQuotas({
      session: { unlimited: true, used: 0, total: 0 },
      placeholder: { used: 0, total: 0 },
    });
    expect(packages).toEqual([]);
  });

  it("prefers per-model antigravity buckets over the double-counting weekly overlay", () => {
    const packages = packagesFromQuotas({
      "gemini-3.8-flash-high": { used: 100, total: 1000, resetAt: "2026-09-20T10:00:00.000Z" },
      gemini_weekly: { used: 500, total: 1000, resetAt: "2026-09-27T10:00:00.000Z" },
    });

    expect(packages).toHaveLength(1);
    expect(packages[0].name).toBe("gemini-3.8-flash-high");
  });

  it("falls back to the weekly pool when an account only has weekly buckets", () => {
    const packages = packagesFromQuotas({
      gemini_weekly: { used: 250, total: 1000, resetAt: "2026-09-27T10:00:00.000Z" },
      claude_gpt_weekly: { used: 0, total: 1000, resetAt: "2026-09-27T10:00:00.000Z" },
    });

    expect(packages.map((p) => p.name)).toEqual(["gemini_weekly", "claude_gpt_weekly"]);
  });
});

describe("pickActivePackage", () => {
  const now = 1_000_000_000_000;

  it("returns the soonest deadline that still has a balance", () => {
    const quota = normalizeQuota(accountQuota([
      { name: "later", remaining: 900, resetAtMs: now + 30 * DAY, recurring: false },
      { name: "sooner", remaining: 100, resetAtMs: now + DAY, recurring: false },
    ]));

    expect(pickActivePackage(quota, now).name).toBe("sooner");
  });

  it("ignores exhausted packages and deadlines already in the past", () => {
    const quota = normalizeQuota(accountQuota([
      { name: "empty", remaining: 0, resetAtMs: now + HOUR },
      { name: "stale", remaining: 500, resetAtMs: now - HOUR },
      { name: "live", remaining: 10, resetAtMs: now + 2 * DAY },
    ]));

    expect(pickActivePackage(quota, now).name).toBe("live");
  });

  it("breaks a deadline tie in favour of the one-shot pack", () => {
    const deadline = now + DAY;
    const quota = normalizeQuota(accountQuota([
      { name: "refill", remaining: 100, resetAtMs: deadline, recurring: true },
      { name: "bonus", remaining: 100, resetAtMs: deadline, recurring: false },
    ]));

    expect(pickActivePackage(quota, now).name).toBe("bonus");
  });

  it("degrades to the legacy single-snapshot descriptor", () => {
    const quota = normalizeQuota({ remaining: 42, total: 100, resetAtMs: now + HOUR });
    expect(pickActivePackage(quota, now)).toMatchObject({ remaining: 42, resetAtMs: now + HOUR });
  });

  it("reports the aggregate of every package for the remaining axis", () => {
    const quota = normalizeQuota(accountQuota([
      { name: "a", remaining: 120, resetAtMs: now + 3 * DAY },
      { name: "b", remaining: 80, resetAtMs: now + 9 * DAY },
    ]));

    expect(quota.remaining).toBe(200);
    expect(quota.resetAtMs).toBe(now + 3 * DAY);
    expect(quota.packages).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Spreading: the behaviour that replaces "drain whichever account expires first"
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Totals shown by the provider page
// ---------------------------------------------------------------------------

describe("summarizePackages", () => {
  const now = 1_000_000_000_000;

  it("sums every package an account holds", () => {
    const list = packagesFromQuotas({
      Monthly: { used: 6.54, total: 500, resetAt: new Date(now + DAY).toISOString() },
      "Bonus Pack 1": { used: 10, total: 200, resetAt: new Date(now + 2 * DAY).toISOString() },
      "Bonus Pack 2": { used: 0, total: 300, resetAt: new Date(now + 3 * DAY).toISOString() },
    });

    const sums = summarizePackages(list);
    expect(sums.count).toBe(3);
    expect(sums.total).toBe(1000);
    expect(sums.used).toBeCloseTo(16.54, 2);
    expect(sums.available).toBeCloseTo(983.46, 2);
  });

  it("counts a total-less package in available only, never inventing a total", () => {
    expect(summarizePackages([{ remaining: 42, total: null }]))
      .toEqual({ total: 0, used: 0, available: 42, count: 1 });
  });

  it("returns zeros for no packages", () => {
    expect(summarizePackages([])).toEqual({ total: 0, used: 0, available: 0, count: 0 });
    expect(summarizePackages(undefined)).toEqual({ total: 0, used: 0, available: 0, count: 0 });
  });

  it("clamps a spent package instead of going negative", () => {
    expect(summarizePackages([{ remaining: 0, total: 100 }]))
      .toEqual({ total: 100, used: 100, available: 0, count: 1 });
  });
});

/**
 * Run `count` sequential selections, recording each pick the way auth.js does: score,
 * take the head, then consume. The ordered ranking is what auth.js hands to the
 * concurrency gate, so the simulation reads it the same way.
 */
function simulate(accounts, count, opts = {}) {
  const picks = new Map(accounts.map((a) => [a.id, 0]));
  for (let i = 0; i < count; i += 1) {
    const ranked = scoreAccounts(accounts, { getQuota: (c) => c.quota, ...opts });
    const best = ranked[0];
    if (!best) break;
    picks.set(best.connection.id, picks.get(best.connection.id) + 1);
    recordConsumption(best.connection.id, 1);
  }
  return picks;
}

describe("quota-weighted earliest-package ordering", () => {
  beforeEach(() => resetOptimistic());

  it("re-ranks after an early package is consumed instead of draining the account", () => {
    const now = Date.now();
    const accounts = [
      { id: "a", quota: accountQuota([
        { name: "a-first", remaining: 1, resetAtMs: now + DAY },
        { name: "a-later", remaining: 10000, resetAtMs: now + 15 * DAY },
      ]) },
      { id: "b", quota: accountQuota([{ name: "b-first", remaining: 100, resetAtMs: now + 2 * DAY }]) },
    ];
    const rank = () => scoreAccounts(accounts, { getQuota: (c) => c.quota, now: () => now });
    expect(rank()[0].connection.id).toBe("a");
    accounts[0].quota.packages[0].remaining = 0;
    recordConsumption("a");
    expect(rank()[0].connection.id).toBe("b");
    expect(rank().find((r) => r.connection.id === "a").detail.activePackage).toBe("a-later");
  });

  it("does not let weights, past service or load override even a one-millisecond earlier deadline", () => {
    const now = Date.now();
    const accounts = [
      { id: "later", quota: accountQuota([{ remaining: 1000000, resetAtMs: now + DAY + 1 }]) },
      { id: "earlier", quota: accountQuota([{ remaining: 0.01, resetAtMs: now + DAY }]) },
    ];
    recordConsumption("earlier", 10000);
    const ranked = scoreAccounts(accounts, {
      getQuota: (c) => c.quota,
      weightRemaining: 10,
      weightExpiry: 0,
      weightFairShare: 10,
      getLoad: (id) => id === "earlier" ? 10 : 0,
    });
    expect(ranked[0].connection.id).toBe("earlier");
  });

  it("ranks by weighted score when earliest-expiry preference is disabled", () => {
    const now = Date.now();
    const accounts = [
      { id: "later", quota: accountQuota([{ remaining: 10000, resetAtMs: now + 15 * DAY }]) },
      { id: "earlier", quota: accountQuota([{ remaining: 1, resetAtMs: now + DAY }]) },
    ];
    const ranked = scoreAccounts(accounts, {
      getQuota: (c) => c.quota, preferEarlierExpiry: false, weightFairShare: 0,
    });
    expect(ranked[0].connection.id).toBe("later");
  });

  it("ignores empty, expired and undated packages when comparing deadlines", () => {
    const now = Date.now();
    const accounts = [
      { id: "stale", quota: accountQuota([
        { name: "expired", remaining: 1000000, resetAtMs: now - 1 },
        { name: "empty", remaining: 0, resetAtMs: now + HOUR },
        { name: "undated", remaining: 1000000, resetAtMs: NaN },
        { name: "later", remaining: 1000000, resetAtMs: now + 15 * DAY },
      ]) },
      { id: "live", quota: accountQuota([{ remaining: 1, resetAtMs: now + DAY }]) },
      { id: "unknown", quota: null },
    ];
    const ranked = scoreAccounts(accounts, { getQuota: (c) => c.quota, now: () => now });
    expect(ranked.map((r) => r.connection.id)).toEqual(["live", "stale", "unknown"]);
    expect(ranked[1].detail.activePackage).toBe("later");
  });

  it("does not truncate a soon-expiring package after the first forty rows", () => {
    const now = Date.now();
    const rows = Object.fromEntries(Array.from({ length: 45 }, (_, i) => [
      `pack-${i}`, { remaining: 100, resetAt: new Date(now + (i === 44 ? 1 : 15) * DAY).toISOString() },
    ]));
    const packages = packagesFromQuotas(rows);
    expect(packages).toHaveLength(45);
    expect(pickActivePackage(aggregatePackages(packages), now).name).toBe("pack-44");
  });

  it("consumes 200 accounts x 30 packages in global deadline order", () => {
    const now = Date.now();
    const accounts = Array.from({ length: 200 }, (_, accountIndex) => ({
      id: `account-${accountIndex}`,
      quota: accountQuota(Array.from({ length: 30 }, (_, packageIndex) => ({
        name: `pack-${packageIndex}`,
        remaining: 1,
        resetAtMs: now + (packageIndex + 1) * DAY + accountIndex,
      }))),
    }));
    let previousDeadline = 0;
    for (let i = 0; i < 6000; i += 1) {
      const [best] = scoreAccounts(accounts, { getQuota: (c) => c.quota, now: () => now });
      const active = pickActivePackage(best.connection.quota, now);
      expect(active.resetAtMs).toBeGreaterThanOrEqual(previousDeadline);
      expect(active.name).toBe(`pack-${Math.floor(i / 200)}`);
      previousDeadline = active.resetAtMs;
      active.remaining = 0;
      recordConsumption(best.connection.id);
    }
    expect(accounts.every((c) => c.quota.packages.every((p) => p.remaining === 0))).toBe(true);
  }, 30000);
});

describe("quota-weighted spreading", () => {
  beforeEach(() => {
    resetOptimistic();
  });

  it("round-robins between identical accounts instead of draining one", () => {
    const now = Date.now();
    const accounts = [
      { id: "a", quota: accountQuota([{ name: "Monthly", remaining: 1000, resetAtMs: now + 10 * DAY, recurring: false }]) },
      { id: "b", quota: accountQuota([{ name: "Monthly", remaining: 1000, resetAtMs: now + 10 * DAY, recurring: false }]) },
    ];

    const picks = simulate(accounts, 20);
    expect(picks.get("a")).toBe(10);
    expect(picks.get("b")).toBe(10);
  });

  it("splits traffic in proportion to how much quota each account is about to lose", () => {
    const now = Date.now();
    const accounts = [
      { id: "big", quota: accountQuota([{ name: "Bonus Pack 1", remaining: 900, resetAtMs: now + 30 * DAY, recurring: false }]) },
      { id: "small", quota: accountQuota([{ name: "Bonus Pack 1", remaining: 100, resetAtMs: now + 30 * DAY, recurring: false }]) },
    ];

    const picks = simulate(accounts, 100);
    // 9:1 target. The bounds assert "the small balance keeps being served" rather than
    // an exact rounding of the deficit-convergence.
    expect(picks.get("big")).toBeGreaterThan(70);
    expect(picks.get("small")).toBeGreaterThan(5);
  });

  it("keeps serving a small balance that expires far sooner than a large one", () => {
    const now = Date.now();
    const accounts = [
      { id: "big", quota: accountQuota([{ name: "Monthly", remaining: 9000, resetAtMs: now + 60 * DAY, recurring: false }]) },
      { id: "urgent", quota: accountQuota([{ name: "Bonus Pack 1", remaining: 300, resetAtMs: now + DAY, recurring: false }]) },
    ];

    const picks = simulate(accounts, 40);
    expect(picks.get("urgent")).toBe(40);
    expect(picks.get("big")).toBe(0);
  });

  it("prefers accounts whose allowance is expiring over accounts with none", () => {
    const now = Date.now();
    const accounts = [
      { id: "known", quota: accountQuota([{ name: "Monthly", remaining: 500, resetAtMs: now + 5 * DAY, recurring: false }]) },
      { id: "unknown", quota: null },
    ];

    const picks = simulate(accounts, 10);
    expect(picks.get("known")).toBe(10);
    expect(picks.get("unknown")).toBe(0);
  });

  it("can be switched off, restoring pure score ordering", () => {
    const now = Date.now();
    const accounts = [
      { id: "rich", quota: accountQuota([{ name: "Monthly", remaining: 900, resetAtMs: now + 30 * DAY, recurring: false }]) },
      { id: "poor", quota: accountQuota([{ name: "Monthly", remaining: 100, resetAtMs: now + 30 * DAY, recurring: false }]) },
    ];

    const picks = simulate(accounts, 20, { weightFairShare: 0 });
    expect(picks.get("rich")).toBe(20);
    expect(picks.get("poor")).toBe(0);
  });

  it("surfaces which allowance is at risk for logging", () => {
    const now = Date.now();
    const accounts = [
      { id: "late", quota: accountQuota([{ name: "Monthly", remaining: 2000, resetAtMs: now + 20 * DAY, recurring: false }]) },
      { id: "soon", quota: accountQuota([{ name: "Bonus Pack 1", remaining: 400, resetAtMs: now + HOUR, recurring: false }]) },
    ];

    const soonDetail = scoreAccounts(accounts, { getQuota: (c) => c.quota })
      .find((r) => r.connection.id === "soon").detail;
    expect(soonDetail.activePackage).toBe("Bonus Pack 1");
    expect(soonDetail.atRisk).toBe(400);
    expect(soonDetail.packageCount).toBe(1);
    expect(soonDetail.msUntilDeadline).toBeGreaterThan(0);
  });

  it("does not starve a negligible balance that expires within the hour", () => {
    const now = Date.now();
    const accounts = [
      { id: "huge", quota: accountQuota([{ name: "Monthly", remaining: 1_000_000, resetAtMs: now + 365 * DAY, recurring: false }]) },
      { id: "tiny", quota: accountQuota([{ name: "Bonus Pack 1", remaining: 5, resetAtMs: now + HOUR, recurring: false }]) },
    ];

    const picks = simulate(accounts, 50);
    expect(picks.get("tiny")).toBe(50);
    expect(picks.get("huge")).toBe(0);
  });

  it("keeps the fair-share bonus meaningful when every base score is identical", () => {
    const now = Date.now();
    const accounts = [
      { id: "a", quota: accountQuota([{ name: "Monthly", remaining: 1000, resetAtMs: now + 5 * DAY, recurring: false }]) },
      { id: "b", quota: accountQuota([{ name: "Monthly", remaining: 1000, resetAtMs: now + 5 * DAY, recurring: false }]) },
    ];

    const ranked = scoreAccounts(accounts, { getQuota: (c) => c.quota });
    expect(ranked[0].detail.base).toBeCloseTo(ranked[1].detail.base, 6);
    expect(ranked[0].score).toBeCloseTo(ranked[1].score, 6);
  });

  it("refunds the fair-share counter when a selection consumed nothing", () => {
    recordConsumption("abc", 1);
    expect(getFairShareServed("abc")).toBeGreaterThan(0);
    releaseConsumption("abc", 1);
    expect(getFairShareServed("abc")).toBe(0);
  });

  it("ranks every candidate, not just the winner, so the concurrency fallback can follow it", () => {
    resetOptimistic();
    const now = Date.now();
    const accounts = [
      { id: "a", quota: accountQuota([{ name: "Monthly", remaining: 900, resetAtMs: now + 30 * DAY, recurring: false }]) },
      { id: "b", quota: accountQuota([{ name: "Monthly", remaining: 100, resetAtMs: now + 30 * DAY, recurring: false }]) },
      { id: "c", quota: null },
    ];

    const ranked = scoreAccounts(accounts, { getQuota: (q) => q.quota });
    expect(ranked).toHaveLength(3);
    expect(ranked.map((r) => r.connection.id)).toEqual(["a", "b", "c"]);
    expect(ranked[0].score).toBeGreaterThanOrEqual(ranked[1].score);
    expect(ranked[2].detail.activeResetAtMs).toBeNull();
  });

  it("still lets in-flight load break a tie between equally urgent accounts", () => {
    const now = Date.now();
    const accounts = [
      { id: "busy", quota: accountQuota([{ name: "Monthly", remaining: 1000, resetAtMs: now + 5 * DAY, recurring: false }]) },
      { id: "idle", quota: accountQuota([{ name: "Monthly", remaining: 1000, resetAtMs: now + 5 * DAY, recurring: false }]) },
    ];

    const ranked = scoreAccounts(accounts, {
      getQuota: (c) => c.quota,
      getLoad: (id) => (id === "busy" ? 5 : 0),
    });
    expect(ranked[0].connection.id).toBe("idle");
  });

  it("falls back to the legacy absolute-deadline ranking when nothing is at risk", () => {
    const now = Date.now();
    // Everything exhausted -> no at-risk allowance anywhere, so the legacy
    // "sooner deadline wins" behaviour must still hold.
    const exhausted = [
      { id: "later", quota: { remaining: 0, total: 100, resetAtMs: now + 10 * DAY } },
      { id: "sooner", quota: { remaining: 0, total: 100, resetAtMs: now + DAY } },
    ];

    const ranked = scoreAccounts(exhausted, { getQuota: (c) => c.quota });
    expect(ranked[0].connection.id).toBe("sooner");
    expect(ranked[0].detail.atRisk).toBeNull();
  });
});
