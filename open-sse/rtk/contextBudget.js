// Context-budget guard: shrink an over-long request BEFORE dispatch so the upstream
// does not reject it with "prompt is too long" (codebuddy 11115 /
// context_length_exceeded). Fail-open: on any doubt the body is left untouched.
//
// Why this exists rather than trusting the provider:
//   The gateway rejects the whole call with HTTP 400 and the request burns a round
//   trip (and, before the accountFallback fix, walked the entire account pool).
//   A local trim turns "hard failure" into "slightly lossy but answered".
//
// Design constraints:
//   - Estimate only. No tokenizer dependency, so CJK must be corrected: the plain
//     chars/4 rule underestimates Chinese/Japanese by up to 4x, which is exactly
//     the payload that overflows. Same heuristic as qoder/contextTier.js.
//   - Idempotent + monotonic: a second pass over an already-fitted body must be a
//     no-op, otherwise retries keep eroding context.
//   - Never touch system/tools/recent turns: those carry the task. Stale middle
//     turns of the same role are trimmed instead (see pickVictim).
import { injectSystemPrompt } from "./systemInject.js";

/** Target share of the window a prompt may occupy; the rest absorbs estimator error + output. */
export const CONTEXT_BUDGET_RATIO = 0.6;

/** Below this many messages, trimming does more harm than good — let the provider answer. */
export const MIN_TRIMMABLE_MESSAGES = 4;

/** Cost of a message envelope (role, ids, json punctuation) in tokens. */
export const PER_MESSAGE_OVERHEAD_TOKENS = 4;

/** Cap on the synthetic system notice so a 1-line history is not dominated by it. */
export const MAX_NOTICE_TOKENS = 512;

const CJK_RE = /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/g;

/**
 * Token estimate for one string. CJK chars count ~1 token, everything else ~1/4.
 * @param {string} text
 * @returns {number}
 */
export function estimateTextTokens(text) {
  if (typeof text !== "string" || text.length === 0) return 0;
  const cjk = (text.match(CJK_RE) || []).length;
  return Math.ceil(cjk + (text.length - cjk) / 4);
}

/**
 * Walk the message-shaped arrays of a body and total their token estimate.
 *
 * Handles every wire shape the translator can emit: OpenAI/Claude `messages[]`
 * (string or typed blocks), OpenAI Responses `input[]`, Gemini `contents[]`. Depth
 * is capped: an image block carries base64, and recursing into it would count the
 * base64 as prose and produce a wildly inflated estimate.
 *
 * @param {any} node
 * @param {number} [depth]
 * @returns {number}
 */
export function estimateTokensDeep(node, depth = 0) {
  if (node == null || depth > 8) return 0;
  if (typeof node === "string") return estimateTextTokens(node);
  if (typeof node !== "object") return 0;
  if (Array.isArray(node)) {
    let sum = 0;
    for (const item of node) sum += estimateTokensDeep(item, depth + 1);
    return sum;
  }

  // Media payloads: never counted as text (avoids a base64 blow-up).
  if (isMediaNode(node)) return 0;

  let sum = 0;
  for (const key of Object.keys(node)) {
    sum += estimateTokensDeep(node[key], depth + 1);
  }
  return sum;
}

function isMediaNode(node) {
  const t = node.type;
  if (t === "image" || t === "image_url" || t === "input_image" || t === "audio" || t === "input_audio") return true;
  if (node.image_url || node.image || node.source?.type === "base64") return true;
  if (node.inline_data || node.inlineData) return true;
  return false;
}

/** Message arrays of a body, across all supported wire shapes. */
export function getMessageArrays(body) {
  if (!body || typeof body !== "object") return [];
  if (body.conversationState) {
    const cs = body.conversationState;
    return [Array.isArray(cs.history) ? cs.history : null, cs.currentMessage ? [cs.currentMessage] : null].filter(Boolean);
  }
  return [body.messages, body.input, body.contents].filter(Array.isArray);
}

/**
 * All messages of the body, flattened across shapes.
 *
 * IMPORTANT: returns the SAME element references held by the body's arrays — but
 * as a NEW container. Mutating the returned array (splice/filter) does NOT touch
 * the body. Callers that need to delete from the request must remove the element
 * from its owning array (see `removeMessage`).
 */
export function collectMessages(body) {
  return getMessageArrays(body).flat();
}

/**
 * Delete one message by identity from whichever array owns it.
 * Identity-based on purpose: `pickVictim` indexes into the flattened view, which
 * does not map back to (array, index) when the body has several message arrays.
 *
 * @param {object} body
 * @param {any} message - the exact object reference to remove
 * @returns {boolean} true when it was found and removed
 */
export function removeMessage(body, message) {
  for (const arr of getMessageArrays(body)) {
    const idx = arr.indexOf(message);
    if (idx >= 0) {
      arr.splice(idx, 1);
      return true;
    }
  }
  return false;
}

