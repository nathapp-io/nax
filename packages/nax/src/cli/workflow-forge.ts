/**
 * The forge seam the `nax workflow` commands run against (SPEC-workflow-record-promote, US-002).
 *
 * `record` and (US-004) `promote` need two things `status` never did: a subprocess/filesystem
 * `ForgeDeps` and a clock for the sidecar's `resumedAt` stamp. Both arrive as one injected object so
 * a test spreads the real one and overrides only what it fakes — a field a later story adds
 * (`waitForChecks`, US-004) then needs no change in any caller or test that only needs the shape.
 *
 * CYCLE NOTE: this module must not value-import `src/workflow/git.ts`. That file imports
 * `step-context`, which imports `@/cli`, and `@/cli` re-exports the modules that import this one —
 * `bun run check:import-cycles`. HEAD is read through `forge.run(["git", "rev-parse", "HEAD"], …)`
 * instead (US-004).
 */
import { defaultForgeDeps, type ForgeDeps } from "@/forge";

export interface WorkflowForgeDeps {
  /** Runs `git`, `gh` and `glab` for the command. */
  readonly forge: ForgeDeps;
  /** The clock behind the sidecar's `resumedAt` and its file name. */
  readonly now: () => Date;
}

/** The real forge and clock: the running process's CLIs and the wall clock. */
export const _workflowForgeDeps: WorkflowForgeDeps = {
  forge: defaultForgeDeps,
  now: () => new Date(),
};
