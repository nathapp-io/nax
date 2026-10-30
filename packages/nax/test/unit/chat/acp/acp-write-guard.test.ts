/** US-010 AC-1..AC-10: the ACP write guard's refusal text, tool kinds, job selection and model gating. */
import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@nathapp/nax-agent";
import { ACP_WRITE_KINDS, acpRefusal, acpWriteRefusal } from "@/chat/acp/acp-write-guard";
import type { ChatJob } from "@/chat/jobs/job-types";

type Approval = Extract<SessionEvent, { type: "approval_requested" }>;

const RUN: ChatJob = {
  schemaVersion: 1,
  id: "j1",
  kind: "run",
  target: "f1",
  argv: [],
  cwd: "/repo",
  pid: 123,
  startedAt: "2026-10-27T10:00:00Z",
  state: "running",
  logPath: "/o/job.log",
  sessionId: "chat",
  approvedAt: "2026-10-27T09:59:00Z",
};

function approval(tool: string): Approval {
  return {
    type: "approval_requested",
    sessionId: "s1",
    turnId: "t1",
    at: "2026-10-27T10:00:00Z",
    metadata: {},
    requestId: "r1",
    tool,
    summary: "edit a file",
    reason: "Approval required",
    expiresAt: "2026-10-27T11:00:00Z",
  };
}

const running = (...jobs: ChatJob[]) => ({ running: () => jobs });

describe("acpWriteRefusal", () => {
  test("AC-1 names the running job in the refusal for an edit", () => {
    expect(acpWriteRefusal(running(RUN), "/repo", approval("edit"))).toBe(
      "[nax-jobs] edit refused: nax run job j1 is running in this checkout; wait for it to end or cancel it",
    );
  });
  test("exports the guarded kinds", () => {
    expect(ACP_WRITE_KINDS).toEqual(["edit", "delete", "move"]);
  });
  test.each([
    ["AC-2", "delete"],
    ["AC-3", "move"],
  ])("%s refuses a %s", (_ac, tool) => {
    expect(acpWriteRefusal(running(RUN), "/repo", approval(tool))).toContain(`${tool} refused`);
  });
  test.each([
    ["AC-4", "execute"],
    ["AC-5", "other"],
  ])("%s does not refuse %s", (_ac, tool) => {
    expect(acpWriteRefusal(running(RUN), "/repo", approval(tool))).toBeUndefined();
  });
  test("AC-6 ignores a job running in another checkout", () => {
    expect(acpWriteRefusal(running({ ...RUN, cwd: "/other" }), "/repo", approval("edit"))).toBeUndefined();
  });
  test("AC-7 ignores a bot_review job", () => {
    expect(acpWriteRefusal(running({ ...RUN, kind: "bot_review" }), "/repo", approval("edit"))).toBeUndefined();
  });
  test("ignores a bot_fix job and no job at all", () => {
    expect(acpWriteRefusal(running({ ...RUN, kind: "bot_fix" }), "/repo", approval("edit"))).toBeUndefined();
    expect(acpWriteRefusal(running(), "/repo", approval("edit"))).toBeUndefined();
  });
  test("AC-8 names the plan/run job with the latest startedAt", () => {
    const older: ChatJob = { ...RUN, id: "j-old", kind: "plan", startedAt: "2026-10-26T10:00:00Z" };
    const newer: ChatJob = { ...RUN, id: "j-new", startedAt: "2026-10-28T10:00:00Z" };
    const unrelated: ChatJob = { ...RUN, id: "j-x", cwd: "/other", startedAt: "2026-10-29T10:00:00Z" };
    expect(acpWriteRefusal(running(older, newer, unrelated), "/repo", approval("edit"))).toContain("nax run job j-new");
    expect(acpWriteRefusal(running(newer, older, unrelated), "/repo", approval("edit"))).toContain("nax run job j-new");
  });
});

describe("acpRefusal", () => {
  test("refuses an edit on an ACP model under a running job", () => {
    const refuse = acpRefusal({ jobs: () => running(RUN), repoRoot: "/repo", model: () => "acp:codex" });
    expect(refuse(approval("edit"))).toContain("nax run job j1");
  });
  test("AC-9 does not refuse on a native model", () => {
    const refuse = acpRefusal({ jobs: () => running(RUN), repoRoot: "/repo", model: () => "openai/gpt-6" });
    expect(refuse(approval("edit"))).toBeUndefined();
  });
  test("AC-10 does not refuse when no jobs exist", () => {
    const refuse = acpRefusal({ jobs: () => undefined, repoRoot: "/repo", model: () => "acp:codex" });
    expect(refuse(approval("edit"))).toBeUndefined();
  });
  test("reads the model and jobs lazily on every call", () => {
    let model = "openai/gpt-6";
    let jobs: ReturnType<typeof running> | undefined;
    const refuse = acpRefusal({ jobs: () => jobs, repoRoot: "/repo", model: () => model });
    expect(refuse(approval("edit"))).toBeUndefined();
    model = "acp:claude";
    expect(refuse(approval("edit"))).toBeUndefined();
    jobs = running(RUN);
    expect(refuse(approval("edit"))).toContain("j1");
  });
});
