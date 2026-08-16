import { describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";

import * as bakeoff from "../../../src/bakeoff";
import { projectOutputDir } from "../../../src/runtime";
import { validateStoryId } from "../../../src/prd/validate";

type UnknownRecord = Record<string, unknown>;
type AsyncFn = (...args: unknown[]) => Promise<unknown>;

const packageRoot = join(import.meta.dir, "../../..");
const feature = "bakeoff-compare-profiles";

function exported(name: string): AsyncFn {
  const value = (bakeoff as UnknownRecord)[name];
  expect(typeof value).toBe("function");
  return value as AsyncFn;
}

function config(overrides: UnknownRecord = {}): UnknownRecord {
  return { name: "acceptance-project", agent: { default: "claude", fallback: { enabled: false } }, ...overrides };
}

function profile(agent = "claude", overlay: UnknownRecord = {}): UnknownRecord {
  return { agent: { default: agent }, ...overlay };
}

function validationDeps(profiles: Record<string, UnknownRecord | undefined>) {
  return {
    loadProfile: mock(async (name: string) => {
      const found = profiles[name];
      if (!found) throw new Error(`Profile ${name} was not found`);
      return found;
    }),
    hasAcpAdapterEntry: (agent: string) => agent === "claude",
    isInstalled: (agent: string) => agent === "claude",
    deepMergeConfig: (base: UnknownRecord, overlay: UnknownRecord) => ({ ...base, ...overlay, agent: { ...(base.agent as UnknownRecord), ...(overlay.agent as UnknownRecord) } }),
  };
}

function runnerDeps(pipeline: (context: UnknownRecord) => Promise<UnknownRecord>) {
  return {
    worktreeManager: {
      create: mock(async (root: string, id: string) => {
        const path = join(root, ".nax-wt", id);
        mkdirSync(path, { recursive: true });
        return path;
      }),
      remove: mock(async (root: string, id: string) => rmSync(join(root, ".nax-wt", id), { recursive: true, force: true })),
    },
    pipeline,
    projectOutputDir,
    deriveBakeoffWorktreeId: (runFeature: string, name: string) => `bakeoff-${runFeature}-${name}`,
  };
}

function successfulPipeline(contexts: UnknownRecord[]) {
  return mock(async (context: UnknownRecord) => {
    contexts.push(context);
    return { results: [{ status: "passed" }], metrics: [] };
  });
}

function tempDir(label: string): string {
  const path = join("/tmp", `nax-bakeoff-${label}-${randomUUID()}`);
  mkdirSync(path, { recursive: true });
  return path;
}

function shell(args: string[], cwd: string): void {
  const result = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(0);
}

function gitRepo(label: string): string {
  const root = tempDir(label);
  shell(["git", "init"], root);
  shell(["git", "config", "user.email", "acceptance@nax.test"], root);
  shell(["git", "config", "user.name", "Nax Acceptance"], root);
  writeFileSync(join(root, "README.md"), "fixture\n");
  shell(["git", "add", "README.md"], root);
  shell(["git", "commit", "-m", "fixture"], root);
  return root;
}

function options(root: string, agents = ["profile-a"]): UnknownRecord {
  return { agents, feature, projectRoot: root, outputDir: join(root, "out"), config: config() };
}

describe("bakeoff profile contestants", () => {
  test("AC-1: resolves a valid cross-agent-pi profile", async () => {
    const result = await exported("validateContestants")(["cross-agent-pi"], config(), packageRoot, validationDeps({ "cross-agent-pi": profile() }));
    expect(result).toMatchObject({ validAgents: ["cross-agent-pi"], errors: [] });
  });

  test("AC-2: reports unknown-profile for a missing profile", async () => {
    const result = await exported("validateContestants")(["nonexistent-profile"], config(), packageRoot, validationDeps({}));
    expect((result as UnknownRecord).errors).toEqual([expect.objectContaining({ reason: "unknown-profile" })]);
  });

  test("AC-3: retains only resolvable profiles", async () => {
    const result = await exported("validateContestants")(["resolvable-profile", "unresolvable-profile"], config(), packageRoot, validationDeps({ "resolvable-profile": profile() }));
    expect(result).toMatchObject({ validAgents: ["resolvable-profile"], errors: [expect.objectContaining({ profile: "unresolvable-profile" })] });
  });

  test("AC-4: includes the missing profile name in its error message", async () => {
    const result = await exported("validateContestants")(["missing-profile"], config(), packageRoot, validationDeps({}));
    const [error] = (result as { errors: Array<{ message?: string }> }).errors;
    expect(error?.message).toContain("missing-profile");
  });

  test("AC-5: loads every profile with the bake-off root", async () => {
    const deps = validationDeps({ "profile-a": profile(), "profile-b": profile() });
    await exported("validateContestants")(["profile-a", "profile-b"], config(), packageRoot, deps);
    expect(deps.loadProfile.mock.calls).toEqual([["profile-a", packageRoot], ["profile-b", packageRoot]]);
  });

  test("AC-6: reports no-acp-adapter for an unregistered resolved agent", async () => {
    const deps = validationDeps({ unsupported: profile("unsupported") });
    const result = await exported("validateContestants")(["unsupported"], config(), packageRoot, deps);
    expect(result).toMatchObject({ errors: [expect.objectContaining({ profile: "unsupported", reason: "no-acp-adapter" })] });
  });

  test("AC-7: reports dnf-not-installed for a missing resolved-agent binary", async () => {
    const deps = { ...validationDeps({ missing: profile("claude") }), isInstalled: () => false };
    const result = await exported("validateContestants")(["missing"], config(), packageRoot, deps);
    expect(result).toMatchObject({ errors: [expect.objectContaining({ profile: "missing", reason: "dnf-not-installed" })] });
  });

  test("AC-8: profile-only configuration wins in the merged config", async () => {
    const result = await exported("validateContestants")(["profile-a"], config(), packageRoot, validationDeps({ "profile-a": profile("claude", { x: { v: "profile-value" } }) }));
    expect((result as { contestants: Array<{ config: UnknownRecord }> }).contestants[0]?.config.x).toEqual({ v: "profile-value" });
  });

  test("AC-9: profile overlay replaces a base configuration value", async () => {
    const result = await exported("validateContestants")(["profile-a"], config({ x: { v: "base-value" } }), packageRoot, validationDeps({ "profile-a": profile("claude", { x: { v: "overlay-value" } }) }));
    expect((result as { contestants: Array<{ config: { x: { v: string } } }> }).contestants[0]?.config.x.v).toBe("overlay-value");
  });

  test("AC-10: preserves the profile agent.default in merged configuration", async () => {
    const result = await exported("validateContestants")(["profile-a"], config(), packageRoot, validationDeps({ "profile-a": profile("claude") }));
    expect((result as { contestants: Array<{ config: { agent: { default: string } } }> }).contestants[0]?.config.agent.default).toBe("claude");
  });

  test("AC-11: pins fallback disabled after merging the profile", async () => {
    const result = await exported("validateContestants")(["profile-a"], config({ agent: { fallback: { enabled: false } } }), packageRoot, validationDeps({ "profile-a": profile("claude", { agent: { fallback: { enabled: true } } }) }));
    expect((result as { contestants: Array<{ config: { agent: { fallback: { enabled: boolean } } } }> }).contestants[0]?.config.agent.fallback.enabled).toBe(false);
  });
});

describe("isolated contestant contexts", () => {
  test("AC-12: pipeline context contains the profile name", async () => {
    const root = tempDir("context-profile"); const contexts: UnknownRecord[] = [];
    await exported("runContestant")("expected-profile", { ...options(root), feature, config: config() }, runnerDeps(successfulPipeline(contexts)));
    expect(contexts[0]?.profile).toBe("expected-profile");
  });

  test("AC-13: pipeline context contains the bake-off feature", async () => {
    const root = tempDir("context-feature"); const contexts: UnknownRecord[] = [];
    await exported("runContestant")("profile-a", { ...options(root), feature: "expected-feature", config: config() }, runnerDeps(successfulPipeline(contexts)));
    expect(contexts[0]?.feature).toBe("expected-feature");
  });

  test("AC-14: worktree path ends with the contestant worktree id", async () => {
    const root = tempDir("context-worktree"); const contexts: UnknownRecord[] = [];
    const deps = runnerDeps(successfulPipeline(contexts));
    await exported("runContestant")("profile-a", { ...options(root), config: config() }, deps);
    const id = (deps.worktreeManager.create.mock.calls[0] as string[])[1];
    expect(contexts[0]?.worktree).toBe(join(root, ".nax-wt", id));
  });

  test("AC-15: two contestants receive different worktrees", async () => {
    const root = tempDir("two-worktrees"); const contexts: UnknownRecord[] = [];
    const pipeline = successfulPipeline(contexts); const deps = runnerDeps(pipeline);
    await exported("runContestant")("profile-a", { ...options(root), config: config() }, deps);
    await exported("runContestant")("profile-b", { ...options(root), config: config() }, deps);
    expect(contexts.map((context) => context.worktree)).toEqual([expect.any(String), expect.any(String)]);
    expect(contexts[0]?.worktree).not.toBe(contexts[1]?.worktree);
  });

  test("AC-16: output directory is feature and profile scoped", async () => {
    const root = tempDir("output-path"); const contexts: UnknownRecord[] = [];
    const baseOutput = join(root, "base-output");
    await exported("runContestant")("profile-a", { ...options(root), feature: "my-feature", config: config({ name: "project-key", outputDir: baseOutput }) }, runnerDeps(successfulPipeline(contexts)));
    expect(contexts[0]?.outputDir).toBe(join(projectOutputDir("project-key", baseOutput), "bakeoff", "my-feature", "profile-a"));
  });

  test("AC-17: two contestants receive distinct output directories", async () => {
    const root = tempDir("two-outputs"); const contexts: UnknownRecord[] = []; const deps = runnerDeps(successfulPipeline(contexts));
    await exported("runContestant")("profile-a", { ...options(root), config: config() }, deps);
    await exported("runContestant")("profile-b", { ...options(root), config: config() }, deps);
    expect(contexts.map((context) => context.outputDir)).toEqual([expect.any(String), expect.any(String)]);
    expect(contexts[0]?.outputDir).not.toBe(contexts[1]?.outputDir);
  });

  test("AC-18: context config outputDir equals context outputDir", async () => {
    const root = tempDir("config-output"); const contexts: UnknownRecord[] = [];
    await exported("runContestant")("profile-a", { ...options(root), config: config() }, runnerDeps(successfulPipeline(contexts)));
    expect((contexts[0]?.config as UnknownRecord).outputDir).toBe(contexts[0]?.outputDir);
  });

  test("AC-19: pipeline rejection becomes dnf-crashed", async () => {
    const root = tempDir("pipeline-crash");
    const result = await exported("runContestant")("profile-a", { ...options(root), config: config() }, runnerDeps(async () => { throw new Error("pipeline crashed"); }));
    expect(result).toMatchObject({ status: "dnf-crashed" });
  });

  test("AC-20: a crash does not prevent the next contestant pipeline", async () => {
    const root = tempDir("continue-after-crash"); let calls = 0;
    const pipeline = mock(async () => { calls += 1; if (calls === 1) throw new Error("first failed"); return { results: [{ status: "passed" }], metrics: [] }; });
    const deps = runnerDeps(pipeline);
    await exported("runContestant")("first", { ...options(root), config: config() }, deps);
    await exported("runContestant")("second", { ...options(root), config: config() }, deps);
    expect(pipeline).toHaveBeenCalledTimes(2);
  });

  test("AC-21: two worktree directories exist during execution and are cleaned", async () => {
    const root = tempDir("worktree-cleanup"); const observed: string[][] = [];
    const pipeline = async () => { observed.push(readdirSync(join(root, ".nax-wt")).sort()); return { results: [{ status: "passed" }], metrics: [] }; };
    const deps = runnerDeps(pipeline);
    await exported("runContestant")("profile-a", { ...options(root), config: config() }, deps);
    await exported("runContestant")("profile-b", { ...options(root), config: config() }, deps);
    expect(observed.flat().filter((name) => name.startsWith("bakeoff-"))).toHaveLength(2);
    expect(existsSync(join(root, ".nax-wt")) ? readdirSync(join(root, ".nax-wt")) : []).toEqual([]);
  });

  test("AC-22: persists a feature-scoped bakeoff JSON file", async () => {
    const output = tempDir("persist");
    await exported("persistBakeoffResult")({ feature: "persisted", contestants: [], ranking: [], outcome: 0 }, output);
    const path = join(output, "bakeoff", "persisted", "bakeoff.json");
    expect(existsSync(path)).toBe(true); expect(() => JSON.parse(readFileSync(path, "utf8"))).not.toThrow();
  });

  test("AC-23: feature-scoped persisted results do not overwrite each other", async () => {
    const output = tempDir("persist-two");
    await exported("persistBakeoffResult")({ feature: "A", contestants: [], ranking: [], outcome: 0 }, output);
    await exported("persistBakeoffResult")({ feature: "B", contestants: [], ranking: [], outcome: 0 }, output);
    expect(JSON.parse(readFileSync(join(output, "bakeoff", "A", "bakeoff.json"), "utf8")).feature).toBe("A");
    expect(JSON.parse(readFileSync(join(output, "bakeoff", "B", "bakeoff.json"), "utf8")).feature).toBe("B");
  });
});

describe("pipeline adapter", () => {
  function context(): UnknownRecord { return { profile: "profile-a", feature: "my-feature", worktree: "/path/to/worktree", outputDir: "/path/to/output", config: config() }; }
  function adapter(run: ReturnType<typeof mock>, metrics: UnknownRecord[] = []) { return exported("createPipelineAdapter")({ run, loadRunMetrics: mock(async () => metrics), loadHooksConfig: async () => ({}) }); }

  test("AC-24: handleRunAction invokes the adapter once per resolved profile", async () => {
    const run = mock(async () => ({ storiesCompleted: 1, totalCost: 0, durationMs: 0 }));
    const pipeline = adapter(run); const profiles = ["a", "b"];
    await exported("handleRunAction")({ ...options(tempDir("cli"), profiles), compare: profiles.join(",") }, { runBakeoff: async (input: UnknownRecord) => Promise.all((input.agents as string[]).map((name) => pipeline({ ...context(), profile: name }))), runSingleAgent: async () => undefined });
    expect(run).toHaveBeenCalledTimes(2);
  });

  test("AC-25: adapter passes context worktree as run workdir", async () => { const run = mock(async () => ({ storiesCompleted: 0, totalCost: 0, durationMs: 0 })); await adapter(run)(context()); expect(run).toHaveBeenCalledWith(expect.objectContaining({ workdir: "/path/to/worktree" })); });
  test("AC-26: adapter places PRD path inside worktree", async () => { const run = mock(async () => ({ storiesCompleted: 0, totalCost: 0, durationMs: 0 })); await adapter(run)(context()); expect((run.mock.calls[0] as UnknownRecord[])[0]?.prdPath).toMatch(/^\/path\/to\/worktree\//); });
  test("AC-27: adapter names PRD after the feature", async () => { const run = mock(async () => ({ storiesCompleted: 0, totalCost: 0, durationMs: 0 })); await adapter(run)(context()); expect(basename(((run.mock.calls[0] as UnknownRecord[])[0]?.prdPath as string))).toBe("my-feature.prd.md"); });
  test("AC-28: adapter places status file inside outputDir", async () => { const run = mock(async () => ({ storiesCompleted: 0, totalCost: 0, durationMs: 0 })); await adapter(run)(context()); expect((run.mock.calls[0] as UnknownRecord[])[0]?.statusFile).toMatch(/^\/path\/to\/output\//); });
  test("AC-29: adapter passes the exact context config", async () => { const run = mock(async () => ({ storiesCompleted: 0, totalCost: 0, durationMs: 0 })); const value = context(); await adapter(run)(value); expect((run.mock.calls[0] as UnknownRecord[])[0]?.config).toEqual(value.config); });
  test("AC-30: adapter returns one result per completed story", async () => { const run = mock(async () => ({ storiesCompleted: 5, totalCost: 0, durationMs: 0 })); expect((await adapter(run)(context()) as { results: unknown[] }).results).toHaveLength(5); });
  test("AC-31: adapter loads metrics from context outputDir", async () => { const run = mock(async () => ({ storiesCompleted: 0, totalCost: 0, durationMs: 0 })); const loadRunMetrics = mock(async () => []); await exported("createPipelineAdapter")({ run, loadRunMetrics, loadHooksConfig: async () => ({}) })(context()); expect(loadRunMetrics).toHaveBeenCalledWith("/path/to/output"); });
  test("AC-32: adapter maps costs and durations from loaded metrics", async () => { const run = mock(async () => ({ storiesCompleted: 2, totalCost: 0, durationMs: 0 })); const result = await adapter(run, [{ id: "s1", cost: 0.5, durationMs: 1000 }, { id: "s2", cost: 0.75, durationMs: 2000 }])(context()); expect((result as UnknownRecord).metrics).toEqual(expect.arrayContaining([{ cost: 0.5, durationMs: 1000 }, { cost: 0.75, durationMs: 2000 }])); });
  test("AC-33: adapter uses run totals when no metrics are stored", async () => { const run = mock(async () => ({ storiesCompleted: 1, totalCost: 1.25, durationMs: 5000 })); const result = await adapter(run)(context()); expect((result as UnknownRecord).metrics).toEqual([{ cost: 1.25, durationMs: 5000 }]); });
});

describe("worktree namespace and PRD guards", () => {
  test("AC-34: uncommitted PRD prevents worktree creation", async () => {
    const root = gitRepo("prd-guard"); const create = mock(async () => undefined);
    const result = await exported("handleRunAction")({ ...options(root), compare: "profile-a" }, { assertCommittedFeaturePrd: async () => { const error = new Error("PRD_UNCOMMITTED"); Object.assign(error, { code: "PRD_UNCOMMITTED" }); throw error; }, worktreeManager: { listWorktrees: async () => [], create }, runSingleAgent: async () => undefined });
    expect(result).toMatchObject({ code: expect.stringMatching(/^PRD_(UNCOMMITTED|UNTRACKED)$/) });
    expect(create).not.toHaveBeenCalled();
  });

  test("AC-35: derived IDs begin with bakeoff-", () => expect((exported("deriveBakeoffWorktreeId") as unknown as (f: string, p: string) => string)("feature", "profile")).toStartWith("bakeoff-"));
  test("AC-36: derived IDs sanitize symbols and unicode", () => { const id = (exported("deriveBakeoffWorktreeId") as unknown as (f: string, p: string) => string)("feature", "!@#$%^&*() café"); expect(() => validateStoryId(id)).not.toThrow(); });
  test("AC-37: derived IDs are at most 64 characters", () => expect((exported("deriveBakeoffWorktreeId") as unknown as (f: string, p: string) => string)("f".repeat(50), "p".repeat(50)).length).toBeLessThanOrEqual(64));
  test("AC-38: different overlong inputs keep distinct IDs", () => { const derive = exported("deriveBakeoffWorktreeId") as unknown as (f: string, p: string) => string; expect(derive("f".repeat(60), "a".repeat(60))).not.toBe(derive("f".repeat(60), "b".repeat(60))); });

  test("AC-39: preflight reclaims stale bakeoff branches", async () => {
    const root = gitRepo("stale-branch"); const id = "bakeoff-test-xyz"; shell(["git", "branch", `nax/${id}`], root);
    await exported("preflightBakeoff")({ projectRoot: root, feature, agents: ["test-xyz"] });
    expect(Bun.spawnSync(["git", "branch", "--list", `nax/${id}`], { cwd: root, stdout: "pipe" }).stdout.toString().trim()).toBe("");
  });

  test("AC-40: preflight does not delete ordinary branches", async () => {
    const root = gitRepo("ordinary-branch"); shell(["git", "branch", "feature/my-branch"], root);
    await exported("preflightBakeoff")({ projectRoot: root, feature, agents: [] });
    expect(Bun.spawnSync(["git", "branch", "--list", "feature/my-branch"], { cwd: root, stdout: "pipe" }).stdout.toString()).toContain("feature/my-branch");
  });

  test("AC-41: untracked prd.json returns PRD_UNTRACKED and names the PRD", async () => {
    const root = gitRepo("untracked-prd"); const prd = join(root, ".nax", "features", feature, "prd.json"); mkdirSync(join(root, ".nax", "features", feature), { recursive: true }); writeFileSync(prd, "{}");
    const result = await exported("handleRunAction")({ ...options(root), compare: "profile-a" });
    expect(result).toMatchObject({ code: "PRD_UNTRACKED", message: expect.stringContaining("prd.json") });
  });

  test("AC-42: modified prd.json returns PRD_UNCOMMITTED and names the PRD", async () => {
    const root = gitRepo("modified-prd"); const dir = join(root, ".nax", "features", feature); mkdirSync(dir, { recursive: true }); const prd = join(dir, "prd.json"); writeFileSync(prd, "{}"); shell(["git", "add", ".nax"], root); shell(["git", "commit", "-m", "add prd"], root); writeFileSync(prd, '{"changed":true}');
    const result = await exported("handleRunAction")({ ...options(root), compare: "profile-a" });
    expect(result).toMatchObject({ code: "PRD_UNCOMMITTED", message: expect.stringContaining("prd.json") });
  });

  test("AC-43: untracked PRD does not invoke the pipeline", async () => {
    const root = gitRepo("untracked-no-pipeline"); const dir = join(root, ".nax", "features", feature); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "prd.json"), "{}"); const pipeline = mock(async () => ({ results: [], metrics: [] }));
    await exported("handleRunAction")({ ...options(root), compare: "profile-a" }, { pipeline, runSingleAgent: async () => undefined });
    expect(pipeline).not.toHaveBeenCalled();
  });

  test("AC-44: worktree creation failure produces dnf-crashed with its reason", async () => {
    const root = tempDir("create-failure"); const reason = "worktree creation failed";
    const result = await exported("runContestant")("bad-profile", { ...options(root), config: config() }, { ...runnerDeps(async () => ({ results: [], metrics: [] })), worktreeManager: { create: async () => { throw new Error(reason); }, remove: async () => undefined } });
    expect(result).toMatchObject({ status: "dnf-crashed", error: expect.stringContaining(reason) });
  });

  test("AC-45: explicit dependencies return the profile name as a string agent", async () => {
    const root = tempDir("explicit-deps"); const result = await exported("runContestant")("test-profile", { ...options(root), config: config() }, runnerDeps(async () => ({ results: [{ status: "passed" }], metrics: [] })));
    expect(result).toMatchObject({ agent: "test-profile" }); expect(typeof (result as UnknownRecord).agent).toBe("string");
  });
});