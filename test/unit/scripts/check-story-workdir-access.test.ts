import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { findStaleExemptions, findViolations, type Violation } from "@scripts/check-story-workdir-access";
import { findViolationsV1 } from "@test/fixtures/story-workdir-access/v1-regex-reference";
import type { Project } from "typescript/unstable/async";
import { API } from "typescript/unstable/async";

/**
 * v4 (path-frame follow-up) resolves the REAL type at each candidate site via
 * `typescript/unstable/async`'s Program/Checker, not a rendered-type-string
 * comparison. That needs a real `Project`, which needs a real file on disk
 * inside a tsconfig-included tree -- the API refused to attach a file outside
 * `tsconfig.test.json`'s `include` globs even when told it was "created"
 * (verified: `getSourceFile` returned undefined for a file under the OS temp
 * dir). `test/helpers/temp.ts`'s `withTempDir()` uses `os.tmpdir()` for
 * portability, which is exactly the directory that does NOT work here, so
 * this file manages its own scratch directory under the already-gitignored
 * `test/tmp/` instead (`.gitignore:59`) rather than reaching for that helper.
 *
 * Each fixture gets its own file (`fixture-<n>.ts`) rather than one file
 * rewritten per test: a "created" file change is unambiguous, and a
 * "changed" one on a file the snapshot has not seen yet is not.
 *
 * PREVIOUS REVISION'S WEAKNESS, FIXED HERE: most fixtures in the prior
 * version of this file declared `declare const story: UserStory;` with NO
 * IMPORT, exploiting the checker's error-recovery echo of an UNRESOLVED type
 * name (a bare reference to an undeclared name still prints back as its own
 * name, e.g. "UserStory", rather than collapsing to "any"). That pinned
 * STRING-MATCHING behaviour, not real type resolution -- which is exactly
 * why every C1 bypass (`Readonly<UserStory>`, `Pick<...>`, `extends`, an
 * intersection, a union) was untestable under the old design: the real
 * checker resolves an unresolved name's members to nothing, so a fixture
 * built that way can never exercise the real declaration-provenance check
 * this file's gate now performs. Every fixture below that needs a real
 * `UserStory` or `StoryWorkdirLike` imports the genuine type from `@/prd` /
 * `@/utils/path-frame` instead. Production code is always checked against
 * the real types by the whole-repo scan; a fixture that isn't is not
 * testing the same code path.
 */

const FIXTURE_DIR = join(process.cwd(), "test", "tmp", "story-workdir-access-fixtures");

let api: API;
let project: Project;
let fixtureCounter = 0;

beforeAll(async () => {
  // A crashed prior run can leave stale fixtures in test/tmp/, which
  // tsconfig.test.json's `include` picks up -- a broken tree that fails
  // `bun run typecheck` before a single test runs. Sweep before, not just
  // after (previous revision's weakness #3).
  await rm(FIXTURE_DIR, { recursive: true, force: true });
  api = new API({ cwd: process.cwd() });
  await Bun.write(join(FIXTURE_DIR, ".keep"), "");
});

afterAll(async () => {
  await api.close();
  await rm(FIXTURE_DIR, { recursive: true, force: true });
});

/** Write `source` to a fresh fixture file and return its violations. */
async function check(source: string): Promise<Violation[]> {
  fixtureCounter++;
  const abs = join(FIXTURE_DIR, `fixture-${fixtureCounter}.ts`);
  const rel = `test/tmp/story-workdir-access-fixtures/fixture-${fixtureCounter}.ts`;
  // Each fixture is a global SCRIPT (no import/export) at top level, which
  // means bare `declare const` bindings are added to a GLOBAL scope shared
  // by every fixture file the project has ever loaded. Two fixtures that
  // both declare, say, `ctx`, with different shapes then collide and the
  // checker resolves an incoherent merged/ambiguous type. Appending
  // `export {}` makes each fixture its own MODULE, which scopes every
  // top-level declaration to that file alone. A fixture with a real
  // `import` is already a module and does not need it.
  const isolated = /^\s*(export|import)\b/m.test(source) ? source : `${source}\nexport {};`;
  await Bun.write(abs, isolated);
  const snapshot = await api.updateSnapshot({
    openProjects: ["tsconfig.test.json"],
    fileChanges: { created: [abs] },
  });
  const p = snapshot.getProject("tsconfig.test.json");
  if (p === undefined) throw new Error("tsconfig.test.json project failed to load");
  project = p;
  return findViolations(project, abs, rel);
}

