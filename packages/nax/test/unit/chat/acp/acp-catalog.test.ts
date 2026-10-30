import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { AgentSessionError, type AgentSessionErrorCode } from "@nathapp/nax-agent";
import { makeLogger, waitForCondition } from "@test/helpers";
import { _acpCatalogDeps, createAcpCatalog } from "@/chat/acp/acp-catalog";
import type { AcpChatAgent } from "@/chat/acp/acp-model";
import type { AcpOffer, AcpOfferStore } from "@/chat/acp/acp-offer-store";

type Kind = "local" | "npx" | undefined;
type ProbeKinds = Partial<Record<string, Kind>>;

const original = { ..._acpCatalogDeps };
const ENV = { PATH: "/test/bin" };
let probe: ReturnType<typeof mock<(agent: string, env?: Readonly<Record<string, string | undefined>>) => Kind>>;

function stubProbe(kinds: ProbeKinds = {}): void {
  probe = mock(
    (agent: string, _env?: Readonly<Record<string, string | undefined>>): Kind =>
      agent in kinds ? kinds[agent] : "local",
  );
  _acpCatalogDeps.launchCandidateKind = probe;
}

function catalog() {
  return createAcpCatalog({ env: ENV });
}

function sessionError(code: AgentSessionErrorCode, message = `injected ${code}`): AgentSessionError {
  return new AgentSessionError(message, code);
}

beforeEach(() => stubProbe());
afterEach(() => {
  Object.assign(_acpCatalogDeps, original);
});

describe("AcpCatalog.rows", () => {
  test("lists the three agents in order before anything is learned", () => {
    expect(catalog().rows()).toEqual(["acp:claude", "acp:codex", "acp:cursor"]);
  });

  test("lists an agent's learned models right after its row", () => {
    const acp = catalog();
    acp.opened("acp:codex", { offeredModels: ["gpt-5.5", "gpt-5.4"] });
    expect(acp.rows()).toEqual(["acp:claude", "acp:codex", "acp:codex/gpt-5.5", "acp:codex/gpt-5.4", "acp:cursor"]);
  });

  test("a non-empty report replaces the agent's rows, whichever model string reported it", () => {
    const acp = catalog();
    acp.opened("acp:codex/gpt-5.5", { offeredModels: ["gpt-5.5"] });
    acp.opened("acp:codex", { offeredModels: ["gpt-5.4"] });
    expect(acp.rows()).toContain("acp:codex/gpt-5.4");
    expect(acp.rows()).not.toContain("acp:codex/gpt-5.5");
  });

  test("keeps the previous models when a later report is not an array", () => {
    const acp = catalog();
    acp.opened("acp:codex", { offeredModels: ["gpt-5.5"] });
    acp.opened("acp:codex", { offeredModels: "gpt-5.4" });
    expect(acp.rows()).toContain("acp:codex/gpt-5.5");
    expect(acp.rows()).not.toContain("acp:codex/gpt-5.4");
  });

  test("keeps the previous models when a later report is empty", () => {
    const acp = catalog();
    acp.opened("acp:codex", { offeredModels: ["gpt-5.5"], offeredEfforts: ["high"] });
    acp.opened("acp:codex", { offeredModels: [], offeredEfforts: [] });
    expect(acp.rows()).toContain("acp:codex/gpt-5.5");
  });

  test("keeps the previous models when a later report carries no fields", () => {
    const acp = catalog();
    acp.opened("acp:codex", { offeredModels: ["gpt-5.5"] });
    acp.opened("acp:codex", {});
    expect(acp.rows()).toContain("acp:codex/gpt-5.5");
  });

  test("learns only the string elements of a report", () => {
    const acp = catalog();
    acp.opened("acp:codex", { offeredModels: ["gpt-5.5", 7] });
    expect(acp.rows()).toEqual(["acp:claude", "acp:codex", "acp:codex/gpt-5.5", "acp:cursor"]);
  });

  test("keeps each agent's models apart", () => {
    const acp = catalog();
    acp.opened("acp:codex", { offeredModels: ["gpt-5.5"] });
    acp.opened("acp:claude", { offeredModels: ["opus"] });
    expect(acp.rows()).toEqual(["acp:claude", "acp:claude/opus", "acp:codex", "acp:codex/gpt-5.5", "acp:cursor"]);
  });

  test("ignores an open of a native model", () => {
    const acp = catalog();
    acp.opened("openai/gpt-6", { offeredModels: ["x"] });
    expect(acp.rows()).toEqual(["acp:claude", "acp:codex", "acp:cursor"]);
  });
});

