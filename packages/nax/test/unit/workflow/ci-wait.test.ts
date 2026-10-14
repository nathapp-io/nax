import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ForgeRunResult } from "@/forge";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import { _ciWaitDeps, waitForChecks } from "@/workflow/ci-wait";

const original = { ..._ciWaitDeps };
afterEach(() => Object.assign(_ciWaitDeps, original));

const OPTS = { cwd: "/repo", timeoutMs: 100, pollMs: 30 };
const r = (stdout: string, exitCode = 0, stderr = ""): ForgeRunResult => ({ stdout, stderr, exitCode });

/** Scripted forge: one reply per poll (the last repeats); a virtual clock advanced by sleep. */
function script(replies: (ForgeRunResult | Error)[]): { calls: string[][]; sleeps: number[] } {
  const calls: string[][] = [];
  const sleeps: number[] = [];
  let clock = 0;
  _ciWaitDeps.now = () => clock;
  _ciWaitDeps.sleep = async (ms) => {
    sleeps.push(ms);
    clock += ms;
  };
  _ciWaitDeps.run = async (cmd) => {
    calls.push(cmd);
    const next = replies.length > 1 ? replies.shift() : replies[0];
    if (next instanceof Error) throw next;
    if (!next) throw new Error("no reply scripted");
    return next;
  };
  return { calls, sleeps };
}

const gh = (buckets: string[]): ForgeRunResult =>
  r(JSON.stringify(buckets.map((bucket, i) => ({ name: `c${i}`, state: bucket.toUpperCase(), bucket }))), 8);

describe("waitForChecks (github)", () => {
  test("every check passes -> green, with the gh argv", async () => {
    const { calls } = script([gh(["pass", "skipping"])]);
    expect((await waitForChecks("github", "feat/x", OPTS)).outcome).toBe("green");
    expect(calls[0]).toEqual(["gh", "pr", "checks", "feat/x", "--json", "name,state,bucket"]);
  });

  test("any failed or cancelled check -> failed", async () => {
    script([gh(["pass", "fail"])]);
    expect((await waitForChecks("github", "b", OPTS)).outcome).toBe("failed");
    script([gh(["cancel"])]);
    expect((await waitForChecks("github", "b", OPTS)).outcome).toBe("failed");
  });

  test("pending, then green: keeps polling (exit 8 with JSON is not an error)", async () => {
    const { calls, sleeps } = script([gh(["pending"]), gh(["pass"])]);
    expect((await waitForChecks("github", "b", OPTS)).outcome).toBe("green");
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([30]);
  });

  test("no checks reported yet keeps polling; the limit returns pending (W-R9)", async () => {
    const { calls } = script([r("", 1, "no checks reported on the 'b' branch")]);
    const out = await waitForChecks("github", "b", OPTS);
    expect(out.outcome).toBe("pending");
    expect(out.detail).toContain("100ms");
    expect(calls.length).toBeGreaterThan(1);
  });

  test("a CLI error returns pending at once (P4-R4)", async () => {
    const { calls } = script([r("", 4, "gh: command failed: auth required")]);
    const out = await waitForChecks("github", "b", OPTS);
    expect(out).toEqual({ outcome: "pending", detail: "CI status unavailable: gh: command failed: auth required" });
    expect(calls).toHaveLength(1);
  });

  test("a spawn throw (gh not installed) returns pending", async () => {
    script([new Error("ENOENT: gh")]);
    expect((await waitForChecks("github", "b", OPTS)).outcome).toBe("pending");
  });

  test("unparseable stdout returns pending", async () => {
    script([r("not json")]);
    expect((await waitForChecks("github", "b", OPTS)).detail).toContain("unparseable");
  });

  test("an aborted signal returns pending without polling", async () => {
    const { calls } = script([gh(["pending"])]);
    const ac = new AbortController();
    ac.abort();
    expect((await waitForChecks("github", "b", { ...OPTS, signal: ac.signal })).outcome).toBe("pending");
    expect(calls).toHaveLength(0);
  });
});

describe("waitForChecks (gitlab)", () => {
  const mr = (status: string | null): ForgeRunResult =>
    r(JSON.stringify({ iid: 3, head_pipeline: status === null ? null : { status } }));

  test("success -> green, with the glab argv", async () => {
    const { calls } = script([mr("success")]);
    expect((await waitForChecks("gitlab", "feat/x", OPTS)).outcome).toBe("green");
    expect(calls[0]).toEqual(["glab", "mr", "view", "feat/x", "--output", "json"]);
  });

  test("failed and canceled -> failed", async () => {
    script([mr("failed")]);
    expect((await waitForChecks("gitlab", "b", OPTS)).outcome).toBe("failed");
    script([mr("canceled")]);
    expect((await waitForChecks("gitlab", "b", OPTS)).outcome).toBe("failed");
  });

  test("no head pipeline, then running, then success", async () => {
    script([mr(null), mr("running"), mr("success")]);
    expect((await waitForChecks("gitlab", "b", OPTS)).outcome).toBe("green");
  });

  test("glab error exit -> pending", async () => {
    script([r("", 1, "glab: not logged in")]);
    expect((await waitForChecks("gitlab", "b", OPTS)).outcome).toBe("pending");
  });
});

