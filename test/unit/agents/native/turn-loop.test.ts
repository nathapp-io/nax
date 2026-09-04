// RE-ARCH: keep
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeTranscriptDirs } from "@/agents/native/session/session";
import { loadTranscript } from "@/agents/native/session/transcript-store";
import { runNativeTurn } from "@/agents/native/session/turn-loop";
import type { SendTurnOpts } from "@/agents/session-types";
import { createTurnDeadline } from "@/agents/turn-deadline";
import type { CodingTool } from "@/tools";

let dir: string;
const handle = { id: "sess-a", agentName: "native" } as const;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nax-turn-"));
  nativeTranscriptDirs.set("sess-a", dir);
});
afterEach(async () => {
  nativeTranscriptDirs.delete("sess-a");
  await rm(dir, { recursive: true, force: true });
});

const usage = { inputTokens: 1, outputTokens: 1 };
const reply = (over: Record<string, unknown> = {}) => ({ text: "done", usage, costUsd: 0, ...over });

// interactionHandler is SendTurnOpts' only required field, so a Partial override
// composes directly into a real SendTurnOpts — no cast needed.
const opts = (over: Partial<SendTurnOpts> = {}): SendTurnOpts => ({
  interactionHandler: { onInteraction: async () => ({ answer: "tool said hi" }) },
  ...over,
});

const fakeRead: CodingTool = {
  name: "Read",
  description: "Read a file",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
  scope: { pathFields: ["path"] },
  async run() {
    return { content: "body" };
  },
};

