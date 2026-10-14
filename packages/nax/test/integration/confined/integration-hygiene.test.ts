/**
 * nax's repaired integration suites, run inside the confined sandbox (nax#2523).
 *
 * Each case drives the real runner CLI over the files this story repaired, so a
 * regression in nax's test temp hygiene fails here exactly as it fails in a
 * confined agent session. The paths are the AC's own groups: one confined
 * `bun test` process per group, 5 s per test, as `test:confined` runs it.
 *
 * Skipped when this host has no usable sandbox, and inside a confined run — a
 * sandbox launch inside a sandbox does not work (spec: out of scope), and a
 * skipped case is the honest answer there rather than a red one. The skip check
 * asks `isConfinedTestRun()` FIRST, so a confined invocation spawns neither the
 * child suites nor the runner's `--probe`; AC-13 pins that with a spawn
 * recorder rather than trusting the source order.
 *
 * These cases read the runner's EXIT CODE, not its output: the confined `bun
 * test` prints its per-file lines to stderr, which the runner inherits into this
 * test's own log on purpose.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  CONFINED_TEST_ENV,
  confinedSandboxAvailable,
  isConfinedTestRun,
  runConfinedFiles,
  withTempDir,
} from "@test/helpers";

/** This package's directory: the frame the AC-13 child runs in. */
const PACKAGE_DIR = resolve(import.meta.dir, "../../..");

/** This file, as the runner and the AC-13 child address it. */
const HYGIENE_FILE = "./test/integration/confined/integration-hygiene.test.ts";

/** The env var the AC-13 recorder writes its log to. */
const SPAWN_LOG_ENV = "NAX_HYGIENE_SPAWN_LOG";

/** A confined group runs a whole `bun test` process inside a sandbox launch. */
const GROUP_TIMEOUT_MS = 300_000;

/** The AC-13 child loads one test file and skips every case in it. */
const CHILD_RUN_TIMEOUT_MS = 120_000;

interface ConfinedGroup {
  readonly ac: string;
  readonly what: string;
  readonly paths: readonly string[];
}

/** One entry per AC, in the order the story lists them. */
const REPAIRED_GROUPS: readonly ConfinedGroup[] = [
  {
    ac: "AC-1",
    what: "the execution runner suite (class A: its literal /tmp temp dirs)",
    paths: ["./test/integration/execution/execution.test.ts"],
  },
  {
    ac: "AC-2",
    what: "the parallel-metrics suites (class B: their PRD fixture write)",
    paths: [
      "./test/integration/execution/runner-parallel-metrics.test.ts",
      "./test/integration/execution/runner-parallel-metrics-rectification-events.test.ts",
    ],
  },
  {
    ac: "AC-3",
    what: "the runner-fixes suite (class A: its PRD temp dir)",
    paths: ["./test/integration/execution/runner-fixes.test.ts"],
  },
  {
    ac: "AC-4",
    what: "the checkpoint reader suite (class A: its temp dir)",
    paths: ["./test/integration/execution/checkpoint/reader.test.ts"],
  },
  {
    ac: "AC-5",
    what: "the progress suite (class A: its temp dirs)",
    paths: ["./test/integration/execution/progress.test.ts"],
  },
  {
    ac: "AC-6",
    what: "the plan and analyze-scanner suites (class A: their fixture dirs)",
    paths: ["./test/integration/plan/plan.test.ts", "./test/integration/plan/analyze-scanner.test.ts"],
  },
  {
    ac: "AC-7",
    what: "the context-integration suite (class A: its temp dir)",
    paths: ["./test/integration/context/context-integration.test.ts"],
  },
  {
    ac: "AC-8",
    what: "the loader-security suite (class A: its plugin fixture roots)",
    paths: ["./test/integration/config/security-loader.test.ts"],
  },
  {
    ac: "AC-9",
    what: "the story-orchestrator suites (class A: their greenfield temp dirs)",
    paths: [
      "./test/integration/tdd/story-orchestrator-core.test.ts",
      "./test/integration/tdd/story-orchestrator-failureCategory.test.ts",
      "./test/integration/tdd/story-orchestrator-fallback.test.ts",
    ],
  },
  {
    ac: "AC-10",
    what: "the interaction-chain and worktree-manager suites (class B: their PRD fixture writes)",
    paths: [
      "./test/integration/interaction/interaction-chain-pipeline.test.ts",
      "./test/integration/worktree/manager.test.ts",
    ],
  },
  {
    ac: "AC-11",
    what: "the bash deny suite (class C: it launches a sandbox, so it nests)",
    paths: ["./test/integration/permissions/bash-deny-suite.test.ts"],
  },
  {
    ac: "AC-12",
    what: "the run temp-root wipe suite (class C: it asserts the shared /tmp/nax parent)",
    paths: ["./test/integration/execution/lifecycle/run-tmp-wipe.test.ts"],
  },
];

/**
 * The preload the AC-13 child runs with: it records every argv the child asks
 * `Bun.spawn` for, so "a confined invocation launches no confined-runner
 * subprocess" is evidence from a real child process rather than an assertion
 * about this file's source order. Written into a temp dir at run time, so it is
 * never a stray file in `test/`.
 */
const SPAWN_RECORDER = `import { appendFileSync, writeFileSync } from "node:fs";

const logPath = process.env.${SPAWN_LOG_ENV};
if (logPath !== undefined) {
  writeFileSync(logPath, "recorder-ready\\n");
  const record = (label, argv) => appendFileSync(logPath, label + " " + JSON.stringify(argv) + "\\n");
  const spawn = Bun.spawn;
  Bun.spawn = (...args) => {
    record("spawn", args[0]);
    return spawn(...args);
  };
}
`;

/** The recorder's own proof of life: without it an empty log asserts nothing. */
const RECORDER_READY = "recorder-ready";

/** What a spawn of the confined runner looks like in the recorded argv. */
const RUNNER_NEEDLE = "run-confined-tests";

const unavailable = isConfinedTestRun() || !(await confinedSandboxAvailable());

describe.skipIf(unavailable)("nax integration suites under confinement", () => {
  for (const group of REPAIRED_GROUPS) {
    test(
      `${group.ac}: ${group.what} passes confined`,
      async () => {
        expect(await runConfinedFiles(group.paths)).toBe(0);
      },
      GROUP_TIMEOUT_MS,
    );
  }

  test(
    "AC-13: a confined invocation launches no confined-runner subprocess, not even a --probe",
    async () => {
      await withTempDir(async (dir) => {
        const preloadPath = join(dir, "record-spawns.ts");
        const logPath = join(dir, "spawns.log");
        await Bun.write(preloadPath, SPAWN_RECORDER);

        const proc = Bun.spawn(["bun", "test", "--preload", preloadPath, HYGIENE_FILE], {
          cwd: PACKAGE_DIR,
          env: { ...process.env, [CONFINED_TEST_ENV]: "1", [SPAWN_LOG_ENV]: logPath },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [exitCode, stdout, stderr] = await Promise.all([
          proc.exited,
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);

        const recorded = existsSync(logPath) ? await Bun.file(logPath).text() : "";
        const runnerSpawns = recorded.split("\n").filter((line) => line.includes(RUNNER_NEEDLE));

        expect(recorded).toContain(RECORDER_READY);
        expect(runnerSpawns).toEqual([]);
        expect({ exitCode, tail: `${stdout}${stderr}`.slice(-2000) }).toMatchObject({ exitCode: 0 });
      });
    },
    CHILD_RUN_TIMEOUT_MS,
  );
});
