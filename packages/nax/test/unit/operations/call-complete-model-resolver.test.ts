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
import {
  makeMockAgentManager,
  makeMockCallContext,
  makeMockRuntime,
  makeNaxConfig,
  makeSessionManager,
  makeTestRuntime,
} from "@test/helpers";
import type { AgentFallbackRecord } from "@/agents/manager-types";
import type { AgentRunOptions, CompleteOptions } from "@/agents/types";
import { type DEFAULT_CONFIG, type NaxConfig, NaxConfigSchema, pickSelector } from "@/config";
import type { BuildHopCallbackContext, CompleteOperation, RunOperation } from "@/operations";
import { _callOpDeps, callOp } from "@/operations";
import type { NaxRuntime } from "@/runtime";
import type { ToolProvider } from "@/tools";

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
        dispatchesCompleted: 1,
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

  test("AC-8: an agent with no models entry degrades to the default agent's, exactly as run() does", async () => {
    const seen: CompleteOptions[] = [];
    const runtime = makeMockRuntime({
      agentManager: makeMockAgentManager({
        completeAsWithFallbackFn: async (_a: string, _p: string, options?: CompleteOptions) => {
          if (options) seen.push(options);
          return {
            result: { output: "out", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 },
            fallbacks: [],
            dispatchesCompleted: 1,
          };
        },
      }),
      config: makeNaxConfig({ agent: { default: "claude" }, models: { claude: MODELS.claude } }),
    });
    createdRuntimes.push(runtime);

    await callOp(ctxFor(runtime), makeCompleteOp(), "input");

    // resolveModelForAgent falls back to models[defaultAgent][tier] before throwing,
    // so a fallback agent the operator never gave models still dispatches the default
    // agent's model. Pinned rather than fixed: the run() path resolves identically
    // (build-hop-callback.ts), and diverging here would put the two seams out of step.
    expect(seen[0].modelDefFor?.("agent-with-no-models")?.model).toBe("claude-sonnet");
  });
});

// ---------------------------------------------------------------------------
// Complete-path fallback recording (nax#1712) — absorbed from
// call-complete-fallback-recording.test.ts.
// ---------------------------------------------------------------------------

const recordingCompleteTestSel = pickSelector("complete-fallback-recording-test", "routing");

function completeHop(overrides: Partial<AgentFallbackRecord> = {}): AgentFallbackRecord {
  return {
    storyId: "US-001",
    priorAgent: "claude",
    newAgent: "codex",
    hop: 1,
    outcome: "fail-quota",
    category: "availability",
    timestamp: "2026-08-25T00:00:00.000Z",
    costUsd: 0.25,
    ...overrides,
  };
}

/** A manager whose completeAsWithFallback reports `fallbacks` beside a good result. */
function completeRecordingRuntimeWith(fallbacks: AgentFallbackRecord[]): NaxRuntime {
  const agentManager = makeMockAgentManager({
    completeAsWithFallbackFn: async () => ({
      result: {
        output: "complete-out",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0,
      },
      fallbacks,
      dispatchesCompleted: 1,
    }),
  });
  const runtime = makeMockRuntime({ agentManager });
  createdRuntimes.push(runtime);
  return runtime;
}

function makeCompleteRecordingOp(
  name: string,
): CompleteOperation<string, string, Pick<typeof DEFAULT_CONFIG, "routing">> {
  return {
    kind: "complete",
    name,
    stage: "complete",
    config: recordingCompleteTestSel,
    build: (input) => ({
      role: { id: "role", content: "You process input.", overridable: false },
      task: { id: "task", content: input, overridable: false },
    }),
    parse: (output) => output,
  };
}

function completeRecordingCtxFor(runtime: NaxRuntime, storyId?: string) {
  return {
    runtime,
    packageView: runtime.packages.repo(),
    packageDir: "/tmp",
    agentName: "claude",
    ...(storyId !== undefined ? { storyId } : {}),
  };
}

