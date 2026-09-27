import { afterEach, describe, expect, test } from "bun:test";
import { makeNaxConfig, makeTestRuntime, opSelector } from "@test/helpers";
import { acceptanceConfigSelector } from "@/config";
import type { AcceptanceConfig } from "@/config/selectors";
import type { AcceptanceRefineInput } from "@/operations/acceptance-refine";
import type { BuildContext } from "@/operations/types";
import type { NaxRuntime } from "@/runtime";

const createdRuntimes: NaxRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});

import { parseRefinementResponse, refinementWouldFallback } from "@/acceptance";
import { ParseValidationError } from "@/agents/retry";
import { acceptanceRefineOp } from "@/operations";

const SAMPLE_INPUT: AcceptanceRefineInput = {
  criteria: ["User can log in", "User can log out"],
  codebaseContext: "# Context\nRelevant files...",
  storyId: "US-001",
  testStrategy: "component",
  testFramework: "react-testing-library",
  storyTitle: "Login flow",
  storyDescription: "Allow users to authenticate with email and password",
};

function makeBuildCtx() {
  const runtime = makeTestRuntime();
  createdRuntimes.push(runtime);
  const view = runtime.packages.repo();
  return { packageView: view, config: view.select(opSelector(acceptanceRefineOp.config)) };
}

describe("acceptanceRefineOp shape", () => {
  test("kind is complete", () => {
    expect(acceptanceRefineOp.kind).toBe("complete");
  });
  test("name is acceptance-refine", () => {
    expect(acceptanceRefineOp.name).toBe("acceptance-refine");
  });
  test("stage is acceptance", () => {
    expect(acceptanceRefineOp.stage).toBe("acceptance");
  });
  test("retry uses transient-network preset with maxAttempts 2", () => {
    expect(acceptanceRefineOp.retry).toMatchObject({ preset: "transient-network", maxAttempts: 2 });
  });
  test("model resolves from acceptance.model config", () => {
    const config = makeNaxConfig({
      acceptance: {
        model: { agent: "opencode", model: "opencode-go/minimax-m2.7" },
      },
    });
    const runtime = makeTestRuntime({ config });
    createdRuntimes.push(runtime);
    const view = runtime.packages.repo();
    const ctx: BuildContext<AcceptanceConfig> = { packageView: view, config: view.select(acceptanceConfigSelector) };
    const modelResolver = acceptanceRefineOp.model as (
      input: AcceptanceRefineInput,
      ctx: BuildContext<AcceptanceConfig>,
    ) => unknown;

    expect(modelResolver(SAMPLE_INPUT, ctx)).toEqual({
      agent: "opencode",
      model: "opencode-go/minimax-m2.7",
    });
  });

  test("model resolves from acceptance.generateModel when set (overrides acceptance.model)", () => {
    const config = makeNaxConfig({
      acceptance: {
        model: { agent: "opencode", model: "opencode-go/minimax-m2.7" },
        generateModel: { agent: "claude", model: "balanced" },
      },
    });
    const runtime = makeTestRuntime({ config });
    createdRuntimes.push(runtime);
    const view = runtime.packages.repo();
    const ctx: BuildContext<AcceptanceConfig> = { packageView: view, config: view.select(acceptanceConfigSelector) };
    const modelResolver = acceptanceRefineOp.model as (
      input: AcceptanceRefineInput,
      ctx: BuildContext<AcceptanceConfig>,
    ) => unknown;

    expect(modelResolver(SAMPLE_INPUT, ctx)).toEqual({
      agent: "opencode",
      model: "opencode-go/minimax-m2.7",
    });
  });

  test("model falls back to acceptance.model when generateModel is not set", () => {
    const config = makeNaxConfig({
      acceptance: {
        model: { agent: "opencode", model: "opencode-go/minimax-m2.7" },
      },
    });
    const runtime = makeTestRuntime({ config });
    createdRuntimes.push(runtime);
    const view = runtime.packages.repo();
    const ctx: BuildContext<AcceptanceConfig> = { packageView: view, config: view.select(acceptanceConfigSelector) };
    const modelResolver = acceptanceRefineOp.model as (
      input: AcceptanceRefineInput,
      ctx: BuildContext<AcceptanceConfig>,
    ) => unknown;

    expect(modelResolver(SAMPLE_INPUT, ctx)).toEqual({
      agent: "opencode",
      model: "opencode-go/minimax-m2.7",
    });
  });
});

