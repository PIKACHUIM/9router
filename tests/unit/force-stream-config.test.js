// Guards forceStream moved from chatCore hardcode → PROVIDERS schema (#5).
import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: vi.fn(() => ({
    execute: executeMock,
    refreshCredentials: vi.fn().mockResolvedValue(null),
  })),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: vi.fn(async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  })),
}));

vi.mock("../../open-sse/utils/clientDetector.js", () => ({
  detectClientTool: vi.fn(() => null),
  isNativePassthrough: vi.fn(() => false),
}));

vi.mock("../../open-sse/utils/bypassHandler.js", () => ({
  handleBypassRequest: vi.fn(() => null),
}));

vi.mock("../../open-sse/utils/stream.js", () => ({
  createSSETransformStreamWithLogger: vi.fn(() => new TransformStream()),
  createPassthroughStreamWithLogger: vi.fn(() => new TransformStream()),
}));

vi.mock("../../open-sse/utils/streamHandler.js", () => ({
  pipeWithDisconnect: vi.fn((response, transform) => response.body.pipeThrough(transform)),
  createStreamController: vi.fn(() => ({
    signal: undefined,
    handleComplete: vi.fn(),
    handleError: vi.fn(),
  })),
}));

vi.mock("../../open-sse/services/tokenRefresh.js", () => ({
  refreshWithRetry: vi.fn(),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  default: vi.fn(),
  proxyAwareFetch: vi.fn(),
}));

vi.mock("../../open-sse/translator/formats/claude.js", () => ({
  normalizeClaudePassthrough: vi.fn(),
}));

vi.mock("../../open-sse/utils/toolDeduper.js", () => ({
  dedupeTools: vi.fn((tools) => ({ tools, stripped: [] })),
}));

vi.mock("../../open-sse/rtk/caveman.js", () => ({
  injectCaveman: vi.fn(),
}));

vi.mock("../../open-sse/rtk/ponytail.js", () => ({
  injectPonytail: vi.fn(),
}));

vi.mock("../../open-sse/rtk/index.js", () => ({
  compressMessages: vi.fn(() => null),
  formatRtkLog: vi.fn(() => ""),
}));

vi.mock("../../open-sse/rtk/headroom.js", () => ({
  compressWithHeadroom: vi.fn(async () => null),
  formatHeadroomLog: vi.fn(() => ""),
  // chatCore also imports these (fb543a1f); a mock missing them fails the import.
  formatHeadroomSizeLog: vi.fn(() => ""),
  isHeadroomPhantomSavings: vi.fn(() => false),
}));

vi.mock("../../open-sse/providers/capabilities.js", () => ({
  getCapabilitiesForModel: vi.fn(() => ({})),
}));

vi.mock("../../open-sse/translator/concerns/modality.js", () => ({
  stripUnsupportedModalities: vi.fn(() => false),
}));

vi.mock("../../open-sse/translator/concerns/prefetch.js", () => ({
  prefetchRemoteImages: vi.fn(async () => 0),
}));

vi.mock("../../open-sse/handlers/chatCore/requestDetail.js", () => ({
  buildRequestDetail: vi.fn((detail) => detail),
  extractRequestConfig: vi.fn((body, stream) => ({ body, stream })),
  extractUsageFromResponse: vi.fn((body) => body.usage || {}),
  saveUsageStats: vi.fn(),
  formatDoneLine: vi.fn(() => "done"),
}));

vi.mock("../../open-sse/utils/error.js", () => ({
  createErrorResult: vi.fn((status, message) => ({ success: false, status, error: message })),
  formatProviderError: vi.fn((error) => error.message),
  parseUpstreamError: vi.fn(),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(() => Promise.resolve()),
  saveRequestDetail: vi.fn(() => Promise.resolve()),
}));

const FORCED = ["openai", "codex", "commandcode"];

