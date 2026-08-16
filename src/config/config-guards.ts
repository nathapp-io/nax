/**
 * Config guards — pre-parse rejection of removed / unimplemented config keys.
 *
 * Zod's default `.strip()` mode silently drops unknown keys. For a key whose
 * removal changes (or appears to change) behaviour, silent stripping leaves the
 * user believing an override still applies. These guards run on the raw config
 * before `safeParse` and throw a `NaxError` naming the key and its migration.
 *
 * Extracted from `loader.ts` to keep that file under the 600-line limit; they
 * are one concern (reject-with-migration-hint) and change together.
 */

import { NaxError } from "../errors";

/**
 * @internal ADR-012 Phase 6 — reject pre-migration agent keys with a migration pointer.
 *
 * Zod's default `.strip()` mode silently drops unknown keys, so pre-migration
 * configs containing `autoMode.defaultAgent`, `autoMode.fallbackOrder`, or
 * `context.v2.fallback` would otherwise run with the wrong default agent and
 * no fallback chain — the exact "T16.3 silent no-op" failure mode ADR-012 was
 * designed to prevent. Throw a NaxError that tells the user what to change.
 *
 * Called on the merged raw config at a single point (after defaults + global +
 * project + profile + CLI merge) so one check catches keys from any source.
 */
export function rejectLegacyAgentKeys(conf: Record<string, unknown>): void {
  const legacyKeys: string[] = [];
  const migrationHints: string[] = [];

  const autoMode = conf.autoMode as Record<string, unknown> | undefined;
  if (autoMode && typeof autoMode === "object") {
    if ("defaultAgent" in autoMode) {
      legacyKeys.push("autoMode.defaultAgent");
      migrationHints.push("- Move `autoMode.defaultAgent` → `agent.default`");
    }
    if ("fallbackOrder" in autoMode) {
      legacyKeys.push("autoMode.fallbackOrder");
      migrationHints.push(
        "- Move `autoMode.fallbackOrder: [primary, ...]` → `agent.fallback.map: { <primary>: [<rest>] }` and `agent.fallback.enabled: true`",
      );
    }
  }

  const context = conf.context as Record<string, unknown> | undefined;
  const contextV2 = context?.v2 as Record<string, unknown> | undefined;
  if (contextV2 && typeof contextV2 === "object" && "fallback" in contextV2) {
    legacyKeys.push("context.v2.fallback");
    migrationHints.push("- Move `context.v2.fallback` → `agent.fallback` (see ADR-012 Phase 6)");
  }

  if (legacyKeys.length === 0) return;

  const message = [
    `Invalid configuration — legacy agent keys detected: ${legacyKeys.join(", ")}.`,
    "These were removed in ADR-012 Phase 6. Migrate to the canonical `agent.*` shape:",
    ...migrationHints,
    "See docs/adr/ADR-012-agent-manager-ownership.md for the full migration guide.",
  ].join("\n");
  throw new NaxError(message, "CONFIG_LEGACY_AGENT_KEYS", { stage: "config", legacyKeys });
}
/**
 * Reject the four legacy rectification-cap keys that were split across
 * `quality.autofix` and `execution.rectification` before the cycle unification.
 * Silent .strip() would mask the change and leave the cycle running with the
 * new defaults despite the user's explicit (now-orphaned) overrides.
 *
 * Migration map:
 *   quality.autofix.maxTotalAttempts           → execution.rectification.maxAttemptsTotal
 *   quality.autofix.rethinkAtAttempt           → execution.rectification.rethinkAtAttempt
 *   quality.autofix.urgencyAtAttempt           → execution.rectification.urgencyAtAttempt
 *   execution.rectification.maxRetries         → execution.rectification.maxAttemptsTotal
 *   execution.regressionGate.maxRectificationAttempts → execution.rectification.maxAttemptsTotal
 */
