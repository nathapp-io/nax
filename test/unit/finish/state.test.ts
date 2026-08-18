import { describe, expect, test } from "bun:test";
import { NaxError } from "@/errors";
import { createFinishState, deserializeFinishState, serializeFinishState } from "@/finish";
import type { FinishPhase } from "@/finish";

const ALL_PHASES: FinishPhase[] = ["acceptance", "spec", "quality", "gate"];

const BASE_INIT = {
  feature: "finish-core",
  workdir: "/repo",
  branch: "feat/finish-core",
  runId: "run-1",
  base: "origin/main",
  specPath: ".nax/features/finish-core/spec.md",
};

describe("createFinishState", () => {
  test("fresh state has all four phases present with every counter zero", () => {
    const state = createFinishState(BASE_INIT);

    expect(state.status).toBe("running");
    expect(Object.keys(state.phases).sort()).toEqual([...ALL_PHASES].sort());
    for (const phase of ALL_PHASES) {
      expect(state.phases[phase]).toEqual({
        fixAttempts: 0,
        reviewAttempts: 0,
        incompleteAttempts: 0,
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

  test("throws FINISH_STATE_VERSION on a payload with version other than 1", () => {
    const state = createFinishState(BASE_INIT);
    const badPayload = JSON.stringify({ ...state, version: 2 });

    expect(() => deserializeFinishState(badPayload)).toThrow(NaxError);
    try {
      deserializeFinishState(badPayload);
      throw new Error("expected deserializeFinishState to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(NaxError);
      expect((err as NaxError).code).toBe("FINISH_STATE_VERSION");
    }
  });

  test("throws FINISH_STATE_UNPARSEABLE on invalid JSON", () => {
    expect(() => deserializeFinishState("not json")).toThrow(NaxError);
    try {
      deserializeFinishState("not json");
      throw new Error("expected deserializeFinishState to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(NaxError);
      expect((err as NaxError).code).toBe("FINISH_STATE_UNPARSEABLE");
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
        for (const [key, v] of Object.entries(value)) {
          expect(v).not.toBeUndefined();
          walk(v);
        }
      }
    };

    walk(parsed);
  });
});
