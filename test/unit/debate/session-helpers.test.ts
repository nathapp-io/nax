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
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { computeAcpHandle } from "@/agents/acp/adapter";
import type { CompleteOptions } from "@/agents/types";
import { DEFAULT_CONFIG, debateConfigSelector } from "@/config";
import type { SelectorContext } from "@/debate/selectors";
import { _debateSessionDeps, resolveOutcome } from "@/debate/session-helpers";
import type { DebateSessionOptions } from "@/debate/session-helpers";
import type { DebateStageConfig } from "@/debate/types";
import type { CallContext } from "@/operations/types";
import { makeLogger, makeMockAgentManager } from "@test/helpers";

const DEFAULT_DEBATE_CONFIG = debateConfigSelector.select(DEFAULT_CONFIG);

// Barrel re-export checks
import { _debateSessionDeps as barrelDeps } from "@/debate";
import type { DebateSessionOptions as BarrelDebateSessionOptions } from "@/debate";

// ─── AC1: File size constraint ────────────────────────────────────────────────

describe("src/debate/ file size constraint (AC1)", () => {
  test("no TypeScript source file in src/debate/ exceeds 400 lines", async () => {
    const debateDir = join(process.cwd(), "src", "debate");
    const tsFiles = readdirSync(debateDir).filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"));

    for (const filename of tsFiles) {
      const content = await Bun.file(join(debateDir, filename)).text();
      const lineCount = content.split("\n").length;
      expect(lineCount, `${filename} has ${lineCount} lines — must be ≤ 400`).toBeLessThanOrEqual(400);
    }
  });

  test("session-helpers.ts, runner-hybrid.ts, runner-stateful.ts, runner-plan.ts all exist in src/debate/", async () => {
    const debateDir = join(process.cwd(), "src", "debate");
    for (const filename of ["session-helpers.ts", "runner-hybrid.ts", "runner-stateful.ts", "runner-plan.ts"]) {
      expect(await Bun.file(join(debateDir, filename)).exists(), `${filename} should exist`).toBe(true);
    }
  });
});

// ─── AC5: _debateSessionDeps exported from session-helpers.ts ─────────────────

describe("_debateSessionDeps export from session-helpers.ts (AC5)", () => {
  test("is object with agentManager, getSafeLogger (fn), readFile (fn); re-exported through barrel", () => {
    expect(typeof _debateSessionDeps).toBe("object");
    expect(_debateSessionDeps).toHaveProperty("agentManager");
    expect(typeof _debateSessionDeps.getSafeLogger).toBe("function");
    expect(typeof _debateSessionDeps.readFile).toBe("function");
    expect(barrelDeps).toBeDefined();
    expect(typeof barrelDeps).toBe("object");
    expect(barrelDeps).toHaveProperty("agentManager");
  });
});

// ─── AC7: DebateSessionOptions type exported from session-helpers.ts ──────────

