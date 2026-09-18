import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeTranscriptDirs } from "@/agents/native/session/session";
import { loadTranscript } from "@/agents/native/session/transcript-store";
import { runNativeTurn } from "@/agents/native/session/turn-loop";
import type { TurnDeps } from "@/agents/native/session/turn-types";
import type { SendTurnOpts } from "@/agents/session-types";
import { createSpinBreaker, DEFAULT_SPIN_BREAKER_SETTINGS } from "@/runtime/spin-breaker";

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
  /** Per-call tool answer. Defaults to the constant every existing test relies on. */
  answer?: () => string;
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
    onInteraction: async () => ({ answer: opts.answer?.() ?? "29 tests passed" }),
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
      spinBreaker: createSpinBreaker({
        ...DEFAULT_SPIN_BREAKER_SETTINGS,
        nudgeAfterRepeats: 3,
        stopAfterRepeats: 6,
        maxNudges: 1,
      }),
    });

    expect(result.spinStopped).toBe(true);
    expect(result.turnIncomplete).toBe(true);
    // The terminal warning gets exactly one answer-only round trip. The next
    // tool call ends the turn before the breaker starts a new accumulation.
    expect(result.internalRoundTrips).toBe(7);
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
      spinBreaker: createSpinBreaker({
        ...DEFAULT_SPIN_BREAKER_SETTINGS,
        nudgeAfterRepeats: 2,
        stopAfterRepeats: 5,
        maxNudges: 1,
      }),
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
      spinBreaker: createSpinBreaker({
        ...DEFAULT_SPIN_BREAKER_SETTINGS,
        nudgeAfterRepeats: 2,
        stopAfterRepeats: 4,
        maxNudges: 1,
      }),
    });

    expect(result.spinStopped).toBeUndefined();
    expect(result.output).toBe("done");
  });

  test("a model that edits and re-runs the same scoped test is not stopped (nax#2120)", async () => {
    // The shape of run-2026-09-17T11-43-47-190Z US-001: one RunCommand key
    // re-run after each edit, with a different failure each time. 40
    // iterations, well past stopAfterSameKeyRepeats=12.
    let call = 0;
    let answered = 0;
    const result = await runTurnWithSpin({
      complete: async () => {
        call += 1;
        if (call > 40) return { text: "done", usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 };
        return {
          text: "",
          toolCalls: [{ id: `c${call}`, name: "RunCommand", input: { command: "testScoped" } }],
          usage: { inputTokens: 1, outputTokens: 1 },
          costUsd: 0,
        };
      },
      answer: () => {
        answered += 1;
        return `FAIL: expected ${answered} to equal ${answered + 1}`;
      },
      spinBreaker: createSpinBreaker(DEFAULT_SPIN_BREAKER_SETTINGS),
    });

    expect(result.spinStopped).toBeUndefined();
    expect(result.output).toBe("done");
  });

  test("a spun turn gets one terminal round trip to produce an answer (nax#2120)", async () => {
    let call = 0;
    const result = await runTurnWithSpin({
      complete: async (messages) => {
        call += 1;
        const warned = messages.some((m) => typeof m.content === "string" && m.content.includes("This turn is ending"));
        // The model answers as soon as it is told the turn is ending.
        if (warned) return { text: "final answer", usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 };
        return {
          text: "",
          toolCalls: [{ id: `c${call}`, name: "RunCommand", input: { command: "testScoped" } }],
          usage: { inputTokens: 1, outputTokens: 1 },
          costUsd: 0,
        };
      },
      spinBreaker: createSpinBreaker({
        ...DEFAULT_SPIN_BREAKER_SETTINGS,
        nudgeAfterRepeats: 3,
        stopAfterRepeats: 6,
        maxNudges: 1,
      }),
    });

    expect(result.output).toBe("final answer");
    expect(result.spinStopped).toBeUndefined();
    expect(result.turnIncomplete).toBeUndefined();
  });

  test("a model that keeps calling tools after the terminal notice is stopped hard", async () => {
    let call = 0;
    const result = await runTurnWithSpin({
      complete: async () => {
        call += 1;
        return {
          text: "",
          toolCalls: [{ id: `c${call}`, name: "RunCommand", input: { command: "testScoped" } }],
          usage: { inputTokens: 1, outputTokens: 1 },
          costUsd: 0,
        };
      },
      spinBreaker: createSpinBreaker({
        ...DEFAULT_SPIN_BREAKER_SETTINGS,
        nudgeAfterRepeats: 3,
        stopAfterRepeats: 6,
        maxNudges: 1,
      }),
    });

    expect(result.spinStopped).toBe(true);
  });

  test("a different tool call after the terminal notice is stopped without execution", async () => {
    let call = 0;
    let executed = 0;
    let executedBeforeWarning: number | undefined;
    const result = await runTurnWithSpin({
      complete: async (messages) => {
        call += 1;
        const warned = messages.some((m) => typeof m.content === "string" && m.content.includes("This turn is ending"));
        if (warned) executedBeforeWarning = executed;
        return {
          text: "",
          toolCalls: [
            {
              id: `c${call}`,
              name: warned ? "Read" : "RunCommand",
              input: warned ? { path: "src/other.ts" } : { command: "testScoped" },
            },
          ],
          usage: { inputTokens: 1, outputTokens: 1 },
          costUsd: 0,
        };
      },
      answer: () => {
        executed += 1;
        return "same result";
      },
      spinBreaker: createSpinBreaker({
        ...DEFAULT_SPIN_BREAKER_SETTINGS,
        nudgeAfterRepeats: 3,
        stopAfterRepeats: 6,
        maxNudges: 1,
      }),
    });

    expect(result.spinStopped).toBe(true);
    // The post-notice Read must never be dispatched to the interaction handler.
    if (executedBeforeWarning === undefined) throw new Error("Expected the terminal warning round trip");
    expect(executed).toBe(executedBeforeWarning);
  });

  test("a raw-backstop terminal warning does not claim that results were unchanged", async () => {
    let answer = 0;
    const toolResults: string[] = [];
    const result = await runTurnWithSpin({
      complete: async (messages) => {
        const warned = messages.some((m) => typeof m.content === "string" && m.content.includes("This turn is ending"));
        if (warned) return { text: "final answer", usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 };
        return {
          text: "",
          toolCalls: [{ id: `c${answer}`, name: "RunCommand", input: { command: "testScoped" } }],
          usage: { inputTokens: 1, outputTokens: 1 },
          costUsd: 0,
        };
      },
      answer: () => {
        answer += 1;
        return `changed result ${answer}`;
      },
      onToolResult: (content) => toolResults.push(content),
      spinBreaker: createSpinBreaker({
        ...DEFAULT_SPIN_BREAKER_SETTINGS,
        nudgeAfterRepeats: 2,
        stopAfterRepeats: 6,
        maxNudges: 0,
      }),
    });

    const terminalNotice = toolResults.find((content) => content.includes("This turn is ending"));
    expect(result.output).toBe("final answer");
    expect(terminalNotice).toContain("call limit");
    expect(terminalNotice).not.toContain("no change in its result");
  });
});
