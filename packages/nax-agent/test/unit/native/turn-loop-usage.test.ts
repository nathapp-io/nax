import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { attachPartialSpend } from "#src/native/session/partial-spend";
import { createNativeSessionState, type NativeSessionState } from "#src/native/session/session";
import { saveTranscript } from "#src/native/session/transcript-store";
import { buildNativeStreamEvent, type NativeTurnActivity } from "#src/native/session/turn-events";
import { runNativeTurn } from "#src/native/session/turn-loop";
import { readNativeTurnFailureUsage } from "#src/native/session/turn-types";
import type { SendTurnOpts } from "#src/session/session-types";
import { cleanupTempDir, makeTempDir, seedNativeSession } from "#test/helpers/index";

let dir: string;
let sessionState: NativeSessionState;
const handle = { id: "sess-usage", agentName: "native" } as const;
const base = { callId: "call-1", runId: "run-1", agentName: "native", sessionName: "sess-usage" };

beforeEach(() => {
  dir = makeTempDir("nax-turn-usage-");
  sessionState = seedNativeSession(createNativeSessionState(), "sess-usage", { transcriptDir: dir });
});
afterEach(() => {
  cleanupTempDir(dir);
});

const reply = (over: Record<string, unknown> = {}) => ({
  text: "done",
  usage: { inputTokens: 1, outputTokens: 1 },
  costUsd: 0,
  ...over,
});

const opts = (over: Partial<SendTurnOpts> = {}): SendTurnOpts => ({
  interactionHandler: { onInteraction: async () => ({ answer: "" }) },
  ...over,
});

type UsageActivity = Extract<NativeTurnActivity, { kind: "usage" }>;
const usageBeats = (activity: NativeTurnActivity[]): UsageActivity[] =>
  activity.filter((a): a is UsageActivity => a.kind === "usage");

class ProtocolStreamError extends Error {
  constructor(readonly protocolError: { kind: string; message: string }) {
    super(protocolError.message);
    this.name = "ProtocolStreamError";
  }
}

/**
 * nax#2045: the native usage stream event carries the round trip's cache
 * figures and a 1-based ordinal, so downstream can reconstruct a per-round-trip
 * usage record. Compaction-summary and transport-retry beats are usage events
 * too but are NOT round-trip boundaries — they must not claim an ordinal.
 */
