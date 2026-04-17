/**
 * Amendment B AC-51: planDigestBoost
 *
 * For stages single-session, tdd-simple, no-test, and batch the plan digest
 * is injected as a scored RawChunk (id: "plan-digest:<hash>") with a boosted
 * rawScore. For all other stages the priorStageDigest remains raw markdown only.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { ContextOrchestrator, _orchestratorDeps } from "../../../../src/context/engine/orchestrator";
import { getStageContextConfig, STAGE_CONTEXT_MAP } from "../../../../src/context/engine/stage-config";
import type { ContextRequest } from "../../../../src/context/engine/types";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

let _seq = 0;
beforeEach(() => {
  _seq = 0;
  _orchestratorDeps.uuid = () => `test-uuid-${++_seq}` as `${string}-${string}-${string}-${string}-${string}`;
  _orchestratorDeps.now = () => Date.now();
});

const PLAN_DIGEST = "Plan summary: touch auth.ts, use _deps pattern, tests in test/unit/auth.";

const BASE_REQUEST: ContextRequest = {
  storyId: "US-001",
  repoRoot: "/project",
  packageDir: "/project",
  stage: "single-session",
  role: "implementer",
  budgetTokens: 10_000,
  providerIds: [],
  priorStageDigest: PLAN_DIGEST,
};

// ─────────────────────────────────────────────────────────────────────────────
// Stage config tests
// ─────────────────────────────────────────────────────────────────────────────

describe("StageContextConfig.planDigestBoost", () => {
  test.each(["single-session", "tdd-simple", "no-test", "batch"])(
    "%s has planDigestBoost >= 1.5",
    (stage) => {
      const cfg = getStageContextConfig(stage);
      expect(cfg.planDigestBoost).toBeGreaterThanOrEqual(1.5);
    },
  );

  test.each(["execution", "verify", "review-semantic", "plan", "tdd-test-writer", "tdd-implementer"])(
    "%s has planDigestBoost absent or <= 1",
    (stage) => {
      const cfg = getStageContextConfig(stage);
      expect(cfg.planDigestBoost ?? 1.0).toBeLessThanOrEqual(1.0);
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator: plan-digest chunk injection
// ─────────────────────────────────────────────────────────────────────────────

describe("ContextOrchestrator — planDigestBoost (Amendment B AC-51)", () => {
  test("plan-digest chunk is injected into includedChunks when planDigestBoost > 1", async () => {
    const orch = new ContextOrchestrator([]);
    const bundle = await orch.assemble({ ...BASE_REQUEST, planDigestBoost: 1.5 });
    const planChunk = bundle.manifest.includedChunks.find((id) => id.startsWith("plan-digest:"));
    expect(planChunk).toBeDefined();
  });

  test("plan-digest chunk appears in bundle.chunks when boosted", async () => {
    const orch = new ContextOrchestrator([]);
    const bundle = await orch.assemble({ ...BASE_REQUEST, planDigestBoost: 1.5 });
    const chunk = bundle.chunks.find((c) => c.id.startsWith("plan-digest:"));
    expect(chunk).toBeDefined();
    expect(chunk?.content).toBe(PLAN_DIGEST);
  });

  test("plan-digest chunk is NOT injected when planDigestBoost absent", async () => {
    const orch = new ContextOrchestrator([]);
    const bundle = await orch.assemble({ ...BASE_REQUEST }); // no planDigestBoost
    const planChunk = bundle.manifest.includedChunks.find((id) => id.startsWith("plan-digest:"));
    expect(planChunk).toBeUndefined();
  });

  test("plan-digest chunk is NOT injected when planDigestBoost <= 1", async () => {
    const orch = new ContextOrchestrator([]);
    const bundle = await orch.assemble({ ...BASE_REQUEST, planDigestBoost: 1.0 });
    const planChunk = bundle.manifest.includedChunks.find((id) => id.startsWith("plan-digest:"));
    expect(planChunk).toBeUndefined();
  });

  test("plan-digest chunk is NOT injected when priorStageDigest is absent", async () => {
    const orch = new ContextOrchestrator([]);
    const bundle = await orch.assemble({ ...BASE_REQUEST, priorStageDigest: undefined, planDigestBoost: 1.5 });
    const planChunk = bundle.manifest.includedChunks.find((id) => id.startsWith("plan-digest:"));
    expect(planChunk).toBeUndefined();
  });

  test("boosted plan-digest chunk has higher rawScore than session-scratch chunks (0.9)", async () => {
    const orch = new ContextOrchestrator([]);
    const bundle = await orch.assemble({ ...BASE_REQUEST, planDigestBoost: 1.5 });
    const chunk = bundle.chunks.find((c) => c.id.startsWith("plan-digest:"));
    // rawScore should be 0.9 * 1.5 = 1.35, exceeding normal session rawScore of 0.9
    expect(chunk?.rawScore).toBeGreaterThan(0.9);
  });

  test("plan-digest chunk appears in providerResults with providerId 'plan-digest'", async () => {
    const orch = new ContextOrchestrator([]);
    const bundle = await orch.assemble({ ...BASE_REQUEST, planDigestBoost: 1.5 });
    const pr = bundle.manifest.providerResults?.find((p) => p.providerId === "plan-digest");
    expect(pr).toBeDefined();
    expect(pr?.status).toBe("ok");
  });

  test("pushMarkdown contains plan digest content when boosted", async () => {
    const orch = new ContextOrchestrator([]);
    const bundle = await orch.assemble({ ...BASE_REQUEST, planDigestBoost: 1.5 });
    expect(bundle.pushMarkdown).toContain(PLAN_DIGEST);
  });
});
