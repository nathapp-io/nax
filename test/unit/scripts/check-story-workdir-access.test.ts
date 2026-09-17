import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { findStaleExemptions, findViolations, type Violation } from "@scripts/check-story-workdir-access";
import type { Project } from "typescript/unstable/async";
import { API } from "typescript/unstable/async";

/**
 * v3 (nax path-frame follow-up) resolves the REAL type at each candidate
 * site via `typescript/unstable/async`'s Program/Checker, not a per-file
 * syntactic binding map. That needs a real `Project`, which needs a real
 * file on disk inside a tsconfig-included tree — the API refused to attach
 * a file outside `tsconfig.test.json`'s `include` globs even when told it
 * was "created" (verified: `getSourceFile` returned undefined for a file
 * under the OS temp dir). `test/helpers/temp.ts`'s `withTempDir()` uses
 * `os.tmpdir()` for portability, which is exactly the directory that does
 * NOT work here, so this file manages its own scratch directory under the
 * already-gitignored `test/tmp/` instead (`.gitignore:59`) rather than
 * reaching for that helper.
 *
 * Each fixture gets its own file (`fixture-<n>.ts`) rather than one file
 * rewritten per test: a "created" file change is unambiguous, and a
 * "changed" one on a file the snapshot has not seen yet is not.
 *
 * Most fixtures declare the receiver's type with `declare const x: UserStory;`
 * and no import. The real checker still resolves the type NAME correctly
 * for an unresolved SINGLE type reference (verified against the live API:
 * it echoes the written name, e.g. "UserStory", not "any") — so a bare
 * annotation is enough to pin the STORY_TYPES match, while a
 * differently-shaped receiver (an inferred object literal type, a
 * same-named local, ...) resolves to ITS OWN real type and correctly
 * misses. A UNION involving an unresolved name does NOT survive the same
 * way — the checker's error recovery collapses `UserStory | undefined` to
 * bare "any" when `UserStory` is unresolvable, unlike the single-reference
 * case — so the optional-chaining fixture below imports the real `UserStory`
 * from `@/prd` instead of declaring a bare one. Production code, unlike
 * most of these fixtures, is always type-checked against the real `@/prd`
 * `UserStory` by the whole-repo scan.
 */

const FIXTURE_DIR = join(process.cwd(), "test", "tmp", "story-workdir-access-fixtures");

let api: API;
let project: Project;
let fixtureCounter = 0;

