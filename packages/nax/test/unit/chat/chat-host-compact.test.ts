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
import { assertDefined, cleanupTempDir, makeLogger, makeNaxConfig, makeTempDir } from "@test/helpers";
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
/** Every metadata read and write asked of the store, in order. */
let log: string[];
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
  log = [];
  const written = real.writeMeta.bind(real);
  const read = real.readMeta.bind(real);
  writes = mock((meta: SessionMeta) => written(meta));
  // Every metadata read and write, in the order they were asked for: the accounting's
  // correctness is an ordering property, so a test can assert the order itself.
  storage = {
    ...real,
    readMeta: async (sessionId: string) => {
      log.push("read");
      return read(sessionId);
    },
    writeMeta: async (meta: SessionMeta) => {
      log.push("write");
      await writes(meta);
    },
  };
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

/** What a turn in the stub session costs. */
const TURN_COST = 0.03;

interface FixtureOptions {
  /** The session's own `compact`; absent answers with `SPEND` unchanged. */
  readonly compact?: AgentSession["compact"];
  /** What an absent `compact` answers, one result per call; the last one repeats. */
  readonly results?: readonly CompactResult[];
  /** False leaves a session whose facade has no `compact` at all. */
  readonly supportsCompact?: boolean;
  /** True parks the turn inside its stream until the case calls `releaseTurn()`. */
  readonly holdSend?: boolean;
}

interface OpenRequest {
  readonly mode?: string;
  readonly model?: string;
  readonly resumeId?: string;
}

function fixture(options: FixtureOptions = {}) {
  const queue = [...(options.results ?? [])];
  function answer(): Promise<CompactResult> {
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return resolveWith(next ?? SPEND);
  }
  const compact = mock(options.compact ?? answer);
  /** The parked turns of a `holdSend` fixture, released one at a time. */
  const parked: Array<() => void> = [];
  const session: AgentSession = {
    id: SESSION,
    backend: { kind: "native", capabilities: {} },
    lastTurn: undefined,
    // One clean turn that spent `TURN_COST`: enough for the host's own accounting to run.
    async *send() {
      const base = { sessionId: SESSION, turnId: "turn-1", at: NOW.toISOString(), metadata: {} };
      yield { ...base, type: "turn_start" as const };
      if (options.holdSend === true) {
        const gate = Promise.withResolvers<void>();
        parked.push(() => gate.resolve());
        await gate.promise;
      }
      yield {
        ...base,
        type: "turn_end" as const,
        status: "completed" as const,
        output: "done",
        usage: { inputTokens: 10, outputTokens: 5 },
        costUsd: TURN_COST,
      };
    },
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
    // Mirrors the real opener: a resume carries the stored metadata forward, a fresh open
    // starts from the opener's copy, and both take the requested mode.
    open: async (request: OpenRequest) => {
      const stored = request.resumeId === undefined ? null : await storage.readMeta(request.resumeId);
      const base = stored ?? metaOf(OPENED_COST);
      return {
        session,
        meta: { ...base, mode: request.mode === "full" ? "full" : "ask", model: request.model ?? MODEL },
        release: async () => {},
      };
    },
  });
  hosts.push(host);
  return {
    host,
    session,
    compact,
    /** Release the turn parked inside its stream, once. */
    releaseTurn: () => parked.shift()?.(),
    parked,
  };
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

/** The microtasks a queued operation's `await`s run, with no wall-clock wait. */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 10; turn++) await Promise.resolve();
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

  test("AC-2 AC-3 two overlapping compactions both count", async () => {
    const f = await started();
    const compact = f.host.compact;
    assertDefined(compact, "the host's compact");
    // Issued together: the facade releases its claim when the summarizer settles, so the
    // second compaction's accounting can start before the first one has written.
    const [first, second] = await Promise.all([compact.call(f.host), compact.call(f.host)]);
    // The order the accounting ran in, taken before this test's own reads join the log.
    const order = [...log];
    expect(first).toEqual(SPEND);
    expect(second).toEqual(SPEND);
    expect(await rows()).toHaveLength(2);
    // Neither write may be based on a read taken before the other wrote.
    expect((await storage.readMeta(SESSION))?.costUsd).toBeCloseTo(STORED_COST + 2 * SPEND.costUsd);
    expect(f.host.current().meta.costUsd).toBeCloseTo(STORED_COST + 2 * SPEND.costUsd);
    expect(order).toEqual(["read", "write", "read", "write"]);
  });

  test("AC-2 AC-3 a turn queued behind a compaction's accounting counts both", async () => {
    const f = await started();
    const compact = f.host.compact;
    assertDefined(compact, "the host's compact");
    const compacting = compact.call(f.host);
    // Let the compaction reach its queued accounting: the store's read is under way, so the
    // turn that follows asks for the same slot from behind it.
    await flush();
    expect(log).toEqual(["read"]);
    await f.host.send("hi", () => {});
    expect(await compacting).toEqual(SPEND);
    const total = STORED_COST + SPEND.costUsd + TURN_COST;
    expect((await storage.readMeta(SESSION))?.costUsd).toBeCloseTo(total);
    expect(f.host.current().meta.costUsd).toBeCloseTo(total);
  });

  test("AC-3 a same-session switch during a turn keeps switched settings and refreshes accounting", async () => {
    const f = await started({ holdSend: true });
    const model = "anthropic/switched";
    const sending = f.host.send("hi", () => {});
    // The turn is parked inside its stream, so the switch lands while it is in flight — and
    // on the same session id, which is what the earlier session-id rule could not tell apart.
    await flush();
    expect(f.parked).toHaveLength(1);
    await f.host.switchTo({ mode: "full", model });
    expect(f.host.current()).toMatchObject({ mode: "full", model, meta: { sessionId: SESSION } });
    f.releaseTurn();
    await sending;
    // Keep the switched settings, but reflect the completed turn's persisted spend and title.
    expect(f.host.current()).toMatchObject({ mode: "full", model });
    const stored = await storage.readMeta(SESSION);
    assertDefined(stored, "the completed turn's metadata");
    expect(stored.costUsd).toBeCloseTo(STORED_COST + TURN_COST);
    expect(f.host.current().meta.costUsd).toBeCloseTo(stored.costUsd ?? 0);
    expect(f.host.current().meta).toMatchObject({ title: "hi", updatedAt: NOW.toISOString() });
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
