/**
 * run-memory.test.ts — the run memory's composition, start sync, index, counting
 * tools and close.
 *
 * Covers US-003 AC-1..AC-20: the `memory.inRun` switch (which opens no host at
 * all), the host it does open (once, with the run's own source), the two ways
 * opening can leave a run without memory (a thrown open and the disabled host's
 * `null`), the guarded start sync (one call, awaited before the run memory
 * resolves, a throw that costs the run nothing and a `locked` result that warns
 * about nothing) and `index()`, which re-renders on every call and answers
 * `undefined` rather than throwing.
 *
 * Covers US-004 AC-1..AC-14: the counting view the tools write through (a save
 * the host resolved is counted, a pending one is counted twice, a refused one is
 * not counted at all, a forget counts nothing, and the note the model wrote
 * reaches the host unchanged), the store's own refusal coming back as the tool's
 * `isError` answer, and `close()`, which syncs once more, logs the run's counts
 * exactly once, survives a failing end sync, and does none of it twice.
 *
 * The save and forget cases drive the provider's real tools rather than calling a
 * wrapper, so what is counted is what a session's `nax-memory__save` actually did.
 *
 * Everything runs through `_runMemoryDeps`, restored after each case, so the
 * composition is driven without a mirror on disk; the cases that need the real
 * composition (AC-18, AC-20) leave the seam alone. The host `renderIndex`,
 * `sync`, `save` and `forget` stubs replace one method of an otherwise real host,
 * so the thing under test is still a memory host the composition accepted.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
  MemoryForgetResult,
  MemoryNoteStatus,
  MemoryNoteWrite,
  MemorySaveResult,
  MemorySyncResult,
  ProviderTool,
  ToolResult,
} from "@nathapp/nax-agent";
import {
  assertDefined,
  cleanupTempDir,
  type LogCall,
  type MockLogger,
  makeLogger,
  makeNaxConfig,
  makeTempDir,
} from "@test/helpers";
import { NaxError } from "@/errors";
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

/** The run context a tool is handed; the memory tools read the host, not the root. */
const RUN_CONTEXT = { root: "/workspace", resolvedPaths: [], maxBytes: 300_000, maxFileBytes: 300_000 };

/** The note the save cases hand the tool, as the model writes it: no scope, so `project`. */
const REPLAY_BUDGET_INPUT = {
  slug: "replay-budget",
  type: "project",
  description: "replay budget",
  body: "2048 MiB",
};

