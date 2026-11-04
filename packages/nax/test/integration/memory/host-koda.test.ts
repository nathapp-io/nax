/**
 * host.ts — a koda-backed host over the real client, provider and mirror (US-009).
 *
 * Covers AC-10, AC-11, AC-12, AC-13, AC-16 and AC-17. Every case composes the host
 * through `createMemoryHost` with the real `createKodaClient`, `createKodaApprovals`
 * and `createKodaMemoryProvider`, and stubs only the transport (`_kodaClientDeps.fetch`),
 * so what is asserted is the composition the surfaces actually get: a page pulled into
 * the mirror, a save delivered and stamped with koda's id, koda's hit ahead of the
 * mirror's, an unreachable koda that leaves the mirror readable and the write queued,
 * a failing search that falls back to the mirror, and `nax memory status --json`
 * reporting the provider id.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createMemoryStore, type MemoryNote } from "@nathapp/nax-agent";
import {
  assertDefined,
  cleanupTempDir,
  kodaListData,
  type MockLogger,
  makeLogger,
  makeNaxConfig,
  makeTempDir,
} from "@test/helpers";
import { type MemoryCliDeps, memoryStatusCommand } from "@/cli";
import type { NaxConfig } from "@/config";
import { createMemoryHost, type MemoryHost } from "@/memory";
import { _kodaClientDeps } from "@/memory/koda-http";
import type { KodaMemoryItem } from "@/memory/koda-mapping";

/** The API root the config names, koda's global prefix included. */
const API = "https://k.example/api";
/** The koda project slug every route addresses. */
const PROJECT = "rs-stock";
/** The koda project id `GET projects/rs-stock` answers with. */
const PROJECT_ID = "p1";
/** The instant every fixture stamps. */
const STAMP = "2026-11-12T10:15:00.000Z";
/** The slug the mirror and the feed share. */
const SLUG = "replay-budget";
/** The message the host's remote-search guard warns with. */
const WARN_MESSAGE = "memory remote search failed";

/** One recorded request, as the stubbed transport sees it. */
interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

/** What one route answers: a response, or a rejection the client classifies. */
type Answer = () => Response | Promise<Response>;

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
function jsonAnswer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The happy answers a route falls back to: writable, one empty finished page, no rows. */
const EMPTY_PAGE: Answer = () => jsonAnswer({ ret: 0, data: { items: [], nextCursor: null, hasMore: false } });
const WRITABLE: Answer = () => jsonAnswer({ ret: 0, data: { mode: "direct" } });
const PROJECT_ANSWER: Answer = () => jsonAnswer({ ret: 0, data: { id: PROJECT_ID } });
const SAVED: Answer = () => jsonAnswer({ ret: 0, data: { id: "k7" } }, 201);
const NO_HITS: Answer = () => jsonAnswer({ ret: 0, data: kodaListData([]) });

/** The routes a case may replace; every other request answers its happy default. */
interface KodaRoute {
  readonly writeMode?: Answer;
  readonly exportPage?: Answer;
  readonly search?: Answer;
  readonly save?: Answer;
  readonly project?: Answer;
}

/** Route the transport by path: the probe, the export feed, the search, a save, the project lookup. */
function stubKoda(route: KodaRoute = {}): void {
  stubFetch(async (call) => {
    if (call.init.method === "POST") return await (route.save ?? SAVED)();
    if (call.url.includes("/memory/write-mode")) return await (route.writeMode ?? WRITABLE)();
    if (call.url.includes("/memory/export")) return await (route.exportPage ?? EMPTY_PAGE)();
    if (call.url.includes("/memory?")) return await (route.search ?? NO_HITS)();
    return await (route.project ?? PROJECT_ANSWER)();
  });
}

/** One row of koda's export feed: an active project note unless the case says otherwise. */
function noteRow(overrides: Partial<KodaMemoryItem> = {}): KodaMemoryItem {
  return {
    id: "k1",
    kind: "NOTE",
    scope: "project",
    subject: SLUG,
    predicate: "project",
    object: "Budget 2,048 MiB.",
    description: "replay budget",
    status: "active",
    updatedAt: STAMP,
    sourceType: "nax-chat",
    ...overrides,
  };
}

/** A page holding `items`, finished: the one page a case's pull drains. */
function pageOf(...items: readonly KodaMemoryItem[]): Answer {
  return () => jsonAnswer({ ret: 0, data: { items, nextCursor: null, hasMore: false } });
}

/** A koda-backed config over the API root and project every case names. */
function kodaConfig(): NaxConfig {
  return makeNaxConfig({
    memory: {
      provider: "koda",
      koda: { url: API, project: PROJECT, headers: { Authorization: "Bearer x" } },
    },
  });
}

/** The mirror note AC-12 searches beside koda's own hit. */
const LOCAL_NOTE: MemoryNote = {
  id: "local",
  slug: "local-alpha",
  type: "project",
  scope: "project",
  description: "alpha local note",
  source: "nax-chat",
  updatedAt: STAMP,
  status: "active",
  body: "alpha from the mirror",
};

