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
  normalizeDeclaredPathSpelling,
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

  test("does not slice a package whose name extends another; a repo-rooted input path is correctly attributed even when another package's name is a prefix", () => {
    const exists = probeOf("packages/application/src/c.ts");
    expect(resolvePathOwners("packages/application/src/c.ts", REPO, ["packages/app"], exists)).toEqual([]);
    expect(
      resolvePathOwners("packages/application/src/c.ts", REPO, ["packages/app", "packages/application"], exists),
    ).toEqual(["packages/application"]);
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

describe("canonicalizeDeclaredPath — repo-rooted declared paths stay as written (US-001)", () => {
  test("US-001 AC1: keeps a declared path that exists at the repo root in its declared spelling", () => {
    const exists = probeOf("docs/pipelines/report.pipeline.json");
    expect(canonicalizeDeclaredPath("docs/pipelines/report.pipeline.json", "packages/lib", REPO, exists)).toEqual({
      path: "docs/pipelines/report.pipeline.json",
      respelled: false,
    });
  });

  test("US-001 AC2: keeps a declared path that exists nowhere — a file the story will create stays repo-rooted", () => {
    expect(canonicalizeDeclaredPath("docs/pipelines/report.pipeline.json", "packages/lib", REPO, probeOf())).toEqual({
      path: "docs/pipelines/report.pipeline.json",
      respelled: false,
    });
  });

  test("US-001 AC3: keeps another package's declared path as written", () => {
    const exists = probeOf("packages/db/src/schema.ts");
    expect(canonicalizeDeclaredPath("packages/db/src/schema.ts", "apps/api", REPO, exists)).toEqual({
      path: "packages/db/src/schema.ts",
      respelled: false,
    });
  });

  test("US-001 AC4: re-spells a package-relative path that is absent at the root and present under the package", () => {
    const exists = probeOf("packages/lib/src/a.ts");
    expect(canonicalizeDeclaredPath("src/a.ts", "packages/lib", REPO, exists)).toEqual({
      path: "packages/lib/src/a.ts",
      respelled: true,
    });
  });

  test("US-001 AC5: prefers the repo-rooted reading when the path exists at the root and under the package", () => {
    const exists = probeOf("src/a.ts", "packages/lib/src/a.ts");
    expect(canonicalizeDeclaredPath("src/a.ts", "packages/lib", REPO, exists)).toEqual({
      path: "src/a.ts",
      respelled: false,
    });
  });

  test("US-001 AC6: normalises the spelling of a path already inside the package, whatever the probe reports", () => {
    for (const exists of [probeOf("packages/lib/src/a.ts"), probeOf()]) {
      expect(canonicalizeDeclaredPath("./packages/lib/src/a.ts/", "packages/lib", REPO, exists)).toEqual({
        path: "packages/lib/src/a.ts",
        respelled: false,
      });
    }
  });

  test("US-001 AC7: never probes the filesystem at the repo root", () => {
    const probed: string[] = [];
    const exists = (abs: string): boolean => {
      probed.push(abs);
      return true;
    };

    expect(canonicalizeDeclaredPath("src/a.ts", ".", REPO, exists)).toEqual({ path: "src/a.ts", respelled: false });
    expect(probed).toEqual([]);
  });

  test("US-001 AC2 boundary: a create-intent path under the package keeps its declared frameless spelling", () => {
    // "src/new.ts" is nowhere on disk, so there is nothing that proves it was
    // meant package-relative — it stays exactly as declared.
    expect(canonicalizeDeclaredPath("src/new.ts", "packages/app", REPO, probeOf())).toEqual({
      path: "src/new.ts",
      respelled: false,
    });
  });

  test("US-001 AC5 boundary: does not slice a package whose name extends another", () => {
    // "packages/app" must not read "packages/application/x.ts" as already framed
    // and must not re-spell it either: the repo-rooted file exists.
    const exists = probeOf("packages/application/x.ts");
    expect(canonicalizeDeclaredPath("packages/application/x.ts", "packages/app", REPO, exists)).toEqual({
      path: "packages/application/x.ts",
      respelled: false,
    });
  });
});

describe("normalizeDeclaredPathSpelling — spelling only, never framing (US-001)", () => {
  test("US-001 AC13: normalises backslash separators, a leading `.\\` and a trailing backslash", () => {
    expect(normalizeDeclaredPathSpelling(".\\packages\\lib\\src\\a.ts\\")).toBe("packages/lib/src/a.ts");
  });

  test("US-001 AC13: returns an already-normalised path unchanged", () => {
    expect(normalizeDeclaredPathSpelling("packages/lib/src/a.ts")).toBe("packages/lib/src/a.ts");
  });

  test("US-001 AC13 boundary: trims surrounding whitespace without re-framing the path", () => {
    expect(normalizeDeclaredPathSpelling("  src/a.ts  ")).toBe("src/a.ts");
  });
});

describe("canonicalizePrdWorkdirs", () => {
  // Use the shared factories: the double-cast escape hatch is ratcheted at ZERO
  // in test/ (scripts/baselines/test-as-unknown-as-baseline.json), and hand-rolled
  // PRD fixtures are what .nax/rules/test-helpers.md forbids anyway.
  const prdOf = (stories: UserStory[]) => makePRD({ userStories: stories });

  test("derives a workdir and re-spells only the declared path that exists under the package", () => {
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
    // "src/b.ts" exists nowhere, so nothing proves it is package-relative: it
    // stays in the frame it was declared in.
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

  test("leaves a modifiedFiles path that exists nowhere in its declared spelling", () => {
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
    expect(prd.userStories[0]?.modifiedFiles).toEqual([{ path: "src/existing.ts", reason: "fix off-by-one" }]);
  });

  test("the result carries exactly { prd, defaulted, respelled } — collisions/rootOnly are gone, not stubbed", () => {
    const result = canonicalizePrdWorkdirs(prdOf([makeStory({ workdir: "packages/app" })]), REPO, PACKAGES, probeOf());
    expect(Object.keys(result).sort()).toEqual(["defaulted", "prd", "respelled"]);
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

describe("canonicalizePrdWorkdirs — repo-rooted declared paths stay as written (US-001)", () => {
  const prdOf = (stories: UserStory[]) => makePRD({ userStories: stories });

  test("US-001 AC8: keeps an expectedFiles path that exists nowhere in its declared spelling", () => {
    const { prd, respelled } = canonicalizePrdWorkdirs(
      prdOf([makeStory({ workdir: "packages/lib", expectedFiles: ["docs/pipelines/report.pipeline.json"] })]),
      REPO,
      PACKAGES,
      probeOf(),
    );

    expect(prd.userStories[0]?.expectedFiles).toEqual(["docs/pipelines/report.pipeline.json"]);
    expect(respelled).toEqual([]);
  });

  test("US-001 AC9: keeps cross-package contextFiles as written, including ContextFileEntry objects", () => {
    const exists = probeOf("packages/db/src/schema.ts", "docs/design.md");
    const { prd, respelled } = canonicalizePrdWorkdirs(
      prdOf([
        makeStory({
          workdir: "apps/api",
          contextFiles: ["packages/db/src/schema.ts", { path: "docs/design.md", factId: "F-1" }],
        }),
      ]),
      REPO,
      PACKAGES,
      exists,
    );

    expect(prd.userStories[0]?.contextFiles).toEqual([
      "packages/db/src/schema.ts",
      { path: "docs/design.md", factId: "F-1" },
    ]);
    expect(respelled).toEqual([]);
  });

  test("US-001 AC10: keeps a modifiedFiles path belonging to another package as written", () => {
    const exists = probeOf("apps/api/tests/test_count.py");
    const { prd, respelled } = canonicalizePrdWorkdirs(
      prdOf([
        makeStory({
          workdir: "packages/lib",
          modifiedFiles: [{ path: "apps/api/tests/test_count.py", reason: "r" }],
        }),
      ]),
      REPO,
      PACKAGES,
      exists,
    );

    expect(prd.userStories[0]?.modifiedFiles).toEqual([{ path: "apps/api/tests/test_count.py", reason: "r" }]);
    expect(respelled).toEqual([]);
  });

  test("US-001 AC11: reports each re-spell as { storyId, field, from, to }", () => {
    const exists = probeOf("packages/lib/src/a.ts");
    const { prd, respelled } = canonicalizePrdWorkdirs(
      prdOf([makeStory({ id: "US-002", workdir: "packages/lib", contextFiles: ["src/a.ts"] })]),
      REPO,
      PACKAGES,
      exists,
    );

    expect(prd.userStories[0]?.contextFiles).toEqual(["packages/lib/src/a.ts"]);
    expect(respelled).toEqual([
      { storyId: "US-002", field: "contextFiles", from: "src/a.ts", to: "packages/lib/src/a.ts" },
    ]);
  });

  test("US-001 AC11 boundary: tags every re-spell with the declared-path field it came from", () => {
    const exists = probeOf("packages/lib/src/a.ts", "packages/lib/src/new.ts", "packages/lib/src/b.ts");
    const { respelled } = canonicalizePrdWorkdirs(
      prdOf([
        makeStory({
          id: "US-002",
          workdir: "packages/lib",
          contextFiles: ["src/a.ts"],
          expectedFiles: ["src/new.ts"],
          modifiedFiles: [{ path: "src/b.ts", reason: "r" }],
        }),
      ]),
      REPO,
      PACKAGES,
      exists,
    );

    // Order is the implementation's business; the tag is not.
    expect(respelled).toHaveLength(3);
    expect(respelled).toContainEqual({
      storyId: "US-002",
      field: "contextFiles",
      from: "src/a.ts",
      to: "packages/lib/src/a.ts",
    });
    expect(respelled).toContainEqual({
      storyId: "US-002",
      field: "expectedFiles",
      from: "src/new.ts",
      to: "packages/lib/src/new.ts",
    });
    expect(respelled).toContainEqual({
      storyId: "US-002",
      field: "modifiedFiles",
      from: "src/b.ts",
      to: "packages/lib/src/b.ts",
    });
  });

  test("US-001 AC12: running over its own output changes nothing and reports no re-spell", () => {
    const exists = probeOf("packages/lib/src/a.ts");
    const prd = prdOf([
      makeStory({ workdir: "packages/lib", contextFiles: ["src/a.ts"], expectedFiles: ["src/b.ts"] }),
    ]);

    const first = canonicalizePrdWorkdirs(prd, REPO, PACKAGES, exists);
    const second = canonicalizePrdWorkdirs(first.prd, REPO, PACKAGES, exists);

    // The control: the first pass DOES re-spell, so an empty second report is a
    // statement about the fixed point rather than about the report being inert.
    expect(first.respelled).toEqual([
      { storyId: "US-001", field: "contextFiles", from: "src/a.ts", to: "packages/lib/src/a.ts" },
    ]);
    expect(second.prd.userStories).toEqual(first.prd.userStories);
    expect(second.respelled).toEqual([]);
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

  test("US-001 AC20: a story outside `only` keeps its package-relative paths and is absent from the report", () => {
    const untouched = makeStory({ id: "US-001", workdir: "packages/lib", contextFiles: ["src/a.ts"] });
    const target = makeStory({ id: "US-002", workdir: "packages/lib", contextFiles: ["src/c.ts"] });
    const prd = makePRD({ userStories: [untouched, target] });
    const exists = probeOf("packages/lib/src/a.ts", "packages/lib/src/c.ts");

    const { prd: out, respelled } = canonicalizePrdWorkdirs(prd, REPO, PACKAGES, exists, { only: new Set(["US-002"]) });

    expect(out.userStories[0]).toBe(untouched);
    expect(out.userStories[0]?.contextFiles).toEqual(["src/a.ts"]);
    // The control: the scoped story IS re-spelled, so "not reported" is a
    // statement about the scope rather than about the report being inert.
    expect(out.userStories[1]?.contextFiles).toEqual(["packages/lib/src/c.ts"]);
    expect(respelled).toEqual([
      { storyId: "US-002", field: "contextFiles", from: "src/c.ts", to: "packages/lib/src/c.ts" },
    ]);
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
    // Zero probes: derivation is skipped, and at the repo root the re-spell is a
    // pure string operation that short-circuits before touching the filesystem.
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

  test("is a fixed point: canonicalizing its own output changes nothing", () => {
    const prd = makePRD({
      userStories: [
        makeStory({
          id: "US-001",
          workdir: "packages/app",
          contextFiles: ["src/a.ts"],
          expectedFiles: ["src/new.ts"],
          modifiedFiles: [{ path: "src/b.ts", reason: "r" }],
        }),
      ],
    });
    const exists = probeOf("packages/app/src/a.ts");

    const once = canonicalizePrdWorkdirs(prd, REPO, PACKAGES, exists).prd;
    const twice = canonicalizePrdWorkdirs(once, REPO, PACKAGES, exists).prd;

    expect(twice.userStories[0]).toEqual(once.userStories[0]);
    // Pin the re-spell's idempotency explicitly: a re-spell that is not a fixed
    // point would double-prefix contextFiles on the second pass.
    expect(twice.userStories[0]?.contextFiles).toEqual(["packages/app/src/a.ts"]);
    // The paths that resolve nowhere stay exactly as declared, in both passes.
    expect(twice.userStories[0]?.expectedFiles).toEqual(["src/new.ts"]);
    expect(twice.userStories[0]?.modifiedFiles).toEqual([{ path: "src/b.ts", reason: "r" }]);
  });
});

describe("canonicalizePrdWorkdirs — frame is independent of disk state (single-frame redesign, design §6)", () => {
  test("the same PRD canonicalized against two different fake-fs states yields byte-identical declared-path frames", () => {
    // Repo-rooted inputs (the frame every declared path is written in), so the
    // invariant is about the write step, not about how the probe answers.
    const story = makeStory({
      workdir: "packages/app",
      contextFiles: ["packages/app/src/a.ts"],
      expectedFiles: ["packages/app/src/new.ts"],
      modifiedFiles: [{ path: "packages/app/src/b.ts", reason: "r" }],
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

  test("flags a contextFiles entry whose spelling is non-canonical on a stamped story", () => {
    const story = makeStory({
      workdir: "packages/app",
      workdirSource: "stated",
      contextFiles: ["./packages/app/src/a.ts"],
    });
    const violations = findNonCanonicalDeclaredPaths(prdOf([story]));
    expect(violations).toEqual([{ storyId: story.id, field: "contextFiles", path: "./packages/app/src/a.ts" }]);
  });

  test("flags an expectedFiles entry whose spelling is non-canonical", () => {
    const story = makeStory({
      workdir: "packages/app",
      workdirSource: "stated",
      expectedFiles: ["./packages/app/src/new.ts"],
    });
    expect(findNonCanonicalDeclaredPaths(prdOf([story]))).toEqual([
      { storyId: story.id, field: "expectedFiles", path: "./packages/app/src/new.ts" },
    ]);
  });

  test("flags a modifiedFiles entry whose spelling is non-canonical", () => {
    const story = makeStory({
      workdir: "packages/app",
      workdirSource: "stated",
      modifiedFiles: [{ path: "./packages/app/src/b.ts", reason: "r" }],
    });
    expect(findNonCanonicalDeclaredPaths(prdOf([story]))).toEqual([
      { storyId: story.id, field: "modifiedFiles", path: "./packages/app/src/b.ts" },
    ]);
  });

  test("flags a non-string contextFiles entry whose spelling is non-canonical", () => {
    const story = makeStory({
      workdir: "packages/app",
      workdirSource: "stated",
      contextFiles: [{ path: ".\\packages\\app\\src\\a.ts", factId: "F-1" }],
    });
    expect(findNonCanonicalDeclaredPaths(prdOf([story]))).toEqual([
      { storyId: story.id, field: "contextFiles", path: ".\\packages\\app\\src\\a.ts" },
    ]);
  });

  test("US-001 AC14: accepts a repo-rooted path outside the story's package on a stamped story", () => {
    const story = makeStory({
      workdir: "packages/lib",
      workdirSource: "stated",
      contextFiles: ["docs/x.md"],
      modifiedFiles: [{ path: "apps/api/tests/t.py", reason: "r" }],
    });

    expect(findNonCanonicalDeclaredPaths(prdOf([story]))).toEqual([]);
  });

  test("US-001 AC15: still flags an expectedFiles spelling the normaliser would change", () => {
    const story = makeStory({
      workdir: "packages/lib",
      workdirSource: "stated",
      expectedFiles: ["./packages/lib/src/new.ts"],
    });

    expect(findNonCanonicalDeclaredPaths(prdOf([story]))).toEqual([
      { storyId: story.id, field: "expectedFiles", path: "./packages/lib/src/new.ts" },
    ]);
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
