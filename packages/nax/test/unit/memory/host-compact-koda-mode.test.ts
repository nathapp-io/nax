/**
 * host-compact-koda-mode.test.ts — a host's compaction against the mode its provider decides.
 *
 * Covers US-006 AC-4..AC-14: an apply and an undo under a provider whose effective write mode
 * is `proposal`, a lookup that rejects — which propagates with no operation called and nothing
 * staged — the local provider as the control, and, last, the composed host, because `host.ts`
 * is where a provider is handed to the compaction rather than its id.
 *
 * Every refusal case builds the compaction over a real mirror and a real outbox in temporary
 * directories and stubs only the two compaction operations, so the files a refused call must
 * leave alone are the ones a surface would actually read. Nothing here imports the koda client
 * for the unit cases: what the compaction asks is `effectiveWriteModeOf(input.provider)`, so a
 * provider carrying that method is the fact under test rather than how koda is reached.
 */

import { afterEach, beforeEach, describe, expect, type Mock, mock, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  createLocalMemoryProvider,
  createMemoryOutbox,
  createMemoryStore,
  type MemoryNote,
  type MemoryOutbox,
  type MemoryProvider,
  type MemoryStore,
  type MemorySyncResult,
} from "@nathapp/nax-agent";
import {
  type MemoryCompactionApplyInput,
  type MemoryCompactionPlan,
  type MemoryCompactionResult,
  type MemoryUndoInput,
  type MemoryUndoResult,
  mirrorCoordinationDir,
} from "@nathapp/nax-agent/internal";
import { assertDefined, cleanupTempDir, type MockLogger, makeLogger, makeNaxConfig, makeTempDir } from "@test/helpers";
import { type MemoryConfig, memoryConfigOf, type NaxConfig } from "@/config";
import { NaxError } from "@/errors";
import { _memoryHostDeps, createMemoryHost, type MemoryHost } from "@/memory";
import { createHostCompaction, type HostCompaction, type HostCompactionInput } from "@/memory/host-compact";
import type { KodaClient } from "@/memory/koda-http";
import type { KodaMemoryProvider } from "@/memory/koda-provider";

/** The plan every apply case hands the compaction: one retire, no merges. */
const PLAN: MemoryCompactionPlan = {
  retire: [{ slug: "old-fact", reason: "superseded by the new budget" }],
  merge: [],
};

/** What an apply is given: the plan, the model tier and the fill measured before it. */
const APPLY_INPUT = { plan: PLAN, model: "balanced", fillBefore: 0.9 };

/** What a stubbed apply answers. */
const APPLIED: MemoryCompactionResult = {
  id: "20261125T101500Z-3fa2c1",
  retired: ["old-fact"],
  merged: [],
  notesBefore: 2,
  notesAfter: 1,
};

/** What a stubbed undo answers. */
const UNDONE: MemoryUndoResult = { id: APPLIED.id, restored: ["old-fact"], removed: [] };

/** The result a sync reports: these cases never deliver anything. */
const LOCKED: MemorySyncResult = { outcome: "locked", pushed: 0, rejected: 0, pulled: 0, skipped: 0 };

/** The memory config every compaction is composed with. */
const CONFIG: MemoryConfig = memoryConfigOf(makeNaxConfig({ memory: { compact: { keepArchives: 2 } } }));

/**
 * The failure a provider's write-mode lookup answers with: a `503`, so it is transient and the
 * outbox would retry the work rather than refuse it.
 */
const LOOKUP_FAILED = new NaxError(
  "[memory] koda GET projects/rs-stock/memory/write-mode answered 503: service unavailable",
  "MEMORY_KODA_HTTP",
  { stage: "memory", status: 503 },
);

/** The koda API root the composed host is configured with. */
const API = "https://k.example/api";
/** The koda project slug the composed host is configured with. */
const PROJECT = "rs-stock";

/** A mirror note with the given slug. */
function noteFor(slug: string): MemoryNote {
  return {
    id: slug,
    slug,
    type: "project",
    scope: "project",
    description: `about ${slug}`,
    source: "nax-chat",
    updatedAt: "2026-11-02T08:00:00Z",
    status: "active",
    body: `body of ${slug}`,
  };
}

