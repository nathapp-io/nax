/**
 * runtime-memory.test.ts — the runtime carries a run's memory and closes it.
 *
 * Covers US-005 AC-1..AC-11: the runtime holds the run memory it was handed and has
 * no `memory` key at all when it was handed none, advertises that memory's provider
 * after every existing provider (MCP, then skills), leaves the provider list exactly
 * as it was when a run has no memory, and closes the run memory once — a second
 * `close()` stays the idempotent no-op it already was.
 *
 * The close cases are about the order teardown happens in: `runtime.close()` waits
 * for a pending `memory.close()` rather than resolving past it, still reaches that
 * close when an earlier step of teardown rejects (the MCP pool, whose rejection is
 * preserved), and resolves when the run memory's own end-of-run sync fails — that
 * failure is the run memory's to absorb, per its contract.
 *
 * Every runtime here comes from the real `createRuntime`. The run memory is a fake
 * carrier (the runtime never reads `host`) except in AC-11, which composes the real
 * run memory over a host whose second sync throws, so the guard exercised there is
 * the one production runs.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { MemorySyncResult, ToolProvider } from "@nathapp/nax-agent";
import { assertDefined, makeLogger, makeNaxConfig } from "@test/helpers";
import { type NaxConfig, NaxConfigSchema } from "@/config";
import { _runMemoryDeps, createRunMemory, type MemoryHost, type RunMemory } from "@/memory";
import { type CreateRuntimeOptions, createRuntime, type NaxRuntime } from "@/runtime";

/** The repository the runtimes are created against; no mirror is ever resolved from it. */
const WORKDIR = "/repo";

/** A sync that held the lock and moved nothing: what a quiet run reports. */
const SYNCED: MemorySyncResult = { outcome: "synced", pushed: 0, rejected: 0, pulled: 0, skipped: 0 };

/** The provider a run memory hands over: the real id and the run stage, no tools. */
const MEMORY_PROVIDER: ToolProvider = {
  id: "nax-memory",
  kind: "static",
  stages: ["run"],
  tools: async () => [],
};

/** The runtimes a case created, torn down by the teardown below. */
const runtimes: NaxRuntime[] = [];

/**
 * A memory host a fake run memory can carry.
 *
 * The runtime never reads a run memory's host — it only appends the provider and
 * calls `close()` — so every read here refuses loudly rather than answering
 * something a case could mistake for behaviour under test.
 */
function fakeHost(): MemoryHost {
  const unused = async (): Promise<never> => {
    throw new Error("the runtime never reads a run memory's host");
  };
  return {
    dirs: { root: "/mem", projectDir: "/mem/project", userDir: "/mem/user" },
    providerId: "local",
    writeMode: "direct",
    notes: unused,
    getNote: unused,
    search: unused,
    renderIndex: unused,
    sync: unused,
    status: unused,
    save: unused,
    forget: unused,
    approve: unused,
  };
}

/** A fake run memory and the count of its closes, which is what the close cases measure. */
interface FakeMemory {
  readonly memory: RunMemory;
  closes(): number;
}

/**
 * A run memory the runtime can carry, with `close` counted.
 *
 * `closing` lets a case hold the close open or make it do something observable; the
 * count is taken before it runs, so a case measures the call rather than the body.
 */
function fakeMemory(closing?: () => Promise<void>): FakeMemory {
  let closes = 0;
  return {
    memory: {
      host: fakeHost(),
      provider: MEMORY_PROVIDER,
      index: async () => undefined,
      summary: () => ({ saved: 0, pending: 0 }),
      close: async () => {
        closes += 1;
        await closing?.();
      },
    },
    closes: () => closes,
  };
}

/** A promise plus the one call that settles it: how a case holds a close open. */
function latch(): { promise: Promise<void>; open: () => void } {
  let settle: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { promise, open: () => settle?.() };
}

/** The config every provider-order case shares: one MCP server, exported by the schema. */
function configWithMcp(skillsInRun = false): NaxConfig {
  const parsed = NaxConfigSchema.parse({ mcp: { servers: { first: { command: "fake" } } } });
  return { ...makeNaxConfig({ resources: { skillsInRun } }), mcp: parsed.mcp };
}

