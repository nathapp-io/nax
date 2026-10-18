import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { StoredEntry } from "@nathapp/nax-agent";
import { makeAgentAdapter, makeAgentRegistry } from "@test/helpers";
import { authReloginHint } from "@/agents/auth-relogin";
import { _agentManagerDeps, AgentManager } from "@/agents/manager";
import { NaxConfigSchema } from "@/config/schemas";
import type { AdapterFailure } from "@/context/engine";

const AUTH: AdapterFailure = { outcome: "fail-auth", category: "availability", retriable: false, message: "401" };
const NOW = 1_800_000_000_000;
const FUTURE = NOW + 86_400_000;
const LOGIN = "Login for openai-codex was rejected. Run: nax auth login openai-codex";
const FUTURE_HINT = `Login for openai-codex was rejected before its recorded expiry (expires ${new Date(FUTURE).toISOString()}). Run: nax auth login openai-codex`;
const UNKNOWN = "Credentials for openai-codex were rejected. Check where they come from with: nax auth list";
const KEY =
  "API key for openai-codex was rejected. Check or replace it: nax auth login openai-codex (or nax auth import)";

test.each([
  ["AC-1", { providerId: "openai-codex", kind: "oauth", expires: FUTURE }, FUTURE_HINT],
  ["AC-2 equal", { providerId: "openai-codex", kind: "oauth", expires: NOW }, LOGIN],
  ["AC-2 past", { providerId: "openai-codex", kind: "oauth", expires: NOW - 1 }, LOGIN],
  ["AC-3", { providerId: "openai-codex", kind: "oauth" }, LOGIN],
  ["AC-4", { providerId: "openai-codex", kind: "api-key" }, KEY],
  ["AC-5", undefined, UNKNOWN],
] satisfies [string, StoredEntry | undefined, string][])("%s hint", (_ac, entry, expected) => {
  expect(authReloginHint("openai-codex", entry, NOW)).toBe(expected);
});

const original = { ..._agentManagerDeps };
let fingerprint = "aaa";
let stored: StoredEntry[] = [];
const logger = {
  warn: mock((_scope: string, _message: string, _data?: Record<string, unknown>) => {}),
  info: mock(() => {}),
  debug: mock(() => {}),
};
const managers: AgentManager[] = [];
beforeEach(() => {
  fingerprint = "aaa";
  stored = [{ providerId: "openai-codex", kind: "oauth", expires: FUTURE }];
  _agentManagerDeps.now = () => NOW;
  _agentManagerDeps.servedAuth = () => ({ fingerprint, source: "file" });
  _agentManagerDeps.readCredential = async () => {};
  _agentManagerDeps.listStoredProviders = async () => stored;
  for (const fn of Object.values(logger)) fn.mockClear();
});
afterEach(() => {
  Object.assign(_agentManagerDeps, original);
  for (const manager of managers) manager.close();
  managers.length = 0;
});
function setup(enabled = true) {
  const config = NaxConfigSchema.parse({
    agent: { protocol: "hybrid", default: "native", fallback: { enabled, map: { native: ["claude"] } } },
    models: { native: { balanced: "openai-codex/gpt-6.1-sol" } },
  });
  const registry = makeAgentRegistry({
    getAgent: () =>
      makeAgentAdapter({
        complete: async () => ({
          output: "failed",
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          estimatedCostUsd: 0,
          adapterFailure: AUTH,
        }),
      }),
  });
  const manager = new AgentManager(config, registry, { models: config.models, logger });
  managers.push(manager);
  return { manager, config };
}
function notice(message = FUTURE_HINT) {
  return { providerId: "openai-codex", agent: "native", message };
}

