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

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryNoteWrite, MemorySaveInput } from "@nathapp/nax-agent";
import { assertNaxError, cleanupTempDir, type MockLogger, makeLogger, makeNaxConfig, makeTempDir } from "@test/helpers";
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
    host = (await createMemoryHost({ config, repoRoot, source: "nax-chat", logger })) as MemoryHost;
  }

  beforeEach(() => {
    globalDir = makeTempDir("nax-host-writes-global-");
    repoRoot = makeTempDir("nax-host-writes-repo-");
    logger = makeLogger();
    savedGlobalEnv = process.env.NAX_GLOBAL_CONFIG_DIR;
    process.env.NAX_GLOBAL_CONFIG_DIR = globalDir;
    originalDeps = { ..._memoryHostDeps };
  });

  afterEach(() => {
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
});