/** Tools are worth counting (a big OpenAPI schema can be tens of thousands of tokens) but never trimmed. */
function estimateToolsTokens(body) {
  if (!body) return 0;
  if (Array.isArray(body.tools)) return estimateTokensDeep(body.tools);
  if (Array.isArray(body.toolConfig)) return estimateTokensDeep(body.toolConfig);
  return 0;
}

/**
 * Prompt size estimate for a complete provider-format body.
 * @param {object} body
 * @returns {{ tokens: number, messageCount: number }}
 */
export function estimateContextUsage(body) {
  const arrays = getMessageArrays(body);
  const messages = arrays.flat();
  let tokens = 0;
  for (const arr of arrays) tokens += estimateTokensDeep(arr);
  tokens += estimateToolsTokens(body);
  // The per-message envelope (role + punctuation) is not free.
  tokens += messages.length * PER_MESSAGE_OVERHEAD_TOKENS;
  return { tokens, messageCount: messages.length };
}

/**
 * How many tokens the request may occupy. Deliberately conservative: the estimator
 * is a heuristic, and the window must also fit the model's output.
 *
 * @param {number|null|undefined} contextWindow
 * @param {object} [options]
 * @param {number} [options.ratio]
 * @param {number} [options.reserveTokens] - output headroom subtracted from the window
 * @param {number} [options.maxOutput]
 * @returns {number|null} null when the window is unknown (→ caller must skip trimming)
 */
export function computeBudgetTokens(contextWindow, options = {}) {
  const limit = Number(contextWindow);
  if (!Number.isFinite(limit) || limit <= 0) return null;

  const ratio = Number.isFinite(options.ratio) && options.ratio > 0 ? options.ratio : CONTEXT_BUDGET_RATIO;
  const budget = Math.floor(limit * ratio);

  // Never reserve so much that a sane window leaves no room for the prompt.
  const reserve = Number.isFinite(options.reserveTokens) && options.reserveTokens > 0 ? options.reserveTokens : 0;
  const floor = Math.max(1024, Math.floor(limit * 0.1));
  return Math.max(floor, budget - reserve);
}

/**
 * Pick the message to drop when over budget.
 *
 * Rules, in order:
 *   1. Never the system/developer turn, never the first user turn — that is the
 *      task statement and deleting it makes the reply worthless.
 *   2. Never the last message — that is the live question.
 *   3. Among the rest, prefer the OLDEST message whose role already appears more
 *      than once in the kept window, so alternation/shape stays plausible and no
 *      role disappears entirely. Ties → the larger message (fastest convergence).
 *
 * @param {any[]} messages
 * @returns {number} index to drop, or -1 when nothing is safe to drop
 */
export function pickVictim(messages) {
  if (!Array.isArray(messages) || messages.length < MIN_TRIMMABLE_MESSAGES) return -1;

  const protectedIdx = new Set([messages.length - 1]);
  for (let i = 0; i < messages.length; i++) {
    const role = messages[i]?.role;
    if (role === "system" || role === "developer") protectedIdx.add(i);
  }
  // First user turn = the task statement.
  const firstUser = messages.findIndex((m) => m?.role === "user");
  if (firstUser >= 0) protectedIdx.add(firstUser);

  // Role census over the candidates only. A role is `protected` when it has no
  // candidate left to drop, so we can never delete the last free-standing member.
  const counts = new Map();
  for (const idx of protectedIdx) {
    const role = messages[idx]?.role;
    if (role) counts.set(role, (counts.get(role) || 0) + 1);
  }
  for (let i = 0; i < messages.length; i++) {
    if (protectedIdx.has(i)) continue;
    const role = messages[i]?.role ?? "";
    counts.set(role, (counts.get(role) || 0) + 1);
  }

  const protectedRoles = new Set();
  for (const [role, total] of counts) {
    let candidates = 0;
    for (let i = 0; i < messages.length; i++) {
      if (protectedIdx.has(i)) continue;
      if ((messages[i]?.role ?? "") === role) candidates++;
    }
    // Dropping one would erase the role from the payload entirely.
    if (total < 2 || candidates < 1) protectedRoles.add(role);
  }

  let best = -1;
  let bestSize = -1;
  for (let i = 0; i < messages.length; i++) {
    if (protectedIdx.has(i)) continue;
    const role = messages[i]?.role ?? "";
    if (protectedRoles.has(role)) continue;
    const size = estimateTokensDeep(messages[i]);
    if (size > bestSize) {
      bestSize = size;
      best = i;
    }
  }
  return best;
}

function buildNotice(estimate, budget, trimmedCount) {
  const notice =
    `[9router] ${trimmedCount} earlier message(s) were removed from this conversation ` +
    `because the prompt (~${estimate} tokens) exceeded the ${budget}-token context budget. ` +
    `Anything only present in those messages is no longer available. ` +
    `Re-read a file or restate a requirement if it is still needed.`;
  return estimateTextTokens(notice) > MAX_NOTICE_TOKENS
    ? `[9router] Earlier messages were trimmed: prompt ~${estimate} tokens exceeded the ${budget}-token budget.`
    : notice;
}

