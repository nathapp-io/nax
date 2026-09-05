import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ─── Runtime helpers ──────────────────────────────────────────────────────

import type { NaxConfig } from "@/config";
import { DEFAULT_CONFIG } from "@/config";
import { type CompleteDispatchEvent, type DispatchEvent, DispatchEventBus } from "@/runtime/dispatch-events";
import { CostAggregator, createNoOpCostAggregator } from "@/runtime/cost-aggregator";
import type { CostEvent } from "@/runtime/cost-aggregator";
import { createRuntime, type CreateRuntimeOptions, type NaxRuntime } from "@/runtime";
import { createNoOpPromptAuditor, PromptAuditor, type PromptAuditEntry } from "@/runtime/prompt-auditor";
import { attachAuditSubscriber } from "@/runtime/middleware/audit";
import { attachCostSubscriber } from "@/runtime/middleware/cost";
import { buildCompleteEvent, buildSessionTurnEvent } from "@/agents/manager-dispatch";
import type { TurnResult } from "@/agents/session-types";
import type { CompleteResult, ResolvedCompleteOptions } from "@/agents/types";
import { NativeAgentAdapter } from "@/agents/native/adapter";
import { _clientDeps, _resetNativeClient } from "@/agents/native/client";
import { buildRateCard, estimateCostUsd, toNaxTokenUsage } from "@/agents/native/models";
import type { TokenPricing } from "@/config/schema-types";
import { resolvePricingSource } from "@/agents/cost/calculate";
import { _promptsMainDeps, promptsCommand } from "@/cli/prompts-main";
import { _grepDeps, grepTool } from "@/tools/grep";
import { makeTempDir, cleanupTempDir } from "@test/helpers";
import { PidRegistry } from "@/execution/pid-registry";

// ─── NaxConfig with promptAudit enabled ────────────────────────────────────

function auditEnabledConfig(auditDir?: string): NaxConfig {
  return {
    ...DEFAULT_CONFIG,
    agent: {
      ...DEFAULT_CONFIG.agent,
      promptAudit: {
        enabled: true,
        ...(auditDir !== undefined ? { dir: auditDir } : {}),
      },
    },
  } as NaxConfig;
}

function makeMockRuntime(config: NaxConfig, workdir: string, opts?: CreateRuntimeOptions): NaxRuntime {
  const rt = createRuntime(config, workdir, opts);
  return rt;
}

// ─── Helpers for derived test dirs ─────────────────────────────────────────

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = makeTempDir("nax-acceptance-audit-cost-grep-");
});

afterEach(() => {
  if (tmpRoot) cleanupTempDir(tmpRoot);
  _resetNativeClient();
});

// ============================================================================
// US-001: Prompt auditing degrades instead of blocking feature-less commands
// ============================================================================