// US-005 (nax#2526): the wait says what it is doing, so a long CI wait is not a silent gap in the log.
describe("waitForChecks progress log", () => {
  let logs: LogEntry[];
  const messages = () => logs.filter((e) => e.stage === "workflow").map((e) => e.message);

  beforeEach(() => {
    resetLogger();
    logs = [];
    initLogger({ level: "silent" });
    addSink((entry) => logs.push(entry));
  });
  afterEach(() => resetLogger());

  const ghCheck = (name: string, bucket: string) => ({ name, state: bucket.toUpperCase(), bucket });
  const ghJson = (checks: { name: string; bucket: string }[]): ForgeRunResult => r(JSON.stringify(checks), 8);

  /**
   * A scripted forge with a virtual clock advanced `stepMs` on every poll — poll counts stay small
   * and no test ever waits a real minute. The final reply repeats once the script runs out.
   */
  function progressScript(replies: ForgeRunResult[], stepMs = 0) {
    let clock = 0;
    let polls = 0;
    _ciWaitDeps.now = () => clock;
    _ciWaitDeps.sleep = async (ms) => {
      clock += ms;
    };
    _ciWaitDeps.run = async () => {
      const next = replies[Math.min(polls, replies.length - 1)];
      polls++;
      clock += stepMs;
      if (!next) throw new Error("no reply scripted");
      return next;
    };
  }

  const TWO_CHECKS_PENDING = ghJson([ghCheck("build", "pending"), ghCheck("test", "pending")]);
  const ALL_PASS = ghJson([ghCheck("build", "pass"), ghCheck("test", "pass")]);

  test("AC-8: logs the wait it is about to run before its first poll", async () => {
    let atFirstPoll: string[] = [];
    _ciWaitDeps.now = () => 0;
    _ciWaitDeps.run = async () => {
      atFirstPoll = messages();
      return ALL_PASS;
    };
    const out = await waitForChecks("github", "feat/x", { cwd: "/repo", timeoutMs: 1200000, pollMs: 30000 });
    expect(out.outcome).toBe("green");
    expect(atFirstPoll).toEqual(["CI wait: feat/x (timeout 1200000ms, poll 30000ms)"]);
  });

  test("AC-9: a poll's check counts are logged once they are known", async () => {
    progressScript([
      ghJson([...Array(3).fill(ghCheck("c", "pass")), ...Array(12).fill(ghCheck("c", "pending"))]),
      ALL_PASS,
    ]);
    await waitForChecks("github", "b", { cwd: "/repo", timeoutMs: 600000, pollMs: 30000 });
    expect(messages()).toContain("CI checks: 3/15 passed, 12 pending");
  });

  test("AC-10: an unchanged summary is not logged twice", async () => {
    progressScript([TWO_CHECKS_PENDING, TWO_CHECKS_PENDING, TWO_CHECKS_PENDING, ALL_PASS]);
    await waitForChecks("github", "b", { cwd: "/repo", timeoutMs: 600000, pollMs: 30000 });
    expect(messages().filter((m) => m === "CI checks: 0/2 passed, 2 pending")).toHaveLength(1);
  });

  test("AC-11: a failed check names itself on the checks line", async () => {
    progressScript([ghJson([ghCheck("lint", "fail"), ghCheck("test", "pass")])]);
    const out = await waitForChecks("github", "b", { cwd: "/repo", timeoutMs: 600000, pollMs: 30000 });
    expect(out.outcome).toBe("failed");
    expect(
      messages()
        .find((m) => m.startsWith("CI checks:"))
        ?.endsWith("failing: lint"),
    ).toBe(true);
    expect(messages()).toContain("CI checks: 1/2 passed, 0 pending, failing: lint");
  });

  test("AC-12: a GitLab pipeline status is logged as it changes", async () => {
    const mr = (status: string): ForgeRunResult => r(JSON.stringify({ iid: 3, head_pipeline: { status } }));
    progressScript([mr("running"), mr("success")]);
    expect((await waitForChecks("gitlab", "b", { cwd: "/repo", timeoutMs: 600000, pollMs: 30000 })).outcome).toBe(
      "green",
    );
    expect(messages()).toContain("CI pipeline: running");
    expect(messages()).toContain("CI pipeline: success");
  });

  test("AC-13: an unchanged wait past the heartbeat interval reports it is still waiting", async () => {
    progressScript([TWO_CHECKS_PENDING, TWO_CHECKS_PENDING, TWO_CHECKS_PENDING, ALL_PASS], 30000);
    await waitForChecks("github", "b", { cwd: "/repo", timeoutMs: 600000, pollMs: 30000 });
    const beat = messages().find((m) => m.startsWith("CI wait: still waiting after"));
    expect(beat).toBeDefined();
    expect(beat).toContain("(CI checks: 0/2 passed, 2 pending)");
  });

  test("B3: a polling interval longer than the heartbeat still beats within 60s", async () => {
    // pollMs 300000 is the config's own upper bound; a heartbeat bound to the
    // poll would be five minutes late.
    _ciWaitDeps.schedule = () => () => {};
    progressScript([TWO_CHECKS_PENDING]);
    const out = await waitForChecks("github", "b", { cwd: "/repo", timeoutMs: 300000, pollMs: 300000 });
    expect(out.outcome).toBe("pending");
    const beats = messages().filter((m) => m.startsWith("CI wait: still waiting after"));
    expect(beats.length).toBeGreaterThan(0);
    // 60000ms virtual, formatted: the bound, not the poll interval.
    expect(beats[0]).toContain("after 1m 0s");
  });

  test("B3: a slow forge call does not suppress the heartbeat, and the schedule is cancelled", async () => {
    let heartbeat: (() => void) | undefined;
    let cancelled = 0;
    _ciWaitDeps.schedule = (fn) => {
      heartbeat = fn;
      return () => {
        cancelled += 1;
      };
    };
    let clock = 0;
    _ciWaitDeps.now = () => clock;
    _ciWaitDeps.sleep = async () => {};
    let first = true;
    _ciWaitDeps.run = async () => {
      if (first) {
        first = false;
        clock += 300000; // the forge call itself is what takes five minutes
        heartbeat?.(); // the independent schedule fires while it is still in flight
        return TWO_CHECKS_PENDING;
      }
      return ALL_PASS;
    };
    expect((await waitForChecks("github", "b", { cwd: "/repo", timeoutMs: 600000, pollMs: 30000 })).outcome).toBe(
      "green",
    );
    expect(messages().some((m) => m.startsWith("CI wait: still waiting after"))).toBe(true);
    expect(cancelled).toBe(1);
  });

  test("AC-14: a wait under 60s reports no heartbeat", async () => {
    progressScript([TWO_CHECKS_PENDING]);
    const out = await waitForChecks("github", "b", { cwd: "/repo", timeoutMs: 35000, pollMs: 10000 });
    expect(out.outcome).toBe("pending");
    expect(messages().some((m) => m.startsWith("CI wait: still waiting after"))).toBe(false);
  });

  test("AC-15: green ends the wait with the elapsed time", async () => {
    progressScript([ALL_PASS]);
    expect((await waitForChecks("github", "b", { cwd: "/repo", timeoutMs: 600000, pollMs: 30000 })).outcome).toBe(
      "green",
    );
    expect(messages().at(-1)?.startsWith("CI wait done: green after")).toBe(true);
  });

  test("AC-16: a timeout ends the wait as pending with the elapsed time", async () => {
    progressScript([TWO_CHECKS_PENDING]);
    expect((await waitForChecks("github", "b", { cwd: "/repo", timeoutMs: 35000, pollMs: 10000 })).outcome).toBe(
      "pending",
    );
    expect(messages().at(-1)?.startsWith("CI wait done: pending after")).toBe(true);
  });

  test("AC-17: with no logger installed the wait returns exactly what it did before", async () => {
    resetLogger();
    progressScript([ALL_PASS]);
    expect(await waitForChecks("github", "b", { cwd: "/repo", timeoutMs: 600000, pollMs: 30000 })).toEqual({
      outcome: "green",
      detail: "all checks passed",
    });
    expect(logs).toEqual([]);
  });

  test("progress lines carry storyId first so a parallel run can attribute them", async () => {
    progressScript([TWO_CHECKS_PENDING, ALL_PASS]);
    await waitForChecks("github", "b", { cwd: "/repo", timeoutMs: 600000, pollMs: 30000 });
    expect(logs.length).toBeGreaterThan(0);
    for (const entry of logs) expect(Object.entries(entry.data ?? {})[0]).toEqual(["storyId", "_run"]);
  });
});
