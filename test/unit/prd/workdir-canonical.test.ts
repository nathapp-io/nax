/**
 * Pure derivation and re-spelling for nax#2067.
 *
 * The probe is a plain Set of absolute paths — no filesystem, no mocks.
 */

import { describe, expect, test } from "bun:test";
import { makePRD, makeStory } from "@test/helpers";
import type { UserStory } from "@/prd/types";
import {
  canonicalizeDeclaredPath,
  canonicalizePrdWorkdirs,
  deriveWorkdir,
  resolvePathOwners,
} from "@/prd/workdir-canonical";

const REPO = "/repo";
const PACKAGES = ["packages/app", "packages/lib"];

/** Build a probe from a list of repo-relative paths that "exist". */
function probeOf(...relPaths: string[]) {
  const set = new Set(relPaths.map((p) => `${REPO}/${p}`));
  return (abs: string) => set.has(abs);
}

describe("resolvePathOwners", () => {
  test("finds the package a package-relative path lives under", () => {
    const exists = probeOf("packages/app/src/a.ts");
    expect(resolvePathOwners("src/a.ts", REPO, PACKAGES, exists)).toEqual(["packages/app"]);
  });

  test("finds the package a repo-rooted path already names", () => {
    const exists = probeOf("packages/lib/src/b.ts");
    expect(resolvePathOwners("packages/lib/src/b.ts", REPO, PACKAGES, exists)).toEqual(["packages/lib"]);
  });

  test("returns both when the same relative path exists in two packages", () => {
    const exists = probeOf("packages/app/src/a.ts", "packages/lib/src/a.ts");
    expect(resolvePathOwners("src/a.ts", REPO, PACKAGES, exists)).toEqual(["packages/app", "packages/lib"]);
  });

  test("returns none for a path that exists nowhere", () => {
    expect(resolvePathOwners("src/new.ts", REPO, PACKAGES, probeOf())).toEqual([]);
  });

  test("does not slice a package whose name extends another", () => {
    const exists = probeOf("packages/application/src/c.ts");
    expect(resolvePathOwners("packages/application/src/c.ts", REPO, ["packages/app"], exists)).toEqual([]);
  });
});

describe("deriveWorkdir", () => {
  test("derives the single owning package", () => {
    const exists = probeOf("packages/app/src/a.ts", "packages/app/src/b.ts");
    expect(deriveWorkdir(["src/a.ts", "src/b.ts"], REPO, PACKAGES, exists)).toEqual({
      workdir: "packages/app",
      source: "derived",
    });
  });

  test("defaults to root when paths span packages", () => {
    const exists = probeOf("packages/app/src/a.ts", "packages/lib/src/b.ts");
    expect(deriveWorkdir(["src/a.ts", "src/b.ts"], REPO, PACKAGES, exists)).toEqual({
      workdir: ".",
      source: "defaulted",
    });
  });

  test("defaults to root when nothing resolves", () => {
    expect(deriveWorkdir(["src/new.ts"], REPO, PACKAGES, probeOf())).toEqual({
      workdir: ".",
      source: "defaulted",
    });
  });

  test("defaults to root when there are no declared paths", () => {
    expect(deriveWorkdir([], REPO, PACKAGES, probeOf())).toEqual({ workdir: ".", source: "defaulted" });
  });

  test("ignores paths that resolve nowhere when others agree", () => {
    // A story that reads one existing file and creates another.
    const exists = probeOf("packages/app/src/a.ts");
    expect(deriveWorkdir(["src/a.ts", "src/brand-new.ts"], REPO, PACKAGES, exists)).toEqual({
      workdir: "packages/app",
      source: "derived",
    });
  });
});

describe("canonicalizeDeclaredPath", () => {
  test("re-spells a package-relative path", () => {
    const exists = probeOf("packages/app/src/a.ts");
    expect(canonicalizeDeclaredPath("src/a.ts", "packages/app", REPO, exists)).toEqual({
      path: "packages/app/src/a.ts",
      collided: false,
    });
  });

  test("leaves an already repo-rooted path alone", () => {
    const exists = probeOf("packages/app/src/a.ts");
    expect(canonicalizeDeclaredPath("packages/app/src/a.ts", "packages/app", REPO, exists)).toEqual({
      path: "packages/app/src/a.ts",
      collided: false,
    });
  });

  test("leaves a path that exists nowhere unchanged — the story creates it", () => {
    expect(canonicalizeDeclaredPath("src/new.ts", "packages/app", REPO, probeOf())).toEqual({
      path: "src/new.ts",
      collided: false,
    });
  });

  test("story-local wins when both spellings exist, and reports the collision", () => {
    const exists = probeOf("src/a.ts", "packages/app/src/a.ts");
    expect(canonicalizeDeclaredPath("src/a.ts", "packages/app", REPO, exists)).toEqual({
      path: "packages/app/src/a.ts",
      collided: true,
    });
  });

  test("is a no-op at the repo root", () => {
    const exists = probeOf("src/a.ts");
    expect(canonicalizeDeclaredPath("src/a.ts", ".", REPO, exists)).toEqual({
      path: "src/a.ts",
      collided: false,
    });
  });
});

