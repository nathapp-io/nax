/**
 * callOp — the per-story effective config, not the root config, reaches run options.
 *
 * nax#2066: callOp read ctx.runtime.configLoader.current() (root) while
 * codingToolRoot two lines below was package-correct, so RunCommand advertised
 * the ROOT quality.commands for a package story and ran the wrong toolchain.
 */

import { describe, expect, test } from "bun:test";
import {
  makeMockAgentManager,
  makeMockCallContext,
  makeNaxConfig,
  makeSessionManager,
  makeTestRuntime,
} from "@test/helpers";
import type { AgentRunOptions } from "@/agents";
import { type DEFAULT_CONFIG, type NaxConfig, pickSelector } from "@/config";
import type { BuildHopCallbackContext, RunOperation } from "@/operations";
import { _callOpDeps, callOp } from "@/operations";

// The assertion field is `execution.permissionProfile`, not `quality.commands`,
// for two reasons. (1) `AgentRunOptions["config"]` is the narrow
// agentManagerConfigSelector Pick — `agent` / `execution` / `profile` — so
// reading `quality` off it would need a cast, and the looseCast ratchet fails
// on growth. (2) It is the field with the real consequence: it is what
// resolvePermissions reads, so this test pins the SEC-3 half of the change.

const testSel = pickSelector("effective-config-test", "routing");

const runEchoOp: RunOperation<{ text: string }, string, Pick<typeof DEFAULT_CONFIG, "routing">> = {
  kind: "run",
  name: "run-echo-effective-config",
  stage: "run",
  config: testSel,
  session: { role: "implementer", lifetime: "fresh" },
  build: (input) => ({
    role: { id: "role", content: "You echo text.", overridable: false },
    task: { id: "task", content: input.text, overridable: false },
  }),
  parse: (output) => output.trim(),
};

async function captureRunOptionsConfig(
  ctxConfig: NaxConfig | undefined,
): Promise<AgentRunOptions["config"] | undefined> {
  const orig = _callOpDeps.buildHopCallback;
  let seen: AgentRunOptions["config"] | undefined;
  _callOpDeps.buildHopCallback = (
    _hopCtx: BuildHopCallbackContext,
    _sessionId: string | undefined,
    runOptions: AgentRunOptions,
  ) => {
    seen = runOptions.config;
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

  // "scoped" — deliberately NOT the schema default ("unrestricted"), so the
  // fallback test proves the value came from the runtime's root config rather
  // than from DEFAULT_CONFIG by coincidence.
  const rootConfig = makeNaxConfig({ execution: { permissionProfile: "scoped" } });
  const runtime = makeTestRuntime({
    config: rootConfig,
    agentManager: makeMockAgentManager({}),
    sessionManager: makeSessionManager({}),
  });
  try {
    await callOp(
      makeMockCallContext({
        runtime,
        packageView: runtime.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
        ...(ctxConfig ? { config: ctxConfig } : {}),
      }),
      runEchoOp,
      { text: "hi" },
    ).catch(() => undefined);
  } finally {
    _callOpDeps.buildHopCallback = orig;
    await runtime.close();
  }
  return seen;
}

describe("callOp — effective config reaches run options (#2066)", () => {
  test("ctx.config wins over the runtime's root config", async () => {
    const effective = makeNaxConfig({ execution: { permissionProfile: "safe" } });
    const seen = await captureRunOptionsConfig(effective);
    expect(seen?.execution?.permissionProfile).toBe("safe");
  });

  test("without ctx.config it still falls back to the root config", async () => {
    const seen = await captureRunOptionsConfig(undefined);
    expect(seen?.execution?.permissionProfile).toBe("scoped");
  });
});
