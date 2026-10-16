import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { makeAgentAdapter, makeAgentRegistry } from "@test/helpers";
import { CooldownStore } from "@/agents/cooldown-store";
import { _agentManagerDeps, AgentManager } from "@/agents/manager";
import { failurePolicyFor } from "@/agents/retry/failure-policy";
import { NaxConfigSchema } from "@/config/schemas";
import type { AdapterFailure } from "@/context/engine";

const AUTH: AdapterFailure = { outcome: "fail-auth", category: "availability", retriable: false, message: "401" };
const RATE: AdapterFailure = { ...AUTH, outcome: "fail-rate-limit", retriable: true };
const originalDeps = { ..._agentManagerDeps };
let fingerprint: string | undefined;
const readCredential = mock(async (_provider: string) => {});
const logger = { info: mock(() => {}), warn: mock(() => {}), debug: mock(() => {}) };
const managers: AgentManager[] = [];

beforeEach(() => {
  fingerprint = "aaa";
  readCredential.mockReset();
  readCredential.mockImplementation(async () => {});
  for (const fn of Object.values(logger)) fn.mockClear();
  _agentManagerDeps.servedAuth = () => (fingerprint ? { fingerprint, source: "file" } : undefined);
  _agentManagerDeps.readCredential = readCredential;
  _agentManagerDeps.sleep = async () => {};
});
afterEach(() => {
  Object.assign(_agentManagerDeps, originalDeps);
  for (const m of managers) m.close();
  managers.length = 0;
});

function setup(primary = "native", flat = false, failure?: AdapterFailure, throws = false) {
  const config = NaxConfigSchema.parse({
    agent: {
      protocol: "hybrid",
      default: primary,
      fallback: {
        enabled: true,
        map: { native: ["claude"], claude: flat ? ["native"] : [{ agent: "native", tier: "balanced" }] },
      },
    },
    models: { native: { balanced: "openai-codex/gpt-6.1-sol", fast: "minimax/MiniMax-M2.7" } },
  });
  const calls: string[] = [];
  const registry = makeAgentRegistry({
    getAgent: (agent) =>
      makeAgentAdapter({
        complete: async () => {
          calls.push(agent);
          if (calls.length === 1 && throws) throw new Error('{"type":"error","error":{"type":"authentication_error"}}');
          return {
            output: "ok",
            tokenUsage: { inputTokens: 0, outputTokens: 0 },
            estimatedCostUsd: 0,
            adapterFailure: calls.length === 1 ? failure : undefined,
          };
        },
      }),
  });
  const manager = new AgentManager(config, registry, { models: config.models, logger });
  managers.push(manager);
  return { manager, config, calls };
}
function entries(m: AgentManager) {
  // biome-ignore lint/complexity/useLiteralKeys: bracket access inspects private store without widening the manager API.
  return m["_cooldowns"].authCooldowns();
}
function park(m: AgentManager) {
  m.markUnavailable("native", AUTH, "balanced");
}

test("AC-1 policy remains agent scoped", () => expect(failurePolicyFor("fail-auth").cooldownScope).toBe("agent"));
test("AC-2 failing native tier is unavailable", () => {
  const { manager: m } = setup();
  park(m);
  expect(m.isUnavailable("native", "balanced")).toBe(true);
});
test("AC-3 other native provider remains available", () => {
  const { manager: m } = setup();
  park(m);
  expect(m.isUnavailable("native", "fast")).toBe(false);
});
test("AC-4 ACP auth remains agent wide without models", () => {
  const { manager: m } = setup();
  m.markUnavailable("claude", AUTH, "fast", "claude-sonnet-4-6");
  expect(m.isUnavailable("claude", "balanced")).toBe(true);
});
test("AC-5 auth survives transient reset", () => {
  const { manager: m } = setup();
  park(m);
  m.resetTransientUnavailable();
  expect(m.isUnavailable("native", "balanced")).toBe(true);
});
test("AC-6 identity-less probe sees provider auth", () => {
  const { manager: m } = setup();
  park(m);
  expect(m.isUnavailable("native")).toBe(true);
});
test("AC-7 flat native target stays excluded", () => {
  const { manager: m } = setup("native", true);
  park(m);
  expect(m.nextCandidate("claude", 0, "claude")).toBeNull();
});
test("AC-8 stamp records served fingerprint", () => {
  const { manager: m } = setup();
  park(m);
  expect(entries(m)).toEqual([
    {
      key: "native::provider::openai-codex",
      agent: "native",
      auth: { providerId: "openai-codex", fingerprint: "aaa" },
    },
  ]);
});
test("AC-9 rate limit has no auth stamp", () => {
  const { manager: m } = setup();
  m.markUnavailable("native", RATE, "balanced");
  expect(entries(m)).toEqual([]);
});
test("AC-10 ACP has no auth stamp", () => {
  const { manager: m } = setup();
  m.markUnavailable("claude", AUTH);
  expect(entries(m)).toEqual([]);
});
test("AC-11 changed credential releases provider", async () => {
  const { manager: m } = setup();
  park(m);
  fingerprint = "bbb";
  await m.refreshAuthCooldowns();
  expect(m.isUnavailable("native", "balanced")).toBe(false);
  expect(readCredential).toHaveBeenCalledWith("openai-codex");
});
test("AC-12 recovery logs fingerprints", async () => {
  const { manager: m } = setup();
  park(m);
  fingerprint = "bbb";
  await m.refreshAuthCooldowns();
  expect(logger.info).toHaveBeenCalledTimes(1);
  expect(logger.info).toHaveBeenCalledWith(
    "agent-manager",
    "Credential changed for openai-codex — native available again",
    { storyId: "_agent", agent: "native", providerId: "openai-codex", previousFingerprint: "aaa", fingerprint: "bbb" },
  );
});
test("AC-13 concurrent refresh logs once", async () => {
  const { manager: m } = setup();
  park(m);
  fingerprint = "bbb";
  await Promise.all([m.refreshAuthCooldowns(), m.refreshAuthCooldowns()]);
  expect(logger.info).toHaveBeenCalledTimes(1);
});
test("AC-14 unchanged credential stays parked silently", async () => {
  const { manager: m } = setup();
  park(m);
  await m.refreshAuthCooldowns();
  expect(m.isUnavailable("native", "balanced")).toBe(true);
  expect(logger.info).not.toHaveBeenCalled();
});
test("AC-15 read failure keeps cooldown and does not throw", async () => {
  const { manager: m } = setup();
  park(m);
  readCredential.mockRejectedValue(new Error("refused"));
  await m.refreshAuthCooldowns();
  expect(m.isUnavailable("native", "balanced")).toBe(true);
  expect(logger.debug).toHaveBeenCalledTimes(1);
});
test("AC-16 missing original stamp recovers", async () => {
  const { manager: m } = setup();
  fingerprint = undefined;
  park(m);
  fingerprint = "bbb";
  await m.refreshAuthCooldowns();
  expect(m.isUnavailable("native", "balanced")).toBe(false);
});
test("AC-17 ACP credential is never read", async () => {
  const { manager: m } = setup();
  m.markUnavailable("claude", AUTH);
  await m.refreshAuthCooldowns();
  expect(readCredential).not.toHaveBeenCalled();
  expect(m.isUnavailable("claude")).toBe(true);
});