describe("canonicalizePrdWorkdirs", () => {
  // Use the shared factories: the double-cast escape hatch is ratcheted at ZERO
  // in test/ (scripts/baselines/test-as-unknown-as-baseline.json), and hand-rolled
  // PRD fixtures are what .nax/rules/test-helpers.md forbids anyway.
  const prdOf = (stories: UserStory[]) => makePRD({ userStories: stories });

  test("derives a workdir and re-spells the story's declared paths", () => {
    const exists = probeOf("packages/app/src/a.ts");
    const { prd } = canonicalizePrdWorkdirs(
      prdOf([makeStory({ contextFiles: ["src/a.ts"], expectedFiles: ["src/b.ts"] })]),
      REPO,
      PACKAGES,
      exists,
    );
    const story = prd.userStories[0];
    expect(story?.workdir).toBe("packages/app");
    expect(story?.workdirSource).toBe("derived");
    expect(story?.contextFiles).toEqual(["packages/app/src/a.ts"]);
    // expectedFiles does not exist yet, so it stays as authored.
    expect(story?.expectedFiles).toEqual(["src/b.ts"]);
  });

  test("keeps a stated workdir and stamps it stated", () => {
    const exists = probeOf("packages/lib/src/a.ts");
    const { prd } = canonicalizePrdWorkdirs(
      prdOf([makeStory({ workdir: "packages/lib", contextFiles: ["src/a.ts"] })]),
      REPO,
      PACKAGES,
      exists,
    );
    expect(prd.userStories[0]?.workdir).toBe("packages/lib");
    expect(prd.userStories[0]?.workdirSource).toBe("stated");
    expect(prd.userStories[0]?.contextFiles).toEqual(["packages/lib/src/a.ts"]);
  });

  test("defaults to root and omits workdir entirely", () => {
    const exists = probeOf("packages/app/src/a.ts", "packages/lib/src/b.ts");
    const { prd } = canonicalizePrdWorkdirs(
      prdOf([makeStory({ contextFiles: ["src/a.ts", "src/b.ts"] })]),
      REPO,
      PACKAGES,
      exists,
    );
    expect(prd.userStories[0]?.workdir).toBeUndefined();
    expect(prd.userStories[0]?.workdirSource).toBe("defaulted");
  });

  test("preserves ContextFileEntry objects and their factId", () => {
    const exists = probeOf("packages/app/src/a.ts");
    const { prd } = canonicalizePrdWorkdirs(
      prdOf([makeStory({ contextFiles: [{ path: "src/a.ts", factId: "F-1" }] })]),
      REPO,
      PACKAGES,
      exists,
    );
    expect(prd.userStories[0]?.contextFiles).toEqual([{ path: "packages/app/src/a.ts", factId: "F-1" }]);
  });

  test("reports a collision without failing", () => {
    const exists = probeOf("src/a.ts", "packages/app/src/a.ts");
    const { prd, collisions } = canonicalizePrdWorkdirs(
      prdOf([makeStory({ workdir: "packages/app", contextFiles: ["src/a.ts"] })]),
      REPO,
      PACKAGES,
      exists,
    );
    expect(prd.userStories[0]?.contextFiles).toEqual(["packages/app/src/a.ts"]);
    expect(collisions).toEqual(["US-001:src/a.ts"]);
  });

  test("is a no-op for a single-package repo (no workspace packages)", () => {
    const exists = probeOf("src/a.ts");
    const { prd } = canonicalizePrdWorkdirs(prdOf([makeStory({ contextFiles: ["src/a.ts"] })]), REPO, [], exists);
    expect(prd.userStories[0]?.workdir).toBeUndefined();
    expect(prd.userStories[0]?.workdirSource).toBe("defaulted");
    expect(prd.userStories[0]?.contextFiles).toEqual(["src/a.ts"]);
  });

  test('an explicitly stated "." is treated as root, not as a package', () => {
    const exists = probeOf("src/a.ts");
    const { prd } = canonicalizePrdWorkdirs(
      prdOf([makeStory({ workdir: ".", contextFiles: ["src/a.ts"] })]),
      REPO,
      PACKAGES,
      exists,
    );
    expect(prd.userStories[0]?.workdir).toBeUndefined();
    expect(prd.userStories[0]?.workdirSource).toBe("defaulted");
  });

  test("does not mutate the input PRD", () => {
    const input = prdOf([makeStory({ contextFiles: ["src/a.ts"] })]);
    const snapshot = JSON.stringify(input);
    canonicalizePrdWorkdirs(input, REPO, PACKAGES, probeOf("packages/app/src/a.ts"));
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
