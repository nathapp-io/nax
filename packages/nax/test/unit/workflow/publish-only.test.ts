import { describe, expect, test } from "bun:test";
import { newFeatureRecord } from "@/workflow/feature-record";
import { isTransientDraft, type PublishOnlyStart, publishedAtHead, publishOnlyStart } from "@/workflow/publish-only";
import type { WorkflowFeatureRecord } from "@/workflow/types";

function finished(over: Partial<WorkflowFeatureRecord> = {}): WorkflowFeatureRecord {
  return {
    ...newFeatureRecord({ now: "t", seed: "s", minors: [] }),
    step: "done",
    head: "headX",
    outcome: "local-only",
    ...over,
  };
}

describe("publishOnlyStart (#2819)", () => {
  test("a feature with no workflow run is refused", () => {
    const start = publishOnlyStart(null, "headX");
    expect(start).toEqual({ kind: "refused", reason: expect.stringContaining("no finished workflow run") });
  });

  test("a workflow that stopped before done is refused and points at nax run", () => {
    const start = publishOnlyStart(finished({ step: "branch-fix" }), "headX");
    expect(start).toEqual({ kind: "refused", reason: expect.stringContaining("stopped at branch-fix") });
  });

  test("a HEAD that moved since the workflow finished is refused", () => {
    const start = publishOnlyStart(finished(), "headY");
    expect(start).toEqual({ kind: "refused", reason: expect.stringContaining("HEAD moved") });
  });

  test("an unreadable HEAD is refused rather than trusted", () => {
    expect(publishOnlyStart(finished(), undefined).kind).toBe("refused");
  });

  test.each(["ready", "draft"] as const)("a %s PR has nothing left to publish", (outcome) => {
    expect(publishOnlyStart(finished({ outcome, url: "https://x/pull/1" }), "headX")).toEqual({
      kind: "published",
    });
  });

  test.each(["local-only", "pushed"] as const)("a %s run resumes its own record at publish", (outcome) => {
    const prior = finished({ outcome, reasons: ["publish disabled"] });
    const start = publishOnlyStart(prior, "headX");
    expect(start).toEqual({ kind: "resume", record: { ...prior, step: "publish" } });
  });
});

/**
 * US-001 (run-start-baseline-fixes): the HEAD-moved refusal names the commits
 * between the recorded head and HEAD. A run that ended on a `nax` auto-commit
 * (the run-summary commit completion writes) is the common case, and the caller
 * needs to know that re-running would re-review nothing but bookkeeping. Every
 * decision stays exactly as it was — only the text changes.
 */
describe("publishOnlyStart — HEAD-moved refusal names the moving commits", () => {
  const AUTO = { sha: "abc1234", subject: "chore(f): auto-commit after run-summary session" };
  const movedRefusal = (reason: string): PublishOnlyStart => ({ kind: "refused", reason });

  function prior(over: Partial<WorkflowFeatureRecord> = {}): WorkflowFeatureRecord {
    return finished({ outcome: "ready", head: "h1", ...over });
  }

  test("AC-10: an all-auto-commit move says so, and what the record still describes", () => {
    expect(publishOnlyStart(prior(), "h2", [AUTO])).toEqual(
      movedRefusal(
        "HEAD moved since the workflow finished, by nax auto-commits only (abc1234 chore(f): auto-commit after run-summary session); the recorded review, gates and items describe h1, and nax run would review the whole branch again",
      ),
    );
  });

  test("AC-11: the all-auto-commit text names the published PR when the record has one", () => {
    const start = publishOnlyStart(prior({ url: "https://x/pull/7" }), "h2", [AUTO]);
    expect(start.kind).toBe("refused");
    expect(start.kind === "refused" ? start.reason : "").toEndWith("; the published PR is https://x/pull/7");
  });

  test("AC-12: one real commit among them keeps the request to re-run", () => {
    const moved = [AUTO, { sha: "def5678", subject: "fix: real change" }];
    expect(publishOnlyStart(prior(), "h2", moved)).toEqual(
      movedRefusal(
        "HEAD moved since the workflow finished (abc1234 chore(f): auto-commit after run-summary session, def5678 fix: real change); run nax run so the new commits are reviewed",
      ),
    );
  });

  test("AC-13: a long list names the first five and counts the rest", () => {
    const moved = Array.from({ length: 7 }, (_, i) => ({ sha: `sha${i}`, subject: `fix: change ${i}` }));
    const start = publishOnlyStart(prior(), "h2", moved);
    const reason = start.kind === "refused" ? start.reason : "";
    expect(reason).toContain(
      "HEAD moved since the workflow finished (sha0 fix: change 0, sha1 fix: change 1, sha2 fix: change 2, sha3 fix: change 3, sha4 fix: change 4, and 2 more)",
    );
  });

  test("AC-14: with no lookup the text is exactly today's", () => {
    expect(publishOnlyStart(prior(), "h2")).toEqual(
      movedRefusal("HEAD moved since the workflow finished; run nax run so the new commits are reviewed"),
    );
  });

  test("AC-15: an empty lookup is the same as no lookup", () => {
    expect(publishOnlyStart(prior(), "h2", [])).toEqual(
      movedRefusal("HEAD moved since the workflow finished; run nax run so the new commits are reviewed"),
    );
  });

  test("AC-16: a matching HEAD still publishes, whatever the lookup found", () => {
    expect(publishOnlyStart(prior(), "h1", [{ sha: "abc1234", subject: "fix: x" }])).toEqual({ kind: "published" });
  });
});