describe("acceptanceRefineOp.build()", () => {
  test("returns ComposeInput with task section", () => {
    const ctx = makeBuildCtx();
    const result = acceptanceRefineOp.build(SAMPLE_INPUT, ctx);
    expect(result).toHaveProperty("task");
  });
  test("task section content contains criteria text", () => {
    const ctx = makeBuildCtx();
    const result = acceptanceRefineOp.build(SAMPLE_INPUT, ctx);
    expect(result.task.content).toContain("User can log in");
  });
  test("task section includes strategy/framework/story context", () => {
    const ctx = makeBuildCtx();
    const result = acceptanceRefineOp.build(SAMPLE_INPUT, ctx);
    expect(result.task.content).toContain("TEST STRATEGY: component");
    expect(result.task.content).toContain("react-testing-library");
    expect(result.task.content).toContain("Title: Login flow");
    expect(result.task.content).toContain("Description: Allow users to authenticate");
  });
});

describe("acceptanceRefineOp.parse()", () => {
  test("parses valid JSON array of RefinedCriterion", () => {
    const ctx = makeBuildCtx();
    const json = JSON.stringify([
      {
        original: "User can log in",
        refined: "login() returns true for valid credentials",
        testable: true,
        storyId: "US-001",
      },
      { original: "User can log out", refined: "logout() clears session token", testable: true, storyId: "US-001" },
    ]);
    const result = acceptanceRefineOp.parse(json, SAMPLE_INPUT, ctx);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
    expect(result[0].refined).toContain("login()");
  });
  test("throws ParseValidationError on malformed JSON instead of falling back", () => {
    const ctx = makeBuildCtx();
    expect(() => acceptanceRefineOp.parse("not json", SAMPLE_INPUT, ctx)).toThrow(ParseValidationError);
  });
  test("throws ParseValidationError on empty response to trigger retry", () => {
    const ctx = makeBuildCtx();
    expect(() => acceptanceRefineOp.parse("", SAMPLE_INPUT, ctx)).toThrow("acceptance-refine: empty output");
    expect(() => acceptanceRefineOp.parse("   \n  ", SAMPLE_INPUT, ctx)).toThrow("acceptance-refine: empty output");
  });
});

