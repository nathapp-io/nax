import { afterEach, describe, expect, test } from "bun:test";
import type { ForgeRunResult } from "@/forge";
import { _ciWaitDeps, CI_ERROR_POLL_LIMIT, type CiWaitResult, waitForChecks } from "@/workflow/ci-wait";

const original = { ..._ciWaitDeps };
afterEach(() => Object.assign(_ciWaitDeps, original));

const SHA = "c".repeat(40);
const API = ["gh", "api", `repos/{owner}/{repo}/commits/${SHA}/check-runs?per_page=100`];
const NO_PR_MSG = "no pull requests found for branch feat/demo";
const r = (stdout: string, exitCode = 0, stderr = ""): ForgeRunResult => ({ stdout, stderr, exitCode });
const noPr = (): ForgeRunResult => r("", 1, NO_PR_MSG);
const runs = (list: unknown[]): ForgeRunResult => r(JSON.stringify({ total_count: list.length, check_runs: list }));
const done = (conclusion: string, name = "ci") => ({ name, status: "completed", conclusion });
const OK_RUN = done("success");

/** Scripted forge: `checks` answers each gh pr checks, `api` each gh api (last repeats); gh pr view fails open. */
function wire(checks: ForgeRunResult[], api: ForgeRunResult[]) {
  const argvs: string[][] = [];
  let clock = 0;
  _ciWaitDeps.now = () => clock;
  _ciWaitDeps.sleep = async (ms) => {
    clock += ms;
  };
  _ciWaitDeps.schedule = () => () => {};
  const counts = { checks: 0, api: 0 };
  const pick = (list: ForgeRunResult[], n: number): ForgeRunResult => list[Math.min(n, list.length - 1)] ?? r("", 1);
  _ciWaitDeps.run = async (cmd) => {
    argvs.push(cmd);
    if (cmd[1] === "pr" && cmd[2] === "view") return r("", 1, "no pull requests found");
    if (cmd[0] === "gh" && cmd[1] === "api") return pick(api, counts.api++);
    if (cmd[0] === "gh") return pick(checks, counts.checks++);
    return r("", 1);
  };
  return argvs;
}

const OPTS = { cwd: "/repo", timeoutMs: 1000, pollMs: 10, commitChecks: true, expectedSha: SHA };
const apiCalls = (argvs: string[][]) => argvs.filter((a) => a[1] === "api");
const unavailable = (d: string): CiWaitResult => ({ outcome: "unavailable", detail: `CI status unavailable: ${d}` });

