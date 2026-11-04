/**
 * koda-provider-forget-search.test.ts — the koda provider's forget and search, and
 * the lookup that finds the row a forget retires.
 *
 * Covers US-006 AC-1..AC-24. Every case drives a real `createKodaClient` whose
 * `fetch` seam is stubbed, so what is asserted is the requests koda would receive
 * and the answer the provider makes of them — never the provider's own view of
 * either.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isMemoryPushRejected, type MemoryHit, type MemoryProvider, type MemoryWriteRequest } from "@nathapp/nax-agent";
import { assertDefined, kodaListData, type MockLogger, makeLogger } from "@test/helpers";
import { NaxError } from "@/errors";
import { _kodaClientDeps, createKodaClient, kodaStatusOf } from "@/memory/koda-http";
import { findActiveKodaNote, MEMORY_KODA_LOOKUP_MAX_PAGES } from "@/memory/koda-lookup";
import { type KodaMemoryItem, kodaHitOf } from "@/memory/koda-mapping";
import { type CreateKodaMemoryProviderInput, createKodaMemoryProvider } from "@/memory/koda-provider";

/** The API root every case builds its client from; koda's global prefix is part of it. */
const API = "https://k.example/api";
/** The koda project slug the provider is composed for. */
const PROJECT = "rs-stock";
/** The koda project id `GET projects/<slug>` answers with. */
const PROJECT_ID = "p1";
/** The instant every row in this file carries. */
const STAMP = "2026-11-12T10:15:00.000Z";
/** How long a request may run: short, so the never-settling case rejects promptly. */
const CLIENT_TIMEOUT_MS = 50;

/** One recorded request, as the stubbed transport sees it. */
interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

/** One koda row, with the fields a case cares about overridden. */
function row(over: Partial<KodaMemoryItem> = {}): KodaMemoryItem {
  return {
    id: "k7",
    kind: "NOTE",
    scope: "project",
    subject: "replay-budget",
    predicate: "project",
    object: "The replay budget stays at 2,048 MiB.",
    description: "replay budget",
    status: "active",
    updatedAt: STAMP,
    sourceType: "nax-chat",
    ...over,
  };
}

describe("kodaHitOf", () => {
  test("a 300-character object with line breaks maps to a snippet of at most 200 characters, on one line (AC-23)", () => {
    const object = `${"Budget 2,048 MiB.\n".repeat(20)}tail`;
    assertDefined(object.length >= 300 ? object : undefined, "an object of 300 characters or more");

    const hit = kodaHitOf(row({ object }), 0, 1);

    assertDefined(hit, "the mapped hit");
    expect(hit.snippet.length).toBeLessThanOrEqual(200);
    expect(hit.snippet).not.toContain("\n");
    expect(hit.snippet.length).toBeGreaterThan(0);
  });

  test("a record whose predicate is decision maps to no hit (AC-24)", () => {
    expect(kodaHitOf(row({ predicate: "decision" }), 0, 1)).toBeNull();
  });
});

