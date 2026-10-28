import { FORMATS } from "../translator/formats.js";
import { parseSSEToOpenAIResponse } from "../handlers/chatCore/sseToJsonHandler.js";
import { convertResponsesStreamToJson } from "../transformer/streamToJsonConverter.js";

const FORCED_MODES = new Set(["force-stream", "force-non-stream"]);
const RESPONSES_FORMATS = new Set([FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI_RESPONSE]);
const GEMINI_FORMATS = new Set([FORMATS.GEMINI, FORMATS.GEMINI_CLI, FORMATS.ANTIGRAVITY]);

export function applyResponseMode(body, mode) {
  if (!FORCED_MODES.has(mode)) return body;
  const next = { ...body, stream: mode === "force-stream" };
  if (!next.stream) delete next.stream_options;
  return next;
}

function convertedHeaders(response, streaming) {
  const headers = new Headers(response.headers);
  for (const name of ["content-length", "content-encoding", "transfer-encoding"]) headers.delete(name);
  headers.set("content-type", streaming ? "text/event-stream; charset=utf-8" : "application/json; charset=utf-8");
  if (streaming) {
    headers.set("cache-control", "no-cache");
    headers.set("connection", "keep-alive");
    headers.set("x-accel-buffering", "no");
  } else {
    headers.delete("connection");
    headers.delete("x-accel-buffering");
  }
  return headers;
}

function errorResponse(response, error, fallback = "Invalid upstream response") {
  const detail = error && typeof error === "object" ? { ...error } : { message: typeof error === "string" ? error : fallback };
  const status = Number(detail.status ?? detail.status_code ?? detail.http_status ?? detail.code);
  const validStatus = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502;
  detail.message ||= fallback;
  detail.type ||= "upstream_response_error";
  return new Response(JSON.stringify({ error: detail }), {
    status: validStatus,
    headers: convertedHeaders(response, false)
  });
}

