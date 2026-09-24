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

export function resolveGateCwd(input: GateCwdInput): GateCwd {
  const { commandName, detected, packageView, workdir } = input;
  // A detected command was derived from the package manifest, so it belongs to
  // the package dir regardless of what any overlay declares.
  if (detected) {
    return { cwd: workdir, provenance: "detected" };
  }
  const overlay = packageView.overlay;
  // The overlay only speaks for this command when it declares it. `review.commands`
  // counts because mergePackageConfig's PKG-006 bridge mirrors overlay quality
  // commands into review.commands, and full-suite-gate reads through it.
  const declaredByOverlay =
    overlay?.quality?.commands?.[commandName] !== undefined || overlay?.review?.commands?.[commandName] !== undefined;
  if (declaredByOverlay) {
    return { cwd: workdir, provenance: "overlay" };
  }
  // Nothing in the overlay is about this command — it is the root command, so run
  // it from the repo root (where the root config was resolved).
  return { cwd: packageView.repoRoot, provenance: "root" };
}
