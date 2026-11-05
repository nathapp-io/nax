import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { assertDefined, cleanupTempDir, makePRD, makeTempDir } from "@test/helpers";
import type { ChatJobs, StartJobRequest } from "@/chat/jobs/job-runner";
import type { ChatJob } from "@/chat/jobs/job-types";
import { _jobsLaunchDeps } from "@/chat/jobs/jobs-launch";
import { createJobsProvider, type JobsProviderOptions } from "@/chat/jobs/jobs-provider";
import { featureDir } from "@/config";

const original = { ..._jobsLaunchDeps };
let options: JobsProviderOptions;
let nested: string;
let running: ChatJob[];
let start: ReturnType<typeof mock<ChatJobs["start"]>>;
let approve: ReturnType<typeof mock<JobsProviderOptions["approve"]>>;
let lockRoots: string[];
let existsPaths: string[];

function runJob(cwd: string): ChatJob {
  return {
    schemaVersion: 1,
    id: "run-00000002",
    kind: "run",
    target: "f1",
    cwd,
    pid: 123,
    argv: [],
    startedAt: "2026-10-01T00:00:00.000Z",
    state: "running",
    logPath: "job.log",
    sessionId: "chat-1",
    approvedAt: "2026-10-01T00:00:00.000Z",
  };
}

beforeEach(async () => {
  running = [];
  lockRoots = [];
  existsPaths = [];
  approve = mock(async () => "allow");
  start = mock(async (_request: StartJobRequest) => runJob(options.repoRoot));
  const root = realpathSync(makeTempDir("jobs-launch-nested-"));
  nested = join(root, "repos", "nax");
  mkdirSync(join(nested, ".nax"), { recursive: true });
  mkdirSync(join(root, "plain"), { recursive: true });
  options = {
    repoRoot: root,
    naxEntry: ["bun", "/n.ts"],
    maxIterations: 20,
    interactionPlugin: "cli",
    approve,
    now: () => new Date("2026-10-01T00:00:00Z"),
    sessionId: () => "chat-1",
    jobs: {
      start,
      running: () => running,
      list: () => [],
      owned: () => [],
      get: () => undefined,
      cancel: async () => runJob(root),
      canCancel: async () => ({ ok: true }),
      attach: async () => {},
      logTail: async () => "",
      peekNotice: () => undefined,
      takeNotice: () => undefined,
      onChange: () => () => {},
      dispose: () => {},
    },
  };
  _jobsLaunchDeps.git = mock(async () => ({ exitCode: 0, stdout: "main", stderr: "" }));
  _jobsLaunchDeps.lockHolder = mock(async (r: string) => {
    lockRoots.push(r);
    return null;
  });
  const exists = _jobsLaunchDeps.exists;
  _jobsLaunchDeps.exists = mock(async (p: string) => {
    existsPaths.push(p);
    return exists(p);
  });
  for (const dir of [root, nested]) {
    await Bun.write(join(featureDir(dir, "f1"), "prd.json"), JSON.stringify(makePRD()));
    await Bun.write(join(featureDir(dir, "f1"), "spec.md"), "spec");
  }
});
afterEach(() => {
  Object.assign(_jobsLaunchDeps, original);
  cleanupTempDir(options.repoRoot);
});

async function launch(kind: string, input: Record<string, unknown>) {
  const tool = (await createJobsProvider(options).tools(options.repoRoot)).find((t) => t.localName === kind);
  assertDefined(tool, "launch tool");
  return tool.run(input, {
    root: options.repoRoot,
    resolvedPaths: [],
    maxBytes: 300_000,
    maxFileBytes: 300_000,
    signal: new AbortController().signal,
  });
}

describe("launch tools with repo", () => {
  test.each(["plan", "run", "bot_review", "bot_fix"])("AC-1 %s schema has repo", async (kind) => {
    const tool = (await createJobsProvider(options).tools(options.repoRoot)).find((t) => t.localName === kind);
    assertDefined(tool, "tool");
    const schema = tool.inputSchema as { properties: Record<string, unknown>; required: string[] };
    expect(schema.properties.repo).toEqual({ type: "string" });
    expect(schema.required).toEqual([kind === "plan" || kind === "run" ? "feature" : "pr"]);
  });

  test("AC-2,3 card shows nested root and start gets the same argv and cwd", async () => {
    await launch("run", { feature: "f1", repo: "repos/nax" });
    const card = approve.mock.calls[0]?.[0];
    assertDefined(card, "card");
    expect(card.command).toContain(`-d ${nested}`);
    expect(card.reason.startsWith(`workdir ${nested}`)).toBe(true);
    const req = start.mock.calls[0]?.[0];
    assertDefined(req, "start request");
    expect(req.cwd).toBe(nested);
    expect(card.command).toBe(req.argv.join(" "));
  });

  test("AC-4 without repo passes the chat root as cwd and -d", async () => {
    await launch("run", { feature: "f1" });
    const req = start.mock.calls[0]?.[0];
    expect(req?.cwd).toBe(options.repoRoot);
    expect(req?.argv).toContain(options.repoRoot);
  });

  test("AC-5 plan reads the spec from the nested root", async () => {
    await launch("plan", { feature: "f1", repo: "repos/nax" });
    expect(existsPaths).toContain(join(featureDir(nested, "f1"), "spec.md"));
    expect(start.mock.calls[0]?.[0].argv).toContain(".nax/features/f1/spec.md");
  });

  test("AC-6 a non-nax folder errors with no card", async () => {
    expect(await launch("run", { feature: "f1", repo: "plain" })).toEqual({
      isError: true,
      content: "[chat] repo plain is not a nax project: no .nax directory",
    });
    expect(approve).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  test("AC-7 a job in the chat root does not make the nested repo busy", async () => {
    running = [runJob(options.repoRoot)];
    const result = await launch("run", { feature: "f1", repo: "repos/nax" });
    expect(result.isError).not.toBe(true);
    expect(start).toHaveBeenCalledTimes(1);
  });

  test("AC-8 a job in the nested root makes the nested repo busy", async () => {
    running = [runJob(nested)];
    const result = await launch("run", { feature: "f1", repo: "repos/nax" });
    expect(result).toMatchObject({ isError: true });
    expect(result.content).toContain("already running");
    expect(approve).not.toHaveBeenCalled();
  });

  test("AC-9 the lock is read from the nested root", async () => {
    await launch("run", { feature: "f1", repo: "repos/nax" });
    expect(lockRoots.length).toBeGreaterThan(0);
    expect(new Set(lockRoots)).toEqual(new Set([nested]));
  });

  test.each([
    [5, "[chat] repo must be a non-empty string"],
    ["missing", "[chat] repo missing does not exist"],
    ["..", "[chat] repo .. is outside"],
    ["", "[chat] repo must be a non-empty string"],
    ["link", "[chat] repo link is outside"],
    ["plain", "[chat] repo plain is not a nax project: no .nax directory"],
  ])("AC-20 repo %p is rejected with no side effects", async (repo, message) => {
    const outside = realpathSync(makeTempDir("jobs-launch-outside-"));
    symlinkSync(outside, join(options.repoRoot, "link"));
    try {
      for (const kind of ["plan", "run", "bot_review", "bot_fix"]) {
        const result = await launch(kind, { feature: "f1", pr: 1, repo });
        expect(result.isError).toBe(true);
        expect(result.content.startsWith(message)).toBe(true);
      }
      expect(approve).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
      expect(existsPaths).toEqual([]);
      expect(lockRoots).toEqual([]);
    } finally {
      cleanupTempDir(outside);
    }
  });
});
