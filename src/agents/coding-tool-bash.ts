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
   * The compiled (pre-synthetic) human `Bash(...)` grant's patterns, for the
   * tool description -- so it names what THIS stage's own rules permit
   * rather than a generic sentence. Carried over verbatim from the
   * pre-extraction call site; F3 (ADR-030) later widens what the caller
   * passes into the description to the EFFECTIVE grant under `raw`.
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

  return {
    effectiveGrants,
    allowBash,
    bashDescriptionPatterns: bashGrant?.patterns ?? [],
  };
}
