import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeTranscriptDirs } from "@/agents/native/session/session";
import { loadTranscript } from "@/agents/native/session/transcript-store";
import { runNativeTurn } from "@/agents/native/session/turn-loop";
import type { TurnDeps } from "@/agents/native/session/turn-types";
import type { SendTurnOpts } from "@/agents/session-types";
import { createTurnDeadline } from "@/agents/turn-deadline";
import { addSink, initLogger, resetLogger } from "@/logger";
import type { LogEntry } from "@/logger/types";
import { createSpinBreaker, DEFAULT_SPIN_BREAKER_SETTINGS } from "@/runtime/spin-breaker";

let dir: string;
const handle = { id: "sess-retry", agentName: "native" } as const;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nax-turn-retry-"));
  nativeTranscriptDirs.set("sess-retry", dir);
});
afterEach(async () => {
  nativeTranscriptDirs.delete("sess-retry");
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

/** Mirrors the fixture used in turn-loop-compaction.test.ts. */
class ProtocolStreamError extends Error {
  constructor(readonly protocolError: { kind: string; message: string; retryAfter?: number; status?: number }) {
    super(protocolError.message);
    this.name = "ProtocolStreamError";
  }
}

/**
 * nax#1870: a transport/overloaded fault from deps.complete gets a bounded,
 * backed-off retry in the same catch block that already handles context
 * overflow — one more guarded branch, not a second turn loop.
 */
describe("native turn loop — transport-fault retry (nax#1870)", () => {
  const retryConfig = { maxAttempts: 3, baseDelayMs: 100 };
  const noopSleep = async () => {};

  test("retries a transport error once and completes normally", async () => {
    let calls = 0;
    const delays: number[] = [];
    const result = await runNativeTurn(handle, "hi", opts(), {
      transportRetry: retryConfig,
      sleep: async (ms) => {
        delays.push(ms);
      },
      complete: async () => {
        calls += 1;
        if (calls === 1) throw new ProtocolStreamError({ kind: "transport", message: "stall" });
        return reply();
      },
    });
    expect(calls).toBe(2);
    expect(delays).toHaveLength(1);
    expect(result.output).toBe("done");
  });

  /**
   * The turn-loop layer is the only place a real timer can still reach a
   * retry: TurnRetryDeps.sleep is required, but TurnDeps.sleep is optional and
   * falls back to realSleep for production. A backoff budget far larger than
   * the test timeout means dropping the injection stops being a slow test and
   * starts being a failing one.
   */
  test("never waits on a real timer — the injected sleep is what the backoff uses", async () => {
    const startedAt = Date.now();
    let calls = 0;
    const result = await runNativeTurn(handle, "hi", opts(), {
      transportRetry: { maxAttempts: 3, baseDelayMs: 600_000 },
      sleep: noopSleep,
      complete: async () => {
        calls += 1;
        if (calls === 1) throw new ProtocolStreamError({ kind: "overloaded", message: "503" });
        return reply();
      },
    });
    expect(calls).toBe(2);
    expect(result.output).toBe("done");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  test("retries an overloaded error", async () => {
    let calls = 0;
    const result = await runNativeTurn(handle, "hi", opts(), {
      transportRetry: retryConfig,
      sleep: noopSleep,
      complete: async () => {
        calls += 1;
        if (calls === 1) throw new ProtocolStreamError({ kind: "overloaded", message: "503" });
        return reply();
      },
    });
    expect(calls).toBe(2);
    expect(result.output).toBe("done");
  });

  test("never retries auth or bad-request faults", async () => {
    for (const kind of ["auth", "bad-request"]) {
      let calls = 0;
      await expect(
        runNativeTurn(handle, "hi", opts(), {
          transportRetry: retryConfig,
          sleep: noopSleep,
          complete: async () => {
            calls += 1;
            throw new ProtocolStreamError({ kind, message: "terminal" });
          },
        }),
      ).rejects.toThrow("terminal");
      expect(calls).toBe(1);
    }
  });

  test("waits out a rate-limit fault and re-issues the round trip", async () => {
    let calls = 0;
    const delays: number[] = [];
    const result = await runNativeTurn(handle, "hi", opts(), {
      transportRetry: retryConfig,
      sleep: async (ms) => {
        delays.push(ms);
      },
      complete: async () => {
        calls += 1;
        if (calls === 1) throw new ProtocolStreamError({ kind: "rate-limit", message: "429-ish", retryAfter: 4 });
        return reply();
      },
    });
    expect(calls).toBe(2);
    expect(delays).toEqual([4000]);
    expect(result.output).toBe("done");
  });

  describe("retry diagnostics", () => {
    let logCalls: LogEntry[];

    beforeEach(() => {
      resetLogger();
      logCalls = [];
      initLogger({ level: "info", suppressConsole: true });
      addSink((entry) => logCalls.push(entry));
    });

    afterEach(() => {
      resetLogger();
    });

    test("logs the rate-limit kind and provider diagnostics before retrying", async () => {
      let calls = 0;
      await runNativeTurn(handle, "hi", opts(), {
        transportRetry: retryConfig,
        sleep: noopSleep,
        complete: async () => {
          calls += 1;
          if (calls === 1) {
            throw new ProtocolStreamError({
              kind: "rate-limit",
              message: "account quota exceeded",
              status: 429,
              retryAfter: 4,
            });
          }
          return reply();
        },
      });

      const warning = logCalls.find((entry) => entry.level === "warn" && entry.stage === "native-adapter");
      expect(warning?.message).toBe("retrying after a rate-limit fault");
      expect(warning?.data).toMatchObject({
        sessionName: "sess-retry",
        retryNumber: 1,
        delayMs: 4_000,
        kind: "rate-limit",
        message: "account quota exceeded",
        status: 429,
        retryAfter: 4,
      });
    });
  });

  test("leaves context-overflow on its own existing path, unaffected by transportRetry being set", async () => {
    // No compaction deps supplied, so the overflow backstop cannot engage either —
    // this pins that transportRetry does not accidentally swallow overflow.
    let calls = 0;
    await expect(
      runNativeTurn(handle, "hi", opts(), {
        transportRetry: retryConfig,
        sleep: noopSleep,
        complete: async () => {
          calls += 1;
          throw new ProtocolStreamError({ kind: "context-overflow", message: "prompt is too long" });
        },
      }),
    ).rejects.toThrow("prompt is too long");
    expect(calls).toBe(1);
  });

  test("rethrows the original error unchanged once retries are exhausted", async () => {
    let calls = 0;
    let thrown: unknown;
    const originals: Error[] = [];
    await runNativeTurn(handle, "hi", opts(), {
      transportRetry: { maxAttempts: 2, baseDelayMs: 10 },
      sleep: noopSleep,
      complete: async () => {
        calls += 1;
        const err = new ProtocolStreamError({ kind: "transport", message: `stall ${calls}` });
        originals.push(err);
        throw err;
      },
    }).catch((err: unknown) => {
      thrown = err;
    });
    // maxAttempts: 2 = one retry beyond the triggering failure.
    expect(calls).toBe(2);
    expect(thrown).toBe(originals[1]);
  });

  test("does not retry when the turn deadline has already expired", async () => {
    let now = 0;
    let calls = 0;
    await expect(
      runNativeTurn(handle, "hi", opts(), {
        transportRetry: retryConfig,
        deadline: createTurnDeadline(10, () => now),
        sleep: noopSleep,
        complete: async () => {
          calls += 1;
          now += 20_000; // past the 10s budget before the retry check runs
          throw new ProtocolStreamError({ kind: "transport", message: "stall" });
        },
      }),
    ).rejects.toThrow("stall");
    expect(calls).toBe(1);
  });

  test("does not retry when the caller's signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await expect(
      runNativeTurn(handle, "hi", opts({ signal: controller.signal }), {
        transportRetry: retryConfig,
        sleep: noopSleep,
        complete: async () => {
          calls += 1;
          throw new ProtocolStreamError({ kind: "transport", message: "stall" });
        },
      }),
    ).rejects.toThrow("stall");
    expect(calls).toBe(1);
  });

  test("honours the provider's retryAfter for the backoff delay", async () => {
    let calls = 0;
    const delays: number[] = [];
    await runNativeTurn(handle, "hi", opts(), {
      transportRetry: retryConfig,
      sleep: async (ms) => {
        delays.push(ms);
      },
      complete: async () => {
        calls += 1;
        if (calls === 1) throw new ProtocolStreamError({ kind: "overloaded", message: "429-ish", retryAfter: 4 });
        return reply();
      },
    });
    expect(delays).toEqual([4000]);
  });

  test("fires an onActivity beat per retry so the idle watchdog resets", async () => {
    let calls = 0;
    const activity: unknown[] = [];
    await runNativeTurn(handle, "hi", opts(), {
      transportRetry: retryConfig,
      sleep: noopSleep,
      onActivity: (a) => activity.push(a),
      complete: async () => {
        calls += 1;
        if (calls === 1) throw new ProtocolStreamError({ kind: "transport", message: "stall" });
        return reply();
      },
    });
    // One retry beat plus the successful round trip's own usage beat.
    expect(activity).toContainEqual({ kind: "usage", inputTokens: 0, outputTokens: 0, costUsd: 0 });
  });

  test("is inert when no transportRetry config is supplied — pre-#1870 behaviour", async () => {
    let calls = 0;
    await expect(
      runNativeTurn(handle, "hi", opts(), {
        complete: async () => {
          calls += 1;
          throw new ProtocolStreamError({ kind: "transport", message: "stall" });
        },
      }),
    ).rejects.toThrow("stall");
    expect(calls).toBe(1);
  });
});

interface RunTurnWithSpinOpts {
  complete: TurnDeps["complete"];
  spinBreaker: TurnDeps["spinBreaker"];
  onToolResult?: (content: string) => void;
  /** Per-call tool answer. Defaults to the constant every existing test relies on. */
  answer?: () => string;
}

describe("runNativeTurn — spin breaker", () => {
  let spinDir: string;
  const spinHandle = { id: "sess-spin", agentName: "native" } as const;

  beforeEach(async () => {
    spinDir = await mkdtemp(join(tmpdir(), "nax-turn-spin-"));
    nativeTranscriptDirs.set("sess-spin", spinDir);
  });
  afterEach(async () => {
    nativeTranscriptDirs.delete("sess-spin");
    await rm(spinDir, { recursive: true, force: true });
  });

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
      spinHandle,
      "hi",
      { interactionHandler },
      { complete: opts.complete, spinBreaker: opts.spinBreaker },
    );
    if (opts.onToolResult !== undefined) {
      const saved = await loadTranscript(spinDir, spinHandle.id);
      for (const message of saved) {
        if (message.role === "tool-result" && typeof message.content === "string") {
          opts.onToolResult(message.content);
        }
      }
    }
    return result;
  }

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
