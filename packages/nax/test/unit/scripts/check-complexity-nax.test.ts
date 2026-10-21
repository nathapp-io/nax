import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { deriveStoryWorktreeId, storyWorktreePath } from "@/worktree";

describe("biome.json", () => {
  const REPO = join(import.meta.dir, "..", "..", "..");
  const includes: string[] = JSON.parse(readFileSync(join(REPO, "biome.json"), "utf8")).files.includes;

  // A story worktree carries its own copy of biome.json; unexcluded, Biome finds
  // it as a nested root config and aborts `lint` in the main checkout (#1934).
  // Anchored: a leading `**/` also matches a checkout that itself lives in one (#2631).
  test("excludes nax's own story worktrees", () => {
    const worktree = storyWorktreePath(REPO, deriveStoryWorktreeId("feature", "US-001"));
    const worktreeDir = relative(REPO, worktree).split(sep)[0];

    expect(includes).toContain(`!${worktreeDir}/**`);
  });
});

/**
 * End to end: keep one real-tree baseline check, then exercise ratchet failures
 * against a tiny package with the real script and Biome. Pins CLI exit codes and
 * refusal to raise or overwrite a baseline without repeatedly scanning nax.
 */
describe("check-complexity script", () => {
  const REPO = join(import.meta.dir, "..", "..", "..");
  const SCRIPT = join(REPO, "..", "repo-tooling", "scripts", "check-complexity.ts");
  const BASELINE = join(REPO, "scripts", "baselines", "complexity-baseline.json");
  const PROBE_FILE = "src/probe.ts";
  // Six nested ifs contribute 1 + 2 + 3 + 4 + 5 + 6 = 21, above the strict limit of 20.
  const PROBE_SCORE = 21;
  let dir: string;

  beforeAll(() => {
    dir = makeTempDir();
    mkdirSync(join(dir, "src"));
    symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"), "dir");
    writeFileSync(join(dir, "biome.json"), JSON.stringify({ files: { includes: ["**"] } }));
    writeFileSync(
      join(dir, PROBE_FILE),
      `export function probe(value: number): number {
  if (value > 0) {
    if (value > 1) {
      if (value > 2) {
        if (value > 3) {
          if (value > 4) {
            if (value > 5) {
              return value;
            }
          }
        }
      }
    }
  }
  return 0;
}
`,
    );
  });
  afterAll(() => cleanupTempDir(dir));

  /** Writes a baseline for the fixture's single over-limit function. */
  function fixture(name: string, value: number): string {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify({ byFile: { [PROBE_FILE]: { probe: value } } }));
    return path;
  }

  async function run(packageRoot: string, ...args: string[]) {
    const proc = Bun.spawn(["bun", SCRIPT, `--package=${packageRoot}`, ...args], {
      cwd: packageRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { exitCode: await proc.exited, stdout, stderr };
  }

  // Fixture baselines have unique paths, so the scenarios can run concurrently.
  test.concurrent("passes against a baseline that matches the tree", async () => {
    const result = await run(REPO, `--baseline=${BASELINE}`);

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  }, 30_000);

  test.concurrent("fails when a function scores higher than its baseline", async () => {
    const result = await run(dir, `--baseline=${fixture("grown.json", PROBE_SCORE - 1)}`);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("ratchet breached");
    expect(result.stderr).toContain(`${PROBE_FILE}: probe ${PROBE_SCORE} (baseline probe ${PROBE_SCORE - 1})`);
  }, 30_000);

  test.concurrent("fails when the baseline is looser than the tree, so the slack cannot be re-spent", async () => {
    const result = await run(dir, `--baseline=${fixture("stale.json", PROBE_SCORE + 1)}`);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("baseline is stale");
  }, 30_000);

  test.concurrent("--update-baseline refuses to raise a baseline and leaves the file untouched", async () => {
    const path = fixture("refuse.json", PROBE_SCORE - 1);
    const before = readFileSync(path, "utf8");

    const result = await run(dir, `--baseline=${path}`, "--update-baseline");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("only ever goes down");
    expect(readFileSync(path, "utf8")).toBe(before);
  }, 30_000);

  test.concurrent("fails when the baseline file is missing", async () => {
    const result = await run(dir, `--baseline=${join(dir, "absent.json")}`);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("missing");
  }, 30_000);

  test.concurrent("--init-baseline refuses to overwrite an existing baseline", async () => {
    const path = fixture("existing.json", PROBE_SCORE);
    const before = readFileSync(path, "utf8");

    const result = await run(dir, `--baseline=${path}`, "--init-baseline");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("never overwrites");
    expect(readFileSync(path, "utf8")).toBe(before);
  }, 30_000);
});
