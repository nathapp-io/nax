/**
 * `nax resume` — resumed run's log filename matches the run identifier it
 * reports (US-005 AC-9).
 *
 * Two paths must agree on the same id:
 *   - the log file the resume command opens (`<runs>/<feature>/runs/<runId>.jsonl`)
 *   - the run.id that `run()` produces and stamps into status.json
 *
 * If they diverge, the resumed run's status.json says `run.id = X` but the
 * only log under the run's `runs/` directory is `<Y>.jsonl` — replay /
 * crash-recovery tools read the wrong file, and `nax status` attributes
 * lines to a run that did not write them.
 *
 * The implementation builds a single id via `buildRunId(workdir, now)` and
 * uses it for both. This test exercises the wiring end-to-end.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { registerResumeCommand } from "@/commands";
import { globalConfigDir } from "@/config/paths";
import { resetLogger } from "@/logger";

describe("`nax resume` — AC-9: log filename matches the run identifier", () => {
  let origCwd: string;
  let origExit: typeof process.exit;
  let tempDir: string;
  let globalDir: string;

  beforeEach(() => {
    origCwd = process.cwd();
    origExit = process.exit;
    tempDir = mkdtempSync(join(tmpdir(), "nax-resume-ac9-"));
    // The runner writes its status file under the isolated global config dir
    // (set by test/preload.ts via NAX_GLOBAL_CONFIG_DIR). Pin that here so
    // the assertions can find the file without scanning the filesystem.
    globalDir = globalConfigDir();
    // Other tests in this process may have initialized the logger; the
    // resume action calls `initLogger()` unconditionally and would throw
    // `LOGGER_ALREADY_INITIALIZED` before reaching `run()` if it stayed
    // wired. Reset between cases so the action always reaches the run.
    resetLogger();
  });

  afterEach(() => {
    process.chdir(origCwd);
    process.exit = origExit;
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    // The resume action unconditionally calls initLogger() — leave the
    // singleton in its initial state so subsequent test files (which
    // also call initLogger() in their own beforeEach) do not trip on
    // LOGGER_ALREADY_INITIALIZED.
    resetLogger();
  });

  test("AC-9: a resumed run writes its log file under a name equal to the run identifier", async () => {
    // Lay down a minimal .nax project + a passed-story PRD so the runner
    // completes without spawning an agent and writes its final state.
    writeProjectFixture(tempDir, "ac9-feature");

    // Stub process.exit so the resume action's "process.exit(...)" call
    // does not kill the test runner. The action always reaches
    // process.exit on every code path (success, run-failure, inner throw).
    // The stub records the requested code for the post-action assertions
    // and returns without terminating the test process.
    const observedExits: number[] = [];
    Object.assign(process, {
      exit(code?: number): void {
        observedExits.push(code ?? 0);
      },
    });
    process.chdir(tempDir);

    const program = new Command();
    registerResumeCommand(program);

    await program.parseAsync(["node", "nax", "resume", "-f", "ac9-feature", "-d", tempDir]);

    // projectKey defaults to basename(tempDir); the runner writes status
    // and log files under `<globalDir>/<projectKey>/...`.
    const projectKey = tempDir.split("/").pop() ?? "";
    const outputDir = join(globalDir, projectKey);
    const runsDir = join(outputDir, "features", "ac9-feature", "runs");

    const logFiles = existsSync(runsDir) ? readdirSync(runsDir).filter((f) => f.endsWith(".jsonl")) : [];
    expect(logFiles.length).toBeGreaterThanOrEqual(1);

    const logBase = (logFiles[0] ?? "").replace(/\.jsonl$/, "");
    // The buildRunId shape: run-<8 hex>-<iso-with-dashes>
    expect(logBase).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(logBase).toMatch(/^run-[0-9a-f]{8}-/);

    // status.json is at <outputDir>/status.json.
    const statusPath = join(outputDir, "status.json");
    expect(existsSync(statusPath)).toBe(true);
    const status = JSON.parse(readFileSync(statusPath, "utf8")) as { run: { id: string; workdir?: string } };

    // Critical assertion: the log filename (sans extension) equals the
    // status.json run.id. If the two diverge, replay reads the wrong file.
    expect(status.run.id).toBe(logBase);

    // Bonus: the resumed run also stamps `run.workdir` onto the status
    // file (AC-1) — readers can now attribute which checkout wrote the
    // run without parsing log lines.
    expect(status.run.workdir).toBe(tempDir);
  }, 30000);
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function writeProjectFixture(tempDir: string, feature: string): void {
  mkdirSync(join(tempDir, ".nax"), { recursive: true });
  writeFileSync(join(tempDir, ".nax", "config.json"), "{}");

  const featureDir = join(tempDir, ".nax", "features", feature);
  mkdirSync(featureDir, { recursive: true });
  const prd = {
    project: "test-project",
    feature,
    branchName: `feat/${feature}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    // A single passed story — the runner completes without spawning an
    // agent and writes its final status.json (so we can compare the
    // run.id against the filename under `runs/`).
    userStories: [
      {
        id: "US-001",
        title: "Already done",
        description: "Nothing left",
        acceptanceCriteria: ["Works"],
        tags: [],
        dependencies: [],
        status: "passed",
        passes: true,
        escalations: [],
        attempts: 0,
      },
    ],
  };
  writeFileSync(join(featureDir, "prd.json"), JSON.stringify(prd, null, 2));
}