/** What the host answers a forget of a note a case stubs the write for. */
const FORGET_RESULT: MemoryForgetResult = { slug: "replay-budget", status: "deleted", delivered: true };

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

  /** Every `info` this case's logger has been given, in order. */
  function infos(): readonly LogCall[] {
    return logger.calls.filter((call) => call.level === "info");
  }

  /** The host's answer to one save: a complete result, of which the ACs name the status. */
  function saveResult(slug: string, status: MemoryNoteStatus): MemorySaveResult {
    return { slug, status, delivered: true };
  }

  /** The two statuses a save answers with, in the order the saves are made. */
  function statusQueue(): () => MemoryNoteStatus {
    const statuses: MemoryNoteStatus[] = ["active", "pending"];
    return () => statuses.shift() ?? "active";
  }

  /** One of the run memory's own tools, run as a run-stage session runs it. */
  async function runTool(memory: RunMemory, name: string, input: Record<string, unknown>): Promise<ToolResult> {
    const tool = (await memory.provider.tools(repoRoot)).find((candidate) => candidate.localName === name);
    assertDefined(tool, `the ${name} tool`);
    return tool.run(input, RUN_CONTEXT);
  }

  /** The refusal the store answers a save it will not take: feature 1's own error. */
  function refusedSave(): never {
    throw new NaxError("secret (aws) must not be stored", "MEMORY_WRITE_REFUSED", { stage: "memory" });
  }

  /**
   * A run memory whose start sync resolves and whose close-time sync throws.
   *
   * The start sync has to succeed for the warn under test to be the close's own:
   * a start that threw would leave the same line behind, and the case could not
   * tell which sync produced it.
   */
  async function memoryWithFailingEndSync(error: Error): Promise<RunMemory> {
    let syncs = 0;
    return await runMemory({
      sync: async () => {
        syncs += 1;
        if (syncs > 1) throw error;
        return SYNCED;
      },
    });
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

  describe("the save counter", () => {
    test("counts one save the host resolved active", async () => {
      const memory = await runMemory({ save: async (write) => saveResult(write.slug, "active") });

      await runTool(memory, "save", REPLAY_BUDGET_INPUT);

      expect(memory.summary()).toEqual({ saved: 1, pending: 0 });
    });

    test("counts a pending save as both saved and pending", async () => {
      const memory = await runMemory({ save: async (write) => saveResult(write.slug, "pending") });

      await runTool(memory, "save", REPLAY_BUDGET_INPUT);

      expect(memory.summary()).toEqual({ saved: 1, pending: 1 });
    });

    test("counts nothing for a save the store refused", async () => {
      const memory = await runMemory({ save: async () => refusedSave() });

      await runTool(memory, "save", REPLAY_BUDGET_INPUT);

      expect(memory.summary()).toEqual({ saved: 0, pending: 0 });
    });

    test("does not count a refusal after a save the store took", async () => {
      let saves = 0;
      const memory = await runMemory({
        save: async (write) => {
          saves += 1;
          if (saves > 1) return refusedSave();
          return saveResult(write.slug, "active");
        },
      });
      await runTool(memory, "save", REPLAY_BUDGET_INPUT);

      await runTool(memory, "save", { ...REPLAY_BUDGET_INPUT, slug: "replay-window" });

      expect(memory.summary()).toEqual({ saved: 1, pending: 0 });
    });

    test("leaves the counts alone when a forget runs", async () => {
      const nextStatus = statusQueue();
      const memory = await runMemory({
        save: async (write) => saveResult(write.slug, nextStatus()),
        forget: async () => FORGET_RESULT,
      });
      await runTool(memory, "save", REPLAY_BUDGET_INPUT);
      await runTool(memory, "save", { ...REPLAY_BUDGET_INPUT, slug: "replay-window" });

      const before = memory.summary();
      const forgotten = await runTool(memory, "forget", { slug: "replay-budget", reason: "stale" });

      expect({ before, forgotten, after: memory.summary() }).toEqual({
        before: { saved: 2, pending: 1 },
        forgotten: { content: JSON.stringify(FORGET_RESULT) },
        after: { saved: 2, pending: 1 },
      });
    });

    test("hands the host the note the model wrote", async () => {
      const writes: MemoryNoteWrite[] = [];
      const memory = await runMemory({
        save: async (write) => {
          writes.push(write);
          return saveResult(write.slug, "active");
        },
      });

      await runTool(memory, "save", REPLAY_BUDGET_INPUT);

      expect(writes).toHaveLength(1);
      const write = writes[0];
      assertDefined(write, "the write the host's save got");
      expect({
        slug: write.slug,
        type: write.type,
        description: write.description,
        body: write.body,
      }).toEqual({
        slug: "replay-budget",
        type: "project",
        description: "replay budget",
        body: "2048 MiB",
      });
    });

    test("answers the store's refusal as the tool's own error", async () => {
      const memory = await runMemory({ save: async () => refusedSave() });

      const result = await runTool(memory, "save", REPLAY_BUDGET_INPUT);

      expect(result).toEqual({ isError: true, content: "[memory] save refused: secret (aws) must not be stored" });
    });
  });

  describe("close", () => {
    test("syncs the host once more", async () => {
      let syncs = 0;
      const memory = await runMemory({
        sync: async () => {
          syncs += 1;
          return SYNCED;
        },
      });

      await memory.close();

      expect(syncs).toBe(2);
    });

    test("logs the counts of one active and one pending save", async () => {
      const nextStatus = statusQueue();
      const memory = await runMemory({
        sync: async () => SYNCED,
        save: async (write) => saveResult(write.slug, nextStatus()),
      });
      await runTool(memory, "save", REPLAY_BUDGET_INPUT);
      await runTool(memory, "save", { ...REPLAY_BUDGET_INPUT, slug: "replay-window" });

      await memory.close();

      expect(infos()).toEqual([
        {
          level: "info",
          stage: "run",
          message: "Memory: 2 saved (1 pending)",
          data: { storyId: "_run", saved: 2, pending: 1 },
        },
      ]);
    });

    test("logs the counts of a run that saved nothing", async () => {
      const memory = await runMemory({ sync: async () => SYNCED });

      await memory.close();

      expect(infos()).toEqual([
        {
          level: "info",
          stage: "run",
          message: "Memory: 0 saved (0 pending)",
          data: { storyId: "_run", saved: 0, pending: 0 },
        },
      ]);
    });

    test("resolves when the end sync throws", async () => {
      const memory = await memoryWithFailingEndSync(new Error("down"));

      await expect(memory.close()).resolves.toBeUndefined();
    });

    test("warns that the end sync failed", async () => {
      const memory = await memoryWithFailingEndSync(new Error("down"));

      await memory.close();

      expect(warns()).toEqual([
        { level: "warn", stage: "run", message: "memory sync failed", data: { storyId: "_run", error: "down" } },
      ]);
    });

    test("logs the counts even when the end sync throws", async () => {
      const memory = await memoryWithFailingEndSync(new Error("down"));

      await memory.close();

      expect(infos().map((call) => call.message)).toEqual(["Memory: 0 saved (0 pending)"]);
    });

    test("does not sync again on a second call", async () => {
      let syncs = 0;
      const memory = await runMemory({
        sync: async () => {
          syncs += 1;
          return SYNCED;
        },
      });

      await memory.close();
      await memory.close();

      expect(syncs).toBe(2);
    });

    test("logs no second summary on a second call", async () => {
      const memory = await runMemory({ sync: async () => SYNCED });

      await memory.close();
      await memory.close();

      expect(infos().map((call) => call.message)).toEqual(["Memory: 0 saved (0 pending)"]);
    });

    test("syncs once when two closes overlap", async () => {
      let syncs = 0;
      const memory = await runMemory({
        sync: async () => {
          syncs += 1;
          return SYNCED;
        },
      });

      await Promise.all([memory.close(), memory.close()]);

      expect(syncs).toBe(2);
    });

    // Branch fix M5: the guard used to be a boolean set before the sync, so a second close
    // resolved immediately while the first was still syncing. `runtime.close()` can be reached
    // from a signal handler and a normal exit, and the normal-exit caller may proceed — and the
    // process may exit — while the end sync is still running. Awaiting the close in flight is
    // what makes "close() is done" mean the same thing to both callers.
    test("a close that starts while the first is running waits for that same close", async () => {
      let openGate = (): void => undefined;
      const gate = new Promise<void>((resolve) => {
        openGate = resolve;
      });
      let endSyncStarted = (): void => undefined;
      const inFlight = new Promise<void>((resolve) => {
        endSyncStarted = resolve;
      });
      let syncs = 0;
      const memory = await runMemory({
        sync: async () => {
          syncs += 1;
          if (syncs > 1) {
            endSyncStarted();
            await gate;
          }
          return SYNCED;
        },
      });

      const first = memory.close();
      await inFlight;
      let secondResolved = false;
      const second = memory.close().then(() => {
        secondResolved = true;
      });
      // One microtask turn is enough for a promise that was already resolved to report in.
      await Promise.resolve();

      expect({ secondResolved, syncs }).toEqual({ secondResolved: false, syncs: 2 });

      openGate();
      await Promise.all([first, second]);

      expect({ secondResolved, syncs }).toEqual({ secondResolved: true, syncs: 2 });
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
