/**
 * The run memory: the memory a `nax run` gives the sessions that do its work.
 *
 * This is the chat host's memory side (`chat/host-memory.ts`) for a run, and it is
 * built the same way: the mirror is synced once when the run starts, so the first
 * session already sees what a teammate committed (and what another nax process
 * saved), and the index a step is handed is rendered fresh from that mirror on
 * every call rather than kept as a snapshot.
 *
 * Neither step may fail a run. A host that cannot be composed is a warning and a
 * run without memory; a sync that throws is a warning and a run whose mirror was
 * left as it was; a render that throws costs the step its `## Memory` section and
 * nothing else. A sync that *reports* `locked`, `unreachable` or `failed` is not a
 * throw at all — `syncMemory` owns that protocol and answers with a result — so
 * those runs warn about nothing.
 *
 * The tools attach by provider stage, not by a session-role list: the provider
 * declares `stages: ["run"]`, so the existing stage filter keeps it off a
 * `review`-stage session. A static provider's tools run in nax's own process, so a
 * run-stage save writes the mirror directly, exactly as a chat save does.
 *
 * The tools write through a counting view of the host, so the run can say what it
 * saved without asking the mirror: every save the host resolved is counted, a
 * `pending` one as both saved and pending, and a save the store refused is not
 * counted at all — except the one refusal the run can still act on, a save the
 * full index refused (`MEMORY_FULL`), which is counted on its own line and handed
 * back to the tool unchanged. Closing is the other half — one last sync so a note
 * the last session saved is on the mirror before the run ends, then one summary
 * line, the refusals if there were any, and how full the index is when it is at
 * its cap. Neither of the last two compacts anything: `nax run` never runs a
 * compaction, so the nearly-full line is an instruction for the person and the
 * host's `applyCompaction` is never called. Both halves are guarded the same way
 * everything else here is: a failing sync warns and the run ends anyway, an index
 * that cannot be read costs the fill line and one warning, and a second close does
 * none of it twice. The host is released last, after those lines, and a close that
 * throws is one more warning.
 */
import type { RenderedMemoryIndex, ToolProvider } from "@nathapp/nax-agent";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { getProjectKey, type MemoryConfig, memoryConfigOf, type NaxConfig } from "@/config";
import { NaxError } from "@/errors";
import { memoryIndexFill, memoryNearlyFull } from "./fill";
import { type CreateMemoryHostInput, createMemoryHost, type MemoryHost } from "./host";
import type { MemoryLogger } from "./paths";
import { createMemoryToolProvider } from "./tool-provider";

/** The origin a note saved by a run session records. */
export const RUN_MEMORY_SOURCE = "nax-run";

/** The pipeline stage the run memory's tools attach to. */
export const RUN_MEMORY_TOOL_STAGES: readonly string[] = ["run"];

/**
 * The story id a run-wide memory line is logged under.
 *
 * Memory is one per run, not one per story, so its lines carry a fixed id rather
 * than borrowing the story that happened to be running when the line was written.
 */
const RUN_MEMORY_STORY_ID = "_run";

/** The code nax-agent refuses a save with when the rendered index has no room for a new note. */
const MEMORY_FULL_CODE = "MEMORY_FULL";

/** How many of this run's saves the mirror took, and how many it refused, as `close()` reports them. */
export interface RunMemorySummary {
  /** Saves that returned a result during this run. */
  readonly saved: number;
  /** Of those, the saves whose result status was `pending`. */
  readonly pending: number;
  /** Saves the mirror refused because the index was full: `MEMORY_FULL`, counted from zero. */
  readonly refusedFull: number;
}

/** One run's memory: the host it reads through, the tools it hands over, and its close. */
export interface RunMemory {
  readonly host: MemoryHost;
  /** The four nax-memory tools over a counting view of `host`, stages `["run"]`. */
  readonly provider: ToolProvider;
  /** The rendered index, read fresh on every call; `undefined` when empty or unavailable. Never throws. */
  index(): Promise<string | undefined>;
  /** The counts `close()` logs; read by tests, no other production reader. */
  summary(): RunMemorySummary;
  /**
   * First call: one sync, then the run's lines — the counts, the refusals if any, and how
   * full the index is when it is at its cap. A later call awaits that same close and does
   * none of it again. Never throws, and never compacts anything.
   */
  close(): Promise<void>;
}

/** What a run's memory is composed from. */
export interface CreateRunMemoryInput {
  readonly config: NaxConfig;
  /** Absolute repository root (the run's workdir); the mirror identity. */
  readonly repoRoot: string;
  readonly logger: MemoryLogger;
}

/** Composition seam for tests: the one call this module makes outside itself. */
export const _runMemoryDeps: { createMemoryHost: typeof createMemoryHost } = { createMemoryHost };

/**
 * The counts while the run is still going: the summary's own fields, mutable.
 *
 * Derived rather than restated, so a field added to `RunMemorySummary` cannot be one
 * the counter forgets to keep.
 */
type SaveCounts = { -readonly [K in keyof RunMemorySummary]: RunMemorySummary[K] };

