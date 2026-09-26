/**
 * Deterministic fix-scope classification (US-002, ADR-033 §1).
 *
 * `checkFixScope` is pure path arithmetic: no git, no LLM, no I/O. Given the
 * repo-root-relative paths a fix changed, it decides whether every non-test file
 * among them is one the story was already authorised to touch — a file it had
 * changed before the fix, one it declares, or one a seeding finding named.
 *
 * Everything here is a pure-function assertion on the returned verdict, plus the
 * boundaries that matter: an empty (known) `storyFiles` versus an unknown one
 * (`undefined`), the `.nax/` and test-file exemptions, and the package-relative
 * join for a finding's workdir-relative `file`.
 */
import { describe, expect, test } from "bun:test";
import { makeFinding, makeStory } from "@test/helpers";
import { checkFixScope, type FixScopeInput } from "@/review/fix-review/scope";

/** A scope input with nothing changed and nothing declared; each case overrides what it cares about. */
function scopeInput(overrides: Partial<FixScopeInput> = {}): FixScopeInput {
  return {
    changedFiles: [],
    storyFiles: [],
    story: makeStory(),
    findings: [],
    packageDirRel: "",
    isTestFile: () => false,
    ...overrides,
  };
}

describe("checkFixScope", () => {
  test("AC11: returns inScope true with no out-of-scope files when every changed file is in storyFiles", () => {
    const result = checkFixScope(
      scopeInput({ changedFiles: ["src/a.ts", "src/b.ts"], storyFiles: ["src/a.ts", "src/b.ts"] }),
    );

    expect(result.inScope).toBe(true);
    expect(result.outOfScopeFiles).toEqual([]);
    expect(result.skipped).toBe(false);
  });

  test("AC11: returns inScope true for a fix that changed nothing", () => {
    const result = checkFixScope(scopeInput({ changedFiles: [], storyFiles: ["src/a.ts"] }));

    expect(result.inScope).toBe(true);
    expect(result.outOfScopeFiles).toEqual([]);
    expect(result.skipped).toBe(false);
  });

  test("AC12: treats a changed file listed only in story.contextFiles as in scope", () => {
    const result = checkFixScope(
      scopeInput({ changedFiles: ["src/ctx.ts"], story: makeStory({ contextFiles: ["src/ctx.ts"] }) }),
    );

    expect(result.inScope).toBe(true);
    expect(result.outOfScopeFiles).toEqual([]);
  });

  test("AC12: leaves an unlisted changed file out of scope even when contextFiles is not empty", () => {
    const result = checkFixScope(
      scopeInput({ changedFiles: ["src/other.ts"], story: makeStory({ contextFiles: ["src/ctx.ts"] }) }),
    );

    expect(result.inScope).toBe(false);
    expect(result.outOfScopeFiles).toEqual(["src/other.ts"]);
  });

  test("AC12: reads the path of a contextFiles entry that carries citation metadata", () => {
    const result = checkFixScope(
      scopeInput({
        changedFiles: ["src/ctx.ts"],
        story: makeStory({ contextFiles: [{ path: "src/ctx.ts", factId: "fact-1" }] }),
      }),
    );

    expect(result.inScope).toBe(true);
    expect(result.outOfScopeFiles).toEqual([]);
  });

  test("AC12: falls back to the deprecated relevantFiles when contextFiles is absent", () => {
    const result = checkFixScope(
      scopeInput({ changedFiles: ["src/legacy.ts"], story: makeStory({ relevantFiles: ["src/legacy.ts"] }) }),
    );

    expect(result.inScope).toBe(true);
    expect(result.outOfScopeFiles).toEqual([]);
  });

  test("AC13: treats a changed file listed only in story.expectedFiles as in scope", () => {
    const result = checkFixScope(
      scopeInput({ changedFiles: ["src/created.ts"], story: makeStory({ expectedFiles: ["src/created.ts"] }) }),
    );

    expect(result.inScope).toBe(true);
    expect(result.outOfScopeFiles).toEqual([]);
  });

  test("AC13: leaves an unlisted changed file out of scope even when expectedFiles is not empty", () => {
    const result = checkFixScope(
      scopeInput({ changedFiles: ["src/other.ts"], story: makeStory({ expectedFiles: ["src/created.ts"] }) }),
    );

    expect(result.inScope).toBe(false);
    expect(result.outOfScopeFiles).toEqual(["src/other.ts"]);
  });

  test("AC14: treats a changed file listed only as a modifiedFiles entry's path as in scope", () => {
    const result = checkFixScope(
      scopeInput({
        changedFiles: ["src/existing.ts"],
        story: makeStory({ modifiedFiles: [{ path: "src/existing.ts", reason: "widens the guard" }] }),
      }),
    );

    expect(result.inScope).toBe(true);
    expect(result.outOfScopeFiles).toEqual([]);
  });

  test("AC14: an authorisation with an empty reason still puts the changed path in scope", () => {
    const result = checkFixScope(
      scopeInput({
        changedFiles: ["src/existing.ts"],
        story: makeStory({ modifiedFiles: [{ path: "src/existing.ts", reason: "" }] }),
      }),
    );

    expect(result.inScope).toBe(true);
    expect(result.outOfScopeFiles).toEqual([]);
  });

  test("AC14: leaves an unlisted changed file out of scope even when modifiedFiles is not empty", () => {
    const result = checkFixScope(
      scopeInput({
        changedFiles: ["src/other.ts"],
        story: makeStory({ modifiedFiles: [{ path: "src/existing.ts", reason: "widens the guard" }] }),
      }),
    );

    expect(result.inScope).toBe(false);
    expect(result.outOfScopeFiles).toEqual(["src/other.ts"]);
  });

  test("AC15: a seeding finding names a file relative to the package dir", () => {
    const result = checkFixScope(
      scopeInput({
        changedFiles: ["packages/a/src/lock.ts"],
        findings: [makeFinding({ file: "src/lock.ts" })],
        packageDirRel: "packages/a",
      }),
    );

    expect(result.inScope).toBe(true);
    expect(result.outOfScopeFiles).toEqual([]);
  });

  test("AC15: joins a finding's path without a stray separator when the package dir is the repo root", () => {
    const result = checkFixScope(
      scopeInput({
        changedFiles: ["src/lock.ts"],
        findings: [makeFinding({ file: "src/lock.ts" })],
        packageDirRel: "",
      }),
    );

    expect(result.inScope).toBe(true);
    expect(result.outOfScopeFiles).toEqual([]);
  });

  test("a `./`-prefixed finding path and a trailing-slash package dir still join to the changed path", () => {
    const result = checkFixScope(
      scopeInput({
        changedFiles: ["packages/a/src/lock.ts"],
        findings: [makeFinding({ file: "./src/lock.ts" })],
        packageDirRel: "packages/a/",
      }),
    );

    expect(result.inScope).toBe(true);
    expect(result.outOfScopeFiles).toEqual([]);
  });

  test.each([".//src/lock.ts", "./././src/lock.ts", "src//lock.ts"])(
    "a finding spelled %p still joins to the changed path",
    (file) => {
      const result = checkFixScope(
        scopeInput({
          changedFiles: ["packages/a/src/lock.ts"],
          findings: [makeFinding({ file })],
          packageDirRel: "packages/a",
        }),
      );

      expect(result.inScope).toBe(true);
    },
  );

  test("AC15: a seeding finding that names no file adds nothing to the allowed set", () => {
    const result = checkFixScope(
      scopeInput({
        changedFiles: ["src/utils/path-file-lock.ts"],
        findings: [makeFinding({ message: "this finding names no file" })],
      }),
    );

    expect(result.inScope).toBe(false);
    expect(result.outOfScopeFiles).toEqual(["src/utils/path-file-lock.ts"]);
  });

  test("AC16: treats a changed file the test classifier matches as in scope even when no allowed set names it", () => {
    const result = checkFixScope(
      scopeInput({ changedFiles: ["test/unit/review/thing.test.ts"], isTestFile: (path) => path.endsWith(".test.ts") }),
    );

    expect(result.inScope).toBe(true);
    expect(result.outOfScopeFiles).toEqual([]);
  });

  test("AC16: exempts only the test file, not a source file changed alongside it", () => {
    const result = checkFixScope(
      scopeInput({
        changedFiles: ["test/unit/review/thing.test.ts", "src/scope-creep.ts"],
        isTestFile: (path) => path.endsWith(".test.ts"),
      }),
    );

    expect(result.inScope).toBe(false);
    expect(result.outOfScopeFiles).toEqual(["src/scope-creep.ts"]);
  });

  test("AC16: hands the classifier the repo-root-relative changed path", () => {
    const seen: string[] = [];
    const isTestFile = (path: string): boolean => {
      seen.push(path);
      return path === "packages/a/test/unit/x.test.ts";
    };

    const result = checkFixScope(
      scopeInput({ changedFiles: ["packages/a/test/unit/x.test.ts"], packageDirRel: "packages/a", isTestFile }),
    );

    expect(result.inScope).toBe(true);
    expect(seen).toContain("packages/a/test/unit/x.test.ts");
  });

  test("AC17: ignores a changed path under .nax/", () => {
    const result = checkFixScope(
      scopeInput({ changedFiles: [".nax/state.json", ".nax/features/fix-review/prd.json"] }),
    );

    expect(result.inScope).toBe(true);
    expect(result.outOfScopeFiles).toEqual([]);
  });

  test('AC17: does not exempt a path that merely starts with ".nax"', () => {
    const result = checkFixScope(scopeInput({ changedFiles: ["docs/.nax-notes.md", ".nax-backup/state.json"] }));

    expect(result.inScope).toBe(false);
    expect(result.outOfScopeFiles).toEqual(["docs/.nax-notes.md", ".nax-backup/state.json"]);
  });

  test("AC17: ignores a changed path under a nested per-package .nax/ directory (monorepo)", () => {
    const result = checkFixScope(
      scopeInput({ changedFiles: ["packages/a/.nax/state.json", "packages/a/.nax", "apps/web/.nax/cache.json"] }),
    );

    expect(result.inScope).toBe(true);
    expect(result.outOfScopeFiles).toEqual([]);
  });

  test("AC18: reports a changed non-test file that is in no allowed set", () => {
    const result = checkFixScope(
      scopeInput({
        changedFiles: ["src/utils/path-file-lock.ts"],
        storyFiles: ["src/review/fix-review/scope.ts"],
        story: makeStory({ contextFiles: ["src/review/fix-review/scope.ts"] }),
      }),
    );

    expect(result.inScope).toBe(false);
    expect(result.outOfScopeFiles).toEqual(["src/utils/path-file-lock.ts"]);
    expect(result.skipped).toBe(false);
  });

  test("AC18: reports every out-of-scope file, not just the first", () => {
    const result = checkFixScope(scopeInput({ changedFiles: ["src/scope-creep.ts", "src/utils/path-file-lock.ts"] }));

    expect(result.inScope).toBe(false);
    expect(result.outOfScopeFiles).toHaveLength(2);
    expect(result.outOfScopeFiles).toContain("src/scope-creep.ts");
    expect(result.outOfScopeFiles).toContain("src/utils/path-file-lock.ts");
  });

  test("AC19: returns inScope true and skipped true when storyFiles is undefined", () => {
    const result = checkFixScope(scopeInput({ changedFiles: ["src/utils/path-file-lock.ts"], storyFiles: undefined }));

    expect(result.inScope).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.outOfScopeFiles).toEqual([]);
  });

  test("AC19: an empty storyFiles means the story changed nothing, so the check still runs", () => {
    const result = checkFixScope(scopeInput({ changedFiles: ["src/utils/path-file-lock.ts"], storyFiles: [] }));

    expect(result.skipped).toBe(false);
    expect(result.inScope).toBe(false);
    expect(result.outOfScopeFiles).toEqual(["src/utils/path-file-lock.ts"]);
  });
});
