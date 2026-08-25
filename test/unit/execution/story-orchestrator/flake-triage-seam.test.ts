/**
 * Production Triage Seam — US-003 wiring
 *
 * Verifies `productionTriageSeam` (the real binding replacing `defaultTriageSeam`
 * in production, see run-phase.ts) actually calls `triageFlakyFindings` with a
 * real baseline diff resolved from git, instead of the passthrough stub this
 * seam previously was.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { cleanupTempDir, makeNaxConfig, makeTempDir, makeTestRuntime } from "@test/helpers";
import { _storyOrchestratorDeps } from "@/execution";
import { productionTriageSeam } from "@/execution/story-orchestrator/flake-triage-seam";
import type { Finding } from "@/findings";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import { FLAKE_TRIAGE_SKIP_EVENT } from "@/verification";
import { _flakeTriageDeps } from "@/verification/flake-triage";

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
      },
    };
  }

  test("flakeDetection.enabled=false passes findings through unchanged (no git calls)", async () => {
    const config = makeNaxConfig({ execution: { flakeDetection: { enabled: false } } });
    const { ctx } = makeCtx(config);
    const findings = [makeFailedTest()];
    const [result, report] = await productionTriageSeam(findings, {
      ctx,
      rawOutput: BUN_FAIL_OUTPUT,
      scope: "blocking-gate",
    });
    expect(result).toEqual(findings);
    expect(report.quarantinedKeys).toEqual([]);
  });

  test("unknown framework passes findings through unchanged", async () => {
    const config = makeNaxConfig({ execution: { flakeDetection: { enabled: true } } });
    const { ctx } = makeCtx(config);
    const findings = [makeFailedTest()];
    const [result, report] = await productionTriageSeam(findings, {
      ctx,
      rawOutput: "totally unrecognized output",
      scope: "blocking-gate",
    });
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
    const [result] = await productionTriageSeam(findings, { ctx, rawOutput: BUN_FAIL_OUTPUT, scope: "blocking-gate" });

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
    const [result, report] = await productionTriageSeam(findings, {
      ctx,
      rawOutput: BUN_FAIL_OUTPUT,
      scope: "blocking-gate",
    });

    expect(probeCalled).toBe(true);
    expect(result[0]?.category).toBe("flaky-test");
    expect(report.quarantinedKeys.length).toBe(1);
  });

  test("is wired as the production seam in _storyOrchestratorDeps.triage", () => {
    expect(_storyOrchestratorDeps.triage).toBe(productionTriageSeam);
  });

  // ── #1657 — skip telemetry ────────────────────────────────────────────────
  //
  // Each seam bail-out leaves the surviving findings indistinguishable from
  // deterministic failures for the repo-scoped-test-fix fallthrough (#1656).
  // Count them so the decision to thread `flakeTriageRan` through the blocking
  // cycle can be made on data.
  describe("skip telemetry (#1657)", () => {
    let entries: LogEntry[];
    let unsubscribe: () => void;

    beforeEach(() => {
      resetLogger();
      initLogger({ level: "silent" });
      entries = [];
      unsubscribe = addSink((entry) => entries.push(entry));
    });

    afterEach(() => {
      unsubscribe();
      resetLogger();
    });

    function skips(): LogEntry[] {
      return entries.filter((e) => e.data?.event === FLAKE_TRIAGE_SKIP_EVENT);
    }

    test("unknown framework emits a framework-undetected counter", async () => {
      const config = makeNaxConfig({ execution: { flakeDetection: { enabled: true } } });
      const { ctx } = makeCtx(config);
      await productionTriageSeam([makeFailedTest(), makeFailedTest({ rule: "shouldBaz" })], {
        ctx,
        rawOutput: "totally unrecognized output",
        scope: "nbf",
      });

      expect(skips().length).toBe(1);
      expect(skips()[0]?.data?.reason).toBe("framework-undetected");
      // The caller's cycle must survive into the row: an nbf skip can never
      // dispatch repo-scoped-test-fix, so #1657 §3 must be able to exclude it.
      expect(skips()[0]?.data?.scope).toBe("nbf");
      expect(skips()[0]?.data?.candidateCount).toBe(2);
      expect(skips()[0]?.data?.candidateBasis).toBe("gate-findings");
      expect(skips()[0]?.data?.storyId).toBe("US-003");
    });

    test("an unresolvable baseline diff emits a baseline-diff-unresolved counter", async () => {
      // `workdir` is an initialized repo with no commits — `getMergeBase()`
      // exhausts every fallback, so `resolveFlakeBaselineDiff` returns null.
      const config = makeNaxConfig({
        execution: { flakeDetection: { enabled: true } },
        quality: { commands: { test: "bun test" } },
      });
      const { ctx } = makeCtx(config);
      const [result, report] = await productionTriageSeam([makeFailedTest()], {
        ctx,
        rawOutput: BUN_FAIL_OUTPUT,
        scope: "blocking-gate",
      });

      expect(report.flakeTriageRan).toBe(false);
      expect(result[0]?.category).toBe("failed-test");
      expect(skips().length).toBe(1);
      expect(skips()[0]?.data?.reason).toBe("baseline-diff-unresolved");
      expect(skips()[0]?.data?.candidateCount).toBe(1);
    });

    test("a thrown context resolution emits a context-error counter carrying the message", async () => {
      const config = makeNaxConfig({
        execution: { flakeDetection: { enabled: true } },
        quality: { commands: { test: "bun test" } },
      });
      const { ctx } = makeCtx(config);
      // `packageView` is read before the try block; make the inner resolution throw
      // by removing the runtime the quality resolver walks.
      // The point of this test is a ctx the type system forbids: no factory can
      // produce a runtime-less CallContext.
      const brokenCtx = { ...ctx, runtime: undefined } as unknown as typeof ctx; // test-ratchet-allow: as-unknown-as

      const [, report] = await productionTriageSeam([makeFailedTest()], {
        ctx: brokenCtx,
        rawOutput: BUN_FAIL_OUTPUT,
        scope: "blocking-gate",
      });

      expect(report.flakeTriageRan).toBe(false);
      expect(skips().length).toBe(1);
      expect(skips()[0]?.data?.reason).toBe("context-error");
      expect(typeof skips()[0]?.data?.error).toBe("string");
    });

    // Without this case the `no-test-command` emit could be deleted and the
    // suite would stay green — the only other reference to it is a direct call
    // in the telemetry module's own test, which exercises the logger wrapper.
    test("a package with no resolvable test command emits a no-test-command counter", async () => {
      await Bun.write(`${workdir}/pre-existing.test.ts`, "test('shouldBar', () => {});\n");
      git(workdir, "add", ".");
      git(workdir, "commit", "-q", "-m", "baseline");

      const config = makeNaxConfig({ execution: { flakeDetection: { enabled: true } } });
      // makeNaxConfig seeds quality.commands.test; unset it so neither the
      // resolver nor the config fallback yields a base command.
      const withoutTestCommand = {
        ...config,
        quality: { ...config.quality, commands: { ...config.quality?.commands, test: undefined } },
      };
      const { ctx } = makeCtx(withoutTestCommand as typeof config);

      const [, report] = await productionTriageSeam([makeFailedTest()], {
        ctx,
        rawOutput: BUN_FAIL_OUTPUT,
        scope: "blocking-gate",
      });

      expect(report.flakeTriageRan).toBe(false);
      expect(skips().length).toBe(1);
      expect(skips()[0]?.data?.reason).toBe("no-test-command");
      expect(skips()[0]?.data?.scope).toBe("blocking-gate");
    });

    test("flakeDetection disabled emits nothing — an operator opt-out is not a gap", async () => {
      const config = makeNaxConfig({ execution: { flakeDetection: { enabled: false } } });
      const { ctx } = makeCtx(config);
      await productionTriageSeam([makeFailedTest()], { ctx, rawOutput: BUN_FAIL_OUTPUT, scope: "blocking-gate" });

      expect(skips().length).toBe(0);
    });

    test("a completed triage emits no skip counter", async () => {
      await Bun.write(`${workdir}/pre-existing.test.ts`, "test('shouldBar', () => {});\n");
      git(workdir, "add", ".");
      git(workdir, "commit", "-q", "-m", "baseline");
      git(workdir, "checkout", "-q", "-b", "feature");
      await Bun.write(`${workdir}/unrelated.ts`, "export const x = 1;\n");
      git(workdir, "add", ".");
      git(workdir, "commit", "-q", "-m", "story touches something else entirely");
      _flakeTriageDeps.runFlakeProbe = async () => ({
        verdict: "consistent-failure",
        probeRuns: 2,
        attributableRuns: 2,
      });

      const config = makeNaxConfig({
        execution: { flakeDetection: { enabled: true } },
        quality: { commands: { test: "bun test" } },
      });
      const { ctx } = makeCtx(config);
      const [, report] = await productionTriageSeam([makeFailedTest({ file: "pre-existing.test.ts" })], {
        ctx,
        rawOutput: BUN_FAIL_OUTPUT,
        scope: "blocking-gate",
      });

      expect(report.flakeTriageRan).toBe(true);
      expect(skips().length).toBe(0);
    });
  });
});
