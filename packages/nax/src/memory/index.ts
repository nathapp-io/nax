/**
 * `src/memory` public API.
 *
 * Every later memory story appends its export here; consumers import from
 * `@/memory` and never from `@/memory/<internal>` (`check:alias-internals`).
 */

export type { MemoryNoteLine } from "./format";
export { formatMemoryNoteLine, formatMemoryStatus, formatMemorySyncResult } from "./format";
export type { CreateMemoryHostInput, MemoryHost, MemorySearchInput, MemoryStatus } from "./host";
export { _memoryHostDeps, createMemoryHost } from "./host";
export type { MemoryDirs, MemoryLogger } from "./paths";
export { _memoryPathsDeps, memoryDirs, memoryProjectSegment } from "./paths";
export type { RepoNotes } from "./repo-notes";
export { _repoNotesDeps, REPO_NOTE_MAX_FILE_BYTES, REPO_NOTES_MAX, readRepoNotes } from "./repo-notes";
export { createMemoryToolProvider, MEMORY_TOOL_PROVIDER_ID } from "./tool-provider";
