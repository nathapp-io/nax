/**
 * US-004 (gate-config-route, #2897/#2898): the `configFacts` / `applyConfigChange` steps and the
 * append-only `recordConfigChange` sink as `buildStoryEnv` wires them, against a **real** temporary
 * repository. What is under test is git's answer (`git show <base>:<pkg>/package.json`), the config
 * chain's (what the package registry reloads after a change) and result.json's (what a second record
 * keeps) — so nothing here fakes git unless the case under test is a git failure.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  assertDefined,
  cleanupTempDir,
  makeMockCallContext,
  makeMockRuntime,
  makeNaxConfig,
  makeScriptedCallOp,
  makeTempDir,
  makeTestContext,
} from "@test/helpers";
import type { Advisor, QuestionDraft } from "@/advisor";
import { naxProtectedPaths } from "@/agents/nax-protected-paths";
import { loadConfigForPackage, type NaxConfig, qualityConfigSelector } from "@/config";
import { _clearRootConfigCache } from "@/config/loader";
import { _clearPackageConfigCache } from "@/config/package-config-cache";
import {
  type LintCheckOutput,
  lintCheckOp,
  type TypecheckCheckOutput,
  typecheckCheckOp,
  verifyScopedOp,
} from "@/operations";
import type { ConfigChangeAnswer, ImplementerQuestionFacts } from "@/workflow/advisor";
import {
  _configChangeDeps,
  type ConfigChangeOutcome,
  configChangeCandidates,
  protectedPathList,
} from "@/workflow/config-change";
import { workflowRunDir } from "@/workflow/paths";
import { newStoryRecord, readResult } from "@/workflow/result";
import { buildStoryEnv } from "@/workflow/stage-env";
import { _workflowDeps } from "@/workflow/step-context";
import type { StoryLoopEnv } from "@/workflow/story-loop";
import type { ConfigChangeRecord, GateName, GateRunResult, WorkflowStoryRecord } from "@/workflow/types";

const ROOT_CONFIG_REL = ".nax/config.json";
const CONFIG_REL = ".nax/mono/apps/admin/config.json";
const MANIFEST_REL = "apps/admin/package.json";
const PACKAGE_REL = "apps/admin";
const STORY_ID = "US-001";
/** `makeTestPRD()`'s feature, which `buildStoryEnv` roots every artifact path at. */
const FEATURE = "test-feature";

const OLD_COMMAND = "bun test {{files}}";
const NEW_COMMAND = "bun test --isolate {{files}}";
const TEST_SCRIPT = "bun test --isolate";

const CONFIG_TEXT = `${JSON.stringify(
  { quality: { commands: { lint: "biome check .", typecheck: "tsc --noEmit", testScoped: OLD_COMMAND } } },
  null,
  2,
)}\n`;
const MANIFEST_WITH_SCRIPT = `${JSON.stringify({ name: "admin", scripts: { test: TEST_SCRIPT } }, null, 2)}\n`;
const MANIFEST_NO_SCRIPTS = `${JSON.stringify({ name: "admin" }, null, 2)}\n`;
/** A manifest that was committed half-written — what a conflicted base commit looks like. */
const MANIFEST_NOT_JSON = '{ "name": "admin", "scripts": { "test": \n';

/** What every deterministic gate op answers when the test is not asserting on its command. */
const GATE_OUTPUTS: Readonly<Record<string, unknown>> = {
  [lintCheckOp.name]: { success: true, findings: [], durationMs: 1 } satisfies LintCheckOutput,
  [typecheckCheckOp.name]: { success: true, findings: [], durationMs: 1 } satisfies TypecheckCheckOutput,
  [verifyScopedOp.name]: {
    success: true,
    status: "passed",
    findings: [],
    durationMs: 1,
    passCount: 0,
    isFullSuite: false,
  },
};

const dirs: string[] = [];
const origDeps = {
  callOp: _workflowDeps.callOp,
  createAdvisor: _workflowDeps.createAdvisor,
  git: _configChangeDeps.git,
};

