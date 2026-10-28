import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {})
}));

const { applyResponseMode, enforceResponseMode } = await import("../../open-sse/utils/responseMode.js");
const { FORMATS } = await import("../../open-sse/translator/formats.js");

const jsonResponse = (body, init = {}) => new Response(JSON.stringify(body), {
  ...init,
  headers: { "content-type": "application/json", ...init.headers }
});
const sseResponse = (text, init = {}) => new Response(text, {
  ...init,
  headers: { "content-type": "text/event-stream", ...init.headers }
});
const event = (data, type) => `${type ? `event: ${type}\n` : ""}data: ${JSON.stringify(data)}\n\n`;
const eventsFrom = (text) => text.split("\n\n").filter(Boolean).map((record) => {
  const payload = record.split("\n").find((line) => line.startsWith("data:"))?.slice(5).trim();
  return payload === "[DONE]" ? "[DONE]" : JSON.parse(payload);
});
const chat = {
  id: "chatcmpl-mode",
  object: "chat.completion",
  created: 123,
  model: "test-model",
  choices: [
    { index: 2, message: { role: "assistant", content: null, reasoning_content: "分析", tool_calls: [{ id: "call-a", type: "function", function: { name: "weather", arguments: '{"city":"北京"}' } }] }, finish_reason: "tool_calls" },
    { index: 0, message: { role: "assistant", content: "你好" }, finish_reason: "stop" }
  ],
  usage: { prompt_tokens: 5, completion_tokens: 8, total_tokens: 13, prompt_tokens_details: { cached_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 4 } }
};
const claude = {
  id: "msg-mode",
  type: "message",
  role: "assistant",
  model: "claude-test",
  content: [
    { type: "thinking", thinking: "思考", signature: "signed" },
    { type: "text", text: "答案", citations: [{ type: "char_location", cited_text: "答案", document_index: 0, start_char_index: 0, end_char_index: 2 }] },
    { type: "tool_use", id: "tool-a", name: "weather", input: { city: "北京", days: [1, 2] } },
    { type: "redacted_thinking", data: "redacted" }
  ],
  stop_reason: "tool_use",
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 4, cache_creation_input_tokens: 6, cache_read_input_tokens: 7, cache_creation: { ephemeral_5m_input_tokens: 6 } }
};
const responses = {
  id: "resp-mode",
  object: "response",
  created_at: 123,
  model: "responses-test",
  status: "completed",
  metadata: { request: "test" },
  error: null,
  output: [
    { id: "rs-a", type: "reasoning", summary: [{ type: "summary_text", text: "思考" }], encrypted_content: "ciphertext" },
    { id: "msg-a", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "答案", annotations: [{ type: "file_citation", file_id: "file-a", index: 0, filename: "test.txt" }] }] },
    { id: "fc-a", type: "function_call", call_id: "call-a", name: "weather", arguments: '{"city":"北京"}', status: "completed" },
    { id: "ctc-a", type: "custom_tool_call", call_id: "call-b", name: "shell", input: "printf hello", status: "completed" }
  ],
  usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20, input_tokens_details: { cached_tokens: 7 }, output_tokens_details: { reasoning_tokens: 3 } }
};

describe("applyResponseMode", () => {
  it.each(["auto", "invalid", null, undefined, "FORCE-STREAM"])("保留 %s 模式请求身份及输入", (mode) => {
    const body = Object.freeze({ stream: true, stream_options: { include_usage: true } });
    expect(applyResponseMode(body, mode)).toBe(body);
  });

  it("强制流式返回浅复制且保留流式选项", () => {
    const messages = [{ role: "user", content: "hello" }];
    const body = Object.freeze({ messages, stream: false, stream_options: { include_usage: true } });
    const next = applyResponseMode(body, "force-stream");
    expect(next).not.toBe(body);
    expect(next).toEqual({ ...body, stream: true });
    expect(next.messages).toBe(messages);
    expect(body.stream).toBe(false);
  });

  it("强制非流式删除副本的 stream_options 而不修改输入", () => {
    const body = Object.freeze({ stream: true, stream_options: Object.freeze({ include_usage: true }) });
    expect(applyResponseMode(body, "force-non-stream")).toEqual({ stream: false });
    expect(body.stream_options.include_usage).toBe(true);
    expect(body.stream).toBe(true);
  });
});

