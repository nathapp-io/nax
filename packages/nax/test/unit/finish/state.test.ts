import { describe, expect, test } from "bun:test";
import { assertNaxError } from "@test/helpers";
import { NaxError } from "@/errors";
import type { FinishPhase } from "@/finish";
import { createFinishState, deserializeFinishState, serializeFinishState } from "@/finish";

const ALL_PHASES: FinishPhase[] = ["acceptance", "spec", "quality", "review", "gate"];

const BASE_INIT = {
  feature: "finish-core",
  workdir: "/repo",
  branch: "feat/finish-core",
  runId: "run-1",
  base: "origin/main",
  specPath: ".nax/features/finish-core/spec.md",
};

describe("createFinishState", () => {
  test("fresh state has all five phases present with every counter zero", () => {
    const state = createFinishState(BASE_INIT);

    expect(state.status).toBe("running");
    expect(Object.keys(state.phases).sort()).toEqual([...ALL_PHASES].sort());
    for (const phase of ALL_PHASES) {
      expect(state.phases[phase]).toEqual({
        fixAttempts: 0,
        reviewAttempts: 0,
        rounds: 0,
      });
    }
  });
});

describe("serializeFinishState / deserializeFinishState", () => {
  test("round-trips through serialize/deserialize deep-equal", () => {
    const state = createFinishState(BASE_INIT);
    const text = serializeFinishState(state);
    const roundTripped = deserializeFinishState(text);

    expect(roundTripped).toEqual(state);
  });

  test("throws FINISH_STATE_VERSION on a payload with version other than 3", () => {
    const state = createFinishState(BASE_INIT);
    const badPayload = JSON.stringify({ ...state, version: 2 });

    expect(() => deserializeFinishState(badPayload)).toThrow(NaxError);
    try {
      deserializeFinishState(badPayload);
      throw new Error("expected deserializeFinishState to throw");
    } catch (err) {
      assertNaxError(err);
      expect(err.code).toBe("FINISH_STATE_VERSION");
    }
  });

  test("throws FINISH_STATE_UNPARSEABLE on invalid JSON", () => {
    expect(() => deserializeFinishState("not json")).toThrow(NaxError);
    try {
      deserializeFinishState("not json");
      throw new Error("expected deserializeFinishState to throw");
    } catch (err) {
      assertNaxError(err);
      expect(err.code).toBe("FINISH_STATE_UNPARSEABLE");
    }
  });

  test("serialized JSON has no function-valued or undefined-valued keys", () => {
    const state = createFinishState(BASE_INIT);
    const parsed = JSON.parse(serializeFinishState(state)) as Record<string, unknown>;

    const walk = (value: unknown): void => {
      if (typeof value === "function") {
        throw new Error("found function-valued key");
      }
      if (Array.isArray(value)) {
        for (const item of value) walk(item);
        return;
      }
      if (value !== null && typeof value === "object") {
        for (const [_key, v] of Object.entries(value)) {
          expect(v).not.toBeUndefined();
          walk(v);
        }
      }
    };

    walk(parsed);
  });
});

describe("A4 finish state", () => {
  test("createFinishState is version 3 with a zeroed review loop and five phases", () => {
    const s = createFinishState(BASE_INIT);
    expect(s.version).toBe(3);
    expect(Object.keys(s.phases).sort()).toEqual(["acceptance", "gate", "quality", "review", "spec"]);
    expect(s.review).toEqual({
      rounds: 0,
      lastFindings: [],
      missingLenses: [],
      unresolved: [],
      reReviewUsed: false,
      committedFixes: false,
      covered: { spec: [], quality: [] },
      ledger: [],
    });
    expect(s.unreviewedFixCommits).toEqual([]);
    expect(s).not.toHaveProperty("escalationReason");
  });

  test("a version 1 state is rejected", () => {
    expect(() => deserializeFinishState('{"version":1}')).toThrow("unsupported version");
  });

  test("a version 3 state round-trips", () => {
    const s = createFinishState(BASE_INIT);
    expect(deserializeFinishState(serializeFinishState(s))).toEqual(s);
  });

  test("a version 3 checkpoint written with the removed lastFixBase field still loads", () => {
    const s = createFinishState(BASE_INIT);
    const old = JSON.stringify({ ...s, lastFixBase: { baseSha: "a", headSha: "a", untrackedBefore: [] } });
    const loaded = deserializeFinishState(old);
    expect(loaded.feature).toBe(s.feature);
    expect(loaded.handoffs).toEqual([]);
  });

  test("a new state has no lastFixBase", () => {
    expect(createFinishState(BASE_INIT)).not.toHaveProperty("lastFixBase");
  });
});