afterEach(() => {
  _workflowDeps.callOp = origDeps.callOp;
  _workflowDeps.createAdvisor = origDeps.createAdvisor;
  _configChangeDeps.git = origDeps.git;
  _clearPackageConfigCache();
  _clearRootConfigCache();
  for (const dir of dirs) cleanupTempDir(dir);
  dirs.length = 0;
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed (${code}): ${err}`);
  return out.trim();
}

interface Repo {
  readonly dir: string;
  /** The story's base commit — the seed commit carrying the package config and its manifest. */
  readonly base: string;
}

interface Built extends Repo {
  readonly env: StoryLoopEnv;
  readonly runtime: ReturnType<typeof makeMockRuntime>;
  /** The per-package config the story runs under (the `.nax/mono` overlay applied). */
  readonly storyConfig: NaxConfig;
}

/**
 * A temp repo whose committed package config declares `testScoped: bun test {{files}}` and whose
 * base manifest is `manifest` — `null` for a base commit with no manifest at all.
 */
async function makeRepo(manifest: string | null = MANIFEST_WITH_SCRIPT): Promise<Repo> {
  const dir = makeTempDir("cfg-steps-");
  dirs.push(dir);
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "config", "user.email", "t@t");
  await git(dir, "config", "user.name", "t");
  await Bun.write(join(dir, ROOT_CONFIG_REL), "{}\n");
  await Bun.write(join(dir, CONFIG_REL), CONFIG_TEXT);
  // Always present: `resolveTestFilePatterns` scans the package dir, and a scan of a missing cwd throws.
  await Bun.write(join(dir, PACKAGE_REL, "src/a.ts"), "export const a = 1;\n");
  if (manifest !== null) await Bun.write(join(dir, MANIFEST_REL), manifest);
  await git(dir, "add", "-A");
  await git(dir, "commit", "-qm", "seed");
  return { dir, base: await git(dir, "rev-parse", "HEAD") };
}

/** `buildStoryEnv` for a story whose package is `apps/admin`, exactly as the workflow stage calls it. */
async function buildEnv(repo: Repo): Promise<Built> {
  const rootConfig = await loadConfigForPackage(repo.dir, undefined, makeNaxConfig());
  const storyConfig = await loadConfigForPackage(repo.dir, PACKAGE_REL, rootConfig);
  const runtime = makeMockRuntime({ config: storyConfig, workdir: repo.dir });
  const ctx = makeTestContext({
    config: storyConfig,
    rootConfig,
    runtime,
    projectDir: repo.dir,
    workdir: join(repo.dir, PACKAGE_REL),
    storyGitRef: repo.base,
  });
  const { env } = await buildStoryEnv(ctx, makeMockCallContext({ runtime }));
  return { ...repo, env, runtime, storyConfig };
}

const factsOf = async (env: StoryLoopEnv, redGates: readonly GateName[]): Promise<ImplementerQuestionFacts> => {
  const step = env.steps.configFacts;
  assertDefined(step, "steps.configFacts");
  return await step(redGates);
};

const gatesOf = async (env: StoryLoopEnv): Promise<GateRunResult> => await env.steps.gates();

/** The advisor's pick: the manifest's `test` script, in the `{{files}}` form the scoped gate needs. */
function change(over: Partial<ConfigChangeAnswer> = {}): ConfigChangeAnswer {
  return {
    kind: "config-change",
    key: "testScoped",
    to: NEW_COMMAND,
    script: "test",
    reason: "matches the package test script",
    decisionId: "D-3",
    needsHumanConfirm: false,
    ...over,
  };
}

async function applyChange(env: StoryLoopEnv, over: Partial<ConfigChangeAnswer> = {}): Promise<ConfigChangeOutcome> {
  const step = env.steps.applyConfigChange;
  assertDefined(step, "steps.applyConfigChange");
  return await step(change(over));
}

/** One change as the loop records it; `round` and the values are the caller's. */
function entry(over: Partial<ConfigChangeRecord> = {}): ConfigChangeRecord {
  return {
    round: 1,
    key: "testScoped",
    from: OLD_COMMAND,
    to: NEW_COMMAND,
    applied: true,
    decisionId: "D-3",
    ...over,
  };
}

/** The story record this run persisted, exactly as a resume or `nax workflow status` reads it. */
async function persistedRecord(dir: string, runId: string): Promise<WorkflowStoryRecord> {
  const result = await readResult(workflowRunDir(dir, FEATURE, runId));
  assertDefined(result, "result.json");
  const record = result.stories[STORY_ID];
  assertDefined(record, `result.json story ${STORY_ID}`);
  return record;
}

/** Run the story's gates with `callOp` scripted, capturing the command each scoped gate would run. */
async function scopedCommandsOf(env: StoryLoopEnv): Promise<(string | string[] | undefined)[]> {
  const seen: (string | string[] | undefined)[] = [];
  _workflowDeps.callOp = makeScriptedCallOp((op, _input, ctx) => {
    if (op.name === verifyScopedOp.name) {
      seen.push(ctx.packageView.select(qualityConfigSelector).quality.commands.testScoped);
    }
    return GATE_OUTPUTS[op.name];
  });
  const result = await gatesOf(env);
  expect(result.states.scoped).toBe("green");
  return seen;
}

/** An advisor seam that records the questions the live workflow advisor asks it. */
function recordingAdvisor(asked: QuestionDraft[]): Advisor {
  return {
    advise: async (q) => {
      asked.push(q);
      return { decision: null };
    },
    recordReuse: async () => null,
    adviseBatch: async () => ({ kind: "residual", items: [], diagnoses: {} }),
  };
}

describe("steps.configFacts (US-004)", () => {
  test("AC-3: carries the protected paths the advisor is told no session may write", async () => {
    const built = await buildEnv(await makeRepo());
    const facts = await factsOf(built.env, ["scoped"]);
    expect(facts.protectedPaths).toEqual(protectedPathList(naxProtectedPaths()));
  });

  test("AC-4: carries the story's resolved scoped command", async () => {
    const built = await buildEnv(await makeRepo());
    const facts = await factsOf(built.env, ["scoped"]);
    // The per-package overlay is what the story runs under; `bun test {{files}}` is its testScoped.
    expect(built.storyConfig.quality.commands.testScoped).toBe(OLD_COMMAND);
    expect(facts.commands.testScoped).toBe(OLD_COMMAND);
  });

  test("AC-5: carries the candidates the base-commit scripts yield for the red gate", async () => {
    const built = await buildEnv(await makeRepo());
    const facts = await factsOf(built.env, ["scoped"]);
    expect(facts.candidates).toEqual([
      { key: "testScoped", to: TEST_SCRIPT, script: "test" },
      { key: "testScoped", to: `${TEST_SCRIPT} {{files}}`, script: "test" },
    ]);
    // ...and they are exactly `configChangeCandidates` over the story's base scripts.
    expect(facts.candidates).toEqual(
      configChangeCandidates({
        redGates: ["scoped"],
        commands: built.storyConfig.quality.commands,
        scripts: { test: TEST_SCRIPT },
      }),
    );
  });

  test("AC-6: a base manifest with no scripts offers no candidates but keeps the paths and commands", async () => {
    const built = await buildEnv(await makeRepo(MANIFEST_NO_SCRIPTS));
    const facts = await factsOf(built.env, ["scoped"]);
    expect(facts.candidates).toEqual([]);
    expect(facts.protectedPaths).toEqual(protectedPathList(naxProtectedPaths()));
    expect(facts.commands.testScoped).toBe(OLD_COMMAND);
  });

  test.each([
    ["missing", null],
    ["not JSON", MANIFEST_NOT_JSON],
  ] as const)("AC-8: a base manifest that is %s offers no candidates and keeps the rest", async (_name, manifest) => {
    const built = await buildEnv(await makeRepo(manifest));
    const facts = await factsOf(built.env, ["scoped"]);
    expect(facts.candidates).toEqual([]);
    expect(facts.protectedPaths).toEqual(protectedPathList(naxProtectedPaths()));
    expect(facts.commands.testScoped).toBe(OLD_COMMAND);
  });

  test("AC-8: a base manifest git cannot read offers no candidates and keeps the rest", async () => {
    const built = await buildEnv(await makeRepo());
    _configChangeDeps.git = async () => {
      throw new Error("fatal: bad object");
    };
    const facts = await factsOf(built.env, ["scoped"]);
    expect(facts.candidates).toEqual([]);
    expect(facts.protectedPaths).toEqual(protectedPathList(naxProtectedPaths()));
    expect(facts.commands.testScoped).toBe(OLD_COMMAND);
  });

  test("a story whose package is the repo root is offered nothing (the root config is cached for the run)", async () => {
    const repo = await makeRepo();
    const rootConfig = await loadConfigForPackage(repo.dir, undefined, makeNaxConfig());
    const runtime = makeMockRuntime({ config: rootConfig, workdir: repo.dir });
    const ctx = makeTestContext({
      config: rootConfig,
      rootConfig,
      runtime,
      projectDir: repo.dir,
      workdir: repo.dir,
      storyGitRef: repo.base,
    });
    const { env } = await buildStoryEnv(ctx, makeMockCallContext({ runtime }));
    const facts = await factsOf(env, ["scoped"]);
    expect(facts.candidates).toEqual([]);
    expect(facts.protectedPaths).toEqual(protectedPathList(naxProtectedPaths()));
  });
});

describe("steps.applyConfigChange reaches the story's next gate run (US-004)", () => {
  test("AC-2: an applied change makes the next gates() run select the new scoped command", async () => {
    const built = await buildEnv(await makeRepo());
    const outcome = await applyChange(built.env);
    expect(outcome).toMatchObject({ applied: true, key: "testScoped", from: OLD_COMMAND, to: NEW_COMMAND });

    expect(await scopedCommandsOf(built.env)).toEqual([NEW_COMMAND]);
  });

  test("AC-11: a refused change leaves the next gates() run on the original scoped command", async () => {
    const built = await buildEnv(await makeRepo());
    const outcome = await applyChange(built.env, { needsHumanConfirm: true });
    expect(outcome).toMatchObject({ applied: false, reason: "needs-confirm" });

    expect(await scopedCommandsOf(built.env)).toEqual([OLD_COMMAND]);
  });
});

describe("sink.recordConfigChange (US-004)", () => {
  test("AC-7: two recorded changes are both kept, in call order", async () => {
    const built = await buildEnv(await makeRepo());
    const sink = built.env.sink;
    assertDefined(sink.recordConfigChange, "sink.recordConfigChange");

    const first = entry({ round: 1 });
    const second = entry({ round: 2, key: "lint", from: "biome check .", to: "eslint .", applied: false });
    await sink.recordConfigChange(first);
    await sink.recordConfigChange(second);

    expect((await persistedRecord(built.dir, built.runtime.runId)).configChanges).toEqual([first, second]);
  });

  test("AC-10: a resumed record's earlier changes survive the new one", async () => {
    const repo = await makeRepo();
    const prior = entry({ round: 1, decisionId: "D-1" });
    // The prior run's unfinished record: no end state (so it is resumable) and past the implement phase.
    const priorRunDir = workflowRunDir(repo.dir, FEATURE, "prior-run");
    const priorRecord: WorkflowStoryRecord = {
      ...newStoryRecord(STORY_ID, 3, "2026-01-01T00:00:00.000Z"),
      phase: "gates",
      round: 1,
      configChanges: [prior],
    };
    await Bun.write(
      join(priorRunDir, "result.json"),
      `${JSON.stringify(
        { schemaVersion: 1, runId: "prior-run", feature: FEATURE, stories: { [STORY_ID]: priorRecord } },
        null,
        2,
      )}\n`,
    );

    const built = await buildEnv(repo);
    expect(built.env.resume?.configChanges).toEqual([prior]);

    const sink = built.env.sink;
    assertDefined(sink.recordConfigChange, "sink.recordConfigChange");
    const second = entry({ round: 2, to: "bun test --bail {{files}}", decisionId: "D-4" });
    await sink.recordConfigChange(second);

    expect((await persistedRecord(built.dir, built.runtime.runId)).configChanges).toEqual([prior, second]);
  });
});

describe("the live advisor's menu with no candidates (US-004)", () => {
  test("AC-9: empty configFacts candidates leave the implementer-question menu answer and hold only", async () => {
    const asked: QuestionDraft[] = [];
    _workflowDeps.createAdvisor = () => recordingAdvisor(asked);
    const built = await buildEnv(await makeRepo(MANIFEST_NO_SCRIPTS));
    const facts = await factsOf(built.env, ["scoped"]);
    expect(facts.candidates).toEqual([]);

    const answer = await built.env.advisor.answerQuestion({
      storyId: STORY_ID,
      status: "NEEDS_CONTEXT",
      concerns: "the scoped gate cannot find the test files",
      facts,
    });

    expect(answer).toBeNull();
    const question = asked[0];
    assertDefined(question, "asked question");
    expect(question.options.map((o) => o.type)).toEqual(["answer", "hold"]);
  });
});