describe("AcpCatalog.effortLevels", () => {
  test("is only default before any open", () => {
    expect(catalog().effortLevels("acp:codex")).toEqual(["default"]);
  });

  test("keeps the previous efforts when a later report is empty", () => {
    const acp = catalog();
    acp.opened("acp:codex", { offeredModels: ["gpt-5.5"], offeredEfforts: ["high"] });
    acp.opened("acp:codex", { offeredModels: [], offeredEfforts: [] });
    expect(acp.effortLevels("acp:codex")).toEqual(["default", "high"]);
  });

  test("applies the agent's levels to a model string carrying an effort", () => {
    const acp = catalog();
    acp.opened("acp:codex", { offeredEfforts: ["low", "high"] });
    expect(acp.effortLevels("acp:codex/gpt-5.5[high]")).toEqual(["default", "low", "high"]);
  });

  test("does not lend one agent's levels to another", () => {
    const acp = catalog();
    acp.opened("acp:codex", { offeredEfforts: ["low", "high"] });
    expect(acp.effortLevels("acp:claude")).toEqual(["default"]);
  });
});

describe("AcpCatalog install probe", () => {
  test("reports an agent whose binary does not resolve as not installed", () => {
    stubProbe({ cursor: undefined });
    const acp = catalog();
    expect(acp.installed("acp:cursor")).toBe(false);
    expect(acp.unavailable("acp:cursor")).toBe("not installed");
  });

  test("counts an npx-only agent as installed", () => {
    stubProbe({ claude: "npx" });
    const acp = catalog();
    expect(acp.installed("acp:claude")).toBe(true);
    expect(acp.unavailable("acp:claude")).toBeUndefined();
  });

  test("probes each agent once with the supplied env across repeated calls", () => {
    const acp = catalog();
    acp.rows();
    acp.rows();
    acp.installed("acp:codex");
    acp.unavailable("acp:codex");
    acp.installed("acp:claude");
    expect(probe).toHaveBeenCalledTimes(3);
    expect(probe.mock.calls.map(([agent]) => agent).sort()).toEqual(["claude", "codex", "cursor"]);
    for (const [, env] of probe.mock.calls) expect(env).toBe(ENV);
  });
});

describe("AcpCatalog.failed", () => {
  test("records an auth failure as not logged in, for every model of the agent", () => {
    const acp = catalog();
    acp.failed("acp:codex", sessionError("AGENT_SESSION_AUTH_REQUIRED"));
    expect(acp.unavailable("acp:codex/gpt-5.5")).toBe("not logged in");
    expect(acp.unavailable("acp:claude")).toBeUndefined();
  });

  test("records the first line of an unavailable backend's message", () => {
    const acp = catalog();
    acp.failed("acp:codex", sessionError("AGENT_SESSION_BACKEND_UNAVAILABLE", "spawn failed\nmore"));
    expect(acp.unavailable("acp:codex")).toBe("spawn failed");
  });

  test("caps the recorded reason at 120 characters", () => {
    const acp = catalog();
    const line = "x".repeat(200);
    acp.failed("acp:codex", sessionError("AGENT_SESSION_BACKEND_UNAVAILABLE", `${line}\nmore`));
    expect(acp.unavailable("acp:codex")).toBe("x".repeat(120));
  });

  test("records nothing for a model mismatch", () => {
    const acp = catalog();
    acp.failed("acp:codex", sessionError("AGENT_SESSION_MODEL_MISMATCH"));
    expect(acp.unavailable("acp:codex")).toBeUndefined();
  });

  test("records nothing for an unsupported capability, a timeout or a non-error", () => {
    const acp = catalog();
    acp.failed("acp:codex", sessionError("AGENT_SESSION_CAPABILITY_UNSUPPORTED"));
    acp.failed("acp:codex", new Error("timed out"));
    acp.failed("acp:codex", "boom");
    expect(acp.unavailable("acp:codex")).toBeUndefined();
  });

  test("ignores a failure of a native model", () => {
    const acp = catalog();
    acp.failed("openai/gpt-6", sessionError("AGENT_SESSION_AUTH_REQUIRED"));
    expect(acp.unavailable("openai/gpt-6")).toBeUndefined();
  });

  test("a later successful open clears the recorded failure", () => {
    const acp = catalog();
    acp.failed("acp:codex", sessionError("AGENT_SESSION_AUTH_REQUIRED"));
    acp.opened("acp:codex", {});
    expect(acp.unavailable("acp:codex")).toBeUndefined();
  });

  test("not installed outranks a recorded failure", () => {
    stubProbe({ codex: undefined });
    const acp = catalog();
    acp.failed("acp:codex", sessionError("AGENT_SESSION_AUTH_REQUIRED"));
    expect(acp.unavailable("acp:codex")).toBe("not installed");
  });
});

describe("AcpCatalog with a native model", () => {
  test("has no unavailable reason and counts as installed", () => {
    const acp = catalog();
    expect(acp.unavailable("openai/gpt-6")).toBeUndefined();
    expect(acp.installed("openai/gpt-6")).toBe(true);
  });
});

