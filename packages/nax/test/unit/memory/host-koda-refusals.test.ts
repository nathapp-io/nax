/**
 * host.ts — the refusal report and the koda-held index keys (US-004).
 *
 * Covers AC-1, AC-4, AC-5, AC-6, AC-8, AC-9, AC-10, AC-13, AC-14 and AC-15 at the
 * `createMemoryHost` entry point. The composition cases stub the `_memoryHostDeps`
 * factories and assert what each one is handed; the status cases compose the real koda
 * guest over a stubbed mirror directory, so what is read back is the file the host wrote
 * and the lenient answer a broken one earns.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { createMemoryStore, type MemoryProvider, type MemoryStore } from "@nathapp/nax-agent";
import {
  assertDefined,
  cleanupTempDir,
  type MockLogger,
  makeFakeMemoryHost,
  makeLogger,
  makeNaxConfig,
  makeTempDir,
} from "@test/helpers";
import { type MemoryCliDeps, memoryStatusCommand } from "@/cli";
import type { NaxConfig } from "@/config";
import {
  _memoryHostDeps,
  createKodaApprovals,
  createMemoryHost,
  KODA_REFUSALS_FILE,
  type KodaApproval,
  type KodaApprovals,
  type KodaRefusal,
  type KodaRefusals,
  type MemoryDirs,
  type MemoryHost,
  type MemoryKodaRefusal,
  type MemoryStatus,
} from "@/memory";

/** The API root every koda config names, koda's global prefix included. */
const API = "https://k.example/api";
/** The koda project slug the config names. */
const PROJECT = "rs-stock";

/** The record of a forget koda is still holding for a project note. */
const FORGET_X: KodaApproval = { approvalId: "apr_x", kind: "forget", scope: "project", slug: "x", clientId: "c_x" };
/** The record of the same for a user note. */
const FORGET_U: KodaApproval = { approvalId: "apr_u", kind: "forget", scope: "user", slug: "u", clientId: "c_u" };
/** A save koda has not answered yet: a record with no kind, which holds no forget. */
const SAVE_Y: KodaApproval = { approvalId: "apr_y", scope: "project", slug: "y", clientId: "c_y" };

/** The koda-backed config every composition case opens its host over. */
function kodaConfig(): NaxConfig {
  return makeNaxConfig({
    memory: { provider: "koda", koda: { url: API, project: PROJECT, headers: { Authorization: "Bearer x" } } },
  });
}

/** A proposal record holding `entries`, as a koda project's file would after a `202`. */
function approvalsWith(entries: readonly KodaApproval[]): KodaApprovals {
  return { list: async () => entries, record: async () => {}, drop: async () => {} };
}