describe("waitForChecks commit path (no PR)", () => {
  test("AC-1/2/3: green; argv is gh pr checks then gh api", async () => {
    const argvs = wire([noPr()], [runs([OK_RUN])]);
    expect((await waitForChecks("github", "feat/demo", OPTS)).outcome).toBe("green");
    expect(argvs).toHaveLength(2);
    expect(argvs[0]?.slice(0, 3)).toEqual(["gh", "pr", "checks"]);
    expect(argvs[1]).toEqual(API);
  });

  test("AC-4: failure detail", async () => {
    wire([noPr()], [runs([done("failure")])]);
    expect(await waitForChecks("github", "feat/demo", OPTS)).toEqual({
      outcome: "failed",
      detail: "CI failed: ci; 0 still pending",
    });
  });

  test("AC-5: in progress then success, two api calls", async () => {
    const argvs = wire([noPr()], [runs([{ name: "ci", status: "in_progress", conclusion: null }]), runs([OK_RUN])]);
    expect((await waitForChecks("github", "feat/demo", OPTS)).outcome).toBe("green");
    expect(apiCalls(argvs)).toHaveLength(2);
  });

  test("AC-6: empty runs until the deadline is no-checks", async () => {
    wire([noPr()], [runs([])]);
    expect((await waitForChecks("github", "feat/demo", OPTS)).outcome).toBe("no-checks");
  });

  test("AC-7: success, skipped, neutral is green", async () => {
    wire([noPr()], [runs([done("success", "a"), done("skipped", "b"), done("neutral", "c")])]);
    expect((await waitForChecks("github", "feat/demo", OPTS)).outcome).toBe("green");
  });

  test.each(["cancelled", "timed_out", "action_required", "startup_failure"])("AC-8..11: %s is failed", async (c) => {
    wire([noPr()], [runs([done(c)])]);
    expect((await waitForChecks("github", "feat/demo", OPTS)).outcome).toBe("failed");
  });

  test("AC-12: unknown conclusion stays pending to the deadline", async () => {
    wire([noPr()], [runs([done("stale")])]);
    expect((await waitForChecks("github", "feat/demo", OPTS)).outcome).toBe("pending");
  });

  test("AC-13: truncated list is unavailable", async () => {
    const hundred = Array.from({ length: 100 }, (_, i) => done("success", `c${i}`));
    wire([noPr()], [r(JSON.stringify({ total_count: 150, check_runs: hundred }))]);
    expect(await waitForChecks("github", "feat/demo", OPTS)).toEqual(
      unavailable("commit cccccccc has 150 check runs; only the first 100 were read"),
    );
  });

  test("AC-14: api failure reports stderr", async () => {
    wire([noPr()], [r("", 1, "HTTP 404: Not Found")]);
    expect(await waitForChecks("github", "feat/demo", OPTS)).toEqual(unavailable("HTTP 404: Not Found"));
  });

  test("AC-15: unparseable output", async () => {
    wire([noPr()], [r("not json")]);
    expect(await waitForChecks("github", "feat/demo", OPTS)).toEqual(unavailable("unparseable gh output: not json"));
  });

  test("AC-16: no commitChecks keeps the gh pr checks error", async () => {
    const argvs = wire([noPr()], [runs([OK_RUN])]);
    const { commitChecks: _drop, ...opts } = OPTS;
    expect(await waitForChecks("github", "feat/demo", opts)).toEqual(unavailable(NO_PR_MSG));
    expect(apiCalls(argvs)).toHaveLength(0);
  });

  test("AC-17: commitChecks without expectedSha takes no api path", async () => {
    const argvs = wire([noPr()], [runs([OK_RUN])]);
    const { expectedSha: _drop, ...opts } = OPTS;
    expect(await waitForChecks("github", "feat/demo", opts)).toEqual(unavailable(NO_PR_MSG));
    expect(apiCalls(argvs)).toHaveLength(0);
  });

  test("AC-18: a PR with checks makes no api call", async () => {
    const argvs = wire([r(JSON.stringify([{ name: "ci", state: "SUCCESS", bucket: "pass" }]))], [runs([])]);
    await waitForChecks("github", "feat/demo", OPTS);
    expect(apiCalls(argvs)).toHaveLength(0);
  });

  test("AC-19: gitlab never runs gh", async () => {
    const argvs = wire([], []);
    await waitForChecks("gitlab", "feat/demo", OPTS);
    expect(argvs.length).toBeGreaterThan(0);
    expect(argvs.filter((a) => a[0] === "gh")).toHaveLength(0);
  });

  test("AC-20: a PR opened during the wait is read normally", async () => {
    const pass = r(JSON.stringify([{ name: "ci", state: "SUCCESS", bucket: "pass" }]));
    const argvs = wire([noPr(), pass], [runs([{ name: "ci", status: "in_progress", conclusion: null }])]);
    expect((await waitForChecks("github", "feat/demo", OPTS)).outcome).toBe("green");
    expect(apiCalls(argvs)).toHaveLength(1);
  });

  test("AC-21: {} is unparseable", async () => {
    wire([noPr()], [r("{}")]);
    expect(await waitForChecks("github", "feat/demo", OPTS)).toEqual(unavailable("unparseable gh output: {}"));
  });

  test("AC-22: stderr is trimmed; ends after CI_ERROR_POLL_LIMIT polls", async () => {
    const argvs = wire([noPr()], [r("", 1, "  HTTP 404: Not Found\n")]);
    expect(await waitForChecks("github", "feat/demo", OPTS)).toEqual(unavailable("HTTP 404: Not Found"));
    expect(apiCalls(argvs)).toHaveLength(CI_ERROR_POLL_LIMIT);
  });

  test("AC-23: empty stderr reports the exit code", async () => {
    const argvs = wire([noPr()], [r("", 7)]);
    expect(await waitForChecks("github", "feat/demo", OPTS)).toEqual(unavailable("exit 7"));
    expect(apiCalls(argvs)).toHaveLength(CI_ERROR_POLL_LIMIT);
  });

  test("AC-24: unparseable output is cut at 200 characters", async () => {
    wire([noPr()], [r("x".repeat(250))]);
    expect(await waitForChecks("github", "feat/demo", OPTS)).toEqual(
      unavailable(`unparseable gh output: ${"x".repeat(200)}`),
    );
  });
});
