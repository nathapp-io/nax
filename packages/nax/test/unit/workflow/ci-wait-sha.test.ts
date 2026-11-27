import { afterEach, expect, test } from "bun:test";
import type { ForgeKind, ForgeRunResult } from "@/forge";
import { _ciWaitDeps, readChecksOnce, waitForChecks } from "@/workflow/ci-wait";

const saved = { ..._ciWaitDeps };
afterEach(() => Object.assign(_ciWaitDeps, saved));
const opts = { cwd: "/repo", timeoutMs: 20, pollMs: 10, expectedSha: "aaa" };

/** `gh pr view <ref> --json headRefOid` — the head-only read US-001 brackets a GitHub poll with. */
const isHeadOnly = (cmd: readonly string[]): boolean => cmd[0] === "gh" && cmd[2] === "view" && cmd[5] === "headRefOid";

/** A scripted value as the forge's answer; an `Error` is a spawn/CLI failure. */
const answer = (value: unknown): ForgeRunResult => {
  if (value instanceof Error) throw value;
  return { exitCode: 0, stderr: "", stdout: JSON.stringify(value) };
};

function wire(values: unknown[], forge = "github") {
  let clock = 0;
  let polls = 0;
  const sleeps: number[] = [];
  const calls: string[][] = [];
  _ciWaitDeps.now = () => clock;
  _ciWaitDeps.schedule = () => () => {};
  _ciWaitDeps.sleep = async (ms) => {
    clock += ms;
    sleeps.push(ms);
  };
  _ciWaitDeps.run = async (cmd) => {
    calls.push(cmd);
    if (forge === "github" && cmd[2] === "checks") {
      return { exitCode: 0, stderr: "", stdout: '[{"name":"test","bucket":"pass"}]' };
    }
    // US-001: every bound GitHub poll reads the head before its checks. The pre-read answers from
    // the value the *following* mergeability read will consume, so the bracket agrees about the
    // head — and neither the polls counted here nor the scripted outcomes move.
    if (isHeadOnly(cmd)) return answer(values[Math.min(polls, values.length - 1)]);
    const value = values[Math.min(polls++, values.length - 1)];
    return answer(value);
  };
  return { sleeps, polls: () => polls, calls };
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

// --- US-003: a failed GitLab pipeline for another commit is held back like a stale green one ---

/** The commit the previous push left in the pipeline, and the head HEAD now points at (US-003). */
const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
/** The story's options: every poll is bound to `NEW`, the pushed head. */
const headOpts = { ...opts, expectedSha: NEW };
const MR = "gitlab" satisfies ForgeKind;

test("US-003 AC-1: a stale failed GitLab pipeline waits for the current head", async () => {
  const observed = wire(
    [{ head_pipeline: { sha: OLD, status: "failed" } }, { head_pipeline: { sha: NEW, status: "success" } }],
    MR,
  );
  const result = await waitForChecks(MR, "b", headOpts);
  expect(result.outcome).toBe("green");
  expect(observed.polls()).toBe(2);
  expect(observed.sleeps).toEqual([10]);
});

test("US-003 AC-2: a stale canceled GitLab pipeline waits for the current head", async () => {
  const observed = wire(
    [{ head_pipeline: { sha: OLD, status: "canceled" } }, { head_pipeline: { sha: NEW, status: "success" } }],
    MR,
  );
  expect((await waitForChecks(MR, "b", headOpts)).outcome).toBe("green");
  expect(observed.polls()).toBe(2);
});

test("US-003 AC-3: a failed pipeline that never reports HEAD ends unavailable at the deadline", async () => {
  wire([{ head_pipeline: { sha: OLD, status: "failed" } }], MR);
  expect(await waitForChecks(MR, "b", headOpts)).toEqual({
    outcome: "unavailable",
    detail: "checks report aaaaaaaa but HEAD is bbbbbbbb",
  });
});

test("US-003 AC-4: a stale failed poll reads pipeline.sha as its commit", async () => {
  const observed = wire(
    [
      { head_pipeline: { status: "failed" }, pipeline: { sha: OLD } },
      { head_pipeline: { sha: NEW, status: "success" } },
    ],
    MR,
  );
  expect((await waitForChecks(MR, "b", headOpts)).outcome).toBe("green");
  expect(observed.polls()).toBe(2);
});

test("US-003 AC-5: a failed pipeline for the current head ends the wait at once", async () => {
  const observed = wire([{ head_pipeline: { sha: NEW, status: "failed" } }], MR);
  expect(await waitForChecks(MR, "b", headOpts)).toEqual({ outcome: "failed", detail: "a check failed" });
  expect(observed.polls()).toBe(1);
});

test("US-003 AC-6: a failed pipeline reporting no commit still ends the wait at once", async () => {
  const observed = wire([{ head_pipeline: { status: "failed" } }], MR);
  expect((await waitForChecks(MR, "b", headOpts)).outcome).toBe("failed");
  expect(observed.polls()).toBe(1);
});

test("US-003 AC-7: without an expected head a stale failed poll still ends the wait", async () => {
  const observed = wire([{ head_pipeline: { sha: OLD, status: "failed" } }], MR);
  const { expectedSha: _unused, ...noHead } = headOpts;
  expect((await waitForChecks(MR, "b", noHead)).outcome).toBe("failed");
  expect(observed.polls()).toBe(1);
});

// --- US-001: GitHub checks are bound to the head they were read for ---

/** The head the checks were read for, and the head the caller expects them for (US-001). */
const CHECKED = "a".repeat(40);
const EXPECTED = "b".repeat(40);
/** One read of the PR's checks, bound to `EXPECTED`; and one bound wait over the same head. */
const once = { cwd: "/repo", expectedSha: EXPECTED };
const waitFor = { cwd: "/repo", timeoutMs: 20, pollMs: 10, expectedSha: EXPECTED };

const PASSING: ForgeRunResult = {
  exitCode: 0,
  stderr: "",
  stdout: '[{"name":"test","state":"SUCCESS","bucket":"pass"}]',
};
const FAILING: ForgeRunResult = {
  exitCode: 1,
  stderr: "",
  stdout: '[{"name":"test","state":"FAILURE","bucket":"fail"}]',
};

/** A scripted head-only read: a SHA, `null` for a reply without `headRefOid`, or a raw result. */
type HeadReply = string | ForgeRunResult | null;

const headReply = (reply: HeadReply): ForgeRunResult => {
  if (reply === null) return { exitCode: 0, stderr: "", stdout: "{}" };
  if (typeof reply === "string") return { exitCode: 0, stderr: "", stdout: JSON.stringify({ headRefOid: reply }) };
  return reply;
};

/**
 * The US-001 forge: the head-only reads answer from `heads` (the last repeats), the mergeability read
 * reports `checkHead`, and `gh pr checks` answers `checks` (all-pass by default) on a fake clock.
 * `headReads()` is only the head-only reads, so a test can count the bracket's own reads.
 */
function wireBracket(spec: {
  readonly heads: readonly HeadReply[];
  readonly checkHead?: string;
  readonly checks?: ForgeRunResult;
}) {
  let clock = 0;
  let polls = 0;
  let headRead = 0;
  const sleeps: number[] = [];
  const calls: string[][] = [];
  _ciWaitDeps.now = () => clock;
  _ciWaitDeps.schedule = () => () => {};
  _ciWaitDeps.sleep = async (ms) => {
    clock += ms;
    sleeps.push(ms);
  };
  _ciWaitDeps.run = async (cmd) => {
    calls.push(cmd);
    if (cmd[2] === "checks") {
      polls += 1;
      return spec.checks ?? PASSING;
    }
    if (isHeadOnly(cmd)) return headReply(spec.heads[Math.min(headRead++, spec.heads.length - 1)]);
    const mergeable = {
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      baseRefName: "main",
      ...(spec.checkHead === undefined ? {} : { headRefOid: spec.checkHead }),
    };
    return { exitCode: 0, stderr: "", stdout: JSON.stringify(mergeable) };
  };
  return { calls, sleeps, polls: () => polls, headReads: () => calls.filter(isHeadOnly) };
}

test("US-001 AC-1: a head that moves between the checks and the mergeability read is pending, not green", async () => {
  const seen = wireBracket({ heads: [CHECKED, EXPECTED], checkHead: EXPECTED });
  expect(await readChecksOnce("github", "7", once)).toEqual({
    outcome: "pending",
    detail: "CI checks: 1/1 passed, 0 pending",
  });
  // The bracket ends at the head the mergeability read reports, so a green poll needs no second read.
  expect(seen.headReads()).toHaveLength(1);
});

test("US-001 AC-2: a moved head makes the wait poll again, and the next poll is green", async () => {
  const seen = wireBracket({ heads: [CHECKED, EXPECTED], checkHead: EXPECTED });
  expect(await waitForChecks("github", "7", waitFor)).toEqual({ outcome: "green", detail: "all checks passed" });
  expect(seen.polls()).toBe(2);
  expect(seen.sleeps).toEqual([10]);
});

test("US-001 AC-3: a head that never agrees with its checks ends unavailable, naming the move", async () => {
  const seen = wireBracket({ heads: [CHECKED], checkHead: EXPECTED });
  expect(await waitForChecks("github", "7", waitFor)).toEqual({
    outcome: "unavailable",
    detail: "the PR head moved from aaaaaaaa to bbbbbbbb while its checks were read",
  });
  expect(seen.polls()).toBeGreaterThan(1);
});

test("US-001 AC-4 (control): every head read agreeing on this head is green", async () => {
  const seen = wireBracket({ heads: [EXPECTED], checkHead: EXPECTED });
  expect(await readChecksOnce("github", "7", once)).toEqual({
    outcome: "green",
    detail: "CI checks: 1/1 passed, 0 pending; checks: test (pass)",
  });
  expect(seen.headReads()).toHaveLength(1);
});

test("US-001 AC-5 (control): a head that never moves off a keeps the existing mismatch detail", async () => {
  wireBracket({ heads: [CHECKED], checkHead: CHECKED });
  expect(await readChecksOnce("github", "7", once)).toEqual({
    outcome: "unavailable",
    detail: "checks report aaaaaaaa but HEAD is bbbbbbbb",
  });
});

test("US-001 AC-6 (control): a pre-read that exits non-zero fails open to green", async () => {
  const seen = wireBracket({ heads: [{ exitCode: 1, stderr: "gh: auth required", stdout: "" }], checkHead: EXPECTED });
  expect((await readChecksOnce("github", "7", once)).outcome).toBe("green");
  expect(seen.headReads()).toHaveLength(1);
});

test("US-001 AC-7 (control): a wait without an expected head never reads the head alone", async () => {
  const seen = wire([{ headRefOid: EXPECTED }]);
  const { expectedSha: _unused, ...noHead } = waitFor;
  expect((await waitForChecks("github", "7", noHead)).outcome).toBe("green");
  expect(seen.calls.filter(isHeadOnly)).toEqual([]);
});

test("US-001 AC-8 (control): a GitLab wait with an expected head issues no gh command", async () => {
  const seen = wire([{ head_pipeline: { status: "success", sha: EXPECTED } }], MR);
  expect((await waitForChecks(MR, "7", waitFor)).outcome).toBe("green");
  expect(seen.calls.filter((cmd) => cmd[0] === "gh")).toEqual([]);
});

test("US-001 AC-9: a failing read for a head that has moved is pending, not failed", async () => {
  const seen = wireBracket({ heads: [CHECKED, EXPECTED], checkHead: EXPECTED, checks: FAILING });
  expect(await readChecksOnce("github", "7", once)).toEqual({
    outcome: "pending",
    detail: "CI checks: 0/1 passed, 0 pending, failing: test",
  });
  // A failed poll carries no head of its own, so the bracket ends with its own head-only read.
  expect(seen.headReads()).toHaveLength(2);
});

test("US-001 AC-10 (control): a push-mode wait reads the checks before anything else", async () => {
  const seen = wire([{ headRefOid: EXPECTED }]);
  expect((await waitForChecks("github", "7", { ...waitFor, commitChecks: true })).outcome).toBe("green");
  expect(seen.calls[0]).toEqual(["gh", "pr", "checks", "7", "--json", "name,state,bucket,link"]);
  expect(seen.calls.filter(isHeadOnly)).toEqual([]);
});

test("US-001 AC-11 (control): an unparseable pre-read fails open to green", async () => {
  const seen = wireBracket({ heads: [{ exitCode: 0, stderr: "", stdout: "not-json" }], checkHead: EXPECTED });
  expect((await readChecksOnce("github", "7", once)).outcome).toBe("green");
  expect(seen.headReads()).toHaveLength(1);
});

// --- US-004: a SHA-less green poll takes the stable head its bracket recovered ---

type Head = string | Error;
const PASS = '[{"name":"test","bucket":"pass"}]';

/** Independently scripted head-only reads (before/after), checks and mergeability. */
function wireHeads(script: {
  readonly heads: (readIndex: number) => Head;
  readonly merge?: Record<string, unknown> | Error;
}) {
  let clock = 0;
  let headReads = 0;
  _ciWaitDeps.now = () => clock;
  _ciWaitDeps.schedule = () => () => {};
  _ciWaitDeps.sleep = async (ms) => {
    clock += ms;
  };
  _ciWaitDeps.run = async (cmd) => {
    if (cmd[2] === "checks") return { exitCode: 0, stderr: "", stdout: PASS };
    if (isHeadOnly(cmd)) {
      const head = script.heads(headReads++);
      return answer(head instanceof Error ? head : { headRefOid: head });
    }
    return answer(script.merge ?? {});
  };
  return { headReads: () => headReads };
}
const B = "b".repeat(40);
const A = "a".repeat(40);
const bOpts = { ...opts, expectedSha: B };

test("US-004 AC-1: A/A bracket with no inline SHA does not satisfy expected B", async () => {
  wireHeads({ heads: () => A });
  expect(await waitForChecks("github", "b", bOpts)).toEqual({
    outcome: "unavailable",
    detail: `checks report ${A.slice(0, 8)} but HEAD is ${B.slice(0, 8)}`,
  });
});

test("US-004 AC-2: A/A bracket with rejected mergeability read still refuses green for B", async () => {
  wireHeads({ heads: () => A, merge: new Error("view failed") });
  const result = await waitForChecks("github", "b", bOpts);
  expect(result.outcome).toBe("unavailable");
  expect(result.detail).toContain("but HEAD is");
});

test("US-004 AC-4: a different inline SHA throughout the wait is unavailable", async () => {
  wireHeads({ heads: () => B, merge: { headRefOid: A } });
  expect((await waitForChecks("github", "b", bOpts)).outcome).toBe("unavailable");
});

test.each([A, B])("US-004 AC-5: an A then B bracket is never green (expected %p)", async (expectedSha) => {
  wireHeads({ heads: (i) => (i % 2 === 0 ? A : B) });
  const result = await waitForChecks("github", "b", { ...opts, expectedSha });
  expect(result.outcome).toBe("unavailable");
  expect(result.detail).toContain("the PR head moved from");
});

test("US-004 AC-6: no inline and no readable head stays green", async () => {
  wireHeads({ heads: () => ({}) as unknown as Head, merge: {} });
  expect((await waitForChecks("github", "b", bOpts)).outcome).toBe("green");
});

test("US-004 AC-7: readChecksOnce keeps its final lookup (A/A bracket, final B) green for B", async () => {
  // reads 0,1 = bracket (A/A); read 2 = readChecksOnce's own final lookup.
  wireHeads({ heads: (i) => (i < 2 ? A : B) });
  const result = await readChecksOnce("github", "b", { cwd: "/repo", expectedSha: B });
  expect(result.outcome).toBe("green");
});

test("US-004 AC-8: one unreadable bracket endpoint and no inline SHA stays green", async () => {
  wireHeads({ heads: (i) => (i === 0 ? A : new Error("head failed")) });
  expect((await waitForChecks("github", "b", bOpts)).outcome).toBe("green");
});
