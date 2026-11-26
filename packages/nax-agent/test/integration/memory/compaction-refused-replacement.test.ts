/**
 * US-001: a merge's source retirements wait on the replacement, end to end.
 *
 * Everything here enters at the two public seams and there is no stub between them:
 * `applyMemoryCompaction` produces the queued writes (`@nathapp/nax-agent/internal`) and
 * `syncMemory` delivers them, which is the drain a real run reaches
 * (`@nathapp/nax-agent`). The provider is the shared scripted one, so what it was asked to
 * push is the whole record of what the provider would have received.
 *
 * The defect this file closes is a pair of writes that were queued as independent entries: a
 * merge into `budget-a` stages the merged note's `save` and then a `forget` for every source it
 * folded. A provider that refuses the save for good (another owner's slug, a body it will not
 * store) used to leave the mirror with two retired sources and the provider with no merged note
 * at all. Now the source forget names the save in `awaits`, and the drain refuses to send it
 * once that save has been refused.
 *
 * A plan whose merged body is blank is refused before anything is staged, because a provider
 * that answers a blank note with a 400 is exactly how a merge reached the drain with a
 * replacement nobody could store.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  createMemoryOutbox,
  createMemoryStore,
  type MemoryNote,
  type MemoryOutbox,
  type MemoryOutboxEntry,
  type MemoryPushResult,
  type MemoryStore,
  type MemorySyncResult,
  NaxError,
  syncMemory,
} from "@nathapp/nax-agent";
import { applyMemoryCompaction, type MemoryCompactionPlan } from "@nathapp/nax-agent/internal";
import {
  assertDefined,
  assertNaxError,
  type MemoryProviderMock,
  type MemoryProviderScript,
  makeFakeClock,
  makeLogger,
  makeMemoryProvider,
  withTempDir,
} from "#test/helpers/index";

/** The instant every injected clock in these tests reports. */
const STAMP = "2026-11-26T10:15:00.000Z";
/** The pid each sync claims as its own: never this process's, so a stale lock is taken over. */
const SYNC_PID = 6101;
/** The two notes the merge folds, and the slug it writes: the note that is already there. */
const MERGED_SLUG = "budget-a";
const SOURCE_SLUG = "budget-b";
/** The note a plan retires outright: no merge wrote a replacement for it. */
const RETIRED_SLUG = "stale-note";
/** The reason the plan's retire carries, and the one the drain records on a write it never sent. */
const RETIRE_REASON = "the loop it described was replaced";
const REFUSAL_MESSAGE = "the replacement is not this project's to write";
const NOT_SENT = `not sent: the replacement it waits on (${MERGED_SLUG}) was refused`;
/** What the refusing provider answers for a forget it did carry out. */
const ANSWER_DELETED: MemoryPushResult = { id: "mem_doomed", status: "deleted" };

/** A project note of the mirror, with overrides. */
function note(slug: string, overrides: Partial<MemoryNote> = {}): MemoryNote {
  return {
    id: `mem_${slug}`,
    slug,
    type: "project",
    scope: "project",
    description: `note ${slug}`,
    source: "nax-chat",
    updatedAt: "2026-11-02T08:11:00.000Z",
    status: "active",
    body: `Body of ${slug}.`,
    ...overrides,
  };
}

/** The mirror every case starts from: the pair to merge, and the note a plan may retire. */
function mirrorNotes(): MemoryNote[] {
  return [note(MERGED_SLUG), note(SOURCE_SLUG), note(RETIRED_SLUG)];
}

/** The plan the refused-replacement cases apply: a merge that keeps `budget-a`'s slug. */
function mergePlan(body = "Both budgets, folded into one note."): MemoryCompactionPlan {
  return {
    retire: [],
    merge: [
      {
        from: [MERGED_SLUG, SOURCE_SLUG],
        into: { slug: MERGED_SLUG, type: "project", description: "the budgets, folded into one", body },
      },
    ],
  };
}

/** The same plan, plus a retire that has no replacement behind it. */
function mergeAndRetirePlan(): MemoryCompactionPlan {
  const plan = mergePlan();
  return { ...plan, retire: [{ slug: RETIRED_SLUG, reason: RETIRE_REASON }] };
}

/** A provider that refuses a save for good and carries out a forget. */
function refusal(): NaxError {
  return new NaxError(REFUSAL_MESSAGE, "MEMORY_PUSH_REJECTED", { stage: "memory" });
}

/** Everything one case runs against, pointed at `<dir>/project`. */
interface Harness {
  readonly store: MemoryStore;
  readonly outbox: MemoryOutbox;
  readonly provider: MemoryProviderMock;
  /** Apply `plan` (or any override) to this mirror. */
  apply(plan: MemoryCompactionPlan): Promise<unknown>;
  /** The sync a real run reaches: step 3 delivers what the apply queued. */
  sync(): Promise<MemorySyncResult>;
}

/** A mirror holding {@link mirrorNotes}, the queue beside it, and the scripted provider. */
async function harness(dir: string, script: MemoryProviderScript = {}): Promise<Harness> {
  const logger = makeLogger();
  const store = createMemoryStore({ projectDir: join(dir, "project"), logger });
  for (const held of mirrorNotes()) await store.writeNote(held);
  const outbox = createMemoryOutbox({ dir: store.paths.outboxDir, now: () => new Date(STAMP) });
  const provider = makeMemoryProvider(script);
  return {
    store,
    outbox,
    provider,
    apply: (plan) =>
      applyMemoryCompaction({
        store,
        outbox,
        logger,
        plan,
        keepArchives: 5,
        provider: "local",
        model: "balanced",
        fillBefore: 0.9,
        now: () => new Date(STAMP),
        timers: makeFakeClock(),
      }),
    sync: () =>
      syncMemory({
        store,
        outbox,
        provider,
        logger,
        now: () => new Date(STAMP),
        pid: SYNC_PID,
        isAlive: () => false,
      }),
  };
}