describe("AcpCatalog persistence", () => {
  function fixture(loaded: ReadonlyMap<AcpChatAgent, AcpOffer> = new Map()) {
    const logger = makeLogger();
    const store: AcpOfferStore = { load: mock(async () => loaded), save: mock(async () => {}) };
    const factory = mock((_input: { path: string; logger?: unknown }) => store);
    _acpCatalogDeps.createAcpOfferStore = factory;
    const acp = createAcpCatalog({ env: ENV, sessionsDir: "/sessions", logger });
    return { logger, store, factory, acp };
  }
  const saved = () => new Map<AcpChatAgent, AcpOffer>([["codex", { models: ["m1"], efforts: ["high"] }]]);

  test("AC-10 loads saved models and efforts without an open", async () => {
    const { acp, factory } = fixture(saved());
    await acp.load();
    expect(acp.rows()).toContain("acp:codex/m1");
    expect(acp.effortLevels("acp:codex")).toContain("high");
    expect(factory.mock.calls[0]?.[0]).toEqual({ path: "/sessions/acp-offers.json", logger: expect.anything() });
  });
  test("AC-11 a live open wins a racing saved load", async () => {
    const { acp, store } = fixture();
    const pending = Promise.withResolvers<ReadonlyMap<AcpChatAgent, AcpOffer>>();
    store.load = () => pending.promise;
    const loading = acp.load();
    acp.opened("acp:codex", { offeredModels: ["live"] });
    pending.resolve(new Map([["codex", { models: ["saved"], efforts: ["high"] }]]));
    await loading;
    expect(acp.rows()).toContain("acp:codex/live");
    expect(acp.rows()).not.toContain("acp:codex/saved");
  });
  test("AC-12 saves a snapshot of every known agent", async () => {
    const { acp, store } = fixture(saved());
    await acp.load();
    const save = mock(store.save);
    store.save = save;
    acp.opened("acp:claude", { offeredModels: ["opus"], offeredEfforts: [] });
    await waitForCondition(() => save.mock.calls.length === 1);
    expect(save.mock.calls[0]?.[0]).toEqual(new Map([["claude", { models: ["opus"], efforts: [] }], ...saved()]));
  });
  test("AC-13 no reported lists means no save", async () => {
    const { acp, store } = fixture();
    const save = mock(store.save);
    store.save = save;
    acp.opened("acp:claude", {});
    await acp.load();
    expect(save).not.toHaveBeenCalled();
  });
  test("AC-14 failed saves warn without throwing; AC-17 serializes and recovers", async () => {
    const { acp, store, logger } = fixture();
    const first = Promise.withResolvers<void>();
    const save = mock((_offers: ReadonlyMap<AcpChatAgent, AcpOffer>) =>
      save.mock.calls.length === 1 ? first.promise : Promise.resolve(),
    );
    store.save = save;
    expect(() => acp.opened("acp:codex", { offeredModels: ["first"] })).not.toThrow();
    await waitForCondition(() => save.mock.calls.length === 1);
    acp.opened("acp:codex", { offeredModels: ["second"] });
    await Promise.resolve();
    expect(save).toHaveBeenCalledTimes(1);
    first.reject(new Error("save failed"));
    await waitForCondition(() => save.mock.calls.length === 2);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]?.[0]).toBe("chat");
    expect(save.mock.calls[1]?.[0].get("codex")?.models).toEqual(["second"]);
  });
  test("AC-15 memory-only never constructs a store", async () => {
    const { factory } = fixture();
    factory.mockClear();
    const acp = catalog();
    await acp.load();
    acp.opened("acp:codex", { offeredModels: ["live"] });
    expect(factory).not.toHaveBeenCalled();
  });
  test("AC-18 efforts-only agents are omitted from saves", async () => {
    const { acp, store } = fixture(saved());
    await acp.load();
    const save = mock(store.save);
    store.save = save;
    acp.opened("acp:cursor", { offeredEfforts: ["high"] });
    await waitForCondition(() => save.mock.calls.length === 1);
    expect(save.mock.calls[0]?.[0]).toEqual(saved());
  });
  test("AC-19 unexpected load rejection warns once and keeps bare rows", async () => {
    const { acp, store, logger } = fixture();
    store.load = async () => {
      throw new Error("read failed");
    };
    await acp.load();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]?.[0]).toBe("chat");
    expect(acp.rows()).toEqual(["acp:claude", "acp:codex", "acp:cursor"]);
  });
});