export function rejectLegacyRectificationKeys(conf: Record<string, unknown>): void {
  const legacyKeys: string[] = [];
  const migrationHints: string[] = [];

  const quality = conf.quality as Record<string, unknown> | undefined;
  const autofix = quality?.autofix as Record<string, unknown> | undefined;
  if (autofix && typeof autofix === "object") {
    if ("maxTotalAttempts" in autofix) {
      legacyKeys.push("quality.autofix.maxTotalAttempts");
      migrationHints.push("- Move `quality.autofix.maxTotalAttempts` → `execution.rectification.maxAttemptsTotal`");
    }
    if ("rethinkAtAttempt" in autofix) {
      legacyKeys.push("quality.autofix.rethinkAtAttempt");
      migrationHints.push("- Move `quality.autofix.rethinkAtAttempt` → `execution.rectification.rethinkAtAttempt`");
    }
    if ("urgencyAtAttempt" in autofix) {
      legacyKeys.push("quality.autofix.urgencyAtAttempt");
      migrationHints.push("- Move `quality.autofix.urgencyAtAttempt` → `execution.rectification.urgencyAtAttempt`");
    }
  }

  const execution = conf.execution as Record<string, unknown> | undefined;
  const rectification = execution?.rectification as Record<string, unknown> | undefined;
  if (rectification && typeof rectification === "object" && "maxRetries" in rectification) {
    legacyKeys.push("execution.rectification.maxRetries");
    migrationHints.push(
      "- Rename `execution.rectification.maxRetries` → `execution.rectification.maxAttemptsTotal` (default changed from 2 to 12)",
    );
  }
  const regressionGate = execution?.regressionGate as Record<string, unknown> | undefined;
  if (regressionGate && typeof regressionGate === "object" && "maxRectificationAttempts" in regressionGate) {
    legacyKeys.push("execution.regressionGate.maxRectificationAttempts");
    migrationHints.push(
      "- Remove `execution.regressionGate.maxRectificationAttempts` — the regression cycle now shares `execution.rectification.maxAttemptsTotal`",
    );
  }

  if (legacyKeys.length === 0) return;

  const message = [
    `Invalid configuration — legacy rectification-cap keys detected: ${legacyKeys.join(", ")}.`,
    "These were consolidated under `execution.rectification.*` so one config controls the unified",
    "fix cycle (semantic + adversarial + mechanical + regression). Migrate as follows:",
    ...migrationHints,
  ].join("\n");
  throw new NaxError(message, "CONFIG_LEGACY_RECTIFICATION_KEYS", { stage: "config", legacyKeys });
}

/**
 * Quality flags that were declared but read at no gate site, mapped to the
 * `quality.commands` key that actually controls each gate. Derived spelling is
 * deliberately avoided: `requireTests` governs `commands.test`, not `.tests`.
 */
const DEAD_QUALITY_FLAGS = {
  requireTypecheck: "typecheck",
  requireLint: "lint",
  requireTests: "test",
} as const;

/**
 * Reject the three `quality.require*` flags.
 *
 * They were declared in the schema, carried through runtime-types and the
 * per-package merge, and documented in the CLI — but read at **no gate site**.
 * Typecheck, lint, and test gates fire whenever a command resolves, regardless
 * of the flag. Setting one to `false` never skipped anything.
 *
 * They are removed rather than wired: wiring would silently change behaviour
 * for anyone who set `false` and has been getting the gate anyway. Removing
 * changes no behaviour — but a silent `.strip()` would leave the user believing
 * the override still applies, so the removal is guarded explicitly.
 *
 * The real control is `quality.commands`: a gate that has no command does not
 * run.
 */
export function rejectDeadQualityFlags(conf: Record<string, unknown>): void {
  const quality = conf.quality as Record<string, unknown> | undefined;
  if (!quality || typeof quality !== "object") return;

  const dead = Object.entries(DEAD_QUALITY_FLAGS).filter(([flag]) => flag in quality);
  if (dead.length === 0) return;
  const deadKeys = dead.map(([flag]) => `quality.${flag}`);

  const message = [
    `Invalid configuration — removed quality flags detected: ${deadKeys.join(", ")}.`,
    "These flags were never read at any gate site: typecheck, lint, and test gates fire",
    "whenever a command resolves, so setting one to `false` never skipped its gate.",
    "",
    "To skip a gate, remove its command from `quality.commands` instead:",
    ...dead.map(
      ([flag, command]) => `- Delete \`quality.${flag}\`; to disable that gate, unset \`quality.commands.${command}\``,
    ),
  ].join("\n");
  throw new NaxError(message, "CONFIG_DEAD_QUALITY_FLAGS", { stage: "config", deadKeys });
}

/**
 * Keys that were declared in the schema and CLI documentation but read at no
 * code site. Setting any of them to `false` was a silent no-op — the behaviour
 * ran unconditionally regardless. Removing them changes no behaviour, but
 * Zod's default `.strip()` would swallow the keys and leave the user
 * believing their override was still in effect.
 *
 * Map value is a migration hint appended to the warning message, telling the
 * user where (or whether) the behaviour they thought they were toggling
 * actually lives. The three `tdd.*` and `execution.rectification.*` entries
 * describe the unconditional behaviour the user was already getting;
 * `acceptance.generateTests` points at the single surviving switch.
 */
const REMOVED_NO_OP_KEYS: Readonly<Record<string, string>> = {
  "execution.rectification.escalateOnExhaustion": "this key had no effect — tier escalation is currently unconditional",
  "tdd.autoVerifyIsolation": "this key had no effect — isolation verification is currently unconditional",
  "tdd.autoApproveVerifier": "this key had no effect — verifier auto-approval is currently unconditional",
  "acceptance.generateTests": "use `acceptance.enabled` instead",
};

