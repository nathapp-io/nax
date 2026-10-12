import { afterEach, describe, expect, test } from "bun:test";
import type { ForgeRunResult } from "@/forge";
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
