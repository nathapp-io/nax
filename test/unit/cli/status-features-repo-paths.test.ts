/**
 * Tests for US-001: nax status reads the repo feature directory.
 *
 * Status paths change:
 *   - prd.json + feature status.json now live under the REPO feature dir
 *     (R/.nax/features/<feature>) rather than the per-user output dir
 *     (O/features/<feature>).
 *   - run logs (runs/*.jsonl) still live under the per-user output dir
 *     (O/features/<feature>/runs/).
 *
 * displayFeatureStatus({ feature, dir }) now resolves projectRoot by:
 *   projectRoot = parent of findProjectDir(resolve(dir))
 *               or resolve(dir) if findProjectDir returns null.
 * displayAllFeatures(projectRoot) reads from featuresDir(projectRoot).
 * getFeatureSummary(name, featureDir, runsDir) reads prd.json + status.json
 * from featureDir and run logs from runsDir.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve as nodeResolve } from "node:path";
import { makeTempDir } from "@test/helpers";
import { Command } from "commander";
import { registerStatusCommand } from "@/cli/status-dispatch";
import { _statusFeaturesDeps, displayFeatureStatus } from "@/cli/status-features";
import type { NaxStatusFile } from "@/execution/status-file";
import type { PRD } from "@/prd";

/**
 * Build the "status fixture" described in the story:
 *   R/                  — temp project root (a real temp dir)
 *     .nax/
 *       config.json     — { "name": "status-fixture" }
 *       features/
 *         feat-a/
 *           prd.json    — two stories, US-001 (passed) and US-002 (pending)
 *   O/                  — separate temp dir, NOT under R; projectOutputDir
 *                          stubbed to return this; holds run logs only.
 */
function buildStatusFixture(): { R: string; O: string } {
  const R = realpathSync(makeTempDir("nax-test-status-"));
  const O = realpathSync(makeTempDir("nax-test-status-output-"));
  const naxDir = join(R, ".nax");
  const featuresDir = join(naxDir, "features");
  const featADir = join(featuresDir, "feat-a");
  mkdirSync(featADir, { recursive: true });
  writeFileSync(join(naxDir, "config.json"), JSON.stringify({ name: "status-fixture" }));

  const prd: PRD = {
    project: "status-fixture",
    feature: "feat-a",
    branchName: "feat/feat-a",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    userStories: [
      {
        id: "US-001",
        title: "First story",
        description: "Test story 1",
        acceptanceCriteria: ["AC-1"],
        tags: [],
        dependencies: [],
        status: "passed",
        passes: true,
        escalations: [],
        attempts: 1,
      },
      {
        id: "US-002",
        title: "Second story",
        description: "Test story 2",
        acceptanceCriteria: ["AC-2"],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 0,
      },
    ],
  };
  writeFileSync(join(featADir, "prd.json"), JSON.stringify(prd, null, 2));

  return { R, O };
}

/** Create a usable feature status.json file. */
function writeFeatureStatus(featureDir: string, overrides: Partial<NaxStatusFile> = {}): void {
  const status: NaxStatusFile = {
    version: 1,
    run: {
      id: "run-2026-01-01T00-00-00-000Z",
      feature: "feat-a",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "completed",
      dryRun: false,
      pid: 99999,
    },
    progress: { total: 2, passed: 1, failed: 0, paused: 0, blocked: 0, pending: 1 },
    cost: { spent: 0, limit: null },
    current: null,
    iterations: 1,
    updatedAt: "2026-01-01T01:00:00.000Z",
    durationMs: 3600000,
    ...overrides,
  };
  writeFileSync(join(featureDir, "status.json"), JSON.stringify(status, null, 2));
}

