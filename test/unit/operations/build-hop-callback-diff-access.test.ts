/**
 * #1800 — the diff-access substitution must reach the agent on the run() path.
 *
 * `callOp` dispatches through `buildHopCallback` as `request.executeHop`, and
 * `AgentManager.runWithFallback` invokes `executeHop` INSTEAD OF `_runHop`, so
 * `createSessionRunHop` is bypassed entirely there. Both review ops are
 * `kind: "run"`, so this is the site their prompts actually pass through.
 *
 * Asserted here rather than on the renderer for the reason the sibling
 * context-tools suite records: deleting this wiring passes every other test in
 * the repository. The preamble beside it is applied only when the op also has
 * context pull tools, and a review op need not have any — so the two cannot
 * share a gate either.
 */
import { describe, expect, mock, test } from "bun:test";
import { makeContextBundle, makeMockAgentManager, makeNaxConfig, makeSessionManager, makeStory } from "@test/helpers";
import type { AgentRunOptions, HopKind, SessionHandle, TurnResult } from "@/agents";
import type { BuildHopCallbackContext } from "@/operations";
import { buildHopCallback } from "@/operations";
import { wrapDiffAccess } from "@/prompts/sections/diff-access";

const WORKDIR = "/repo";
const PROMPT = `review US-001\n${wrapDiffAccess({ ref: "abc123", fullExclude: [".", ":!.nax/"] }, "SHELL BODY\n")}end`;

function makeCtx(agentName: string, prompts: string[]): BuildHopCallbackContext {
  const handle: SessionHandle = { id: "nax-diff-access", agentName };
  return {
    sessionManager: makeSessionManager({ openSession: mock(async () => handle) }),
    agentManager: makeMockAgentManager({
      runAsSessionFn: (_agentName, _handle, prompt): Promise<TurnResult> => {
        prompts.push(prompt);
        return Promise.resolve({
          output: "ok",
          internalRoundTrips: 1,
          tokenUsage: { inputTokens: 1, outputTokens: 1 },
          estimatedCostUsd: 0,
        });
      },
    }),
    story: makeStory({ id: "US-001" }),
    config: makeNaxConfig(),
    featureName: "diff-access",
    workdir: WORKDIR,
    effectiveTier: "balanced",
    defaultAgent: agentName,
    pipelineStage: "review",
  };
}

/** The prompt the agent was actually dispatched — the only seam that proves reachability. */
async function dispatchedPrompt(agentName: string): Promise<string> {
  const prompts: string[] = [];
  const ctx = makeCtx(agentName, prompts);
  const options: AgentRunOptions = {
    prompt: PROMPT,
    workdir: WORKDIR,
    modelTier: "balanced",
    modelDef: { provider: "anthropic", model: "claude-sonnet-4-5" },
    timeoutSeconds: 60,
    config: ctx.config,
  };

  const cb = buildHopCallback(ctx, "sess-diff-access", options);
  // An empty bundle: a review op need not carry context pull tools, and the
  // substitution must not depend on whether it does.
  await cb(agentName, makeContextBundle({ pullTools: [] }), { kind: "primary" } satisfies HopKind, options);

  return prompts[0] ?? "";
}

describe("buildHopCallback — diff access is rendered for the dispatched protocol", () => {
  test("a native dispatch receives tool-shaped diff instructions", async () => {
    const prompt = await dispatchedPrompt("native");
    expect(prompt).toContain("review US-001");
    expect(prompt).toContain('"subcommand":"diff"');
    expect(prompt).not.toContain("SHELL BODY");
  });

  test("an ACP dispatch keeps the shell body", async () => {
    const prompt = await dispatchedPrompt("claude");
    expect(prompt).toContain("SHELL BODY");
    expect(prompt).not.toContain('"subcommand":"diff"');
  });

  test("no agent is ever dispatched a marker", async () => {
    for (const agent of ["native", "claude"]) {
      expect(await dispatchedPrompt(agent)).not.toContain("nax:diff-access");
    }
  });
});
