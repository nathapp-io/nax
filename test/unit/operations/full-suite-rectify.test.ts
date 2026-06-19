import { describe, expect, test } from "bun:test";
import {
  makeFullSuiteRectifyStrategy,
  fullSuiteRectifyOp,
  makeDeclarationSink,
} from "@/operations";
import type { FullSuiteRectifyInput, FullSuiteRectifyOutput } from "@/operations";
import type { TestEditDeclaration } from "@/operations";
import type { Finding } from "@/findings";
import type { UserStory } from "@/prd";
import { makeNaxConfig } from "@test/helpers";

function makeTestFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    source: "test-runner",
    severity: "error",
    category: "failed-test",
    rule: "some test",
    file: "test/unit/foo.test.ts",
    message: "Expected true but got false",
    ...overrides,
  };
}

function makeTestStory(overrides: Partial<UserStory> = {}): UserStory {
  return {
    id: "US-001",
    title: "Test Story",
    workdir: ".",
    ...overrides,
  } as UserStory;
}

describe("makeFullSuiteRectifyStrategy", () => {
  test("name is full-suite-rectify", () => {
    const strategy = makeFullSuiteRectifyStrategy(makeTestStory(), makeNaxConfig());
    expect(strategy.name).toBe("full-suite-rectify");
  });

  test("coRun is exclusive", () => {
    const strategy = makeFullSuiteRectifyStrategy(makeTestStory(), makeNaxConfig());
    expect(strategy.coRun).toBe("exclusive");
  });

  test("appliesTo returns true for test-runner + failed-test findings", () => {
    const strategy = makeFullSuiteRectifyStrategy(makeTestStory(), makeNaxConfig());
    const finding = makeTestFinding();
    expect(strategy.appliesTo(finding)).toBe(true);
  });

  test("appliesTo returns false for other sources", () => {
    const strategy = makeFullSuiteRectifyStrategy(makeTestStory(), makeNaxConfig());
    const finding = makeTestFinding({ source: "lint" });
    expect(strategy.appliesTo(finding)).toBe(false);
  });

  test("appliesTo returns false for other categories (e.g. assertion-failure from acceptance-diagnose)", () => {
    const strategy = makeFullSuiteRectifyStrategy(makeTestStory(), makeNaxConfig());
    const finding = makeTestFinding({ category: "assertion-failure" });
    expect(strategy.appliesTo(finding)).toBe(false);
  });

  test("appliesTo returns true for test-runner + execution-failed (synth finding from gate)", () => {
    const strategy = makeFullSuiteRectifyStrategy(makeTestStory(), makeNaxConfig());
    const finding = makeTestFinding({ category: "execution-failed" });
    expect(strategy.appliesTo(finding)).toBe(true);
  });

  test("fixOp references implementerOp (name=implementer)", () => {
    const strategy = makeFullSuiteRectifyStrategy(makeTestStory(), makeNaxConfig());
    expect(strategy.fixOp.name).toBe("implementer");
  });

  test("buildInput produces ImplementerInput with story and contextMarkdown", () => {
    const story = makeTestStory();
    const strategy = makeFullSuiteRectifyStrategy(story, makeNaxConfig());
    const finding = makeTestFinding();
    const input = strategy.buildInput([finding], [], {} as any);
    expect(input.story).toBe(story);
    expect(typeof input.contextMarkdown).toBe("string");
    expect(input.contextMarkdown!.length).toBeGreaterThan(0);
  });

  test("each call returns a new strategy instance closing over its own story", () => {
    const story1 = makeTestStory({ id: "US-001" });
    const story2 = makeTestStory({ id: "US-002" });
    const s1 = makeFullSuiteRectifyStrategy(story1, makeNaxConfig());
    const s2 = makeFullSuiteRectifyStrategy(story2, makeNaxConfig());
    const input1 = s1.buildInput([], [], {} as any);
    const input2 = s2.buildInput([], [], {} as any);
    expect(input1.story.id).toBe("US-001");
    expect(input2.story.id).toBe("US-002");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC1/2/3/6/7: DeclarationSink parameter wiring
// ─────────────────────────────────────────────────────────────────────────────

describe("makeFullSuiteRectifyStrategy — with DeclarationSink", () => {
  test("AC1: fixOp is fullSuiteRectifyOp when sink provided", () => {
    const sink = makeDeclarationSink();
    const strategy = makeFullSuiteRectifyStrategy(makeTestStory(), makeNaxConfig(), sink);
    expect(strategy.fixOp.name).toBe(fullSuiteRectifyOp.name);
  });

  test("AC2: appliesTo returns true for test-runner failed-test when sink provided", () => {
    const sink = makeDeclarationSink();
    const strategy = makeFullSuiteRectifyStrategy(makeTestStory(), makeNaxConfig(), sink);
    expect(strategy.appliesTo(makeTestFinding({ source: "test-runner", category: "failed-test" }))).toBe(true);
  });

  test("AC3: appliesTo returns false for semantic-review when sink provided", () => {
    const sink = makeDeclarationSink();
    const strategy = makeFullSuiteRectifyStrategy(makeTestStory(), makeNaxConfig(), sink);
    expect(strategy.appliesTo(makeTestFinding({ source: "semantic-review", category: "x" }))).toBe(false);
  });

  test("AC6: extractApplied with mock_structure declaration pushes files to sink.mockHandoffs", () => {
    const sink = makeDeclarationSink();
    const strategy = makeFullSuiteRectifyStrategy(makeTestStory(), makeNaxConfig(), sink);
    const output: FullSuiteRectifyOutput = {
      applied: true,
      testEditDeclarations: [
        {
          reason: "mock_structure",
          file: "test/unit/foo.test.ts",
          files: ["test/unit/foo.test.ts", "test/unit/bar.test.ts"],
          reasonDetail: "mock setup needs restructuring",
        },
      ],
    };
    const input: FullSuiteRectifyInput = { story: makeTestStory(), findings: [] };
    strategy.extractApplied!(output, input);
    expect(sink.mockHandoffs).toHaveLength(1);
    expect(sink.mockHandoffs[0]?.files).toEqual(["test/unit/foo.test.ts", "test/unit/bar.test.ts"]);
    expect(sink.mockHandoffs[0]?.reasonDetail).toBe("mock setup needs restructuring");
  });

  test("AC6 boundary: extractApplied with mock_structure missing files does not push to sink.mockHandoffs", () => {
    const sink = makeDeclarationSink();
    const strategy = makeFullSuiteRectifyStrategy(makeTestStory(), makeNaxConfig(), sink);
    const declWithoutFiles: TestEditDeclaration = {
      reason: "mock_structure",
      file: "test/unit/foo.test.ts",
      // no files, no reasonDetail
    };
    const output: FullSuiteRectifyOutput = { applied: true, testEditDeclarations: [declWithoutFiles] };
    const input: FullSuiteRectifyInput = { story: makeTestStory(), findings: [] };
    strategy.extractApplied!(output, input);
    expect(sink.mockHandoffs).toHaveLength(0);
  });

  test("AC7: extractApplied with prd_contract declaration pushes to sink.testEdits", () => {
    const sink = makeDeclarationSink();
    const strategy = makeFullSuiteRectifyStrategy(makeTestStory(), makeNaxConfig(), sink);
    const decl: TestEditDeclaration = {
      reason: "prd_contract",
      file: "test/unit/foo.test.ts",
      prdQuote: "doSomething()",
      testBefore: "old assertion",
      testAfter: "new assertion",
    };
    const output: FullSuiteRectifyOutput = { applied: true, testEditDeclarations: [decl] };
    const input: FullSuiteRectifyInput = { story: makeTestStory(), findings: [] };
    strategy.extractApplied!(output, input);
    expect(sink.testEdits).toHaveLength(1);
    expect(sink.testEdits[0]).toEqual(decl);
  });

  test("AC7 boundary: extractApplied with no declarations does not push to sink", () => {
    const sink = makeDeclarationSink();
    const strategy = makeFullSuiteRectifyStrategy(makeTestStory(), makeNaxConfig(), sink);
    const output: FullSuiteRectifyOutput = { applied: true, testEditDeclarations: [] };
    const input: FullSuiteRectifyInput = { story: makeTestStory(), findings: [] };
    strategy.extractApplied!(output, input);
    expect(sink.testEdits).toHaveLength(0);
    expect(sink.mockHandoffs).toHaveLength(0);
  });

  test("AC8: extractApplied forwards unresolvedReason as unresolved when no testEditDeclarations", () => {
    const sink = makeDeclarationSink();
    const strategy = makeFullSuiteRectifyStrategy(makeTestStory(), makeNaxConfig(), sink);
    const output: FullSuiteRectifyOutput = {
      applied: true,
      testEditDeclarations: [],
      unresolvedReason: "Test uses relative URLs that the library rejects",
    };
    const input: FullSuiteRectifyInput = { story: makeTestStory(), findings: [] };
    const result = strategy.extractApplied!(output, input);
    expect(result.unresolved).toBe("Test uses relative URLs that the library rejects");
    expect(result.summary).toBe("Test uses relative URLs that the library rejects");
  });

  test("AC8 boundary: extractApplied without unresolvedReason leaves unresolved undefined", () => {
    const sink = makeDeclarationSink();
    const strategy = makeFullSuiteRectifyStrategy(makeTestStory(), makeNaxConfig(), sink);
    const output: FullSuiteRectifyOutput = { applied: true, testEditDeclarations: [] };
    const input: FullSuiteRectifyInput = { story: makeTestStory(), findings: [] };
    const result = strategy.extractApplied!(output, input);
    expect(result.unresolved).toBeUndefined();
    expect(result.summary).toBe("Fixed failing tests");
  });

  test("AC8 priority: UNRESOLVED + testEditDeclarations → testEditDeclarations win, unresolved suppressed", () => {
    const sink = makeDeclarationSink();
    const strategy = makeFullSuiteRectifyStrategy(makeTestStory(), makeNaxConfig(), sink);
    const decl: TestEditDeclaration = {
      reason: "required_infrastructure_missing",
      file: "test/oauth/admin-client.guard.route.spec.ts",
    };
    const output: FullSuiteRectifyOutput = {
      applied: true,
      testEditDeclarations: [decl],
      unresolvedReason: "Test uses relative URLs",
    };
    const input: FullSuiteRectifyInput = { story: makeTestStory(), findings: [] };
    const result = strategy.extractApplied!(output, input);
    // Declaration flows through to sink so test-writer handoff can fire via postValidate
    expect(sink.testEdits).toHaveLength(1);
    // unresolved is suppressed — agent-gave-up must NOT fire when a handoff can still run
    expect(result.unresolved).toBeUndefined();
    // summary must not echo the UNRESOLVED text either: this iteration is a handoff, not a give-up
    expect(result.summary).toBe("Fixed failing tests");
  });
});
