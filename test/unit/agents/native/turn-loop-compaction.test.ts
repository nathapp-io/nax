import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPACTION_SUMMARY_PREFIX, type ResolvedCompaction } from "@/agents/native/session/compaction";
import { nativeSessionLastUsage, nativeTranscriptDirs } from "@/agents/native/session/session";
import { loadTranscript, saveTranscript } from "@/agents/native/session/transcript-store";
import { runNativeTurn } from "@/agents/native/session/turn-loop";
import type { SendTurnOpts } from "@/agents/session-types";
import { addSink, initLogger, resetLogger } from "@/logger";
import type { LogEntry } from "@/logger/types";

let dir: string;
const handle = { id: "sess-c", agentName: "native" } as const;
const cfg: ResolvedCompaction = { enabled: true, compactAtPercent: 90, keepRecentPercent: 30 };
const usage = { inputTokens: 1, outputTokens: 1 };
const opts = (): SendTurnOpts => ({ interactionHandler: { onInteraction: async () => ({ answer: "" }) } });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nax-compact-"));
  nativeTranscriptDirs.set("sess-c", dir);
});
afterEach(async () => {
  nativeTranscriptDirs.delete("sess-c");
  // The usage anchor is a module-level map keyed by session id, keyed the same
  // as the transcript dir above — without clearing it here, a later test
  // reusing "sess-c" inherits a stale anchor from whatever array length the
  // previous test's turn ended on, corrupting estimateContextTokens.
  nativeSessionLastUsage.delete("sess-c");
  await rm(dir, { recursive: true, force: true });
});

/** A transcript already far past a small window. */
async function seedOversizedTranscript() {
  await saveTranscript(dir, "sess-c", [
    { role: "user", content: "the task" },
    { role: "assistant", content: "a".repeat(20_000) },
    { role: "user", content: "keep going" },
    { role: "assistant", content: "b".repeat(20_000) },
  ]);
}

