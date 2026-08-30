/**
 * `generateSetupPlan` is a thin `callOp(ctx, setupGenerateOp, analysis)` wrapper.
 * `setupGenerateOp` itself is covered exhaustively in
 * test/unit/operations/setup-generate.test.ts — this test only proves the
 * wrapper actually delegates through callOp with the real op, end to end.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { makeAgentAdapter, makeMockCallContext, makeRuntimeWithFakeAgent } from "@test/helpers";
import { generateSetupPlan } from "@/cli/setup-llm";
import type { RepoAnalysis } from "@/cli/setup-types";
import type { NaxRuntime } from "@/runtime";

function makeAnalysis(): RepoAnalysis {
  return {
    shape: "single",
    packages: [{ relativeDir: "", testFramework: "bun", testFilePatterns: [], missingScripts: [] }],
    pmRunPrefix: "bun run",
    pmDlx: "bunx",
    orchestrator: "none",
  };
}

function fenced(config: unknown): string {
  return `\`\`\`json\n${JSON.stringify({ config })}\n\`\`\``;
}

const createdRuntimes: NaxRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});

describe("generateSetupPlan", () => {
  test("delegates to callOp(setupGenerateOp) and returns its parsed SetupPlan", async () => {
    const adapter = makeAgentAdapter({
      sendTurn: mock(async () => ({
        output: fenced({}),
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0,
        internalRoundTrips: 1,
      })),
    });
    const { runtime } = makeRuntimeWithFakeAgent(adapter);
    createdRuntimes.push(runtime);
    const ctx = makeMockCallContext({ runtime });

    const plan = await generateSetupPlan(ctx, makeAnalysis());

    expect(plan).toHaveProperty("config");
    expect(plan).toHaveProperty("gaps");
  });

  test("propagates a rejection from the underlying op", async () => {
    const adapter = makeAgentAdapter({
      sendTurn: mock(async () => ({
        output: "not json at all",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0,
        internalRoundTrips: 1,
      })),
    });
    const { runtime } = makeRuntimeWithFakeAgent(adapter);
    createdRuntimes.push(runtime);
    const ctx = makeMockCallContext({ runtime });

    await expect(generateSetupPlan(ctx, makeAnalysis())).rejects.toBeDefined();
  }, 15_000);
});
