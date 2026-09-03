/**
 * The PRODUCER for `AgentRunOptions.outputDir`.
 *
 * `resolveCodingToolSupport` reads this field to place the tool-audit ledger.
 * A field with no producer is nax#1744 / the `transcriptDir` shape: the seam's
 * own tests stay green, the consumer quietly takes its fallback branch, and the
 * chain is dead end to end. C1 added `codingToolRoot` with no test on its
 * producer at all, so this asserts on what actually reaches `runWithFallback`
 * rather than on the object literal in call.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { assertDefined, makeMockAgentManager, makeMockRuntime } from "@test/helpers";
import type { AgentRunOptions } from "@/agents";
import { type DEFAULT_CONFIG, pickSelector } from "@/config";
import { callOp, type RunOperation } from "@/operations";
import type { NaxRuntime } from "@/runtime";

const testSel = pickSelector("output-dir-producer-test", "routing");
const createdRuntimes: NaxRuntime[] = [];

afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});

function makeOp(): RunOperation<string, string, Pick<typeof DEFAULT_CONFIG, "routing">> {
  return {
    kind: "run",
    name: "output-dir-producer",
    stage: "run",
    config: testSel,
    session: { role: "implementer", lifetime: "fresh" },
    build: (input) => ({
      role: { id: "role", content: "You process input.", overridable: false },
      task: { id: "task", content: input, overridable: false },
    }),
    parse: (output) => output,
  };
}

describe("callOp produces AgentRunOptions.outputDir", () => {
  test("hands the runtime's output dir to the dispatch that resolves coding tools", async () => {
    const seen: AgentRunOptions[] = [];
    const runtime = makeMockRuntime({
      agentManager: makeMockAgentManager({
        runWithFallbackFn: async (req) => {
          seen.push(req.runOptions);
          const { executeHop } = req;
          assertDefined(executeHop, "req.executeHop");
          const hopResult = await executeHop("claude", undefined, { kind: "primary" }, req.runOptions);
          return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [] };
        },
        runAsSessionFn: async () => ({
          output: "done",
          estimatedCostUsd: 0,
          internalRoundTrips: 0,
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
        }),
      }),
    });
    createdRuntimes.push(runtime);

    await callOp(
      { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude" },
      makeOp(),
      "input",
    );

    expect(seen.length).toBe(1);
    expect(seen[0]?.outputDir).toBe(runtime.outputDir);
    // The point of the field: it must not collapse to the tool root, which is
    // the story's package workdir inside a worktree git later removes.
    expect(seen[0]?.outputDir).not.toBe(seen[0]?.codingToolRoot);
  });
});
