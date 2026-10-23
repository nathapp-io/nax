import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { makeBotFixDraftEnv } from "@test/helpers";
import { _fixReportDeps, readyStep } from "@/bot/fix-report";
import { _prHeadWaitDeps, PR_HEAD_POLL_MS, PR_HEAD_WAIT_MS, waitForPrHead } from "@/bot/pr-head-wait";

const original = { ..._prHeadWaitDeps };
afterEach(() => {
  mock.restore();
  Object.assign(_prHeadWaitDeps, original);
});

describe("waitForPrHead", () => {
  test("uses relocated default deps and retries a transient forge error", async () => {
    const env = makeBotFixDraftEnv();
    let now = 0;
    const read = mock(async () => env.info);
    read.mockRejectedValueOnce(new Error("transient forge read failure"));
    const sleep = mock(async (ms: number) => {
      now += ms;
    });
    Object.assign(_prHeadWaitDeps, { readPrInfo: read, sleep, now: () => now });
    expect(await waitForPrHead({ ref: env.ref, repoRoot: env.repoRoot, sha: env.info.headSha })).toBe(true);
    expect(sleep).toHaveBeenCalledWith(PR_HEAD_POLL_MS);
    expect(read).toHaveBeenCalledTimes(2);
  });
  test("AC-19 real polling expiry leaves the draft completely unchanged", async () => {
    const env = makeBotFixDraftEnv();
    let now = 0;
    const read = mock(async () => env.info);
    Object.assign(_prHeadWaitDeps, {
      readPrInfo: read,
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
    });
    spyOn(_fixReportDeps, "waitForPrHead").mockImplementation(waitForPrHead);
    const rulings = spyOn(_fixReportDeps, "recordPrRulings");
    const checks = spyOn(_fixReportDeps, "waitForChecks");
    const post = spyOn(_fixReportDeps, "postPrComment");
    const edit = spyOn(_fixReportDeps, "editComment");
    const forge = spyOn(env.forge, "run");
    const out = await readyStep(env, { step: "ready", timings: {}, pushedSha: "abcdef1234" });
    expect(now).toBe(PR_HEAD_WAIT_MS);
    expect(read).toHaveBeenCalledTimes(PR_HEAD_WAIT_MS / PR_HEAD_POLL_MS + 1);
    expect(out.patch).toEqual({ markedReady: false, readyHeld: "PR head did not reach abcdef1" });
    for (const effect of [rulings, checks, post, edit, forge]) expect(effect).not.toHaveBeenCalled();
  });
});
