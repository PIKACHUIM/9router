// Context-budget guard (open-sse/rtk/contextBudget.js).
//
// Motivation: codebuddy-cn answered an oversized request with HTTP 400
// `11115 prompt is too long: 1436966 tokens > 1048576 maximum`. Before the
// accountFallback fix that 400 also walked the whole account pool; either way the
// user lost the turn. A local trim converts a hard rejection into a lossy reply.
import { describe, expect, it } from "vitest";
import {
  estimateTextTokens,
  estimateContextUsage,
  computeBudgetTokens,
  pickVictim,
  trimToContextBudget,
  formatContextBudgetLog,
  PER_MESSAGE_OVERHEAD_TOKENS,
} from "../../open-sse/rtk/contextBudget.js";

// ~10000 tokens per blob (40000 ASCII chars / 4)
const BIG = "x".repeat(40000);

function longChat() {
  return {
    model: "deepseek-v4.1-flash",
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "TASK: fix the bug" },
      { role: "assistant", content: BIG },
      { role: "user", content: BIG },
      { role: "assistant", content: BIG },
      { role: "user", content: BIG },
      { role: "assistant", content: BIG },
      { role: "user", content: "so what now?" },
    ],
  };
}

describe("token estimation", () => {
  it("counts ASCII at ~4 chars/token", () => {
    expect(estimateTextTokens("abcd")).toBe(1);
    expect(estimateTextTokens("x".repeat(40000))).toBe(10000);
  });

  it("counts CJK at ~1 token/char (plain chars/4 underestimates 4x)", () => {
    expect(estimateTextTokens("你好世界")).toBe(4);
    expect(estimateTextTokens("你好abcd")).toBe(3); // 2 CJK + 4/4
  });

  it("ignores empty / non-string input", () => {
    expect(estimateTextTokens("")).toBe(0);
    expect(estimateTextTokens(null)).toBe(0);
    expect(estimateTextTokens(42)).toBe(0);
  });

  it("does NOT count base64 media as prose (would inflate by orders of magnitude)", () => {
    const withImage = {
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image", source: { type: "base64", data: "A".repeat(400000) } },
        ],
      }],
    };
    expect(estimateContextUsage(withImage).tokens).toBeLessThan(100);
  });

  it("adds a per-message envelope cost", () => {
    const one = { messages: [{ role: "user", content: "abcd" }] };
    expect(estimateContextUsage(one).tokens).toBe(1 + PER_MESSAGE_OVERHEAD_TOKENS);
    expect(estimateContextUsage(one).messageCount).toBe(1);
  });

  it("counts tools, which it will never trim", () => {
    const withTools = { messages: [{ role: "user", content: "hi" }], tools: [{ name: "t", description: BIG }] };
    expect(estimateContextUsage(withTools).tokens).toBeGreaterThan(10000);
  });
});

describe("computeBudgetTokens", () => {
  it("uses 60% of the window by default", () => {
    expect(computeBudgetTokens(1000000)).toBe(600000);
  });

  it("returns null for an unknown window so callers skip trimming", () => {
    expect(computeBudgetTokens(undefined)).toBe(null);
    expect(computeBudgetTokens(0)).toBe(null);
    expect(computeBudgetTokens(NaN)).toBe(null);
  });

  it("honours an explicit ratio", () => {
    expect(computeBudgetTokens(100000, { ratio: 0.5 })).toBe(50000);
  });

  it("never shrinks below a usable floor", () => {
    expect(computeBudgetTokens(100000, { ratio: 0.001 })).toBeGreaterThanOrEqual(1024);
  });

  it("subtracts an output reserve", () => {
    expect(computeBudgetTokens(100000, { ratio: 0.8, reserveTokens: 10000 })).toBe(70000);
  });
});

