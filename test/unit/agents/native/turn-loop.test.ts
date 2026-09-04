// RE-ARCH: keep
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeTranscriptDirs } from "@/agents/native/session/session";
import { loadTranscript } from "@/agents/native/session/transcript-store";
import { runNativeTurn } from "@/agents/native/session/turn-loop";
import type { SendTurnOpts } from "@/agents/session-types";
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

  test("stops at maxTurns when the model keeps calling tools", async () => {
    const result = await runNativeTurn(handle, "hi", opts({ maxTurns: 3 }), {
      complete: async () => reply({ toolCalls: [{ id: "c1", name: "t", input: {} }] }),
    });
    expect(result.internalRoundTrips).toBe(3);
  });

  test("defaults to 10 turns when maxTurns is unset", async () => {
    const result = await runNativeTurn(handle, "hi", opts(), {
      complete: async () => reply({ toolCalls: [{ id: "c1", name: "t", input: {} }] }),
    });
    expect(result.internalRoundTrips).toBe(10);
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

  test("flags an incomplete turn when the cap cuts the loop off mid-work", async () => {
    // Every completion asks for another tool, so the loop can only end at the cap.
    const result = await runNativeTurn(handle, "hi", opts({ maxTurns: 3 }), {
      complete: async () =>
        reply({ text: "still working on it", toolCalls: [{ id: "c1", name: "query_neighbor", input: {} }] }),
    });
    // Both sides non-empty: output IS present, which is exactly why this case
    // slipped past the empty-output guard.
    expect(result.output).toBe("still working on it");
    expect(result.internalRoundTrips).toBe(3);
    expect(result.turnIncomplete).toBe(true);
  });

  test("a turn that ends on its own is not flagged incomplete", async () => {
    const result = await runNativeTurn(handle, "hi", opts(), { complete: async () => reply() });
    expect(result.output).toBe("done");
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
});
