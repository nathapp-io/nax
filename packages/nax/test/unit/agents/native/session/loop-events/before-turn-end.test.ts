/**
 * P3 `before_turn_end` — the last seam event, dispatched in turn-loop.ts at
 * each turn ENDING, before the final saveTranscript (spec 6.4).
 *
 * The only event that can spend money on its own: a handler's `followUp`
 * re-enters the loop with another user turn. Two bounds come with it:
 *
 *   1. A cap per turn — MAX_FOLLOW_UPS_PER_TURN (3) injections, then the
 *      channel stops and the turn ends.
 *   2. No injection after a STOP — a turn that ended by the spin breaker
 *      (nax#2120), the invalid-call budget (nax#2047), or the deadline
 *      carries `stopped: true` and any followUp returned is ignored.
 *      Resurrecting a turn a breaker just killed would re-open the exact
 *      loops those breakers exist to close, through the back door. The
 *      payload's `stopped` flag is all a handler sees — which breaker fired
 *      is not leaked.
 *
 * The stop doubles reuse the existing regression shapes rather than inventing
 * new ones: the aggressive createSpinBreaker and the malformed-input budget
 * drive from turn-loop-seam.test.ts (AC13/AC18), and the createTurnDeadline
 * fake clock from turn-loop.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLoopEventRegistry } from "@/agents/native/session/loop-events";
import type { BeforeTurnEndPayload } from "@/agents/native/session/loop-events/types";
import { nativeTranscriptDirs } from "@/agents/native/session/session";
import { loadTranscript } from "@/agents/native/session/transcript-store";
import { runNativeTurn } from "@/agents/native/session/turn-loop";
import type { SendTurnOpts } from "@/agents/session-types";
import { createTurnDeadline } from "@/agents/turn-deadline";
import { createSpinBreaker, DEFAULT_SPIN_BREAKER_SETTINGS } from "@/runtime/spin-breaker";
import type { CodingTool } from "@/tools";

const baseUsage = { inputTokens: 1, outputTokens: 1 };

let dir: string;
const handle = { id: "sess-before-turn-end", agentName: "native" } as const;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nax-before-turn-end-"));
  nativeTranscriptDirs.set(handle.id, dir);
});
afterEach(async () => {
  nativeTranscriptDirs.delete(handle.id);
  await rm(dir, { recursive: true, force: true });
});

const reply = (over: Record<string, unknown> = {}) => ({ text: "done", usage: baseUsage, costUsd: 0, ...over });

// interactionHandler is SendTurnOpts' only required field, so a Partial override
// composes directly into a real SendTurnOpts — no cast needed (the seam fixture).
const baseOpts = (over: Partial<SendTurnOpts> = {}): SendTurnOpts => ({
  interactionHandler: { onInteraction: async () => ({ answer: "ok" }) },
  codingTools: [fakeRead],
  ...over,
});

const fakeRead: CodingTool = {
  name: "Read",
  description: "Read a file",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
  scope: { pathFields: ["path"] },
  async run() {
    return { content: "body" };
  },
};

describe("runNativeTurn — before_turn_end and the bounded followUp channel", () => {
  test("followUp re-enters the loop with another user turn", async () => {
    const payloads: BeforeTurnEndPayload[] = [];
    // Snapshotted INSIDE the handler: payload.messages is the loop's live
    // in-memory array (the documented fact), so its length must be read at
    // dispatch time, not after the turn has continued past it.
    const messageCounts: number[] = [];
    let dispatches = 0;
    const registry = createLoopEventRegistry();
    registry.register("before_turn_end", (p) => {
      dispatches += 1;
      payloads.push(p);
      messageCounts.push(p.messages.length);
      return dispatches === 1 ? { followUp: "what did you find?" } : {};
    });
    const sent: unknown[][] = [];
    let calls = 0;
    const result = await runNativeTurn(handle, "hi", baseOpts(), {
      loopEvents: registry,
      complete: async (messages) => {
        calls += 1;
        // Copied, not aliased: the loop pushes onto the array after this returns.
        sent.push([...messages]);
        return calls === 1 ? reply({ text: "done" }) : reply({ text: "final answer" });
      },
    });

    // The event fired at both turn endings, carrying the loop's facts: the
    // final in-memory array, the round-trip count, and the per-turn followUp
    // count (0 on the first ending, 1 after the honoured injection).
    expect(payloads).toHaveLength(2);
    expect(payloads[0]?.roundTrips).toBe(1);
    expect(payloads[0]?.stopped).toBe(false);
    expect(payloads[0]?.followUpsSoFar).toBe(0);
    expect(messageCounts[0]).toBe(2);
    expect(payloads[1]?.roundTrips).toBe(2);
    expect(payloads[1]?.stopped).toBe(false);
    expect(payloads[1]?.followUpsSoFar).toBe(1);
    expect(messageCounts[1]).toBe(4);
    // THE assertion: the follow-up USER message reached the provider as
    // another turn over the continued conversation.
    expect(sent[0]).toEqual([{ role: "user", content: "hi" }]);
    expect(sent[1]).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "done" },
      { role: "user", content: "what did you find?" },
    ]);
    // The turn's final result reflects the continued conversation, and the
    // transcript persists it — the result is built when the turn ENDS, not at
    // the honoured injection.
    expect(result.output).toBe("final answer");
    expect(result.internalRoundTrips).toBe(2);
    expect(result.turnIncomplete).toBeUndefined();
    const saved = await loadTranscript(dir, handle.id);
    expect(saved).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "done" },
      { role: "user", content: "what did you find?" },
      { role: "assistant", content: "final answer" },
    ]);
  });

  test("followUp is capped per turn", async () => {
    // MAX_FOLLOW_UPS_PER_TURN is 3 (turn-loop.ts). A handler returning
    // followUp unconditionally must not loop forever: exactly three
    // injections, then the channel stops and the turn ends.
    const MAX_FOLLOW_UPS_PER_TURN = 3;
    const payloads: BeforeTurnEndPayload[] = [];
    const registry = createLoopEventRegistry();
    registry.register("before_turn_end", (p) => {
      payloads.push(p);
      return { followUp: "again" };
    });
    let calls = 0;
    const result = await runNativeTurn(handle, "hi", baseOpts(), {
      loopEvents: registry,
      complete: async () => {
        calls += 1;
        return reply();
      },
    });

    // 1 + MAX round trips, then the turn ends — no infinite loop.
    expect(calls).toBe(MAX_FOLLOW_UPS_PER_TURN + 1);
    // followUpsSoFar climbs 0..MAX on each ending; the final dispatch reports
    // the cap and its followUp is dropped (the event still fires — only the
    // channel is capped).
    expect(payloads).toHaveLength(MAX_FOLLOW_UPS_PER_TURN + 1);
    expect(payloads.map((p) => p.followUpsSoFar)).toEqual([0, 1, 2, 3]);
    const saved = await loadTranscript(dir, handle.id);
    const injections = saved.filter((m) => m.role === "user" && m.content === "again");
    expect(injections).toHaveLength(MAX_FOLLOW_UPS_PER_TURN);
    expect(result.internalRoundTrips).toBe(MAX_FOLLOW_UPS_PER_TURN + 1);
    expect(result.output).toBe("done");
    expect(result.turnIncomplete).toBeUndefined();
  });

  test("followUp is NOT offered after a spin-breaker stop", async () => {
    const payloads: BeforeTurnEndPayload[] = [];
    const registry = createLoopEventRegistry();
    registry.register("before_turn_end", (p) => {
      payloads.push(p);
      // Tries to resurrect the stopped turn — must be ignored.
      return { followUp: "keep going" };
    });
    let calls = 0;
    const result = await runNativeTurn(handle, "hi", baseOpts(), {
      complete: async () => {
        calls += 1;
        // Same call every round trip so the breaker fires on the second
        // occurrence (first is allow, second is stop).
        return {
          text: "",
          toolCalls: [{ id: `c${calls}`, name: "Read", input: { path: "a.ts" } }],
          usage: baseUsage,
          costUsd: 0,
        };
      },
      loopEvents: registry,
      // Aggressive breaker — one repeat already trips the raw backstop.
      spinBreaker: createSpinBreaker({
        ...DEFAULT_SPIN_BREAKER_SETTINGS,
        nudgeAfterRepeats: 0,
        stopAfterRepeats: 1,
        maxNudges: 0,
      }),
    });

    expect(result.spinStopped).toBe(true);
    // The event still fires — once — but the payload says STOP and the
    // handler's followUp was ignored: no extra provider round trip, no
    // injected user message in the transcript.
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.stopped).toBe(true);
    expect(payloads[0]?.followUpsSoFar).toBe(0);
    // The double's own shape (pinned live): the stop verdict fires on the
    // first call, whose tool-result is the terminal notice; round trip 2 is
    // the terminal trip nax#2120 spends, and its batch stops via the
    // spinWarned snapshot. An honoured followUp would have made a 3rd call.
    expect(calls).toBe(2);
    const saved = await loadTranscript(dir, handle.id);
    expect(saved.filter((m) => m.role === "user" && m.content === "keep going")).toHaveLength(0);
  });

  test("followUp is NOT offered after the invalid-call budget trips", async () => {
    const payloads: BeforeTurnEndPayload[] = [];
    const registry = createLoopEventRegistry();
    registry.register("before_turn_end", (p) => {
      payloads.push(p);
      return { followUp: "try again" };
    });
    let calls = 0;
    const result = await runNativeTurn(handle, "hi", baseOpts(), {
      complete: async () => {
        calls += 1;
        // Three identical malformed calls — the 3rd trips the budget.
        if (calls <= 3) {
          return {
            text: "",
            toolCalls: [{ id: `c${calls}`, name: "Read", input: { path: 42 } }],
            usage: baseUsage,
            costUsd: 0,
          };
        }
        return reply();
      },
      loopEvents: registry,
    });

    expect(result.invalidCallBudgetExceeded).toBe(true);
    // Same rule (nax#2047): the event fired once, as a STOP — the followUp
    // was ignored, so the wrap-up reply above was never requested.
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.stopped).toBe(true);
    expect(payloads[0]?.followUpsSoFar).toBe(0);
    expect(calls).toBe(3);
    const saved = await loadTranscript(dir, handle.id);
    expect(saved.filter((m) => m.role === "user" && m.content === "try again")).toHaveLength(0);
  });

  test("followUp is NOT offered after a deadline timeout", async () => {
    const payloads: BeforeTurnEndPayload[] = [];
    const registry = createLoopEventRegistry();
    registry.register("before_turn_end", (p) => {
      payloads.push(p);
      return { followUp: "one more" };
    });
    let now = 0;
    let calls = 0;
    const result = await runNativeTurn(handle, "hi", baseOpts(), {
      deadline: createTurnDeadline(30, () => now),
      complete: async () => {
        calls += 1;
        now += 20_000; // two round trips fit; the third must not start
        return {
          text: "partial progress",
          toolCalls: [{ id: "c1", name: "query_neighbor", input: {} }],
          usage: baseUsage,
          costUsd: 0,
        };
      },
      loopEvents: registry,
    });

    expect(result.timedOut).toBe(true);
    // The event fired once, as a STOP — the followUp was ignored.
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.roundTrips).toBe(2);
    expect(payloads[0]?.stopped).toBe(true);
    expect(payloads[0]?.followUpsSoFar).toBe(0);
    expect(calls).toBe(2);
    const saved = await loadTranscript(dir, handle.id);
    expect(saved.filter((m) => m.role === "user" && m.content === "one more")).toHaveLength(0);
  });
});

describe("review #20: before_turn_end on the error path", () => {
  test("a normal ending reports ended=completed", async () => {
    const registry = createLoopEventRegistry();
    const ended: string[] = [];
    registry.register("before_turn_end", (p) => {
      ended.push(p.ended);
      return {};
    });
    await runNativeTurn(handle, "hi", baseOpts(), {
      loopEvents: registry,
      complete: async () => reply({ text: "done" }),
    });
    expect(ended).toEqual(["completed"]);
  });

  test("a throwing turn fires once with ended=errored and rethrows the same error", async () => {
    const registry = createLoopEventRegistry();
    const ended: string[] = [];
    registry.register("before_turn_end", (p) => {
      ended.push(p.ended);
      return { followUp: "ignored" };
    });
    const boom = new Error("provider down");
    const err = await runNativeTurn(handle, "hi", baseOpts(), {
      loopEvents: registry,
      complete: async () => {
        throw boom;
      },
    }).catch((e: unknown) => e);
    expect(err).toBe(boom);
    expect(ended).toEqual(["errored"]);
  });

  test("an aborted turn reports ended=aborted", async () => {
    const registry = createLoopEventRegistry();
    const ended: string[] = [];
    registry.register("before_turn_end", (p) => {
      ended.push(p.ended);
      return {};
    });
    const ac = new AbortController();
    // deps.signal (4th argument) is what the catch reads; opts.signal alone is not threaded into it.
    await runNativeTurn(handle, "hi", baseOpts({ signal: ac.signal }), {
      loopEvents: registry,
      signal: ac.signal,
      complete: async () => {
        ac.abort();
        throw new DOMException("aborted", "AbortError");
      },
    }).catch(() => undefined);
    expect(ended).toEqual(["aborted"]);
  });
});
