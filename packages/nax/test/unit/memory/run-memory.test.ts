/**
 * run-memory.test.ts — the run memory's composition, start sync and index.
 *
 * Covers US-003 AC-1..AC-20: the `memory.inRun` switch (which opens no host at
 * all), the host it does open (once, with the run's own source), the two ways
 * opening can leave a run without memory (a thrown open and the disabled host's
 * `null`), the guarded start sync (one call, awaited before the run memory
 * resolves, a throw that costs the run nothing and a `locked` result that warns
 * about nothing) and `index()`, which re-renders on every call and answers
 * `undefined` rather than throwing.
 *
 * `provider`, `summary()` and `close()` carry the shapes US-004 completes; this
 * file asserts only the provider's identity, its stage list and the tools a
 * session is handed — read off a real host over temp directories, exactly as the
 * run will read them.
 *
 * Everything runs through `_runMemoryDeps`, restored after each case, so the
 * composition is driven without a mirror on disk; the cases that need the real
 * composition (AC-18, AC-20) leave the seam alone. The host `renderIndex` and
 * `sync` stubs replace one method of an otherwise real host, so the thing under
 * test is still a memory host the composition accepted.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { MemorySyncResult, ProviderTool } from "@nathapp/nax-agent";
import {
  assertDefined,
  cleanupTempDir,
  type LogCall,
  type MockLogger,
  makeLogger,
  makeNaxConfig,
  makeTempDir,
} from "@test/helpers";
import {
  _memoryHostDeps,
  _runMemoryDeps,
  type CreateMemoryHostInput,
  createMemoryHost,
  createRunMemory,
  type MemoryHost,
  RUN_MEMORY_SOURCE,
  RUN_MEMORY_TOOL_STAGES,
  type RunMemory,
} from "@/memory";

/** A sync that held the lock and moved nothing: what a quiet run reports. */
const SYNCED: MemorySyncResult = { outcome: "synced", pushed: 0, rejected: 0, pulled: 0, skipped: 0 };

/** A sync another holder locked out: a result the composition must not warn about. */
const LOCKED: MemorySyncResult = { outcome: "locked", pushed: 0, rejected: 0, pulled: 0, skipped: 0 };

/** The four tool names the `nax-memory` provider advertises, in the order a session reads them. */
const TOOL_NAMES = ["get", "search", "save", "forget"];

