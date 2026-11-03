/**
 * US-005 — the surfaces close the memory host.
 *
 * Three surfaces own a host for a bounded time and must release it when they finish:
 * the chat's close-time sync (`createHostMemory(...).closeSync()`), the run memory's
 * `close()`, and each `nax memory` subcommand (through `withMemoryHost`). Every case
 * enters through one of those public entry points with a host whose `close` is a spy,
 * and an event log records the order of the calls that matter.
 *
 * A close that throws is a warning (chat, run) or ignored (CLI): it never changes a
 * result or an exit code. A host built by hand without `close` stays valid.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { MemoryNote, MemorySyncResult } from "@nathapp/nax-agent";
import { assertDefined, makeLogger, makeNaxConfig } from "@test/helpers";
import { createHostMemory } from "@/chat";
import {
  type MemoryCliDeps,
  memoryListCommand,
  memorySaveCommand,
  memoryShowCommand,
  memoryStatusCommand,
  withMemoryHost,
} from "@/cli";
import { _runMemoryDeps, createRunMemory, type MemoryHost, type MemoryStatus } from "@/memory";

// ─── fixtures ────────────────────────────────────────────────────────────────

const SYNCED: MemorySyncResult = { outcome: "synced", pushed: 0, rejected: 0, pulled: 0, skipped: 0 };

const STATUS: MemoryStatus = {
  enabled: true,
  provider: "local",
  writeMode: "direct",
  projectDir: "/m/projects/p",
  userDir: "/m/user",
  lastPullAt: null,
  lastError: null,
  queued: 0,
  rejected: 0,
  notes: { project: 1, user: 0, repo: 0 },
  repoSkipped: 0,
};

const NOTE: MemoryNote = {
  id: "human",
  slug: "staging-db",
  type: "project",
  scope: "project",
  description: "shared staging db",
  source: "human",
  updatedAt: "2026-11-02T08:11:00.000Z",
  status: "active",
  body: "the body",
};

interface FakeHostOptions {
  readonly events?: string[];
  /** Give the host no `close` at all (a hand-built host). */
  readonly noClose?: boolean;
  readonly syncRejects?: boolean;
  readonly closeRejects?: boolean;
  readonly over?: Partial<MemoryHost>;
}

interface FakeHost {
  readonly host: MemoryHost;
  readonly events: string[];
  /** How many times `close` was called. */
  readonly closes: () => number;
}

/** A host whose sync, close and the reads these cases drive record into one event log. */
function fakeHost(options: FakeHostOptions = {}): FakeHost {
  const events = options.events ?? [];
  let closeCalls = 0;
  const unused = async (): Promise<never> => {
    throw new Error("the host does not read this here");
  };
  const base: MemoryHost = {
    dirs: { root: "/m", projectDir: "/m/projects/p", userDir: "/m/user" },
    providerId: "local",
    writeMode: "direct",
    notes: async () => [],
    getNote: async () => NOTE,
    search: unused,
    renderIndex: async () => ({ text: "", omitted: 0 }),
    sync: async () => {
      events.push("sync");
      if (options.syncRejects === true) throw new Error("the mirror is unreachable");
      return SYNCED;
    },
    status: async () => STATUS,
    save: async (write) => ({ slug: write.slug, status: "active", delivered: true }),
    forget: unused,
    approve: unused,
    ...options.over,
  };
  const close = async (): Promise<void> => {
    closeCalls += 1;
    events.push("close");
    if (options.closeRejects === true) throw new Error("the pool would not close");
  };
  const host: MemoryHost = options.noClose === true ? base : { ...base, close };
  return { host, events, closes: () => closeCalls };
}

interface Harness {
  readonly deps: MemoryCliDeps;
  readonly out: string[];
  readonly err: string[];
}

/** The CLI deps with every external call stubbed; `log` records into `events` too. */
function harness(host: MemoryHost | null, events: string[] = []): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const deps: MemoryCliDeps = {
    log: (msg) => {
      out.push(msg);
      events.push("log");
    },
    logErr: (msg) => err.push(msg),
    exit: () => {},
    findProjectDir: () => null,
    loadConfig: async () => makeNaxConfig(),
    createMemoryHost: async () => host,
    readFile: async () => "",
  };
  return { deps, out, err };
}

// ─── chat: createHostMemory(...).closeSync() ─────────────────────────────────

