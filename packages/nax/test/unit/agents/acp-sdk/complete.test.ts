// test/unit/agents/acp-sdk/complete.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { AgentSessionError, isProcessAlive, NaxError } from "@nathapp/nax-agent";
import { cleanupTempDir, makeTempDir, waitForCondition } from "@test/helpers";
import {
  failTurn,
  fakeAcpBackend,
  fakeStartPids,
  hangTurn,
  replyTurn,
  scriptedOpened,
} from "@test/helpers/acp-fake-agent";
import { _acpSdkDeps, AcpSdkAgentAdapter } from "@/agents/acp-sdk";
import { FALLBACK_RATES } from "@/agents/cost";
import { CompleteError, type ResolvedCompleteOptions, SessionFailureError, SessionTurnError } from "@/agents/types";

const REAL = { ..._acpSdkDeps };
let dir: string;

beforeEach(() => {
  dir = makeTempDir("acp-sdk-complete-");
  _acpSdkDeps.resolveRateCard = async () => ({ rates: FALLBACK_RATES, source: "fallback-rates" });
  _acpSdkDeps.cwdExists = async () => true;
});
afterEach(() => {
  Object.assign(_acpSdkDeps, REAL);
  cleanupTempDir(dir);
});

function options(overrides: Partial<ResolvedCompleteOptions> = {}): ResolvedCompleteOptions {
  return {
    modelDef: { provider: "anthropic", model: "sonnet" },
    workdir: dir,
    resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
    ...overrides,
  };
}

function scripted(...turns: Parameters<typeof scriptedOpened>[0]) {
  const script = scriptedOpened(turns);
  _acpSdkDeps.acpBackend = () => ({ kind: "acp:claude", open: async () => script.opened });
  return script;
}