describe("native turn loop — usage activities (nax#2045)", () => {
  test("emits the round trip's cache figures and its 1-based ordinal", async () => {
    const activity: NativeTurnActivity[] = [];
    await runNativeTurn(handle, "hi", opts(), {
      sessionState,
      onActivity: (a) => activity.push(a),
      complete: async () =>
        reply({
          usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 20 },
        }),
    });

    expect(usageBeats(activity)).toEqual([
      {
        kind: "usage",
        inputTokens: 10,
        outputTokens: 5,
        costUsd: 0,
        cacheRead: 100,
        cacheWrite: 20,
        roundTrip: 1,
      },
    ]);
  });

  test("leaves cache figures absent, not 0, when the round trip reported none", async () => {
    const activity: NativeTurnActivity[] = [];
    await runNativeTurn(handle, "hi", opts(), {
      sessionState,
      onActivity: (a) => activity.push(a),
      complete: async () => reply(),
    });

    const [beat] = usageBeats(activity);
    expect(beat).not.toHaveProperty("cacheRead");
    expect(beat).not.toHaveProperty("cacheWrite");
  });

  test("keeps an explicit zero cacheRead on the beat", async () => {
    const activity: NativeTurnActivity[] = [];
    await runNativeTurn(handle, "hi", opts(), {
      sessionState,
      onActivity: (a) => activity.push(a),
      complete: async () => reply({ usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 } }),
    });

    expect(usageBeats(activity)[0]).toHaveProperty("cacheRead", 0);
  });

  test("numbers successive round trips 1 then 2, never 0", async () => {
    const activity: NativeTurnActivity[] = [];
    let round = 0;
    await runNativeTurn(handle, "hi", opts(), {
      sessionState,
      onActivity: (a) => activity.push(a),
      complete: async () => {
        round += 1;
        return round === 1
          ? reply({ text: "calling", toolCalls: [{ id: "c1", name: "t", input: {} }] })
          : reply({ text: "done" });
      },
    });

    expect(usageBeats(activity).map((b) => b.roundTrip)).toEqual([1, 2]);
  });

  test("the compaction-summary beat is not a round-trip boundary", async () => {
    await saveTranscript(dir, "sess-usage", [
      { role: "user", content: "the task" },
      { role: "assistant", content: "a".repeat(20_000) },
      { role: "user", content: "keep going" },
      { role: "assistant", content: "b".repeat(20_000) },
    ]);
    const activity: NativeTurnActivity[] = [];

    await runNativeTurn(handle, "next", opts(), {
      sessionState,
      contextWindow: 8000,
      compaction: { enabled: true, compactAtPercent: 90, keepRecentPercent: 30 },
      onActivity: (a) => activity.push(a),
      summarize: async () => ({
        text: "summary",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 100, cacheWriteTokens: 20 },
        costUsd: 0.01,
      }),
      complete: async () => reply(),
    });

    const beats = usageBeats(activity);
    expect(beats).toHaveLength(2);
    const [summaryBeat, roundTripBeat] = beats;
    expect(summaryBeat).not.toHaveProperty("roundTrip");
    expect(summaryBeat).toHaveProperty("cacheRead", 100);
    expect(summaryBeat).toHaveProperty("cacheWrite", 20);
    expect("perRoundTrip" in buildNativeStreamEvent(base, summaryBeat, 1)).toBe(false);
    expect(roundTripBeat).toHaveProperty("roundTrip", 1);
    expect("perRoundTrip" in buildNativeStreamEvent(base, roundTripBeat, 2)).toBe(true);
  });

  test("the transport-retry zero-beat is not a round-trip boundary", async () => {
    const activity: NativeTurnActivity[] = [];
    let calls = 0;
    await runNativeTurn(handle, "hi", opts(), {
      sessionState,
      transportRetry: { maxAttempts: 3, baseDelayMs: 100 },
      sleep: async () => {},
      onActivity: (a) => activity.push(a),
      complete: async () => {
        calls += 1;
        if (calls === 1) throw new ProtocolStreamError({ kind: "transport", message: "stall" });
        return reply();
      },
    });

    const beats = usageBeats(activity);
    const retryBeat = beats[0];
    expect(retryBeat).toEqual({ kind: "usage", inputTokens: 0, outputTokens: 0, costUsd: 0 });
    expect("perRoundTrip" in buildNativeStreamEvent(base, retryBeat, 1)).toBe(false);
    expect(beats[1]).toHaveProperty("roundTrip", 1);
  });

  describe("billed usage on failed round trips", () => {
    const partial = { inputTokens: 40, outputTokens: 2 };
    const failing = (kind: string, spend = true) => {
      const err = new ProtocolStreamError({ kind, message: "boom" });
      if (spend) attachPartialSpend(err, { usage: partial, costUsd: 0.4 });
      return err;
    };

    test("a retried round trip counts the failed attempt and the successful one", async () => {
      let calls = 0;
      const result = await runNativeTurn(handle, "hi", opts(), {
        sessionState,
        transportRetry: { maxAttempts: 3, baseDelayMs: 100 },
        sleep: async () => {},
        complete: async () => {
          calls += 1;
          if (calls === 1) throw failing("transport");
          return reply({ usage: { inputTokens: 10, outputTokens: 5 }, costUsd: 0.1 });
        },
      });

      expect(result.tokenUsage).toMatchObject({ inputTokens: 50, outputTokens: 7 });
      expect(result.estimatedCostUsd).toBeCloseTo(0.5);
    });

    test("every failed attempt of an exhausted retry is counted on the recorded failure usage", async () => {
      let thrown: unknown;
      try {
        await runNativeTurn(handle, "hi", opts(), {
          sessionState,
          transportRetry: { maxAttempts: 2, baseDelayMs: 100 },
          sleep: async () => {},
          complete: async () => {
            throw failing("transport");
          },
        });
      } catch (err) {
        thrown = err;
      }
      expect(readNativeTurnFailureUsage(thrown)).toEqual({
        tokenUsage: { inputTokens: 80, outputTokens: 4 },
        costUsd: expect.closeTo(0.8),
      });
    });

    test("an aborted or non-retryable round trip counts what it was billed", async () => {
      let thrown: unknown;
      try {
        await runNativeTurn(handle, "hi", opts(), {
          sessionState,
          complete: async () => {
            throw failing("bad-request");
          },
        });
      } catch (err) {
        thrown = err;
      }
      expect(readNativeTurnFailureUsage(thrown)?.tokenUsage).toEqual({ inputTokens: 40, outputTokens: 2 });
    });

    test("the success path adds nothing beyond the response usage", async () => {
      const result = await runNativeTurn(handle, "hi", opts(), {
        sessionState,
        complete: async () => reply({ usage: { inputTokens: 10, outputTokens: 5 }, costUsd: 0.1 }),
      });
      expect(result.tokenUsage).toMatchObject({ inputTokens: 10, outputTokens: 5 });
      expect(result.estimatedCostUsd).toBeCloseTo(0.1);
    });

    test("a failed attempt with no billed usage adds no usage beat", async () => {
      const activity: NativeTurnActivity[] = [];
      let calls = 0;
      await runNativeTurn(handle, "hi", opts(), {
        sessionState,
        transportRetry: { maxAttempts: 3, baseDelayMs: 100 },
        sleep: async () => {},
        onActivity: (a) => activity.push(a),
        complete: async () => {
          calls += 1;
          if (calls === 1) throw failing("transport", false);
          return reply();
        },
      });
      expect(usageBeats(activity)).toHaveLength(2);
    });
  });
});
