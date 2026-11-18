/**
 * flow-handoff-input.ts — the handoff form of `nax-flow__send`: one feature the
 * chain already ran in this chat, beside the roles and the cap koda bills against.
 *
 * The handoff form reuses the spec form's role and cost-cap rules rather than
 * restating them, so the cost-cap case here asserts the *same* message
 * `parseFlowSendInput` produces instead of a copy of the text.
 */

import { describe, expect, test } from "bun:test";
import {
  FLOW_FEATURE_NAME_RE,
  type FlowHandoffInput,
  formatHandoffCostCap,
  handoffStepArgv,
  parseFlowHandoffInput,
  parseFlowSendInput,
} from "@/chat/flow";

const SPEC_PATH = ".nax/features/f1/spec.md";

/** The brief's own example: feature `f1`, one role model twice, a $5 cap. */
function validRaw(): Record<string, unknown> {
  return {
    handoff: { feature: "f1" },
    roles: { reviewer: "acp:claude", supervisor: "acp:claude" },
    costCapUsd: 5,
  };
}

/** The parsed input, or a failure naming what the parser refused. */
function inputOf(raw: Record<string, unknown>): FlowHandoffInput {
  const result = parseFlowHandoffInput(raw);
  if ("errors" in result) throw new Error(`expected a parsed input, got errors: ${result.errors.join("; ")}`);
  return result;
}

/** The errors the parser returned; fails the test when it returned an input instead. */
function errorsOf(raw: Record<string, unknown>): string[] {
  const result = parseFlowHandoffInput(raw);
  if (!("errors" in result)) {
    throw new Error(`expected errors, got a parsed input: ${JSON.stringify(result)}`);
  }
  return result.errors;
}

/** The single error a one-cause input must yield, so a stray extra message fails the test. */
function singleError(raw: Record<string, unknown>): string {
  const errors = errorsOf(raw);
  expect(errors).toHaveLength(1);
  return errors[0] ?? "";
}

/** The spec form's cost-cap message for `costCapUsd`, read back from `parseFlowSendInput`. */
function specFormCostCapError(costCapUsd: number): string {
  const result = parseFlowSendInput({
    features: [{ feature: "f1", specPath: SPEC_PATH }],
    roles: { reviewer: "acp:claude", supervisor: "acp:claude" },
    costCapUsd,
  });
  if (!("errors" in result)) throw new Error("expected the spec form to refuse this cost cap");
  const error = result.errors.find((entry) => entry.includes("costCapUsd"));
  if (error === undefined) throw new Error(`expected a costCapUsd error, got: ${result.errors.join("; ")}`);
  return error;
}

describe("parseFlowHandoffInput", () => {
  test("returns the feature, roles and cap the handoff form carries (AC-1)", () => {
    expect(inputOf(validRaw())).toEqual({
      feature: "f1",
      roles: { reviewer: "acp:claude", supervisor: "acp:claude" },
      costCapUsd: 5,
    });
  });

  test("returns errors naming handoff.feature when the feature carries a path segment (AC-2)", () => {
    const error = singleError({ ...validRaw(), handoff: { feature: "../x" } });

    expect(error).toContain("handoff.feature");
    expect(error).toContain("../x");
  });

  test("applies the feature-name charset, not only the path rules", () => {
    for (const feature of ["-f1", "f 1", `a${"b".repeat(128)}`]) {
      expect(singleError({ ...validRaw(), handoff: { feature } })).toContain("handoff.feature");
    }
  });

  test("refuses a name the workflow helpers cannot turn into a feature directory (AC-2)", () => {
    // koda's wire charset accepts both; `featureDir` does not, so a handoff for either would pass
    // approval and then find no record to send.
    for (const feature of ["a..b", "a".repeat(65)]) {
      expect(FLOW_FEATURE_NAME_RE.test(feature)).toBe(true);
      const error = singleError({ ...validRaw(), handoff: { feature } });
      expect(error).toContain("handoff.feature");
      expect(error).toContain("is not a usable feature name");
    }
  });

  test("accepts the longest name a feature directory holds", () => {
    expect(inputOf({ ...validRaw(), handoff: { feature: "a".repeat(64) } }).feature).toBe("a".repeat(64));
  });

  test("returns the spec form's own cost-cap error for 1.23456 (AC-3)", () => {
    expect(errorsOf({ ...validRaw(), costCapUsd: 1.23456 })).toEqual([specFormCostCapError(1.23456)]);
  });

  test("applies the spec form's role rules, naming the role that breaks them", () => {
    const error = singleError({ ...validRaw(), roles: { reviewer: "acp claude", supervisor: "acp:claude" } });

    expect(error).toContain("roles.reviewer");
  });

  test("returns errors naming the unknown key when handoff carries one the form does not declare (AC-4)", () => {
    const error = singleError({ ...validRaw(), handoff: { feature: "f1", specPath: SPEC_PATH } });

    expect(error).toContain("handoff");
    expect(error).toContain("specPath");
  });

  test("returns errors naming the unknown key when the form carries one it does not declare", () => {
    expect(singleError({ ...validRaw(), features: [] })).toContain("features");
  });

  test("returns errors naming handoff when it is not an object", () => {
    for (const handoff of ["f1", ["f1"], null]) {
      expect(singleError({ ...validRaw(), handoff })).toContain("handoff");
    }
  });

  test("returns errors naming handoff.feature when it is missing or not a string", () => {
    for (const handoff of [{}, { feature: 7 }]) {
      expect(singleError({ ...validRaw(), handoff })).toContain("handoff.feature");
    }
  });

  test("reports every violation rather than stopping at the first", () => {
    const errors = errorsOf({
      ...validRaw(),
      handoff: { feature: "../x" },
      roles: { reviewer: "acp claude" },
      costCapUsd: 0,
    });

    expect(errors).toHaveLength(4);
    expect(errors[0]).toContain("handoff.feature");
    expect(errors[1]).toContain("roles.reviewer");
    expect(errors[2]).toContain("roles.supervisor");
    expect(errors[3]).toContain("costCapUsd");
  });
});

describe("handoffStepArgv", () => {
  test("is the token list a chain step and the tool call are compared by (AC-7)", () => {
    const argv = handoffStepArgv({ feature: "f1", roles: { reviewer: "r", supervisor: "s" }, costCapUsd: 5 });

    expect(argv).toEqual([
      "nax-flow__send",
      "--handoff",
      "f1",
      "--reviewer",
      "r",
      "--supervisor",
      "s",
      "--cost-cap",
      "5",
    ]);
  });

  test("writes the cap as the string the tool call carries", () => {
    const argv = handoffStepArgv({ feature: "f1", roles: { reviewer: "r", supervisor: "s" }, costCapUsd: 0.0001 });

    expect(argv[argv.length - 1]).toBe("0.0001");
  });
});

describe("formatHandoffCostCap (AC-11)", () => {
  test.each([
    [5, "5.00"],
    [5.5, "5.50"],
    [5.25, "5.25"],
    [0.0001, "0.0001"],
    [5.004, "5.004"],
    [5.0005, "5.0005"],
  ])("prints %p as the request authorizes it", (cap, expected) => {
    expect(formatHandoffCostCap(cap)).toBe(expected);
  });

  test("never rounds a cap the parser accepts, so the card and the request agree", () => {
    for (const cap of [5.001, 5.004, 5.0001, 12.3456]) {
      expect(formatHandoffCostCap(cap)).toBe(String(cap));
    }
  });
});
