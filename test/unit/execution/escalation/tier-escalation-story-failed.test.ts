/**
 * preIterationTierCheck — story:failed event emission (BUG-5) and the
 * on-story-fail hook single-fire regression (follow-up code review round).
 *
 * Split out of tier-escalation.test.ts (file-size ratchet — see
 * .claude/rules/project-conventions.md) by describe-block concern.
 *
 * When a story exhausts its final tier's attempt budget (no next tier to
 * escalate to), preIterationTierCheck marks it failed and emits story:failed
 * on the pipeline event bus. Historically it never emitted story:failed at
 * all — even though story:started was already emitted for it — so reporters,
 * the events file, the TUI, and the max-retries interaction trigger never
 * learned the story reached a terminal state (BUG-5).
 *
 * A later fix round then made preIterationTierCheck call `fireHook(hooks,
 * "on-story-fail", ...)` directly IN ADDITION to emitting story:failed — but
 * wireHooks (src/pipeline/subscribers/hooks.ts) already subscribes to
 * story:failed on the very same bus and fires "on-story-fail" itself, so the
 * hook fired twice for every terminal tier-exhaustion. The fix removes the
 * direct fireHook call, leaving the bus subscriber as the single source of
 * the hook firing (matching the sibling emitters in tier-outcome.ts, which
 * never called fireHook directly).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeMockRuntime, makeNaxConfig, makePRD, makeStory, makeTempDir } from "@test/helpers";
import type { LoadedHooksConfig } from "@/hooks";
import { pipelineEventBus } from "@/pipeline";
import { wireHooks } from "@/pipeline/subscribers/hooks";

describe("preIterationTierCheck — story:failed event emission (BUG-5)", () => {
  type StoryFailedPayload = {
    type: "story:failed";
    storyId: string;
    reason: string;
    countsTowardEscalation: boolean;
    feature?: string;
    attempts?: number;
    cost?: number;
  };
  let capturedEvents: StoryFailedPayload[] = [];
  let unsubscribe: (() => void) | undefined;

  beforeEach(() => {
    capturedEvents = [];
    unsubscribe = pipelineEventBus.on("story:failed", (event) => {
      capturedEvents.push(event as StoryFailedPayload);
    });
  });

  afterEach(() => {
    unsubscribe?.();
  });

  test("emits story:failed when the story has exhausted the final tier's budget (no next tier)", async () => {
    const { preIterationTierCheck, _tierEscalationDeps } = await import("@/execution/escalation/tier-escalation");

    const origSavePRD = _tierEscalationDeps.savePRD;
    _tierEscalationDeps.savePRD = () => Promise.resolve();

    try {
      // attempts === tierCfg.attempts (1) for the ONLY tier in tierOrder → no
      // escalation possible, budget exhausted → terminal fail path.
      const story = makeStory({
        id: "US-terminal-fail-001",
        title: "Terminal story",
        status: "in-progress",
        attempts: 1,
        routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
      });
      const prd = makePRD({ userStories: [story] });
      const config = makeNaxConfig({
        autoMode: { escalation: { enabled: true, tierOrder: [{ tier: "fast", attempts: 1 }] } },
        routing: { llm: { mode: "per-story" } },
      });
      const hooks: LoadedHooksConfig = { hooks: {} };

      const result = await preIterationTierCheck(
        story,
        { modelTier: "fast" },
        config,
        prd,
        "/tmp/test-prd-terminal-fail.json",
        undefined,
        hooks,
        "f",
        0,
        "/tmp",
      );

      expect(result.shouldSkipIteration).toBe(true);
      expect(result.prd.userStories.find((s) => s.id === story.id)?.status).toBe("failed");

      expect(capturedEvents).toHaveLength(1);
      expect(capturedEvents[0]).toMatchObject({
        type: "story:failed",
        storyId: "US-terminal-fail-001",
        countsTowardEscalation: true,
        feature: "f",
      });
      expect(capturedEvents[0].reason).toContain("All tiers exhausted");
    } finally {
      _tierEscalationDeps.savePRD = origSavePRD;
    }
  });

  test("does not emit story:failed when the story still has escalation budget or a next tier", async () => {
    const { preIterationTierCheck, _tierEscalationDeps } = await import("@/execution/escalation/tier-escalation");

    const origSavePRD = _tierEscalationDeps.savePRD;
    _tierEscalationDeps.savePRD = () => Promise.resolve();

    try {
      const story = makeStory({
        id: "US-terminal-fail-002",
        status: "in-progress",
        attempts: 1,
        routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
      });
      const prd = makePRD({ userStories: [story] });
      const config = makeNaxConfig({
        autoMode: {
          escalation: {
            enabled: true,
            // Second tier exists — budget exhaustion escalates instead of failing.
            tierOrder: [
              { tier: "fast", attempts: 1 },
              { tier: "balanced", attempts: 2 },
            ],
          },
        },
        routing: { llm: { mode: "per-story" } },
      });
      const hooks: LoadedHooksConfig = { hooks: {} };

      const result = await preIterationTierCheck(
        story,
        { modelTier: "fast" },
        config,
        prd,
        "/tmp/test-prd-terminal-fail-2.json",
        undefined,
        hooks,
        "f",
        0,
        "/tmp",
      );

      expect(result.shouldSkipIteration).toBe(true);
      expect(capturedEvents).toHaveLength(0);
    } finally {
      _tierEscalationDeps.savePRD = origSavePRD;
    }
  });

  test("cost falls back to totalCost when no runtime is passed", async () => {
    const { preIterationTierCheck, _tierEscalationDeps } = await import("@/execution/escalation/tier-escalation");

    const origSavePRD = _tierEscalationDeps.savePRD;
    _tierEscalationDeps.savePRD = () => Promise.resolve();

    try {
      const story = makeStory({
        id: "US-cost-fallback",
        status: "in-progress",
        attempts: 1,
        routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
      });
      const prd = makePRD({ userStories: [story] });
      const config = makeNaxConfig({
        autoMode: { escalation: { enabled: true, tierOrder: [{ tier: "fast", attempts: 1 }] } },
        routing: { llm: { mode: "per-story" } },
      });
      const hooks: LoadedHooksConfig = { hooks: {} };

      await preIterationTierCheck(
        story,
        { modelTier: "fast" },
        config,
        prd,
        "/tmp/x.json",
        undefined,
        hooks,
        "f",
        4.5,
        "/tmp",
      );

      expect(capturedEvents).toHaveLength(1);
      expect(capturedEvents[0].cost).toBe(4.5);
    } finally {
      _tierEscalationDeps.savePRD = origSavePRD;
    }
  });

  test("cost uses the per-story total from runtime.costAggregator.byStory() when a runtime is passed", async () => {
    const { preIterationTierCheck, _tierEscalationDeps } = await import("@/execution/escalation/tier-escalation");

    const origSavePRD = _tierEscalationDeps.savePRD;
    _tierEscalationDeps.savePRD = () => Promise.resolve();

    try {
      const story = makeStory({
        id: "US-cost-per-story",
        status: "in-progress",
        attempts: 1,
        routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
      });
      const prd = makePRD({ userStories: [story] });
      const config = makeNaxConfig({
        autoMode: { escalation: { enabled: true, tierOrder: [{ tier: "fast", attempts: 1 }] } },
        routing: { llm: { mode: "per-story" } },
      });
      const hooks: LoadedHooksConfig = { hooks: {} };
      const runtime = makeMockRuntime({ config });
      runtime.costAggregator.record({
        ts: Date.now(),
        runId: "test-run",
        agentName: "claude",
        model: "test-model",
        storyId: story.id,
        tokens: { input: 10, output: 10 },
        estimatedCostUsd: 1.25,
        exactCostUsd: 1.25,
        costUsd: 1.25,
        confidence: "estimated",
        durationMs: 100,
      });

      // totalCost (the run-wide accumulator, deliberately different from the
      // per-story cost) must NOT leak onto the event when a runtime is present.
      await preIterationTierCheck(
        story,
        { modelTier: "fast" },
        config,
        prd,
        "/tmp/x2.json",
        undefined,
        hooks,
        "f",
        99,
        "/tmp",
        runtime,
      );

      expect(capturedEvents).toHaveLength(1);
      expect(capturedEvents[0].cost).toBe(1.25);
    } finally {
      _tierEscalationDeps.savePRD = origSavePRD;
    }
  });
});

describe("preIterationTierCheck — on-story-fail hook fires exactly once (regression)", () => {
  let workdir: string;
  let unsubscribeHooks: (() => void) | undefined;

  beforeEach(() => {
    workdir = makeTempDir("nax-tier-escalation-hook-once-");
  });

  afterEach(() => {
    unsubscribeHooks?.();
    cleanupTempDir(workdir);
  });

  test("terminal tier-exhaustion fires the on-story-fail hook exactly once", async () => {
    const { preIterationTierCheck, _tierEscalationDeps } = await import("@/execution/escalation/tier-escalation");

    const origSavePRD = _tierEscalationDeps.savePRD;
    _tierEscalationDeps.savePRD = () => Promise.resolve();

    // A tiny counter script — invoked in argv mode (no shell) by the real hook
    // runner. Each invocation increments the integer stored in markerPath.
    const scriptPath = join(workdir, "counter.js");
    const markerPath = join(workdir, "marker.txt");
    await Bun.write(
      scriptPath,
      [
        'const fs = require("fs");',
        "const path = process.argv[2];",
        "let n = 0;",
        'try { n = parseInt(fs.readFileSync(path, "utf8"), 10) || 0; } catch {}',
        "fs.writeFileSync(path, String(n + 1));",
      ].join("\n"),
    );

    const hooks: LoadedHooksConfig = {
      hooks: {
        "on-story-fail": { command: `bun ${scriptPath} ${markerPath}`, timeout: 5000 },
      },
    };

    unsubscribeHooks = wireHooks(pipelineEventBus, hooks, workdir, "f");

    try {
      const story = makeStory({
        id: "US-hook-once",
        status: "in-progress",
        attempts: 1,
        routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
      });
      const prd = makePRD({ userStories: [story] });
      const config = makeNaxConfig({
        autoMode: { escalation: { enabled: true, tierOrder: [{ tier: "fast", attempts: 1 }] } },
        routing: { llm: { mode: "per-story" } },
      });

      const result = await preIterationTierCheck(
        story,
        { modelTier: "fast" },
        config,
        prd,
        join(workdir, "prd.json"),
        undefined,
        hooks,
        "f",
        0,
        workdir,
      );
      expect(result.shouldSkipIteration).toBe(true);

      // The hook runs via the bus subscriber, which is async (fire-and-forget) —
      // drain the bus's pending subscriber promises before asserting.
      await pipelineEventBus.drain();

      const markerText = await Bun.file(markerPath)
        .text()
        .catch(() => "0");
      expect(markerText.trim()).toBe("1");
    } finally {
      _tierEscalationDeps.savePRD = origSavePRD;
    }
  });
});
