/**
 * S3-3 (spec 5.3, 5.4): the loop's round-level turn events. Deltas carry the
 * round; a re-issued request voids the round's deltas with stream_reset; each
 * round trip ends with one usage event; compaction is reported with its reason.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createNativeSessionState, type NativeSessionState } from "#src/native/session/session";
import { saveTranscript } from "#src/native/session/transcript-store";
import { runNativeTurn } from "#src/native/session/turn-loop";
import type { StreamDeltaSink, TurnDeps } from "#src/native/session/turn-types";
import type { SendTurnOpts } from "#src/session/session-types";
import type { TurnEvent } from "#src/session/turn-event";
import { cleanupTempDir, makeTempDir, seedNativeSession } from "#test/helpers/index";

let dir: string;
let sessionState: NativeSessionState;
const handle = { id: "sess-turn-events", agentName: "native" } as const;

beforeEach(() => {
  dir = makeTempDir("nax-turn-events-");
  sessionState = seedNativeSession(createNativeSessionState(), handle.id, { transcriptDir: dir });
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

function turnOpts(over: Partial<SendTurnOpts> = {}): SendTurnOpts {
  return {
    interactionHandler: { onInteraction: async () => ({ answer: "ok" }) },
    ...over,
  };
}

/** Builds deps whose `complete` streams `chunks` through the delta sink before resolving. */
function streamingDeps(events: TurnEvent[], over: Partial<TurnDeps> = {}): TurnDeps {
  return {
    sessionState,
    onTurnEvent: (e) => void events.push(e),
    complete: async (_m, _t, _o, onDelta?: StreamDeltaSink) => {
      onDelta?.({ type: "text_delta", text: "do" });
      onDelta?.({ type: "text_delta", text: "ne" });
      return reply();
    },
    ...over,
  };
}

class ProtocolStreamError extends Error {
  constructor(readonly protocolError: { kind: string; message: string }) {
    super(protocolError.message);
    this.name = "ProtocolStreamError";
  }
}

