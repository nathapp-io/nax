import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatReport, type HatchKind, scanEscapeHatches } from "@scripts/check-test-escape-hatches";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

function write(root: string, rel: string, content: string) {
  mkdirSync(join(root, rel.split("/").slice(0, -1).join("/")), { recursive: true });
  writeFileSync(join(root, rel), content);
}

/**
 * Three counters, down from eight. The five that retired on 2026-08-27
 * (`asAny`, `anyType`, `nonNullAssert`, `asNever`, `absentValue`) each have a
 * biome rule or GritQL plugin at `error` behind them now, so their regexes
 * could only ever fire on prose. Their behavioural tests moved with them: the
 * `noExplicitAny` / `noNonNullAssertion` severities are pinned by
 * `test/unit/scripts/biome-test-severity.test.ts`, and the two plugins by
 * `biome-no-as-never-plugin.test.ts` / `biome-no-absent-value-plugin.test.ts`.
 * See docs/plans/STATUS-test-debt-drain.md §8.14.
 */
const BASE = {
  tsSuppress: 0,
  ratchetAllow: 0,
  looseCast: 0,
};

describe("scanEscapeHatches", () => {
  let root: string;

  beforeEach(() => {
    root = makeTempDir("nax-hatches-");
  });
  afterEach(() => cleanupTempDir(root));

  test("scans .tsx as well as .ts", async () => {
    // Regression guard: the glob read `**/*.ts` for the whole drain, so
    // test/ui/'s six .tsx files were invisible to every counter and six real
    // `as never` sites went uncounted. See the glob's comment in the script.
    write(root, "test/ui/a.test.tsx", "const x = y as Widget;\n");
    const { counts, byFile } = await scanEscapeHatches(root);
    expect(counts.looseCast).toBe(1);
    expect(byFile["test/ui/a.test.tsx"]?.looseCast).toBe(1);
  });

  test("counts each hatch kind separately", async () => {
    write(
      root,
      "test/unit/a.test.ts",
      [
        "const w = foo as Bar;",
        "// @ts-expect-error deliberate",
        "const y = bar as unknown as Baz; // test-ratchet-allow: as-unknown-as",
      ].join("\n"),
    );
    const { counts } = await scanEscapeHatches(root);
    expect(counts).toEqual({ ...BASE, looseCast: 1, tsSuppress: 1, ratchetAllow: 1 });
  });

  test("counts every hatch on a line, not the line once", async () => {
    write(root, "test/unit/a.test.ts", "call(x as Foo, y as Bar);\n");
    expect((await scanEscapeHatches(root)).counts.looseCast).toBe(2);
  });

  test("counts @ts-ignore and @ts-nocheck alongside @ts-expect-error", async () => {
    write(root, "test/unit/a.test.ts", "// @ts-ignore\n// @ts-nocheck\n// @ts-expect-error\n");
    expect((await scanEscapeHatches(root)).counts.tsSuppress).toBe(3);
  });

  /**
   * Anchored to the comment OPENER, which is where TypeScript requires a real
   * directive to sit: the first text in the comment. Anything else in between
   * makes it prose about the directive, not the directive.
   *
   * Deliberately NOT anchored to the start of a line — `foo(); // @ts-expect-error`
   * is a real suppression, and a `^`-anchored pattern would miss it. This
   * counter has been wrong in that direction twice before (the `**\/*.ts` glob
   * that hid six .tsx files, and the `nonNullAssert` regex that undercounted
   * by 272), so the cases below pin both halves.
   */
  test("tsSuppress counts every real directive form, including one trailing after code", async () => {
    write(
      root,
      "test/unit/a.test.ts",
      [
        "// @ts-expect-error spaced",
        "//@ts-expect-error unspaced",
        "/* @ts-ignore */",
        "/** @ts-expect-error */",
        " * @ts-nocheck",
        "foo(); // @ts-ignore trailing after code",
        "  // @ts-nocheck indented",
      ].join("\n"),
    );
    expect((await scanEscapeHatches(root)).counts.tsSuppress).toBe(7);
  });

  test("tsSuppress does not count prose that merely names a directive", async () => {
    // The real residue this closed: run-regression.test.ts explains why it
    // asserts at the type level INSTEAD of suppressing, and the unanchored
    // pattern read those two sentences as two suppressions. §4 forbids
    // deleting such a comment to lower a count, so the regex was the defect.
    write(
      root,
      "test/unit/a.test.ts",
      [
        "// Asserted at the type level, not with `@ts-expect-error` on a value literal.",
        "// a single @ts-expect-error on the literal asserts less than it looks",
        "/** Prefer a type-level assertion over @ts-expect-error here. */",
        'const s = "a string mentioning @ts-ignore";',
      ].join("\n"),
    );
    expect((await scanEscapeHatches(root)).counts.tsSuppress).toBe(0);
  });

  test("does not scan src/, scripts/ or bin/", async () => {
    mkdirSync(join(root, "test"), { recursive: true });
    write(root, "src/foo.ts", "const x = a as Foo;\n");
    write(root, "scripts/foo.ts", "const x = a as Foo;\n");
    write(root, "bin/foo.ts", "const x = a as Foo;\n");
    expect((await scanEscapeHatches(root)).counts.looseCast).toBe(0);
  });

  test("records per-file counts", async () => {
    write(root, "test/unit/a.test.ts", "const x = a as Foo;\nconst y = b as Bar;\n");
    write(root, "test/unit/b.test.ts", "// @ts-ignore\n");
    const { byFile } = await scanEscapeHatches(root);
    expect(byFile["test/unit/a.test.ts"]?.looseCast).toBe(2);
    expect(byFile["test/unit/b.test.ts"]?.tsSuppress).toBe(1);
  });

  /**
   * GitHub #1682: an exemption is per kind, never per file. Driven through the
   * injectable `exemptions` parameter because every entry in the live map is
   * currently `ALL_KINDS` — without the seam this branch would be unreachable
   * from a test, and the guarantee would go untested rather than untrue.
   */
  test("a file exempt for one kind is still graded by the others", async () => {
    write(root, "test/unit/a.test.ts", "// @ts-ignore\nconst probe = {} as Foo;\n");
    const exemptions = new Map<string, ReadonlySet<HatchKind>>([
      ["test/unit/a.test.ts", new Set<HatchKind>(["tsSuppress"])],
    ]);
    const { counts } = await scanEscapeHatches(root, exemptions);
    expect(counts.tsSuppress).toBe(0);
    expect(counts.looseCast).toBe(1);
  });

  // test-ratchet-allow: as-unknown-as — title and fixture quote the phrase
  test("looseCast counts `x as Foo` but not `as unknown as`, `as const`, or a lowercase type", async () => {
    write(
      root,
      "test/unit/a.test.ts",
      // test-ratchet-allow: as-unknown-as
      ["const a = x as Foo;", "const b = x as unknown as Foo;", "const c = x as const;", "const d = x as never;"].join(
        "\n",
      ),
    );
    const { counts } = await scanEscapeHatches(root);
    expect(counts.looseCast).toBe(1);
  });

  /**
   * The anchor that made `as never` invisible here for two phases of its drain
   * — 619 uncounted sites. `as never` is now biome-plugins/no-as-never.grit's
   * job, but this pins WHY the counter could not do it: any new lowercase
   * bottom-ish type is equally invisible, so a rule is the only fix.
   */
  test("looseCast cannot see a lowercase target type — the anchor is `as [A-Z]`", async () => {
    write(root, "test/unit/a.test.ts", ["const a = x as never;", "const b = y as unknown;"].join("\n"));
    expect((await scanEscapeHatches(root)).counts.looseCast).toBe(0);
  });
});

