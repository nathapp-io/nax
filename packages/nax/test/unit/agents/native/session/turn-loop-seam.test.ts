/**
 * US-002 — native loop event seam integration with `runNativeTurn`.
 *
 * Where `loop-events.test.ts` pins the dispatcher's contract at the unit
 * level, this file pins the loop's wiring of that dispatcher at every site
 * that produces a tool-result message:
 *
 *   - AC10–AC13: every "early-exit" tool-result path (budget exhausted, no
 *     operator reachable, ask-human answered, spin stop) bypasses `after_tool`.
 *     A registered handler must observe zero invocations for these branches.
 *   - AC14: a denied policy result flows through `after_tool` exactly once,
 *     and the `denied` field is preserved (a refused Write is not a crashed
 *     Write — ADR-029 s5).
 *   - AC15: a normal tool return flows through `after_tool` exactly once.
 *   - AC16: a tool throw flows through `after_tool` exactly once with
 *     `isError` true.
 *   - AC17: a model that repeats past the spin threshold answers every
 *     outstanding call and ends the loop — the same observable behavior as
 *     today.
 *   - AC18: an exhausted invalid-call budget ends the loop — the same
 *     observable behavior as today.
 *
 * The handler registration goes through `deps.loopEvents` — the dispatcher
 * the implementer adds to `TurnDeps`. Tests construct a real
 * `createLoopEventRegistry()` (from `@/agents/native/session/loop-events`)
 * and pass it via `deps`, observing invocations on the registry itself.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASK_HUMAN_TOOL_NAME } from "@/agents/native/session/ask-human";
import { createLoopEventRegistry, type LoopEventRegistry } from "@/agents/native/session/loop-events";
import { nativeTranscriptDirs } from "@/agents/native/session/session";
import { loadTranscript } from "@/agents/native/session/transcript-store";
import { runNativeTurn } from "@/agents/native/session/turn-loop";
import type { SendTurnOpts } from "@/agents/session-types";
import { createSpinBreaker, DEFAULT_SPIN_BREAKER_SETTINGS } from "@/runtime/spin-breaker";
import type { CodingTool } from "@/tools";

const baseUsage = { inputTokens: 1, outputTokens: 1 };

let dir: string;
const handle = { id: "sess-seam", agentName: "native" } as const;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nax-turn-seam-"));
  nativeTranscriptDirs.set("sess-seam", dir);
});
afterEach(async () => {
  nativeTranscriptDirs.delete("sess-seam");
  await rm(dir, { recursive: true, force: true });
});

const fakeRead: CodingTool = {
  name: "Read",
  description: "Read a file",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
  scope: { pathFields: ["path"] },
  async run() {
    return { content: "raw-body" };
  },
};

const baseOpts = (over: Partial<SendTurnOpts> = {}): SendTurnOpts => ({
  interactionHandler: {
    onInteraction: async () => ({ answer: "ok" }),
  },
  codingTools: [fakeRead],
  ...over,
});

/**
 * Wires a freshly-installed after_tool counter into the registry so a test can
 * assert on the exact number of handler invocations.
 */
function withCounter(registry: LoopEventRegistry): { count: { value: number }; payloads: unknown[] } {
  const count = { value: 0 };
  const payloads: unknown[] = [];
  registry.register("after_tool", (payload) => {
    count.value += 1;
    payloads.push(payload);
    return {};
  });
  return { count, payloads };
}

