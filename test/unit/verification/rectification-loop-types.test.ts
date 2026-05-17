/**
 * Type-level tests for RectificationLoopOptions
 *
 * These tests verify that:
 * - sessionManager property is not allowed in RectificationLoopOptions
 * - runtime property is required in RectificationLoopOptions
 *
 * Note: These are compile-time checks. If the test file compiles without
 * errors, the type constraints are satisfied.
 */

import { describe, test, expect } from "bun:test";
import type { RectificationLoopOptions } from "../../../src/verification/rectification-loop";
import type { NaxConfig } from "../../../src/config";
import type { UserStory } from "../../../src/prd";
import type { IAgentManager } from "../../../src/agents";
import type { NaxRuntime } from "../../../src/runtime";

describe("RectificationLoopOptions — type constraints", () => {
  test("sessionManager is not a property of RectificationLoopOptions", () => {
    // This is a compile-time check. If TypeScript allows assigning
    // sessionManager to a RectificationLoopOptions object, this test should fail.
    // The type test passes if this code does NOT compile.
    const _: typeof testSessionManagerNotAllowed = testSessionManagerNotAllowed;
    expect(_).toBeDefined();
  });

  test("runtime is a required property of RectificationLoopOptions", () => {
    // This is a compile-time check. If runtime is optional,
    // this code will not satisfy the type requirement.
    const _: typeof testRuntimeIsRequired = testRuntimeIsRequired;
    expect(_).toBeDefined();
  });
});

// Compile-time type constraint verifications
// These functions should only compile if the type constraints are satisfied.

function testSessionManagerNotAllowed(opts: RectificationLoopOptions): boolean {
  // @ts-expect-error — sessionManager is not a valid property
  const _x = opts.sessionManager;
  return true;
}

function testRuntimeIsRequired(): RectificationLoopOptions {
  const config = {} as NaxConfig;
  const story = {} as UserStory;
  const agentManager = {} as IAgentManager;
  const runtime = {} as NaxRuntime;

  // This should compile because runtime is provided
  return {
    config,
    workdir: "/tmp/test",
    story,
    testCommand: "bun test",
    timeoutSeconds: 30,
    testOutput: "test output",
    agentManager,
    runtime, // Required
  };
}

function testRuntimeIsRequiredError(): void {
  const config = {} as NaxConfig;
  const story = {} as UserStory;
  const agentManager = {} as IAgentManager;

  // @ts-expect-error — runtime is required, omitting it should cause compile error
  const _opts: RectificationLoopOptions = {
    config,
    workdir: "/tmp/test",
    story,
    testCommand: "bun test",
    timeoutSeconds: 30,
    testOutput: "test output",
    agentManager,
    // runtime omitted — should not compile
  };
}
