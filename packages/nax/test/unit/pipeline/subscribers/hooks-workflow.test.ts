/**
 * US-004: the feature-workflow hook events — `on-workflow-start`, `on-workflow-step` and
 * `on-workflow-publish` — and the `NAX_STEP` / `NAX_CI` variables they carry.
 *
 * Hook delivery is asynchronous, so every environment assertion drains the bus first. Two seams are
 * proved end to end: the real producer (`runWorkflowFeature`) into a real `wireHooks` subscriber on
 * the singleton bus, and the real `buildFeatureEnv` sink driving the real `runFeatureMachine`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  cleanupTempDir,
  makeFeatureContext,
  makeNaxConfig,
  makeTempDir,
  makeTestPRD,
  makeTestRuntime,
  makeTestStory,
  withWarnSpy,
} from "@test/helpers";
import type { Advisor } from "@/advisor";
import { fireHook, HOOK_EVENTS, type HookDef, type LoadedHooksConfig, loadHooksConfig } from "@/hooks";
import { PipelineEventBus, pipelineEventBus } from "@/pipeline/event-bus";
import { wireHooks } from "@/pipeline/subscribers/hooks";
import { markTrusted } from "@/trust";
import { _featureRunDeps, runWorkflowFeature } from "@/workflow/feature";
import { buildFeatureEnv, type FeatureEnvInput } from "@/workflow/feature-env";
import { runFeatureMachine } from "@/workflow/feature-machine";
import { newFeatureRecord } from "@/workflow/feature-record";
import { _workflowDeps } from "@/workflow/step-context";
import { startTokenMeter } from "@/workflow/tokens";

const dirs: string[] = [];
const runtimes: ReturnType<typeof makeTestRuntime>[] = [];
const originalRunDeps = { ..._featureRunDeps };
const originalWorkflowDeps = { ..._workflowDeps };

afterEach(async () => {
  Object.assign(_featureRunDeps, originalRunDeps);
  Object.assign(_workflowDeps, originalWorkflowDeps);
  pipelineEventBus.clear();
  await Promise.allSettled(runtimes.map((r) => r.close()));
  runtimes.length = 0;
  await Promise.all(dirs.map(cleanupTempDir));
  dirs.length = 0;
});

function tempDir(prefix: string): string {
  const dir = makeTempDir(prefix);
  dirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// A hook workdir whose scripts record the hook's environment
// ---------------------------------------------------------------------------

/**
 * Appends this run's `NAX_*` environment to the file in `$1`, then a blank line, so a file written
 * more than once stays readable as one block per run of the hook.
 */
const RECORD_ENV_SCRIPT = `#!/bin/sh\nenv | grep "^NAX_" >> "$1"\nprintf '\\n' >> "$1"\n`;

interface HookBench {
  /** The hook workdir: trusted for project hooks, and the argv prefix that keeps commands shell-free. */
  readonly dir: string;
  /** A hook command that records its environment into `<dir>/<file>`. */
  readonly recording: (file: string) => string;
  /** A hook command that exits 3. */
  readonly failing: string;
  /** A hook command that outlives any hook timeout. */
  readonly stalling: string;
}

async function makeBench(): Promise<HookBench> {
  const dir = tempDir("nax-hooks-wf-");
  const record = join(dir, "record-env.sh");
  const fail = join(dir, "fail.sh");
  const stall = join(dir, "stall.sh");
  await Bun.write(record, RECORD_ENV_SCRIPT);
  await Bun.write(fail, "#!/bin/sh\nexit 3\n");
  await Bun.write(stall, "#!/bin/sh\nsleep 30\n");
  // A project hook is repository-controlled code, so fireHook refuses an untrusted workdir.
  markTrusted(dir);
  return {
    dir,
    recording: (file) => `sh ${record} ${join(dir, file)}`,
    failing: `sh ${fail}`,
    stalling: `sh ${stall}`,
  };
}

/** One run of a recording hook, as the `NAX_*` map it wrote. */
async function hookRuns(dir: string, file: string): Promise<Record<string, string>[]> {
  const text = (await Bun.file(join(dir, file)).text()).trim();
  if (text === "") return [];
  return text.split("\n\n").map((block) =>
    Object.fromEntries(
      block
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    ),
  );
}

/** The one and only run a hook made — a louder failure than reading an absent file. */
async function singleRun(dir: string, file: string): Promise<Record<string, string>> {
  const runs = await hookRuns(dir, file);
  expect(runs).toHaveLength(1);
  return runs[0] ?? {};
}