describe("proactive compaction", () => {
  test("compacts before the call when the estimate crosses the threshold", async () => {
    await seedOversizedTranscript();
    let sentToModel: readonly { role: string }[] = [];
    let summarizeCalls = 0;

    await runNativeTurn(handle, "next", opts(), {
      contextWindow: 8000,
      compaction: cfg,
      summarize: async () => {
        summarizeCalls += 1;
        return { text: "did some work", usage, costUsd: 0.01 };
      },
      complete: async (messages) => {
        sentToModel = messages;
        return { text: "done", usage, costUsd: 0 };
      },
    });

    expect(summarizeCalls).toBe(1);
    expect(sentToModel[1].role).toBe("user");
    const second = sentToModel[1] as { role: "user"; content: string };
    expect(second.content.startsWith(COMPACTION_SUMMARY_PREFIX)).toBe(true);
    expect(second.content).toContain("did some work");
  });

  test("does not compact when the conversation fits", async () => {
    await saveTranscript(dir, "sess-c", [{ role: "user", content: "small" }]);
    let summarizeCalls = 0;

    await runNativeTurn(handle, "next", opts(), {
      contextWindow: 200_000,
      compaction: cfg,
      summarize: async () => {
        summarizeCalls += 1;
        return { text: "unused", usage, costUsd: 0 };
      },
      complete: async () => ({ text: "done", usage, costUsd: 0 }),
    });

    expect(summarizeCalls).toBe(0);
  });

  test("never compacts when no context window is known", async () => {
    await seedOversizedTranscript();
    let summarizeCalls = 0;

    await runNativeTurn(handle, "next", opts(), {
      compaction: cfg,
      summarize: async () => {
        summarizeCalls += 1;
        return { text: "unused", usage, costUsd: 0 };
      },
      complete: async () => ({ text: "done", usage, costUsd: 0 }),
    });

    expect(summarizeCalls).toBe(0);
  });

  test("a failed summary leaves the conversation untouched and does not fail the turn", async () => {
    await seedOversizedTranscript();
    let sentToModel: readonly unknown[] = [];

    const result = await runNativeTurn(handle, "next", opts(), {
      contextWindow: 8000,
      compaction: cfg,
      summarize: async () => {
        throw new Error("summarizer unavailable");
      },
      complete: async (messages) => {
        // Copied, not aliased: the loop mutates its `messages` array (pushing
        // the assistant reply) after this call returns, so holding onto the
        // reference would see that later push too.
        sentToModel = [...messages];
        return { text: "done", usage, costUsd: 0 };
      },
    });

    expect(result.output).toBe("done");
    expect(sentToModel).toHaveLength(5); // 4 seeded + the new prompt, nothing dropped
  });

  test("does not start completion when the turn deadline expires during summarization", async () => {
    await seedOversizedTranscript();
    let expired = false;
    let completeCalls = 0;

    await expect(
      runNativeTurn(handle, "next", opts(), {
        contextWindow: 8000,
        compaction: cfg,
        deadline: { remainingMs: () => (expired ? 0 : 1000), expired: () => expired },
        summarize: async () => {
          expired = true;
          throw new Error("summary deadline exceeded");
        },
        complete: async () => {
          completeCalls += 1;
          return { text: "done", usage, costUsd: 0 };
        },
      }),
    ).rejects.toThrow("summary deadline exceeded");

    expect(completeCalls).toBe(0);
  });

  test("does not start completion when the caller aborts during summarization", async () => {
    await seedOversizedTranscript();
    const controller = new AbortController();
    let completeCalls = 0;

    await expect(
      runNativeTurn(
        handle,
        "next",
        { ...opts(), signal: controller.signal },
        {
          contextWindow: 8000,
          compaction: cfg,
          summarize: async () => {
            controller.abort();
            throw new Error("summary cancelled");
          },
          complete: async () => {
            completeCalls += 1;
            return { text: "done", usage, costUsd: 0 };
          },
        },
      ),
    ).rejects.toThrow("summary cancelled");

    expect(completeCalls).toBe(0);
  });

  test("counts the summary's cost but not as a round trip", async () => {
    await seedOversizedTranscript();

    const result = await runNativeTurn(handle, "next", opts(), {
      contextWindow: 8000,
      compaction: cfg,
      summarize: async () => ({ text: "summary", usage: { inputTokens: 500, outputTokens: 50 }, costUsd: 0.25 }),
      complete: async () => ({ text: "done", usage, costUsd: 0.5 }),
    });

    expect(result.estimatedCostUsd).toBeCloseTo(0.75, 6);
    expect(result.internalRoundTrips).toBe(1);
    expect(result.tokenUsage.inputTokens).toBe(501);
  });

  test("emits a usage activity for the summary, so the idle watchdog sees it", async () => {
    await seedOversizedTranscript();
    const activity: string[] = [];

    await runNativeTurn(handle, "next", opts(), {
      contextWindow: 8000,
      compaction: cfg,
      onActivity: (a) => activity.push(a.kind),
      summarize: async () => ({ text: "summary", usage, costUsd: 0.01 }),
      complete: async () => ({ text: "done", usage, costUsd: 0 }),
    });

    // Two usage events: the summary's and the round trip's.
    expect(activity.filter((k) => k === "usage")).toHaveLength(2);
  });

  test("persists the compacted conversation", async () => {
    await seedOversizedTranscript();

    await runNativeTurn(handle, "next", opts(), {
      contextWindow: 8000,
      compaction: cfg,
      summarize: async () => ({ text: "summary", usage, costUsd: 0 }),
      complete: async () => ({ text: "done", usage, costUsd: 0 }),
    });

    const saved = await loadTranscript(dir, "sess-c");
    expect(saved[0]).toEqual({ role: "user", content: "the task" });
    expect(saved[1].role === "user" && saved[1].content.startsWith(COMPACTION_SUMMARY_PREFIX)).toBe(true);
  });

  test("compacts once per round trip even when the result is still over the threshold", async () => {
    await seedOversizedTranscript();
    let summarizeCalls = 0;

    await runNativeTurn(handle, "next", opts(), {
      contextWindow: 8000,
      compaction: cfg,
      summarize: async () => {
        summarizeCalls += 1;
        // A summary so large the transcript is STILL over the threshold after
        // compacting. Without the once-per-round-trip bound this is the input
        // that would compact repeatedly.
        return { text: "s".repeat(40_000), usage, costUsd: 0 };
      },
      complete: async () => ({ text: "done", usage, costUsd: 0 }),
    });

    expect(summarizeCalls).toBe(1);
  });

  describe("no-progress logging", () => {
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

    test("logs a warning, but still completes, when a compaction makes no size progress", async () => {
      // Finding 2 (whole-branch review, 2026-09-04): prepareCompaction can
      // return a plan even when toSummarize is empty, so long as a previous
      // summary exists (needed for summary-merge scenarios). If the
      // summarizer then returns text at least as large as what it replaced,
      // applyCompaction produces an array no smaller than the input — a paid
      // model call that shrank nothing. This must not be fatal or retried;
      // it must be logged so a repeating no-op is diagnosable.
      await seedOversizedTranscript();

      const result = await runNativeTurn(handle, "next", opts(), {
        contextWindow: 8000,
        compaction: cfg,
        summarize: async () => {
          // Larger than the whole seeded transcript it is replacing —
          // guarantees the post-compaction estimate is not smaller than the
          // pre-compaction one.
          return { text: "s".repeat(60_000), usage, costUsd: 0 };
        },
        complete: async () => ({ text: "done", usage, costUsd: 0 }),
      });

      expect(result.output).toBe("done");
      const warnings = logCalls.filter((e) => e.level === "warn" && e.message === "compaction made no size progress");
      expect(warnings.length).toBeGreaterThan(0);
    });

    test("logs the audit measurements for every successful compaction", async () => {
      await seedOversizedTranscript();

      await runNativeTurn(handle, "next", opts(), {
        contextWindow: 8000,
        compaction: cfg,
        summarize: async () => ({ text: "summary", usage, costUsd: 0 }),
        complete: async () => ({ text: "done", usage, costUsd: 0 }),
      });

      expect(logCalls.map((entry) => `${entry.level}:${entry.message}`)).toContain("info:compaction completed");
      const audit = logCalls.find((e) => e.level === "info" && e.message === "compaction completed");
      expect(audit?.data).toMatchObject({
        sessionName: "sess-c",
        messagesDropped: 2,
        summaryLength: 7,
      });
      const tokens = audit?.data?.tokens as { before?: number; after?: number } | undefined;
      expect(tokens?.before).toBeGreaterThan(0);
      expect(tokens?.after).toBeGreaterThan(0);
    });
  });

  /** Big enough to leave something to summarize, small enough not to trip the
   *  threshold on its own. See the sizing table in the plan. */
  async function seedCompactableTranscript() {
    await saveTranscript(dir, "sess-c", [
      { role: "user", content: "the task" },
      { role: "assistant", content: "a".repeat(12_000) },
      { role: "user", content: "b".repeat(12_000) },
      { role: "assistant", content: "c".repeat(12_000) },
    ]);
  }

  test("counts cached prompt tokens toward the compaction threshold", async () => {
    // Regression for nax#1852. The provider serves a cached prefix, so it
    // reports 16 uncached input tokens and 71,755 cache reads. Anchoring on
    // inputTokens alone reads that 71,771-token prompt as ~16, and compaction
    // never fires even though the prompt is 4x the window.
    await seedCompactableTranscript();
    let summarizeCalls = 0;
    let completeCalls = 0;

    await runNativeTurn(handle, "next", opts(), {
      contextWindow: 20_000,
      compaction: cfg,
      summarize: async () => {
        summarizeCalls += 1;
        return { text: "summary", usage, costUsd: 0 };
      },
      complete: async () => {
        completeCalls += 1;
        if (completeCalls === 1) {
          // Sets the anchor. The tool call forces a second round trip, whose
          // pre-flight check is the assertion point.
          return {
            text: "working",
            toolCalls: [{ id: "c1", name: "t", input: {} }],
            usage: { inputTokens: 16, outputTokens: 5, cacheReadInputTokens: 71_755 },
            costUsd: 0,
          };
        }
        return { text: "done", usage, costUsd: 0 };
      },
    });

    expect(completeCalls).toBe(2);
    expect(summarizeCalls).toBe(1);
  });

  test("does not compact when the same transcript reports no cached tokens", async () => {
    // Negative control for the test above. Identical in every respect except
    // that the prompt was not cached, so the anchor is genuinely small. If this
    // one also compacts, the test above is passing on transcript size rather
    // than on the cache accounting, and proves nothing.
    await seedCompactableTranscript();
    let summarizeCalls = 0;
    let completeCalls = 0;

    await runNativeTurn(handle, "next", opts(), {
      contextWindow: 20_000,
      compaction: cfg,
      summarize: async () => {
        summarizeCalls += 1;
        return { text: "summary", usage, costUsd: 0 };
      },
      complete: async () => {
        completeCalls += 1;
        if (completeCalls === 1) {
          return {
            text: "working",
            toolCalls: [{ id: "c1", name: "t", input: {} }],
            usage: { inputTokens: 16, outputTokens: 5 },
            costUsd: 0,
          };
        }
        return { text: "done", usage, costUsd: 0 };
      },
    });

    expect(completeCalls).toBe(2);
    expect(summarizeCalls).toBe(0);
  });
});