/** The one queued entry of `kind` for `slug`; the test fails when the queue holds none or several. */
async function entryFor(
  outbox: MemoryOutbox,
  kind: MemoryOutboxEntry["kind"],
  slug: string,
): Promise<MemoryOutboxEntry> {
  const matching = (await outbox.list()).filter((entry) => entry.kind === kind && entry.slug === slug);
  expect(matching).toHaveLength(1);
  const [entry] = matching;
  assertDefined(entry, `the ${kind} entry for "${slug}"`);
  return entry;
}

/** The slugs the provider was asked to push, as `<kind>:<slug>`, in call order. */
function pushed(h: Harness): string[] {
  return h.provider.push.mock.calls.map(([request]) => `${request.kind}:${request.slug}`);
}

describe("applyMemoryCompaction: a merge's source retirements wait on its save", () => {
  test("AC-1: the forget for the folded source awaits the merged note's save", async () => {
    await withTempDir(async (dir) => {
      const h = await harness(dir);

      await h.apply(mergePlan());

      const save = await entryFor(h.outbox, "save", MERGED_SLUG);
      const forget = await entryFor(h.outbox, "forget", SOURCE_SLUG);
      expect(forget.awaits).toBe(save.clientId);
      // The save's client id is the merged note's own id: one id names the note and its write.
      expect(save.clientId).toBe(save.note?.id ?? "");
    });
  });

  test("AC-2: one apply gives the merge's source forget a dependency and the plan's retire none", async () => {
    await withTempDir(async (dir) => {
      const h = await harness(dir);

      await h.apply(mergeAndRetirePlan());

      const save = await entryFor(h.outbox, "save", MERGED_SLUG);
      const retire = await entryFor(h.outbox, "forget", RETIRED_SLUG);
      const folded = await entryFor(h.outbox, "forget", SOURCE_SLUG);
      expect(retire.reason).toBe(RETIRE_REASON);
      // A retire the plan stated has no replacement behind it: it is enqueued on its own, and the
      // merge that shares this apply must not lend it one. Both halves are asserted here because
      // "no dependency" alone is also true of an apply that gives no forget a dependency at all.
      expect(retire.awaits).toBeUndefined();
      expect(folded.awaits).toBe(save.clientId);
    });
  });
});

describe("a merge whose replacement the provider refuses", () => {
  test("AC-15: the sync sends only the merged note's save to the provider", async () => {
    await withTempDir(async (dir) => {
      const h = await harness(dir, { push: [refusal(), ANSWER_DELETED] });
      await h.apply(mergePlan());

      const result = await h.sync();

      // The refused save is pushed once; the source forget it holds back never is.
      expect(pushed(h)).toEqual([`save:${MERGED_SLUG}`]);
      expect(result).toMatchObject({ outcome: "synced", pushed: 0, rejected: 2 });
      expect(await entryFor(h.outbox, "forget", SOURCE_SLUG)).toMatchObject({ state: "rejected", reason: NOT_SENT });
    });
  });
});

describe("a merge whose replacement could not be stored at all", () => {
  test("AC-16: a whitespace-only merged body is refused before anything is written", async () => {
    await withTempDir(async (dir) => {
      const h = await harness(dir);

      const refusalOfPlan = await h.apply(mergePlan("   ")).catch((error: unknown) => error);

      assertNaxError(refusalOfPlan, "the apply's refusal");
      expect(refusalOfPlan).toMatchObject({
        code: "MEMORY_COMPACT_PLAN_INVALID",
        context: { reasons: [`merge target "${MERGED_SLUG}": body must not be blank`] },
      });
    });
  });

  test("AC-17: the refusal stages no write, so the outbox stays empty", async () => {
    await withTempDir(async (dir) => {
      const h = await harness(dir);

      await h.apply(mergePlan("   ")).catch(() => undefined);

      expect(await h.outbox.list()).toEqual([]);
      // The merge wrote no note either: the plan was refused, not half-applied.
      expect(await h.store.readNote("project", MERGED_SLUG)).toEqual(note(MERGED_SLUG));
    });
  });
});

describe("a merge whose replacement fails transiently", () => {
  test("AC-23: the sync stops at the save and reports the failure", async () => {
    await withTempDir(async (dir) => {
      const h = await harness(dir, { push: [new Error("connection reset by peer")] });
      await h.apply(mergePlan());

      const result = await h.sync();

      expect(pushed(h)).toEqual([`save:${MERGED_SLUG}`]);
      expect(result).toMatchObject({ outcome: "failed", pushed: 0, rejected: 0, error: "connection reset by peer" });
    });
  });

  test("AC-24: the source forgets stay queued for the next sync", async () => {
    await withTempDir(async (dir) => {
      const h = await harness(dir, { push: [new Error("connection reset by peer")] });
      await h.apply(mergePlan());
      const save = await entryFor(h.outbox, "save", MERGED_SLUG);

      await h.sync();

      expect(await entryFor(h.outbox, "forget", SOURCE_SLUG)).toMatchObject({
        state: "queued",
        awaits: save.clientId,
      });
      expect(await entryFor(h.outbox, "save", MERGED_SLUG)).toMatchObject({ state: "queued" });
    });
  });
});
