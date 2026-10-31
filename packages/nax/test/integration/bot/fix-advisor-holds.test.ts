import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { makeBotFixDeps, makeBotFixEnv, makeTestRuntime } from "@test/helpers";
import { _fixInputDeps, loadLatestReview } from "@/bot/fix-input";
import { _fixReportDeps, readyStep, replyStep, reportStep } from "@/bot/fix-report";
import { _botFixDeps, runBotFix } from "@/bot/fix-run";
import { _fixStepsDeps, checkStep, fixStep } from "@/bot/fix-steps";
import { _rulingsDeps, recordPrRulings } from "@/bot/rulings";
import { workflowPrReadiness } from "@/bot/workflow-ready";
import { NAX_WORKFLOW_PR_MARKER, type PrComment, type PrThread, parseNaxBotMarker, withNaxBotMarker } from "@/forge";
import { renderItemIndex, renderItemOpener } from "@/workflow/item-threads";

const key = "w-D-1.12345678";
const originals = {
  fix: { ..._botFixDeps },
  input: { ..._fixInputDeps },
  steps: { ..._fixStepsDeps },
  rulings: { ..._rulingsDeps },
};
const input = { dir: "/repo", pr: 42, profiles: [], interactive: false };
const comment = (id: string, body: string, author = "bot"): PrComment => ({
  id,
  body,
  author,
  kind: "thread",
  createdAt: "",
});
let env: ReturnType<typeof makeBotFixEnv>;
let runtime: ReturnType<typeof makeTestRuntime>;
let thread: PrThread;
let comments: PrComment[];

beforeEach(() => {
  const base = makeBotFixEnv();
  thread = {
    id: "advisor",
    replyTo: "opener",
    resolved: true,
    outdated: false,
    comments: [
      comment("opener", withNaxBotMarker(renderItemOpener({ id: "D-1", kind: "advisor", issue: "change X" }), key)),
      comment("confirm", "confirm: change X", "alice"),
    ],
  };
  comments = [comment("index", withNaxBotMarker(renderItemIndex({ keys: [key] }), "w-index"))];
  env = {
    ...base,
    info: { ...base.info, draft: true, body: NAX_WORKFLOW_PR_MARKER },
    threads: [thread],
    review: { ...base.review, version: 3, checks: base.checks },
  };
  runtime = makeTestRuntime();
  Object.assign(_botFixDeps, makeBotFixDeps(env, runtime), {
    forge: env.forge,
    loadLatestReview,
    fixStep,
    checkStep,
    replyStep,
    readyStep,
    reportStep,
    recordPrRulings,
    listPrComments: async () => comments,
  });
  spyOn(_fixInputDeps, "glob").mockResolvedValue(["saved/bot-review.json"]);
  spyOn(_fixInputDeps, "readText").mockImplementation(async () => JSON.stringify(env.review));
  spyOn(_fixInputDeps, "mtimeMs").mockResolvedValue(1);
  spyOn(_rulingsDeps, "hasWriteAccess").mockResolvedValue(true);
  spyOn(_rulingsDeps, "readPrInfo").mockImplementation(async () => env.info);
  spyOn(_rulingsDeps, "editComment").mockResolvedValue();
  spyOn(_rulingsDeps, "resolveThread").mockResolvedValue();
  spyOn(_rulingsDeps, "replyToThread").mockImplementation(async (_ref, _thread, body) => {
    thread = { ...thread, comments: [...thread.comments, comment("echo", body)] };
    return { id: "echo" };
  });
  spyOn(_fixReportDeps, "readPrInfo").mockImplementation(async () => env.info);
  spyOn(_fixReportDeps, "readCurrentUser").mockResolvedValue(env.user);
  spyOn(_fixReportDeps, "listReviewThreads").mockImplementation(async () => [thread]);
  spyOn(_fixReportDeps, "listPrComments").mockImplementation(async () => comments);
  spyOn(_fixReportDeps, "postPrComment").mockResolvedValue({ id: "summary" });
  spyOn(_fixReportDeps, "replyToThread").mockResolvedValue({ id: "fix" });
  spyOn(_fixReportDeps, "resolveThread").mockResolvedValue();
});
afterEach(async () => {
  mock.restore();
  Object.assign(_botFixDeps, originals.fix);
  Object.assign(_fixInputDeps, originals.input);
  Object.assign(_fixStepsDeps, originals.steps);
  Object.assign(_rulingsDeps, originals.rulings);
  await runtime.close();
});

