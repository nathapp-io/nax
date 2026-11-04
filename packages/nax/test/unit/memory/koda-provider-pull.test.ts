/**
 * koda-provider-pull.test.ts — the koda provider's pull: the export request, the
 * page's shape check, note reconciliation, the decision merge, and the mirror
 * reads reconciliation needs.
 *
 * Covers US-007 AC-1..AC-15 and AC-18. Every case drives a real `createKodaClient`
 * whose `fetch` seam is stubbed through a real provider, so what is asserted is the
 * request koda would receive and the page the provider makes of the answer. AC-16
 * and AC-17, which need the sync loop over a real mirror, live in
 * `test/integration/memory/koda-pull-sync.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { MemoryDecision, MemoryNote, MemoryPage, MemoryProvider, MemoryScope } from "@nathapp/nax-agent";
import { assertDefined, type LogCall, type MockLogger, makeLogger } from "@test/helpers";
import { NaxError } from "@/errors";
import { _kodaClientDeps, createKodaClient } from "@/memory/koda-http";
import type { KodaMemoryItem } from "@/memory/koda-mapping";
import { type CreateKodaMemoryProviderInput, createKodaMemoryProvider } from "@/memory/koda-provider";

/** The API root every case builds its client from; koda's global prefix is part of it. */
const API = "https://k.example/api";
/** The koda project slug the provider is composed for. */
const PROJECT = "rs-stock";
/** The instant every row in this file carries. */
const STAMP = "2026-11-12T10:15:00.000Z";
/** How long a request may run: short, so a never-settling answer rejects promptly. */
const CLIENT_TIMEOUT_MS = 50;

/** One recorded request, as the stubbed transport sees it. */
interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

/** The page one case asks for, unless it says otherwise. */
interface PullRequest {
  readonly scope: MemoryScope;
  readonly cursor: string | null;
  readonly take: number;
}

/** The pull of a project scope's first page, with `over` applied. */
function pullOf(over: Partial<PullRequest> = {}): PullRequest {
  return { scope: "project", cursor: null, take: 200, ...over };
}

/** One koda NOTE row, with the fields a case cares about overridden. */
function row(over: Partial<KodaMemoryItem> = {}): KodaMemoryItem {
  return {
    id: "k1",
    kind: "NOTE",
    scope: "project",
    subject: "replay-budget",
    predicate: "project",
    object: "Budget 2,048 MiB.",
    description: "replay budget",
    status: "active",
    updatedAt: STAMP,
    sourceType: "nax-chat",
    ...over,
  };
}

/** One koda DECISION row. */
function decisionRow(over: Partial<KodaMemoryItem> = {}): KodaMemoryItem {
  return {
    id: "d1",
    kind: "DECISION",
    scope: "project",
    subject: "replay-budget",
    predicate: "decision",
    object: "Budget 512 MiB.",
    description: "replay decision",
    status: "active",
    updatedAt: STAMP,
    ...over,
  };
}

/** The note the mirror already holds for `slug`. */
function mirrorNote(slug: string, id: string, scope: MemoryScope = "project"): MemoryNote {
  return {
    id,
    slug,
    type: "project",
    scope,
    description: `about ${slug}`,
    body: `body of ${slug}`,
    updatedAt: STAMP,
    source: "nax-chat",
    status: "active",
  };
}

