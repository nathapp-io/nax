/**
 * Unit tests for execution stage workdir resolution helper (MW-002).
 *
 * Scope: `resolveStoryWorkdir` is a pure helper exposed from the execution
 * stage barrel. The previous integration-style tests that asserted the
 * resolved workdir reached the agent via `agent.run()` were retired with
 * the US-004 dispatch refactor — workdir now flows through
 * `StoryOrchestratorBuilder` -> `callOp` -> `SessionManager.openSession`,
 * covered by `test/unit/execution/story-orchestrator.test.ts` and the
 * session-manager test suite.
 */

import { describe, expect, test } from "bun:test";
import { resolveStoryWorkdir } from "../../../../src/pipeline/stages/execution";

describe("resolveStoryWorkdir (MW-002)", () => {
  test("returns repoRoot unchanged when storyWorkdir is undefined", () => {
    expect(resolveStoryWorkdir("/tmp")).toBe("/tmp");
  });

  test("returns repoRoot unchanged when storyWorkdir is empty string", () => {
    expect(resolveStoryWorkdir("/tmp", "")).toBe("/tmp");
  });

  test("joins repoRoot with storyWorkdir when directory exists", () => {
    // /tmp always exists — use it as the package dir
    expect(resolveStoryWorkdir("/", "tmp")).toBe("/tmp");
  });

  test("throws when storyWorkdir does not exist on disk", () => {
    expect(() => resolveStoryWorkdir("/tmp", "nonexistent-package-xyz")).toThrow(
      'story.workdir "nonexistent-package-xyz" does not exist',
    );
  });
});
