import { describe, expect, mock, test } from "bun:test";
import { makeSpawn, withDepsRestore } from "@test/helpers";
import { _cleanupDeps, CLEANUP_GRACE_POLL_INTERVAL_MS, cleanupProcessTree } from "@/tdd/cleanup";

withDepsRestore(_cleanupDeps, ["spawn", "sleep", "kill", "killProcessGroupFn"]);

// US-002: bound the cleanup grace wait via a bounded poll over
// hasLiveGroupMembers. Replaces the unconditional single sleep(gracePeriodMs)
// with a poll whose interval is CLEANUP_GRACE_POLL_INTERVAL_MS, capped at
// ceil(gracePeriodMs / CLEANUP_GRACE_POLL_INTERVAL_MS) iterations, so it
// terminates as soon as the group dies (instantly with injected sleep).

describe("CLEANUP_GRACE_POLL_INTERVAL_MS (US-002)", () => {
  // AC6 — the constant is a small positive number well under the 3000ms
  // default grace. Importing it at module load must not throw.
  test("AC-6: is a positive number strictly less than 3000", () => {
    expect(typeof CLEANUP_GRACE_POLL_INTERVAL_MS).toBe("number");
    expect(CLEANUP_GRACE_POLL_INTERVAL_MS).toBeGreaterThan(0);
    expect(CLEANUP_GRACE_POLL_INTERVAL_MS).toBeLessThan(3000);
  });
});