/**
 * The host a run's tools write through: the host's own members, and a `save` that
 * counts what the host resolved.
 *
 * The count is taken after the host's answer, so a write the store refused is not a
 * save the run reports — the tool still answers the model with the refusal, and the
 * summary counts the saves that landed. A refusal because the index is full is the one
 * exception, and it is counted as nothing else: it leaves `saved` where it was, adds one
 * to `refusedFull`, and is rethrown so the tool still answers with the hint that names
 * the way out. Nothing is stamped here: the host already records `RUN_MEMORY_SOURCE`
 * from composition, and the write the tool built is forwarded unchanged.
 *
 * The mirror this counts is the run's own. A static provider's tools run in nax's
 * process, so a run-stage save writes the mirror directly, exactly as a chat save
 * does; there is no outbox hop whose delivery this count could be confusing.
 */
function countingHost(host: MemoryHost, counts: SaveCounts): MemoryHost {
  return {
    ...host,
    save: async (write) => {
      try {
        const result = await host.save(write);
        counts.saved += 1;
        if (result.status === "pending") counts.pending += 1;
        return result;
      } catch (error) {
        if (error instanceof NaxError && error.code === MEMORY_FULL_CODE) counts.refusedFull += 1;
        throw error;
      }
    },
  };
}

/** The one summary line a run's memory logs, as `close()` writes it. */
function summaryLine(summary: SaveCounts): string {
  return `Memory: ${summary.saved} saved (${summary.pending} pending)`;
}

/** The line a run whose full index refused saves logs: the count, and what it means. */
function refusedLine(summary: SaveCounts): string {
  return `Memory: ${summary.refusedFull} saves refused (index full)`;
}

/** The line a run whose index is at its cap logs: the fill, and the one command that fixes it. */
function nearlyFullLine(project: string, fill: number): string {
  return `Memory for ${project} is ${percent(fill)}% full; run nax memory compact.`;
}

/** Fill as the whole percent every memory surface speaks in. */
function percent(fill: number): number {
  return Math.round(fill * 100);
}

/**
 * The memory host a run reads through, or `undefined` when it has none.
 *
 * A throw is a warning rather than a failure: a run without memory still does its
 * work, and a mirror that cannot be composed is not a reason to stop it.
 */
async function openHost(input: CreateRunMemoryInput): Promise<MemoryHost | undefined> {
  const hostInput: CreateMemoryHostInput = {
    config: input.config,
    repoRoot: input.repoRoot,
    source: RUN_MEMORY_SOURCE,
    logger: input.logger,
  };
  try {
    const host = await _runMemoryDeps.createMemoryHost(hostInput);
    return host ?? undefined;
  } catch (error) {
    input.logger.warn("run", "memory unavailable", { storyId: RUN_MEMORY_STORY_ID, error: errorMessage(error) });
    return undefined;
  }
}

/**
 * The run's one start sync: a throw is a warning, and an expected outcome is not a
 * throw. The host is synced before the first session is handed its index, so that
 * index already holds what a teammate committed since the last run.
 *
 * The same guard is the end sync's, because it is the same fact: a mirror that
 * cannot be synced costs the run a warning, never the work the run did.
 */
async function syncStart(host: MemoryHost, logger: MemoryLogger): Promise<void> {
  try {
    await host.sync();
  } catch (error) {
    logger.warn("run", "memory sync failed", { storyId: RUN_MEMORY_STORY_ID, error: errorMessage(error) });
  }
}

/** What a run's close reports on, beyond the host it holds and the counts it kept. */
interface CloseReport {
  readonly host: MemoryHost;
  readonly counts: SaveCounts;
  readonly logger: MemoryLogger;
  /** The memory block: the threshold and cap the fill line is measured against. */
  readonly memory: MemoryConfig;
  /** `getProjectKey(config, repoRoot)`: how every memory surface names this project. */
  readonly project: string;
}

/**
 * The close a run's memory hands out: one end sync, then the lines it reports.
 *
 * The work is memoized rather than flagged, so closes that overlap share one run of it:
 * the second caller awaits the promise the first is waiting on instead of resolving ahead
 * of the sync it has not done. `runtime.close()` can be reached from a signal handler and
 * a normal exit both, and it is the normal-exit caller that may otherwise proceed — and
 * let the process exit — while the end sync is still in flight.
 *
 * The promise is stored before the body's first `await`, so a second call made in the same
 * turn as the first still finds it. A sync that throws is the same warning the start sync
 * gives: the run is ending either way, and the counts are worth more than the failure
 * they would otherwise be lost to.
 */
function createClose(report: CloseReport): () => Promise<void> {
  let closing: Promise<void> | undefined;
  return () => {
    closing ??= closeOnce(report);
    return closing;
  };
}

/** The one close a run's memory performs: the end sync, the lines it logs, then the host's release. */
async function closeOnce(report: CloseReport): Promise<void> {
  try {
    await syncStart(report.host, report.logger);
    logCounts(report);
    await logNearlyFull(report);
  } finally {
    await closeHost(report.host, report.logger);
  }
}