/** Create a runtime, tracked for the teardown below. */
function runtime(opts?: CreateRuntimeOptions, config: NaxConfig = makeNaxConfig()): NaxRuntime {
  const created = createRuntime(config, WORKDIR, opts);
  runtimes.push(created);
  return created;
}

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map((created) => created.close()));
});

describe("createRuntime memory carrier", () => {
  test("AC-1 the runtime holds the run memory it was given", () => {
    const { memory } = fakeMemory();

    expect(runtime({ memory }).memory).toBe(memory);
  });

  test("AC-2 a runtime created without a run memory has no memory key", () => {
    const created = runtime();

    expect(created.memory).toBeUndefined();
    expect("memory" in created).toBe(false);
  });

  test("AC-10 CreateRuntimeOptions from @/runtime carries memory through the public path", () => {
    const { memory } = fakeMemory();
    const options: CreateRuntimeOptions = { memory };

    expect(runtime(options).memory).toBe(memory);
  });
});

describe("createRuntime memory provider", () => {
  test("AC-3 the memory provider is the last entry, after every enabled provider", () => {
    const { memory } = fakeMemory();
    const created = runtime({ memory }, configWithMcp());

    expect(created.toolProviders.at(-1)).toBe(memory.provider);
    expect(created.toolProviders.map((p) => p.id)).toEqual(["first", "nax-memory"]);
  });

  test("AC-4 with skills in the run, the ids end nax-skills then nax-memory", () => {
    const { memory } = fakeMemory();
    const created = runtime({ memory }, configWithMcp(true));
    const ids = created.toolProviders.map((p) => p.id);

    expect(ids.slice(-2)).toEqual(["nax-skills", "nax-memory"]);
    expect(ids).toEqual(["first", "nax-skills", "nax-memory"]);
  });

  test("AC-5 without a run memory the ids are unchanged — no nax-memory", () => {
    const created = runtime(undefined, configWithMcp(true));
    const ids = created.toolProviders.map((p) => p.id);

    expect(ids).toEqual(["first", "nax-skills"]);
    expect(ids).not.toContain("nax-memory");
  });
});

describe("runtime.close() and the run memory", () => {
  test("AC-6 close() calls the run memory's close exactly once", async () => {
    const fake = fakeMemory();
    const created = runtime({ memory: fake.memory });

    await created.close();

    expect(fake.closes()).toBe(1);
  });

  test("AC-7 a second close() does not close the run memory again", async () => {
    const fake = fakeMemory();
    const created = runtime({ memory: fake.memory });

    await created.close();
    await created.close();

    expect(fake.closes()).toBe(1);
  });

  test("AC-8 close() does not resolve while the run memory's close is pending", async () => {
    const entered = latch();
    const gate = latch();
    const fake = fakeMemory(async () => {
      entered.open();
      await gate.promise;
    });
    const created = runtime({ memory: fake.memory });
    let resolved = false;

    const closing = created.close().then(() => {
      resolved = true;
    });

    await entered.promise;
    expect(resolved).toBe(false);
    gate.open();
    await closing;
    expect(resolved).toBe(true);
  });

  test("AC-9 a rejecting MCP close still closes the run memory once", async () => {
    const fake = fakeMemory();
    const created = runtime({ memory: fake.memory });
    created.mcpPool.close = async () => {
      throw new Error("mcp down");
    };

    await expect(created.close()).rejects.toThrow("mcp down");

    expect(fake.closes()).toBe(1);
  });

  test("AC-11 a failing end-of-run sync leaves runtime.close() resolving", async () => {
    const logger = makeLogger();
    const original = _runMemoryDeps.createMemoryHost;
    let syncs = 0;
    _runMemoryDeps.createMemoryHost = async () => ({
      ...fakeHost(),
      sync: async () => {
        syncs += 1;
        if (syncs > 1) throw new Error("down");
        return SYNCED;
      },
    });

    try {
      const memory = await createRunMemory({ config: makeNaxConfig(), repoRoot: WORKDIR, logger });
      assertDefined(memory, "the run memory");
      const created = runtime({ memory });

      await created.close();

      expect(syncs).toBe(2);
      expect(logger.calls.some((call) => call.level === "warn" && call.message === "memory sync failed")).toBe(true);
    } finally {
      _runMemoryDeps.createMemoryHost = original;
    }
  });
});
