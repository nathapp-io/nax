// test/unit/agents/acp-sdk/parity-turn.test.ts
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  type AdapterInteraction,
  AgentSessionError,
  type AgentStreamEvent,
  createMemoryTranscriptStore,
  type InteractionHandler,
  NO_OP_INTERACTION_HANDLER,
  type OpenedBackend,
  type OpenSessionOpts,
  SessionTurnError,
} from "@nathapp/nax-agent";
import { waitForCondition } from "@test/helpers";
import { failTurn, hangTurn, replyTurn, scriptedOpened } from "@test/helpers/acp-fake-agent";
import { createAskPort } from "@/agents/acp-sdk/ask-port";
import { _acpSdkDeps, type AcpSdkSession } from "@/agents/acp-sdk/session";
import { createAuditRecorder } from "@/agents/acp-sdk/tool-audit";
import { runTurnLoop } from "@/agents/acp-sdk/turn-loop";
import { createTurnSlot } from "@/agents/acp-sdk/turn-slot";
import { FALLBACK_RATES } from "@/agents/cost";
import { failurePolicyFor } from "@/agents/retry/failure-policy";
import { getLogger, initLogger, resetLogger } from "@/logger";

const REAL = { ..._acpSdkDeps };
afterEach(() => {
  Object.assign(_acpSdkDeps, REAL);
});

interface Built {
  readonly session: AcpSdkSession;
  readonly events: AgentStreamEvent[];
  readonly cancels: Array<() => Promise<void>>;
}

function build(opened: OpenedBackend, overrides: Partial<OpenSessionOpts> = {}): Built {
  const events: AgentStreamEvent[] = [];
  const cancels: Array<() => Promise<void>> = [];
  const slot = createTurnSlot();
  const opts: OpenSessionOpts = {
    agentName: "claude",
    workdir: "/repo",
    resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
    modelDef: { provider: "anthropic", model: "sonnet" },
    timeoutSeconds: 60,
    onActiveCall: (_callId, cancel) => {
      cancels.push(cancel);
    },
    ...overrides,
  };
  const session: AcpSdkSession = {
    name: "nax-loop",
    agent: "claude",
    opts,
    handle: { id: "nax-loop", agentName: "claude" },
    store: createMemoryTranscriptStore(),
    slot,
    asks: createAskPort(slot),
    audit: createAuditRecorder("nax-loop", undefined),
    closer: new AbortController(),
    rateCard: { rates: FALLBACK_RATES, source: "fallback-rates" },
    stream: {
      emit: (e) => {
        events.push(e);
      },
      agentName: "claude",
      sessionName: "nax-loop",
      runId: "r",
      storyId: undefined,
      model: "sonnet",
      timeoutSeconds: 60,
      pid: () => undefined,
    },
    process: { pid: undefined },
    opened,
    running: undefined,
    unlinkRun: () => {},
  };
  return { session, events, cancels };
}

function answering(...answers: string[]): InteractionHandler & { readonly asked: AdapterInteraction[] } {
  const asked: AdapterInteraction[] = [];
  return {
    asked,
    onInteraction: async (interaction) => {
      asked.push(interaction);
      const answer = answers.shift();
      return answer === undefined ? null : { answer };
    },
  };
}

const NONE = answering();