/** The rejection a promise carries, as the error a refused call is expected to throw. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to reject");
}

/** The rejection a refused call carries, as the `NaxError` it must be. */
async function naxRejection(promise: Promise<unknown>): Promise<NaxError> {
  const caught = await rejection(promise);
  if (!(caught instanceof NaxError)) throw new Error(`expected a NaxError, got ${String(caught)}`);
  return caught;
}

/**
 * A koda-shaped provider: it answers the mode `answer` resolves or throws, as the real one does.
 *
 * The koda provider is the only one that decides a mode of its own, so an object carrying the
 * method is exactly the seam `effectiveWriteModeOf` looks for.
 */
function providerWithMode(
  answer: () => Promise<"direct" | "proposal">,
): MemoryProvider & { effectiveWriteMode(): Promise<"direct" | "proposal"> } {
  return {
    id: `koda:${PROJECT}`,
    pull: async () => ({ notes: [], done: true }),
    push: async (request) => ({ id: request.clientId, status: "active" }),
    reachable: async () => true,
    effectiveWriteMode: answer,
  } satisfies KodaMemoryProvider;
}

/** Every file under `dir`, by relative path and content: what a refused call must not change. */
function snapshotOf(dir: string): ReadonlyMap<string, string> {
  const files = new Map<string, string>();
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else files.set(relative(dir, path), readFileSync(path, "utf8"));
    }
  };
  if (existsSync(dir)) walk(dir);
  return files;
}