describe("US-001 — prompt auditing degrades", () => {
  // AC-1: createRuntime with promptAudit.enabled = true and no opts does not throw
  test("AC-1: createRuntime with promptAudit.enabled=true and no opts returns runtime, does not throw", () => {
    const auditDir = join(tmpRoot, "prompt-audit");
    const config = auditEnabledConfig(auditDir);
    // Provide a pidRegistry that points to a non-existent dir so PidRegistry
    // constructor does not touch the real filesystem in a way that matters.
    const pidRegistry = new PidRegistry(tmpRoot);
    // Use a no-op cost aggregator to avoid file-system side effects.
    const costAggregator = createNoOpCostAggregator();

    const runtime = makeMockRuntime(config, tmpRoot, { pidRegistry, costAggregator });
    expect(runtime).toBeDefined();
    expect(typeof runtime.close).toBe("function");
    expect(runtime.promptAuditor).toBeDefined();
    // The auditor should be the no-op auditor (no feature name was provided)
    expect(runtime.promptAuditor).toBeTruthy();
  });

  // AC-2: No-op auditor writes no files after record + flush
  test("AC-2: no-op auditor writes no files after record+flush", async () => {
    const auditDir = join(tmpRoot, "prompt-audit-nofiles");
    const config = auditEnabledConfig(auditDir);
    const pidRegistry = new PidRegistry(tmpRoot);
    const costAggregator = createNoOpCostAggregator();

    const runtime = makeMockRuntime(config, tmpRoot, { pidRegistry, costAggregator });
    // The auditor is the no-op auditor because we passed no featureName.
    const auditor = runtime.promptAuditor;

    auditor.record({
      ts: Date.now(),
      runId: runtime.runId,
      agentName: "claude",
      permissionProfile: "approve-all",
      prompt: "hello",
      response: "world",
      durationMs: 100,
    });
    await auditor.flush();

    // The prompt-audit directory should not exist or be empty
    expect(existsSync(auditDir)).toBe(false);
    await runtime.close();
  });

  // AC-3: Real PromptAuditor with featureName writes files after record + flush
  test("AC-3: real PromptAuditor writes files when featureName provided", async () => {
    const auditDir = join(tmpRoot, "prompt-audit-files");
    const config = auditEnabledConfig(auditDir);
    const pidRegistry = new PidRegistry(tmpRoot);
    const costAggregator = createNoOpCostAggregator();

    const runtime = makeMockRuntime(config, tmpRoot, {
      pidRegistry,
      costAggregator,
      featureName: "demo",
    });
    const auditor = runtime.promptAuditor;

    // Assert the auditor is NOT a no-op — it's a real PromptAuditor
    // (createNoOpPromptAuditor returns a plain object, PromptAuditor is a class instance)
    const noOp = createNoOpPromptAuditor();
    expect(Object.getPrototypeOf(auditor).constructor.name).not.toBe("Object");
    // The simplest check: a no-op auditor's record() does nothing observable;
    // a real PromptAuditor has internal state. Check by type:
    expect(auditor).not.toBe(noOp);

    auditor.record({
      ts: Date.now(),
      runId: runtime.runId,
      agentName: "claude",
      permissionProfile: "approve-all",
      prompt: "record me",
      response: "done",
      durationMs: 50,
      callType: "complete",
      sessionName: "test-session-demo",
    });
    await auditor.flush();

    // The prompt-audit dir/<featureName> dir should now contain files
    const featureDir = join(auditDir, "demo");
    expect(existsSync(featureDir)).toBe(true);
    const files = readdirSync(featureDir);
    expect(files.length).toBeGreaterThanOrEqual(1);
    // At least one .jsonl and/or .txt file
    expect(files.some((f) => f.endsWith(".jsonl") || f.endsWith(".txt"))).toBe(true);

    await runtime.close();
  });

  // AC-4: promptsCommand calls createRuntime with { featureName: feature }
  test("AC-4: promptsCommand calls createRuntime with featureName equal to the feature string", async () => {
    // Set up a temporary workdir with a prd.json for feature "demo"
    const workdir = tmpRoot;
    const feature = "demo";
    const featureDir = join(workdir, ".nax", "features", feature);
    mkdirSync(featureDir, { recursive: true });
    writeFileSync(
      join(featureDir, "prd.json"),
      JSON.stringify({
        project: "test-project",
        feature,
        branchName: "feat/test",
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        userStories: [
          {
            id: "US-001",
            title: "Story one",
            description: "desc",
            acceptanceCriteria: ["AC-1"],
            tags: [],
            dependencies: [],
            status: "pending",
            passes: false,
            escalations: [],
            attempts: 0,
          },
        ],
      }),
    );

    const captured: Array<
      [Parameters<typeof _promptsMainDeps.createRuntime>[0], Parameters<typeof _promptsMainDeps.createRuntime>[1], Parameters<typeof _promptsMainDeps.createRuntime>[2] | undefined]
    > = [];
    const origCreateRuntime = _promptsMainDeps.createRuntime;
    try {
      _promptsMainDeps.createRuntime = (cfg, wd, opts) => {
        captured.push([cfg, wd, opts]);
        // Return a minimal disposable runtime
        const pidRegistry = new PidRegistry(workdir);
        const costAggregator = createNoOpCostAggregator();
        return createRuntime(cfg, wd, {
          pidRegistry,
          costAggregator,
          ...opts,
        });
      };

      const config = DEFAULT_CONFIG;
      await promptsCommand({ feature, workdir, config });

      expect(captured).toHaveLength(1);
      const [cfg, wd, opts] = captured[0];
      expect(opts).toBeDefined();
      expect(opts!.featureName).toBe(feature);
    } finally {
      _promptsMainDeps.createRuntime = origCreateRuntime;
    }
  });
});

// ============================================================================
// US-002: Sessionless complete() audit records carry their stage and session id
// ============================================================================

