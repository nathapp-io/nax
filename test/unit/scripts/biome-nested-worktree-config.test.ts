/**
 * Nested worktree biome.json must not abort the project-wide lint (nax#1934).
 *
 * A git worktree checked out under `.worktrees/` (or `.claude/worktrees/`)
 * carries its own copy of `biome.json`, since that file is tracked at the
 * repo root and comes along with every worktree checkout. Biome's project
 * scan walks the whole repo tree looking for config files and, on finding
 * that second root config, aborts with "Found a nested root configuration"
 * before checking a single file. Because `bun run lint` fronts thirteen
 * `check:*` ratchets behind this one `biome check` call, all of them go dark
 * and the agent sees only an opaque exit 1.
 *
 * The fix is a top-level `files.includes` on the root `biome.json` that
 * excludes `**\/.worktrees/**` and `**\/.claude/worktrees/**`. This test
 * reproduces the real failure mode: it plants a nested config under
 * `.worktrees/` inside THIS repo and runs the real `bun x biome check`
 * against it, the same way `bun run lint` does.
 *
 * Deliberately NOT substituted: `vcs: { enabled: true, clientKind: "git",
 * useIgnoreFile: true }` also silences the "nested root configuration"
 * error, but it was measured to silently drop 10 files from the lint
 * surface (2468 checked vs. the 2478 baseline) because gitignored paths
 * elsewhere in the tree are legitimately still linted. `files.includes` was
 * measured to keep the count at exactly 2478 — do not swap it for `vcs`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..", "..");
const TARGET_FILE = "src/version.ts";

let worktreeDir: string | undefined;

afterEach(() => {
  if (worktreeDir) {
    rmSync(worktreeDir, { recursive: true, force: true });
    worktreeDir = undefined;
  }
});

describe("nested worktree biome.json (nax#1934)", () => {
  test("bun x biome check succeeds and reports a file count with a nested .worktrees/ config present", async () => {
    worktreeDir = join(REPO, ".worktrees", `nax-test-1934-${process.pid}-${Date.now()}`);
    mkdirSync(worktreeDir, { recursive: true });
    writeFileSync(
      join(worktreeDir, "biome.json"),
      JSON.stringify({
        $schema: "https://biomejs.dev/schemas/2.5.10/schema.json",
        linter: { enabled: true },
      }),
    );

    const proc = Bun.spawn(["bun", "x", "biome", "check", TARGET_FILE], {
      cwd: REPO,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    // Pre-fix, this exits non-zero with "Found a nested root configuration"
    // in stderr and never reaches the "Checked" summary line.
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Checked");
    expect(stderr).not.toContain("nested root configuration");
  });
});