test("AC-6/11 reports stored OAuth and retains notice", async () => {
  const { manager } = setup();
  await manager.reportAuthFailure("native", AUTH, "balanced");
  expect(logger.warn).toHaveBeenCalledTimes(1);
  expect(logger.warn).toHaveBeenCalledWith("agent-manager", FUTURE_HINT, {
    storyId: "_agent",
    agent: "native",
    providerId: "openai-codex",
    kind: "oauth",
    expires: FUTURE,
  });
  expect(manager.authRelogins()).toEqual([notice()]);
});
test("AC-7 concurrent claims log once", async () => {
  const { manager } = setup();
  await Promise.all([
    manager.reportAuthFailure("native", AUTH, "balanced"),
    manager.reportAuthFailure("native", AUTH, "balanced"),
  ]);
  expect(logger.warn).toHaveBeenCalledTimes(1);
});
test("AC-8 list failure still warns", async () => {
  _agentManagerDeps.listStoredProviders = async () => {
    throw new Error("unavailable");
  };
  const { manager } = setup();
  await manager.reportAuthFailure("native", AUTH, "balanced");
  expect(logger.warn).toHaveBeenCalledTimes(1);
  expect(manager.authRelogins()).toEqual([notice(UNKNOWN)]);
  expect(logger.warn).toHaveBeenCalledWith(
    "agent-manager",
    UNKNOWN,
    expect.objectContaining({ providerId: "openai-codex" }),
  );
  expect(logger.debug).toHaveBeenCalledWith(
    "agent-manager",
    expect.stringContaining("Credential metadata read failed"),
    expect.objectContaining({ providerId: "openai-codex", error: "Error: unavailable" }),
  );
});
test.each([
  ["AC-9", "native", { ...AUTH, outcome: "fail-rate-limit" }, "balanced", undefined],
  ["AC-10", "claude", AUTH, "fast", undefined],
  ["unknown provider", "native", AUTH, undefined, "unknown/model"],
] satisfies [string, string, AdapterFailure, string | undefined, string | undefined][])(
  "%s ignores irrelevant failures",
  async (_ac, agent, failure, tier, model) => {
    const { manager } = setup();
    await manager.reportAuthFailure(agent, failure, tier, model);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(manager.authRelogins()).toEqual([]);
  },
);
test("AC-12 replaces provider notice after fingerprint change", async () => {
  const { manager } = setup();
  await manager.reportAuthFailure("native", AUTH, "balanced");
  fingerprint = "bbb";
  stored = [{ providerId: "openai-codex", kind: "api-key" }];
  await manager.reportAuthFailure("native", AUTH, "balanced");
  expect(manager.authRelogins()).toEqual([notice(KEY)]);
});
test("AC-13/24 release drops notice and new failure reports again", async () => {
  const { manager } = setup();
  await manager.reportAuthFailure("native", AUTH, "balanced");
  manager.markUnavailable("native", AUTH, "balanced");
  fingerprint = "bbb";
  await manager.refreshAuthCooldowns();
  expect(manager.authRelogins()).toEqual([]);
  stored = [{ providerId: "openai-codex", kind: "api-key" }];
  manager.markUnavailable("native", AUTH, "balanced");
  await manager.reportAuthFailure("native", AUTH, "balanced");
  expect(logger.warn).toHaveBeenCalledTimes(2);
  expect(manager.authRelogins()).toEqual([notice(KEY)]);
});
test("AC-14 reset clears notices and claims", async () => {
  const { manager } = setup();
  await manager.reportAuthFailure("native", AUTH, "balanced");
  manager.reset();
  expect(manager.authRelogins()).toEqual([]);
  await manager.reportAuthFailure("native", AUTH, "balanced");
  expect(logger.warn).toHaveBeenCalledTimes(2);
});
test("AC-19 declined-swap notice changes without recovery log", async () => {
  const { manager } = setup();
  await manager.reportAuthFailure("native", AUTH, "balanced");
  await manager.refreshAuthCooldowns();
  expect(manager.authRelogins()).toHaveLength(1);
  fingerprint = "bbb";
  await manager.refreshAuthCooldowns();
  expect(manager.authRelogins()).toEqual([]);
  expect(logger.info).not.toHaveBeenCalled();
});
test.each([
  ["AC-15", true, false],
  ["AC-16", false, false],
  ["AC-17", true, true],
] as const)("%s run warns before fallback or terminal return", async (_ac, enabled, noFallback) => {
  const { manager, config } = setup(enabled);
  const calls: string[] = [];
  await manager.runWithFallback({
    noFallback,
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
      if (agent === "claude") {
        expect(manager.authRelogins()).toEqual([notice()]);
        expect(logger.warn).toHaveBeenCalledWith("agent-manager", FUTURE_HINT, expect.any(Object));
      }
      return {
        bundle,
        endpoint: { modelDef: { provider: "openai-codex", model: "openai-codex/gpt-6.1-sol" } },
        result: {
          success: agent === "claude",
          exitCode: 1,
          output: "failed",
          rateLimited: false,
          durationMs: 0,
          estimatedCostUsd: 0,
          adapterFailure: agent === "native" ? AUTH : undefined,
        },
      };
    },
  });
  expect(calls).toEqual(enabled && !noFallback ? ["native", "claude"] : ["native"]);
  expect(logger.warn.mock.calls.filter((c) => c[1] === FUTURE_HINT)).toHaveLength(1);
  expect(manager.authRelogins()).toEqual([notice()]);
});
test("provider notices retain first-report order despite metadata read order", async () => {
  const { manager } = setup();
  let resolveFirst!: (entries: StoredEntry[]) => void;
  const firstRead = new Promise<StoredEntry[]>((resolve) => {
    resolveFirst = resolve;
  });
  let reads = 0;
  _agentManagerDeps.listStoredProviders = () => (++reads === 1 ? firstRead : Promise.resolve([]));
  const first = manager.reportAuthFailure("native", AUTH, "balanced");
  await manager.reportAuthFailure("native", AUTH, undefined, "minimax/model");
  resolveFirst(stored);
  await first;
  expect(manager.authRelogins().map(({ providerId }) => providerId)).toEqual(["openai-codex", "minimax"]);
});

