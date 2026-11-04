/**
 * host.ts — the koda branch of `composeMemory` (US-009).
 *
 * Covers AC-1..AC-9, AC-14, AC-15 and AC-18 at the `createMemoryHost` entry point. The
 * composition cases stub the three koda `_memoryHostDeps` entries and assert the exact
 * arguments each factory is handed; the identity cases (`AC-6`, AC-18) compose the real
 * provider, because the id a stubbed factory returns would prove nothing. The barrel case
 * asserts the six koda names `@/memory` now re-exports, and the config cases compose a
 * config the schema never saw — the only way to reach the branch's own guard.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createMemoryStore, type MemoryDecision, type MemoryNote, type MemoryProvider } from "@nathapp/nax-agent";
import { assertDefined, cleanupTempDir, type MockLogger, makeLogger, makeNaxConfig, makeTempDir } from "@test/helpers";
import type { McpServerConfig, NaxConfig } from "@/config";
import { NaxError } from "@/errors";
import * as memoryBarrel from "@/memory";
import { _memoryHostDeps, createMemoryHost, type MemoryHost } from "@/memory";
import { createKodaApprovals, type KodaApprovals } from "@/memory/koda-approvals";
import { createKodaClient, type KodaClient, kodaStatusOf, MEMORY_KODA_REQUEST_TIMEOUT_MS } from "@/memory/koda-http";
import { createKodaMemoryProvider, MEMORY_KODA_PROVIDER_PREFIX } from "@/memory/koda-provider";

/** The API root the AC names, koda's global prefix included. */
const API = "https://k/api";
/** The koda project slug the AC names. */
const PROJECT = "rs-stock";
/** The headers the AC names: the bearer key that reaches koda. */
const HEADERS = { Authorization: "Bearer x" };

/** The mirror note AC-4 reads back through the provider's `readNote`. */
const NOTE: MemoryNote = {
  id: "human",
  slug: "staging-db",
  type: "project",
  scope: "project",
  description: "shared staging db",
  source: "nax-chat",
  updatedAt: "2026-11-02T08:11:00.000Z",
  status: "active",
  body: "the body",
};

/** The decision AC-5 reads back through the provider's `readDecisions`. */
const DECISION: MemoryDecision = {
  id: "d1",
  subject: "memory",
  predicate: "provider",
  object: "koda",
  updatedAt: "2026-11-02T08:11:00.000Z",
  status: "active",
};

/** The koda-backed config every composition case opens its host over. */
function kodaConfig(): NaxConfig {
  return makeNaxConfig({
    memory: { provider: "koda", koda: { url: API, project: PROJECT, headers: HEADERS } },
  });
}

/** A client whose two calls are inert: the composition cases never let it reach the network. */
function fakeClient(): KodaClient {
  return {
    get: async () => ({ status: 200, data: {} }),
    post: async () => ({ status: 201, data: {} }),
  };
}

/** A proposal record with nothing in it. */
function fakeApprovals(): KodaApprovals {
  return { list: async () => [], record: async () => {}, drop: async () => {} };
}

/** A provider that is not the koda one: only the id matters to a composition case. */
function stubProvider(id: string): MemoryProvider {
  return {
    id,
    pull: async () => ({ notes: [], done: true }),
    push: async (request) => ({ id: request.clientId, status: "active" }),
    reachable: async () => true,
  };
}

/** The configured MCP server AC-18 composes over. */
function omServer(): McpServerConfig {
  return {
    url: "http://localhost:8765/mcp",
    args: [],
    env: {},
    stages: ["*"],
    timeoutMs: 4321,
    enabled: true,
  };
}

