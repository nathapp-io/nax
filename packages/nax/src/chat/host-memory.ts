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
 * only holds it and calls it. `handlers` and `closeSync` are the seam US-014 fills:
 * the compaction handler and the close-time sync.
 */
import type { LoopHandlerSet } from "@nathapp/nax-agent";
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
   * Sync the mirror and render the index the next open carries. Absent when this
   * chat has no memory host or the render failed; never throws on either failure.
   */
  prepare(): Promise<string | undefined>;
  /** The index the last `prepare` stored — what a session opened right now carries. */
  current(): string | undefined;
  /** The loop handlers memory registers on a session; empty until US-014 adds compaction. */
  readonly handlers: LoopHandlerSet;
  /** Sync once as the host closes; the host wires it into teardown in US-014. */
  closeSync(): Promise<void>;
}

/** No handlers yet: compaction registration is US-014's. */
const NO_HANDLERS: LoopHandlerSet = Object.freeze([]);

/** Build one host's memory side. Nothing is read from `memory` until `prepare` is called. */
export function createHostMemory(input: CreateHostMemoryInput): HostMemory {
  let index: string | undefined;

  /** One guarded sync: a throw is a warning, and an expected outcome is not a throw. */
  async function syncOnce(memory: MemoryHost): Promise<void> {
    try {
      await memory.sync();
    } catch (error) {
      input.logger.warn("chat", "memory sync failed", { error: errorMessage(error) });
    }
  }

  /** The index this open should carry, replacing whatever the previous open had. */
  async function renderIndex(memory: MemoryHost): Promise<string | undefined> {
    try {
      return (await memory.renderIndex()).text;
    } catch (error) {
      input.logger.warn("chat", "memory index unavailable", { error: errorMessage(error) });
      return undefined;
    }
  }

  return {
    async prepare() {
      const memory = input.memory;
      if (memory === undefined) return undefined;
      await syncOnce(memory);
      index = await renderIndex(memory);
      return index;
    },
    current: () => index,
    handlers: NO_HANDLERS,
    async closeSync() {
      const memory = input.memory;
      if (memory === undefined) return;
      await syncOnce(memory);
    },
  };
}
