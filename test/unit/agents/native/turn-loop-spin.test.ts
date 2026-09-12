import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeTranscriptDirs } from "@/agents/native/session/session";
import { loadTranscript } from "@/agents/native/session/transcript-store";
import { runNativeTurn, type TurnDeps } from "@/agents/native/session/turn-loop";
import type { SendTurnOpts } from "@/agents/session-types";
import { DEFAULT_SPIN_BREAKER_SETTINGS } from "@/runtime/spin-breaker";

let dir: string;
const handle = { id: "sess-spin", agentName: "native" } as const;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nax-turn-spin-"));
  nativeTranscriptDirs.set("sess-spin", dir);
});
afterEach(async () => {
  nativeTranscriptDirs.delete("sess-spin");
  await rm(dir, { recursive: true, force: true });
});

interface RunTurnWithSpinOpts {
  complete: TurnDeps["complete"];
  spinBreaker: TurnDeps["spinBreaker"];
  onToolResult?: (content: string) => void;
}

/**
 * Builds real TurnDeps/SendTurnOpts and calls the real runNativeTurn —
 * modeled on the sibling suites' setup (turn-loop.test.ts,
 * turn-loop-transport-retry.test.ts). The stub interactionHandler answers
 * every coding-tool call with "29 tests passed". When `onToolResult` is
 * supplied, every tool-result message actually written to the transcript
 * (i.e. after the loop's own nudge-prepend, not the raw interactionHandler
 * answer) is forwarded to it, so a test can assert on exactly what the model
 * would see.
 */
async function runTurnWithSpin(opts: RunTurnWithSpinOpts) {
  const interactionHandler: SendTurnOpts["interactionHandler"] = {
    onInteraction: async () => ({ answer: "29 tests passed" }),
  };
  const result = await runNativeTurn(
    handle,
    "hi",
    { interactionHandler },
    { complete: opts.complete, spinBreaker: opts.spinBreaker },
  );
  if (opts.onToolResult !== undefined) {
    const saved = await loadTranscript(dir, handle.id);
    for (const message of saved) {
      if (message.role === "tool-result" && typeof message.content === "string") {
        opts.onToolResult(message.content);
      }
    }
  }
  return result;
}

describe("runNativeTurn — spin breaker", () => {
  test("ends the turn with spinStopped once the breaker stops it", async () => {
    // A model that asks for the same RunCommand forever.
    const complete = async () => ({
      text: "",
      toolCalls: [{ id: "c1", name: "RunCommand", input: { command: "testScoped" } }],
      usage: { inputTokens: 1, outputTokens: 1 },
      costUsd: 0,
    });

    const result = await runTurnWithSpin({
      complete,
      spinBreaker: { ...DEFAULT_SPIN_BREAKER_SETTINGS, nudgeAfterRepeats: 3, stopAfterRepeats: 6, maxNudges: 1 },
    });

    expect(result.spinStopped).toBe(true);
    expect(result.turnIncomplete).toBe(true);
    expect(result.internalRoundTrips).toBeLessThan(10);
  });

  test("prepends the nudge to the real tool result instead of replacing it", async () => {
    const toolResults: string[] = [];
    const result = await runTurnWithSpin({
      complete: async () => ({
        text: "",
        toolCalls: [{ id: "c1", name: "RunCommand", input: { command: "testScoped" } }],
        usage: { inputTokens: 1, outputTokens: 1 },
        costUsd: 0,
      }),
      onToolResult: (content: string) => toolResults.push(content),
      spinBreaker: { ...DEFAULT_SPIN_BREAKER_SETTINGS, nudgeAfterRepeats: 2, stopAfterRepeats: 5, maxNudges: 1 },
    });

    const nudged = toolResults.find((content) => content.includes("repeating work already done"));
    expect(nudged).toBeDefined();
    expect(nudged).toContain("29 tests passed");
    expect(result.spinStopped).toBe(true);
  });

  test("a varied sequence completes normally with no spin flag", async () => {
    let call = 0;
    const result = await runTurnWithSpin({
      complete: async () => {
        call += 1;
        if (call > 5) return { text: "done", usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 };
        return {
          text: "",
          toolCalls: [{ id: `c${call}`, name: "Read", input: { path: `src/f${call}.ts` } }],
          usage: { inputTokens: 1, outputTokens: 1 },
          costUsd: 0,
        };
      },
      spinBreaker: { ...DEFAULT_SPIN_BREAKER_SETTINGS, nudgeAfterRepeats: 2, stopAfterRepeats: 4, maxNudges: 1 },
    });

    expect(result.spinStopped).toBeUndefined();
    expect(result.output).toBe("done");
  });
});
