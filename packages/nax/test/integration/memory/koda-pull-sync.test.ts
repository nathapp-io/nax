/**
 * koda-pull-sync.test.ts — US-007 AC-16 and AC-17: what `syncMemory` makes of the
 * koda provider's export pages.
 *
 * The provider is the real one, over a real `createKodaClient` whose `fetch` seam is
 * stubbed; the mirror, the queue, the lock and `sync.json` are real, in a temporary
 * directory. So the reconciliation the unit file pins row by row is asserted here at
 * the seam the sync loop reads it through: a page's stale rejection does not delete the
 * successor the same page carries, and a page the pull cannot read leaves the cursor
 * where the last good page checkpointed it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  createMemoryOutbox,
  createMemoryStore,
  type MemoryNote,
  type MemoryOutbox,
  type MemoryProvider,
  type MemoryStore,
  type MemorySyncResult,
  syncMemory,
} from "@nathapp/nax-agent";
import { cleanupTempDir, type MockLogger, makeLogger, makeTempDir } from "@test/helpers";
import { createKodaApprovals } from "@/memory/koda-approvals";
import { _kodaClientDeps, createKodaClient } from "@/memory/koda-http";
import { createKodaMemoryProvider } from "@/memory/koda-provider";

/** The instant every injected clock and row reports. */
const STAMP = "2026-11-12T10:15:00.000Z";
/** The API root the client is built from, koda's global prefix included. */
const API = "https://k.example/api";
/** The koda project slug the provider is composed for. */
const PROJECT = "rs-stock";
/** The koda project id `GET projects/rs-stock` answers with. */
const PROJECT_ID = "p1";
/** How long one request may run. */
const CLIENT_TIMEOUT_MS = 50;
/** The slug both cases pull. */
const SLUG = "a";

/** One recorded request, as the stubbed transport sees it. */
interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

/** One koda NOTE row for {@link SLUG}, with the fields a case cares about overridden. */
function row(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    kind: "NOTE",
    scope: "project",
    subject: SLUG,
    predicate: "project",
    object: `body of ${id}`,
    description: `about ${id}`,
    status: "active",
    updatedAt: STAMP,
    sourceType: "nax-chat",
    ...over,
  };
}

/** The note the mirror already holds for {@link SLUG}. */
function mirrorNote(id: string): MemoryNote {
  return {
    id,
    slug: SLUG,
    type: "project",
    scope: "project",
    description: `about ${id}`,
    body: `body of ${id}`,
    updatedAt: STAMP,
    source: "nax-chat",
    status: "active",
  };
}

/** The whole stack one case runs against: a real mirror, queue, provider and sync. */
interface Harness {
  readonly store: MemoryStore;
  readonly outbox: MemoryOutbox;
  readonly provider: MemoryProvider;
  readonly logger: MockLogger;
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
    sync: () => syncMemory({ store, outbox, provider, logger, now: () => new Date(STAMP) }),
  };
}

describe("syncMemory over the koda provider's export pages", () => {
  let calls: FetchCall[] = [];
  let originalFetch: typeof _kodaClientDeps.fetch;
  let dir: string;
  let koda: Harness;

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

  /** The export answer carrying `data` as its payload. */
  function exportAnswer(data: unknown): Response {
    return jsonAnswer({ ret: 0, data });
  }

  /** Route the probe to a mode that lets the agent write, and everything else to `export`. */
  function stubKoda(exported: () => Response): void {
    stubFetch((call) => {
      if (call.url.includes("/memory/export")) return exported();
      if (call.url.endsWith("/memory/write-mode")) return jsonAnswer({ ret: 0, data: { mode: "direct" } });
      return jsonAnswer({ ret: 0, data: { id: PROJECT_ID } });
    });
  }

  beforeEach(() => {
    originalFetch = _kodaClientDeps.fetch;
    calls = [];
    dir = makeTempDir("nax-koda-pull-");
    koda = harness(dir);
  });

  afterEach(() => {
    _kodaClientDeps.fetch = originalFetch;
    cleanupTempDir(dir);
  });

  test("a page carrying a slug's active successor and its stale rejection leaves the mirror on the successor (AC-16)", async () => {
    await koda.store.writeNote(mirrorNote("k0"));
    stubKoda(() =>
      exportAnswer({ items: [row("k1"), row("k0", { status: "rejected" })], nextCursor: null, hasMore: false }),
    );

    const result = await koda.sync();

    expect(result.outcome).toBe("synced");
    expect(result.pulled).toBe(1);
    expect((await koda.store.readNote("project", SLUG))?.id).toBe("k1");
  });

  test.each([
    ["an items that is not an array", { items: "rows", nextCursor: null, hasMore: false }],
    ["a hasMore that is not a boolean", { items: [], nextCursor: null, hasMore: "false" }],
  ] as const)("a page with %s leaves the cursor at the last checkpointed page (AC-17)", async (_label, badPage) => {
    let exports = 0;
    stubKoda(() => {
      exports += 1;
      return exports === 1 ? exportAnswer({ items: [], nextCursor: "n1", hasMore: true }) : exportAnswer(badPage);
    });

    const result = await koda.sync();

    expect(result.outcome).toBe("failed");
    expect(exports).toBe(2);
    expect((await koda.store.readSyncState()).cursor).toEqual({ project: "n1", user: null });
  });
});