describe("native turn loop", () => {
  test("a reply with no tool calls ends the turn in one round trip", async () => {
    const result = await runNativeTurn(handle, "hi", opts(), { complete: async () => reply() });
    expect(result.output).toBe("done");
    expect(result.internalRoundTrips).toBe(1);
  });

  test("persists the conversation, including thinking blocks", async () => {
    await runNativeTurn(handle, "hi", opts(), {
      complete: async () => reply({ thinking: [{ text: "hmm", signature: "sig-1" }] }),
    });
    const saved = await loadTranscript(dir, "sess-a");
    expect(saved[0]).toEqual({ role: "user", content: "hi" });
    expect(saved[1]).toMatchObject({ role: "assistant", thinking: [{ signature: "sig-1" }] });
  });

  test("executes a tool call through the interaction handler and continues", async () => {
    let round = 0;
    const seen: string[] = [];
    const result = await runNativeTurn(
      handle,
      "hi",
      opts({
        interactionHandler: {
          onInteraction: async (r) => {
            if (r.kind === "context-tool") seen.push(r.name);
            return { answer: "42" };
          },
        },
      }),
      {
        complete: async () => {
          round += 1;
          return round === 1
            ? reply({ text: "", toolCalls: [{ id: "c1", name: "query_neighbor", input: {} }] })
            : reply({ text: "the answer is 42" });
        },
      },
    );

    expect(seen).toEqual(["query_neighbor"]);
    expect(result.output).toBe("the answer is 42");
    expect(result.internalRoundTrips).toBe(2);
    const saved = await loadTranscript(dir, "sess-a");
    expect(saved).toContainEqual({ role: "tool-result", toolCallId: "c1", content: "42" });
  });

  test("accumulates token usage across the whole turn, not just the last call", async () => {
    let round = 0;
    const result = await runNativeTurn(handle, "hi", opts(), {
      complete: async () => {
        round += 1;
        return round === 1
          ? reply({ toolCalls: [{ id: "c1", name: "t", input: {} }], usage: { inputTokens: 10, outputTokens: 5 } })
          : reply({ usage: { inputTokens: 3, outputTokens: 2 } });
      },
    });
    expect(result.tokenUsage.inputTokens).toBe(13);
    expect(result.tokenUsage.outputTokens).toBe(7);
  });

  test("a tool failure comes back as an error result and the turn continues", async () => {
    let round = 0;
    const result = await runNativeTurn(
      handle,
      "hi",
      opts({
        interactionHandler: {
          onInteraction: async () => {
            throw new Error("budget exhausted");
          },
        },
      }),
      {
        complete: async () => {
          round += 1;
          return round === 1 ? reply({ toolCalls: [{ id: "c1", name: "t", input: {} }] }) : reply({ text: "ok" });
        },
      },
    );
    expect(result.output).toBe("ok");
    const saved = await loadTranscript(dir, "sess-a");
    expect(saved).toContainEqual(expect.objectContaining({ role: "tool-result", toolCallId: "c1", isError: true }));
  });

  // Finding 6 (whole-branch review, 2026-09-02): InteractionHandler.onInteraction
  // is documented to be able to return null (no answer given), and turn-loop.ts
  // handles it via `answer?.answer ?? ""` — but only the throw path and the
  // normal-answer path were covered before this test.
  test("a null interaction answer records an empty tool-result and the turn continues", async () => {
    let round = 0;
    const result = await runNativeTurn(
      handle,
      "hi",
      opts({
        interactionHandler: {
          onInteraction: async () => null,
        },
      }),
      {
        complete: async () => {
          round += 1;
          return round === 1 ? reply({ toolCalls: [{ id: "c1", name: "t", input: {} }] }) : reply({ text: "ok" });
        },
      },
    );
    expect(result.output).toBe("ok");
    const saved = await loadTranscript(dir, "sess-a");
    expect(saved).toContainEqual({ role: "tool-result", toolCallId: "c1", content: "" });
  });

  test("a session with no known transcript directory fails loudly", async () => {
    nativeTranscriptDirs.delete("sess-a");
    await expect(runNativeTurn(handle, "hi", opts(), { complete: async () => reply() })).rejects.toThrow(/transcript/i);
  });

  test("a denied coding tool becomes a tool-result that is NOT isError", async () => {
    const messages: unknown[] = [];
    let round = 0;
    await runNativeTurn(
      handle,
      "please read",
      opts({
        codingTools: [fakeRead],
        interactionHandler: {
          onInteraction: async () => ({
            answer: "Denied: not granted",
            denied: { reason: "not granted", breach: false },
          }),
        },
      }),
      {
        complete: async (msgs) => {
          messages.push(...msgs);
          round += 1;
          return round === 1 ? reply({ toolCalls: [{ id: "c1", name: "Read", input: {} }] }) : reply();
        },
      },
    );

    const toolResult = messages.find((m) => (m as { role?: string }).role === "tool-result") as {
      isError?: boolean;
      denied?: unknown;
    };
    expect(toolResult.isError).toBeUndefined();
    expect(toolResult.denied).toEqual({ reason: "not granted", breach: false });
  });

  test("a named coding tool is routed as the coding-tool kind, not context-tool", async () => {
    const seen: string[] = [];
    let round = 0;
    await runNativeTurn(
      handle,
      "hi",
      opts({
        codingTools: [fakeRead],
        interactionHandler: {
          onInteraction: async (r) => {
            if (r.kind === "coding-tool") seen.push(r.name);
            return { answer: "body" };
          },
        },
      }),
      {
        complete: async () => {
          round += 1;
          return round === 1 ? reply({ toolCalls: [{ id: "c1", name: "Read", input: {} }] }) : reply();
        },
      },
    );
    expect(seen).toEqual(["Read"]);
  });

  test("flags an incomplete turn when the budget cuts the loop off mid-work", async () => {
    let now = 0;
    const result = await runNativeTurn(handle, "hi", opts(), {
      deadline: createTurnDeadline(10, () => now),
      complete: async () => {
        now += 6_000;
        return reply({ text: "still working on it", toolCalls: [{ id: "c1", name: "query_neighbor", input: {} }] });
      },
    });
    expect(result.output).toBe("still working on it");
    expect(result.turnIncomplete).toBe(true);
  });

  test("a turn that ends on its own is not flagged incomplete", async () => {
    const result = await runNativeTurn(handle, "hi", opts(), { complete: async () => reply() });
    expect(result.output).toBe("done");
    expect(result.turnIncomplete).toBeUndefined();
  });

  test("runs past ten round trips when the model keeps working", async () => {
    let round = 0;
    const result = await runNativeTurn(handle, "hi", opts(), {
      complete: async () => {
        round += 1;
        return round < 25
          ? reply({ text: "working", toolCalls: [{ id: `c${round}`, name: "query_neighbor", input: {} }] })
          : reply({ text: "finished after 25" });
      },
    });
    expect(result.internalRoundTrips).toBe(25);
    expect(result.output).toBe("finished after 25");
    expect(result.turnIncomplete).toBeUndefined();
  });
});

