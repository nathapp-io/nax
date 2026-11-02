/**
 * `memory` config types — the repository-wide memory block read by the chat
 * surfaces, the memory host and `nax memory`.
 *
 * Split out of `runtime-types.ts`, which is at its file-size limit (the `mcp`
 * precedent). The field is optional here because `NaxConfig` is hand-written;
 * every reader resolves it through `memoryConfigOf` (`./schemas-memory`), which
 * falls back to the schema default.
 */

export interface MemoryConfig {
  /** Master switch: false means no host, no tools, no prompt section and no sync. */
  enabled: boolean;
  /** Where notes live. Only the local store exists in this release. */
  provider: "local";
  /** `direct` writes a save immediately; `proposal` queues it for `nax memory approve`. */
  writeMode: "direct" | "proposal";
  /** Byte cap for the memory index injected into the chat prompt. */
  indexBytes: number;
  /** Ask before `nax-memory__save` / `__forget` in a guarded native chat. */
  askOnSave: boolean;
}
