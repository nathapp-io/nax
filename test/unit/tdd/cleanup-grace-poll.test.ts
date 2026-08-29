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