/** A refusal report holding `entries`, never written to. */
function refusalsWith(entries: readonly KodaRefusal[] = []): KodaRefusals {
  return { list: async () => entries, record: async () => {} };
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

/** One logged refusal, stamped now so it is inside the report window. */
function loggedRefusal(refusedAt = new Date().toISOString()): KodaRefusal {
  return { approvalId: "apr_x", kind: "forget", scope: "project", slug: "x", status: "rejected", refusedAt };
}

/** The status document AC-13 prints. */
const STATUS: MemoryStatus = {
  enabled: true,
  provider: `koda:${PROJECT}`,
  writeMode: "koda",
  projectDir: "/mem/projects/p",
  userDir: "/mem/user",
  lastPullAt: null,
  lastError: null,
  queued: 0,
  rejected: 0,
  rejectedEntries: [],
  kodaRefusals: [
    { kind: "forget", scope: "project", slug: "x", status: "rejected", refusedAt: "2026-11-14T05:00:00.000Z" },
  ],
  notes: { project: 1, user: 0, repo: 0 },
  repoSkipped: 0,
};

describe("a koda-backed host's held-forget source and refusal report", () => {
  let mirrorRoot: string;
  let dirs: MemoryDirs;
  let logger: MockLogger;
  let originalDeps: typeof _memoryHostDeps;
  /** Every input the store factory was handed, in call order. */
  let storeInputs: Parameters<typeof createMemoryStore>[0][];
  /** Every store the factory built, in the same order. */
  let stores: MemoryStore[];

  beforeEach(() => {
    mirrorRoot = makeTempDir("nax-host-koda-refusals-");
    dirs = {
      root: join(mirrorRoot, "memory"),
      projectDir: join(mirrorRoot, "memory", "projects", "p"),
      userDir: join(mirrorRoot, "memory", "user"),
    };
    logger = makeLogger();
    storeInputs = [];
    stores = [];
    originalDeps = { ..._memoryHostDeps };
    _memoryHostDeps.memoryDirs = async () => dirs;
  });

  afterEach(() => {
    Object.assign(_memoryHostDeps, originalDeps);
    cleanupTempDir(mirrorRoot);
  });

  async function open(config: NaxConfig = kodaConfig()): Promise<MemoryHost> {
    const host = await createMemoryHost({ config, repoRoot: mirrorRoot, source: "nax-chat", logger });
    assertDefined(host, "the memory host");
    return host;
  }

  /** Replace the store factory with a pass-through that records what the host gave it. */
  function captureStore(): void {
    _memoryHostDeps.createMemoryStore = (input: Parameters<typeof createMemoryStore>[0]) => {
      const store = createMemoryStore(input);
      storeInputs.push(input);
      stores.push(store);
      return store;
    };
  }

  /** The input the store factory was handed; fails when it was never called. */
  function storeInput(): Parameters<typeof createMemoryStore>[0] {
    const input = storeInputs[0];
    assertDefined(input, "the store factory input");
    return input;
  }

  /** The store the factory built; fails when it was never called. */
  function createdStore(): MemoryStore {
    const store = stores[0];
    assertDefined(store, "the store the factory built");
    return store;
  }

  /** Stub the koda factories the composition cases assert on; the client never dials out. */
  function stubKodaFactories(approvals: KodaApprovals, refusals: KodaRefusals, provider = stubProvider("koda:stub")) {
    const createKodaApprovalsStub = mock(
      (_input: Parameters<typeof _memoryHostDeps.createKodaApprovals>[0]) => approvals,
    );
    const createKodaRefusalsStub = mock((_input: Parameters<typeof _memoryHostDeps.createKodaRefusals>[0]) => refusals);
    const createKodaMemoryProviderStub = mock(
      (_input: Parameters<typeof _memoryHostDeps.createKodaMemoryProvider>[0]) => provider,
    );
    _memoryHostDeps.createKodaClient = () => ({
      get: async () => ({ status: 200, data: {} }),
      post: async () => ({ status: 201, data: {} }),
    });
    _memoryHostDeps.createKodaApprovals = createKodaApprovalsStub;
    _memoryHostDeps.createKodaRefusals = createKodaRefusalsStub;
    _memoryHostDeps.createKodaMemoryProvider = createKodaMemoryProviderStub;
    return { approvals, refusals, provider, createKodaRefusalsStub, createKodaMemoryProviderStub };
  }

  /** Write the refusal report the host will read, as `body` spells it. */
  async function writeRefusalsFile(body: string): Promise<void> {
    await Bun.write(join(dirs.projectDir, KODA_REFUSALS_FILE), body);
  }

  test("AC-1 the store's held-forget source holds a koda forget record's slug and not a save's", async () => {
    stubKodaFactories(approvalsWith([FORGET_X, SAVE_Y]), refusalsWith());
    captureStore();

    await open();

    const source = storeInput().heldForgets;
    assertDefined(source, "the store's heldForgets source");
    const keys = await source();
    expect([keys.has("project/x"), keys.has("project/y")]).toEqual([true, false]);
  });

  test("AC-4 a local-backed host passes the store factory no held-forget source at all", async () => {
    captureStore();

    const host = await open(makeNaxConfig());

    expect(host.providerId).toBe("local");
    expect(storeInput().heldForgets).toBeUndefined();
  });

  test("AC-5 a koda-backed host builds one refusal report in its own project mirror directory", async () => {
    const stub = stubKodaFactories(approvalsWith([]), refusalsWith());

    const host = await open();

    expect(stub.createKodaRefusalsStub.mock.calls).toEqual([[{ dir: host.dirs.projectDir, logger }]]);
    expect(host.dirs).toEqual(dirs);
  });

  test("AC-6 the store the refusal factory returned is the provider's refusals source", async () => {
    const stub = stubKodaFactories(approvalsWith([]), refusalsWith());

    await open();

    const input = stub.createKodaMemoryProviderStub.mock.calls[0]?.[0];
    assertDefined(input, "the provider factory input");
    expect(input.refusals === stub.refusals).toBe(true);
  });

  test("AC-8 a koda host whose refusal report is empty answers no refusals", async () => {
    await writeRefusalsFile(JSON.stringify({ version: 1, refusals: [] }));
    const host = await open();

    expect((await host.status()).kodaRefusals).toEqual([]);
  });

  test("AC-9 a local-backed host answers no kodaRefusals field", async () => {
    const host = await open(makeNaxConfig());

    expect("kodaRefusals" in (await host.status())).toBe(false);
  });

  test("AC-10 two status reads both report the one logged refusal", async () => {
    const refusal = loggedRefusal();
    await writeRefusalsFile(JSON.stringify({ version: 1, refusals: [refusal] }));
    const host = await open();

    const first = await host.status();
    const second = await host.status();

    const expected: readonly MemoryKodaRefusal[] = [
      { kind: "forget", scope: "project", slug: "x", status: "rejected", refusedAt: refusal.refusedAt },
    ];
    expect({ first: first.kodaRefusals, second: second.kodaRefusals }).toEqual({ first: expected, second: expected });
  });

  test("AC-13 nax memory status --json carries the koda refusals the host reports", async () => {
    const out: string[] = [];
    const host: MemoryHost = { ...makeFakeMemoryHost("status only"), status: async () => STATUS };
    const deps: MemoryCliDeps = {
      log: (msg) => out.push(msg),
      logErr: () => {},
      exit: () => {},
      findProjectDir: () => null,
      loadConfig: async () => kodaConfig(),
      createMemoryHost: async () => host,
      readFile: async () => "",
    };

    const code = await memoryStatusCommand({ dir: mirrorRoot, json: true }, deps);

    assertDefined(out[0], "the status document");
    expect({ code, kodaRefusals: kodaRefusalsOf(out[0]) }).toEqual({ code: 0, kodaRefusals: STATUS.kodaRefusals });
  });

  test("AC-14 forgetPendingKeys and the store's own read answer the same koda forget keys", async () => {
    const seed = createKodaApprovals({ dir: dirs.projectDir, logger });
    await seed.record(FORGET_X);
    await seed.record(FORGET_U);
    captureStore();
    const host = await open();

    const readHeldForgetKeys = createdStore().readHeldForgetKeys;
    assertDefined(readHeldForgetKeys, "the store's readHeldForgetKeys");
    const forgetPendingKeys = host.forgetPendingKeys;
    assertDefined(forgetPendingKeys, "the host's forgetPendingKeys");
    const storeKeys = await readHeldForgetKeys();
    const hostKeys = await forgetPendingKeys();

    expect({ store: [...storeKeys].sort(), host: [...hostKeys].sort() }).toEqual({
      store: ["project/x", "user/u"],
      host: ["project/x", "user/u"],
    });
  });

  test("AC-15 a refusal report that is not JSON reads as no refusals instead of throwing", async () => {
    await writeRefusalsFile("not json at all");
    const host = await open();

    expect((await host.status()).kodaRefusals).toEqual([]);
  });
});

/** The `kodaRefusals` field of a `--json` status document, or `undefined` when it names none. */
function kodaRefusalsOf(document: string): unknown {
  const parsed: unknown = JSON.parse(document);
  if (typeof parsed !== "object" || parsed === null || !("kodaRefusals" in parsed)) return undefined;
  return parsed.kodaRefusals;
}
