/**
 * Quota-weighted account scoring.
 *
 * Motivation (the "1000 points / 10 days vs 2000 points / 15 days" case): fill-first
 * always drains the highest-priority account to zero, which can let a small,
 * soon-expiring package go unused while a larger, later-expiring one is consumed
 * first. Naive round-robin ignores the amounts entirely.
 *
 * This module produces a comparable score per account from two heterogeneous
 * quantities with DIFFERENT UNITS:
 *   - remaining quota (points / percent / tokens — provider dependent)
 *   - time-to-expiry (ms)
 * Applying weights directly to raw values is dimensionally wrong (a 1e6-token
 * balance would swamp a 1e9-ms expiry or vice versa). So each axis is first
 * MIN-MAX NORMALISED across the CURRENT candidate set into [0,1], and only then
 * weighted. This keeps the two weights meaningful regardless of scale.
 *
 * ---------------------------------------------------------------------------
 * "Burn every account's soon-expiring package", not "burn the account that
 * expires first"
 * ---------------------------------------------------------------------------
 * Scoring on the ABSOLUTE deadline is the wrong objective when a pool has many
 * accounts. Every request goes to whichever account happens to expire first, so that
 * one account is drained to zero while every other account's packages quietly age out.
 *
 * The objective is instead: each account should get rid of its own allowance before
 * that allowance is wasted, spread across accounts. Two mechanisms deliver that:
 *
 *  1. URGENCY IS RELATIVE TO THE ACCOUNT'S OWN DEADLINE.
 *     `urgency = atRisk / msUntilDeadline` — the burn rate a package needs to be
 *     consumed before it is lost. A large balance expiring late and a small balance
 *     expiring at once can have the same urgency; the score no longer rewards the
 *     earliest calendar date.
 *
 *  2. WEIGHTED FAIR SHARE (deficit accounting).
 *     Min-max scoring always has exactly one winner, so consecutive selections keep
 *     landing on the same account. Each account's "share" is its required burn rate
 *     relative to the pool's, `urgency_i / Σ urgency`; we track how much it has recently
 *     been served and give the next request to whoever is furthest BEHIND its share.
 *
 *     Sharing by burn rate rather than by raw balance is what minimises waste: if every
 *     account is served at the rate it needs to finish before its own deadline, they all
 *     drain in step and no allowance is left over. Sharing by balance alone would keep a
 *     small-but-imminent package starved behind a large distant one (1000 points expiring
 *     tomorrow is worth a thousand times more attention per point than 100000 expiring
 *     in a year), which is exactly the "other packages expire first" failure again.
 *
 * score = base + reach * norm(deficit)
 *   base    = wRemaining * norm(remaining)
 *           + wExpiry    * norm(urgency)   (or 1 - norm(urgency) when later-first)
 *           - loadPenalty
 *   reach   = wFairShare * (spread(base) + 1)
 *
 * The fair-share bonus is deliberately scaled by the spread of the base scores. A bonus
 * capped at the same [0,1] range as the axes would be permanently outvoted by them —
 * an account holding 9x the quota of another keeps a >1.0 edge and would never hand a
 * request over, so "spread the traffic" would silently do nothing. `reach` must STRICTLY
 * exceed the spread: at exactly the spread, the account that has fallen behind can only
 * tie, and a tie is resolved by candidate order, so the same account keeps winning.
 * `+1` makes the term decisive while the weight still dials how much base differences
 * (balance, deadline urgency, load) bend the split. Set the weight to 0 for pure score
 * ordering with no spreading.
 *
 * Callers must pass a `getQuota(connection)` accessor returning either
 * `{ remaining, total, resetAtMs, packages? }` or the legacy `{ remaining, total,
 * resetAtMs }` — `normalizeQuota()` accepts both (see quotaPackages.js). Accounts with
 * no quota data score NEUTRAL so they are neither starved nor unfairly preferred; when
 * NO candidate has anything at risk the scorer falls back to the legacy absolute-deadline
 * behaviour, so installs that never report per-package data are unaffected.
 */

import { normalizeQuota, pickActivePackage } from "./quotaPackages.js";

const NEUTRAL = 0.5;

function minMax(values) {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 0, span: 0 };
  return { min, max, span: max - min };
}

/** Normalise x into [0,1] given min/span; returns NEUTRAL when span is 0 (all equal). */
function norm(x, min, span) {
  if (!Number.isFinite(x)) return NEUTRAL;
  if (span <= 0) return NEUTRAL;
  return Math.min(1, Math.max(0, (x - min) / span));
}

// ---------------------------------------------------------------------------
// Weighted fair share ("deficit") accounting
//
// See the header: this is what stops the scoring from concentrating every request on
// the single best-scoring account. Counters decay with the half-life below so the split
// tracks the CURRENT balances and deadlines instead of locking in a stale history.
// Selection is serialised per provider by the auth mutex, so a counter written by the
// previous selection is always visible to the next one.
// ---------------------------------------------------------------------------

