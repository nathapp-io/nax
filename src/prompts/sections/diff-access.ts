/** Legacy diff-access API retained as a thin adapter over protocol regions. */

import { applyProtocolRegions, type DiffAccessSpec, type PromptProtocol, wrapAffordance } from "./protocol-region";

export type { DiffAccessSpec, PromptProtocol } from "./protocol-region";
export { renderNative } from "./protocol-region";

/** Any diff-access opener, nonce or not — used to assert none survives dispatch. */
export const DIFF_ACCESS_MARKER_PREFIX = "<!--nax:diff-access";

/** Retained two-argument public API; delegates marker ownership to the registry. */
export function wrapDiffAccess(spec: DiffAccessSpec, shellBody: string): string {
  return wrapAffordance("diff-access", spec, shellBody);
}

/**
 * Retained adapter API. `undefined` advertised tools preserves ungated native
 * rendering for callers that cannot inspect the advertised coding-tool set.
 */
export function applyDiffAccess(prompt: string, protocol: PromptProtocol, advertisedTools?: readonly string[]): string {
  return applyProtocolRegions(prompt, {
    protocol,
    ...(advertisedTools === undefined ? {} : { advertisedTools: new Set(advertisedTools) }),
  });
}
