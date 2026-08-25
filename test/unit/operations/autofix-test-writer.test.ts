/**
 * Unit tests for autofix-test-writer operation.
 *
 * Covers:
 * - AutofixTestWriterInput interface extension (mock-restructure mode)
 * - testWriterRectifyOp.build forwards handoff data to prompt builder
 */

import { describe, expect, test } from "bun:test";
import { makeStory } from "@test/helpers";
import type { AutofixTestWriterInput } from "@/operations";
import { testWriterRectifyOp } from "@/operations";

describe("AutofixTestWriterInput", () => {
  test("interface accepts mode: 'mock-restructure'", () => {
    const input: AutofixTestWriterInput = {
      failedChecks: [],
      story: makeStory(),
      mode: "mock-restructure",
    };
    expect(input.mode).toBe("mock-restructure");
  });

  test("interface declares optional handoffReason field", () => {
    const input: AutofixTestWriterInput = {
      failedChecks: [],
      story: makeStory(),
      mode: "mock-restructure",
      handoffReason: "Mock dispatch shape mismatch",
    };
    expect(input.handoffReason).toBe("Mock dispatch shape mismatch");
  });

  test("interface declares optional handoffFiles field", () => {
    const input: AutofixTestWriterInput = {
      failedChecks: [],
      story: makeStory(),
      mode: "mock-restructure",
      handoffFiles: ["test/foo.test.ts", "test/bar.test.ts"],
    };
    expect(input.handoffFiles).toEqual(["test/foo.test.ts", "test/bar.test.ts"]);
  });
});

describe("testWriterRectifyOp.session", () => {
  test("role is 'test-writer'", () => {
    expect(testWriterRectifyOp.session.role).toBe("test-writer");
  });

  test("lifetime is 'warm' (resumes the open test-writer session across iterations)", () => {
    expect(testWriterRectifyOp.session.lifetime).toBe("warm");
  });
});

describe("testWriterRectifyOp.build", () => {
  test("accepts mode: mock-restructure in input and builds prompt", () => {
    const story = makeStory({ description: "Test mock restructuring" });
    const input: AutofixTestWriterInput = {
      failedChecks: [],
      story,
      mode: "mock-restructure",
      handoffReason: "Mock dispatch must align with AC shape",
      handoffFiles: ["test/dispatcher.test.ts"],
    };

    const ctx = {} as any;

    const result = testWriterRectifyOp.build(input, ctx);

    // The prompt should be generated
    expect(result.task.content).toBeDefined();
    expect(result.task.content.length).toBeGreaterThan(0);
  });

  test("accepts handoffReason in input", () => {
    const story = makeStory();
    const input: AutofixTestWriterInput = {
      failedChecks: [],
      story,
      mode: "mock-restructure",
      handoffReason: "Specific mock structure alignment issue",
      handoffFiles: ["test/x.test.ts"],
    };

    const ctx = {} as any;

    const result = testWriterRectifyOp.build(input, ctx);

    expect(result.task.content).toBeDefined();
  });

  test("accepts empty handoffFiles list", () => {
    const story = makeStory();
    const input: AutofixTestWriterInput = {
      failedChecks: [],
      story,
      mode: "mock-restructure",
      handoffReason: "Empty restructuring",
      handoffFiles: [],
    };

    const ctx = {} as any;

    const result = testWriterRectifyOp.build(input, ctx);

    expect(result.task.content).toBeDefined();
  });

  test("accepts undefined handoffReason", () => {
    const story = makeStory();
    const input: AutofixTestWriterInput = {
      failedChecks: [],
      story,
      mode: "mock-restructure",
      handoffFiles: ["test/demo.test.ts"],
      // handoffReason omitted
    };

    const ctx = {} as any;

    const result = testWriterRectifyOp.build(input, ctx);

    expect(result.task.content).toBeDefined();
    expect(result.task.content.length).toBeGreaterThan(0);
  });
});
