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
 * excludes `.worktrees/**` and `.claude/worktrees/**` at the root and under
 * `packages/**\/` (anchored, never `**\/` first: see nax#2631 below). This test
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
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

const REPO = join(import.meta.dir, "..", "..", "..");
const TARGET_FILE = "src/version.ts";
const WORKTREE_DIRS: string[] = [".nax-wt", ".worktrees", ".claude/worktrees"];
const PACKAGES = ["nax", "nax-agent", "nax-agent-acp", "nax-ai", "repo-tooling", "test-kit"] as const;
const BIOME_BIN = Bun.resolveSync("@biomejs/biome/bin/biome", REPO);

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
    // Spawns `bun x biome check`: ~1.2s alone, but past the confined run's 5s
    // per-test budget on a 4-core CI runner with 4 parallel test workers busy.
  }, 20_000);
});

/**
 * A checkout that itself lives under a worktree directory (nax#2631). The bot
 * checks a PR out at `<repo>/.nax-wt/bot-pr-<n>-<id>`, story worktrees use
 * `.nax-wt/<storyId>`. An unanchored `!**\/.nax-wt/**` matches every file's own
 * path there, so `biome check` processes nothing and exits 1. Exclusions must be
 * anchored to the config's own directory.
 */
describe("checkout under a worktree directory (nax#2631)", () => {
  const MONOREPO = join(REPO, "..", "..");
  const CONFIGS = ["biome.json", ...PACKAGES.map((pkg) => `packages/${pkg}/biome.json`)];
  let tempDir: string | undefined;

  afterEach(() => {
    cleanupTempDir(tempDir);
    tempDir = undefined;
  });

  /** The monorepo's biome configs and one nax source file, laid out at `root`. */
  function layoutCheckout(root: string): string {
    const nax = join(root, "packages", "nax");
    cpSync(join(MONOREPO, "biome.json"), join(root, "biome.json"));
    cpSync(join(REPO, "biome.json"), join(nax, "biome.json"));
    cpSync(join(REPO, "biome-plugins"), join(nax, "biome-plugins"), { recursive: true });
    cpSync(join(REPO, TARGET_FILE), join(nax, TARGET_FILE));
    return nax;
  }

  async function biomeCheck(cwd: string): Promise<{ output: string; stdout: string; exitCode: number }> {
    const proc = Bun.spawn([BIOME_BIN, "check", TARGET_FILE], { cwd, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { output: stderr + stdout, stdout, exitCode };
  }

  test.each(WORKTREE_DIRS)(
    "bun x biome check still checks files when the checkout sits under %s/",
    async (dir) => {
      tempDir = makeTempDir();
      const { output, stdout, exitCode } = await biomeCheck(layoutCheckout(join(tempDir, dir, "co")));

      expect(output).not.toContain("No files were processed");
      expect(stdout).toContain("Checked 1 file");
      expect(exitCode).toBe(0);
    },
    20_000,
  );

  // Bot checkouts and story worktrees live at the monorepo root, beside packages/ (nax#1934 again).
  test("a checkout inside a monorepo-root worktree directory does not abort the main checkout's lint", async () => {
    tempDir = makeTempDir();
    const nax = layoutCheckout(tempDir);
    for (const dir of WORKTREE_DIRS) layoutCheckout(join(tempDir, dir, "nested"));

    const { output, stdout, exitCode } = await biomeCheck(nax);

    expect(output).not.toContain("nested root configuration");
    expect(stdout).toContain("Checked 1 file");
    expect(exitCode).toBe(0);
  }, 20_000);

  test.each(CONFIGS)("%s anchors its worktree exclusions to its own directory", (config) => {
    const parsed: { files?: { includes?: string[] } } = JSON.parse(readFileSync(join(MONOREPO, config), "utf8"));
    const unanchored = (parsed.files?.includes ?? []).filter((glob) =>
      WORKTREE_DIRS.some((dir) => glob === `!**/${dir}/**`),
    );
    expect(unanchored).toEqual([]);
  });
});
