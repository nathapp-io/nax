import { afterEach, describe, expect, test } from "bun:test";
import type { AcceptanceRefineInput } from "../../../src/operations/acceptance-refine";
import type { NaxRuntime } from "../../../src/runtime";
import { makeNaxConfig, makeTestRuntime } from "../../helpers";

const createdRuntimes: NaxRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});
import { parseRefinementResponse, refinementWouldFallback } from "../../../src/acceptance/refinement";
import { acceptanceRefineOp } from "../../../src/operations/acceptance-refine";

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
  return { packageView: view, config: view.select(acceptanceRefineOp.config) };
}

describe("acceptanceRefineOp shape", () => {
  test("kind is complete", () => {
    expect(acceptanceRefineOp.kind).toBe("complete");
  });
  test("name is acceptance-refine", () => {
    expect(acceptanceRefineOp.name).toBe("acceptance-refine");
  });
  test("jsonMode is true", () => {
    expect(acceptanceRefineOp.jsonMode).toBe(true);
  });
  test("stage is acceptance", () => {
    expect(acceptanceRefineOp.stage).toBe("acceptance");
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
    const ctx = { packageView: view, config: view.select(acceptanceRefineOp.config) };

    expect(acceptanceRefineOp.model?.(SAMPLE_INPUT, ctx)).toEqual({
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
  test("falls back to original criteria on malformed JSON", () => {
    const ctx = makeBuildCtx();
    const result = acceptanceRefineOp.parse("not json", SAMPLE_INPUT, ctx);
    expect(Array.isArray(result)).toBe(true);
    expect(result[0].original).toBe("User can log in");
    expect(result[0].refined).toBe("User can log in");
    expect(result[0].testable).toBe(true);
  });
  test("falls back on empty response", () => {
    const ctx = makeBuildCtx();
    const result = acceptanceRefineOp.parse("", SAMPLE_INPUT, ctx);
    expect(result).toHaveLength(2);
    expect(result[0].original).toBe("User can log in");
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
    ]);
    const output = `\`\`\`json\n${inner}\n\`\`\``;
    const result = acceptanceRefineOp.parse(output, SAMPLE_INPUT, ctx);
    expect(result[0].refined).toBe("login() works");
  });
});