/** The record a publish-only run would skip at: `done`, at `head`, published as `outcome`. */
function recorded(over: Partial<WorkflowFeatureRecord> = {}): WorkflowFeatureRecord {
  return {
    ...newFeatureRecord({ now: "t", seed: "s", minors: [] }),
    step: "done",
    head: "h1",
    outcome: "draft",
    url: "https://x/pull/7",
    ci: "green",
    reasons: [],
    ...over,
  };
}

describe("publishedAtHead (US-002)", () => {
  test("AC-1 a draft PR at the same HEAD is already published", () => {
    expect(publishedAtHead(recorded(), "h1")).toEqual({ outcome: "draft", url: "https://x/pull/7" });
  });

  test("AC-2 a ready PR at the same HEAD is already published", () => {
    expect(publishedAtHead(recorded({ outcome: "ready" }), "h1")).toEqual({
      outcome: "ready",
      url: "https://x/pull/7",
    });
  });

  test("AC-3 a record left at a different HEAD publishes something", () => {
    expect(publishedAtHead(recorded({ head: "h1" }), "h2")).toBeUndefined();
  });

  test("AC-4 an unreadable or empty HEAD is never an already-published HEAD", () => {
    expect(publishedAtHead(recorded({ head: "h1" }), undefined)).toBeUndefined();
    expect(publishedAtHead(recorded({ head: "h1" }), "")).toBeUndefined();
  });

  test("AC-5 no prior record publishes something", () => {
    expect(publishedAtHead(null, "h1")).toBeUndefined();
  });

  test("AC-6 a run that stopped before done publishes something", () => {
    expect(publishedAtHead(recorded({ step: "publish", head: "h1" }), "h1")).toBeUndefined();
  });

  test("AC-7 a run that published no PR has nothing published at that HEAD", () => {
    expect(publishedAtHead(recorded({ outcome: "local-only", head: "h1" }), "h1")).toBeUndefined();
  });

  test("AC-8 a transient draft is republished, not skipped", () => {
    expect(
      publishedAtHead(recorded({ outcome: "draft", ci: "unavailable", head: "h1", reasons: [] }), "h1"),
    ).toBeUndefined();
  });

  test("a record with no url names no PR", () => {
    expect(publishedAtHead(recorded({ url: undefined }), "h1")).toEqual({ outcome: "draft" });
  });
});

describe("isTransientDraft (US-002)", () => {
  test("AC-9 a pending CI as the draft's only reason is transient", () => {
    const prior = recorded({ outcome: "draft", ci: "pending", reasons: ["CI pending"] });
    expect(isTransientDraft(prior)).toBe(true);
  });

  test("AC-9 a draft held by open items is not transient", () => {
    const prior = recorded({ outcome: "draft", ci: "green", reasons: ["open items"] });
    expect(isTransientDraft(prior)).toBe(false);
  });
});
