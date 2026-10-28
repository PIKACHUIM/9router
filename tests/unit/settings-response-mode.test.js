import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  json: vi.fn((body, init) => ({ status: init?.status || 200, body })),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  applyOutboundProxyEnv: vi.fn(),
  resetComboRotation: vi.fn(),
  compare: vi.fn(),
  genSalt: vi.fn(),
  hash: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: mocks.json },
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  updateSettings: mocks.updateSettings,
}));

vi.mock("@/lib/network/outboundProxy", () => ({
  applyOutboundProxyEnv: mocks.applyOutboundProxyEnv,
}));

vi.mock("open-sse/services/combo.js", () => ({
  resetComboRotation: mocks.resetComboRotation,
}));

vi.mock("bcryptjs", () => ({
  default: { compare: mocks.compare, genSalt: mocks.genSalt, hash: mocks.hash },
}));

const { PATCH } = await import("../../src/app/api/settings/route.js");

const patchRequest = (body) => ({ json: async () => body });

describe("PATCH /api/settings responseMode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ responseMode: "auto" });
    mocks.updateSettings.mockImplementation(async (patch) => ({ responseMode: "auto", ...patch }));
  });

  it.each(["auto", "force-stream", "force-non-stream"])("persists the valid mode %s", async (responseMode) => {
    const response = await PATCH(patchRequest({ responseMode }));

    expect(response.status).toBe(200);
    expect(response.body.responseMode).toBe(responseMode);
    expect(mocks.updateSettings).toHaveBeenCalledExactlyOnceWith({ responseMode });
  });

  it.each([
    { label: "null", value: null },
    { label: "object", value: {} },
    { label: "array", value: [] },
    { label: "array containing a valid mode", value: ["auto"] },
    { label: "zero", value: 0 },
    { label: "number", value: 1 },
    { label: "false", value: false },
    { label: "true", value: true },
    { label: "empty string", value: "" },
    { label: "uppercase mode", value: "AUTO" },
    { label: "unknown mode", value: "stream" },
    { label: "misspelled mode", value: "force-nonstream" },
    { label: "mode with trailing whitespace", value: "auto " },
  ])("rejects $label before persistence or side effects", async ({ value }) => {
    const response = await PATCH(patchRequest({
      responseMode: value,
      newPassword: "must-not-be-hashed",
      outboundProxyEnabled: true,
      comboStrategy: "round-robin",
    }));

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("Invalid response mode");
    expect(mocks.updateSettings).not.toHaveBeenCalled();
    expect(mocks.getSettings).not.toHaveBeenCalled();
    expect(mocks.compare).not.toHaveBeenCalled();
    expect(mocks.genSalt).not.toHaveBeenCalled();
    expect(mocks.hash).not.toHaveBeenCalled();
    expect(mocks.applyOutboundProxyEnv).not.toHaveBeenCalled();
    expect(mocks.resetComboRotation).not.toHaveBeenCalled();
  });

  it("allows unrelated settings without changing an existing response mode", async () => {
    mocks.updateSettings.mockResolvedValue({ responseMode: "force-stream", fallbackStrategy: "fill-first" });

    const response = await PATCH(patchRequest({ fallbackStrategy: "fill-first" }));

    expect(response.status).toBe(200);
    expect(response.body.responseMode).toBe("force-stream");
    expect(mocks.updateSettings).toHaveBeenCalledExactlyOnceWith({ fallbackStrategy: "fill-first" });
  });
});
