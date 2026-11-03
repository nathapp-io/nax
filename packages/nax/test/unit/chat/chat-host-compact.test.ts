/**
 * US-005: the chat host's `compact` — a plain delegation plus the spend it records.
 *
 * The session facade owns what a compaction is and what it cost; the host's own work is the
 * accounting: one ledger row for the summarizer call, and the session metadata's cumulative
 * spend carried forward. A compaction that spent nothing — nothing to compact — writes neither.
 *
 * The metadata is re-read from storage before it is written, never taken from the opener's
 * handle: a turn may have added spend since this session was opened, and a stale copy would
 * erase it.
 */
import { afterEach, beforeEach, describe, expect, type Mock, mock, test } from "bun:test";
import { join } from "node:path";
import {
  type AgentSession,
  type CompactResult,
  createSessionStorage,
  type SessionMeta,
  type SessionStorage,
} from "@nathapp/nax-agent";
import { cleanupTempDir, makeLogger, makeNaxConfig, makeTempDir } from "@test/helpers";
import { createChatHost } from "@/chat";

const NOW = new Date("2026-10-01T00:00:00.000Z");
const SESSION = "compact-session";
const MODEL = "anthropic/test";

/** A compaction that spent: the summarizer call's own usage, and what it cost. */
const SPEND: CompactResult = {
  compacted: true,
  tokensBefore: 84_200,
  tokensAfter: 12_100,
  usage: { inputTokens: 900, outputTokens: 120 },
  costUsd: 0.02,
};

/** A compaction with nothing to do: no model call, so no usage and no cost. */
const NOTHING: CompactResult = {
  compacted: false,
  tokensBefore: 1_000,
  tokensAfter: 1_000,
  usage: { inputTokens: 0, outputTokens: 0 },
  costUsd: 0,
};

/** The spend the store already holds, and the spend the handle was opened with — deliberately stale. */
const STORED_COST = 0.05;
const OPENED_COST = 0.01;

let dir: string;
let storage: SessionStorage;
let writes: Mock<(meta: SessionMeta) => Promise<void>>;
const hosts: ReturnType<typeof createChatHost>[] = [];

beforeEach(async () => {
  dir = makeTempDir("chat-compact-");
  const real = createSessionStorage({
    dir: join(dir, "sessions"),
    pid: process.pid,
    now: () => NOW,
    logger: makeLogger(),
  });
  // The store's spend is ahead of the handle's: only a re-read sees it.
  await real.writeMeta(metaOf(STORED_COST));
  const written = real.writeMeta.bind(real);
  writes = mock((meta: SessionMeta) => written(meta));
  storage = { ...real, writeMeta: writes };
});

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  cleanupTempDir(dir);
});

function metaOf(costUsd: number): SessionMeta {
  return {
    schemaVersion: 1,
    sessionId: SESSION,
    cwd: "/r",
    mode: "ask",
    model: MODEL,
    bashApproval: "gated",
    title: null,
    createdAt: NOW.toISOString(),
    updatedAt: null,
    costUsd,
  };
}

const resolveWith = async (result: CompactResult): Promise<CompactResult> => result;

interface FixtureOptions {
  /** The session's own `compact`; absent answers with `SPEND` unchanged. */
  readonly compact?: AgentSession["compact"];
  /** What an absent `compact` answers, one result per call; the last one repeats. */
  readonly results?: readonly CompactResult[];
  /** False leaves a session whose facade has no `compact` at all. */
  readonly supportsCompact?: boolean;
}

function fixture(options: FixtureOptions = {}) {
  const queue = [...(options.results ?? [])];
  function answer(): Promise<CompactResult> {
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return resolveWith(next ?? SPEND);
  }
  const compact = mock(options.compact ?? answer);
  const session: AgentSession = {
    id: SESSION,
    backend: { kind: "native", capabilities: {} },
    lastTurn: undefined,
    async *send() {},
    answer: () => "accepted",
    cancel() {},
    close: async () => {},
    ...(options.supportsCompact === false ? {} : { compact }),
  };
  const host = createChatHost({
    config: makeNaxConfig({ outputDir: join(dir, "output") }),
    cwd: "/r",
    repoRoot: "/r",
    chain: null,
    storage,
    now: () => NOW,
    logger: makeLogger(),
    open: async () => ({ session, meta: metaOf(OPENED_COST), release: async () => {} }),
  });
  hosts.push(host);
  return { host, session, compact };
}