describe("a koda-backed memory host", () => {
  let repoRoot: string;
  let logger: MockLogger;

  beforeEach(() => {
    originalFetch = _kodaClientDeps.fetch;
    calls = [];
    repoRoot = makeTempDir("nax-host-koda-real-");
    logger = makeLogger();
  });

  afterEach(() => {
    _kodaClientDeps.fetch = originalFetch;
    cleanupTempDir(repoRoot);
  });

  async function open(config: NaxConfig = kodaConfig()): Promise<MemoryHost> {
    const host = await createMemoryHost({ config, repoRoot, source: "nax-chat", logger });
    assertDefined(host, "the memory host");
    return host;
  }

  /** Write one note straight into the mirror this host reads. */
  async function writeMirrorNote(host: MemoryHost, note: MemoryNote): Promise<void> {
    const store = createMemoryStore({ projectDir: host.dirs.projectDir, userDir: host.dirs.userDir, logger });
    await store.writeNote(note);
  }

  function remoteWarns() {
    return logger.calls.filter((call) => call.level === "warn" && call.message === WARN_MESSAGE);
  }

  test("AC-10 a sync writes the feed's active project note into the mirror", async () => {
    stubKoda({ exportPage: pageOf(noteRow()) });
    const host = await open();

    const result = await host.sync();

    expect(result).toMatchObject({ outcome: "synced", pulled: 1 });
    expect(await host.getNote("project", SLUG)).toMatchObject({
      id: "k1",
      slug: SLUG,
      status: "active",
      description: "replay budget",
      body: "Budget 2,048 MiB.",
    });
  });

  test("AC-10 the pull reads the export feed of the configured project", async () => {
    stubKoda({ exportPage: pageOf(noteRow()) });
    const host = await open();

    await host.sync();

    const exports = calls.filter((call) => call.url.includes("/memory/export"));
    expect(exports.map((call) => call.url.split("?")[0])).toEqual([
      `${API}/projects/${PROJECT}/memory/export`,
      `${API}/projects/${PROJECT}/memory/export`,
    ]);
  });

  test("AC-11 a save followed by a sync leaves the mirror note with koda's id and status active", async () => {
    stubKoda();
    const host = await open();

    const saved = await host.save({
      slug: SLUG,
      type: "project",
      scope: "project",
      description: "replay budget",
      body: "Budget 2,048 MiB.",
    });
    const result = await host.sync();

    expect(saved.delivered).toBe(true);
    expect(result.outcome).toBe("synced");
    expect(await host.getNote("project", SLUG)).toMatchObject({ id: "k7", status: "active" });
  });

  test("AC-12 a search puts koda's hit ahead of the mirror's hit for a different slug", async () => {
    stubKoda({
      search: () =>
        jsonAnswer({
          ret: 0,
          data: kodaListData([noteRow({ id: "k9", subject: "koda-alpha", description: "alpha from koda" })]),
        }),
    });
    const host = await open();
    await writeMirrorNote(host, LOCAL_NOTE);

    const hits = await host.search({ text: "alpha", limit: 10 });

    expect(hits.map((hit) => hit.slug)).toEqual(["koda-alpha", "local-alpha"]);
  });

  test.each([
    ["the server is unreachable", (): Answer => () => Promise.reject(new TypeError("connection refused"))],
    ["the key is wrong", (): Answer => () => jsonAnswer({ ret: -1, message: "bad key" }, 401)],
    ["membership is lost", (): Answer => () => jsonAnswer({ ret: -1, message: "no such project" }, 404)],
  ])(
    "AC-16 a sync reports unreachable when %s, and the mirror keeps answering while the write stays queued",
    async (_label, writeMode) => {
      stubKoda({ writeMode: writeMode() });
      const host = await open();
      const saved = await host.save({
        slug: SLUG,
        type: "project",
        scope: "project",
        description: "replay budget",
        body: "Budget 2,048 MiB.",
      });

      const result = await host.sync();

      expect(saved.delivered).toBe(false);
      expect(result.outcome).toBe("unreachable");
      expect(await host.getNote("project", SLUG)).toMatchObject({ slug: SLUG, description: "replay budget" });
      expect((await host.status()).queued).toBe(1);
    },
  );

  test("AC-17 a failing koda search warns through the remote-search guard and answers from the mirror", async () => {
    stubKoda({ search: () => Promise.reject(new TypeError("search down")) });
    const host = await open();
    await writeMirrorNote(host, LOCAL_NOTE);

    const hits = await host.search({ text: "alpha", limit: 10 });

    expect(hits.map((hit) => hit.slug)).toEqual(["local-alpha"]);
    expect(remoteWarns().map((call) => call.data?.provider)).toEqual([`koda:${PROJECT}`]);
  });

  test("status reports that koda decides the write mode, not the local default (#2791)", async () => {
    stubKoda({ writeMode: () => jsonAnswer({ ret: 0, data: { mode: "proposal" } }) });
    const host = await open();

    expect((await host.status()).writeMode).toBe("koda");
  });

  test("AC-13 nax memory status --json reports the koda provider", async () => {
    stubKoda();
    const out: string[] = [];
    const deps: MemoryCliDeps = {
      log: (msg) => out.push(msg),
      logErr: () => {},
      exit: () => {},
      findProjectDir: () => null,
      loadConfig: async () => kodaConfig(),
      createMemoryHost,
      readFile: async () => "",
    };

    const code = await memoryStatusCommand({ dir: repoRoot, json: true }, deps);

    assertDefined(out[0], "the status document");
    expect(code).toBe(0);
    expect(providerOf(out[0])).toBe(`koda:${PROJECT}`);
  });
});

/** The `provider` field of a `--json` status document, or `undefined` when it names none. */
function providerOf(document: string): unknown {
  const parsed: unknown = JSON.parse(document);
  if (typeof parsed !== "object" || parsed === null || !("provider" in parsed)) return undefined;
  return parsed.provider;
}
