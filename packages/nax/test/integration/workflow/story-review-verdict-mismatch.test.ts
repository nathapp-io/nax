import { afterEach, describe, expect, test } from "bun:test";
import { assertDefined, makeMockAgentManager, makeSessionManager, makeTestRuntime } from "@test/helpers";
import { callOp, workflowStoryReviewOp } from "@/operations";
import { buildWorkflowReviewJsonRetry, buildWorkflowVerdictMismatchRetry } from "@/prompts";
import type { NaxRuntime } from "@/runtime";

let runtime: NaxRuntime | undefined;
afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

const mismatch = JSON.stringify({ spec: "fail", quality: "approved", findings: [] });
const pass = JSON.stringify({ spec: "pass", quality: "approved", findings: [] });

async function run(replies: string[]) {
  const prompts: string[] = [];
  const agentManager = makeMockAgentManager({
    runWithFallbackFn: async (req) => {
      assertDefined(req.executeHop, "executeHop");
      const hop = await req.executeHop("claude", undefined, { kind: "primary" }, req.runOptions);
      return { result: { ...hop.result, agentFallbacks: [] }, fallbacks: [] };
    },
    runAsSessionFn: async (_agent, _handle, prompt) => {
      prompts.push(prompt);
      return {
        output: replies[prompts.length - 1] ?? "unexpected turn",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0,
        internalRoundTrips: 0,
      };
    },
  });
  runtime = makeTestRuntime({ agentManager, sessionManager: makeSessionManager() });
  const result = await callOp(
    { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-002" },
    workflowStoryReviewOp,
    { prompt: "review", timeoutMs: 1000 },
  );
  return { result, prompts };
}

describe("story review mismatch retry through callOp", () => {
  test("mismatch followed by pass uses exactly two turns with specific prompt", async () => {
    const { result, prompts } = await run([mismatch, pass]);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toBe(buildWorkflowVerdictMismatchRetry(["spec"]));
    expect(result?.spec).toBe("pass");
  });
  test("persistent mismatch returns the final verdict", async () => {
    const { result, prompts } = await run([mismatch, mismatch]);
    expect(prompts).toHaveLength(2);
    expect(result?.mismatch).toEqual(["spec"]);
  });
  test("invalid JSON then mismatch spends the single retry", async () => {
    const { result, prompts } = await run(["not json", mismatch]);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toBe(buildWorkflowReviewJsonRetry());
    expect(result?.mismatch).toEqual(["spec"]);
  });
  test("mismatch then invalid JSON returns null", async () => {
    const { result, prompts } = await run([mismatch, "not json"]);
    expect(prompts).toHaveLength(2);
    expect(result).toBeNull();
  });
});
