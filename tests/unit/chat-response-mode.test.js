import { beforeEach, describe, expect, it, vi } from "vitest";

const { settings, core, bypass, comboModels, fusion } = vi.hoisted(() => ({
  settings: { responseMode: "auto" },
  core: vi.fn(),
  bypass: vi.fn(),
  comboModels: vi.fn(),
  fusion: vi.fn(),
}));

vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/lib/localDb", () => ({ getSettings: vi.fn(async () => settings) }));
vi.mock("../../src/sse/services/auth.js", () => ({
  getProviderCredentials: vi.fn(async () => ({ connectionId: "conn", apiKey: "test" })),
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: false })),
  clearAccountError: vi.fn(),
  extractApiKey: vi.fn(() => null),
  isValidApiKey: vi.fn(async () => true),
  releaseAccountSlot: vi.fn(),
  refundAccountQuotaDiscount: vi.fn(),
}));
vi.mock("../../src/sse/services/model.js", () => ({
  getModelInfo: vi.fn(async () => ({ provider: "openrouter", model: "test" })),
  getComboModels: comboModels,
}));
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: vi.fn(async (_provider, credentials) => credentials),
  updateProviderCredentials: vi.fn(async () => {}),
}));
vi.mock("../../src/sse/services/antigravityQuota.js", () => ({
  handleAntigravityQuotaError: vi.fn(), clearAntigravityStrikes: vi.fn(),
}));
vi.mock("../../src/sse/services/keyAccess.js", () => ({
  getKeyAccessContext: vi.fn(async () => null),
  enforceKeyAccess: vi.fn(async () => null),
  filterAdapterModels: vi.fn(async (_access, models) => models),
}));
vi.mock("../../src/sse/services/systemoneRouter.js", () => ({ resolveSmartChoice: vi.fn() }));
vi.mock("@/lib/headroom/detect", () => ({ DEFAULT_HEADROOM_URL: "http://localhost:8787" }));
vi.mock("@/lib/pxpipe/loader.js", () => ({ getTransform: vi.fn() }));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: vi.fn() }));
vi.mock("../../open-sse/handlers/chatCore.js", () => ({ handleChatCore: core }));
vi.mock("../../open-sse/utils/bypassHandler.js", () => ({ handleBypassRequest: bypass }));
vi.mock("../../open-sse/services/combo.js", () => ({
  detectRequiredCapabilities: vi.fn(() => new Set()),
  handleFusionChat: fusion,
  handleComboChat: vi.fn(async ({ body, models, handleSingleModel }) => handleSingleModel(body, models[0])),
}));
vi.mock("../../open-sse/services/capacityAdapter.js", () => ({
  augmentModelsWithCapacityAdapter: vi.fn((models) => models),
  withCapacityAdapterStripping: vi.fn((handler) => handler),
  getActiveAdapterStrategy: vi.fn(() => "fallback"),
}));
vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}), saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

const { handleChat } = await import("../../src/sse/handlers/chat.js");
const completion = () => Response.json({
  id: "chatcmpl-mode", object: "chat.completion", model: "test",
  choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
});
const sse = () => new Response([
  'data: {"id":"chatcmpl-mode","choices":[{"index":0,"delta":{"role":"assistant","content":"hello"},"finish_reason":null}]}',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
  "data: [DONE]", "",
].join("\n\n"), { headers: { "Content-Type": "text/event-stream" } });
const requestFor = (stream, extra = {}) => new Request("http://localhost/v1/chat/completions", {
  method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
  body: JSON.stringify({ model: "openrouter/test", messages: [{ role: "user", content: "hello" }],
    ...(stream === undefined ? {} : { stream }), ...extra }),
});

describe("global chat response mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settings.responseMode = "auto";
    delete settings.comboStrategy;
    comboModels.mockResolvedValue(null);
    bypass.mockReturnValue(null);
    core.mockImplementation(async () => ({ success: true, response: completion() }));
  });

  it.each([undefined, false, true])("forces streaming for stream=%s while preserving the logged client request", async (stream) => {
    settings.responseMode = "force-stream";
    const response = await handleChat(requestFor(stream));
    expect(core).toHaveBeenCalledOnce();
    const options = core.mock.calls[0][0];
    expect(options.body.stream).toBe(true);
    expect(options.clientRawRequest.body.stream).toBe(stream);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await response.text()).toContain("hello");
  });

  it.each([undefined, false, true])("forces synchronous JSON for stream=%s", async (stream) => {
    settings.responseMode = "force-non-stream";
    core.mockResolvedValueOnce({ success: true, response: sse() });
    const response = await handleChat(requestFor(stream, { stream_options: { include_usage: true } }));
    expect(core.mock.calls[0][0].body.stream).toBe(false);
    expect(core.mock.calls[0][0].body).not.toHaveProperty("stream_options");
    expect(response.headers.get("content-type")).toContain("application/json");
    expect((await response.json()).choices[0].message.content).toBe("hello");
  });

  it("keeps auto requests and responses unchanged", async () => {
    const upstream = completion();
    core.mockResolvedValueOnce({ success: true, response: upstream });
    expect(await handleChat(requestFor(false))).toBe(upstream);
    expect(core.mock.calls[0][0].body.stream).toBe(false);
  });

  it("applies the forced mode before bypass handling", async () => {
    settings.responseMode = "force-stream";
    bypass.mockReturnValueOnce({ success: true, response: completion() });
    const response = await handleChat(requestFor(false));
    expect(bypass.mock.calls[0][0].stream).toBe(true);
    expect(core).not.toHaveBeenCalled();
    expect(response.headers.get("content-type")).toContain("text/event-stream");
  });

  it("does not force Fusion's internal synchronous panel calls to stream", async () => {
    settings.responseMode = "force-stream";
    settings.comboStrategy = "fusion";
    comboModels.mockResolvedValueOnce(["openrouter/test"]);
    fusion.mockImplementationOnce(async ({ body, models, handleSingleModel }) => {
      expect(body.stream).toBe(true);
      const panel = await handleSingleModel({ ...body, stream: false }, models[0], true);
      expect((await panel.json()).choices[0].message.content).toBe("hello");
      return handleSingleModel(body, models[0], false);
    });
    const response = await handleChat(requestFor(false));
    expect(core.mock.calls[0][0].body.stream).toBe(false);
    expect(core.mock.calls[1][0].body.stream).toBe(true);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
  });

  it("preserves authentication failures rather than generating successful SSE", async () => {
    settings.responseMode = "force-stream";
    settings.requireApiKey = true;
    try {
      const response = await handleChat(requestFor(false));
      expect(response.status).toBe(401);
      expect(core).not.toHaveBeenCalled();
    } finally {
      delete settings.requireApiKey;
    }
  });
});
