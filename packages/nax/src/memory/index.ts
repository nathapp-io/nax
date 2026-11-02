/**
 * `src/memory` public API.
 *
 * Every later memory story appends its export here; consumers import from
 * `@/memory` and never from `@/memory/<internal>` (`check:alias-internals`).
 */

export type { MemoryDirs, MemoryLogger } from "./paths";
export { _memoryPathsDeps, memoryDirs, memoryProjectSegment } from "./paths";