describe("createHostMemory closeSync", () => {
  test("AC-1: syncs and then closes the host, in that order", async () => {
    const fake = fakeHost();
    await createHostMemory({ memory: fake.host, logger: makeLogger() }).closeSync();
    expect(fake.events).toEqual(["sync", "close"]);
  });

  test("AC-2: still closes the host when the sync rejects", async () => {
    const fake = fakeHost({ syncRejects: true });
    await createHostMemory({ memory: fake.host, logger: makeLogger() }).closeSync();
    expect(fake.events).toEqual(["sync", "close"]);
    expect(fake.closes()).toBe(1);
  });

  test("AC-3: resolves when the sync rejects", async () => {
    const fake = fakeHost({ syncRejects: true });
    await expect(createHostMemory({ memory: fake.host, logger: makeLogger() }).closeSync()).resolves.toBeUndefined();
  });

  test("AC-4: resolves when the close rejects", async () => {
    const fake = fakeHost({ closeRejects: true });
    await expect(createHostMemory({ memory: fake.host, logger: makeLogger() }).closeSync()).resolves.toBeUndefined();
  });

  test("AC-5: warns through the logger when the close rejects", async () => {
    const fake = fakeHost({ closeRejects: true });
    const logger = makeLogger();
    await createHostMemory({ memory: fake.host, logger }).closeSync();
    const warns = logger.calls.filter((call) => call.level === "warn");
    expect(warns).toHaveLength(1);
    expect(warns[0]?.stage).toBe("chat");
    expect(warns[0]?.data?.error).toBe("the pool would not close");
  });

  test("a host without close still syncs and resolves", async () => {
    const fake = fakeHost({ noClose: true });
    await createHostMemory({ memory: fake.host, logger: makeLogger() }).closeSync();
    expect(fake.events).toEqual(["sync"]);
  });
});

// ─── run: createRunMemory(...).close() ───────────────────────────────────────

describe("createRunMemory close", () => {
  const original = _runMemoryDeps.createMemoryHost;
  afterEach(() => {
    _runMemoryDeps.createMemoryHost = original;
  });

  /** The run memory over `fake`, with the start sync's event already dropped from the log. */
  async function runMemoryOver(fake: FakeHost, logger = makeLogger()) {
    _runMemoryDeps.createMemoryHost = async () => fake.host;
    const created = await createRunMemory({ config: makeNaxConfig(), repoRoot: "/repo", logger });
    assertDefined(created, "the run memory");
    fake.events.length = 0;
    return { run: created, logger };
  }

  test("AC-6: closes the host once, after the end sync", async () => {
    const fake = fakeHost();
    const { run } = await runMemoryOver(fake);
    await run.close();
    expect(fake.events).toEqual(["sync", "close"]);
    expect(fake.closes()).toBe(1);
  });

  test("AC-7: a second close does not close the host again", async () => {
    const fake = fakeHost();
    const { run } = await runMemoryOver(fake);
    await run.close();
    await run.close();
    expect(fake.closes()).toBe(1);
  });

  test("AC-8: resolves when the host's close rejects", async () => {
    const fake = fakeHost({ closeRejects: true });
    const { run } = await runMemoryOver(fake);
    await expect(run.close()).resolves.toBeUndefined();
  });

  test("AC-9: logs the summary line when the host's close rejects", async () => {
    const fake = fakeHost({ closeRejects: true });
    const { run, logger } = await runMemoryOver(fake);
    await run.close();
    const infos = logger.calls.filter((call) => call.level === "info");
    expect(infos.map((call) => call.message)).toEqual(["Memory: 0 saved (0 pending)"]);
  });

  test("AC-22: warns when the host's close rejects", async () => {
    const fake = fakeHost({ closeRejects: true });
    const { run, logger } = await runMemoryOver(fake);
    logger.reset();
    await run.close();
    const warns = logger.calls.filter((call) => call.level === "warn");
    expect(warns).toHaveLength(1);
    expect(warns[0]?.stage).toBe("run");
    expect(warns[0]?.data?.error).toBe("the pool would not close");
  });

  test("closes after the summary line is logged", async () => {
    const events: string[] = [];
    const fake = fakeHost({ events });
    const { run, logger } = await runMemoryOver(fake);
    logger.info.mockImplementation(() => {
      events.push("summary");
    });
    events.length = 0;
    await run.close();
    expect(events).toEqual(["sync", "summary", "close"]);
  });

  test("a host without close closes cleanly", async () => {
    const fake = fakeHost({ noClose: true });
    const { run } = await runMemoryOver(fake);
    await expect(run.close()).resolves.toBeUndefined();
  });
});

// ─── CLI: the subcommands and withMemoryHost ─────────────────────────────────

