/**
 * host-writes.test.ts — the memory host's save, forget and approve.
 *
 * Covers US-007 AC-1..AC-18: a save that lands in force and one held as a
 * proposal, the note a save leaves for the next read and the source it records, a
 * refused save that writes nothing, a save over a slug only the repository holds
 * (the mirror's note then shadows it), a forget that retires a note and one the
 * repository owns — refused as `MEMORY_NOTE_READ_ONLY` with the repository file
 * left exactly as it was — the `MEMORY_NOTE_NOT_FOUND` answers, an approval that
 * puts a pending note in force, and the `writeMode` / `source` the composed save
 * hands feature 1's operation.
 *
 * Everything runs against the real store, outbox and local provider under a temp
 * global directory, so the note a save leaves is read back through `getNote` on
 * the same host rather than asserted against a mock. Only the operation AC-17 and
 * AC-18 name is stubbed, and only in the cases that assert its input.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryNoteWrite, MemoryOutbox, MemorySaveInput } from "@nathapp/nax-agent";
import {
  assertDefined,
  assertNaxError,
  cleanupTempDir,
  type MockLogger,
  makeLogger,
  makeNaxConfig,
  makeTempDir,
} from "@test/helpers";
import { _memoryHostDeps, createMemoryHost, type MemoryHost } from "@/memory";

/** The Design's example repo note, verbatim. */
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

/** The write AC-1 saves, and every later case reuses. */
const REPLAY_BUDGET: MemoryNoteWrite = {
  slug: "replay-budget",
  type: "project",
  scope: "project",
  description: "replay budget",
  body: "2048 MiB",
};

/** A user-scoped save: the same shape under the other scope. */
const STAGING_CREDS: MemoryNoteWrite = {
  slug: "staging-creds",
  type: "user",
  scope: "user",
  description: "the staging password lives in vault",
  body: "vault: secret/staging",
};

/** A body carrying an AWS access key: the validator refuses it. */
const LEAKED_KEY: MemoryNoteWrite = {
  slug: "leaked-key",
  type: "project",
  scope: "project",
  description: "the key to use",
  body: "export AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP",
};

