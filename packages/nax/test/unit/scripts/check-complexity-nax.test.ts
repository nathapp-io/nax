import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { deriveStoryWorktreeId, storyWorktreePath } from "@/worktree";

describe("biome.json", () => {
  const REPO = join(import.meta.dir, "..", "..", "..");
  const includes: string[] = JSON.parse(readFileSync(join(REPO, "biome.json"), "utf8")).files.includes;

  // A story worktree carries its own copy of biome.json; unexcluded, Biome finds
  // it as a nested root config and aborts `lint` in the main checkout (#1934).
  test("excludes nax's own story worktrees", () => {
    const worktree = storyWorktreePath(REPO, deriveStoryWorktreeId("feature", "US-001"));
    const worktreeDir = relative(REPO, worktree).split(sep)[0];

    expect(includes).toContain(`!**/${worktreeDir}/**`);
  });
});

/**
 * End to end: the real script against the real tree, with a fixture baseline
 * derived from the committed one. Pins the exit codes and the refusal to raise,
 * which the pure functions above cannot see.
 */
describe("check-complexity script", () => {
  const REPO = join(import.meta.dir, "..", "..", "..");
  const SCRIPT = join(REPO, "..", "repo-tooling", "scripts", "check-complexity.ts");
  const committed: { byFile: Record<string, Record<string, number>> } = JSON.parse(
    readFileSync(join(REPO, "scripts", "baselines", "complexity-baseline.json"), "utf8"),
  );
  const [probeFile, probeScores] = Object.entries(committed.byFile)[0] ?? ["", {}];
  const [probeLabel, worst] = Object.entries(probeScores)[0] ?? ["", 0];
  let dir: string;

  beforeAll(() => {
    dir = makeTempDir();
  });
  afterAll(() => cleanupTempDir(dir));

  /** Writes a baseline where `probeFile`'s worst function is recorded at `value`. */
  function fixture(name: string, value: number): string {
    const path = join(dir, name);
    const byFile = { ...committed.byFile, [probeFile]: { ...probeScores, [probeLabel]: value } };
    writeFileSync(path, JSON.stringify({ ...committed, byFile }));
    return path;
  }

  async function run(...args: string[]) {
    const proc = Bun.spawn(["bun", SCRIPT, ...args], { cwd: REPO, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { exitCode: await proc.exited, stdout, stderr };
  }

  // The script runs biome against the full source tree each invocation; the 6
  // scenarios are independent of each other (unique fixture files, no shared
  // state mutation), so run them concurrently to collapse ~2.8 s of serial
  // biome scans into ~470 ms of wall-clock.
  test.concurrent("passes against a baseline that matches the tree", async () => {
    const result = await run(`--baseline=${fixture("match.json", worst)}`);

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  }, 30_000);

  test.concurrent("fails when a function scores higher than its baseline", async () => {
    const result = await run(`--baseline=${fixture("grown.json", worst - 1)}`);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("ratchet breached");
    expect(result.stderr).toContain(probeFile);
  }, 30_000);

  test.concurrent("fails when the baseline is looser than the tree, so the slack cannot be re-spent", async () => {
    const result = await run(`--baseline=${fixture("stale.json", worst + 1)}`);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("baseline is stale");
  }, 30_000);

  test.concurrent("--update-baseline refuses to raise a baseline and leaves the file untouched", async () => {
    const path = fixture("refuse.json", worst - 1);
    const before = readFileSync(path, "utf8");

    const result = await run(`--baseline=${path}`, "--update-baseline");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("only ever goes down");
    expect(readFileSync(path, "utf8")).toBe(before);
  }, 30_000);

  test.concurrent("fails when the baseline file is missing", async () => {
    const result = await run(`--baseline=${join(dir, "absent.json")}`);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("missing");
  }, 30_000);

  test.concurrent("--init-baseline refuses to overwrite an existing baseline", async () => {
    const path = fixture("existing.json", worst);
    const before = readFileSync(path, "utf8");

    const result = await run(`--baseline=${path}`, "--init-baseline");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("never overwrites");
    expect(readFileSync(path, "utf8")).toBe(before);
  }, 30_000);
});
