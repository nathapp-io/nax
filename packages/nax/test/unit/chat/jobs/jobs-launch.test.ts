import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { utimes } from "node:fs/promises";
import { join } from "node:path";
import { assertDefined, cleanupTempDir, makePRD, makeStory, makeTempDir } from "@test/helpers";
import type { HostApprovalCard } from "@/chat/ask-controller";
import type { ChatJobs, StartJobRequest } from "@/chat/jobs/job-runner";
import { _jobsLaunchDeps } from "@/chat/jobs/jobs-launch";
import {
  createJobsProvider,
  type JobsProviderOptions,
  PROFILES_SCHEMA,
  PUBLISH_SCHEMA,
} from "@/chat/jobs/jobs-provider";
import { _workflowDefaultsDeps } from "@/chat/jobs/workflow-defaults";
import { type ChatWorkflowConfig, featureDir } from "@/config";
import { newFeatureRecord } from "@/workflow/feature-record";
import { type FoundHandoffMark, writeHandoffMark } from "@/workflow/handoff-mark";
import { workflowFeatureDir } from "@/workflow/paths";
import { newStoryRecord, upsertFeatureRecord, upsertStoryRecord } from "@/workflow/result";
import type { WorkflowFeatureRecord } from "@/workflow/types";

function locatedPrior(record: WorkflowFeatureRecord) {
  return { record, runDir: join(workflowFeatureDir(options.repoRoot, "f1"), "run-1") };
}

const originalDeps = { ..._jobsLaunchDeps };
const originalWorkflowDeps = { ..._workflowDefaultsDeps };
let options: JobsProviderOptions;
let approve: ReturnType<typeof mock<(card: HostApprovalCard) => Promise<"allow" | "deny">>>;
let start: ReturnType<typeof mock<ChatJobs["start"]>>;
let signal: AbortSignal;

beforeEach(async () => {
  const repoRoot = makeTempDir("jobs-launch-");
  signal = new AbortController().signal;
  approve = mock(async () => "allow");
  start = mock(async (request: StartJobRequest) => ({
    ...request,
    schemaVersion: 1,
    id: "run-12345678",
    cwd: repoRoot,
    pid: 123,
    startedAt: "2026-10-01T00:00:00.000Z",
    state: "running",
    logPath: join(repoRoot, "job.log"),
  }));
  const jobs: ChatJobs = {
    start,
    list: () => [],
    get: () => undefined,
    running: () => [],
    owned: () => [],
    cancel: async () => {
      throw new Error("unexpected cancel");
    },
    canCancel: async () => ({ ok: false, message: "unused" }),
    attach: async () => {},
    logTail: async () => "",
    peekNotice: () => undefined,
    takeNotice: () => undefined,
    onChange: () => () => {},
    dispose: () => {},
  };
  options = {
    repoRoot,
    naxEntry: ["bun", "/n.ts"],
    interactionPlugin: "cli",
    jobs,
    approve,
    sessionId: () => "chat-1",
    now: () => new Date("2026-10-01T00:00:00Z"),
  };
  _jobsLaunchDeps.git = mock(async () => ({ exitCode: 0, stdout: "feat/f1\n", stderr: "" }));
  // US-002: a publish launch reads the prior record and HEAD after its pending-story guard.
  _jobsLaunchDeps.loadPriorFeature = mock(async () => null);
  _jobsLaunchDeps.headSha = mock(async () => null);
  await Bun.write(
    join(featureDir(repoRoot, "f1"), "prd.json"),
    JSON.stringify(
      makePRD({
        userStories: [1, 2, 3].map((n) => makeStory({ id: `US-00${n}`, status: "pending", passes: false })),
      }),
    ),
  );
});
afterEach(() => {
  Object.assign(_jobsLaunchDeps, originalDeps);
  Object.assign(_workflowDefaultsDeps, originalWorkflowDeps);
  cleanupTempDir(options.repoRoot);
});
async function launch(kind = "run", input: Record<string, unknown> = { feature: "f1" }) {
  const tool = (await createJobsProvider(options).tools(options.repoRoot)).find((t) => t.localName === kind);
  assertDefined(tool, `launch tool ${kind}`);
  return tool.run(input, {
    root: options.repoRoot,
    resolvedPaths: [],
    maxBytes: 300_000,
    maxFileBytes: 300_000,
    signal,
  });
}
function card() {
  const value = approve.mock.calls[0]?.[0];
  assertDefined(value, "approval card");
  return value;
}
function runArgv() {
  return ["bun", "/n.ts", "run", "-f", "f1", "-d", options.repoRoot, "--headless"];
}