/** A host started over the stub session. */
async function started(options: FixtureOptions = {}) {
  const f = fixture(options);
  await f.host.start({ mode: "guarded", model: MODEL });
  return f;
}

/** The cost file this process's ledger writes to, whichever rows it holds. */
function costFile(): string {
  return join(dir, "output", "cost", `chat-${SESSION}-${NOW.getTime()}.jsonl`);
}

/** The rows this process's ledger persisted, parsed. */
async function rows(): Promise<Record<string, unknown>[]> {
  const text = await Bun.file(costFile()).text();
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("ChatHost.compact", () => {
  test("AC-1 returns the open session's compact result unchanged", async () => {
    const f = await started();
    expect(await f.host.compact?.()).toBe(SPEND);
    expect(f.compact).toHaveBeenCalledTimes(1);
  });

  test("AC-2 adds the result's cost to the spend in storage", async () => {
    const f = await started();
    await f.host.compact?.();
    expect((await storage.readMeta(SESSION))?.costUsd).toBeCloseTo(STORED_COST + SPEND.costUsd);
  });

  test("AC-3 reports the new spend from current()", async () => {
    const f = await started();
    await f.host.compact?.();
    expect(f.host.current().meta.costUsd).toBeCloseTo(STORED_COST + SPEND.costUsd);
  });

  test("AC-4 records one ledger row with the summarizer's own usage and cost", async () => {
    const f = await started();
    await f.host.compact?.();
    const persisted = await rows();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      stage: "chat",
      sessionRole: "tui",
      model: MODEL,
      costUsd: SPEND.costUsd,
      tokens: { input: SPEND.usage.inputTokens, output: SPEND.usage.outputTokens },
    });
  });

  test("AC-4 records the cache tokens the summarizer call reported", async () => {
    const cached: CompactResult = { ...SPEND, usage: { inputTokens: 900, outputTokens: 120, cacheReadTokens: 400 } };
    const f = await started({ compact: () => resolveWith(cached) });
    await f.host.compact?.();
    expect((await rows())[0]).toMatchObject({ tokens: { input: 900, output: 120, cacheRead: 400 } });
  });

  test("AC-5 a compaction that spent nothing writes no ledger row", async () => {
    // The spending compaction first: the "no row" assertion below would otherwise hold on a
    // ledger that never wrote anything at all.
    const f = await started({ results: [SPEND, NOTHING] });
    await f.host.compact?.();
    expect(await f.host.compact?.()).toEqual(NOTHING);
    expect(await rows()).toHaveLength(1);
  });

  test("AC-6 a compaction that spent nothing writes no metadata", async () => {
    const f = await started({ results: [SPEND, NOTHING] });
    await f.host.compact?.();
    expect(writes).toHaveBeenCalledTimes(1);
    await f.host.compact?.();
    expect(writes).toHaveBeenCalledTimes(1);
    expect((await storage.readMeta(SESSION))?.costUsd).toBeCloseTo(STORED_COST + SPEND.costUsd);
  });

  test("a rejection leaves the spend untouched and reaches the caller", async () => {
    const f = await started({
      compact: async () => {
        throw new Error("summarizer is down");
      },
    });
    await expect(f.host.compact?.()).rejects.toThrow("summarizer is down");
    expect(writes).not.toHaveBeenCalled();
    expect((await storage.readMeta(SESSION))?.costUsd).toBeCloseTo(STORED_COST);
  });

  test("a session whose facade cannot compact rejects with the capability code", async () => {
    const f = await started({ supportsCompact: false });
    await expect(f.host.compact?.()).rejects.toMatchObject({ code: "CHAT_COMPACT_UNSUPPORTED" });
    expect(writes).not.toHaveBeenCalled();
  });

  test("no open session rejects rather than compacting nothing", async () => {
    const f = fixture();
    await expect(f.host.compact?.()).rejects.toMatchObject({ code: "CHAT_SESSION_NOT_OPEN" });
    expect(f.compact).not.toHaveBeenCalled();
  });
});
