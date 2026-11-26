/**
 * host-compaction.test.ts — the compaction surface a composed host exposes.
 *
 * Covers AC-1..AC-11: the candidates the host lists, the apply and the undo it makes
 * through `_memoryHostDeps` (what each call carries, and the one sync it runs after),
 * the result that stands when that sync throws, and the refusal both members answer
 * under `memory.writeMode: "proposal"` — before any operation is reached.
 *
 * Every case composes the real host over a temp global directory and a temp
 * repository with the local provider, and stubs only the two compaction operations
 * and `syncMemory`. So what is asserted is the composition a surface gets: the
 * mirror and the queue the host resolved, the config it read, and the repository
 * notes it reserved — never a hand-built double of any of them.
 */

import { afterEach, beforeEach, describe, expect, type Mock, mock, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createMemoryOutbox,
  createMemoryStore,
  type MemoryNote,
  type MemoryOutbox,
  type MemoryStore,
  type MemorySyncResult,
} from "@nathapp/nax-agent";
import {
  type MemoryCompactionApplyInput,
  type MemoryCompactionPlan,
  type MemoryCompactionResult,
  type MemoryUndoInput,
  type MemoryUndoResult,
  memoryCompactionCandidates,
  mirrorCoordinationDir,
} from "@nathapp/nax-agent/internal";
import { assertDefined, cleanupTempDir, type MockLogger, makeLogger, makeNaxConfig, makeTempDir } from "@test/helpers";
import type { NaxConfig } from "@/config";
import { NaxError } from "@/errors";
import { _memoryHostDeps, createMemoryHost, type MemoryHost } from "@/memory";

/** The Design's example repo note, verbatim: a team note the host must reserve the slug of. */
const STAGING_DB_NOTE = `---
id: staging-db
slug: staging-db
type: project
scope: project
description: the staging database is shared; never reset it
source: human
updatedAt: 2026-11-02T08:00:00Z
status: active
---

Ask in #infra before running migrations against staging.
`;

/** A second repository note, so "every repository note's slug" is more than one. */
const RELEASE_NOTE = `---
id: release-train
slug: release-train
type: reference
scope: project
description: releases ship on Thursdays
source: human
updatedAt: 2026-11-03T08:00:00Z
status: active
---

Cut the branch on Wednesday.
`;

/** The plan every apply case hands the host: one retire, no merges. */
const PLAN: MemoryCompactionPlan = {
  retire: [{ slug: "old-fact", reason: "superseded by the new budget" }],
  merge: [],
};

/** The input AC-2 pins: the plan, the model tier and the fill measured before the apply. */
const APPLY_INPUT = { plan: PLAN, model: "balanced", fillBefore: 0.9 };

/** What a stubbed apply answers: the result a surface reports to the user. */
const APPLIED: MemoryCompactionResult = {
  id: "20261125T101500Z-3fa2c1",
  retired: ["old-fact"],
  merged: [],
  notesBefore: 2,
  notesAfter: 1,
};

/** The compaction AC-8 undoes. */
const UNDO_ID = APPLIED.id;

/** What a stubbed undo answers. */
const UNDONE: MemoryUndoResult = { id: UNDO_ID, restored: ["old-fact"], removed: [] };

/** The result a sync that found the mirror owned by another process reports. */
const LOCKED: MemorySyncResult = { outcome: "locked", pushed: 0, rejected: 0, pulled: 0, skipped: 0 };

/** A mirror note with the given slug, and whatever else the case needs. */
function noteFor(slug: string, overrides: Partial<MemoryNote> = {}): MemoryNote {
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
    ...overrides,
  };
}

/** The rejection a promise carries, as the `NaxError` a refused call is expected to throw. */
async function rejection(promise: Promise<unknown>): Promise<NaxError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof NaxError) return error;
    throw error;
  }
  throw new Error("expected the call to reject");
}

