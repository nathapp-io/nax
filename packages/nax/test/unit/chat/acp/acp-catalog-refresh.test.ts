import { beforeEach, describe, expect, mock, test } from "bun:test";
import { makeLogger, withDepsRestore } from "@test/helpers";
import { _acpCatalogDeps, ACP_CHAT_AGENTS, createAcpCatalog } from "@/chat/acp";
import { NaxError } from "@/errors";

describe("AcpCatalog.refresh", () => {
  withDepsRestore(_acpCatalogDeps);
  beforeEach(() => {
    _acpCatalogDeps.launchCandidateKind = () => "local";
    _acpCatalogDeps.probeAcpAgent = mock(async () => ({ offeredModels: ["a", "b"] }));
  });

  test("AC-1 AC-2 AC-3 probes even saved/learned offers, ordered results and model counts", async () => {
    _acpCatalogDeps.createAcpOfferStore = () => ({
      load: async () => new Map([["claude", { models: ["saved"], efforts: [] }]]),
      save: async () => {},
    });
    const catalog = createAcpCatalog({ env: {}, sessionsDir: "/fake" });
    await catalog.load();
    catalog.opened("acp:codex", { offeredModels: ["learned"] });
    const results = await catalog.refresh("/r");
    expect(results).toEqual(ACP_CHAT_AGENTS.map((agent) => ({ agent, outcome: "learned", models: 2 })));
    expect(_acpCatalogDeps.probeAcpAgent).toHaveBeenCalledTimes(3);
    for (const agent of ACP_CHAT_AGENTS) {
      expect(_acpCatalogDeps.probeAcpAgent).toHaveBeenCalledWith({ agent, cwd: "/r" });
      expect(catalog.rows()).toContain(`acp:${agent}/a`);
      expect(catalog.rows()).toContain(`acp:${agent}/b`);
    }
  });

  test("AC-4 missing binaries are memoized and never launched", async () => {
    const discovery = mock(() => undefined);
    _acpCatalogDeps.launchCandidateKind = discovery;
    const catalog = createAcpCatalog({ env: {} });
    catalog.rows();
    expect(await catalog.refresh("/r")).toEqual(ACP_CHAT_AGENTS.map((agent) => ({ agent, outcome: "not installed" })));
    expect(discovery).toHaveBeenCalledTimes(3);
    expect(_acpCatalogDeps.probeAcpAgent).not.toHaveBeenCalled();
  });

  test.each([
    ["AC-5 auth", new NaxError("login", "AGENT_SESSION_AUTH_REQUIRED", { stage: "chat" }), "not logged in", true],
    ["AC-5 generic", new Error("boom\nmore"), "boom", false],
    [
      "AC-14 backend",
      new NaxError("spawn failed\ndetail", "AGENT_SESSION_BACKEND_UNAVAILABLE", { stage: "chat" }),
      "spawn failed",
      true,
    ],
    // biome-ignore lint/suspicious/useErrorMessage: AC-14 explicitly requires an empty probe error.
    ["AC-14 empty", new Error(""), "probe failed", false],
    ["AC-16 long", new Error(`${"x".repeat(200)}\nmore`), "x".repeat(120), false],
  ])("%s preserves failure reasons", async (_ac, error, reason, unavailable) => {
    _acpCatalogDeps.probeAcpAgent = mock(async () => {
      throw error;
    });
    const logger = makeLogger();
    const catalog = createAcpCatalog({ env: {}, logger });
    expect(await catalog.refresh("/r")).toEqual(ACP_CHAT_AGENTS.map((agent) => ({ agent, outcome: "failed", reason })));
    expect(catalog.unavailable("acp:codex")).toBe(unavailable ? reason : undefined);
    expect(logger.debug).toHaveBeenCalledTimes(3);
  });

  test("AC-6 warm and concurrent refresh share pending probes, not completion order", async () => {
    const pending = Promise.withResolvers<Readonly<Record<string, unknown>>>();
    _acpCatalogDeps.probeAcpAgent = mock(async ({ agent }) => (agent === "codex" ? pending.promise : {}));
    const catalog = createAcpCatalog({ env: {} });
    catalog.warm("/r");
    const first = catalog.refresh("/r");
    const second = catalog.refresh("/r");
    expect(_acpCatalogDeps.probeAcpAgent).toHaveBeenCalledTimes(3);
    pending.resolve({ offeredModels: ["shared"] });
    const results = await first;
    expect(results.map((result) => result.agent)).toEqual([...ACP_CHAT_AGENTS]);
    expect(results[1]).toEqual({ agent: "codex", outcome: "learned", models: 1 });
    expect(await second).toEqual(results);
  });

  test("AC-13 effort-only success reports zero models", async () => {
    _acpCatalogDeps.probeAcpAgent = async () => ({ offeredEfforts: ["low"] });
    const catalog = createAcpCatalog({ env: {} });
    expect(await catalog.refresh("/r")).toEqual(
      ACP_CHAT_AGENTS.map((agent) => ({ agent, outcome: "learned", models: 0 })),
    );
    expect(catalog.effortLevels("acp:codex")).toContain("low");
  });

  test.each([false, true])("close drops late probe side effects (reject=%s)", async (reject) => {
    const pending = Promise.withResolvers<Readonly<Record<string, unknown>>>();
    _acpCatalogDeps.probeAcpAgent = () => pending.promise;
    const save = mock(async () => {});
    _acpCatalogDeps.createAcpOfferStore = () => ({ load: async () => new Map(), save });
    const logger = makeLogger();
    const catalog = createAcpCatalog({ env: {}, sessionsDir: "/fake", logger });
    const refreshing = catalog.refresh("/r");
    catalog.close();
    if (reject) pending.reject(new NaxError("login", "AGENT_SESSION_AUTH_REQUIRED", { stage: "chat" }));
    else pending.resolve({ offeredModels: ["late"] });
    await refreshing;
    expect(catalog.rows()).not.toContain("acp:codex/late");
    expect(catalog.unavailable("acp:codex")).toBeUndefined();
    expect(save).not.toHaveBeenCalled();
    expect(logger.debug).not.toHaveBeenCalled();
  });
});
