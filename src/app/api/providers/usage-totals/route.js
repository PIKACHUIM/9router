import { NextResponse } from "next/server";
import { getProviderConnections } from "@/lib/localDb";
import { getUsageSnapshot } from "open-sse/services/usageSnapshot.js";
import { packagesFromQuotas, summarizePackages } from "open-sse/services/quotaPackages.js";

export const dynamic = "force-dynamic";

/**
 * GET /api/providers/usage-totals?provider=<providerId>
 *
 * Total / used / available points for each of a provider's accounts, plus the roll-up
 * across them.
 *
 * Computed from the SAME allowance cache the quota-weighted scheduler reads, so this
 * page shows exactly what scheduling sees and costs no upstream request. It is
 * populated by GET /api/usage/[connectionId] and by the background warm-up scheduler
 * (see open-sse/services/usageSnapshot.js), with the connection's stored snapshot as a
 * fallback for accounts whose live quota has never been fetched.
 *
 * Accounts with neither are simply absent from the response: the UI hides the block
 * instead of rendering a misleading 0.
 */
export async function GET(request) {
  try {
    const provider = new URL(request.url).searchParams.get("provider");
    if (!provider) {
      return NextResponse.json({ error: "provider query parameter is required" }, { status: 400 });
    }

    const connections = await getProviderConnections({ provider });
    const totals = {};
    const summary = { total: 0, used: 0, available: 0, packages: 0, accounts: 0 };

    for (const connection of connections) {
      const resolved = resolvePackages(connection);
      if (!resolved.packages || resolved.packages.length === 0) continue;

      const sums = summarizePackages(resolved.packages);
      if (sums.count === 0) continue;

      totals[connection.id] = { ...sums, source: resolved.source };
      summary.total += sums.total;
      summary.used += sums.used;
      summary.available += sums.available;
      summary.packages += sums.count;
      summary.accounts += 1;
    }

    return NextResponse.json(
      { totals, summary },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.warn(`[UsageTotals] ${error.message}`);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * Allowance packages for one connection, preferring live data.
 *
 * "live"   — from the in-memory usage snapshot (fresh, same source as scheduling)
 * "stored" — the snapshot on the connection itself (written by scripts/set-quota.mjs
 *            or an older client); can be stale, so it is labelled in the UI
 */
function resolvePackages(connection) {
  const snapshot = getUsageSnapshot(connection.id);
  if (snapshot) {
    const packages = packagesFromQuotas(snapshot.quotas);
    if (packages.length > 0) return { packages, source: "live" };
  }

  const stored = connection.providerSpecificData?.quota;
  if (!stored || typeof stored !== "object") return { packages: [], source: null };

  if (Array.isArray(stored.packages) && stored.packages.length > 0) {
    const normalized = stored.packages
      .map((p) => {
        const remaining = Number(p?.remaining);
        if (!Number.isFinite(remaining)) return null;
        return {
          name: typeof p?.name === "string" ? p.name : null,
          remaining,
          total: Number.isFinite(Number(p?.total)) ? Number(p.total) : null,
          resetAtMs: p?.resetAtMs ?? (p?.resetAt ? new Date(p.resetAt).getTime() : NaN),
          recurring: p?.recurring !== false,
        };
      })
      .filter(Boolean);
    if (normalized.length > 0) return { packages: normalized, source: "stored" };
  }

  // Legacy single-object snapshot: one package, so the sums still match the rule.
  const remaining = Number(stored.remaining);
  if (Number.isFinite(remaining)) {
    return {
      packages: [{
        name: null,
        remaining,
        total: Number.isFinite(Number(stored.total)) ? Number(stored.total) : null,
        resetAtMs: stored.resetAt ? new Date(stored.resetAt).getTime() : NaN,
        recurring: true,
      }],
      source: "stored",
    };
  }

  return { packages: [], source: null };
}
