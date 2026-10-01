/**
 * Tests for scripts/check-worktree-id-ssot.ts — the static gate that
 * prevents source from open-coding the `.nax-wt/<id>` worktree path,
 * the `nax/<id>` story branch, the `bakeoff-<feature>-<profile>` id, and
 * the `refs/nax/orphan/<storyId>` ref name outside the worktree-id module.
 *
 * Mirrors scripts/check-feature-dir-ssot.ts: scan `src/`, allowlist a
 * handful of consumers whose spelling must stay as it is, and let prose
 * escape with a per-line `nax-worktree-id-allow: <reason>` marker.
 *
 * Story: US-001
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { findWorktreeIdViolations, formatWorktreeIdViolationReport } from "@scripts/check-worktree-id-ssot";
import { makeTempDir } from "@test/helpers";

function writeSource(root: string, relPath: string, content: string): void {
  mkdirSync(dirname(join(root, relPath)), { recursive: true });
  writeFileSync(join(root, relPath), content);
}

describe("findWorktreeIdViolations", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-worktree-id-ssot-");
    mkdirSync(join(tempDir, "src"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns empty array when only the SSOT module spells the worktree path", () => {
    const src = "export function storyWorktreePath(projectRoot, id) { return projectRoot + '/.nax-wt/' + id; }\n";
    writeSource(tempDir, "src/worktree/worktree-id.ts", src);

    expect(findWorktreeIdViolations(tempDir)).toEqual([]);
  });

  // AC-10: non-allowlisted file spelling a `.nax-wt` path segment MUST fail.
  test("US-001 AC10: flags a non-allowlisted source file that builds a string containing a `.nax-wt` path segment", () => {
    writeSource(
      tempDir,
      "src/execution/manual-worktree.ts",
      'const worktreePath = join(projectRoot, ".nax-wt", storyId);\n',
    );

    const violations = findWorktreeIdViolations(tempDir);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe("src/execution/manual-worktree.ts");
    expect(violations[0]?.line).toBe(1);
  });

  // AC-11: non-allowlisted file spelling a `nax/` branch prefix MUST fail.
  test("US-001 AC11: flags a non-allowlisted source file that builds a branch string prefixed `nax/`", () => {
    const src = "const branchName = 'nax/' + storyId;\n";
    writeSource(tempDir, "src/execution/manual-branch.ts", src);

    const violations = findWorktreeIdViolations(tempDir);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe("src/execution/manual-branch.ts");
    expect(violations[0]?.line).toBe(1);
  });

  test("flags an open-coded worktree path in a production constructor", () => {
    writeSource(tempDir, "src/worktree/manager.ts", 'const worktreePath = join(projectRoot, ".nax-wt", storyId);\n');

    expect(findWorktreeIdViolations(tempDir)).toHaveLength(1);
  });

  // AC-12: a per-line `nax-worktree-id-allow: <reason>` marker MUST escape.
  test("US-001 AC12: honours a per-line allow comment on a prose line", () => {
    writeSource(
      tempDir,
      "src/execution/message.ts",
      'const msg = "spawned worktree at .nax-wt/<storyId>/"; // nax-worktree-id-allow: user-facing message\n',
    );

    expect(findWorktreeIdViolations(tempDir)).toEqual([]);
  });

  test("US-001 AC12 (boundary): an unrelated comment does NOT escape", () => {
    writeSource(
      tempDir,
      "src/execution/no-marker.ts",
      'const worktreePath = join(projectRoot, ".nax-wt", storyId); // just some unrelated comment\n',
    );

    expect(findWorktreeIdViolations(tempDir).length).toBeGreaterThan(0);
  });

  // Regression: the allow marker only counts when it sits in a `//`
  // comment. Scanning the full line would let
  // `const m = "nax-worktree-id-allow";` mask a real `.nax-wt/<id>`
  // spelling on the same line.
  test("the allow marker inside an executable string literal does NOT escape", () => {
    const src = 'const marker = "nax-worktree-id-allow"; const worktreePath = join(root, ".nax-wt", storyId);\n';
    writeSource(tempDir, "src/execution/marker-in-string.ts", src);

    const violations = findWorktreeIdViolations(tempDir);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]?.file).toBe("src/execution/marker-in-string.ts");
  });

  // Regression: a `//` inside a string literal is NOT a comment start.
  // Otherwise `const m = "//nax-worktree-id-allow: r";` would make the
  // gate treat the rest of the line as a comment and miss a real
  // `.nax-wt/<id>` spelling that follows the string literal.
  test("a `//` inside a string literal does NOT count as a comment start", () => {
    const src = 'const m = "//nax-worktree-id-allow: r"; const worktreePath = join(root, ".nax-wt", storyId);\n';
    writeSource(tempDir, "src/execution/marker-via-string-slash-slash.ts", src);

    const violations = findWorktreeIdViolations(tempDir);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]?.file).toBe("src/execution/marker-via-string-slash-slash.ts");
  });

  // Regression: a closed block comment on the same line as executable
  // code is NOT pure prose — the gate must still scan the code for an
  // open-coded `.nax-wt/<id>` spelling. The pre-fix `startsWith("*") /
  // startsWith("/*")` check would skip the line entirely.
  test("a closed block comment on the same line as code does NOT skip the code", () => {
    const src = '/* ignored */ const worktreePath = join(root, ".nax-wt", storyId);\n';
    writeSource(tempDir, "src/execution/block-then-code.ts", src);

    const violations = findWorktreeIdViolations(tempDir);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]?.file).toBe("src/execution/block-then-code.ts");
  });

  // Regression: a block-comment terminator followed by executable code
  // on the same line is NOT pure prose — the gate must scan the code.
  test("a block-comment terminator followed by code on the same line does NOT skip the code", () => {
    const src = '*/ const worktreePath = join(root, ".nax-wt", storyId);\n';
    writeSource(tempDir, "src/execution/terminator-then-code.ts", src);

    const violations = findWorktreeIdViolations(tempDir);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]?.file).toBe("src/execution/terminator-then-code.ts");
  });

  // Regression (adversarial review): a line whose trimmed form begins with
  // `*` was skipped as "block-comment continuation" even when no block
  // comment was open. A continuation line may legitimately begin with `*` as
  // a multiplication operator — ASI does not break the expression — so an
  // open-coded spelling on such a line evaded the gate entirely.
  test("US-001 AC10 (boundary): a line beginning with `*` that continues executable code is NOT skipped as prose", () => {
    // `const factor = 1 * ".nax-wt/"` — valid syntax; the `*` lands at the
    // start of line 2 because the initializer continues across the newline.
    writeSource(tempDir, "src/execution/star-continuation.ts", 'const factor = 1\n* ".nax-wt/"\n');

    const violations = findWorktreeIdViolations(tempDir);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe("src/execution/star-continuation.ts");
    expect(violations[0]?.line).toBe(2);
  });

  // The same evasion with a `nax/` branch prefix on the asterisk-led line.
  test("US-001 AC11 (boundary): a line beginning with `*` that continues executable code is NOT skipped as prose for a `nax/` branch", () => {
    writeSource(tempDir, "src/execution/star-continuation-branch.ts", 'const label = 1\n* "nax/story-f-US-001"\n');

    const violations = findWorktreeIdViolations(tempDir);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe("src/execution/star-continuation-branch.ts");
    expect(violations[0]?.line).toBe(2);
  });

  // Same root cause, other direction: a block comment that CLOSES mid-line
  // with executable code after it must still be scanned — even though the
  // line begins with `*`. The old heuristic skipped it as prose.
  test("US-001 AC10 (boundary): code after a block comment closing mid-line is scanned", () => {
    writeSource(tempDir, "src/execution/close-then-code.ts", '/* prose\n * more prose */ const p = ".nax-wt/x";\n');

    const violations = findWorktreeIdViolations(tempDir);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe("src/execution/close-then-code.ts");
    expect(violations[0]?.line).toBe(2);
  });

  // The behaviour the asterisk rule was trying to provide is preserved:
  // genuine multi-line block-comment prose is still not a violation.
  test("does not flag prose inside a multi-line block comment", () => {
    writeSource(
      tempDir,
      "src/doc.ts",
      "/**\n * The worktree lives at `.nax-wt/<id>` and the ref at `refs/nax/orphan/<id>`.\n * The branch is `nax/<id>`.\n */\nconst x = 1;\n",
    );

    expect(findWorktreeIdViolations(tempDir)).toEqual([]);
  });

  // AC-13: an allowlisted consumer file that spells `.nax-wt` MUST pass.
  test("US-001 AC13: allows src/utils/gitignore.ts (the gitignore entry)", () => {
    writeSource(tempDir, "src/utils/gitignore.ts", 'const ENTRY = ".nax-wt/";\n');
    expect(findWorktreeIdViolations(tempDir)).toEqual([]);
  });

  test("US-001 AC13: allows src/review/runner/index.ts (the ignore regex)", () => {
    writeSource(tempDir, "src/review/runner/index.ts", "const PATTERN = /\\.nax-wt\\//;\n");
    expect(findWorktreeIdViolations(tempDir)).toEqual([]);
  });

  test("US-001 AC13: allows src/precheck/checks-git.ts (the porcelain-status regex)", () => {
    writeSource(tempDir, "src/precheck/checks-git.ts", "const PATTERN = /^.{2} \\.nax-wt\\//;\n");
    expect(findWorktreeIdViolations(tempDir)).toEqual([]);
  });

  test("US-001 AC13: allows src/precheck/checks-warnings.ts (the ignore entry)", () => {
    writeSource(tempDir, "src/precheck/checks-warnings.ts", 'const PATTERN = ".nax-wt/";\n');
    expect(findWorktreeIdViolations(tempDir)).toEqual([]);
  });

  test("US-001 AC13: allows src/bakeoff/preflight.ts (the bakeoff- branch namespace)", () => {
    writeSource(tempDir, "src/bakeoff/preflight.ts", 'const BAKEOFF_BRANCH_PREFIX = "nax/bakeoff-";\n');
    expect(findWorktreeIdViolations(tempDir)).toEqual([]);
  });

  test("US-001 AC13: allows src/runtime/packages.ts (the .nax-wt first-segment guard)", () => {
    writeSource(
      tempDir,
      "src/runtime/packages.ts",
      'const seg = packageDir.split("/")[0]; if (seg !== ".nax-wt") return packageDir;\n',
    );
    expect(findWorktreeIdViolations(tempDir)).toEqual([]);
  });

  test("does not flag prose in comments", () => {
    writeSource(tempDir, "src/commented.ts", "// Walks .nax-wt/<storyId>/ to resolve the worktree.\nconst x = 1;\n");

    expect(findWorktreeIdViolations(tempDir)).toEqual([]);
  });

  test("does not flag prose in a trailing comment after real code", () => {
    writeSource(tempDir, "src/trailing.ts", "const x = 1; // `.nax-wt/<storyId>` here is just a comment\n");

    expect(findWorktreeIdViolations(tempDir)).toEqual([]);
  });

  test("flags a string literal that hardcodes `refs/nax/orphan/<id>`", () => {
    writeSource(tempDir, "src/execution/manual-orphan-ref.ts", 'const ref = "refs/nax/orphan/" + storyId;\n');

    const violations = findWorktreeIdViolations(tempDir);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe("src/execution/manual-orphan-ref.ts");
  });
});

