import { NextResponse } from "next/server";
import "open-sse/index.js";

import { getProviderConnections } from "@/models";
import { refreshAndUpdateCredentials } from "@/app/api/usage/[connectionId]/route";
import { checkinCodebuddyAccount } from "open-sse/services/checkin/codebuddy-cn.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 对一组 CodeBuddy CN 连接执行签到。
 */
export async function runCodebuddyCheckin(connections, { dryRun = false, concurrency = 3 } = {}) {
  const results = [];
  const queue = [...connections];

  async function worker() {
    while (queue.length > 0) {
      const conn = queue.shift();
      if (!conn) break;

      let proxyOptions = null;
      try {
        proxyOptions = await resolveConnectionProxyConfig(conn?.providerSpecificData);
      } catch (err) {
        console.log("[Checkin] resolve proxy config failed:", err?.message || err);
      }

      const refreshFn = async (c) => {
        const { connection: updated } = await refreshAndUpdateCredentials(c, true, proxyOptions);
        return updated;
      };

      try {
        const result = await checkinCodebuddyAccount(conn, {
          refreshFn,
          proxyOptions,
          dryRun,
        });
        results.push(result);
      } catch (err) {
        results.push({
          id: conn.id,
          name: conn.name || conn.email || conn.id,
          status: "fail",
          message: err?.message || String(err),
        });
      }
    }
  }

  const workers = [];
  const n = Math.max(1, Math.min(concurrency, connections.length || 1));
  for (let i = 0; i < n; i++) workers.push(worker());
  await Promise.all(workers);

  // 保持与输入一致的顺序
  const order = new Map(connections.map((c, i) => [c.id, i]));
  results.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  return results;
}

/**
 * POST /api/providers/checkin
 * 一键对全部 CodeBuddy CN 账号签到。
 *
 * Body (可选):
 *   {
 *     dryRun?: boolean,
 *     connectionIds?: string[],   // 只签指定账号
 *     concurrency?: number
 *   }
 */
export async function POST(request) {
  try {
    let body = {};
    try {
      body = await request.json();
    } catch {
      // 允许空 body
    }

    const all = await getProviderConnections({ provider: "codebuddy-cn", isActive: true });
    const idFilter = Array.isArray(body?.connectionIds) && body.connectionIds.length > 0
      ? new Set(body.connectionIds)
      : null;
    const connections = idFilter ? all.filter((c) => idFilter.has(c.id)) : all;

    if (connections.length === 0) {
      return NextResponse.json({
        results: [],
        summary: { total: 0, ok: 0, already: 0, fail: 0, skip: 0 },
      });
    }

    const results = await runCodebuddyCheckin(connections, {
      dryRun: body?.dryRun === true,
      concurrency: Number(body?.concurrency) || 3,
    });

    const summary = {
      total: results.length,
      ok: results.filter((r) => r.status === "ok" || r.status === "dry").length,
      already: results.filter((r) => r.status === "already").length,
      fail: results.filter((r) => r.status === "fail" || r.status === "refresh_fail").length,
      skip: results.filter((r) => r.status === "skip").length,
    };

    return NextResponse.json({ results, summary });
  } catch (error) {
    console.log("Error running bulk check-in:", error);
    return NextResponse.json(
      { error: error?.message || "Failed to run check-in" },
      { status: 500 }
    );
  }
}
