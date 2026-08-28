/**
 * nax#1739 — callOp must hand the complete() path a per-agent model resolver.
 *
 * `completeWithFallback` swaps agents but cannot re-resolve the model itself
 * (`agentManagerConfigSelector` carries no `models`). callOp already owns model
 * policy, so it injects `modelDefFor`. This pins the resolver's semantics, which
 * mirror the run() path's `pinnedModelAgent`: the dispatch agent keeps the model
 * callOp resolved for it, any other agent re-resolves from its own tier map.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { makeMockAgentManager, makeMockRuntime, makeNaxConfig } from "@test/helpers";
import type { CompleteOptions } from "@/agents/types";
import { type DEFAULT_CONFIG, pickSelector } from "@/config";
import type { CompleteOperation } from "@/operations";
import { callOp } from "@/operations";
import type { NaxRuntime } from "@/runtime";

const testSel = pickSelector("complete-model-resolver-test", "routing");
const createdRuntimes: NaxRuntime[] = [];

afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});

const MODELS = {
  claude: { fast: "claude-haiku", balanced: "claude-sonnet", powerful: "claude-opus" },
  codex: { fast: "gpt-5.4-mini", balanced: "gpt-5.6-luna", powerful: "gpt-5.6-sol" },
};

/** Captures the CompleteOptions callOp builds, without dispatching anything. */
function runtimeCapturing(seen: CompleteOptions[]): NaxRuntime {
  const agentManager = makeMockAgentManager({
    completeAsWithFallbackFn: async (_agent: string, _prompt: string, options?: CompleteOptions) => {
      if (options) seen.push(options);
      return {
        result: { output: "out", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 },
        fallbacks: [],
      };
    },
  });
  const runtime = makeMockRuntime({
    agentManager,
    config: makeNaxConfig({ agent: { default: "claude" }, models: MODELS }),
  });
  createdRuntimes.push(runtime);
  return runtime;
}

function makeCompleteOp(): CompleteOperation<string, string, Pick<typeof DEFAULT_CONFIG, "routing">> {
  return {
    kind: "complete",
    name: "resolver-probe",
    stage: "complete",
    config: testSel,
    model: () => "balanced",
    build: (input) => ({
      role: { id: "role", content: "You process input.", overridable: false },
      task: { id: "task", content: input, overridable: false },
    }),
    parse: (output) => output,
  };
}

function ctxFor(runtime: NaxRuntime) {
  return {
    runtime,
    packageView: runtime.packages.repo(),
    packageDir: "/tmp",
    agentName: "claude",
    storyId: "US-001",
  };
}

describe("callOp injects a per-agent model resolver (nax#1739)", () => {
  test("AC-5: the complete options carry a modelDefFor resolver", async () => {
    const seen: CompleteOptions[] = [];

    await callOp(ctxFor(runtimeCapturing(seen)), makeCompleteOp(), "input");

    expect(seen).toHaveLength(1);
    expect(typeof seen[0].modelDefFor).toBe("function");
  });

  test("AC-6: the resolver returns the fallback agent's own model at the same tier", async () => {
    const seen: CompleteOptions[] = [];

    await callOp(ctxFor(runtimeCapturing(seen)), makeCompleteOp(), "input");

    expect(seen[0].modelDef.model).toBe("claude-sonnet");
    expect(seen[0].modelDefFor?.("codex")?.model).toBe("gpt-5.6-luna");
  });

  test("AC-7: the dispatch agent keeps the modelDef callOp resolved for it", async () => {
    const seen: CompleteOptions[] = [];

    await callOp(ctxFor(runtimeCapturing(seen)), makeCompleteOp(), "input");

    expect(seen[0].modelDefFor?.("claude")).toEqual(seen[0].modelDef);
  });
});
