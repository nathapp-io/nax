import { describe, expect, test } from "bun:test";
import { makeTestRuntime } from "../../helpers";
import type { AcceptanceGenerateInput } from "../../../src/operations/acceptance-generate";
import { acceptanceGenerateOp } from "../../../src/operations/acceptance-generate";

const SAMPLE_INPUT: AcceptanceGenerateInput = {
  featureName: "my-feature",
  criteriaList: "AC-1: do X\nAC-2: do Y",
  frameworkOverrideLine: "",
  targetTestFilePath: "/tmp/acceptance.test.ts",
};

function makeBuildCtx() {
  const runtime = makeTestRuntime();
  const view = runtime.packages.repo();
  return { packageView: view, config: view.select(acceptanceGenerateOp.config) };
}

describe("acceptanceGenerateOp shape", () => {
  test("kind is complete", () => {
    expect(acceptanceGenerateOp.kind).toBe("complete");
  });
  test("name is acceptance-generate", () => {
    expect(acceptanceGenerateOp.name).toBe("acceptance-generate");
  });
  test("jsonMode is false", () => {
    expect(acceptanceGenerateOp.jsonMode).toBe(false);
  });
  test("stage is acceptance", () => {
    expect(acceptanceGenerateOp.stage).toBe("acceptance");
  });
});

describe("acceptanceGenerateOp.build()", () => {
  test("returns ComposeInput with task section", () => {
    const ctx = makeBuildCtx();
    const result = acceptanceGenerateOp.build(SAMPLE_INPUT, ctx);
    expect(result).toHaveProperty("task");
  });
  test("task section content contains featureName", () => {
    const ctx = makeBuildCtx();
    const result = acceptanceGenerateOp.build(SAMPLE_INPUT, ctx);
    expect(result.task.content).toContain("my-feature");
  });
  test("task section content contains criteria", () => {
    const ctx = makeBuildCtx();
    const result = acceptanceGenerateOp.build(SAMPLE_INPUT, ctx);
    expect(result.task.content).toContain("AC-1: do X");
  });
});

describe("acceptanceGenerateOp.parse()", () => {
  test("extracts code from typescript fenced block", () => {
    const ctx = makeBuildCtx();
    const output = "Here is the test:\n```typescript\nconst x = 1;\n```";
    const result = acceptanceGenerateOp.parse(output, SAMPLE_INPUT, ctx);
    expect(result.testCode).toContain("const x = 1");
  });
  test("returns null testCode when no code block present", () => {
    const ctx = makeBuildCtx();
    const result = acceptanceGenerateOp.parse("no code here", SAMPLE_INPUT, ctx);
    expect(result.testCode).toBeNull();
  });
  test("extracts code from generic fenced block", () => {
    const ctx = makeBuildCtx();
    const output = "```\nimport { test } from 'bun:test';\n```";
    const result = acceptanceGenerateOp.parse(output, SAMPLE_INPUT, ctx);
    expect(result.testCode).toContain("import");
  });
});
