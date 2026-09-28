/**
 * Execution-phase functions for the `nax run` CLI action (bin/nax.ts): the
 * TUI mount, the deferred-schedule wait, the bake-off hand-off, the
 * single-agent run() call and the headless summary.
 *
 * Split from bin/run-action.ts to keep both files under the 600-line cap —
 * see that file's header for the extraction boundaries (BUG-15/ENH-47
 * source-signature tests, no back imports). Everything here takes and returns
 * explicit parameters; nothing may import from bin/nax.ts.
 */

import { join } from "node:path";

import chalk from "chalk";
import type { NaxConfig } from "../src/config";
import { run } from "../src/execution";
import type { LoadedHooksConfig } from "../src/hooks";
import type { AgentStreamEventBus } from "../src/runtime";
import { waitForSchedule } from "../src/schedule";
import { type PipelineEventEmitter, renderTui, type StoryDisplayState } from "../src/tui";
import { NAX_BUILD_INFO } from "../src/version";
import type { FormatterMode, LoadedPrd, ResolvedScheduleGate, RunActionOptions, TuiInstance } from "./run-action";

/** Render the TUI for a non-headless run from the already-loaded PRD. */
export function mountRunTui(params: {
  prd: LoadedPrd;
  feature: string;
  eventEmitter: PipelineEventEmitter;
  agentStreamEvents: AgentStreamEventBus | undefined;
  workdir: string;
}): TuiInstance {
  const initialStories: StoryDisplayState[] = params.prd.userStories.map((story) => ({
    story,
    status: story.passes ? "passed" : "pending",
    routing: story.routing,
    cost: 0,
  }));

  return renderTui({
    feature: params.feature,
    version: NAX_BUILD_INFO,
    stories: initialStories,
    events: params.eventEmitter,
    agentStreamEvents: params.agentStreamEvents,
    queueFilePath: join(params.workdir, ".queue.txt"),
  });
}

/** Wait out a deferred --schedule start; unmounts the TUI and exits 0 when cancelled while waiting. */
export async function waitForScheduledRun(params: {
  scheduleGate: ResolvedScheduleGate;
  feature: string;
  formatterMode: FormatterMode;
  isTTY: boolean;
  tuiInstance: TuiInstance | undefined;
}): Promise<void> {
  const { scheduleGate, feature, formatterMode, isTTY, tuiInstance } = params;
  if (!scheduleGate.target) return;

  const scheduleController = new AbortController();
  const onSigint = () => scheduleController.abort();
  process.once("SIGINT", onSigint);
  const outcome = await waitForSchedule(scheduleGate.target, {
    label: feature,
    // --json needs countdown-free output for clean machine parsing, and a
    // genuinely piped/redirected stdout (no TTY) would just accumulate
    // literal \r characters instead of overwriting a line. Plain
    // --headless with a real terminal attached still gets the live
    // countdown, same as interactive mode.
    quiet: formatterMode === "json" || !isTTY,
    signal: scheduleController.signal,
  });
  process.removeListener("SIGINT", onSigint);
  if (outcome === "cancelled") {
    // BUG-22: unmount before exiting — the TUI is already mounted by
    // this point, and exiting without unmounting left the cancellation
    // message printed over the still-live TUI frame.
    tuiInstance?.unmount();
    console.log(chalk.dim("\nScheduled run cancelled."));
    process.exit(0);
  }
}

/**
 * Bake-off routing: hand off to the bake-off coordinator and skip the
 * single-agent path. Always terminates the process with the bake-off exit
 * outcome.
 */
export async function runBakeoffMode(params: {
  options: RunActionOptions;
  workdir: string;
  outputDir: string;
  config: NaxConfig;
  tuiInstance: TuiInstance | undefined;
}): Promise<never> {
  const { options, workdir, outputDir, config, tuiInstance } = params;
  const { handleRunAction, _bakeoffCliDeps } = await import("../src/bakeoff");
  const bakeoffResult = await handleRunAction(
    {
      compare: options.compare,
      feature: options.feature,
      projectRoot: workdir,
      outputDir,
      config,
      maxCostUsd: options.maxCost !== undefined ? Number(options.maxCost) : undefined,
    },
    _bakeoffCliDeps,
  );
  if (tuiInstance) {
    tuiInstance.unmount();
  }
  const { renderBakeoffReport } = await import("../src/bakeoff");
  const report = renderBakeoffReport(bakeoffResult as import("../src/bakeoff").BakeoffResult);
  console.log(report);
  const exitOutcome =
    typeof (bakeoffResult as { outcome?: number })?.outcome === "number"
      ? (bakeoffResult as { outcome: number }).outcome
      : 0;
  process.exit(exitOutcome);
}

/**
 * The single-agent run() call, with the BUG-51 guarantee: the TUI is
 * unmounted in a finally even when run() throws — otherwise a thrown error
 * prints over the still-mounted TUI frame instead of a clean error message,
 * and the headless summary never runs either.
 */
export async function executeSingleAgentRun(params: {
  options: RunActionOptions;
  config: NaxConfig;
  hooks: LoadedHooksConfig;
  prdPath: string;
  workdir: string;
  featureDir: string;
  parallel: number | undefined;
  eventEmitter: PipelineEventEmitter;
  statusFilePath: string;
  logFilePath: string;
  formatterMode: FormatterMode;
  useHeadless: boolean;
  agentStreamEvents: AgentStreamEventBus | undefined;
  tuiInstance: TuiInstance | undefined;
}): Promise<Awaited<ReturnType<typeof run>>> {
  const {
    options,
    config,
    hooks,
    prdPath,
    workdir,
    featureDir,
    parallel,
    eventEmitter,
    statusFilePath,
    logFilePath,
    formatterMode,
    useHeadless,
    agentStreamEvents,
    tuiInstance,
  } = params;

  let result: Awaited<ReturnType<typeof run>>;
  try {
    result = await run({
      prdPath,
      workdir,
      config,
      hooks,
      feature: options.feature,
      featureDir,
      dryRun: options.dryRun,
      useBatch: options.batch ?? true,
      parallel,
      eventEmitter,
      statusFile: statusFilePath,
      logFilePath,
      formatterMode: useHeadless ? formatterMode : undefined,
      headless: useHeadless,
      skipPrecheck: options.skipPrecheck ?? false,
      agentStreamEvents,
      resumeMode: options.fresh === true || options.resume === false ? "fresh" : "auto",
    });
  } finally {
    // Unmount the TUI even when run() throws — see the doc comment above.
    if (tuiInstance) {
      tuiInstance.unmount();
    }
  }
  return result;
}

/** Headless-mode run summary (the TUI shows its own). */
export function printRunSummary(result: Awaited<ReturnType<typeof run>>): void {
  console.log(chalk.dim("\n── Summary ──────────────────────────────────"));
  console.log(chalk.dim(`   Iterations:  ${result.iterations}`));
  console.log(chalk.dim(`   Completed:   ${result.storiesCompleted}`));
  console.log(chalk.dim(`   Cost:        $${result.totalCost.toFixed(4)}`));
  console.log(chalk.dim(`   Duration:    ${(result.durationMs / 1000 / 60).toFixed(1)} min`));
  // ENH-20: surface fail-open reviews distinctly — a run whose review
  // checks were skipped (LLM outage) is not the same as reviewed-and-passed.
  if (result.reviewsFailedOpen) {
    console.log(chalk.yellow(`   Reviews failed open: ${result.reviewsFailedOpen} (not actually reviewed)`));
  }
}
