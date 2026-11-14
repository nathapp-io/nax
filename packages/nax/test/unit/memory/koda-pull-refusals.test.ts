/**
 * koda-pull-refusals.test.ts — US-003: the proposals a pull drops *because koda
 * refused them* are logged in the refusal report, and logged before the approvals
 * are dropped.
 *
 * Every case drives a real `createKodaClient` whose `fetch` seam is stubbed, through
 * the real provider, and seeds its records through a real `createKodaApprovals` in a
 * temporary directory. What is asserted is what the pull asked the refusal report to
 * log (`refusals.record`'s captured calls), which approvals it dropped, and — for
 * the ordering case — the sequence across the two calls. AC-10 is the one case that
 * needs a real `createKodaRefusals`, because the assertion is the dedupe two pulls
 * share through one store.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { MemoryNote, MemoryPage, MemoryProvider, MemoryScope } from "@nathapp/nax-agent";
import { cleanupTempDir, kodaListData, type LogCall, type MockLogger, makeLogger, makeTempDir } from "@test/helpers";
import { createKodaApprovals, type KodaApproval, type KodaApprovals } from "@/memory/koda-approvals";
import { _kodaClientDeps, createKodaClient } from "@/memory/koda-http";
import type { KodaMemoryItem } from "@/memory/koda-mapping";
import { type CreateKodaMemoryProviderInput, createKodaMemoryProvider } from "@/memory/koda-provider";
import {
  _kodaRefusalsDeps,
  createKodaRefusals,
  KODA_REFUSALS_FILE,
  type KodaRefusal,
  type KodaRefusals,
} from "@/memory/koda-refusals";

/** An incoming refusal: an entry before the store stamps its `refusedAt`. */
type Incoming = Omit<KodaRefusal, "refusedAt">;

/** The API root every case builds its client from; koda's global prefix is part of it. */
const API = "https://k.example/api";
/** The koda project slug the provider is composed for. */
const PROJECT = "rs-stock";
/** The slug every case's proposal names. */
const SLUG = "x";
/** The instant every row and note in this file carries. */
const STAMP = "2026-11-12T10:15:00.000Z";
/** How long a request may run. */
const CLIENT_TIMEOUT_MS = 50;
/** The page size a pull case asks for. */
const PAGE_TAKE = 200;

/** One recorded request, as the stubbed transport sees it. */
interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

/** The answer one stubbed route gives to a request. */
type Answer = () => Response;

/** The export page a pull case publishes, and its tail. */
interface PageRows {
  readonly items: readonly unknown[];
  readonly hasMore?: boolean;
  readonly nextCursor?: string | null;
}