/** Wire hooks onto a private bus, so these tests never share the singleton. */
function wirePrivate(bench: HookBench, hooks: LoadedHooksConfig): PipelineEventBus {
  const bus = new PipelineEventBus();
  wireHooks(bus, hooks, bench.dir, "feat");
  return bus;
}

describe("workflow hook registration (US-004)", () => {
  test("AC-1: the three workflow hooks are registered, and hooks.json keeps an on-workflow-step definition", async () => {
    expect(HOOK_EVENTS).toContain("on-workflow-start");
    expect(HOOK_EVENTS).toContain("on-workflow-step");
    expect(HOOK_EVENTS).toContain("on-workflow-publish");

    const dir = tempDir("nax-hooks-json-");
    await Bun.write(
      join(dir, "hooks.json"),
      JSON.stringify({ hooks: { "on-workflow-step": { command: "echo step", enabled: true } } }),
    );
    const loaded = await loadHooksConfig(dir);
    // Typed access, not just an unknown key: "on-workflow-step" is a hook event the config map knows.
    const kept: HookDef | undefined = loaded.hooks["on-workflow-step"];
    expect(kept).toEqual({ command: "echo step", enabled: true });
    expect(loaded.hooks).toEqual({ "on-workflow-step": { command: "echo step", enabled: true } });
  });

  test("AC-13: a project hooks.json retains an existing on-start definition beside the new workflow hook", async () => {
    const dir = tempDir("nax-hooks-json-");
    await Bun.write(
      join(dir, "hooks.json"),
      JSON.stringify({
        hooks: {
          "on-start": { command: "echo start", timeout: 250 },
          "on-workflow-step": { command: "echo step" },
        },
      }),
    );
    const loaded = await loadHooksConfig(dir);
    const existing: HookDef | undefined = loaded.hooks["on-start"];
    // Typed access: the new event sits in the same map as the existing one, which is left untouched.
    const added: HookDef | undefined = loaded.hooks["on-workflow-step"];
    expect(existing).toEqual({ command: "echo start", timeout: 250 });
    expect(added).toEqual({ command: "echo step" });
    expect(loaded.hooks).toEqual({
      "on-start": { command: "echo start", timeout: 250 },
      "on-workflow-step": { command: "echo step" },
    });
  });
});

describe("fireHook environment for the workflow context (US-004)", () => {
  test("AC-2: on-workflow-step runs the command with NAX_EVENT and NAX_STEP", async () => {
    const bench = await makeBench();
    const hooks: LoadedHooksConfig = {
      hooks: { "on-workflow-step": { command: bench.recording("step.env") } },
    };

    await fireHook(hooks, "on-workflow-step", { event: "on-workflow-step", feature: "f", step: "publish" }, bench.dir);

    const env = await singleRun(bench.dir, "step.env");
    expect(env.NAX_EVENT).toBe("on-workflow-step");
    expect(env.NAX_STEP).toBe("publish");
  });

  test("AC-3: on-workflow-publish runs the command with NAX_CI", async () => {
    const bench = await makeBench();
    const hooks: LoadedHooksConfig = {
      hooks: { "on-workflow-publish": { command: bench.recording("publish.env") } },
    };

    await fireHook(
      hooks,
      "on-workflow-publish",
      { event: "on-workflow-publish", feature: "f", status: "draft", ci: "pending" },
      bench.dir,
    );

    expect((await singleRun(bench.dir, "publish.env")).NAX_CI).toBe("pending");
  });
});