describe("createRunMemory", () => {
  let globalDir: string;
  let repoRoot: string;
  let logger: MockLogger;
  let savedGlobalEnv: string | undefined;
  let originalDeps: typeof _runMemoryDeps;
  let originalHostDeps: typeof _memoryHostDeps;

  /**
   * The real host over this case's temp mirror, with whatever the case replaces.
   *
   * Only the method a case is about is swapped; every other read still goes to the
   * store the composition built, so the object handed back is a host, not a stub
   * standing in for one.
   */
  async function openHost(overrides: Partial<MemoryHost> = {}): Promise<MemoryHost> {
    const created = await createMemoryHost({ config: makeNaxConfig(), repoRoot, source: RUN_MEMORY_SOURCE, logger });
    assertDefined(created, "the memory host");
    return { ...created, ...overrides };
  }

  /** Serve `host` from the composition seam, and answer the opens it recorded. */
  function serve(host: MemoryHost | null): CreateMemoryHostInput[] {
    const calls: CreateMemoryHostInput[] = [];
    _runMemoryDeps.createMemoryHost = async (input) => {
      calls.push(input);
      return host;
    };
    return calls;
  }

  /** The run memory for this case, composed over `overrides` on a real host. */
  async function runMemory(overrides: Partial<MemoryHost> = {}): Promise<RunMemory> {
    serve(await openHost(overrides));
    const created = await createRunMemory({ config: makeNaxConfig(), repoRoot, logger });
    assertDefined(created, "the run memory");
    return created;
  }

  /** Every `warn` this case's logger has been given, in order. */
  function warns(): readonly LogCall[] {
    return logger.calls.filter((call) => call.level === "warn");
  }

  beforeEach(() => {
    globalDir = makeTempDir("nax-run-memory-global-");
    repoRoot = makeTempDir("nax-run-memory-repo-");
    logger = makeLogger();
    savedGlobalEnv = process.env.NAX_GLOBAL_CONFIG_DIR;
    process.env.NAX_GLOBAL_CONFIG_DIR = globalDir;
    originalDeps = { ..._runMemoryDeps };
    originalHostDeps = { ..._memoryHostDeps };
  });

  afterEach(() => {
    _runMemoryDeps.createMemoryHost = originalDeps.createMemoryHost;
    _memoryHostDeps.syncMemory = originalHostDeps.syncMemory;
    if (savedGlobalEnv === undefined) {
      delete process.env.NAX_GLOBAL_CONFIG_DIR;
    } else {
      process.env.NAX_GLOBAL_CONFIG_DIR = savedGlobalEnv;
    }
    cleanupTempDir(globalDir);
    cleanupTempDir(repoRoot);
  });

  test("returns undefined without opening a host when memory.inRun is false", async () => {
    const calls = serve(null);

    const created = await createRunMemory({
      config: makeNaxConfig({ memory: { inRun: false } }),
      repoRoot,
      logger,
    });

    expect(created).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  test("names the run's own note source", () => {
    expect(RUN_MEMORY_SOURCE).toBe("nax-run");
  });

  test("opens the host once with the run's source and its own input", async () => {
    const calls = serve(await openHost());
    const config = makeNaxConfig();

    await createRunMemory({ config, repoRoot, logger });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.config).toBe(config);
    expect(calls[0]?.repoRoot).toBe(repoRoot);
    expect(calls[0]?.source).toBe(RUN_MEMORY_SOURCE);
    expect(calls[0]?.logger).toBe(logger);
  });

  test("returns undefined when the host composes nothing", async () => {
    serve(null);

    const created = await createRunMemory({ config: makeNaxConfig(), repoRoot, logger });

    expect(created).toBeUndefined();
  });

  test("resolves undefined when opening the host throws", async () => {
    _runMemoryDeps.createMemoryHost = async () => {
      throw new Error("boom");
    };

    const created = await createRunMemory({ config: makeNaxConfig(), repoRoot, logger });

    expect(created).toBeUndefined();
  });

  test("warns that memory is unavailable when opening the host throws", async () => {
    _runMemoryDeps.createMemoryHost = async () => {
      throw new Error("boom");
    };

    await createRunMemory({ config: makeNaxConfig(), repoRoot, logger });

    expect(warns()).toEqual([
      { level: "warn", stage: "run", message: "memory unavailable", data: { storyId: "_run", error: "boom" } },
    ]);
  });

  test("syncs the host exactly once", async () => {
    let syncs = 0;
    serve(
      await openHost({
        sync: async () => {
          syncs += 1;
          return SYNCED;
        },
      }),
    );

    await createRunMemory({ config: makeNaxConfig(), repoRoot, logger });

    expect(syncs).toBe(1);
  });

  test("resolves only after the host's sync settles", async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = (): void => undefined;
    const inFlight = new Promise<void>((resolve) => {
      started = resolve;
    });
    const host = await openHost({
      sync: async () => {
        started();
        await gate;
        return SYNCED;
      },
    });
    serve(host);
    let created: RunMemory | undefined;

    const pending = createRunMemory({ config: makeNaxConfig(), repoRoot, logger }).then((memory) => {
      created = memory;
    });
    await inFlight;

    expect(created).toBeUndefined();

    release();
    await pending;
    expect(created?.host).toBe(host);
  });

  test("returns the run memory even when the start sync throws", async () => {
    const host = await openHost({
      sync: async () => {
        throw new Error("down");
      },
    });
    serve(host);

    const created = await createRunMemory({ config: makeNaxConfig(), repoRoot, logger });

    assertDefined(created, "the run memory");
    expect(created.host).toBe(host);
  });

  test("warns that the start sync failed when it throws", async () => {
    serve(
      await openHost({
        sync: async () => {
          throw new Error("down");
        },
      }),
    );

    await createRunMemory({ config: makeNaxConfig(), repoRoot, logger });

    expect(warns()).toEqual([
      { level: "warn", stage: "run", message: "memory sync failed", data: { storyId: "_run", error: "down" } },
    ]);
  });

  test("warns about nothing when the start sync is locked out", async () => {
    serve(await openHost({ sync: async () => LOCKED }));

    const created = await createRunMemory({ config: makeNaxConfig(), repoRoot, logger });

    assertDefined(created, "the run memory");
    expect(warns()).toEqual([]);
  });

  test("renders the index the host rendered", async () => {
    const memory = await runMemory({ renderIndex: async () => ({ text: "## Memory\n- a note", omitted: 0 }) });

    expect(await memory.index()).toBe("## Memory\n- a note");
  });

  test("renders the index again on every call", async () => {
    let renders = 0;
    const memory = await runMemory({
      renderIndex: async () => {
        renders += 1;
        return { text: `render ${renders}`, omitted: 0 };
      },
    });

    const first = await memory.index();
    const second = await memory.index();

    expect({ first, second, renders }).toEqual({ first: "render 1", second: "render 2", renders: 2 });
  });

  test("resolves undefined for an index with no text", async () => {
    const memory = await runMemory({ renderIndex: async () => ({ text: "", omitted: 0 }) });

    expect(await memory.index()).toBeUndefined();
  });

  test("resolves undefined when rendering the index throws", async () => {
    const memory = await runMemory({
      renderIndex: async () => {
        throw new Error("bad");
      },
    });

    expect(await memory.index()).toBeUndefined();
  });

  test("warns that the index is unavailable when rendering throws", async () => {
    const memory = await runMemory({
      renderIndex: async () => {
        throw new Error("bad");
      },
    });

    await memory.index();

    expect(warns()).toEqual([
      { level: "warn", stage: "run", message: "memory index unavailable", data: { storyId: "_run", error: "bad" } },
    ]);
  });

  test("carries the nax-memory provider", async () => {
    const memory = await runMemory();

    expect({ id: memory.provider.id, kind: memory.provider.kind }).toEqual({ id: "nax-memory", kind: "static" });
  });

  test("attaches the provider to the run stage alone", async () => {
    const memory = await runMemory();

    expect(memory.provider.stages).toEqual(["run"]);
  });

  test("hands the run the four memory tools, in order", async () => {
    _memoryHostDeps.syncMemory = async () => SYNCED;

    const memory = await createRunMemory({ config: makeNaxConfig(), repoRoot, logger });

    assertDefined(memory, "the run memory");
    const tools: readonly ProviderTool[] = await memory.provider.tools(repoRoot);
    expect(tools.map((tool) => tool.localName)).toEqual(TOOL_NAMES);
  });

  test("counts no saves for a run that saved nothing, and closes cleanly", async () => {
    const memory = await runMemory({ sync: async () => SYNCED });

    const before = memory.summary();
    await memory.close();

    expect({ before, after: memory.summary() }).toEqual({
      before: { saved: 0, pending: 0 },
      after: { saved: 0, pending: 0 },
    });
  });

  test("is exported from the memory barrel with its stage list", () => {
    expect({ createRunMemory: typeof createRunMemory, stages: RUN_MEMORY_TOOL_STAGES }).toEqual({
      createRunMemory: "function",
      stages: ["run"],
    });
  });

  test("returns undefined when memory is disabled", async () => {
    const created = await createRunMemory({
      config: makeNaxConfig({ memory: { enabled: false, inRun: true } }),
      repoRoot,
      logger,
    });

    expect(created).toBeUndefined();
  });
});
