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
import { basename } from "node:path";
import { loadConfig } from "@/config";
import { defaultForgeDeps, type ForgeDeps } from "@/forge";
import { projectOutputDir } from "@/runtime";
import { waitForChecks } from "../workflow/ci-wait";

export interface WorkflowForgeDeps {
  /** Runs `git`, `gh` and `glab` for the command. */
  readonly forge: ForgeDeps;
  /** Canonical URL reader; injectable for fixtures with synthetic PR URLs. */
  /** The clock behind the sidecar's `resumedAt` and its file name. */
  readonly now: () => Date;
  /**
   * The CI wait `promote` binds the pushed head to (US-004). It arrives here rather than being
   * imported at the call site so a test stubs the wait — and the clock inside it — without a real
   * poll loop.
   */
  readonly waitForChecks: typeof waitForChecks;
  /**
   * The project's output directory, where the advisor's audit artifacts live (#2578): a ledger
   * decision counts only when its artifact there records it. Resolved as `nax advisor` resolves it.
   */
  readonly resolveOutputDir: (dir: string) => Promise<string>;
}

/** The real forge, clock and CI wait: the running process's CLIs, the wall clock and a live poll. */
export const _workflowForgeDeps: WorkflowForgeDeps = {
  forge: defaultForgeDeps,
  now: () => new Date(),
  waitForChecks,
  resolveOutputDir: async (dir) => {
    const config = await loadConfig(dir).catch(() => null);
    return projectOutputDir(config?.name?.trim() || basename(dir), config?.outputDir);
  },
};