/** What the stub answers: the export page, each approval's status, and the restoring lookup. */
interface StubAnswers {
  /** The export page; an empty last page by default. */
  readonly page?: PageRows;
  /** One answer per approval id; an id with no entry answers 404. */
  readonly approvals?: Readonly<Record<string, Answer>>;
  /** The restoring lookup's answer; a lookup with no rows by default. */
  readonly lookup?: Answer;
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

/** An approval koda has settled on `value`. */
function settlement(value: string): Answer {
  return () => jsonAnswer({ ret: 0, data: { status: value } });
}

/** An answer koda refuses with `code`. */
function refuse(code: number): Answer {
  return () => jsonAnswer({ ret: code, message: "koda refused" }, code);
}

/** A lookup page carrying `records`, and saying whether more follow. */
function lookupPage(items: readonly unknown[]): Answer {
  return () => jsonAnswer({ ret: 0, data: kodaListData(items) });
}

/** One koda NOTE row for `slug`, with the fields a case cares about overridden. */
function kodaRow(slug: string, id: string, over: Partial<KodaMemoryItem> = {}): KodaMemoryItem {
  return {
    id,
    kind: "NOTE",
    scope: "project",
    subject: slug,
    predicate: "project",
    object: `body of ${id}`,
    description: `about ${id}`,
    status: "active",
    updatedAt: STAMP,
    sourceType: "nax-chat",
    ...over,
  };
}

/** The mirror's note for `slug`, carrying `id` and the status a case gives it. */
function mirrorNote(slug: string, id: string, status: MemoryNote["status"] = "pending"): MemoryNote {
  return {
    id,
    slug,
    type: "project",
    scope: "project",
    description: `about ${slug}`,
    body: `body of ${slug}`,
    updatedAt: STAMP,
    source: "nax-chat",
    status,
  };
}

/** A mirror reader over `notes`, answering per scope and slug. */
function mirrorOf(...notes: readonly MemoryNote[]): (scope: MemoryScope, slug: string) => Promise<MemoryNote | null> {
  return async (scope, slug) => notes.find((note) => note.scope === scope && note.slug === slug) ?? null;
}

/** A refusal report that keeps every call, and appends a marker to the shared event log. */
interface RecordingRefusals extends KodaRefusals {
  /** Every entries array `record` was handed, in call order. */
  readonly calls: (readonly Incoming[])[];
}

/**
 * The refusal report under test: a report that logs nothing to disk and keeps what it was
 * asked to log, so a case asserts the pull's calls rather than the store's file.
 */
function recordingRefusals(events: string[]): RecordingRefusals {
  const calls: (readonly Incoming[])[] = [];
  return {
    calls,
    list: async () => [],
    record: async (entries) => {
      calls.push(entries);
      events.push(`record:${entries.map((entry) => entry.approvalId).join(",")}`);
    },
  };
}

/** The approvals record under test: the real file store, with every `drop` observed. */
interface SpiedApprovals extends KodaApprovals {
  /** The approval ids `drop` actually dropped, in call order. */
  readonly dropped: string[];
}

/**
 * The approvals record the pull sees: `store` behind a `drop` that is recorded, and that
 * fails instead of dropping when `failDrop` is given.
 *
 * `events` is shared with the refusal report, so the order across a `record` and a `drop`
 * is one sequence rather than two guesses.
 */
function spiedApprovals(store: KodaApprovals, events: string[], failDrop?: Error): SpiedApprovals {
  const dropped: string[] = [];
  return {
    dropped,
    list: () => store.list(),
    record: (entry) => store.record(entry),
    drop: async (approvalIds) => {
      events.push(`drop:${approvalIds.join(",")}`);
      if (failDrop !== undefined) throw failDrop;
      await store.drop(approvalIds);
      dropped.push(...approvalIds);
    },
  };
}

describe("pullKodaPage — the refusals a pull logs", () => {
  let calls: FetchCall[] = [];
  let originalFetch: typeof _kodaClientDeps.fetch;
  let originalRefusalDeps: typeof _kodaRefusalsDeps;
  let logger: MockLogger;
  let dir: string;
  let approvals: KodaApprovals;
  let refusals: RecordingRefusals;
  /** The `record`/`drop` boundary markers, in the order the pull crossed them. */
  let events: string[];

  /** Replace the fetch seam with `answer`, recording every call it receives. */
  function stubFetch(answer: (call: FetchCall) => Response | Promise<Response>): void {
    _kodaClientDeps.fetch = async (input, init) => {
      const call: FetchCall = { url: input, init };
      calls.push(call);
      return await answer(call);
    };
  }

  /** Route the export page, each approval's status and the restoring lookup. */
  function stubKoda(answers: StubAnswers = {}): void {
    const page = answers.page ?? { items: [] };
    stubFetch((call) => {
      const url = new URL(call.url);
      if (url.pathname.endsWith("/memory/export")) {
        return exportAnswer({
          items: page.items,
          hasMore: page.hasMore ?? false,
          nextCursor: page.nextCursor ?? null,
        });
      }
      if (url.pathname.endsWith("/memory")) return (answers.lookup ?? lookupPage([]))();
      const approvalId = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
      return (answers.approvals?.[approvalId] ?? refuse(404))();
    });
  }

  /** The provider under test, with every read a case does not override answering nothing. */
  function provider(over: Partial<CreateKodaMemoryProviderInput> = {}): MemoryProvider {
    return createKodaMemoryProvider({
      client: createKodaClient({ url: API, headers: { Authorization: "Bearer k" }, timeoutMs: CLIENT_TIMEOUT_MS }),
      project: PROJECT,
      approvals,
      refusals,
      readNote: async () => null,
      readDecisions: async () => [],
      logger,
      ...over,
    });
  }

  /** Pull one scope's last page through the provider under test. */
  async function pullLastPage(over: Partial<CreateKodaMemoryProviderInput> = {}): Promise<MemoryPage> {
    return await provider(over).pull({ scope: "project", cursor: null, take: PAGE_TAKE });
  }

  /** One recorded proposal, with the fields a case cares about overridden. */
  function record(over: Partial<KodaApproval> = {}): KodaApproval {
    return { approvalId: "apr_1", scope: "project", slug: SLUG, clientId: "c1", ...over };
  }

  /** Every refusal entry the pull asked to log, flattened across calls. */
  function logged(): readonly Incoming[] {
    return refusals.calls.flat();
  }

  /**
   * The approval ids the record file still holds.
   *
   * Read through a second `createKodaApprovals` over the same directory, so the answer is
   * what `drop` left on disk rather than what the provider kept in memory.
   */
  async function held(): Promise<readonly string[]> {
    const reread = createKodaApprovals({ dir, logger });
    return (await reread.list()).map((entry) => entry.approvalId);
  }

  /** Every warn this case logged. */
  function warns(): readonly LogCall[] {
    return logger.calls.filter((call) => call.level === "warn");
  }

  beforeEach(() => {
    originalFetch = _kodaClientDeps.fetch;
    originalRefusalDeps = { ..._kodaRefusalsDeps };
    calls = [];
    events = [];
    logger = makeLogger();
    dir = makeTempDir("nax-koda-pull-refusals-");
    approvals = createKodaApprovals({ dir, logger });
    refusals = recordingRefusals(events);
  });

  afterEach(() => {
    _kodaClientDeps.fetch = originalFetch;
    Object.assign(_kodaRefusalsDeps, originalRefusalDeps);
    cleanupTempDir(dir);
  });

  test("a refused save the page already carries is logged once with koda's status (AC-1)", async () => {
    await approvals.record(record());
    stubKoda({
      page: { items: [kodaRow(SLUG, "k2")] },
      approvals: { apr_1: settlement("rejected") },
    });

    await pullLastPage();

    expect(refusals.calls).toEqual([
      [{ approvalId: "apr_1", kind: "save", scope: "project", slug: SLUG, status: "rejected" }],
    ]);
  });

  test("a refused forget the mirror holds is logged with its kind and status (AC-2)", async () => {
    await approvals.record(record({ approvalId: "apr_2", kind: "forget" }));
    stubKoda({ approvals: { apr_2: settlement("expired") } });

    await pullLastPage({ readNote: mirrorOf(mirrorNote(SLUG, "c1")) });

    expect(logged()).toContainEqual({
      approvalId: "apr_2",
      kind: "forget",
      scope: "project",
      slug: SLUG,
      status: "expired",
    });
  });

  test("an executed answer and a 404 log no refusal (AC-3)", async () => {
    await approvals.record(record({ approvalId: "apr_1" }));
    await approvals.record(record({ approvalId: "apr_2", kind: "forget", slug: "y" }));
    stubKoda({ approvals: { apr_1: settlement("executed"), apr_2: refuse(404) } });

    await pullLastPage({ readNote: mirrorOf(mirrorNote("y", "c2")) });

    expect(refusals.calls).toEqual([]);
    expect(await held()).toEqual([]);
  });

  test("a refused record whose resolution restores the slug is not logged yet (AC-4)", async () => {
    await approvals.record(record({ approvalId: "apr_1", kind: "forget" }));
    stubKoda({ approvals: { apr_1: settlement("rejected") }, lookup: lookupPage([kodaRow(SLUG, "k1")]) });

    const page = await pullLastPage({ readNote: mirrorOf() });

    expect(page.notes.map((note) => note.id)).toEqual(["k1"]);
    expect(refusals.calls).toEqual([]);
    expect(await held()).toEqual(["apr_1"]);
  });

  test("a refused forget whose page already carries the slug drops the record (AC-5)", async () => {
    const spied = spiedApprovals(approvals, events);
    await approvals.record(record({ approvalId: "apr_5", kind: "forget" }));
    stubKoda({
      page: { items: [kodaRow(SLUG, "k2")] },
      approvals: { apr_5: settlement("rejected") },
    });

    const page = await pullLastPage({ approvals: spied });

    expect(page.notes.map((note) => note.id)).toEqual(["k2"]);
    expect(spied.dropped).toEqual(["apr_5"]);
    expect(await held()).toEqual([]);
  });

  test("a refused forget whose page already carries the slug is logged (AC-6)", async () => {
    const spied = spiedApprovals(approvals, events);
    await approvals.record(record({ approvalId: "apr_5", kind: "forget" }));
    stubKoda({
      page: { items: [kodaRow(SLUG, "k2")] },
      approvals: { apr_5: settlement("rejected") },
    });

    await pullLastPage({ approvals: spied });

    expect(logged().map((entry) => entry.approvalId)).toEqual(["apr_5"]);
    expect(spied.dropped).toEqual(["apr_5"]);
  });

  test("the refusal is recorded before the approvals are dropped (AC-7)", async () => {
    const spied = spiedApprovals(approvals, events);
    await approvals.record(record({ approvalId: "apr_1", kind: "forget" }));
    stubKoda({
      page: { items: [kodaRow(SLUG, "k2")] },
      approvals: { apr_1: settlement("rejected") },
    });

    await pullLastPage({ approvals: spied });

    expect(events).toEqual(["record:apr_1", "drop:apr_1"]);
  });

  test("a refusal log whose write fails warns, and the pull still drops the record (AC-8)", async () => {
    const spied = spiedApprovals(approvals, events);
    const failing = createKodaRefusals({ dir, logger });
    _kodaRefusalsDeps.write = async () => {
      throw new Error("read-only file system");
    };
    await approvals.record(record({ approvalId: "apr_1", kind: "forget" }));
    stubKoda({
      page: { items: [kodaRow(SLUG, "k2")] },
      approvals: { apr_1: settlement("rejected") },
    });

    const page = await pullLastPage({ approvals: spied, refusals: failing });

    expect(page.notes.map((note) => note.id)).toEqual(["k2"]);
    expect(spied.dropped).toEqual(["apr_1"]);
    expect(await held()).toEqual([]);
    expect(warns().map((call) => call.message)).toContain("koda refusals were not recorded");
    expect(await Bun.file(`${dir}/${KODA_REFUSALS_FILE}`).exists()).toBe(false);
  });

  test("a provider composed without a refusal log drops a refused record as before (AC-9)", async () => {
    const spied = spiedApprovals(approvals, events);
    await approvals.record(record({ approvalId: "apr_1", kind: "forget" }));
    stubKoda({
      page: { items: [kodaRow(SLUG, "k2")] },
      approvals: { apr_1: settlement("rejected") },
    });

    const page = await pullLastPage({ approvals: spied, refusals: undefined });

    expect(page.notes.map((note) => note.id)).toEqual(["k2"]);
    expect(spied.dropped).toEqual(["apr_1"]);
    expect(await held()).toEqual([]);
    expect(warns()).toEqual([]);
  });

  test("a drop that fails after the refusal was logged leaves one entry for the next pull (AC-10)", async () => {
    const store = createKodaRefusals({ dir, logger });
    await approvals.record(record({ approvalId: "apr_1", kind: "forget" }));
    stubKoda({
      page: { items: [kodaRow(SLUG, "k2")] },
      approvals: { apr_1: settlement("rejected") },
    });
    const failing = spiedApprovals(approvals, events, new Error("cannot write the approvals file"));

    await expect(pullLastPage({ approvals: failing, refusals: store })).rejects.toThrow(
      "cannot write the approvals file",
    );
    expect((await store.list()).map((entry) => entry.approvalId)).toEqual(["apr_1"]);

    const second = spiedApprovals(approvals, events);
    await pullLastPage({ approvals: second, refusals: store });

    expect(second.dropped).toEqual(["apr_1"]);
    expect((await store.list()).map((entry) => entry.approvalId)).toEqual(["apr_1"]);
  });

  test("a page with more to come logs no refusal (AC-11)", async () => {
    await approvals.record(record({ approvalId: "apr_1", kind: "forget" }));
    stubKoda({
      page: { items: [kodaRow(SLUG, "k2")], hasMore: true, nextCursor: "n1" },
      approvals: { apr_1: settlement("rejected") },
    });

    const page = await pullLastPage();

    expect(page.done).toBe(false);
    expect(refusals.calls).toEqual([]);
    expect(await held()).toEqual(["apr_1"]);
  });
});
