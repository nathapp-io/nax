/**
 * Bash-specific grant resolution for `buildCodingToolSupport`.
 *
 * Extracted from coding-tool-support.ts, which sits at the 600-line source
 * limit, so this stage's grant math -- and the explanatory comments that are
 * load-bearing for reading the ADR-030 gating rule correctly -- have room to
 * live without pushing the caller over the limit.
 *
 * Pure: no I/O, no `NaxError`. Decides nothing about the empty-root guard or
 * the terminal `tools.length === 0` guard; both stay in coding-tool-support.ts,
 * where the rest of the runtime is assembled.
 */

import type { BashApprovalMode } from "@/config/bash-approval";
import { BASH_TOOL_NAME, type CodingToolName, narrowGrants, type ToolGrant, type ToolPatternNarrowing } from "@/tools";

export interface BashSupportResolution {
  /**
   * The grants `compileToolPolicy` should compile -- narrowed, and with the
   * ADR-030 synthetic `Bash(*)` grant appended under `raw` when applicable.
   */
  readonly effectiveGrants: readonly ToolGrant[];
  /** Whether the op should receive a Bash tool at all (the declaration ceiling). */
  readonly allowBash: boolean;
  /**
   * The patterns the Bash tool's description should name -- the EFFECTIVE
   * grant (post-synthetic), not the pre-synthetic human grant, so a `raw`
   * stage with no human `Bash(...)` rule still names what it can actually
   * run instead of the stale "no command forms are granted" (ADR-030 / F3).
   * `createBashTool` ignores this entirely under `raw` (it has its own
   * static raw description), so the distinction only matters for
   * `gated`/`escalate`, where it is identical to the pre-synthetic grant --
   * `raw` is the only mode that ever synthesizes one.
   */
  readonly bashDescriptionPatterns: readonly string[];
}

/**
 * Resolve the Bash-specific half of a stage's compiled grants.
 *
 * `grants` is the RAW (pre-narrow) grant list, matching what
 * `buildCodingToolSupport` used to pass into `narrowGrants` inline.
 */
export function resolveBashSupport(args: {
  declared: readonly CodingToolName[];
  grants: readonly ToolGrant[];
  toolPatterns?: ToolPatternNarrowing;
  bashApproval: BashApprovalMode;
}): BashSupportResolution {
  // Narrowed, not raw: `narrowGrants` is what the POLICY compiles, so reading
  // the raw list here would name forms in the tool's description that the
  // policy then refuses -- the wasted turn the `patterns` option exists to
  // prevent, inverted.
  const narrowedGrants = narrowGrants(args.grants, args.toolPatterns);
  const bashGrant = narrowedGrants.findLast((grant) => grant.tool === BASH_TOOL_NAME);
  const allowBash = args.declared.includes(BASH_TOOL_NAME);

  // ADR-030: `raw` changes GATING, not GRANTING — the Bash tool still has to be
  // granted or `callTool` never reaches the policy. The grant is synthetic
  // (no human wrote a `Bash(...)` rule) and is deliberately conditioned on the
  // op having DECLARED Bash. That condition is what keeps review ops and the
  // verifier shell-free under every mode: they declare no Bash, so no mode can
  // hand them one. Never grant unconditionally here.
  const syntheticGrant: ToolGrant | undefined =
    args.bashApproval === "raw" && allowBash && bashGrant === undefined
      ? { tool: BASH_TOOL_NAME, patterns: ["*"] }
      : undefined;
  const effectiveGrants = syntheticGrant !== undefined ? [...narrowedGrants, syntheticGrant] : narrowedGrants;
  const effectiveBashGrant = bashGrant ?? syntheticGrant;

  return {
    effectiveGrants,
    allowBash,
    bashDescriptionPatterns: effectiveBashGrant?.patterns ?? [],
  };
}
