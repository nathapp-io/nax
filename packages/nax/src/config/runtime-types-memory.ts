/**
 * `memory` config types — the repository-wide memory block read by the chat
 * surfaces, the memory host and `nax memory`.
 *
 * Split out of `runtime-types.ts`, which is at its file-size limit (the `mcp`
 * precedent). The field is optional here because `NaxConfig` is hand-written;
 * every reader resolves it through `memoryConfigOf` (`./schemas-memory`), which
 * falls back to the schema default.
 */
import type { ConfiguredModel } from "./schema-types";

/** `memory.compact` — when a compaction is offered, which model plans it, and how many archives survive. */
export interface MemoryCompactConfig {
  /** Fill at or above which the index counts as nearly full, 0 < threshold <= 1. */
  threshold: number;
  /** The model a compaction plan is requested from: a tier name or a `{ agent, model }` pin. */
  model: ConfiguredModel;
  /** How many compaction archives the newest-first prune keeps (1-50). */
  keepArchives: number;
}

/** `memory.mcp` — the MCP server that holds the memories, and the names of its tools and arguments. */
export interface MemoryMcpConfig {
  /** A key of `mcp.servers`. */
  server: string;
  tools: {
    /** Defaults to `search_memory`. */
    search: string;
    /** Defaults to `add_memories`. */
    add: string;
    /** No default: the user's server names its own single-memory delete tool. */
    forget?: string;
  };
  args: {
    /** Defaults to `query`. */
    query: string;
    /** Defaults to `text`. */
    text: string;
    /** No default; required when `tools.forget` is set. */
    id?: string;
  };
}

/** `memory.koda` — the koda project that holds the memories, and how to reach it. */
export interface MemoryKodaConfig {
  /** koda's API root *including* its global prefix (`https://koda.example/api`). Global-only. */
  url?: string;
  /** koda project slug; written by `nax memory link`. */
  project?: string;
  /** Static request headers (the bearer agent key), carried literally. Global-only. */
  headers: Record<string, string>;
}

export interface MemoryConfig {
  /** Master switch: false means no host, no tools, no prompt section and no sync. */
  enabled: boolean;
  /** Where notes live: the local store, an MCP server named by `mcp`, or a koda project named by `koda`. */
  provider: "local" | "mcp" | "koda";
  /** The MCP server behind `provider: "mcp"`; unused under `"local"` and `"koda"`. */
  mcp?: MemoryMcpConfig;
  /** The koda project behind `provider: "koda"`; unused under the other providers. */
  koda?: MemoryKodaConfig;
  /** `direct` writes a save immediately; `proposal` queues it for `nax memory approve`. */
  writeMode: "direct" | "proposal";
  /** Byte cap for the memory index injected into the chat prompt. */
  indexBytes: number;
  /** Ask before `nax-memory__save` / `__forget` in a guarded native chat. */
  askOnSave: boolean;
  /**
   * Workflow-run switch: false means no run memory — no start sync, no index in
   * the brief, no run-stage tools. Chat is unaffected.
   */
  inRun: boolean;
  /** Compaction settings: the fill that counts as nearly full, the planning model, and the archive depth. */
  compact: MemoryCompactConfig;
}
