/**
 * `src/memory` public API.
 *
 * Every later memory story appends its export here; consumers import from
 * `@/memory` and never from `@/memory/<internal>` (`check:alias-internals`).
 */

export type { MemoryCompactFacts } from "./compact-facts";
export { _compactFactsDeps, readMemoryCompactFacts } from "./compact-facts";
export type {
  CompactProjectMemoryInput,
  MemoryCompactOutcome,
  MemoryCompactPreview,
} from "./compact-project";
export { _compactProjectDeps, compactProjectMemory } from "./compact-project";
export { memoryIndexFill, memoryNearlyFull } from "./fill";
export type { MemoryNoteLine } from "./format";
export { formatMemoryNoteLine, formatMemoryStatus, formatMemorySyncResult } from "./format";
export type { CreateMemoryHostInput, MemoryHost, MemoryRejectedEntry, MemorySearchInput, MemoryStatus } from "./host";
export { _memoryHostDeps, createMemoryHost } from "./host";
export { pendingForgetKey } from "./host-forget-keys";
export type { MemoryRejectedTarget } from "./host-writes";
export type { KodaApproval, KodaApprovals } from "./koda-approvals";
export { createKodaApprovals, KODA_APPROVALS_FILE } from "./koda-approvals";
export type { CreateKodaClientInput, KodaClient, KodaResponse } from "./koda-http";
export { createKodaClient, kodaStatusOf, MEMORY_KODA_REQUEST_TIMEOUT_MS } from "./koda-http";
export type { CreateKodaMemoryProviderInput } from "./koda-provider";
export { createKodaMemoryProvider, MEMORY_KODA_PROVIDER_PREFIX } from "./koda-provider";
export type { KodaRefusal, KodaRefusals, MemoryKodaRefusal } from "./koda-refusals";
export {
  createKodaRefusals,
  KODA_REFUSAL_REPORT_MS,
  KODA_REFUSAL_STATUSES,
  KODA_REFUSALS_FILE,
  KODA_REFUSALS_MAX,
} from "./koda-refusals";
export type { CreateMcpMemoryProviderInput } from "./mcp-provider";
export { createMcpMemoryProvider, MEMORY_MCP_PROVIDER_PREFIX } from "./mcp-provider";
export { _mirrorLockDeps, lockMemoryMirror, type MirrorLockInput } from "./mirror-lock";
export { _mirrorOriginDeps, ensureMirrorOrigin, ORIGIN_FILE } from "./mirror-origin";
export type { MemoryMirrorInfo, MemoryMirrorRead } from "./mirrors";
export { isPrunableMirror, listMemoryMirrors, readMemoryMirror } from "./mirrors";
export type { MemoryDirs, MemoryLogger } from "./paths";
export { _memoryPathsDeps, memoryDirs, memoryProjectSegment, memoryProjectsDir } from "./paths";
export type { RepoNotes } from "./repo-notes";
export { _repoNotesDeps, REPO_NOTE_MAX_FILE_BYTES, REPO_NOTES_MAX, readRepoNotes } from "./repo-notes";
export type { CreateRunMemoryInput, RunMemory, RunMemorySummary } from "./run-memory";
export { _runMemoryDeps, createRunMemory, RUN_MEMORY_SOURCE, RUN_MEMORY_TOOL_STAGES } from "./run-memory";
export { createMemoryToolProvider, MEMORY_TOOL_PROVIDER_ID } from "./tool-provider";
