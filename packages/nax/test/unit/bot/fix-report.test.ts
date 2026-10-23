import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { makeBotFixDraftEnv, makeBotFixEnv } from "@test/helpers";
import { _fixCycleDeps, waitForPrHead } from "@/bot";
import { _fixReportDeps, readyStep, replyStep, reportStep } from "@/bot/fix-report";
import { NAX_WORKFLOW_PR_MARKER, withNaxBotMarker } from "@/forge";

afterEach(() => mock.restore());

describe("resolveOwnFindings via replyStep", () => {
  test("AC-19 never replies to or resolves an agreed workflow finding", async () => {
    const key = "w-B3.12345678";
    const base = makeBotFixEnv([{ kind: "finding", key, issue: "hold", severity: "minor" }]);
    const env = {
      ...base,
      threads: [
        {
          id: "1",
          replyTo: "1",
          resolved: false,
          outdated: false,
          comments: [
            {
              id: "7",
              kind: "thread" as const,
              author: base.user.login,
              body: withNaxBotMarker("finding", key),
              createdAt: "",
            },
          ],
        },
      ],
    };
    const reply = spyOn(_fixReportDeps, "replyToThread").mockResolvedValue({ id: "new" });
    const resolve = spyOn(_fixReportDeps, "resolveThread").mockResolvedValue();
    expect((await replyStep(env, { step: "reply", timings: {}, pushedSha: "abcdef12" })).patch).toEqual({
      replied: 0,
      resolved: 0,
    });
    expect(reply).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe("readyStep published head (US-009)", () => {
  test("AC-7 barrel poll resolves on the second read", async () => {
    const env = makeBotFixEnv();
    let reads = 0;
    const readPrInfo = mock(async () => ({ ...env.info, headSha: ++reads === 2 ? "S" : "old" }));
    expect(
      await waitForPrHead(
        { ref: env.ref, repoRoot: env.repoRoot, sha: "S" },
        {
          ..._fixCycleDeps,
          readPrInfo,
          sleep: async () => {},
          now: () => 0,
        },
      ),
    ).toBe(true);
    expect(readPrInfo).toHaveBeenCalledTimes(2);
  });
  test.each([true, false])("AC-8–10/19 waits before rulings; published=%s", async (published) => {
    const env = makeBotFixDraftEnv({ body: NAX_WORKFLOW_PR_MARKER });
    const order: string[] = [];
    const wait = spyOn(_fixReportDeps, "waitForPrHead").mockImplementation(async () => {
      order.push("head");
      return published;
    });
    const read = spyOn(_fixReportDeps, "readPrInfo").mockImplementation(async () => {
      order.push("rulings");
      return { ...env.info, headSha: "abcdef1234" };
    });
    spyOn(_fixReportDeps, "readCurrentUser").mockResolvedValue(env.user);
    spyOn(_fixReportDeps, "listReviewThreads").mockResolvedValue([]);
    spyOn(_fixReportDeps, "listPrComments").mockResolvedValue([]);
    spyOn(_fixReportDeps, "recordPrRulings").mockResolvedValue({
      recorded: [],
      settled: [],
      open: [],
      asked: 0,
      failed: 0,
    });
    const ci = spyOn(_fixReportDeps, "waitForChecks");
    const forge = spyOn(env.forge, "run");
    const post = spyOn(_fixReportDeps, "postPrComment");
    const result = await readyStep(env, { step: "ready", timings: {}, pushedSha: "abcdef1234" });
    expect(wait).toHaveBeenCalledWith({ ref: env.ref, repoRoot: env.repoRoot, sha: "abcdef1234" });
    expect(order).toEqual(published ? ["head", "rulings"] : ["head"]);
    if (!published) {
      expect(result.patch).toEqual({ markedReady: false, readyHeld: "PR head did not reach abcdef1" });
      expect(read).not.toHaveBeenCalled();
      expect(ci).not.toHaveBeenCalled();
    }
    expect(forge).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });
  test("AC-11 without a push never polls", async () => {
    const wait = spyOn(_fixReportDeps, "waitForPrHead");
    spyOn(_fixReportDeps, "waitForChecks").mockResolvedValue({ outcome: "failed", detail: "red" });
    await readyStep(makeBotFixDraftEnv(), { step: "ready", timings: {} });
    expect(wait).not.toHaveBeenCalled();
  });
});

describe("reportStep ledger push (US-009)", () => {
  test("AC-14–16 reports ledger head, next review and main-checkout pull hint", async () => {
    const env = makeBotFixEnv();
    const post = spyOn(_fixReportDeps, "postPrComment").mockResolvedValue({ id: "report" });
    await reportStep(env, {
      step: "report",
      timings: {},
      outcome: "nothing",
      pushedSha: "abcdef1234",
      ledgerCarried: true,
    });
    const body = post.mock.calls[0]?.[1];
    expect(body).toContain("Pushed abcdef1: advisor ledger.");
    expect(body).toContain("Run nax bot review 42 before the next nax bot fix.");
    expect(body).toContain("git pull --rebase");
  });
});
