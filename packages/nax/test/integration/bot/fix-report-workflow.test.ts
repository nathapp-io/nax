import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { makeBotFixDraftEnv, makeNaxConfig } from "@test/helpers";
import { _fixReportDeps, readyStep } from "@/bot/fix-report";
import type { BotFixState } from "@/bot/fix-steps";
import type { RecordRulingsOutcome } from "@/bot/rulings";
import { NAX_WORKFLOW_PR_MARKER, type PrComment, withNaxBotMarker } from "@/forge";
import { botRulingReadOp } from "@/operations";
import { evidenceComment, markReadyArgv } from "@/workflow/promote";
import { _workflowDeps } from "@/workflow/step-context";

const state: BotFixState = { step: "ready", timings: {}, outcome: "nothing" };
const green = { outcome: "green", detail: "passed" } as const;
const empty: RecordRulingsOutcome = { index: { keys: [] }, recorded: [], settled: [], open: [], asked: 0, failed: 0 };
const item = {
  key: "w-B3.12345678",
  itemId: "B3",
  kind: "ruling",
  thread: { id: "1", replyTo: "1", resolved: false, outdated: false, comments: [] },
  replies: [],
};
const complete: RecordRulingsOutcome = {
  ...empty,
  index: { keys: [item.key] },
  settled: [
    {
      ...item,
      ruling: {
        itemKey: item.key,
        itemId: item.itemId,
        disposition: "fixed",
        reason: "done",
        sha: "abcdef12",
        by: "writer",
      },
    },
  ],
};
const evidence = withNaxBotMarker(
  evidenceComment([{ id: "B3", kind: "advisor", disposition: "fixed", reason: "done", sha: "abcdef12" }]),
  "w-evidence",
);
const comment: PrComment = { id: "7", kind: "comment", author: "bot", body: evidence, createdAt: "" };
afterEach(() => mock.restore());

function setup(outcome: RecordRulingsOutcome = complete, comments: PrComment[] = []) {
  const env = makeBotFixDraftEnv({ body: NAX_WORKFLOW_PR_MARKER });
  const fresh = { ...env.info, headSha: env.info.headSha, body: `${NAX_WORKFLOW_PR_MARKER}\n- [x] **B3**` };
  const order: string[] = [];
  const read = spyOn(_fixReportDeps, "readPrInfo").mockResolvedValue(fresh);
  const user = spyOn(_fixReportDeps, "readCurrentUser").mockResolvedValue(env.user);
  const threads = [item.thread];
  const list = spyOn(_fixReportDeps, "listReviewThreads").mockResolvedValue(threads);
  const notes = spyOn(_fixReportDeps, "listPrComments").mockResolvedValue(comments);
  const record = spyOn(_fixReportDeps, "recordPrRulings").mockResolvedValue(outcome);
  const wait = spyOn(_fixReportDeps, "waitForChecks").mockImplementation(async () => {
    order.push("ci");
    return green;
  });
  const post = spyOn(_fixReportDeps, "postPrComment").mockImplementation(async () => {
    order.push("post");
    return { id: "new" };
  });
  const edit = spyOn(_fixReportDeps, "editComment").mockImplementation(async () => {
    order.push("edit");
  });
  const run = spyOn(env.forge, "run").mockImplementation(async () => {
    order.push("ready");
    return { exitCode: 0, stdout: "", stderr: "" };
  });
  return { env, fresh, order, read, user, list, notes, threads, record, wait, post, edit, run };
}

