/**
 * nax's permission rules, translated into an ACP agent's own configuration
 * (SPEC-cursor-pi-acp-read-only). A rule is one `Tool(...)` grant of the grammar
 * native sessions use: `tool` names the tool, `patterns` are its patterns, and a
 * rule is unconditional when one of its patterns is `*` (nax's own test, which
 * treats `["*", "src/**"]` as unconditional too).
 *
 * Only an unconditional deny of a read tool (`Read`, `Glob`, `Grep`) is
 * translated here, and only for profiles `read` and `review`: a read-only
 * profile already runs with the agent's write tools removed, so no rule can
 * widen it. Bash rules are applied by nax itself (shell-rules.ts, US-003), and
 * a path-scoped or non-deny rule is left to the native matcher.
 */
import type { AgentSessionProfile } from "@nathapp/nax-agent";
import { isReadOnlyProfile, launchEnvFor } from "#src/client/capabilities";
import type { ResolvedAcpOptions } from "#src/client/options";
import { OPENCODE_NONE_CONFIG, OPENCODE_READ_CONFIG, OPENCODE_REVIEW_CONFIG } from "#src/client/registry";

export interface AcpRule {
  readonly tool: string;
  readonly patterns: readonly string[];
}

export interface AcpPermissionRules {
  readonly allow: readonly AcpRule[];
  readonly deny: readonly AcpRule[];
  readonly ask: readonly AcpRule[];
}

const NONE: readonly AcpRule[] = Object.freeze([]);

/** The rules of a caller that has none: every list empty. */
export const NO_RULES: AcpPermissionRules = Object.freeze({ allow: NONE, deny: NONE, ask: NONE });

/** The read tools a read-only profile can lose. */
type ReadTool = "Read" | "Glob" | "Grep";

/** A rule denies this tool outright: nax's own "unconditional" test, a pattern holding `*`. */
function denied(rules: AcpPermissionRules, tool: ReadTool): boolean {
  return rules.deny.some((rule) => rule.tool === tool && rule.patterns.includes("*"));
}

/**
 * opencode's `permission` entries and the read tool each one serves, in the order
 * the registry's own configs list them: the catch-all deny first, then each
 * allowance, because opencode's rules are last-match-wins. `list` belongs to
 * `Read`: without the read tool opencode has no reason to list directories either.
 */
const OPENCODE_ENTRIES: readonly (readonly [string, ReadTool])[] = Object.freeze([
  Object.freeze(["read", "Read"] as const),
  Object.freeze(["glob", "Glob"] as const),
  Object.freeze(["grep", "Grep"] as const),
  Object.freeze(["list", "Read"] as const),
]);

/**
 * opencode's permission config for a read-only profile (SPEC US-002). An
 * unconditional deny of a read tool removes its entries, so opencode drops the
 * tool from the model's catalog; with no such rule the result is byte-identical
 * to the registry's OPENCODE_*_CONFIG. `none` ignores the rules: every tool is
 * denied there and no rule can widen it. Bash rules are never translated (an
 * agent matching command text knows nothing of redirects), and `read` keeps no
 * shell tool while `review` asks nax about every command.
 */
export function opencodePermissionConfig(profile: "none" | "read" | "review", rules: AcpPermissionRules): string {
  if (profile === "none") return OPENCODE_NONE_CONFIG;
  const kept = OPENCODE_ENTRIES.filter(([, tool]) => !denied(rules, tool));
  // No read tool is denied: the operator default, byte for byte.
  if (kept.length === OPENCODE_ENTRIES.length) {
    return profile === "review" ? OPENCODE_REVIEW_CONFIG : OPENCODE_READ_CONFIG;
  }
  const permission: Record<string, string> = { "*": "deny" };
  for (const [key] of kept) permission[key] = "allow";
  if (profile === "review") permission.bash = "ask";
  return JSON.stringify({ permission });
}

/**
 * The environment the profile's rules add to the agent process (SPEC US-002), the
 * one seam every launch goes through — a new session, a resume and a reconnect.
 * An agent whose entry names no policy keeps its `launchEnv` untouched, so its
 * env is exactly what it was before rules existed; a custom agent has no entry
 * and gets nothing. The caller spreads this over its own env, so neither the
 * caller nor a model can weaken the enforcement value.
 */
export async function policyLaunchEnv(
  profile: AgentSessionProfile,
  options: ResolvedAcpOptions,
): Promise<Readonly<Record<string, string>>> {
  const entry = options.entry;
  if (!isReadOnlyProfile(profile)) return launchEnvFor(profile, entry);
  if (entry?.readOnly?.policy === "opencode") {
    return Object.freeze({ OPENCODE_CONFIG_CONTENT: opencodePermissionConfig(profile, options.rules) });
  }
  // Cursor and pi build their environment from files under stateDir (US-004).
  return launchEnvFor(profile, entry);
}
