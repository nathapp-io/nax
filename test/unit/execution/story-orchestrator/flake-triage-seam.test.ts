/**
 * Production Triage Seam — US-003 wiring
 *
 * Verifies `productionTriageSeam` (the real binding replacing `defaultTriageSeam`
 * in production, see run-phase.ts) actually calls `triageFlakyFindings` with a
 * real baseline diff resolved from git, instead of the passthrough stub this
 * seam previously was.
 */

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _storyOrchestratorDeps } from "@/execution";
import type { Finding } from "@/findings";
import { productionTriageSeam } from "@/execution/story-orchestrator/flake-triage-seam";
import { _flakeTriageDeps } from "@/verification/flake-triage";
import { cleanupTempDir, makeNaxConfig, makeTempDir, makeTestRuntime } from "@test/helpers";

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr?.toString()}`);
  }
}

function makeFailedTest(overrides: Partial<Finding> = {}): Finding {
  return {
    source: "test-runner",
    severity: "error",
    category: "failed-test",
    rule: "shouldBar",
    file: "pre-existing.test.ts",
    message: "expected x to equal y",
    ...overrides,
  };
}

const BUN_FAIL_OUTPUT = "bun test v1.0.0\n(fail) pre-existing.test.ts > shouldBar\n";

describe("productionTriageSeam", () => {
  let workdir: string;
  let savedRunFlakeProbe: typeof _flakeTriageDeps.runFlakeProbe;

  beforeEach(() => {
    // realpathSync avoids a macOS /tmp -> /private/tmp symlink mismatch between
    // `workdir` and `getGitRoot()`'s resolved toplevel, which otherwise confuses
    // smart-runner's git-root-relative path stripping for an unrelated reason.
    workdir = realpathSync(makeTempDir("nax-flake-seam-"));
    git(workdir, "init", "-q");
    git(workdir, "config", "user.email", "test@example.com");
    git(workdir, "config", "user.name", "Test");
    savedRunFlakeProbe = _flakeTriageDeps.runFlakeProbe;
  });

  afterEach(() => {
    cleanupTempDir(workdir);
    _flakeTriageDeps.runFlakeProbe = savedRunFlakeProbe;
  });

  function makeCtx(config: ReturnType<typeof makeNaxConfig>) {
    const runtime = makeTestRuntime({ config, workdir });
    return {
      ctx: {
        runtime,
        packageView: runtime.packages.repo(),
        packageDir: workdir,
        agentName: "claude",
        storyId: "US-003",
      } as unknown as Parameters<typeof productionTriageSeam>[1]["ctx"],
    };
  }

  test("flakeDetection.enabled=false passes findings through unchanged (no git calls)", async () => {
    const config = makeNaxConfig({ execution: { flakeDetection: { enabled: false } } });
    const { ctx } = makeCtx(config);
    const findings = [makeFailedTest()];
    const [result, report] = await productionTriageSeam(findings, { ctx, rawOutput: BUN_FAIL_OUTPUT });
    expect(result).toEqual(findings);
    expect(report.quarantinedKeys).toEqual([]);
  });

  test("unknown framework passes findings through unchanged", async () => {
    const config = makeNaxConfig({ execution: { flakeDetection: { enabled: true } } });
    const { ctx } = makeCtx(config);
    const findings = [makeFailedTest()];
    const [result, report] = await productionTriageSeam(findings, { ctx, rawOutput: "totally unrecognized output" });
    expect(result).toEqual(findings);
    expect(report.quarantinedKeys).toEqual([]);
  });

  test("a test file touched by the story's own diff is never probed (real git baseline check)", async () => {
    // Commit a "pre-existing" baseline, then modify pre-existing.test.ts on top —
    // it is now a story-touched file per `git diff <mergeBase>`.
    await Bun.write(`${workdir}/pre-existing.test.ts`, "test('shouldBar', () => {});\n");
    git(workdir, "add", ".");
    git(workdir, "commit", "-q", "-m", "baseline");
    git(workdir, "checkout", "-q", "-b", "feature");
    await Bun.write(`${workdir}/pre-existing.test.ts`, "test('shouldBar', () => { expect(1).toBe(1); });\n");
    git(workdir, "add", ".");
    git(workdir, "commit", "-q", "-m", "story touches this test");

    let probeCalled = false;
    _flakeTriageDeps.runFlakeProbe = async () => {
      probeCalled = true;
      return { verdict: "flaky", probeRuns: 2, probePasses: 1, attributableRuns: 2 };
    };

    const config = makeNaxConfig({
      execution: { flakeDetection: { enabled: true } },
      quality: { commands: { test: "bun test" } },
    });
    const { ctx } = makeCtx(config);
    const findings = [makeFailedTest({ file: "pre-existing.test.ts" })];
    const [result] = await productionTriageSeam(findings, { ctx, rawOutput: BUN_FAIL_OUTPUT });

    expect(probeCalled).toBe(false);
    expect(result[0]?.category).toBe("failed-test");
  });

  test("a pre-existing, story-untouched failure is probed and quarantined on a flaky verdict", async () => {
    await Bun.write(`${workdir}/pre-existing.test.ts`, "test('shouldBar', () => {});\n");
    git(workdir, "add", ".");
    git(workdir, "commit", "-q", "-m", "baseline");
    git(workdir, "checkout", "-q", "-b", "feature");
    await Bun.write(`${workdir}/unrelated.ts`, "export const x = 1;\n");
    git(workdir, "add", ".");
    git(workdir, "commit", "-q", "-m", "story touches something else entirely");

    let probeCalled = false;
    _flakeTriageDeps.runFlakeProbe = async () => {
      probeCalled = true;
      return { verdict: "flaky", probeRuns: 2, probePasses: 1, attributableRuns: 2 };
    };

    const config = makeNaxConfig({
      execution: { flakeDetection: { enabled: true } },
      quality: { commands: { test: "bun test" } },
    });
    const { ctx } = makeCtx(config);
    const findings = [makeFailedTest({ file: "pre-existing.test.ts" })];
    const [result, report] = await productionTriageSeam(findings, { ctx, rawOutput: BUN_FAIL_OUTPUT });

    expect(probeCalled).toBe(true);
    expect(result[0]?.category).toBe("flaky-test");
    expect(report.quarantinedKeys.length).toBe(1);
  });

  test("is wired as the production seam in _storyOrchestratorDeps.triage", () => {
    expect(_storyOrchestratorDeps.triage).toBe(productionTriageSeam);
  });
});
