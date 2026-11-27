import { afterEach, expect, test } from "bun:test";
import { _ciWaitDeps, waitForChecks } from "@/workflow/ci-wait";

const saved = { ..._ciWaitDeps };
afterEach(() => Object.assign(_ciWaitDeps, saved));

test("US-004 AC-3: stable B/B bracket with no inline SHA returns green for expected B", async () => {
  const B = "b".repeat(40);
  let clock = 0;
  _ciWaitDeps.now = () => clock;
  _ciWaitDeps.schedule = () => () => {};
  _ciWaitDeps.sleep = async (ms) => {
    clock += ms;
  };
  _ciWaitDeps.run = async (cmd) => {
    if (cmd[2] === "checks") return { exitCode: 0, stderr: "", stdout: '[{"name":"test","bucket":"pass"}]' };
    if (cmd[5] === "headRefOid") return { exitCode: 0, stderr: "", stdout: JSON.stringify({ headRefOid: B }) };
    return { exitCode: 0, stderr: "", stdout: "{}" };
  };
  const result = await waitForChecks("github", "b", { cwd: "/repo", timeoutMs: 20, pollMs: 10, expectedSha: B });
  expect(result.outcome).toBe("green");
});