describe("runNativeTurn turn events (S3-3)", () => {
  test("deltas carry the round, and a usage event ends each round trip", async () => {
    const events: TurnEvent[] = [];
    let round = 0;
    await runNativeTurn(
      handle,
      "hi",
      turnOpts(),
      streamingDeps(events, {
        complete: async (_m, _t, _o, onDelta) => {
          round += 1;
          onDelta?.({ type: "text_delta", text: `r${round}` });
          return round === 1
            ? reply({
                text: "r1",
                toolCalls: [{ id: "c1", name: "ctx", input: {} }],
                usage: { inputTokens: 5, outputTokens: 2, cacheReadTokens: 3 },
              })
            : reply({ text: "r2", costUsd: 0.25 });
        },
      }),
    );
    expect(events.filter((e) => e.type !== "tool_call" && e.type !== "tool_result")).toEqual([
      { type: "text_delta", round: 1, text: "r1" },
      { type: "usage", round: 1, inputTokens: 5, outputTokens: 2, cacheRead: 3, costUsd: 0 },
      { type: "text_delta", round: 2, text: "r2" },
      { type: "usage", round: 2, inputTokens: 1, outputTokens: 1, costUsd: 0.25 },
    ]);
  });

  test("a transport retry after emitted deltas voids them with stream_reset", async () => {
    const events: TurnEvent[] = [];
    let attempt = 0;
    const result = await runNativeTurn(
      handle,
      "hi",
      turnOpts(),
      streamingDeps(events, {
        transportRetry: { maxAttempts: 3, baseDelayMs: 100 },
        sleep: async () => {},
        complete: async (_m, _t, _o, onDelta) => {
          attempt += 1;
          if (attempt === 1) {
            onDelta?.({ type: "text_delta", text: "stale" });
            throw new ProtocolStreamError({ kind: "transport", message: "upstream idle timeout" });
          }
          onDelta?.({ type: "text_delta", text: "fresh" });
          return reply({ text: "fresh" });
        },
      }),
    );
    expect(events).toEqual([
      { type: "text_delta", round: 1, text: "stale" },
      { type: "stream_reset", round: 1, attempt: 2 },
      { type: "text_delta", round: 1, text: "fresh" },
      { type: "usage", round: 1, inputTokens: 1, outputTokens: 1, costUsd: 0 },
    ]);
    expect(result.output).toBe("fresh");
  });

  test("proactive compaction is reported before the round's deltas, and the summary emits no usage", async () => {
    await saveTranscript(dir, handle.id, [
      { role: "user", content: "the task" },
      { role: "assistant", content: "a".repeat(20_000) },
      { role: "user", content: "keep going" },
      { role: "assistant", content: "b".repeat(20_000) },
    ]);
    const events: TurnEvent[] = [];
    await runNativeTurn(
      handle,
      "next",
      turnOpts(),
      streamingDeps(events, {
        contextWindow: 8000,
        compaction: { enabled: true, compactAtPercent: 90, keepRecentPercent: 30 },
        summarize: async () => ({ text: "summary", usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0.01 }),
      }),
    );
    expect(events.map((e) => e.type)).toEqual(["compaction", "text_delta", "text_delta", "usage"]);
    expect(events[0]).toEqual({ type: "compaction", reason: "proactive" });
  });

  test("an overflow is reported as compaction then stream_reset for the retried request", async () => {
    // ~2,000 tokens of history against a 4,000-token window: under the proactive
    // threshold (compactionThreshold: min(3600, 4000 - min(4096, 1000)) = 3000), but over the overflow keep budget
    // (keepBudget(4000, 30%, aggressive) = 600), so the overflow step has a span to summarize.
    await saveTranscript(dir, handle.id, [
      { role: "user", content: "the task" },
      { role: "assistant", content: "a".repeat(4_000) },
      { role: "user", content: "keep going" },
      { role: "assistant", content: "b".repeat(4_000) },
    ]);
    const events: TurnEvent[] = [];
    let attempt = 0;
    await runNativeTurn(
      handle,
      "next",
      turnOpts(),
      streamingDeps(events, {
        contextWindow: 4_000,
        compaction: { enabled: true, compactAtPercent: 90, keepRecentPercent: 30 },
        summarize: async () => ({ text: "summary", usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 }),
        complete: async () => {
          attempt += 1;
          if (attempt === 1) throw new ProtocolStreamError({ kind: "context-overflow", message: "too long" });
          return reply();
        },
      }),
    );
    expect(events).toEqual([
      { type: "compaction", reason: "overflow" },
      { type: "stream_reset", round: 1, attempt: 2 },
      { type: "usage", round: 1, inputTokens: 1, outputTokens: 1, costUsd: 0 },
    ]);
  });

  test("a throw that escapes the batch leaves its tool_call answered by flushUnanswered", async () => {
    const events: TurnEvent[] = [];
    // The batch's own catch reads `err.message` to build the failure result.
    // A message read that itself throws escapes that catch, so the reported
    // tool_call is still outstanding when the turn's catch runs.
    const hostile = new Error("the tool failed");
    Object.defineProperty(hostile, "message", {
      get() {
        throw new Error("reading the tool error's message threw");
      },
    });
    await expect(
      runNativeTurn(
        handle,
        "hi",
        turnOpts({
          interactionHandler: {
            onInteraction: async () => {
              throw hostile;
            },
          },
        }),
        streamingDeps(events, {
          complete: async (_m, _t, _o, onDelta) => {
            onDelta?.({ type: "text_delta", text: "r1" });
            return reply({ text: "r1", toolCalls: [{ id: "c1", name: "ctx", input: {} }] });
          },
        }),
      ),
    ).rejects.toThrow();
    expect(events[events.length - 1]).toEqual({
      type: "tool_result",
      callId: "c1",
      isError: true,
      preview: "Not answered: the turn ended.",
    });
  });

  test("without a sink the loop hands complete() no delta sink", async () => {
    const seen: unknown[] = [];
    await runNativeTurn(handle, "hi", turnOpts(), {
      sessionState,
      complete: async (_m, _t, _o, onDelta) => {
        seen.push(onDelta);
        return reply();
      },
    });
    expect(seen).toEqual([undefined]);
  });
});