/**
 * The rubber-stamp guard corroborates a reviewer's self-declared
 * `inspectedFiles` against tools it actually invoked, so the turn has to report
 * what it dispatched. Without this the guard can only trust the model's own
 * account of its behaviour — which is precisely what it exists to distrust.
 */
describe("native turn loop — coding tool use reported on the result", () => {
  test("records which coding tools were advertised and which were called", async () => {
    let round = 0;
    const result = await runNativeTurn(handle, "review it", opts({ codingTools: [fakeRead] }), {
      complete: async () => {
        round += 1;
        return round === 1 ? reply({ toolCalls: [{ id: "c1", name: "Read", input: { path: "a.ts" } }] }) : reply();
      },
    });

    expect(result.codingToolUse).toEqual({ advertised: 1, called: ["Read"] });
  });

  test("reports an empty call list when tools were advertised but never used", async () => {
    const result = await runNativeTurn(handle, "review it", opts({ codingTools: [fakeRead] }), {
      complete: async () => reply(),
    });

    expect(result.codingToolUse).toEqual({ advertised: 1, called: [] });
  });

  test("omits the report entirely when no coding tools were advertised", async () => {
    const result = await runNativeTurn(handle, "hi", opts(), { complete: async () => reply() });

    expect(result.codingToolUse).toBeUndefined();
  });
});

/**
 * What the model is TOLD exists, not merely what it is allowed to call.
 *
 * Every other test here scripts the fake model to return a tool call
 * unconditionally, so it would keep passing if the coding-tool definitions were
 * dropped from the payload entirely — the model "calls" a tool it was never
 * offered. That is the branch's own defect class (a capability wired everywhere
 * except where it is consumed) one hop lower, so the advertisement is asserted
 * directly.
 */
