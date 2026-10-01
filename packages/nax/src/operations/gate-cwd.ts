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
  // The overlay only speaks for a command when it declares THAT command.
  //
  // `review.commands` is consulted for the test gate alone: full-suite-gate is the
  // only gate whose command comes from `review.commands.test ?? quality.commands.test`
  // (resolveQualityTestCommands, plus mergePackageConfig's PKG-006 bridge). lint-check
  // and typecheck-check read `quality.commands` only, so a review-only overlay — a
  // legal mergeable field — must not drag their root commands into the package dir,
  // which would be the mirror of the misplacement bug this module fixes.
  const declaredByQuality = overlay?.quality?.commands?.[commandName] !== undefined;
  const declaredByReview = commandName === "test" && overlay?.review?.commands?.test !== undefined;
  if (declaredByQuality || declaredByReview) {
    return { cwd: workdir, provenance: "overlay" };
  }
  // Nothing in the overlay is about this command — it is the root command, so run
  // it from the repo root (where the root config was resolved).
  return { cwd: packageView.repoRoot, provenance: "root" };
}
