import { describe, expect, it } from "vitest";
import {
  CODEBUDDY_CLIENT_UA,
  WORKBUDDY_CLIENT_UA,
  CLIENT_PROFILES,
  applyClientProfile,
  clientProfileHeaders,
  normalizeClientProfile,
  resolveClientProfile,
} from "../../open-sse/providers/clientProfiles.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";

describe("client identity profiles", () => {
  it("uses the official client UAs verbatim", () => {
    expect(CODEBUDDY_CLIENT_UA).toBe("CodeBuddyIDE/5.0.0 CodeBuddy/2.177.1");
    expect(WORKBUDDY_CLIENT_UA).toBe("WorkBuddy/5.9.2 WorkBuddy/5.9.2 CLI/2.165.0");
    expect(CLIENT_PROFILES.codebuddy.userAgent).toBe(CODEBUDDY_CLIENT_UA);
    expect(CLIENT_PROFILES.workbuddy.userAgent).toBe(WORKBUDDY_CLIENT_UA);
  });

  it("ships the IDE markers for CodeBuddy and the CLI markers for WorkBuddy", () => {
    expect(CLIENT_PROFILES.codebuddy.headers).toMatchObject({
      "X-Product": "SaaS",
      "X-IDE-Type": "IDE",
      "X-IDE-Name": "IDE",
      "x-requested-with": "XMLHttpRequest",
      "x-codebuddy-request": "1",
    });
    expect(CLIENT_PROFILES.workbuddy.headers).toMatchObject({
      "X-Product": "SaaS",
      "X-IDE-Type": "CLI",
      "X-IDE-Name": "CLI",
      "x-requested-with": "XMLHttpRequest",
      "x-codebuddy-request": "1",
    });
  });

  it("normalizes stored values and rejects unknown ones to auto", () => {
    expect(normalizeClientProfile("")).toBe("auto");
    expect(normalizeClientProfile(undefined)).toBe("auto");
    expect(normalizeClientProfile(" CodeBuddy ")).toBe("codebuddy");
    expect(normalizeClientProfile("cbcn")).toBe("codebuddy");
    expect(normalizeClientProfile("wb")).toBe("workbuddy");
    expect(normalizeClientProfile("workbuddy-cli")).toBe("workbuddy");
    expect(normalizeClientProfile("off")).toBe("none");
    expect(normalizeClientProfile("garbage")).toBe("auto");
    expect(normalizeClientProfile({})).toBe("auto");
  });

  it("leaves non-CodeBuddy channels alone", () => {
    expect(resolveClientProfile({ provider: "openai", credentials: { providerSpecificData: {} } })).toBeNull();
    expect(resolveClientProfile({
      provider: "openai-compatible-chat-abc",
      credentials: { providerSpecificData: { baseUrl: "https://api.example.com/v1", nodeName: "My Relay" } },
    })).toBeNull();
  });

  it("detects the built-in CodeBuddy providers", () => {
    expect(resolveClientProfile({ provider: "codebuddy-cn" })?.id).toBe("codebuddy");
    expect(resolveClientProfile({ provider: "codebuddy-intl" })?.id).toBe("codebuddy");
  });

  it("detects reseller nodes by node name, prefix or baseUrl", () => {
    expect(resolveClientProfile({
      provider: "openai-compatible-chat-abc",
      credentials: { providerSpecificData: { nodeName: "WorkBuddy Reseller" } },
    })?.id).toBe("workbuddy");
    expect(resolveClientProfile({
      provider: "anthropic-compatible-abc",
      credentials: { providerSpecificData: { prefix: "codebuddy-pro" } },
    })?.id).toBe("codebuddy");
    expect(resolveClientProfile({
      provider: "openai-compatible-chat-abc",
      credentials: { providerSpecificData: { baseUrl: "https://www.codebuddy.ai/v1" } },
    })?.id).toBe("codebuddy");
    expect(resolveClientProfile({
      provider: "openai-compatible-chat-abc",
      credentials: { providerSpecificData: { baseUrl: "https://copilot.tencent.com/v2" } },
    })?.id).toBe("codebuddy");
    expect(resolveClientProfile({
      provider: "openai-compatible-chat-abc",
      credentials: { providerSpecificData: { baseUrl: "https://wb.example.com/v1" }, connectionName: "WorkBuddy #2" },
    })?.id).toBe("workbuddy");
  });

  it("lets an explicit per-connection selection win over detection", () => {
    expect(resolveClientProfile({
      provider: "codebuddy-cn",
      credentials: { providerSpecificData: { clientProfile: "workbuddy" } },
    })?.id).toBe("workbuddy");
    expect(resolveClientProfile({
      provider: "openai-compatible-chat-abc",
      credentials: { providerSpecificData: { clientProfile: "codebuddy", nodeName: "Relay" } },
    })?.id).toBe("codebuddy");
    expect(resolveClientProfile({
      provider: "codebuddy-cn",
      credentials: { providerSpecificData: { clientProfile: "none" } },
    })).toBeNull();
  });

  it("overwrites identity headers without touching auth or case variants", () => {
    const headers = {
      "Content-Type": "application/json",
      Authorization: "Bearer token",
      "user-agent": "curl/8.0",
      "x-ide-type": "SDK",
      "X-IDE-Type": "OTHER",
    };
    applyClientProfile(headers, CLIENT_PROFILES.workbuddy);
    const identityKeys = Object.keys(headers).filter((k) => /^(user-agent|x-ide-type)$/i.test(k));
    expect(identityKeys).toHaveLength(2);
    expect(headers["User-Agent"]).toBe(WORKBUDDY_CLIENT_UA);
    expect(headers["X-IDE-Type"]).toBe("CLI");
    expect(headers.Authorization).toBe("Bearer token");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(applyClientProfile(headers, null)).toBe(headers);
  });

  it("registry headers carry the shared identity block", () => {
    expect(clientProfileHeaders("codebuddy")["User-Agent"]).toBe(CODEBUDDY_CLIENT_UA);
    expect(clientProfileHeaders("unknown")).toEqual({});
    expect(PROVIDERS["codebuddy-cn"].headers["User-Agent"]).toBe(CODEBUDDY_CLIENT_UA);
    expect(PROVIDERS["codebuddy-intl"].headers["User-Agent"]).toBe(CODEBUDDY_CLIENT_UA);
  });
});

