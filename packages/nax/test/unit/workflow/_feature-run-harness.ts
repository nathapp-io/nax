/**
 * Shared harness for the `runWorkflowFeature` suites (`feature.test.ts`, `feature-publish-only.test.ts`):
 * a feature context over a temp output dir, a machine stub that records its envs, and a finished prior
 * run to resume or refuse. The leading underscore marks a local, non-collected helper module.
 */
import { afterEach } from "bun:test";
import { join } from "node:path";
import { _fileLockDeps } from "@nathapp/nax-agent/internal";
import {
  cleanupTempDir,
  makeFeatureContext,
  makeNaxConfig,
  makeTempDir,
  makeTestPRD,
  makeTestRuntime,
  makeTestStory,
  withDepsRestore,
} from "@test/helpers";
import type { NaxRuntime } from "@/runtime";
import { _featureRunDeps } from "@/workflow/feature";
import type { FeatureEnv } from "@/workflow/feature-machine";
import { newFeatureRecord } from "@/workflow/feature-record";
import { newStoryRecord, upsertFeatureRecord, upsertStoryRecord } from "@/workflow/result";
import { _workflowDeps } from "@/workflow/step-context";

const originalRun = { ..._featureRunDeps };
const originalWf = { ..._workflowDeps };
const dirs: string[] = [];
const runtimes: NaxRuntime[] = [];

/** Register the per-test restore and cleanup; call once at the top level of each suite. */
export function registerFeatureRunHarness(): void {
  withDepsRestore(_fileLockDeps);
  afterEach(async () => {
    Object.assign(_featureRunDeps, originalRun);
    Object.assign(_workflowDeps, originalWf);
    await Promise.allSettled(runtimes.map((r) => r.close()));
    runtimes.length = 0;
    await Promise.all(dirs.map(cleanupTempDir));
    dirs.length = 0;
  });
}

/** A temp dir removed after the current test. */
export function trackedTempDir(prefix: string): string {
  const dir = makeTempDir(prefix);
  dirs.push(dir);
  return dir;
}

export function setup(over: { dryRun?: boolean; runSignal?: AbortSignal } = {}) {
  const out = makeTempDir("wf-feat-");
  dirs.push(out);
  const config = makeNaxConfig({ outputDir: out });
  const runtime = makeTestRuntime({ config, workdir: "/repo", ...(over.dryRun ? { dryRun: true } : {}) });
  runtimes.push(runtime);
  const prd = makeTestPRD([makeTestStory({ id: "US-001", status: "passed", passes: true })]);
  const featureDir = join(out, "workflow", prd.feature);
  const fc = makeFeatureContext({
    prd,
    feature: prd.feature,
    featureDir,
    runDir: join(featureDir, "r-now"),
    runId: "r-now",
    runSignal: over.runSignal,
  });
  let disposed = 0;
  _featureRunDeps.buildFeatureContext = async () => ({
    fc,
    dispose: async () => {
      disposed++;
    },
  });
  _workflowDeps.git = async (args) => {
    if (args[0] === "rev-parse") return { stdout: "headX\n", exitCode: 0 };
    // A publish-only run re-reads the checked-out branch under the handoff lock.
    if (args[0] === "branch") return { stdout: `${fc.branch}\n`, exitCode: 0 };
    return { stdout: "", exitCode: 1 };
  };
  const envs: FeatureEnv[] = [];
  _featureRunDeps.runFeatureMachine = async (env) => {
    envs.push(env);
    return { ...env.record, step: "done", outcome: "draft", passed: false, reasons: ["CI failed"], url: "u" };
  };
  const input = {
    runtime,
    config,
    prd,
    feature: prd.feature,
    workdir: "/repo",
    branch: "feat/x",
    runId: "r-now",
    agentName: "claude",
  };
  return { fc, input, envs, featureDir, runtime, disposed: () => disposed };
}

export async function seedFinished(
  featureDir: string,
  feature: string,
  over: {
    outcome: "ready" | "draft" | "local-only" | "pushed";
    url?: string;
    head?: string;
    passed?: boolean;
    finalGates?: { ran: string[]; failing: string[] };
    flaggedDecisions?: readonly string[];
  },
): Promise<void> {
  const prior = join(featureDir, "r-old");
  await upsertStoryRecord(prior, { runId: "r-old", feature }, newStoryRecord("US-001", 5, "t"));
  await upsertFeatureRecord(
    prior,
    { runId: "r-old", feature },
    { ...newFeatureRecord({ now: "t", seed: "s", minors: [] }), step: "done", head: "headX", passed: true, ...over },
  );
}
