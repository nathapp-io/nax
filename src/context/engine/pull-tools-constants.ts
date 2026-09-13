/**
 * Shared constants for the pull-tools module, extracted so handler files can
 * consume them without importing `pull-tools.ts` back (breaking the runtime
 * import cycle; see docs/plans/STATUS-import-cycles-drain.md Task 12).
 */

export const DEFAULT_MAX_TOKENS_PER_CALL = 2048;
