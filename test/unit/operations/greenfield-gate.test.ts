import { describe, expect, test } from "bun:test";
import { greenfieldGateOp } from "@/operations";
import { DEFAULT_CONFIG } from "@/config";

const ctx = {
  packageView: {} as any,
  config: DEFAULT_CONFIG,
};

const input = {
  story: { id: "US-001" } as any,
  workdir: "/tmp/test",
  resolvedTestPatterns: { globs: ["**/*.test.ts"] } as any,
};

describe("greenfieldGateOp — RunOperation shape", () => {
  test("exports as a RunOperation with kind=run", () => {
    expect(greenfieldGateOp).toBeDefined();
    expect(greenfieldGateOp.kind).toBe("run");
  });

  test("name is greenfield-gate", () => {
    expect(greenfieldGateOp.name).toBe("greenfield-gate");
  });

  test("session role is main and lifetime is fresh", () => {
    expect(greenfieldGateOp.session.role).toBe("main");
    expect(greenfieldGateOp.session.lifetime).toBe("fresh");
  });

  test("has build and parse functions", () => {
    expect(typeof greenfieldGateOp.build).toBe("function");
    expect(typeof greenfieldGateOp.parse).toBe("function");
  });
});

describe("greenfieldGateOp.parse — isGreenfield detection (AC8)", () => {
  test("returns isGreenfield=true and success=true when agent reports no test files", () => {
    const result = greenfieldGateOp.parse('{"isGreenfield":true}', input, ctx);
    expect(result.isGreenfield).toBe(true);
    expect(result.success).toBe(true);
  });

  test("returns isGreenfield=false and success=true when agent reports test files exist", () => {
    const result = greenfieldGateOp.parse('{"isGreenfield":false}', input, ctx);
    expect(result.isGreenfield).toBe(false);
    expect(result.success).toBe(true);
  });

  test("returns isGreenfield=false and success=true on unparseable output (safe fallback)", () => {
    const result = greenfieldGateOp.parse("not json at all", input, ctx);
    expect(result.isGreenfield).toBe(false);
    expect(result.success).toBe(true);
  });

  test("returns isGreenfield=false and success=true on empty string (safe fallback)", () => {
    const result = greenfieldGateOp.parse("", input, ctx);
    expect(result.isGreenfield).toBe(false);
    expect(result.success).toBe(true);
  });

  test("extracts isGreenfield from markdown-fenced JSON", () => {
    const fencedOutput = "```json\n{\"isGreenfield\":true}\n```";
    const result = greenfieldGateOp.parse(fencedOutput, input, ctx);
    expect(result.isGreenfield).toBe(true);
    expect(result.success).toBe(true);
  });

  test("returns isGreenfield=false when isGreenfield field is missing from JSON", () => {
    const result = greenfieldGateOp.parse('{"otherField":"value"}', input, ctx);
    expect(result.isGreenfield).toBe(false);
    expect(result.success).toBe(true);
  });

  test("treats truthy non-boolean isGreenfield values as true", () => {
    const result = greenfieldGateOp.parse('{"isGreenfield":1}', input, ctx);
    expect(result.isGreenfield).toBe(true);
    expect(result.success).toBe(true);
  });

  test("always returns success=true — gate is informational, never blocks execution", () => {
    const withTrue = greenfieldGateOp.parse('{"isGreenfield":true}', input, ctx);
    const withFalse = greenfieldGateOp.parse('{"isGreenfield":false}', input, ctx);
    const withError = greenfieldGateOp.parse("bad input", input, ctx);
    expect(withTrue.success).toBe(true);
    expect(withFalse.success).toBe(true);
    expect(withError.success).toBe(true);
  });
});