describe("readyStep workflow drafts", () => {
  test("concurrent push before readiness cannot switch the execution head", async () => {
    const s = setup();
    s.read.mockResolvedValue({ ...s.fresh, headSha: "concurrent" });
    const out = await readyStep(s.env, { ...state, pushedSha: "pushed" });
    expect(out.patch).toEqual({ markedReady: false, readyHeld: "PR head changed since this execution" });
    expect(s.wait).not.toHaveBeenCalled();
    expect(s.run).not.toHaveBeenCalled();
  });
  test("head changes during CI hold promotion and CI stays pinned to pushed head", async () => {
    const s = setup();
    s.read
      .mockResolvedValueOnce({ ...s.fresh, headSha: "pushed" })
      .mockResolvedValue({ ...s.fresh, headSha: "concurrent" });
    const out = await readyStep(s.env, { ...state, pushedSha: "pushed" });
    expect(s.wait.mock.calls[0]?.[2]?.expectedSha).toBe("pushed");
    expect(out.patch.markedReady).toBe(false);
    expect(s.run).not.toHaveBeenCalled();
  });
  test("a collaborator reopening an item during CI holds readiness without stale evidence", async () => {
    const s = setup();
    s.wait.mockImplementation(async () => {
      s.record.mockResolvedValue({ ...complete, settled: [], open: [{ ...item, kept: [] }] });
      return green;
    });
    expect((await readyStep(s.env, state)).patch).toEqual({
      markedReady: false,
      readyHeld: "1 open item(s): B3",
    });
    expect(s.list).toHaveBeenCalledTimes(2);
    expect(s.notes).toHaveBeenCalledTimes(2);
    expect(s.post).not.toHaveBeenCalled();
    expect(s.edit).not.toHaveBeenCalled();
    expect(s.run).not.toHaveBeenCalled();
  });
  test("evidence uses the rulings and own comments refreshed after CI", async () => {
    const s = setup();
    const refreshed = {
      ...complete,
      settled: complete.settled.map((entry) => ({
        ...entry,
        ruling: { ...entry.ruling, reason: "rechecked after CI" },
      })),
    };
    s.wait.mockImplementation(async () => {
      s.record.mockResolvedValue(refreshed);
      s.notes.mockResolvedValue([comment]);
      return green;
    });
    expect((await readyStep(s.env, state)).patch.markedReady).toBe(true);
    expect(s.record).toHaveBeenCalledTimes(2);
    expect(s.post).not.toHaveBeenCalled();
    expect(s.edit).toHaveBeenCalledWith(
      s.env.ref,
      comment,
      withNaxBotMarker(
        evidenceComment([
          { id: "B3", kind: "advisor", disposition: "fixed", reason: "rechecked after CI", sha: "abcdef12" },
        ]),
        "w-evidence",
      ),
      s.env.forge,
      s.env.repoRoot,
    );
  });
  test("AC-8 fresh PR, user, threads and comments feed recording", async () => {
    const s = setup();
    await readyStep(s.env, state);
    for (const read of [s.read, s.user, s.list, s.notes])
      expect(read).toHaveBeenCalledWith(s.env.ref, s.env.forge, s.env.repoRoot);
    expect(s.record).toHaveBeenCalledWith({
      ref: s.env.ref,
      info: s.fresh,
      login: s.env.user.login,
      threads: s.threads,
      comments: [],
      deps: s.env.forge,
      cwd: s.env.repoRoot,
      readModel: expect.any(Function),
    });
    expect(s.wait.mock.calls[0]?.[2]?.expectedSha).toBe(s.fresh.headSha);
  });
  test("AC-9 open item blocks CI even with body ticked", async () => {
    const s = setup({ ...empty, index: { keys: [item.key] }, open: [{ ...item, kept: [] }] });
    expect((await readyStep(s.env, state)).patch).toEqual({ markedReady: false, readyHeld: "1 open item(s): B3" });
    expect(s.wait).not.toHaveBeenCalled();
    expect(s.run).not.toHaveBeenCalled();
  });
  test("incomplete publication holds even when all indexed items are settled", async () => {
    const s = setup({ ...complete, unindexed: ["w-new.12345678"] });
    expect((await readyStep(s.env, state)).patch).toEqual({
      markedReady: false,
      readyHeld: "incomplete item publication: 1 unindexed item(s)",
    });
    expect(s.wait).not.toHaveBeenCalled();
    expect(s.post).not.toHaveBeenCalled();
    expect(s.run).not.toHaveBeenCalled();
  });
  test("AC-10 settled items wait, post exact evidence then ready", async () => {
    const s = setup();
    expect((await readyStep(s.env, state)).patch).toEqual({ markedReady: true });
    expect(s.order).toEqual(["ci", "post", "ready"]);
    expect(s.post).toHaveBeenCalledWith(s.env.ref, evidence, s.env.forge, s.env.repoRoot);
    expect(s.run).toHaveBeenCalledWith(markReadyArgv(s.env.ref.forge, String(s.env.ref.number)), {
      cwd: s.env.repoRoot,
    });
  });
  test("AC-11 retry edits existing own evidence, never duplicates", async () => {
    const s = setup(complete, [comment]);
    await readyStep(s.env, state);
    await readyStep(s.env, state);
    expect(s.edit).toHaveBeenCalledTimes(2);
    expect(s.edit).toHaveBeenCalledWith(s.env.ref, comment, evidence, s.env.forge, s.env.repoRoot);
    expect(s.post).not.toHaveBeenCalled();
  });
  test("AC-12 empty index readies without evidence", async () => {
    const s = setup(empty);
    expect((await readyStep(s.env, state)).patch.markedReady).toBe(true);
    expect(s.post).not.toHaveBeenCalled();
    expect(s.edit).not.toHaveBeenCalled();
  });
  test.each(["post", "edit"] as const)("AC-13 evidence %s failure holds", async (write) => {
    const s = setup(complete, write === "edit" ? [comment] : []);
    s[write].mockRejectedValue(new Error("denied"));
    expect((await readyStep(s.env, state)).patch).toEqual({
      markedReady: false,
      readyHeld: "evidence comment failed: denied",
    });
    expect(s.run).not.toHaveBeenCalled();
  });
  test("AC-14 recording failure holds before CI", async () => {
    const s = setup();
    s.record.mockRejectedValue(new Error("unreadable"));
    expect((await readyStep(s.env, state)).patch).toEqual({
      markedReady: false,
      readyHeld: "rulings could not be read",
    });
    expect(s.wait).not.toHaveBeenCalled();
    expect(s.run).not.toHaveBeenCalled();
  });
  test("AC-15 recording model uses ruling operation and configured tier", async () => {
    const s = setup();
    s.env = { ...s.env, config: makeNaxConfig({ bot: { models: { rulings: "balanced" } } }) };
    const call = spyOn(_workflowDeps, "callOp").mockResolvedValue(null);
    await readyStep(s.env, state);
    const input = { items: [] };
    expect(await s.record.mock.calls[0]?.[0].readModel(input)).toBeNull();
    expect(call).toHaveBeenCalledWith(s.env.ctx.callCtx, botRulingReadOp, { ...input, model: "balanced" });
  });
  test.each(["green", "failed", "pending", "unavailable", "no-checks", "conflicting"] as const)(
    "AC-16 unmarked draft CI %s",
    async (outcome) => {
      const s = setup();
      s.env = { ...s.env, info: { ...s.env.info, body: "plain PR" } };
      s.wait.mockResolvedValue({ outcome, detail: "detail" });
      expect((await readyStep(s.env, state)).patch.markedReady).toBe(outcome === "green");
      expect(s.run).toHaveBeenCalledTimes(outcome === "green" ? 1 : 0);
      expect(s.record).not.toHaveBeenCalled();
    },
  );
  test.each(["failed", "pending", "unavailable", "no-checks", "conflicting"] as const)(
    "workflow CI %s never posts evidence or marks ready",
    async (outcome) => {
      const s = setup();
      s.wait.mockResolvedValue({ outcome, detail: "not green" });
      expect((await readyStep(s.env, state)).patch).toEqual({
        markedReady: false,
        readyHeld: `CI ${outcome}: not green`,
      });
      expect(s.post).not.toHaveBeenCalled();
      expect(s.run).not.toHaveBeenCalled();
    },
  );
  test("fresh forge read failure holds before recording", async () => {
    const s = setup();
    s.read.mockRejectedValue(new Error("offline"));
    expect((await readyStep(s.env, state)).patch.readyHeld).toBe("rulings could not be read");
    expect(s.record).not.toHaveBeenCalled();
    expect(s.wait).not.toHaveBeenCalled();
  });
});
