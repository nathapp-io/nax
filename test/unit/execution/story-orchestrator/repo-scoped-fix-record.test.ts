/**
 * recordRepoScopedFixes — US-002 mapping from run-time RepoScopedFixRecord
 * to the on-disk PersistedRepoScopedFix.
 *
 * Mirrors src/execution/story-orchestrator/repo-scoped-fix-record.ts.
 */

import { describe, expect, test } from "bun:test";
import { recordRepoScopedFixes } from "@/execution";
import type { RepoScopedFixRecord } from "@/execution";
import { makeStory } from "@test/helpers";

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