describe("cleanupProcessTree — bounded grace poll (US-002)", () => {
  // The first `ps -o pgid= -p PID` looks up the leader's own PGID; the
  // remaining `ps -o pid= -g PGID` calls probe group membership. The
  // handler distinguishes them by inspecting the args.
  function stubPs(opts: { pgidForLeader: string | null; groupMembers: string[] }): void {
    _cleanupDeps.spawn = makeSpawn(({ cmd }) => {
      if (cmd[1] === "-o" && cmd[2] === "pgid=") {
        return opts.pgidForLeader === null
          ? { stdout: "", stderr: "No such process\n", exitCode: 1 }
          : { stdout: `  ${opts.pgidForLeader}\n` };
      }
      if (cmd[1] === "-o" && cmd[2] === "pid=") {
        // hasLiveGroupMembers: returns true if the group has members
        const members = opts.groupMembers;
        return { stdout: members.join("\n") };
      }
      return { stdout: "" };
    }).spawn;
  }

  // AC7 — first ps reports pgid 12345, every later probe reports an empty
  // group. cleanupProcessTree must send exactly one SIGTERM and the
  // recorded sleep arguments must sum to no more than
  // CLEANUP_GRACE_POLL_INTERVAL_MS (because the first poll exits early).
  test("AC-7: early-exits on empty group after one SIGTERM, sleep ≤ CLEANUP_GRACE_POLL_INTERVAL_MS", async () => {
    stubPs({ pgidForLeader: "12345", groupMembers: [] });

    const killCalls: Array<{ pid: number; signal: string | number }> = [];
    _cleanupDeps.killProcessGroupFn = mock((pid: number, signal: string | number) => {
      killCalls.push({ pid, signal });
      return true;
    });

    const sleepArgs: number[] = [];
    _cleanupDeps.sleep = mock(async (ms: number) => {
      sleepArgs.push(ms);
    });

    await cleanupProcessTree(12345, 3000);

    // Exactly one SIGTERM, no SIGKILL — the group died before the grace window elapsed.
    expect(killCalls.length).toBe(1);
    expect(killCalls[0].signal).toBe("SIGTERM");

    // Sleep arguments summed must fit within a single poll interval — the
    // bounded poll returns as soon as the group is empty.
    expect(sleepArgs.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(CLEANUP_GRACE_POLL_INTERVAL_MS);
  });

  // AC8 — every probe reports the group still populated. cleanupProcessTree
  // must send exactly SIGTERM then SIGKILL, and call sleep at most
  // ceil(3000 / CLEANUP_GRACE_POLL_INTERVAL_MS) times.
  test("AC-8: full grace window — SIGTERM then SIGKILL, sleep count bounded by ceil(3000 / CLEANUP_GRACE_POLL_INTERVAL_MS)", async () => {
    stubPs({ pgidForLeader: "12345", groupMembers: ["12345"] });

    const killCalls: Array<{ pid: number; signal: string | number }> = [];
    _cleanupDeps.killProcessGroupFn = mock((pid: number, signal: string | number) => {
      killCalls.push({ pid, signal });
      return true;
    });

    let sleepCalls = 0;
    _cleanupDeps.sleep = mock(async () => {
      sleepCalls += 1;
    });

    await cleanupProcessTree(12345, 3000);

    // SIGTERM then SIGKILL.
    expect(killCalls.length).toBe(2);
    expect(killCalls[0].signal).toBe("SIGTERM");
    expect(killCalls[1].signal).toBe("SIGKILL");

    // Sleep count bounded by the poll-iteration cap. With injected instant
    // sleep, the poll must terminate after at most ceil(grace/interval)
    // iterations — not the full grace wall clock.
    expect(sleepCalls).toBeLessThanOrEqual(Math.ceil(3000 / CLEANUP_GRACE_POLL_INTERVAL_MS));
  });
});

// Adversarial-review follow-up: the bounded poll must not OVERSHOOT the
// requested grace window. A caller asking for 250 ms must not actually sleep
// 300 ms; a caller asking for less than the 100 ms interval must not wait
// beyond that interval. Non-finite or negative grace values must not
// infinite-loop or silently skip the grace either.
describe("cleanupProcessTree — grace overshoot / non-finite defense", () => {
  function stubPs(opts: { pgidForLeader: string | null; groupMembers: string[] }): void {
    _cleanupDeps.spawn = makeSpawn(({ cmd }) => {
      if (cmd[1] === "-o" && cmd[2] === "pgid=") {
        return opts.pgidForLeader === null
          ? { stdout: "", stderr: "No such process\n", exitCode: 1 }
          : { stdout: `  ${opts.pgidForLeader}\n` };
      }
      if (cmd[1] === "-o" && cmd[2] === "pid=") {
        return { stdout: opts.groupMembers.join("\n") };
      }
      return { stdout: "" };
    }).spawn;
  }

  // Overshoot: a grace of 50 ms (less than the 100 ms interval) must not
  // actually sleep 100 ms — every sleep argument must be ≤ gracePeriodMs.
  test("grace shorter than poll interval: sleeps ≤ gracePeriodMs, not a full interval", async () => {
    stubPs({ pgidForLeader: "12345", groupMembers: ["12345"] });

    _cleanupDeps.killProcessGroupFn = mock(() => true);

    const sleepArgs: number[] = [];
    _cleanupDeps.sleep = mock(async (ms: number) => {
      sleepArgs.push(ms);
    });

    await cleanupProcessTree(12345, 50);

    for (const ms of sleepArgs) {
      expect(ms).toBeLessThanOrEqual(50);
    }
    expect(sleepArgs.length).toBeGreaterThan(0);
  });

  // Overshoot: a non-multiple grace (250 ms) must not actually sleep 300 ms
  // — the final iteration must use the remaining budget.
  test("non-multiple grace 250ms: total sleep argument sum is ≤ 250ms", async () => {
    stubPs({ pgidForLeader: "12345", groupMembers: ["12345"] });

    _cleanupDeps.killProcessGroupFn = mock(() => true);

    const sleepArgs: number[] = [];
    _cleanupDeps.sleep = mock(async (ms: number) => {
      sleepArgs.push(ms);
    });

    await cleanupProcessTree(12345, 250);

    expect(sleepArgs.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(250);
  });

  // Non-finite defense: Infinity must not infinite-loop the poll. The call
  // must terminate. We bound the assertion via a deadline race so a real
  // hang fails the test instead of hanging the suite, and we count sleep
  // calls: under the bug (maxIterations = Math.ceil(Infinity/100) =
  // Infinity), the loop runs until the test's own rescue flips the stub to
  // empty — well beyond the ceil(3000/100) = 30 calls a clamped-default
  // graceful cleanup would make.
  test("gracePeriodMs=Infinity does not infinite-loop the poll", async () => {
    stubPs({ pgidForLeader: "12345", groupMembers: ["12345"] });

    _cleanupDeps.killProcessGroupFn = mock(() => true);

    let sleepCalls = 0;
    _cleanupDeps.sleep = mock(async () => {
      sleepCalls += 1;
      if (sleepCalls > 200) {
        // After 200 sleep calls, force the group to look empty so the poll
        // can break out. This protects the suite from an infinite loop if
        // the fix regresses.
        stubPs({ pgidForLeader: "12345", groupMembers: [] });
      }
    });

    await Promise.race([
      cleanupProcessTree(12345, Number.POSITIVE_INFINITY),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("timeout: cleanupProcessTree did not terminate")), 2000),
      ),
    ]);

    // Under the bug the rescue fires at call #201, so sleepCalls >= 201.
    // Under the fix the grace is clamped to a finite value and the loop
    // completes in at most ceil(grace/interval) calls — well under 100.
    expect(sleepCalls).toBeLessThan(200);
  });

  // Negative defense: a negative grace must not silently skip the bounded
  // wait and go straight to the kill probe (current bug — Math.ceil(-5/100)
  // = -0 and 0 < -0 is false, so the loop is skipped and the group is never
  // re-probed).
  test("negative gracePeriodMs does not silently skip the bounded wait", async () => {
    stubPs({ pgidForLeader: "12345", groupMembers: ["12345"] });

    _cleanupDeps.killProcessGroupFn = mock(() => true);

    let sleepCalls = 0;
    _cleanupDeps.sleep = mock(async () => {
      sleepCalls += 1;
    });

    await cleanupProcessTree(12345, -5);

    // Either the call falls back to the default grace (so it sleeps at
    // least once) OR it errors — it must NOT be a no-op that bypasses the
    // poll. The conservative assertion is that the poll was attempted
    // (sleep was called at least once) before the final SIGKILL probe.
    expect(sleepCalls).toBeGreaterThan(0);
  });

  // NaN defense: NaN currently produces maxIterations = Math.ceil(NaN) = NaN,
  // the loop is skipped, and the bounded wait is bypassed entirely. The
  // function must not silently skip the grace either.
  test("gracePeriodMs=NaN does not silently skip the bounded wait", async () => {
    stubPs({ pgidForLeader: "12345", groupMembers: ["12345"] });

    _cleanupDeps.killProcessGroupFn = mock(() => true);

    let sleepCalls = 0;
    _cleanupDeps.sleep = mock(async () => {
      sleepCalls += 1;
    });

    await cleanupProcessTree(12345, Number.NaN);

    expect(sleepCalls).toBeGreaterThan(0);
  });
});