describe("enforceResponseMode 透传和头部", () => {
  it.each(["auto", "invalid", null, undefined])("%s 透传未读取的 Response", async (mode) => {
    const original = jsonResponse(chat);
    expect(await enforceResponseMode(original, mode, FORMATS.OPENAI)).toBe(original);
    expect(original.bodyUsed).toBe(false);
  });

  it.each([400, 403, 429, 500, 502])("保留上游错误状态 %s 和响应身份", async (status) => {
    const original = jsonResponse({ error: { message: "failed" } }, { status });
    expect(await enforceResponseMode(original, "force-stream", FORMATS.OPENAI)).toBe(original);
    expect(await enforceResponseMode(original, "force-non-stream", FORMATS.OPENAI)).toBe(original);
    expect(original.bodyUsed).toBe(false);
  });

  it("实际 SSE 的 Content-Type 大小写不影响识别和透传", async () => {
    const original = sseResponse("data: [DONE]\n\n", { headers: { "content-type": "Text/Event-Stream; Charset=UTF-8" } });
    expect(await enforceResponseMode(original, "force-stream", FORMATS.OPENAI)).toBe(original);
    expect(original.bodyUsed).toBe(false);
  });

  it("实际 JSON 非流式透传", async () => {
    const original = jsonResponse(chat);
    expect(await enforceResponseMode(original, "force-non-stream", FORMATS.OPENAI)).toBe(original);
    expect(original.bodyUsed).toBe(false);
  });

  it("转换保留状态、CORS和request-id，删除实体头并设置流式头", async () => {
    const output = await enforceResponseMode(jsonResponse(chat, {
      status: 201,
      headers: { "content-length": "100", "content-encoding": "gzip", "access-control-allow-origin": "*", "x-request-id": "req-1", "request-id": "req-2" }
    }), "force-stream", FORMATS.OPENAI);
    expect(output.status).toBe(201);
    expect(output.headers.get("content-type")).toContain("text/event-stream");
    expect(output.headers.get("content-length")).toBeNull();
    expect(output.headers.get("content-encoding")).toBeNull();
    expect(output.headers.get("access-control-allow-origin")).toBe("*");
    expect(output.headers.get("x-request-id")).toBe("req-1");
    expect(output.headers.get("request-id")).toBe("req-2");
    expect(output.headers.get("cache-control")).toBe("no-cache");
    expect(output.headers.get("x-accel-buffering")).toBe("no");
    const final = await enforceResponseMode(output, "force-non-stream", FORMATS.OPENAI);
    expect(final.status).toBe(201);
    expect(final.headers.get("content-type")).toContain("application/json");
    expect(final.headers.get("connection")).toBeNull();
    expect(final.headers.get("x-accel-buffering")).toBeNull();
    expect(final.headers.get("x-request-id")).toBe("req-1");
  });
});