describe("callOp records complete()-path agent-swap hops (#1712)", () => {
  test("AC-3: appends the hops completeAsWithFallback reported, keyed by story", async () => {
    const recorded = [completeHop()];
    const runtime = completeRecordingRuntimeWith(recorded);

    await callOp(completeRecordingCtxFor(runtime, "US-001"), makeCompleteRecordingOp("record-one"), "input");

    expect(runtime.agentFallbacks.get("US-001")).toEqual(recorded);
  });

  test("AC-4: a second writer accumulates rather than replacing", async () => {
    const runtime = completeRecordingRuntimeWith([completeHop({ hop: 1 })]);

    await callOp(completeRecordingCtxFor(runtime, "US-001"), makeCompleteRecordingOp("first-op"), "input");
    await callOp(completeRecordingCtxFor(runtime, "US-001"), makeCompleteRecordingOp("second-op"), "input");

    expect(runtime.agentFallbacks.get("US-001")).toHaveLength(2);
  });

  test("AC-5: an ad-hoc call carrying no storyId records nothing", async () => {
    const runtime = completeRecordingRuntimeWith([completeHop()]);

    await callOp(completeRecordingCtxFor(runtime), makeCompleteRecordingOp("no-story"), "input");

    expect(runtime.agentFallbacks.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Runtime tool-provider injection (absorbed from call-tool-providers.test.ts).
// ---------------------------------------------------------------------------

const providersTestSel = pickSelector("test", "routing");

const providersRunEchoOp: RunOperation<{ text: string }, string, Pick<typeof DEFAULT_CONFIG, "routing">> = {
  kind: "run",
  name: "run-echo-provider-injection",
  stage: "run",
  config: providersTestSel,
  session: { role: "implementer", lifetime: "fresh" },
  build: (input) => ({
    role: { id: "role", content: "You echo text.", overridable: false },
    task: { id: "task", content: input.text, overridable: false },
  }),
  parse: (output) => output.trim(),
};

const configWithMcpServer = (): NaxConfig => {
  const parsed = NaxConfigSchema.parse({
    name: "probe",
    mcp: { servers: { memory: { command: "fake", stages: ["run"] } } },
  });
  return { ...parsed, version: 1 };
};

interface CapturedOptions {
  providers: readonly ToolProvider[] | undefined;
  runtimeProviders: readonly ToolProvider[];
}

async function runOpAndCaptureProviders(config: NaxConfig | undefined): Promise<CapturedOptions> {
  const orig = _callOpDeps.buildHopCallback;
  let seenProviders: readonly ToolProvider[] | undefined;
  _callOpDeps.buildHopCallback = (
    _hopCtx: BuildHopCallbackContext,
    _sessionId: string | undefined,
    runOptions: AgentRunOptions,
  ) => {
    seenProviders = runOptions.providers;
    return async () => ({
      result: {
        success: true,
        exitCode: 0,
        output: "ok",
        rateLimited: false,
        durationMs: 0,
        estimatedCostUsd: 0,
      },
      bundle: undefined,
    });
  };

  const agentManager = makeMockAgentManager({});
  const runtime = makeTestRuntime({ config, agentManager, sessionManager: makeSessionManager({}) });
  try {
    await callOp(
      makeMockCallContext({
        runtime,
        packageView: runtime.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
      }),
      providersRunEchoOp,
      { text: "hi" },
    ).catch(() => undefined);
  } finally {
    _callOpDeps.buildHopCallback = orig;
    await runtime.close();
  }
  return { providers: seenProviders, runtimeProviders: runtime.toolProviders };
}

describe("callOp — runtime tool providers reach run options", () => {
  test("no MCP servers: run options carry no `providers` key", async () => {
    const { providers, runtimeProviders } = await runOpAndCaptureProviders(undefined);
    expect(runtimeProviders).toEqual([]);
    expect(providers).toBeUndefined();
  });

  test("a configured server: run options carry the runtime's providers array", async () => {
    const { providers, runtimeProviders } = await runOpAndCaptureProviders(configWithMcpServer());
    expect(runtimeProviders.map((p) => p.id)).toEqual(["memory"]);
    expect(providers).toBe(runtimeProviders);
  });
});
