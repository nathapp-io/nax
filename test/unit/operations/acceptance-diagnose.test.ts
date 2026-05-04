import { describe, expect, test } from "bun:test";
import { makeNaxConfig, makeTestRuntime } from "../../helpers";
import type { AcceptanceDiagnoseInput } from "../../../src/operations/acceptance-diagnose";
import { acceptanceDiagnoseOp } from "../../../src/operations/acceptance-diagnose";

const SAMPLE_INPUT: AcceptanceDiagnoseInput = {
  testOutput: "FAIL: expected 1 but got 2",
  testFileContent: "test('x', () => expect(fn()).toBe(1))",
  sourceFiles: [{ path: "src/fn.ts", content: "export function fn() { return 2; }" }],
  semanticVerdicts: [
    { storyId: "US-001", passed: true, timestamp: "2026-01-01T00:00:00Z", acCount: 2, findings: [] },
  ],
};

function makeBuildCtx() {
  const config = makeNaxConfig({});
  const runtime = makeTestRuntime({ config });
  const view = runtime.packages.repo();
  return { packageView: view, config: view.select(acceptanceDiagnoseOp.config) };
}

describe("acceptanceDiagnoseOp shape", () => {
  test("kind is run", () => {
    expect(acceptanceDiagnoseOp.kind).toBe("run");
  });
  test("name is acceptance-diagnose", () => {
    expect(acceptanceDiagnoseOp.name).toBe("acceptance-diagnose");
  });
  test("session.role is diagnose", () => {
    expect(acceptanceDiagnoseOp.session.role).toBe("diagnose");
  });
  test("session.lifetime is fresh", () => {
    expect(acceptanceDiagnoseOp.session.lifetime).toBe("fresh");
  });
  test("stage is acceptance", () => {
    expect(acceptanceDiagnoseOp.stage).toBe("acceptance");
  });
  test("model resolves from acceptance.fix.diagnoseModel", () => {
    const config = makeNaxConfig({
      acceptance: {
        fix: {
          diagnoseModel: { agent: "opencode", model: "opencode-go/deepseek-v4-pro" },
        },
      },
    });
    const runtime = makeTestRuntime({ config });
    const view = runtime.packages.repo();
    const ctx = { packageView: view, config: view.select(acceptanceDiagnoseOp.config) };

    expect(acceptanceDiagnoseOp.model?.(SAMPLE_INPUT, ctx)).toEqual({
      agent: "opencode",
      model: "opencode-go/deepseek-v4-pro",
    });
  });
});

describe("acceptanceDiagnoseOp.build()", () => {
  test("returns ComposeInput with task section", () => {
    const ctx = makeBuildCtx();
    const result = acceptanceDiagnoseOp.build(SAMPLE_INPUT, ctx);
    expect(result).toHaveProperty("task");
  });
  test("task section content contains test output", () => {
    const ctx = makeBuildCtx();
    const result = acceptanceDiagnoseOp.build(SAMPLE_INPUT, ctx);
    expect(result.task.content).toContain("FAIL: expected 1 but got 2");
  });
  test("task section content contains source file content", () => {
    const ctx = makeBuildCtx();
    const result = acceptanceDiagnoseOp.build(SAMPLE_INPUT, ctx);
    expect(result.task.content).toContain("fn()");
  });
  test("task section includes semantic verdict hints when provided", () => {
    const ctx = makeBuildCtx();
    const result = acceptanceDiagnoseOp.build(SAMPLE_INPUT, ctx);
    expect(result.task.content).toContain("SEMANTIC VERDICTS");
    expect(result.task.content).toContain("likely test bug");
  });
  test("build() emits findings schema", () => {
    const ctx = makeBuildCtx();
    const result = acceptanceDiagnoseOp.build(SAMPLE_INPUT, ctx);
    expect(result.task.content).toContain('"findings"');
    expect(result.task.content).toContain('"fixTarget"');
    expect(result.task.content).not.toContain('"testIssues"');
    expect(result.task.content).not.toContain('"sourceIssues"');
  });
});

describe("acceptanceDiagnoseOp.parse()", () => {
  test("parses valid JSON diagnosis result", () => {
    const ctx = makeBuildCtx();
    const json = JSON.stringify({ verdict: "source_bug", reasoning: "fn returns wrong value", confidence: 0.9 });
    const result = acceptanceDiagnoseOp.parse(json, SAMPLE_INPUT, ctx);
    expect(result.verdict).toBe("source_bug");
    expect(result.reasoning).toBe("fn returns wrong value");
    expect(result.confidence).toBe(0.9);
  });
  test("falls back to source_bug on malformed JSON", () => {
    const ctx = makeBuildCtx();
    const result = acceptanceDiagnoseOp.parse("could not diagnose", SAMPLE_INPUT, ctx);
    expect(result.verdict).toBe("source_bug");
    expect(result.confidence).toBe(0);
  });
  test("falls back to source_bug on missing fields", () => {
    const ctx = makeBuildCtx();
    const result = acceptanceDiagnoseOp.parse(JSON.stringify({ verdict: "test_bug" }), SAMPLE_INPUT, ctx);
    expect(result.verdict).toBe("source_bug");
  });
  test("parses test_bug verdict", () => {
    const ctx = makeBuildCtx();
    const json = JSON.stringify({ verdict: "test_bug", reasoning: "bad test", confidence: 0.8 });
    const result = acceptanceDiagnoseOp.parse(json, SAMPLE_INPUT, ctx);
    expect(result.verdict).toBe("test_bug");
  });
  test("parses findings[] directly when LLM emits findings array", () => {
    const ctx = makeBuildCtx();
    const json = JSON.stringify({
      verdict: "test_bug",
      reasoning: "test imports wrong",
      confidence: 0.85,
      findings: [
        { fixTarget: "test", category: "import-path", message: "wrong relative path", file: "test/foo.test.ts", line: 3 },
      ],
    });
    const result = acceptanceDiagnoseOp.parse(json, SAMPLE_INPUT, ctx);
    expect(result.findings?.length).toBe(1);
    expect(result.findings?.[0]).toMatchObject({ fixTarget: "test", category: "import-path", message: "wrong relative path" });
  });
  test("falls back gracefully when findings[] is empty array", () => {
    const ctx = makeBuildCtx();
    const json = JSON.stringify({
      verdict: "source_bug",
      reasoning: "missing impl",
      confidence: 0.9,
      findings: [],
    });
    const result = acceptanceDiagnoseOp.parse(json, SAMPLE_INPUT, ctx);
    expect(result.verdict).toBe("source_bug");
    expect(result.findings).toBeUndefined();
  });
  test("findings is undefined when no findings[] in response", () => {
    const ctx = makeBuildCtx();
    const json = JSON.stringify({ verdict: "source_bug", reasoning: "plain", confidence: 0.8 });
    const result = acceptanceDiagnoseOp.parse(json, SAMPLE_INPUT, ctx);
    expect(result.findings).toBeUndefined();
  });
});
