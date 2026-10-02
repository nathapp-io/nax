/**
 * Expansion of provider grants into the only shape the policy can use.
 *
 * `compileToolPolicy` keys grants by exact tool name, and `advertised()` tests
 * `granted.has(<namespaced name>)`. Any grant-expression sugar a consuming
 * feature defines — `Mcp(server)`, `Mcp(server:tool)` — is SURFACE SYNTAX FOR
 * HUMANS and must be expanded here before compilation. A grant that survives in
 * parsed form compiles to the key `"Mcp"`, matches no advertised name, and
 * denies every call while every parser unit test still passes.
 */
import { namespacedToolName } from "./provider-adapt";
import type { ToolGrant } from "./types";

export interface ProviderGrantEntry {
  readonly providerId: string;
  readonly localNames: readonly string[];
}

export function expandProviderGrants(entries: readonly ProviderGrantEntry[]): readonly ToolGrant[] {
  const grants: ToolGrant[] = [];
  for (const entry of entries) {
    for (const localName of entry.localNames) {
      grants.push({ tool: namespacedToolName(entry.providerId, localName), patterns: ["*"] });
    }
  }
  return grants;
}

/**
 * The pseudo-tool name `Mcp(...)` parses to. SURFACE SYNTAX ONLY: it must be
 * partitioned out and expanded before compilation (see this file's header).
 */
export const MCP_RULE_TOOL = "Mcp";

/**
 * Split `Mcp(...)` rules out of a parsed rule list.
 *
 * Patterns MERGE across entries rather than overwriting, unlike the allow
 * compiler's per-tool last-write-wins: two `Mcp(...)` expressions in one list
 * are two servers a human named, and dropping the earlier one would silently
 * withdraw a grant that is written in the config.
 */
export function partitionMcpRules(grants: readonly ToolGrant[]): {
  readonly grants: readonly ToolGrant[];
  readonly mcpPatterns: readonly string[];
} {
  const kept: ToolGrant[] = [];
  const mcpPatterns: string[] = [];
  for (const grant of grants) {
    if (grant.tool === MCP_RULE_TOOL) mcpPatterns.push(...grant.patterns);
    else kept.push(grant);
  }
  return { grants: kept, mcpPatterns };
}

/** Does an `Mcp` pattern list admit `<providerId>__<localName>`?
 * `*` = every server; `server` = every tool of that server; `server:tool` =
 * one tool; `server:*` = every tool of that server, written explicitly. */
export function mcpRuleAdmits(patterns: readonly string[], providerId: string, localName: string): boolean {
  return patterns.some((pattern) => {
    if (pattern === "*") return true;
    const colon = pattern.indexOf(":");
    if (colon === -1) return pattern === providerId;
    return pattern.slice(0, colon) === providerId && ["*", localName].includes(pattern.slice(colon + 1));
  });
}

/**
 * Expand `Mcp` patterns against the tools a provider actually advertised.
 *
 * Keyed on the post-lock, post-`allowedTools` list the caller passes in, so a
 * rule can only ever narrow what the provider layer already admitted — and the
 * result is concrete `<id>__<tool>` grants, which is the only shape
 * `compileToolPolicy` can key on.
 */
export function expandMcpRuleGrants(
  patterns: readonly string[],
  entries: readonly ProviderGrantEntry[],
): readonly ToolGrant[] {
  const admitted: ProviderGrantEntry[] = entries.map((entry) => ({
    providerId: entry.providerId,
    localNames: entry.localNames.filter((localName) => mcpRuleAdmits(patterns, entry.providerId, localName)),
  }));
  return expandProviderGrants(admitted.filter((entry) => entry.localNames.length > 0));
}
