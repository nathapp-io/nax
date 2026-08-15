import { describe, expect, test } from "bun:test";
import { assertNoDependencyCycle, detectDependencyCycle } from "../../../src/prd/dependency-cycle";
import type { UserStory } from "../../../src/prd/types";

function story(id: string, dependencies: string[] = []): UserStory {
  return { id, dependencies } as UserStory;
}

describe("detectDependencyCycle (BUG-27)", () => {
  test("returns null for an acyclic graph", () => {
    expect(detectDependencyCycle([story("A"), story("B", ["A"]), story("C", ["B"])])).toBeNull();
  });

  test("detects a direct 2-node cycle", () => {
    const cycle = detectDependencyCycle([story("A", ["B"]), story("B", ["A"])]);
    expect(cycle).not.toBeNull();
    expect(cycle).toContain("A");
    expect(cycle).toContain("B");
  });

  test("detects a self-cycle", () => {
    expect(detectDependencyCycle([story("A", ["A"])])).not.toBeNull();
  });

  test("detects a transitive cycle", () => {
    expect(detectDependencyCycle([story("A", ["C"]), story("B", ["A"]), story("C", ["B"])])).not.toBeNull();
  });

  test("does not false-positive on a diamond DAG", () => {
    expect(
      detectDependencyCycle([story("A"), story("B", ["A"]), story("C", ["A"]), story("D", ["B", "C"])]),
    ).toBeNull();
  });
});

describe("assertNoDependencyCycle (BUG-27)", () => {
  test("does not throw for an acyclic graph", () => {
    expect(() => assertNoDependencyCycle([story("A"), story("B", ["A"])])).not.toThrow();
  });

  test("throws naming the cycle", () => {
    expect(() => assertNoDependencyCycle([story("A", ["B"]), story("B", ["A"])])).toThrow(/Circular dependency/);
  });
});