describe("AcpSdkAgentAdapter.complete() (spec §6.6)", () => {
  test("returns trimmed output with tokens, card estimate, reported exact cost and rates", async () => {
    const script = scripted(replyTurn("  the answer \n"));
    const result = await new AcpSdkAgentAdapter("claude").complete("q", options());
    expect(result).toMatchObject({
      output: "the answer",
      tokenUsage: { inputTokens: 10, outputTokens: 5 },
      exactCostUsd: 0.01,
      pricingSource: "fallback-rates",
    });
    expect(result.estimatedCostUsd).toBeGreaterThan(0);
    expect(result.rates).toBeDefined();
    expect(script.prompts).toEqual(["q"]);
    expect(script.closeCount()).toBe(1);
  });

  test("one prompt only: a trailing question in the output does not start an interaction", async () => {
    const script = scripted(replyTurn("Which file should I edit?"), replyTurn("never"));
    const result = await new AcpSdkAgentAdapter("claude").complete("q", options());
    expect(result.output).toBe("Which file should I edit?");
    expect(script.prompts).toEqual(["q"]);
  });

  test("blank output throws CompleteError, as acpx", async () => {
    scripted(replyTurn("   "));
    await expect(new AcpSdkAgentAdapter("claude").complete("q", options())).rejects.toBeInstanceOf(CompleteError);
  });

  test("the timeout throws AGENT_TIMEOUT and closes the session", async () => {
    const script = scripted(hangTurn());
    const err = await new AcpSdkAgentAdapter("claude")
      .complete("q", options({ timeoutMs: 50 }))
      .catch((e: unknown) => e);
    if (!(err instanceof NaxError)) throw err;
    expect(err.code).toBe("AGENT_TIMEOUT");
    expect(script.closeCount()).toBe(1);
  });

  test("a run abort is rethrown fail-aborted, never a cancelled result (D3-a, D2-c)", async () => {
    scripted(hangTurn());
    const run = new AbortController();
    const cancels: Array<() => Promise<void>> = [];
    const pending = new AcpSdkAgentAdapter("claude").complete(
      "q",
      options({ signal: run.signal, onActiveCall: (_id, cancel) => cancels.push(cancel) }),
    );
    await waitForCondition(() => cancels.length > 0);
    run.abort("shutdown");
    const err = await pending.catch((e: unknown) => e);
    if (!(err instanceof SessionTurnError)) throw err;
    expect(err.adapterFailure?.outcome).toBe("fail-aborted");
  });

  test("an open-time failure is thrown pre-classified (SessionFailureError, D3-a)", async () => {
    _acpSdkDeps.acpBackend = () => ({
      kind: "acp:claude",
      open: async () => {
        throw new AgentSessionError("login", "AGENT_SESSION_AUTH_REQUIRED");
      },
    });
    const err = await new AcpSdkAgentAdapter("claude").complete("q", options()).catch((e: unknown) => e);
    if (!(err instanceof SessionFailureError)) throw err;
    expect(err.adapterFailure).toMatchObject({ outcome: "fail-auth", category: "availability" });
  });

  test("a model refusal at open is fail-adapter-error / quality (D2-b through complete())", async () => {
    _acpSdkDeps.acpBackend = () => ({
      kind: "acp:claude",
      open: async () => {
        throw new AgentSessionError("no model", "AGENT_SESSION_CAPABILITY_UNSUPPORTED", { capability: "model" });
      },
    });
    const err = await new AcpSdkAgentAdapter("claude").complete("q", options()).catch((e: unknown) => e);
    if (!(err instanceof SessionFailureError)) throw err;
    expect(err.adapterFailure).toMatchObject({ outcome: "fail-adapter-error", category: "quality" });
  });

  test("a watchdog cancel returns cancelled with the burned tokens priced, no adapterFailure (BUG-57)", async () => {
    scripted(hangTurn({ inputTokens: 7, outputTokens: 2, costUsd: 0.004 }));
    const cancels: Array<() => Promise<void>> = [];
    const pending = new AcpSdkAgentAdapter("claude").complete(
      "q",
      options({ onActiveCall: (_id, cancel) => cancels.push(cancel) }),
    );
    await waitForCondition(() => cancels.length > 0);
    await cancels[0]?.();
    const result = await pending;
    expect(result).toMatchObject({ cancelled: true, output: "", tokenUsage: { inputTokens: 7, outputTokens: 2 } });
    expect(result.estimatedCostUsd).toBeGreaterThan(0);
    expect(result.adapterFailure).toBeUndefined();
  });

  test("any other failure is thrown pre-classified", async () => {
    scripted(failTurn(new AgentSessionError("login", "AGENT_SESSION_AUTH_REQUIRED")));
    const err = await new AcpSdkAgentAdapter("claude").complete("q", options()).catch((e: unknown) => e);
    if (!(err instanceof SessionTurnError)) throw err;
    expect(err.adapterFailure).toMatchObject({ outcome: "fail-auth", category: "availability" });
  });

  test("promptRetries applies to complete()", async () => {
    _acpSdkDeps.delay = async () => {};
    const transient = new NaxError("x", "AGENT_SESSION_TURN_FAILED", { rpcCode: -32603 });
    const script = scripted(failTurn(transient), replyTurn("ok"));
    const result = await new AcpSdkAgentAdapter("claude").complete("q", options({ promptRetries: 1 }));
    expect(result.output).toBe("ok");
    expect(script.prompts).toEqual(["q", "q"]);
  });

  test("the session is named from sessionName, else computeAcpHandle", async () => {
    const opened: string[] = [];
    const script = scriptedOpened([replyTurn("x")]);
    _acpSdkDeps.acpBackend = () => ({
      kind: "acp:claude",
      open: async (ctx) => {
        opened.push(ctx.sessionId);
        return script.opened;
      },
    });
    const adapter = new AcpSdkAgentAdapter("claude");
    await adapter.complete("q", options({ sessionName: "nax-explicit" }));
    await adapter.complete("q", options({ featureName: "feat", storyId: "US-1" }));
    expect(opened[0]).toBe("nax-explicit");
    expect(opened[1]).toContain("feat");
  });

  test("the profile comes from resolvedPermissions, as sessions (B3)", async () => {
    const profiles: string[] = [];
    const script = scriptedOpened([replyTurn("x")]);
    _acpSdkDeps.acpBackend = () => ({
      kind: "acp:claude",
      open: async (ctx) => {
        profiles.push(ctx.profile);
        return script.opened;
      },
    });
    await new AcpSdkAgentAdapter("claude").complete(
      "q",
      options({ resolvedPermissions: { mode: "approve-reads", bashApproval: "raw" } }),
    );
    expect(profiles).toEqual(["read"]);
  });

  test("a hung complete() times out and leaves no agent process (Review Focus 4)", async () => {
    const record = join(dir, "record.jsonl");
    _acpSdkDeps.acpBackend = fakeAcpBackend({ turns: [{ steps: [{ kind: "hang" }] }] }, record);
    // The fake's "hang" ignores session/cancel, so the close waits out cancelGraceMs: keep it short.
    const err = await new AcpSdkAgentAdapter("claude")
      .complete("q", options({ timeoutMs: 300, trackedSpawnDeadlineMs: 500 }))
      .catch((e: unknown) => e);
    if (!(err instanceof NaxError)) throw err;
    expect(err.code).toBe("AGENT_TIMEOUT");
    const pid = fakeStartPids(record)[0];
    expect(pid).toBeDefined();
    await waitForCondition(() => pid !== undefined && !isProcessAlive(pid), 5_000);
  }, 30_000);
});