describe("createJobsProvider", () => {
  test("#2815 the profiles field tells the agent to omit it to use the planned profile", () => {
    expect(PROFILES_SCHEMA.type).toBe("array");
    expect(PROFILES_SCHEMA.description).toContain("Omit");
    expect(PROFILES_SCHEMA.description).toContain("nax-jobs__list");
  });
  test("US-006 AC-23 the profiles description names chat.workflow as the configured default", () => {
    expect(PROFILES_SCHEMA.description).toContain("chat.workflow");
  });
  test.each([
    ["plan", { feature: { type: "string" }, spec: { type: "string" } }, "feature"],
    ["run", { feature: { type: "string" }, maxCost: { type: "number" }, publish: PUBLISH_SCHEMA }, "feature"],
    ["publish", { feature: { type: "string" } }, "feature"],
    ["bot_review", { pr: { type: "integer" }, model: { type: "string" }, decisions: { type: "string" } }, "pr"],
    [
      "bot_fix",
      {
        pr: { type: "integer" },
        model: { type: "string" },
        trust: { type: "boolean" },
        noRereview: { type: "boolean" },
      },
      "pr",
    ],
  ])("%s has a closed schema with exact properties", async (kind, properties, required) => {
    const tool = (await createJobsProvider(options).tools(options.repoRoot)).find((t) => t.localName === kind);
    assertDefined(tool, "schema tool");
    expect(tool.inputSchema).toEqual({
      type: "object",
      additionalProperties: false,
      required: [required],
      properties: { ...properties, profiles: PROFILES_SCHEMA, repo: { type: "string" } },
    });
  });
  test("plan prefers feature spec over legacy and explicit spec over both", async () => {
    await Bun.write(join(featureDir(options.repoRoot, "f1"), "spec.md"), "feature spec");
    await Bun.write(join(options.repoRoot, ".nax", "specs", "f1.md"), "legacy spec");
    await launch("plan");
    expect(start.mock.calls[0]?.[0].argv).toContain(".nax/features/f1/spec.md");
    await Bun.write(join(options.repoRoot, "custom.md"), "custom spec");
    await launch("plan", { feature: "f1", spec: "./custom.md", profiles: ["a", "b"] });
    expect(start.mock.calls[1]?.[0]).toMatchObject({
      kind: "plan",
      target: "f1",
      argv: [
        "bun",
        "/n.ts",
        "plan",
        "-f",
        "f1",
        "--from",
        "custom.md",
        "-d",
        options.repoRoot,
        "--profile",
        "a",
        "--profile",
        "b",
      ],
    });
    expect(approve.mock.calls[1]?.[0].reason).toContain("profiles a, b");
  });
  test("missing explicit spec does not fall back to an existing default", async () => {
    await Bun.write(join(featureDir(options.repoRoot, "f1"), "spec.md"), "spec");
    expect(await launch("plan", { feature: "f1", spec: "missing.md" })).toEqual({
      isError: true,
      content: "[chat] no spec for f1; looked for missing.md",
    });
    expect(approve).not.toHaveBeenCalled();
  });
  test("bot review validates existing decisions and starts the approved PR argv", async () => {
    await Bun.write(join(options.repoRoot, "d.json"), "{}");
    await launch("bot_review", { pr: 12, decisions: "d.json", model: "opus" });
    expect(card().summary).toBe("nax bot review #12");
    expect(start.mock.calls[0]?.[0]).toMatchObject({
      kind: "bot_review",
      target: "12",
      argv: ["bun", "/n.ts", "bot", "review", "12", "-d", options.repoRoot, "--model", "opus", "--decisions", "d.json"],
    });
  });
  test("unreadable PRD returns an error without approving or launching", async () => {
    await Bun.write(join(featureDir(options.repoRoot, "f1"), "prd.json"), "not json");
    expect(await launch()).toMatchObject({ isError: true });
    expect(approve).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
  test("AC-1 exactly five launch tools and static metadata", async () => {
    const provider = createJobsProvider(options);
    expect((await provider.tools(options.repoRoot)).slice(0, 5).map((t) => t.localName)).toEqual([
      "plan",
      "run",
      "publish",
      "bot_review",
      "bot_fix",
    ]);
    expect({
      id: provider.id,
      kind: provider.kind,
      stages: provider.stages,
    }).toEqual({ id: "nax-jobs", kind: "static", stages: ["*"] });
  });
  test("AC-2 each description explains billing and explicit user asks", async () => {
    const tools = (await createJobsProvider(options).tools(options.repoRoot)).slice(0, 4);
    expect(tools).toHaveLength(4);
    for (const tool of tools) {
      expect(tool.description).toContain("asks the user");
      expect(tool.description).toContain("Billed");
    }
  });
  test("AC-3 run asks exactly once", async () => {
    await launch();
    expect(approve).toHaveBeenCalledTimes(1);
  });
  test("AC-4 run card identity", async () => {
    await launch();
    expect({ tool: card().tool, summary: card().summary }).toEqual({ tool: "nax-jobs__run", summary: "nax run f1" });
  });
  test("AC-5 command is the exact argv display", async () => {
    await launch();
    expect(card().command).toBe(runArgv().join(" "));
  });
  test("AC-6 allow starts the approved request with current session and timestamp", async () => {
    await launch();
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]?.[0]).toEqual({
      kind: "run",
      target: "f1",
      argv: runArgv(),
      cwd: options.repoRoot,
      sessionId: "chat-1",
      approvedAt: options.now().toISOString(),
    });
  });
  test("AC-7 result contains started job JSON and completion notice", async () => {
    const result = await launch();
    expect(JSON.parse(result.content.split("\n")[0] ?? "")).toEqual({
      job: "run-12345678",
      state: "running",
      log: join(options.repoRoot, "job.log"),
    });
    expect(result.content.split("\n")[1]).toBe("A [nax-jobs] notice arrives when it ends.");
  });
  test("AC-8 deny never starts", async () => {
    approve.mockResolvedValue("deny");
    await launch();
    expect(start).not.toHaveBeenCalled();
  });
  test("AC-9 denial result forbids argument retries", async () => {
    approve.mockResolvedValue("deny");
    expect(await launch()).toEqual({
      isError: true,
      content: "[chat] the user declined nax run f1; do not retry with different arguments unless the user asks",
    });
  });
  test("US-005 AC-6 counts pending stories without cap text", async () => {
    await launch();
    expect(card().reason).toContain("stories 3 pending of 3");
    expect(card().reason).not.toContain("max iterations");
  });
  test("US-005 AC-7 removed input never starts", async () => {
    expect(await launch("run", { feature: "f1", maxIterations: 2 })).toEqual({
      isError: true,
      content: "[chat] maxIterations was removed: workflow mode bounds a run by its stories",
    });
    expect(start).not.toHaveBeenCalled();
    expect(approve).not.toHaveBeenCalled();
  });
  test("workflow run shows no limit or overflow warning", async () => {
    await launch("run", { feature: "f1" });
    expect(card().reason).toContain("stories 3 pending of 3");
    expect(card().reason).not.toContain("max iterations");
    expect(card().reason).not.toContain("nax#2706");
  });
  test("AC-12 cli warns about unanswerable asks", async () => {
    await launch();
    expect(card().reason).toContain("asks you do not answer in chat fall to the run's timeout defaults");
  });
  test("AC-13 telegram has no channel warning", async () => {
    options = { ...options, interactionPlugin: "telegram" };
    await launch();
    expect(card().reason).not.toContain("no channel");
    expect(card().reason).not.toContain("asks you do not answer in chat fall to the run's timeout defaults");
  });
  test("AC-14 branch is shown and queried in repo root", async () => {
    await launch();
    expect(card().reason.split("\n")[0]).toBe(`workdir ${options.repoRoot} on branch feat/f1`);
    expect(_jobsLaunchDeps.git).toHaveBeenCalledWith(["symbolic-ref", "--short", "HEAD"], options.repoRoot);
  });
  test("AC-15 failed symbolic-ref omits branch", async () => {
    _jobsLaunchDeps.git = mock(async () => ({ exitCode: 1, stdout: "", stderr: "detached" }));
    await launch();
    expect(card().reason.split("\n")[0]).toBe(`workdir ${options.repoRoot}`);
  });
  test("AC-16 entry and empty profiles are adjacent reason lines", async () => {
    await launch();
    expect(card().reason.split("\n").slice(1, 3)).toEqual(["nax bun /n.ts", "profiles (none)"]);
  });
  async function writePlannedProfile(routingProfile: string): Promise<void> {
    await Bun.write(
      join(featureDir(options.repoRoot, "f1"), "prd.json"),
      JSON.stringify(makePRD({ routingProfile, userStories: [makeStory({ id: "US-001", status: "pending" })] })),
    );
  }
  test("#2815 a run with no profiles names the PRD's planned profile on the card", async () => {
    await writePlannedProfile("a+b");
    await launch();
    expect(card().reason.split("\n")[2]).toBe("profiles (none); the run uses the PRD's planned profile a+b");
  });
  test("#2815 a PRD planned with the default profile keeps the plain empty line", async () => {
    await writePlannedProfile("default");
    await launch();
    expect(card().reason.split("\n")[2]).toBe("profiles (none)");
  });
  test("#2815 profiles that differ from the PRD's planned profile warn on the card", async () => {
    await writePlannedProfile("a");
    await launch("run", { feature: "f1", profiles: ["c"] });
    expect(card().reason).toContain("warning: the PRD was planned with profile a, not c");
  });
  test("#2815 profiles that match the PRD's planned chain do not warn", async () => {
    await writePlannedProfile("a+b");
    await launch("run", { feature: "f1", profiles: ["a", "b"] });
    expect(card().reason).not.toContain("warning: the PRD was planned");
  });
  test("#2819 publish is refused while stories are pending", async () => {
    const result = await launch("publish", { feature: "f1" });
    expect(result).toEqual({
      isError: true,
      content: "[chat] f1 has 3 pending stories; finish them with nax-jobs__run first",
    });
    expect(approve).not.toHaveBeenCalled();
  });
  test("AC-18 publish over a PRD with 2 pending stories is refused before any card", async () => {
    await Bun.write(
      join(featureDir(options.repoRoot, "f1"), "prd.json"),
      JSON.stringify(
        makePRD({
          userStories: [1, 2].map((n) => makeStory({ id: `US-00${n}`, status: "pending", passes: false })),
        }),
      ),
    );
    expect(await launch("publish", { feature: "f1" })).toEqual({
      isError: true,
      content: "[chat] f1 has 2 pending stories; finish them with nax-jobs__run first",
    });
    expect(approve).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
  test("#2819 publish on a passed feature shows a publish-only card and runs --publish-only", async () => {
    await Bun.write(
      join(featureDir(options.repoRoot, "f1"), "prd.json"),
      JSON.stringify(makePRD({ userStories: [makeStory({ id: "US-001", status: "passed", passes: true })] })),
    );
    await launch("publish", { feature: "f1" });
    expect(card().summary).toBe("nax run f1 --publish-only");
    expect(card().reason).toContain("publish only: reruns the workflow's publish step");
    expect(start.mock.calls[0]?.[0]).toMatchObject({
      kind: "publish",
      target: "f1",
      argv: [...runArgv(), "--publish-only"],
    });
  });
  test("AC-17 plan resolves legacy spec to repo-relative argv", async () => {
    await Bun.write(join(options.repoRoot, ".nax", "specs", "f1.md"), "spec");
    await launch("plan");
    expect(start.mock.calls[0]?.[0].argv).toEqual([
      "bun",
      "/n.ts",
      "plan",
      "-f",
      "f1",
      "--from",
      ".nax/specs/f1.md",
      "-d",
      options.repoRoot,
    ]);
  });
  test("AC-18 missing spec names both attempted paths without asking", async () => {
    const result = await launch("plan");
    expect(result.isError).toBe(true);
    expect(result.content).toStartWith("[chat] no spec for f1; looked for ");
    expect(result.content).toContain(".nax/features/f1/spec.md");
    expect(result.content).toContain(".nax/specs/f1.md");
    expect(approve).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
  test("AC-19 plan warns before replacing a PRD", async () => {
    await Bun.write(join(featureDir(options.repoRoot, "f1"), "spec.md"), "spec");
    await launch("plan");
    expect(card().reason).toContain("warning: prd.json exists and will be replaced");
  });
  test("AC-20 missing PRD returns actionable failure", async () => {
    expect(await launch("run", { feature: "f2" })).toEqual({
      isError: true,
      content: "[chat] no prd.json for f2; run nax plan first",
    });
    expect(approve).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
  test("AC-21 bot fix asks even with trust", async () => {
    await launch("bot_fix", { pr: 12, trust: true });
    expect(card().summary).toBe("nax bot fix #12");
  });
  test("AC-22 missing decisions returns failure without asking", async () => {
    expect(await launch("bot_review", { pr: 12, decisions: "d.json" })).toEqual({
      isError: true,
      content: "[chat] decisions file d.json not found",
    });
    expect(approve).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
  test("AC-23 parse failure returns unchanged without asking", async () => {
    expect(await launch("run", { feature: "f1", profiles: ["--x"] })).toEqual({
      isError: true,
      content: "[chat] profile --x is not a valid profile name",
    });
    expect(approve).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
  test("AC-24 approval receives the exact abort signal", async () => {
    await launch();
    expect(card().signal).toBe(signal);
  });
});

describe("createJobsProvider chat.workflow defaults", () => {
  function withWorkflow(workflow: ChatWorkflowConfig): void {
    options = { ...options, workflow };
  }
  function workflow(overrides: Partial<ChatWorkflowConfig> = {}): ChatWorkflowConfig {
    return { specFixRounds: 2, ...overrides };
  }
  async function writeSpec(): Promise<void> {
    await Bun.write(join(featureDir(options.repoRoot, "f1"), "spec.md"), "spec");
  }
  async function writePlannedProfile(routingProfile: string): Promise<void> {
    await Bun.write(
      join(featureDir(options.repoRoot, "f1"), "prd.json"),
      JSON.stringify(makePRD({ routingProfile, userStories: [makeStory({ id: "US-001", status: "pending" })] })),
    );
  }

  test("AC-10 a plan takes the configured profiles into argv", async () => {
    await writeSpec();
    _workflowDefaultsDeps.listProfileNames = async () => ["p1", "p2"];
    withWorkflow(workflow({ plan: { profiles: ["p1", "p2"] } }));
    await launch("plan");
    expect(card().command).toContain("--profile p1 --profile p2");
  });
  test("AC-11 the plan card names chat.workflow.plan as the source", async () => {
    await writeSpec();
    _workflowDefaultsDeps.listProfileNames = async () => ["p1", "p2"];
    withWorkflow(workflow({ plan: { profiles: ["p1", "p2"] } }));
    await launch("plan");
    expect(card().reason.split("\n")).toContain("profiles p1, p2 (chat.workflow.plan)");
  });
  test("AC-12 request profiles win over the configured plan list", async () => {
    await writeSpec();
    _workflowDefaultsDeps.listProfileNames = async () => ["p1", "x"];
    withWorkflow(workflow({ plan: { profiles: ["p1"] } }));
    await launch("plan", { feature: "f1", profiles: ["x"] });
    expect(card().command).toContain("--profile x");
    expect(card().command).not.toContain("--profile p1");
  });
  test("AC-13 a bot fix takes the configured model and names its source", async () => {
    _workflowDefaultsDeps.listProfileNames = async () => [];
    withWorkflow(workflow({ botFix: { model: "openai-codex/gpt-6.1-sol" } }));
    await launch("bot_fix", { pr: 12 });
    expect(card().reason.split("\n")).toContain("model openai-codex/gpt-6.1-sol (chat.workflow.botFix)");
  });
  test("AC-16 an unknown configured profile is an error before any card", async () => {
    await writeSpec();
    _workflowDefaultsDeps.listProfileNames = async () => ["alpha", "beta"];
    withWorkflow(workflow({ plan: { profiles: ["ghost"] } }));
    expect(await launch("plan")).toEqual({
      isError: true,
      content: "[chat] chat.workflow.plan.profiles names unknown profile ghost; known: alpha, beta",
    });
  });
  test("AC-17 an unknown configured profile never reaches approval", async () => {
    await writeSpec();
    _workflowDefaultsDeps.listProfileNames = async () => ["alpha"];
    withWorkflow(workflow({ plan: { profiles: ["ghost"] } }));
    await launch("plan");
    expect(approve).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
  test("a missing spec is reported before the unknown configured profile", async () => {
    const listProfileNames = mock(async () => ["alpha"]);
    _workflowDefaultsDeps.listProfileNames = listProfileNames;
    withWorkflow(workflow({ plan: { profiles: ["ghost"] } }));
    const result = await launch("plan");
    expect(result.isError).toBe(true);
    expect(result.content).toStartWith("[chat] no spec for f1; looked for ");
    expect(listProfileNames).not.toHaveBeenCalled();
  });
  test("AC-18 a run with no workflow keeps the PRD's planned profile line", async () => {
    await writePlannedProfile("a+b");
    await launch();
    expect(card().reason.split("\n")[2]).toBe("profiles (none); the run uses the PRD's planned profile a+b");
    expect(card().command).not.toContain("--profile");
  });
  test("configured run profiles that differ from the plan warn on the card", async () => {
    await writePlannedProfile("a+b");
    _workflowDefaultsDeps.listProfileNames = async () => ["c"];
    withWorkflow(workflow({ run: { profiles: ["c"] } }));
    await launch();
    expect(card().reason).toContain("warning: the PRD was planned with profile a+b, not c");
    expect(card().command).toContain("--profile c");
  });
});
/**
 * US-002: a publish launch at a HEAD the feature already published would do nothing —
 * `runInContext` skips `--publish-only` there — so the launch is refused before its card.
 */
describe("createJobsProvider US-002 publish refusal", () => {
  const refusal =
    "[chat] f1 is already published at HEAD abcdef0 as a draft PR https://x/pull/7; nothing to publish: use nax-jobs__bot_review for its open items";

  async function allPassedPrd(): Promise<void> {
    await Bun.write(
      join(featureDir(options.repoRoot, "f1"), "prd.json"),
      JSON.stringify(makePRD({ userStories: [makeStory({ id: "US-001", status: "passed", passes: true })] })),
    );
  }
  function record(over: Partial<WorkflowFeatureRecord>): WorkflowFeatureRecord {
    return { ...newFeatureRecord({ now: "2026-10-01T00:00:00Z", seed: null, minors: [] }), ...over };
  }
  const published = record({
    step: "done",
    head: "abcdef0123",
    outcome: "draft",
    url: "https://x/pull/7",
    ci: "green",
    reasons: [],
  });

  test("AC-10 a published draft at HEAD refuses before any card", async () => {
    await allPassedPrd();
    _jobsLaunchDeps.loadPriorFeature = mock(async () => locatedPrior(published));
    _jobsLaunchDeps.headSha = mock(async () => "abcdef0123");
    expect(await launch("publish", { feature: "f1" })).toEqual({ isError: true, content: refusal });
    expect(approve).not.toHaveBeenCalled();
    expect(_jobsLaunchDeps.loadPriorFeature).toHaveBeenCalledWith(workflowFeatureDir(options.repoRoot, "f1"), "");
  });

  test("AC-11 the refusal names no URL when the record has none", async () => {
    await allPassedPrd();
    _jobsLaunchDeps.loadPriorFeature = mock(async () => locatedPrior({ ...published, url: undefined }));
    _jobsLaunchDeps.headSha = mock(async () => "abcdef0123");
    expect(await launch("publish", { feature: "f1" })).toEqual({
      isError: true,
      content:
        "[chat] f1 is already published at HEAD abcdef0 as a draft PR; nothing to publish: use nax-jobs__bot_review for its open items",
    });
  });

  test("AC-12 an unreadable HEAD does not refuse", async () => {
    await allPassedPrd();
    _jobsLaunchDeps.loadPriorFeature = mock(async () => locatedPrior(published));
    _jobsLaunchDeps.headSha = mock(async () => null);
    await launch("publish", { feature: "f1" });
    expect(card().summary).toBe("nax run f1 --publish-only");
    expect(_jobsLaunchDeps.headSha).toHaveBeenCalledWith(options.repoRoot);
  });

  test("AC-13 an unreadable prior record does not refuse", async () => {
    await allPassedPrd();
    _jobsLaunchDeps.loadPriorFeature = mock(async () => {
      throw new Error("unreadable record");
    });
    _jobsLaunchDeps.headSha = mock(async () => "abcdef0123");
    await launch("publish", { feature: "f1" });
    expect(card().summary).toBe("nax run f1 --publish-only");
    expect(_jobsLaunchDeps.loadPriorFeature).toHaveBeenCalled();
    expect(_jobsLaunchDeps.headSha).toHaveBeenCalled();
  });

  test("AC-13 a rejected HEAD read does not refuse", async () => {
    await allPassedPrd();
    _jobsLaunchDeps.loadPriorFeature = mock(async () => locatedPrior(published));
    _jobsLaunchDeps.headSha = mock(async () => {
      throw new Error("git failed");
    });
    await launch("publish", { feature: "f1" });
    expect(card().summary).toBe("nax run f1 --publish-only");
    expect(_jobsLaunchDeps.headSha).toHaveBeenCalled();
  });

  test("AC-20 no prior record still reaches the publish card", async () => {
    await allPassedPrd();
    _jobsLaunchDeps.loadPriorFeature = mock(async () => null);
    _jobsLaunchDeps.headSha = mock(async () => "abcdef0123");
    await launch("publish", { feature: "f1" });
    expect(card().summary).toBe("nax run f1 --publish-only");
    expect(_jobsLaunchDeps.loadPriorFeature).toHaveBeenCalled();
  });

  test("AC-17 the real workflow-directory loader reads the feature's newest record", async () => {
    await allPassedPrd();
    await Bun.write(
      join(workflowFeatureDir(options.repoRoot, "f1"), "run-1", "result.json"),
      JSON.stringify({ schemaVersion: 1, stories: {}, featureWorkflow: published }),
    );
    _jobsLaunchDeps.loadPriorFeature = originalDeps.loadPriorFeature;
    _jobsLaunchDeps.headSha = mock(async () => "abcdef0123");
    const result = await launch("publish", { feature: "f1" });
    expect(result.isError).toBe(true);
    expect(result.content).toStartWith("[chat] f1 is already published at HEAD abcdef0");
  });
});
/**
 * US-004: a feature a chat chain handed to koda already has koda as its publisher, so the local publish
 * launch refuses it. The read sits after the pending-story guard, whose report is the more actionable one.
 */
describe("createJobsProvider US-004 handoff mark refusal", () => {
  const found: FoundHandoffMark = {
    mark: { schemaVersion: 1, at: "2026-11-18T00:00:00.000Z", flowId: "fl1", url: "https://koda/flows/fl1" },
    path: "/r/handoff.json",
  };
  const refusal =
    "f1 was handed off to koda (flow fl1 https://koda/flows/fl1) at 2026-11-18T00:00:00.000Z; koda publishes it. Delete /r/handoff.json to publish it here instead";
  const finished: WorkflowFeatureRecord = {
    ...newFeatureRecord({ now: found.mark.at, seed: null, minors: [] }),
    step: "done",
    head: "abcdef0123",
    outcome: "local-only",
  };

  async function allPassedPrd(): Promise<void> {
    await Bun.write(
      join(featureDir(options.repoRoot, "f1"), "prd.json"),
      JSON.stringify(makePRD({ userStories: [makeStory({ id: "US-001", status: "passed", passes: true })] })),
    );
  }

  test("AC-10 a marked feature is refused before any card", async () => {
    await allPassedPrd();
    const prior = locatedPrior(finished);
    _jobsLaunchDeps.loadPriorFeature = mock(async () => prior);
    _jobsLaunchDeps.readRunMark = mock(async () => found);
    expect(await launch("publish", { feature: "f1" })).toEqual({ isError: true, content: `[chat] ${refusal}` });
    expect(_jobsLaunchDeps.readRunMark).toHaveBeenCalledWith(prior.runDir);
    expect(approve).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  test.each(["story-only checkpoint", "finished run"])(
    "a newer %s supersedes the marked run only if it supplies a feature record",
    async (newer) => {
      await allPassedPrd();
      _jobsLaunchDeps.loadPriorFeature = originalDeps.loadPriorFeature;
      _jobsLaunchDeps.headSha = mock(async () => "abcdef0123");
      const dir = workflowFeatureDir(options.repoRoot, "f1");
      const marked = join(dir, "run-1");
      await upsertFeatureRecord(marked, { runId: "run-1", feature: "f1" }, finished);
      await writeHandoffMark(marked, found.mark);
      await utimes(join(marked, "result.json"), 1, 1);
      const header = { runId: "run-2", feature: "f1" };
      const runDir = join(dir, header.runId);
      await upsertStoryRecord(runDir, header, newStoryRecord("US-001", 5, found.mark.at));
      if (newer === "finished run") await upsertFeatureRecord(runDir, header, finished);

      const result = await launch("publish", { feature: "f1" });
      if (newer === "story-only checkpoint") {
        expect(result).toMatchObject({ isError: true, content: expect.stringContaining(join(marked, "handoff.json")) });
        expect(approve).not.toHaveBeenCalled();
        expect(start).not.toHaveBeenCalled();
      } else {
        expect(result.isError).not.toBe(true);
        expect(card().summary).toBe("nax run f1 --publish-only");
        expect(start).toHaveBeenCalledTimes(1);
      }
    },
  );

  test("AC-11 an unmarked feature reaches the published-at-head check and the normal card", async () => {
    await allPassedPrd();
    const prior = locatedPrior(finished);
    _jobsLaunchDeps.readRunMark = mock(async () => null);
    _jobsLaunchDeps.loadPriorFeature = mock(async () => prior);
    _jobsLaunchDeps.headSha = mock(async () => "abcdef0123");
    await launch("publish", { feature: "f1" });
    expect(_jobsLaunchDeps.headSha).toHaveBeenCalledWith(options.repoRoot);
    expect(card().summary).toBe("nax run f1 --publish-only");
  });

  test("AC-12 pending stories keep their own refusal and never read the mark", async () => {
    _jobsLaunchDeps.readRunMark = mock(async () => found);
    expect(await launch("publish", { feature: "f1" })).toEqual({
      isError: true,
      content: "[chat] f1 has 3 pending stories; finish them with nax-jobs__run first",
    });
    expect(_jobsLaunchDeps.readRunMark).not.toHaveBeenCalled();
    expect(approve).not.toHaveBeenCalled();
  });
});