describe("OpenAI 响应转换", () => {
  it("同步 JSON 转 SSE 保留多候选、工具索引、reasoning、usage和完成原因", async () => {
    const output = await enforceResponseMode(jsonResponse(chat), "force-stream", FORMATS.OPENAI);
    const chunks = eventsFrom(await output.text());
    expect(chunks[0].object).toBe("chat.completion.chunk");
    expect(chunks[0].choices[0]).toMatchObject({ index: 2, finish_reason: null, delta: { role: "assistant", content: null, reasoning_content: "分析", tool_calls: [{ index: 0, id: "call-a" }] } });
    expect(chunks[0].choices[1]).toMatchObject({ index: 0, delta: { content: "你好" } });
    expect(chunks[1].choices.map((choice) => choice.finish_reason)).toEqual(["tool_calls", "stop"]);
    expect(chunks[2].usage).toEqual(chat.usage);
    expect(chunks.at(-1)).toBe("[DONE]");
  });

  it("SSE 聚合多候选工具参数分片、usage及reasoning", async () => {
    const text = event({ id: chat.id, model: chat.model, choices: [{ index: 2, delta: { role: "assistant", reasoning_content: "分", tool_calls: [{ index: 0, id: "call-a", type: "function", function: { name: "wea", arguments: '{"city":' } }] } }, { index: 0, delta: { role: "assistant", content: "你" } }] })
      + event({ choices: [{ index: 2, delta: { reasoning_content: "析", tool_calls: [{ index: 0, function: { name: "ther", arguments: '"北京"}' } }] }, finish_reason: "tool_calls" }, { index: 0, delta: { content: "好" }, finish_reason: "stop" }] })
      + event({ choices: [], usage: chat.usage }) + "data: [DONE]\n\n";
    const output = await enforceResponseMode(sseResponse(text.replace(/\n/g, "\r\n")), "force-non-stream", FORMATS.OPENAI);
    const result = await output.json();
    expect(output.status).toBe(200);
    expect(result.choices.map((choice) => choice.index)).toEqual([0, 2]);
    expect(result.choices[0].message.content).toBe("你好");
    expect(result.choices[1]).toMatchObject(chat.choices[0]);
    expect(result.usage).toEqual(chat.usage);
  });

  it("保留旧式function_call、custom tool和logprobs", async () => {
    const text = event({ choices: [{ index: 0, delta: { role: "assistant", function_call: { name: "tool", arguments: "{" }, tool_calls: [{ index: 3, id: "custom-a", type: "custom", custom: { name: "shell", input: "echo " } }] }, logprobs: { content: [{ token: "a" }] } }] })
      + event({ choices: [{ index: 0, delta: { function_call: { arguments: "}" }, tool_calls: [{ index: 3, custom: { input: "hello" } }] }, logprobs: { content: [{ token: "b" }] }, finish_reason: "tool_calls" }] });
    const result = await (await enforceResponseMode(sseResponse(text), "force-non-stream", FORMATS.OPENAI)).json();
    expect(result.choices[0].message.function_call).toEqual({ name: "tool", arguments: "{}" });
    expect(result.choices[0].message.tool_calls).toEqual([{ id: "custom-a", type: "custom", custom: { name: "shell", input: "echo hello" } }]);
    expect(result.choices[0].logprobs.content).toEqual([{ token: "a" }, { token: "b" }]);
  });

  it.each([400, 403, 429, 503, 200, 999, undefined])("SSE错误不能伪装成功，上游 status=%s", async (status) => {
    const output = await enforceResponseMode(sseResponse(event({ error: { message: "quota exceeded", status } }), { headers: { "x-request-id": "req-error" } }), "force-non-stream", FORMATS.OPENAI);
    expect(output.status).toBe(status >= 400 && status <= 599 ? status : 502);
    expect((await output.json()).error.message).toBe("quota exceeded");
    expect(output.headers.get("x-request-id")).toBe("req-error");
  });

  it.each(["data: not-json\n\n", "data: [DONE]\n\n", event({ choices: [{ index: 0, delta: { content: "partial" } }] }), "not an SSE stream"])("畸形或不完整SSE返回清晰502", async (text) => {
    const output = await enforceResponseMode(sseResponse(text), "force-non-stream", FORMATS.OPENAI);
    expect(output.status).toBe(502);
    expect((await output.json()).error.message).toMatch(/Invalid|Incomplete/);
  });

  it.each(["not-json", "null", "[]", "{}"])("无效同步JSON返回502", async (text) => {
    const output = await enforceResponseMode(new Response(text, { headers: { "content-type": "application/json" } }), "force-stream", FORMATS.OPENAI);
    expect(output.status).toBe(502);
    expect((await output.json()).error.message).toContain("Response mode conversion failed");
  });

  it("JSON中的上游错误映射为非2xx", async () => {
    const output = await enforceResponseMode(jsonResponse({ error: { message: "denied", status: 403 } }), "force-stream", FORMATS.OPENAI);
    expect(output.status).toBe(403);
  });
});

