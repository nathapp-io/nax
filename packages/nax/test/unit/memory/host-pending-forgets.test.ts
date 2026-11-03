/**
 * host-pending-forgets.test.ts — the host's `forgetPendingKeys` and the index it feeds.
 *
 * The keys a forget still holds come from two places: the mirror's own pending-forget record
 * (feature 1's `pending-forgets.jsonl`, written when a proposal forget is answered) and the
 * outbox (a queued forget a sync has yet to deliver). Both cases build the host over a real
 * mirror directory — a temp project directory and a temp global root — and write the record
 * and the queue through the store and the outbox the host itself composes, so what is read
 * back is what those surfaces wrote rather than a fixture shaped like it.
 *
 * The third case is the same union reaching the index: a recorded forget alone is enough to
 * mark the note, which the outbox-only reading the host had before cannot do.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createMemoryOutbox,
  createMemoryStore,
  type MemoryNote,
  type MemoryScope,
  type MemoryStore,
} from "@nathapp/nax-agent";
import { assertDefined, cleanupTempDir, type MockLogger, makeLogger, makeNaxConfig, makeTempDir } from "@test/helpers";
import { createMemoryHost, type MemoryHost } from "@/memory";

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

describe("host pending forgets", () => {
  let globalDir: string;
  let repoRoot: string;
  let logger: MockLogger;
  let host: MemoryHost;
  let savedGlobalEnv: string | undefined;

  /** The mirror the host reads, built from the directories it resolved. */
  function mirror(): MemoryStore {
    return createMemoryStore({ projectDir: host.dirs.projectDir, userDir: host.dirs.userDir, logger });
  }

  /** Write one note into the mirror the host reads. */
  async function writeMirrorNote(note: MemoryNote): Promise<void> {
    await mirror().writeNote(note);
  }

  /** Record one pending forget, as a proposal forget the provider answered leaves it. */
  async function recordForget(scope: MemoryScope, slug: string): Promise<void> {
    await mirror().writePendingForgets([{ clientId: `cli-recorded-${slug}`, scope, slug, reason: "stale" }]);
  }

  /** Queue one forget, as a write this mirror has not yet delivered leaves it. */
  async function queueForget(scope: MemoryScope, slug: string): Promise<void> {
    const outbox = createMemoryOutbox({ dir: mirror().paths.outboxDir });
    await outbox.enqueue({ kind: "forget", scope, slug, writeMode: "direct", reason: "stale" });
  }

  /** The keys the host reports, asserting it sets the member a hand-built double need not. */
  async function pendingKeys(): Promise<ReadonlySet<string>> {
    const member = host.forgetPendingKeys;
    assertDefined(member, "the host's forgetPendingKeys");
    return await member();
  }

  /** The index line the rendering shows for one slug. */
  async function indexLineFor(slug: string): Promise<string | undefined> {
    const index = await host.renderIndex();
    return index.text.split("\n").find((line) => line.includes(`] ${slug} `));
  }

  beforeEach(() => {
    globalDir = makeTempDir("nax-host-pending-global-");
    repoRoot = makeTempDir("nax-host-pending-repo-");
    logger = makeLogger();
    savedGlobalEnv = process.env.NAX_GLOBAL_CONFIG_DIR;
    process.env.NAX_GLOBAL_CONFIG_DIR = globalDir;
  });

  afterEach(() => {
    if (savedGlobalEnv === undefined) {
      delete process.env.NAX_GLOBAL_CONFIG_DIR;
    } else {
      process.env.NAX_GLOBAL_CONFIG_DIR = savedGlobalEnv;
    }
    cleanupTempDir(globalDir);
    cleanupTempDir(repoRoot);
  });

  /** Open the host under test over the temp mirror. */
  async function openHost(): Promise<void> {
    const created = await createMemoryHost({ config: makeNaxConfig(), repoRoot, source: "nax-chat", logger });
    assertDefined(created, "the memory host");
    host = created;
  }

  test("AC-1: a recorded pending forget for project/a is a pending key", async () => {
    await openHost();
    await writeMirrorNote(noteFor("a"));
    await recordForget("project", "a");

    expect((await pendingKeys()).has("project/a")).toBe(true);
  });

  test("AC-2: a queued forget for project/q is a pending key alongside the recorded one", async () => {
    await openHost();
    await writeMirrorNote(noteFor("a"));
    await writeMirrorNote(noteFor("q"));
    await recordForget("project", "a");
    await queueForget("project", "q");

    const keys = await pendingKeys();

    expect({ recorded: keys.has("project/a"), queued: keys.has("project/q"), size: keys.size }).toEqual({
      recorded: true,
      queued: true,
      size: 2,
    });
  });

  test("AC-3: the index marks the active note a as forget pending from the record alone", async () => {
    await openHost();
    await writeMirrorNote(noteFor("a"));
    await recordForget("project", "a");

    const line = await indexLineFor("a");

    expect(line?.endsWith("(forget pending)")).toBe(true);
  });
});
