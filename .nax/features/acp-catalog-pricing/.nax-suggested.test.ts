import { afterEach, expect, mock, test } from "bun:test";
import { _acpAdapterDeps, AcpAgentAdapter } from "@/agents/acp/adapter";
import type { AcpClient, AcpSession } from "@/agents/acp/adapter-session-types";
import type { RateCard } from "@/agents/cost";
import { NO_OP_INTERACTION_HANDLER } from "@/agents/interaction-handler";
import { SessionTurnError } from "@/agents/types";

const retainedCard: RateCard = {
  rates: { inputPer1M: 2, outputPer1M: 10 },
  source: "catalog-rates",
};

const distinctCard: RateCard = {
  rates: { inputPer1M: 101, outputPer1M: 503 },
  source: "fallback-rates",
};

const originalCreateClient = _acpAdapterDeps.createClient;
const originalResolveRateCard = _acpAdapterDeps.resolveRateCard;

afterEach(() => {
  _acpAdapterDeps.createClient = originalCreateClient;
  _acpAdapterDeps.resolveRateCard = originalResolveRateCard;
  mock.restore();
});

test("AC-1: billable SessionTurnError uses the rate card retained by the session handle", async () => {
  const resolveCalls: string[] = [];
  _acpAdapterDeps.resolveRateCard = mock(async (modelId: string) => {
    resolveCalls.push(modelId);
    return retainedCard;
  });

  const session: AcpSession = {
    prompt: async () => ({
      messages: [],
      stopReason: "error",
      retryable: true,
      cumulative_token_usage: { input_tokens: 1_000_000, output_tokens: 2_000_000 },
    }),
    close: async () => {},
    cancelActivePrompt: async () => {},
  };
  const client: AcpClient = {
    start: async () => {},
    createSession: async () => session,
    close: async () => {},
  };
  _acpAdapterDeps.createClient = mock(() => client);

  const adapter = new AcpAgentAdapter("claude");
  const handle = await adapter.openSession("nax-billable-error", {
    agentName: "claude",
    workdir: "/tmp/nax-billable-error",
    resolvedPermissions: { mode: "approve-reads" },
    modelDef: { provider: "anthropic", model: "model-resolved-at-open", env: {} },
    timeoutSeconds: 30,
  });

  // If sendTurn re-resolves, this deliberately incompatible card produces a
  // radically different amount and source from the card retained at openSession.
  _acpAdapterDeps.resolveRateCard = mock(async () => distinctCard);

  let caught: Error | undefined;
  try {
    await adapter.sendTurn(handle, "billable failure", { interactionHandler: NO_OP_INTERACTION_HANDLER });
  } catch (error) {
    if (error instanceof Error) caught = error;
    else throw error;
  }

  expect(caught).toBeInstanceOf(SessionTurnError);
  if (!(caught instanceof SessionTurnError)) throw new Error("expected sendTurn to throw SessionTurnError");

  expect(caught.retryable).toBe(true);
  expect(caught.tokenUsage).toEqual({ inputTokens: 1_000_000, outputTokens: 2_000_000 });
  expect(caught.estimatedCostUsd).toBe(22);
  expect((caught as SessionTurnError & { pricingSource?: string }).pricingSource).toBe("catalog-rates");
  expect(resolveCalls).toEqual(["model-resolved-at-open"]);
});