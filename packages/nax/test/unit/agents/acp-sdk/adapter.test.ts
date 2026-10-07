import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  type AgentStreamEvent,
  isProcessAlive,
  NO_OP_INTERACTION_HANDLER,
  type OpenSessionOpts,
  SessionTurnError,
} from "@nathapp/nax-agent";
import { cleanupTempDir, makeTempDir, waitForCondition } from "@test/helpers";
import { fakeAcpBackend, fakeMethods, fakeStartPids } from "@test/helpers/acp-fake-agent";
import { _acpSdkDeps, AcpSdkAgentAdapter } from "@/agents/acp-sdk";
import { FALLBACK_RATES } from "@/agents/cost";

const REAL = { ..._acpSdkDeps };
let dir = "";
let record = "";

beforeEach(() => {
  dir = makeTempDir("acp-sdk-adapter-");
  record = join(dir, "record.jsonl");
  _acpSdkDeps.resolveRateCard = async () => ({ rates: FALLBACK_RATES, source: "fallback-rates" });
});

afterEach(() => {
  Object.assign(_acpSdkDeps, REAL);
  cleanupTempDir(dir);
});

function opts(overrides: Partial<OpenSessionOpts> = {}): OpenSessionOpts {
  return {
    agentName: "claude",
    workdir: dir,
    resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
    modelDef: { provider: "anthropic", model: "sonnet" },
    timeoutSeconds: 60,
    transcriptDir: join(dir, "sessions"),
    trackedSpawnDeadlineMs: 2_000,
    ...overrides,
  };
}

const PONG_TURN = {
  steps: [
    {
      kind: "update",
      update: { sessionUpdate: "usage_update", used: 100, size: 200_000, cost: { amount: 0.02, currency: "USD" } },
    },
    { kind: "text", text: "pong" },
  ],
  usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
};

describe("AcpSdkAgentAdapter over a real agent process", () => {
  test("open, one turn, close: output, spend, stream events, no process left", async () => {
    _acpSdkDeps.acpBackend = fakeAcpBackend({ turns: [PONG_TURN] }, record);
    const adapter = new AcpSdkAgentAdapter("claude");
    const events: AgentStreamEvent[] = [];
    const established: string[] = [];
    const handle = await adapter.openSession(
      "nax-a1",
      opts({
        onStreamActivity: (e) => events.push(e),
        onSessionEstablished: (ids, name) => established.push(`${name}:${ids.sessionId}`),
      }),
    );
    expect(handle).toMatchObject({ id: "nax-a1", agentName: "claude" });
    expect(established).toEqual(["nax-a1:fake-session-1"]);

    const result = await adapter.sendTurn(handle, "ping", { interactionHandler: NO_OP_INTERACTION_HANDLER });
    expect(result).toMatchObject({ output: "pong", tokenUsage: { inputTokens: 12, outputTokens: 3 } });
    expect(result.exactCostUsd).toBeCloseTo(0.02);
    expect(events.map((e) => e.kind)).toEqual(
      expect.arrayContaining(["agent.call_started", "agent.message_update", "agent.call_ended"]),
    );

    const [pid] = fakeStartPids(record);
    await adapter.closeSession(handle);
    await waitForCondition(() => pid !== undefined && !isProcessAlive(pid), 5_000);
    await expect(
      adapter.sendTurn(handle, "again", { interactionHandler: NO_OP_INTERACTION_HANDLER }),
    ).rejects.toMatchObject({ code: "ACP_SDK_SESSION_NOT_OPEN" });
  }, 30_000);

  test("closeSession during a running prompt ends the turn as fail-aborted (Review Focus 1)", async () => {
    _acpSdkDeps.acpBackend = fakeAcpBackend({ turns: [{ steps: [{ kind: "waitForCancel" }] }] }, record);
    const adapter = new AcpSdkAgentAdapter("claude");
    const handle = await adapter.openSession("nax-a2", opts());
    const pending = adapter.sendTurn(handle, "long", { interactionHandler: NO_OP_INTERACTION_HANDLER });
    // Attach the handler before the close: the turn rejects while closeSession's
    // I/O runs, and Bun fails the test if the rejection sits unhandled across a
    // macrotask boundary.
    const caught = pending.catch((e: unknown) => e);
    await waitForCondition(() => fakeMethods(record).includes("session/prompt"), 5_000);
    await adapter.closeSession(handle);
    const err = await caught;
    if (!(err instanceof SessionTurnError)) throw err;
    expect(err.cancelled).toBe(true);
    expect(err.adapterFailure?.outcome).toBe("fail-aborted");
    const [pid] = fakeStartPids(record);
    await waitForCondition(() => pid !== undefined && !isProcessAlive(pid), 5_000);
  }, 30_000);

  test("a model the agent does not offer fails the open and leaves nothing (Review Focus 3)", async () => {
    _acpSdkDeps.acpBackend = fakeAcpBackend({}, record);
    const adapter = new AcpSdkAgentAdapter("claude");
    await expect(
      adapter.openSession("nax-a3", opts({ modelDef: { provider: "anthropic", model: "claude-sonnet-4-5" } })),
    ).rejects.toMatchObject({ code: "AGENT_SESSION_CAPABILITY_UNSUPPORTED" });
    await expect(
      adapter.sendTurn({ id: "nax-a3", agentName: "claude" }, "x", { interactionHandler: NO_OP_INTERACTION_HANDLER }),
    ).rejects.toMatchObject({ code: "ACP_SDK_SESSION_NOT_OPEN" });
    const [pid] = fakeStartPids(record);
    await waitForCondition(() => pid !== undefined && !isProcessAlive(pid), 5_000);
  }, 30_000);

  test("closePhysicalSession closes a live handle and ignores an unknown one", async () => {
    _acpSdkDeps.acpBackend = fakeAcpBackend({}, record);
    const adapter = new AcpSdkAgentAdapter("claude");
    await adapter.openSession("nax-a4", opts());
    await adapter.closePhysicalSession("not-open", dir);
    await adapter.closePhysicalSession("nax-a4", dir, { force: true });
    const [pid] = fakeStartPids(record);
    await waitForCondition(() => pid !== undefined && !isProcessAlive(pid), 5_000);
  }, 30_000);

  test("re-opening a live name closes the old session first", async () => {
    _acpSdkDeps.acpBackend = fakeAcpBackend({}, record);
    const adapter = new AcpSdkAgentAdapter("claude");
    await adapter.openSession("nax-a5", opts());
    const handle = await adapter.openSession("nax-a5", opts());
    const [firstPid] = fakeStartPids(record);
    await waitForCondition(() => firstPid !== undefined && !isProcessAlive(firstPid), 5_000);
    await adapter.closeSession(handle);
  }, 30_000);
});