beforeAll(async () => {
  api = new API({ cwd: process.cwd() });
  // Ensure the directory exists before the first fixture write.
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
  // checker resolves an incoherent merged/ambiguous type -- reproduced: this
  // was silently corrupting later fixtures' type resolution before this
  // fix. Appending `export {}` makes each fixture its own MODULE, which
  // scopes every top-level declaration to that file alone.
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
    const found = await check("declare const story: UserStory;\nconst w = story.workdir ?? '';");
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(2);
  });

  test("flags a property-access chain where the root binding has UserStory type", async () => {
    const found = await check(
      "declare const story: UserStory;\ndeclare function reframe(a: string, b: unknown): void;\nreframe('x', story.workdir);",
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(3);
  });

  test("ignores a non-story receiver (no UserStory type)", async () => {
    expect(await check("declare const ctx: { workdir: string };\nconst w = ctx.workdir;")).toHaveLength(0);
  });

  test("ignores line comments and doc comments", async () => {
    const src = [
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
        "declare const story: UserStory;\ndeclare function storyWorkdir(s: UserStory): string;\nconst w = storyWorkdir(story);",
      ),
    ).toHaveLength(0);
  });

  test("reports every occurrence on separate lines", async () => {
    const src = [
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
    // A union with an unresolved bare type name collapses to "any" in the
    // checker's error recovery (unlike a single unresolved type reference,
    // which echoes its written name) -- this needs the REAL, resolvable
    // UserStory to exercise the union-stripping path genuinely.
    const found = await check(
      "import type { UserStory } from \"@/prd\";\ndeclare const story: UserStory | undefined;\nconst w = story?.workdir ?? '.';",
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(3);
  });

  test("flags destructuring const { workdir } = story", async () => {
    const found = await check("declare const story: UserStory;\nconst { workdir } = story;");
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(2);
  });

  test("flags element access story['workdir']", async () => {
    const found = await check("declare const story: UserStory;\nconst w = story['workdir'];");
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(2);
  });

  test('flags element access story["workdir"]', async () => {
    const found = await check('declare const story: UserStory;\nconst w = story["workdir"];');
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(2);
  });

  test("flags target.workdir when target has UserStory type (non-*story name)", async () => {
    const found = await check("declare const target: UserStory;\nconst w = target.workdir;");
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(2);
  });

  test("does not flag target.workdir when target lacks a story type", async () => {
    expect(await check("declare const target: { other: string };\nconst w = target.other;")).toHaveLength(0);
  });

  test("does not flag storyWorkdir(story) accessor call", async () => {
    expect(
      await check(
        "declare const story: UserStory;\ndeclare function storyWorkdir(s: UserStory): string;\nconst w = storyWorkdir(story);",
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
    const found = await check("declare const story: StoryWorkdirLike;\nconst w = story.workdir ?? '.';");
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(2);
  });
});

describe("findViolations — missed idioms (path-frame follow-up C2)", () => {
  test("flags a member chain ctx.story.workdir", async () => {
    const found = await check("declare const ctx: { story: UserStory };\nconst w = ctx.story.workdir ?? '.';");
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(2);
  });

  test('flags indexed member chain input.story["workdir"]', async () => {
    const found = await check('declare const input: { story: UserStory };\nconst w = input.story["workdir"];');
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(2);
  });

  test("flags indexed access stories[0].workdir", async () => {
    const found = await check("declare const stories: UserStory[];\nconst w = stories[0].workdir;");
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(2);
  });

  test("flags multi-element destructuring const { workdir, id } = s", async () => {
    const found = await check("declare const s: UserStory;\nconst { workdir, id } = s;\nconst _x = id;");
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(2);
  });

  test("flags a renamed destructure const { workdir: wd } = s", async () => {
    // The walker keys on the binding's SOURCE property name (propertyName ??
    // name), not its local alias — a rename must not evade it.
    const found = await check("declare const s: UserStory;\nconst { workdir: wd } = s;\nconst _x = wd;");
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(2);
  });

  test("flags a cast (s as UserStory).workdir", async () => {
    const found = await check("declare const s: unknown;\nconst w = (s as UserStory).workdir;");
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(2);
  });

  test("flags an inferred (non-annotated) receiver from a function return type", async () => {
    const src = [
      "declare function getStory(): UserStory;",
      "const target = getStory();",
      "const w = target.workdir;",
    ].join("\n");
    const found = await check(src);
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(3);
  });
});

describe("findViolations — false positives fixed by the real checker (path-frame follow-up C2)", () => {
  test("does not flag a same-named local that shadows a UserStory-typed parameter elsewhere in the file", async () => {
    const src = [
      "declare function a(story: UserStory): string;",
      "function b() {",
      "  const story = { workdir: '/tmp' };",
      "  return story.workdir;",
      "}",
    ].join("\n");
    expect(await check(src)).toHaveLength(0);
  });

  test("does not flag a regex literal that mentions workdir, even alongside a real story binding", async () => {
    const src = ["declare const story: UserStory;", "const re = /story.workdir/;", "const _x = story;"].join("\n");
    expect(await check(src)).toHaveLength(0);
  });

  test("does not flag an accessor-shaped wrapper's own definition when marked on the access line itself", async () => {
    const src = [
      "export function myStoryWorkdir(story: UserStory): string {",
      "  return story.workdir ?? '.'; // workdir-access-allow: SSOT wrapper, mirrors storyWorkdir()",
      "}",
    ].join("\n");
    expect(await check(src)).toHaveLength(0);
  });

  test("the inline marker also works on the line above the access", async () => {
    const src = [
      "export function myStoryWorkdir(story: UserStory): string {",
      "  // workdir-access-allow: SSOT wrapper, mirrors storyWorkdir()",
      "  return story.workdir ?? '.';",
      "}",
    ].join("\n");
    expect(await check(src)).toHaveLength(0);
  });

  test("an unmarked accessor-shaped wrapper is still flagged (the marker is opt-in, not shape-inferred)", async () => {
    const found = await check(
      ["export function myStoryWorkdir(story: UserStory): string {", "  return story.workdir ?? '.';", "}"].join("\n"),
    );
    expect(found).toHaveLength(1);
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
});
