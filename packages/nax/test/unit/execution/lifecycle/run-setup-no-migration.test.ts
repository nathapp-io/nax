/**
 * run-setup.ts — US-001: a run setup no longer migrates in-repo `.nax/` content.
 *
 * The startup auto-migration renamed every generated `.nax/` entry into the
 * output dir — including paths current nax writes and reads
 * (`features/<f>/sessions/`, `features/<f>/status.json`, every per-story
 * `context-manifest-*.json`) — and it refused the *next* run with
 * `MIGRATE_CONFLICT` as soon as a destination already existed. This file pins
 * the replacing invariant: `setupRun` moves nothing, so the artifacts keep
 * their path and their contents, the run's output dir gains only the feature
 * lock, and no migration entry reaches the log.
 *
 * `captureLogs` is copied from
 * test/integration/commands/migrate-tracked-candidates.test.ts, which US-003
 * deletes; this file is where its log-capture coverage survives.
 *
 * Split out of run-setup.test.ts alongside run-setup-auto-migrate.test.ts's
 * former territory (the seam it pinned is gone) and run-setup-locks.test.ts,
 * which use the same harness shape.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  cleanupTempDir,
  makeMockRuntime,
  makeNaxConfig,
  makePRD,
  makeStory,
  makeTempDir,
  withDepsRestore,
} from "@test/helpers";
import { releaseFeatureLock } from "@/execution/feature-lock";
import { releaseLock } from "@/execution/helpers";
import { _runSetupDeps, type RunSetupOptions, setupRun } from "@/execution/lifecycle/run-setup";
import { initLogger, resetLogger } from "@/logger";

const tempDirs: string[] = [];

// Restore every `_runSetupDeps` entry the harness below replaces.
withDepsRestore(_runSetupDeps);

afterEach(() => {
  for (const dir of tempDirs.splice(0)) cleanupTempDir(dir);
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixture — the three generated artifacts the removed call used to move
// ─────────────────────────────────────────────────────────────────────────────

const FEATURE = "demo";
const OUTPUT_DIR_NAME = "nax-out";
const RUN_ID = "run-no-migration-setup";

/** A live session transcript, as `.nax/features/<f>/sessions/` holds. */
const SESSIONS_REL = join(".nax", "features", FEATURE, "sessions", "s1.json");
/** The feature status file. */
const STATUS_REL = join(".nax", "features", FEATURE, "status.json");
/** A per-story context manifest. */
const MANIFEST_REL = join(".nax", "features", FEATURE, "stories", "US-001", "context-manifest-a.json");

/**
 * Contents are distinct per file so an assertion on one cannot be satisfied by
 * another, and none of them is a path nax writes during setup (the run's own
 * status file lives at the workdir root below), so "original contents" is a
 * real claim rather than "whatever the run just wrote".
 */
const IN_REPO_ARTIFACTS: ReadonlyArray<{ readonly rel: string; readonly content: string }> = [
  { rel: SESSIONS_REL, content: `${JSON.stringify({ sessionId: "s1", turns: 2 })}\n` },
  { rel: STATUS_REL, content: `${JSON.stringify({ currentStory: "US-001", status: "passed" })}\n` },
  { rel: MANIFEST_REL, content: `${JSON.stringify({ storyId: "US-001", tokens: 42 })}\n` },
];