describe("formatReport", () => {
  const scan = (counts: Partial<typeof BASE>, byFile = {}) => ({ counts: { ...BASE, ...counts }, byFile });

  test("passes when every counter is at or below baseline", () => {
    const { ok, message } = formatReport(scan({ looseCast: 5 }), {
      counts: { ...BASE, looseCast: 5 },
      updatedAt: "",
    });
    expect(ok).toBe(true);
    expect(message).toContain("[OK]");
    expect(message).toContain("looseCast=5");
  });

  test("notes each counter that shrank", () => {
    const { ok, message } = formatReport(scan({ looseCast: 2, tsSuppress: 1 }), {
      counts: { ...BASE, looseCast: 5, tsSuppress: 3 },
      updatedAt: "",
    });
    expect(ok).toBe(true);
    expect(message).toContain("looseCast ↓ 3");
    expect(message).toContain("tsSuppress ↓ 2");
  });

  test("fails when any single counter grows, naming the offending file", () => {
    const { ok, message, grown } = formatReport(
      scan({ looseCast: 5, ratchetAllow: 4 }, { "test/a.test.ts": { ratchetAllow: 4 } }),
      {
        counts: { ...BASE, looseCast: 5, ratchetAllow: 1 },
        updatedAt: "",
        byFile: { "test/a.test.ts": { ratchetAllow: 1 } },
      },
    );
    expect(ok).toBe(false);
    expect(grown).toEqual(["ratchetAllow"]);
    expect(message).toContain("ratchetAllow: 1 → 4");
    expect(message).toContain("test/a.test.ts");
  });

  test("reports every grown counter, not just the first", () => {
    const { grown } = formatReport(scan({ tsSuppress: 9, looseCast: 9 }), { counts: BASE, updatedAt: "" });
    expect(grown).toEqual(["tsSuppress", "looseCast"]);
  });

  test("fails when no baseline exists", () => {
    const { ok, message } = formatReport(scan({ looseCast: 1 }), null);
    expect(ok).toBe(false);
    expect(message).toContain("--update-baseline");
  });
});