describe("runNativeTurn — after_tool invocation sites", () => {
  test("AC10: human Q&A budget exhausted pushes a tool-result and invokes no after_tool handler", async () => {
    const registry = createLoopEventRegistry();
    const { count } = withCounter(registry);
    let roundTrip = 0;
    await runNativeTurn(
      handle,
      "hi",
      baseOpts({
        maxInteractions: 1,
        interactionHandler: {
          onInteraction: async (req) => (req.kind === "question" ? { answer: "first" } : { answer: "ignored" }),
        },
      }),
      {
        complete: async () => {
          roundTrip += 1;
          // Round 1: ask_human — consumes the only budget slot.
          if (roundTrip === 1) {
            return {
              text: "",
              toolCalls: [{ id: "q1", name: ASK_HUMAN_TOOL_NAME, input: { text: "first?" } }],
              usage: baseUsage,
              costUsd: 0,
            };
          }
          // Round 2: ask_human again — budget is exhausted, must refuse.
          if (roundTrip === 2) {
            return {
              text: "",
              toolCalls: [{ id: "q2", name: ASK_HUMAN_TOOL_NAME, input: { text: "second?" } }],
              usage: baseUsage,
              costUsd: 0,
            };
          }
          return { text: "done", usage: baseUsage, costUsd: 0 };
        },
        loopEvents: registry,
      },
    );

    // A tool-result was pushed (the budget-exhausted notice), but the
    // after_tool handler is bypassed for synthetic early-exit results.
    const saved = await loadTranscript(dir, handle.id);
    const budgetNotice = saved.find(
      (m) =>
        m.role === "tool-result" && m.toolCallId === "q2" && m.content.includes("Q&A budget for this turn is spent"),
    );
    expect(budgetNotice).toBeDefined();
    expect(count.value).toBe(0);
  });

  test("AC11: no operator reachable pushes a tool-result and invokes no after_tool handler", async () => {
    const registry = createLoopEventRegistry();
    const { count } = withCounter(registry);
    let roundTrip = 0;
    await runNativeTurn(
      handle,
      "hi",
      baseOpts({
        maxInteractions: 5,
        interactionHandler: {
          onInteraction: async () => null,
        },
      }),
      {
        complete: async () => {
          roundTrip += 1;
          if (roundTrip === 1) {
            return {
              text: "",
              toolCalls: [{ id: "q1", name: ASK_HUMAN_TOOL_NAME, input: { text: "anyone?" } }],
              usage: baseUsage,
              costUsd: 0,
            };
          }
          return { text: "done", usage: baseUsage, costUsd: 0 };
        },
        loopEvents: registry,
      },
    );

    const saved = await loadTranscript(dir, handle.id);
    const noOperatorNotice = saved.find(
      (m) => m.role === "tool-result" && m.toolCallId === "q1" && m.content.includes("No human operator is available"),
    );
    expect(noOperatorNotice).toBeDefined();
    expect(count.value).toBe(0);
  });

  test("AC12: an AskHuman answered call pushes the human answer and invokes no after_tool handler", async () => {
    const registry = createLoopEventRegistry();
    const { count } = withCounter(registry);
    let roundTrip = 0;
    await runNativeTurn(
      handle,
      "hi",
      baseOpts({
        maxInteractions: 5,
        interactionHandler: {
          onInteraction: async (req) => (req.kind === "question" ? { answer: "use postgres" } : { answer: "" }),
        },
      }),
      {
        complete: async () => {
          roundTrip += 1;
          if (roundTrip === 1) {
            return {
              text: "",
              toolCalls: [{ id: "q1", name: ASK_HUMAN_TOOL_NAME, input: { text: "which db?" } }],
              usage: baseUsage,
              costUsd: 0,
            };
          }
          return { text: "done", usage: baseUsage, costUsd: 0 };
        },
        loopEvents: registry,
      },
    );

    const saved = await loadTranscript(dir, handle.id);
    const answered = saved.find(
      (m) => m.role === "tool-result" && m.toolCallId === "q1" && m.content === "use postgres",
    );
    expect(answered).toBeDefined();
    expect(count.value).toBe(0);
  });

  test("AC13: spin breaker stops the batch — pushes its notice and invokes no after_tool handler", async () => {
    const registry = createLoopEventRegistry();
    const { count } = withCounter(registry);
    let roundTrip = 0;
    await runNativeTurn(handle, "hi", baseOpts(), {
      complete: async () => {
        roundTrip += 1;
        // Same tool call every round trip so the spin breaker can fire
        // on the second occurrence (first is allow, second is stop).
        return {
          text: "",
          toolCalls: [{ id: `c${roundTrip}`, name: "Read", input: { path: "a.ts" } }],
          usage: baseUsage,
          costUsd: 0,
        };
      },
      loopEvents: registry,
      // Aggressive breaker — one repeat already trips the raw backstop.
      spinBreaker: createSpinBreaker({
        ...DEFAULT_SPIN_BREAKER_SETTINGS,
        nudgeAfterRepeats: 0,
        stopAfterRepeats: 1,
        maxNudges: 0,
      }),
    });

    const saved = await loadTranscript(dir, handle.id);
    const stopNotice = saved.find(
      (m) => m.role === "tool-result" && typeof m.content === "string" && m.content.includes("This turn is ending"),
    );
    expect(stopNotice).toBeDefined();
    expect(count.value).toBe(0);
  });

  test("AC14: policy denial invokes a registered after_tool handler exactly once and preserves denied", async () => {
    const registry = createLoopEventRegistry();
    const { count, payloads } = withCounter(registry);
    let roundTrip = 0;
    await runNativeTurn(
      handle,
      "hi",
      baseOpts({
        interactionHandler: {
          onInteraction: async () => ({
            answer: "denied reason",
            denied: { reason: "policy denied", breach: false },
          }),
        },
      }),
      {
        complete: async () => {
          roundTrip += 1;
          if (roundTrip === 1) {
            return {
              text: "",
              toolCalls: [{ id: "c1", name: "Read", input: { path: "a.ts" } }],
              usage: baseUsage,
              costUsd: 0,
            };
          }
          return { text: "done", usage: baseUsage, costUsd: 0 };
        },
        loopEvents: registry,
      },
    );

    expect(count.value).toBe(1);
    // The handler received the result before it was built — its payload was
    // { content, denied? } and the builder preserved denied regardless of
    // what the handler returned (handlers must NOT be able to patch denied).
    const saved = await loadTranscript(dir, handle.id);
    const result = saved.find((m) => m.role === "tool-result" && m.toolCallId === "c1") as
      | { denied?: unknown; content?: unknown; isError?: boolean }
      | undefined;
    expect(result).toBeDefined();
    expect(result?.denied).toEqual({ reason: "policy denied", breach: false });
    // The original content (the denial reason from the policy) is preserved
    // when the handler returns an empty patch.
    expect(result?.content).toBe("denied reason");
    expect(result?.isError).toBeFalsy(); // denied is NOT isError (ADR-029 s5)
    expect(payloads).toHaveLength(1);
  });

  test("AC15: a tool returning normally invokes a registered after_tool handler exactly once", async () => {
    const registry = createLoopEventRegistry();
    const { count } = withCounter(registry);
    let roundTrip = 0;
    await runNativeTurn(handle, "hi", baseOpts(), {
      complete: async () => {
        roundTrip += 1;
        if (roundTrip === 1) {
          return {
            text: "",
            toolCalls: [{ id: "c1", name: "Read", input: { path: "a.ts" } }],
            usage: baseUsage,
            costUsd: 0,
          };
        }
        return { text: "done", usage: baseUsage, costUsd: 0 };
      },
      loopEvents: registry,
    });

    expect(count.value).toBe(1);
    const saved = await loadTranscript(dir, handle.id);
    const result = saved.find((m) => m.role === "tool-result" && m.toolCallId === "c1");
    expect(result).toBeDefined();
    if (result === undefined || result.role !== "tool-result") throw new Error("unreachable");
    expect(result.content).toBe("ok");
    expect(result.isError).toBeUndefined();
  });

  test("AC16: a tool throwing invokes a registered after_tool handler exactly once with isError true", async () => {
    const registry = createLoopEventRegistry();
    const { count } = withCounter(registry);
    let roundTrip = 0;
    await runNativeTurn(
      handle,
      "hi",
      baseOpts({
        interactionHandler: {
          onInteraction: async () => {
            throw new Error("tool exploded");
          },
        },
      }),
      {
        complete: async () => {
          roundTrip += 1;
          if (roundTrip === 1) {
            return {
              text: "",
              toolCalls: [{ id: "c1", name: "Read", input: { path: "a.ts" } }],
              usage: baseUsage,
              costUsd: 0,
            };
          }
          return { text: "done", usage: baseUsage, costUsd: 0 };
        },
        loopEvents: registry,
      },
    );

    expect(count.value).toBe(1);
    const saved = await loadTranscript(dir, handle.id);
    const result = saved.find((m) => m.role === "tool-result" && m.toolCallId === "c1");
    expect(result).toBeDefined();
    if (result === undefined || result.role !== "tool-result") throw new Error("unreachable");
    expect(result.isError).toBe(true);
    expect(result.content).toBe("tool exploded");
  });
});

