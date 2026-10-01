/**
 * NaxRuntime.dryRun — nax#1808.
 *
 * The auto-commit refusal has to reach two call sites that share no arguments:
 * the completion phase (RunnerCompletionOptions) and pre-run acceptance setup
 * (PipelineContext). Both extend DispatchContext, which carries `runtime`, so a
 * single run-scoped field reaches them without threading a parameter through
 * either call chain -- the same shape as `dirtyWorktrees` and `quarantineMemo`.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "@/config";
import { createRuntime } from "@/runtime";

describe("createRuntime dryRun", () => {
  test("defaults to false so non-run callers commit as before", () => {
    const rt = createRuntime(DEFAULT_CONFIG, "/tmp/test");

    expect(rt.dryRun).toBe(false);
  });

  test("carries the flag when the run opts in", () => {
    const rt = createRuntime(DEFAULT_CONFIG, "/tmp/test", { dryRun: true });

    expect(rt.dryRun).toBe(true);
  });
});
