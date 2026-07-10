/**
 * buildResumePlan unit tests — pure planner for cross-run resume.
 *
 * The planner decides which green phases can be elided on re-entry and which
 * cheap gates must always re-run. It is a pure function: no I/O, no clock,
 * no globals — tests inject `StoryCheckpoint` / `TreeState` literals.
 *
 * Coverage matrix:
 *   AC1 — importability from @/execution/checkpoint
 *   AC2 — matching tree + greenPhases [implementer, verify-scoped] ⇒ skipPhases includes implementer, excludes verify-scoped
 *   AC3 — matching tree ⇒ revalidateGates equals all 3 cheap gates and reason is "resume"
 *   AC4 — diverging headSha ⇒ empty skipPhases and reason "tree-moved"
 *   AC5 — diverging dirtyDigest ⇒ empty skipPhases and reason "tree-moved"
 *   AC6 — null checkpoint ⇒ empty skipPhases and reason "no-checkpoint"
 *   AC7 — matching tree + greenPhases containing all cheap gates ⇒ none appear in skipPhases
 */

import { describe, expect, test } from "bun:test";
import type { StoryCheckpoint, TreeState } from "@/execution";
import { buildResumePlan, type ResumePlan } from "@/execution";
import * as checkpointBarrel from "@/execution/checkpoint";

const TREE: TreeState = { headSha: "abc123", dirtyDigest: "deadbeef" };

function cp(greenPhases: StoryCheckpoint["greenPhases"], tree: TreeState = TREE): StoryCheckpoint {
  return { storyId: "US-001", greenPhases, tree };
}

describe("buildResumePlan importability (AC1)", () => {
  test("is exported from @/execution/checkpoint with callable signature", () => {
    // AC1 requires the function to be importable from src/execution/checkpoint
    // specifically — the local re-export from the parent barrel is incidental.
    expect(typeof checkpointBarrel.buildResumePlan).toBe("function");
    expect(typeof buildResumePlan).toBe("function");
    const plan: ResumePlan = buildResumePlan(null, TREE);
    expect(plan.reason).toBe("no-checkpoint");
    expect(plan.skipPhases).toEqual([]);
  });
});

describe("buildResumePlan with matching tree (AC2 + AC3)", () => {
  test("greenPhases containing implementer and verify-scoped ⇒ skipPhases keeps implementer, drops verify-scoped", () => {
    const checkpoint = cp(["implementer", "verify-scoped"]);
    const plan = buildResumePlan(checkpoint, TREE);

    expect(plan.skipPhases).toContain("implementer");
    expect(plan.skipPhases).not.toContain("verify-scoped");
  });

  test("revalidateGates equals all three cheap gates and reason is 'resume'", () => {
    const checkpoint = cp(["implementer", "verify-scoped"]);
    const plan = buildResumePlan(checkpoint, TREE);

    expect(plan.revalidateGates).toEqual(["verify-scoped", "lint-check", "typecheck-check"]);
    expect(plan.reason).toBe("resume");
  });
});

describe("buildResumePlan tree guard (AC4 + AC5)", () => {
  test("diverging headSha ⇒ empty skipPhases and reason 'tree-moved'", () => {
    const checkpoint = cp(["implementer", "verify-scoped"], {
      headSha: "different-sha",
      dirtyDigest: TREE.dirtyDigest,
    });
    const plan = buildResumePlan(checkpoint, TREE);

    expect(plan.skipPhases).toEqual([]);
    expect(plan.revalidateGates).toEqual(["verify-scoped", "lint-check", "typecheck-check"]);
    expect(plan.reason).toBe("tree-moved");
  });

  test("diverging dirtyDigest ⇒ empty skipPhases and reason 'tree-moved'", () => {
    const checkpoint = cp(["implementer", "verify-scoped"], {
      headSha: TREE.headSha,
      dirtyDigest: "different-digest",
    });
    const plan = buildResumePlan(checkpoint, TREE);

    expect(plan.skipPhases).toEqual([]);
    expect(plan.revalidateGates).toEqual(["verify-scoped", "lint-check", "typecheck-check"]);
    expect(plan.reason).toBe("tree-moved");
  });

  test("both fields diverging still yields 'tree-moved' rather than 'no-checkpoint'", () => {
    const checkpoint = cp(["implementer"], {
      headSha: "x",
      dirtyDigest: "y",
    });
    const plan = buildResumePlan(checkpoint, TREE);

    expect(plan.reason).toBe("tree-moved");
  });
});

describe("buildResumePlan with null checkpoint (AC6)", () => {
  test("null input ⇒ empty skipPhases and reason 'no-checkpoint'", () => {
    const plan = buildResumePlan(null, TREE);

    expect(plan.skipPhases).toEqual([]);
    expect(plan.revalidateGates).toEqual(["verify-scoped", "lint-check", "typecheck-check"]);
    expect(plan.reason).toBe("no-checkpoint");
  });
});

describe("buildResumePlan cheap-gate exclusion (AC7)", () => {
  test("matching tree + greenPhases containing verify-scoped, lint-check, typecheck-check ⇒ none appear in skipPhases", () => {
    const checkpoint = cp([
      "test-writer",
      "implementer",
      "verifier",
      "verify-scoped",
      "lint-check",
      "typecheck-check",
    ]);
    const plan = buildResumePlan(checkpoint, TREE);

    expect(plan.skipPhases).not.toContain("verify-scoped");
    expect(plan.skipPhases).not.toContain("lint-check");
    expect(plan.skipPhases).not.toContain("typecheck-check");
    // Sanity: agent phases that are not cheap gates ARE in skipPhases.
    expect(plan.skipPhases).toContain("test-writer");
    expect(plan.skipPhases).toContain("implementer");
    expect(plan.skipPhases).toContain("verifier");
  });

  test("even when greenPhases contains ONLY cheap gates, skipPhases is empty", () => {
    const checkpoint = cp(["verify-scoped", "lint-check", "typecheck-check"]);
    const plan = buildResumePlan(checkpoint, TREE);

    expect(plan.skipPhases).toEqual([]);
    expect(plan.reason).toBe("resume");
  });
});