describe("runNativeTurn — before_tool outcomes (AC5–AC8)", () => {
  test("AC5: before_tool allow with an input rewrites the call input that the interaction handler sees", async () => {
    const registry = createLoopEventRegistry();
    // Handler returns allow with a rewritten input. The interaction handler
    // must observe the rewritten input, NOT the model's original argument.
    registry.register("before_tool", () => ({ kind: "allow", input: { path: "rewritten.ts" } }));
    const seen: unknown[] = [];
    let roundTrip = 0;
    await runNativeTurn(
      handle,
      "hi",
      baseOpts({
        interactionHandler: {
          onInteraction: async (req) => {
            if (req.kind === "coding-tool") seen.push(req.input);
            return { answer: "ok" };
          },
        },
      }),
      {
        complete: async () => {
          roundTrip += 1;
          if (roundTrip === 1) {
            return {
              text: "",
              toolCalls: [{ id: "c1", name: "Read", input: { path: "original.ts" } }],
              usage: baseUsage,
              costUsd: 0,
            };
          }
          return { text: "done", usage: baseUsage, costUsd: 0 };
        },
        loopEvents: registry,
      },
    );

    expect(seen).toEqual([{ path: "rewritten.ts" }]);
  });

  test("AC6: before_tool block pushes a tool-result carrying handler content without invoking the tool", async () => {
    const registry = createLoopEventRegistry();
    registry.register("before_tool", () => ({ kind: "block", content: "blocked-by-seam", isError: true }));
    let invoked = 0;
    let roundTrip = 0;
    await runNativeTurn(
      handle,
      "hi",
      baseOpts({
        interactionHandler: {
          onInteraction: async () => {
            invoked += 1;
            return { answer: "should-not-run" };
          },
        },
      }),
      {
        complete: async () => {
          roundTrip += 1;
          if (roundTrip === 1) {
            return {
              text: "",
              toolCalls: [{ id: "c1", name: "Read", input: { path: "a.ts" } }],
              usage: baseUsage,
              costUsd: 0,
            };
          }
          return { text: "done", usage: baseUsage, costUsd: 0 };
        },
        loopEvents: registry,
      },
    );

    // The interaction handler must never run for a blocked tool call.
    expect(invoked).toBe(0);
    const saved = await loadTranscript(dir, handle.id);
    const blocked = saved.find(
      (m) => m.role === "tool-result" && m.toolCallId === "c1" && m.content === "blocked-by-seam",
    );
    expect(blocked).toBeDefined();
    if (blocked === undefined || blocked.role !== "tool-result") throw new Error("unreachable");
    expect(blocked.isError).toBe(true);
  });

  test("AC7: before_tool terminate pushes one tool-result per outstanding call in the batch", async () => {
    const registry = createLoopEventRegistry();
    registry.register("before_tool", () => ({ kind: "terminate", content: "ended-by-seam" }));
    let invoked = 0;
    let roundTrip = 0;
    await runNativeTurn(
      handle,
      "hi",
      baseOpts({
        interactionHandler: {
          onInteraction: async () => {
            invoked += 1;
            return { answer: "should-not-run" };
          },
        },
      }),
      {
        complete: async () => {
          roundTrip += 1;
          if (roundTrip === 1) {
            // Three tool calls in one batch — all three must be answered.
            return {
              text: "",
              toolCalls: [
                { id: "c1", name: "Read", input: { path: "a.ts" } },
                { id: "c2", name: "Read", input: { path: "b.ts" } },
                { id: "c3", name: "Read", input: { path: "c.ts" } },
              ],
              usage: baseUsage,
              costUsd: 0,
            };
          }
          return { text: "done", usage: baseUsage, costUsd: 0 };
        },
        loopEvents: registry,
      },
    );

    // None of the three were invoked.
    expect(invoked).toBe(0);
    const saved = await loadTranscript(dir, handle.id);
    const expectedIds = new Set(["c1", "c2", "c3"]);
    const results = saved.filter((m) => m.role === "tool-result" && expectedIds.has(m.toolCallId));
    // All three outstanding calls answered.
    expect(results).toHaveLength(3);
    expect(results.every((m) => m.role === "tool-result" && m.content === "ended-by-seam")).toBe(true);
  });

  test("AC8: before_tool nudge prepends the handler text to the eventual tool-result content", async () => {
    const registry = createLoopEventRegistry();
    registry.register("before_tool", () => ({ kind: "nudge", text: "nudge-prefix" }));
    let roundTrip = 0;
    await runNativeTurn(
      handle,
      "hi",
      baseOpts({
        interactionHandler: {
          onInteraction: async () => ({ answer: "tool-real-output" }),
        },
      }),
      {
        complete: async () => {
          roundTrip += 1;
          if (roundTrip === 1) {
            return {
              text: "",
              toolCalls: [{ id: "c1", name: "Read", input: { path: "a.ts" } }],
              usage: baseUsage,
              costUsd: 0,
            };
          }
          return { text: "done", usage: baseUsage, costUsd: 0 };
        },
        loopEvents: registry,
      },
    );

    const saved = await loadTranscript(dir, handle.id);
    const result = saved.find((m) => m.role === "tool-result" && m.toolCallId === "c1");
    expect(result).toBeDefined();
    if (result === undefined || result.role !== "tool-result") throw new Error("unreachable");
    // The eventual tool-result content starts with the handler's nudge text.
    expect(result.content.startsWith("nudge-prefix")).toBe(true);
  });
});

