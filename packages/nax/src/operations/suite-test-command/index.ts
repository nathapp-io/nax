/**
 * Suite test command — the one resolution of "which test command runs, and from
 * which directory".
 *
 * Two consumers must agree: the per-package run-start baseline capture and the
 * per-story full-suite gate. When they resolve separately they can measure
 * different commands (a root command vs the package overlay's), and every
 * baseline entry is then compared against a run that never produced it. This
 * module is that single resolution.
 *
 * Resolution order (unchanged from the gate's original inline logic):
 *   1. configured — `review.commands.test ?? quality.commands.test`, package
 *      overlay over root; cwd from `resolveGateCwd` (`gate-cwd.ts`).
 *   2. detected — `resolveDefaultQualityCommands(workdir).test`, run from the
 *      package dir because the default was derived from that package's manifest.
 *   3. neither — `undefined`, so the caller decides (the gate throws
 *      `TEST_COMMAND_MISSING`; the capture writes a `no-test-command` marker).
 *
 * Nothing here imports from `src/execution/`: the capture and the gate both
 * depend on this module, so an execution edge would close a cycle.
 */

import type { QualityCommandSpec } from "@nathapp/nax-agent/internal";
import { resolveDefaultQualityCommands, resolveQualityTestCommands } from "@/quality";
import type { PackageView } from "@/runtime";
import { type GateCommandProvenance, resolveGateCwd } from "../gate-cwd";

export interface SuiteTestCommand {
  readonly testCmd: QualityCommandSpec;
  readonly cmdWorkdir: string;
  readonly provenance: GateCommandProvenance;
}

export interface SuiteTestCommandInput {
  /** The package-merged config and the raw overlay the cwd rule reads. */
  readonly packageView: PackageView;
  /** Absolute package dir — the story's package, or the repo root for a root story. */
  readonly workdir: string;
  /** `storyPackageDir(story)` — the relative package key, undefined at the repo root. */
  readonly packageDir?: string;
}

export async function resolveSuiteTestCommand(input: SuiteTestCommandInput): Promise<SuiteTestCommand | undefined> {
  const { packageView, workdir, packageDir } = input;
  const { testCommand } = await resolveQualityTestCommands(packageView.config, workdir, packageDir);

  if (!testCommand) {
    // Detection fallback: nothing is configured (root or per-package), so derive
    // a command from the package's manifest — e.g. a new package's freshly
    // scaffolded pyproject.toml. It runs from the package dir, where it was detected.
    const detected = (await resolveDefaultQualityCommands(workdir)).test;
    if (!detected) return undefined;
    return { testCmd: detected, cmdWorkdir: workdir, provenance: "detected" };
  }

  // A configured command's cwd follows its provenance: the package dir when the
  // overlay declares it, the repo root when it comes from the root config.
  const { cwd, provenance } = resolveGateCwd({
    commandName: "test",
    detected: false,
    packageView,
    workdir,
  });
  return { testCmd: testCommand, cmdWorkdir: cwd, provenance };
}