describe("pickVictim safety rules", () => {
  it("never drops system, the task statement, or the live question", () => {
    const convo = longChat().messages;
    const victim = pickVictim(convo);
    expect(victim).toBeGreaterThanOrEqual(0);
    expect(convo[victim].role).not.toBe("system");
    expect(victim).not.toBe(1); // first user turn = task statement
    expect(victim).not.toBe(convo.length - 1); // live question
  });

  it("refuses below MIN_TRIMMABLE_MESSAGES", () => {
    expect(pickVictim([{ role: "user", content: "x" }, { role: "assistant", content: "y" }])).toBe(-1);
  });

  it("refuses when dropping would erase a role from the payload", () => {
    const convo = [
      { role: "system", content: "s" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
    ];
    expect(pickVictim(convo)).toBe(-1);
  });
});

describe("trimToContextBudget", () => {
  it("brings an oversized prompt under budget and keeps the task + question", () => {
    const body = longChat();
    const before = estimateContextUsage(body).tokens;
    const stats = trimToContextBudget(body, { contextWindow: 20000 });

    expect(stats.applied).toBe(true);
    expect(stats.trimmedCount).toBeGreaterThan(0);
    expect(stats.estimateAfter).toBeLessThan(before);
    expect(stats.estimateAfter).toBeLessThanOrEqual(stats.budgetTokens);

    const roles = body.messages.map((m) => m.role);
    expect(roles).toContain("system");
    expect(body.messages.some((m) => m.content === "TASK: fix the bug")).toBe(true);
    expect(body.messages[body.messages.length - 1].content).toBe("so what now?");
  });

  it("removes the messages from the REQUEST, not just a local view", () => {
    const body = longChat();
    const originalCount = body.messages.length;
    const stats = trimToContextBudget(body, { contextWindow: 20000 });
    expect(body.messages.length).toBe(originalCount - stats.trimmedCount);
  });

  it("tells the model that context was lost", () => {
    const body = longChat();
    trimToContextBudget(body, { contextWindow: 20000 });
    const systemText = JSON.stringify(body.messages.filter((m) => m.role === "system"));
    expect(systemText).toContain("9router");
    expect(systemText.toLowerCase()).toContain("trimmed");
  });

  it("is idempotent — a second pass must not erode context further", () => {
    const body = longChat();
    trimToContextBudget(body, { contextWindow: 20000 });
    const settled = estimateContextUsage(body).tokens;

    const second = trimToContextBudget(body, { contextWindow: 20000 });
    expect(second.reason).toBe("within-budget");
    expect(second.trimmedCount).toBe(0);
    expect(estimateContextUsage(body).tokens).toBe(settled);
  });

  it("leaves a request that already fits completely untouched", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    const stats = trimToContextBudget(body, { contextWindow: 1000000 });
    expect(stats.reason).toBe("within-budget");
    expect(stats.applied).toBe(false);
    expect(body.messages.length).toBe(1);
  });

  it("does nothing when the window is unknown (never trim on a guess)", () => {
    const body = { messages: [{ role: "user", content: BIG }] };
    const stats = trimToContextBudget(body, {});
    expect(stats.reason).toBe("unknown-context-window");
    expect(stats.applied).toBe(false);
    expect(body.messages.length).toBe(1);
  });

  it("passes through when there are too few messages to trim safely", () => {
    const body = { messages: [{ role: "system", content: "s" }, { role: "user", content: BIG }] };
    const stats = trimToContextBudget(body, { contextWindow: 1000 });
    expect(stats.reason).toBe("too-few-messages");
    expect(stats.applied).toBe(false);
  });

  it("handles the OpenAI Responses input[] shape", () => {
    const body = {
      input: [
        { type: "message", role: "system", content: [{ type: "input_text", text: "sys" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "TASK" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: BIG }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: BIG }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: BIG }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "now?" }] },
      ],
    };
    const stats = trimToContextBudget(body, { contextWindow: 20000 });
    expect(stats.applied).toBe(true);
    expect(body.input[body.input.length - 1].content[0].text).toBe("now?");
  });

  it("fails open on malformed bodies instead of throwing", () => {
    const weird = { messages: [{ role: "user", content: 42 }, null, { role: "assistant" }] };
    expect(() => trimToContextBudget(weird, { contextWindow: 100 })).not.toThrow();
    expect(() => trimToContextBudget(null, { contextWindow: 100 })).not.toThrow();
    expect(trimToContextBudget(null, { contextWindow: 100 }).reason).toBe("no-body");
  });
});

describe("formatContextBudgetLog", () => {
  it("stays silent when nothing happened", () => {
    expect(formatContextBudgetLog(null)).toBe(null);
    expect(formatContextBudgetLog({ applied: false, reason: "within-budget" })).toBe(null);
  });

  it("reports a successful trim with the token delta", () => {
    const line = formatContextBudgetLog({
      applied: true, trimmedCount: 4, droppedRoles: ["assistant", "user"],
      estimateBefore: 50059, estimateAfter: 10103, budgetTokens: 12000, contextWindow: 20000,
    });
    expect(line).toContain("trimmed 4 msg");
    expect(line).toContain("10103");
  });

  it("warns when it could not fit the request", () => {
    const line = formatContextBudgetLog({
      applied: false, reason: "nothing-safe-to-trim",
      estimateBefore: 99999, budgetTokens: 12000, contextWindow: 20000,
    });
    expect(line).toContain("passing through");
  });
});
