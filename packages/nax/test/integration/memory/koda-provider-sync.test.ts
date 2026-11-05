/**
 * koda-provider-sync.test.ts — US-005 AC-23 and AC-24: what `syncMemory` makes of the
 * koda provider's save answers.
 *
 * The provider here is the real one, over a real `createKodaClient` whose `fetch` seam
 * is stubbed; the mirror, the outbox, the lock and `sync.json` are real too, in a
 * temporary directory. So the classification the unit file pins request by request is
 * asserted here at the seam the drain actually reads: a permanent refusal marks the
 * entry rejected and the drain carries on to the next one, and every transient failure
 * leaves the entry queued, stops the drain and records the error in `sync.json`. A contract
 * mismatch that answers every forget badly (#2791) never parks one (#2793).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  createMemoryOutbox,
  createMemoryStore,
  MEMORY_PUSH_MAX_BAD_RESPONSES,
  type MemoryNote,
  type MemoryOutbox,
  type MemoryProvider,
  type MemoryStore,
  type MemorySyncResult,
  syncMemory,
} from "@nathapp/nax-agent";
import { assertDefined, cleanupTempDir, type MockLogger, makeLogger, makeTempDir } from "@test/helpers";
import { createKodaApprovals } from "@/memory/koda-approvals";
import { _kodaClientDeps, createKodaClient } from "@/memory/koda-http";
import { createKodaMemoryProvider } from "@/memory/koda-provider";

/** The instant every injected clock reports. */
const STAMP = "2026-11-12T10:15:00.000Z";
/** The API root the client is built from, koda's global prefix included. */
const API = "https://k.example/api";
/** The koda project slug the provider is composed for. */
const PROJECT = "rs-stock";
/** The koda project id `GET projects/rs-stock` answers with. */
const PROJECT_ID = "p1";
/** How long one request may run: short, so the never-settling answer rejects promptly. */
const CLIENT_TIMEOUT_MS = 50;
/** The two slugs the drain cases queue, in outbox order. */
const FIRST_SLUG = "replay-budget";
const SECOND_SLUG = "export-window";

/** One recorded request, as the stubbed transport sees it. */
interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

let calls: FetchCall[] = [];
let originalFetch: typeof _kodaClientDeps.fetch;

/** Replace the fetch seam with `answer`, recording every call it receives. */
function stubFetch(answer: (call: FetchCall) => Response | Promise<Response>): void {
  _kodaClientDeps.fetch = async (input, init) => {
    const call: FetchCall = { url: input, init };
    calls.push(call);
    return await answer(call);
  };
}

/** A koda envelope answer. */
function jsonAnswer(body: unknown, status = 200, statusText = ""): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Route the transport: the probe says the agent may write directly, the project lookup
 * answers the id, the export feed answers an empty finished page, and every `POST memory`
 * is handed to `save`.
 */
function stubKoda(save: (call: FetchCall) => Response | Promise<Response>): void {
  stubFetch(async (call) => {
    if (call.init.method === "POST") return await save(call);
    if (call.url.endsWith(`/projects/${PROJECT}/memory/write-mode`))
      return jsonAnswer({ ret: 0, data: { mode: "direct" } });
    // A drain that finishes reaches the pull, so the export feed answers the empty page that
    // ends it: these cases are about what the drain made of a save.
    if (call.url.includes("/memory/export"))
      return jsonAnswer({ ret: 0, data: { items: [], nextCursor: null, hasMore: false } });
    return jsonAnswer({ ret: 0, data: { id: PROJECT_ID } });
  });
}

/** The note one queued save carries. */
function noteFor(slug: string): MemoryNote {
  return {
    id: slug,
    slug,
    type: "project",
    scope: "project",
    description: `about ${slug}`,
    source: "nax-chat",
    updatedAt: STAMP,
    status: "active",
    body: `body of ${slug}`,
  };
}

/** The whole stack one case runs against: a real mirror, queue, provider and sync. */
interface Harness {
  readonly store: MemoryStore;
  readonly outbox: MemoryOutbox;
  readonly provider: MemoryProvider;
  readonly logger: MockLogger;
  /** Queue one save, the way a surface that already took the write queues it. */
  queueSave(slug: string, clientId: string): Promise<void>;
  /** Run one sync against this harness's pieces. */
  sync(): Promise<MemorySyncResult>;
}

function harness(dir: string): Harness {
  const logger = makeLogger();
  const projectDir = join(dir, "project");
  const store = createMemoryStore({ projectDir, logger });
  const outbox = createMemoryOutbox({ dir: store.paths.outboxDir, now: () => new Date(STAMP) });
  const provider = createKodaMemoryProvider({
    client: createKodaClient({ url: API, headers: { Authorization: "Bearer k" }, timeoutMs: CLIENT_TIMEOUT_MS }),
    project: PROJECT,
    approvals: createKodaApprovals({ dir: projectDir, logger }),
    readNote: (scope, slug) => store.readNote(scope, slug),
    readDecisions: () => store.readDecisions(),
    logger,
  });
  return {
    store,
    outbox,
    provider,
    logger,
    queueSave: async (slug, clientId) => {
      await outbox.enqueue({
        kind: "save",
        clientId,
        scope: "project",
        slug,
        writeMode: "direct",
        note: noteFor(slug),
      });
    },
    sync: () => syncMemory({ store, outbox, provider, logger, now: () => new Date(STAMP) }),
  };
}

