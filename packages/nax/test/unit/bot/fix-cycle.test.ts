import { describe, expect, mock, test } from "bun:test";
import { makeBotFixEnv } from "@test/helpers";
import { _fixCycleDeps, PR_HEAD_POLL_MS, PR_HEAD_WAIT_MS, waitForPrHead } from "@/bot/fix-cycle";

describe("waitForPrHead", () => {
  test.each([false, true])("retries forge errors within the deadline; permanent=%s", async (permanent) => {
    const env = makeBotFixEnv();
    let time = 0;
    let reads = 0;
    const deps = {
      ..._fixCycleDeps,
      now: () => time,
      sleep: async (ms: number) => {
        time += ms;
      },
      readPrInfo: async () => {
        if (permanent || reads++ === 0) throw new Error("forge unavailable");
        return env.info;
      },
    };
    expect(await waitForPrHead({ ref: env.ref, repoRoot: "/repo", sha: env.info.headSha }, deps)).toBe(!permanent);
    expect(time).toBe(permanent ? PR_HEAD_WAIT_MS : PR_HEAD_POLL_MS);
  });
  test("AC-12/13 polls resolved ref and sleeps between reads until head matches", async () => {
    const env = makeBotFixEnv();
    let time = 0;
    const readPrInfo = mock(async () => ({ ...env.info, headSha: time >= PR_HEAD_POLL_MS * 2 ? "expected" : "old" }));
    const sleep = mock(async (ms: number) => {
      time += ms;
    });
    const deps = { ..._fixCycleDeps, readPrInfo, sleep, now: () => time };
    expect(await waitForPrHead({ ref: env.ref, repoRoot: "/resolved", sha: "expected" }, deps)).toBe(true);
    expect(readPrInfo).toHaveBeenCalledTimes(3);
    expect(readPrInfo).toHaveBeenCalledWith(env.ref, deps.forge, "/resolved");
    expect(sleep.mock.calls).toEqual([[PR_HEAD_POLL_MS], [PR_HEAD_POLL_MS]]);
  });
  test("AC-14 stops at the injected deadline without real waits", async () => {
    const env = makeBotFixEnv();
    let time = 0;
    const sleep = mock(async (ms: number) => {
      time += ms;
    });
    const deps = { ..._fixCycleDeps, readPrInfo: mock(async () => env.info), sleep, now: () => time };
    expect(await waitForPrHead({ ref: env.ref, repoRoot: "/resolved", sha: "missing" }, deps)).toBe(false);
    expect(time).toBe(PR_HEAD_WAIT_MS);
    expect(sleep).toHaveBeenCalledTimes(PR_HEAD_WAIT_MS / PR_HEAD_POLL_MS);
  });
});
