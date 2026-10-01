import { describe, expect, mock, test } from "bun:test";
import { _storyOrchestratorDeps, refreshReviewInputForDispatch } from "@/execution";

/**
 * #1668 — `checkFindingEvidence` resolves a finding's file against `repoRoot`
 * first, falling back to `workdir` as a package-relative path. Review findings
 * carry repo-root-relative paths, so in a monorepo — where `workdir` is the
 * package dir — a missing `repoRoot` makes every lookup double-count the package
 * prefix, return "unreadable", and fail open.
 *
 * `plan-inputs-review-wiring.test.ts` guards `repoRoot` being SET on the inputs;
 * those tests fail on the pre-fix code. These guard the value surviving
 * `refreshReviewInputForDispatch`'s **catch path**, which rebuilds the input by
 * destructuring `_refresh` off and returning the rest. That branch is otherwise
 * unexercised for field preservation, and it is the one a future refactor is
 * most likely to rewrite field-by-field — which would drop `repoRoot` and
 * silently restore the fail-open on exactly the runs where the refresh already
 * failed.
 */
describe("review input repoRoot — refresh failure path (#1668)", () => {
  const STALE = {
    workdir: "/tmp/repo/packages/api",
    repoRoot: "/tmp/repo",
    story: { id: "US-x" },
    mode: "ref" as const,
    stat: "",
    storyGitRef: "stale-ref",
    excludePatterns: [],
    _refresh: { projectDir: "/tmp/repo", storyId: "US-x", storyGitRef: "stale-ref" },
  };

  test("semantic-review keeps repoRoot when the refresh throws", async () => {
    const orig = _storyOrchestratorDeps.prepareSemanticReviewInput;
    _storyOrchestratorDeps.prepareSemanticReviewInput = mock(async () => {
      throw new Error("git unavailable");
    }) as typeof _storyOrchestratorDeps.prepareSemanticReviewInput;

    try {
      const out = (await refreshReviewInputForDispatch("semantic-review", {
        ...STALE,
        semanticConfig: { diffMode: "ref" },
      })) as Record<string, unknown>;
      expect(out.repoRoot).toBe("/tmp/repo");
      expect(out.repoRoot).not.toBe(out.workdir);
      // _refresh must still be stripped on the fallback.
      expect(out._refresh).toBeUndefined();
    } finally {
      _storyOrchestratorDeps.prepareSemanticReviewInput = orig;
    }
  });

  test("adversarial-review keeps repoRoot when the refresh throws", async () => {
    const orig = _storyOrchestratorDeps.prepareAdversarialReviewInput;
    _storyOrchestratorDeps.prepareAdversarialReviewInput = mock(async () => {
      throw new Error("git unavailable");
    }) as typeof _storyOrchestratorDeps.prepareAdversarialReviewInput;

    try {
      const out = (await refreshReviewInputForDispatch("adversarial-review", {
        ...STALE,
        adversarialConfig: { diffMode: "ref" },
      })) as Record<string, unknown>;
      expect(out.repoRoot).toBe("/tmp/repo");
      expect(out.repoRoot).not.toBe(out.workdir);
      expect(out._refresh).toBeUndefined();
    } finally {
      _storyOrchestratorDeps.prepareAdversarialReviewInput = orig;
    }
  });
});