const FAIR_SHARE_HALF_LIFE_MS = 5 * 60_000;
/** Entries decayed below this are forgotten (keeps the map from growing forever). */
const FAIR_SHARE_FLOOR = 0.01;

/**
 * Deadlines closer than this are treated as "right now" rather than divided by ~0. A
 * package expiring in one second cannot command materially more urgency than one expiring
 * in a minute, and the unbounded ratio would let a rounding-error deadline swallow the
 * whole pool.
 */
const MIN_DEADLINE_MS = 60_000;

const fairShare = new Map(); // connectionId -> { used, atMs }

function decayedUsed(entry, now) {
  if (!entry) return 0;
  const elapsed = now - entry.atMs;
  if (!(elapsed > 0)) return entry.used;
  return entry.used * Math.pow(0.5, elapsed / FAIR_SHARE_HALF_LIFE_MS);
}

function servedUnits(connectionId, now) {
  if (!connectionId) return 0;
  const entry = fairShare.get(connectionId);
  if (!entry) return 0;
  const used = decayedUsed(entry, now);
  if (used < FAIR_SHARE_FLOOR) {
    fairShare.delete(connectionId);
    return 0;
  }
  return used;
}

function addServed(connectionId, cost, now) {
  if (!connectionId) return;
  const next = servedUnits(connectionId, now) + cost;
  if (next < FAIR_SHARE_FLOOR) {
    fairShare.delete(connectionId);
    return;
  }
  fairShare.set(connectionId, { used: next, atMs: now });
}

/**
 * Score a list of candidate connections.
 *
 * @param {Array<object>} candidates
 * @param {object} opts
 * @param {(c: object) => object|null} opts.getQuota
 *   Quota descriptor. May carry a `packages` list (multi-allowance accounts) or only the
 *   legacy single `{ remaining, total, resetAtMs }` aggregate.
 * @param {number} [opts.weightRemaining=1]
 * @param {number} [opts.weightExpiry=0.5]
 * @param {number} [opts.weightFairShare=1]
 * @param {boolean} [opts.preferEarlierExpiry=true]
 * @param {() => number} [opts.now=Date.now]
 * @param {(c: object) => number} [opts.getLoad] - in-flight load, used as a tie-breaker
 * @returns {Array<{ connection: object, score: number, detail: object }>} sorted best-first
 */
