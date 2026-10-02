/**
 * migrate.ts — US-003: git-tracked generated content is never migrated.
 *
 * `setupRun`'s startup auto-migration used to rename every generated `.nax/`
 * entry into the output dir. For an entry git still tracks, the next
 * auto-commit restores it, logs a per-file error, and leaves the destination
 * behind — so the run after that refuses with `MIGRATE_CONFLICT`, stranding
 * every other candidate. `partitionTrackedCandidates` splits the candidates so
 * both the startup helper and the `nax migrate` CLI move untracked content only.
 *
 * Every fixture is a real git repo built inside a `makeTempDir()` directory:
 * the feature's whole input is `git ls-files` output, so a stubbed git could
 * not prove anything about the `.nax/<name>` vs `.nax/<name>/` boundary, and
 * the repos are local and disposable (no network, no shared state).
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { gitSpawnEnv } from "@nathapp/nax-agent/internal";
import { assertDefined, cleanupTempDir, makeSpawn, makeTempDir } from "@test/helpers";
import {
  _gitDeps,
  autoMigrateGeneratedContent,
  detectGeneratedContent,
  type MigrateCandidate,
  migrateCommand,
  partitionTrackedCandidates,
} from "@/commands/migrate";
import { initLogger, resetLogger } from "@/logger";

// ─────────────────────────────────────────────────────────────────────────────
// Fixture paths — the two candidates every criterion is built from
// ─────────────────────────────────────────────────────────────────────────────

/** A generated candidate git HAS committed (the context manifest). */
const MANIFEST_REL = join(".nax", "features", "old", "stories", "US-001", "context-manifest-a.json");
/** The same path as `detectGeneratedContent` names it (relative to `.nax/`). */
const MANIFEST_NAME = join("features", "old", "stories", "US-001", "context-manifest-a.json");
/** A generated candidate git has NOT committed (`.nax/runs/`). */
const RUNS_REL = join(".nax", "runs", "r.json");
const RUNS_NAME = "runs";
const OUTPUT_DIR_NAME = "nax-out";

// ─────────────────────────────────────────────────────────────────────────────
// Fixture + git + log-capture helpers
// ─────────────────────────────────────────────────────────────────────────────

const tempDirs: string[] = [];
const decoder = new TextDecoder();

afterEach(() => {
  for (const dir of tempDirs.splice(0)) cleanupTempDir(dir);
});

function makeWorkdir(): string {
  const dir = makeTempDir("nax-migrate-tracked-");
  tempDirs.push(dir);
  return dir;
}

function git(dir: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["git", ...args], { cwd: dir, env: gitSpawnEnv() });
  return {
    code: proc.exitCode ?? -1,
    stdout: decoder.decode(proc.stdout),
    stderr: decoder.decode(proc.stderr),
  };
}

/** Make `dir` a git repo with an identity, so fixture commits can be made. */
function initRepo(dir: string): void {
  expect(git(dir, ["init", "-q"]).code).toBe(0);
  expect(git(dir, ["config", "user.email", "nax-test@example.com"]).code).toBe(0);
  expect(git(dir, ["config", "user.name", "nax test"]).code).toBe(0);
}

/** Write a fixture file (parent directories are created). */
async function writeFixture(dir: string, rel: string, content = "{}\n"): Promise<void> {
  await Bun.write(join(dir, rel), content);
}

/** Stage and commit exactly `rels`, leaving every other fixture path untracked. */
function commitPaths(dir: string, rels: string[]): void {
  const add = git(dir, ["add", "--", ...rels]);
  expect(add.code).toBe(0);
  const commit = git(dir, ["commit", "-qm", "fixture"]);
  expect(commit.code).toBe(0);
}

/** Candidate names alone — the assertions below are about classification. */
function names(candidates: readonly MigrateCandidate[]): string[] {
  return candidates.map((candidate) => candidate.name);
}

/** Names in a stable order, so an assertion never depends on readdir order. */
function sorted(values: readonly string[]): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

