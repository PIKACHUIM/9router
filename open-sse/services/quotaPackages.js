/**
 * Quota packages — the scheduler's view of an account's allowances.
 *
 * One account usually holds SEVERAL independent allowances ("packages"), each with
 * its own balance and its own deadline:
 *
 *   - CodeBuddy CN: a recurring refill pack (Monthly/Weekly/…) plus N one-shot bonus
 *     packs, every one expiring on its own date (see usage/codebuddy-cn.js).
 *   - Antigravity: a 5h bucket per model, plus weekly pools for free-tier accounts
 *     (see usage/google.js + usage/antigravity-weekly.js).
 *   - Everything else: at least the rolling window the usage endpoint reports.
 *
 * Each selection compares the earliest non-empty, unexpired package per account.
 * After it is consumed, the next package determines that account's deadline, so
 * other accounts' urgent packages can run before this account's later packages.
 *
 * This module turns the heterogeneous provider quota shapes into that common package
 * list and derives the comparable aggregate the scorer consumes.
 */

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toMs(value) {
  if (value === null || value === undefined) return NaN;
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : NaN;
}

/**
 * One provider quota row -> one package. Returns null for rows that carry no usable
 * balance: 0/0 placeholders and "unlimited" sentinels carry no deadline pressure.
 *
 * Units stay provider-native (points, percentage, currency). Only comparisons WITHIN
 * the candidate set are made, so mixing units across providers is harmless; mixing
 * them within one account is not, which is why total/used wins over remainingPercentage
 * when both are present.
 */
function rowToPackage(name, row) {
  if (!row || typeof row !== "object") return null;
  if (row.unlimited === true) return null;

  const total = toNumber(row.total);
  const used = toNumber(row.used);
  const percentage = toNumber(row.remainingPercentage);
  const explicit = toNumber(row.remaining);

  let remaining = null;
  let packageTotal = total;
  if (total !== null && used !== null) {
    remaining = Math.max(0, total - used);
  } else if (percentage !== null) {
    remaining = percentage;
    packageTotal = 100;
  } else if (explicit !== null) {
    remaining = explicit;
  }
  if (remaining === null) return null;
  // Nothing reported at all is a placeholder row, not a balance.
  if (packageTotal === 0 && remaining === 0) return null;

  return {
    name: typeof name === "string" ? name : null,
    remaining,
    total: packageTotal,
    resetAtMs: toMs(row.resetAt),
    // Recurring packs refill at resetAt (the unused balance is still forfeited at the
    // cycle boundary); one-shot packs vanish for good. Default true so providers that
    // never set the flag behave exactly like the legacy single-snapshot path.
    recurring: row.recurring !== false,
  };
}

/**
 * Provider quota map (`{ [rowName]: row }`) -> package list.
 *
 * Antigravity ships per-model buckets AND weekly overlays that double count the same
 * allowance, so overlays are only used when no per-model bucket exists (free tier,
 * where the weekly pool is the only real limit).
 */
export function packagesFromQuotas(quotas) {
  const rows = Object.entries(quotas || {});
  if (rows.length === 0) return [];

  const isWeekly = (name) => /_weekly$/i.test(name);
  const perModel = rows.filter(([name]) => !isWeekly(name));
  const chosen = perModel.length > 0 ? perModel : rows.filter(([name]) => isWeekly(name));

  const packages = [];
  for (const [name, row] of chosen) {
    const pkg = rowToPackage(name, row);
    if (pkg) packages.push(pkg);
  }
  return packages;
}

/**
 * Package list -> the comparable aggregate used by the "how much is left" axis.
 *
 * `resetAtMs` is the SOONEST deadline across packages: the instant at which this
 * account loses whatever is still sitting in that package.
 */
export function aggregatePackages(packages) {
  if (!Array.isArray(packages) || packages.length === 0) return null;

  const remaining = packages.reduce((sum, p) => sum + p.remaining, 0);
  const totals = packages.map((p) => p.total).filter((t) => Number.isFinite(t));
  const resets = packages.map((p) => p.resetAtMs).filter((t) => Number.isFinite(t));

  return {
    remaining,
    total: totals.length > 0 ? totals.reduce((a, b) => a + b, 0) : null,
    resetAtMs: resets.length > 0 ? Math.min(...resets) : NaN,
    packages,
  };
}

/** True for the two-weekly-pool keys the antigravity usage handler overlays. */
export function isWeeklyOverlayKey(name) {
  return /_weekly$/i.test(String(name || ""));
}

