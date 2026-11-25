/**
 * run-memory-close.test.ts — what a run's memory says about a full index at close (US-019).
 *
 * `run-memory.test.ts` covers the composition, the counting view the tools write
 * through and the close lifecycle. This file is the report those counts feed: a
 * save the store refused because the rendered index had no room (`MEMORY_FULL`) is
 * counted as a refusal rather than as a save, and `close()` says so — and says how
 * full the index is — without ever compacting anything. `nax run` never runs a
 * compaction, so the nearly-full line is an instruction to the person, not a call.
 *
 * Split from the sibling file by concern: that one is already at its size target,
 * and the close report is a describe block of its own.
 *
 * Everything runs through `_runMemoryDeps` (restored after each case) over a real
 * host composed on this case's temp mirror, with only the method a case is about
 * replaced — so what is counted is what a session's `nax-memory__save` did.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
  MemoryNoteStatus,
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
import type { NaxConfig } from "@/config";
import { NaxError } from "@/errors";
import {
  _runMemoryDeps,
  type CreateMemoryHostInput,
  createMemoryHost,
  createRunMemory,
  type MemoryHost,
  RUN_MEMORY_SOURCE,
  type RunMemory,
} from "@/memory";

/** A sync that held the lock and moved nothing: what a quiet run reports. */
const SYNCED: MemorySyncResult = { outcome: "synced", pushed: 0, rejected: 0, pulled: 0, skipped: 0 };

/** The run context a tool is handed; the memory tools read the host, not the root. */
const RUN_CONTEXT = { root: "/workspace", resolvedPaths: [], maxBytes: 300_000, maxFileBytes: 300_000 };

/** The note the save cases hand the tool, as the model writes it: no scope, so `project`. */
const REPLAY_BUDGET_INPUT = { slug: "replay-budget", type: "project", description: "replay budget", body: "2048 MiB" };

/** The project every line of this file names, so the run line can be spelled out in full. */
const PROJECT = "acme";

/**
 * A legal byte cap, so a text of known length has a fill a reader can name:
 * 900 bytes of a 1000-byte cap is 90% full, above the default 0.8 threshold.
 */
const INDEX_BYTES = 1000;

/** An index at 90% of its byte cap: above the threshold, so nearly full. */
const NEARLY_FULL = { text: "x".repeat(900), omitted: 0 };

/** An index at 10% of its byte cap with nothing omitted: room to spare. */
const ROOMY = { text: "x".repeat(100), omitted: 0 };

/** The percentage the nearly-full fixture works out to, as the run line prints it. */
const NEARLY_FULL_PERCENT = 90;

/** The counts line every close logs, whatever else it logs. */
const COUNT_LINE = "Memory: 0 saved (0 pending)";

/** The line a run that refused one save logs. */
const REFUSED_LINE = "Memory: 1 saves refused (index full)";

/** The line a run whose index is nearly full logs. */
const NEARLY_FULL_LINE = `Memory for ${PROJECT} is ${NEARLY_FULL_PERCENT}% full; run nax memory compact.`;

/** The config every case composes over: a named project with a cap a test can compute from. */
function namedConfig(): NaxConfig {
  return makeNaxConfig({ name: PROJECT, memory: { indexBytes: INDEX_BYTES } });
}

/** The refusal a save gets when the rendered index has no room: nax-agent's own error. */
function indexFullRefusal(): NaxError {
  return new NaxError("memory index is full: a new note would drop entries from the index", "MEMORY_FULL", {
    stage: "memory",
    scope: "project",
    slug: "replay-budget",
  });
}