describe("wireHooks workflow event projection (US-004)", () => {
  test("AC-4: workflow:started runs on-workflow-start with NAX_STATUS running and NAX_STEP branch-fix", async () => {
    const bench = await makeBench();
    const bus = wirePrivate(bench, {
      hooks: { "on-workflow-start": { command: bench.recording("start.env") } },
    });

    bus.emit({ type: "workflow:started", step: "branch-fix" });
    await bus.drain();

    const env = await singleRun(bench.dir, "start.env");
    expect(env.NAX_EVENT).toBe("on-workflow-start");
    expect(env.NAX_STATUS).toBe("running");
    expect(env.NAX_STEP).toBe("branch-fix");
  });

  test("AC-5: workflow:step runs on-workflow-step with NAX_STEP and no NAX_STATUS", async () => {
    const bench = await makeBench();
    const bus = wirePrivate(bench, {
      hooks: { "on-workflow-step": { command: bench.recording("step.env") } },
    });

    bus.emit({ type: "workflow:step", step: "final-gates" });
    await bus.drain();

    const env = await singleRun(bench.dir, "step.env");
    expect(env.NAX_EVENT).toBe("on-workflow-step");
    expect(env.NAX_STEP).toBe("final-gates");
    expect("NAX_STATUS" in env).toBe(false);
  });

  test("AC-6: a ready workflow:published carries the outcome, the CI state and the url, and no reason", async () => {
    const bench = await makeBench();
    const bus = wirePrivate(bench, {
      hooks: { "on-workflow-publish": { command: bench.recording("publish.env") } },
    });

    bus.emit({
      type: "workflow:published",
      outcome: "ready",
      ci: "green",
      url: "https://github.com/o/r/pull/295",
      passed: true,
      reasons: [],
    });
    await bus.drain();

    const env = await singleRun(bench.dir, "publish.env");
    expect(env.NAX_STATUS).toBe("ready");
    expect(env.NAX_CI).toBe("green");
    expect(env.NAX_RESULT_URL).toBe("https://github.com/o/r/pull/295");
    expect("NAX_REASON" in env).toBe(false);
  });

  test("AC-7: a draft workflow:published joins its reasons and leaves NAX_RESULT_URL unset", async () => {
    const bench = await makeBench();
    const bus = wirePrivate(bench, {
      hooks: { "on-workflow-publish": { command: bench.recording("publish.env") } },
    });

    bus.emit({
      type: "workflow:published",
      outcome: "draft",
      passed: false,
      reasons: ["CI failed", "approval withheld"],
    });
    await bus.drain();

    const env = await singleRun(bench.dir, "publish.env");
    expect(env.NAX_STATUS).toBe("draft");
    expect(env.NAX_REASON).toBe("CI failed; approval withheld");
    expect("NAX_RESULT_URL" in env).toBe(false);
  });

  test("AC-11: a local-only publish reports its outcome and no url", async () => {
    const bench = await makeBench();
    const bus = wirePrivate(bench, {
      hooks: { "on-workflow-publish": { command: bench.recording("publish.env") } },
    });

    bus.emit({ type: "workflow:published", outcome: "local-only", passed: false, reasons: [] });
    await bus.drain();

    const env = await singleRun(bench.dir, "publish.env");
    expect(env.NAX_STATUS).toBe("local-only");
    expect("NAX_RESULT_URL" in env).toBe(false);
  });

  test("AC-8: a failing on-workflow-step command warns once, naming the event, and never throws", async () => {
    const bench = await makeBench();
    const bus = wirePrivate(bench, {
      hooks: { "on-workflow-step": { command: bench.failing } },
    });

    await withWarnSpy(async (warnSpy) => {
      expect(() => bus.emit({ type: "workflow:step", step: "final-gates" })).not.toThrow();
      await bus.drain();

      const named = warnSpy.mock.calls.filter((call) => String(call[1]).includes("on-workflow-step"));
      expect(named.map((call) => call[1])).toEqual(["Project hook on-workflow-step failed"]);
    });
  });

  test("AC-12: a timing-out on-workflow-step command warns once and resolves instead of propagating", async () => {
    const bench = await makeBench();
    const bus = wirePrivate(bench, {
      hooks: { "on-workflow-step": { command: bench.stalling, timeout: 100 } },
    });

    await withWarnSpy(async (warnSpy) => {
      expect(() => bus.emit({ type: "workflow:step", step: "publish" })).not.toThrow();
      await bus.drain();

      const named = warnSpy.mock.calls.filter((call) => String(call[1]).includes("on-workflow-step"));
      expect(named.map((call) => call[1])).toEqual(["Project hook on-workflow-step failed"]);
      expect(named[0]?.[2]).toMatchObject({ event: "on-workflow-step", output: "Hook timed out after 100ms" });
    });
  });
});

// ---------------------------------------------------------------------------
// Producer-to-hook seams
// ---------------------------------------------------------------------------

const OFF_ADVISOR: Advisor = {
  advise: async () => ({ decision: null, fallbackReason: "off" }),
  recordReuse: async () => null,
  adviseBatch: async () => ({ kind: "residual", items: [], diagnoses: {} }),
};

/** `rev-parse HEAD` answers with a fixed sha; every other git read fails, which callers read fail-soft. */
function stubGit(): void {
  _workflowDeps.git = async (args) =>
    args[0] === "rev-parse" ? { stdout: "headX\n", exitCode: 0 } : { stdout: "", exitCode: 1 };
}

