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
import {
  checkIgnoreRuleStatus,
  findTrackedNaxArtifacts,
  formatTrackedNaxArtifactsReport,
} from "@scripts/check-nax-artifacts-untracked";

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

  test("reports a tracked top-level .nax/status.json", () => {
    const root = makeRepo({ ".nax/status.json": "{}\n" });

    expect(findTrackedNaxArtifacts(root)).toEqual([".nax/status.json"]);
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

    expect(report).toContain("[FAIL] 3 tracked file(s) match a nax gitignore entry");
    expect(report).toContain("status.json: 2");
    expect(report).toContain("progress.txt: 1");
    expect(report).toContain("git rm --cached");
  });

  // Fix 1(b): the old fixed text ("The ignore rule is in place") stated a fact
  // it never checked, and both halves could be false at once — the observed
  // real-run failure was exactly that: no rule in place, and the file was
  // never committed, only staged. The message must say which case actually
  // holds, per violating path.
  test("when the ignore rule is missing, says so and points at nax's reconcile / nax init — not git rm --cached alone", () => {
    const report = formatTrackedNaxArtifactsReport([".nax/scratchpad/notes.md"], () => "missing");

    expect(report).toContain("have no ignore rule yet");
    expect(report).toContain("nax init");
    expect(report).not.toContain("The ignore rule is\nin place");
  });

  test("when the ignore rule is already in place, says the file is merely still in the index", () => {
    const report = formatTrackedNaxArtifactsReport([".nax/features/demo/status.json"], () => "in-place");

    expect(report).toContain("already have an ignore rule in place");
    expect(report).toContain("does not");
    expect(report).toContain("untrack a file already in the index");
    expect(report).toContain("git rm --cached");
  });

  test("a mixed set reports both cases, each with its own count", () => {
    const report = formatTrackedNaxArtifactsReport(
      [".nax/features/demo/status.json", ".nax/scratchpad/notes.md"],
      (path) => (path === ".nax/features/demo/status.json" ? "in-place" : "missing"),
    );

    expect(report).toContain("1 already have an ignore rule in place");
    expect(report).toContain("1 have no ignore rule yet");
  });

  test("defaults to treating every violation as rule-missing when no checker is supplied", () => {
    // main() always supplies a real checker; the default only matters for a
    // caller that doesn't (e.g. an older test) — and it must not silently
    // claim a rule is in place that was never checked.
    const report = formatTrackedNaxArtifactsReport([".nax/scratchpad/notes.md"]);

    expect(report).toContain("have no ignore rule yet");
    expect(report).not.toContain("already have an ignore rule in place");
  });

  // Critical 2 (code review): "unknown" is its own bucket. It must never be
  // folded into "missing" (that would recommend adding a rule that might
  // already exist) or "in-place" (that would recommend `git rm --cached` on
  // a status nobody actually confirmed).
  test("an unresolved status gets its own bucket, and recommends neither remedy outright", () => {
    const report = formatTrackedNaxArtifactsReport([".nax/scratchpad/notes.md"], () => "unknown");

    expect(report).toContain("could not be checked");
    expect(report).toContain("check-ignore");
    expect(report).not.toContain("already have an ignore rule in place");
    expect(report).not.toContain("have no ignore rule yet");
  });
});

describe("checkIgnoreRuleStatus", () => {
  test("is 'missing' for a path no ignore rule covers", () => {
    const root = makeRepo({});

    expect(checkIgnoreRuleStatus(root, ".nax/scratchpad/notes.md")).toBe("missing");
  });

  test("does not false-positive on a path that merely looks similar to an ignored one", () => {
    // Guards the exact substring-matching bug src/worktree/manager.ts already
    // documents: a naive check must not treat "packages/app/.nax/scratchpad-backup/x"
    // as matched by "**/.nax/scratchpad/".
    const root = makeRepo({});
    writeFileSync(join(root, ".gitignore"), "**/.nax/scratchpad/\n", "utf8");

    expect(checkIgnoreRuleStatus(root, "packages/app/.nax/scratchpad-backup/x")).toBe("missing");
  });

  test("is 'in-place' for a path covered only by .git/info/exclude (worktree reconcile)", () => {
    const root = makeRepo({});
    mkdirSync(join(root, ".git", "info"), { recursive: true });
    writeFileSync(join(root, ".git", "info", "exclude"), "**/.nax/scratchpad/\n", "utf8");

    expect(checkIgnoreRuleStatus(root, ".nax/scratchpad/notes.md")).toBe("in-place");
  });

  // Critical 2 (code review): every real call site passes a path from
  // findTrackedNaxArtifacts, which only ever returns TRACKED paths — but the
  // original implementation was missing --no-index, and git check-ignore does
  // NOT report a tracked file as ignored without it, so the "in-place" branch
  // was unreachable in production. This test drives the real failure
  // condition (a genuinely tracked file), not the untracked happy path the
  // earlier version of this suite exercised.
  test("is 'in-place' for a TRACKED file a .gitignore rule covers — the real call-site shape", () => {
    const root = makeRepo({ ".nax/scratchpad/notes.md": "scratch note\n" });
    writeFileSync(join(root, ".gitignore"), "**/.nax/scratchpad/\n", "utf8");
    git(root, "add", ".gitignore");
    // Confirm the fixture actually reproduces the call-site shape: the file
    // must be tracked, or this test proves nothing.
    expect(findTrackedNaxArtifacts(root)).toContain(".nax/scratchpad/notes.md");

    expect(checkIgnoreRuleStatus(root, ".nax/scratchpad/notes.md")).toBe("in-place");

    // And the report built from that status recommends the ONE correct
    // remedy for a tracked-plus-ignored file: untrack it. It must not claim
    // the rule is missing.
    const report = formatTrackedNaxArtifactsReport([".nax/scratchpad/notes.md"], (path) =>
      checkIgnoreRuleStatus(root, path),
    );
    expect(report).toContain("already have an ignore rule in place");
    expect(report).toContain("git rm --cached");
    expect(report).not.toContain("have no ignore rule yet");
  });

  test("is 'unknown' for a fatal git error (path escapes the repo)", () => {
    const root = makeRepo({});

    // check-ignore rejects a pathspec that resolves outside the repository
    // with a fatal error (exit 128) — not "not ignored".
    expect(checkIgnoreRuleStatus(root, "../../etc/passwd")).toBe("unknown");
  });

  test("is 'unknown', not 'missing', when git itself cannot answer (not a repo at all)", () => {
    const notARepo = mkdtempSync(join(tmpdir(), "nax-artifacts-not-a-repo-"));
    tempDirs.push(notARepo);

    expect(checkIgnoreRuleStatus(notARepo, "anything.txt")).toBe("unknown");
  });
});
