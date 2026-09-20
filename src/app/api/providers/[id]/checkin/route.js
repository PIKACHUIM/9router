import { NextResponse } from "next/server";
import "open-sse/index.js";

import { getProviderConnectionById } from "@/models";
import { refreshAndUpdateCredentials } from "@/app/api/usage/[connectionId]/route";
import { checkinCodebuddyAccount } from "open-sse/services/checkin/codebuddy-cn.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";

/**
 * POST /api/providers/[id]/checkin
 * 对单个 CodeBuddy CN 账号执行签到。
 *
 * Body (可选):
 *   { dryRun?: boolean }  // 只查询状态，不真正签到
 */
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    let body = {};
    try {
      body = await request.json();
    } catch {
      // 允许空 body
    }
    const dryRun = body?.dryRun === true;

    const connection = await getProviderConnectionById(id);
    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    if (connection.provider !== "codebuddy-cn") {
      return NextResponse.json(
        { error: `Provider "${connection.provider}" does not support check-in` },
        { status: 400 }
      );
    }

    let proxyOptions = null;
    try {
      proxyOptions = await resolveConnectionProxyConfig(connection?.providerSpecificData);
    } catch (err) {
      console.log("[Checkin] resolve proxy config failed:", err?.message || err);
    }

    // 复用主应用的刷新/写回逻辑（会写回数据库）
    const refreshFn = async (conn) => {
      const { connection: updated } = await refreshAndUpdateCredentials(conn, true, proxyOptions);
      return updated;
    };

    const result = await checkinCodebuddyAccount(connection, {
      refreshFn,
      proxyOptions,
      dryRun,
    });

    const status = result.status;
    const httpStatus = status === "fail" || status === "refresh_fail" ? 400 : 200;
    return NextResponse.json({ result }, { status: httpStatus });
  } catch (error) {
    console.log("Error checking in:", error);
    return NextResponse.json(
      { error: error?.message || "Failed to check in" },
      { status: 500 }
    );
  }
}