function makeOptions(bodyStream) {
  const body = {
    model: "gpt-4.1",
    messages: [{ role: "user", content: "hello" }],
  };
  if (bodyStream !== undefined) body.stream = bodyStream;

  return {
    body,
    modelInfo: { provider: "openai", model: "gpt-4.1" },
    credentials: { apiKey: "sk-test" },
    clientRawRequest: {
      endpoint: "/v1/chat/completions",
      body,
      headers: { accept: "application/json" },
    },
    connectionId: "test-connection",
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

// The first test pays for importing chatCore's module graph (3s+ under full-suite
// load); a test that times out keeps running and its late fetch call leaks into the
// next test's mock counts, so give the file room instead of cascading failures.
describe("forceStream provider config", { timeout: 20_000 }, () => {
  beforeEach(() => {
    executeMock.mockReset();
    executeMock.mockRejectedValue(new Error("boom"));
  });

  it("only openai/codex/commandcode force streaming", async () => {
    const { PROVIDERS } = await import("../../open-sse/config/providers.js");
    for (const id of FORCED) {
      expect(PROVIDERS[id]?.forceStream, `${id} forced`).toBe(true);
    }
    // a sample of others must NOT force
    for (const id of ["deepseek", "claude", "gemini", "openrouter"]) {
      expect(PROVIDERS[id]?.forceStream, `${id} not forced`).not.toBe(true);
    }
  });

  it.each([undefined, false])( "keeps forced-stream providers streaming for JSON clients when body.stream is %s", async (bodyStream) => {
    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

    await handleChatCore(makeOptions(bodyStream));

    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(executeMock.mock.calls[0][0].stream).toBe(true);
    expect(executeMock.mock.calls[0][0].body.stream).toBe(true);
  });

  it.each([false, true])("keeps the actual same-format upstream body consistent with stream=%s", async (stream) => {
    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    const options = makeOptions(stream);
    options.modelInfo.provider = "openrouter";
    options.body.stream_options = { include_usage: true };
    await handleChatCore(options);
    const sent = executeMock.mock.calls[0][0];
    expect(sent.stream).toBe(stream);
    expect(sent.body.stream).toBe(stream);
    if (!stream) expect(sent.body).not.toHaveProperty("stream_options");
  });

  it("also applies the stream setting to native passthrough bodies", async () => {
    const { isNativePassthrough } = await import("../../open-sse/utils/clientDetector.js");
    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    isNativePassthrough.mockReturnValue(true);
    try {
      await handleChatCore(makeOptions(false));
      expect(executeMock.mock.calls[0][0].body.stream).toBe(true);
    } finally {
      isNativePassthrough.mockReturnValue(false);
    }
  });

  it("returns JSON when a streaming-only provider answers a synchronous client with JSON", async () => {
    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    executeMock.mockResolvedValueOnce({
      response: Response.json({ id: "chatcmpl-json", object: "chat.completion", model: "gpt-4.1",
        choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }] }),
      url: "https://api.openai.com/v1/chat/completions", headers: {},
    });
    const result = await handleChatCore(makeOptions(false));
    expect(result.success).toBe(true);
    expect(result.response.headers.get("content-type")).toContain("application/json");
    expect((await result.response.json()).choices[0].message.content).toBe("hello");
  });

  it("synthesizes SSE when a streaming request receives complete upstream JSON", async () => {
    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    executeMock.mockResolvedValueOnce({
      response: Response.json({ id: "chatcmpl-json", object: "chat.completion", model: "gpt-4.1",
        choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }] }),
      url: "https://api.openai.com/v1/chat/completions", headers: {},
    });
    const result = await handleChatCore(makeOptions(true));
    expect(result.success).toBe(true);
    expect(result.response.headers.get("content-type")).toContain("text/event-stream");
    const text = await result.response.text();
    expect(text).toContain('"delta":{"role":"assistant","content":"hello"}');
    expect(text).toContain("data: [DONE]");
  });

  it("aggregates a streaming-only provider without exposing SSE to a synchronous client", async () => {
    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    executeMock.mockResolvedValueOnce({
      response: new Response('data: {"id":"chatcmpl-sse","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } }),
      url: "https://api.openai.com/v1/chat/completions", headers: {},
    });
    const result = await handleChatCore(makeOptions(false));
    expect(executeMock.mock.calls[0][0].body.stream).toBe(true);
    expect(result.success).toBe(true);
    expect((await result.response.json()).choices[0].message.content).toBe("hello");
  });

  it("converts complete Responses upstream JSON into a synchronous Chat completion", async () => {
    await import("../translator/registerAll.js");
    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    const options = makeOptions(false);
    options.modelInfo = { provider: "codex", model: "gpt-5.1-codex" };
    executeMock.mockResolvedValueOnce({
      response: Response.json({ id: "resp-test", object: "response", model: "gpt-5.1-codex", status: "completed", error: null,
        output: [{ id: "msg-1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "hello", annotations: [] }] }],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }),
      url: "https://chatgpt.com/backend-api/codex/responses", headers: {},
    });
    const result = await handleChatCore(options);
    expect(result.success).toBe(true);
    const body = await result.response.json();
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].message.content).toBe("hello");
    expect(body.usage.total_tokens).toBe(15);
  });

  it("does not call request-success callbacks for an upstream JSON error", async () => {
    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    const options = makeOptions(true);
    options.onRequestSuccess = vi.fn();
    executeMock.mockResolvedValueOnce({
      response: Response.json({ error: { message: "quota exceeded", status: 429 } }),
      url: "https://api.openai.com/v1/chat/completions", headers: {},
    });
    const result = await handleChatCore(options);
    expect(result.success).toBe(false);
    expect(result.status).toBe(429);
    expect(options.onRequestSuccess).not.toHaveBeenCalled();
  });
});