/**
 * What a run's memory took and what it could not, in the order a reader needs them.
 *
 * A run that refused nothing says nothing about it: the refused line exists for the case
 * the person has to act on, and printing `0 saves refused` on every run would bury it.
 */
function logCounts(report: CloseReport): void {
  const { saved, pending, refusedFull } = report.counts;
  report.logger.info("run", summaryLine(report.counts), { storyId: RUN_MEMORY_STORY_ID, saved, pending });
  if (refusedFull === 0) return;
  report.logger.info("run", refusedLine(report.counts), { storyId: RUN_MEMORY_STORY_ID, refusedFull });
}

/**
 * The line a run whose index is at its cap logs, or none when it has room.
 *
 * One read of the index, measured against the configured threshold and byte cap by the
 * same `memoryNearlyFull` the chat's offer asks: a run and a chat must agree on what
 * "nearly full" means. Nothing is compacted here — `nax run` never runs a compaction, so
 * the line names the command for the person instead.
 *
 * A render that throws is one warning and no line (F16): the run is already closing, and
 * a mirror that cannot be read is not a reason to lose the counts just reported.
 */
async function logNearlyFull(report: CloseReport): Promise<void> {
  const index = await renderSafely(report.host, report.logger);
  if (index === undefined || !memoryNearlyFull(index, report.memory)) return;
  const fill = memoryIndexFill(index, report.memory.indexBytes);
  report.logger.info("run", nearlyFullLine(report.project, fill), {
    storyId: RUN_MEMORY_STORY_ID,
    percent: percent(fill),
  });
}

/** Release the host the run opened (an MCP-backed host holds a pool): a throw is a warning. */
async function closeHost(host: MemoryHost, logger: MemoryLogger): Promise<void> {
  try {
    await host.close?.();
  } catch (error) {
    logger.warn("run", "memory close failed", { storyId: RUN_MEMORY_STORY_ID, error: errorMessage(error) });
  }
}

/** The provider a run's tools hang off: the memory provider over `host`, re-staged onto `run`. */
function runProvider(host: MemoryHost): ToolProvider {
  return { ...createMemoryToolProvider(host), stages: RUN_MEMORY_TOOL_STAGES };
}

/**
 * The index as the host renders it now, or `undefined` when the render throws.
 *
 * A render that throws costs the caller its answer and nothing else, and one warn says so:
 * a step loses its `## Memory` section, and the close loses its fill line, while the run
 * carries on with what it already has.
 */
async function renderSafely(host: MemoryHost, logger: MemoryLogger): Promise<RenderedMemoryIndex | undefined> {
  try {
    return await host.renderIndex();
  } catch (error) {
    logger.warn("run", "memory index unavailable", { storyId: RUN_MEMORY_STORY_ID, error: errorMessage(error) });
    return undefined;
  }
}

/**
 * The index a step is handed: rendered now, never cached.
 *
 * A run's steps read the index once each, minutes apart, and a note another nax
 * process saved in between is exactly what the next step should see — so every call
 * renders rather than replaying the run's first render. A render that throws costs
 * that step its `## Memory` section and nothing else, and a render that comes back
 * empty is the same absence: there is no section to hand over.
 */
async function renderIndex(host: MemoryHost, logger: MemoryLogger): Promise<string | undefined> {
  const text = (await renderSafely(host, logger))?.text ?? "";
  return text === "" ? undefined : text;
}

/**
 * Compose one run's memory.
 *
 * The `memory.inRun` switch is read before the first dependency call, and
 * `memory.enabled` is left to the host: a run whose memory is switched off must not
 * have its repository resolved, hashed or read at all.
 *
 * The tools are handed a counting view of the host and the host itself is kept as
 * `host`, so the two reads this object makes outside its tools (the index and the
 * sync) are the host's own, and nothing that reads `host` can be counted twice.
 *
 * The `memory` block is read once here — the `inRun` switch decides whether the run gets
 * any memory, and the close keeps the same block for the threshold and cap the fill line
 * is measured against. The project key is `getProjectKey(config, repoRoot)`: the name
 * every memory surface uses for this project, which is what the fill line tells the person
 * to compact.
 *
 * @param input.config - The loaded nax config (`memory` is read through `memoryConfigOf`)
 * @param input.repoRoot - Absolute repository root; the mirror identity
 * @param input.logger - Where the composition and its guarded steps log
 * @returns The run's memory, or `undefined` when the run gets none
 */
export async function createRunMemory(input: CreateRunMemoryInput): Promise<RunMemory | undefined> {
  const memory = memoryConfigOf(input.config);
  if (memory.inRun === false) return undefined;
  const host = await openHost(input);
  if (host === undefined) return undefined;
  await syncStart(host, input.logger);
  const counts: SaveCounts = { saved: 0, pending: 0, refusedFull: 0 };
  return {
    host,
    provider: runProvider(countingHost(host, counts)),
    index: () => renderIndex(host, input.logger),
    summary: () => ({ ...counts }),
    close: createClose({
      host,
      counts,
      logger: input.logger,
      memory,
      project: getProjectKey(input.config, input.repoRoot),
    }),
  };
}
