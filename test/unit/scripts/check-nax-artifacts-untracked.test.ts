/**
 * The nax-owned run-artifact drift gate.
 *
 * `patchIgnoreFile` cannot see the git index, so an entry added to
 * `NAX_GITIGNORE_ENTRIES` after a repo was initialised re-opens the leak on
 * every future run: the rule is right, the already-tracked file stays tracked.
 * This gate closes that hole. It is proven against fixture repos, never the
 * live one — the live repo is red until the tracked artifacts are untracked,
 * and the gate must keep passing afterwards.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findTrackedNaxArtifacts, formatTrackedNaxArtifactsReport } from "@scripts/check-nax-artifacts-untracked";

const tempDirs: string[] = [];

function git(cwd: string, ...args: string[]): void {
  const proc = Bun.spawnSync(["git", ...args], { cwd });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
  }
}

/** Initialises a fixture repo with `files` staged in the index. */
function makeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "nax-artifacts-"));
  tempDirs.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "nax test");
  for (const [relativePath, body] of Object.entries(files)) {
    const fullPath = join(root, relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, body, "utf8");
  }
  git(root, "add", "-A");
  return root;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("findTrackedNaxArtifacts", () => {
  test("reports a tracked file matching a feature-artifact entry", () => {
    const root = makeRepo({ ".nax/features/demo/status.json": "{}\n" });

    expect(findTrackedNaxArtifacts(root)).toEqual([".nax/features/demo/status.json"]);
  });

  test("reports a tracked file matching a top-level entry", () => {
    const root = makeRepo({ "nax.lock": "lock\n" });

    expect(findTrackedNaxArtifacts(root)).toEqual(["nax.lock"]);
  });

  test("reports a feature artifact under a nested monorepo package", () => {
    const root = makeRepo({ "packages/app/.nax/features/demo/status.json": "{}\n" });

    expect(findTrackedNaxArtifacts(root)).toEqual(["packages/app/.nax/features/demo/status.json"]);
  });

  test("reports nothing for a clean fixture", () => {
    const root = makeRepo({ "src/a.ts": "export const a = 1;\n" });

    expect(findTrackedNaxArtifacts(root)).toEqual([]);
  });

  test("does not flag feature files that belong in version control", () => {
    const root = makeRepo({
      ".nax/features/demo/prd.json": "{}\n",
      ".nax/features/demo/spec.md": "# spec\n",
    });

    expect(findTrackedNaxArtifacts(root)).toEqual([]);
  });
});

describe("formatTrackedNaxArtifactsReport", () => {
  test("reports ok when nothing is tracked", () => {
    expect(formatTrackedNaxArtifactsReport([])).toContain("[OK]");
  });

  test("reports the count, per-basename breakdown, and the remedy", () => {
    const report = formatTrackedNaxArtifactsReport([
      ".nax/features/demo/status.json",
      ".nax/features/other/status.json",
      ".nax/features/demo/progress.txt",
    ]);

    expect(report).toContain("[FAIL]");
    expect(report).toContain("3");
    expect(report).toContain("status.json: 2");
    expect(report).toContain("progress.txt: 1");
    expect(report).toContain("git rm --cached");
  });
});
