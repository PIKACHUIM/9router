import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ handleChat: vi.fn() }));
vi.mock("@/sse/handlers/chat.js", () => ({ handleChat: mocks.handleChat }));

import { POST } from "../../src/app/api/v1/api/chat/route.js";
import { transformToOllama } from "../../open-sse/utils/ollamaTransform.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";

// Ollama streams NDJSON — one raw JSON object per line, no "data: " prefix.
// Whatever arrives without a closing newline stays in the line buffer and is
// only parsed when the transform flushes.
async function runOllamaStream(input) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(input));
      controller.close();
    },
  });

  const output = stream.pipeThrough(
    createSSETransformStreamWithLogger(FORMATS.OLLAMA, FORMATS.OPENAI, "ollama", null, null, "gpt-oss:120b"),
  );

  const reader = output.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

const chunk = (content, done = false) => JSON.stringify({
  model: "gpt-oss:120b",
  created_at: "2026-08-25T00:00:00Z",
  message: { role: "assistant", content },
  done,
  ...(done ? { done_reason: "stop", prompt_eval_count: 11, eval_count: 7 } : {}),
});

const deltas = (sse) => sse
  .split("\n")
  .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
  .map((l) => JSON.parse(l.slice(6)));

describe("Ollama NDJSON stream: the tail left in the line buffer", () => {
  it("delivers a content chunk that arrived without its newline", async () => {
    const out = await runOllamaStream([chunk("hello"), chunk(" world")].join("\n"));
    const content = deltas(out).map((c) => c.choices?.[0]?.delta?.content || "").join("");
    expect(content).toBe("hello world");
  });

  it("delivers the final chunk — finish_reason and usage — when it arrives without its newline", async () => {
    const out = await runOllamaStream([chunk("hello"), chunk("", true)].join("\n"));
    const last = deltas(out).at(-1);
    expect(last.choices[0].finish_reason).toBe("stop");
    expect(last.usage).toEqual({ prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 });
  });

  it("is unchanged when every line is newline-terminated", async () => {
    const out = await runOllamaStream(`${[chunk("hello"), chunk(" world"), chunk("", true)].join("\n")}\n`);
    const parsed = deltas(out);
    expect(parsed.map((c) => c.choices?.[0]?.delta?.content || "").join("")).toBe("hello world");
    expect(parsed.at(-1).choices[0].finish_reason).toBe("stop");
    expect(parsed.at(-1).usage.total_tokens).toBe(18);
  });
});

describe("Ollama complete JSON responses", () => {
  it("converts content, reasoning, tools and usage while preserving status and CORS", async () => {
    const upstreamResponse = Response.json({
      created: 1787616000,
      choices: [{
        message: {
          role: "assistant",
          content: "hello",
          reasoning_content: "thinking through it",
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "weather", arguments: '{"city":"Paris"}' } },
            { id: "call_2", type: "function", function: { name: "clock", arguments: { timezone: "UTC" } } },
          ],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    }, {
      status: 201,
      statusText: "Created",
      headers: {
        "Access-Control-Allow-Origin": "https://client.test",
        "Access-Control-Allow-Headers": "*",
        "X-Request-Id": "test-request",
        "Content-Length": "1000",
        "Content-Encoding": "gzip",
        "Transfer-Encoding": "chunked",
      },
    });

    const response = await transformToOllama(upstreamResponse, "gpt-oss:120b");
    expect(response.status).toBe(201);
    expect(response.statusText).toBe("Created");
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("access-control-allow-origin")).toBe("https://client.test");
    expect(response.headers.get("access-control-allow-headers")).toBe("*");
    expect(response.headers.get("x-request-id")).toBe("test-request");
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("transfer-encoding")).toBeNull();
    expect(await response.json()).toEqual({
      model: "gpt-oss:120b",
      created_at: new Date(1787616000 * 1000).toISOString(),
      message: {
        role: "assistant",
        content: "hello",
        thinking: "thinking through it",
        tool_calls: [
          { function: { name: "weather", arguments: { city: "Paris" } } },
          { function: { name: "clock", arguments: { timezone: "UTC" } } },
        ],
      },
      done: true,
      done_reason: "stop",
      prompt_eval_count: 11,
      eval_count: 7,
    });
  });

  it("handles a truncated tool argument string and completion length", async () => {
    const response = await transformToOllama(Response.json({
      choices: [{
        message: { content: null, tool_calls: [{ function: { name: "weather", arguments: '{"city":' } }] },
        finish_reason: "length",
      }],
    }), "gpt-oss:120b");
    const body = await response.json();
    expect(body.message).toEqual({ role: "assistant", content: "", tool_calls: [{ function: { name: "weather", arguments: {} } }] });
    expect(body.done_reason).toBe("length");
    expect(body.done).toBe(true);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it.each(["application/json", "text/event-stream"])("preserves non-ok %s errors without consuming them", async (contentType) => {
    const upstreamResponse = new Response(JSON.stringify({ error: { message: "rate limited" } }), {
      status: 429,
      headers: { "Content-Type": contentType, "Retry-After": "12", "Access-Control-Allow-Origin": "*" },
    });
    const response = await transformToOllama(upstreamResponse, "gpt-oss:120b");
    expect(response).toBe(upstreamResponse);
    expect(response.headers.get("retry-after")).toBe("12");
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: { message: "rate limited" } });
  });

  it("preserves a JSON error body even when upstream status is 200", async () => {
    const upstreamResponse = Response.json({ error: { message: "upstream error" } });
    const response = await transformToOllama(upstreamResponse, "gpt-oss:120b");
    expect(response).toBe(upstreamResponse);
    expect(await response.json()).toEqual({ error: { message: "upstream error" } });
  });

  it("does not consume malformed JSON when conversion fails", async () => {
    const upstreamResponse = new Response("invalid json", { headers: { "Content-Type": "application/json" } });
    const response = await transformToOllama(upstreamResponse, "gpt-oss:120b");
    expect(response).toBe(upstreamResponse);
    expect(await response.text()).toBe("invalid json");
  });

  it("lets the async Ollama route adopt the JSON transformation promise", async () => {
    mocks.handleChat.mockResolvedValueOnce(Response.json({
      choices: [{ message: { role: "assistant", content: "complete answer" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 4, completion_tokens: 2 },
    }));
    const request = new Request("https://router.test/v1/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-oss:120b", stream: true, messages: [{ role: "user", content: "hello" }] }),
    });
    const response = await POST(request);
    expect(response).toBeInstanceOf(Response);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toMatchObject({ model: "gpt-oss:120b", message: { content: "complete answer" }, done: true, prompt_eval_count: 4, eval_count: 2 });
  });
});

describe("SSE providers keep their sentinel handling", () => {
  it("does not translate a trailing data: [DONE]", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(
          `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\ndata: [DONE]`,
        ));
        controller.close();
      },
    });
    const out = stream.pipeThrough(
      createSSETransformStreamWithLogger(FORMATS.OPENAI, FORMATS.OPENAI, "openai", null, null, "gpt-4o"),
    );
    const reader = out.getReader();
    const decoder = new TextDecoder();
    let text = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    expect(text).toContain('"content":"hi"');
    // The sentinel is a framing marker, not a chunk — it must not be translated.
    expect(text).not.toContain('"done":true');
  });
});