/** `runWorkflowFeature` with only its context and its machine stubbed; the machine resolves a ready publish. */
function setupFeatureRun() {
  const out = tempDir("nax-hooks-run-");
  const config = makeNaxConfig({ outputDir: out });
  const runtime = makeTestRuntime({ config, workdir: "/repo" });
  runtimes.push(runtime);
  const prd = makeTestPRD([makeTestStory({ id: "US-001", status: "passed", passes: true })]);
  const featureDir = join(out, "workflow", prd.feature);
  const fc = makeFeatureContext({
    prd,
    feature: prd.feature,
    featureDir,
    runDir: join(featureDir, "r-now"),
    runId: "r-now",
  });
  _workflowDeps.createAdvisor = () => OFF_ADVISOR;
  stubGit();
  _featureRunDeps.buildFeatureContext = async () => ({ fc, dispose: async () => {} });
  _featureRunDeps.runFeatureMachine = async (env) => ({
    ...env.record,
    step: "done",
    outcome: "ready",
    ci: "green",
    url: "https://github.com/o/r/pull/295",
    passed: true,
    reasons: [],
  });
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
  return { input, fc };
}

/** A fresh `FeatureEnvInput` for `buildFeatureEnv`: one complete story, no ledger items. */
function featureEnvInput(): FeatureEnvInput {
  return {
    stories: [{ id: "US-001", title: "A", state: "complete", rounds: 2, unreviewed: false, flagged: 0 }],
    ledgerItems: { deferredMinors: [], cannotVerify: [], parked: [] },
    record: newFeatureRecord({ now: "t", seed: "s", minors: [] }),
    meter: startTokenMeter(undefined),
    preflight: null,
    specPath: "",
  };
}

/** The real `buildFeatureEnv` over a temp run dir, with the advisor stubbed off. */
function setupFeatureEnv() {
  const out = tempDir("nax-hooks-env-");
  _workflowDeps.createAdvisor = () => OFF_ADVISOR;
  stubGit();
  const fc = makeFeatureContext({ runDir: out, outputDir: out });
  const env = buildFeatureEnv(
    fc,
    {
      runtime: fc.callCtx.runtime,
      config: fc.config,
      prd: fc.prd,
      feature: fc.feature,
      workdir: fc.projectDir,
      branch: fc.branch,
      runId: fc.runId,
      agentName: "claude",
    },
    featureEnvInput(),
  );
  return { fc, env };
}

describe("workflow hooks end to end (US-004)", () => {
  test("AC-9: runWorkflowFeature starts the workflow hook at repo-gates and publishes the url hook", async () => {
    const bench = await makeBench();
    const { input } = setupFeatureRun();
    const off = wireHooks(
      pipelineEventBus,
      {
        hooks: {
          "on-workflow-start": { command: bench.recording("start.env") },
          "on-workflow-publish": { command: bench.recording("publish.env") },
        },
      },
      bench.dir,
      input.feature,
    );
    try {
      await runWorkflowFeature(input);
      await pipelineEventBus.drain();
    } finally {
      off();
    }

    const started = await singleRun(bench.dir, "start.env");
    expect(started.NAX_EVENT).toBe("on-workflow-start");
    expect(started.NAX_STEP).toBe("repo-gates");

    const published = await singleRun(bench.dir, "publish.env");
    expect(published.NAX_EVENT).toBe("on-workflow-publish");
    expect(published.NAX_STATUS).toBe("ready");
    expect(published.NAX_RESULT_URL).toBe("https://github.com/o/r/pull/295");
  });

  test("AC-10: the real sink publishes workflow:step once for the publish step the machine runs", async () => {
    const bench = await makeBench();
    const { env } = setupFeatureEnv();
    const off = wireHooks(
      pipelineEventBus,
      { hooks: { "on-workflow-step": { command: bench.recording("step.env") } } },
      bench.dir,
      "feat",
    );
    const wired = {
      ...env,
      record: { ...env.record, step: "publish" as const },
      steps: {
        ...env.steps,
        publish: async () => ({ outcome: "ready" as const, ci: "pending" as const, reasons: [] }),
      },
    };
    try {
      await runFeatureMachine(wired);
      await pipelineEventBus.drain();
    } finally {
      off();
    }

    const step = await singleRun(bench.dir, "step.env");
    expect(step.NAX_EVENT).toBe("on-workflow-step");
    expect(step.NAX_STEP).toBe("publish");
  });
});