describe("createKodaMemoryProvider — pull", () => {
  let calls: FetchCall[] = [];
  let originalFetch: typeof _kodaClientDeps.fetch;
  let logger: MockLogger;

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

  /** The provider under test; a pull records no approval. */
  function makeProvider(over: Partial<CreateKodaMemoryProviderInput> = {}): MemoryProvider {
    return createKodaMemoryProvider({
      client: createKodaClient({ url: API, headers: { Authorization: "Bearer k" }, timeoutMs: CLIENT_TIMEOUT_MS }),
      project: PROJECT,
      approvals: { list: () => Promise.resolve([]), record: () => Promise.resolve(), drop: () => Promise.resolve() },
      readNote: async () => null,
      readDecisions: async () => [],
      logger,
      ...over,
    });
  }

  /** Pull one page through the provider under test. */
  async function pullPage(
    over: Partial<PullRequest> = {},
    input: Partial<CreateKodaMemoryProviderInput> = {},
  ): Promise<MemoryPage> {
    return await makeProvider(input).pull(pullOf(over));
  }

  /** The URL of the one request this case made. */
  function onlyUrl(): string {
    assertDefined(calls[0], "the export request");
    return calls[0].url;
  }

  /** The NaxError `promise` rejects with; fails the case when it resolves instead. */
  async function rejectionOf(promise: Promise<unknown>): Promise<NaxError> {
    const caught: unknown = await promise.then(
      () => undefined,
      (error: unknown) => error,
    );
    if (!(caught instanceof NaxError)) throw new Error(`expected a NaxError, got ${String(caught)}`);
    return caught;
  }

  /** Every warn this case logged. */
  function warns(): readonly LogCall[] {
    return logger.calls.filter((call) => call.level === "warn");
  }

  beforeEach(() => {
    originalFetch = _kodaClientDeps.fetch;
    calls = [];
    logger = makeLogger();
  });

  afterEach(() => {
    _kodaClientDeps.fetch = originalFetch;
  });

  test("a project pull with a null cursor asks for the first page and no since (AC-1)", async () => {
    stubFetch(() => exportAnswer({ items: [], nextCursor: null, hasMore: false }));

    await pullPage({ scope: "project", cursor: null, take: 200 });

    expect(onlyUrl()).toBe(`${API}/projects/rs-stock/memory/export?take=200`);
    expect(calls[0]?.init.method).toBe("GET");
  });

  test("a cursor names the export's since, beside the take (AC-2)", async () => {
    stubFetch(() => exportAnswer({ items: [], nextCursor: null, hasMore: false }));

    await pullPage({ cursor: "c_abc", take: 200 });

    expect(onlyUrl()).toBe(`${API}/projects/rs-stock/memory/export?since=c_abc&take=200`);
  });

  test("a take of 900 asks koda for 500 rows (AC-3)", async () => {
    stubFetch(() => exportAnswer({ items: [], nextCursor: null, hasMore: false }));

    await pullPage({ take: 900 });

    expect(new URL(onlyUrl()).searchParams.get("take")).toBe("500");
  });

  test("an active project row and a cursor resolve one active note with more to come (AC-4)", async () => {
    stubFetch(() => exportAnswer({ items: [row()], nextCursor: "n1", hasMore: true }));

    const page = await pullPage();

    expect(page.notes).toEqual([
      {
        id: "k1",
        slug: "replay-budget",
        type: "project",
        scope: "project",
        description: "replay budget",
        body: "Budget 2,048 MiB.",
        updatedAt: STAMP,
        source: "nax-chat",
        status: "active",
      },
    ]);
    expect(page.nextCursor).toBe("n1");
    expect(page.done).toBe(false);
  });

  test("the feed's end answers no cursor and done (AC-5)", async () => {
    stubFetch(() => exportAnswer({ items: [], nextCursor: null, hasMore: false }));

    const page = await pullPage();

    expect(onlyUrl()).toBe(`${API}/projects/rs-stock/memory/export?take=200`);
    expect(page.done).toBe(true);
    expect(page.nextCursor).toBeUndefined();
  });

  test("a project pull keeps only the project's rows of the shared feed (AC-6)", async () => {
    stubFetch(() =>
      exportAnswer({
        items: [row({ id: "k2", subject: "user-preference", scope: "user" }), row()],
        nextCursor: null,
        hasMore: false,
      }),
    );

    const page = await pullPage({ scope: "project" });

    expect(page.notes.map((note) => note.slug)).toEqual(["replay-budget"]);
  });

  test("a user pull reads the same feed and keeps the user's rows (AC-7)", async () => {
    stubFetch(() =>
      exportAnswer({
        items: [row(), row({ id: "k2", subject: "user-preference", scope: "user" })],
        nextCursor: null,
        hasMore: false,
      }),
    );

    const page = await pullPage({ scope: "user" });

    expect(page.notes).toEqual([
      {
        id: "k2",
        slug: "user-preference",
        type: "project",
        scope: "user",
        description: "replay budget",
        body: "Budget 2,048 MiB.",
        updatedAt: STAMP,
        source: "nax-chat",
        status: "active",
      },
    ]);
  });

  test("the mirror is read once for each distinct slug the page's valid own-scope notes name (AC-8)", async () => {
    const reads: (readonly [MemoryScope, string])[] = [];
    stubFetch(() =>
      exportAnswer({
        items: [
          row({ id: "k1" }),
          row({ id: "k2" }),
          row({ id: "k3", subject: "export-window" }),
          row({ id: "k4", subject: "Bad Slug" }),
          row({ id: "k5", subject: "user-preference", scope: "user" }),
          decisionRow(),
        ],
        nextCursor: null,
        hasMore: false,
      }),
    );

    await pullPage(
      { scope: "project" },
      {
        readNote: async (scope, slug) => {
          reads.push([scope, slug]);
          return null;
        },
      },
    );

    expect(reads).toEqual([
      ["project", "replay-budget"],
      ["project", "export-window"],
    ]);
  });

  test("a rejection of the note the mirror holds is the page's tombstone for it (AC-9)", async () => {
    stubFetch(() => exportAnswer({ items: [row({ status: "rejected" })], nextCursor: null, hasMore: false }));

    const page = await pullPage({}, { readNote: async (scope, slug) => mirrorNote(slug, "k1", scope) });

    expect(page.notes).toEqual([
      {
        id: "k1",
        slug: "replay-budget",
        type: "project",
        scope: "project",
        description: "replay budget",
        body: "Budget 2,048 MiB.",
        updatedAt: STAMP,
        source: "nax-chat",
        status: "rejected",
      },
    ]);
  });

  test("a project page merges its DECISION rows into the mirror's own (AC-10)", async () => {
    const current: readonly MemoryDecision[] = [
      {
        id: "d0",
        subject: "budget",
        predicate: "decision",
        object: "Budget 1 MiB.",
        updatedAt: "2026-11-01T00:00:00.000Z",
        status: "active",
      },
    ];
    stubFetch(() => exportAnswer({ items: [row(), decisionRow()], nextCursor: null, hasMore: false }));

    const page = await pullPage({}, { readDecisions: async () => current });

    expect(page.decisions).toEqual([
      {
        id: "d1",
        subject: "replay-budget",
        predicate: "decision",
        object: "Budget 512 MiB.",
        updatedAt: STAMP,
        status: "active",
      },
      current[0],
    ]);
  });

  test("a project page without a DECISION row answers no decisions, so the file is not rewritten (AC-11)", async () => {
    stubFetch(() => exportAnswer({ items: [row()], nextCursor: null, hasMore: false }));

    const page = await pullPage();

    expect(onlyUrl()).toBe(`${API}/projects/rs-stock/memory/export?take=200`);
    expect(page.notes).toHaveLength(1);
    expect(page.decisions).toBeUndefined();
  });

  test("a user page's DECISION row is not the mirror's to write, and its list is not read (AC-12)", async () => {
    const reads: string[] = [];
    stubFetch(() =>
      exportAnswer({
        items: [decisionRow({ scope: "user" }), row({ id: "k2", subject: "user-preference", scope: "user" })],
        nextCursor: null,
        hasMore: false,
      }),
    );

    const page = await pullPage(
      { scope: "user" },
      {
        readDecisions: async () => {
          reads.push("decisions");
          return [];
        },
      },
    );

    expect(page.notes.map((note) => note.slug)).toEqual(["user-preference"]);
    expect(page.decisions).toBeUndefined();
    expect(reads).toEqual([]);
  });

  test.each([
    ["an answer with no items array", { nextCursor: null, hasMore: false }],
    ["an answer whose items is an object", { items: { rows: [] }, hasMore: false }],
  ])("a page whose data carries %s is a bad response (AC-13)", async (_label, data) => {
    stubFetch(() => exportAnswer(data));

    const error = await rejectionOf(pullPage());

    expect(error.code).toBe("MEMORY_KODA_BAD_RESPONSE");
  });

  test('a page whose hasMore is the string "false" is a bad response (AC-14)', async () => {
    stubFetch(() => exportAnswer({ items: [], nextCursor: null, hasMore: "false" }));

    const error = await rejectionOf(pullPage());

    expect(error.code).toBe("MEMORY_KODA_BAD_RESPONSE");
  });

  test("a page with one invalid NOTE row is skipped and warned about once, with the count (AC-15)", async () => {
    stubFetch(() => exportAnswer({ items: [row(), row({ predicate: "fact" })], nextCursor: null, hasMore: false }));

    const page = await pullPage();

    expect(page.notes).toHaveLength(1);
    const logged = warns();
    expect(logged).toHaveLength(1);
    assertDefined(logged[0], "the page's warn");
    expect(logged[0].data?.skipped).toBe(1);
    expect(logged[0].message).toContain("1");
  });

  test("a page's invalid NOTE and DECISION rows are counted together in one warn (AC-18)", async () => {
    stubFetch(() =>
      exportAnswer({
        items: [
          row(),
          row({ predicate: "fact" }),
          {
            id: "d2",
            kind: "DECISION",
            scope: "project",
            subject: "replay-budget",
            status: "active",
            updatedAt: STAMP,
          },
        ],
        nextCursor: null,
        hasMore: false,
      }),
    );

    const page = await pullPage();

    expect(page.notes).toHaveLength(1);
    const logged = warns();
    expect(logged).toHaveLength(1);
    assertDefined(logged[0], "the page's warn");
    expect(logged[0].data?.skipped).toBe(2);
    expect(logged[0].message).toContain("2");
  });
});