describe("a run memory's full-index report", () => {
  let globalDir: string;
  let repoRoot: string;
  let logger: MockLogger;
  let savedGlobalEnv: string | undefined;
  let originalDeps: typeof _runMemoryDeps;
  /** How many times a case's host was released. */
  let releases: number;

  /**
   * The real host over this case's temp mirror, with whatever the case replaces.
   *
   * Only the method a case is about is swapped; every other read still goes to the
   * store the composition built, so the object handed back is a host, not a stub
   * standing in for one. `close` is counted by default, so "releases the host" is
   * something every case can assert without replacing it twice.
   */
  async function openHost(config: NaxConfig, overrides: Partial<MemoryHost> = {}): Promise<MemoryHost> {
    const created = await createMemoryHost({ config, repoRoot, source: RUN_MEMORY_SOURCE, logger });
    assertDefined(created, "the memory host");
    return {
      ...created,
      close: async () => {
        releases += 1;
      },
      ...overrides,
    };
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
  async function runMemory(overrides: Partial<MemoryHost> = {}, config = namedConfig()): Promise<RunMemory> {
    serve(await openHost(config, overrides));
    const created = await createRunMemory({ config, repoRoot, logger });
    assertDefined(created, "the run memory");
    return created;
  }

  /** Every call of one level this case's logger has been given, in order. */
  function callsAt(level: LogCall["level"]): readonly LogCall[] {
    return logger.calls.filter((call) => call.level === level);
  }

  /** Every `info` this case's logger has been given, in order. */
  function infos(): readonly LogCall[] {
    return callsAt("info");
  }

  /** Every `warn` this case's logger has been given, in order. */
  function warns(): readonly LogCall[] {
    return callsAt("warn");
  }

  /** The messages of one level, in order: what "which lines, in which order" is asserted on. */
  function messagesAt(level: LogCall["level"]): readonly string[] {
    return callsAt(level).map((call) => call.message);
  }

  /** The host's answer to one save: a complete result, of which the ACs name the status. */
  function saveResult(slug: string, status: MemoryNoteStatus): MemorySaveResult {
    return { slug, status, delivered: true };
  }

  /** One of the run memory's own tools, run as a run-stage session runs it. */
  async function runTool(memory: RunMemory, name: string, input: Record<string, unknown>): Promise<ToolResult> {
    const tool = (await memory.provider.tools(repoRoot)).find(
      (candidate: ProviderTool) => candidate.localName === name,
    );
    assertDefined(tool, `the ${name} tool`);
    return tool.run(input, RUN_CONTEXT);
  }

  /** One save the store refused because the index was full, made through the run's own tool. */
  async function refusedSave(memory: RunMemory): Promise<ToolResult> {
    return await runTool(memory, "save", REPLAY_BUDGET_INPUT);
  }

  beforeEach(() => {
    globalDir = makeTempDir("nax-run-memory-close-global-");
    repoRoot = makeTempDir("nax-run-memory-close-repo-");
    logger = makeLogger();
    releases = 0;
    savedGlobalEnv = process.env.NAX_GLOBAL_CONFIG_DIR;
    process.env.NAX_GLOBAL_CONFIG_DIR = globalDir;
    originalDeps = { ..._runMemoryDeps };
  });

  afterEach(() => {
    _runMemoryDeps.createMemoryHost = originalDeps.createMemoryHost;
    if (savedGlobalEnv === undefined) {
      delete process.env.NAX_GLOBAL_CONFIG_DIR;
    } else {
      process.env.NAX_GLOBAL_CONFIG_DIR = savedGlobalEnv;
    }
    cleanupTempDir(globalDir);
    cleanupTempDir(repoRoot);
  });

  describe("the refusal counter", () => {
    test("reports no refused saves before any save", async () => {
      const memory = await runMemory();

      expect(memory.summary()).toEqual({ saved: 0, pending: 0, refusedFull: 0 });
    });

    test("counts a save the full index refused", async () => {
      const memory = await runMemory({
        save: async () => {
          throw indexFullRefusal();
        },
      });

      await refusedSave(memory);

      expect(memory.summary()).toEqual({ saved: 0, pending: 0, refusedFull: 1 });
    });

    test("leaves the saved count unchanged when a save is refused as full", async () => {
      let saves = 0;
      const memory = await runMemory({
        save: async (write) => {
          saves += 1;
          if (saves > 1) throw indexFullRefusal();
          return saveResult(write.slug, "active");
        },
      });
      await runTool(memory, "save", REPLAY_BUDGET_INPUT);

      const before = memory.summary();
      await runTool(memory, "save", { ...REPLAY_BUDGET_INPUT, slug: "replay-window" });

      expect({ before, after: memory.summary() }).toEqual({
        before: { saved: 1, pending: 0, refusedFull: 0 },
        after: { saved: 1, pending: 0, refusedFull: 1 },
      });
    });

    test("counts one pending save and no refusals", async () => {
      const memory = await runMemory({ save: async (write) => saveResult(write.slug, "pending") });

      await runTool(memory, "save", REPLAY_BUDGET_INPUT);

      expect(memory.summary()).toEqual({ saved: 1, pending: 1, refusedFull: 0 });
    });

    // The counting view must not turn the refusal into an answer of its own: the tool's
    // `MEMORY_FULL` line is what tells the model to overwrite a note or to compact, and a
    // swallowed throw would reach it as a save that reported nothing.
    test("reaches the tool as the refusal it is", async () => {
      const memory = await runMemory({
        save: async () => {
          throw indexFullRefusal();
        },
      });

      const result = await refusedSave(memory);

      expect({ result, counts: memory.summary() }).toEqual({
        result: {
          isError: true,
          content:
            "[memory] save refused: memory index is full: a new note would drop entries from the index" +
            "; run nax memory compact, or overwrite an existing note",
        },
        counts: { saved: 0, pending: 0, refusedFull: 1 },
      });
    });
  });

  describe("close", () => {
    test("logs how many saves the full index refused", async () => {
      const memory = await runMemory({
        sync: async () => SYNCED,
        renderIndex: async () => ROOMY,
        save: async () => {
          throw indexFullRefusal();
        },
      });
      await refusedSave(memory);

      await memory.close();

      expect(infos()).toContainEqual({
        level: "info",
        stage: "run",
        message: REFUSED_LINE,
        data: { storyId: "_run", refusedFull: 1 },
      });
    });

    // The line is conditional on a refusal, so the guard is "the close read the index and
    // still logged nothing else": a quiet run must not be told to compact, and a close that
    // logged the refused line unconditionally (with 0) would fail the message list here.
    test("logs no refused line when nothing was refused", async () => {
      let renders = 0;
      const memory = await runMemory({
        sync: async () => SYNCED,
        renderIndex: async () => {
          renders += 1;
          return ROOMY;
        },
      });

      await memory.close();

      expect({ renders, messages: messagesAt("info"), warns: warns() }).toEqual({
        renders: 1,
        messages: [COUNT_LINE],
        warns: [],
      });
    });

    test("logs how full memory is when the index is nearly full", async () => {
      const memory = await runMemory({ sync: async () => SYNCED, renderIndex: async () => NEARLY_FULL });

      await memory.close();

      expect(infos()).toContainEqual({
        level: "info",
        stage: "run",
        message: NEARLY_FULL_LINE,
        data: { storyId: "_run", percent: NEARLY_FULL_PERCENT },
      });
    });

    // The other side of the same condition: the close reads the index once and finds room,
    // so nothing about the fill is said — a run with space must not be told to compact.
    test("logs no fill line when the index has room", async () => {
      let renders = 0;
      const memory = await runMemory({
        sync: async () => SYNCED,
        renderIndex: async () => {
          renders += 1;
          return ROOMY;
        },
      });

      await memory.close();

      expect({ renders, messages: messagesAt("info") }).toEqual({ renders: 1, messages: [COUNT_LINE] });
    });

    test("logs the counts, the refusals and the fill in order, then releases the host", async () => {
      const loggedBeforeRelease: string[][] = [];
      const memory = await runMemory({
        sync: async () => SYNCED,
        renderIndex: async () => NEARLY_FULL,
        save: async () => {
          throw indexFullRefusal();
        },
        close: async () => {
          releases += 1;
          loggedBeforeRelease.push([...messagesAt("info")]);
        },
      });
      await refusedSave(memory);

      await memory.close();

      expect({ messages: messagesAt("info"), loggedBeforeRelease, releases }).toEqual({
        messages: [COUNT_LINE, REFUSED_LINE, NEARLY_FULL_LINE],
        loggedBeforeRelease: [[COUNT_LINE, REFUSED_LINE, NEARLY_FULL_LINE]],
        releases: 1,
      });
    });

    test("logs no fill line and one warning when the close-time render throws", async () => {
      const memory = await runMemory({
        sync: async () => SYNCED,
        renderIndex: async () => {
          throw new Error("bad index");
        },
      });

      await memory.close();

      expect({ messages: messagesAt("info"), warns: warns() }).toEqual({
        messages: [COUNT_LINE],
        warns: [
          {
            level: "warn",
            stage: "run",
            message: "memory index unavailable",
            data: { storyId: "_run", error: "bad index" },
          },
        ],
      });
    });

    test("releases the host when the close-time render throws", async () => {
      const memory = await runMemory({
        sync: async () => SYNCED,
        renderIndex: async () => {
          throw new Error("bad index");
        },
      });

      await memory.close();

      expect({ releases, warnings: warns().length }).toEqual({ releases: 1, warnings: 1 });
    });

    test("never compacts the memory, even with a nearly-full index", async () => {
      let compactions = 0;
      const memory = await runMemory({
        sync: async () => SYNCED,
        renderIndex: async () => NEARLY_FULL,
        applyCompaction: async () => {
          compactions += 1;
          throw new Error("nax run must not compact");
        },
      });

      await memory.close();

      expect({ compactions, messages: messagesAt("info") }).toEqual({
        compactions: 0,
        messages: [COUNT_LINE, NEARLY_FULL_LINE],
      });
    });

    test("two overlapping closes log one set of lines and release the host once", async () => {
      let syncs = 0;
      const memory = await runMemory({
        sync: async () => {
          syncs += 1;
          return SYNCED;
        },
        renderIndex: async () => NEARLY_FULL,
      });

      await Promise.all([memory.close(), memory.close()]);

      expect({ syncs, releases, messages: messagesAt("info") }).toEqual({
        syncs: 2,
        releases: 1,
        messages: [COUNT_LINE, NEARLY_FULL_LINE],
      });
    });
  });
});
