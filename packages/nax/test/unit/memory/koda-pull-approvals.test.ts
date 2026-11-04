/**
 * koda-pull-approvals.test.ts — US-008: the recorded proposals a pull resolves at
 * a scope's last page, and the slug a refused proposal puts back.
 *
 * Every case drives a real `createKodaClient` whose `fetch` seam is stubbed, through
 * the real provider, and seeds its records through a real `createKodaApprovals` in a
 * temporary directory — so what is asserted is the request koda would receive, the
 * records the file is left holding and the page the provider makes of it. AC-16,
 * which needs the sync loop over a real mirror, lives in
 * `test/integration/memory/koda-pull-sync.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { MemoryNote, MemoryPage, MemoryProvider, MemoryScope } from "@nathapp/nax-agent";
import { assertDefined, cleanupTempDir, type LogCall, type MockLogger, makeLogger, makeTempDir } from "@test/helpers";
import { createKodaApprovals, type KodaApproval, type KodaApprovals } from "@/memory/koda-approvals";
import { _kodaClientDeps, createKodaClient } from "@/memory/koda-http";
import type { KodaMemoryItem } from "@/memory/koda-mapping";
import {
  type CreateKodaMemoryProviderInput,
  createKodaMemoryProvider,
  MEMORY_KODA_APPROVAL_CHECKS_MAX,
} from "@/memory/koda-provider";

/** The API root every case builds its client from; koda's global prefix is part of it. */
const API = "https://k.example/api";
/** The koda project slug the provider is composed for. */
const PROJECT = "rs-stock";
/** The slug every case's proposal names, unless it says otherwise. */
const SLUG = "replay-budget";
/** The instant every row and note in this file carries. */
const STAMP = "2026-11-12T10:15:00.000Z";
/** How long a request may run: short, so a never-settling answer rejects promptly. */
const CLIENT_TIMEOUT_MS = 50;
/** The page size a case pulls with. */
const PAGE_TAKE = 200;

/** One recorded request, as the stubbed transport sees it. */
interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

/** The answer one stubbed route gives to a request. */
type Answer = () => Response;

/** The export page a case publishes, and its tail. */
interface PageRows {
  readonly items: readonly unknown[];
  readonly hasMore?: boolean;
  readonly nextCursor?: string | null;
}

/** What the stub answers: the export page, each approval's status, and the restoring lookup. */
interface StubAnswers {
  /** The export page; an empty page by default. */
  readonly page?: PageRows;
  /** One answer per approval id; an id with no entry answers 404. */
  readonly approvals?: Readonly<Record<string, Answer>>;
  /** The restoring lookup's answer; a page with no records by default. */
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

/** A transport that never reaches koda. */
const UNREACHABLE: Answer = () => {
  throw new Error("socket hang up");
};

/** A lookup page carrying `items`, and saying whether more follow. */
function lookupPage(items: readonly unknown[]): Answer {
  return () => jsonAnswer({ ret: 0, data: { items, hasNext: false, current: 1 } });
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

/** The mirror's pending note for `slug`, carrying the client id of the proposal that made it. */
function pendingNote(slug: string, id: string, scope: MemoryScope = "project"): MemoryNote {
  return {
    id,
    slug,
    type: "project",
    scope,
    description: `about ${slug}`,
    body: `body of ${slug}`,
    updatedAt: STAMP,
    source: "nax-chat",
    status: "pending",
  };
}

/** A mirror reader over `notes`, answering per scope and slug. */
function mirrorOf(...notes: readonly MemoryNote[]): (scope: MemoryScope, slug: string) => Promise<MemoryNote | null> {
  return async (scope, slug) => notes.find((note) => note.scope === scope && note.slug === slug) ?? null;
}

describe("pullKodaPage — recorded proposal resolution", () => {
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
      readNote: async () => null,
      readDecisions: async () => [],
      logger,
      ...over,
    });
  }

  /** Pull one scope's last page through the provider under test. */
  async function pullLastPage(
    over: Partial<CreateKodaMemoryProviderInput> = {},
    scope: MemoryScope = "project",
  ): Promise<MemoryPage> {
    return await provider(over).pull({ scope, cursor: null, take: PAGE_TAKE });
  }