function parseEvents(text) {
  const events = [];
  for (const record of text.replace(/\r\n?/g, "\n").split(/\n\s*\n/)) {
    let event;
    const data = [];
    for (const line of record.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (!data.length) continue;
    const payload = data.join("\n");
    if (payload.trim() === "[DONE]") {
      events.push({ event: "done", done: true });
      continue;
    }
    let value;
    try { value = JSON.parse(payload); }
    catch { throw new Error("Invalid JSON in upstream SSE response"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid upstream SSE event");
    events.push({ event: event || value.type, data: value });
  }
  if (!events.some((event) => event.data)) throw new Error("Invalid or empty upstream SSE response");
  return events;
}

function findStreamError(events) {
  for (const { event, data } of events) {
    if (!data) continue;
    if (data.error || data.response?.error || event === "error" || event === "response.failed" || data.response?.status === "failed") {
      const error = data.error || data.response?.error || { message: data.message || "Upstream SSE stream failed" };
      return typeof error === "object"
        ? { ...error, status: error.status ?? data.status ?? data.status_code ?? data.response?.status_code }
        : { message: String(error), status: data.status ?? data.status_code };
    }
  }
  return null;
}

function eventText(data, event) {
  return `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`;
}

function openAIToSSE(body, model) {
  if (!Array.isArray(body.choices) || !body.choices.length || body.choices.some((choice) => !choice.message || typeof choice.message !== "object")) {
    throw new Error("Invalid OpenAI JSON response: missing choices.message");
  }
  const { choices, usage, ...metadata } = body;
  const base = { ...metadata, id: body.id || `chatcmpl-${Date.now()}`, model: body.model || model || "unknown", object: "chat.completion.chunk" };
  const deltas = choices.map((choice, index) => ({
    ...choice,
    index: choice.index ?? index,
    message: undefined,
    delta: {
      ...choice.message,
      ...(choice.message.tool_calls ? { tool_calls: choice.message.tool_calls.map((tool, toolIndex) => ({ ...tool, index: tool.index ?? toolIndex })) } : {})
    },
    finish_reason: null
  }));
  const stops = choices.map((choice, index) => ({ index: choice.index ?? index, delta: {}, finish_reason: choice.finish_reason ?? "stop" }));
  return eventText({ ...base, choices: deltas })
    + eventText({ ...base, choices: stops })
    + (usage ? eventText({ ...base, choices: [], usage }) : "")
    + "data: [DONE]\n\n";
}

function openAIFromSSE(events, model) {
  const chunks = events.filter((event) => event.data).map((event) => event.data);
  const indexes = new Set();
  for (const chunk of chunks) {
    if (!Array.isArray(chunk.choices)) throw new Error("Invalid OpenAI SSE response: missing choices");
    for (const choice of chunk.choices) {
      if (!choice.delta || typeof choice.delta !== "object") throw new Error("Invalid OpenAI SSE response: missing delta");
      indexes.add(choice.index ?? 0);
    }
  }
  if (!indexes.size) throw new Error("Invalid OpenAI SSE response: no choices");
  const choices = [];
  let result;
  for (const index of [...indexes].sort((a, b) => a - b)) {
    const selected = chunks.map((chunk) => ({ ...chunk, choices: chunk.choices.filter((choice) => (choice.index ?? 0) === index) }));
    if (!events.some((event) => event.done) && !selected.some((chunk) => chunk.choices.some((choice) => choice.finish_reason != null))) {
      throw new Error("Incomplete OpenAI SSE response");
    }
    const parsed = parseSSEToOpenAIResponse(selected.map((chunk) => eventText(chunk)).join(""), model);
    result ||= parsed;
    const choice = { ...parsed.choices[0], index };
    const tools = new Map();
    for (const chunk of selected) {
      const source = chunk.choices[0];
      if (!source) continue;
      const delta = source.delta;
      if (delta.role) choice.message.role = delta.role;
      for (const [key, value] of Object.entries(delta)) {
        if (["role", "content", "reasoning_content", "reasoning", "tool_calls"].includes(key)) continue;
        if (key === "function_call") {
          choice.message.function_call ||= {};
          for (const [field, part] of Object.entries(value || {})) {
            choice.message.function_call[field] = (choice.message.function_call[field] || "") + part;
          }
        } else if (typeof value === "string") {
          choice.message[key] = (choice.message[key] || "") + value;
        } else if (Array.isArray(value)) {
          choice.message[key] = [...(choice.message[key] || []), ...value];
        } else {
          choice.message[key] = value;
        }
      }
      if (typeof delta.reasoning === "string") choice.message.reasoning = (choice.message.reasoning || "") + delta.reasoning;
      if (Array.isArray(delta.content)) {
        choice.message.content = [...(Array.isArray(choice.message.content) ? choice.message.content : []), ...delta.content];
      }
      if (source.logprobs != null) {
        choice.logprobs ||= {};
        for (const [key, values] of Object.entries(source.logprobs)) {
          choice.logprobs[key] = Array.isArray(values) ? [...(choice.logprobs[key] || []), ...values] : values;
        }
      }
      for (const tool of delta.tool_calls || []) {
        const toolIndex = tool.index ?? 0;
        let target = tools.get(toolIndex);
        if (!target) { target = {}; tools.set(toolIndex, target); }
        for (const [key, value] of Object.entries(tool)) {
          if (key === "index") continue;
          if (key === "function" || key === "custom") {
            target[key] ||= {};
            for (const [field, part] of Object.entries(value || {})) {
              target[key][field] = typeof part === "string" ? (target[key][field] || "") + part : part;
            }
          } else target[key] = value;
        }
      }
    }
    if (tools.size) choice.message.tool_calls = [...tools].sort(([a], [b]) => a - b).map(([, tool]) => tool);
    choices.push(choice);
  }
  return { ...result, choices };
}

function claudeToSSE(body) {
  if (body.type !== "message" || !Array.isArray(body.content)) throw new Error("Invalid Claude JSON response: missing message content");
  let text = eventText({ type: "message_start", message: { ...body, content: [], stop_reason: null, stop_sequence: null, usage: { ...body.usage, output_tokens: 0 } } }, "message_start");
  body.content.forEach((block, index) => {
    let initial = { ...block };
    const deltas = [];
    if (block.type === "text") {
      initial.text = "";
      deltas.push({ type: "text_delta", text: block.text || "" });
    } else if (block.type === "thinking") {
      initial.thinking = "";
      if (block.signature !== undefined) initial.signature = "";
      deltas.push({ type: "thinking_delta", thinking: block.thinking || "" });
      if (block.signature !== undefined) deltas.push({ type: "signature_delta", signature: block.signature });
    } else if (block.type === "tool_use") {
      initial.input = {};
      deltas.push({ type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) });
    }
    text += eventText({ type: "content_block_start", index, content_block: initial }, "content_block_start");
    for (const delta of deltas) text += eventText({ type: "content_block_delta", index, delta }, "content_block_delta");
    text += eventText({ type: "content_block_stop", index }, "content_block_stop");
  });
  text += eventText({ type: "message_delta", delta: { stop_reason: body.stop_reason ?? "end_turn", stop_sequence: body.stop_sequence ?? null }, usage: body.usage || {} }, "message_delta");
  return text + eventText({ type: "message_stop" }, "message_stop");
}

function claudeFromSSE(events) {
  let message;
  let stopped = false;
  const blocks = new Map();
  const open = new Set();
  const inputs = new Map();
  for (const { event, data } of events) {
    if (!data || event === "ping") continue;
    if (stopped) throw new Error("Invalid Claude SSE event after message_stop");
    if (event === "message_start") {
      if (message || !data.message || !Array.isArray(data.message.content)) throw new Error("Invalid Claude message_start event");
      message = { ...data.message, content: [...data.message.content], usage: { ...data.message.usage } };
    } else if (event === "content_block_start") {
      if (!message || blocks.has(data.index) || !data.content_block) throw new Error("Invalid Claude content_block_start event");
      blocks.set(data.index, structuredClone(data.content_block));
      open.add(data.index);
    } else if (event === "content_block_delta") {
      const block = blocks.get(data.index);
      if (!block || !open.has(data.index)) throw new Error("Invalid Claude content_block_delta event");
      const delta = data.delta || {};
      if (delta.type === "input_json_delta") inputs.set(data.index, (inputs.get(data.index) || "") + (delta.partial_json || ""));
      else if (delta.type === "citations_delta") block.citations = [...(block.citations || []), delta.citation];
      else {
        const field = { text_delta: "text", thinking_delta: "thinking", signature_delta: "signature" }[delta.type];
        if (!field) throw new Error("Unsupported Claude content block delta");
        block[field] = (block[field] || "") + (delta[field] || "");
      }
    } else if (event === "content_block_stop") {
      if (!open.delete(data.index)) throw new Error("Invalid Claude content_block_stop event");
      if (inputs.has(data.index)) {
        try { blocks.get(data.index).input = JSON.parse(inputs.get(data.index)); }
        catch { throw new Error("Invalid Claude tool input JSON"); }
      }
    } else if (event === "message_delta") {
      if (!message) throw new Error("Claude stream missing message_start");
      Object.assign(message, data.delta);
      Object.assign(message.usage, data.usage);
    } else if (event === "message_stop") stopped = true;
  }
  if (!message || !stopped || open.size) throw new Error("Incomplete Claude SSE response: missing message_stop or content_block_stop");
  message.content.push(...[...blocks].sort(([a], [b]) => a - b).map(([, block]) => block));
  return message;
}

function responsesToSSE(body) {
  if (!Array.isArray(body.output)) throw new Error("Invalid Responses JSON response: missing output");
  let sequence = 0;
  let text = "";
  const emit = (type, data) => { text += eventText({ type, sequence_number: sequence++, ...data }, type); };
  const pending = { ...body, status: "in_progress", output: [], usage: null, error: null };
  emit("response.created", { response: pending });
  emit("response.in_progress", { response: pending });
  body.output.forEach((item, output_index) => {
    const item_id = item.id;
    const refs = { item_id, output_index };
    const initial = { ...item, status: "in_progress" };
    if (item.type === "message") initial.content = [];
    if (item.type === "reasoning") initial.summary = [];
    if (item.type === "function_call") initial.arguments = "";
    if (item.type === "custom_tool_call") initial.input = "";
    emit("response.output_item.added", { output_index, item: initial });
    for (const [content_index, part] of (item.content || []).entries()) {
      const partRefs = { ...refs, content_index };
      const initialPart = { ...part };
      if (part.type === "output_text") { initialPart.text = ""; initialPart.annotations = []; }
      if (part.type === "refusal") initialPart.refusal = "";
      emit("response.content_part.added", { ...partRefs, part: initialPart });
      if (part.type === "output_text") {
        emit("response.output_text.delta", { ...partRefs, delta: part.text || "", logprobs: part.logprobs || [] });
        (part.annotations || []).forEach((annotation, annotation_index) => emit("response.output_text.annotation.added", { ...partRefs, annotation_index, annotation }));
        emit("response.output_text.done", { ...partRefs, text: part.text || "", logprobs: part.logprobs || [] });
      } else if (part.type === "refusal") {
        emit("response.refusal.delta", { ...partRefs, delta: part.refusal || "" });
        emit("response.refusal.done", { ...partRefs, refusal: part.refusal || "" });
      }
      emit("response.content_part.done", { ...partRefs, part });
    }
    for (const [summary_index, part] of (item.summary || []).entries()) {
      const partRefs = { ...refs, summary_index };
      emit("response.reasoning_summary_part.added", { ...partRefs, part: { ...part, text: "" } });
      emit("response.reasoning_summary_text.delta", { ...partRefs, delta: part.text || "" });
      emit("response.reasoning_summary_text.done", { ...partRefs, text: part.text || "" });
      emit("response.reasoning_summary_part.done", { ...partRefs, part });
    }
    if (item.type === "function_call") {
      emit("response.function_call_arguments.delta", { ...refs, delta: item.arguments || "" });
      emit("response.function_call_arguments.done", { ...refs, arguments: item.arguments || "", name: item.name });
    } else if (item.type === "custom_tool_call") {
      emit("response.custom_tool_call_input.delta", { ...refs, delta: item.input || "" });
      emit("response.custom_tool_call_input.done", { ...refs, input: item.input || "" });
    }
    emit("response.output_item.done", { output_index, item });
  });
  const status = body.status || "completed";
  if (!["completed", "incomplete", "failed"].includes(status)) throw new Error("Responses JSON has no terminal status");
  emit(`response.${status}`, { response: { ...body, status } });
  return text;
}

async function responsesFromSSE(events) {
  const terminal = events.findLast((event) => ["response.completed", "response.done", "response.incomplete"].includes(event.event));
  if (!terminal?.data?.response) throw new Error("Incomplete Responses SSE response: missing terminal response");
  const text = events.filter((event) => event.data).map(({ event, data }) => eventText(data, event)).join("");
  const base = await convertResponsesStreamToJson(new Response(text).body);
  const response = terminal.data.response;
  const created = events.find((event) => event.event === "response.created")?.data?.response || {};
  return { ...base, ...created, ...response, status: terminal.event === "response.incomplete" ? "incomplete" : "completed", output: response.output ?? base.output, usage: response.usage ?? base.usage };
}

function geminiToSSE(body) {
  const result = body.response || body;
  if (!Array.isArray(result.candidates)) throw new Error("Invalid Gemini JSON response: missing candidates");
  return eventText(body);
}

function geminiFromSSE(events) {
  const candidates = new Map();
  let result = {};
  let enveloped = false;
  for (const { data } of events) {
    if (!data) continue;
    enveloped ||= Boolean(data.response);
    const chunk = data.response || data;
    if (!Array.isArray(chunk.candidates) && !chunk.usageMetadata) throw new Error("Invalid Gemini SSE response");
    const { candidates: incoming, ...metadata } = chunk;
    result = { ...result, ...metadata };
    for (const [position, candidate] of (incoming || []).entries()) {
      const index = candidate.index ?? position;
      const previous = candidates.get(index);
      const parts = [...(previous?.content?.parts || [])];
      for (const part of candidate.content?.parts || []) {
        const last = parts.at(-1);
        if (typeof part.text === "string" && typeof last?.text === "string" && part.thought === last.thought && !part.thoughtSignature && !last.thoughtSignature) last.text += part.text;
        else parts.push(structuredClone(part));
      }
      candidates.set(index, { ...previous, ...candidate, index, content: { ...previous?.content, ...candidate.content, parts } });
    }
  }
  if (!candidates.size || (!events.some((event) => event.done) && [...candidates.values()].some((candidate) => !candidate.finishReason))) {
    throw new Error("Incomplete Gemini SSE response");
  }
  result.candidates = [...candidates].sort(([a], [b]) => a - b).map(([, candidate]) => candidate);
  return enveloped ? { response: result } : result;
}

export async function enforceResponseMode(response, mode, sourceFormat, model) {
  if (!FORCED_MODES.has(mode) || !response.ok) return response;
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  const isSSE = contentType.includes("text/event-stream");
  if (mode === "force-stream" && isSSE) return response;
  if (mode === "force-non-stream" && !isSSE && contentType.includes("application/json")) return response;
  try {
    if (!isSSE) {
      const body = await response.json();
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid upstream JSON response");
      if (body.error || body.status === "failed") return errorResponse(response, body.error, "Upstream JSON response failed");
      if (mode === "force-non-stream") {
        return new Response(JSON.stringify(body), { status: response.status, statusText: response.statusText, headers: convertedHeaders(response, false) });
      }
      const text = sourceFormat === FORMATS.CLAUDE ? claudeToSSE(body)
        : RESPONSES_FORMATS.has(sourceFormat) ? responsesToSSE(body)
          : GEMINI_FORMATS.has(sourceFormat) ? geminiToSSE(body) : openAIToSSE(body, model);
      return new Response(text, { status: response.status, statusText: response.statusText, headers: convertedHeaders(response, true) });
    }
    const events = parseEvents(await response.text());
    const error = findStreamError(events);
    if (error) return errorResponse(response, error, "Upstream SSE stream failed");
    const body = sourceFormat === FORMATS.CLAUDE ? claudeFromSSE(events)
      : RESPONSES_FORMATS.has(sourceFormat) ? await responsesFromSSE(events)
        : GEMINI_FORMATS.has(sourceFormat) ? geminiFromSSE(events) : openAIFromSSE(events, model);
    return new Response(JSON.stringify(body), { status: response.status, statusText: response.statusText, headers: convertedHeaders(response, false) });
  } catch (error) {
    return errorResponse(response, { message: `Response mode conversion failed: ${error.message}` });
  }
}