/** Paths git reports as deleted (in the index or the working tree). */
function deletedPaths(dir: string): string[] {
  const status = git(dir, ["status", "--porcelain"]);
  expect(status.code).toBe(0);
  return status.stdout
    .split("\n")
    .filter((line) => line.length >= 3 && line.slice(0, 2).includes("D"))
    .map((line) => line.slice(3));
}

interface CapturedLog {
  level: string;
  stage: string;
  message: string;
  data?: Record<string, unknown>;
}

/**
 * Run `fn` with the logger singleton re-initialised at `silent` and a sink
 * attached, so every entry the code under test emits is captured (and nothing
 * reaches the console or a file).
 */
async function captureLogs<T>(fn: () => Promise<T>): Promise<{ result: T; entries: CapturedLog[] }> {
  resetLogger();
  const logger = initLogger({ level: "silent" });
  const entries: CapturedLog[] = [];
  const unsubscribe = logger.addSink((entry) => {
    entries.push({ level: entry.level, stage: entry.stage, message: entry.message, data: entry.data });
  });
  try {
    return { result: await fn(), entries };
  } finally {
    unsubscribe();
    resetLogger();
  }
}

function atLevel(entries: readonly CapturedLog[], level: string, message: string): CapturedLog[] {
  return entries.filter((entry) => entry.level === level && entry.message === message);
}

