/**
 * Vocabulary for tools supplied by a provider rather than compiled into
 * `CodingToolName`.
 *
 * Providers split by ONE axis that matters: who authored the tool's schema.
 * A `static` provider's schema is written in this repo and reviewed in this
 * repo's PRs, making it exactly as trustworthy as Read's. A `discovered`
 * provider's schema arrives from an external process at runtime, which makes
 * its description a prompt-injection surface and its schema an unbounded
 * context cost. Sanitisation and pinning attach to the KIND, so a trusted
 * provider never inherits ceremony it does not need.
 */

import { NaxError } from "#src/infra/index";
import type { JSONSchema } from "#src/session/tool-descriptor";
import type { ToolResult, ToolRunContext } from "./registry.ts";

export type ProviderKind = "static" | "discovered";

export interface ProviderTool {
  /** Unqualified, as the provider knows it. Namespaced by `provider-adapt`. */
  readonly localName: string;
  readonly description: string;
  readonly inputSchema: JSONSchema;
  run(input: Record<string, unknown>, ctx: ToolRunContext): Promise<ToolResult>;
}

export interface ToolProvider {
  readonly id: string;
  readonly kind: ProviderKind;
  /** Stage names this provider attaches to, or "*" for every stage. */
  readonly stages: readonly string[];
  /**
   * `workdir` is the HOP'S PERMITTED ROOT, never the runtime's workdir. A
   * provider may legitimately expose different tools per working root, and a
   * run executes stories in parallel worktrees.
   */
  tools(workdir: string): Promise<readonly ProviderTool[]>;
}

/**
 * No `__`: that sequence is the namespace separator, and an id containing it
 * would make `<id>__<local>` ambiguous to a human reading a ledger row.
 */
export const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

export function validateProviderId(id: string): void {
  if (!PROVIDER_ID_RE.test(id) || id.includes("__")) {
    throw new NaxError(`provider id ${JSON.stringify(id)} must match ${PROVIDER_ID_RE}`, "PROVIDER_ID_INVALID");
  }
}

export function providerAttachesTo(provider: Pick<ToolProvider, "stages">, stage: string): boolean {
  return provider.stages.some((s) => s === "*" || s === stage);
}
