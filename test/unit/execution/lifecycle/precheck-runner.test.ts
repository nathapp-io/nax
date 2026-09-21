/**
 * Unit tests for src/execution/lifecycle/precheck-runner.ts
 *
 * Exercises runPrecheckValidation() directly (rather than through the full
 * `run()` pipeline) so the pass/warning/blocker/story-size-gate branches can
 * be driven without gating on FULL=1. Runs the real `runPrecheck()` against
 * real temp-dir git repos — no mock.module().
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupTempDir,
  makeNaxConfig,
  makePRD,
  makeSpawn,
  makeStory,
  makeTempDir,
  withDepsRestore,
} from "@test/helpers";
import { runPrecheckValidation } from "@/execution/lifecycle/precheck-runner";
import { StatusWriter } from "@/execution/status-writer";
import { InteractionChain } from "@/interaction/chain";
import type { InteractionPlugin, InteractionRequest, InteractionResponse } from "@/interaction/types";
import type { PRD } from "@/prd/types";
import { _precheckDeps } from "@/precheck";
import { _deps as _cliDeps } from "@/precheck/checks-blockers";

let tmpDir: string;
let origNaxPrecheck: string | undefined;

withDepsRestore(_cliDeps, ["spawn"]);

beforeEach(() => {
  tmpDir = makeTempDir("nax-precheck-runner-test-");
  origNaxPrecheck = process.env.NAX_PRECHECK;
  // The agent/claude CLI binary is not guaranteed to be on PATH in CI —
  // stub it so these tests exercise runPrecheckValidation's own branches
  // rather than the environment's.
  _cliDeps.spawn = makeSpawn(() => ({ exitCode: 0 })).spawn;
});

afterEach(() => {
  if (origNaxPrecheck === undefined) {
    delete process.env.NAX_PRECHECK;
  } else {
    process.env.NAX_PRECHECK = origNaxPrecheck;
  }
  cleanupTempDir(tmpDir);
});

async function setupGitRepo(dir: string): Promise<void> {
  await Bun.spawn(["git", "init"], { cwd: dir, stdout: "ignore", stderr: "ignore" }).exited;
  await Bun.spawn(["git", "config", "user.name", "Test"], { cwd: dir, stdout: "ignore", stderr: "ignore" }).exited;
  await Bun.spawn(["git", "config", "user.email", "test@test.com"], { cwd: dir, stdout: "ignore", stderr: "ignore" })
    .exited;
  await Bun.write(join(dir, "README.md"), "# Test");
  await Bun.write(join(dir, "package.json"), JSON.stringify({ name: "test" }));
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  await Bun.spawn(["git", "add", "."], { cwd: dir, stdout: "ignore", stderr: "ignore" }).exited;
  await Bun.spawn(["git", "commit", "-m", "init"], { cwd: dir, stdout: "ignore", stderr: "ignore" }).exited;
}

function makeStatusWriter(dir: string): StatusWriter {
  return new StatusWriter(join(dir, "status.json"), makeNaxConfig(), {
    runId: "test-run",
    feature: "test-feature",
    startedAt: new Date().toISOString(),
    dryRun: true,
    startTimeMs: Date.now(),
    pid: process.pid,
  });
}

function makePrd(overrides: Partial<PRD> = {}): PRD {
  return makePRD({ feature: "test-feature", userStories: [makeStory()], ...overrides });
}

/** Auto-responding interaction plugin — always answers the given action. */
function makeAutoInteractionPlugin(action: "approve" | "skip" | "abort"): InteractionPlugin {
  return {
    name: "auto-test-plugin",
    async send(_request: InteractionRequest): Promise<void> {},
    async receive(requestId: string): Promise<InteractionResponse> {
      return { requestId, action, respondedAt: Date.now() };
    },
  };
}

