import { describe, expect, test } from "bun:test";
import { buildCommitRound, commitRoundOutcome } from "@flows/nax-finish/steps/commit-round";

const NOW = "2026-08-08T05:00:00.000Z";
const base = {
  phase: "gate" as const,
  attempt: 1,
  committed: true,
  route: "changed",
  findings: [],
  now: NOW,
};

describe("commitRoundOutcome", () => {
  test("a review phase's fix round is `fixed`", () => {
    expect(commitRoundOutcome("spec", "changed")).toBe("fixed");
    expect(commitRoundOutcome("quality", "changed")).toBe("fixed");
  });

  // Every gate round that commits is now routed on to review_quality (#1510),
  // so `changed` and `tests-only` describe what the fix touched, not whether
  // anyone looked at it. Both therefore carry the same outcome.
  test("a gate fix routed on to the re-review is `no-reviewer`", () => {
    expect(commitRoundOutcome("gate", "changed")).toBe("no-reviewer");
  });

  // Regression for #1510: this returned `review-skipped` while `tests-only`
  // bypassed the reviewer. It no longer does, and a round that claims a review
  // was skipped when one actually ran misleads exactly as `no-reviewer` did
  // before #1507.
  test("a tests-only gate fix is re-reviewed, so it is not marked skipped", () => {
    expect(commitRoundOutcome("gate", "tests-only")).toBe("no-reviewer");
  });

  test("a gate fix that committed nothing is not marked skipped — nothing was owed", () => {
    expect(commitRoundOutcome("gate", "unchanged")).toBe("no-reviewer");
  });

  test("acceptance has no reviewer to skip", () => {
    expect(commitRoundOutcome("acceptance", "tests-only")).toBe("no-reviewer");
    expect(commitRoundOutcome("acceptance", "changed")).toBe("no-reviewer");
  });
});

describe("buildCommitRound", () => {
  test("carries the post-commit sha when there was a commit", () => {
    expect(buildCommitRound({ ...base, shaAfter: "deadbeef" }).sha).toBe("deadbeef");
  });

  // Absence is load-bearing: it is how a reader of the JSONL tells "no commit"
  // from "record lost", so it must never be spelled null or undefined.
  test("omits sha entirely when nothing was committed", () => {
    const round = buildCommitRound({ ...base, committed: false, shaAfter: "deadbeef" });
    expect(round).not.toHaveProperty("sha");
  });

  test("omits sha when the commit happened but HEAD would not resolve", () => {
    expect(buildCommitRound({ ...base, shaAfter: null })).not.toHaveProperty("sha");
  });

  test("omits failing for phases that have no gate commands", () => {
    expect(buildCommitRound({ ...base, phase: "spec" })).not.toHaveProperty("failing");
  });

  test("records an empty failing list as present, distinguishing it from a non-gate phase", () => {
    expect(buildCommitRound({ ...base, failing: [] }).failing).toEqual([]);
  });

  test("passes through the round's identity fields unchanged", () => {
    const round = buildCommitRound({ ...base, phase: "quality", attempt: 3, route: "changed" });
    expect(round).toMatchObject({ ts: NOW, phase: "quality", attempt: 3, committed: true });
  });
});
