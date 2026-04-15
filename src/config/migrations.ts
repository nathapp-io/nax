/**
 * Config Migration Shims
 *
 * Immutable transformations applied to the raw JSON config before Zod parse.
 * Running before Zod allows the shim to distinguish "user omitted" (key absent)
 * from "user set to default value" — the `.default()` in Zod erases that signal.
 *
 * Rules:
 * - Each function returns a NEW object; the input is never mutated.
 * - Shims are one-way and additive: they do not remove user data.
 * - Deprecation warnings are logged via the passed logger (which may be null
 *   if called before the logger is initialized — guard with `?.`).
 */

import type { Logger } from "../logger";

/**
 * Alias the deprecated `context.testCoverage.testPattern` (single glob string)
 * to `execution.smartTestRunner.testFilePatterns` (string array) — ADR-009 §4.5.
 *
 * Behaviour:
 * - If `testPattern` is absent → no-op, returns input.
 * - If `testPattern` is present AND `testFilePatterns` is also set → smartTestRunner
 *   wins; `testPattern` is dropped silently (user has already migrated, no conflict).
 * - If `testPattern` is present and `testFilePatterns` is absent → alias:
 *   `testFilePatterns = [testPattern]`.
 * - In all cases the `testPattern` key is removed from the output to avoid
 *   the deprecated field leaking into the Zod-parsed config.
 *
 * @param raw    Raw JSON config object (before Zod parse).
 * @param logger Nullable logger — logger may not be initialized yet at call time.
 * @returns New config object with migration applied.
 */
export function migrateLegacyTestPattern(raw: Record<string, unknown>, logger: Logger | null): Record<string, unknown> {
  type RawContext = { testCoverage?: { testPattern?: unknown; [k: string]: unknown }; [k: string]: unknown };
  type RawExecution = { smartTestRunner?: { testFilePatterns?: unknown; [k: string]: unknown }; [k: string]: unknown };

  const context = raw.context as RawContext | undefined;
  const legacyPattern = context?.testCoverage?.testPattern;
  if (legacyPattern === undefined) return raw;

  logger?.warn(
    "config",
    "context.testCoverage.testPattern is deprecated — migrate to " +
      "execution.smartTestRunner.testFilePatterns (array). Migration shim applied.",
    { legacyPattern },
  );

  // Drop the deprecated key regardless of whether we alias it.
  const safeContext = context ?? {};
  const { testPattern: _drop, ...testCoverageRest } = safeContext.testCoverage ?? {};
  const migratedContext: RawContext = { ...safeContext, testCoverage: testCoverageRest };

  const execution = raw.execution as RawExecution | undefined;
  const smartRunnerPatterns = execution?.smartTestRunner?.testFilePatterns;

  if (smartRunnerPatterns !== undefined) {
    // User already set the canonical key — drop legacy only, do not alias.
    return { ...raw, context: migratedContext };
  }

  // Alias: wrap the single-string pattern into an array.
  const aliasedSmartRunner = {
    ...execution?.smartTestRunner,
    testFilePatterns: [legacyPattern],
  };
  const migratedExecution: RawExecution = {
    ...execution,
    smartTestRunner: aliasedSmartRunner,
  };

  return { ...raw, execution: migratedExecution, context: migratedContext };
}
