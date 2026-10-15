/**
 * nax's repaired unit suites, run inside the confined sandbox (nax#2523).
 *
 * Each case drives the real runner CLI over the files this story repaired, so
 * a regression in nax's test temp hygiene fails here exactly as it fails in a
 * confined agent session. The paths are the AC's own groups: one confined
 * `bun test` process per group, 5 s per test, as `test:confined` runs it.
 *
 * Skipped when this host has no usable sandbox, and inside a confined run — a
 * sandbox launch inside a sandbox does not work (spec: out of scope), and a
 * skipped case is the honest answer there rather than a red one. The skip
 * check asks `isConfinedTestRun()` first so a confined run never even spawns
 * the probe.
 *
 * These cases read the runner's EXIT CODE, not its output: the confined `bun
 * test` prints its per-file lines to stderr, which the runner inherits into
 * this test's own log on purpose.
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { confinedSandboxAvailable, isConfinedTestRun, runConfinedFiles, USAGE_EXIT } from "@test/helpers";

const PACKAGE_DIR = resolve(import.meta.dir, "../../..");
const RUNNER = resolve(import.meta.dir, "../../../../nax-agent/scripts/run-confined-tests.ts");

/** A confined group runs a whole `bun test` process inside a sandbox launch. */
const GROUP_TIMEOUT_MS = 300_000;

interface ConfinedGroup {
  readonly ac: string;
  readonly what: string;
  readonly paths: readonly string[];
}

/** One entry per AC, in the order the story lists them. */
const REPAIRED_GROUPS: readonly ConfinedGroup[] = [
  {
    ac: "AC-5",
    what: "the pid registry suite (class A: its temp dir)",
    paths: ["./test/unit/execution/pid-registry.test.ts"],
  },
  {
    ac: "AC-6",
    what: "the run-metrics suite (class A: its temp dir)",
    paths: ["./test/unit/metrics/save-run-metrics.test.ts"],
  },
  {
    ac: "AC-7",
    what: "the TUI queue writer and the queue file lock (class A: their lock files)",
    paths: ["./test/unit/ui/tui-controls.test.ts", "./test/unit/utils/queue-file-lock.test.ts"],
  },
  {
    ac: "AC-8",
    what: "the bakeoff coordinator, preflight and report suites (class A: their output dirs)",
    paths: [
      "./test/unit/bakeoff/coordinator.test.ts",
      "./test/unit/bakeoff/preflight.test.ts",
      "./test/unit/bakeoff/report.test.ts",
    ],
  },
  {
    ac: "AC-9",
    what: "the pipeline result handler suites (class B: their PRD fixture writes)",
    paths: [
      "./test/unit/execution/pipeline-result-handler.test.ts",
      "./test/unit/execution/pipeline-result-handler-bug12.test.ts",
      "./test/unit/execution/pipeline-result-handler-worktree-cleanup.test.ts",
    ],
  },
  {
    ac: "AC-10",
    what: "the unified executor suites (class B: their PRD fixture writes)",
    paths: [
      "./test/unit/execution/unified-executor-cost.test.ts",
      "./test/unit/execution/unified-executor-dispatch.test.ts",
      "./test/unit/execution/unified-executor-failure.test.ts",
      "./test/unit/execution/unified-executor-fallback-seam.test.ts",
      "./test/unit/execution/unified-executor-results.test.ts",
    ],
  },
  {
    ac: "AC-11",
    what: "the tier-escalation retry cap and structured-failure suites (class B: their PRD fixture writes)",
    paths: [
      "./test/unit/execution/escalation/tier-escalation-retry-cap.test.ts",
      "./test/unit/execution/structured-failure.test.ts",
    ],
  },
  {
    ac: "AC-12",
    what: "the acceptance setup gate suite (class B: its workdir fixture)",
    paths: ["./test/unit/pipeline/stages/acceptance-setup-gate.test.ts"],
  },
  {
    ac: "AC-13",
    what: "the coding-tool session TMPDIR suite (class C)",
    paths: ["./test/unit/agents/coding-tool-support-session-tmp.test.ts"],
  },
  {
    ac: "AC-14",
    what: "the coding-tool command-shadow suite (class C)",
    paths: ["./test/unit/agents/coding-tool-support-command-shadow.test.ts"],
  },
  {
    ac: "AC-15",
    what: "the Bun runtime spawn suite (class C)",
    paths: ["./test/unit/agent-runtime/bun-runtime.test.ts"],
  },
];

const unavailable = isConfinedTestRun() || !(await confinedSandboxAvailable());

describe("runConfinedFiles — the runner's own contract", () => {
  test("AC-3: confinedSandboxAvailable() resolves true exactly when the runner's --probe exits 0", async () => {
    const probe = Bun.spawnSync(["bun", RUNNER, "--probe"], {
      cwd: PACKAGE_DIR,
      stdout: "ignore",
      stderr: "ignore",
    });

    expect(await confinedSandboxAvailable()).toBe(probe.exitCode === 0);
  }, 60_000);

  test("AC-4: runConfinedFiles([]) resolves the runner's usage exit (2), without needing a sandbox", async () => {
    expect(await runConfinedFiles([])).toBe(USAGE_EXIT);
  }, 60_000);
});

describe.skipIf(unavailable)("nax unit suites under confinement", () => {
  for (const group of REPAIRED_GROUPS) {
    test(
      `${group.ac}: ${group.what} passes confined`,
      async () => {
        expect(await runConfinedFiles(group.paths)).toBe(0);
      },
      GROUP_TIMEOUT_MS,
    );
  }
});
