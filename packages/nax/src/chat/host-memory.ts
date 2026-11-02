/**
 * The chat host's memory side (US-013).
 *
 * One chat session opens many times — `start`, `resume`, `clear` and every mode or
 * model switch — and each open hands the agent a fresh `## Memory` section. The
 * index for it is prepared here, once per open: the mirror is synced first, so the
 * session sees what a teammate committed (and what another nax process saved) since
 * the last open, and then the index is rendered from that mirror.
 *
 * Neither step may fail an open. A sync that throws is a warning — the mirror's
 * index is still worth handing over — and a render that throws costs the session
 * its `## Memory` section and nothing else. A sync that *reports* `unreachable` or
 * `locked` is not a throw at all: `syncMemory` owns that protocol and answers with
 * a result, so those runs warn about nothing.
 *
 * The index is a snapshot, not a view: a session keeps the text it opened with, and
 * a note saved mid-session reaches the next open rather than the current one.
 *
 * Everything the host does with memory goes through this object, so the host itself
 * only holds it and calls it. `handlers` and `closeSync` are the compaction flush
 * and the close-time sync: both are one `sync()` behind the same guard.
 */
import type { ExternalHandlerOf, LoopEvent, LoopHandlerSet } from "@nathapp/nax-agent";
import { errorMessage } from "@nathapp/nax-agent/internal";
import type { Logger } from "@/logger";
import type { MemoryHost } from "@/memory";

/** Everything one host's memory side is built from; memory is absent when the chat has none. */
export interface CreateHostMemoryInput {
  readonly memory?: MemoryHost;
  /** A `warn`-only view: preparing an index logs nothing else. */
  readonly logger: Pick<Logger, "warn">;
}

/** One chat host's memory side. */
export interface HostMemory {
  /**
   * Sync the mirror and render the index for one open. Absent when this chat has no
   * memory host or the render failed; never throws on either failure.
   */
  prepare(): Promise<string | undefined>;
  /**
   * The index the last `prepare` stored. Each open carries the value its own `prepare`
   * returned instead, so two operations that overlap cannot swap snapshots.
   */
  current(): string | undefined;
  /** The loop handlers memory registers on a session; empty when this chat has no memory. */
  readonly handlers: LoopHandlerSet;
  /** Sync once as the host closes, after every resource teardown; never throws. */
  closeSync(): Promise<void>;
}

/**
 * The plugin name the one entry this module registers carries. It is the memory
 * tool provider's id (`MEMORY_TOOL_PROVIDER_ID`), spelled here rather than imported
 * so a chat host does not pull the tool provider's module graph in to name an
 * entry — the same choice `chat-mcp.ts` makes for its reserved server ids.
 */
export const HOST_MEMORY_PLUGIN = "nax-memory";

/** No handlers when there is no memory host: `handlers` is the chat's only entry. */
const NO_HANDLERS: LoopHandlerSet = Object.freeze([]);

/** One guarded sync: a throw is a warning, and an expected outcome is not a throw. */
async function syncOnce(memory: MemoryHost, logger: Pick<Logger, "warn">): Promise<void> {
  try {
    await memory.sync();
  } catch (error) {
    logger.warn("chat", "memory sync failed", { error: errorMessage(error) });
  }
}

/**
 * The one entry a chat with memory registers: a flush before the transcript is
 * summarised, so a note saved mid-session reaches the mirror before the turn that
 * carried it is compacted away. It answers `undefined` — always. The summary is the
 * summarizer's, and a mirror flush is not a replacement for it.
 */
function compactionHandlers(memory: MemoryHost, logger: Pick<Logger, "warn">): LoopHandlerSet {
  const beforeCompaction: ExternalHandlerOf<LoopEvent> = async () => {
    await syncOnce(memory, logger);
    return undefined;
  };
  const entries: LoopHandlerSet = [
    { plugin: HOST_MEMORY_PLUGIN, event: "before_compaction", handler: beforeCompaction },
  ];
  return Object.freeze(entries);
}

/** Build one host's memory side. Nothing is read from `memory` until a flush is due. */
export function createHostMemory(input: CreateHostMemoryInput): HostMemory {
  let index: string | undefined;
  const memory = input.memory;

  /** The index this open should carry, replacing whatever the previous open had. */
  async function renderIndex(host: MemoryHost): Promise<string | undefined> {
    try {
      return (await host.renderIndex()).text;
    } catch (error) {
      input.logger.warn("chat", "memory index unavailable", { error: errorMessage(error) });
      return undefined;
    }
  }

  return {
    async prepare() {
      if (memory === undefined) return undefined;
      await syncOnce(memory, input.logger);
      index = await renderIndex(memory);
      return index;
    },
    current: () => index,
    handlers: memory === undefined ? NO_HANDLERS : compactionHandlers(memory, input.logger),
    async closeSync() {
      if (memory === undefined) return;
      await syncOnce(memory, input.logger);
    },
  };
}
