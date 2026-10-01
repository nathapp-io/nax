/** Legacy diff-access API retained as a thin adapter over protocol regions. */

import { applyProtocolRegions, type DiffAccessSpec, type PromptProtocol, wrapAffordance } from "./protocol-region";

export type { DiffAccessSpec, PromptProtocol } from "./protocol-region";
export { renderNative } from "./protocol-region";

/** Any diff-access opener, nonce or not — used to assert none survives dispatch. */
export const DIFF_ACCESS_MARKER_PREFIX = "<!--nax:diff-access";

/**
 * One-line notice carried beside the `## Changed Files` stat in ref-mode review
 * prompts.
 *
 * After #2090 every command and the embedded stat are scoped with `-- .`, which
 * both re-spells and RESTRICTS: a change the story made in a sibling package is
 * dropped from the stat and the full diff. `modifiedFiles` may legitimately name
 * such a change (Ruling 8/F), so without a notice the reviewer sees zero
 * evidence the edit exists and nothing says anything was omitted — the likely
 * outcome is a false `unimplemented` (M10). Stating the omission is the fix;
 * restoring visibility is not (the reviewer could not open the out-of-package
 * file before either).
 */
export const DIFF_SCOPE_OMISSION_NOTICE =
  "> Note: this diff is scoped to the current package. Changes committed outside it are not shown below.";

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