/** The `[clientId, state]` rows the queue holds, in outbox order. */
async function queued(outbox: MemoryOutbox): Promise<readonly (readonly [string, string])[]> {
  return (await outbox.list()).map((entry) => [entry.clientId, entry.state] as const);
}

describe("syncMemory over the koda provider", () => {
  let dir: string;
  let koda: Harness;

  beforeEach(() => {
    originalFetch = _kodaClientDeps.fetch;
    calls = [];
    dir = makeTempDir("nax-koda-sync-");
    koda = harness(dir);
  });

  afterEach(() => {
    _kodaClientDeps.fetch = originalFetch;
    cleanupTempDir(dir);
  });

  test.each([400, 403, 409, 413, 422])(
    "a save answered %d is marked rejected and the drain delivers the next one (AC-23)",
    async (status) => {
      let posts = 0;
      stubKoda(() => {
        posts += 1;
        return posts === 1
          ? jsonAnswer({ ret: -2, message: "koda will not take this" }, status)
          : jsonAnswer({ ret: 0, data: { id: "k7" } }, 201);
      });
      await koda.queueSave(FIRST_SLUG, "c1");
      await koda.queueSave(SECOND_SLUG, "c2");

      const result = await koda.sync();

      expect(result).toMatchObject({ outcome: "synced", pushed: 1, rejected: 1 });
      expect(result.error).toBeUndefined();
      expect(await queued(koda.outbox)).toEqual([["c1", "rejected"]]);
      expect((await koda.store.readNote("project", SECOND_SLUG))?.id).toBe("k7");
    },
  );

  test.each([
    ["a 401", (): Response => jsonAnswer({ ret: -1, message: "bad key" }, 401)],
    ["a 404", (): Response => jsonAnswer({ ret: -1, message: "no such project" }, 404)],
    ["a 408", (): Response => jsonAnswer({ ret: -1, message: "request timeout" }, 408)],
    ["a 429", (): Response => jsonAnswer({ ret: -1, message: "slow down" }, 429)],
    ["a 500", (): Response => jsonAnswer({ ret: -1, message: "boom" }, 500)],
    ["a 503", (): Response => jsonAnswer({ ret: -1, message: "unavailable" }, 503)],
    ["an answer that never arrives", (): Promise<Response> => new Promise<Response>(() => {})],
    ["an unreachable host", (): Promise<Response> => Promise.reject(new TypeError("connection refused"))],
    ["a body that is not JSON", (): Response => new Response("not json", { status: 201, statusText: "Created" })],
  ])("a save answered with %s keeps its entry queued and records the error (AC-24)", async (_label, answer) => {
    stubKoda(() => answer());
    await koda.queueSave(FIRST_SLUG, "c1");

    const result = await koda.sync();

    expect(result.outcome).toBe("failed");
    const failure = result.error;
    assertDefined(failure, "the run's recorded error");
    expect(await queued(koda.outbox)).toEqual([["c1", "queued"]]);
    expect((await koda.store.readSyncState()).lastError).toBe(failure);
  });

  test("a lookup contract mismatch answers every forget badly, and no forget is ever parked (#2791, #2793)", async () => {
    // The shape koda answered before #2791 was fixed: `items`, not `records`. Every forget's
    // lookup is a bad response, so the proof write fails too and nothing may park.
    stubFetch(async (call) => {
      if (call.url.endsWith(`/projects/${PROJECT}/memory/write-mode`))
        return jsonAnswer({ ret: 0, data: { mode: "direct" } });
      if (call.url.includes("/memory/export"))
        return jsonAnswer({ ret: 0, data: { items: [], nextCursor: null, hasMore: false } });
      if (call.url.includes(`/projects/${PROJECT}/memory?`))
        return jsonAnswer({ ret: 0, data: { items: [], hasNext: false } });
      return jsonAnswer({ ret: 0, data: { id: PROJECT_ID } });
    });
    for (const [slug, clientId] of [
      [FIRST_SLUG, "f1"],
      [SECOND_SLUG, "f2"],
    ] as const) {
      await koda.outbox.enqueue({
        kind: "forget",
        clientId,
        scope: "project",
        slug,
        writeMode: "direct",
        reason: "stale",
      });
    }

    const runs = MEMORY_PUSH_MAX_BAD_RESPONSES + 2;
    for (let run = 0; run < runs; run += 1) {
      const result = await koda.sync();
      expect(result.outcome).toBe("failed");
      expect(result.parked).toBeUndefined();
    }

    expect(await queued(koda.outbox)).toEqual([
      ["f1", "queued"],
      ["f2", "queued"],
    ]);
    // The provider answered, so every run still pulled the export feed.
    expect(calls.filter((call) => call.url.includes("/memory/export")).length).toBeGreaterThanOrEqual(runs);
  });
});
