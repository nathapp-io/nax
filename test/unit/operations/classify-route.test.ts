import { describe, expect, test } from "bun:test";
import { routingConfigSelector } from "../../../src/config";
import type { ClassifyRouteInput } from "../../../src/operations/classify-route";
import { classifyRouteOp } from "../../../src/operations/classify-route";
import { makeTestRuntime } from "../../helpers";

const SAMPLE_INPUT: ClassifyRouteInput = {
  title: "Add button",
  description: "Add a red button",
  acceptanceCriteria: ["Button exists"],
  tags: [],
};

function makeBuildCtx() {
  const runtime = makeTestRuntime();
  const view = runtime.packages.repo();
  return { packageView: view, config: view.select(routingConfigSelector) };
}

describe("classifyRouteOp shape", () => {
  test("kind is complete", () => {
    expect(classifyRouteOp.kind).toBe("complete");
  });
  test("name is classify-route", () => {
    expect(classifyRouteOp.name).toBe("classify-route");
  });
  test("jsonMode is true", () => {
    expect(classifyRouteOp.jsonMode).toBe(true);
  });
});

describe("classifyRouteOp.build()", () => {
  test("build returns role + task sections with content", () => {
    const ctx = makeBuildCtx();
    const composeInput = classifyRouteOp.build(SAMPLE_INPUT, ctx);
    expect(composeInput.role.content.length).toBeGreaterThan(0);
    expect(composeInput.task.content.length).toBeGreaterThan(0);
  });
});

describe("classifyRouteOp.parse()", () => {
  test("parses valid JSON decision and derives testStrategy", () => {
    const ctx = makeBuildCtx();
    const raw = JSON.stringify({ complexity: "simple", modelTier: "fast", reasoning: "trivial" });
    const result = classifyRouteOp.parse(raw, SAMPLE_INPUT, ctx);
    expect(result.complexity).toBe("simple");
    expect(result.modelTier).toBe("fast");
    expect(result.reasoning).toBe("trivial");
    // testStrategy is derived by validateRoutingDecision — verify presence rather than value,
    // since the derivation depends on default config.tdd.strategy.
    expect(typeof result.testStrategy).toBe("string");
    expect(result.testStrategy.length).toBeGreaterThan(0);
  });

  test("throws on unparseable JSON", () => {
    const ctx = makeBuildCtx();
    expect(() => classifyRouteOp.parse("not json", SAMPLE_INPUT, ctx)).toThrow();
  });

  test("throws on invalid complexity value", () => {
    const ctx = makeBuildCtx();
    const raw = JSON.stringify({ complexity: "trivial", modelTier: "fast", reasoning: "x" });
    expect(() => classifyRouteOp.parse(raw, SAMPLE_INPUT, ctx)).toThrow(/Invalid complexity/);
  });

  test("throws on tier not in config.models", () => {
    const ctx = makeBuildCtx();
    const raw = JSON.stringify({ complexity: "simple", modelTier: "nonexistent-tier", reasoning: "x" });
    expect(() => classifyRouteOp.parse(raw, SAMPLE_INPUT, ctx)).toThrow(/Invalid modelTier/);
  });

  test("throws on missing required fields", () => {
    const ctx = makeBuildCtx();
    const raw = JSON.stringify({ complexity: "simple" });
    expect(() => classifyRouteOp.parse(raw, SAMPLE_INPUT, ctx)).toThrow(/Missing required fields/);
  });
});
