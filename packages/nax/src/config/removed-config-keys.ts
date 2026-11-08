/**
 * Removed config keys — warn-and-strip compatibility for the keys C1 retired.
 *
 * Since pipeline mode was removed, a config key that only configured it is dead
 * weight: the schema field is gone, so Zod's default `.strip()` would silently
 * drop it and leave the user believing their override still applies. This module
 * is the compatibility layer that keeps such a config loading while its author
 * migrates: the key is dropped and one warning per key names it and says what
 * (if anything) the behaviour it configured does now.
 *
 * `stripKeysAtPaths` is the shared traversal. It was extracted from
 * `stripRemovedNoOpKeys` (config-guards.ts) so the two key maps — the declared
 * but never-read keys and the pipeline-only keys — walk paths one way, rebuild
 * the objects above the change one way, and tolerate missing and non-object
 * intermediates one way.
 *
 * Wiring: `stripRemovedConfig` (removed-stage-names.ts) runs the no-op strip,
 * then this strip, then the removed-stage-name strip, with one sink. The loader
 * calls it at all three strip sites, before `NaxConfigSchema.safeParse`, so a key
 * under a `.strict()` schema (`CommandInterceptorConfigSchema`) is gone before
 * the schema sees it.
 */

/** Hint for a key that only configured the removed pipeline mode. */
export const PIPELINE_ONLY_KEY_HINT = "nothing reads this key since pipeline mode was removed";

/**
 * Hint for `execution.commandInterceptor.provider`, which was never read at any
 * site — not even in pipeline mode: the interceptor has always been rtk.
 */
const COMMAND_INTERCEPTOR_PROVIDER_HINT = "nothing read this key; the interceptor is always rtk";

/**
 * Hint for `execution.verificationTimeoutSeconds`. The verify timeout it
 * configured is now `execution.regressionGate.timeoutSeconds` — the value
 * `operations/verify-scoped.ts` has always read.
 */
const VERIFICATION_TIMEOUT_HINT = "verification uses execution.regressionGate.timeoutSeconds";

/**
 * Hint for the two keys that configured story worktree isolation
 * (`execution.storyIsolation`, `execution.worktreeDependencies`). Their readers
 * went with the worktree execution path, so there is no replacement setting:
 * stories always run in the project checkout.
 */
const STORY_ISOLATION_HINT =
  "stories always run in the project checkout since worktree isolation was removed with pipeline mode";

/**
 * Config keys removed in C1, each mapped to the hint its warning appends.
 *
 * Map value is a migration hint telling the user what the behaviour they thought
 * they were configuring does now. Only `execution.rectification.maxAttemptsTotal`
 * and `execution.rectification.fullSuiteTimeoutSeconds` are read out of the
 * rectification section, so the eleven leaves below are all inert; the two whole
 * sections (flakeDetection, mutationCheck) were declared, defaulted, merged and
 * documented but read at no code site; the interceptor's `provider` was never
 * read even in pipeline mode; `regressionGate.mode` was declared, defaulted,
 * merged and documented but read at no code site; and the verification timeout
 * is `regressionGate.timeoutSeconds`, not a key of its own.
 *
 * `acceptance` is the third whole section: `src/acceptance/` was deleted with
 * pipeline mode, so every leaf under it configured a phase no run has. The whole
 * section was pipeline-only, which is why it takes `PIPELINE_ONLY_KEY_HINT`
 * rather than a per-key hint.
 *
 * `execution.storyIsolation` and `execution.worktreeDependencies` configured the
 * story-worktree execution path, which was deleted with pipeline mode too; both
 * take `STORY_ISOLATION_HINT`, which names what stories do now instead.
 *
 * The tdd, autoMode and quality entries configured pipeline sessions and
 * strategies (the TDD test-writer and verifier sessions, the autofix strategy,
 * the lint and format fix commands) that no workflow run has, so they take
 * `PIPELINE_ONLY_KEY_HINT` too.
 *
 * A section entry strips the WHOLE section — one warning for the section, not one
 * per leaf under it.
 */
