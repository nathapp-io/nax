import { describe, expect, test } from "bun:test";
import { makeFullSuiteRectifyStrategy } from "@/operations";
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
