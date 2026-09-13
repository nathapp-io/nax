/**
 * callOp — MCP tool-provider injection into run options.
 *
 * The single wiring line that makes MCP live: runOptions carries
 * `providers: ctx.runtime.toolProviders` only when the runtime has any.
 * Pinned at callOp's narrowest dispatch seam (_callOpDeps.buildHopCallback) —
 * the integration suites drive buildHopCallback directly with hand-built
 * options, and mcp-wiring.test.ts is type-level only, so neither could catch
 * a runtime that silently advertises no providers.
 */

import { describe, expect, test } from "bun:test";
import { makeMockAgentManager, makeMockCallContext, makeSessionManager, makeTestRuntime } from "@test/helpers";
import type { AgentRunOptions } from "@/agents";
import { type DEFAULT_CONFIG, type NaxConfig, NaxConfigSchema, pickSelector } from "@/config";
import type { BuildHopCallbackContext, RunOperation } from "@/operations";
import { _callOpDeps, callOp } from "@/operations";
import type { ToolProvider } from "@/tools";

const testSel = pickSelector("test", "routing");

const runEchoOp: RunOperation<{ text: string }, string, Pick<typeof DEFAULT_CONFIG, "routing">> = {
  kind: "run",
  name: "run-echo-provider-injection",
  stage: "run",
  config: testSel,
  session: { role: "implementer", lifetime: "fresh" },
  build: (input) => ({
    role: { id: "role", content: "You echo text.", overridable: false },
    task: { id: "task", content: input.text, overridable: false },
  }),
  parse: (output) => output.trim(),
};

// Mirror mcp-wiring.test.ts: a schema-parsed config whose mcp block yields one
// provider. Construction spawns nothing — the connect is lazy.
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
      runEchoOp,
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