test("reset while metadata is pending does not resurrect a notice", async () => {
  const { manager } = setup();
  let resolveRead!: (entries: StoredEntry[]) => void;
  _agentManagerDeps.listStoredProviders = () =>
    new Promise((resolve) => {
      resolveRead = resolve;
    });
  const pending = manager.reportAuthFailure("native", AUTH, "balanced");
  manager.reset();
  resolveRead(stored);
  await pending;
  expect(manager.authRelogins()).toEqual([]);
  expect(logger.warn).not.toHaveBeenCalled();
});

test("late metadata for an old fingerprint cannot replace the latest notice", async () => {
  const { manager } = setup();
  let resolveRead!: (entries: StoredEntry[]) => void;
  const pendingRead = new Promise<StoredEntry[]>((resolve) => {
    resolveRead = resolve;
  });
  let reads = 0;
  _agentManagerDeps.listStoredProviders = () =>
    ++reads === 1 ? pendingRead : Promise.resolve([{ providerId: "openai-codex", kind: "api-key" }]);
  const first = manager.reportAuthFailure("native", AUTH, "balanced");
  fingerprint = "bbb";
  await manager.reportAuthFailure("native", AUTH, "balanced");
  resolveRead(stored);
  await first;
  expect(manager.authRelogins()).toEqual([notice(KEY)]);
});

test("AC-18 complete warns with fallback disabled", async () => {
  const { manager } = setup(false);
  await manager.completeWithFallback("do it", {
    workdir: "/tmp",
    modelDef: { provider: "openai-codex", model: "gpt-6.1-sol" },
    resolvedPermissions: { mode: "approve-reads", bashApproval: "raw" },
  });
  expect(logger.warn.mock.calls.filter((c) => c[1] === FUTURE_HINT)).toHaveLength(1);
  expect(manager.authRelogins()).toEqual([notice()]);
});
test("a dispatched authModel names the notice's provider, as it names the cooldown stamp", async () => {
  stored = [];
  const { manager } = setup();
  await manager.reportAuthFailure("native", AUTH, "balanced", undefined, "minimax/m3");
  manager.markUnavailable("native", AUTH, "balanced", undefined, "minimax/m3");
  expect(manager.authRelogins().map((n) => n.providerId)).toEqual(["minimax"]);
  fingerprint = "bbb";
  await manager.refreshAuthCooldowns();
  expect(manager.authRelogins()).toEqual([]);
});
