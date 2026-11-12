/** US-001: readiness is held for an unreviewed pushed head and for open critical/important findings. */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { makeBotFixDraftEnv, makeBotFixEnv } from "@test/helpers";
import { _fixReportDeps, type AgreedItem, type BotFixEnv, type BotFixState, readyStep } from "@/bot";
import { markReadyArgv } from "@/workflow/promote";

const HEAD = "abc1234def";
const greenCi = { outcome: "green", detail: "all checks passed" } as const;
/** This execution pushed `HEAD`: the fix graph's post-push readiness pass. */
const pushed: BotFixState = { step: "reply", timings: {}, outcome: "pushed", pushedSha: HEAD };
/** A ready-only pass (`nax bot fix --ready-only`): no fix session, no push. */
const readyPass: BotFixState = { step: "ready", timings: {}, outcome: "ready-pass", readyOnly: true };

function finding(key: string, severity: "critical" | "important" | "minor"): AgreedItem {
  return { kind: "finding", key, issue: `issue ${key}`, severity };
}
const threadItem: AgreedItem = {
  kind: "thread",
  key: "t-1",
  issue: "rename",
  reason: "clearer",
  threadId: "n1",
  replyTo: "r1",
};
const commentItem: AgreedItem = { kind: "comment", key: "c-1", issue: "please rename", reason: "reasonable" };

/** A draft PR at `HEAD` whose readiness review agreed on `agreed`. */
function draftEnv(agreed: readonly AgreedItem[] = []): BotFixEnv {
  const base = makeBotFixDraftEnv({ url: "https://github.com/o/r/pull/42" });
  return {
    ...base,
    info: { ...base.info, headSha: HEAD },
    review: { ...base.review, headSha: HEAD, agreed },
  };
}

beforeEach(() => {
  spyOn(_fixReportDeps, "waitForPrHead").mockResolvedValue(true);
  spyOn(_fixReportDeps, "waitForChecks").mockResolvedValue(greenCi);
  spyOn(_fixReportDeps, "readPrInfo").mockResolvedValue({ ...makeBotFixDraftEnv().info, headSha: HEAD });
});
afterEach(() => mock.restore());

describe("readyStep pushed-head hold", () => {
  test("AC-1 holds a pushed head for a bot review of that head", async () => {
    const env = draftEnv();
    const result = await readyStep(env, pushed);
    expect(result.patch.markedReady).toBe(false);
    expect(result.patch.readyHeld).toStartWith("pushed abc1234; a bot review of the pushed head decides readiness");
  });

  test("AC-2 never writes the mark-ready argv for an unreviewed pushed head", async () => {
    const env = draftEnv();
    const run = spyOn(env.forge, "run");
    await readyStep(env, pushed);
    expect(run).not.toHaveBeenCalledWith(markReadyArgv(env.ref.forge, env.info.url), expect.anything());
    expect(run).not.toHaveBeenCalled();
  });

  test("the hold names both recovery commands for this PR", async () => {
    const result = await readyStep(draftEnv(), pushed);
    expect(result.patch.readyHeld).toContain("nax bot review 42, then nax bot fix 42 --ready-only");
  });

  test("a ready-only pass is not held by the pushed-head check", async () => {
    const env = draftEnv();
    const run = spyOn(env.forge, "run");
    const result = await readyStep(env, { ...pushed, readyOnly: true });
    expect(result.patch.markedReady).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("readyStep open-finding hold", () => {
  test("AC-3 an important finding of the readiness review holds readiness", async () => {
    const result = await readyStep(draftEnv([finding("f-1", "important")]), readyPass);
    expect(result.patch.markedReady).toBe(false);
    expect(result.patch.readyHeld).toContain("1 open critical/important finding(s)");
    expect(result.patch.readyHeld).toContain("f-1");
  });

  test("AC-4 a critical finding holds readiness", async () => {
    const result = await readyStep(draftEnv([finding("f-2", "critical")]), readyPass);
    expect(result.patch.markedReady).toBe(false);
    expect(result.patch.readyHeld).toContain("f-2");
  });

  test("AC-5 minor findings, threads and comments never hold the mark-ready write", async () => {
    const env = draftEnv([finding("f-3", "minor"), threadItem]);
    const run = spyOn(env.forge, "run").mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const result = await readyStep(env, readyPass);
    expect(result.patch).toEqual({ markedReady: true });
    expect(run).toHaveBeenCalledWith(markReadyArgv(env.ref.forge, env.info.url), { cwd: env.repoRoot });
  });

  test("AC-6 names at most five keys and counts the rest", async () => {
    const agreed = Array.from({ length: 7 }, (_, index) => finding(`f-${index}`, "important"));
    const result = await readyStep(draftEnv(agreed), readyPass);
    expect(result.patch.readyHeld).toContain("7 open critical/important finding(s)");
    expect(result.patch.readyHeld).toEndWith("f-0, f-1, f-2, f-3, f-4, +2 more");
  });

  test("AC-7 the hold wins over a PR that is not a draft", async () => {
    const base = makeBotFixEnv([finding("f-1", "important")]);
    const env: BotFixEnv = {
      ...base,
      info: { ...base.info, headSha: HEAD, draft: false },
      review: { ...base.review, headSha: HEAD, agreed: [finding("f-1", "important")] },
    };
    const run = spyOn(env.forge, "run");
    expect(await readyStep(env, readyPass)).toEqual({
      patch: {
        markedReady: false,
        readyHeld: "1 open critical/important finding(s) in the bot review of abc1234: f-1",
      },
      exit: "report",
    });
    expect(run).not.toHaveBeenCalled();
  });

  test("AC-20 only minor findings, threads or comments leave the readiness checks in charge", async () => {
    for (const agreed of [
      [finding("f-4", "minor")],
      [threadItem],
      [commentItem],
      [finding("f-5", "minor"), commentItem],
    ]) {
      const env = draftEnv(agreed);
      spyOn(env.forge, "run").mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
      const result = await readyStep(env, readyPass);
      expect(result.patch.readyHeld).toBeUndefined();
      expect(result.patch.markedReady).toBe(true);
    }
  });
});
