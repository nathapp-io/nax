/**
 * nax#2839: a native `fail-auth` on the run path must park only the provider that
 * failed. The first primary hop is tier-less, so the failure has to be recorded
 * against the endpoint's full `provider/model`; without it the cooldown landed on
 * the bare `native` key and retired every native provider for the rest of the run.
 *
 * The failing hop reports its endpoint, as `dispatchHopTurn`'s catch path does
 * (pinned in test/unit/operations/build-hop-callback-branches.test.ts).
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { type MockLogger, makeAgentRegistry, makeLogger, makeNaxConfig } from "@test/helpers";
import { _agentManagerDeps, AgentManager } from "@/agents/manager";
import type { HopKind } from "@/agents/manager-types";
import type { AgentResult, AgentRunOptions } from "@/agents/types";
import type { NaxConfig } from "@/config";
import type { ModelDef } from "@/config/schema-types";
import type { AdapterFailure } from "@/context/engine";

const AUTH: AdapterFailure = {
  outcome: "fail-auth",
  category: "availability",
  retriable: false,
  message: "401 api_key_expired",
};
const EXPIRED: ModelDef = { provider: "opencode-go", model: "deepseek-v4.1-flash" };
const POWERFUL: ModelDef = { provider: "openai-codex", model: "gpt-6.1-sol" };
const FAST: ModelDef = { provider: "openai-codex", model: "gpt-6-luna" };
const START_ON_FALLBACK = "Primary agent already unavailable — starting on fallback";
const originalDeps = { ..._agentManagerDeps };
const managers: AgentManager[] = [];
let logger: MockLogger;

beforeEach(() => {
  logger = makeLogger();
  _agentManagerDeps.servedAuth = () => ({ fingerprint: "aaa", source: "file" });
  _agentManagerDeps.readCredential = async () => {};
  _agentManagerDeps.listStoredProviders = async () => [];
  _agentManagerDeps.sleep = async () => {};
});
afterEach(() => {
  Object.assign(_agentManagerDeps, originalDeps);
  for (const m of managers) m.close();
  managers.length = 0;
});

function setup(): { manager: AgentManager; config: NaxConfig } {
  const config = makeNaxConfig({
    agent: {
      protocol: "hybrid",
      default: "native",
      fallback: { enabled: true, map: { native: [{ agent: "native", tier: "powerful" }, "claude"] } },
    },
    models: {
      native: {
        fast: "openai-codex/gpt-6-luna",
        balanced: "opencode-go/deepseek-v4.1-flash",
        powerful: "openai-codex/gpt-6.1-sol",
      },
    },
  });
  const manager = new AgentManager(config, makeAgentRegistry(), { models: config.models, logger });
  managers.push(manager);
  return { manager, config };
}

function outcome(success: boolean): AgentResult {
  return {
    success,
    exitCode: success ? 0 : 1,
    output: success ? "ok" : "401",
    rateLimited: false,
    durationMs: 0,
    estimatedCostUsd: 0,
    ...(success ? {} : { adapterFailure: AUTH }),
  };
}

function runOptions(config: NaxConfig, tier: string, modelDef: ModelDef): AgentRunOptions {
  return { prompt: "do it", workdir: "/tmp", modelTier: tier, timeoutSeconds: 60, modelDef, config, storyId: "US-1" };
}

/** Runs one op; a native hop that dispatches to the `EXPIRED` provider fails auth, every other hop succeeds. */
async function runOp(manager: AgentManager, options: AgentRunOptions): Promise<{ agent: string; tier?: string }[]> {
  const hops: { agent: string; tier?: string }[] = [];
  await manager.runWithFallback({
    runOptions: options,
    executeHop: async (agent: string, bundle, kind: HopKind, resolved: AgentRunOptions) => {
      hops.push({ agent, tier: kind.tier });
      const modelDef = kind.tier === "powerful" ? POWERFUL : (resolved.modelDef ?? POWERFUL);
      const failed = agent === "native" && modelDef.provider === EXPIRED.provider;
      return { bundle, result: outcome(!failed), endpoint: { modelDef } };
    },
  });
  return hops;
}

function startedOnFallback(): boolean {
  return logger.calls.some((call) => call.message === START_ON_FALLBACK);
}

test("a tier-less primary fail-auth swaps to a native rung on another provider, not off native", async () => {
  const { manager, config } = setup();
  const hops = await runOp(manager, runOptions(config, "balanced", EXPIRED));
  expect(hops).toEqual([
    { agent: "native", tier: undefined },
    { agent: "native", tier: "powerful" },
  ]);
});

test("the cooldown parks only the failing provider", async () => {
  const { manager, config } = setup();
  await runOp(manager, runOptions(config, "balanced", EXPIRED));
  expect(manager.isUnavailable("native", "balanced")).toBe(true);
  expect(manager.isUnavailable("native", "fast")).toBe(false);
  expect(manager.isUnavailable("native", "powerful")).toBe(false);
});

test("a later op on a healthy native provider starts on native", async () => {
  const { manager, config } = setup();
  await runOp(manager, runOptions(config, "balanced", EXPIRED));
  logger.reset();
  const hops = await runOp(manager, runOptions(config, "fast", FAST));
  expect(hops).toEqual([{ agent: "native", tier: undefined }]);
  expect(startedOnFallback()).toBe(false);
});

test("the re-login hint names the failing provider", async () => {
  const { manager, config } = setup();
  await runOp(manager, runOptions(config, "balanced", EXPIRED));
  const hints = logger.calls.filter((call) => call.level === "warn" && call.data?.providerId !== undefined);
  expect(hints.map((call) => call.data?.providerId)).toEqual(["opencode-go"]);
});