describe("nax memory commands close the host", () => {
  test("AC-10: status calls close once", async () => {
    const fake = fakeHost();
    await memoryStatusCommand({ dir: "/r" }, harness(fake.host).deps);
    expect(fake.closes()).toBe(1);
  });

  test("AC-11: status returns 0", async () => {
    const fake = fakeHost();
    expect(await memoryStatusCommand({ dir: "/r" }, harness(fake.host).deps)).toBe(0);
  });

  test("AC-12: list with a notes() that rejects calls close once", async () => {
    const fake = fakeHost({
      over: {
        notes: async () => {
          throw new Error("the mirror is unreadable");
        },
      },
    });
    await memoryListCommand({ dir: "/r" }, harness(fake.host).deps);
    expect(fake.closes()).toBe(1);
  });

  test("AC-13: list with a notes() that rejects returns 1", async () => {
    const fake = fakeHost({
      over: {
        notes: async () => {
          throw new Error("the mirror is unreadable");
        },
      },
    });
    const h = harness(fake.host);
    expect(await memoryListCommand({ dir: "/r" }, h.deps)).toBe(1);
    expect(h.err).toEqual(["Error: the mirror is unreadable"]);
  });

  test("AC-14: status still returns 0 when close rejects", async () => {
    const fake = fakeHost({ closeRejects: true });
    const h = harness(fake.host);
    expect(await memoryStatusCommand({ dir: "/r" }, h.deps)).toBe(0);
    expect(h.err).toEqual([]);
  });

  test("AC-15: status with memory disabled returns 0", async () => {
    const h = harness(null);
    expect(await memoryStatusCommand({ dir: "/r" }, h.deps)).toBe(0);
    expect(h.out).toEqual(["enabled: false"]);
  });

  test("AC-16: status with memory disabled makes no close call", async () => {
    const fake = fakeHost();
    const created: Array<MemoryHost | null> = [];
    const h = harness(null);
    const deps: MemoryCliDeps = {
      ...h.deps,
      createMemoryHost: async () => {
        created.push(null);
        return null;
      },
    };
    await memoryStatusCommand({ dir: "/r" }, deps);
    expect(created).toHaveLength(1);
    expect(fake.closes()).toBe(0);
  });

  test("AC-17: show closes once, after the note is written to deps.log", async () => {
    const events: string[] = [];
    const fake = fakeHost({ events });
    await memoryShowCommand("staging-db", { dir: "/r" }, harness(fake.host, events).deps);
    expect(fake.closes()).toBe(1);
    expect(events).toEqual(["log", "close"]);
  });

  test("AC-18: save closes once", async () => {
    const fake = fakeHost();
    await memorySaveCommand(
      { dir: "/r", slug: "s1", type: "project", description: "d", body: "b" },
      harness(fake.host).deps,
    );
    expect(fake.closes()).toBe(1);
  });

  test("AC-19: save returns 0", async () => {
    const fake = fakeHost();
    const code = await memorySaveCommand(
      { dir: "/r", slug: "s1", type: "project", description: "d", body: "b" },
      harness(fake.host).deps,
    );
    expect(code).toBe(0);
  });

  test("AC-23: status on a hand-built host without close returns 0", async () => {
    const fake = fakeHost({ noClose: true });
    expect(await memoryStatusCommand({ dir: "/r" }, harness(fake.host).deps)).toBe(0);
  });

  test("AC-24: status --json logs exactly JSON.stringify(status)", async () => {
    const fake = fakeHost();
    const h = harness(fake.host);
    await memoryStatusCommand({ dir: "/r", json: true }, h.deps);
    expect(h.out).toEqual([JSON.stringify(STATUS)]);
  });
});

describe("withMemoryHost", () => {
  const context = { config: makeNaxConfig(), repoRoot: "/repo" };

  test("AC-20: a run that rejects still calls close once", async () => {
    const fake = fakeHost();
    const outcome = withMemoryHost(context, harness(fake.host).deps, async () => {
      throw new Error("the body failed");
    });
    await outcome.catch(() => {});
    expect(fake.closes()).toBe(1);
  });

  test("AC-21: a run that rejects rejects with run's error", async () => {
    const fake = fakeHost();
    const failure = new Error("the body failed");
    const outcome = withMemoryHost(context, harness(fake.host).deps, async () => {
      throw failure;
    });
    await expect(outcome).rejects.toBe(failure);
  });

  test("returns run's result and hands it the opened host", async () => {
    const fake = fakeHost();
    const seen: Array<MemoryHost | null> = [];
    const result = await withMemoryHost(context, harness(fake.host).deps, async (host) => {
      seen.push(host);
      return 7;
    });
    expect(result).toBe(7);
    expect(seen).toEqual([fake.host]);
  });

  test("passes null through and calls no close", async () => {
    const seen: Array<MemoryHost | null> = [];
    const result = await withMemoryHost(context, harness(null).deps, async (host) => {
      seen.push(host);
      return 0;
    });
    expect(result).toBe(0);
    expect(seen).toEqual([null]);
  });

  test("a close that rejects does not change run's result", async () => {
    const fake = fakeHost({ closeRejects: true });
    expect(await withMemoryHost(context, harness(fake.host).deps, async () => 3)).toBe(3);
  });

  test("a close that rejects does not mask run's error", async () => {
    const fake = fakeHost({ closeRejects: true });
    const failure = new Error("the body failed");
    const outcome = withMemoryHost(context, harness(fake.host).deps, async () => {
      throw failure;
    });
    await expect(outcome).rejects.toBe(failure);
  });
});
