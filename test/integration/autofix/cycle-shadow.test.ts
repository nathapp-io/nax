/**
 * Integration test: shadow mode writes valid divergence reports when cycleV2 is active.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "path";
import { DEFAULT_CONFIG } from "../../../src/config";
import { _cycleDeps } from "../../../src/findings";
import { _autofixDeps } from "../../../src/pipeline/stages/autofix";
import { runAgentRectificationV2 } from "../../../src/pipeline/stages/autofix-cycle";
import type { PipelineContext } from "../../../src/pipeline/types";
import type { ReviewCheckResult } from "../../../src/review/types";
import { makeMockAgentManager, makeMockRuntime } from "../../helpers";
import { makeTempDir, cleanupTempDir } from "../../helpers/temp";

function failedCheck(check: ReviewCheckResult["check"], output = `${check} failed`): ReviewCheckResult {
  return { check, success: false, command: "nax review", exitCode: 1, output, durationMs: 1 };
}

let tmpDir: string;
let savedRecheck: typeof _autofixDeps.recheckReview;
let savedCycleCallOp: typeof _cycleDeps.callOp;

beforeEach(() => {
  tmpDir = makeTempDir("cycle-shadow-test");
  savedRecheck = _autofixDeps.recheckReview;
  savedCycleCallOp = _cycleDeps.callOp;
});

afterEach(() => {
  _autofixDeps.recheckReview = savedRecheck;
  _cycleDeps.callOp = savedCycleCallOp;
  cleanupTempDir(tmpDir);
});

function makeCtx(workdir: string): PipelineContext {
  const runtime = makeMockRuntime({ config: { ...DEFAULT_CONFIG, outputDir: join(workdir, ".nax") } });
  return {
    config: {
      ...DEFAULT_CONFIG,
      quality: {
        ...DEFAULT_CONFIG.quality,
        autofix: { enabled: true, maxAttempts: 2, maxTotalAttempts: 4, cycleV2: true },
      },
    } as PipelineContext["config"],
    prd: { feature: "shadow-test", stories: [] } as unknown as PipelineContext["prd"],
    story: { id: "US-shadow-1", title: "shadow test", status: "in-progress", acceptanceCriteria: [] } as unknown as PipelineContext["story"],
    stories: [],
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    rootConfig: DEFAULT_CONFIG,
    workdir,
    projectDir: workdir,
    hooks: {} as unknown as PipelineContext["hooks"],
    runtime,
    agentManager: makeMockAgentManager({}),
    sessionManager: runtime.sessionManager,
    abortSignal: runtime.signal,
    reviewResult: {
      success: false,
      checks: [failedCheck("lint", "lint failure")],
    } as unknown as PipelineContext["reviewResult"],
  };
}

describe("autofix-cycle shadow mode", () => {
  test("writes shadow report JSON to .nax/cycle-shadow/<storyId>/ when cycleV2 runs", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    _cycleDeps.callOp = async (): Promise<any> => ({ applied: true });
    _autofixDeps.recheckReview = async (ctx: PipelineContext) => {
      ctx.reviewResult = { success: true, checks: [] } as unknown as PipelineContext["reviewResult"];
      return true;
    };

    const ctx = makeCtx(tmpDir);
    await runAgentRectificationV2(ctx, undefined, undefined, tmpDir);

    const shadowDir = join(tmpDir, ".nax", "cycle-shadow", "US-shadow-1");
    const glob = new Bun.Glob("*.json");
    const files = [...glob.scanSync({ cwd: shadowDir, absolute: true })];

    expect(files.length).toBeGreaterThanOrEqual(1);

    const content = await Bun.file(files[0]!).json();
    expect(content.storyId).toBe("US-shadow-1");
    expect(typeof content.exitReason).toBe("string");
    expect(typeof content.iterations).toBe("number");
    expect(typeof content.finalFindingsCount).toBe("number");
  });

  test("shadow report records resolved exit reason when cycle resolves", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    _cycleDeps.callOp = async (): Promise<any> => ({ applied: true });
    _autofixDeps.recheckReview = async (ctx: PipelineContext) => {
      ctx.reviewResult = { success: true, checks: [] } as unknown as PipelineContext["reviewResult"];
      return true;
    };

    const ctx = makeCtx(tmpDir);
    await runAgentRectificationV2(ctx, undefined, undefined, tmpDir);

    const shadowDir = join(tmpDir, ".nax", "cycle-shadow", "US-shadow-1");
    const glob = new Bun.Glob("*.json");
    const files = [...glob.scanSync({ cwd: shadowDir, absolute: true })];
    const content = await Bun.file(files[0]!).json();

    expect(content.exitReason).toBe("resolved");
    expect(content.finalFindingsCount).toBe(0);
  });
});
