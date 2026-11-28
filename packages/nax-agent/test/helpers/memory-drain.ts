import { join } from "node:path";
import {
  createMemoryOutbox,
  createMemoryStore,
  type MemoryNote,
  type MemoryOutbox,
  type MemoryOutboxEntry,
  type MemoryPushResult,
  type MemoryStore,
  NaxError,
} from "@nathapp/nax-agent";
import type { MemorySyncInput } from "#src/memory/index";
import { type DrainResult, drainOutbox, type MemoryDrainInput } from "#src/memory/sync-drain";
import {
  assertDefined,
  type MemoryProviderMock,
  type MemoryProviderScript,
  type MockLogger,
  makeLogger,
  makeMemoryProvider,
} from "#test/helpers/index";

/** The instant every injected clock reports. */
const DRAIN_STAMP = "2026-11-26T09:20:00.000Z";
/** The pid each sync claims as its own: never this process's, so a stale lock is taken over. */
const DRAIN_SYNC_PID = 5151;
/** The replacement a merge writes and the source it folds: the pair every case is about. */
const DRAIN_MERGED_SLUG = "budget-a";
const DRAIN_SOURCE_SLUG = "budget-b";
/** The client ids the two queued writes take, so `awaits` can name one before it exists on disk. */
const DRAIN_SAVE_ID = "client-save";
const DRAIN_FORGET_ID = "client-forget";
/** What a provider that took the save answers, and what it answers for a forget it carried out. */
const DRAIN_ANSWER_ACTIVE: MemoryPushResult = { id: "mem_remote_1", status: "active" };
const DRAIN_ANSWER_DELETED: MemoryPushResult = { id: "mem_doomed", status: "deleted" };
/** The rejection reason a refused replacement is recorded with. */
const DRAIN_REFUSAL_MESSAGE = "the replacement is not this project's to write";
/** The message a bad response carries: an answer that arrived but cannot be used. */
const DRAIN_BAD_MESSAGE = '[memory] koda POST memory answered a save for "budget-a" without an id';
/** The reason the drain records on a forget it never sent. */
const DRAIN_NOT_SENT = `not sent: the replacement it waits on (${DRAIN_MERGED_SLUG}) was refused`;

/** A project note of the mirror, with overrides. */
function memoryDrainNote(slug: string, overrides: Partial<MemoryNote> = {}): MemoryNote {
  return {
    id: `local-${slug}`,
    slug,
    type: "project",
    scope: "project",
    description: `note ${slug}`,
    source: "nax-chat",
    updatedAt: DRAIN_STAMP,
    status: "active",
    body: `Body of ${slug}.`,
    ...overrides,
  };
}

/** A `save` write request for `saved`, keyed by `clientId`. */
function memoryDrainSaveRequest(saved: MemoryNote, clientId: string): Parameters<MemoryOutbox["enqueue"]>[0] {
  return { kind: "save", clientId, scope: "project", slug: saved.slug, writeMode: "direct", note: saved };
}

/** A `forget` write request, waiting on `awaits` when the test gives one. */
function memoryDrainForgetRequest(
  slug: string,
  clientId: string,
  awaits?: string,
): Parameters<MemoryOutbox["enqueue"]>[0] {
  return {
    kind: "forget",
    clientId,
    scope: "project",
    slug,
    writeMode: "direct",
    reason: `merged into ${DRAIN_MERGED_SLUG}`,
    ...(awaits === undefined ? {} : { awaits }),
  };
}

/** A provider's answer a permanent refusal is thrown as. */
function memoryDrainRefusal(): NaxError {
  return new NaxError(DRAIN_REFUSAL_MESSAGE, "MEMORY_PUSH_REJECTED", { stage: "memory" });
}

/** A provider's answer a bad response is thrown as: it arrived, and it cannot be used. */
function memoryDrainBadResponse(): NaxError {
  return new NaxError(DRAIN_BAD_MESSAGE, "MEMORY_KODA_BAD_RESPONSE", { stage: "memory", status: 200 });
}

