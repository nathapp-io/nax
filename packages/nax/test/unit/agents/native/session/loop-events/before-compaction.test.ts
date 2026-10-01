import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPACTION_SUMMARY_PREFIX, type ResolvedCompaction } from "@/agents/native/session/compaction";
import { createLoopEventRegistry } from "@/agents/native/session/loop-events";
import { nativeSessionLastUsage, nativeTranscriptDirs } from "@/agents/native/session/session";
import { saveTranscript } from "@/agents/native/session/transcript-store";
import { runNativeTurn } from "@/agents/native/session/turn-loop";
import type { SendTurnOpts } from "@/agents/session-types";
import { addSink, initLogger, resetLogger } from "@/logger";
import type { LogEntry } from "@/logger/types";

let dir: string;
const handle = { id: "sess-before-compaction", agentName: "native" } as const;
const cfg: ResolvedCompaction = { enabled: true, compactAtPercent: 90, keepRecentPercent: 30 };
const usage = { inputTokens: 1, outputTokens: 1 };
const opts = (): SendTurnOpts => ({ interactionHandler: { onInteraction: async () => ({ answer: "" }) } });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nax-before-compaction-"));
  nativeTranscriptDirs.set(handle.id, dir);
});
afterEach(async () => {
  nativeTranscriptDirs.delete(handle.id);
  // Same hygiene as turn-loop-compaction.test.ts: the anchor is module-level
  // state keyed by session id, and a stale entry would hand a later test a
  // phantom anchor (turn-loop.ts reads it before the first request).
  nativeSessionLastUsage.delete(handle.id);
  await rm(dir, { recursive: true, force: true });
});

/** A transcript already far past a small window — the proactive branch's input. */
async function seedOversizedTranscript() {
  await saveTranscript(dir, handle.id, [
    { role: "user", content: "the task" },
    { role: "assistant", content: "a".repeat(20_000) },
    { role: "user", content: "keep going" },
    { role: "assistant", content: "b".repeat(20_000) },
  ]);
}

class ProtocolStreamError extends Error {
  constructor(readonly protocolError: { kind: string; message: string }) {
    super(protocolError.message);
    this.name = "ProtocolStreamError";
  }
}

/**
 * A transcript that fits under the proactive threshold but is still large enough
 * for the aggressive keep budget to find a cut — the overflow branch's input.
 *
 * The sizing is load-bearing and borrowed from turn-loop-compaction.test.ts:
 * at a 20000-token window the threshold is 15904 (90% capped by headroom) and
 * the aggressive keep budget is 3000; this transcript is ~8006 tokens, so the
 * proactive check stays silent and only the backstop can compact.
 */
const BACKSTOP_WINDOW = 20_000;
async function seedModerateTranscript() {
  await saveTranscript(dir, handle.id, [
    { role: "user", content: "the task" },
    { role: "assistant", content: "a".repeat(16_000) },
    { role: "user", content: "keep going" },
    { role: "assistant", content: "b".repeat(16_000) },
  ]);
}

/**
 * `before_compaction` fires in BOTH compaction branches, and its `decline` is
 * deliberately asymmetric (spec 6.2): HONOURED proactively — the branch runs
 * before any request, so sending uncompacted is a legitimate outcome — and
 * IGNORED + logged at overflow, where the request has ALREADY failed with a
 * context-overflow error, declining leaves no recovery, and honouring it would
 * kill the story. The signal stops; the compaction does not.
 */