/**
 * Strip config keys that were declared but never read, warning once per key.
 *
 * Unlike the four `reject*` siblings above, this function warns rather than
 * throws. The four keys it strips were inert: setting one to `false` never
 * disabled anything. A throw would hard-fail every existing config that
 * supplied an already-inert key, with no behaviour change to show for it. A
 * warning surfaces the false belief (the user was setting a key that did
 * nothing) without breaking already-working configs. The divergence from the
 * `reject*` siblings is deliberate and is captured by this doc comment so
 * the next reader does not read the inconsistency as an oversight.
 *
 * Returns a new object; does not mutate `conf`. Runs after every layer of
 * the config-merge chain so one warning is emitted per resolved config
 * regardless of which layer supplied the key.
 *
 * @param conf - Raw config object (post-merge, pre-`safeParse`).
 * @param warn - Optional sink; called once per removed key. Defaults to
 *   `defaultConfigWarn` from `loader.ts` when invoked via `loadConfig`.
 * @returns A new object with the removed keys stripped.
 */
export function stripRemovedNoOpKeys(
  conf: Record<string, unknown>,
  warn?: (msg: string) => void,
): Record<string, unknown> {
  let result = conf;

  for (const [path, hint] of Object.entries(REMOVED_NO_OP_KEYS)) {
    const segments = path.split(".");
    if (segments.length < 2) continue;

    // Walk into result following `segments`. Tolerate missing intermediates
    // (AC-7: no `tdd` at all) and non-object intermediates (AC-8: `tdd: 42`).
    let parent: Record<string, unknown> | undefined = result;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i];
      const next = parent?.[seg];
      if (next === null || typeof next !== "object") {
        parent = undefined;
        break;
      }
      parent = next as Record<string, unknown>;
    }
    if (!parent) continue;

    const leaf = segments[segments.length - 1];
    if (!(leaf in parent)) continue;

    warn?.(`Config key "${path}" has been removed — ${hint}. Remove it from your config.`);
    const { [leaf]: _removed, ...rest } = parent;
    // Re-attach the stripped parent at its path under `result`. Re-walking
    // from the root keeps the chain immutable — we never mutate the original
    // `conf`, only rebuild new objects above it.
    const newParent = rest;
    if (segments.length === 1) {
      result = newParent;
    } else {
      result = rebuildAtPath(result, segments.slice(0, -1), newParent);
    }
  }

  // Return a new top-level object even when no key matched (AC-3) so callers
  // can treat the result as owned.
  return result === conf ? { ...conf } : result;
}

/**
 * Build a new object whose path (a sequence of segment keys) ends at
 * `value`. Each ancestor is reconstructed as a fresh shallow copy so the
 * original is not mutated.
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
 * @internal Reject `execution.permissionProfile: "scoped"` until Phase 2 lands.
 *
 * The scoped profile is a valid enum value (Zod accepts it), but its resolver
 * (`resolveScopedPermissions`) is still a stub that silently returns "safe"
 * defaults. A user who sets `"scoped"` would believe they have per-stage tool
 * allowlists while actually running in the weaker `safe` mode — a silent
 * downgrade. Fail fast with a pointer to the tracking issue instead.
 *
 * Remove this guard when scoped permissions are implemented (GitHub #374).
 */
export function rejectUnimplementedScopedProfile(conf: Record<string, unknown>): void {
  const execution = conf.execution as Record<string, unknown> | undefined;
  if (execution?.permissionProfile !== "scoped") return;

  const message = [
    'Invalid configuration — execution.permissionProfile: "scoped" is not yet implemented.',
    "The scoped (per-stage tool allowlist) profile is tracked by GitHub #374 and would",
    'otherwise silently run as "safe", giving you weaker permissions than intended.',
    'Use "unrestricted" or "safe" for now.',
  ].join("\n");
  throw new NaxError(message, "CONFIG_SCOPED_PROFILE_UNIMPLEMENTED", { stage: "config" });
}

/**
 * @internal Reject the `execution.permissions` policy block until Phase 2 lands.
 *
 * The block is the per-stage counterpart to `permissionProfile: "scoped"` and
 * belongs to the same unimplemented feature (GitHub #374). Zod accepted and
 * validated its whole shape while nothing in `src/` ever read it, so a user
 * could write a per-stage permission policy, get no error, and get no
 * enforcement — believing their agents were constrained while every stage ran
 * under the resolved profile. Silently ignoring a stated security intent is
 * worse than not offering the key, so this fails fast for the same reason the
 * `"scoped"` profile above does.
 *
 * Remove this guard when scoped permissions are implemented (GitHub #374).
 */
export function rejectUnimplementedPermissionsBlock(conf: Record<string, unknown>): void {
  const execution = conf.execution as Record<string, unknown> | undefined;
  if (execution === null || typeof execution !== "object") return;
  if (!("permissions" in execution)) return;

  const message = [
    "Invalid configuration — execution.permissions is not yet implemented.",
    "Per-stage permission policy is tracked by GitHub #374. The block is currently",
    "read by nothing, so leaving it in place would silently give you no enforcement.",
    "Remove it and use execution.permissionProfile for now.",
  ].join("\n");
  throw new NaxError(message, "CONFIG_PERMISSIONS_BLOCK_UNIMPLEMENTED", { stage: "config" });
}
