/**
 * Tests for resolvePlanMode() and the pipeline branch stub in planCommand().
 * Split from plan.test.ts to stay within the 600-line file limit.
 * Covers AC8–AC14 of the config.plan.mode schema + pipeline branch stub story.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  assertDefined,
  assertNaxError,
  makeLogger,
  makeMockAgentManager,
  makeMockRuntime,
  makeTempDir,
} from "@test/helpers";
import { _planDeps, planCommand, resolvePlanMode } from "@/cli";
import type { NaxConfig } from "@/config";
import { DEFAULT_CONFIG } from "@/config";
import { NaxError } from "@/errors";

// DEFAULT_CONFIG.debate is typed optional (Zod `.optional().default(...)`) but
// always populated at runtime — narrow once so the spreads below stay fully typed.
const DEFAULT_DEBATE = DEFAULT_CONFIG.debate;
assertDefined(DEFAULT_DEBATE, "DEFAULT_CONFIG.debate");

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const origReadFile = _planDeps.readFile;
const origWriteFile = _planDeps.writeFile;
const origScanSourceRoots = _planDeps.scanSourceRoots;
const origCreateRuntime = _planDeps.createRuntime;
const origReadPackageJson = _planDeps.readPackageJson;
const origSpawnSync = _planDeps.spawnSync;
const origMkdirp = _planDeps.mkdirp;
const origExistsSync = _planDeps.existsSync;
const origGetLogger = _planDeps.getLogger;

function makeMinimalConfig(overrides: Partial<NaxConfig> = {}): NaxConfig {
  return { ...DEFAULT_CONFIG, ...overrides } as NaxConfig;
}

// ─────────────────────────────────────────────────────────────────────────────
// resolvePlanMode (AC8–AC12)
// ─────────────────────────────────────────────────────────────────────────────

describe("resolvePlanMode", () => {
  // AC8: explicit plan.mode === "pipeline"
  test("AC8: explicit plan.mode pipeline returns pipeline", () => {
    const config = makeMinimalConfig({ plan: { ...DEFAULT_CONFIG.plan, mode: "pipeline" } });
    expect(resolvePlanMode(config)).toBe("pipeline");
  });

  // AC9: explicit plan.mode wins over debate.enabled
  test("AC9: explicit plan.mode single wins over debate.enabled", () => {
    const config = makeMinimalConfig({
      plan: { ...DEFAULT_CONFIG.plan, mode: "single" },
      debate: {
        ...DEFAULT_DEBATE,
        enabled: true,
        stages: { ...DEFAULT_DEBATE.stages, plan: { ...DEFAULT_DEBATE.stages.plan, enabled: true } },
      },
    });
    expect(resolvePlanMode(config)).toBe("single");
  });

  // AC10: legacy debate precedence when no explicit mode
  test("AC10: debate.enabled + stages.plan.enabled returns debate when mode absent", () => {
    const config = makeMinimalConfig({
      debate: {
        ...DEFAULT_DEBATE,
        enabled: true,
        stages: { ...DEFAULT_DEBATE.stages, plan: { ...DEFAULT_DEBATE.stages.plan, enabled: true } },
      },
    });
    expect(resolvePlanMode(config)).toBe("debate");
  });

  // AC11: empty config returns single
  test("AC11: empty config returns single", () => {
    expect(resolvePlanMode({} as NaxConfig)).toBe("single");
  });

  // AC12: debate.enabled true but stages.plan.enabled false → single
  test("AC12: debate.enabled true but stages.plan.enabled false returns single", () => {
    const config = makeMinimalConfig({
      debate: {
        ...DEFAULT_DEBATE,
        enabled: true,
        stages: { ...DEFAULT_DEBATE.stages, plan: { ...DEFAULT_DEBATE.stages.plan, enabled: false } },
      },
    });
    expect(resolvePlanMode(config)).toBe("single");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// pipeline branch stub (AC13–AC14)
// ─────────────────────────────────────────────────────────────────────────────

describe("planCommand — pipeline branch stub", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = makeTempDir("nax-plan-pipeline-test-");
    await mkdir(join(tmpDir, ".nax"), { recursive: true });

    _planDeps.readFile = mock(async () => "# spec");
    _planDeps.writeFile = mock(async () => {});
    _planDeps.scanSourceRoots = mock(async () => []);
    _planDeps.readPackageJson = mock(async () => ({ name: "my-project" }));
    _planDeps.spawnSync = mock(() => ({ stdout: Buffer.from(""), exitCode: 1 }));
    _planDeps.mkdirp = mock(async () => {});
    _planDeps.existsSync = mock((path: string) => path.endsWith(".nax"));
    _planDeps.createRuntime = mock(() => makeMockRuntime({ agentManager: makeMockAgentManager() }));
  });

  afterEach(async () => {
    mock.restore();
    _planDeps.readFile = origReadFile;
    _planDeps.writeFile = origWriteFile;
    _planDeps.scanSourceRoots = origScanSourceRoots;
    _planDeps.createRuntime = origCreateRuntime;
    _planDeps.readPackageJson = origReadPackageJson;
    _planDeps.spawnSync = origSpawnSync;
    _planDeps.mkdirp = origMkdirp;
    _planDeps.existsSync = origExistsSync;
    _planDeps.getLogger = origGetLogger;
    await rm(tmpDir, { recursive: true, force: true });
  });

  // AC13: pipeline mode throws PLAN_PIPELINE_GROUND_FAILED (grounder fails with mock runtime)
  test("AC13: pipeline mode throws NaxError PLAN_PIPELINE_GROUND_FAILED", async () => {
    const config = makeMinimalConfig({ plan: { ...DEFAULT_CONFIG.plan, mode: "pipeline" } });

    let thrown: unknown;
    try {
      await planCommand(tmpDir, config, { from: "/spec.md", feature: "my-feature" });
    } catch (err) {
      thrown = err;
    }

    assertNaxError(thrown);
    expect(thrown.code).toBe("PLAN_PIPELINE_GROUND_FAILED");
    expect(thrown.context?.stage).toBe("plan");
  });

  // AC14: pipeline mode + debate.enabled emits one logger.warn then throws
  test("AC14: pipeline mode + debate.enabled emits logger.warn once before throwing", async () => {
    const logger = makeLogger();
    _planDeps.getLogger = () => logger;

    const config = makeMinimalConfig({
      plan: { ...DEFAULT_CONFIG.plan, mode: "pipeline" },
      debate: {
        ...DEFAULT_DEBATE,
        enabled: true,
        stages: { ...DEFAULT_DEBATE.stages, plan: { ...DEFAULT_DEBATE.stages.plan, enabled: true } },
      },
    });

    await expect(planCommand(tmpDir, config, { from: "/spec.md", feature: "my-feature" })).rejects.toBeInstanceOf(
      NaxError,
    );

    const warnCalls = logger.calls.filter((c) => c.level === "warn" && c.stage === "plan");
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]?.data).toMatchObject({ mode: "pipeline", debateEnabled: true });
  });
});
