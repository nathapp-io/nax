/**
 * Narrowing a grant an operation inherits.
 *
 * `CodingToolRuntime.advertised()` intersects tool NAMES against the policy's
 * grants, so an op declaring `Write` under the `unrestricted` profile received
 * that profile's `["*"]` — there was no way to say "this role may write, but
 * only this one file" (nax#2013).
 *
 * Narrowing only. `resolvePermissions` remains the single permission authority
 * (CLAUDE.md, Permission Resolution): a tool the profile did not grant has no
 * grant here to narrow, so nothing in this module can widen access.
 *
 * Glob-set intersection is undecidable in general, so the rule is structural
 * rather than semantic — see each branch below.
 */

import { getSafeLogger } from "@/logger";
import type { CodingToolName, ToolGrant } from "./types";

/** Per-tool path globs an operation asks to be held to. */
export type ToolPatternNarrowing = Partial<Record<CodingToolName, readonly string[]>>;

const UNCONDITIONAL = "*";

export function narrowGrants(
  grants: readonly ToolGrant[],
  narrowing: ToolPatternNarrowing | undefined,
): readonly ToolGrant[] {
  if (narrowing === undefined || Object.keys(narrowing).length === 0) return grants;

  // Indexed through a Map rather than `narrowing[grant.tool]`: `ToolGrant.tool`
  // is a plain string (third parties register their own names) while the
  // op-facing type is keyed on CodingToolName so a typo in an op is a compile
  // error. Object.entries bridges the two without a cast.
  const wanted = new Map<string, readonly string[]>(
    Object.entries(narrowing).filter((entry): entry is [string, readonly string[]] => entry[1] !== undefined),
  );

  const out: ToolGrant[] = [];
  for (const grant of grants) {
    const requested = wanted.get(grant.tool);
    if (requested === undefined || requested.length === 0) {
      out.push(grant);
      continue;
    }
    // An unconditional grant is wider than any concrete list, so the op's
    // patterns are unambiguously a narrowing of it.
    if (grant.patterns.includes(UNCONDITIONAL)) {
      out.push({ tool: grant.tool, patterns: [...requested] });
      continue;
    }
    // A scoped grant already names specific globs. Comparing two globs for
    // containment is undecidable, so admit only the ones the grant's author
    // wrote verbatim — which is what a scoped profile intending this writes.
    const admitted = requested.filter((pattern) => grant.patterns.includes(pattern));
    if (admitted.length === 0) {
      getSafeLogger()?.warn("tools", "[policy] op narrowing excluded by the scoped grant — tool withheld", {
        tool: grant.tool,
        requested: [...requested],
        granted: [...grant.patterns],
      });
      continue;
    }
    out.push({ tool: grant.tool, patterns: admitted });
  }
  return out;
}
