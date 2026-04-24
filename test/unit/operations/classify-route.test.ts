import { describe, test, expect } from "bun:test";
import { classifyRouteOp } from "../../../src/operations/classify-route";
import { makeTestRuntime } from "../../helpers";

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
    const runtime = makeTestRuntime();
    const view = runtime.packages.repo();
    const ctx = { packageView: view, config: view.select(classifyRouteOp.config) };
    const composeInput = classifyRouteOp.build(
      { title: "Add button", description: "Add a red button", acceptanceCriteria: ["Button exists"], tags: [] },
      ctx,
    );
    expect(composeInput.role.content.length).toBeGreaterThan(0);
    expect(composeInput.task.content.length).toBeGreaterThan(0);
  });
});

describe("classifyRouteOp.parse()", () => {
  test("parses valid JSON decision", () => {
    const raw = JSON.stringify({ complexity: "simple", modelTier: "fast", reasoning: "trivial" });
    const result = classifyRouteOp.parse(raw);
    expect(result.modelTier).toBe("fast");
    expect(result.complexity).toBe("simple");
  });

  test("throws on unparseable JSON", () => {
    expect(() => classifyRouteOp.parse("not json")).toThrow();
  });
});