describe("AcpCatalog warm and close", () => {
  function fixture(offers: ReadonlyMap<AcpChatAgent, AcpOffer> = new Map()) {
    stubProbe({ claude: undefined, cursor: undefined });
    const pending = Promise.withResolvers<Readonly<Record<string, unknown>>>();
    const discover = mock(() => pending.promise);
    _acpCatalogDeps.probeAcpAgent = discover;
    const logger = makeLogger();
    const save = mock(async (_offers: ReadonlyMap<AcpChatAgent, AcpOffer>) => {});
    _acpCatalogDeps.createAcpOfferStore = () => ({ load: async () => offers, save });
    const acp = createAcpCatalog({ env: ENV, sessionsDir: "/s", logger });
    return { acp, pending, discover, logger, save };
  }

  test("AC-6/7/11 starts only installed missing agents without waiting, once per start", async () => {
    const f = fixture();
    expect(f.acp.warm("/r")).toBeUndefined();
    f.acp.warm("/r");
    expect(f.discover).toHaveBeenCalledTimes(1);
    expect(f.discover).toHaveBeenCalledWith({ agent: "codex", cwd: "/r" });
    f.pending.resolve({});
    await f.pending.promise;
    await Promise.resolve();
    f.acp.warm("/r");
    expect(f.discover).toHaveBeenCalledTimes(1);
  });
  test.each(["saved", "learned"])("AC-8 skips %s nonempty models", async (source) => {
    const f = fixture(source === "saved" ? new Map([["codex", { models: ["m"], efforts: [] }]]) : new Map());
    await f.acp.load();
    if (source === "learned") f.acp.opened("acp:codex", { offeredModels: ["m"] });
    f.acp.warm("/r");
    expect(f.discover).not.toHaveBeenCalled();
  });
  test.each(["saved", "learned"])("efforts-only %s offers do not suppress warming", async (source) => {
    const f = fixture(source === "saved" ? new Map([["codex", { models: [], efforts: ["low"] }]]) : new Map());
    await f.acp.load();
    if (source === "learned") f.acp.opened("acp:codex", { offeredEfforts: ["low"] });
    f.acp.warm("/r");
    expect(f.discover).toHaveBeenCalledTimes(1);
    f.pending.resolve({});
  });
  test("AC-9 learns and saves a successful probe", async () => {
    const f = fixture();
    f.acp.warm("/r");
    f.pending.resolve({ offeredModels: ["m1"], offeredEfforts: ["low"] });
    await waitForCondition(() => f.save.mock.calls.length === 1);
    expect(f.acp.rows()).toContain("acp:codex/m1");
    expect(f.acp.effortLevels("acp:codex")).toContain("low");
    expect(f.save.mock.calls[0]?.[0].get("codex")).toEqual({ models: ["m1"], efforts: ["low"] });
  });
  test.each([
    ["AGENT_SESSION_AUTH_REQUIRED", "login", "not logged in"],
    ["AGENT_SESSION_BACKEND_UNAVAILABLE", "spawn failed\ndetail", "spawn failed"],
    ["AGENT_SESSION_TIMEOUT", "timeout", undefined],
  ] as const)("AC-10/16/17 handles %s without rejecting warm", async (code, message, reason) => {
    const f = fixture();
    f.acp.warm("/r");
    const error = code === "AGENT_SESSION_TIMEOUT" ? new Error(message) : sessionError(code, message);
    f.pending.reject(error);
    await waitForCondition(() => f.logger.debug.mock.calls.length === 1);
    expect(f.acp.unavailable("acp:codex")).toBe(reason);
    expect(f.logger.debug).toHaveBeenCalledWith("chat", expect.any(String), { agent: "codex", error });
  });
  test.each(["resolve", "reject"])("AC-12/19 close drops late %s without waiting", async (outcome) => {
    const f = fixture();
    f.acp.warm("/r");
    expect(f.acp.close()).toBeUndefined();
    if (outcome === "resolve") f.pending.resolve({ offeredModels: ["m1"] });
    else f.pending.reject(sessionError("AGENT_SESSION_AUTH_REQUIRED"));
    await f.pending.promise.catch(() => {});
    await Promise.resolve();
    expect(f.acp.rows()).not.toContain("acp:codex/m1");
    expect(f.save).not.toHaveBeenCalled();
    expect(f.acp.unavailable("acp:codex")).toBeUndefined();
    f.acp.warm("/r");
    expect(f.discover).toHaveBeenCalledTimes(1);
  });
  test("AC-20 failed persistence retains the learned probe and warns once", async () => {
    const f = fixture();
    f.save.mockRejectedValue(new Error("write failed"));
    f.acp.warm("/r");
    f.pending.resolve({ offeredModels: ["m1"] });
    await waitForCondition(() => f.logger.warn.mock.calls.length === 1);
    expect(f.acp.rows()).toContain("acp:codex/m1");
    expect(f.logger.warn).toHaveBeenCalledTimes(1);
    expect(f.logger.warn.mock.calls[0]?.[0]).toBe("chat");
  });
});