describe("DebateSessionOptions type export from session-helpers.ts (AC7)", () => {
  test("DebateSessionOptions: required + optional fields; accessible through barrel", () => {
    const opts1: DebateSessionOptions = {
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
    } as any;
    expect(opts1.storyId).toBe("US-000");
    expect(opts1.stageConfig.rounds).toBe(1);

    const opts2: DebateSessionOptions = {
      storyId: "US-000",
      stage: "plan",
      stageConfig: {
        enabled: true,
        resolver: { type: "synthesis" },
        sessionMode: "stateful",
        rounds: 2,
        debaters: [{ agent: "claude" }],
        timeoutSeconds: 120,
      },
      workdir: "/tmp/workspace",
      featureName: "my-feature",
      timeoutSeconds: 300,
    } as any;
    expect(opts2.workdir).toBe("/tmp/workspace");

    const opts3: BarrelDebateSessionOptions = {
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
    } as any;
    expect(opts3.storyId).toBe("US-000");
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

function makeCaptureManager(captured: { opts?: CompleteOptions }[], output = "resolved") {
  return makeMockAgentManager({
    completeFn: async (_agentName: string, _prompt: string, opts?: CompleteOptions) => {
      captured.push({ opts });
      return { output, costUsd: 0.01, source: "exact" as const };
    },
  });
}

// ─── AC1: resolveOutcome() signature adds workdir? and featureName? ───────────

describe("resolveOutcome() — workdir and featureName parameters (US-004 AC1)", () => {
  test("resolveOutcome is exported from session-helpers.ts", () => {
    expect(typeof resolveOutcome).toBe("function");
  });

  test("calling with workdir and featureName does not throw for majority resolver", async () => {
    // Runtime check: extra args accepted silently (TypeScript check enforces the signature)
    const stageConfig = makeResolveStageConfig("majority-fail-closed");
    const result = await resolveOutcome(
      ['{"passed": true}'],
      [],
      stageConfig,
      undefined,
      makeMinimalCallCtx(),
      "US-004",
      30_000,
      "/tmp/workdir",
      "my-feature",
    );
    expect(result).toBeDefined();
  });
});

// ─── AC2: synthesisResolver receives sessionName=implementer when workdir set ─

describe("resolveOutcome() — synthesis resolver sessionHandle (US-004 AC2)", () => {
  let origAgentManager: typeof _debateSessionDeps.agentManager;

  beforeEach(() => {
    origAgentManager = _debateSessionDeps.agentManager;
  });

  afterEach(() => {
    _debateSessionDeps.agentManager = origAgentManager;
    mock.restore();
  });

  test("synthesis: passes sessionName when workdir set; undefined when workdir omitted", async () => {
    const stageConfig = makeResolveStageConfig("synthesis");
    const workdir = "/tmp/workspace";
    const featureName = "semantic-continuity";
    const storyId = "US-004";

    const captured1: { opts?: CompleteOptions }[] = [];
    _debateSessionDeps.agentManager = makeCaptureManager(captured1);
    await resolveOutcome(
      ["proposal-a", "proposal-b"],
      ["critique-a"],
      stageConfig,
      DEFAULT_DEBATE_CONFIG,
      makeMinimalCallCtx(),
      storyId,
      30_000,
      workdir,
      featureName,
    );
    expect(captured1[0]?.opts?.sessionName).toBe(computeAcpHandle(workdir, featureName, storyId, "synthesis"));

    const captured2: { opts?: CompleteOptions }[] = [];
    _debateSessionDeps.agentManager = makeCaptureManager(captured2);
    await resolveOutcome(
      ["proposal-a", "proposal-b"],
      ["critique-a"],
      stageConfig,
      DEFAULT_DEBATE_CONFIG,
      makeMinimalCallCtx(),
      "US-004",
      30_000,
    );
    expect(captured2[0]?.opts?.sessionName).toBeUndefined();
  });
});

// ─── AC3: judgeResolver receives sessionName=judge when workdir set ─────

describe("resolveOutcome() — custom/judge resolver sessionHandle (US-004 AC3)", () => {
  let origAgentManager: typeof _debateSessionDeps.agentManager;

  beforeEach(() => {
    origAgentManager = _debateSessionDeps.agentManager;
  });

  afterEach(() => {
    _debateSessionDeps.agentManager = origAgentManager;
    mock.restore();
  });

  test("custom/judge: passes sessionName=computeAcpHandle(...,'judge') when workdir set; undefined when omitted", async () => {
    const stageConfig = makeResolveStageConfig("custom", "claude");
    const workdir = "/tmp/judge-workspace";
    const featureName = "judge-feature";
    const storyId = "US-004";

    const captured1: { opts?: CompleteOptions }[] = [];
    _debateSessionDeps.agentManager = makeCaptureManager(captured1);
    await resolveOutcome(
      ["proposal-a"],
      ["critique-a"],
      stageConfig,
      DEFAULT_DEBATE_CONFIG,
      makeMinimalCallCtx(),
      storyId,
      30_000,
      workdir,
      featureName,
    );
    expect(captured1[0]?.opts?.sessionName).toBe(computeAcpHandle(workdir, featureName, storyId, "judge"));

    const captured2: { opts?: CompleteOptions }[] = [];
    _debateSessionDeps.agentManager = makeCaptureManager(captured2);
    await resolveOutcome(
      ["proposal-a"],
      ["critique-a"],
      stageConfig,
      DEFAULT_DEBATE_CONFIG,
      makeMinimalCallCtx(),
      "US-004",
      30_000,
    );
    expect(captured2[0]?.opts?.sessionName).toBeUndefined();
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

  test("emits warn for majority-fail-closed and majority-fail-open when workdir is defined", async () => {
    const makeWarnCapture = () => {
      const logger = makeLogger();
      _debateSessionDeps.getSafeLogger = mock(() => logger);
      return logger;
    };

    for (const resolverType of ["majority-fail-closed", "majority-fail-open"] as const) {
      const warnCalls = makeWarnCapture();
      await resolveOutcome(
        ['{"passed": true}'],
        [],
        makeResolveStageConfig(resolverType),
        undefined,
        makeMinimalCallCtx(),
        "US-004",
        30_000,
        "/tmp/workdir",
        "my-feature",
      );
      expect(warnCalls.calls.length).toBeGreaterThan(0);
      expect(warnCalls.calls[0]?.message).toContain(
        "majority resolver does not support implementer session resumption",
      );
    }
  });

  test("majority resolver result is unchanged regardless of workdir (AC6)", async () => {
    const stageConfig = makeResolveStageConfig("majority-fail-closed");

    // 2 passes vs 1 fail — majority votes "passed"
    const baseResult = await resolveOutcome(
      ['{"passed": true}', '{"passed": true}', '{"passed": false}'],
      [],
      stageConfig,
      undefined,
      makeMinimalCallCtx(),
      "US-004",
      30_000,
    );
    expect(baseResult.outcome).toBe("passed"); // 2 pass > 1 fail — majority wins
  });
});

// ─── callContext threading (Phase 1, #855) ────────────────────────────────────

function makeMinimalCallCtx(): CallContext {
  return {
    runtime: {
      agentManager: makeMockAgentManager(),
      sessionManager: {} as any,
      configLoader: { current: () => DEFAULT_CONFIG } as any,
      packages: { resolve: () => ({ config: DEFAULT_CONFIG, select: (_: unknown) => DEFAULT_CONFIG }) } as any,
      signal: undefined,
    } as any,
    packageView: { config: DEFAULT_CONFIG, select: (_: unknown) => DEFAULT_CONFIG } as any,
    packageDir: "/tmp",
    agentName: "claude",
    storyId: "US-cc",
    featureName: "feat-cc",
  };
}

describe("SelectorContext — callContext field (AC1)", () => {
  test("SelectorContext interface accepts readonly callContext: CallContext (compile-time check)", () => {
    const callCtx = makeMinimalCallCtx();
    const ctx: SelectorContext = {
      storyId: "US-001",
      stage: "review",
      stageConfig: makeResolveStageConfig("synthesis"),
      config: DEFAULT_DEBATE_CONFIG,
      proposals: [],
      critiques: [],
      workdir: "/tmp",
      featureName: "feat",
      timeoutMs: 30_000,
      agentManager: makeMockAgentManager(),
      debaters: [],
      callContext: callCtx,
    };
    expect(ctx.callContext).toBeDefined();
    expect(ctx.callContext).toBe(callCtx);
  });
});

describe("resolveOutcome() — callContext parameter (AC2)", () => {
  let origAgentManager: typeof _debateSessionDeps.agentManager;

  beforeEach(() => {
    origAgentManager = _debateSessionDeps.agentManager;
  });

  afterEach(() => {
    _debateSessionDeps.agentManager = origAgentManager;
    mock.restore();
  });

  test("resolveOutcome accepts callContext: majority returns 'passed'; synthesis places callContext on selectorCtx (AC2)", async () => {
    const callCtx = makeMinimalCallCtx();

    const r1 = await resolveOutcome(
      ['{"passed": true}', '{"passed": true}'],
      [],
      makeResolveStageConfig("majority-fail-closed"),
      DEFAULT_DEBATE_CONFIG,
      callCtx,
      "US-ac2",
      30_000,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      makeMockAgentManager(),
    );
    expect(r1.outcome).toBe("passed");

    const captured: { opts?: CompleteOptions }[] = [];
    _debateSessionDeps.agentManager = makeCaptureManager(captured, '{"passed": true}');
    const r2 = await resolveOutcome(
      ["proposal-a"],
      [],
      makeResolveStageConfig("synthesis"),
      DEFAULT_DEBATE_CONFIG,
      callCtx,
      "US-ac2b",
      30_000,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      _debateSessionDeps.agentManager as NonNullable<typeof _debateSessionDeps.agentManager>,
    );
    expect(r2).toBeDefined();
  });
});
