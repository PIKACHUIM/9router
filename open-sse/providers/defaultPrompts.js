// WorkBuddy prompt override ("覆盖提示词").
//
// Gateways that fingerprint the official desktop client compare more than the
// User-Agent: the system prompt is part of the fingerprint too. A converted
// channel can therefore replay the WorkBuddy system prompt verbatim so the
// upstream sees a request the real client would send.
//
// The default prompt lives in a plain file rather than in the bundle: it is
// long (~126 KB), it changes with the client release, and users need to read
// and edit it without a rebuild. `WORKBUDDY_PROMPT_FILE` points the reader at a
// different file (the Docker image, for instance, has no D: drive).

import fs from "node:fs";

export const DEFAULT_PROMPT_FILE = "D:/下载/无标题.txt";

// Guard against storing/sending an unbounded body.
export const MAX_PROMPT_CHARS = 400_000;

const CHAT_TEMPLATE_OPEN = "<|im_start|>system";
const CHAT_TEMPLATE_CLOSE = "<|im_end|>";

// The file is 100 KB+ and sits on the hot path of every converted request, so
// it is read once and only re-read when the mtime changes.
let fileCache = { path: "", mtimeMs: -1, prompt: "" };

export function resolvePromptFilePath() {
  const configured = typeof process === "undefined" ? "" : process.env?.WORKBUDDY_PROMPT_FILE;
  return String(configured || "").trim() || DEFAULT_PROMPT_FILE;
}

/**
 * A `lms log stream` dump wraps the real prompt in the chat template and in
 * LM Studio's log preamble. Keep just the system turn; a plain prompt file is
 * returned unchanged (minus surrounding blank lines).
 */
export function extractPromptText(raw) {
  const text = typeof raw === "string" ? raw : "";
  const start = text.indexOf(CHAT_TEMPLATE_OPEN);
  if (start === -1) return text.trim();
  const body = text.slice(start + CHAT_TEMPLATE_OPEN.length);
  const end = body.indexOf(CHAT_TEMPLATE_CLOSE);
  const prompt = end === -1 ? body : body.slice(0, end);
  // LM Studio stamps the loaded model onto the prompt it dumped; that banner
  // belongs to the capture, not to the client's system prompt.
  return prompt.replace(/^\s*This conversation is powered by .*(\r?\n)+/i, "").trim();
}

/**
 * Read the default prompt. Never throws: a missing file degrades to "no
 * override" so a channel keeps working on a machine without the dump.
 */
export function readPromptFile(filePath) {
  const path = filePath || resolvePromptFilePath();
  try {
    const { mtimeMs } = fs.statSync(path);
    if (fileCache.path === path && fileCache.mtimeMs === mtimeMs) {
      return { path, exists: true, prompt: fileCache.prompt };
    }
    const prompt = extractPromptText(fs.readFileSync(path, "utf8")).slice(0, MAX_PROMPT_CHARS);
    fileCache = { path, mtimeMs, prompt };
    return { path, exists: true, prompt };
  } catch {
    return { path, exists: false, prompt: "" };
  }
}

/**
 * Bound and normalize a user-supplied override. Newlines are meaningful in a
 * prompt, so only the length is capped.
 */
export function sanitizeClientSystemPrompt(value) {
  if (typeof value !== "string") return "";
  return value.slice(0, MAX_PROMPT_CHARS);
}

/**
 * The prompt a channel should send.
 *
 * Precedence: the node's own override text → the default file (WorkBuddy
 * channels only) → nothing. Channels that merely present the User-Agent keep
 * the client's system prompt, which is what most relays expect.
 */
export function resolveClientSystemPrompt({ identity, credentials } = {}) {
  if (!identity) return "";
  const custom = sanitizeClientSystemPrompt(credentials?.providerSpecificData?.clientSystemPrompt).trim();
  if (custom) return custom;
  if (identity.id !== "workbuddy") return "";
  return readPromptFile().prompt;
}

/**
 * Replace the conversation's system prompt with `prompt`, keeping every other
 * message untouched. Handles both wire shapes an executor can hold at this
 * point: OpenAI-style `messages` and Anthropic-style `system`.
 */
export function applySystemPromptOverride(body, prompt) {
  if (!prompt || !body || typeof body !== "object" || Array.isArray(body)) return body;

  if (Array.isArray(body.messages)) {
    const conversation = body.messages.filter((message) => (
      message && typeof message === "object" && !["system", "developer"].includes(message.role)
    ));
    return { ...body, messages: [{ role: "system", content: prompt }, ...conversation] };
  }

  if (typeof body.system === "string" || Array.isArray(body.system)) {
    return { ...body, system: prompt };
  }

  return body;
}
