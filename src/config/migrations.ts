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

/**
 * Alias the deprecated `review.semantic.modelTier` and `review.adversarial.modelTier`
 * (string tier label) to `review.{semantic,adversarial}.model` (ConfiguredModel).
 *
 * Behaviour per block:
 * - If `modelTier` is absent → no-op for that block.
 * - If both `modelTier` and `model` are set → both are kept dropped except `model`
 *   (canonical wins); we do NOT throw — `model` is a strict superset and the user
 *   has already adopted the new key.
 * - If only `modelTier` is present → alias: `model = modelTier`, drop `modelTier`.
 *
 * In all migrated cases the `modelTier` key is removed from the output to keep
 * the deprecated field out of Zod-parsed config (Zod is in `.strip()` mode so it
 * would silently drop, but we drop here to log + keep one place to maintain).
 */
export function migrateLegacyReviewModelKey(
  raw: Record<string, unknown>,
  logger: Logger | null,
): Record<string, unknown> {
  type Block = { modelTier?: unknown; model?: unknown; [k: string]: unknown };
  type RawReview = { semantic?: Block; adversarial?: Block; [k: string]: unknown };

  const review = raw.review as RawReview | undefined;
  if (!review) return raw;

  const semantic = migrateBlock(review.semantic, "review.semantic", logger);
  const adversarial = migrateBlock(review.adversarial, "review.adversarial", logger);
  if (semantic === review.semantic && adversarial === review.adversarial) return raw;

  return {
    ...raw,
    review: {
      ...review,
      ...(semantic !== undefined ? { semantic } : {}),
      ...(adversarial !== undefined ? { adversarial } : {}),
    },
  };

  function migrateBlock(block: Block | undefined, path: string, log: Logger | null): Block | undefined {
    if (!block || block.modelTier === undefined) return block;
    const { modelTier, ...rest } = block;
    if (block.model !== undefined) {
      log?.warn(
        "config",
        `${path}.modelTier is deprecated and ignored — ${path}.model is set and wins. Remove ${path}.modelTier.`,
        { legacyKey: `${path}.modelTier`, canonicalKey: `${path}.model` },
      );
      return rest;
    }
    log?.warn(
      "config",
      `${path}.modelTier is deprecated — migrate to ${path}.model (accepts the same tier string or a { agent, model } pin). Migration shim applied.`,
      { legacyKey: `${path}.modelTier`, canonicalKey: `${path}.model`, value: modelTier },
    );
    return { ...rest, model: modelTier };
  }
}