describe("US-002 — complete audit records carry stage and session id", () => {
  // AC-5: complete entry with stage 'acceptance' produces '-acceptance-complete.txt' suffix
  test("AC-5: deriveAuditSuffix with stage=acceptance complete entry returns acceptance-complete", async () => {
    // We test deriveAuditSuffix through the filename it produces on the txt write path.
    // Spin up a real PromptAuditor with injected deps to capture the written path.
    const auditDir = join(tmpRoot, "ac5");
    const writtenPaths: string[] = [];
    const origWrite = (await import("@/runtime/prompt-auditor"))._promptAuditorDeps.write;
    const origAppend = (await import("@/runtime/prompt-auditor"))._promptAuditorDeps.appendLine;
    try {
      const mod = await import("@/runtime/prompt-auditor");
      mod._promptAuditorDeps.write = async (p: string) => {
        writtenPaths.push(p);
        return 0;
      };
      mod._promptAuditorDeps.appendLine = async () => {};

      const auditor = new mod.PromptAuditor("r-ac5", auditDir, "feature-ac5");
      auditor.record({
        ts: 1234567890000,
        runId: "r-ac5",
        agentName: "claude",
        permissionProfile: "approve-all",
        prompt: "test",
        response: "ok",
        durationMs: 50,
        callType: "complete",
        stage: "acceptance",
        sessionName: "nax-abc12345-my-feature-us-000-refine",
      });
      await auditor.flush();

      expect(writtenPaths).toHaveLength(1);
      expect(writtenPaths[0]).toEndWith("-acceptance-complete.txt");
    } finally {
      (await import("@/runtime/prompt-auditor"))._promptAuditorDeps.write = origWrite;
      (await import("@/runtime/prompt-auditor"))._promptAuditorDeps.appendLine = origAppend;
    }
  });

  // AC-6: complete entry without stage produces bare '-complete.txt' suffix
  test("AC-6: deriveAuditSuffix with stage=undefined complete entry returns bare complete", async () => {
    const auditDir = join(tmpRoot, "ac6");
    const writtenPaths: string[] = [];
    const mod = await import("@/runtime/prompt-auditor");
    const origWrite = mod._promptAuditorDeps.write;
    const origAppend = mod._promptAuditorDeps.appendLine;
    try {
      mod._promptAuditorDeps.write = async (p: string) => {
        writtenPaths.push(p);
        return 0;
      };
      mod._promptAuditorDeps.appendLine = async () => {};

      const auditor = new mod.PromptAuditor("r-ac6", auditDir, "feature-ac6");
      auditor.record({
        ts: 1234567890000,
        runId: "r-ac6",
        agentName: "claude",
        permissionProfile: "approve-all",
        prompt: "test",
        response: "ok",
        durationMs: 50,
        callType: "complete",
        sessionName: "nax-abc-no-stage-session",
      });
      await auditor.flush();

      expect(writtenPaths).toHaveLength(1);
      expect(writtenPaths[0]).toEndWith("-complete.txt");
      // Ensure there is no double-hyphen or empty segment before -complete.txt:
      // the pattern should be ...-sessionName-complete.txt, not ...--complete.txt
      // or ...-sessionName--complete.txt or ...-sessionName-.txt
      const basename = writtenPaths[0].split("/").pop()!;
      // The segment before "complete.txt" must be "complete", not empty
      // Strip "complete.txt": the character before must be "-" and before that must be non-empty
      const suffix = "-complete.txt";
      const beforeSuffix = basename.slice(0, -suffix.length);
      expect(beforeSuffix.endsWith("-")).toBe(false);
      expect(beforeSuffix.length).toBeGreaterThan(0);
      expect(basename).toMatch(/.+-complete\.txt$/);
      // Verify no empty dash-delimited segment: all dash-separated parts non-empty
      const segments = basename.split("-");
      expect(segments.every((s) => s.length > 0)).toBe(true);
    } finally {
      mod._promptAuditorDeps.write = origWrite;
      mod._promptAuditorDeps.appendLine = origAppend;
    }
  });

  // AC-7: run entry with stage run and turn 1 still produces -run-t01.txt suffix
  test("AC-7: deriveAuditSuffix with run turn=1 produces -run-t01.txt", async () => {
    const auditDir = join(tmpRoot, "ac7");
    const writtenPaths: string[] = [];
    const mod = await import("@/runtime/prompt-auditor");
    const origWrite = mod._promptAuditorDeps.write;
    const origAppend = mod._promptAuditorDeps.appendLine;
    try {
      mod._promptAuditorDeps.write = async (p: string) => {
        writtenPaths.push(p);
        return 0;
      };
      mod._promptAuditorDeps.appendLine = async () => {};

      const auditor = new mod.PromptAuditor("r-ac7", auditDir, "feature-ac7");
      auditor.record({
        ts: 1234567890000,
        runId: "r-ac7",
        agentName: "claude",
        permissionProfile: "approve-all",
        prompt: "test",
        response: "ok",
        durationMs: 50,
        callType: "run",
        stage: "run",
        sessionName: "nax-abc-run-test",
      });
      await auditor.flush();

      expect(writtenPaths).toHaveLength(1);
      expect(writtenPaths[0]).toEndWith("-run-t01.txt");
    } finally {
      mod._promptAuditorDeps.write = origWrite;
      mod._promptAuditorDeps.appendLine = origAppend;
    }
  });

  // AC-8: buildCompleteEvent with sessionId propagates it
  test("AC-8: buildCompleteEvent with sessionId returns event with sessionId", () => {
    const event = buildCompleteEvent({
      sessionName: "test-session",
      sessionRole: "auto",
      prompt: "hello",
      response: "world",
      agentName: "claude",
      stage: "complete" as any,
      options: {
        modelDef: { provider: "anthropic", model: "claude-sonnet-4" },
        workdir: "/tmp",
        resolvedPermissions: { mode: "approve-all" },
      },
      resolvedPermissions: { mode: "approve-all" },
      tokenUsage: { inputTokens: 10, outputTokens: 5 },
      estimatedCostUsd: 0.1,
      startedAt: Date.now(),
      sessionId: "nax-abc12345",
    });

    expect(event.kind).toBe("complete");
    expect(event.sessionId).toBe("nax-abc12345");
  });

  // AC-9: buildCompleteEvent without sessionId omits the property
  test("AC-9: buildCompleteEvent without sessionId omits the property", () => {
    const event = buildCompleteEvent({
      sessionName: "test-session",
      sessionRole: "auto",
      prompt: "hello",
      response: "world",
      agentName: "claude",
      stage: "complete" as any,
      options: {
        modelDef: { provider: "anthropic", model: "claude-sonnet-4" },
        workdir: "/tmp",
        resolvedPermissions: { mode: "approve-all" },
      },
      resolvedPermissions: { mode: "approve-all" },
      tokenUsage: { inputTokens: 10, outputTokens: 5 },
      estimatedCostUsd: 0.1,
      startedAt: Date.now(),
    });

    expect(event.kind).toBe("complete");
    expect(Object.prototype.hasOwnProperty.call(event, "sessionId")).toBe(false);
  });

  // AC-10: attachAuditSubscriber passes sessionId from complete dispatch event to auditor
  test("AC-10: audit subscriber records sessionId from complete dispatch event", () => {
    const bus = new DispatchEventBus();
    let recordedEntry: PromptAuditEntry | undefined;

    const spyAuditor = {
      record: (entry: PromptAuditEntry) => {
        recordedEntry = entry;
      },
      recordError: () => {},
      flush: async () => {},
    };

    const unsubscribe = attachAuditSubscriber(bus, spyAuditor, "run-001");

    const event: CompleteDispatchEvent = {
      kind: "complete",
      sessionName: "sess-1",
      sessionRole: "auto",
      prompt: "hi",
      response: "there",
      agentName: "claude",
      stage: "acceptance" as any,
      resolvedPermissions: { mode: "approve-all" },
      tokenUsage: { inputTokens: 1, outputTokens: 1 },
      durationMs: 10,
      timestamp: Date.now(),
      sessionId: "nax-abc12345",
    };

    bus.emitDispatch(event);

    expect(recordedEntry).toBeDefined();
    expect(recordedEntry!.sessionId).toBe("nax-abc12345");

    unsubscribe();
  });

  // AC-11: NativeAgentAdapter.complete() sessionId matches the one sent to provider
  test("AC-11: complete() sessionId matches the sessionId sent to the provider", async () => {
    // We need to mock the nax-ai client to capture the sessionId.
    const _build = _clientDeps.build;
    let capturedSessionId: string | undefined;

    _clientDeps.build = async () => ({
      model: async () => ({
        id: "gpt-5.4-mini",
        provider: "openai",
        protocol: "openai-responses",
        pricing: { input: 2, output: 10 },
        contextWindow: 128_000,
        supportsTools: true,
        thinkingLevels: [],
      }),
      listModels: async () => [],
      pricing: () => ({ input: 2, output: 10 }),
      stream: async function* gen() {},
      complete: async (_prompt: string, opts?: any) => {
        capturedSessionId = opts?.sessionId;
        return { text: "ok", usage: { inputTokens: 10, outputTokens: 5 }, stopReason: "stop" };
      },
      validate: () => {},
    });

    const adapter = new NativeAgentAdapter();
    const result = await adapter.complete("hello", {
      modelDef: { provider: "unknown", model: "openai/gpt-5.4-mini" },
      workdir: "/tmp",
      resolvedPermissions: { mode: "approve-all" },
    });

    expect(result.sessionId).toBeDefined();
    expect(typeof result.sessionId).toBe("string");
    expect(result.sessionId!.length).toBeGreaterThan(0);
    expect(result.sessionId).toBe(capturedSessionId);

    _clientDeps.build = _build;
  });

  // AC-12: Two complete() calls on same instance share sessionId
  test("AC-12: two complete() calls on same instance share sessionId", async () => {
    const _build = _clientDeps.build;
    _clientDeps.build = async () => ({
      model: async () => ({
        id: "gpt-5.4-mini",
        provider: "openai",
        protocol: "openai-responses",
        pricing: { input: 2, output: 10 },
        contextWindow: 128_000,
        supportsTools: true,
        thinkingLevels: [],
      }),
      listModels: async () => [],
      pricing: () => ({ input: 2, output: 10 }),
      stream: async function* gen() {},
      complete: async () => ({ text: "ok", usage: { inputTokens: 10, outputTokens: 5 }, stopReason: "stop" }),
      validate: () => {},
    });

    const adapter = new NativeAgentAdapter();
    const r1 = await adapter.complete("hello", {
      modelDef: { provider: "unknown", model: "openai/gpt-5.4-mini" },
      workdir: "/tmp",
      resolvedPermissions: { mode: "approve-all" },
    });
    const r2 = await adapter.complete("world", {
      modelDef: { provider: "unknown", model: "openai/gpt-5.4-mini" },
      workdir: "/tmp",
      resolvedPermissions: { mode: "approve-all" },
    });

    expect(typeof r1.sessionId).toBe("string");
    expect(r1.sessionId!.length).toBeGreaterThan(0);
    expect(r1.sessionId).toBe(r2.sessionId);
    expect(r1.sessionId).toBe(r2.sessionId);

    // A fresh adapter may produce a different sessionId
    const adapter2 = new NativeAgentAdapter();
    const r3 = await adapter2.complete("hello", {
      modelDef: { provider: "unknown", model: "openai/gpt-5.4-mini" },
      workdir: "/tmp",
      resolvedPermissions: { mode: "approve-all" },
    });
    // It's possible (though astronomically unlikely) that two random UUIDs collide
    expect(r3.sessionId).toBeDefined();
    expect(r3.sessionId!.length).toBeGreaterThan(0);

    _clientDeps.build = _build;
  });
});

