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
/** Quality flags that were declared but read at no gate site. */
const DEAD_QUALITY_FLAGS = ["requireTypecheck", "requireLint", "requireTests"] as const;

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

  const deadKeys = DEAD_QUALITY_FLAGS.filter((flag) => flag in quality).map((flag) => `quality.${flag}`);
  if (deadKeys.length === 0) return;

  const message = [
    `Invalid configuration — removed quality flags detected: ${deadKeys.join(", ")}.`,
    "These flags were never read at any gate site: typecheck, lint, and test gates fire",
    "whenever a command resolves, so setting one to `false` never skipped its gate.",
    "",
    "To skip a gate, remove its command from `quality.commands` instead:",
    ...deadKeys.map((key) => {
      const gate = key.replace("quality.require", "").toLowerCase();
      return `- Delete \`quality.${key.split(".")[1]}\`; to disable that gate, unset \`quality.commands.${gate}\``;
    }),
  ].join("\n");
  throw new NaxError(message, "CONFIG_DEAD_QUALITY_FLAGS", { stage: "config", deadKeys });
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