describe("acceptanceRefineOp.parse() — US-003 fails loud", () => {
  const THREE_CRITERIA_INPUT: AcceptanceRefineInput = {
    ...SAMPLE_INPUT,
    criteria: ["User can log in", "User can log out", "User can reset password"],
  };

  function item(original: string, refined: string, storyId?: string) {
    return storyId === undefined
      ? { original, refined, testable: true }
      : { original, refined, testable: true, storyId };
  }

  test("US-003 AC1: throws ParseValidationError when the model says it could not refine", () => {
    const ctx = makeBuildCtx();
    expect(() => acceptanceRefineOp.parse("I could not refine these criteria", THREE_CRITERIA_INPUT, ctx)).toThrow(
      ParseValidationError,
    );
  });

  test("US-003 AC1 boundary: usable JSON for every criterion still parses", () => {
    const ctx = makeBuildCtx();
    const json = JSON.stringify([
      item("User can log in", "login() returns true"),
      item("User can log out", "logout() clears the token"),
      item("User can reset password", "reset() sends a mail"),
    ]);
    expect(acceptanceRefineOp.parse(json, THREE_CRITERIA_INPUT, ctx)).toHaveLength(3);
  });

  test("US-003 AC2: throws ParseValidationError reporting the shortfall when too few criteria come back", () => {
    const ctx = makeBuildCtx();
    const json = JSON.stringify([
      item("User can log in", "login() returns true"),
      item("User can log out", "logout() clears the token"),
    ]);
    expect(() => acceptanceRefineOp.parse(json, THREE_CRITERIA_INPUT, ctx)).toThrow(ParseValidationError);
    expect(() => acceptanceRefineOp.parse(json, THREE_CRITERIA_INPUT, ctx)).toThrow("returned 2 of 3 criteria");
  });

  test("US-003 AC2 boundary: an empty array is a count mismatch, not a silent fallback", () => {
    const ctx = makeBuildCtx();
    expect(() => acceptanceRefineOp.parse("[]", THREE_CRITERIA_INPUT, ctx)).toThrow(ParseValidationError);
    expect(() => acceptanceRefineOp.parse("[]", THREE_CRITERIA_INPUT, ctx)).toThrow("returned 0 of 3 criteria");
  });

  test("US-003 AC3: throws ParseValidationError reporting the surplus when too many criteria come back", () => {
    const ctx = makeBuildCtx();
    const json = JSON.stringify([
      item("User can log in", "login() returns true"),
      item("User can log out", "logout() clears the token"),
      item("User can reset password", "reset() sends a mail"),
      item("User can register", "register() creates an account"),
    ]);
    expect(() => acceptanceRefineOp.parse(json, THREE_CRITERIA_INPUT, ctx)).toThrow(ParseValidationError);
    expect(() => acceptanceRefineOp.parse(json, THREE_CRITERIA_INPUT, ctx)).toThrow("returned 4 of 3 criteria");
  });

  test("US-003 AC4: returns one criterion per input criterion, defaulting storyId from the input", () => {
    const ctx = makeBuildCtx();
    const json = JSON.stringify([
      item("User can log in", "login() returns true"),
      item("User can log out", "logout() clears the token"),
      item("User can reset password", "reset() sends a mail"),
    ]);
    const result = acceptanceRefineOp.parse(json, THREE_CRITERIA_INPUT, ctx);
    expect(result).toHaveLength(THREE_CRITERIA_INPUT.criteria.length);
    for (const criterion of result) {
      expect(criterion.storyId).toBe(THREE_CRITERIA_INPUT.storyId);
    }
    expect(result.map((c) => c.original)).toEqual(THREE_CRITERIA_INPUT.criteria);
  });

  test("US-003 AC4 boundary: an explicit per-item storyId is preserved", () => {
    const ctx = makeBuildCtx();
    const json = JSON.stringify([
      item("User can log in", "login() returns true", "US-042"),
      item("User can log out", "logout() clears the token"),
      item("User can reset password", "reset() sends a mail"),
    ]);
    const result = acceptanceRefineOp.parse(json, THREE_CRITERIA_INPUT, ctx);
    expect(result[0]?.storyId).toBe("US-042");
    expect(result[1]?.storyId).toBe(THREE_CRITERIA_INPUT.storyId);
  });
});

describe("refinementWouldFallback (#3B observability)", () => {
  // The predicate must agree with parseRefinementResponse's ACTUAL fallback:
  // true only when the parser discards output and returns the unrefined criteria.
  test.each([
    ["", true],
    ["   \n  ", true],
    ["not json", true],
    ['{"passed":true}', true], // non-array → fallback
    ["[]", false], // empty array is a successful parse (returns []), NOT a fallback
  ] as const)("wouldFallback(%p) === %p", (output, expected) => {
    expect(refinementWouldFallback(output)).toBe(expected);
  });

  test("agrees with parseRefinementResponse on the fallback cases", () => {
    const criteria = ["User can log in", "User can log out"];
    for (const output of ["", "not json", '{"x":1}']) {
      // When wouldFallback is true, the parser returns exactly the unrefined criteria.
      expect(refinementWouldFallback(output)).toBe(true);
      expect(parseRefinementResponse(output, criteria).map((c) => c.refined)).toEqual(criteria);
    }
  });

  test("usable refinement array does not fall back", () => {
    const usable = JSON.stringify([{ original: "a", refined: "a()", testable: true, storyId: "" }]);
    expect(refinementWouldFallback(usable)).toBe(false);
  });

  test("fenced JSON array does not fall back", () => {
    const fenced = '```json\n[{"original":"a","refined":"a()","testable":true,"storyId":""}]\n```';
    expect(refinementWouldFallback(fenced)).toBe(false);
  });
  test("parses JSON wrapped in code fence", () => {
    const ctx = makeBuildCtx();
    const inner = JSON.stringify([
      { original: "User can log in", refined: "login() works", testable: true, storyId: "US-001" },
      { original: "User can log out", refined: "logout() works", testable: true, storyId: "US-001" },
    ]);
    const output = `\`\`\`json\n${inner}\n\`\`\``;
    const result = acceptanceRefineOp.parse(output, SAMPLE_INPUT, ctx);
    expect(result[0].refined).toBe("login() works");
  });
});
