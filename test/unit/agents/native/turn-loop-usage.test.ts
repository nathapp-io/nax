import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { nativeSessionLastUsage, nativeTranscriptDirs } from "@/agents/native/session/session";
import { saveTranscript } from "@/agents/native/session/transcript-store";
import { buildNativeStreamEvent, type NativeTurnActivity } from "@/agents/native/session/turn-events";
import { runNativeTurn } from "@/agents/native/session/turn-loop";
import type { SendTurnOpts } from "@/agents/session-types";

let dir: string;
const handle = { id: "sess-usage", agentName: "native" } as const;
const base = { callId: "call-1", runId: "run-1", agentName: "native", sessionName: "sess-usage" };

beforeEach(() => {
  dir = makeTempDir("nax-turn-usage-");
  nativeTranscriptDirs.set("sess-usage", dir);
});
afterEach(() => {
  nativeTranscriptDirs.delete("sess-usage");
  // The usage anchor is a module-level map keyed by session id; clear it so a
  // later test reusing the id does not inherit a stale pre-compaction anchor.
  nativeSessionLastUsage.delete("sess-usage");
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
      onActivity: (a) => activity.push(a),
      complete: async () =>
        reply({
          usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 100, cacheCreationInputTokens: 20 },
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
      onActivity: (a) => activity.push(a),
      complete: async () => reply({ usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0 } }),
    });

    expect(usageBeats(activity)[0]).toHaveProperty("cacheRead", 0);
  });

  test("numbers successive round trips 1 then 2, never 0", async () => {
    const activity: NativeTurnActivity[] = [];
    let round = 0;
    await runNativeTurn(handle, "hi", opts(), {
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
      contextWindow: 8000,
      compaction: { enabled: true, compactAtPercent: 90, keepRecentPercent: 30 },
      onActivity: (a) => activity.push(a),
      summarize: async () => ({
        text: "summary",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 100, cacheCreationInputTokens: 20 },
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
});