describe("US-001: nax status reads the repo feature directory", () => {
  let originalCwd: string;
  let consoleOutput: string[];
  const originalLog = console.log;
  let origProjectOutputDir: typeof _statusFeaturesDeps.projectOutputDir;
  let origFindProjectDir: typeof _statusFeaturesDeps.findProjectDir;

  beforeEach(() => {
    originalCwd = process.cwd();

    origProjectOutputDir = _statusFeaturesDeps.projectOutputDir;
    origFindProjectDir = _statusFeaturesDeps.findProjectDir;

    consoleOutput = [];
    console.log = mock((message: string) => {
      consoleOutput.push(message);
    });
  });

  afterEach(() => {
    _statusFeaturesDeps.projectOutputDir = origProjectOutputDir;
    _statusFeaturesDeps.findProjectDir = origFindProjectDir;
    process.chdir(originalCwd);
    console.log = originalLog;
  });

  // ============================================================================
  // AC-1: single-feature dir reads prd.json from R/.nax/features/<feature>
  // ============================================================================
  test("AC-1: single-feature view reads prd.json from repo feature dir, not from output dir", async () => {
    const { R, O } = buildStatusFixture();
    _statusFeaturesDeps.findProjectDir = (() => join(R, ".nax")) as typeof _statusFeaturesDeps.findProjectDir;
    _statusFeaturesDeps.projectOutputDir = (() => O) as typeof _statusFeaturesDeps.projectOutputDir;

    try {
      await displayFeatureStatus({ feature: "feat-a", dir: R });

      const output = consoleOutput.join("\n");
      expect(output).toContain("US-001");
      expect(output).toContain("US-002");
      expect(output).not.toContain("No prd.json found");
    } finally {
      rmSync(R, { recursive: true, force: true });
      rmSync(O, { recursive: true, force: true });
    }
  });

  // ============================================================================
  // AC-2: crashed run banner surfaces in single-feature view
  // ============================================================================
  test("AC-2: single-feature view prints 'Crashed Run Detected' when feature status.json has run.status === 'crashed'", async () => {
    const { R, O } = buildStatusFixture();
    writeFeatureStatus(join(R, ".nax", "features", "feat-a"), {
      run: {
        id: "run-crashed",
        feature: "feat-a",
        startedAt: "2026-01-01T00:00:00.000Z",
        status: "crashed",
        dryRun: false,
        pid: 99999,
      },
    });
    _statusFeaturesDeps.findProjectDir = (() => join(R, ".nax")) as typeof _statusFeaturesDeps.findProjectDir;
    _statusFeaturesDeps.projectOutputDir = (() => O) as typeof _statusFeaturesDeps.projectOutputDir;

    try {
      await displayFeatureStatus({ feature: "feat-a", dir: R });

      const output = consoleOutput.join("\n");
      expect(output).toContain("Crashed Run Detected");
    } finally {
      rmSync(R, { recursive: true, force: true });
      rmSync(O, { recursive: true, force: true });
    }
  });

  // ============================================================================
  // AC-3: subdirectory without its own .nax still walks up to find R
  // ============================================================================
  test("AC-3: subdirectory with no .nax of its own still resolves to the parent's feature dir", async () => {
    const { R, O } = buildStatusFixture();
    const pkgApp = join(R, "packages", "app");
    mkdirSync(pkgApp, { recursive: true });
    _statusFeaturesDeps.findProjectDir = ((start: string) => {
      const real = nodeResolve(start);
      // Pretend we walked up from packages/app and found the project's .nax
      if (real.startsWith(join(R, "packages"))) return join(R, ".nax");
      return null;
    }) as typeof _statusFeaturesDeps.findProjectDir;
    _statusFeaturesDeps.projectOutputDir = (() => O) as typeof _statusFeaturesDeps.projectOutputDir;

    try {
      await displayFeatureStatus({ feature: "feat-a", dir: pkgApp });

      const output = consoleOutput.join("\n");
      expect(output).toContain("US-001");
      expect(output).not.toContain("No prd.json found");
    } finally {
      rmSync(R, { recursive: true, force: true });
      rmSync(O, { recursive: true, force: true });
    }
  });

  // ============================================================================
  // AC-4: prd.json under O (output dir) is IGNORED; we read from R
  // ============================================================================
  test("AC-4: prd.json under O (output dir) is ignored — we read from R's repo feature dir", async () => {
    const { R, O } = buildStatusFixture();
    // Plant a decoy PRD under O that mentions US-099
    const oFeaturesDir = join(O, "features", "feat-a");
    mkdirSync(oFeaturesDir, { recursive: true });
    const decoyPrd: PRD = {
      project: "status-fixture",
      feature: "feat-a",
      branchName: "feat/feat-a",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      userStories: [
        {
          id: "US-099",
          title: "Decoy story",
          description: "Decoy",
          acceptanceCriteria: ["AC-99"],
          tags: [],
          dependencies: [],
          status: "pending",
          passes: false,
          escalations: [],
          attempts: 0,
        },
      ],
    };
    writeFileSync(join(oFeaturesDir, "prd.json"), JSON.stringify(decoyPrd, null, 2));
    _statusFeaturesDeps.findProjectDir = (() => join(R, ".nax")) as typeof _statusFeaturesDeps.findProjectDir;
    _statusFeaturesDeps.projectOutputDir = (() => O) as typeof _statusFeaturesDeps.projectOutputDir;

    try {
      await displayFeatureStatus({ feature: "feat-a", dir: R });

      const output = consoleOutput.join("\n");
      expect(output).toContain("US-001");
      expect(output).not.toContain("US-099");
    } finally {
      rmSync(R, { recursive: true, force: true });
      rmSync(O, { recursive: true, force: true });
    }
  });

  // ============================================================================
  // AC-5: missing prd.json surfaces the same "Run: nax plan" notice as before
  // ============================================================================
  test("AC-5: single-feature view prints 'No prd.json found. Run: nax plan -f feat-b' when R/.nax/features/feat-b has no prd.json", async () => {
    const { R, O } = buildStatusFixture();
    // Create feat-b directory but no prd.json inside
    mkdirSync(join(R, ".nax", "features", "feat-b"), { recursive: true });
    _statusFeaturesDeps.findProjectDir = (() => join(R, ".nax")) as typeof _statusFeaturesDeps.findProjectDir;
    _statusFeaturesDeps.projectOutputDir = (() => O) as typeof _statusFeaturesDeps.projectOutputDir;

    try {
      await displayFeatureStatus({ feature: "feat-b", dir: R });

      const output = consoleOutput.join("\n");
      expect(output).toContain("No prd.json found");
      expect(output).toContain("Run: nax plan -f feat-b");
    } finally {
      rmSync(R, { recursive: true, force: true });
      rmSync(O, { recursive: true, force: true });
    }
  });

  // ============================================================================
  // AC-6: all-features table enumerates subdirs of R/.nax/features
  // ============================================================================
  test("AC-6: all-features view lists both feat-a and feat-b from R/.nax/features", async () => {
    const { R, O } = buildStatusFixture();
    // Add feat-b with a single pending story
    const featBDir = join(R, ".nax", "features", "feat-b");
    mkdirSync(featBDir, { recursive: true });
    const prdB: PRD = {
      project: "status-fixture",
      feature: "feat-b",
      branchName: "feat/feat-b",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      userStories: [
        {
          id: "US-010",
          title: "Only story",
          description: "Pending",
          acceptanceCriteria: ["AC-1"],
          tags: [],
          dependencies: [],
          status: "pending",
          passes: false,
          escalations: [],
          attempts: 0,
        },
      ],
    };
    writeFileSync(join(featBDir, "prd.json"), JSON.stringify(prdB, null, 2));
    // No O/features/ at all
    _statusFeaturesDeps.findProjectDir = (() => join(R, ".nax")) as typeof _statusFeaturesDeps.findProjectDir;
    _statusFeaturesDeps.projectOutputDir = (() => O) as typeof _statusFeaturesDeps.projectOutputDir;

    try {
      await displayFeatureStatus({ dir: R });

      const output = consoleOutput.join("\n");
      const featARow = output.split("\n").find((line) => line.trimStart().startsWith("feat-a "));
      const featBRow = output.split("\n").find((line) => line.trimStart().startsWith("feat-b "));
      expect(featARow).toBeDefined();
      expect(featBRow).toBeDefined();
    } finally {
      rmSync(R, { recursive: true, force: true });
      rmSync(O, { recursive: true, force: true });
    }
  });

  // ============================================================================
  // AC-7: feat-a row Done=1 / Pending=1 in all-features table
  // ============================================================================
  test("AC-7: all-features view shows feat-a row with Done=1 and Pending=1", async () => {
    const { R, O } = buildStatusFixture();
    _statusFeaturesDeps.findProjectDir = (() => join(R, ".nax")) as typeof _statusFeaturesDeps.findProjectDir;
    _statusFeaturesDeps.projectOutputDir = (() => O) as typeof _statusFeaturesDeps.projectOutputDir;

    try {
      await displayFeatureStatus({ dir: R });

      const output = consoleOutput.join("\n");
      const featARow = output.split("\n").find((line) => line.trimStart().startsWith("feat-a "));
      expect(featARow).toBeDefined();
      // Row format: "  feat-a 1 0 1 ... ..."
      // Done column immediately follows the padded feature name.
      const match = featARow?.match(/feat-a\s+(\S+)\s+(\S+)\s+(\S+)/);
      expect(match).not.toBeNull();
      expect(match?.[1]).toBe("1"); // Done
      expect(match?.[3]).toBe("1"); // Pending
    } finally {
      rmSync(R, { recursive: true, force: true });
      rmSync(O, { recursive: true, force: true });
    }
  });

  // ============================================================================
  // AC-8: run log under O shows in Last Run column
  // ============================================================================
  test("AC-8: Last Run column reflects the run log timestamp from O/features/<feat>/runs/", async () => {
    const { R, O } = buildStatusFixture();
    const runsDir = join(O, "features", "feat-a", "runs");
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(runsDir, "2026-09-28T10-00-00.jsonl"), "{}\n");
    _statusFeaturesDeps.findProjectDir = (() => join(R, ".nax")) as typeof _statusFeaturesDeps.findProjectDir;
    _statusFeaturesDeps.projectOutputDir = (() => O) as typeof _statusFeaturesDeps.projectOutputDir;

    try {
      await displayFeatureStatus({ dir: R });

      const output = consoleOutput.join("\n");
      const featARow = output.split("\n").find((line) => line.trimStart().startsWith("feat-a "));
      expect(featARow).toBeDefined();
      expect(featARow).toContain("2026-09-28T10-00-00");
    } finally {
      rmSync(R, { recursive: true, force: true });
      rmSync(O, { recursive: true, force: true });
    }
  });

  // ============================================================================
  // AC-9: cost.spent surfaces in Cost column
  // ============================================================================
  test("AC-9: Cost column reflects status.json cost.spent ($1.5000)", async () => {
    const { R, O } = buildStatusFixture();
    writeFeatureStatus(join(R, ".nax", "features", "feat-a"), {
      cost: { spent: 1.5, limit: null },
    });
    _statusFeaturesDeps.findProjectDir = (() => join(R, ".nax")) as typeof _statusFeaturesDeps.findProjectDir;
    _statusFeaturesDeps.projectOutputDir = (() => O) as typeof _statusFeaturesDeps.projectOutputDir;

    try {
      await displayFeatureStatus({ dir: R });

      const output = consoleOutput.join("\n");
      const featARow = output.split("\n").find((line) => line.trimStart().startsWith("feat-a "));
      expect(featARow).toBeDefined();
      expect(featARow).toContain("$1.5000");
    } finally {
      rmSync(R, { recursive: true, force: true });
      rmSync(O, { recursive: true, force: true });
    }
  });

  // ============================================================================
  // AC-10: run log for a feature with NO repo feature dir is not listed
  // ============================================================================
  test("AC-10: a run log for a feature with no R/.nax/features/<feat> dir does NOT appear as a row", async () => {
    const { R, O } = buildStatusFixture();
    const ghostRunsDir = join(O, "features", "ghost", "runs");
    mkdirSync(ghostRunsDir, { recursive: true });
    writeFileSync(join(ghostRunsDir, "2026-09-28T10-00-00.jsonl"), "{}\n");
    _statusFeaturesDeps.findProjectDir = (() => join(R, ".nax")) as typeof _statusFeaturesDeps.findProjectDir;
    _statusFeaturesDeps.projectOutputDir = (() => O) as typeof _statusFeaturesDeps.projectOutputDir;

    try {
      await displayFeatureStatus({ dir: R });

      const output = consoleOutput.join("\n");
      const ghostRow = output.split("\n").find((line) => line.trimStart().startsWith("ghost "));
      expect(ghostRow).toBeUndefined();
    } finally {
      rmSync(R, { recursive: true, force: true });
      rmSync(O, { recursive: true, force: true });
    }
  });

  // ============================================================================
  // AC-11: empty R/.nax/features prints "No features found."
  // ============================================================================
  test("AC-11: prints 'No features found.' when R/.nax/features is absent or empty", async () => {
    const R = realpathSync(makeTempDir("nax-test-status-empty-"));
    const O = realpathSync(makeTempDir("nax-test-status-empty-output-"));
    mkdirSync(join(R, ".nax"), { recursive: true });
    writeFileSync(join(R, ".nax", "config.json"), "{}");
    _statusFeaturesDeps.findProjectDir = (() => join(R, ".nax")) as typeof _statusFeaturesDeps.findProjectDir;
    _statusFeaturesDeps.projectOutputDir = (() => O) as typeof _statusFeaturesDeps.projectOutputDir;

    try {
      await displayFeatureStatus({ dir: R });

      const output = consoleOutput.join("\n");
      expect(output).toContain("No features found");
    } finally {
      rmSync(R, { recursive: true, force: true });
      rmSync(O, { recursive: true, force: true });
    }
  });

  // ============================================================================
  // AC-12: subdir without .nax — all-features view resolves and prints feat-a row
  // ============================================================================
  test("AC-12: all-features view from a subdirectory without .nax still prints a feat-a row", async () => {
    const { R, O } = buildStatusFixture();
    const pkgApp = join(R, "packages", "app");
    mkdirSync(pkgApp, { recursive: true });
    _statusFeaturesDeps.findProjectDir = ((start: string) => {
      const real = nodeResolve(start);
      if (real.startsWith(join(R, "packages"))) return join(R, ".nax");
      return null;
    }) as typeof _statusFeaturesDeps.findProjectDir;
    _statusFeaturesDeps.projectOutputDir = (() => O) as typeof _statusFeaturesDeps.projectOutputDir;

    try {
      await displayFeatureStatus({ dir: pkgApp });

      const output = consoleOutput.join("\n");
      const featARow = output.split("\n").find((line) => line.trimStart().startsWith("feat-a "));
      expect(featARow).toBeDefined();
    } finally {
      rmSync(R, { recursive: true, force: true });
      rmSync(O, { recursive: true, force: true });
    }
  });

  // ============================================================================
  // AC-14: no runs/ dir in O prints "No runs yet"
  // ============================================================================
  test("AC-14: 'No runs yet' is printed when O/features/<feat>/runs does not exist", async () => {
    const { R, O } = buildStatusFixture();
    // No runs/ in O
    _statusFeaturesDeps.findProjectDir = (() => join(R, ".nax")) as typeof _statusFeaturesDeps.findProjectDir;
    _statusFeaturesDeps.projectOutputDir = (() => O) as typeof _statusFeaturesDeps.projectOutputDir;

    try {
      await displayFeatureStatus({ dir: R });

      const output = consoleOutput.join("\n");
      const featARow = output.split("\n").find((line) => line.trimStart().startsWith("feat-a "));
      expect(featARow).toBeDefined();
      expect(featARow).toContain("No runs yet");
    } finally {
      rmSync(R, { recursive: true, force: true });
      rmSync(O, { recursive: true, force: true });
    }
  });

  // ============================================================================
  // AC-15: dir with no .nax in it or any ancestor → single-feature prints "No prd.json found"
  // ============================================================================
  test("AC-15: dir with no .nax/config.json anywhere up the tree prints 'No prd.json found' for single-feature view", async () => {
    // Build a fresh temp dir under /tmp with NO .nax in any ancestor.
    // makeTempDir places under os.tmpdir(); we trust the host doesn't put .nax
    // in /tmp or its ancestors.
    const T = realpathSync(makeTempDir("nax-test-no-nax-"));
    // findProjectDir returns null because there is no .nax anywhere
    _statusFeaturesDeps.findProjectDir = (() => null) as typeof _statusFeaturesDeps.findProjectDir;
    // projectOutputDir is irrelevant here — we don't reach it.
    _statusFeaturesDeps.projectOutputDir = (() => T) as typeof _statusFeaturesDeps.projectOutputDir;

    try {
      await displayFeatureStatus({ feature: "feat-a", dir: T });

      const output = consoleOutput.join("\n");
      expect(output).toContain("No prd.json found");
      expect(output).toContain("Run: nax plan -f feat-a");
    } finally {
      rmSync(T, { recursive: true, force: true });
    }
  });

  // ============================================================================
  // AC-16: projectOutputDir is called with project key = basename(R) when config has no name
  // ============================================================================
  test("AC-16: projectOutputDir is called with the project key equal to basename(R) when config.name is unset", async () => {
    const R = realpathSync(makeTempDir("nax-test-keyproj-"));
    const O = realpathSync(makeTempDir("nax-test-keyproj-output-"));
    mkdirSync(join(R, ".nax"), { recursive: true });
    writeFileSync(join(R, ".nax", "config.json"), "not json");
    mkdirSync(join(R, ".nax", "features"), { recursive: true });

    _statusFeaturesDeps.findProjectDir = (() => join(R, ".nax")) as typeof _statusFeaturesDeps.findProjectDir;

    const calls: Array<[string, string | undefined]> = [];
    _statusFeaturesDeps.projectOutputDir = ((projectKey: string, override: string | undefined) => {
      calls.push([projectKey, override]);
      return O;
    }) as typeof _statusFeaturesDeps.projectOutputDir;

    try {
      await displayFeatureStatus({ dir: R });

      // projectOutputDir must have been called with basename(R) as the project key
      const usedBaseName = calls.some(([key]) => key === basename(R));
      expect(usedBaseName).toBe(true);
    } finally {
      rmSync(R, { recursive: true, force: true });
      rmSync(O, { recursive: true, force: true });
    }
  });

  // ============================================================================
  // AC-17: feat-b with no prd.json renders 0/0/0 in all-features view
  // ============================================================================
  test("AC-17: all-features view shows feat-b row with Done=0, Failed=0, Pending=0 when no prd.json", async () => {
    const { R, O } = buildStatusFixture();
    mkdirSync(join(R, ".nax", "features", "feat-b"), { recursive: true });
    _statusFeaturesDeps.findProjectDir = (() => join(R, ".nax")) as typeof _statusFeaturesDeps.findProjectDir;
    _statusFeaturesDeps.projectOutputDir = (() => O) as typeof _statusFeaturesDeps.projectOutputDir;

    try {
      await displayFeatureStatus({ dir: R });

      const output = consoleOutput.join("\n");
      const featBRow = output.split("\n").find((line) => line.trimStart().startsWith("feat-b "));
      expect(featBRow).toBeDefined();
      const match = featBRow?.match(/feat-b\s+(\S+)\s+(\S+)\s+(\S+)/);
      expect(match).not.toBeNull();
      expect(match?.[1]).toBe("0");
      expect(match?.[2]).toBe("0");
      expect(match?.[3]).toBe("0");
    } finally {
      rmSync(R, { recursive: true, force: true });
      rmSync(O, { recursive: true, force: true });
    }
  });

  // ============================================================================
  // Adversarial: a directory under .nax/features that fails featureId validation
  // (e.g. .DS_Store, whitespace) must NOT abort the all-features listing. The
  // status command is a diagnostic; a stray sibling directory should be
  // silently ignored, not throw an INVALID_FEATURE_ID across the whole view.
  // ============================================================================
  test("all-features view silently skips directories that fail featureId validation (.DS_Store, whitespace, etc.)", async () => {
    const { R, O } = buildStatusFixture();
    // Plant two junk entries alongside feat-a
    mkdirSync(join(R, ".nax", "features", ".DS_Store"), { recursive: true });
    mkdirSync(join(R, ".nax", "features", "foo bar"), { recursive: true });
    _statusFeaturesDeps.findProjectDir = (() => join(R, ".nax")) as typeof _statusFeaturesDeps.findProjectDir;
    _statusFeaturesDeps.projectOutputDir = (() => O) as typeof _statusFeaturesDeps.projectOutputDir;

    try {
      // Must not throw
      await displayFeatureStatus({ dir: R });

      const output = consoleOutput.join("\n");
      // feat-a row should still be present; junk entries must not appear
      const featARow = output.split("\n").find((line) => line.trimStart().startsWith("feat-a "));
      expect(featARow).toBeDefined();
      expect(output).not.toContain(".DS_Store");
      expect(output).not.toContain("foo bar");
    } finally {
      rmSync(R, { recursive: true, force: true });
      rmSync(O, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// AC-13: commander-level integration with the default
// _statusCommandActionDeps parses `["status", "-f", "feat-a", "--dir", R]`
// and renders US-001, never "No prd.json found".
// ============================================================================

describe("US-001 — registerStatusCommand + commander parse integration", () => {
  let originalCwd: string;
  let consoleOutput: string[];
  const originalLog = console.log;
  let origProjectOutputDir: typeof _statusFeaturesDeps.projectOutputDir;
  let origFindProjectDir: typeof _statusFeaturesDeps.findProjectDir;

  beforeEach(() => {
    originalCwd = process.cwd();

    origProjectOutputDir = _statusFeaturesDeps.projectOutputDir;
    origFindProjectDir = _statusFeaturesDeps.findProjectDir;

    consoleOutput = [];
    console.log = mock((message: string) => {
      consoleOutput.push(message);
    });
  });

  afterEach(() => {
    _statusFeaturesDeps.projectOutputDir = origProjectOutputDir;
    _statusFeaturesDeps.findProjectDir = origFindProjectDir;
    process.chdir(originalCwd);
    console.log = originalLog;
  });

  test("AC-13: commander program with registerStatusCommand parses `status -f feat-a --dir R` and prints US-001 (not 'No prd.json found')", async () => {
    const { R, O } = buildStatusFixture();
    _statusFeaturesDeps.findProjectDir = (() => join(R, ".nax")) as typeof _statusFeaturesDeps.findProjectDir;
    _statusFeaturesDeps.projectOutputDir = (() => O) as typeof _statusFeaturesDeps.projectOutputDir;

    try {
      const program = new Command();
      program.exitOverride();
      registerStatusCommand(program);

      await program.parseAsync(["status", "-f", "feat-a", "--dir", R], { from: "user" });

      const output = consoleOutput.join("\n");
      expect(output).toContain("US-001");
      expect(output).not.toContain("No prd.json found");
    } finally {
      rmSync(R, { recursive: true, force: true });
      rmSync(O, { recursive: true, force: true });
    }
  });
});