class ProtocolStreamError extends Error {
  constructor(readonly protocolError: { kind: string; message: string }) {
    super(protocolError.message);
    this.name = "ProtocolStreamError";
  }
}

/**
 * A transcript that fits under the proactive threshold but is still large enough
 * for the aggressive keep budget to find a cut.
 *
 * The sizing is load-bearing and was derived, not guessed. At a 20000-token
 * window the threshold is 15904 (90% capped by headroom) and the aggressive keep
 * budget is 3000; this transcript is ~8006 tokens, so the proactive check stays
 * silent and only the backstop can compact. A large window does NOT work here:
 * at 1_000_000 the aggressive budget is 150_000 tokens, more than the whole
 * transcript, so prepareCompaction returns undefined and the backstop rethrows.
 */
const BACKSTOP_WINDOW = 20_000;
async function seedModerateTranscript() {
  await saveTranscript(dir, "sess-c", [
    { role: "user", content: "the task" },
    { role: "assistant", content: "a".repeat(16_000) },
    { role: "user", content: "keep going" },
    { role: "assistant", content: "b".repeat(16_000) },
  ]);
}

describe("reactive backstop", () => {
  test("compacts and retries once when an overflow gets through", async () => {
    await seedModerateTranscript();
    let completes = 0;
    let summarizeCalls = 0;

    const result = await runNativeTurn(handle, "next", opts(), {
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

    expect(summarizeCalls).toBe(1);
    expect(completes).toBe(2);
    expect(result.output).toBe("done");
  });

  test("retries once, not repeatedly", async () => {
    await seedModerateTranscript();
    let completes = 0;

    await expect(
      runNativeTurn(handle, "next", opts(), {
        contextWindow: BACKSTOP_WINDOW,
        compaction: cfg,
        summarize: async () => ({ text: "summary", usage, costUsd: 0 }),
        complete: async () => {
          completes += 1;
          throw new ProtocolStreamError({ kind: "context-overflow", message: "prompt is too long" });
        },
      }),
    ).rejects.toThrow("prompt is too long");

    expect(completes).toBe(2);
  });

  test("does not compact or retry an overflow when compaction is disabled", async () => {
    await seedModerateTranscript();
    let completes = 0;
    let summarizeCalls = 0;

    await expect(
      runNativeTurn(handle, "next", opts(), {
        contextWindow: BACKSTOP_WINDOW,
        compaction: { ...cfg, enabled: false },
        summarize: async () => {
          summarizeCalls += 1;
          return { text: "summary", usage, costUsd: 0 };
        },
        complete: async () => {
          completes += 1;
          throw new ProtocolStreamError({ kind: "context-overflow", message: "prompt is too long" });
        },
      }),
    ).rejects.toThrow("prompt is too long");

    expect(summarizeCalls).toBe(0);
    expect(completes).toBe(1);
  });

  test("does not retry an overflow when the summarizer already failed this round trip", async () => {
    await seedOversizedTranscript();
    let completes = 0;

    await expect(
      runNativeTurn(handle, "next", opts(), {
        contextWindow: 8000, // proactive fires first, and fails
        compaction: cfg,
        summarize: async () => {
          throw new Error("summarizer unavailable");
        },
        complete: async () => {
          completes += 1;
          throw new ProtocolStreamError({ kind: "context-overflow", message: "prompt is too long" });
        },
      }),
    ).rejects.toThrow("prompt is too long");

    // One attempt only: paying twice to fail the same way helps nobody.
    expect(completes).toBe(1);
  });

  test("leaves a non-overflow protocol error alone", async () => {
    await seedModerateTranscript();
    let completes = 0;

    await expect(
      runNativeTurn(handle, "next", opts(), {
        contextWindow: BACKSTOP_WINDOW,
        compaction: cfg,
        summarize: async () => ({ text: "summary", usage, costUsd: 0 }),
        complete: async () => {
          completes += 1;
          throw new ProtocolStreamError({ kind: "rate-limit", message: "429" });
        },
      }),
    ).rejects.toThrow("429");

    expect(completes).toBe(1);
  });
});