describe("sendTurn parity with acpx (spec §9)", () => {
  test("a run abort throws fail-aborted, which the policy never retries or swaps (D2-c pin)", async () => {
    const script = scriptedOpened([hangTurn()]);
    const { session } = build(script.opened);
    const run = new AbortController();
    const pending = runTurnLoop(session, "p", { interactionHandler: NONE, signal: run.signal });
    await waitForCondition(() => script.prompts.length === 1);
    run.abort("shutdown");
    const err = await pending.catch((e: unknown) => e);
    if (!(err instanceof SessionTurnError)) throw err;
    expect(err).toMatchObject({ cancelled: true, retryable: false });
    expect(err.adapterFailure?.outcome).toBe("fail-aborted");
    expect(failurePolicyFor("fail-aborted")).toMatchObject({ sameAgentRetry: "none", swap: "never" });
  });

  test("the default budget is 10 prompts and spending it warns (adapter-send-turn-edges)", async () => {
    resetLogger();
    initLogger({ level: "silent" });
    const warnSpy = spyOn(getLogger(), "warn").mockImplementation(() => {});
    try {
      const script = scriptedOpened([replyTurn("Shall I continue?")]);
      const { session } = build(script.opened);
      const result = await runTurnLoop(session, "p", { interactionHandler: answering(..."yyyyyyyyyyyy".split("")) });
      expect(result.internalRoundTrips).toBe(10);
      expect(warnSpy.mock.calls.some((call) => String(call[1]).includes("Interaction budget spent"))).toBe(true);
    } finally {
      warnSpy.mockRestore();
      resetLogger();
    }
  });

  test("the deadline expiring between iterations returns timedOut (adapter-send-turn-edges)", async () => {
    const script = scriptedOpened([replyTurn('<nax_tool_call name="t">{}</nax_tool_call>')]);
    const { session } = build(script.opened, { timeoutSeconds: 0.05 });
    const started = Date.now();
    // The reply is withheld until the 50 ms deadline has passed; no fixed timer in the test.
    const late: InteractionHandler = {
      onInteraction: async () => {
        await waitForCondition(() => Date.now() - started > 60);
        return { answer: "r" };
      },
    };
    const result = await runTurnLoop(session, "p", { interactionHandler: late });
    expect(result).toMatchObject({ timedOut: true, output: "" });
  });

  test("a pre-aborted turn still stamps the handle's pricingSource on the error (adapter-send-turn-edges)", async () => {
    const script = scriptedOpened([replyTurn("never")]);
    const { session } = build(script.opened);
    const err = await runTurnLoop(session, "p", { interactionHandler: NONE, signal: AbortSignal.abort("x") }).catch(
      (e: unknown) => e,
    );
    if (!(err instanceof SessionTurnError)) throw err;
    expect(err.pricingSource).toBe("fallback-rates");
    expect(err.estimatedCostUsd).toBe(0);
  });

  test("the exact cost sums every prompt's reported cost (adapter-phase-a)", async () => {
    const script = scriptedOpened([
      replyTurn('<nax_tool_call name="t">{}</nax_tool_call>', { inputTokens: 1, outputTokens: 1, costUsd: 0.25 }),
      replyTurn("done", { inputTokens: 1, outputTokens: 1, costUsd: 0.5 }),
    ]);
    const { session } = build(script.opened);
    const result = await runTurnLoop(session, "p", { interactionHandler: answering("r") });
    expect(result.exactCostUsd).toBeCloseTo(0.75);
    expect(result.internalRoundTrips).toBe(2);
  });

  test("NO_OP_INTERACTION_HANDLER ends the loop at the first question (adapter-phase-a)", async () => {
    const script = scriptedOpened([replyTurn("Which one?"), replyTurn("never")]);
    const { session } = build(script.opened);
    const result = await runTurnLoop(session, "p", { interactionHandler: NO_OP_INTERACTION_HANDLER });
    expect(result.output).toBe("Which one?");
    expect(script.prompts).toEqual(["p"]);
  });

  test("a failed NOT_FOUND re-open surfaces the dead turn's error (adapter-send-turn-edges)", async () => {
    const first = scriptedOpened([failTurn(new AgentSessionError("gone", "AGENT_SESSION_NOT_FOUND"))]);
    _acpSdkDeps.acpBackend = () => ({
      kind: "acp:claude",
      open: async () => {
        throw new Error("cannot reopen");
      },
    });
    const { session } = build(first.opened);
    const err = await runTurnLoop(session, "p", { interactionHandler: NONE }).catch((e: unknown) => e);
    if (!(err instanceof SessionTurnError)) throw err;
    expect(err.message).toBe("gone");
    expect(err.adapterFailure?.outcome).toBe("fail-adapter-error");
  });
});