  /** One recorded proposal for {@link SLUG}, with the fields a case cares about overridden. */
  function proposal(over: Partial<KodaApproval> = {}): KodaApproval {
    return { approvalId: "apr_1", scope: "project", slug: SLUG, clientId: "c1", ...over };
  }

  /** Every request this case made, as URLs. */
  function urls(): readonly string[] {
    return calls.map((call) => call.url);
  }

  /** The approval ids this case asked koda about, in request order. */
  function approvalRequests(): readonly string[] {
    return urls()
      .filter((url) => new URL(url).pathname.includes("/approvals/"))
      .map((url) => new URL(url).pathname.slice(new URL(url).pathname.lastIndexOf("/") + 1));
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
    dir = makeTempDir("nax-koda-approvals-");
    approvals = createKodaApprovals({ dir, logger });
  });

  afterEach(() => {
    _kodaClientDeps.fetch = originalFetch;
    cleanupTempDir(dir);
  });

  test("a last project page asks koda about the project's recorded approval (AC-1)", async () => {
    await approvals.record(proposal());
    stubKoda({ approvals: { apr_1: settlement("pending") } });

    await pullLastPage();

    expect(calls.some((call) => call.url === `${API}/approvals/apr_1` && call.init.method === "GET")).toBe(true);
  });

  test("a page with more to come asks koda about no approval and keeps every record (AC-2)", async () => {
    await approvals.record(proposal());
    stubKoda({ page: { items: [], hasMore: true, nextCursor: "n1" }, approvals: { apr_1: settlement("pending") } });

    const page = await pullLastPage();

    expect(page.done).toBe(false);
    expect(approvalRequests()).toEqual([]);
    expect(await recorded()).toEqual(["apr_1"]);
  });

  test("a last user page asks only about the approvals recorded for the user scope (AC-3)", async () => {
    await approvals.record(proposal());
    await approvals.record(proposal({ approvalId: "apr_2", scope: "user", slug: "editor-theme" }));
    stubKoda({ approvals: { apr_1: settlement("pending"), apr_2: settlement("pending") } });

    await pullLastPage({}, "user");

    expect(approvalRequests()).toEqual(["apr_2"]);
  });

  test("a last page resolves at most MEMORY_KODA_APPROVAL_CHECKS_MAX approvals, oldest first (AC-4)", async () => {
    const settlements: Record<string, Answer> = {};
    for (let index = 1; index <= 25; index += 1) {
      await approvals.record(proposal({ approvalId: `apr_${index}`, slug: `note-${index}` }));
      settlements[`apr_${index}`] = settlement("pending");
    }
    stubKoda({ approvals: settlements });

    await pullLastPage();

    const oldest = Array.from({ length: MEMORY_KODA_APPROVAL_CHECKS_MAX }, (_unused, index) => `apr_${index + 1}`);
    expect(approvalRequests()).toHaveLength(MEMORY_KODA_APPROVAL_CHECKS_MAX);
    expect(approvalRequests()).toEqual(oldest);
  });

  test("a pending answer keeps the record and adds no note (AC-5)", async () => {
    await approvals.record(proposal());
    stubKoda({ approvals: { apr_1: settlement("pending") } });

    const page = await pullLastPage();

    expect(approvalRequests()).toEqual(["apr_1"]);
    expect(page.notes).toEqual([]);
    expect(await recorded()).toEqual(["apr_1"]);
  });

  test("an approved answer keeps the record, because it can still settle (AC-6)", async () => {
    await approvals.record(proposal());
    stubKoda({ approvals: { apr_1: settlement("approved") } });

    const page = await pullLastPage();

    expect(approvalRequests()).toEqual(["apr_1"]);
    expect(page.notes).toEqual([]);
    expect(await recorded()).toEqual(["apr_1"]);
  });

  test("an executed answer drops the record and adds no note (AC-7)", async () => {
    await approvals.record(proposal());
    stubKoda({ approvals: { apr_1: settlement("executed") } });

    const page = await pullLastPage();

    expect(page.notes).toEqual([]);
    expect(await recorded()).toEqual([]);
  });

  test("a 404 answer drops the record and adds no note (AC-8)", async () => {
    await approvals.record(proposal());
    stubKoda({ approvals: { apr_1: refuse(404) } });

    const page = await pullLastPage();

    expect(page.notes).toEqual([]);
    expect(await recorded()).toEqual([]);
    expect(lookedUp()).toBe(false);
  });

  test.each([
    ["a 500 answer", refuse(500)],
    ["a transport failure", UNREACHABLE],
  ])("a status read that fails with %s keeps the record and warns (AC-9)", async (_label, answer) => {
    await approvals.record(proposal());
    stubKoda({ approvals: { apr_1: answer } });

    const page = await pullLastPage();

    expect(page.notes).toEqual([]);
    expect(await recorded()).toEqual(["apr_1"]);
    const logged = warns();
    expect(logged).toHaveLength(1);
    assertDefined(logged[0], "the status read's warn");
    expect(logged[0].data?.approvalId).toBe("apr_1");
  });

  test.each([
    ["no pending note to put back", () => mirrorOf()],
    ["the lookup succeeds", () => mirrorOf(pendingNote(SLUG, "c1"))],
  ])("a rejected answer drops the record when %s (AC-10)", async (_label, mirror) => {
    await approvals.record(proposal());
    stubKoda({ approvals: { apr_1: settlement("rejected") }, lookup: lookupPage([kodaRow(SLUG, "k1")]) });

    await pullLastPage({ readNote: mirror() });

    expect(await recorded()).toEqual([]);
  });

  test("a failed answer with no active koda row adds the mirror's pending note as a rejection (AC-11)", async () => {
    await approvals.record(proposal());
    const pending = pendingNote(SLUG, "c1");
    stubKoda({ approvals: { apr_1: settlement("failed") }, lookup: lookupPage([]) });

    const page = await pullLastPage({ readNote: mirrorOf(pending) });

    expect(page.notes).toEqual([{ ...pending, status: "rejected" }]);
    expect(await recorded()).toEqual([]);
    expect(lookedUp()).toBe(true);
  });

  test("a rejected answer puts koda's active row back as the slug's note (AC-12)", async () => {
    await approvals.record(proposal());
    stubKoda({ approvals: { apr_1: settlement("rejected") }, lookup: lookupPage([kodaRow(SLUG, "k1")]) });

    const page = await pullLastPage({ readNote: mirrorOf(pendingNote(SLUG, "c1")) });

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
    expect(await recorded()).toEqual([]);
  });

  test("an expired answer whose mirror note is another id adds no note and looks nothing up (AC-13)", async () => {
    await approvals.record(proposal());
    stubKoda({ approvals: { apr_1: settlement("expired") }, lookup: lookupPage([kodaRow(SLUG, "k1")]) });

    const page = await pullLastPage({ readNote: mirrorOf(pendingNote(SLUG, "c_other")) });

    expect(page.notes).toEqual([]);
    expect(lookedUp()).toBe(false);
    expect(await recorded()).toEqual([]);
  });

  test("a cancelled answer for a slug the page already carries adds no second note and looks nothing up (AC-14)", async () => {
    await approvals.record(proposal());
    stubKoda({
      page: { items: [kodaRow(SLUG, "k2")] },
      approvals: { apr_1: settlement("cancelled") },
      lookup: lookupPage([kodaRow(SLUG, "k1")]),
    });

    const page = await pullLastPage({ readNote: mirrorOf(pendingNote(SLUG, "c1")) });

    expect(page.notes).toHaveLength(1);
    expect(page.notes[0]?.id).toBe("k2");
    expect(lookedUp()).toBe(false);
    expect(await recorded()).toEqual([]);
  });

  test.each([
    ["a 500 answer", refuse(500)],
    ["a transport failure", UNREACHABLE],
  ])(
    "a restoring lookup that fails with %s keeps the record, adds no note and warns (AC-15)",
    async (_label, answer) => {
      await approvals.record(proposal());
      stubKoda({ approvals: { apr_1: settlement("rejected") }, lookup: answer });

      const page = await pullLastPage({ readNote: mirrorOf(pendingNote(SLUG, "c1")) });

      expect(page.notes).toEqual([]);
      expect(await recorded()).toEqual(["apr_1"]);
      const logged = warns();
      expect(logged).toHaveLength(1);
      assertDefined(logged[0], "the lookup failure's warn");
      expect(logged[0].data?.approvalId).toBe("apr_1");
      expect(logged[0].data?.reason).toBeTruthy();
    },
  );
});
