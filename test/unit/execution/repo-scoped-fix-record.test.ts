/**
 * deriveRepoScopedFixes — visibility for repo-scoped repairs (#1658).
 *
 * When `repo-scoped-test-fix` (#1654) dispatches, the agent may edit files
 * outside the story's scope and those edits land in the story's commit. Nothing
 * previously said so: a reviewer seeing an unrelated file in the diff had no
 * explanation for it, and a run where the fallthrough fired, failed, and the
 * story passed anyway on the verifier-SSOT carve-out was indistinguishable from
 * a run where nothing happened.
 *
 * The derivation is pure over the cycle's own iteration records — no new
 * plumbing through the fix cycle.
 */

import { describe, expect, test } from "bun:test";
import { deriveRepoScopedFixes, recordRepoScopedFixes } from "@/execution";
import type { Finding, Iteration } from "@/findings";
import type { RepoScopedFixRecord } from "@/execution";
import { makeStory } from "@test/helpers";

const REPO_SCOPED = "repo-scoped-test-fix";
const STORY_SCOPED = "full-suite-rectify";

function failedTest(file: string, rule: string): Finding {
  return { source: "test-runner", severity: "error", category: "failed-test", file, rule, message: `${rule} failed` };
}

function iteration(overrides: Partial<Iteration<Finding>> & Pick<Iteration<Finding>, "iterationNum">): Iteration<Finding> {
  return {
    findingsBefore: [],
    findingsAfter: [],
    fixesApplied: [],
    outcome: "unchanged",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    ...overrides,
  };
}

const declined = iteration({
  iterationNum: 1,
  findingsBefore: [failedTest("test/legacy/auth.spec.ts", "redirects to login")],
  findingsAfter: [failedTest("test/legacy/auth.spec.ts", "redirects to login")],
  fixesApplied: [
    {
      strategyName: STORY_SCOPED,
      op: "full-suite-rectify",
      targetFiles: [],
      summary: "",
      unresolved: "test/legacy/auth.spec.ts is outside this story's scope",
    },
  ],
});

function repoScopedIteration(filesChanged: string[], findingsAfter: Finding[]): Iteration<Finding> {
  return iteration({
    iterationNum: 2,
    findingsBefore: [failedTest("test/legacy/auth.spec.ts", "redirects to login")],
    findingsAfter,
    fixesApplied: [
      { strategyName: REPO_SCOPED, op: "full-suite-rectify", targetFiles: filesChanged, summary: "fixed" },
    ],
  });
}

