/**
 * Gate command provenance — choose each quality gate's cwd from the actual
 * source of its command rather than from an unrelated package-level override.
 *
 * A package overlay that defines only `quality.commands.test` says nothing
 * about where the package's `lint` command should run. Routing that lint gate
 * into the package dir because an override "exists" runs the repo-root lint
 * command from the wrong directory (or vacates it entirely).
 */
import type { PackageView } from "../runtime";

export type GateCommandProvenance = "root" | "overlay" | "detected";

export interface GateCwdInput {
  /** The quality command the gate runs. */
  readonly commandName: "lint" | "typecheck" | "test";
  /** True when the command was auto-detected from the package manifest, not configured. */
  readonly detected: boolean;
  readonly packageView: Pick<PackageView, "overlay" | "repoRoot">;
  /** The story's package workdir (`input.workdir` in each gate). */
  readonly workdir: string;
}

export interface GateCwd {
  readonly cwd: string;
  readonly provenance: GateCommandProvenance;
}

export function resolveGateCwd(_input: GateCwdInput): GateCwd {
  return { cwd: "", provenance: "root" };
}