describe("memory host koda composition", () => {
  let repoRoot: string;
  let logger: MockLogger;
  let originalDeps: typeof _memoryHostDeps;

  beforeEach(() => {
    repoRoot = makeTempDir("nax-host-koda-");
    logger = makeLogger();
    originalDeps = { ..._memoryHostDeps };
  });

  afterEach(() => {
    Object.assign(_memoryHostDeps, originalDeps);
    cleanupTempDir(repoRoot);
  });

  async function open(config: NaxConfig): Promise<MemoryHost> {
    const host = await createMemoryHost({ config, repoRoot, source: "nax-chat", logger });
    assertDefined(host, "the memory host");
    return host;
  }

  /**
   * The host creation a bypassed config must fail.
   *
   * Returned unawaited so the two `rejects` assertions below can each read it: a rejected
   * promise may be awaited again, and this keeps the code and the class checked without a
   * cast.
   */
  function creationOf(config: NaxConfig): Promise<MemoryHost | null> {
    return createMemoryHost({ config, repoRoot, source: "nax-chat", logger });
  }

  /** Stub the three koda factories; returns the stubs and what they answer with. */
  function stubKodaFactories(client = fakeClient(), approvals = fakeApprovals(), provider = stubProvider("koda:stub")) {
    const createKodaClientStub = mock((_input: Parameters<typeof _memoryHostDeps.createKodaClient>[0]) => client);
    const createKodaApprovalsStub = mock(
      (_input: Parameters<typeof _memoryHostDeps.createKodaApprovals>[0]) => approvals,
    );
    const createKodaMemoryProviderStub = mock(
      (_input: Parameters<typeof _memoryHostDeps.createKodaMemoryProvider>[0]) => provider,
    );
    _memoryHostDeps.createKodaClient = createKodaClientStub;
    _memoryHostDeps.createKodaApprovals = createKodaApprovalsStub;
    _memoryHostDeps.createKodaMemoryProvider = createKodaMemoryProviderStub;
    return { client, approvals, provider, createKodaClientStub, createKodaApprovalsStub, createKodaMemoryProviderStub };
  }

  /** The input the provider factory was handed; fails when it was never called. */
  function providerInputOf(stub: ReturnType<typeof stubKodaFactories>) {
    const input = stub.createKodaMemoryProviderStub.mock.calls[0]?.[0];
    assertDefined(input, "the provider factory input");
    return input;
  }

  test("AC-1 the client factory receives the configured url, headers and the request timeout", async () => {
    const stub = stubKodaFactories();

    await open(kodaConfig());

    expect(stub.createKodaClientStub.mock.calls).toEqual([
      [{ url: API, headers: HEADERS, timeoutMs: MEMORY_KODA_REQUEST_TIMEOUT_MS }],
    ]);
  });

  test("AC-2 the approvals record is built in the host's own project mirror directory", async () => {
    const stub = stubKodaFactories();

    const host = await open(kodaConfig());

    expect(stub.createKodaApprovalsStub.mock.calls).toEqual([[{ dir: host.dirs.projectDir, logger }]]);
  });

  test("AC-3 the provider factory receives the project slug, the client and the approvals record", async () => {
    const stub = stubKodaFactories();

    await open(kodaConfig());

    const input = providerInputOf(stub);
    expect({
      project: input.project,
      client: input.client === stub.client,
      approvals: input.approvals === stub.approvals,
    }).toEqual({ project: PROJECT, client: true, approvals: true });
  });

  test("AC-3 the provider factory is called once and logs through the host's logger", async () => {
    const stub = stubKodaFactories();

    await open(kodaConfig());

    expect(stub.createKodaMemoryProviderStub).toHaveBeenCalledTimes(1);
    expect(providerInputOf(stub).logger === logger).toBe(true);
  });

  test("AC-4 the readNote handed to the provider resolves the note the mirror holds for a scope and slug", async () => {
    const stub = stubKodaFactories();
    const host = await open(kodaConfig());
    const store = createMemoryStore({ projectDir: host.dirs.projectDir, userDir: host.dirs.userDir, logger });
    await store.writeNote(NOTE);

    const readNote = providerInputOf(stub).readNote;

    expect(await readNote("project", NOTE.slug)).toEqual(NOTE);
  });

  test("AC-4 the readNote handed to the provider resolves null for a slug the mirror does not hold", async () => {
    const stub = stubKodaFactories();
    await open(kodaConfig());

    expect(await providerInputOf(stub).readNote("project", "absent")).toBeNull();
  });

  test("AC-5 the readDecisions handed to the provider resolves the mirror's decisions", async () => {
    const stub = stubKodaFactories();
    const host = await open(kodaConfig());
    const store = createMemoryStore({ projectDir: host.dirs.projectDir, userDir: host.dirs.userDir, logger });
    await store.writeDecisions([DECISION]);

    expect(await providerInputOf(stub).readDecisions()).toEqual([DECISION]);
  });

  test("AC-6 the host reports the koda provider's own id, koda:<project>", async () => {
    const host = await open(kodaConfig());

    expect(host.providerId).toBe("koda:rs-stock");
  });

  test("AC-7 a koda host composes neither an MCP pool nor a local provider", async () => {
    stubKodaFactories();
    const createMcpPool = mock((_input: Parameters<typeof _memoryHostDeps.createMcpPool>[0]) => {
      throw new Error("a koda host owns no MCP pool");
    });
    const createLocalMemoryProvider = mock(
      (_store: Parameters<typeof _memoryHostDeps.createLocalMemoryProvider>[0]) => {
        throw new Error("a koda host is not local");
      },
    );
    _memoryHostDeps.createMcpPool = createMcpPool;
    _memoryHostDeps.createLocalMemoryProvider = createLocalMemoryProvider;

    await open(kodaConfig());

    expect(createMcpPool).not.toHaveBeenCalled();
    expect(createLocalMemoryProvider).not.toHaveBeenCalled();
  });

  test("AC-8 a koda config with no project is refused at host creation", async () => {
    const creation = creationOf(makeNaxConfig({ memory: { provider: "koda", koda: { url: API, headers: HEADERS } } }));

    await expect(creation).rejects.toBeInstanceOf(NaxError);
    await expect(creation).rejects.toMatchObject({ code: "MEMORY_KODA_CONFIG_MISSING" });
  });

  test("AC-15 a koda config with no url is refused at host creation", async () => {
    const creation = creationOf(
      makeNaxConfig({ memory: { provider: "koda", koda: { project: PROJECT, headers: {} } } }),
    );

    await expect(creation).rejects.toBeInstanceOf(NaxError);
    await expect(creation).rejects.toMatchObject({ code: "MEMORY_KODA_CONFIG_MISSING" });
  });

  test("AC-9 a koda host closes, and a second close resolves too", async () => {
    const host = await open(kodaConfig());

    await expect(host.close?.()).resolves.toBeUndefined();
    await expect(host.close?.()).resolves.toBeUndefined();
  });

  test("AC-18 a local configuration still reports providerId local", async () => {
    const host = await open(makeNaxConfig());

    expect(host.providerId).toBe("local");
  });

  test("AC-18 a valid MCP configuration naming server om still reports mcp:om", async () => {
    const createMcpPool = mock((_input: Parameters<typeof _memoryHostDeps.createMcpPool>[0]) => ({
      listTools: async () => [],
      call: async () => ({ content: "", isError: false, bytesPreTruncation: 0 }),
      events: () => [],
      close: async () => {},
    }));
    const createMcpMemoryProvider = mock((_input: Parameters<typeof _memoryHostDeps.createMcpMemoryProvider>[0]) =>
      stubProvider("mcp:om"),
    );
    _memoryHostDeps.createMcpPool = createMcpPool;
    _memoryHostDeps.createMcpMemoryProvider = createMcpMemoryProvider;
    const config = makeNaxConfig({
      memory: { provider: "mcp", mcp: { server: "om" } },
      mcp: { servers: { om: omServer() } },
    });

    const host = await open(config);

    expect(host.providerId).toBe("mcp:om");
  });
});

describe("the @/memory barrel", () => {
  test("AC-14 re-exports the koda client, its status helper, the timeout, the approvals record and the provider", () => {
    expect(memoryBarrel.createKodaClient).toBe(createKodaClient);
    expect(memoryBarrel.kodaStatusOf).toBe(kodaStatusOf);
    expect(memoryBarrel.MEMORY_KODA_REQUEST_TIMEOUT_MS).toBe(MEMORY_KODA_REQUEST_TIMEOUT_MS);
    expect(memoryBarrel.createKodaApprovals).toBe(createKodaApprovals);
    expect(memoryBarrel.createKodaMemoryProvider).toBe(createKodaMemoryProvider);
    expect(memoryBarrel.MEMORY_KODA_PROVIDER_PREFIX).toBe(MEMORY_KODA_PROVIDER_PREFIX);
  });

  test("AC-14 the barrel's koda prefix is the one the provider id is spelled with", () => {
    expect(MEMORY_KODA_PROVIDER_PREFIX).toBe("koda:");
  });
});
