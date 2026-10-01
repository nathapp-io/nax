import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  findPackageFrameDerivationViolations,
  formatPackageFrameDerivationReport,
} from "@scripts/check-package-frame-derivation";
import { makeTempDir } from "@test/helpers";

describe("findPackageFrameDerivationViolations", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-package-frame-derivation-check-");
    mkdirSync(join(tempDir, "src", "context", "engine", "providers"), { recursive: true });
    mkdirSync(join(tempDir, "src", "runtime"), { recursive: true });
    mkdirSync(join(tempDir, "src", "pipeline", "stages"), { recursive: true });
    mkdirSync(join(tempDir, "src", "cli"), { recursive: true });
    mkdirSync(join(tempDir, "src", "utils"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("flags relative(request.repoRoot, request.packageDir) — the nax#2111 defect shape", () => {
    writeFileSync(
      join(tempDir, "src", "context", "engine", "providers", "test-coverage.ts"),
      "const relPackageDir = relative(request.repoRoot, request.packageDir) || undefined;\n",
    );

    const violations = findPackageFrameDerivationViolations(tempDir);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe("src/context/engine/providers/test-coverage.ts");
    expect(violations[0]?.line).toBe(1);
  });

  test("flags relative(repoRoot, packageDir) with bare identifiers (no member access)", () => {
    writeFileSync(join(tempDir, "src", "runtime", "scratch.ts"), "const rel = relative(repoRoot, packageDir);\n");

    expect(findPackageFrameDerivationViolations(tempDir)).toHaveLength(1);
  });

  test("flags packageDirRelative(x.repoRoot, x.packageDir)", () => {
    writeFileSync(
      join(tempDir, "src", "runtime", "scratch2.ts"),
      "const rel = packageDirRelative(request.repoRoot, request.packageDir);\n",
    );

    expect(findPackageFrameDerivationViolations(tempDir)).toHaveLength(1);
  });

  test("does not flag packageDirRelative(root, ctx.workdir) — second arg is workdir, not packageDir", () => {
    writeFileSync(
      join(tempDir, "src", "pipeline", "stages", "routing.ts"),
      "const packageDir = packageDirRelative(root, ctx.workdir);\n",
    );

    expect(findPackageFrameDerivationViolations(tempDir)).toEqual([]);
  });

  test("does not flag relative(ctx.projectDir, ctx.workdir) — neither arg is the repoRoot/packageDir pair", () => {
    writeFileSync(
      join(tempDir, "src", "pipeline", "stages", "context.ts"),
      "const rel = relative(ctx.projectDir, ctx.workdir);\n",
    );

    expect(findPackageFrameDerivationViolations(tempDir)).toEqual([]);
  });

  test("does not flag prose in comments", () => {
    writeFileSync(
      join(tempDir, "src", "runtime", "commented.ts"),
      "// Never derive it as relative(request.repoRoot, request.packageDir) — see nax#2111.\nconst x = 1;\n",
    );

    expect(findPackageFrameDerivationViolations(tempDir)).toEqual([]);
  });

  test("exempts src/runtime/packages.ts — a registry LOOKUP KEY, not a path frame", () => {
    writeFileSync(
      join(tempDir, "src", "runtime", "packages.ts"),
      "const relativeFromRoot = stripLeadingSlash(relative(repoRoot, packageDir));\n" +
        "function toRelativeKey(packageDir) {\n" +
        "  return stripLeadingSlash(relative(repoRoot, packageDir));\n" +
        "}\n",
    );

    expect(findPackageFrameDerivationViolations(tempDir)).toEqual([]);
  });

  test("exempts src/cli/features-acceptance.ts — a CLI path outside story isolation", () => {
    writeFileSync(
      join(tempDir, "src", "cli", "features-acceptance.ts"),
      "const packageDir = relative(repoRoot, g.packageDir);\n",
    );

    expect(findPackageFrameDerivationViolations(tempDir)).toEqual([]);
  });

  test("flags relative(repoRoot, packageDir ?? repoRoot) — a nullish-coalescing fallback on the second arg", () => {
    writeFileSync(
      join(tempDir, "src", "utils", "unexempted.ts"),
      "const rel = relative(repoRoot, packageDir ?? repoRoot);\n",
    );

    expect(findPackageFrameDerivationViolations(tempDir)).toHaveLength(1);
  });

  test("flags relative(repoRoot, packageDir ?? repoRoot) in src/utils/path-filters.ts — no longer blanket-exempt", () => {
    // Correction: this file used to be blanket-exempt with a "provably inert"
    // justification that was WRONG — it only tested whether the worktree
    // prefix could break a match, never whether it could create one via
    // compileMatcher's subject-prepend shape. The real defect is fixed at the
    // source (resolveNaxIgnorePatterns now takes an explicit packageWorkdir
    // override), and the one remaining fallback call carries its own inline
    // `nax-package-frame-allow` marker rather than a whole-file exemption.
    writeFileSync(
      join(tempDir, "src", "utils", "path-filters.ts"),
      "const packagePrefix = a !== b ? normalizePath(relative(repoRoot, packageDir ?? repoRoot)) : null;\n",
    );

    expect(findPackageFrameDerivationViolations(tempDir)).toHaveLength(1);
  });

  test("honours an inline nax-package-frame-allow marker on the call's own line", () => {
    writeFileSync(
      join(tempDir, "src", "utils", "path-filters.ts"),
      "const packagePrefix = normalizePath(packageWorkdir ?? relative(repoRoot, packageDir ?? repoRoot)); // nax-package-frame-allow: fallback for non-worktree callers\n",
    );

    expect(findPackageFrameDerivationViolations(tempDir)).toEqual([]);
  });
});

describe("formatPackageFrameDerivationReport", () => {
  test("returns ok message when there are no violations", () => {
    expect(formatPackageFrameDerivationReport([])).toContain("[OK]");
  });

  test("includes file, line, and guidance when violations exist", () => {
    const report = formatPackageFrameDerivationReport([
      {
        file: "src/context/engine/providers/test-coverage.ts",
        line: 71,
        snippet: "const relPackageDir = relative(request.repoRoot, request.packageDir) || undefined;",
      },
    ]);

    expect(report).toContain("[FAIL]");
    expect(report).toContain("src/context/engine/providers/test-coverage.ts:71");
    expect(report).toContain("storyWorkdir");
  });
});
