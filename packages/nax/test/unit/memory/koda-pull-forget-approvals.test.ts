/**
 * koda-pull-forget-approvals.test.ts — a forget koda answers with a `202`, and how a
 * pull resolves the record it leaves behind.
 *
 * Two halves, both over a real `createKodaClient` whose `fetch` seam is stubbed, so what
 * is asserted is the request koda would receive and the answer the provider and the pull
 * make of it — never their own view of either. The first half is the provider's `retire`:
 * a `202` records what koda opened, and nothing else does. The second is the pull's
 * `resolveRecord`, which reads a `kind: "forget"` record by koda's answer: an open
 * approval keeps it, `executed` or `404` drops it, and a refused one drops it when the
 * slug needs no restoring and puts koda's active row back when it does — never a
 * tombstone, because a refused forget did not delete the note.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { MemoryNote, MemoryPage, MemoryProvider, MemoryScope } from "@nathapp/nax-agent";
import {
  assertDefined,
  cleanupTempDir,
  kodaListData,
  type LogCall,
  type MockLogger,
  makeLogger,
  makeTempDir,
} from "@test/helpers";
import { NaxError } from "@/errors";
import { createKodaApprovals, type KodaApproval, type KodaApprovals } from "@/memory/koda-approvals";
import { _kodaClientDeps, createKodaClient, kodaStatusOf } from "@/memory/koda-http";
import type { KodaMemoryItem } from "@/memory/koda-mapping";
import { type CreateKodaMemoryProviderInput, createKodaMemoryProvider } from "@/memory/koda-provider";

/** The API root every case builds its client from; koda's global prefix is part of it. */
const API = "https://k.example/api";
/** The koda project slug the provider is composed for. */
const PROJECT = "rs-stock";
/** The koda project id `GET projects/<slug>` answers with. */
const PROJECT_ID = "p1";
/** The slug every case's forget names, unless it says otherwise. */
const SLUG = "replay-budget";
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

/** A transport that never reaches koda. */
const UNREACHABLE: Answer = () => {
  throw new Error("socket hang up");
};

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