/**
 * Trim a provider-format body so its prompt fits `budgetTokens`.
 *
 * Mutates `body` in place (the caller already owns a translated copy) and returns
 * stats. Fail-open: any internal error leaves the body as it was.
 *
 * @param {object} body
 * @param {object} options
 * @param {number} options.contextWindow - model input window in tokens
 * @param {number} [options.ratio]
 * @param {number} [options.reserveTokens]
 * @param {string} [options.model] - for logging only
 * @param {string} [options.provider] - for logging only
 * @returns {{ applied: boolean, reason?: string, estimateBefore: number, estimateAfter: number, budgetTokens: number|null, contextWindow: number|null, trimmedCount: number, droppedRoles: string[] }}
 */
export function trimToContextBudget(body, options = {}) {
  const contextWindow = Number(options.contextWindow) > 0 ? Number(options.contextWindow) : null;
  const budgetTokens = computeBudgetTokens(contextWindow, options);
  const stats = {
    applied: false,
    estimateBefore: 0,
    estimateAfter: 0,
    budgetTokens,
    contextWindow,
    trimmedCount: 0,
    droppedRoles: [],
  };

  try {
    if (!body || typeof body !== "object") return { ...stats, reason: "no-body" };
    if (budgetTokens == null) return { ...stats, reason: "unknown-context-window" };

    const before = estimateContextUsage(body);
    stats.estimateBefore = before.tokens;

    if (before.tokens <= budgetTokens) {
      stats.estimateAfter = before.tokens;
      return { ...stats, reason: "within-budget" };
    }

    const messages = collectMessages(body);
    if (messages.length < MIN_TRIMMABLE_MESSAGES) {
      stats.estimateAfter = before.tokens;
      return { ...stats, reason: "too-few-messages" };
    }

    let trimmed = 0;
    let currentTokens = before.tokens;
    const droppedRoles = [];
    // Bounded: every iteration removes exactly one element, so this terminates.
    // Re-estimates the whole body each pass (splice indexes shift) which is O(n)
    // per removal and O(n^2) overall — fine for realistic message counts, and it
    // keeps correctness obvious instead of maintaining a running delta.
    while (currentTokens > budgetTokens) {
      const victim = pickVictim(messages);
      if (victim < 0) break;

      const victimMsg = messages[victim];
      droppedRoles.push(victimMsg?.role ?? "?");
      // Remove from the OWNING array, not the flattened view: `messages` is a new
      // container, so splicing it would leave the request untouched. The local
      // view must drop it too, otherwise pickVictim re-reads a ghost message.
      if (!removeMessage(body, victimMsg)) break;
      messages.splice(victim, 1);
      trimmed++;

      const after = estimateContextUsage(body);
      // Progress guard: if deleting did not reduce the estimate we are done
      // (defends against pathological shapes rather than looping forever).
      if (after.tokens >= currentTokens) {
        currentTokens = after.tokens;
        break;
      }
      currentTokens = after.tokens;
    }
    stats.estimateAfter = currentTokens;

    stats.trimmedCount = trimmed;
    stats.droppedRoles = droppedRoles;

    if (trimmed === 0) {
      return { ...stats, reason: "nothing-safe-to-trim" };
    }

    // Tell the model (and the user) that context was lost. Without this the model
    // silently hallucinates over the gap.
    const notice = buildNotice(before.tokens, budgetTokens, trimmed);
    injectSystemPrompt(body, options.format, notice);

    const final = estimateContextUsage(body);
    stats.estimateAfter = final.tokens;
    stats.applied = true;
    return stats;
  } catch (e) {
    // Fail-open: never break a request over a budget guess.
    return { ...stats, applied: false, reason: `error: ${e?.message || "unknown"}` };
  }
}

/**
 * One-line log for a trim decision, or null when nothing noteworthy happened.
 * @param {object} stats
 * @returns {string|null}
 */
export function formatContextBudgetLog(stats) {
  if (!stats) return null;
  if (!stats.applied) {
    // Only worth a line when we genuinely could not fit the request.
    if (stats.reason === "nothing-safe-to-trim" || stats.reason === "too-few-messages") {
      return `[CTX] overhead ~${stats.estimateBefore} tok > budget ${stats.budgetTokens} (window ${stats.contextWindow}) — ${stats.reason}, passing through`;
    }
    return null;
  }
  return `[CTX] trimmed ${stats.trimmedCount} msg (${stats.droppedRoles.join(",")}) · ~${stats.estimateBefore} → ~${stats.estimateAfter} tok (budget ${stats.budgetTokens}, window ${stats.contextWindow})`;
}
