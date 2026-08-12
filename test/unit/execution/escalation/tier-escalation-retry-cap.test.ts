/**
 * Tier Escalation — Runtime Crash Retry Cap (quality-review follow-up on BUG-070)
 *
 * A runtime-crash retry-same outcome must not loop forever: after
 * RUNTIME_CRASH_RETRY_CAP consecutive crashes on the same story, the story
 * pauses for human review instead of retrying indefinitely. The counter is
 * in-memory only (never persisted to the PRD) — AC-4/AC-5 in
 * tier-escalation.test.ts require retry-same to never write to disk or dirty
 * the PRD, so this cap must not touch either.
 */

import { describe, expect, test } from "bun:test";

describe("handleTierEscalation — runtime-crash retry cap", () => {
  test("pauses the story once the runtime-crash retry cap is exceeded, instead of looping forever", async () => {
    const mod = await import("@/execution/escalation");
    const { handleTierEscalation, _tierEscalationDeps, _runtimeCrashRetryCounts, RUNTIME_CRASH_RETRY_CAP } = mod;

    const origSavePRD = _tierEscalationDeps.savePRD;
    let saveCalls = 0;
    _tierEscalationDeps.savePRD = () => {
      saveCalls++;
      return Promise.resolve();
    };

    const storyId = "US-002-retry-cap";
    _runtimeCrashRetryCounts.delete(storyId);

    try {
      const story = {
        id: storyId,
        title: "Story",
        description: "Test",
        acceptanceCriteria: [],
        tags: [],
        dependencies: [],
        status: "in-progress" as const,
        passes: false,
        escalations: [],
        attempts: 1,
        routing: { modelTier: "fast", testStrategy: "test-after" },
      };

      const prd = {
        project: "test",
        feature: "f",
        branchName: "b",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        userStories: [story],
      };

      const buildCtx = () => ({
        story,
        storiesToExecute: [story],
        isBatchExecution: false,
        routing: { modelTier: "fast", testStrategy: "test-after" },
        pipelineResult: { reason: "Bun runtime crash", context: { tddFailureCategory: "runtime-crash" } },
        config: {
          autoMode: {
            escalation: {
              enabled: true,
              tierOrder: [
                { tier: "fast", attempts: 2 },
                { tier: "balanced", attempts: 3 },
              ],
            },
          },
          routing: { llm: { mode: "per-story" }, strategy: "keyword" },
          models: {},
        },
        prd,
        prdPath: "/tmp/test-prd-us002-retry-cap.json",
        featureDir: undefined,
        hooks: { hooks: {} },
        feature: "f",
        totalCost: 0,
        workdir: "/tmp",
        runtimeCrashResult: { status: "RUNTIME_CRASH", success: false },
      });

      // Retry up to the cap: still retry-same, still no disk write.
      for (let i = 0; i < RUNTIME_CRASH_RETRY_CAP; i++) {
        const result = await handleTierEscalation(
          buildCtx() as unknown as Parameters<typeof handleTierEscalation>[0], // test-ratchet-allow: as-unknown-as
        );
        expect(result.outcome).toBe("retry-same");
      }
      expect(saveCalls).toBe(0);

      // One more crash beyond the cap must pause the story rather than retry
      // forever. The pause path writes via tier-outcome.ts's own savePRD
      // import (not _tierEscalationDeps), so saveCalls stays 0 here — the
      // retry-same branch's own no-write invariant is what saveCalls proves.
      const finalResult = await handleTierEscalation(
        buildCtx() as unknown as Parameters<typeof handleTierEscalation>[0], // test-ratchet-allow: as-unknown-as
      );
      expect(finalResult.outcome).toBe("paused");
      expect(finalResult.prdDirty).toBe(true);
      expect(saveCalls).toBe(0);
    } finally {
      _tierEscalationDeps.savePRD = origSavePRD;
      _runtimeCrashRetryCounts.delete(storyId);
    }
  });
});
