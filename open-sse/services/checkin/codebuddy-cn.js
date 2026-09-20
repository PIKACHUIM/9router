/**
 * CodeBuddy CN (Tencent) 每日签到 handler.
 *
 * Reverse-engineered from cockpit-tools (jlcodes99/cockpit-tools) Rust impl:
 *   GET  /v2/plugin/accounts                       → uid / enterpriseId
 *   POST /v2/billing/meter/checkin-activity-status → 今日是否已签 (fallback: /checkin-status)
 *   POST /v2/billing/meter/daily-checkin           → 执行签到
 *
 * The gateway is shared with copilot.tencent.com, but the public hostname the
 * plugin/CLI uses is www.codebuddy.cn. Domain header follows the host.
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";

export const CODEBUDDY_CN_HOST = "https://www.codebuddy.cn";
const ACCOUNTS_URL = `${CODEBUDDY_CN_HOST}/v2/plugin/accounts`;
const CHECKIN_STATUS_URL = `${CODEBUDDY_CN_HOST}/v2/billing/meter/checkin-activity-status`;
const CHECKIN_STATUS_URL_LEGACY = `${CODEBUDDY_CN_HOST}/v2/billing/meter/checkin-status`;
const CHECKIN_URL = `${CODEBUDDY_CN_HOST}/v2/billing/meter/daily-checkin`;
const DEFAULT_DOMAIN = "www.codebuddy.cn";

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return { raw: await response.text().catch(() => "") };
  }
}

function buildHeaders(accessToken, { uid, eid, domain, refreshToken, headers = {} } = {}) {
  const out = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": "CLI/2.63.2 CodeBuddy/2.63.2",
    "X-Product": "SaaS",
    "X-Requested-With": "XMLHttpRequest",
    "X-Domain": domain || DEFAULT_DOMAIN,
    ...headers,
  };
  if (uid) out["X-User-Id"] = uid;
  if (eid) {
    out["X-Enterprise-Id"] = eid;
    out["X-Tenant-Id"] = eid;
  }
  if (refreshToken) out["X-Refresh-Token"] = refreshToken;
  return out;
}

async function request(url, accessToken, { method = "POST", body, proxyOptions, ...rest } = {}) {
  const response = await proxyAwareFetch(
    url,
    {
      method,
      headers: buildHeaders(accessToken, rest),
      ...(method === "GET" ? {} : { body: JSON.stringify(body || {}) }),
    },
    proxyOptions,
  );
  const json = await readJson(response);
  return { status: response.status, body: json || {} };
}

/**
 * GET /v2/plugin/accounts -> { uid, enterpriseId }.
 * Picks the last logged-in account, else the first one.
 */
export async function fetchAccountInfo(accessToken, { domain, proxyOptions } = {}) {
  const { status, body } = await request(ACCOUNTS_URL, accessToken, {
    method: "GET",
    domain,
    proxyOptions,
  });
  if (status !== 200) {
    throw new Error(`accounts http=${status}: ${JSON.stringify(body)}`);
  }
  const accounts = body?.data?.accounts || [];
  if (!accounts.length) throw new Error("accounts 返回空");
  const acc = accounts.find((a) => a.lastLogin) || accounts[0];
  const uid = acc.uid || acc.user_id || "";
  const eid = String(acc.enterpriseId || acc.enterprise_id || "").trim() || null;
  return { uid: uid || null, eid };
}

/** 查签到状态。先试 checkin-activity-status，失败回退 checkin-status。 */
export async function getCheckinStatus(accessToken, { uid, eid, domain, proxyOptions } = {}) {
  let last = null;
  for (const url of [CHECKIN_STATUS_URL, CHECKIN_STATUS_URL_LEGACY]) {
    const res = await request(url, accessToken, { uid, eid, domain, proxyOptions });
    last = res;
    if (res.status === 200 && res.body?.code === 0) return res.body?.data || {};
  }
  throw new Error(`checkin-status 查询失败: http=${last?.status} body=${JSON.stringify(last?.body)}`);
}

