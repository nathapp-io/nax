import { afterEach, expect, mock, test } from "bun:test";
import { realpathSync } from "node:fs";
import { createAgentSession } from "@nathapp/nax-agent";
import { _sessionSandboxDeps } from "#src/coding-tools/coding-tool-sandbox";
import { _agentSessionDeps } from "#src/session/agent-session-deps";
import { buildSessionToolSupport } from "#src/session/session-tool-support";
import { createWebExposure } from "#src/web/exposure";
import { createWebExposureGuard } from "#src/web/guard";
import {
  eventsOf,
  installManualTimers,
  installScriptedProvider,
  reader,
  resetScriptedProvider,
  sessionOptions,
  textRound,
  toolRound,
} from "#test/helpers/agent-session";
import {
  assertDefined,
  cleanupTempDir,
  makeTempDir,
  stubSessionSandboxDeps,
  testProtectedPaths,
  waitForCondition,
  withDepsRestore,
  withWarnSpy,
} from "#test/helpers/index";

withDepsRestore(_sessionSandboxDeps);
withDepsRestore(_agentSessionDeps);
afterEach(() => {
  resetScriptedProvider();
  mock.restore();
});

function guardFixture() {
  const exposure = createWebExposure();
  const guard = createWebExposureGuard({
    exposure,
    configuredAllowedDomains: undefined,
    exposedAllowedDomains: ["registry.npmjs.org"],
  });
  return { exposure, guard };
}

test("AC-19: session coding runtime offers network only with a networking exposure port", () => {
  const root = realpathSync(makeTempDir("network-runtime-"));
  try {
    const { guard } = guardFixture();
    const build = (webExposure?: typeof guard) =>
      buildSessionToolSupport({
        root,
        profile: "full",
        sessionName: "network-runtime",
        protectedPaths: testProtectedPaths(),
        bashApproval: "escalate",
        launcher: undefined,
        interceptor: undefined,
        askResolver: { resolve: async () => ({ decision: "deny", decidedBy: "human", latencyMs: 0 }) },
        ...(webExposure === undefined ? {} : { webExposure }),
      }).support.tools.find((tool) => tool.name === "Bash");
    const optedIn = build(guard);
    const ordinary = build();
    assertDefined(optedIn);
    assertDefined(ordinary);
    expect(optedIn.inputSchema.properties).toHaveProperty("network", { type: "string", enum: ["full"] });
    expect(ordinary.inputSchema.properties).not.toHaveProperty("network");
  } finally {
    cleanupTempDir(root);
  }
});

test("AC-21: failed network update still sends a flagged call to the native session ask port", async () => {
  installManualTimers();
  const { backend } = stubSessionSandboxDeps(_sessionSandboxDeps);
  let updates = 0;
  backend.updateNetwork = async () => {
    updates++;
    throw new Error("swap failed");
  };
  const { guard, exposure } = guardFixture();
  const root = realpathSync(makeTempDir("network-session-"));
  const provider = installScriptedProvider();
  provider.push(
    toolRound([{ id: "full-network", name: "Bash", input: { command: "echo hi", network: "full" } }]),
    textRound("done"),
  );
  const session = await createAgentSession(
    sessionOptions({ profile: "full", workdir: root, bashApproval: "escalate", hostPorts: { webExposure: guard } }),
  );
  try {
    await withWarnSpy(async (warn) => {
      exposure.markExposed(new Date(0));
      await waitForCondition(() => warn.mock.calls.length === 1);
      expect(updates).toBe(1);
      expect(warn).toHaveBeenCalledTimes(1);
      const events = reader(session.send("run it"));
      const [ask] = eventsOf(await events.until("approval_requested"), "approval_requested");
      expect(ask).toMatchObject({
        tool: "Bash",
        callId: "full-network",
        // US-002: the ask the person approves names the escape it grants, and
        // carries the marker a host keys on.
        reason: "full network after this session read web content; runs OUTSIDE the sandbox: full network requested",
        unsandboxed: true,
      });
      assertDefined(ask);
      session.answer(ask.requestId, { decision: "deny" });
      await events.rest();
    });
  } finally {
    await session.close();
    cleanupTempDir(root);
  }
});
