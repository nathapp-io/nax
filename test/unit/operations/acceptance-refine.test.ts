import { describe, expect, test } from "bun:test";
import { makeTestRuntime } from "../../helpers";
import type { AcceptanceRefineInput } from "../../../src/operations/acceptance-refine";
import { acceptanceRefineOp } from "../../../src/operations/acceptance-refine";

const SAMPLE_INPUT: AcceptanceRefineInput = {
  criteria: ["User can log in", "User can log out"],
  codebaseContext: "# Context\nRelevant files...",
  storyId: "US-001",
};

function makeBuildCtx() {
  const runtime = makeTestRuntime();
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
});

describe("acceptanceRefineOp.parse()", () => {
  test("parses valid JSON array of RefinedCriterion", () => {
    const ctx = makeBuildCtx();
    const json = JSON.stringify([
      { original: "User can log in", refined: "login() returns true for valid credentials", testable: true, storyId: "US-001" },
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