/** The `GET projects/<slug>` answer, carrying the project id. */
function projectAnswer(): Answer {
  return () => jsonAnswer({ ret: 0, data: { id: PROJECT_ID } });
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
function mirrorNote(slug: string, id: string, status: MemoryNote["status"] = "active"): MemoryNote {
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

/** The approvals record with everything it was asked to record, in call order. */
interface RecordingApprovals extends KodaApprovals {
  readonly recorded: KodaApproval[];
}

/**
 * An approvals record that keeps every entry it was handed.
 *
 * `fail` makes each `record` reject after the call is counted, which is what a `record` that
 * cannot read the file does — the entry is what the provider asked for, and the count is what
 * tells "recorded once" from "never recorded".
 */
function recordingApprovals(fail?: Error): RecordingApprovals {
  const recorded: KodaApproval[] = [];
  return {
    recorded,
    list: async () => recorded,
    record: async (entry) => {
      recorded.push(entry);
      if (fail !== undefined) throw fail;
    },
    drop: async () => {},
  };
}

describe("the koda provider's held forget", () => {
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

  /** Route the three requests a forget makes: the lookup, the project id and the retire. */
  function stubForget(input: { lookup?: () => Response; project?: () => Response; retire?: () => Response }): void {
    stubFetch((call) => {
      if (call.init.method === "POST") return (input.retire ?? (() => jsonAnswer({ ret: 0, data: { id: "k7" } })))();
      if (new URL(call.url).pathname.endsWith("/memory")) return (input.lookup ?? lookupPage([kodaRow(SLUG, "k7")]))();
      return (input.project ?? projectAnswer())();
    });
  }

  /** The provider under test, over the approvals record the case supplies. */
  function provider(approvals: KodaApprovals): MemoryProvider {
    return createKodaMemoryProvider({
      client: createKodaClient({ url: API, headers: { Authorization: "Bearer k" }, timeoutMs: CLIENT_TIMEOUT_MS }),
      project: PROJECT,
      approvals,
      readNote: async () => null,
      readDecisions: async () => [],
      logger,
    });
  }

  /** The forget every case pushes unless it says otherwise. */
  function forget(): Parameters<MemoryProvider["push"]>[0] {
    return { kind: "forget", clientId: "c5", scope: "project", slug: SLUG, writeMode: "direct", reason: "stale" };
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

  test("a 202 retire records the forget's approval and resolves pending (AC-5)", async () => {
    const approvals = recordingApprovals();
    stubForget({ retire: () => jsonAnswer({ ret: 0, data: { id: "apr_9" } }, 202) });

    const answer = await provider(approvals).push(forget());

    expect(answer).toEqual({ id: "c5", status: "pending" });
    expect(approvals.recorded).toEqual([
      { approvalId: "apr_9", kind: "forget", scope: "project", slug: SLUG, clientId: "c5" },
    ]);
  });

  test("a 202 retire without a string data.id is the provider's bad response and records nothing (AC-6)", async () => {
    const approvals = recordingApprovals();
    stubForget({ retire: () => jsonAnswer({ ret: 0, data: { id: 9 } }, 202) });

    const error = await rejectionOf(provider(approvals).push(forget()));

    expect(error.code).toBe("MEMORY_KODA_BAD_RESPONSE");
    expect(kodaStatusOf(error)).toBeUndefined();
    expect(approvals.recorded).toEqual([]);
  });

  test("a 200 retire records nothing and resolves deleted (AC-7)", async () => {
    const approvals = recordingApprovals();
    stubForget({ retire: () => jsonAnswer({ ret: 0, data: { id: "k7" } }, 200) });

    expect(await provider(approvals).push(forget())).toEqual({ id: "c5", status: "deleted" });
    expect(approvals.recorded).toEqual([]);
  });

  test("a record that rejects still resolves pending, and warns once naming the slug and approval (AC-17)", async () => {
    const failure = new NaxError("cannot read the approvals file", "MEMORY_KODA_APPROVALS_READ_FAILED", {
      stage: "memory",
    });
    const approvals = recordingApprovals(failure);
    stubForget({ retire: () => jsonAnswer({ ret: 0, data: { id: "apr_9" } }, 202) });

    expect(await provider(approvals).push(forget())).toEqual({ id: "c5", status: "pending" });
    expect(approvals.recorded).toHaveLength(1);
    const logged = warns();
    expect(logged).toHaveLength(1);
    assertDefined(logged[0], "the unrecorded approval's warn");
    expect(logged[0].data).toMatchObject({ slug: SLUG, approvalId: "apr_9" });
  });
});

/** The export page a pull case publishes, and its tail. */
interface PageRows {
  readonly items: readonly unknown[];
  readonly hasMore?: boolean;
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

describe("pullKodaPage — a held forget's record", () => {
  let calls: FetchCall[] = [];
  let originalFetch: typeof _kodaClientDeps.fetch;
  let logger: MockLogger;
  let dir: string;
  let approvals: KodaApprovals;

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
        return exportAnswer({ items: page.items, hasMore: page.hasMore ?? false, nextCursor: null });
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

  /** One held forget for {@link SLUG}, with the fields a case cares about overridden. */
  function forgetRecord(over: Partial<KodaApproval> = {}): KodaApproval {
    return { approvalId: "apr_1", kind: "forget", scope: "project", slug: SLUG, clientId: "c1", ...over };
  }

  /** Every request this case made, as URLs. */
  function urls(): readonly string[] {
    return calls.map((call) => call.url);
  }

  /** True when koda was asked to look the slug's active row up. */
  function lookedUp(): boolean {
    return urls().some((url) => new URL(url).pathname.endsWith("/memory"));
  }

  /**
   * The approval ids the record file still holds.
   *
   * Read through a second `createKodaApprovals` over the same directory, so the answer is
   * what `drop` left on disk rather than what the provider kept in memory.
   */
  async function recorded(): Promise<readonly string[]> {
    const reread = createKodaApprovals({ dir, logger });
    return (await reread.list()).map((entry) => entry.approvalId);
  }

  /** Every warn this case logged. */
  function warns(): readonly LogCall[] {
    return logger.calls.filter((call) => call.level === "warn");
  }

  beforeEach(() => {
    originalFetch = _kodaClientDeps.fetch;
    calls = [];
    logger = makeLogger();
    dir = makeTempDir("nax-koda-forget-approvals-");
    approvals = createKodaApprovals({ dir, logger });
  });

  afterEach(() => {
    _kodaClientDeps.fetch = originalFetch;
    cleanupTempDir(dir);
  });

  test("an open answer at the scope's last page keeps the record and restores no note (AC-8)", async () => {
    await approvals.record(forgetRecord());
    stubKoda({ approvals: { apr_1: settlement("pending") } });

    const page = await pullLastPage();

    expect(page.notes).toEqual([]);
    expect(await recorded()).toEqual(["apr_1"]);
    expect(lookedUp()).toBe(false);
  });

  test("an executed answer drops the record (AC-9)", async () => {
    await approvals.record(forgetRecord());
    stubKoda({ approvals: { apr_1: settlement("executed") } });

    const page = await pullLastPage();

    expect(page.notes).toEqual([]);
    expect(await recorded()).toEqual([]);
    expect(lookedUp()).toBe(false);
  });

  test("a refused answer for a slug the mirror holds drops the record and adds no note (AC-10)", async () => {
    await approvals.record(forgetRecord());
    stubKoda({ approvals: { apr_1: settlement("rejected") }, lookup: lookupPage([kodaRow(SLUG, "k1")]) });

    // The mirror holds the slug as the pending note this very forget was opened for: a
    // forget that was refused never deleted it, so nothing is put back and nothing is retired.
    const page = await pullLastPage({ readNote: mirrorOf(mirrorNote(SLUG, "c1", "pending")) });

    expect(page.notes).toEqual([]);
    expect(await recorded()).toEqual([]);
    expect(lookedUp()).toBe(false);
  });

  test("a refused answer restores koda's active row for a slug the mirror does not hold, and keeps the record (AC-11)", async () => {
    await approvals.record(forgetRecord());
    stubKoda({ approvals: { apr_1: settlement("rejected") }, lookup: lookupPage([kodaRow(SLUG, "k1")]) });

    const page = await pullLastPage({ readNote: mirrorOf() });

    expect(page.notes).toEqual([
      {
        id: "k1",
        slug: SLUG,
        type: "project",
        scope: "project",
        description: "about k1",
        body: "body of k1",
        updatedAt: STAMP,
        source: "nax-chat",
        status: "active",
      },
    ]);
    expect(await recorded()).toEqual(["apr_1"]);
  });

  test("a refused answer with no active koda row drops the record and adds no note (AC-12)", async () => {
    await approvals.record(forgetRecord());
    stubKoda({ approvals: { apr_1: settlement("rejected") }, lookup: lookupPage([]) });

    const page = await pullLastPage({ readNote: mirrorOf() });

    expect(page.notes).toEqual([]);
    expect(await recorded()).toEqual([]);
    // The lookup is what decided it: a forget looks koda's active row up rather than reading
    // the mirror's pending note, so it did ask and koda answered with nothing.
    expect(lookedUp()).toBe(true);
  });

  test.each(["rejected", "expired", "cancelled", "failed"] as const)(
    "a refused forget answered %s produces no rejected note (AC-13)",
    async (status) => {
      await approvals.record(forgetRecord());
      stubKoda({ approvals: { apr_1: settlement(status) }, lookup: lookupPage([kodaRow(SLUG, "k1")]) });

      // Both arms that could build one: a mirror still holding the note, and one that does not.
      const held = await pullLastPage({ readNote: mirrorOf(mirrorNote(SLUG, "c1", "pending")) });
      const restored = await pullLastPage({ readNote: mirrorOf() });

      expect([...held.notes, ...restored.notes].map((note) => note.status)).not.toContain("rejected");
    },
  );

  test("an approval read answered 404 drops the record (AC-14)", async () => {
    await approvals.record(forgetRecord());
    stubKoda({ approvals: { apr_1: refuse(404) } });

    const page = await pullLastPage();

    expect(page.notes).toEqual([]);
    expect(await recorded()).toEqual([]);
  });

  test("a refused answer for a slug the page already carries drops the record and adds no second note (AC-15)", async () => {
    await approvals.record(forgetRecord());
    stubKoda({
      page: { items: [kodaRow(SLUG, "k2")] },
      approvals: { apr_1: settlement("rejected") },
      lookup: lookupPage([kodaRow(SLUG, "k1")]),
    });

    const page = await pullLastPage({ readNote: mirrorOf() });

    expect(page.notes.map((note) => note.id)).toEqual(["k2"]);
    expect(await recorded()).toEqual([]);
    expect(lookedUp()).toBe(false);
  });

  test("a refused answer whose active row the mirror cannot hold keeps the record and warns (AC-16)", async () => {
    await approvals.record(forgetRecord());
    stubKoda({
      approvals: { apr_1: settlement("rejected") },
      lookup: lookupPage([kodaRow(SLUG, "k1", { predicate: "fact" })]),
    });

    const page = await pullLastPage({ readNote: mirrorOf() });

    expect(page.notes).toEqual([]);
    expect(await recorded()).toEqual(["apr_1"]);
    const logged = warns();
    expect(logged.map((call) => call.message)).toEqual(["koda approval was not resolved"]);
  });

  test.each([
    ["a 500 answer", refuse(500)],
    ["a transport failure", UNREACHABLE],
  ])("a refused forget whose restoring lookup fails with %s keeps the record and warns", async (_label, lookup) => {
    await approvals.record(forgetRecord());
    stubKoda({ approvals: { apr_1: settlement("rejected") }, lookup });

    const page = await pullLastPage({ readNote: mirrorOf() });

    expect(page.notes).toEqual([]);
    expect(await recorded()).toEqual(["apr_1"]);
    const logged = warns();
    expect(logged.map((call) => call.message)).toEqual(["koda approval was not resolved"]);
    assertDefined(logged[0], "the lookup failure's warn");
    expect(logged[0].data).toMatchObject({ approvalId: "apr_1" });
  });
});
