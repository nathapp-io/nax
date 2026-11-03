/**
 * `memory` config types — the repository-wide memory block read by the chat
 * surfaces, the memory host and `nax memory`.
 *
 * Split out of `runtime-types.ts`, which is at its file-size limit (the `mcp`
 * precedent). The field is optional here because `NaxConfig` is hand-written;
 * every reader resolves it through `memoryConfigOf` (`./schemas-memory`), which
 * falls back to the schema default.
 */

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

export interface MemoryConfig {
  /** Master switch: false means no host, no tools, no prompt section and no sync. */
  enabled: boolean;
  /** Where notes live: the local store, or an MCP server named by `mcp`. */
  provider: "local" | "mcp";
  /** The MCP server behind `provider: "mcp"`; unused under `"local"`. */
  mcp?: MemoryMcpConfig;
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
}
