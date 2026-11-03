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
 */
import type { ToolProvider } from "@nathapp/nax-agent";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { memoryConfigOf, type NaxConfig } from "@/config";
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

/** How many of this run's saves the mirror took — the counts `close()` reports. */
export interface RunMemorySummary {
  /** Saves that returned a result during this run. */
  readonly saved: number;
  /** Of those, the saves whose result status was `pending`. */
  readonly pending: number;
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
  /** First call: one sync, then one summary log line. Later calls do nothing. Never throws. */
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

/** The counts a run memory with nothing counted yet reports. */
const ZERO_SUMMARY: RunMemorySummary = { saved: 0, pending: 0 };

/** Closing a run memory before US-004 gives it a sync and a summary line to do. */
async function closeRunMemory(): Promise<void> {
  return undefined;
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
 */
async function syncStart(host: MemoryHost, logger: MemoryLogger): Promise<void> {
  try {
    await host.sync();
  } catch (error) {
    logger.warn("run", "memory sync failed", { storyId: RUN_MEMORY_STORY_ID, error: errorMessage(error) });
  }
}

/** The provider a run's tools hang off: the memory provider, re-staged onto `run`. */
function runProvider(host: MemoryHost): ToolProvider {
  return { ...createMemoryToolProvider(host), stages: RUN_MEMORY_TOOL_STAGES };
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
  try {
    const text = (await host.renderIndex()).text;
    return text === "" ? undefined : text;
  } catch (error) {
    logger.warn("run", "memory index unavailable", { storyId: RUN_MEMORY_STORY_ID, error: errorMessage(error) });
    return undefined;
  }
}

/**
 * Compose one run's memory.
 *
 * The `memory.inRun` switch is read before the first dependency call, and
 * `memory.enabled` is left to the host: a run whose memory is switched off must not
 * have its repository resolved, hashed or read at all.
 *
 * @param input.config - The loaded nax config (`memory` is read through `memoryConfigOf`)
 * @param input.repoRoot - Absolute repository root; the mirror identity
 * @param input.logger - Where the composition and its guarded steps log
 * @returns The run's memory, or `undefined` when the run gets none
 */
export async function createRunMemory(input: CreateRunMemoryInput): Promise<RunMemory | undefined> {
  if (memoryConfigOf(input.config).inRun === false) return undefined;
  const host = await openHost(input);
  if (host === undefined) return undefined;
  await syncStart(host, input.logger);
  return {
    host,
    provider: runProvider(host),
    index: () => renderIndex(host, input.logger),
    summary: () => ZERO_SUMMARY,
    close: closeRunMemory,
  };
}