/** The pieces one drain runs against, all pointed at `<dir>/project`. */
interface MemoryDrainHarness {
  readonly store: MemoryStore;
  readonly outbox: MemoryOutbox;
  readonly provider: MemoryProviderMock;
  readonly logger: MockLogger;
  /** The sync's input: this harness's pieces plus any per-test override. */
  input(overrides?: Partial<MemorySyncInput>): MemorySyncInput;
}

function makeMemoryDrainHarness(dir: string, script: MemoryProviderScript = {}): MemoryDrainHarness {
  const logger = makeLogger();
  const store = createMemoryStore({ projectDir: join(dir, "project"), logger });
  const outbox = createMemoryOutbox({ dir: store.paths.outboxDir, now: () => new Date(DRAIN_STAMP) });
  const provider = makeMemoryProvider(script);
  return {
    store,
    outbox,
    provider,
    logger,
    input: (overrides = {}) => ({
      store,
      outbox,
      provider,
      logger,
      now: () => new Date(DRAIN_STAMP),
      pid: DRAIN_SYNC_PID,
      // A lock nobody's pid proves live is a stale one: this run takes it over.
      isAlive: () => false,
      ...overrides,
    }),
  };
}

/** Step 3 alone, against this harness: a pull that follows it cannot mask what the drain did. */
function memoryDrainDrain(h: MemoryDrainHarness, overrides: Partial<MemoryDrainInput> = {}): Promise<DrainResult> {
  return drainOutbox({ store: h.store, outbox: h.outbox, provider: h.provider, logger: h.logger, ...overrides });
}

/** The slugs the provider was asked to push, as `<kind>:<slug>`, in call order. */
function memoryDrainPushed(h: MemoryDrainHarness): string[] {
  return h.provider.push.mock.calls.map(([request]) => `${request.kind}:${request.slug}`);
}

/** The request the provider was asked to push at `index`, which the test asserts reached it. */
function memoryDrainPushedAt(h: MemoryDrainHarness, index: number): Parameters<MemoryProviderMock["push"]>[0] {
  const call = h.provider.push.mock.calls[index];
  assertDefined(call, `the provider's push call ${index}`);
  return call[0];
}

/** The one entry the outbox holds under `clientId`. */
async function memoryDrainEntryOf(outbox: MemoryOutbox, clientId: string): Promise<MemoryOutboxEntry> {
  const held = (await outbox.list()).find((entry) => entry.clientId === clientId);
  assertDefined(held, `the outbox entry "${clientId}"`);
  return held;
}

/**
 * The fixture the refused-replacement cases share: a queued save for the merged note and the
 * source forget that waits on it, with a provider that refuses the save for good.
 */
async function memoryDrainRefusedReplacement(dir: string): Promise<MemoryDrainHarness> {
  const h = makeMemoryDrainHarness(dir, { push: [memoryDrainRefusal(), DRAIN_ANSWER_DELETED] });
  await h.store.writeNote(memoryDrainNote(DRAIN_MERGED_SLUG));
  await h.outbox.enqueue(memoryDrainSaveRequest(memoryDrainNote(DRAIN_MERGED_SLUG), DRAIN_SAVE_ID));
  await h.outbox.enqueue(memoryDrainForgetRequest(DRAIN_SOURCE_SLUG, DRAIN_FORGET_ID, DRAIN_SAVE_ID));
  return h;
}

export {
  DRAIN_ANSWER_ACTIVE,
  DRAIN_ANSWER_DELETED,
  DRAIN_BAD_MESSAGE,
  DRAIN_FORGET_ID,
  DRAIN_MERGED_SLUG,
  DRAIN_NOT_SENT,
  DRAIN_REFUSAL_MESSAGE,
  DRAIN_SAVE_ID,
  DRAIN_SOURCE_SLUG,
  DRAIN_STAMP,
  DRAIN_SYNC_PID,
  type MemoryDrainHarness,
  makeMemoryDrainHarness,
  memoryDrainBadResponse,
  memoryDrainDrain,
  memoryDrainEntryOf,
  memoryDrainForgetRequest,
  memoryDrainNote,
  memoryDrainPushed,
  memoryDrainPushedAt,
  memoryDrainRefusal,
  memoryDrainRefusedReplacement,
  memoryDrainSaveRequest,
};
