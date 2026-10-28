import { describe, expect, test } from "bun:test";
import type { ChatJob } from "@/chat/jobs/job-types";

const RUN: ChatJob = {
  schemaVersion: 1,
  id: "run-1a2b3c4d",
  kind: "run",
  target: "f1",
  argv: [],
  cwd: "/r",
  pid: 123,
  startedAt: "2026-10-27T10:00:00Z",
  state: "running",
  logPath: "/o/job.log",
  sessionId: "chat",
  approvedAt: "2026-10-27T09:59:00Z",
};

async function invoke(jobs: readonly ChatJob[], name: string) {
  const { createJobWriteGuard } = await import("@/chat/jobs/job-write-guard");
  const entry = createJobWriteGuard({ running: () => jobs }, "/r")[0];
  if (!entry) throw new Error("missing guard entry");
  return entry.handler({ call: { id: "call-1", name, input: {} }, tools: [] }, { sessionName: "chat" });
}

describe("createJobWriteGuard", () => {
  test("AC-1 registers one nax-jobs before_tool entry", async () => {
    const { createJobWriteGuard, GUARDED_WRITE_TOOLS } = await import("@/chat/jobs/job-write-guard");
    const entries = createJobWriteGuard({ running: () => [] }, "/r");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ plugin: "nax-jobs", event: "before_tool" });
    expect(GUARDED_WRITE_TOOLS).toEqual(["Write", "Edit", "Delete", "GitCommit"]);
  });
  test.each([
    [2, "Write"],
    [3, "Edit"],
    [4, "Delete"],
    [5, "GitCommit"],
  ] as const)("AC-%i blocks %s with an actionable job identity", async (_ac, name) => {
    expect(await invoke([RUN], name)).toEqual({
      kind: "block",
      isError: true,
      content: `[nax-jobs] ${name} refused: nax run job run-1a2b3c4d is running in this checkout; wait for it to end or cancel it`,
    });
  });
  test.each([
    [6, "Read"],
    [7, "Bash"],
    [0, "Git"],
    [0, "RunCommand"],
  ] as const)("AC-%i allows unguarded %s", async (_ac, name) => {
    expect(await invoke([RUN], name)).toEqual({ kind: "allow" });
  });
  test.each([
    [8, [{ ...RUN, kind: "bot_fix" as const }]],
    [9, [{ ...RUN, cwd: "/other" }]],
    [10, []],
    [0, [{ ...RUN, kind: "bot_review" as const }]],
  ] as const)("AC-%i allows Write without a competing checkout writer", async (_ac, jobs) => {
    expect(await invoke(jobs, "Write")).toEqual({ kind: "allow" });
  });
  test("AC-11 names the newest matching writer, not a newer unrelated job", async () => {
    const plan: ChatJob = { ...RUN, kind: "plan", id: "plan-11111111", startedAt: "2026-10-26T10:00:00Z" };
    const unrelated: ChatJob = { ...RUN, cwd: "/other", id: "run-22222222", startedAt: "2026-10-28T10:00:00Z" };
    expect(await invoke([plan, unrelated, RUN], "Write")).toMatchObject({
      kind: "block",
      content: expect.stringContaining("nax run job run-1a2b3c4d"),
    });
    expect(await invoke([plan], "Write")).toMatchObject({
      kind: "block",
      content: expect.stringContaining("nax plan job plan-11111111"),
    });
  });
  test("reads running jobs again for each tool call", async () => {
    const { createJobWriteGuard } = await import("@/chat/jobs/job-write-guard");
    let jobs: readonly ChatJob[] = [RUN];
    const entry = createJobWriteGuard({ running: () => jobs }, "/r")[0];
    if (!entry) throw new Error("missing guard entry");
    const payload = { call: { id: "call-1", name: "Write", input: {} }, tools: [] };
    expect(await entry.handler(payload, { sessionName: "chat" })).toMatchObject({ kind: "block" });
    jobs = [];
    expect(await entry.handler(payload, { sessionName: "chat" })).toEqual({ kind: "allow" });
    expect(
      await entry.handler(
        { prompt: "hello", history: [], sessionName: "chat", boundary: false },
        { sessionName: "chat" },
      ),
    ).toEqual({ kind: "allow" });
  });
});
