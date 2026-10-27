import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { assertDefined, cleanupTempDir, makePRD, makeStory, makeTempDir } from "@test/helpers";
import type { HostApprovalCard } from "@/chat/ask-controller";
import type { ChatJobs, StartJobRequest } from "@/chat/jobs/job-runner";
import { _jobsLaunchDeps } from "@/chat/jobs/jobs-launch";
import { createJobsProvider, type JobsProviderOptions } from "@/chat/jobs/jobs-provider";
import { featureDir } from "@/config";

const originalDeps = { ..._jobsLaunchDeps };
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
    maxIterations: 20,
    interactionPlugin: "cli",
    jobs,
    approve,
    sessionId: () => "chat-1",
    now: () => new Date("2026-10-01T00:00:00Z"),
  };
  _jobsLaunchDeps.git = mock(async () => ({ exitCode: 0, stdout: "feat/f1\n", stderr: "" }));
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
  test.each([
    ["plan", { feature: { type: "string" }, spec: { type: "string" } }, "feature"],
    [
      "run",
      { feature: { type: "string" }, maxIterations: { type: "integer" }, maxCost: { type: "number" } },
      "feature",
    ],
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
      properties: { ...properties, profiles: { type: "array", items: { type: "string" } } },
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
  test("AC-1 exactly four launch tools and static metadata", async () => {
    const provider = createJobsProvider(options);
    expect((await provider.tools(options.repoRoot)).slice(0, 4).map((t) => t.localName)).toEqual([
      "plan",
      "run",
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
  test("AC-10 counts pending stories and uses resolved limit", async () => {
    await launch();
    expect(card().reason).toContain("stories 3 pending of 3; max iterations 20");
  });
  test("AC-11 input limit warns on pending overflow", async () => {
    await launch("run", { feature: "f1", maxIterations: 2 });
    expect(card().reason).toContain(
      "warning: 3 stories pending but max iterations is 2; pass maxIterations (nax#2706)",
    );
  });
  test("AC-12 cli warns about unanswerable asks", async () => {
    await launch();
    expect(card().reason).toContain("warning: this run has no channel for its own asks; they will time out");
  });
  test("AC-13 telegram has no channel warning", async () => {
    options = { ...options, interactionPlugin: "telegram" };
    await launch();
    expect(card().reason).not.toContain("no channel");
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