async function outstanding() {
  return recordPrRulings({
    ref: env.ref,
    info: env.info,
    login: env.user.login,
    threads: [thread],
    comments,
    deps: env.forge,
    cwd: env.repoRoot,
    readModel: async () => null,
  });
}
function expectHold(reason: string | undefined) {
  expect(reason).toContain("D-1");
  expect(reason).toContain("confirmed advisor");
  expect(reason).toContain("run nax bot review, then nax bot fix");
}

describe("runBotFix confirmed advisor holds", () => {
  test("AC-12/13/14 echoes confirm but consumes the saved empty review and holds readiness", async () => {
    const session = spyOn(_fixStepsDeps, "runBranchFix").mockResolvedValue({ autoCommitted: false, dirty: false });
    const result = await runBotFix(input);
    expect(result).toMatchObject({ outcome: "nothing", markedReady: false });
    expect(_fixInputDeps.readText).toHaveBeenCalledWith("saved/bot-review.json");
    expect(env.review.agreed).toEqual([]);
    expect(session).not.toHaveBeenCalled();
    expect(_rulingsDeps.replyToThread).toHaveBeenCalledTimes(1);
    expect(thread.comments.map((c) => parseNaxBotMarker(c.body)?.key)).toContain(`wr-confirmed-${key}`);
    expect(_fixReportDeps.postPrComment).toHaveBeenCalledWith(
      env.ref,
      expect.stringContaining("Nothing to fix"),
      env.forge,
      env.repoRoot,
    );
    if (result.outcome === "refused") throw new Error(result.reason);
    expectHold(result.readyHeld);
    const reread = await outstanding();
    expect(reread.confirmedWork?.map((item) => item.itemId)).toEqual(["D-1"]);
    expect(_rulingsDeps.replyToThread).toHaveBeenCalledTimes(1);
    const ready = workflowPrReadiness({ outcome: reread, ci: { outcome: "green", detail: "passed" } });
    expect(ready.ready).toBe(false);
    if (!ready.ready) expectHold(ready.reason);
  });
  test("AC-15/16 no-change route skips push/reply/ready; reread still holds confirmed work", async () => {
    env = {
      ...env,
      review: { ...env.review, agreed: [{ kind: "finding", key, issue: "change X", severity: "important" }] },
    };
    // The shared boundary defaults captured the earlier environment; only the artifact changes.
    spyOn(_fixStepsDeps, "runBranchFix").mockResolvedValue({ autoCommitted: false, dirty: false });
    spyOn(_fixStepsDeps, "readHead").mockResolvedValue(env.info.headSha);
    spyOn(_fixStepsDeps, "runGit").mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    spyOn(_fixStepsDeps, "changedPaths").mockResolvedValue([]);
    const push = spyOn(_botFixDeps, "pushStep");
    const reply = spyOn(_botFixDeps, "replyStep");
    const ready = spyOn(_botFixDeps, "readyStep");
    expect(await runBotFix(input)).toMatchObject({ outcome: "no-change", agreedCount: 1 });
    expect(push).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
    expect(ready).not.toHaveBeenCalled();
    expect(_fixReportDeps.replyToThread).not.toHaveBeenCalled();
    expect(thread.comments.some((c) => parseNaxBotMarker(c.body)?.key === `fix-${key}`)).toBe(false);
    const reread = await outstanding();
    expect(reread.confirmedWork?.map((item) => item.itemId)).toEqual(["D-1"]);
    const readiness = workflowPrReadiness({ outcome: reread, ci: { outcome: "green", detail: "passed" } });
    expect(readiness.ready).toBe(false);
    if (!readiness.ready) expectHold(readiness.reason);
  });
});