// ============================================================================
// US-003: The native adapter reports which rate card priced the call
// ============================================================================

describe("US-003 — native adapter reports pricing source", () => {
  // AC-13: buildRateCard with no override returns catalog-rates source and catalog rates
  test("AC-13: buildRateCard with undefined override returns catalog-rates source with cache rates", () => {
    const catalog = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };
    const { rates, source } = buildRateCard(catalog, undefined);
    expect(source).toBe("catalog-rates");
    expect(rates).toEqual({
      inputPer1M: 2,
      outputPer1M: 10,
      cacheReadPer1M: 0.2,
      cacheCreationPer1M: 2.5,
    });
  });

  // AC-14: buildRateCard with override returns config-override source and the override itself
  test("AC-14: buildRateCard with override returns config-override source and override identity", () => {
    const catalog = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };
    const override: TokenPricing = { inputPer1M: 99, outputPer1M: 199 };
    const { rates, source } = buildRateCard(catalog, override);
    expect(source).toBe("config-override");
    // rates must be the exact override object (reference identity)
    expect(rates).toBe(override);
    // No catalog fields should bleed through
    expect(rates.cacheReadPer1M).toBeUndefined();
    expect(rates.cacheCreationPer1M).toBeUndefined();
  });

  // AC-15: buildRateCard with tiers in catalog translates to nax field names
  test("AC-15: buildRateCard with catalog tiers translates to nax field names", () => {
    const catalog = {
      input: 2,
      output: 12,
      cacheRead: 0.2,
      cacheWrite: 2.5,
      tiers: [{ inputTokensAbove: 272_000, input: 4, output: 18, cacheRead: 0.4, cacheWrite: 5 }],
    };
    const { rates, source } = buildRateCard(catalog, undefined);
    expect(source).toBe("catalog-rates");
    expect(rates.tiers).toBeDefined();
    expect(rates.tiers!).toHaveLength(1);
    expect(rates.tiers![0]).toEqual({
      inputPer1M: 4,
      outputPer1M: 18,
      cacheReadPer1M: 0.4,
      cacheCreationPer1M: 5,
      inputTokensAbove: 272_000,
    });
  });

  // AC-16: NativeAgentAdapter.complete() with no pricing override returns pricingSource "catalog-rates"
  test("AC-16: complete() returns pricingSource catalog-rates when modelDef has no pricing override", async () => {
    const _build = _clientDeps.build;
    try {
      _clientDeps.build = async () => ({
        model: async () => ({
          id: "gpt-5.4-mini",
          provider: "openai",
          protocol: "openai-responses",
          pricing: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
          contextWindow: 128_000,
          supportsTools: true,
          thinkingLevels: [],
        }),
        listModels: async () => [],
        pricing: () => ({ input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }),
        stream: async function* gen() {},
        complete: async () => ({
          text: "ok",
          usage: { inputTokens: 10, outputTokens: 5 },
          stopReason: "stop",
        }),
        validate: () => {},
      });

      const adapter = new NativeAgentAdapter();
      const result = await adapter.complete("hi", {
        modelDef: { provider: "unknown", model: "openai/gpt-5.4-mini" },
        workdir: "/tmp",
        resolvedPermissions: { mode: "approve-all" },
        // No pricing override
      });
      expect(result.pricingSource).toBe("catalog-rates");
    } finally {
      _clientDeps.build = _build;
    }
  });

  // AC-17: NativeAgentAdapter.complete() with pricing override returns pricingSource "config-override"
  test("AC-17: complete() returns pricingSource config-override when modelDef has pricing override", async () => {
    const _build = _clientDeps.build;
    try {
      _clientDeps.build = async () => ({
        model: async () => ({
          id: "gpt-5.4-mini",
          provider: "openai",
          protocol: "openai-responses",
          pricing: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
          contextWindow: 128_000,
          supportsTools: true,
          thinkingLevels: [],
        }),
        listModels: async () => [],
        pricing: () => ({ input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }),
        stream: async function* gen() {},
        complete: async () => ({
          text: "ok",
          usage: { inputTokens: 10, outputTokens: 5 },
          stopReason: "stop",
        }),
        validate: () => {},
      });

      const adapter = new NativeAgentAdapter();
      // We need a modelDef with pricing that is not undefined
      const result = await adapter.complete("hi", {
        modelDef: {
          provider: "unknown",
          model: "openai/gpt-5.4-mini",
          pricing: { inputPer1M: 99, outputPer1M: 199 },
        },
        workdir: "/tmp",
        resolvedPermissions: { mode: "approve-all" },
      });
      expect(result.pricingSource).toBe("config-override");
    } finally {
      _clientDeps.build = _build;
    }
  });

  // AC-18: NativeAgentAdapter.sendTurn() returns TurnResult with pricingSource catalog-rates
  test("AC-18: sendTurn() returns pricingSource catalog-rates when no pricing override", async () => {
    const _build = _clientDeps.build;
    try {
      _clientDeps.build = async () => ({
        model: async () => ({
          id: "gpt-5.4-mini",
          provider: "openai",
          protocol: "openai-responses",
          pricing: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
          contextWindow: 128_000,
          supportsTools: true,
          thinkingLevels: [],
        }),
        listModels: async () => [],
        pricing: () => ({ input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }),
        stream: async function* gen() {},
        complete: async () => ({
          text: "ok",
          usage: { inputTokens: 10, outputTokens: 5 },
          stopReason: "stop",
        }),
        validate: () => {},
      });

      const adapter = new NativeAgentAdapter();
      // We need to open a session and send a turn
      // sendTurn goes through the turn loop which calls client.complete internally
      // But sendTurn also calls buildRateCard and stamps pricingSource on the result
      // For this test we just verify the path works, so we use a minimal session
      // with a session handle that has no pricing override.
      try {
        const transcriptDir = join(tmpRoot, "transcript-turn");
        mkdirSync(transcriptDir, { recursive: true });
        const handle = await adapter.openSession("sess-ac18", {
          agentName: "native",
          workdir: "/tmp",
          resolvedPermissions: { mode: "approve-all" },
          modelDef: { provider: "unknown", model: "openai/gpt-5.4-mini" },
          timeoutSeconds: 60,
          transcriptDir,
        });

        // sendTurn will call client.complete via the turn loop.
        // We already stubbed complete above, so this should work.
        const result = await adapter.sendTurn(handle, "hello", {
          interactionHandler: { onInteraction: async () => ({ answer: "" }) },
        });

        expect(result.pricingSource).toBe("catalog-rates");
      } catch (e) {
        // The turn loop may fail if the mock doesn't provide tool support.
        // In that case we skip the detailed assertion and just verify the
        // pricing source logic is wired by checking the source was set
        // from the buildRateCard call. But we still check it's defined.
        expect((e as any)?.message ?? "no error").toBeDefined();
        // Actually rethrow — the turn-loop mock might be incomplete
        throw e;
      }
    } finally {
      _clientDeps.build = _build;
    }
  });
});