describe("host compaction", () => {
  let globalDir: string;
  let repoRoot: string;
  let logger: MockLogger;
  let host: MemoryHost;
  let applyStub: Mock<(input: MemoryCompactionApplyInput) => Promise<MemoryCompactionResult>>;
  let undoStub: Mock<(input: MemoryUndoInput) => Promise<MemoryUndoResult>>;
  let savedGlobalEnv: string | undefined;
  let originalDeps: typeof _memoryHostDeps;

  /** The mirror the host reads, built from the directories it resolved. */
  function mirror(): MemoryStore {
    return createMemoryStore({
      projectDir: host.dirs.projectDir,
      coordinationDir: mirrorCoordinationDir(host.dirs.projectDir),
      userDir: host.dirs.userDir,
      logger,
    });
  }

  /** The outbox the host reads, at the path the store gives it. */
  function outbox(): MemoryOutbox {
    return createMemoryOutbox({ dir: mirror().paths.outboxDir });
  }

  /** Commit one repository note under `<repoRoot>/.nax/memory`. */
  function writeRepoNote(name: string, content: string): void {
    mkdirSync(join(repoRoot, ".nax", "memory"), { recursive: true });
    writeFileSync(join(repoRoot, ".nax", "memory", name), content);
  }

  /** Open the host under test, with whatever config the case needs. */
  async function openHost(config: NaxConfig = makeNaxConfig()): Promise<void> {
    const created = await createMemoryHost({ config, repoRoot, source: "nax-chat", logger });
    assertDefined(created, "the memory host");
    host = created;
  }

  /** Replace the apply seam with a stub that answers `APPLIED`. */
  function stubApply(): void {
    applyStub = mock(async (_input: MemoryCompactionApplyInput) => APPLIED);
    _memoryHostDeps.applyMemoryCompaction = applyStub;
  }

  /** Replace the undo seam with a stub that answers `UNDONE`. */
  function stubUndo(): void {
    undoStub = mock(async (_input: MemoryUndoInput) => UNDONE);
    _memoryHostDeps.undoMemoryCompaction = undoStub;
  }

  /** The host's `applyCompaction`, narrowed: a host composed here always sets it. */
  function applySeam(): NonNullable<MemoryHost["applyCompaction"]> {
    const seam = host.applyCompaction;
    assertDefined(seam, "host.applyCompaction");
    return seam;
  }

  /** The host's `undoCompaction`, narrowed. */
  function undoSeam(): NonNullable<MemoryHost["undoCompaction"]> {
    const seam = host.undoCompaction;
    assertDefined(seam, "host.undoCompaction");
    return seam;
  }

  /** The one apply call the seam received. */
  function applyCall(): MemoryCompactionApplyInput {
    const call = applyStub.mock.calls[0]?.[0];
    assertDefined(call, "the applyMemoryCompaction call");
    return call;
  }

  /** The one undo call the seam received. */
  function undoCall(): MemoryUndoInput {
    const call = undoStub.mock.calls[0]?.[0];
    assertDefined(call, "the undoMemoryCompaction call");
    return call;
  }

  /** Count the syncs the host runs, answering a locked result. */
  function countSyncs(): { readonly calls: number } {
    const counter = { calls: 0 };
    _memoryHostDeps.syncMemory = async () => {
      counter.calls += 1;
      return LOCKED;
    };
    return counter;
  }

  beforeEach(() => {
    globalDir = makeTempDir("nax-host-compact-global-");
    repoRoot = makeTempDir("nax-host-compact-repo-");
    logger = makeLogger();
    savedGlobalEnv = process.env.NAX_GLOBAL_CONFIG_DIR;
    process.env.NAX_GLOBAL_CONFIG_DIR = globalDir;
    originalDeps = { ..._memoryHostDeps };
  });

  afterEach(() => {
    _memoryHostDeps.syncMemory = originalDeps.syncMemory;
    _memoryHostDeps.applyMemoryCompaction = originalDeps.applyMemoryCompaction;
    _memoryHostDeps.undoMemoryCompaction = originalDeps.undoMemoryCompaction;
    if (savedGlobalEnv === undefined) {
      delete process.env.NAX_GLOBAL_CONFIG_DIR;
    } else {
      process.env.NAX_GLOBAL_CONFIG_DIR = savedGlobalEnv;
    }
    cleanupTempDir(globalDir);
    cleanupTempDir(repoRoot);
  });

  test("AC-1 compactionCandidates resolves what memoryCompactionCandidates answers for its store and outbox", async () => {
    await openHost();
    await mirror().writeNote(noteFor("kept-note"));
    await mirror().writeNote(noteFor("a-standing-instruction", { type: "feedback" }));
    const candidates = host.compactionCandidates;
    assertDefined(candidates, "host.compactionCandidates");

    const listed = await candidates();

    expect(listed.map((note) => note.slug)).toEqual(["kept-note"]);
    expect(listed).toEqual(await memoryCompactionCandidates({ store: mirror(), outbox: outbox() }));
  });

  test("AC-2 applyCompaction calls the seam once with the host's store and outbox, the plan, model and fillBefore", async () => {
    await openHost();
    await mirror().writeNote(noteFor("old-fact"));
    await outbox().enqueue({ kind: "forget", scope: "project", slug: "gone", writeMode: "direct", reason: "stale" });
    stubApply();
    // The post-apply sync is stubbed so the queued entry is still there to identify the queue by.
    countSyncs();

    await applySeam()(APPLY_INPUT);

    expect(applyStub).toHaveBeenCalledTimes(1);
    const call = applyCall();
    expect({ plan: call.plan, model: call.model, fillBefore: call.fillBefore }).toEqual(APPLY_INPUT);
    expect(call.store.paths).toEqual(mirror().paths);
    expect((await call.outbox.list()).map((entry) => entry.slug)).toEqual(["gone"]);
  });

  test("AC-3 that call carries keepArchives from memory.compact and the host's providerId", async () => {
    await openHost(makeNaxConfig({ memory: { compact: { keepArchives: 2 } } }));
    stubApply();

    await applySeam()(APPLY_INPUT);

    expect({ keepArchives: applyCall().keepArchives, provider: applyCall().provider }).toEqual({
      keepArchives: 2,
      provider: host.providerId,
    });
  });

  test("AC-4 that call carries every repository note's slug as reservedSlugs", async () => {
    await openHost();
    writeRepoNote("staging-db.md", STAGING_DB_NOTE);
    writeRepoNote("release-train.md", RELEASE_NOTE);
    stubApply();

    await applySeam()(APPLY_INPUT);

    expect([...(applyCall().reservedSlugs ?? [])].sort()).toEqual(["release-train", "staging-db"]);
  });

  test("AC-5 syncs once after the apply resolves", async () => {
    await openHost();
    stubApply();
    const syncs = countSyncs();

    await applySeam()(APPLY_INPUT);

    expect(syncs.calls).toBe(1);
  });

  test("AC-6 resolves with the compaction result when that sync throws", async () => {
    await openHost();
    stubApply();
    _memoryHostDeps.syncMemory = async () => {
      throw new Error("koda is unreachable");
    };

    await expect(applySeam()(APPLY_INPUT)).resolves.toEqual(APPLIED);
  });

  test("AC-7 logs one warn when that sync throws", async () => {
    await openHost();
    stubApply();
    _memoryHostDeps.syncMemory = async () => {
      throw new Error("koda is unreachable");
    };

    await applySeam()(APPLY_INPUT);

    expect(logger.calls.filter((entry) => entry.level === "warn")).toHaveLength(1);
  });

  test("AC-8 undoCompaction calls the seam once with the host's store and outbox, the id and force", async () => {
    await openHost();
    await mirror().writeNote(noteFor("old-fact"));
    await outbox().enqueue({ kind: "forget", scope: "project", slug: "gone", writeMode: "direct", reason: "stale" });
    stubUndo();
    // The post-undo sync is stubbed so the queued entry is still there to identify the queue by.
    countSyncs();

    await undoSeam()({ id: UNDO_ID, force: true });

    expect(undoStub).toHaveBeenCalledTimes(1);
    const call = undoCall();
    expect({ id: call.id, force: call.force }).toEqual({ id: UNDO_ID, force: true });
    expect(call.store.paths).toEqual(mirror().paths);
    expect((await call.outbox.list()).map((entry) => entry.slug)).toEqual(["gone"]);
  });

  test("AC-9 syncs once after the undo resolves", async () => {
    await openHost();
    stubUndo();
    const syncs = countSyncs();

    await undoSeam()({ id: UNDO_ID, force: true });

    expect(syncs.calls).toBe(1);
  });

  test("AC-10 under memory.writeMode proposal applyCompaction rejects MEMORY_COMPACT_UNSUPPORTED without reaching the seam", async () => {
    await openHost(makeNaxConfig({ memory: { writeMode: "proposal" } }));
    stubApply();

    const error = await rejection(applySeam()(APPLY_INPUT));

    expect({ code: error.code, calls: applyStub.mock.calls.length }).toEqual({
      code: "MEMORY_COMPACT_UNSUPPORTED",
      calls: 0,
    });
    expect(error.message).toBe(
      'memory compaction is not available with memory.writeMode "proposal"; nothing was changed',
    );
  });

  test("AC-11 under memory.writeMode proposal undoCompaction rejects MEMORY_COMPACT_UNSUPPORTED without reaching the seam", async () => {
    await openHost(makeNaxConfig({ memory: { writeMode: "proposal" } }));
    stubUndo();

    const error = await rejection(undoSeam()({ id: UNDO_ID, force: true }));

    expect({ code: error.code, calls: undoStub.mock.calls.length }).toEqual({
      code: "MEMORY_COMPACT_UNSUPPORTED",
      calls: 0,
    });
  });
});