describe("host compaction against the provider's effective write mode", () => {
  let root: string;
  let logger: MockLogger;
  let store: MemoryStore;
  let outbox: MemoryOutbox;
  let applyStub: Mock<(input: MemoryCompactionApplyInput) => Promise<MemoryCompactionResult>>;
  let undoStub: Mock<(input: MemoryUndoInput) => Promise<MemoryUndoResult>>;

  /** The compaction under test, over this case's mirror, queue and provider. */
  function compactionOf(overrides: Partial<HostCompactionInput> = {}): HostCompaction {
    return createHostCompaction({
      store,
      outbox,
      logger,
      config: CONFIG,
      provider: createLocalMemoryProvider(store),
      writeMode: "direct",
      repoNotes: async () => [],
      sync: async () => LOCKED,
      operations: { applyMemoryCompaction: applyStub, undoMemoryCompaction: undoStub },
      ...overrides,
    });
  }

  /**
   * Replace the two operations with stubs that would change the mirror and the queue if they
   * were ever reached: what a test asserts is that these files are exactly as they were.
   */
  function stubWritingOperations(): void {
    applyStub = mock(async (_input: MemoryCompactionApplyInput) => {
      await store.writeNote(noteFor("compacted"));
      await outbox.enqueue({ kind: "forget", scope: "project", slug: "gone", writeMode: "direct", reason: "stale" });
      return APPLIED;
    });
    undoStub = mock(async (_input: MemoryUndoInput) => {
      await store.writeNote(noteFor("restored"));
      await outbox.enqueue({
        kind: "save",
        scope: "project",
        slug: "back",
        writeMode: "direct",
        note: noteFor("back"),
      });
      return UNDONE;
    });
  }

  /** The one apply call the operation received. */
  function applyCall(): MemoryCompactionApplyInput {
    const call = applyStub.mock.calls[0]?.[0];
    assertDefined(call, "the applyMemoryCompaction call");
    return call;
  }

  /** The mirror's own files and the queue's, as a refused call must find them again. */
  function filesOnDisk(): {
    readonly mirror: ReadonlyMap<string, string>;
    readonly outbox: ReadonlyMap<string, string>;
  } {
    return { mirror: snapshotOf(store.paths.projectDir), outbox: snapshotOf(store.paths.outboxDir) };
  }

  beforeEach(async () => {
    root = makeTempDir("nax-host-compact-mode-");
    logger = makeLogger();
    const projectDir = join(root, "project");
    const userDir = join(root, "user");
    store = createMemoryStore({
      projectDir,
      coordinationDir: mirrorCoordinationDir(projectDir),
      userDir,
      logger,
    });
    outbox = createMemoryOutbox({ dir: store.paths.outboxDir });
    applyStub = mock(async (_input: MemoryCompactionApplyInput) => APPLIED);
    undoStub = mock(async (_input: MemoryUndoInput) => UNDONE);
    await store.writeNote(noteFor("old-fact"));
    await outbox.enqueue({ kind: "forget", scope: "project", slug: "stale", writeMode: "direct", reason: "stale" });
  });

  afterEach(() => {
    cleanupTempDir(root);
  });

  test("AC-4 an effective proposal mode refuses the apply with MEMORY_COMPACT_UNSUPPORTED", async () => {
    const compaction = compactionOf({ provider: providerWithMode(async () => "proposal") });

    const error = await naxRejection(compaction.applyCompaction(APPLY_INPUT));

    expect(error.code).toBe("MEMORY_COMPACT_UNSUPPORTED");
  });

  test("AC-5 that refused apply never calls operations.applyMemoryCompaction", async () => {
    const compaction = compactionOf({ provider: providerWithMode(async () => "proposal") });

    await rejection(compaction.applyCompaction(APPLY_INPUT));

    expect(applyStub.mock.calls).toHaveLength(0);
  });

  test("AC-6 the same provider refuses the undo with MEMORY_COMPACT_UNSUPPORTED", async () => {
    const compaction = compactionOf({ provider: providerWithMode(async () => "proposal") });

    const error = await naxRejection(compaction.undoCompaction({ id: APPLIED.id }));

    expect(error.code).toBe("MEMORY_COMPACT_UNSUPPORTED");
  });

  test("AC-7 that refused undo never calls operations.undoMemoryCompaction", async () => {
    const compaction = compactionOf({ provider: providerWithMode(async () => "proposal") });

    await rejection(compaction.undoCompaction({ id: APPLIED.id }));

    expect(undoStub.mock.calls).toHaveLength(0);
  });

  test("AC-8 a rejecting lookup propagates the same error out of applyCompaction", async () => {
    const compaction = compactionOf({
      provider: providerWithMode(async () => {
        throw LOOKUP_FAILED;
      }),
    });

    expect(await rejection(compaction.applyCompaction(APPLY_INPUT))).toBe(LOOKUP_FAILED);
  });

  test("AC-9 a rejecting lookup during applyCompaction never calls operations.applyMemoryCompaction", async () => {
    const compaction = compactionOf({
      provider: providerWithMode(async () => {
        throw LOOKUP_FAILED;
      }),
    });

    await rejection(compaction.applyCompaction(APPLY_INPUT));

    expect(applyStub.mock.calls).toHaveLength(0);
  });

  test("AC-10 (control) the local provider, which decides no mode of its own, applies with itself as the label", async () => {
    const provider = createLocalMemoryProvider(store);

    await compactionOf({ provider }).applyCompaction(APPLY_INPUT);

    expect(applyStub.mock.calls).toHaveLength(1);
    expect(applyCall().provider).toBe(provider.id);
  });

  test("AC-10 (control) an effective mode of direct lets the apply through", async () => {
    await compactionOf({ provider: providerWithMode(async () => "direct") }).applyCompaction(APPLY_INPUT);

    expect(applyCall().provider).toBe(`koda:${PROJECT}`);
  });

  test("AC-12 a rejecting lookup propagates the same error out of undoCompaction", async () => {
    const compaction = compactionOf({
      provider: providerWithMode(async () => {
        throw LOOKUP_FAILED;
      }),
    });

    expect(await rejection(compaction.undoCompaction({ id: APPLIED.id }))).toBe(LOOKUP_FAILED);
  });

  test("AC-13 a rejected lookup before undoCompaction never calls operations.undoMemoryCompaction", async () => {
    const compaction = compactionOf({
      provider: providerWithMode(async () => {
        throw LOOKUP_FAILED;
      }),
    });

    await rejection(compaction.undoCompaction({ id: APPLIED.id }));

    expect(undoStub.mock.calls).toHaveLength(0);
  });

  test("AC-14 a failed lookup leaves the mirror and the outbox byte-for-byte unchanged", async () => {
    stubWritingOperations();
    const compaction = compactionOf({
      provider: providerWithMode(async () => {
        throw LOOKUP_FAILED;
      }),
    });
    const before = filesOnDisk();

    await rejection(compaction.applyCompaction(APPLY_INPUT));
    await rejection(compaction.undoCompaction({ id: APPLIED.id }));

    expect(filesOnDisk()).toEqual(before);
    expect(before.mirror.size).toBeGreaterThan(0);
    expect(before.outbox.size).toBeGreaterThan(0);
  });
});

