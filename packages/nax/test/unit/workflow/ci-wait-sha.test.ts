import { afterEach, expect, test } from "bun:test";
import { _ciWaitDeps, waitForChecks } from "@/workflow/ci-wait";

const saved = { ..._ciWaitDeps };
afterEach(() => Object.assign(_ciWaitDeps, saved));
const opts = { cwd: "/repo", timeoutMs: 20, pollMs: 10, expectedSha: "aaa" };

function wire(values: unknown[], forge = "github") {
  let clock = 0;
  let polls = 0;
  const sleeps: number[] = [];
  _ciWaitDeps.now = () => clock;
  _ciWaitDeps.schedule = () => () => {};
  _ciWaitDeps.sleep = async (ms) => {
    clock += ms;
    sleeps.push(ms);
  };
  _ciWaitDeps.run = async (cmd) => {
    if (forge === "github" && cmd[2] === "checks") {
      return { exitCode: 0, stderr: "", stdout: '[{"name":"test","bucket":"pass"}]' };
    }
    const value = values[Math.min(polls++, values.length - 1)];
    if (value instanceof Error) throw value;
    return { exitCode: 0, stderr: "", stdout: JSON.stringify(value) };
  };
  return { sleeps, polls: () => polls };
}

test("AC-1/2: stale GitHub green waits until the pushed SHA is green", async () => {
  const observed = wire([{ headRefOid: "bbb" }, { headRefOid: "aaa" }]);
  expect((await waitForChecks("github", "b", opts)).outcome).toBe("green");
  expect(observed.polls()).toBe(2);
  expect(observed.sleeps).toEqual([10]);
});

test("AC-3: stale GitHub green at deadline is unavailable", async () => {
  wire([{ headRefOid: "bbb" }]);
  expect((await waitForChecks("github", "b", opts)).outcome).toBe("unavailable");
});

test("AC-4: mismatch detail uses the first eight characters of both SHAs", async () => {
  wire([{ headRefOid: "bbbbbbbb123456" }]);
  expect(await waitForChecks("github", "b", { ...opts, expectedSha: "aaaaaaaa654321" })).toEqual({
    outcome: "unavailable",
    detail: "checks report bbbbbbbb but HEAD is aaaaaaaa",
  });
});

test("AC-5: stale GitLab green cannot end the wait", async () => {
  const observed = wire([{ head_pipeline: { status: "success", sha: "bbb" } }], "gitlab");
  expect((await waitForChecks("gitlab", "b", opts)).outcome).toBe("unavailable");
  expect(observed.polls()).toBeGreaterThan(1);
});

test("AC-6: GitLab falls back to pipeline SHA", async () => {
  wire([{ pipeline: { status: "success", sha: "aaa" } }], "gitlab");
  expect((await waitForChecks("gitlab", "b", opts)).outcome).toBe("green");
});

test("AC-7: absent expected SHA preserves green", async () => {
  wire([{ headRefOid: "bbb" }]);
  const { expectedSha: _, ...withoutSha } = opts;
  expect((await waitForChecks("github", "b", withoutSha)).outcome).toBe("green");
});

test("AC-8: GitLab success without a reported SHA remains green", async () => {
  wire([{ head_pipeline: { status: "success" } }], "gitlab");
  expect((await waitForChecks("gitlab", "b", opts)).outcome).toBe("green");
});

test.each([{}, new Error("view failed")])("missing/unreadable GitHub SHA fails open: %p", async (value) => {
  wire([value]);
  expect((await waitForChecks("github", "b", opts)).outcome).toBe("green");
});

test("GitLab uses pipeline.sha when head_pipeline has no sha", async () => {
  wire([{ head_pipeline: { status: "success" }, pipeline: { sha: "bbb" } }], "gitlab");
  expect((await waitForChecks("gitlab", "b", opts)).outcome).toBe("unavailable");
});

test.each([
  ["AC-12", "skipped", "green"],
  ["AC-13", "manual", "unavailable"],
  ["AC-14", "scheduled", "unavailable"],
] as const)("%s: GitLab %s ends on the first poll", async (_ac, status, outcome) => {
  const observed = wire([{ head_pipeline: { status } }], "gitlab");
  const result = await waitForChecks("gitlab", "b", opts);
  expect(result.outcome).toBe(outcome);
  if (outcome === "unavailable") expect(result.detail).toBe(`pipeline is waiting on a ${status} job`);
  expect(observed.polls()).toBe(1);
  expect(observed.sleeps).toEqual([]);
});