/** 执行签到。code!==0 视为业务错误（如已签）返回 success:false。 */
export async function performCheckin(accessToken, { uid, eid, domain, proxyOptions } = {}) {
  const { status, body } = await request(CHECKIN_URL, accessToken, {
    uid,
    eid,
    domain,
    proxyOptions,
  });
  const code = body?.code;
  if (status !== 200 || code === undefined) {
    throw new Error(`daily-checkin http=${status}: ${JSON.stringify(body)}`);
  }
  if (code !== 0) {
    return { success: false, message: body?.message || body?.msg || "unknown", raw: body };
  }
  const data = body?.data || {};
  return {
    success: data.success !== false,
    message: data.message ?? null,
    credit: data.credit ?? data.today_credit ?? null,
    streak_days: data.streak_days ?? null,
    is_streak_day: data.is_streak_day ?? null,
    next_checkin_in: data.nextCheckinIn ?? data.next_checkin_in ?? null,
    reward: data.reward ?? null,
  };
}

function isTokenExpired(expiresAt, leadMs = 5 * 60 * 1000) {
  if (!expiresAt) return false;
  const t = new Date(expiresAt).getTime();
  if (!Number.isFinite(t)) return false;
  return Date.now() >= t - leadMs;
}

/**
 * 单账号签到。connection 为 providerConnections 行（含 accessToken / refreshToken 等）。
 * refreshFn(connection) -> Promise<connection> 用于 token 过期时刷新（由调用方注入，
 * 以便复用主程序已实现的 codebuddy 刷新与写回逻辑）。
 */
export async function checkinCodebuddyAccount(connection, { refreshFn, proxyOptions, dryRun = false } = {}) {
  const name = connection.name || connection.email || connection.id;
  let conn = connection;

  if (!conn.accessToken) {
    return { id: conn.id, name, status: "skip", message: "无 accessToken" };
  }

  const domain =
    conn.providerSpecificData?.domain || conn.domain || DEFAULT_DOMAIN;

  if (refreshFn && isTokenExpired(conn.expiresAt || conn.tokenExpiresAt) && conn.refreshToken) {
    try {
      conn = (await refreshFn(conn)) || conn;
    } catch (e) {
      return { id: connection.id, name, status: "refresh_fail", message: String(e.message || e) };
    }
  }

  const run = async (token) => {
    const { uid, eid } = await fetchAccountInfo(token, { domain, proxyOptions });
    const statusInfo = await getCheckinStatus(token, { uid, eid, domain, proxyOptions });
    if (statusInfo.today_checked_in) {
      return {
        id: connection.id,
        name,
        status: "already",
        streak_days: statusInfo.streak_days ?? null,
        message: "今日已签",
      };
    }
    if (dryRun) {
      return { id: connection.id, name, status: "dry", message: "未签到（dry-run）" };
    }
    const r = await performCheckin(token, { uid, eid, domain, proxyOptions });
    if (r.success) {
      return {
        id: connection.id,
        name,
        status: "ok",
        credit: r.credit,
        streak_days: r.streak_days,
        is_streak_day: r.is_streak_day,
        message: "签到成功",
      };
    }
    return { id: connection.id, name, status: "fail", message: r.message || "签到失败" };
  };

  try {
    return await run(conn.accessToken);
  } catch (e) {
    const msg = String(e.message || e);
    const authLike = /401|未授权|unauthorized|token/i.test(msg);
    if (authLike && refreshFn && conn.refreshToken) {
      try {
        const refreshed = (await refreshFn(conn)) || conn;
        return await run(refreshed.accessToken);
      } catch (e2) {
        return { id: connection.id, name, status: "fail", message: `刷新重试失败: ${e2.message || e2}` };
      }
    }
    return { id: connection.id, name, status: "fail", message: msg };
  }
}
