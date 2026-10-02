/**
 * Characterisation tests for the test-consolidation ranker's CLI surface
 * (`scripts/report-test-consolidation.ts` main()).
 *
 * Nothing else in the repo drives main(): the exported pure primitives
 * (walk/readStat/buildGroups/packGroup) are exercised through
 * check-test-satellites and its unit test, but the report modes, argument
 * validation, and exit codes had zero coverage. These tests pin the branch
 * BEHAVIOUR of each mode — mode selection, exit codes, and message text —
 * by spawning the real script against the live repo. They deliberately do
 * NOT pin volatile counts (scanned files, removable lines), which change
 * with every commit; structural invariants (totals vs rows, the sort order)
 * are pinned instead.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..", "..");
const SCRIPT = join(REPO, "..", "repo-tooling", "scripts", "report-test-consolidation.ts");

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function run(args: string[]): Promise<RunResult> {
  const proc = Bun.spawn(["bun", SCRIPT, ...args], {
    cwd: REPO,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe("report-test-consolidation main — default human report", () => {
  test("exits 0 and prints the ranker headline, table header, and floor line", async () => {
    const { exitCode, stdout } = await run([]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Test-consolidation ranker");
    expect(stdout).toContain("(test/e2e/ excluded — separate CI step)");
    expect(stdout).toContain("  -files  -lines  files→packed  base");
    expect(stdout).toContain("groups already at their floor:");
  });
});

describe("report-test-consolidation main — --json", () => {
  test("exits 0 and emits totals + rows with the Row shape and the sort invariant", async () => {
    const { exitCode, stdout } = await run(["--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as { totals: Record<string, unknown>; rows: Array<Record<string, unknown>> };
    expect(parsed.totals.files).toBeGreaterThan(0);
    expect(parsed.totals.groups).toBe(parsed.rows.length);
    const removable = parsed.rows.map((r) => r.removableFiles as number);
    for (let i = 1; i < removable.length; i++) {
      const prev = removable[i - 1];
      const cur = removable[i];
      const prevLines = parsed.rows[i - 1].removableLines as number;
      const curLines = parsed.rows[i].removableLines as number;
      const ordered = prev > cur || (prev === cur && prevLines >= curLines);
      expect(ordered).toBe(true);
    }
    const row = parsed.rows[0];
    for (const key of [
      "base",
      "members",
      "satellites",
      "mirrors",
      "staticTests",
      "expects",
      "lines",
      "packedFiles",
      "packedLines",
      "removableFiles",
      "removableLines",
      "ticketSatellites",
      "unrestored",
      "unclear",
      "unmergeable",
      "frozenBases",
    ]) {
      expect(key in row).toBe(true);
    }
  });
});

describe("report-test-consolidation main — --group happy path", () => {
  test("prints the group detail sections for a full-path base and exits 0", async () => {
    const { exitCode, stdout } = await run(["--group", "test/unit/runtime/runtime.test.ts"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("GROUP test/unit/runtime/runtime.test.ts");
    expect(stdout).toContain("fill target 650, hard cap 800");
    expect(stdout).toContain("proposed packing:");
    expect(stdout).toContain("members in detail:");
  });
});

describe("report-test-consolidation main — --group argument validation", () => {
  test("exits 1 with a hint when --group has no value", async () => {
    const { exitCode, stderr } = await run(["--group"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--group needs a base test path. Run without --group to list the groups.");
  });

  test("exits 1 when no group matches the requested base", async () => {
    const { exitCode, stderr } = await run(["--group", "test/unit/does-not-exist.test.ts"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("No group with base test/unit/does-not-exist.test.ts. Run without --group to list them.");
  });

  test("exits 1 with the candidate list when a bare filename matches several groups", async () => {
    const { exitCode, stderr } = await run(["--group", "manager.test.ts"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Ambiguous: manager.test.ts matches");
    expect(stderr).toContain("Use the full path:");
  });
});

describe("report-test-consolidation main — --mirrors", () => {
  test("exits 0 and prints the never-merge mirrors banner", async () => {
    const { exitCode, stdout } = await run(["--mirrors"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Mirrors — satellites that ARE the per-source test file. NEVER merge these.");
  });
});