test.each([
  ["AC-18", "bbb", "native"],
  ["AC-19", "aaa", "claude"],
])("%s run refreshes before start selection", async (_ac, fp, first) => {
  const { manager: m, config } = setup();
  park(m);
  fingerprint = fp;
  const calls: string[] = [];
  await m.runWithFallback({
    runOptions: {
      prompt: "do it",
      workdir: "/tmp",
      modelTier: "balanced",
      timeoutSeconds: 60,
      modelDef: { provider: "openai-codex", model: "gpt-6.1-sol" },
      config,
    },
    executeHop: async (agent, bundle) => {
      calls.push(agent);
      return {
        bundle,
        result: { success: true, exitCode: 0, output: "ok", rateLimited: false, durationMs: 0, estimatedCostUsd: 0 },
      };
    },
  });
  expect(calls).toEqual([first]);
  if (first === "claude")
    expect(logger.info).toHaveBeenCalledWith(
      "agent-manager",
      "Primary agent already unavailable — starting on fallback",
      expect.any(Object),
    );
});

test("store lists only live stamps and release deletes exactly one key", () => {
  let now = 0;
  const store = new CooldownStore(() => now);
  store.mark("native", RATE, "balanced", "openai-codex/model", { providerId: "openai-codex", fingerprint: "aaa" });
  store.mark("native", AUTH, "fast", "minimax/model", { providerId: "minimax", fingerprint: "mmm" });
  expect(store.authCooldowns()).toHaveLength(2);
  now = 60_001;
  expect(store.authCooldowns().map((entry) => entry.auth.providerId)).toEqual(["minimax"]);
  expect(store.release("native::provider::minimax")).toBe(true);
  expect(store.release("native::provider::minimax")).toBe(false);
  expect(store.isCooling("native")).toBe(false);
});

test("provider stamp blocks sibling models but not unrelated providers", () => {
  const store = new CooldownStore(() => 0);
  store.mark("native", AUTH, "balanced", "openai-codex/model", { providerId: "openai-codex" });
  expect(store.isCooling("native", "fast", "openai-codex/other-model")).toBe(true);
  expect(store.isCooling("native", "fast", "minimax/model")).toBe(false);
  expect(store.isCooling("native", "unresolved-tier")).toBe(false);
});

test("unresolved native provider keeps legacy agent-wide cooldown and is not refreshed", async () => {
  const { manager: m } = setup();
  m.markUnavailable("native", AUTH, undefined, "unknown/sonnet");
  fingerprint = "bbb";
  await m.refreshAuthCooldowns();
  expect(entries(m)).toEqual([]);
  expect(readCredential).not.toHaveBeenCalled();
  expect(m.isUnavailable("native", "fast")).toBe(true);
});

test("a missing current fingerprint keeps the cooldown", async () => {
  const { manager: m } = setup();
  park(m);
  fingerprint = undefined;
  await m.refreshAuthCooldowns();
  expect(m.isUnavailable("native", "balanced")).toBe(true);
  expect(logger.info).not.toHaveBeenCalled();
});

const options = {
  workdir: "/tmp",
  modelDef: { provider: "openai-codex", model: "gpt-6.1-sol" },
  resolvedPermissions: { mode: "approve-reads" as const, bashApproval: "raw" as const },
};
test("AC-20 complete refreshes before choosing fallback", async () => {
  const { manager: m, calls } = setup("claude", false, RATE);
  park(m);
  fingerprint = "bbb";
  await m.completeWithFallback("do it", options);
  expect(calls).toEqual(["claude", "native"]);
});
test("AC-21 complete stamps dispatched native model", async () => {
  const { manager: m, calls } = setup("native", false, AUTH);
  await m.completeWithFallback("do it", options);
  expect(calls).toEqual(["native", "claude"]);
  expect(entries(m)[0]?.auth).toEqual({ providerId: "openai-codex", fingerprint: "aaa" });
});
test("AC-22 thrown ACP auth remains agent wide", async () => {
  const { manager: m } = setup("claude", false, undefined, true);
  await m.completeWithFallback("do it", {
    ...options,
    modelDef: { provider: "anthropic", model: "claude-sonnet-4-6" },
  });
  expect(m.isUnavailable("claude")).toBe(true);
});
