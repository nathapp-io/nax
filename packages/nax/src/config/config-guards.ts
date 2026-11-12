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

import { MCP_RULE_TOOL, RESERVED_TOOL_NAMES } from "@nathapp/nax-agent";
// Leaf import — see config-warnings.ts's own header comment for why this must
// not route through the `@/quality` barrel (config -> quality -> config cycle).
import type { QualityCommandSpec } from "@nathapp/nax-agent/internal";
import { NaxError } from "../errors";
import { collectCommandChainWarnings } from "./config-warnings";
import { stripKeysAtPaths } from "./removed-config-keys";
import { MCP_SERVER_ID_RE } from "./schemas-mcp";

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
 *   quality.autofix.rethinkAtAttempt           → removed: nothing reads it since pipeline mode was removed
 *   quality.autofix.urgencyAtAttempt           → removed: nothing reads it since pipeline mode was removed
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
      migrationHints.push("- Remove `quality.autofix.rethinkAtAttempt`");
    }
    if ("urgencyAtAttempt" in autofix) {
      legacyKeys.push("quality.autofix.urgencyAtAttempt");
      migrationHints.push("- Remove `quality.autofix.urgencyAtAttempt`");
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
    "Attempt-cap keys are consolidated under `execution.rectification.*` so one config controls the",
    "unified fix cycle (semantic + adversarial + mechanical + regression); the rest are removed, not",
    "moved. Migrate as follows:",
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
 * Plan modes removed with the debate subsystem and the asymmetric pipeline.
 *
 * Unlike the inert keys handled by `stripRemovedNoOpKeys`, these were not
 * no-ops: a config that named one was getting that strategy. Silently
 * resolving to `single` would change the user's plan output without telling
 * them, so this guard throws — matching `rejectDeadQualityFlags` rather than
 * the warn-and-strip path. The narrowed Zod enum would reject these too, but
 * only with "Invalid option: expected one of ...", which names the survivors
 * and explains nothing.
 */
const REMOVED_PLAN_MODES: Readonly<Record<string, string>> = {
  pipeline:
    "the asymmetric pipeline plan mode was removed along with its grounder, draft and critic stages; nax no longer grounds plans against a facts manifest",
  debate: "the multi-agent debate subsystem was removed",
};

/** Pipeline mode was removed (C1 B1). Runs on each raw config layer, before it is merged. */
export function rejectPipelineModeKeys(layer: Record<string, unknown>, source: string): void {
  const execution = layer.execution;
  if (!execution || typeof execution !== "object") return;
  const keys: string[] = [];
  const hints: string[] = [];
  if ("mode" in execution && execution.mode === "pipeline") {
    keys.push("execution.mode");
    hints.push('- execution.mode: remove it, or set it to "workflow".');
  }
  if (Object.hasOwn(execution, "maxIterations")) {
    keys.push("execution.maxIterations");
    hints.push("- execution.maxIterations: remove it.");
  }
  if (keys.length === 0) return;
  const message = [
    `Invalid configuration in ${source} — pipeline mode was removed: ${keys.join(", ")}.`,
    "Workflow mode is the only execution mode, and it bounds a run by its stories.",
    ...hints,
  ].join("\n");
  throw new NaxError(message, "CONFIG_PIPELINE_MODE_REMOVED", { stage: "config", source, keys });
}

export function rejectRemovedPlanModes(conf: Record<string, unknown>): void {
  const plan = conf.plan as Record<string, unknown> | undefined;
  if (!plan || typeof plan !== "object") return;

  const mode = plan.mode;
  if (typeof mode !== "string") return;

  const reason = REMOVED_PLAN_MODES[mode];
  if (!reason) return;

  const message = [
    `Invalid configuration — removed plan mode: plan.mode: "${mode}".`,
    `${reason.charAt(0).toUpperCase()}${reason.slice(1)}.`,
    "",
    "Set `plan.mode` to one of the surviving modes instead:",
    "- `single` — one planning call (the default when `plan.mode` is unset)",
    "- `refine` — a draft call followed by a self-audit call",
  ].join("\n");
  throw new NaxError(message, "CONFIG_REMOVED_PLAN_MODE", { stage: "config", mode });
}

/**
 * Warn (never throw) when a declared `quality.commands` entry chains with
 * `&&`. A chain still runs exactly as it always did — this is a nudge toward
 * the list form (nax#1990), not a removal, so it follows the warn-and-continue
 * shape of `stripRemovedNoOpKeys` rather than the throw-with-migration-hint
 * shape of the `reject*` guards above: an existing config with a chained
 * command must keep working.
 *
 * @param conf - Raw config object (post-merge, pre-`safeParse`).
 * @param warn - Sink; called once per offending `quality.commands` key.
 *   Defaults to `defaultConfigWarn` from `compat-shims.ts` when invoked via
 *   `loadConfig`, mirroring every other shim in this file.
 */
export function warnQualityCommandChains(conf: Record<string, unknown>, warn?: (msg: string) => void): void {
  const quality = conf.quality as Record<string, unknown> | undefined;
  if (!quality || typeof quality !== "object") return;

  const commands = quality.commands as Partial<Record<string, QualityCommandSpec>> | undefined;
  for (const message of collectCommandChainWarnings(commands)) {
    warn?.(message);
  }
}

/**
 * The placeholder a scoped test command MUST carry so the runner can scope a
 * run to the agent's own files.
 */
const TEST_FILES_PLACEHOLDER = "{{files}}";

/** The string entries of a raw, pre-safeParse `QualityCommandSpec`. A
 *  malformed spec (scalar non-string, mixed array) yields none — Zod reports
 *  it below, and this guard is warn-only. */
function commandEntries(spec: unknown): string[] {
  if (typeof spec === "string") return [spec];
  if (Array.isArray(spec) && spec.every((entry) => typeof entry === "string")) return spec;
  return [];
}

/**
 * Warn (never throw) when `quality.commands.testScoped` cannot scope a run:
 *
 * - it carries no `{{files}}` placeholder, so there is nowhere to put the
 *   agent's files and every "scoped" run is the declared command verbatim;
 * - it is the same command as `quality.commands.test`, so a scoped run IS the
 *   full suite — the exact failure the placeholder exists to prevent.
 *
 * A command list is checked across its entries: it warns for a missing
 * placeholder only when NO entry holds one. Warn-only, like
 * `warnQualityCommandChains`: the command still runs as configured, and an
 * existing config must keep working.
 *
 * @param conf - Raw config object (post-merge, pre-`safeParse`).
 * @param warn - Sink; called at most once, with the most specific message.
 */
export function warnScopedTestCommand(conf: Record<string, unknown>, warn?: (msg: string) => void): void {
  const quality = conf.quality as Record<string, unknown> | undefined;
  if (!quality || typeof quality !== "object") return;

  const commands = quality.commands as Record<string, unknown> | undefined;
  if (!commands || typeof commands !== "object") return;

  const scoped = commandEntries(commands.testScoped);
  if (scoped.length === 0) return;

  const test = commandEntries(commands.test);
  // Equality is reported first: when both hold, "every scoped run is the full
  // suite" is the actionable consequence, and one warning per problem reads
  // better than two lines saying the same thing twice.
  if (test.length > 0 && scoped.length === test.length && scoped.every((entry, i) => entry === test[i])) {
    warn?.("quality.commands.testScoped equals quality.commands.test, so every scoped run is the full suite");
    return;
  }

  if (scoped.some((entry) => entry.includes(TEST_FILES_PLACEHOLDER))) return;

  warn?.(
    "quality.commands.testScoped declares no {{files}} placeholder, so agents cannot scope a test run to their files; add {{files}} where the runner takes test paths",
  );
}

/**
 * Keys that were declared in the schema and CLI documentation but read at no
 * code site. Setting any of them to `false` was a silent no-op — the behaviour
 * ran unconditionally regardless. Removing them changes no behaviour, but
 * Zod's default `.strip()` would swallow the keys and leave the user
 * believing their override was still in effect.
 *
 * The map covers whole retired subsystems too, not only inert leaf keys:
 * `debate` was removed with the multi-agent debate subsystem, and
 * `plan.citationThreshold`/`plan.criticModel` only fed the removed pipeline
 * plan mode. Clearing `plan.mode` of `"debate"`/`"pipeline"` is deliberately
 * NOT handled here — those modes were not inert (a config naming one was
 * getting that strategy), so `rejectRemovedPlanModes` throws on them instead.
 *
 * Map value is a migration hint appended to the warning message, telling the
 * user where (or whether) the behaviour they thought they were toggling
 * actually lives. The three `tdd.*` and `execution.rectification.*` entries
 * describe the unconditional behaviour the user was already getting.
 */
const REMOVED_NO_OP_KEYS: Readonly<Record<string, string>> = {
  "execution.rectification.escalateOnExhaustion": "this key had no effect — tier escalation is currently unconditional",
  "tdd.autoVerifyIsolation": "this key had no effect — isolation verification is currently unconditional",
  "tdd.autoApproveVerifier": "this key had no effect — verifier auto-approval is currently unconditional",
  "review.gateLLMChecksOnMechanicalPass":
    "LLM review checks are sequenced by the story orchestrator; this key never had an effect after #1859",
  debate:
    "the multi-agent debate subsystem was removed; a config that enabled debate.stages.plan without setting plan.mode was resolving to the debate plan strategy and now plans with `single` — set plan.mode explicitly to `single` or `refine`",
  "plan.citationThreshold": "this key only fed the removed pipeline plan mode",
  "plan.criticModel": "this key only fed the removed pipeline plan mode",
};

/**
 * Strip config keys that were declared but never read, warning once per key.
 *
 * Unlike the four `reject*` siblings above, this function warns rather than
 * throws. The keys it strips were inert: setting one to `false` never
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
  // The path walk, the message and the immutable rebuild live in one place for
  // both key maps — see `removed-config-keys.ts`.
  return stripKeysAtPaths(conf, REMOVED_NO_OP_KEYS, warn);
}

/**
 * @internal Validate one tool expression (`Tool` or `Tool(pattern, ...)`)
 * against the known-tool set, naming the stage in every error. Private because
 * only `validatePermissionsBlock` owns the decision of which lists to scan.
 */
function validateToolExpression(stage: string, expression: string, known: Set<string>): void {
  const open = expression.indexOf("(");
  const tool = (open === -1 ? expression : expression.slice(0, open)).trim();
  if (!known.has(tool)) {
    throw new NaxError(
      [
        `Invalid configuration — execution.permissions.${stage} grants unknown tool "${tool}".`,
        `Known tools: ${[...known].join(", ")}.`,
        "An unrecognised name would grant nothing while appearing to grant something.",
      ].join("\n"),
      "CONFIG_PERMISSIONS_UNKNOWN_TOOL",
      { stage: "config", tool },
    );
  }
  if (open !== -1 && !expression.trimEnd().endsWith(")")) {
    throw new NaxError(
      `Invalid configuration — execution.permissions.${stage} has an unclosed pattern list in "${expression}".`,
      "CONFIG_PERMISSIONS_BAD_PATTERN",
      { stage: "config" },
    );
  }
  // An EMPTY list is refused for EVERY tool, never widened. `parseToolExpression`
  // (`packages/nax-agent/src/permissions/grammar.ts`) collapses an empty list to ["*"], so a typo'd
  // `Bash()` loads clean and grants every shell command -- the exact widening
  // validateMcpExpression already refuses, and Bash is where it costs most. A
  // bare `Bash` with no parentheses stays valid: that names the wildcard by
  // omitting the list, which is a thing a human writes on purpose. `Mcp` is
  // excluded because validateMcpExpression owns its whole surface shape,
  // including a bare `Mcp`, and says so in the vocabulary of servers.
  if (
    tool !== MCP_RULE_TOOL &&
    open !== -1 &&
    expression
      .slice(open + 1, expression.lastIndexOf(")"))
      .split(",")
      .every((p) => p.trim() === "")
  ) {
    throw new NaxError(
      `Invalid configuration — execution.permissions.${stage} has "${expression}", which names no pattern. ` +
        `An empty list is read as every pattern; write ${tool}(*) if that is what you meant, or name the patterns.`,
      "CONFIG_PERMISSIONS_BAD_PATTERN",
      { stage: "config" },
    );
  }
  if (tool === MCP_RULE_TOOL) validateMcpExpression(stage, expression);
}

/**
 * @internal Validate one `Mcp(...)` expression. Extracted from
 * `validateToolExpression` because the empty-list rules add a second concern
 * (surface-shape) beside the per-pattern id check.
 *
 * An EMPTY pattern list is refused, never widened: `parseToolExpression`
 * (`packages/nax-agent/src/permissions/grammar.ts`) collapses an empty list to `["*"]`, so a bare
 * `Mcp`, `Mcp()` or `Mcp(,)` left unchecked would silently admit every provider
 * under `scoped` — the opposite of an allowlist. `Mcp(*)` stays valid because it
 * names the wildcard explicitly.
 */
function validateMcpExpression(stage: string, expression: string): void {
  const malformed = (detail: string): NaxError =>
    new NaxError(
      `Invalid configuration — execution.permissions.${stage} has a malformed Mcp pattern "${expression}". ${detail}`,
      "CONFIG_PERMISSIONS_BAD_PATTERN",
      { stage: "config" },
    );

  const open = expression.indexOf("(");
  if (open === -1) {
    throw malformed("A bare Mcp names no server; write Mcp(<serverId>) or Mcp(<serverId>:<tool>).");
  }

  const inner = expression.slice(open + 1, expression.lastIndexOf(")"));
  const patterns = inner.split(",").map((entry) => entry.trim());
  if (patterns.every((pattern) => pattern === "")) {
    throw malformed("An empty Mcp names no server; under `scoped` it admits nothing, never everything.");
  }

  for (const pattern of patterns) {
    if (pattern === "" || pattern === "*") continue;
    const colon = pattern.indexOf(":");
    const serverId = colon === -1 ? pattern : pattern.slice(0, colon);
    const toolName = colon === -1 ? undefined : pattern.slice(colon + 1);
    // The server id's SHAPE is checked; its existence is not. A config is
    // shared across machines, so an unconfigured server is a resolve-time
    // warning, never a load error. `__` is rejected too: it is the tool-name
    // namespace separator, so a server id containing it can never match
    // (McpServerIdSchema and validateProviderId reject it for the same reason).
    if (!MCP_SERVER_ID_RE.test(serverId) || serverId.includes("__") || (toolName !== undefined && toolName === "")) {
      throw malformed(`Expected Mcp(<serverId>) or Mcp(<serverId>:<tool>), server ids matching ${MCP_SERVER_ID_RE}.`);
    }
  }
}

type PermissionBlocks = Record<
  string,
  { allowedTools?: unknown; allow?: unknown; deny?: unknown; ask?: unknown; inherit?: unknown } | undefined
>;

/** Validate block references without treating Object prototype members as blocks. */
function validatePermissionInheritance(blocks: PermissionBlocks, stage: string, inherit: unknown): void {
  if (typeof inherit === "string" && (!Object.hasOwn(blocks, inherit) || blocks[inherit] === undefined)) {
    throw new NaxError(
      `Invalid configuration — execution.permissions.${stage}.inherit names "${inherit}", which is not a permission block.`,
      "CONFIG_PERMISSIONS_BAD_INHERIT",
      { stage: "config" },
    );
  }

  // A cycle is not a security hole -- resolveScopedPermissions walks with its
  // own seen-set and falls through to `default`, so a cycle yields FEWER
  // grants, never more. It is refused because of how it fails: the stage
  // silently receives the default block's grants instead of the ones its
  // author wrote, and the symptom is a mid-run permission denial with
  // nothing pointing back at the config.
  //
  // The seen-set is per-walk, not shared across stages: two stages inheriting
  // the same target is convergence, not a cycle.
  const seen = new Set<string>([stage]);
  const path = [stage];
  let cursor = inherit;
  while (typeof cursor === "string") {
    path.push(cursor);
    if (seen.has(cursor)) {
      throw new NaxError(
        [
          `Invalid configuration — execution.permissions has an inherit cycle: ${path.join(" -> ")}.`,
          "A cycle resolves to the default block rather than the grants written here,",
          "so the stage would be denied something the config appears to permit.",
        ].join("\n"),
        "CONFIG_PERMISSIONS_INHERIT_CYCLE",
        { stage: "config" },
      );
    }
    seen.add(cursor);
    cursor = Object.hasOwn(blocks, cursor) ? blocks[cursor]?.inherit : undefined;
  }
}

/**
 * @internal Validate `execution.permissions` at load time.
 *
 * Replaces rejectUnimplementedScopedProfile/rejectUnimplementedPermissionsBlock,
 * which refused the block outright while it was unenforced. Now that it IS
 * enforced, the failure mode inverts: a typo in a tool name would silently grant
 * nothing, which reads as "the policy is working" right up until it is not.
 * ConfigError at load beats a surprise mid-run.
 */
export function validatePermissionsBlock(conf: Record<string, unknown>): void {
  const execution = conf.execution as Record<string, unknown> | undefined;
  const blocks = execution?.permissions as PermissionBlocks | undefined;
  if (!blocks) return;

  // `Mcp` is a PSEUDO-tool: it is expanded to concrete `<server>__<tool>`
  // grants before compilation (packages/nax-agent/src/tools/provider-grants.ts), so it is legal
  // in a rule list even though no tool by that name is ever registered.
  const known = new Set<string>([...RESERVED_TOOL_NAMES, MCP_RULE_TOOL]);
  for (const [stage, block] of Object.entries(blocks)) {
    validatePermissionInheritance(blocks, stage, block?.inherit);

    if (block?.allowedTools !== undefined && block?.allow !== undefined) {
      throw new NaxError(
        [
          `Invalid configuration — execution.permissions.${stage} carries both "allowedTools" and "allow".`,
          `"allowedTools" is the legacy alias of "allow"; a block may use one, never both,`,
          "because a merge would silently decide which list wins.",
        ].join("\n"),
        "CONFIG_PERMISSIONS_ALLOW_ALIAS_CONFLICT",
        { stage: "config" },
      );
    }

    for (const key of ["allowedTools", "allow", "deny", "ask"] as const) {
      const list = block?.[key];
      if (list === undefined || !Array.isArray(list)) continue;
      // ALLOW only. `compileToolPolicy` is last-write-wins per tool, so two
      // allow expressions naming one tool silently discard the first -- a live
      // run granting `Bash(bun test *)` and `Bash(echo *)` reported "granted
      // forms: echo *" and denied the test command. Deny and ask MERGE
      // (`compileRuleMap`), so duplicates there are legal and mean what they say.
      //
      // Refused rather than merged: merging would change the verdict for any
      // config already carrying two expressions for one tool, which the
      // byte-identity regression gate pins. An error names the one-expression
      // form instead, and loses no grant anyone can currently rely on.
      if (key === "allow" || key === "allowedTools") {
        const seenTools = new Set<string>();
        for (const expression of list) {
          if (typeof expression !== "string") continue;
          const open = expression.indexOf("(");
          const tool = (open === -1 ? expression : expression.slice(0, open)).trim();
          if (seenTools.has(tool)) {
            throw new NaxError(
              `Invalid configuration — execution.permissions.${stage}.${key} names "${tool}" more than once. ` +
                `Only the last expression would take effect; combine the patterns into one, e.g. ${tool}(a, b).`,
              "CONFIG_PERMISSIONS_DUPLICATE_TOOL",
              { stage: "config", tool },
            );
          }
          seenTools.add(tool);
        }
      }
      for (const expression of list) {
        if (typeof expression !== "string") continue;
        validateToolExpression(stage, expression, known);
      }
    }
  }
}