describe("native turn loop — what the model is told exists", () => {
  test("passes the coding tool's wire definition to the provider", async () => {
    let advertised: unknown;
    await runNativeTurn(handle, "hi", opts({ codingTools: [fakeRead] }), {
      complete: async (_messages, tools) => {
        advertised = tools;
        return reply();
      },
    });

    expect(advertised).toEqual([
      {
        name: "Read",
        description: "Read a file",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
      },
    ]);
  });

  test("advertises nothing when the session was granted no coding tools", async () => {
    let advertised: unknown;
    await runNativeTurn(handle, "hi", opts(), {
      complete: async (_messages, tools) => {
        advertised = tools;
        return reply();
      },
    });

    expect(advertised).toEqual([]);
  });

  test("stops on the whole-turn deadline and reports it as a transport fact", async () => {
    let now = 0;
    const deadline = createTurnDeadline(30, () => now);
    let calls = 0;
    const result = await runNativeTurn(handle, "hi", opts({ maxTurns: 50 }), {
      deadline,
      complete: async () => {
        calls += 1;
        now += 20_000; // two round-trips fit; the third must not start
        return reply({ text: "partial progress", toolCalls: [{ id: "c1", name: "query_neighbor", input: {} }] });
      },
    });
    expect(calls).toBe(2);
    expect(result.timedOut).toBe(true);
    expect(result.turnIncomplete).toBe(true);
    // Non-empty on both sides: the budget ran out mid-work, with prose present.
    expect(result.output).toBe("partial progress");
  });

  test("an unbounded turn is never stopped by the deadline", async () => {
    let round = 0;
    const result = await runNativeTurn(handle, "hi", opts({ maxTurns: 5 }), {
      complete: async () => {
        round += 1;
        return round < 3
          ? reply({ text: "working", toolCalls: [{ id: "c1", name: "query_neighbor", input: {} }] })
          : reply({ text: "finished" });
      },
    });
    expect(result.output).toBe("finished");
    expect(result.timedOut).toBeUndefined();
  });

  test("reports usage, message and tool activity for every round trip", async () => {
    const seen: string[] = [];
    let round = 0;
    await runNativeTurn(handle, "hi", opts(), {
      onActivity: (a) => seen.push(a.kind),
      complete: async () => {
        round += 1;
        return round === 1
          ? reply({ text: "calling", toolCalls: [{ id: "c1", name: "query_neighbor", input: {} }] })
          : reply({ text: "done" });
      },
    });
    // Round 1: usage + message + one tool. Round 2: usage + message.
    expect(seen.filter((k) => k === "usage")).toHaveLength(2);
    expect(seen.filter((k) => k === "tool")).toHaveLength(1);
    expect(seen).toContain("message");
  });

  test("routes an ask_human call to the interaction handler and records the exchange", async () => {
    let round = 0;
    const result = await runNativeTurn(
      handle,
      "hi",
      opts({
        interactionHandler: {
          onInteraction: async (r) => (r.kind === "question" ? { answer: "use postgres" } : { answer: "" }),
        },
      }),
      {
        complete: async () => {
          round += 1;
          return round === 1
            ? reply({ text: "", toolCalls: [{ id: "q1", name: "ask_human", input: { text: "which database?" } }] })
            : reply({ text: "using postgres" });
        },
      },
    );
    expect(result.output).toBe("using postgres");
    expect(result.interactions).toEqual([{ turnIndex: 1, question: "which database?", reply: "use postgres" }]);
  });

  test("stops asking once maxInteractionTurns is spent, and says so", async () => {
    let asked = 0;
    let round = 0;
    const result = await runNativeTurn(
      handle,
      "hi",
      opts({
        maxTurns: 2,
        interactionHandler: {
          onInteraction: async (r) => {
            if (r.kind === "question") asked += 1;
            return { answer: "yes" };
          },
        },
      }),
      {
        complete: async () => {
          round += 1;
          // Asks five times, so only the budget — not the fixture — can stop it
          // at two. Terminates on its own so the test can never hang.
          return round <= 5
            ? reply({ text: "asking", toolCalls: [{ id: `q${round}`, name: "ask_human", input: { text: "again?" } }] })
            : reply({ text: "done asking" });
        },
      },
    );
    // Exactly two, not "at most two": an off-by-one or a missing check must fail.
    expect(asked).toBe(2);
    expect(result.interactions).toHaveLength(2);
    // Calls past the budget are refused as data the model can act on, not dropped.
    expect(result.output).toBe("done asking");
  });

  test("an unanswerable question consumes no budget and records no exchange", async () => {
    let round = 0;
    const result = await runNativeTurn(
      handle,
      "hi",
      opts({
        maxTurns: 2,
        // Mirrors run-interaction-handler.ts: kind "question" returns null when
        // no interactionBridge is configured for the run.
        interactionHandler: { onInteraction: async () => null },
      }),
      {
        complete: async () => {
          round += 1;
          return round <= 3
            ? reply({ text: "asking", toolCalls: [{ id: `q${round}`, name: "ask_human", input: { text: "hello?" } }] })
            : reply({ text: "gave up asking" });
        },
      },
    );
    // Three asks against a budget of two: if a null answer consumed budget, the
    // third would have been refused for the wrong reason and this would be 2.
    expect(result.interactions).toBeUndefined();
    expect(result.output).toBe("gave up asking");
  });
});
