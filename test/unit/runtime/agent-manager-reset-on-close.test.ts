/**
 * MEM-12: a pre-built `AgentManager` is accepted by `createRuntime` and may be
 * reused across runs (`runtime/index.ts`), but `reset()` had no production call
 * site — so `StoryHopBudget._byStory` (along with cooldowns and the pruned
 * fallback set) accumulated across runs of the same manager. Run teardown must
 * reset the manager so the next run starts from a clean per-run budget.
 */

import { describe, expect, mock, test } from "bun:test";
import { makeAgentAdapter, makeAgentRegistry, makeNaxConfig, withTempDir } from "@test/helpers";
import { AgentManager } from "@/agents/manager";
import type { ResolvedCompleteOptions } from "@/agents/types";
import { createRuntime } from "@/runtime";

const availFailure = {
  category: "availability" as const,
  outcome: "fail-auth" as const,
  retriable: false,
  message: "",
};

/** claude (primary) fails availability, codex (fallback) succeeds. */
function makeRegistry() {
  return makeAgentRegistry({
    getAgent: (name: string) => {
      if (name === "claude") {
        return makeAgentAdapter({
          complete: mock(async () => ({
            output: "",
            tokenUsage: { inputTokens: 0, outputTokens: 0 },
            estimatedCostUsd: 0,
            adapterFailure: availFailure,
          })),
        });
      }
      if (name === "codex") {
        return makeAgentAdapter({
          complete: mock(async () => ({
            output: "from codex",
            tokenUsage: { inputTokens: 0, outputTokens: 0 },
            estimatedCostUsd: 0,
          })),
        });
      }
      return undefined;
    },
  });
}

describe("NaxRuntime.close() resets the shared AgentManager (MEM-12)", () => {
  test("a reused manager starts the next run with a fresh per-story hop budget", async () => {
    await withTempDir(async (dir) => {
      const config = makeNaxConfig({
        agent: {
          fallback: {
            enabled: true,
            map: { claude: ["codex"] },
            maxHopsPerStory: 1,
            onQualityFailure: false,
            rebuildContext: false,
          },
        },
      });
      const manager = new AgentManager(config, makeRegistry());
      const rt = createRuntime(config, dir, { agentManager: manager });
      const options: ResolvedCompleteOptions = {
        modelDef: { provider: "anthropic", model: "claude-sonnet-4-6", env: {} },
        workdir: dir,
        resolvedPermissions: { mode: "approve-reads" as const },
        storyId: "us-001",
      };

      // First run: the story spends its single hop, swapping claude → codex.
      const first = await manager.completeWithFallback("prompt", options);
      expect(first.fallbacks).toHaveLength(1);

      await rt.close();

      // Run teardown cleared the budget and cooldowns, so the SAME story can swap
      // again in the next run instead of being capped by the previous run's hop.
      const second = await manager.completeWithFallback("prompt", options);
      expect(second.fallbacks).toHaveLength(1);
    });
  });
});