// ============================================================================
// US-004: Cost rows record the pricing source their producer reported
// ============================================================================

describe("US-004 — cost rows record pricing source from producer", () => {
  // AC-19: Cost subscriber records catalog-rates from event
  test("AC-19: cost subscriber records event-carried pricingSource catalog-rates", async () => {
    const bus = new DispatchEventBus();
    const costDir = join(tmpRoot, "cost-ac19");
    const aggregator = new CostAggregator("run-ac19", costDir);
    const unsubscribe = attachCostSubscriber(bus, aggregator, "run-ac19", "test-project");

    try {
      // Emit a complete event with token usage, no exactCostUsd, and pricingSource catalog-rates
      bus.emitDispatch({
        kind: "complete",
        sessionName: "test",
        sessionRole: "auto",
        prompt: "hello",
        response: "world",
        agentName: "claude",
        stage: "complete" as any,
        resolvedPermissions: { mode: "approve-all" },
        tokenUsage: { inputTokens: 100, outputTokens: 50 },
        estimatedCostUsd: 0.01,
        model: "haiku",
        durationMs: 100,
        timestamp: Date.now(),
        pricingSource: "catalog-rates",
      } as CompleteDispatchEvent);

      // Read back from aggregator via snapshot/byAgent/byStage
      const byStage = aggregator.byStage();
      // The event was recorded in the aggregator's events list.
      // We need to verify the pricingSource reached the CostEvent.
      // The aggregator stores CostEvent objects internally.
      // We can access via snapshot (aggregate) or direct events.
      // Since we don't have a direct getter, we drain and check.
      // Actually, we can just check snapshot() for the pricingSource.
      // But snapshot doesn't carry pricingSource.
      // Let's drain the aggregator and then read the file.
      // But drain writes to disk, and we'd rather check in memory.
      // Use _events via the aggregator — we need a way to inspect recorded events.
      // Let's check via byStage which gives a snapshot per stage.
      // PricingSource isn't accessible via snapshot. We need another approach.
      // Let's use a custom aggregator wrapper or read the events after drain.
      // Actually the simplest: the aggregator's _events is private. Let's drain
      // and read the file.
      await aggregator.drain();

      // Read the cost file
      const costFile = join(costDir, "run-ac19.jsonl");
      expect(existsSync(costFile)).toBe(true);
      const content = await Bun.file(costFile).text();
      const lines = content.trim().split("\n").filter(Boolean);
      expect(lines.length).toBeGreaterThanOrEqual(1);
      const costEvent = JSON.parse(lines[0]);
      expect(costEvent.pricingSource).toBe("catalog-rates");
    } finally {
      unsubscribe();
    }
  });

  // AC-20: Cost subscriber records config-override from event
  test("AC-20: cost subscriber records event-carried pricingSource config-override", async () => {
    const bus = new DispatchEventBus();
    const costDir = join(tmpRoot, "cost-ac20");
    const aggregator = new CostAggregator("run-ac20", costDir);
    const unsubscribe = attachCostSubscriber(bus, aggregator, "run-ac20", "test-project");

    try {
      bus.emitDispatch({
        kind: "complete",
        sessionName: "test",
        sessionRole: "auto",
        prompt: "hello",
        response: "world",
        agentName: "claude",
        stage: "complete" as any,
        resolvedPermissions: { mode: "approve-all" },
        tokenUsage: { inputTokens: 100, outputTokens: 50 },
        estimatedCostUsd: 0.01,
        model: "haiku",
        durationMs: 100,
        timestamp: Date.now(),
        pricingSource: "config-override",
      } as CompleteDispatchEvent);

      await aggregator.drain();

      const costFile = join(costDir, "run-ac20.jsonl");
      expect(existsSync(costFile)).toBe(true);
      const content = await Bun.file(costFile).text();
      const lines = content.trim().split("\n").filter(Boolean);
      expect(lines.length).toBeGreaterThanOrEqual(1);
      const costEvent = JSON.parse(lines[0]);
      expect(costEvent.pricingSource).toBe("config-override");
    } finally {
      unsubscribe();
    }
  });

  // AC-21: Cost subscriber falls back to resolvePricingSource when event has no pricingSource
  test("AC-21: cost subscriber falls back to resolvePricingSource when event has no pricingSource", async () => {
    const bus = new DispatchEventBus();
    const costDir = join(tmpRoot, "cost-ac21");
    const aggregator = new CostAggregator("run-ac21", costDir);
    const unsubscribe = attachCostSubscriber(bus, aggregator, "run-ac21", "test-project");

    try {
      // Emit an event with no pricingSource, model "haiku" (known in MODEL_PRICING)
      bus.emitDispatch({
        kind: "complete",
        sessionName: "test",
        sessionRole: "auto",
        prompt: "hello",
        response: "world",
        agentName: "claude",
        stage: "complete" as any,
        resolvedPermissions: { mode: "approve-all" },
        tokenUsage: { inputTokens: 100, outputTokens: 50 },
        estimatedCostUsd: 0.01,
        model: "haiku",
        durationMs: 100,
        timestamp: Date.now(),
        // No pricingSource — the subscriber should fall back to resolvePricingSource("haiku") = "model-rates"
      } as CompleteDispatchEvent);

      await aggregator.drain();

      const costFile = join(costDir, "run-ac21.jsonl");
      expect(existsSync(costFile)).toBe(true);
      const content = await Bun.file(costFile).text();
      const lines = content.trim().split("\n").filter(Boolean);
      expect(lines.length).toBeGreaterThanOrEqual(1);
      const costEvent = JSON.parse(lines[0]);
      // resolvePricingSource("haiku") returns "model-rates" because haiku is in MODEL_PRICING
      expect(costEvent.pricingSource).toBe("model-rates");
    } finally {
      unsubscribe();
    }

    // Now test with a model NOT in MODEL_PRICING
    const bus2 = new DispatchEventBus();
    const costDir2 = join(tmpRoot, "cost-ac21b");
    const aggregator2 = new CostAggregator("run-ac21b", costDir2);
    const unsubscribe2 = attachCostSubscriber(bus2, aggregator2, "run-ac21b", "test-project");

    try {
      bus2.emitDispatch({
        kind: "complete",
        sessionName: "test",
        sessionRole: "auto",
        prompt: "hello",
        response: "world",
        agentName: "claude",
        stage: "complete" as any,
        resolvedPermissions: { mode: "approve-all" },
        tokenUsage: { inputTokens: 100, outputTokens: 50 },
        estimatedCostUsd: 0.01,
        model: "nonexistent-model-xyz",
        durationMs: 100,
        timestamp: Date.now(),
        // No pricingSource — should fall back to resolvePricingSource("nonexistent-model-xyz") = "fallback-rates"
      } as CompleteDispatchEvent);

      await aggregator2.drain();

      const costFile2 = join(costDir2, "run-ac21b.jsonl");
      expect(existsSync(costFile2)).toBe(true);
      const content2 = await Bun.file(costFile2).text();
      const lines2 = content2.trim().split("\n").filter(Boolean);
      expect(lines2.length).toBeGreaterThanOrEqual(1);
      const costEvent2 = JSON.parse(lines2[0]);
      expect(costEvent2.pricingSource).toBe("fallback-rates");
    } finally {
      unsubscribe2();
    }
  });

  // AC-22: Wire exact cost takes precedence over event-carried pricingSource
  test("AC-22: finite exactCostUsd causes pricingSource = wire, overriding event-carried value", async () => {
    const bus = new DispatchEventBus();
    const costDir = join(tmpRoot, "cost-ac22");
    const aggregator = new CostAggregator("run-ac22", costDir);
    const unsubscribe = attachCostSubscriber(bus, aggregator, "run-ac22", "test-project");

    try {
      bus.emitDispatch({
        kind: "complete",
        sessionName: "test",
        sessionRole: "auto",
        prompt: "hello",
        response: "world",
        agentName: "claude",
        stage: "complete" as any,
        resolvedPermissions: { mode: "approve-all" },
        tokenUsage: { inputTokens: 100, outputTokens: 50 },
        estimatedCostUsd: 0.01,
        exactCostUsd: 0.05, // finite exact cost
        model: "haiku",
        durationMs: 100,
        timestamp: Date.now(),
        pricingSource: "catalog-rates", // event says catalog-rates, but wire should win
      } as CompleteDispatchEvent);

      await aggregator.drain();

      const costFile = join(costDir, "run-ac22.jsonl");
      expect(existsSync(costFile)).toBe(true);
      const content = await Bun.file(costFile).text();
      const lines = content.trim().split("\n").filter(Boolean);
      expect(lines.length).toBeGreaterThanOrEqual(1);
      const costEvent = JSON.parse(lines[0]);
      expect(costEvent.pricingSource).toBe("wire");
    } finally {
      unsubscribe();
    }
  });

  // AC-23: resolvePricingSource returns expected values
  test("AC-23: resolvePricingSource returns fallback-rates for unknown and model-rates for known models", () => {
    // A model id that is definitely not in MODEL_PRICING
    expect(resolvePricingSource("nonexistent-model-xyz")).toBe("fallback-rates");

    // A model id that is known in MODEL_PRICING
    expect(resolvePricingSource("haiku")).toBe("model-rates");
    expect(resolvePricingSource("sonnet")).toBe("model-rates");
    expect(resolvePricingSource("opus")).toBe("model-rates");

    // These should also typecheck — the returned type is the widened union
    const source1: "model-rates" | "fallback-rates" | "unknown-model" | "catalog-rates" | "config-override" =
      resolvePricingSource("haiku");
    expect(source1).toBe("model-rates");

    const source2: "model-rates" | "fallback-rates" | "unknown-model" | "catalog-rates" | "config-override" =
      resolvePricingSource("nonexistent-model-xyz");
    expect(source2).toBe("fallback-rates");

    // Also verify undefined returns "unknown-model" (baseline behavior unchanged)
    expect(resolvePricingSource(undefined)).toBe("unknown-model");
  });

  // AC-24: CostEvent with pricingSource catalog-rates is accepted and read back
  test("AC-24: CostEvent with pricingSource catalog-rates is accepted by aggregator", async () => {
    const costDir = join(tmpRoot, "cost-ac24");
    const aggregator = new CostAggregator("run-ac24", costDir);

    const costEvent: CostEvent = {
      ts: Date.now(),
      runId: "run-ac24",
      projectKey: "test",
      schemaVersion: 3,
      agentName: "claude",
      model: "haiku",
      stage: "complete" as any,
      sessionRole: "auto" as any,
      tokens: { input: 100, output: 50 },
      estimatedCostUsd: 0.01,
      exactCostUsd: 0.01,
      costUsd: 0.01,
      confidence: "estimated",
      pricingSource: "catalog-rates",
      durationMs: 100,
    };

    aggregator.record(costEvent);
    await aggregator.drain();

    const costFile = join(costDir, "run-ac24.jsonl");
    expect(existsSync(costFile)).toBe(true);
    const content = await Bun.file(costFile).text();
    const lines = content.trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.pricingSource).toBe("catalog-rates");
  });

  // AC-25: buildSessionTurnEvent forwards pricingSource from TurnResult
  test("AC-25: buildSessionTurnEvent forwards pricingSource from TurnResult", () => {
    // Turn 1: TurnResult with pricingSource catalog-rates
    const event = buildSessionTurnEvent({
      handle: {
        id: "sess-1",
        agentName: "native",
        modelDef: { provider: "openai", model: "gpt-5.4-mini" },
      } as any,
      sessionRole: "implementer" as any,
      prompt: "hello",
      result: {
        output: "world",
        tokenUsage: { inputTokens: 10, outputTokens: 5 },
        estimatedCostUsd: 0.01,
        internalRoundTrips: 1,
        pricingSource: "catalog-rates",
      } as TurnResult,
      agentName: "native",
      stage: "run" as any,
      opts: {} as any,
      resolvedPermissions: { mode: "approve-all" },
      startedAt: Date.now(),
    });

    expect(event.pricingSource).toBe("catalog-rates");
  });
});

