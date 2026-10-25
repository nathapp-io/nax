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
  /**
   * The provider's own claim that the tool does not modify anything. Only a
   * `discovered` provider sets it (an MCP server's `readOnlyHint`); it is
   * trusted as stated and decides whether an ask-profile session asks first.
   */
  readonly readOnly?: boolean;
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
  /**
   * What the provider says about USING it (#2517), with the same
   * `workdir` contract as `tools` — an MCP server's own `initialize`
   * instructions, plus whatever the host configured. Optional: a provider with
   * nothing to say contributes no section.
   *
   * Called only for a provider that attached to this stage AND still has at
   * least one advertised tool after `admits`, so instructions never describe a
   * capability the model cannot see, and an empty or throwing answer costs the
   * caller nothing (`provider-advertise.ts`).
   */
  instructions?(workdir: string): Promise<string | undefined>;
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