describe("the composed host's compaction over a koda provider", () => {
  let globalDir: string;
  let repoRoot: string;
  let logger: MockLogger;
  let applyStub: Mock<(input: MemoryCompactionApplyInput) => Promise<MemoryCompactionResult>>;
  let savedGlobalEnv: string | undefined;
  let originalDeps: typeof _memoryHostDeps;

  /** The koda-backed config this host is opened over: koda decides the mode, not nax. */
  function kodaConfig(): NaxConfig {
    return makeNaxConfig({
      memory: { provider: "koda", koda: { url: API, project: PROJECT, headers: { Authorization: "Bearer k" } } },
    });
  }

  /** The koda client stub: it records the routes it is asked and answers `mode` on the probe. */
  function stubKodaClient(mode: string): { readonly client: KodaClient; readonly routes: string[] } {
    const routes: string[] = [];
    const client: KodaClient = {
      get: async (path) => {
        routes.push(`GET ${path}`);
        return path.endsWith("/memory/write-mode")
          ? { status: 200, data: { mode } }
          : { status: 200, data: { id: "p1" } };
      },
      post: async (path) => {
        routes.push(`POST ${path}`);
        return { status: 201, data: { id: "n1" } };
      },
    };
    return { client, routes };
  }

  /** The host under test, with the koda client stubbed and the two operations replaced. */
  async function openKodaHost(mode: string): Promise<{ host: MemoryHost; routes: readonly string[] }> {
    const stub = stubKodaClient(mode);
    _memoryHostDeps.createKodaClient = () => stub.client;
    const created = await createMemoryHost({
      config: kodaConfig(),
      repoRoot,
      source: "nax-chat",
      logger,
    });
    assertDefined(created, "the memory host");
    return { host: created, routes: stub.routes };
  }

  /** The host's `applyCompaction`, narrowed: a host composed here always sets it. */
  function applySeam(host: MemoryHost): NonNullable<MemoryHost["applyCompaction"]> {
    const seam = host.applyCompaction;
    assertDefined(seam, "host.applyCompaction");
    return seam;
  }

  beforeEach(() => {
    globalDir = makeTempDir("nax-host-compact-mode-global-");
    repoRoot = makeTempDir("nax-host-compact-mode-repo-");
    logger = makeLogger();
    savedGlobalEnv = process.env.NAX_GLOBAL_CONFIG_DIR;
    process.env.NAX_GLOBAL_CONFIG_DIR = globalDir;
    originalDeps = { ..._memoryHostDeps };
    applyStub = mock(async (_input: MemoryCompactionApplyInput) => APPLIED);
    _memoryHostDeps.applyMemoryCompaction = applyStub;
  });

  afterEach(() => {
    Object.assign(_memoryHostDeps, originalDeps);
    if (savedGlobalEnv === undefined) {
      delete process.env.NAX_GLOBAL_CONFIG_DIR;
    } else {
      process.env.NAX_GLOBAL_CONFIG_DIR = savedGlobalEnv;
    }
    cleanupTempDir(globalDir);
    cleanupTempDir(repoRoot);
  });

  test("AC-11 the host hands its koda provider to the compaction, so an effective proposal mode refuses the apply", async () => {
    const { host, routes } = await openKodaHost("proposal");
    // The host's own write mode is nax's, and it is direct: only the provider's mode refuses.
    expect(host.writeMode).toBe("direct");

    const error = await naxRejection(applySeam(host)(APPLY_INPUT));

    expect(error.code).toBe("MEMORY_COMPACT_UNSUPPORTED");
    expect(applyStub.mock.calls).toHaveLength(0);
    expect(routes).toContain(`GET projects/${PROJECT}/memory/write-mode`);
  });
});