// ============================================================================
// US-005: Grep discloses literal search when pattern contains regex metacharacters
// ============================================================================

describe("US-005 — Grep discloses literal search", () => {
  let grepRoot: string;

  beforeEach(() => {
    grepRoot = makeTempDir("nax-grep-accept-");
    mkdirSync(join(grepRoot, "src"), { recursive: true });
    writeFileSync(join(grepRoot, "src", "a.ts"), "export const needle = 1;\n");
    writeFileSync(join(grepRoot, "src", "b.ts"), "export const other = 2;\n");
  });

  afterEach(() => {
    if (grepRoot) cleanupTempDir(grepRoot);
  });

  const realWhich = _grepDeps.which;

  afterEach(() => {
    _grepDeps.which = realWhich;
  });

  function ctx(resolvedPaths: readonly string[] = []) {
    return { root: grepRoot, resolvedPaths, maxBytes: 10000, maxFileBytes: 10000 };
  }

  // AC-26: Zero-match regex metacharacter pattern discloses literal search
  test("AC-26: zero-match with regex metacharacters discloses literal search", async () => {
    // No file contains 'export.*divide' literally
    const res = await grepTool.run({ pattern: "export.*divide" }, ctx());
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('no matches for "export.*divide"');
    expect(res.content).toContain("literally");
    expect(res.content).toContain("regex metacharacters");
    expect(res.content).toContain("not interpreted");
  });

  // AC-27: Zero-match pattern without regex metacharacters does NOT mention them
  test("AC-27: zero-match without metacharacters does not mention regex", async () => {
    // No file contains 'divide' literally
    const res = await grepTool.run({ pattern: "divide" }, ctx());
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('no matches for "divide"');
    // Must NOT contain keywords related to the disclosure
    expect(res.content.toLowerCase()).not.toContain("regex");
    expect(res.content.toLowerCase()).not.toContain("literally");
    expect(res.content.toLowerCase()).not.toContain("metacharacter");
  });

  // AC-28: Zero-match with regex metacharacters has no isError set
  test("AC-28: zero-match regex metacharacter pattern has isError unset", async () => {
    const res = await grepTool.run({ pattern: "export.*divide" }, ctx());
    expect(res.isError).toBeFalsy();
    // Also check the property is either absent or undefined/false
    expect("isError" in res ? res.isError : undefined).toBeFalsy();
  });

  // AC-29: Matching pattern with metacharacters includes match results
  test("AC-29: matching pattern with metacharacters returns matches without disclosure", async () => {
    const cPath = join(grepRoot, "src", "c.ts");
    writeFileSync(cPath, "export.*divide is in this file\n");
    try {
      const res = await grepTool.run({ pattern: "export.*divide" }, ctx());
      expect(res.isError).toBeFalsy();
      expect(res.content).toContain("src/c.ts");
      // Must NOT contain the disclosure clause
      expect(res.content.toLowerCase()).not.toContain("regex metacharacters");
      expect(res.content.toLowerCase()).not.toContain("literally");
      expect(res.content.toLowerCase()).not.toContain("not interpreted");
    } finally {
      rmSync(cPath, { force: true });
    }
  });

  // AC-30: Neither binary available returns error, unchanged by metacharacter disclosure
  test("AC-30: no binary available returns isError true, unchanged", async () => {
    _grepDeps.which = () => null;
    const res = await grepTool.run({ pattern: "needle" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/ripgrep|grep/);
  });
});