/**
 * Normalise anything a caller can produce into the scheduler's quota descriptor:
 * a package list, a legacy single `{ remaining, total, resetAtMs }` snapshot, or both.
 * Returns null when nothing usable is known — the scorer then treats the account as
 * neutral instead of starving it.
 */
export function normalizeQuota(quota) {
  if (!quota || typeof quota !== "object") return null;

  let packages = null;
  if (Array.isArray(quota.packages)) {
    packages = quota.packages
      .filter((p) => p && typeof p === "object")
      .map((p) => {
        const remaining = toNumber(p.remaining);
        if (remaining === null) return null;
        return {
          name: typeof p.name === "string" ? p.name : null,
          remaining,
          total: toNumber(p.total),
          resetAtMs: toMs(p.resetAtMs ?? p.resetAt),
          recurring: p.recurring !== false,
        };
      })
      .filter(Boolean);
  }

  const remaining = toNumber(quota.remaining);
  if (remaining === null) {
    return packages && packages.length > 0 ? aggregatePackages(packages) : null;
  }

  return {
    remaining,
    total: toNumber(quota.total),
    resetAtMs: toMs(quota.resetAtMs ?? quota.resetAt),
    packages: packages || [],
  };
}

/**
 * The package that is about to be wasted: the soonest deadline among those that still
 * hold a balance. `recurring` only breaks exact ties — a one-shot pack loses its value
 * for good, a recurring one merely rolls into a new cycle.
 *
 * When the descriptor has no package list it degrades to the legacy single snapshot,
 * so accounts that only report one aggregate balance keep working unchanged.
 */
export function pickActivePackage(quota, now = Date.now()) {
  if (!quota) return null;

  const candidates = quota.packages && quota.packages.length > 0
    ? quota.packages
    : Number.isFinite(quota.remaining) && quota.remaining > 0 && Number.isFinite(quota.resetAtMs)
      ? [{
        name: null,
        remaining: quota.remaining,
        total: quota.total ?? null,
        resetAtMs: quota.resetAtMs,
        recurring: true,
      }]
      : [];

  let best = null;
  for (const p of candidates) {
    if (!Number.isFinite(p.remaining) || p.remaining <= 0) continue;
    // An already-passed deadline is not a deadline: the upstream is authoritative
    // about whether that balance still exists, and scoring a negative ttl would
    // produce a meaningless burn rate.
    if (!Number.isFinite(p.resetAtMs) || p.resetAtMs <= now) continue;

    if (!best) {
      best = p;
      continue;
    }
    if (p.resetAtMs < best.resetAtMs) {
      best = p;
      continue;
    }
    if (p.resetAtMs === best.resetAtMs && best.recurring === true && p.recurring === false) {
      best = p;
    }
  }
  return best;
}

/** Sum of every package balance (used by the dashboard for account totals). */
export function sumPackageRemaining(packages) {
  if (!Array.isArray(packages)) return 0;
  return packages.reduce((sum, p) => sum + (Number.isFinite(p?.remaining) ? p.remaining : 0), 0);
}

/**
 * Sum a package list into the "Total / Used / Available" points summary.
 *
 * The convention is per-package summation: an account's total is the sum over EVERY
 * allowance it holds, so a CodeBuddy account with a refill pack plus three bonus packs
 * reports all four added up rather than just one row.
 *
 * Mirrors `sumQuotaPoints` in the usage page's utils.js — that one sums already-parsed
 * quota ROWS, this one sums scheduler packages. Both apply the same rule; keep them in
 * step if the rule changes.
 *
 * A package with no finite total (a provider that only reports a remaining balance)
 * contributes to `available` and `count` but to neither `total` nor `used`, because
 * inventing a total for it would silently distort the account's headline number.
 *
 * @param {Array<object>} packages
 * @returns {{ total:number, used:number, available:number, count:number }}
 */
export function summarizePackages(packages) {
  const summary = { total: 0, used: 0, available: 0, count: 0 };

  for (const pkg of packages || []) {
    const remaining = Number(pkg?.remaining);
    if (!Number.isFinite(remaining)) continue;

    summary.count += 1;
    summary.available += Math.max(0, remaining);

    const total = Number(pkg?.total);
    if (Number.isFinite(total) && total > 0) {
      summary.total += total;
      summary.used += Math.max(0, total - remaining);
    }
  }

  return summary;
}
