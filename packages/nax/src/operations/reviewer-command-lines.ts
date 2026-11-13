/**
 * nax#2904: the configured verification commands a reviewer is shown, each with the
 * directory its gate runs it from. Reviewers keep sandboxed Bash only: RunCommand's
 * declared branch runs through runQualityCommand, which is unsandboxed, so it is not
 * offered to a review op (nax#2500 R9). Showing the exact command stops reviewers
 * guessing a runner the gate does not use.
 */
import type { ReviewerCommandEntry } from "@/prompts";
import type { QualityCommandSpec } from "@/quality";
import { normalizeCommandSpec } from "@/quality";
import type { PackageView } from "@/runtime";
import { resolveGateCwd } from "./gate-cwd";

export type ReviewerCommandName = "testScoped" | "test" | "lint" | "typecheck";

/** The prompt's entry shape, narrowed to the four commands a reviewer is shown. */
export interface ReviewerCommandLine extends ReviewerCommandEntry {
  readonly name: ReviewerCommandName;
}

/** The config fields read: a structural slice so both NaxConfig and op slices fit. */
export interface ReviewerCommandSources {
  readonly quality?: {
    readonly commands?: {
      readonly testScoped?: QualityCommandSpec;
      readonly test?: QualityCommandSpec;
      readonly lint?: QualityCommandSpec;
      readonly typecheck?: QualityCommandSpec;
    };
  };
  readonly review?: { readonly commands?: { readonly test?: QualityCommandSpec } };
}

type ReviewerView = Pick<PackageView, "overlay" | "repoRoot" | "relativeFromRoot">;

/** The gate whose cwd rule a command follows: testScoped runs where the test gate does (verify-scoped). */
const GATE_OF: Readonly<Record<ReviewerCommandName, "test" | "lint" | "typecheck">> = {
  testScoped: "test",
  test: "test",
  lint: "lint",
  typecheck: "typecheck",
};

function specFor(name: ReviewerCommandName, config: ReviewerCommandSources): QualityCommandSpec | undefined {
  const commands = config.quality?.commands;
  // The full-suite gate reads review.commands.test first (resolveQualityTestCommands).
  if (name === "test") return config.review?.commands?.test ?? commands?.test;
  return commands?.[name];
}

function dirFor(name: ReviewerCommandName, view: ReviewerView): string {
  const { provenance } = resolveGateCwd({
    commandName: GATE_OF[name],
    detected: false,
    packageView: view,
    workdir: view.relativeFromRoot,
  });
  return provenance === "root" || view.relativeFromRoot === "" ? "." : view.relativeFromRoot;
}

/** Configured commands only, in a fixed order; [] when the project configures none. */
export function reviewerCommandLines(config: ReviewerCommandSources, view: ReviewerView): ReviewerCommandLine[] {
  const names: readonly ReviewerCommandName[] = ["testScoped", "test", "lint", "typecheck"];
  return names.flatMap((name) => {
    const steps = normalizeCommandSpec(specFor(name, config));
    return steps.length === 0 ? [] : [{ name, steps, dir: dirFor(name, view) }];
  });
}
