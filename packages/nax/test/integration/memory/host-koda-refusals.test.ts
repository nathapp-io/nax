/**
 * host.ts — the koda host feeding the index and the status from its own records (US-004).
 *
 * Covers AC-2, AC-3 and AC-7. Every case composes the host through `createMemoryHost` with
 * the real client, approvals record, refusal report and provider, and stubs only the
 * transport (`_kodaClientDeps.fetch`) with this file's own minimal router: the write-mode
 * probe, the export feed and one approval's status. What is asserted is what a session
 * reads — the on-disk `MEMORY.md` and `host.status()` — rather than the store call.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createMemoryStore, type MemoryNote } from "@nathapp/nax-agent";
import { assertDefined, cleanupTempDir, type MockLogger, makeLogger, makeNaxConfig, makeTempDir } from "@test/helpers";
import type { NaxConfig } from "@/config";
import { createKodaApprovals, createMemoryHost, type KodaApproval, type MemoryHost } from "@/memory";
import { _kodaClientDeps } from "@/memory/koda-http";

/** The API root the config names, koda's global prefix included. */
const API = "https://k.example/api";
/** The koda project slug every route addresses. */
const PROJECT = "rs-stock";
/** The slug the mirror and the approval record share. */
const SLUG = "x";
/** The instant the mirror's note stamps. */
const STAMP = "2026-11-12T10:15:00.000Z";
/** What a note's index line ends with while koda holds a forget for it. */
const FORGET_PENDING = " (forget pending)";

/** One recorded request, as the stubbed transport sees it. */
interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

let originalFetch: typeof _kodaClientDeps.fetch;

/** A koda envelope answer. */
function envelope(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/**
 * The three routes these cases need, and nothing else: the probe says this agent may write
 * directly, the feed is one finished empty page, and the approvals route answers `status`.
 */
function stubTransport(status: "pending" | "executed" | "rejected"): void {
  _kodaClientDeps.fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const call: FetchCall = { url: input, init };
    if (call.url.includes("/memory/write-mode")) return envelope({ ret: 0, data: { mode: "direct" } });
    if (call.url.includes("/memory/export")) {
      return envelope({ ret: 0, data: { items: [], nextCursor: null, hasMore: false } });
    }
    if (call.url.includes("/approvals/")) return envelope({ ret: 0, data: { status } });
    return envelope({ ret: 0, data: {} });
  };
}

/** The koda-backed config every case opens its host over. */
function kodaConfig(): NaxConfig {
  return makeNaxConfig({
    memory: { provider: "koda", koda: { url: API, project: PROJECT, headers: { Authorization: "Bearer x" } } },
  });
}

/** The mirror note the koda forget names: one active project note. */
const NOTE: MemoryNote = {
  id: "m1",
  slug: SLUG,
  type: "project",
  scope: "project",
  description: "the note a forget is held for",
  source: "nax-chat",
  updatedAt: STAMP,
  status: "active",
  body: "body of the held note",
};

/** The forget koda answered with a `202` and has not settled. */
const FORGET: KodaApproval = { approvalId: "apr_1", kind: "forget", scope: "project", slug: SLUG, clientId: "c1" };

describe("a koda-backed host over a held forget", () => {
  let repoRoot: string;
  let logger: MockLogger;
  let host: MemoryHost;

  beforeEach(async () => {
    originalFetch = _kodaClientDeps.fetch;
    repoRoot = makeTempDir("nax-host-koda-refusals-int-");
    logger = makeLogger();
    const opened = await createMemoryHost({ config: kodaConfig(), repoRoot, source: "nax-chat", logger });
    assertDefined(opened, "the memory host");
    host = opened;
    const store = createMemoryStore({ projectDir: host.dirs.projectDir, userDir: host.dirs.userDir, logger });
    await store.writeNote(NOTE);
    await createKodaApprovals({ dir: host.dirs.projectDir, logger }).record(FORGET);
  });

  afterEach(() => {
    _kodaClientDeps.fetch = originalFetch;
    cleanupTempDir(repoRoot);
  });

  /** The project `MEMORY.md` as the sync left it on disk. */
  async function writtenIndex(): Promise<string> {
    return await Bun.file(join(host.dirs.projectDir, "MEMORY.md")).text();
  }

  /** The index line the held note renders as; fails when the index names no such note. */
  async function noteLine(): Promise<string> {
    const line = (await writtenIndex()).split("\n").find((rendered) => rendered.includes(`] ${SLUG} `));
    assertDefined(line, `the index line for ${SLUG}`);
    return line;
  }

  test("AC-2 a sync that leaves the approval pending marks the note forget pending in MEMORY.md", async () => {
    stubTransport("pending");

    const result = await host.sync();

    expect(result.outcome).toBe("synced");
    expect((await noteLine()).endsWith(FORGET_PENDING)).toBe(true);
  });

  test("AC-3 a sync that reads the approval as executed marks no note forget pending", async () => {
    stubTransport("executed");

    await host.sync();

    const line = await noteLine();
    expect(line.includes(`] ${SLUG} `)).toBe(true);
    expect(line.endsWith(FORGET_PENDING)).toBe(false);
  });

  test("AC-7 a refused forget is reported by status with koda's own word and an ISO instant", async () => {
    stubTransport("rejected");

    await host.sync();

    const refusals = (await host.status()).kodaRefusals;
    assertDefined(refusals, "the status's kodaRefusals");
    expect(refusals.length).toBe(1);
    const [refusal] = refusals;
    assertDefined(refusal, "the one refusal");
    const { refusedAt, ...rest } = refusal;
    expect(rest).toEqual({ kind: "forget", scope: "project", slug: SLUG, status: "rejected" });
    expect(new Date(refusedAt).toISOString()).toBe(refusedAt);
  });
});