/** (Re)write every in-repo artifact — parent directories are created. */
async function writeInRepoArtifacts(workdir: string): Promise<void> {
  for (const artifact of IN_REPO_ARTIFACTS) {
    await Bun.write(join(workdir, artifact.rel), artifact.content);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Log capture — copied from migrate-tracked-candidates.test.ts (see header)
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

interface NoMigrationHarness {
  readonly options: RunSetupOptions;
  readonly workdir: string;
  readonly outputDir: string;
  /** Release both locks the call took — a real run holds them until it ends. */
  releaseLocks: () => Promise<void>;
}

/**
 * A temp project holding the three in-repo artifacts, plus `.nax/config.json`
 * whose `outputDir` is the directory the run itself uses. Every heavy seam
 * `setupRun` needs is stubbed, and the PRD holds one already-`passed` story, so
 * a call runs to completion without touching the network or the PATH.
 *
 * `_runSetupDeps.createRuntime` builds a fresh mock runtime per call (a second
 * run is a second runtime in production too) with `outputDir` pinned to
 * `nax-out/` inside the workdir, so nothing can escape into the real `~/.nax`.
 */
async function installHarness(): Promise<NoMigrationHarness> {
  const workdir = makeTempDir("nax-runsetup-nomigration-");
  tempDirs.push(workdir);
  const outputDir = join(workdir, OUTPUT_DIR_NAME);

  const prdPath = join(workdir, "prd.json");
  await Bun.write(
    prdPath,
    JSON.stringify(
      makePRD({
        feature: FEATURE,
        userStories: [makeStory({ id: "US-001", status: "passed", passes: true, workdir: "packages/app" })],
      }),
      null,
      2,
    ),
  );

  // The project's configured outputDir resolves to the directory this run
  // writes under — the arrangement that let the old auto-migration move the
  // artifacts below straight into the run's own output tree on the first call.
  await Bun.write(join(workdir, ".nax", "config.json"), JSON.stringify({ name: FEATURE, outputDir }, null, 2));
  await writeInRepoArtifacts(workdir);

  _runSetupDeps.createRuntime = () => {
    const runtime = makeMockRuntime({ workdir });
    Object.defineProperty(runtime, "outputDir", { value: outputDir, writable: false, configurable: true });
    return runtime;
  };
  _runSetupDeps.detectProjectProfile = async () => ({ language: "typescript" });
  // No real signal handlers: setupRun only needs a cleanup function back.
  _runSetupDeps.installCrashHandlers = () => () => {};
  _runSetupDeps.buildApprovalsSeal = async () => async () => {};

  return {
    workdir,
    outputDir,
    options: {
      prdPath,
      workdir,
      // Acceptance enabled would make the run reach for the default agent
      // binary (`which`), which is unrelated to this story and flaky.
      config: makeNaxConfig({ acceptance: { enabled: false } }),
      hooks: { hooks: {} },
      feature: FEATURE,
      dryRun: false,
      statusFile: join(workdir, "status.json"),
      runId: RUN_ID,
      startedAt: new Date().toISOString(),
      startTime: Date.now(),
      skipPrecheck: true,
      headless: true,
      formatterMode: "quiet",
      getTotalCost: () => 0,
      getIterations: () => 0,
      getStoriesCompleted: () => 0,
      getTotalStories: () => 0,
    },
    // Reverse of acquisition: the feature lock (outputDir-scoped) first, then
    // the checkout lock (workdir-scoped).
    releaseLocks: async () => {
      await releaseFeatureLock({ outputDir, feature: FEATURE, runId: RUN_ID });
      await releaseLock(workdir);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// US-001 AC-1 … AC-4
// ─────────────────────────────────────────────────────────────────────────────

describe("setupRun — US-001: no auto-migration at run setup", () => {
  test("US-001 AC-1: the three in-repo feature artifacts keep their path and contents", async () => {
    const harness = await installHarness();

    const result = await setupRun(harness.options);
    try {
      for (const artifact of IN_REPO_ARTIFACTS) {
        const absolute = join(harness.workdir, artifact.rel);
        expect(existsSync(absolute)).toBe(true);
        expect(await Bun.file(absolute).text()).toBe(artifact.content);
      }
    } finally {
      result.cleanupCrashHandlers();
      await harness.releaseLocks();
    }
  });

  test("US-001 AC-2: the output dir's feature folder holds only the feature lock", async () => {
    const harness = await installHarness();

    const result = await setupRun(harness.options);
    try {
      const featureOutputDir = join(harness.outputDir, "features", FEATURE);
      expect(existsSync(join(featureOutputDir, "nax.lock"))).toBe(true);
      expect((await readdir(featureOutputDir)).sort()).toEqual(["nax.lock"]);
    } finally {
      result.cleanupCrashHandlers();
      await harness.releaseLocks();
    }
  });

  test("US-001 AC-3: the run records no auto-migration log entry", async () => {
    const harness = await installHarness();

    const { result, entries } = await captureLogs(() => setupRun(harness.options));
    try {
      // The sink is live: a capture that saw nothing would make the assertion
      // below vacuous rather than passing.
      expect(entries.length).toBeGreaterThan(0);
      const migrationEntries = entries.filter(
        (entry) => entry.message.startsWith("Auto-migration") || entry.message.startsWith("Found generated content"),
      );
      expect(migrationEntries).toEqual([]);
    } finally {
      result.cleanupCrashHandlers();
      await harness.releaseLocks();
    }
  });

  test("US-001 AC-4: a second run after both locks are released reports no migration conflict", async () => {
    const harness = await installHarness();

    const first = await captureLogs(() => setupRun(harness.options));
    first.result.cleanupCrashHandlers();
    await harness.releaseLocks();

    // The artifacts are re-written before the second call. The invariant this
    // story installs is that the FIRST call never moved them, so this write is
    // a no-op on files that are already there; under the old auto-migration it
    // restores what the first call deleted, which is what arms the conflict.
    await writeInRepoArtifacts(harness.workdir);

    const second = await captureLogs(() => setupRun(harness.options));
    try {
      expect(second.entries.length).toBeGreaterThan(0);
      const conflicts = second.entries.filter(
        (entry) =>
          entry.level === "warn" &&
          (entry.message.includes("Migration conflict") ||
            String(entry.data?.error ?? "").includes("Migration conflict")),
      );
      expect(conflicts).toEqual([]);
      // The second run moved nothing either — the same three artifacts are
      // still at their original paths.
      for (const artifact of IN_REPO_ARTIFACTS) {
        expect(existsSync(join(harness.workdir, artifact.rel))).toBe(true);
      }
    } finally {
      second.result.cleanupCrashHandlers();
      await harness.releaseLocks();
    }
  });
});
