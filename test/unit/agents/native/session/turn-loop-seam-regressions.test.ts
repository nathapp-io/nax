/**
 * Regression guards for the two defects the adversarial review found in the
 * US-002 seam (nax#2151). Both are invisible to the acceptance suites, which
 * is how they survived them:
 *
 *  1. A `before_tool` handler may rewrite a call's input, and the spin breaker
 *     observes the call through that seam. Noting the result against the
 *     model's ORIGINAL input leaves the observed key without a result, so the
 *     breaker's result axis silently stops working for rewritten calls — only
 *     the raw 50-call backstop still bounds them.
 *  2. The built-in handlers are per-turn, but a registry a caller reuses must
 *     not accumulate a fresh pair per turn: a stale pair keeps an earlier
 *     turn's budget and advances the shared breaker a second time per call,
 *     halving every threshold it is meant to enforce.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLoopEventRegistry } from "@/agents/native/session/loop-events";
import { nativeTranscriptDirs } from "@/agents/native/session/session";
import { runNativeTurn } from "@/agents/native/session/turn-loop";
import type { TurnDeps } from "@/agents/native/session/turn-types";
import type { SendTurnOpts } from "@/agents/session-types";
import { createSpinBreaker, DEFAULT_SPIN_BREAKER_SETTINGS } from "@/runtime/spin-breaker";
import type { CodingTool } from "@/tools";

const baseUsage = { inputTokens: 1, outputTokens: 1 };

let dir: string;
const handle = { id: "sess-seam-regression", agentName: "native" } as const;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nax-turn-seam-regression-"));
  nativeTranscriptDirs.set("sess-seam-regression", dir);
});
afterEach(async () => {
  nativeTranscriptDirs.delete("sess-seam-regression");
  await rm(dir, { recursive: true, force: true });
});

const fakeRead: CodingTool = {
  name: "Read",
  description: "Read a file",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
  scope: { pathFields: ["path"] },
  async run() {
    return { content: "raw-body" };
  },
};

const baseOpts = (over: Partial<SendTurnOpts> = {}): SendTurnOpts => ({
  interactionHandler: { onInteraction: async () => ({ answer: "ok" }) },
  codingTools: [fakeRead],
  ...over,
});

/**
 * A model that keeps asking for the same tool, capped so that a turn which
 * should have stopped but does not still reaches a clean exit within the test.
 */
function loopingComplete(
  name: string,
  inputOf: (nth: number) => Record<string, unknown>,
  cap: number,
): TurnDeps["complete"] {
  let produced = 0;
  return async () => {
    produced += 1;
    if (produced > cap) return { text: "done", usage: baseUsage, costUsd: 0 };
    return {
      text: "",
      toolCalls: [{ id: `c${produced}`, name, input: inputOf(produced) }],
      usage: baseUsage,
      costUsd: 0,
    };
  };
}

describe("runNativeTurn — loop event seam regressions", () => {
  test("notes a rewritten call's result against the input the breaker observed", async () => {
    const registry = createLoopEventRegistry();
    // Every call is rewritten to one canonical input, so the breaker sees a
    // single repeated key while the model asks for a different one each time.
    registry.registerBeforeTool(() => ({ kind: "allow", input: { path: "canonical.ts" } }));

    const result = await runNativeTurn(handle, "hi", baseOpts(), {
      complete: loopingComplete("Read", (nth) => ({ path: `f${nth}.ts` }), 12),
      spinBreaker: createSpinBreaker({
        ...DEFAULT_SPIN_BREAKER_SETTINGS,
        stopAfterSameKeyRepeats: 2,
        maxNudges: 0,
      }),
      loopEvents: registry,
    });

    // The identical result on the same rewritten key is spin evidence: at a
    // threshold of 2 the stop verdict lands on the third occurrence, and the
    // next batch is what ends the turn — four round trips. Noting the result
    // against the model's original input instead means no same-result run ever
    // accumulates, so the turn rides the raw 50-call backstop, runs past the
    // stub's cap and finishes normally with no stop at all.
    expect(result.spinStopped).toBe(true);
    expect(result.internalRoundTrips).toBe(4);
  });

  test("reusing one registry across turns does not advance the breaker twice per call", async () => {
    const registry = createLoopEventRegistry();
    const breaker = createSpinBreaker({
      ...DEFAULT_SPIN_BREAKER_SETTINGS,
      nudgeAfterRepeats: 3,
      stopAfterRepeats: 6,
      maxNudges: 1,
    });

    // Turn 1 installs the built-ins on this registry and leaves the breaker
    // with no evidence: its single call is a new key, which resets the run.
    const first = await runNativeTurn(handle, "hi", baseOpts(), {
      complete: loopingComplete("Read", () => ({ path: "a.ts" }), 1),
      spinBreaker: breaker,
      loopEvents: registry,
    });
    expect(first.spinStopped).toBeUndefined();

    // Turn 2 loops one call. At the one-observe-per-call accounting the
    // thresholds are defined in, the stop lands on round trip 7 —
    // turn-loop-spin.test.ts pins the same numbers. A stale pair left behind
    // by turn 1 observing too would spend the run twice as fast.
    const second = await runNativeTurn(handle, "hi", baseOpts(), {
      complete: loopingComplete("RunCommand", () => ({ command: "testScoped" }), 20),
      spinBreaker: breaker,
      loopEvents: registry,
    });
    expect(second.spinStopped).toBe(true);
    expect(second.internalRoundTrips).toBe(7);
  });
});
