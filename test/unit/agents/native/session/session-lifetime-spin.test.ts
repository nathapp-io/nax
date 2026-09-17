/**
 * Spin-breaker session-lifetime tests (nax#2047 follow-up to nax#2013).
 *
 * The breaker used to be constructed per `runNativeTurn`, so the second turn of
 * a fix round started its counter at zero and never saw the prior turn's
 * evidence. These tests pin the lifetime semantics on the session:
 *
 *   1. The same `handle.id` reuses the same live `SpinBreaker` instance across
 *      turns, so the cumulative counter survives.
 *   2. Two different session names get independent breakers.
 *   3. `closeNativeSession` evicts the breaker, so a new session of the same
 *      name starts fresh.
 *   4. A session opened without `opts.spinBreaker` has no breaker — same as
 *      before the map existed.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeNativeSession, nativeSessionSpinBreaker, openNativeSession } from "@/agents/native/session/session";
import { runNativeTurn } from "@/agents/native/session/turn-loop";
import type { TurnDeps } from "@/agents/native/session/turn-types";
import type { OpenSessionOpts, SendTurnOpts, SessionHandle } from "@/agents/session-types";
import {
  DEFAULT_SPIN_BREAKER_SETTINGS,
  type ResolvedSpinBreakerSettings,
  type SpinBreaker,
} from "@/runtime/spin-breaker";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nax-session-spin-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const opts = (over: Partial<OpenSessionOpts> = {}): OpenSessionOpts => ({
  agentName: "native",
  workdir: "/tmp",
  resolvedPermissions: { mode: "approve-all" },
  modelDef: { provider: "unknown", model: "openrouter/deepseek/deepseek-v4-flash" },
  timeoutSeconds: 60,
  transcriptDir: dir,
  ...over,
});

/** A model that always asks for the same RunCommand — the shape #2047 measured. */
function loopingComplete(maxToolCalls: number): TurnDeps["complete"] {
  let produced = 0;
  return async () => {
    produced += 1;
    if (produced > maxToolCalls) {
      return { text: "done", usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 };
    }
    return {
      text: "",
      toolCalls: [{ id: `c${produced}`, name: "RunCommand", input: { command: "testScoped" } }],
      usage: { inputTokens: 1, outputTokens: 1 },
      costUsd: 0,
    };
  };
}

const interactionHandler: SendTurnOpts["interactionHandler"] = {
  onInteraction: async () => ({ answer: "ok" }),
};

/**
 * Drives `runNativeTurn` against a handle whose session is already open,
 * passing the live breaker the session map holds. This is exactly the wiring
 * the adapter does for real sessions (adapter.ts:302-303) — but bypassing the
 * adapter lets the test observe the same instance it pulled from the map,
 * which is what we want to assert about.
 */
async function runTurnAgainst(handle: SessionHandle, breaker: SpinBreaker | undefined, maxToolCalls: number) {
  return runNativeTurn(
    handle,
    "hi",
    { interactionHandler },
    {
      complete: loopingComplete(maxToolCalls),
      ...(breaker !== undefined ? { spinBreaker: breaker } : {}),
    },
  );
}

/**
 * Like `runTurnAgainst`, but takes the model and a per-call answer directly.
 * The nax#2120 cross-turn reprieve test needs CHANGING results so the raw
 * backstop — not the same-result axis — is what fires and gets reprieved.
 */
async function runTurnWith(
  handle: SessionHandle,
  breaker: SpinBreaker | undefined,
  complete: TurnDeps["complete"],
  answer: () => string,
) {
  return runNativeTurn(
    handle,
    "hi",
    { interactionHandler: { onInteraction: async () => ({ answer: answer() }) } },
    {
      complete,
      ...(breaker !== undefined ? { spinBreaker: breaker } : {}),
    },
  );
}