describe("native turn loop — before_compaction event", () => {
  test("decline is HONOURED in the proactive branch", async () => {
    await seedOversizedTranscript();
    let summarizeCalls = 0;
    const reasons: string[] = [];
    const registry = createLoopEventRegistry();
    registry.register("before_compaction", (payload) => {
      reasons.push(payload.reason);
      return { decline: true };
    });
    let sentToModel: readonly { role: string }[] = [];

    await runNativeTurn(handle, "next", opts(), {
      loopEvents: registry,
      contextWindow: 8000,
      compaction: cfg,
      summarize: async () => {
        summarizeCalls += 1;
        return { text: "unused", usage, costUsd: 0 };
      },
      complete: async (messages) => {
        // Copied, not aliased: the loop pushes the assistant reply onto the
        // array after this call returns (turn-loop-compaction.test.ts's note).
        sentToModel = [...messages];
        return { text: "done", usage, costUsd: 0 };
      },
    });

    // The event actually fired, from the proactive branch.
    expect(reasons).toEqual(["proactive"]);
    // The decline was honoured: the summarizer never ran.
    expect(summarizeCalls).toBe(0);
    // Non-vacuous: the request went out UNCOMPACTED — every seeded message
    // plus the new prompt, nothing dropped and no summary inserted.
    expect(sentToModel).toHaveLength(5);
  });

  test("decline is IGNORED in the overflow branch, and compaction still runs", async () => {
    // spec 6.2: the request has ALREADY failed with a context overflow.
    // Declining leaves no recovery and kills the story, so the SIGNAL stops,
    // not the compaction. This test is the stop rule with teeth: an
    // implementation that honours decline everywhere passes the proactive and
    // replacement-summary tests and fails only this one.
    await seedModerateTranscript();
    let summarizeCalls = 0;
    let completes = 0;
    const reasons: string[] = [];
    const registry = createLoopEventRegistry();
    registry.register("before_compaction", (payload) => {
      reasons.push(payload.reason);
      return { decline: true };
    });
    // The ignore is a warn — assert the brief-verbatim line so the log is
    // load-bearing, not decorative.
    resetLogger();
    const logCalls: LogEntry[] = [];
    initLogger({ level: "info", suppressConsole: true });
    addSink((entry) => logCalls.push(entry));

    try {
      const result = await runNativeTurn(handle, "next", opts(), {
        loopEvents: registry,
        contextWindow: BACKSTOP_WINDOW,
        compaction: cfg,
        summarize: async () => {
          summarizeCalls += 1;
          return { text: "summary", usage, costUsd: 0 };
        },
        complete: async () => {
          completes += 1;
          if (completes === 1) {
            throw new ProtocolStreamError({ kind: "context-overflow", message: "prompt is too long" });
          }
          return { text: "done", usage, costUsd: 0 };
        },
      });

      // The event fired from the overflow branch.
      expect(reasons).toEqual(["overflow"]);
      // THE assertion: the decline did not stop the compaction — the
      // summarizer WAS called despite it.
      expect(summarizeCalls).toBe(1);
      // And the turn recovered: compact, then retry once.
      expect(completes).toBe(2);
      expect(result.output).toBe("done");
      const warnings = logCalls.filter(
        (e) => e.level === "warn" && e.message === "before_compaction decline ignored at overflow",
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.data).toMatchObject({ sessionName: handle.id });
    } finally {
      resetLogger();
    }
  });

  test("a replacement summary skips the summarizer call", async () => {
    await seedOversizedTranscript();
    let summarizeCalls = 0;
    const registry = createLoopEventRegistry();
    registry.register("before_compaction", () => ({ summary: "handler wrote the summary" }));
    let sentToModel: readonly { role: string }[] = [];

    await runNativeTurn(handle, "next", opts(), {
      loopEvents: registry,
      contextWindow: 8000,
      compaction: cfg,
      summarize: async () => {
        summarizeCalls += 1;
        return { text: "summarizer output", usage, costUsd: 0 };
      },
      complete: async (messages) => {
        sentToModel = [...messages];
        return { text: "done", usage, costUsd: 0 };
      },
    });

    // The summarizer was skipped — the handler's text is the summary.
    expect(summarizeCalls).toBe(0);
    // The compacted array carries the handler's summary text, under the
    // standard summary prefix, and not the summarizer's. Shape: pin + summary
    // + the kept tail (the 2400-token keep budget holds only the last big
    // message and the prompt) = 4, one shorter than the uncompacted 5.
    expect(sentToModel).toHaveLength(4);
    const summary = sentToModel[1] as { role: "user"; content: string };
    expect(summary.content.startsWith(COMPACTION_SUMMARY_PREFIX)).toBe(true);
    expect(summary.content).toContain("handler wrote the summary");
    expect(summary.content).not.toContain("summarizer output");
  });
});
