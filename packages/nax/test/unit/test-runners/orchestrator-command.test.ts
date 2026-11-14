/**
 * Unit tests for the `isMonorepoOrchestratorCommand` leaf module (US-007).
 *
 * The predicate used to live in `scoped-selection.ts`, whose import graph
 * (`@/logger`, `verification/smart-runner`) is too heavy for config guards to
 * depend on. It moved here unchanged; `scoped-selection.ts` re-exports it so
 * every existing importer is untouched.
 */

import { describe, expect, test } from "bun:test";
import { isMonorepoOrchestratorCommand } from "@/test-runners/orchestrator-command";

describe("isMonorepoOrchestratorCommand", () => {
  test("AC-1: recognises a turbo test command", () => {
    expect(isMonorepoOrchestratorCommand("npx turbo test")).toBe(true);
  });

  test.each(["turbo run test", "npx nx affected -t test", "bunx turbo test --filter=@pkg"])(
    "recognises the orchestrator command %j",
    (command) => {
      expect(isMonorepoOrchestratorCommand(command)).toBe(true);
    },
  );

  test("recognises a list whose every entry is an orchestrator", () => {
    expect(isMonorepoOrchestratorCommand(["turbo run test", "nx affected -t test"])).toBe(true);
  });

  test.each(["bun test", "pytest -q", "go test ./..."])("rejects the non-orchestrator command %j", (command) => {
    expect(isMonorepoOrchestratorCommand(command)).toBe(false);
  });

  test("rejects a list that mixes an orchestrator with a plain command", () => {
    expect(isMonorepoOrchestratorCommand(["bun test", "tsc --noEmit"])).toBe(false);
  });

  test("requires EVERY entry of a list to be an orchestrator", () => {
    expect(isMonorepoOrchestratorCommand(["turbo test", "bun test"])).toBe(false);
  });

  test("is false for an empty command", () => {
    expect(isMonorepoOrchestratorCommand("")).toBe(false);
    expect(isMonorepoOrchestratorCommand([])).toBe(false);
  });
});
