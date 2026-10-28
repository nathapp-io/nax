import { beforeEach, describe, expect, mock, test } from "bun:test";
import { assertDefined } from "@test/helpers";
import type { ChatJobs } from "@/chat/jobs/job-runner";
import { JOB_LOG_TAIL_LINES } from "@/chat/jobs/job-runner";
import type { ChatJob } from "@/chat/jobs/job-types";
import * as providerModule from "@/chat/jobs/jobs-provider";
import { createJobsProvider, type JobsProviderOptions } from "@/chat/jobs/jobs-provider";
import { buildJobsInstructions } from "@/prompts";

const repoRoot = "/fixture/repo";
const signal = new AbortController().signal;
function record(overrides: Partial<ChatJob> = {}): ChatJob {
  return {
    schemaVersion: 1,
    id: "run-1a2b3c4d",
    kind: "run",
    target: "f1",
    state: "running",
    startedAt: "2026-10-01T00:00:00.000Z",
    cwd: repoRoot,
    pid: 123,
    argv: ["nax", "run"],
    logPath: "/fixture/job.log",
    sessionId: "chat-1",
    approvedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}
let records: ChatJob[];
let options: JobsProviderOptions;
let approve: ReturnType<typeof mock<JobsProviderOptions["approve"]>>;
let cancel: ReturnType<typeof mock<ChatJobs["cancel"]>>;
let canCancel: ReturnType<typeof mock<ChatJobs["canCancel"]>>;
let logTail: ReturnType<typeof mock<ChatJobs["logTail"]>>;
beforeEach(() => {
  records = [record()];
  approve = mock(async () => "allow");
  cancel = mock(async () => record());
  canCancel = mock(async () => ({ ok: true }));
  logTail = mock(async () => "last log line");
  const jobs: ChatJobs = {
    start: mock(async () => record()),
    list: () => records,
    get: (id) => records.find((job) => job.id === id),
    running: () => records,
    owned: () => records,
    cancel,
    canCancel,
    logTail,
    attach: async () => {},
    dispose: () => {},
    onChange: () => () => {},
    peekNotice: () => undefined,
    takeNotice: () => undefined,
  };
  options = {
    repoRoot,
    naxEntry: ["nax"],
    maxIterations: 20,
    interactionPlugin: "cli",
    jobs,
    approve,
    sessionId: () => "chat-1",
    now: () => new Date("2026-10-01T00:00:00Z"),
  };
});
async function invoke(name: string, input: Record<string, unknown>) {
  const tool = (await createJobsProvider(options).tools(repoRoot)).find((t) => t.localName === name);
  assertDefined(tool, `tool ${name}`);
  return tool.run(input, { root: repoRoot, resolvedPaths: [], maxBytes: 300_000, maxFileBytes: 300_000, signal });
}
describe("createJobsProvider", () => {
  test("AC-1–5 provider metadata, final tools and launch contracts", async () => {
    const provider = createJobsProvider(options);
    expect(provider.id).toBe("nax-jobs");
    expect(provider.kind).toBe("static");
    expect(provider.stages).toEqual(["*"]);
    const tools = await provider.tools(repoRoot);
    expect(tools.map((t) => t.localName)).toEqual(["plan", "run", "bot_review", "bot_fix", "list", "cancel"]);
    expect(tools.find((t) => t.localName === "run")?.inputSchema.required).toEqual(["feature"]);
    for (const tool of tools.slice(0, 4)) {
      expect(tool.description).toContain("Billed");
      expect(tool.description).toContain("asks the user");
    }
  });
  test.each(["list", "cancel"])("%s schema is closed", async (name) => {
    const tool = (await createJobsProvider(options).tools(repoRoot)).find((t) => t.localName === name);
    assertDefined(tool, name);
    expect(tool.inputSchema).toEqual({
      type: "object",
      properties: { job: { type: "string" } },
      additionalProperties: false,
      required: name === "cancel" ? ["job"] : [],
    });
  });
  test("AC-6–9 bounds and projects newest-first listing", async () => {
    records = Array.from({ length: 25 }, (_, n) =>
      record({
        id: `run-${n.toString(16).padStart(8, "0")}`,
        startedAt: new Date(Date.UTC(2026, 9, n + 1)).toISOString(),
      }),
    ).reverse();
    const result = JSON.parse((await invoke("list", {})).content);
    expect(result.jobs).toHaveLength(20);
    expect(result.omitted).toBe(5);
    expect(result.jobs[0].id).toBe(records[0]?.id);
    for (const job of result.jobs) {
      expect(Object.keys(job).sort()).toEqual(["id", "kind", "startedAt", "state", "target"]);
      expect(job).not.toHaveProperty("endedAt");
    }
    expect(providerModule).toHaveProperty("JOBS_LIST_LIMIT", 20);
  });
  test("list retains optional summary fields including zero cost", async () => {
    records = [record({ endedAt: "end", progress: { passed: 0, total: 3 }, cost: 0, note: "note" })];
    expect(JSON.parse((await invoke("list", {})).content).jobs[0]).toEqual({
      id: records[0]?.id,
      kind: "run",
      target: "f1",
      state: "running",
      startedAt: records[0]?.startedAt,
      endedAt: "end",
      progress: { passed: 0, total: 3 },
      cost: 0,
      note: "note",
    });
  });
  test("AC-10 detail includes full record and bounded log tail", async () => {
    expect(JSON.parse((await invoke("list", { job: "run-1a2b3c4d" })).content)).toEqual({
      ...record(),
      logTail: "last log line",
    });
    expect(logTail).toHaveBeenCalledWith("run-1a2b3c4d", JOB_LOG_TAIL_LINES);
  });
  test("missing log is an empty tail", async () => {
    logTail.mockResolvedValue("");
    expect(JSON.parse((await invoke("list", { job: "run-1a2b3c4d" })).content).logTail).toBe("");
  });
  test.each([
    ["AC-11", "list", "x/../y", "invalid job id x/../y"],
    ["AC-12", "list", "run-ffffffff", "unknown job run-ffffffff"],
    ["AC-20", "cancel", "run-ffffffff", "unknown job run-ffffffff"],
    ["AC-21", "cancel", "nope", "invalid job id nope"],
  ])("%s rejects %s job %s", async (_ac, tool, job, message) => {
    expect(await invoke(tool, { job })).toEqual({ isError: true, content: `[chat] ${message}` });
    expect(approve).not.toHaveBeenCalled();
    expect(canCancel).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(logTail).not.toHaveBeenCalled();
  });
  test("AC-13–15 preflights then approves cancellation with signal", async () => {
    canCancel.mockImplementation(async () => {
      expect(approve).not.toHaveBeenCalled();
      return { ok: true };
    });
    expect(await invoke("cancel", { job: "run-1a2b3c4d" })).toEqual({
      content: "cancel requested for job run-1a2b3c4d; SIGINT sent",
    });
    expect(canCancel).toHaveBeenCalledWith("run-1a2b3c4d");
    expect(approve).toHaveBeenCalledWith({
      tool: "nax-jobs__cancel",
      summary: "cancel nax run f1 (run-1a2b3c4d)",
      reason: "Cancelling stops the job; paid work it has done is not refunded.",
      signal,
    });
    expect(cancel).toHaveBeenCalledWith("run-1a2b3c4d");
  });
  test("AC-16–17 denial never cancels", async () => {
    approve.mockResolvedValue("deny");
    expect(await invoke("cancel", { job: "run-1a2b3c4d" })).toEqual({
      isError: true,
      content: "[chat] the user declined to cancel job run-1a2b3c4d",
    });
    expect(cancel).not.toHaveBeenCalled();
  });
  test.each([
    ["AC-18", record({ state: "failed" }), "job run-1a2b3c4d is not running (state failed)"],
    [
      "AC-19",
      record({ id: "bot_fix-1a2b3c4d", kind: "bot_fix" }),
      "job bot_fix-1a2b3c4d was started by another chat and its pid cannot be verified; stop it from that chat or by hand",
    ],
  ])("%s preflight failure never asks or cancels", async (_ac, job, message) => {
    records = [job];
    canCancel.mockResolvedValue({ ok: false, message });
    expect(await invoke("cancel", { job: job.id })).toEqual({ isError: true, content: `[chat] ${message}` });
    expect(canCancel).toHaveBeenCalledWith(job.id);
    expect(approve).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });
  test("AC-22 supplies canonical instructions", async () => {
    expect(await createJobsProvider(options).instructions?.(repoRoot)).toBe(buildJobsInstructions());
  });
});
