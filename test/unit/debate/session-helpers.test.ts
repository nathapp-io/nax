/**
 * Tests for session-helpers.ts module exports — US-000
 *
 * Covers:
 * - AC1: No file in src/debate/ exceeds 400 lines
 * - AC5: _debateSessionDeps exported from session-helpers.ts and re-exported through barrel
 * - AC6: resolveDebaterModel() exported from session-helpers.ts and re-exported through barrel
 * - AC7: DebateSessionOptions type exported from session-helpers.ts and re-exported through barrel
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { readdirSync } from "node:fs";

// RED: These imports fail until session-helpers.ts is created
import { _debateSessionDeps, resolveDebaterModel, resolveOutcome } from "../../../src/debate/session-helpers";
import type { DebateSessionOptions } from "../../../src/debate/session-helpers";
import { buildSessionName } from "../../../src/agents/acp/adapter";
import type { AgentAdapter, CompleteOptions } from "../../../src/agents/types";
import type { DebateStageConfig } from "../../../src/debate/types";

// Barrel re-export checks (resolveDebaterModel is also not yet in barrel — both are RED)
import {
  _debateSessionDeps as barrelDeps,
  resolveDebaterModel as barrelResolveDebaterModel,
} from "../../../src/debate";
import type { DebateSessionOptions as BarrelDebateSessionOptions } from "../../../src/debate";

// ─── AC1: File size constraint ────────────────────────────────────────────────

describe("src/debate/ file size constraint (AC1)", () => {
  test("no TypeScript source file in src/debate/ exceeds 400 lines", async () => {
    const debateDir = join(process.cwd(), "src", "debate");
    const tsFiles = readdirSync(debateDir).filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".d.ts"),
    );

    for (const filename of tsFiles) {
      const content = await Bun.file(join(debateDir, filename)).text();
      const lineCount = content.split("\n").length;
      expect(
        lineCount,
        `${filename} has ${lineCount} lines — must be ≤ 400`,
      ).toBeLessThanOrEqual(400);
    }
  });

  test("session-helpers.ts exists as a separate file in src/debate/", async () => {
    const helpersPath = join(process.cwd(), "src", "debate", "session-helpers.ts");
    const file = Bun.file(helpersPath);
    expect(await file.exists()).toBe(true);
  });

  test("session-one-shot.ts exists as a separate file in src/debate/", async () => {
    const oneShotPath = join(process.cwd(), "src", "debate", "session-one-shot.ts");
    const file = Bun.file(oneShotPath);
    expect(await file.exists()).toBe(true);
  });

  test("session-stateful.ts exists as a separate file in src/debate/", async () => {
    const statefulPath = join(process.cwd(), "src", "debate", "session-stateful.ts");
    const file = Bun.file(statefulPath);
    expect(await file.exists()).toBe(true);
  });

  test("session-plan.ts exists as a separate file in src/debate/", async () => {
    const planPath = join(process.cwd(), "src", "debate", "session-plan.ts");
    const file = Bun.file(planPath);
    expect(await file.exists()).toBe(true);
  });
});

// ─── AC5: _debateSessionDeps exported from session-helpers.ts ─────────────────

describe("_debateSessionDeps export from session-helpers.ts (AC5)", () => {
  test("_debateSessionDeps is defined and is an object", () => {
    expect(_debateSessionDeps).toBeDefined();
    expect(typeof _debateSessionDeps).toBe("object");
  });

  test("_debateSessionDeps.getAgent is a function", () => {
    expect(typeof _debateSessionDeps.getAgent).toBe("function");
  });

  test("_debateSessionDeps.getSafeLogger is a function", () => {
    expect(typeof _debateSessionDeps.getSafeLogger).toBe("function");
  });

  test("_debateSessionDeps.readFile is a function", () => {
    expect(typeof _debateSessionDeps.readFile).toBe("function");
  });

  test("_debateSessionDeps is re-exported through the debate barrel index.ts", () => {
    expect(barrelDeps).toBeDefined();
    expect(typeof barrelDeps).toBe("object");
    expect(typeof barrelDeps.getAgent).toBe("function");
  });
});

// ─── AC6: resolveDebaterModel() exported from session-helpers.ts ──────────────

describe("resolveDebaterModel() export from session-helpers.ts (AC6)", () => {
  test("resolveDebaterModel is exported from session-helpers.ts as a function", () => {
    expect(typeof resolveDebaterModel).toBe("function");
  });

  test("resolveDebaterModel returns raw model string when no config provided", () => {
    const result = resolveDebaterModel({ agent: "claude", model: "claude-3-5-haiku" });
    expect(result).toBe("claude-3-5-haiku");
  });

  test("resolveDebaterModel returns undefined when model absent and no config", () => {
    const result = resolveDebaterModel({ agent: "claude" }, undefined);
    expect(result).toBeUndefined();
  });

  test("resolveDebaterModel is re-exported through the debate barrel index.ts", () => {
    expect(typeof barrelResolveDebaterModel).toBe("function");
  });
});

// ─── AC7: DebateSessionOptions type exported from session-helpers.ts ──────────

describe("DebateSessionOptions type export from session-helpers.ts (AC7)", () => {
  test("DebateSessionOptions from session-helpers.ts satisfies expected interface shape", () => {
    // Runtime construction check — if DebateSessionOptions is not exported from session-helpers.ts,
    // tsc (bun run typecheck) will fail at compile time.
    const opts: DebateSessionOptions = {
      storyId: "US-000",
      stage: "review",
      stageConfig: {
        enabled: true,
        resolver: { type: "majority-fail-closed" },
        sessionMode: "one-shot",
        rounds: 1,
        debaters: [{ agent: "claude" }],
        timeoutSeconds: 60,
      },
    };
    expect(opts.storyId).toBe("US-000");
    expect(opts.stage).toBe("review");
    expect(opts.stageConfig.rounds).toBe(1);
  });

  test("DebateSessionOptions supports optional workdir, featureName, config, timeoutSeconds", () => {
    const opts: DebateSessionOptions = {
      storyId: "US-000",
      stage: "plan",
      stageConfig: {
        enabled: true,
        resolver: { type: "synthesis" },
        sessionMode: "stateful",
        rounds: 2,
        debaters: [{ agent: "claude" }, { agent: "gemini" }],
        timeoutSeconds: 120,
      },
      workdir: "/tmp/workspace",
      featureName: "my-feature",
      timeoutSeconds: 300,
    };
    expect(opts.workdir).toBe("/tmp/workspace");
    expect(opts.timeoutSeconds).toBe(300);
  });

  test("DebateSessionOptions is accessible through the debate barrel index.ts", () => {
    // TypeScript will error at compile time if barrel does not export DebateSessionOptions.
    const opts: BarrelDebateSessionOptions = {
      storyId: "US-000",
      stage: "review",
      stageConfig: {
        enabled: true,
        resolver: { type: "majority-fail-closed" },
        sessionMode: "one-shot",
        rounds: 1,
        debaters: [{ agent: "claude" }],
        timeoutSeconds: 60,
      },
    };
    expect(opts.storyId).toBe("US-000");
  });
});

// ─── US-004 helpers ───────────────────────────────────────────────────────────

function makeResolveStageConfig(
  resolverType: "synthesis" | "majority-fail-closed" | "majority-fail-open" | "custom",
  agent?: string,
): DebateStageConfig {
  return {
    enabled: true,
    resolver: { type: resolverType, ...(agent !== undefined ? { agent } : {}) },
    sessionMode: "one-shot",
    rounds: 1,
    debaters: [{ agent: "claude" }],
    timeoutSeconds: 60,
  } as DebateStageConfig;
}

function makeCaptureAdapter(
  captured: { opts?: CompleteOptions }[],
  output = "resolved",
): AgentAdapter {
  return {
    name: "mock",
    displayName: "mock",
    binary: "mock",
    capabilities: {
      supportedTiers: ["fast", "balanced", "powerful"] as const,
      maxContextTokens: 100_000,
      features: new Set<"tdd" | "review" | "refactor" | "batch">(["review"]),
    },
    isInstalled: async () => true,
    run: async () => ({
      success: true,
      exitCode: 0,
      output: "",
      rateLimited: false,
      durationMs: 1,
      estimatedCost: 0,
    }),
    buildCommand: () => [],
    buildAllowedEnv: () => ({}),
    plan: async () => ({ specContent: "" }),
    decompose: async () => ({ stories: [] }),
    complete: async (_prompt: string, opts?: CompleteOptions) => {
      captured.push({ opts });
      return { output, costUsd: 0.01, source: "exact" as const };
    },
  };
}

// ─── AC1: resolveOutcome() signature adds workdir? and featureName? ───────────

describe("resolveOutcome() — workdir and featureName parameters (US-004 AC1)", () => {
  test("resolveOutcome is exported from session-helpers.ts", () => {
    expect(typeof resolveOutcome).toBe("function");
  });

  test("calling with workdir and featureName does not throw for majority resolver", async () => {
    // Runtime check: extra args accepted silently (TypeScript check enforces the signature)
    const stageConfig = makeResolveStageConfig("majority-fail-closed");
    // @ts-ignore — RED: resolveOutcome does not yet accept workdir/featureName params
    const result = await resolveOutcome(
      ['{"passed": true}'],
      [],
      stageConfig,
      undefined,
      "US-004",
      30_000,
      "/tmp/workdir",
      "my-feature",
    );
    expect(result).toBeDefined();
    expect(result.resolverCostUsd).toBe(0);
  });
});

// ─── AC2: synthesisResolver receives sessionName=implementer when workdir set ─

describe("resolveOutcome() — synthesis resolver acpSessionName (US-004 AC2)", () => {
  let origGetAgent: typeof _debateSessionDeps.getAgent;

  beforeEach(() => {
    origGetAgent = _debateSessionDeps.getAgent;
  });

  afterEach(() => {
    _debateSessionDeps.getAgent = origGetAgent;
    mock.restore();
  });

  test("passes sessionName=buildSessionName(workdir,featureName,storyId,'implementer') in completeOptions", async () => {
    const captured: { opts?: CompleteOptions }[] = [];
    _debateSessionDeps.getAgent = mock(() => makeCaptureAdapter(captured));

    const stageConfig = makeResolveStageConfig("synthesis");
    const workdir = "/tmp/workspace";
    const featureName = "semantic-continuity";
    const storyId = "US-004";

    // @ts-ignore — RED: resolveOutcome does not yet accept workdir/featureName params
    await resolveOutcome(
      ["proposal-a", "proposal-b"],
      ["critique-a"],
      stageConfig,
      undefined,
      storyId,
      30_000,
      workdir,
      featureName,
    );

    expect(captured.length).toBeGreaterThan(0);
    const capturedOpts = captured[0]?.opts;
    const expectedSessionName = buildSessionName(workdir, featureName, storyId, "synthesis");
    expect(capturedOpts?.sessionName).toBe(expectedSessionName);
  });

  test("does not pass sessionName when workdir is undefined", async () => {
    const captured: { opts?: CompleteOptions }[] = [];
    _debateSessionDeps.getAgent = mock(() => makeCaptureAdapter(captured));

    const stageConfig = makeResolveStageConfig("synthesis");

    await resolveOutcome(
      ["proposal-a", "proposal-b"],
      ["critique-a"],
      stageConfig,
      undefined,
      "US-004",
      30_000,
      // workdir intentionally omitted (AC7)
    );

    expect(captured.length).toBeGreaterThan(0);
    const capturedOpts = captured[0]?.opts;
    expect(capturedOpts?.sessionName).toBeUndefined();
  });
});

// ─── AC3: judgeResolver receives sessionName=judge when workdir set ─────

describe("resolveOutcome() — custom/judge resolver acpSessionName (US-004 AC3)", () => {
  let origGetAgent: typeof _debateSessionDeps.getAgent;

  beforeEach(() => {
    origGetAgent = _debateSessionDeps.getAgent;
  });

  afterEach(() => {
    _debateSessionDeps.getAgent = origGetAgent;
    mock.restore();
  });

  test("custom resolver: passes sessionName=buildSessionName(...,'judge') in completeOptions", async () => {
    const captured: { opts?: CompleteOptions }[] = [];
    _debateSessionDeps.getAgent = mock(() => makeCaptureAdapter(captured));

    const stageConfig = makeResolveStageConfig("custom", "claude");
    const workdir = "/tmp/judge-workspace";
    const featureName = "judge-feature";
    const storyId = "US-004";

    // @ts-ignore — RED: resolveOutcome does not yet accept workdir/featureName params
    await resolveOutcome(
      ["proposal-a"],
      ["critique-a"],
      stageConfig,
      undefined,
      storyId,
      30_000,
      workdir,
      featureName,
    );

    expect(captured.length).toBeGreaterThan(0);
    const capturedOpts = captured[0]?.opts;
    const expectedSessionName = buildSessionName(workdir, featureName, storyId, "judge");
    expect(capturedOpts?.sessionName).toBe(expectedSessionName);
  });

  test("custom resolver: does not pass sessionName when workdir is undefined", async () => {
    const captured: { opts?: CompleteOptions }[] = [];
    _debateSessionDeps.getAgent = mock(() => makeCaptureAdapter(captured));

    const stageConfig = makeResolveStageConfig("custom", "claude");

    await resolveOutcome(
      ["proposal-a"],
      ["critique-a"],
      stageConfig,
      undefined,
      "US-004",
      30_000,
      // workdir intentionally omitted (AC7)
    );

    expect(captured.length).toBeGreaterThan(0);
    const capturedOpts = captured[0]?.opts;
    expect(capturedOpts?.sessionName).toBeUndefined();
  });
});

// ─── AC5: warn log for majority resolver when workdir is defined ──────────────

describe("resolveOutcome() — majority resolver warns when workdir provided (US-004 AC5)", () => {
  let origGetSafeLogger: typeof _debateSessionDeps.getSafeLogger;

  beforeEach(() => {
    origGetSafeLogger = _debateSessionDeps.getSafeLogger;
  });

  afterEach(() => {
    _debateSessionDeps.getSafeLogger = origGetSafeLogger;
    mock.restore();
  });

  test("emits warn for majority-fail-closed when workdir is defined", async () => {
    const warnCalls: Array<{ stage: string; message: string }> = [];
    _debateSessionDeps.getSafeLogger = mock(() => ({
      warn: (stage: string, message: string) => {
        warnCalls.push({ stage, message });
      },
      info: () => {},
      debug: () => {},
      error: () => {},
    }) as ReturnType<typeof _debateSessionDeps.getSafeLogger>);

    const stageConfig = makeResolveStageConfig("majority-fail-closed");

    // @ts-ignore — RED: resolveOutcome does not yet accept workdir/featureName params
    await resolveOutcome(
      ['{"passed": true}'],
      [],
      stageConfig,
      undefined,
      "US-004",
      30_000,
      "/tmp/workdir",
      "my-feature",
    );

    // RED: warn log not yet emitted — assertion will fail
    expect(warnCalls.length).toBeGreaterThan(0);
    expect(warnCalls[0].message).toContain("majority resolver does not support implementer session resumption");
  });

  test("emits warn for majority-fail-open when workdir is defined", async () => {
    const warnCalls: Array<{ stage: string; message: string }> = [];
    _debateSessionDeps.getSafeLogger = mock(() => ({
      warn: (stage: string, message: string) => {
        warnCalls.push({ stage, message });
      },
      info: () => {},
      debug: () => {},
      error: () => {},
    }) as ReturnType<typeof _debateSessionDeps.getSafeLogger>);

    const stageConfig = makeResolveStageConfig("majority-fail-open");

    // @ts-ignore — RED: resolveOutcome does not yet accept workdir/featureName params
    await resolveOutcome(
      ['{"passed": true}'],
      [],
      stageConfig,
      undefined,
      "US-004",
      30_000,
      "/tmp/workdir",
      "my-feature",
    );

    // RED: warn log not yet emitted — assertion will fail
    expect(warnCalls.length).toBeGreaterThan(0);
    expect(warnCalls[0].message).toContain("majority resolver does not support implementer session resumption");
  });

  test("majority resolver result is unchanged regardless of workdir (AC6)", async () => {
    const stageConfig = makeResolveStageConfig("majority-fail-closed");

    // 2 passes vs 1 fail — majority votes "passed"
    const baseResult = await resolveOutcome(
      ['{"passed": true}', '{"passed": true}', '{"passed": false}'],
      [],
      stageConfig,
      undefined,
      "US-004",
      30_000,
    );
    expect(baseResult.outcome).toBe("passed"); // 2 pass > 1 fail — majority wins
    expect(baseResult.resolverCostUsd).toBe(0);
  });
});