describe("spin breaker — session lifetime (nax#2047)", () => {
  test("two turns on the same handle.id share the cumulative per-key counter", async () => {
    // 7 < 12 → no stop on turn 1. Turn 2 continues the same cumulative count,
    // but under nax#2120 it must now spend the (3) nudge ladder before it can
    // stop, so the hard stop lands at call 8 of turn 2 rather than reaching 12
    // on the combined counter. 25 is comfortably past that hard-stop point, so
    // this holds under the later nax#2120 tasks too.
    const settings: ResolvedSpinBreakerSettings = {
      ...DEFAULT_SPIN_BREAKER_SETTINGS,
      stopAfterSameKeyRepeats: 12,
    };
    const handle = await openNativeSession("sess-shared", opts({ spinBreaker: settings }));

    const breaker = nativeSessionSpinBreaker.get("sess-shared");
    expect(breaker).toBeDefined();

    const first = await runTurnAgainst(handle, breaker, 7);
    expect(first.spinStopped).toBeUndefined();
    expect(first.output).toBe("done");

    const second = await runTurnAgainst(handle, breaker, 25);
    expect(second.spinStopped).toBe(true);
    expect(second.turnIncomplete).toBe(true);

    await closeNativeSession(handle, false);
  });

  test("two different session names get independent breakers", async () => {
    const settings: ResolvedSpinBreakerSettings = {
      ...DEFAULT_SPIN_BREAKER_SETTINGS,
      stopAfterSameKeyRepeats: 12,
    };
    const handleA = await openNativeSession("sess-iso-a", opts({ spinBreaker: settings }));
    const handleB = await openNativeSession("sess-iso-b", opts({ spinBreaker: settings }));

    const breakerA = nativeSessionSpinBreaker.get("sess-iso-a");
    const breakerB = nativeSessionSpinBreaker.get("sess-iso-b");
    expect(breakerA).toBeDefined();
    expect(breakerB).toBeDefined();
    expect(breakerA).not.toBe(breakerB);

    // 11 identical calls each — under the cap of 12, so neither stops.
    const resultA = await runTurnAgainst(handleA, breakerA, 11);
    expect(resultA.spinStopped).toBeUndefined();

    const resultB = await runTurnAgainst(handleB, breakerB, 11);
    expect(resultB.spinStopped).toBeUndefined();

    await closeNativeSession(handleA, false);
    await closeNativeSession(handleB, false);
  });

  test("closeNativeSession evicts the breaker so a reused name starts fresh", async () => {
    const settings: ResolvedSpinBreakerSettings = {
      ...DEFAULT_SPIN_BREAKER_SETTINGS,
      stopAfterSameKeyRepeats: 12,
    };
    const handleA = await openNativeSession("sess-reuse", opts({ spinBreaker: settings }));
    const breakerA = nativeSessionSpinBreaker.get("sess-reuse");

    // Drive 11 calls into session A — counter is at 11 but below the cap.
    const first = await runTurnAgainst(handleA, breakerA, 11);
    expect(first.spinStopped).toBeUndefined();

    await closeNativeSession(handleA, false);
    expect(nativeSessionSpinBreaker.has("sess-reuse")).toBe(false);

    // Reopen with the same name and same settings.
    const handleB = await openNativeSession("sess-reuse", opts({ spinBreaker: settings }));
    const breakerB = nativeSessionSpinBreaker.get("sess-reuse");
    expect(breakerB).toBeDefined();
    expect(breakerB).not.toBe(breakerA);

    // Fresh counter — 11 calls must NOT stop. A leaked breaker from session A
    // would already have 11 counted and would trip on the next call.
    const second = await runTurnAgainst(handleB, breakerB, 11);
    expect(second.spinStopped).toBeUndefined();

    await closeNativeSession(handleB, false);
  });

  test("a session without opts.spinBreaker has no breaker registered", async () => {
    const handle = await openNativeSession("sess-none", opts());
    expect(nativeSessionSpinBreaker.has("sess-none")).toBe(false);

    // Drive the same looping shape and assert no spin flag — same behaviour
    // as the pre-#2013 path: no breaker, no enforcement.
    const result = await runTurnAgainst(handle, undefined, 5);
    expect(result.spinStopped).toBeUndefined();
    expect(result.output).toBe("done");

    await closeNativeSession(handle, false);
  });

  // nax#2120 Important #1: the first stop is reprieved by the turn loop
  // (Task 4), so `spinStopped` stays unset and the SAME breaker keeps going
  // into the next turn. Before the fix `repeatsSinceProgress` stayed latched
  // near stopAfterRepeats, so the next turn's second repeated call stopped
  // cold (reason repeat-run, nudges already spent). A real stop must consume
  // the run evidence so it re-accumulates in full.
  test("a reprieved first stop does not make the next turn stop cold", async () => {
    const settings: ResolvedSpinBreakerSettings = { ...DEFAULT_SPIN_BREAKER_SETTINGS };
    const handle = await openNativeSession("sess-reprieve", opts({ spinBreaker: settings }));
    const breaker = nativeSessionSpinBreaker.get("sess-reprieve");
    expect(breaker).toBeDefined();

    let answered = 0;
    const uniqueAnswer = () => {
      answered += 1;
      return `unique result ${answered}`;
    };
    let turn1Produced = 0;
    const turn1 = async () => {
      turn1Produced += 1;
      if (turn1Produced > 50) {
        return { text: "done", usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 };
      }
      return {
        text: "",
        toolCalls: [{ id: `t1-${turn1Produced}`, name: "RunCommand", input: { command: "testScoped" } }],
        usage: { inputTokens: 1, outputTokens: 1 },
        costUsd: 0,
      };
    };

    // Changing results keep the same-result axis silent; the raw per-key
    // backstop fires at call 50, with `repeatsSinceProgress` at 48. That stop
    // is the first, so the turn loop reprieves it and the model closes out.
    const first = await runTurnWith(handle, breaker, turn1, uniqueAnswer);
    expect(first.spinStopped).toBeUndefined();
    expect(first.output).toBe("done");

    // Turn 2 makes three more repeats of the same key. Before the fix the
    // second call reached rsp 50 and stopped cold; now the run restarts and
    // all three are allowed before the model answers.
    let turn2Produced = 0;
    const turn2 = async () => {
      turn2Produced += 1;
      if (turn2Produced > 3) {
        return { text: "done", usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 };
      }
      return {
        text: "",
        toolCalls: [{ id: `t2-${turn2Produced}`, name: "RunCommand", input: { command: "testScoped" } }],
        usage: { inputTokens: 1, outputTokens: 1 },
        costUsd: 0,
      };
    };

    const second = await runTurnWith(handle, breaker, turn2, uniqueAnswer);
    expect(second.spinStopped).toBeUndefined();
    expect(second.output).toBe("done");

    await closeNativeSession(handle, false);
  });
});