export const REMOVED_CONFIG_KEYS: Readonly<Record<string, string>> = {
  acceptance: PIPELINE_ONLY_KEY_HINT,
  "autoMode.enabled": PIPELINE_ONLY_KEY_HINT,
  "tdd.maxRetries": PIPELINE_ONLY_KEY_HINT,
  "tdd.sessionTiers": PIPELINE_ONLY_KEY_HINT,
  "tdd.verifierTimeoutSeconds": PIPELINE_ONLY_KEY_HINT,
  "tdd.testWriterAllowedPaths": PIPELINE_ONLY_KEY_HINT,
  "tdd.testWriterCommitHooks": PIPELINE_ONLY_KEY_HINT,
  "tdd.rollbackOnFailure": PIPELINE_ONLY_KEY_HINT,
  "quality.commands.lintFix": PIPELINE_ONLY_KEY_HINT,
  "quality.commands.lintFixScoped": PIPELINE_ONLY_KEY_HINT,
  "quality.commands.formatFix": PIPELINE_ONLY_KEY_HINT,
  "quality.commands.formatFixScoped": PIPELINE_ONLY_KEY_HINT,
  "quality.typecheckOutput": PIPELINE_ONLY_KEY_HINT,
  "quality.autofix": PIPELINE_ONLY_KEY_HINT,
  "review.commands.lintFix": PIPELINE_ONLY_KEY_HINT,
  "review.commands.lintFixScoped": PIPELINE_ONLY_KEY_HINT,
  "review.commands.formatFix": PIPELINE_ONLY_KEY_HINT,
  "review.commands.formatFixScoped": PIPELINE_ONLY_KEY_HINT,
  "execution.rectification.enabled": PIPELINE_ONLY_KEY_HINT,
  "execution.rectification.maxAttemptsPerStrategy": PIPELINE_ONLY_KEY_HINT,
  "execution.rectification.maxFailureSummaryChars": PIPELINE_ONLY_KEY_HINT,
  "execution.rectification.abortOnIncreasingFailures": PIPELINE_ONLY_KEY_HINT,
  "execution.rectification.consecutiveIncreasesToBail": PIPELINE_ONLY_KEY_HINT,
  "execution.rectification.abortOnNoProgress": PIPELINE_ONLY_KEY_HINT,
  "execution.rectification.consecutiveNoProgressToBail": PIPELINE_ONLY_KEY_HINT,
  "execution.rectification.storyScopedFixBudget": PIPELINE_ONLY_KEY_HINT,
  "execution.rectification.rethinkAtAttempt": PIPELINE_ONLY_KEY_HINT,
  "execution.rectification.urgencyAtAttempt": PIPELINE_ONLY_KEY_HINT,
  "execution.rectification.repoScopedFallback": PIPELINE_ONLY_KEY_HINT,
  "execution.flakeDetection": PIPELINE_ONLY_KEY_HINT,
  "execution.mutationCheck": PIPELINE_ONLY_KEY_HINT,
  "execution.commandInterceptor.provider": COMMAND_INTERCEPTOR_PROVIDER_HINT,
  "execution.verificationTimeoutSeconds": VERIFICATION_TIMEOUT_HINT,
  "execution.regressionGate.mode": PIPELINE_ONLY_KEY_HINT,
  "execution.storyIsolation": STORY_ISOLATION_HINT,
  "execution.worktreeDependencies": STORY_ISOLATION_HINT,
};

/** The warning one removed path emits. */
function removalMessage(path: string, hint: string): string {
  return `Config key "${path}" has been removed — ${hint}. Remove it from your config.`;
}

/**
 * The object that directly holds the leaf of `segments`, or undefined when the
 * walk cannot reach it.
 *
 * Tolerates missing intermediates (no `execution` at all) and non-object
 * intermediates (`execution: 42`): either way the leaf cannot be a property of
 * anything, so there is nothing to strip and nothing to warn about.
 */
function parentAtPath(root: Record<string, unknown>, segments: string[]): Record<string, unknown> | undefined {
  let parent: Record<string, unknown> = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const next = parent[segments[i]];
    if (next === null || typeof next !== "object") return undefined;
    parent = next as Record<string, unknown>;
  }
  return parent;
}

/**
 * Build a new object whose path (a sequence of segment keys) ends at `value`.
 * Each ancestor is reconstructed as a fresh shallow copy so the original is not
 * mutated.
 */
function rebuildAtPath(
  root: Record<string, unknown>,
  path: string[],
  value: Record<string, unknown>,
): Record<string, unknown> {
  if (path.length === 0) return value;
  const [head, ...tail] = path;
  return { ...root, [head]: rebuildAtPath((root[head] as Record<string, unknown>) ?? {}, tail, value) };
}

/**
 * Strip each dotted path in `keys` from `conf`, warning once per path present:
 * `Config key "<path>" has been removed — <hint>. Remove it from your config.`
 *
 * Tolerates missing and non-object intermediates. Returns a new object; never
 * mutates `conf`. The new top-level object is returned even when no path
 * matched, so callers can treat the result as owned.
 *
 * @param conf - Raw config object (post-merge, pre-`safeParse`).
 * @param keys - Dotted config paths mapped to the hint their warning appends.
 * @param warn - Optional sink; called once per removed path.
 * @returns A new object with the removed paths stripped.
 */
export function stripKeysAtPaths(
  conf: Record<string, unknown>,
  keys: Readonly<Record<string, string>>,
  warn?: (msg: string) => void,
): Record<string, unknown> {
  let result = conf;

  for (const [path, hint] of Object.entries(keys)) {
    const segments = path.split(".");
    // A single-segment key targets the top level: the walk below simply never
    // descends, so `parent` stays the root object.
    const parent = parentAtPath(result, segments);
    if (!parent) continue;

    const leaf = segments[segments.length - 1];
    if (!(leaf in parent)) continue;

    warn?.(removalMessage(path, hint));
    const { [leaf]: _removed, ...rest } = parent;
    // Re-attach the stripped parent at its path under `result`. Re-walking from
    // the root keeps the chain immutable — we never mutate the original `conf`,
    // only rebuild new objects above it.
    result = segments.length === 1 ? rest : rebuildAtPath(result, segments.slice(0, -1), rest);
  }

  return result === conf ? { ...conf } : result;
}

/**
 * `stripKeysAtPaths` bound to `REMOVED_CONFIG_KEYS` — the strip every loader
 * site runs for the keys C1 removed.
 */
export function stripRemovedConfigKeys(
  conf: Record<string, unknown>,
  warn?: (msg: string) => void,
): Record<string, unknown> {
  return stripKeysAtPaths(conf, REMOVED_CONFIG_KEYS, warn);
}