describe("AcpSdkAgentAdapter without a process", () => {
  test("a missing workdir fails SESSION_CWD_MISSING before any spawn", async () => {
    _acpSdkDeps.acpBackend = fakeAcpBackend({}, record);
    await expect(
      new AcpSdkAgentAdapter("claude").openSession("nax-b1", opts({ workdir: join(dir, "missing") })),
    ).rejects.toMatchObject({ code: "SESSION_CWD_MISSING" });
    expect(fakeStartPids(record)).toEqual([]);
  });

  test("an aborted run signal fails before any spawn", async () => {
    _acpSdkDeps.acpBackend = fakeAcpBackend({}, record);
    await expect(
      new AcpSdkAgentAdapter("claude").openSession("nax-b2", opts({ signal: AbortSignal.abort("stop") })),
    ).rejects.toThrow();
    expect(fakeStartPids(record)).toEqual([]);
  });

  test("aider has no ACP launcher: it lists, never opens (spec §11 item 2)", async () => {
    const adapter = new AcpSdkAgentAdapter("aider");
    expect(adapter.displayName).toBe("ACP Agent");
    expect(await adapter.isInstalled()).toBe(false);
    await expect(adapter.openSession("nax-b3", opts({ agentName: "aider" }))).rejects.toMatchObject({
      code: "ACP_AGENT_UNSUPPORTED",
    });
  });

  test("isInstalled asks whether the agent's ACP launcher resolves", async () => {
    _acpSdkDeps.isAgentLaunchable = (agent) => agent === "claude";
    expect(await new AcpSdkAgentAdapter("claude").isInstalled()).toBe(true);
    expect(await new AcpSdkAgentAdapter("codex").isInstalled()).toBe(false);
  });

  test("identity rows match the entries", () => {
    const adapter = new AcpSdkAgentAdapter("claude");
    expect(adapter).toMatchObject({ name: "claude", displayName: "Claude Code (ACP)", binary: "claude" });
    expect(adapter.capabilities.supportedTiers).toEqual(["fast", "balanced", "powerful"]);
    expect(adapter.buildCommand()).toEqual(["acp", "claude"]);
    expect(adapter.buildAllowedEnv().HOME).toBeDefined();
  });

  test("closeSession on an unknown handle is a no-op", async () => {
    await new AcpSdkAgentAdapter("claude").closeSession({ id: "never", agentName: "claude" });
  });
});