describe("host writes", () => {
  let globalDir: string;
  let repoRoot: string;
  let logger: MockLogger;
  let host: MemoryHost;
  let savedGlobalEnv: string | undefined;
  let originalDeps: typeof _memoryHostDeps;
  /** Every outbox the hosts opened under this case were built over, so a case can interleave one. */
  let outboxes: MemoryOutbox[];

  /** The directory the repository's team notes are committed to. */
  function repoMemoryDir(): string {
    return join(repoRoot, ".nax", "memory");
  }

  /** The repository note file AC-11 and AC-12 name. */
  function stagingDbPath(): string {
    return join(repoMemoryDir(), "staging-db.md");
  }

  /** Commit one repo note file under `.nax/memory`. */
  function writeRepoNote(name: string, content: string): void {
    mkdirSync(repoMemoryDir(), { recursive: true });
    writeFileSync(join(repoMemoryDir(), name), content);
  }

  /** Open the host under test, with whatever config the case needs. */
  async function openHost(config = makeNaxConfig()): Promise<void> {
    const created = await createMemoryHost({ config, repoRoot, source: "nax-chat", logger });
    assertDefined(created, "the memory host");
    host = created;
  }

  /**
   * The outbox the host under test was built over.
   *
   * A recovery runs against the queue file, so the one interesting interleaving — another process
   * changing an entry between the listing and the write — needs the queue the host itself holds.
   * The seam hands every outbox it builds back here.
   */
  function hostOutbox(): MemoryOutbox {
    const [outbox] = outboxes;
    assertDefined(outbox, "the host's outbox");
    return outbox;
  }

  beforeEach(() => {
    globalDir = makeTempDir("nax-host-writes-global-");
    repoRoot = makeTempDir("nax-host-writes-repo-");
    logger = makeLogger();
    savedGlobalEnv = process.env.NAX_GLOBAL_CONFIG_DIR;
    process.env.NAX_GLOBAL_CONFIG_DIR = globalDir;
    originalDeps = { ..._memoryHostDeps };
    outboxes = [];
    _memoryHostDeps.createMemoryOutbox = (seam) => {
      const outbox = originalDeps.createMemoryOutbox(seam);
      outboxes.push(outbox);
      return outbox;
    };
  });

  afterEach(() => {
    _memoryHostDeps.createMemoryOutbox = originalDeps.createMemoryOutbox;
    _memoryHostDeps.saveMemoryNote = originalDeps.saveMemoryNote;
    _memoryHostDeps.forgetMemoryNote = originalDeps.forgetMemoryNote;
    _memoryHostDeps.approveMemoryNote = originalDeps.approveMemoryNote;
    if (savedGlobalEnv === undefined) {
      delete process.env.NAX_GLOBAL_CONFIG_DIR;
    } else {
      process.env.NAX_GLOBAL_CONFIG_DIR = savedGlobalEnv;
    }
    cleanupTempDir(globalDir);
    cleanupTempDir(repoRoot);
  });

  describe("save", () => {
    test("stores a direct note in force and reports it delivered", async () => {
      await openHost();

      const result = await host.save(REPLAY_BUDGET);

      expect(result).toEqual({ slug: "replay-budget", status: "active", delivered: true });
    });

    test("records the host's source on the note it saved", async () => {
      await openHost();

      await host.save(REPLAY_BUDGET);

      expect((await host.getNote("project", "replay-budget"))?.source).toBe("nax-chat");
    });

    test("holds a save pending under the proposal write mode", async () => {
      await openHost(makeNaxConfig({ memory: { writeMode: "proposal" } }));

      const result = await host.save(REPLAY_BUDGET);

      expect(result.status).toBe("pending");
    });

    test("refuses a body that carries a secret", async () => {
      await openHost();

      const caught = await host.save(LEAKED_KEY).catch((error: unknown) => error);

      assertNaxError(caught, "host.save rejection");
      expect(caught.code).toBe("MEMORY_WRITE_REFUSED");
    });

    test("leaves no note behind for a refused save", async () => {
      await openHost();

      await host.save(LEAKED_KEY).catch(() => null);

      expect(await host.getNote("project", "leaked-key")).toBeNull();
    });

    test("saves a user note the user scope lists", async () => {
      await openHost();

      await host.save(STAGING_CREDS);

      expect((await host.notes("user")).map((note) => note.slug)).toEqual(["staging-creds"]);
    });

    test("lets a saved note shadow the repository's note of the same slug", async () => {
      await openHost();
      writeRepoNote("staging-db.md", STAGING_DB_NOTE);

      await host.save({
        ...REPLAY_BUDGET,
        slug: "staging-db",
        description: "staging database notes",
        body: "2048 MiB",
      });

      expect((await host.getNote("project", "staging-db"))?.source).toBe("nax-chat");
    });

    test("hands saveMemoryNote the host's write mode", async () => {
      await openHost(makeNaxConfig({ memory: { writeMode: "proposal" } }));
      const calls: MemorySaveInput[] = [];
      _memoryHostDeps.saveMemoryNote = async (input) => {
        calls.push(input);
        return { slug: input.write.slug, status: "pending", delivered: false };
      };

      await host.save(REPLAY_BUDGET);

      expect(calls.map((call) => call.writeMode)).toEqual([host.writeMode]);
    });

    test("hands saveMemoryNote the host's source", async () => {
      await openHost();
      const sources: string[] = [];
      _memoryHostDeps.saveMemoryNote = async (input) => {
        sources.push(input.source);
        return { slug: input.write.slug, status: "active", delivered: false };
      };

      await host.save(REPLAY_BUDGET);

      expect(sources).toEqual(["nax-chat"]);
    });
  });

  describe("forget", () => {
    test("retires a direct note and reports it deleted", async () => {
      await openHost();
      await host.save(REPLAY_BUDGET);

      const result = await host.forget({ scope: "project", slug: "replay-budget", reason: "stale" });

      expect(result.status).toBe("deleted");
    });

    test("leaves no note for the slug it retired", async () => {
      await openHost();
      await host.save(REPLAY_BUDGET);

      await host.forget({ scope: "project", slug: "replay-budget", reason: "stale" });

      expect(await host.getNote("project", "replay-budget")).toBeNull();
    });

    test("refuses to forget a note only the repository holds", async () => {
      await openHost();
      writeRepoNote("staging-db.md", STAGING_DB_NOTE);

      const caught = await host.forget({ scope: "project", slug: "staging-db", reason: "stale" }).catch((e) => e);

      assertNaxError(caught, "host.forget rejection");
      expect(caught.code).toBe("MEMORY_NOTE_READ_ONLY");
    });

    test("names the repository file to edit in that refusal", async () => {
      await openHost();
      writeRepoNote("staging-db.md", STAGING_DB_NOTE);

      const caught = await host.forget({ scope: "project", slug: "staging-db", reason: "stale" }).catch((e) => e);

      assertNaxError(caught, "host.forget rejection");
      expect(caught.message).toContain(".nax/memory/staging-db.md");
    });

    test("leaves the repository note file as it was after that refusal", async () => {
      await openHost();
      writeRepoNote("staging-db.md", STAGING_DB_NOTE);

      await host.forget({ scope: "project", slug: "staging-db", reason: "stale" }).catch(() => null);

      expect(await Bun.file(stagingDbPath()).text()).toBe(STAGING_DB_NOTE);
    });

    test("answers a slug no scope holds with a not-found refusal", async () => {
      await openHost();

      const caught = await host.forget({ scope: "project", slug: "absent", reason: "stale" }).catch((e) => e);

      assertNaxError(caught, "host.forget rejection");
      expect(caught.code).toBe("MEMORY_NOTE_NOT_FOUND");
    });
  });

  describe("approve", () => {
    test("puts a pending note in force", async () => {
      await openHost(makeNaxConfig({ memory: { writeMode: "proposal" } }));
      await host.save(REPLAY_BUDGET);

      const approved = await host.approve({ scope: "project", slug: "replay-budget" });

      expect(approved.status).toBe("active");
    });

    test("refuses to approve a note only the repository holds", async () => {
      await openHost();
      writeRepoNote("staging-db.md", STAGING_DB_NOTE);

      const caught = await host.approve({ scope: "project", slug: "staging-db" }).catch((e) => e);

      assertNaxError(caught, "host.approve rejection");
      expect(caught.code).toBe("MEMORY_NOTE_READ_ONLY");
    });

    test("answers a slug the mirror does not hold with a not-found refusal", async () => {
      await openHost();

      const caught = await host.approve({ scope: "project", slug: "absent" }).catch((e) => e);

      assertNaxError(caught, "host.approve rejection");
      expect(caught.code).toBe("MEMORY_NOTE_NOT_FOUND");
    });
  });

  describe("recovery", () => {
    /** The client id the uncertain entry below is keyed by. */
    const UNCERTAIN_CLIENT = "c_uncertain_replay_budget";
    /** The source a merge folds into `REPLAY_BUDGET`, and the retirement that waits on its save. */
    const FOLDED_SLUG = "replay-budget-v1";
    const RETIRED_CLIENT = "c_retire_replay_budget_v1";
    /** Why a non-replayable write is held: the answer every "delivery unknown" line prints. */
    const UNKNOWN_REASON = "delivery unknown: socket closed; not retried";

    /**
     * Leave the note's entry in the outbox as one whose dispatch never came back, through the
     * real outbox: the save path is stubbed, because only a provider that may not repeat a write
     * can produce that state, and this suite runs against the local one.
     */
    function leaveUncertainEntry(): void {
      _memoryHostDeps.saveMemoryNote = async (input) => {
        await input.outbox.enqueue({
          kind: "save",
          clientId: UNCERTAIN_CLIENT,
          scope: REPLAY_BUDGET.scope,
          slug: REPLAY_BUDGET.slug,
          writeMode: "direct",
          note: {
            id: UNCERTAIN_CLIENT,
            slug: REPLAY_BUDGET.slug,
            type: REPLAY_BUDGET.type,
            scope: REPLAY_BUDGET.scope,
            description: REPLAY_BUDGET.description,
            source: input.source,
            updatedAt: "2026-11-28T00:00:00.000Z",
            status: "active",
            body: REPLAY_BUDGET.body,
          },
        });
        await input.outbox.markUncertain(UNCERTAIN_CLIENT, UNKNOWN_REASON);
        return {
          slug: REPLAY_BUDGET.slug,
          status: "active",
          delivered: false,
          pending: {
            delivery: "unknown",
            clientId: UNCERTAIN_CLIENT,
            reason: UNKNOWN_REASON,
          },
        };
      };
    }

    /** The host's requeue, which every recovery case needs and `createMemoryHost` always sets. */
    function requeueOf(): NonNullable<MemoryHost["requeue"]> {
      const requeue = host.requeue;
      assertDefined(requeue, "host.requeue");
      return requeue;
    }

    /** The host's discard, on the same terms. */
    function discardOf(): NonNullable<MemoryHost["discard"]> {
      const discard = host.discard;
      assertDefined(discard, "host.discard");
      return discard;
    }

    test("blocks a later save of the note while its uncertain entry is held", async () => {
      await openHost();
      leaveUncertainEntry();
      await host.save(REPLAY_BUDGET);
      // The real save path again: the entry's key is held, so this write queues behind it.
      _memoryHostDeps.saveMemoryNote = originalDeps.saveMemoryNote;

      const blocked = await host.save(REPLAY_BUDGET);

      expect(blocked.delivered).toBe(false);
      expect(blocked.pending?.delivery).toBe("queued");
    });

    test("leaves an uncertain entry in place and names it when the duplicate risk is unacknowledged", async () => {
      await openHost();
      leaveUncertainEntry();
      await host.save(REPLAY_BUDGET);

      const result = await requeueOf()({ clientId: UNCERTAIN_CLIENT });

      expect(result).toEqual({ moved: 0, heldBack: [UNCERTAIN_CLIENT] });
    });

    test("requeues the uncertain entry once the duplicate risk is accepted, and the sync delivers it", async () => {
      await openHost();
      leaveUncertainEntry();
      await host.save(REPLAY_BUDGET);

      const result = await requeueOf()({ clientId: UNCERTAIN_CLIENT }, { allowDuplicate: true });
      const sync = await host.sync();

      expect(result).toEqual({ moved: 1, heldBack: [] });
      expect(sync.pushed).toBe(1);
    });

    test("requeues an uncertain entry named by its note as well as by its client id", async () => {
      await openHost();
      leaveUncertainEntry();
      await host.save(REPLAY_BUDGET);

      const byNote = await requeueOf()({ scope: "project", slug: "replay-budget" }, { allowDuplicate: true });

      expect(byNote).toEqual({ moved: 1, heldBack: [] });
    });

    test("requeues a rejected entry without asking for the duplicate risk", async () => {
      await openHost();
      _memoryHostDeps.saveMemoryNote = async (input) => {
        await input.outbox.enqueue({
          kind: "save",
          clientId: "c_rejected",
          scope: "project",
          slug: "replay-budget",
          writeMode: "direct",
        });
        await input.outbox.markRejected("c_rejected", "quota exceeded");
        return { slug: "replay-budget", status: "active", delivered: false };
      };
      await host.save(REPLAY_BUDGET);

      const result = await requeueOf()("all");

      expect(result).toEqual({ moved: 1, heldBack: [] });
    });

    test("discards an uncertain entry and lets the next save of that note through", async () => {
      await openHost();
      leaveUncertainEntry();
      await host.save(REPLAY_BUDGET);
      _memoryHostDeps.saveMemoryNote = originalDeps.saveMemoryNote;

      const discarded = await discardOf()({ clientId: UNCERTAIN_CLIENT });
      const saved = await host.save(REPLAY_BUDGET);

      expect(discarded).toEqual({ moved: 1, heldBack: [] });
      expect(saved.delivered).toBe(true);
    });

    test("answers nothing to discard once the uncertain entry is gone", async () => {
      await openHost();
      leaveUncertainEntry();
      await host.save(REPLAY_BUDGET);
      await discardOf()({ clientId: UNCERTAIN_CLIENT });

      expect(await discardOf()({ clientId: UNCERTAIN_CLIENT })).toEqual({ moved: 0, heldBack: [] });
    });

    test("leaves a queued write alone: it is still on its way", async () => {
      await openHost();
      _memoryHostDeps.saveMemoryNote = async (input) => {
        await input.outbox.enqueue({
          kind: "save",
          clientId: "c_queued",
          scope: "project",
          slug: "replay-budget",
          writeMode: "direct",
        });
        return {
          slug: "replay-budget",
          status: "active",
          delivered: false,
          pending: { delivery: "queued", clientId: "c_queued" },
        };
      };
      await host.save(REPLAY_BUDGET);

      expect(await requeueOf()("all")).toEqual({ moved: 0, heldBack: [] });
      expect(await discardOf()("all")).toEqual({ moved: 0, heldBack: [] });
    });

    test("[B1] holds back an entry a sync made uncertain after the recovery listed it", async () => {
      await openHost();
      _memoryHostDeps.saveMemoryNote = async (input) => {
        await input.outbox.enqueue({
          kind: "save",
          clientId: UNCERTAIN_CLIENT,
          scope: "project",
          slug: REPLAY_BUDGET.slug,
          writeMode: "direct",
        });
        await input.outbox.markRejected(UNCERTAIN_CLIENT, "quota exceeded");
        return { slug: REPLAY_BUDGET.slug, status: "active", delivered: false };
      };
      await host.save(REPLAY_BUDGET);
      // The window the race lives in: the entry was `rejected` when the recovery listed it, and a
      // sync dispatched it before the requeue got to the file. The listing is a snapshot, so the
      // decision has to be re-made against the entry itself.
      const outbox = hostOutbox();
      const listed = outbox.list.bind(outbox);
      spyOn(outbox, "list").mockImplementation(async () => {
        const snapshot = await listed();
        await outbox.markUncertain(UNCERTAIN_CLIENT, UNKNOWN_REASON);
        return snapshot;
      });

      const result = await requeueOf()({ clientId: UNCERTAIN_CLIENT });

      expect(result).toEqual({ moved: 0, heldBack: [UNCERTAIN_CLIENT] });
      expect(await outbox.held(UNCERTAIN_CLIENT)).toMatchObject({ state: "uncertain" });
    });

    test("[B5] refuses the source retirements a discarded replacement was folded into", async () => {
      await openHost();
      // The source a merge folded is live in the mirror, so a retirement sent on a guess shows.
      await host.save({ ...REPLAY_BUDGET, slug: FOLDED_SLUG });
      _memoryHostDeps.saveMemoryNote = async (input) => {
        await input.outbox.enqueue({
          kind: "save",
          clientId: UNCERTAIN_CLIENT,
          scope: "project",
          slug: REPLAY_BUDGET.slug,
          writeMode: "direct",
        });
        await input.outbox.markUncertain(UNCERTAIN_CLIENT, UNKNOWN_REASON);
        await input.outbox.enqueue({
          kind: "forget",
          clientId: RETIRED_CLIENT,
          scope: "project",
          slug: FOLDED_SLUG,
          writeMode: "direct",
          reason: `merged into ${REPLAY_BUDGET.slug}`,
          awaits: UNCERTAIN_CLIENT,
        });
        return {
          slug: REPLAY_BUDGET.slug,
          status: "active",
          delivered: false,
          pending: { delivery: "unknown", clientId: UNCERTAIN_CLIENT, reason: UNKNOWN_REASON },
        };
      };
      await host.save(REPLAY_BUDGET);

      const discarded = await discardOf()({ clientId: UNCERTAIN_CLIENT });
      _memoryHostDeps.saveMemoryNote = originalDeps.saveMemoryNote;
      const sync = await host.sync();

      expect(discarded.moved).toBe(1);
      // Nothing proved the replacement was ever written, so its source must stay where it is.
      expect(sync.pushed).toBe(0);
      expect(await host.getNote("project", FOLDED_SLUG)).not.toBeNull();
      expect(discarded.refused).toEqual([RETIRED_CLIENT]);
    });
    test("[B5] refuses the retirement under --all too, and leaves it for a later discard", async () => {
      await openHost();
      await host.save({ ...REPLAY_BUDGET, slug: FOLDED_SLUG });
      _memoryHostDeps.saveMemoryNote = async (input) => {
        await input.outbox.enqueue({
          kind: "save",
          clientId: UNCERTAIN_CLIENT,
          scope: "project",
          slug: REPLAY_BUDGET.slug,
          writeMode: "direct",
        });
        await input.outbox.markUncertain(UNCERTAIN_CLIENT, UNKNOWN_REASON);
        await input.outbox.enqueue({
          kind: "forget",
          clientId: RETIRED_CLIENT,
          scope: "project",
          slug: FOLDED_SLUG,
          writeMode: "direct",
          reason: `merged into ${REPLAY_BUDGET.slug}`,
          awaits: UNCERTAIN_CLIENT,
        });
        return {
          slug: REPLAY_BUDGET.slug,
          status: "active",
          delivered: false,
          pending: { delivery: "unknown", clientId: UNCERTAIN_CLIENT, reason: UNKNOWN_REASON },
        };
      };
      await host.save(REPLAY_BUDGET);

      const discarded = await discardOf()("all");

      // The held save goes; the retirement waiting on it was queued, and a queued write is never
      // dropped — so it is refused, named, and left for the second discard to take.
      expect(discarded).toEqual({ moved: 1, heldBack: [], refused: [RETIRED_CLIENT] });
      expect(await discardOf()("all")).toEqual({ moved: 1, heldBack: [] });
      expect(await hostOutbox().list()).toEqual([]);
    });
  });
});
