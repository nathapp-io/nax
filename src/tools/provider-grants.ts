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