describe("deriveRepoScopedFixes", () => {
  test("returns nothing when the repo-scoped strategy never dispatched", () => {
    expect(deriveRepoScopedFixes([declined])).toEqual([]);
  });

  test("records the files the dispatch changed", () => {
    const records = deriveRepoScopedFixes([declined, repoScopedIteration(["src/legacy/auth.ts"], [])]);
    expect(records).toHaveLength(1);
    expect(records[0]?.filesChanged).toEqual(["src/legacy/auth.ts"]);
  });

  test("names the failing tests that triggered it, so an unrelated file in the diff has a cause", () => {
    const records = deriveRepoScopedFixes([declined, repoScopedIteration(["src/legacy/auth.ts"], [])]);
    expect(records[0]?.triggeringTests).toEqual(["test/legacy/auth.spec.ts::redirects to login"]);
  });

  test("carries the reason the story-scoped rectifier declined", () => {
    const records = deriveRepoScopedFixes([declined, repoScopedIteration(["src/legacy/auth.ts"], [])]);
    expect(records[0]?.declinedReason).toBe("test/legacy/auth.spec.ts is outside this story's scope");
  });

  test("reports whether the findings were gone afterwards", () => {
    const cleared = deriveRepoScopedFixes([declined, repoScopedIteration(["src/legacy/auth.ts"], [])]);
    expect(cleared[0]?.findingsCleared).toBe(true);

    const stillRed = deriveRepoScopedFixes([
      declined,
      repoScopedIteration([], [failedTest("test/legacy/auth.spec.ts", "redirects to login")]),
    ]);
    expect(stillRed[0]?.findingsCleared).toBe(false);
  });

  test("findingsCleared does not imply the dispatch fixed anything", () => {
    // The verifier-SSOT carve-out drops a gate finding when the verifier passed,
    // which empties the cycle's findings without anything being repaired. The
    // record must not call that a fix — `filesChanged` is the honest signal, and
    // an empty one means nothing was touched.
    const carvedOut = deriveRepoScopedFixes([declined, repoScopedIteration([], [])]);
    expect(carvedOut[0]?.findingsCleared).toBe(true);
    expect(carvedOut[0]?.filesChanged).toEqual([]);
  });

  test("survives a cycle result whose iterations omit the arrays the type requires", () => {
    // Plugin-supplied and stubbed cycle results arrive with fields the type
    // declares required. This runs on the exit path of a story that may
    // otherwise have succeeded, so it must not throw.
    // The cast is the point of the test: it constructs the exact shape the type
    // forbids and production nonetheless receives.
    const raw = [{ iterationNum: 1 }, { iterationNum: 2, fixesApplied: [{ strategyName: REPO_SCOPED }] }];
    const partial = raw as unknown as Iteration<Finding>[]; // test-ratchet-allow: as-unknown-as
    expect(() => deriveRepoScopedFixes(partial)).not.toThrow();
    const records = deriveRepoScopedFixes(partial);
    expect(records).toHaveLength(1);
    expect(records[0]?.triggeringTests).toEqual([]);
  });

  test("reports each dispatch when the strategy ran more than once", () => {
    const records = deriveRepoScopedFixes([
      declined,
      repoScopedIteration(["src/a.ts"], [failedTest("test/legacy/auth.spec.ts", "redirects to login")]),
      { ...repoScopedIteration(["src/b.ts"], []), iterationNum: 3 },
    ]);
    expect(records.map((r) => r.filesChanged)).toEqual([["src/a.ts"], ["src/b.ts"]]);
  });

  test("takes the decline reason from the nearest preceding give-up, not any earlier one", () => {
    const earlier = iteration({
      iterationNum: 1,
      fixesApplied: [
        { strategyName: STORY_SCOPED, op: "o", targetFiles: [], summary: "", unresolved: "an older refusal" },
      ],
    });
    const nearer = iteration({
      iterationNum: 2,
      fixesApplied: [
        { strategyName: STORY_SCOPED, op: "o", targetFiles: [], summary: "", unresolved: "the refusal that mattered" },
      ],
    });
    const records = deriveRepoScopedFixes([earlier, nearer, { ...repoScopedIteration([], []), iterationNum: 3 }]);
    expect(records[0]?.declinedReason).toBe("the refusal that mattered");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// recordRepoScopedFixes — US-002 mapping from run-time RepoScopedFixRecord
// to the on-disk PersistedRepoScopedFix.
// ─────────────────────────────────────────────────────────────────────────────

function makeRecord(overrides: Partial<RepoScopedFixRecord> = {}): RepoScopedFixRecord {
  return {
    triggeringTests: ["test/legacy/auth.spec.ts::redirects to login"],
    filesChanged: ["src/legacy/auth.ts"],
    findingsCleared: true,
    ...overrides,
  };
}

describe("recordRepoScopedFixes (US-002)", () => {
  test("AC1: maps one record onto a story whose repoScopedFixes is undefined", () => {
    const story = makeStory();

    recordRepoScopedFixes(story, [makeRecord()]);

    expect(story.repoScopedFixes).toEqual([
      {
        triggeringTests: ["test/legacy/auth.spec.ts::redirects to login"],
        filesChanged: ["src/legacy/auth.ts"],
        findingsCleared: true,
      },
    ]);
  });

  test("AC2: omits declinedReason from the persisted entry", () => {
    const story = makeStory();

    recordRepoScopedFixes(story, [makeRecord({ declinedReason: "gave up" })]);

    expect(story.repoScopedFixes).toHaveLength(1);
    expect(Object.keys(story.repoScopedFixes?.[0] ?? {}).sort()).toEqual(
      ["filesChanged", "findingsCleared", "triggeringTests"],
    );
  });

  test("AC3: preserves source order across two records", () => {
    const story = makeStory();
    const first = makeRecord({
      triggeringTests: ["a.test.ts::t1"],
      filesChanged: ["src/a.ts"],
      findingsCleared: false,
    });
    const second = makeRecord({
      triggeringTests: ["b.test.ts::t2"],
      filesChanged: ["src/b.ts"],
      findingsCleared: true,
    });

    recordRepoScopedFixes(story, [first, second]);

    expect(story.repoScopedFixes).toHaveLength(2);
    expect(story.repoScopedFixes?.[0]?.filesChanged).toEqual(["src/a.ts"]);
    expect(story.repoScopedFixes?.[1]?.filesChanged).toEqual(["src/b.ts"]);
  });

  test("AC4: appends after the existing entry when the story already has repoScopedFixes", () => {
    const story = makeStory({
      repoScopedFixes: [
        {
          triggeringTests: ["existing.test.ts::legacy"],
          filesChanged: ["src/existing.ts"],
          findingsCleared: true,
        },
      ],
    });
    const next = makeRecord({
      triggeringTests: ["new.test.ts::fresh"],
      filesChanged: ["src/new.ts"],
      findingsCleared: false,
    });

    recordRepoScopedFixes(story, [next]);

    expect(story.repoScopedFixes).toHaveLength(2);
    expect(story.repoScopedFixes?.[0]?.filesChanged).toEqual(["src/existing.ts"]);
    expect(story.repoScopedFixes?.[1]?.filesChanged).toEqual(["src/new.ts"]);
  });

  test("AC5: empty records is a no-op when story has no repoScopedFixes", () => {
    const story = makeStory();

    recordRepoScopedFixes(story, []);

    expect(story.repoScopedFixes).toBeUndefined();
  });

  test("AC5b: empty records leaves an existing array untouched", () => {
    const existing = {
      triggeringTests: ["existing.test.ts::legacy"],
      filesChanged: ["src/existing.ts"],
      findingsCleared: true,
    };
    const story = makeStory({ repoScopedFixes: [existing] });

    recordRepoScopedFixes(story, []);

    expect(story.repoScopedFixes).toEqual([existing]);
  });

  test("AC6: undefined records is a no-op when story has no repoScopedFixes", () => {
    const story = makeStory();

    recordRepoScopedFixes(story, undefined);

    expect(story.repoScopedFixes).toBeUndefined();
  });

  test("AC7: returns undefined synchronously", () => {
    const story = makeStory();

    const result = recordRepoScopedFixes(story, [makeRecord()]);

    expect(result).toBeUndefined();
  });
});

describe("recordRepoScopedFixes — barrel export", () => {
  test("AC8: typeof recordRepoScopedFixes from @/execution is 'function'", () => {
    expect(typeof recordRepoScopedFixes).toBe("function");
  });
});
