/**
 * Test File Pattern Detection — Phase 2
 *
 * Re-exports from the detect/ directory which implements the full four-tier
 * detection pipeline (framework configs → framework defaults → file scan →
 * directory conventions) with mtime-based cache.
 *
 * Injectable `_detectDeps` follows the project `_deps` pattern (mock.module()
 * is banned — see `.claude/rules/forbidden-patterns.md`).
 */

export type { DetectionResult, DetectionSource } from "./detect/types";
export { detectTestFilePatterns, detectTestFilePatternsForWorkspace } from "./detect/index";

// Re-export sub-module deps objects so tests can inject mocks without
// touching the top-level module boundary.
export { _cacheDeps } from "./detect/cache";
export { _frameworkConfigDeps } from "./detect/framework-configs";
export { _frameworkDefaultsDeps } from "./detect/framework-defaults";
export { _fileScanDeps } from "./detect/file-scan";
export { _directoryScanDeps } from "./detect/directory-scan";
export { _workspaceDeps } from "./detect/workspace";

/** Injectable deps for testability — kept for backward compat with resolver.ts */
export const _detectDeps = {
  spawn: Bun.spawn as typeof Bun.spawn,
  file: Bun.file as typeof Bun.file,
};
