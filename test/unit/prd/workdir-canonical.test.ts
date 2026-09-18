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
  findNonCanonicalDeclaredPaths,
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

describe("canonicalizeDeclaredPath — unconditional pure-string normalization (single-frame redesign)", () => {
  test("re-spells a package-relative path without touching disk", () => {
    expect(canonicalizeDeclaredPath("src/a.ts", "packages/app")).toBe("packages/app/src/a.ts");
  });

  test("leaves an already repo-rooted path alone", () => {
    expect(canonicalizeDeclaredPath("packages/app/src/a.ts", "packages/app")).toBe("packages/app/src/a.ts");
  });

  test("re-spells a path that will not exist until this story creates it", () => {
    // No exists() probe is passed at all — the old signature required one.
    expect(canonicalizeDeclaredPath("src/new.ts", "packages/app")).toBe("packages/app/src/new.ts");
  });

  test("is a no-op at the repo root", () => {
    expect(canonicalizeDeclaredPath("src/a.ts", ".")).toBe("src/a.ts");
  });

  test("does not slice a package whose name extends another", () => {
    // "packages/app" must not treat "packages/application/x.ts" as already-framed.
    expect(canonicalizeDeclaredPath("packages/application/x.ts", "packages/app")).toBe(
      "packages/app/packages/application/x.ts",
    );
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
    // unconditional re-spell now covers create-intent paths too
    expect(story?.expectedFiles).toEqual(["packages/app/src/b.ts"]);
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

  test("reframes modifiedFiles the same way as contextFiles", () => {
    const { prd } = canonicalizePrdWorkdirs(
      prdOf([
        makeStory({
          workdir: "packages/app",
          modifiedFiles: [{ path: "src/existing.ts", reason: "fix off-by-one" }],
        }),
      ]),
      REPO,
      PACKAGES,
      probeOf(),
    );
    expect(prd.userStories[0]?.modifiedFiles).toEqual([
      { path: "packages/app/src/existing.ts", reason: "fix off-by-one" },
    ]);
  });

  test("the result carries exactly { prd, defaulted } — collisions/rootOnly are gone, not stubbed", () => {
    const result = canonicalizePrdWorkdirs(prdOf([makeStory({ workdir: "packages/app" })]), REPO, PACKAGES, probeOf());
    expect(Object.keys(result).sort()).toEqual(["defaulted", "prd"]);
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

describe("canonicalizePrdWorkdirs — scoped canonicalization (nax#2080)", () => {
  test("leaves a story outside `only` as the identical reference", () => {
    const untouched = makeStory({ id: "US-001", contextFiles: ["src/a.ts"] });
    const target = makeStory({ id: "US-002", contextFiles: ["src/b.ts"] });
    const prd = makePRD({ userStories: [untouched, target] });
    const exists = probeOf("packages/app/src/a.ts", "packages/app/src/b.ts");

    const { prd: out } = canonicalizePrdWorkdirs(prd, REPO, PACKAGES, exists, { only: new Set(["US-002"]) });

    // Identity, not deep equality: an untouched story must not even be respread,
    // or a caller cannot tell "we left it alone" from "we recomputed the same value".
    expect(out.userStories[0]).toBe(untouched);
    expect(out.userStories[0]?.workdirSource).toBeUndefined();
    expect(out.userStories[1]?.workdir).toBe("packages/app");
    expect(out.userStories[1]?.contextFiles).toEqual(["packages/app/src/b.ts"]);
  });

  test("does not report an out-of-scope story as defaulted", () => {
    const prd = makePRD({ userStories: [makeStory({ id: "US-001" }), makeStory({ id: "US-002" })] });

    const { defaulted } = canonicalizePrdWorkdirs(prd, REPO, PACKAGES, probeOf(), { only: new Set(["US-002"]) });

    expect(defaulted).toEqual(["US-002"]);
  });

  test("derive:false defaults an unstated story without probing the filesystem", () => {
    const prd = makePRD({ userStories: [makeStory({ id: "US-001", contextFiles: ["src/a.ts"] })] });
    const probed: string[] = [];
    const exists = (abs: string): boolean => {
      probed.push(abs);
      return true;
    };

    const { prd: out, defaulted } = canonicalizePrdWorkdirs(prd, REPO, PACKAGES, exists, { derive: false });

    expect(out.userStories[0]?.workdir).toBeUndefined();
    expect(out.userStories[0]?.workdirSource).toBe("defaulted");
    expect(defaulted).toEqual(["US-001"]);
    // Zero probes: derivation is skipped, and the unconditional pure-string
    // re-spell never probes the filesystem.
    expect(probed).toEqual([]);
  });

  test("derive:false still re-spells the paths of a story that states its workdir", () => {
    const prd = makePRD({
      userStories: [makeStory({ id: "US-001", workdir: "packages/app", contextFiles: ["src/a.ts"] })],
    });

    const { prd: out } = canonicalizePrdWorkdirs(prd, REPO, PACKAGES, probeOf("packages/app/src/a.ts"), {
      derive: false,
    });

    expect(out.userStories[0]?.workdirSource).toBe("stated");
    expect(out.userStories[0]?.contextFiles).toEqual(["packages/app/src/a.ts"]);
  });

  test("is a fixed point over an already-canonical story", () => {
    const prd = makePRD({
      userStories: [makeStory({ id: "US-001", workdir: "packages/app", contextFiles: ["src/a.ts"] })],
    });
    const exists = probeOf("packages/app/src/a.ts");

    const once = canonicalizePrdWorkdirs(prd, REPO, PACKAGES, exists).prd;
    const twice = canonicalizePrdWorkdirs(once, REPO, PACKAGES, exists).prd;

    expect(twice.userStories[0]).toEqual(once.userStories[0]);
  });
});

describe("canonicalizePrdWorkdirs — frame is independent of disk state (single-frame redesign, design §6)", () => {
  test("the same PRD canonicalized against two different fake-fs states yields byte-identical declared-path frames", () => {
    const story = makeStory({
      workdir: "packages/app",
      contextFiles: ["src/a.ts"],
      expectedFiles: ["src/new.ts"],
      modifiedFiles: [{ path: "src/b.ts", reason: "r" }],
    });
    const prd = makePRD({ userStories: [story] });

    // Tree state A: everything declared already exists.
    const treeA = probeOf("packages/app/src/a.ts", "packages/app/src/new.ts", "packages/app/src/b.ts");
    // Tree state B: NOTHING exists yet (a freshly-checked-out branch before the story ran).
    const treeB = probeOf();

    const resultA = canonicalizePrdWorkdirs(prd, REPO, PACKAGES, treeA, { derive: false });
    const resultB = canonicalizePrdWorkdirs(prd, REPO, PACKAGES, treeB, { derive: false });

    expect(JSON.stringify(resultA.prd)).toBe(JSON.stringify(resultB.prd));
  });

  test("with an unstated workdir and derive disabled, output is still disk-state-independent", () => {
    const story = makeStory({ contextFiles: ["packages/app/src/a.ts"] }); // no workdir stated
    const prd = makePRD({ userStories: [story] });
    const resultA = canonicalizePrdWorkdirs(prd, REPO, PACKAGES, probeOf("packages/app/src/a.ts"), { derive: false });
    const resultB = canonicalizePrdWorkdirs(prd, REPO, PACKAGES, probeOf(), { derive: false });
    expect(JSON.stringify(resultA.prd)).toBe(JSON.stringify(resultB.prd));
  });
});

describe("findNonCanonicalDeclaredPaths — plan-write-time validation (single-frame redesign)", () => {
  const prdOf = (stories: UserStory[]) => makePRD({ userStories: stories });

  test("flags a contextFiles entry that is not repo-rooted on a canonicalized story", () => {
    const story = makeStory({
      workdir: "packages/app",
      workdirSource: "stated",
      contextFiles: ["src/a.ts"], // should have been "packages/app/src/a.ts"
    });
    const violations = findNonCanonicalDeclaredPaths(prdOf([story]));
    expect(violations).toEqual([{ storyId: story.id, field: "contextFiles", path: "src/a.ts" }]);
  });

  test("is silent for a properly repo-rooted story", () => {
    const story = makeStory({
      workdir: "packages/app",
      workdirSource: "stated",
      contextFiles: ["packages/app/src/a.ts"],
      expectedFiles: ["packages/app/src/new.ts"],
      modifiedFiles: [{ path: "packages/app/src/b.ts", reason: "r" }],
    });
    expect(findNonCanonicalDeclaredPaths(prdOf([story]))).toEqual([]);
  });

  test("skips a legacy story with no workdirSource stamped", () => {
    const story = makeStory({ workdir: "packages/app", contextFiles: ["src/a.ts"] });
    expect(findNonCanonicalDeclaredPaths(prdOf([story]))).toEqual([]);
  });

  test("is silent at the repo root — every path is trivially canonical", () => {
    const story = makeStory({ workdirSource: "defaulted", contextFiles: ["src/a.ts"] });
    expect(findNonCanonicalDeclaredPaths(prdOf([story]))).toEqual([]);
  });
});