describe("runNativeTurn — preserved behaviour (AC17/AC18)", () => {
  test("AC17: identical tool calls past the spin threshold end the loop with spinStopped (today's behaviour)", async () => {
    let roundTrip = 0;
    const result = await runNativeTurn(handle, "hi", baseOpts(), {
      complete: async () => {
        roundTrip += 1;
        // Same call every round trip — past the spin threshold.
        return {
          text: "",
          toolCalls: [{ id: `c${roundTrip}`, name: "Read", input: { path: "a.ts" } }],
          usage: baseUsage,
          costUsd: 0,
        };
      },
      spinBreaker: createSpinBreaker({
        ...DEFAULT_SPIN_BREAKER_SETTINGS,
        nudgeAfterRepeats: 0,
        stopAfterRepeats: 2,
        maxNudges: 0,
      }),
    });

    expect(result.spinStopped).toBe(true);
    expect(result.turnIncomplete).toBe(true);
    // Same observable shape as the pre-seam spin breaker: terminal notice
    // answers every outstanding call, the loop ends.
    const saved = await loadTranscript(dir, handle.id);
    const stopNotices = saved.filter(
      (m) => m.role === "tool-result" && typeof m.content === "string" && m.content.includes("This turn is ending"),
    );
    expect(stopNotices.length).toBeGreaterThanOrEqual(1);
  });

  test("AC18: exhausting the invalid-call budget ends the loop with invalidCallBudgetExceeded (today's behaviour)", async () => {
    const MALFORMED = { path: 42 } as const; // not a string — invalid per Read's schema
    let roundTrip = 0;
    const result = await runNativeTurn(handle, "hi", baseOpts(), {
      complete: async () => {
        roundTrip += 1;
        if (roundTrip <= 3) {
          return {
            text: "",
            toolCalls: [{ id: `c${roundTrip}`, name: "Read", input: { ...MALFORMED } }],
            usage: baseUsage,
            costUsd: 0,
          };
        }
        return { text: "done", usage: baseUsage, costUsd: 0 };
      },
    });

    expect(result.invalidCallBudgetExceeded).toBe(true);
    expect(result.turnIncomplete).toBe(true);
    expect(result.spinStopped).toBeFalsy();
    // The 3rd invalid call was NOT answered.
    const saved = await loadTranscript(dir, handle.id);
    const ids = saved
      .filter((m) => m.role === "tool-result")
      .map((m) => (m.role === "tool-result" ? m.toolCallId : ""));
    expect(ids).not.toContain("c3");
  });
});
