// RE-ARCH: keep
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeTranscriptDirs } from "@/agents/native/session/session";
import { loadTranscript } from "@/agents/native/session/transcript-store";
import { runNativeTurn } from "@/agents/native/session/turn-loop";
import type { SendTurnOpts } from "@/agents/session-types";

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

  test("a session with no known transcript directory fails loudly", async () => {
    nativeTranscriptDirs.delete("sess-a");
    await expect(runNativeTurn(handle, "hi", opts(), { complete: async () => reply() })).rejects.toThrow(/transcript/i);
  });
});