describe("runPrecheckValidation", () => {
  test("skips validation entirely when NAX_PRECHECK is not '1'", async () => {
    delete process.env.NAX_PRECHECK;

    // No git repo at all — if precheck actually ran, this would throw.
    await expect(
      runPrecheckValidation({
        config: makeNaxConfig(),
        prd: makePrd(),
        workdir: tmpDir,
        statusWriter: makeStatusWriter(tmpDir),
        headless: false,
        formatterMode: "normal",
      }),
    ).resolves.toBeUndefined();
  });

  test("throws and writes precheck-failed status on a Tier 1 blocker", async () => {
    process.env.NAX_PRECHECK = "1";
    // tmpDir has no .git — git-repo-exists blocker fires immediately.
    const statusWriter = makeStatusWriter(tmpDir);
    const logFilePath = join(tmpDir, "runs", "test.jsonl");

    await expect(
      runPrecheckValidation({
        config: makeNaxConfig(),
        prd: makePrd(),
        workdir: tmpDir,
        statusWriter,
        headless: false,
        formatterMode: "normal",
        logFilePath,
      }),
    ).rejects.toThrow("Precheck failed");

    expect(existsSync(logFilePath)).toBe(true);
    const logged = JSON.parse(readFileSync(logFilePath, "utf8").trim().split("\n")[0]);
    expect(logged.type).toBe("precheck");
    expect(logged.passed).toBe(false);
    expect(logged.blockers.length).toBeGreaterThan(0);
  });

  test("passes with warnings (no CLAUDE.md) and logs the warning summary in headless mode", async () => {
    process.env.NAX_PRECHECK = "1";
    await setupGitRepo(tmpDir);

    await expect(
      runPrecheckValidation({
        config: makeNaxConfig(),
        prd: makePrd(),
        workdir: tmpDir,
        statusWriter: makeStatusWriter(tmpDir),
        headless: true,
        formatterMode: "normal",
      }),
    ).resolves.toBeUndefined();
  });

  test("passes with warnings but skips terminal output when formatterMode is 'json'", async () => {
    process.env.NAX_PRECHECK = "1";
    await setupGitRepo(tmpDir);

    await expect(
      runPrecheckValidation({
        config: makeNaxConfig(),
        prd: makePrd(),
        workdir: tmpDir,
        statusWriter: makeStatusWriter(tmpDir),
        headless: true,
        formatterMode: "json",
      }),
    ).resolves.toBeUndefined();
  });

  test("prompts via the interaction chain for a flagged story and honors 'approve'", async () => {
    process.env.NAX_PRECHECK = "1";
    await setupGitRepo(tmpDir);
    await Bun.write(join(tmpDir, "CLAUDE.md"), "# Project");
    await Bun.spawn(["git", "add", "."], { cwd: tmpDir, stdout: "ignore", stderr: "ignore" }).exited;
    await Bun.spawn(["git", "commit", "-m", "add claude md"], { cwd: tmpDir, stdout: "ignore", stderr: "ignore" })
      .exited;

    const bigStory = makeStory({
      id: "US-BIG",
      acceptanceCriteria: Array.from({ length: 15 }, (_, i) => `AC ${i}`),
    });
    const prd = makePrd({ userStories: [bigStory] });

    const chain = new InteractionChain({ defaultTimeout: 5000, defaultFallback: "escalate" });
    chain.register(makeAutoInteractionPlugin("approve"));

    await runPrecheckValidation({
      config: makeNaxConfig({ precheck: { storySizeGate: { action: "warn" } } }),
      prd,
      workdir: tmpDir,
      statusWriter: makeStatusWriter(tmpDir),
      headless: false,
      formatterMode: "normal",
      interactionChain: chain,
      featureName: "test-feature",
    });

    expect(bigStory.status).not.toBe("skipped");
  });

  test("skips flagged-story prompts (with a warning log) when no interaction chain is provided", async () => {
    process.env.NAX_PRECHECK = "1";
    await setupGitRepo(tmpDir);
    await Bun.write(join(tmpDir, "CLAUDE.md"), "# Project");
    await Bun.spawn(["git", "add", "."], { cwd: tmpDir, stdout: "ignore", stderr: "ignore" }).exited;
    await Bun.spawn(["git", "commit", "-m", "add claude md"], { cwd: tmpDir, stdout: "ignore", stderr: "ignore" })
      .exited;

    const bigStory = makeStory({
      id: "US-BIG",
      acceptanceCriteria: Array.from({ length: 15 }, (_, i) => `AC ${i}`),
    });
    const prd = makePrd({ userStories: [bigStory] });

    await expect(
      runPrecheckValidation({
        config: makeNaxConfig({ precheck: { storySizeGate: { action: "warn" } } }),
        prd,
        workdir: tmpDir,
        statusWriter: makeStatusWriter(tmpDir),
        headless: false,
        formatterMode: "normal",
      }),
    ).resolves.toBeUndefined();
  });

  test("aborts and throws when the user selects 'abort' on a flagged story", async () => {
    process.env.NAX_PRECHECK = "1";
    await setupGitRepo(tmpDir);
    await Bun.write(join(tmpDir, "CLAUDE.md"), "# Project");
    await Bun.spawn(["git", "add", "."], { cwd: tmpDir, stdout: "ignore", stderr: "ignore" }).exited;
    await Bun.spawn(["git", "commit", "-m", "add claude md"], { cwd: tmpDir, stdout: "ignore", stderr: "ignore" })
      .exited;

    const bigStory = makeStory({
      id: "US-BIG",
      acceptanceCriteria: Array.from({ length: 15 }, (_, i) => `AC ${i}`),
    });
    const prd = makePrd({ userStories: [bigStory] });

    const chain = new InteractionChain({ defaultTimeout: 5000, defaultFallback: "escalate" });
    chain.register(makeAutoInteractionPlugin("abort"));

    await expect(
      runPrecheckValidation({
        config: makeNaxConfig({ precheck: { storySizeGate: { action: "warn" } } }),
        prd,
        workdir: tmpDir,
        statusWriter: makeStatusWriter(tmpDir),
        headless: false,
        formatterMode: "normal",
        interactionChain: chain,
        featureName: "test-feature",
      }),
    ).rejects.toThrow("Run aborted by user");
  });

  // =========================================================================
  // US-003 AC13/AC14/AC15: thread the feature lock through to checkStaleLock
  // only when the run has a feature name. The environment precheck has no
  // feature and so keeps today's checkout-only behaviour.
  // =========================================================================

  describe("US-003: feature lock threading", () => {
    let savedCheckStaleLock: typeof _precheckDeps.checkStaleLock | undefined;
    let calls: { workdir: string; featureLock: unknown }[];

    beforeEach(() => {
      calls = [];
      savedCheckStaleLock = _precheckDeps.checkStaleLock;
      _precheckDeps.checkStaleLock = (async (workdir: string, featureLock?: { outputDir: string; feature: string }) => {
        calls.push({ workdir, featureLock });
        return {
          name: "no-stale-lock",
          tier: "blocker",
          passed: true,
          message: "No lock file present",
        };
      }) as typeof _precheckDeps.checkStaleLock;
    });

    afterEach(() => {
      if (savedCheckStaleLock) {
        _precheckDeps.checkStaleLock = savedCheckStaleLock;
      }
    });

    test("AC14: passes the run's feature and output directory through to checkStaleLock", async () => {
      process.env.NAX_PRECHECK = "1";
      await setupGitRepo(tmpDir);
      const featureName = "auth";

      await runPrecheckValidation({
        config: makeNaxConfig(),
        prd: makePrd({ feature: featureName }),
        workdir: tmpDir,
        statusWriter: makeStatusWriter(tmpDir),
        headless: true,
        formatterMode: "normal",
        featureName,
      });

      const staleCall = calls.find((c) => c.featureLock !== undefined);
      expect(staleCall).toBeDefined();
      // The runner must pass a featureLock whose `feature` is the run's
      // feature and whose `outputDir` is the project's resolved output dir.
      const lock = staleCall?.featureLock as { outputDir: string; feature: string };
      expect(lock.feature).toBe(featureName);
      expect(typeof lock.outputDir).toBe("string");
      expect(lock.outputDir.length).toBeGreaterThan(0);
    });

    test("AC15: omits the feature lock argument when the run has no feature name", async () => {
      process.env.NAX_PRECHECK = "1";
      await setupGitRepo(tmpDir);

      await runPrecheckValidation({
        config: makeNaxConfig(),
        prd: makePrd(),
        workdir: tmpDir,
        statusWriter: makeStatusWriter(tmpDir),
        headless: true,
        formatterMode: "normal",
        // no featureName — represents the `nax plan` path with no feature.
      });

      const staleCalls = calls.filter((c) => c.featureLock !== undefined);
      expect(staleCalls.length).toBe(0);
    });

    test("AC13 (boundary): when the environment precheck composes its early blockers, no feature lock is threaded", async () => {
      // runEnvironmentPrecheck is the no-PRD path used by `nax plan` — it
      // composes its early blockers from getEarlyEnvironmentBlockers. The
      // composition must NOT pass a featureLock, even if a featureLock were
      // available — that path has no feature context.
      process.env.NAX_PRECHECK = "1";
      await setupGitRepo(tmpDir);

      const { runEnvironmentPrecheck } = await import("@/precheck");
      const result = await runEnvironmentPrecheck(makeNaxConfig(), tmpDir, { silent: true });

      expect(result.passed).toBe(true);
      const staleCalls = calls.filter((c) => c.featureLock !== undefined);
      expect(staleCalls.length).toBe(0);
    });
  });
});
