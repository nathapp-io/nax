import { afterEach, describe, expect, mock, test } from "bun:test";
import type { ForgeRunResult } from "@/forge";
import { _ciWaitDeps, readChecksOnce } from "@/workflow/ci-wait";

const original = { ..._ciWaitDeps };
afterEach(() => Object.assign(_ciWaitDeps, original));

const r = (stdout: string, exitCode = 0, stderr = ""): ForgeRunResult => ({ stdout, stderr, exitCode });
const gh = (checks: Record<string, string>): ForgeRunResult =>
  r(JSON.stringify(Object.entries(checks).map(([name, bucket]) => ({ name, state: bucket.toUpperCase(), bucket }))), 8);
const OPTS = { cwd: "/repo", expectedSha: "head1234aa" };

/** One scripted checks reply; the `gh pr view` read reports `headRefOid`. */
function forge(checks: ForgeRunResult | Error, headRefOid = OPTS.expectedSha) {
  const sleep = mock(async (_ms: number) => {});
  _ciWaitDeps.sleep = sleep;
  _ciWaitDeps.run = async (cmd) => {
    if (cmd[0] === "gh" && cmd[2] === "view") return r(JSON.stringify({ mergeable: "MERGEABLE", headRefOid }));
    if (checks instanceof Error) throw checks;
    return checks;
  };
  return { sleep };
}

describe("readChecksOnce (nax#2631)", () => {
  test("green names every reported check and never waits", async () => {
    const { sleep } = forge(gh({ build: "pass", e2e: "skipping" }));
    expect(await readChecksOnce("github", "url", OPTS)).toEqual({
      outcome: "green",
      detail: "CI checks: 2/2 passed, 0 pending; checks: build (pass), e2e (skipping)",
    });
    expect(sleep).not.toHaveBeenCalled();
  });

  test("red keeps the failing check names", async () => {
    forge(gh({ build: "pass", lint: "fail" }));
    expect(await readChecksOnce("github", "url", OPTS)).toEqual({
      outcome: "failed",
      detail: "CI checks: 1/2 passed, 0 pending, failing: lint; checks: build (pass), lint (fail)",
    });
  });

  test.each([
    ["green", { build: "pass" }],
    ["red", { build: "fail" }],
  ])("%s checks for another head are unavailable, never this head's verdict", async (_label, checks) => {
    forge(gh(checks), "newer9999");
    expect(await readChecksOnce("github", "url", OPTS)).toEqual({
      outcome: "unavailable",
      detail: "checks report newer999 but HEAD is head1234",
    });
  });

  test("pending reports what is still running", async () => {
    forge(gh({ build: "pass", test: "pending" }));
    expect(await readChecksOnce("github", "url", OPTS)).toMatchObject({ outcome: "pending" });
  });

  test("no checks yet is no-checks, without a duration", async () => {
    forge(r("", 1, "no checks reported on the 'b' branch"));
    expect(await readChecksOnce("github", "url", OPTS)).toEqual({
      outcome: "no-checks",
      detail: "no CI check reported for this head yet",
    });
  });

  test("an unreadable forge is unavailable with its error", async () => {
    forge(new Error("gh: rate limited"));
    expect(await readChecksOnce("github", "url", OPTS)).toEqual({
      outcome: "unavailable",
      detail: "CI status unavailable: gh: rate limited",
    });
  });

  test("a failed GitLab pipeline for another commit is unavailable", async () => {
    forge(r(JSON.stringify({ head_pipeline: { status: "failed", sha: "newer9999" } })));
    expect(await readChecksOnce("gitlab", "url", OPTS)).toEqual({
      outcome: "unavailable",
      detail: "checks report newer999 but HEAD is head1234",
    });
  });
});