describe("formatWorktreeIdViolationReport", () => {
  test("returns OK message when there are no violations", () => {
    expect(formatWorktreeIdViolationReport([])).toContain("[OK]");
  });

  test("includes file, line, and guidance when violations exist", () => {
    const report = formatWorktreeIdViolationReport([
      {
        file: "src/unsafe.ts",
        line: 7,
        snippet: 'const worktreePath = join(projectRoot, ".nax-wt", storyId);',
        kind: "worktree-path",
      },
    ]);

    expect(report).toContain("[FAIL]");
    expect(report).toContain("src/unsafe.ts:7");
    expect(report).toContain("storyWorktreePath");
    expect(report).toContain("naxOrphanRefName(worktreeId)");
    expect(report).toContain("nax-worktree-id-allow");
  });
});

describe("the nax repo itself", () => {
  // AC-13 (repo-wide): every consumer of `.nax-wt` / `nax/` /
  // `refs/nax/orphan/` outside `src/worktree/worktree-id.ts` is either
  // allowlisted (with a comment justifying the spelling) or carries an
  // explicit per-line `nax-worktree-id-allow` marker.
  test("every .nax-wt / nax/ / refs/nax/orphan/ spelling outside src/worktree/worktree-id.ts is either allowlisted or carries an nax-worktree-id-allow marker", () => {
    const root = join(import.meta.dir, "..", "..", "..");
    const violations = findWorktreeIdViolations(root);

    if (violations.length > 0) {
      // Surface the violation report inline so a failing test names the
      // exact file/line that needs an allowlist or marker.
      console.error(formatWorktreeIdViolationReport(violations));
    }

    expect(violations).toEqual([]);
  });
});