describe("createKodaMemoryProvider — search", () => {
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

  /** The `GET projects/<slug>/memory` answer, carrying `records` in koda's rank order. */
  function searchAnswer(records: readonly KodaMemoryItem[]): Response {
    return jsonAnswer({ ret: 0, data: kodaListData(records) });
  }

  /** The provider under test; the forget and search paths record no approval. */
  function makeProvider(overrides: Partial<CreateKodaMemoryProviderInput> = {}): MemoryProvider {
    return createKodaMemoryProvider({
      client: createKodaClient({ url: API, headers: { Authorization: "Bearer k" }, timeoutMs: CLIENT_TIMEOUT_MS }),
      project: PROJECT,
      approvals: { list: () => Promise.resolve([]), record: () => Promise.resolve(), drop: () => Promise.resolve() },
      readNote: async () => null,
      readDecisions: async () => [],
      logger,
      ...overrides,
    });
  }

  /** The URL of the one request this case made. */
  function onlyUrl(): string {
    assertDefined(calls[0], "the search request");
    return calls[0].url;
  }

  beforeEach(() => {
    originalFetch = _kodaClientDeps.fetch;
    calls = [];
    logger = makeLogger();
  });

  afterEach(() => {
    _kodaClientDeps.fetch = originalFetch;
  });

  test("a query requests kind, scope, text and size in that order (AC-17)", async () => {
    stubFetch(() => searchAnswer([row()]));

    await makeProvider().search?.({ scope: "project", text: "replay budget", limit: 5 });

    expect(onlyUrl()).toBe(`${API}/projects/rs-stock/memory?kind=NOTE&scope=project&text=replay+budget&size=5`);
  });

  test("a 150-character text sends its first 100 characters (AC-18)", async () => {
    stubFetch(() => searchAnswer([]));
    const text = "a".repeat(150);

    await makeProvider().search?.({ scope: "project", text, limit: 5 });

    expect(new URL(onlyUrl()).searchParams.get("text")).toBe("a".repeat(100));
  });

  test("a limit of 500 sends size 100 (AC-19)", async () => {
    stubFetch(() => searchAnswer([]));

    await makeProvider().search?.({ scope: "project", text: "budget", limit: 500 });

    expect(new URL(onlyUrl()).searchParams.get("size")).toBe("100");
  });

  test("blank text resolves no hits and asks koda nothing (AC-20)", async () => {
    stubFetch(() => searchAnswer([row()]));

    expect(await makeProvider().search?.({ scope: "project", text: "   ", limit: 5 })).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test("records resolve in koda's order, scored by their rank (AC-21)", async () => {
    stubFetch(() => searchAnswer([row(), row({ id: "k8", subject: "export-window" })]));

    const hits = await makeProvider().search?.({ scope: "project", text: "budget", limit: 5 });

    assertDefined(hits, "the search hits");
    expect(hits.map((hit: MemoryHit) => hit.slug)).toEqual(["replay-budget", "export-window"]);
    expect(hits.map((hit: MemoryHit) => hit.score)).toEqual([2, 1]);
  });

  test("three records with a limit of 2 resolve two hits (AC-22)", async () => {
    const records = [row(), row({ id: "k8", subject: "export-window" }), row({ id: "k9", subject: "merge-order" })];
    stubFetch(() => searchAnswer(records));

    const hits = await makeProvider().search?.({ scope: "project", text: "budget", limit: 2 });

    assertDefined(hits, "the search hits");
    expect(hits).toHaveLength(2);
    expect(hits[0]?.slug).toBe("replay-budget");
  });
});

describe("findActiveKodaNote", () => {
  let calls: FetchCall[] = [];
  let originalFetch: typeof _kodaClientDeps.fetch;
  /** The answers the next lookups receive, in order; an empty queue answers an empty page. */
  let pages: Response[] = [];

  /** A koda envelope answer. */
  function jsonAnswer(body: unknown, status = 200, statusText = ""): Response {
    return new Response(JSON.stringify(body), {
      status,
      statusText,
      headers: { "content-type": "application/json" },
    });
  }

  /** One search page, carrying `records` and koda's `hasNext` flag. */
  function pageAnswer(records: readonly KodaMemoryItem[], hasNext = false): Response {
    return jsonAnswer({ ret: 0, data: kodaListData(records, { hasNext }) });
  }

  /** Answer each lookup request with the next queued page, recording every call. */
  function stubPages(queued: readonly Response[]): void {
    pages = [...queued];
    _kodaClientDeps.fetch = async (input, init) => {
      calls.push({ url: input, init });
      return pages.shift() ?? pageAnswer([]);
    };
  }

  /** The lookup under test, over a real client whose transport is stubbed. */
  function lookup(scope: "project" | "user" = "project", slug = "replay-budget"): Promise<KodaMemoryItem | null> {
    return findActiveKodaNote({
      client: createKodaClient({ url: API, headers: {}, timeoutMs: CLIENT_TIMEOUT_MS }),
      project: PROJECT,
      scope,
      slug,
    });
  }

  /** The `current` page of every request made, in order. */
  function pagesRequested(): readonly (string | null)[] {
    return calls.map((call) => new URL(call.url).searchParams.get("current"));
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

  beforeEach(() => {
    originalFetch = _kodaClientDeps.fetch;
    calls = [];
    pages = [];
  });

  afterEach(() => {
    _kodaClientDeps.fetch = originalFetch;
  });

  test("it asks for the slug's active project rows, first page only until a match (AC-1)", async () => {
    stubPages([pageAnswer([row()])]);

    await lookup();

    expect(calls[0]?.url).toBe(
      `${API}/projects/rs-stock/memory?kind=NOTE&subject=replay-budget&scope=project&status=active&size=100&current=1`,
    );
  });

  test("koda's subject filter is a prefix match, so a longer subject is skipped (AC-2)", async () => {
    stubPages([pageAnswer([row({ id: "k8", subject: "replay-budget-2" }), row({ id: "k7" })])]);

    const found = await lookup();

    assertDefined(found, "the matching row");
    expect(found.id).toBe("k7");
    expect(found.subject).toBe("replay-budget");
  });

  test("a page with no match and hasNext asks the next page (AC-3)", async () => {
    stubPages([pageAnswer([row({ id: "k8", subject: "replay-budget-2" })], true), pageAnswer([row({ id: "k7" })])]);

    const found = await lookup();

    assertDefined(found, "the matching row");
    expect(found.id).toBe("k7");
    expect(pagesRequested()).toEqual(["1", "2"]);
  });

  test("no match on the last page resolves null (AC-4)", async () => {
    stubPages([pageAnswer([row({ id: "k8", subject: "replay-budget-2" })], false)]);

    expect(await lookup()).toBeNull();
    expect(pagesRequested()).toEqual(["1"]);
  });

  test("a cap of pages with no match is an exhausted lookup, not a missing note (AC-5)", async () => {
    pages = [];
    _kodaClientDeps.fetch = async (input, init) => {
      calls.push({ url: input, init });
      return pageAnswer([row({ id: "k8", subject: "replay-budget-2" })], true);
    };

    const error = await rejectionOf(lookup());

    expect(error.code).toBe("MEMORY_KODA_LOOKUP_EXHAUSTED");
    expect(MEMORY_KODA_LOOKUP_MAX_PAGES).toBe(10);
    expect(calls).toHaveLength(MEMORY_KODA_LOOKUP_MAX_PAGES);
  });

  test.each([
    ["no id", { subject: "replay-budget", scope: "project" }],
    ["an empty id", { id: "", subject: "replay-budget", scope: "project" }],
    ["an id that is not a string", { id: 7, subject: "replay-budget", scope: "project" }],
  ])("a matching row with %s is a bad response, not a row to retire (AC-16)", async (_label, record) => {
    stubPages([jsonAnswer({ ret: 0, data: kodaListData([record]) })]);

    const error = await rejectionOf(lookup());

    expect(error.code).toBe("MEMORY_KODA_BAD_RESPONSE");
  });

  test.each([
    ["no hasNext flag", { records: [] }],
    ["a null hasNext", { records: [], hasNext: null }],
    ["a hasNext that is not a boolean", { records: [], hasNext: "true" }],
    ["a hasNext of zero", { records: [], hasNext: 0 }],
  ])("a page with %s is a bad response, not the last page (AC-16)", async (_label, data) => {
    stubPages([jsonAnswer({ ret: 0, data })]);

    const error = await rejectionOf(lookup());

    expect(error.code).toBe("MEMORY_KODA_BAD_RESPONSE");
  });
});

describe("createKodaMemoryProvider — forget", () => {
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

  /** The forget lookup's answer, carrying `records`. */
  function lookupAnswer(records: readonly KodaMemoryItem[]): Response {
    return jsonAnswer({ ret: 0, data: kodaListData(records) });
  }

  /** The `GET projects/<slug>` answer, carrying the project id. */
  function projectAnswer(): Response {
    return jsonAnswer({ ret: 0, data: { id: PROJECT_ID } });
  }

  /** The retire answer: a koda envelope at `status`. */
  function retireAnswer(status = 201): Response {
    return jsonAnswer({ ret: 0, data: { id: "k7" } }, status);
  }

  /**
   * Route the three requests a forget may make: the lookup, the project id and the retire.
   * Each falls back to the happy path, so a case states only the answer it is about.
   */
  function stubForget(input: {
    lookup?: () => Response | Promise<Response>;
    project?: () => Response;
    retire?: () => Response | Promise<Response>;
  }): void {
    stubFetch((call) => {
      if (call.init.method === "POST") return input.retire?.() ?? retireAnswer();
      if (new URL(call.url).pathname.endsWith("/memory")) return input.lookup?.() ?? lookupAnswer([row()]);
      return input.project?.() ?? projectAnswer();
    });
  }

  /** The provider under test; a forget records no approval. */
  function makeProvider(): MemoryProvider {
    return createKodaMemoryProvider({
      client: createKodaClient({ url: API, headers: { Authorization: "Bearer k" }, timeoutMs: CLIENT_TIMEOUT_MS }),
      project: PROJECT,
      approvals: { list: () => Promise.resolve([]), record: () => Promise.resolve(), drop: () => Promise.resolve() },
      readNote: async () => null,
      readDecisions: async () => [],
      logger,
    });
  }

  /** The forget every case pushes unless it says otherwise. */
  function forgetOf(over: Partial<MemoryWriteRequest> = {}): MemoryWriteRequest {
    return {
      kind: "forget",
      clientId: "c5",
      scope: "project",
      slug: "replay-budget",
      writeMode: "direct",
      reason: "stale",
      ...over,
    };
  }

  /** The requests made so far as `METHOD path` rows, in the order koda received them. */
  function routesOf(): readonly string[] {
    return calls.map((call) => `${call.init.method ?? "GET"} ${new URL(call.url).pathname}`);
  }

  /** The parsed body of the one retire request this case made. */
  function retireBody(): Record<string, unknown> {
    const posted = calls.find((call) => call.init.method === "POST");
    assertDefined(posted, "the retire request");
    const body: Record<string, unknown> = JSON.parse(String(posted.init.body));
    return body;
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

  beforeEach(() => {
    originalFetch = _kodaClientDeps.fetch;
    calls = [];
    logger = makeLogger();
  });

  afterEach(() => {
    _kodaClientDeps.fetch = originalFetch;
  });

  test("a slug koda holds no active row for is already forgotten, and no retire is sent (AC-6)", async () => {
    stubForget({ lookup: () => lookupAnswer([]) });

    expect(await makeProvider().push(forgetOf())).toEqual({ id: "c5", status: "deleted" });
    expect(routesOf()).toEqual(["GET /api/projects/rs-stock/memory"]);
  });

  test("a found row is retired with the project id and the reason (AC-7)", async () => {
    stubForget({});

    expect(await makeProvider().push(forgetOf())).toEqual({ id: "c5", status: "deleted" });
    expect(routesOf()).toEqual([
      "GET /api/projects/rs-stock/memory",
      "GET /api/projects/rs-stock",
      "POST /api/memory/notes/k7/retire",
    ]);
    expect(retireBody()).toEqual({ projectId: PROJECT_ID, reason: "stale" });
  });

  test("an empty reason is omitted from the retire body (AC-8)", async () => {
    stubForget({});

    await makeProvider().push(forgetOf({ reason: "" }));

    expect(retireBody()).toEqual({ projectId: PROJECT_ID });
  });

  test.each([
    ["a 201", 201, "deleted"],
    ["a 202", 202, "pending"],
    ["a 404", 404, "deleted"],
    ["a 409", 409, "deleted"],
  ] as const)(
    "a retire answered %s resolves the client id as %s (AC-9, AC-10, AC-11, AC-12)",
    async (_label, status, expected) => {
      stubForget({ retire: () => retireAnswer(status) });

      expect(await makeProvider().push(forgetOf())).toEqual({ id: "c5", status: expected });
    },
  );

  test.each([400, 413, 422] as const)(
    "a retire answered %d is a permanent refusal quoting koda's message (AC-13)",
    async (status) => {
      stubForget({ retire: () => jsonAnswer({ ret: -2, message: "the note is not active" }, status) });

      const error = await rejectionOf(makeProvider().push(forgetOf()));

      expect(isMemoryPushRejected(error)).toBe(true);
      expect(error.message).toContain("the note is not active");
    },
  );

  test("a retire answered 403 is a permanent refusal: koda will not take this write (AC-14)", async () => {
    stubForget({ retire: () => jsonAnswer({ ret: -1, message: "forbidden" }, 403) });

    expect(isMemoryPushRejected(await rejectionOf(makeProvider().push(forgetOf())))).toBe(true);
  });

  test("a project lookup answered 404 leaves the entry queued and sends no retire (AC-15)", async () => {
    stubForget({ project: () => jsonAnswer({ ret: -1, message: "project not found" }, 404) });

    const error = await rejectionOf(makeProvider().push(forgetOf()));

    expect(isMemoryPushRejected(error)).toBe(false);
    expect(routesOf()).toEqual(["GET /api/projects/rs-stock/memory", "GET /api/projects/rs-stock"]);
  });

  test.each([
    ["a matching row with no id", { records: [{ subject: "replay-budget", scope: "project" }], hasNext: false }],
    ["a matching row with an empty id", { records: [{ id: "", subject: "replay-budget", scope: "project" }] }],
    ["an answer with no hasNext flag", { records: [] }],
    ["an answer whose hasNext is not a boolean", { records: [], hasNext: "false" }],
  ])("a malformed lookup answer — %s — leaves the entry queued and sends no retire (AC-16)", async (_label, data) => {
    stubForget({ lookup: () => jsonAnswer({ ret: 0, data }) });

    const error = await rejectionOf(makeProvider().push(forgetOf()));

    expect(isMemoryPushRejected(error)).toBe(false);
    expect(error.code).toBe("MEMORY_KODA_BAD_RESPONSE");
    expect(calls.filter((call) => call.init.method === "POST")).toHaveLength(0);
  });

  test.each([
    ["the lookup is answered 500", { lookup: () => jsonAnswer({ ret: -1, message: "boom" }, 500) }, 500],
    ["the lookup is answered 404", { lookup: () => jsonAnswer({ ret: -1, message: "no project" }, 404) }, 404],
    ["the lookup never answers", { lookup: () => new Promise<Response>(() => {}) }, undefined],
    ["the host is unreachable", { lookup: () => Promise.reject(new TypeError("connection refused")) }, undefined],
    ["the retire is answered 401", { retire: () => jsonAnswer({ ret: -1, message: "unauthorized" }, 401) }, 401],
    ["the retire is answered 408", { retire: () => jsonAnswer({ ret: -1, message: "timeout" }, 408) }, 408],
    ["the retire is answered 429", { retire: () => jsonAnswer({ ret: -1, message: "slow down" }, 429) }, 429],
    ["the retire is answered 500", { retire: () => jsonAnswer({ ret: -1, message: "boom" }, 500) }, 500],
    ["the retire never answers", { retire: () => new Promise<Response>(() => {}) }, undefined],
    [
      "the retire body is not JSON",
      { retire: () => new Response("not json", { status: 201, statusText: "Created" }) },
      undefined,
    ],
  ] as const)("a transient failure — %s — is rethrown, not refused (AC-16)", async (_label, answers, status) => {
    stubForget(answers);

    const error = await rejectionOf(makeProvider().push(forgetOf()));

    expect(isMemoryPushRejected(error)).toBe(false);
    expect(error).toBeInstanceOf(NaxError);
    expect(kodaStatusOf(error)).toBe(status);
  });
});
