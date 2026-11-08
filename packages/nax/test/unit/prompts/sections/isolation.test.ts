/**
 * Isolation Rules — only the no-test and implementer roles render a section.
 *
 * US-004 narrowed the role argument to `"no-test" | "implementer"`: the
 * test-writer, verifier and tdd-simple arms and the old `"strict"` / `"lite"`
 * first-argument call form had no caller. The implementer's text is unchanged,
 * and the retired arms are pinned as gone.
 */
import { describe, expect, test } from "bun:test";
import { buildIsolationSection } from "@/prompts/sections/isolation";

type IsolationRole = Parameters<typeof buildIsolationSection>[0];

/**
 * Compile-time pin (US-004): the retired roles and the old `"strict"` /
 * `"lite"` call form are out of the role argument. While one of them is still
 * in the union the assertions below do not typecheck — `bun run typecheck` is
 * the gate that enforces it. It is also what keeps the retired arms
 * unreachable: an arm for a role the union no longer admits has no caller.
 */
type AssertTrue<T extends true> = T;
type AssertOnlyTheLiveRolesRemain = AssertTrue<"test-writer" extends IsolationRole ? false : true>;
type AssertTheOldApiFormIsGone = AssertTrue<"strict" extends IsolationRole ? false : true>;
type AssertTheNoTestRoleRemains = AssertTrue<"no-test" extends IsolationRole ? true : false>;
type AssertTheImplementerRoleRemains = AssertTrue<"implementer" extends IsolationRole ? true : false>;

const _onlyTheLiveRolesRemain: AssertOnlyTheLiveRolesRemain = true;
const _theOldApiFormIsGone: AssertTheOldApiFormIsGone = true;
const _theNoTestRoleRemains: AssertTheNoTestRoleRemains = true;
const _theImplementerRoleRemains: AssertTheImplementerRoleRemains = true;

describe("buildIsolationSection — no-test role", () => {
  // AC-3
  test("returns empty string for no-test prompts", () => {
    const result = buildIsolationSection("no-test");
    expect(result).toBe("");
  });

  test("does not emit isolation header for no-test prompts", () => {
    const result = buildIsolationSection("no-test", undefined, "bun test");
    expect(result).not.toContain("# Isolation Rules");
    expect(result).not.toContain("bun test");
  });
});

describe("buildIsolationSection — implementer role", () => {
  test("allows modification of src/ files", () => {
    const result = buildIsolationSection("implementer");
    expect(result).toContain("src/");
    expect(result).not.toContain("Do NOT modify");
  });

  // AC-5
  test("forbids modification of test files", () => {
    const result = buildIsolationSection("implementer", undefined, "bun test");
    expect(result).toContain("Do not modify test files.");
  });

  test("includes test filtering rule when command configured", () => {
    const result = buildIsolationSection("implementer", undefined, "bun test");
    expect(result).toContain("bun test");
  });

  // AC-4
  test("lite mode allows adding tests for uncovered ACs instead of forbidding all test edits", () => {
    const result = buildIsolationSection("implementer", "lite", "bun test");
    // Session 2 of three-session-tdd-lite fills coverage gaps; a blanket
    // "do not modify test files" would contradict the role-task section.
    expect(result).toContain("You MAY add tests for acceptance criteria that have no coverage yet");
    expect(result).not.toMatch(/do not modify test files/i);
    expect(result.toLowerCase()).toMatch(/do not weaken/i);
  });

  test("explicit strict mode keeps the standard no-test-edits rule", () => {
    const result = buildIsolationSection("implementer", "strict");
    expect(result.toLowerCase()).toMatch(/do not modify.*test|test.*do not modify/i);
  });

  test("omits command example when no test command configured (#543)", () => {
    const result = buildIsolationSection("implementer", "strict");
    expect(result).toContain("scope each run to the files you changed");
    expect(result).not.toContain("bun test");
  });

  // US-004 — the retired arms had their own isolation scopes; the implementer
  // section carries none of them.
  test("contains none of the retired isolation arms", () => {
    const result = buildIsolationSection("implementer");
    // The retired test-writer arms.
    expect(result).not.toContain("Only create or modify files in the test/ directory");
    expect(result).not.toContain("MAY read src/");
    // The retired verifier arm.
    expect(result).not.toContain("Read-only TDD integrity inspection");
    // The retired tdd-simple arm.
    expect(result).not.toContain("You may modify both src/ and test/ files");
  });
});
