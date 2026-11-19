// WorkBuddy prompt override ("覆盖提示词").
//
// Gateways that fingerprint the official desktop client compare more than the
// User-Agent: the system prompt is part of the fingerprint too. A converted
// channel can therefore replay the WorkBuddy system prompt verbatim so the
// upstream sees a request the real client would send.
//
// The default prompt is bundled in ./workbuddySystemPrompt.js; a node can
// replace it with its own text from the dashboard.

import { WORKBUDDY_SYSTEM_PROMPT } from "./workbuddySystemPrompt.js";

export const DEFAULT_CLIENT_SYSTEM_PROMPT = WORKBUDDY_SYSTEM_PROMPT;

// Guard against storing/sending an unbounded body.
export const MAX_PROMPT_CHARS = 400_000;

/**
 * Bound a user-supplied override. Newlines are meaningful in a prompt, so only
 * the length is capped.
 */
export function sanitizeClientSystemPrompt(value) {
  if (typeof value !== "string") return "";
  return value.slice(0, MAX_PROMPT_CHARS);
}

/**
 * The prompt a channel should send.
 *
 * Precedence: the node's own override text → the bundled WorkBuddy prompt
 * (WorkBuddy channels only) → nothing. Channels that merely present the
 * User-Agent keep the client's system prompt, which is what most relays expect.
 */
export function resolveClientSystemPrompt({ identity, credentials } = {}) {
  if (!identity) return "";
  const custom = sanitizeClientSystemPrompt(credentials?.providerSpecificData?.clientSystemPrompt).trim();
  if (custom) return custom;
  if (identity.id !== "workbuddy") return "";
  return DEFAULT_CLIENT_SYSTEM_PROMPT;
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