describe("DefaultExecutor client conversion", () => {
  it("stamps the CodeBuddy identity on built-in CodeBuddy channels", () => {
    const headers = new DefaultExecutor("codebuddy-cn").buildHeaders(
      { apiKey: "sk-test", providerSpecificData: {} },
      true,
    );
    expect(headers["User-Agent"]).toBe(CODEBUDDY_CLIENT_UA);
    expect(headers["X-IDE-Type"]).toBe("IDE");
    expect(headers["x-codebuddy-request"]).toBe("1");
    expect(headers.Authorization).toBe("Bearer sk-test");
    expect(headers.Accept).toBe("text/event-stream");
  });

  it("stamps the WorkBuddy identity on a WorkBuddy relay node", () => {
    const headers = new DefaultExecutor("openai-compatible-chat-abc").buildHeaders(
      { apiKey: "sk-test", providerSpecificData: { nodeName: "WorkBuddy", clientProfile: "auto" } },
      true,
    );
    expect(headers["User-Agent"]).toBe(WORKBUDDY_CLIENT_UA);
    expect(headers["X-IDE-Type"]).toBe("CLI");
    expect(headers["X-Product"]).toBe("SaaS");
  });

  it("honors an explicit selection and the off switch", () => {
    const forced = new DefaultExecutor("openai-compatible-chat-abc").buildHeaders(
      { apiKey: "sk-test", providerSpecificData: { nodeName: "Relay", clientProfile: "codebuddy" } },
      false,
    );
    expect(forced["User-Agent"]).toBe(CODEBUDDY_CLIENT_UA);

    const off = new DefaultExecutor("codebuddy-cn").buildHeaders(
      { apiKey: "sk-test", providerSpecificData: { clientProfile: "none" } },
      true,
    );
    // Registry defaults still ship the CodeBuddy UA; `none` only stops the runtime override.
    expect(off["User-Agent"]).toBe(CODEBUDDY_CLIENT_UA);
    expect(off.Authorization).toBe("Bearer sk-test");
  });

  it("does not invent identity headers for unrelated providers", () => {
    const headers = new DefaultExecutor("openai").buildHeaders(
      { apiKey: "sk-test", providerSpecificData: {} },
      true,
    );
    expect(headers["User-Agent"]).toBeUndefined();
    expect(headers["X-IDE-Type"]).toBeUndefined();
  });
});