describe("Claude 原生响应转换", () => {
  it("完整message产生正确事件并双向保留所有块和cache usage", async () => {
    const stream = await enforceResponseMode(jsonResponse(claude), "force-stream", FORMATS.CLAUDE);
    const text = await stream.text();
    const chunks = eventsFrom(text);
    expect(chunks[0].type).toBe("message_start");
    expect(chunks[0].message.content).toEqual([]);
    expect(chunks.some((chunk) => chunk.delta?.type === "thinking_delta")).toBe(true);
    expect(chunks.some((chunk) => chunk.delta?.type === "signature_delta")).toBe(true);
    expect(chunks.some((chunk) => chunk.delta?.partial_json === JSON.stringify(claude.content[2].input))).toBe(true);
    expect(chunks.at(-1).type).toBe("message_stop");
    const output = await enforceResponseMode(sseResponse(text), "force-non-stream", FORMATS.CLAUDE);
    expect(output.status).toBe(200);
    expect(await output.json()).toEqual(claude);
  });

  it("工具input和thinking签名分片正确聚合", async () => {
    const text = event({ type: "message_start", message: { ...claude, content: [], usage: { input_tokens: 10, cache_read_input_tokens: 7, output_tokens: 0 } } }, "message_start")
      + event({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool-a", name: "weather", input: {} } }, "content_block_start")
      + event({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"city":' } }, "content_block_delta")
      + event({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"北京"}' } }, "content_block_delta")
      + event({ type: "content_block_stop", index: 0 }, "content_block_stop")
      + event({ type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "" } }, "content_block_start")
      + event({ type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "想" } }, "content_block_delta")
      + event({ type: "content_block_delta", index: 1, delta: { type: "signature_delta", signature: "sig" } }, "content_block_delta")
      + event({ type: "content_block_delta", index: 1, delta: { type: "signature_delta", signature: "ned" } }, "content_block_delta")
      + event({ type: "content_block_stop", index: 1 }, "content_block_stop")
      + event({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 4 } }, "message_delta")
      + event({ type: "message_stop" }, "message_stop");
    const output = await enforceResponseMode(sseResponse(text), "force-non-stream", FORMATS.CLAUDE);
    const result = await output.json();
    expect(result.content).toEqual([{ type: "tool_use", id: "tool-a", name: "weather", input: { city: "北京" } }, { type: "thinking", thinking: "想", signature: "signed" }]);
    expect(result.usage).toEqual({ input_tokens: 10, cache_read_input_tokens: 7, output_tokens: 4 });
  });

  it("没有message_stop的Claude SSE失败", async () => {
    const output = await enforceResponseMode(sseResponse(event({ type: "message_start", message: { ...claude, content: [] } }, "message_start")), "force-non-stream", FORMATS.CLAUDE);
    expect(output.status).toBe(502);
    expect((await output.json()).error.message).toContain("message_stop");
  });

  it("message_stop之后的Claude事件不能被伪装为完整成功响应", async () => {
    const text = event({ type: "message_stop" }, "message_stop")
      + event({ type: "message_start", message: { ...claude, content: [] } }, "message_start");
    const output = await enforceResponseMode(sseResponse(text), "force-non-stream", FORMATS.CLAUDE);
    expect(output.status).toBe(502);
  });

  it("Claude error事件返回非2xx", async () => {
    const output = await enforceResponseMode(sseResponse(event({ type: "error", error: { type: "overloaded_error", message: "busy" } }, "error")), "force-non-stream", FORMATS.CLAUDE);
    expect(output.status).toBe(502);
    expect((await output.json()).error.message).toBe("busy");
  });
});

describe("Responses API 原生响应转换", () => {
  it("完整output生成原生工具、text、reasoning事件并无损聚合终态", async () => {
    const stream = await enforceResponseMode(jsonResponse(responses), "force-stream", FORMATS.OPENAI_RESPONSES);
    const text = await stream.text();
    const chunks = eventsFrom(text);
    expect(chunks[0].type).toBe("response.created");
    expect(chunks[1].type).toBe("response.in_progress");
    expect(chunks.map((chunk) => chunk.sequence_number)).toEqual(chunks.map((_, index) => index));
    expect(chunks.some((chunk) => chunk.type === "response.function_call_arguments.delta" && chunk.delta === responses.output[2].arguments)).toBe(true);
    expect(chunks.some((chunk) => chunk.type === "response.custom_tool_call_input.done" && chunk.input === "printf hello")).toBe(true);
    expect(chunks.some((chunk) => chunk.type === "response.reasoning_summary_text.delta" && chunk.delta === "思考")).toBe(true);
    expect(chunks.filter((chunk) => chunk.type === "response.output_item.done").map((chunk) => chunk.item)).toEqual(responses.output);
    expect(chunks.at(-1).response).toEqual(responses);
    const output = await enforceResponseMode(sseResponse(text), "force-non-stream", FORMATS.OPENAI_RESPONSES);
    expect(output.status).toBe(200);
    expect(await output.json()).toEqual(responses);
  });

  it("incomplete状态及详情保持非错误终态", async () => {
    const body = { ...responses, status: "incomplete", incomplete_details: { reason: "max_output_tokens" } };
    const stream = await enforceResponseMode(jsonResponse(body), "force-stream", FORMATS.OPENAI_RESPONSES);
    const text = await stream.text();
    expect(eventsFrom(text).at(-1).type).toBe("response.incomplete");
    const output = await enforceResponseMode(sseResponse(text), "force-non-stream", FORMATS.OPENAI_RESPONSES);
    expect(output.status).toBe(200);
    expect(await output.json()).toEqual(body);
  });

  it("终态未附output时复用output_item.done保留原生函数调用", async () => {
    const { output, ...terminal } = responses;
    const text = event({ type: "response.created", response: { id: responses.id, model: responses.model } }, "response.created")
      + output.map((item, output_index) => event({ type: "response.output_item.done", output_index, item }, "response.output_item.done")).join("")
      + event({ type: "response.completed", response: terminal }, "response.completed");
    const result = await (await enforceResponseMode(sseResponse(text), "force-non-stream", FORMATS.OPENAI_RESPONSES)).json();
    expect(result.output).toEqual(output);
    expect(result.usage).toEqual(responses.usage);
    expect(result.model).toBe(responses.model);
  });

  it.each(["response.failed", "error"])("%s不被转成成功JSON", async (type) => {
    const text = event(type === "error" ? { type, error: { message: "failed", status: 429 } } : { type, response: { status: "failed", error: { message: "failed", status: 429 } } }, type);
    const output = await enforceResponseMode(sseResponse(text), "force-non-stream", FORMATS.OPENAI_RESPONSES);
    expect(output.status).toBe(429);
    expect((await output.json()).error.message).toBe("failed");
  });

  it("缺少Responses终态不能伪装成功", async () => {
    const output = await enforceResponseMode(sseResponse(event({ type: "response.created", response: { id: responses.id } }, "response.created")), "force-non-stream", FORMATS.OPENAI_RESPONSES);
    expect(output.status).toBe(502);
    expect((await output.json()).error.message).toContain("terminal");
  });
});

describe("原生Gemini CLI转换", () => {
  it("按候选聚合parts并保留工具、thinking及usage", async () => {
    const text = event({ response: { responseId: "gemini-a", candidates: [{ index: 1, content: { role: "model", parts: [{ text: "想", thought: true }, { text: "你" }] } }] } })
      + event({ response: { candidates: [{ index: 1, content: { role: "model", parts: [{ text: "好" }, { functionCall: { name: "tool", args: { a: 1 } } }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, thoughtsTokenCount: 2 } } });
    const output = await enforceResponseMode(sseResponse(text), "force-non-stream", FORMATS.GEMINI_CLI);
    const body = await output.json();
    expect(body.response.candidates[0].content.parts).toEqual([{ text: "想", thought: true }, { text: "你好" }, { functionCall: { name: "tool", args: { a: 1 } } }]);
    expect(body.response.usageMetadata.thoughtsTokenCount).toBe(2);
    const stream = await enforceResponseMode(jsonResponse(body), "force-stream", FORMATS.GEMINI_CLI);
    expect(eventsFrom(await stream.text())).toEqual([body]);
  });
});
