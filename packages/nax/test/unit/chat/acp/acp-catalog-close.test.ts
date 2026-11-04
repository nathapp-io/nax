import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AgentSessionError } from "@nathapp/nax-agent";
import { makeLogger, withTimerSpy } from "@test/helpers";
import * as acpExports from "@/chat/acp";
import { _acpCatalogDeps, type AcpCatalog, createAcpCatalog } from "@/chat/acp/acp-catalog";

const original = { ..._acpCatalogDeps };
const catalogs: AcpCatalog[] = [];
const releases: (() => void)[] = [];

beforeEach(() => {
  _acpCatalogDeps.launchCandidateKind = (agent) => (agent === "codex" ? "local" : undefined);
});
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await Promise.all(catalogs.splice(0).map((catalog) => catalog.close()));
  Object.assign(_acpCatalogDeps, original);
});

function fixture(closeBoundMs = 60_000) {
  const logger = makeLogger();
  const catalog = createAcpCatalog({ env: {}, logger, sessionsDir: "/s", closeBoundMs });
  catalogs.push(catalog);
  return { catalog, logger };
}

function abortingProbe() {
  _acpCatalogDeps.probeAcpAgent = ({ signal }) =>
    new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new AgentSessionError("closed", "AGENT_SESSION_CLOSED")), {
        once: true,
      });
    });
}

function pendingProbe() {
  const pending = Promise.withResolvers<Readonly<Record<string, unknown>>>();
  releases.push(() => pending.resolve({}));
  _acpCatalogDeps.probeAcpAgent = () => pending.promise;
}

function pendingSave() {
  const save = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  releases.push(() => save.resolve());
  _acpCatalogDeps.probeAcpAgent = async () => ({ offeredModels: ["m1"] });
  _acpCatalogDeps.createAcpOfferStore = () => ({
    load: async () => new Map(),
    save: () => {
      entered.resolve();
      return save.promise;
    },
  });
  return { save, entered };
}

// Avoid constructing real stores even though no I/O occurs in most cases.
beforeEach(() => {
  _acpCatalogDeps.createAcpOfferStore = () => ({ load: async () => new Map(), save: async () => {} });
});

describe("AcpCatalog bounded close", () => {
  test("AC-3 exports the default close bound from the barrel", () => {
    expect(acpExports).toHaveProperty("ACP_CATALOG_CLOSE_BOUND_MS", 2000);
  });

  test.each(["warm", "refresh"] as const)(
    "AC-4/5/6 %s shares a signal aborted synchronously by close",
    async (method) => {
      let recorded: AbortSignal | undefined;
      _acpCatalogDeps.probeAcpAgent = async ({ signal }) => {
        recorded = signal;
        return {};
      };
      const { catalog } = fixture();
      const work = catalog[method]("/r");
      expect(recorded).toBeInstanceOf(AbortSignal);
      expect(recorded?.aborted).toBe(false);
      const closing = catalog.close();
      expect(recorded?.aborted).toBe(true);
      await closing;
      await work;
    },
  );

  test("AC-7 repeated close returns the exact same promise", async () => {
    const { catalog } = fixture();
    const first = catalog.close();
    expect(first).toBeInstanceOf(Promise);
    expect(catalog.close()).toBe(first);
    await first;
  });

  test("AC-8/9/12 aborted probes settle promptly without failure records or leaked timers", async () => {
    abortingProbe();
    const { catalog, logger } = fixture();
    catalog.warm("/r");
    const timers = await withTimerSpy(async () => {
      const closing = catalog.close();
      expect(closing).toBeInstanceOf(Promise);
      await closing;
    });
    expect(timers.armed.length).toBeGreaterThan(0);
    expect(timers.armed.every((id) => timers.cleared.has(id))).toBe(true);
    expect(timers.leaked).toEqual([]);
    expect(catalog.unavailable("acp:codex")).toBeUndefined();
    expect(logger.debug.mock.calls.some(([, message]) => message === "ACP offer probe failed")).toBe(false);
  }, 1000);

  test("AC-10/11 bounds an uncooperative probe and names it", async () => {
    pendingProbe();
    const { catalog, logger } = fixture(20);
    catalog.warm("/r");
    await catalog.close();
    expect(logger.debug).toHaveBeenCalledWith("chat", "ACP catalog closed with probes still pending", {
      agents: ["codex"],
    });
  });

  test("AC-13 bounds an uncooperative save with no pending agents", async () => {
    const { entered } = pendingSave();
    const { catalog, logger } = fixture(20);
    catalog.warm("/r");
    await entered.promise;
    await catalog.close();
    expect(logger.debug).toHaveBeenCalledWith("chat", "ACP catalog closed with probes still pending", { agents: [] });
  });

  test("AC-14 waits for a pending save and resolves after it completes", async () => {
    const { save, entered } = pendingSave();
    const { catalog } = fixture();
    catalog.warm("/r");
    await entered.promise;
    let resolved = false;
    const closing = Promise.resolve(catalog.close()).then(() => {
      resolved = true;
    });
    try {
      await Promise.resolve();
      expect(resolved).toBe(false);
    } finally {
      save.resolve();
      await closing;
    }
    expect(resolved).toBe(true);
  });

  test("AC-15/19 settles a save rejected during close and preserves its warning", async () => {
    const { save, entered } = pendingSave();
    const { catalog, logger } = fixture();
    catalog.warm("/r");
    await entered.promise;
    const closing = catalog.close();
    expect(closing).toBeInstanceOf(Promise);
    const error = new Error("save failed");
    save.reject(error);
    await closing;
    expect(logger.warn).toHaveBeenCalledWith("chat", "Failed to save ACP offers", { error });
  });
});