/** `data[key]` read as a string array, without asserting past `unknown`. */
function stringArray(data: Record<string, unknown> | undefined, key: string): string[] {
  const value = data?.[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

// The exact operator-facing strings the story pins.
const SKIP_TRACKED_MSG = "Skipping git-tracked generated content under .nax/ — untrack it with git rm -r --cached";
const FOUND_GENERATED_MSG = "Found generated content under .nax/ — migrating to output dir";
const AUTO_MIGRATION_FAILED_MSG = "Auto-migration failed — continuing without migration";

// ─────────────────────────────────────────────────────────────────────────────
// partitionTrackedCandidates
// ─────────────────────────────────────────────────────────────────────────────

describe("US-003 partitionTrackedCandidates", () => {
  test("US-003 AC1: a committed candidate is tracked and an untracked one is migratable", async () => {
    const dir = makeWorkdir();
    initRepo(dir);
    await writeFixture(dir, MANIFEST_REL);
    await writeFixture(dir, RUNS_REL);
    commitPaths(dir, [MANIFEST_REL]);

    const candidates = await detectGeneratedContent(join(dir, ".nax"));
    expect(sorted(names(candidates))).toEqual(sorted([MANIFEST_NAME, RUNS_NAME]));

    const { migratable, tracked } = await partitionTrackedCandidates(dir, candidates);

    expect(names(tracked)).toEqual([MANIFEST_NAME]);
    expect(names(migratable)).toEqual([RUNS_NAME]);
    // The candidate is handed back — same object, with the srcPath the caller moves.
    const manifestCandidate = candidates.find((candidate) => candidate.name === MANIFEST_NAME);
    assertDefined(manifestCandidate, "manifest candidate");
    expect(tracked[0]).toBe(manifestCandidate);
    expect(tracked[0]?.srcPath).toBe(join(dir, MANIFEST_REL));
  });

  test("US-003 AC2: a candidate directory is tracked when a committed file lies inside it", async () => {
    const dir = makeWorkdir();
    initRepo(dir);
    const committedRel = join(".nax", "features", "f", "runs", "r.json");
    await writeFixture(dir, committedRel);
    commitPaths(dir, [committedRel]);

    const candidates = await detectGeneratedContent(join(dir, ".nax"));
    const directoryCandidate = join("features", "f", "runs");
    expect(names(candidates)).toEqual([directoryCandidate]);

    const { migratable, tracked } = await partitionTrackedCandidates(dir, candidates);

    expect(names(tracked)).toEqual([directoryCandidate]);
    expect(migratable).toEqual([]);
  });

  test("US-003 AC3: a tracked sibling sharing the prefix does not mark the candidate tracked", async () => {
    const dir = makeWorkdir();
    initRepo(dir);
    const siblingRel = join(".nax", "runs-archive", "x.json");
    await writeFixture(dir, siblingRel);
    await writeFixture(dir, RUNS_REL);
    commitPaths(dir, [siblingRel]);

    const candidates = await detectGeneratedContent(join(dir, ".nax"));
    expect(names(candidates)).toEqual([RUNS_NAME]);

    const { migratable, tracked } = await partitionTrackedCandidates(dir, candidates);

    // `.nax/runs-archive/x.json` must not be read as living under `.nax/runs/`.
    expect(tracked).toEqual([]);
    expect(names(migratable)).toEqual([RUNS_NAME]);
    expect(migratable[0]).toBe(candidates[0]);
  });

  test("US-003 regression: a tracked file under one feature does not block an untracked sibling under a different feature", async () => {
    // Adversarial-review regression: a prior implementation partitioned by
    // the candidate's first path segment, so a tracked manifest under
    // `.nax/features/f/stories/...` caused any candidate whose name started
    // with `features/` to be marked tracked — including an untracked
    // `.nax/features/g/runs/` candidate that nothing had committed.
    const dir = makeWorkdir();
    initRepo(dir);
    const trackedManifestRel = join(".nax", "features", "f", "stories", "US-001", "context-manifest-a.json");
    const untrackedRunsRel = join(".nax", "features", "g", "runs", "r.json");
    await writeFixture(dir, trackedManifestRel);
    await writeFixture(dir, untrackedRunsRel);
    commitPaths(dir, [trackedManifestRel]);

    const candidates = await detectGeneratedContent(join(dir, ".nax"));
    const manifestName = join("features", "f", "stories", "US-001", "context-manifest-a.json");
    const runsName = join("features", "g", "runs");
    expect(sorted(names(candidates))).toEqual(sorted([manifestName, runsName]));

    const { migratable, tracked } = await partitionTrackedCandidates(dir, candidates);

    expect(names(tracked)).toEqual([manifestName]);
    expect(names(migratable)).toEqual([runsName]);
  });

  test("US-003 AC4: a workdir that is not a git repo leaves every candidate migratable", async () => {
    const dir = makeWorkdir(); // deliberately never `git init`-ed
    await writeFixture(dir, RUNS_REL);
    await writeFixture(dir, join(".nax", "metrics.json"));

    const candidates = await detectGeneratedContent(join(dir, ".nax"));
    expect(sorted(names(candidates))).toEqual(sorted(["metrics.json", RUNS_NAME]));

    const { migratable, tracked } = await partitionTrackedCandidates(dir, candidates);

    expect(tracked).toEqual([]);
    expect(sorted(names(migratable))).toEqual(sorted(["metrics.json", RUNS_NAME]));
  });

  test("US-003 AC13: the partition makes exactly one git call, and it lists files", async () => {
    const dir = makeWorkdir();
    initRepo(dir);
    const committedRels = [RUNS_REL, join(".nax", "metrics.json"), join(".nax", "features", "f", "runs", "r.json")];
    for (const rel of committedRels) await writeFixture(dir, rel);
    commitPaths(dir, committedRels);

    const candidates = await detectGeneratedContent(join(dir, ".nax"));
    expect(candidates).toHaveLength(3);

    // A spy that delegates to the real spawn: the call is real git, only
    // observed. `_gitDeps` is the shared git seam `gitWithTimeout` spawns
    // through, re-exported from this module.
    const spy = spyOn(_gitDeps, "spawn");
    let calls: unknown[][];
    try {
      await partitionTrackedCandidates(dir, candidates);
      calls = spy.mock.calls;
    } finally {
      spy.mockRestore();
    }

    expect(calls).toHaveLength(1);
    const call = calls[0];
    assertDefined(call, "the single git spawn");
    expect(call[0]).toContain("ls-files");
  });

  test("US-003 regression: tracked-prefix match works when candidate.name uses the platform separator (Windows backslashes)", async () => {
    // Adversarial-review regression: a prior implementation built the
    // comparison target from `candidate.name` directly, but `candidate.name`
    // comes from `path.join()` and on Windows uses backslashes, while
    // `git ls-files -z` always emits POSIX-style paths with forward slashes.
    // A tracked `.nax/features/f/...` candidate whose name contained
    // backslashes would never match the listed path and so be misclassified
    // as migratable.
    //
    // Mock `_gitDeps.spawn` so the test runs identically on every platform —
    // no real git repo, no real git binary — and feed candidates whose `name`
    // mirrors what `path.join` produces on win32.
    const stdout = ".nax/features/f/stories/US-001/context-manifest-a.json\u0000";
    const origSpawn = _gitDeps.spawn;
    const stub = makeSpawn(({ cmd }) => (cmd.includes("ls-files") ? stdout : ""));
    _gitDeps.spawn = stub.spawn;
    try {
      const candidates: MigrateCandidate[] = [
        // Simulates what detectGeneratedContent returns on Windows: names
        // built with `path.join`, which yields backslashes on win32.
        {
          name: "features\\f\\stories\\US-001\\context-manifest-a.json",
          srcPath: "/x/.nax/features/f/stories/US-001/context-manifest-a.json",
        },
        // Untracked sibling under a different feature — must NOT be marked
        // tracked just because they share the top-level `features` segment.
        { name: "features\\g\\runs", srcPath: "/x/.nax/features/g/runs" },
      ];

      const { migratable, tracked } = await partitionTrackedCandidates("/anywhere", candidates);

      expect(names(tracked)).toEqual(["features\\f\\stories\\US-001\\context-manifest-a.json"]);
      expect(names(migratable)).toEqual(["features\\g\\runs"]);
    } finally {
      _gitDeps.spawn = origSpawn;
    }
  });

  test("US-003 regression: a non-zero git ls-files exit is logged at debug (not silently swallowed)", async () => {
    // Adversarial-review regression: the previous implementation returned
    // every candidate as migratable on a non-zero exit without logging
    // anything, while the thrown-error branch DID log at debug. That
    // asymmetry hid why tracked-file detection fell back — the same
    // fallback, but no breadcrumb. The fix unifies the two branches: a
    // non-zero exit now also logs `debug` with `exitCode` and `stderr`.
    const origSpawn = _gitDeps.spawn;
    // Simulate "not a git repo" — `ls-files` exits 128 with the canonical
    // fatal-on-stderr message.
    const stub = makeSpawn(({ cmd }) =>
      cmd.includes("ls-files") ? { stdout: "", stderr: "fatal: not a git repository", exitCode: 128 } : "",
    );
    _gitDeps.spawn = stub.spawn;
    try {
      const candidates: MigrateCandidate[] = [
        { name: "runs", srcPath: "/x/.nax/runs" },
        { name: "metrics.json", srcPath: "/x/.nax/metrics.json" },
      ];

      const { entries, result } = await captureLogs(() => partitionTrackedCandidates("/anywhere", candidates));

      // All candidates migratable, none tracked — the documented fallback.
      expect(result.migratable).toHaveLength(2);
      expect(result.tracked).toEqual([]);

      // …and the debug log that proves WHY the fallback fired. Same shape
      // as the thrown-error branch, so an operator gets one breadcrumb per
      // git failure, not "silent" on one path and "loud" on the other.
      const debugs = entries.filter((entry) => entry.level === "debug" && entry.message.includes("non-zero"));
      expect(debugs).toHaveLength(1);
      expect(debugs[0]?.data?.exitCode).toBe(128);
      expect(debugs[0]?.data?.stderr).toContain("not a git repository");
    } finally {
      _gitDeps.spawn = origSpawn;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// autoMigrateGeneratedContent
// ─────────────────────────────────────────────────────────────────────────────

interface AutoMigrateFixture {
  readonly dir: string;
  readonly outputDir: string;
  readonly manifestAbsPath: string;
  readonly runsAbsPath: string;
}

/**
 * A temp git repo holding one committed generated candidate (the context
 * manifest) and one untracked one (`.nax/runs/`), plus a `.nax/config.json`
 * whose `outputDir` points inside the temp dir so no fixture can escape into
 * the real `~/.nax`.
 */
async function makeAutoMigrateFixture(): Promise<AutoMigrateFixture> {
  const dir = makeWorkdir();
  initRepo(dir);
  const outputDir = join(dir, OUTPUT_DIR_NAME);
  await writeFixture(dir, join(".nax", "config.json"), JSON.stringify({ name: "migrate-fixture", outputDir }));
  await writeFixture(dir, MANIFEST_REL);
  await writeFixture(dir, RUNS_REL);
  commitPaths(dir, [MANIFEST_REL]);
  return { dir, outputDir, manifestAbsPath: join(dir, MANIFEST_REL), runsAbsPath: join(dir, RUNS_REL) };
}

describe("US-003 autoMigrateGeneratedContent", () => {
  test("US-003 AC5: the untracked entry is moved and the committed one stays put", async () => {
    const fixture = await makeAutoMigrateFixture();

    await autoMigrateGeneratedContent(fixture.dir);

    expect(existsSync(join(fixture.outputDir, RUNS_NAME, "r.json"))).toBe(true);
    expect(existsSync(join(fixture.dir, ".nax", RUNS_NAME))).toBe(false);
    expect(existsSync(fixture.manifestAbsPath)).toBe(true);
  });

  test("US-003 AC6: the tracked candidate is reported once, with the git rm fix", async () => {
    const fixture = await makeAutoMigrateFixture();

    const { entries } = await captureLogs(() => autoMigrateGeneratedContent(fixture.dir));

    const warns = atLevel(entries, "warn", SKIP_TRACKED_MSG);
    expect(warns).toHaveLength(1);
    const data = warns[0]?.data;
    assertDefined(data, "the skipped-tracked-content warn data");
    // storyId leads the data object — the log correlator reads the first key.
    expect(Object.keys(data)[0]).toBe("storyId");
    expect(data.storyId).toBe("_setup");
    expect(data.count).toBe(1);
    expect(data.paths).toEqual([MANIFEST_REL]);
    expect(data.fix).toBe(`git rm -r --cached ${MANIFEST_REL}`);
  });

  test("US-003 AC7: a second run reports no migration failure and leaves the tracked file alone", async () => {
    const fixture = await makeAutoMigrateFixture();

    const first = await captureLogs(() => autoMigrateGeneratedContent(fixture.dir));
    // The first run moved the untracked candidate, so the second run has only
    // the tracked one left — which is exactly the state that used to abort.
    expect(atLevel(first.entries, "info", FOUND_GENERATED_MSG)).toHaveLength(1);
    expect(existsSync(join(fixture.outputDir, RUNS_NAME, "r.json"))).toBe(true);

    const second = await captureLogs(() => autoMigrateGeneratedContent(fixture.dir));

    expect(atLevel(second.entries, "warn", AUTO_MIGRATION_FAILED_MSG)).toEqual([]);
    // …and the tracked candidate is still detected and skipped, not silently ignored.
    expect(atLevel(second.entries, "warn", SKIP_TRACKED_MSG)).toHaveLength(1);
    expect(existsSync(fixture.manifestAbsPath)).toBe(true);
  });

  test("US-003 AC8: when every candidate is committed nothing is migrated and nothing is deleted", async () => {
    const dir = makeWorkdir();
    initRepo(dir);
    await writeFixture(
      dir,
      join(".nax", "config.json"),
      JSON.stringify({ name: "migrate-fixture", outputDir: join(dir, OUTPUT_DIR_NAME) }),
    );
    const committedRels = [RUNS_REL, join(".nax", "metrics.json"), MANIFEST_REL];
    for (const rel of committedRels) await writeFixture(dir, rel);
    commitPaths(dir, committedRels);

    const { entries } = await captureLogs(() => autoMigrateGeneratedContent(dir));

    expect(atLevel(entries, "info", FOUND_GENERATED_MSG)).toEqual([]);
    // Every candidate is recognised as tracked — that is why nothing moved, and
    // so why nothing has to be restored afterwards.
    const warns = atLevel(entries, "warn", SKIP_TRACKED_MSG);
    expect(warns).toHaveLength(1);
    expect(warns[0]?.data?.count).toBe(3);
    expect(deletedPaths(dir)).toEqual([]);
    for (const rel of committedRels) expect(existsSync(join(dir, rel))).toBe(true);
    expect(existsSync(join(dir, OUTPUT_DIR_NAME))).toBe(false);
  });

  test("US-003 AC9: seven tracked candidates warn with count 7 and only five paths", async () => {
    const dir = makeWorkdir();
    initRepo(dir);
    const committedRels = [
      join(".nax", "runs", "r.json"),
      join(".nax", "metrics.json"),
      join(".nax", "prompt-audit", "a.json"),
      join(".nax", "review-audit", "a.json"),
      join(".nax", "cost", "a.json"),
      join(".nax", "cycle-shadow", "a.json"),
      join(".nax", "curator", "a.json"),
    ];
    for (const rel of committedRels) await writeFixture(dir, rel);
    commitPaths(dir, committedRels);

    const candidates = await detectGeneratedContent(join(dir, ".nax"));
    expect(candidates).toHaveLength(7);
    expect((await partitionTrackedCandidates(dir, candidates)).tracked).toHaveLength(7);

    const { entries } = await captureLogs(() => autoMigrateGeneratedContent(dir));

    const warn = entries.find((entry) => entry.level === "warn" && entry.message === SKIP_TRACKED_MSG);
    assertDefined(warn, "the skipped-tracked-content warn");
    expect(warn.data?.count).toBe(7);
    const paths = stringArray(warn.data, "paths");
    expect(paths).toHaveLength(5);
    for (const relative of paths) expect(relative.startsWith(".nax/")).toBe(true);
    expect(warn.data?.fix).toBe(`git rm -r --cached ${paths[0]}`);
  });

  test("US-003 AC10: a migration that cannot run resolves and is reported as a warn", async () => {
    const dir = makeWorkdir();
    initRepo(dir);
    await writeFixture(dir, RUNS_REL); // untracked; no .nax/config.json at all

    const { result, entries } = await captureLogs(() =>
      autoMigrateGeneratedContent(dir).then(
        () => "resolved",
        () => "rejected",
      ),
    );

    expect(result).toBe("resolved");
    expect(atLevel(entries, "warn", AUTO_MIGRATION_FAILED_MSG)).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// migrateCommand — the CLI path shares the same partition
// ─────────────────────────────────────────────────────────────────────────────

describe("US-003 migrateCommand", () => {
  test("US-003 AC11: only the untracked candidate is moved", async () => {
    const fixture = await makeAutoMigrateFixture();

    const { entries } = await captureLogs(() => migrateCommand({ workdir: fixture.dir }));

    expect(existsSync(join(fixture.outputDir, RUNS_NAME, "r.json"))).toBe(true);
    expect(existsSync(join(fixture.dir, ".nax", RUNS_NAME))).toBe(false);
    expect(existsSync(fixture.manifestAbsPath)).toBe(true);
    expect(existsSync(join(fixture.outputDir, "features"))).toBe(false);
    // The skipped candidate is still surfaced on the CLI path.
    expect(
      entries.some(
        (entry) =>
          entry.level === "info" && (entry.message.includes(MANIFEST_NAME) || entry.message.includes(MANIFEST_REL)),
      ),
    ).toBe(true);
  });

  test("US-003 AC12: dry-run skips the tracked candidate and would move only the untracked one", async () => {
    const fixture = await makeAutoMigrateFixture();

    const { entries } = await captureLogs(() => migrateCommand({ workdir: fixture.dir, dryRun: true }));

    const skips = entries.filter((entry) => entry.message.startsWith("[dry-run] Skip (git-tracked)"));
    expect(skips).toHaveLength(1);
    // The skip line names the candidate relative to the workdir — an absolute
    // srcPath would not be actionable in the operator's shell.
    expect(skips[0]?.message).toContain(`[dry-run] Skip (git-tracked): ${join(".nax", MANIFEST_NAME)}`);

    const moves = entries.filter((entry) => entry.message.includes("[dry-run] Would move"));
    expect(moves).toHaveLength(1);
    expect(moves[0]?.message).toContain(join(".nax", RUNS_NAME));
    expect(moves[0]?.message).not.toContain(MANIFEST_REL);

    expect(existsSync(fixture.manifestAbsPath)).toBe(true);
    expect(existsSync(fixture.runsAbsPath)).toBe(true);
    expect(existsSync(fixture.outputDir)).toBe(false);
  });
});