export function scoreAccounts(candidates, opts = {}) {
  const {
    getQuota,
    weightRemaining = 1,
    weightExpiry = 0.5,
    weightFairShare = 1,
    preferEarlierExpiry = true,
    now = () => Date.now(),
    getLoad = null,
  } = opts;

  const n = now();
  const quotas = candidates.map((c) => (typeof getQuota === "function" ? normalizeQuota(getQuota(c)) : null));

  // The package that is about to be wasted for each candidate, plus the burn rate needed
  // to consume it before it is lost (balance-units per ms). This is the whole basis of
  // the "burn before it expires" objective.
  const actives = quotas.map((q) => pickActivePackage(q, n));
  const atRiskValues = actives.map((p) => (p ? p.remaining : NaN));
  const urgencyValues = actives.map((p) => (
    p ? p.remaining / Math.max(MIN_DEADLINE_MS, p.resetAtMs - n) : NaN
  ));
  const totalUrgency = urgencyValues.reduce((sum, v) => sum + (Number.isFinite(v) ? v : 0), 0);
  // No candidate reports an expiring balance -> nothing can be wasted right now, so
  // fall back to the legacy absolute-deadline axes rather than inventing a ranking.
  const hasAtRisk = totalUrgency > 0;

  const remainingValues = quotas.map((q) => (q && Number.isFinite(q.remaining) ? q.remaining : NaN));
  // Legacy axis: absolute time-to-expiry, negated so "sooner" is "larger".
  const legacyExpiryValues = quotas.map((q) => (q && Number.isFinite(q.resetAtMs) ? -q.resetAtMs : NaN));

  const rem = minMax(remainingValues);
  const urgency = minMax(urgencyValues);
  const legacyExpiry = minMax(legacyExpiryValues);

  // Deficit vs. fair share. `share * (totalServed + 1) - served` is the classic
  // weighted fair queueing rule: positive means "has not had its share yet".
  // The share is the account's required burn rate relative to the pool's, so accounts
  // whose allowance must be consumed fastest get the most traffic (see header).
  const served = candidates.map((c) => servedUnits(c?.id, n));
  const totalServed = served.reduce((sum, v) => sum + v, 0);
  const shares = urgencyValues.map((v) => (
    totalUrgency > 0 && Number.isFinite(v) ? v / totalUrgency : NaN
  ));
  const deficits = shares.map((share, i) => (
    Number.isFinite(share) ? share * (totalServed + 1) - served[i] : NaN
  ));
  const deficit = minMax(deficits);

  // Pass 1 — the base score, i.e. how attractive each account is BEFORE fairness.
  const parts = candidates.map((connection, i) => {
    const q = quotas[i];
    let scoreRemaining = NEUTRAL;
    let scoreExpiry = NEUTRAL;

    if (q && Number.isFinite(q.remaining)) {
      scoreRemaining = norm(q.remaining, rem.min, rem.span);
    }

    if (hasAtRisk) {
      // Relative urgency. A candidate with no expiring balance scores 0 on this axis
      // instead of NEUTRAL: it is strictly worse than one that has something to lose,
      // and a neutral 0.5 would outrank a genuinely low-urgency account.
      const value = Number.isFinite(urgencyValues[i]) ? urgencyValues[i] : 0;
      const normalised = norm(value, urgency.min, urgency.span);
      scoreExpiry = preferEarlierExpiry ? normalised : 1 - normalised;
    } else if (q && Number.isFinite(q.resetAtMs)) {
      const normalised = norm(-q.resetAtMs, legacyExpiry.min, legacyExpiry.span);
      scoreExpiry = preferEarlierExpiry ? normalised : 1 - normalised;
    }

    let base = weightRemaining * scoreRemaining + weightExpiry * scoreExpiry;

    // Small load penalty (pure tie-breaker, bounded well below one weight unit)
    // so equally-scored accounts pick the least busy one.
    const load = typeof getLoad === "function" ? getLoad(connection.id) : 0;
    if (load > 0) base -= Math.min(0.1, load * 0.01);

    return { connection, q, active: actives[i], scoreRemaining, scoreExpiry, load, base };
  });

  // How far the fair-share bonus must reach to be able to reorder the base scores.
  // `+1` is what makes it decisive (see header) and keeps it meaningful when every base
  // score is identical — the case where spreading is the entire point.
  const baseSpread = parts.reduce((acc, p) => {
    acc.min = Math.min(acc.min, p.base);
    acc.max = Math.max(acc.max, p.base);
    return acc;
  }, { min: Infinity, max: -Infinity });
  const baseSpan = Number.isFinite(baseSpread.min) ? baseSpread.max - baseSpread.min : 0;
  const reach = hasAtRisk ? weightFairShare * (baseSpan + 1) : 0;

  const scored = parts.map((part, i) => {
    const scoreFairShare = hasAtRisk
      ? (Number.isFinite(deficits[i]) ? norm(deficits[i], deficit.min, deficit.span) : 0)
      : NEUTRAL;

    const q = part.q;
    const active = part.active;

    return {
      connection: part.connection,
      score: part.base + reach * scoreFairShare,
      detail: {
        hasQuota: !!q,
        remaining: q?.remaining ?? null,
        resetAtMs: q?.resetAtMs ?? null,
        scoreRemaining: part.scoreRemaining,
        scoreExpiry: part.scoreExpiry,
        scoreFairShare,
        base: part.base,
        load: part.load,
        msUntilExpiry: q && Number.isFinite(q.resetAtMs) ? q.resetAtMs - n : null,
        // Package-level view: which allowance is about to be wasted and how much is
        // in it. Surfaced for logs/diagnostics and for tests to assert spreading.
        packageCount: q?.packages?.length ?? 0,
        activePackage: active?.name ?? null,
        atRisk: Number.isFinite(atRiskValues[i]) ? atRiskValues[i] : null,
        msUntilDeadline: active ? active.resetAtMs - n : null,
        share: Number.isFinite(shares[i]) ? shares[i] : null,
        served: served[i],
        deficit: Number.isFinite(deficits[i]) ? deficits[i] : null,
      },
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * Pick the single best account by quota-weighted score.
 *
 * `score` is returned alongside `detail` because callers log it; it lives on the
 * scored entry (a sibling of `detail`), not inside `detail`.
 *
 * @returns {{ connection: object|null, score: number|null, detail: object|null }}
 */
export function pickQuotaWeighted(candidates, opts = {}) {
  if (!candidates || candidates.length === 0) return { connection: null, score: null, detail: null };
  const ranked = scoreAccounts(candidates, opts);
  const best = ranked[0];
  return { connection: best.connection, score: best.score, detail: best.detail };
}

// ---------------------------------------------------------------------------
// Optimistic local consumption
//
// The quota snapshot / Antigravity cache is inherently stale (it is refreshed on
// a timer or on error). If N concurrent requests all score against the SAME
// snapshot they all pick the same "best" account, which defeats the purpose and
// re-creates the thundering-herd problem (audit item #6). To damp this, we apply
// a short-lived LOCAL decrement per selection: the chosen account's effective
// remaining quota is lowered immediately, so the next selector that runs within
// the decay window sees a less attractive account and spreads out. The decrement
// is purely advisory and self-heals as entries expire.
// ---------------------------------------------------------------------------

const optimistic = new Map(); // connectionId -> { used, expiresAt }
const OPTIMISTIC_TTL_MS = 30_000;

function optimisticUsed(connectionId, now) {
  const e = optimistic.get(connectionId);
  if (!e) return 0;
  if (e.expiresAt <= now) {
    optimistic.delete(connectionId);
    return 0;
  }
  return e.used;
}

/**
 * Record that `connectionId` was just selected, so concurrent selectors within
 * the decay window discount its apparent remaining quota, and so the weighted
 * fair-share term counts this account as served.
 * @param {string} connectionId
 * @param {number} [cost=1] - units to discount (default: one "slot")
 */
export function recordConsumption(connectionId, cost = 1) {
  if (!connectionId) return;
  const now = Date.now();
  const e = optimistic.get(connectionId);
  if (!e || e.expiresAt <= now) {
    optimistic.set(connectionId, { used: cost, expiresAt: now + OPTIMISTIC_TTL_MS });
  } else {
    e.used += cost;
    optimistic.set(connectionId, e);
  }
  addServed(connectionId, cost, now);
}

/**
 * Wrap a getQuota accessor so it returns the snapshot MINUS the optimistic local
 * decrement. The decrement is expressed as a fraction of the snapshot's total
 * (or a small absolute floor when no total is known), so it perturbs scoring
 * without inventing wildly out-of-range values.
 *
 * The same ratio is applied to every package, so the "which package is about to be
 * wasted" decision sees the discount too and a burst cannot pile onto one allowance.
 *
 * @param {(c: object) => object|null} getQuota
 * @returns {(c: object) => object|null}
 */
export function withOptimisticDiscount(getQuota) {
  return (c) => {
    const q = typeof getQuota === "function" ? getQuota(c) : null;
    if (!q) return null;
    const now = Date.now();
    const used = optimisticUsed(c?.id, now);
    if (!used) return q;
    const remaining = Number(q.remaining);
    if (!Number.isFinite(remaining) || remaining <= 0) return q;

    const total = Number.isFinite(q.total) && q.total > 0 ? q.total : null;
    // Discount = used units of the total when known, else 2% of remaining per unit.
    const discount = total
      ? Math.min(remaining, used)
      : Math.min(remaining * 0.02 * used, remaining * 0.5);
    const nextRemaining = Math.max(0, remaining - discount);

    const ratio = nextRemaining / remaining;
    const packages = Array.isArray(q.packages)
      ? q.packages.map((p) => ({
        ...p,
        remaining: Number.isFinite(p?.remaining) ? p.remaining * ratio : p?.remaining,
      }))
      : q.packages;

    return { ...q, remaining: nextRemaining, packages, optimisticUsed: used };
  };
}

/**
 * Roll back a previously recorded optimistic consumption.
 *
 * `recordConsumption` is applied at SELECTION time, before we know whether the
 * request will actually consume anything. When the attempt fails without
 * consuming quota (a concurrency-429 retry, or a failover to another account),
 * the discount is stale: it makes a perfectly healthy account look emptier than
 * it is for the remainder of the decay window, and it inflates the fair-share
 * counter, biasing subsequent selections away from it for no reason.
 *
 * Refunding keeps both the optimistic view and the fair-share split honest. The
 * counters are clamped at zero and the entries are dropped when they reach zero, so an
 * unmatched refund can never drive either value negative (which would make an account
 * look artificially attractive).
 *
 * @param {string} connectionId
 * @param {number} [cost=1] - units to refund; must mirror the recorded cost
 */
export function releaseConsumption(connectionId, cost = 1) {
  if (!connectionId) return;
  const now = Date.now();

  const e = optimistic.get(connectionId);
  if (e) {
    if (e.expiresAt <= now) {
      // Already decayed; nothing to refund.
      optimistic.delete(connectionId);
    } else {
      e.used -= cost;
      if (e.used <= 0) optimistic.delete(connectionId);
      else optimistic.set(connectionId, e);
    }
  }

  addServed(connectionId, -cost, now);
}

/** Clear optimistic + fair-share state (test helper / maintenance). */
export function resetOptimistic() {
  optimistic.clear();
  fairShare.clear();
}

/** Current optimistic discount units for a connection (diagnostics / tests). */
export function getOptimisticUsed(connectionId) {
  if (!connectionId) return 0;
  return optimisticUsed(connectionId, Date.now());
}

/** Current fair-share served units for a connection (diagnostics / tests). */
export function getFairShareServed(connectionId, now = Date.now()) {
  if (!connectionId) return 0;
  return servedUnits(connectionId, now);
}
