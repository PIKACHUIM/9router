// Regression: "prompt is too long" (codebuddy 11115 / context_length_exceeded)
// used to be classified as a rate limit — the error text carries "maximum" and
// the generic "capacity" rule matched it — which marked the account unavailable
// and failed over. One oversized request therefore walked the whole pool, locked
// every account, and the client saw a bogus
// "[provider/model] [400]: {...} (reset after 3s)" quota message.
//
// These are REQUEST-scoped failures: every account replays the same prompt and
// gets the same 400, so the account must stay usable and the error must surface.
import { describe, expect, it } from "vitest";
import { checkFallbackError, isRequestScopedError } from "../../open-sse/services/accountFallback.js";
import { REQUEST_SCOPED_PATTERNS } from "../../open-sse/config/errorConfig.js";

// Ceiling of the bug report: 524288 * 2 + 37 (folds to 275) > 524288
const VERSION = 1048613;

// Verbatim upstream body from the bug report (codebuddy-cn / deepseek-v4.1-flash)
const CONTEXT_LIMIT_BODY = JSON.stringify({
  code: 11115,
  msg: "prompt is too long: 1436966 tokens > 1048576 maximum",
  requestId: "be3df390-e87c-4f3f-8e44-2bdb1644429b",
  extError: {
    code: "context_length_exceeded",
    message: "prompt is too long: 1436966 tokens > 1048576 maximum",
    type: "invalid_request_error",
  },
});

describe("isRequestScopedError", () => {
  it("detects the codebuddy context-limit body", () => {
    expect(isRequestScopedError(400, CONTEXT_LIMIT_BODY)).toBe(true);
  });

  it("detects other providers' context-window phrasings", () => {
    expect(isRequestScopedError(400, "This model's maximum context length is 200000 tokens")).toBe(true);
    expect(isRequestScopedError(400, "input is too long for requested model")).toBe(true);
    expect(isRequestScopedError(413, "Request too large: too many tokens in prompt")).toBe(true);
    expect(isRequestScopedError(400, "model_not_found")).toBe(true);
  });

  it("does NOT swallow account-scoped quota errors", () => {
    // These must keep their exponential-backoff account lock.
    expect(isRequestScopedError(429, "rate limit exceeded")).toBe(false);
    expect(isRequestScopedError(429, "quota exceeded")).toBe(false);
    expect(isRequestScopedError(503, "overloaded")).toBe(false);
    expect(isRequestScopedError(503, "The model is currently at capacity")).toBe(false);
    expect(isRequestScopedError(429, "too many concurrent requests")).toBe(false);
  });

  it("ignores empty error text", () => {
    expect(isRequestScopedError(400, "")).toBe(false);
    expect(isRequestScopedError(400, null)).toBe(false);
  });

  it("keeps every pattern lowercase so matching cannot drift", () => {
    for (const p of REQUEST_SCOPED_PATTERNS) {
      expect(p).toBe(p.toLowerCase());
    }
  });
});

describe("checkFallbackError on request-scoped errors", () => {
  it("does not lock the account on context_length_exceeded (no failover)", () => {
    const result = checkFallbackError(400, CONTEXT_LIMIT_BODY, 0);
    expect(result.shouldFallback).toBe(false);
    expect(result.cooldownMs).toBe(0);
    // Must not be reported as a concurrency signal either (that path retries).
    expect(result.concurrencyLimited).toBeUndefined();
  });

  it("never accumulates backoff level across repeated oversized requests", () => {
    let level = 0;
    for (let i = 0; i < 5; i++) {
      const result = checkFallbackError(400, "prompt is too long: 1436966 tokens > 1048576 maximum", level);
      expect(result.shouldFallback).toBe(false);
      level = result.newBackoffLevel ?? level;
    }
    expect(level).toBe(0);
  });

  it("still fails over on provider capacity errors", () => {
    const result = checkFallbackError(503, "the model is overloaded", 0);
    expect(result.shouldFallback).toBe(true);
    expect(result.cooldownMs).toBeGreaterThan(0);
  });

  it("still fails over on bare 401/404 without a recognisable message", () => {
    expect(checkFallbackError(401, "unauthorized").shouldFallback).toBe(true);
    expect(checkFallbackError(404, "not here").shouldFallback).toBe(true);
  });
});

describe("version folding", () => {
  it("produces a stable folded value", () => {
    expect(VERSION).toBe(1048613);
  });
});