/** The two real imports every story-typed fixture below needs. */
const IMPORT_USER_STORY = 'import type { UserStory } from "@/prd";';
const IMPORT_WORKDIR_LIKE = 'import type { StoryWorkdirLike } from "@/utils/path-frame";';

describe("findStaleExemptions", () => {
  test("reports an exemption that matched no read", () => {
    expect(findStaleExemptions(["a.ts"], new Set())).toEqual(["a.ts"]);
  });
  test("does not report a used exemption", () => {
    expect(findStaleExemptions(["a.ts"], new Set(["a.ts"]))).toEqual([]);
  });
  test("is empty when there are no exemptions", () => {
    expect(findStaleExemptions([], new Set(["a.ts"]))).toEqual([]);
  });
});

describe("findViolations", () => {
  test("flags a raw read on a UserStory binding", async () => {
    const found = await check(`${IMPORT_USER_STORY}\ndeclare const story: UserStory;\nconst w = story.workdir ?? '';`);
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(3);
  });

  test("flags a property-access chain where the root binding has UserStory type", async () => {
    const found = await check(
      `${IMPORT_USER_STORY}\ndeclare const story: UserStory;\ndeclare function reframe(a: string, b: unknown): void;\nreframe('x', story.workdir);`,
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(4);
  });

  test("ignores a non-story receiver (no UserStory type)", async () => {
    expect(await check("declare const ctx: { workdir: string };\nconst w = ctx.workdir;")).toHaveLength(0);
  });

  test("ignores line comments and doc comments", async () => {
    const src = [
      IMPORT_USER_STORY,
      "declare const story: UserStory;",
      "// story.workdir is repo-relative",
      "/** When story.workdir is set, the plan-time writer is the SSOT. */",
      "/* story.workdir can also appear in a block comment. */",
    ].join("\n");
    expect(await check(src)).toHaveLength(0);
  });

  test("ignores an accessor call", async () => {
    expect(
      await check(
        `${IMPORT_USER_STORY}\ndeclare const story: UserStory;\ndeclare function storyWorkdir(s: UserStory): string;\nconst w = storyWorkdir(story);`,
      ),
    ).toHaveLength(0);
  });

  test("reports every occurrence on separate lines", async () => {
    const src = [
      IMPORT_USER_STORY,
      "declare const a: UserStory;",
      "declare const story: UserStory;",
      "const x = a.workdir;",
      "const y = story.workdir;",
    ].join("\n");
    expect(await check(src)).toHaveLength(2);
  });
});

describe("findViolations bypass idioms (nax#2084)", () => {
  test("flags optional chaining story?.workdir", async () => {
    const found = await check(
      `${IMPORT_USER_STORY}\ndeclare const story: UserStory | undefined;\nconst w = story?.workdir ?? '.';`,
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(3);
  });

  test("flags destructuring const { workdir } = story", async () => {
    const found = await check(`${IMPORT_USER_STORY}\ndeclare const story: UserStory;\nconst { workdir } = story;`);
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(3);
  });

  test("flags element access story['workdir']", async () => {
    const found = await check(`${IMPORT_USER_STORY}\ndeclare const story: UserStory;\nconst w = story['workdir'];`);
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(3);
  });

  test('flags element access story["workdir"]', async () => {
    const found = await check(`${IMPORT_USER_STORY}\ndeclare const story: UserStory;\nconst w = story["workdir"];`);
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(3);
  });

  test("flags target.workdir when target has UserStory type (non-*story name)", async () => {
    const found = await check(`${IMPORT_USER_STORY}\ndeclare const target: UserStory;\nconst w = target.workdir;`);
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(3);
  });

  test("does not flag target.workdir when target lacks a story type", async () => {
    expect(await check("declare const target: { other: string };\nconst w = target.other;")).toHaveLength(0);
  });

  test("does not flag storyWorkdir(story) accessor call", async () => {
    expect(
      await check(
        `${IMPORT_USER_STORY}\ndeclare const story: UserStory;\ndeclare function storyWorkdir(s: UserStory): string;\nconst w = storyWorkdir(story);`,
      ),
    ).toHaveLength(0);
  });

  test("does not flag destructuring from a non-story options object", async () => {
    expect(
      await check("declare const someNonStoryOptions: { workdir: string };\nconst { workdir } = someNonStoryOptions;"),
    ).toHaveLength(0);
  });

  test("does not flag ctx.workdir on a context type (not UserStory)", async () => {
    expect(await check("declare const ctx: { workdir?: string };\nconst w = ctx.workdir;")).toHaveLength(0);
  });

  test("also keys on StoryWorkdirLike (path-frame.ts structural type)", async () => {
    const found = await check(
      `${IMPORT_WORKDIR_LIKE}\ndeclare const story: StoryWorkdirLike;\nconst w = story.workdir ?? '.';`,
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(3);
  });
});

describe("findViolations — missed idioms (path-frame follow-up C2)", () => {
  test("flags a member chain ctx.story.workdir", async () => {
    const found = await check(
      `${IMPORT_USER_STORY}\ndeclare const ctx: { story: UserStory };\nconst w = ctx.story.workdir ?? '.';`,
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(3);
  });

  test('flags indexed member chain input.story["workdir"]', async () => {
    const found = await check(
      `${IMPORT_USER_STORY}\ndeclare const input: { story: UserStory };\nconst w = input.story["workdir"];`,
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(3);
  });

  test("flags indexed access stories[0].workdir", async () => {
    const found = await check(
      `${IMPORT_USER_STORY}\ndeclare const stories: UserStory[];\nconst w = stories[0].workdir;`,
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(3);
  });

  test("flags multi-element destructuring const { workdir, id } = s", async () => {
    const found = await check(
      `${IMPORT_USER_STORY}\ndeclare const s: UserStory;\nconst { workdir, id } = s;\nconst _x = id;`,
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(3);
  });

  test("flags a renamed destructure const { workdir: wd } = s", async () => {
    // The walker keys on the binding's SOURCE property name (propertyName ??
    // name), not its local alias — a rename must not evade it.
    const found = await check(
      `${IMPORT_USER_STORY}\ndeclare const s: UserStory;\nconst { workdir: wd } = s;\nconst _x = wd;`,
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(3);
  });

  test("flags a cast (s as UserStory).workdir", async () => {
    const found = await check(`${IMPORT_USER_STORY}\ndeclare const s: unknown;\nconst w = (s as UserStory).workdir;`);
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(3);
  });

  test("flags an inferred (non-annotated) receiver from a function return type", async () => {
    const src = [
      IMPORT_USER_STORY,
      "declare function getStory(): UserStory;",
      "const target = getStory();",
      "const w = target.workdir;",
    ].join("\n");
    const found = await check(src);
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(4);
  });
});

describe("findViolations — false positives fixed by the real checker (path-frame follow-up C2)", () => {
  test("does not flag a same-named local that shadows a UserStory-typed parameter elsewhere in the file", async () => {
    const src = [
      IMPORT_USER_STORY,
      "declare function a(story: UserStory): string;",
      "function b() {",
      "  const story = { workdir: '/tmp' };",
      "  return story.workdir;",
      "}",
    ].join("\n");
    expect(await check(src)).toHaveLength(0);
  });

  test("does not flag a regex literal that mentions workdir, even alongside a real story binding", async () => {
    const src = [
      IMPORT_USER_STORY,
      "declare const story: UserStory;",
      "const re = /story.workdir/;",
      "const _x = story;",
    ].join("\n");
    expect(await check(src)).toHaveLength(0);
  });

  test("does not flag an accessor-shaped wrapper's own definition when marked on the access line itself", async () => {
    const src = [
      IMPORT_USER_STORY,
      "export function myStoryWorkdir(story: UserStory): string {",
      "  return story.workdir ?? '.'; // workdir-access-allow: SSOT wrapper, mirrors storyWorkdir()",
      "}",
    ].join("\n");
    expect(await check(src)).toHaveLength(0);
  });

  test("the inline marker also works on the line above the access", async () => {
    const src = [
      IMPORT_USER_STORY,
      "export function myStoryWorkdir(story: UserStory): string {",
      "  // workdir-access-allow: SSOT wrapper, mirrors storyWorkdir()",
      "  return story.workdir ?? '.';",
      "}",
    ].join("\n");
    expect(await check(src)).toHaveLength(0);
  });

  test("an unmarked accessor-shaped wrapper is still flagged (the marker is opt-in, not shape-inferred)", async () => {
    const found = await check(
      [
        IMPORT_USER_STORY,
        "export function myStoryWorkdir(story: UserStory): string {",
        "  return story.workdir ?? '.';",
        "}",
      ].join("\n"),
    );
    expect(found).toHaveLength(1);
  });
});

describe("findViolations — C1: receiver TYPE SHAPE is irrelevant to the checker-provenance check", () => {
  test("flags Readonly<UserStory>", async () => {
    const found = await check(
      `${IMPORT_USER_STORY}\ndeclare const story: Readonly<UserStory>;\nconst w = story.workdir;`,
    );
    expect(found).toHaveLength(1);
  });

  test('flags Pick<UserStory, "workdir">', async () => {
    const found = await check(
      `${IMPORT_USER_STORY}\ndeclare const story: Pick<UserStory, "workdir">;\nconst w = story.workdir;`,
    );
    expect(found).toHaveLength(1);
  });

  test("flags an interface that extends UserStory", async () => {
    const src = [
      IMPORT_USER_STORY,
      "interface PlanStory extends UserStory { extra: number }",
      "declare const story: PlanStory;",
      "const w = story.workdir;",
    ].join("\n");
    expect(await check(src)).toHaveLength(1);
  });

  test("flags an intersection UserStory & { x: number }", async () => {
    const found = await check(
      `${IMPORT_USER_STORY}\ndeclare const story: UserStory & { x: number };\nconst w = story.workdir;`,
    );
    expect(found).toHaveLength(1);
  });

  test("flags a union of two story-shaped types", async () => {
    const src = [
      IMPORT_USER_STORY,
      "interface OtherStory { workdir?: string; other: true }",
      "declare const story: UserStory | OtherStory;",
      "const w = story.workdir;",
    ].join("\n");
    expect(await check(src)).toHaveLength(1);
  });

  test("still does not flag a same-shaped non-story object type ({ workdir: string })", async () => {
    expect(await check("declare const story: { workdir: string };\nconst w = story.workdir;")).toHaveLength(0);
  });
});

describe("findViolations — H1: destructuring ASSIGNMENT (not a BindingElement at all)", () => {
  test("flags a shorthand destructuring assignment ({ workdir } = story)", async () => {
    const found = await check(
      `${IMPORT_USER_STORY}\ndeclare const story: UserStory;\nlet workdir: string | undefined;\n({ workdir } = story);`,
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(4);
  });

  test("flags a renamed destructuring assignment ({ workdir: w } = story)", async () => {
    const found = await check(
      `${IMPORT_USER_STORY}\ndeclare const story: UserStory;\nlet w: string | undefined;\n({ workdir: w } = story);`,
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(4);
  });

  test("does not flag an ordinary object literal named workdir (not an assignment target)", async () => {
    expect(await check("const obj = { workdir: 'x' };\nconst _x = obj;")).toHaveLength(0);
  });
});

describe("findViolations — H2/H3: parameter, nested and for-of destructuring (one rule: pattern-node type)", () => {
  test("flags a destructured function parameter", async () => {
    const src = [IMPORT_USER_STORY, "function g({ workdir }: UserStory) { return workdir; }"].join("\n");
    const found = await check(src);
    expect(found).toHaveLength(1);
  });

  test("flags a destructured arrow-function callback parameter over UserStory[]", async () => {
    const src = [
      IMPORT_USER_STORY,
      "declare const list: UserStory[];",
      "const mapped = list.map(({ workdir }) => workdir);",
    ].join("\n");
    const found = await check(src);
    expect(found).toHaveLength(1);
  });

  test("flags nested destructuring const { story: { workdir } } = ctx", async () => {
    const src = [
      IMPORT_USER_STORY,
      "declare const ctx: { story: UserStory };",
      "const { story: { workdir } } = ctx;",
      "const _x = workdir;",
    ].join("\n");
    const found = await check(src);
    expect(found).toHaveLength(1);
  });

  test("flags for (const { workdir } of stories) — the previously-dead ForOfStatement branch", async () => {
    const src = [
      IMPORT_USER_STORY,
      "declare const stories: UserStory[];",
      "for (const { workdir } of stories) { void workdir; }",
    ].join("\n");
    const found = await check(src);
    expect(found).toHaveLength(1);
  });
});

describe("findViolations — M1: template-literal and computed keys", () => {
  test("flags a no-substitution template key story[`workdir`]", async () => {
    const found = await check(`${IMPORT_USER_STORY}\ndeclare const story: UserStory;\nconst w = story[\`workdir\`];`);
    expect(found).toHaveLength(1);
  });

  test('flags a const-narrowed computed key (const K = "workdir" as const; story[K])', async () => {
    const src = [
      IMPORT_USER_STORY,
      "declare const story: UserStory;",
      'const K = "workdir" as const;',
      "const w = story[K];",
    ].join("\n");
    const found = await check(src);
    expect(found).toHaveLength(1);
  });

  test("does not flag a non-literal computed key", async () => {
    const src = [
      IMPORT_USER_STORY,
      "declare const story: UserStory;",
      "declare const key: string;",
      "const w = story[key];",
    ].join("\n");
    expect(await check(src)).toHaveLength(0);
  });
});

describe("findViolations — H4: inline marker resolved from real comment trivia", () => {
  test("does not honour marker text that appears only inside a string literal", async () => {
    const src = [
      IMPORT_USER_STORY,
      "declare const story: UserStory;",
      "const note = 'see workdir-access-allow: not a real marker';",
      "const w = story.workdir;",
    ].join("\n");
    const found = await check(src);
    expect(found).toHaveLength(1);
  });

  test("does not honour a comment attached to a different, unrelated statement", async () => {
    const src = [
      IMPORT_USER_STORY,
      "declare const story: UserStory;",
      "// workdir-access-allow: this reason is for the NEXT statement, not this one",
      "const unrelated = 1;",
      "const w = story.workdir;",
    ].join("\n");
    const found = await check(src);
    expect(found).toHaveLength(1);
  });

  test("does not honour an empty-reason marker", async () => {
    const src = [
      IMPORT_USER_STORY,
      "declare const story: UserStory;",
      "const w = story.workdir; // workdir-access-allow:",
    ].join("\n");
    const found = await check(src);
    expect(found).toHaveLength(1);
  });

  test("reports a STALE MARKER when the marked statement is not a real story-typed read", async () => {
    const src = [
      "declare const ctx: { workdir: string };",
      "const w = ctx.workdir; // workdir-access-allow: no longer needed",
    ].join("\n");
    const found = await check(src);
    expect(found).toHaveLength(1);
    expect(found[0]?.text).toContain("STALE MARKER");
  });
});

describe("findViolations — C2: a file outside the Program is a hard error, not a silent skip", () => {
  test("throws naming the file when the Program does not contain it", async () => {
    const abs = join(FIXTURE_DIR, "never-created.ts");
    await expect(
      findViolations(project, abs, "test/tmp/story-workdir-access-fixtures/never-created.ts"),
    ).rejects.toThrow(/never-created\.ts/);
  });
});

describe("check-story-workdir-access.ts — fail-closed on a bad scan root", () => {
  test("a missing scan root exits non-zero instead of printing clean", async () => {
    const proc = Bun.spawn(["bun", "run", "scripts/check-story-workdir-access.ts", "/nonexistent-root-xyz"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    expect(exitCode).not.toBe(0);
    expect(stdout).not.toContain("clean");
  }, 30_000);

  test("a root with no src/ at all exits non-zero instead of printing clean (M2)", async () => {
    const root = join(process.cwd(), "test", "tmp", "story-workdir-access-no-src-root");
    await rm(root, { recursive: true, force: true });
    await Bun.write(join(root, "bin", ".keep"), "");
    try {
      const proc = Bun.spawn(["bun", "run", "scripts/check-story-workdir-access.ts", root], {
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      expect(exitCode).not.toBe(0);
      expect(stdout).not.toContain("clean");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

/**
 * DIFFERENTIAL CORPUS vs the regex predecessor (8cae0c3cd^).
 *
 * Every entry is a real bypass idiom this file's brief called out (C1, H1,
 * H2, H3, M1). Each is asserted against BOTH implementations: the current
 * checker-based gate (`findViolations`, expected via `v4Count`) and the
 * frozen regex gate (`findViolationsV1`, expected via `v1Catches`). The
 * final test in this block asserts the SUPERSET property directly: for every
 * entry the regex version caught, the current gate must catch it too. That
 * property is what would have caught both the nax#2084 -> v3 regression (the
 * regex caught receiver-name-shaped bypasses v3's type-string match missed)
 * and this session's v3 -> v4 fix target, and is the guard against a v5
 * repeating either mistake.
 *
 * Deliberately excluded from this table: the shadowing false-positive fixture
 * above (`declare function a(story: UserStory)... const story = { workdir }`)
 * — the regex version, having no type information, WRONGLY flags it (it goes
 * only by the name "story"), while the checker-based gate correctly does not.
 * A superset assertion including that entry would be un-satisfiable by any
 * correct implementation; it is covered on its own above instead.
 */
interface CorpusEntry {
  readonly name: string;
  readonly source: string;
  readonly v4Count: number;
  readonly v1Catches: boolean;
}

const CORPUS: readonly CorpusEntry[] = [
  {
    name: "plain UserStory (control)",
    source: `${IMPORT_USER_STORY}\ndeclare const story: UserStory;\nconst w = story.workdir;`,
    v4Count: 1,
    v1Catches: true,
  },
  {
    name: "Readonly<UserStory>",
    source: `${IMPORT_USER_STORY}\ndeclare const story: Readonly<UserStory>;\nconst w = story.workdir;`,
    v4Count: 1,
    v1Catches: true,
  },
  {
    name: 'Pick<UserStory, "workdir">',
    source: `${IMPORT_USER_STORY}\ndeclare const story: Pick<UserStory, "workdir">;\nconst w = story.workdir;`,
    v4Count: 1,
    v1Catches: true,
  },
  {
    name: "interface PlanStory extends UserStory",
    source: [
      IMPORT_USER_STORY,
      "interface PlanStory extends UserStory { extra: number }",
      "declare const story: PlanStory;",
      "const w = story.workdir;",
    ].join("\n"),
    v4Count: 1,
    v1Catches: true,
  },
  {
    name: "UserStory & { x: number }",
    source: `${IMPORT_USER_STORY}\ndeclare const story: UserStory & { x: number };\nconst w = story.workdir;`,
    v4Count: 1,
    v1Catches: true,
  },
  {
    name: "union of two story-shaped types",
    source: [
      IMPORT_USER_STORY,
      "interface OtherStory { workdir?: string; other: true }",
      "declare const story: UserStory | OtherStory;",
      "const w = story.workdir;",
    ].join("\n"),
    v4Count: 1,
    v1Catches: true,
  },
  {
    name: "member chain ctx.story.workdir",
    source: `${IMPORT_USER_STORY}\ndeclare const ctx: { story: UserStory };\nconst w = ctx.story.workdir;`,
    v4Count: 1,
    v1Catches: true,
  },
  {
    name: "destructuring assignment ({ workdir } = story)",
    source: `${IMPORT_USER_STORY}\ndeclare const story: UserStory;\nlet workdir: string | undefined;\n({ workdir } = story);`,
    v4Count: 1,
    v1Catches: false,
  },
  {
    name: "renamed destructuring assignment ({ workdir: w } = story)",
    source: `${IMPORT_USER_STORY}\ndeclare const story: UserStory;\nlet w: string | undefined;\n({ workdir: w } = story);`,
    v4Count: 1,
    v1Catches: false,
  },
  {
    name: "destructured function parameter",
    source: [IMPORT_USER_STORY, "function g({ workdir }: UserStory) { return workdir; }"].join("\n"),
    v4Count: 1,
    v1Catches: false,
  },
  {
    name: "destructured arrow-callback parameter over UserStory[]",
    source: [
      IMPORT_USER_STORY,
      "declare const list: UserStory[];",
      "const mapped = list.map(({ workdir }) => workdir);",
    ].join("\n"),
    v4Count: 1,
    v1Catches: false,
  },
  {
    name: "nested destructuring const { story: { workdir } } = ctx",
    source: [
      IMPORT_USER_STORY,
      "declare const ctx: { story: UserStory };",
      "const { story: { workdir } } = ctx;",
      "const _x = workdir;",
    ].join("\n"),
    v4Count: 1,
    v1Catches: false,
  },
  {
    name: "for (const { workdir } of stories)",
    source: [
      IMPORT_USER_STORY,
      "declare const stories: UserStory[];",
      "for (const { workdir } of stories) { void workdir; }",
    ].join("\n"),
    v4Count: 1,
    v1Catches: false,
  },
  {
    name: "cast (s as UserStory).workdir",
    source: `${IMPORT_USER_STORY}\ndeclare const s: unknown;\nconst w = (s as UserStory).workdir;`,
    v4Count: 1,
    v1Catches: false,
  },
  {
    name: "inferred receiver from a function return type",
    source: [
      IMPORT_USER_STORY,
      "declare function getStory(): UserStory;",
      "const target = getStory();",
      "const w = target.workdir;",
    ].join("\n"),
    v4Count: 1,
    v1Catches: false,
  },
  {
    name: 'indexed member chain input.story["workdir"]',
    source: `${IMPORT_USER_STORY}\ndeclare const input: { story: UserStory };\nconst w = input.story["workdir"];`,
    v4Count: 1,
    v1Catches: false,
  },
  {
    name: "indexed access stories[0].workdir",
    source: `${IMPORT_USER_STORY}\ndeclare const stories: UserStory[];\nconst w = stories[0].workdir;`,
    v4Count: 1,
    v1Catches: false,
  },
  {
    name: "no-substitution template key story[`workdir`]",
    source: `${IMPORT_USER_STORY}\ndeclare const story: UserStory;\nconst w = story[\`workdir\`];`,
    v4Count: 1,
    v1Catches: false,
  },
  {
    name: 'const-narrowed computed key (const K = "workdir" as const)',
    source: [
      IMPORT_USER_STORY,
      "declare const story: UserStory;",
      'const K = "workdir" as const;',
      "const w = story[K];",
    ].join("\n"),
    v4Count: 1,
    v1Catches: false,
  },
];

/**
 * NOT in the corpus above: a `{ workdir: string }` receiver literally named
 * "story" (`declare const story: { workdir: string }`). The regex
 * predecessor flags it (name-only match), the checker-based gate correctly
 * does not (no real `UserStory`/`StoryWorkdirLike` declaration) — the same
 * asymmetry as the shadowing fixture above. A superset assertion cannot hold
 * over an entry where the OLDER implementation is the one with the false
 * positive; that non-story-receiver behaviour is covered by the standalone
 * tests above ("ignores a non-story receiver", "still does not flag a
 * same-shaped non-story object type") instead.
 */

describe("differential corpus vs the regex predecessor (8cae0c3cd^)", () => {
  for (const entry of CORPUS) {
    test(`v4 catch-count for: ${entry.name}`, async () => {
      const found = await check(entry.source);
      expect(found).toHaveLength(entry.v4Count);
    });

    test(`v1 catches (regex predecessor) for: ${entry.name}`, () => {
      const found = findViolationsV1("fixture.ts", entry.source);
      expect(found.length > 0).toBe(entry.v1Catches);
    });
  }

  test("SUPERSET PROPERTY: the current gate catches every entry the regex predecessor caught", async () => {
    const regressions: string[] = [];
    for (const entry of CORPUS) {
      const v1Found = findViolationsV1("fixture.ts", entry.source).length > 0;
      if (!v1Found) continue;
      const v4Found = (await check(entry.source)).length > 0;
      if (!v4Found) regressions.push(entry.name);
    }
    expect(regressions).toEqual([]);
  });
});
