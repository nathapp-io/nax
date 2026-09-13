import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildImportGraph,
  findCyclicModules,
  formatReport,
  resolveSpecifier,
  stripComments,
} from "@scripts/check-import-cycles";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { byCodePoint } from "@/utils/sort";

function write(root: string, rel: string, content: string): void {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

describe("resolveSpecifier", () => {
  let root: string;
  beforeEach(() => {
    root = makeTempDir("nax-cycles-");
    write(root, "src/a/leaf.ts", "export const a = 1;\n");
    write(root, "src/a/index.ts", 'export { a } from "./leaf";\n');
  });
  afterEach(() => cleanupTempDir(root));

  test("resolves a relative specifier to a .ts file", () => {
    const from = join(root, "src/a/index.ts");
    expect(resolveSpecifier(root, from, "./leaf")).toBe(join(root, "src/a/leaf.ts"));
  });

  test("resolves an @/ alias to src/", () => {
    const from = join(root, "src/a/leaf.ts");
    expect(resolveSpecifier(root, from, "@/a")).toBe(join(root, "src/a/index.ts"));
  });

  test("resolves a .js specifier to its .ts source (TypeScript ESM convention)", () => {
    const from = join(root, "src/a/index.ts");
    expect(resolveSpecifier(root, from, "./leaf.js")).toBe(join(root, "src/a/leaf.ts"));
  });

  test("returns null for a bare package specifier", () => {
    const from = join(root, "src/a/index.ts");
    expect(resolveSpecifier(root, from, "zod")).toBeNull();
  });
});

describe("buildImportGraph", () => {
  let root: string;
  beforeEach(() => {
    root = makeTempDir("nax-cycles-");
  });
  afterEach(() => cleanupTempDir(root));

  test("excludes type-only imports — they are erased and cannot cycle", () => {
    write(root, "src/a/leaf.ts", 'import type { B } from "./other";\nexport const a = 1;\n');
    write(root, "src/a/other.ts", "export interface B { n: number }\n");

    const graph = buildImportGraph(root);
    expect(graph.get(join(root, "src/a/leaf.ts"))).toEqual([]);
  });

  test("includes value imports", () => {
    write(root, "src/a/leaf.ts", 'import { b } from "./other";\nexport const a = b;\n');
    write(root, "src/a/other.ts", "export const b = 1;\n");

    const graph = buildImportGraph(root);
    expect(graph.get(join(root, "src/a/leaf.ts"))).toEqual([join(root, "src/a/other.ts")]);
  });

  // Regression: the matcher ran over raw file text, so prose in a comment that
  // happened to contain the shape `import ... from "..."` was parsed as a real
  // dependency. src/cli/plan-command.ts carries exactly such a comment and it
  // fabricated a plan-command -> plan edge, which then showed up as a runtime
  // import cycle that did not exist. Comments are stripped before matching.
  test("ignores an import-shaped line comment", () => {
    write(root, "src/a/leaf.ts", '// callers that import from "./other" still work\nexport const a = 1;\n');
    write(root, "src/a/other.ts", "export const b = 1;\n");

    const graph = buildImportGraph(root);
    expect(graph.get(join(root, "src/a/leaf.ts"))).toEqual([]);
  });

  test("ignores an import-shaped block comment", () => {
    write(
      root,
      "src/a/leaf.ts",
      '/**\n * Historically you would import { b } from "./other" here.\n */\nexport const a = 1;\n',
    );
    write(root, "src/a/other.ts", "export const b = 1;\n");

    const graph = buildImportGraph(root);
    expect(graph.get(join(root, "src/a/leaf.ts"))).toEqual([]);
  });

  test("keeps a real import that carries a trailing comment", () => {
    write(
      root,
      "src/a/leaf.ts",
      'import { b } from "./other"; // and not import { c } from "./third"\nexport const a = b;\n',
    );
    write(root, "src/a/other.ts", "export const b = 1;\n");
    write(root, "src/a/third.ts", "export const c = 1;\n");

    const graph = buildImportGraph(root);
    expect(graph.get(join(root, "src/a/leaf.ts"))).toEqual([join(root, "src/a/other.ts")]);
  });

  // A naive stripper treats the `/*` inside this string literal as opening a
  // block comment and swallows the real import that follows it.
  test("does not treat a comment marker inside a string literal as a comment", () => {
    write(root, "src/a/leaf.ts", 'const s = "/*";\nimport { b } from "./other";\nexport const a = b + s;\n');
    write(root, "src/a/other.ts", "export const b = 1;\n");

    const graph = buildImportGraph(root);
    expect(graph.get(join(root, "src/a/leaf.ts"))).toEqual([join(root, "src/a/other.ts")]);
  });

  // Regression: the prelude used to be `[^"']*?`, which crosses newlines, so a
  // match could start at `export interface X {` and run down to an unrelated
  // statement's `from "..."`. The prelude then lost its `type` prefix and a
  // type-only re-export was counted as a value edge. src/config/runtime-types.ts
  // has exactly this shape. A quote in the intervening text masked it, which is
  // why stripping comments surfaced it.
  test("a type-only re-export below an interface block is not a value edge", () => {
    write(
      root,
      "src/a/leaf.ts",
      [
        "export interface Thing {",
        "  name?: string;",
        "}",
        "",
        "// Re-exported to keep a single source of truth",
        'export type { B } from "./other";',
        "",
      ].join("\n"),
    );
    write(root, "src/a/other.ts", "export interface B { n: number }\n");

    const graph = buildImportGraph(root);
    expect(graph.get(join(root, "src/a/leaf.ts"))).toEqual([]);
  });

  test("still records a multi-line value re-export", () => {
    write(root, "src/a/leaf.ts", 'export {\n  b,\n  c,\n} from "./other";\n');
    write(root, "src/a/other.ts", "export const b = 1;\nexport const c = 2;\n");

    const graph = buildImportGraph(root);
    expect(graph.get(join(root, "src/a/leaf.ts"))).toEqual([join(root, "src/a/other.ts")]);
  });

  test("records a namespace import as a value edge", () => {
    write(root, "src/a/leaf.ts", 'import * as other from "./other";\nexport const a = other.b;\n');
    write(root, "src/a/other.ts", "export const b = 1;\n");

    const graph = buildImportGraph(root);
    expect(graph.get(join(root, "src/a/leaf.ts"))).toEqual([join(root, "src/a/other.ts")]);
  });
});

describe("stripComments", () => {
  test("blanks a line comment but keeps the line count", () => {
    const out = stripComments('// import { b } from "./other"\nconst a = 1;\n');
    expect(out).not.toContain("import");
    expect(out.split("\n")).toHaveLength(3);
  });

  test("blanks a block comment and preserves its newlines", () => {
    const out = stripComments('/*\nimport { b } from "./other";\n*/\nconst a = 1;\n');
    expect(out).not.toContain("import");
    expect(out.split("\n")).toHaveLength(5);
  });

  test("leaves string literals intact so real specifiers survive", () => {
    const source = 'import { b } from "./other";\n';
    expect(stripComments(source)).toBe(source);
  });

  test("does not open a comment on a marker inside a string", () => {
    expect(stripComments('const s = "// not a comment";\nconst a = 1;\n')).toContain("// not a comment");
  });

  test("keeps an escaped quote from ending a string early", () => {
    const source = 'const s = "a\\"b"; // gone\n';
    const out = stripComments(source);
    expect(out).toContain('"a\\"b"');
    expect(out).not.toContain("gone");
  });
});

describe("findCyclicModules", () => {
  let root: string;
  beforeEach(() => {
    root = makeTempDir("nax-cycles-");
  });
  afterEach(() => cleanupTempDir(root));

  const files = (root: string) =>
    findCyclicModules(root)
      .map((m) => m.file)
      .sort(byCodePoint);

  test("reports nothing for an acyclic graph", () => {
    write(root, "src/a/index.ts", 'export { a } from "./leaf";\n');
    write(root, "src/a/leaf.ts", "export const a = 1;\n");
    expect(findCyclicModules(root)).toEqual([]);
  });

  test("detects a barrel cycle", () => {
    write(root, "src/a/index.ts", 'export { a } from "./leaf";\n');
    write(root, "src/a/leaf.ts", 'import { z } from "./sibling";\nexport const a = z;\n');
    write(root, "src/a/sibling.ts", 'import { a } from "./index";\nexport const z = a;\n');

    expect(files(root)).toEqual(["src/a/index.ts", "src/a/leaf.ts", "src/a/sibling.ts"]);
  });

  test("a type-only edge does not close a cycle", () => {
    write(root, "src/a/index.ts", 'export { a } from "./leaf";\n');
    write(root, "src/a/leaf.ts", 'import { z } from "./sibling";\nexport const a = z;\n');
    write(root, "src/a/sibling.ts", 'import type { A } from "./index";\nexport const z: A | number = 1;\n');

    expect(findCyclicModules(root)).toEqual([]);
  });

  test("does not report modules that merely reach a cycle without being in it", () => {
    write(root, "src/a/one.ts", 'import { t } from "./two";\nexport const o = t;\n');
    write(root, "src/a/two.ts", 'import { o } from "./one";\nexport const t = o;\n');
    write(root, "src/a/entry.ts", 'import { o } from "./one";\nexport const x = o;\n');

    expect(files(root)).toEqual(["src/a/one.ts", "src/a/two.ts"]);
  });

  // Regression: the previous DFS marked a node DONE after its first visit and
  // never re-examined it, so only the first simple cycle found in a strongly
  // connected component was reported. Here `four` closes a second cycle
  // (one -> four -> three -> one) through `three`, which is already DONE by
  // the time `four` is reached — the old checker reported `four` as clean.
  // This is the false negative that hid the review-builder cycle in the
  // deep-relatives migration runbook, section 7.2.
  test("reports every module of a component, not just the first cycle found", () => {
    write(root, "src/a/one.ts", 'import { t } from "./two";\nimport { f } from "./four";\nexport const o = t + f;\n');
    write(root, "src/a/two.ts", 'import { h } from "./three";\nexport const t = h;\n');
    write(root, "src/a/three.ts", 'import { o } from "./one";\nexport const h = o;\n');
    write(root, "src/a/four.ts", 'import { h } from "./three";\nexport const f = h;\n');

    expect(files(root)).toEqual(["src/a/four.ts", "src/a/one.ts", "src/a/three.ts", "src/a/two.ts"]);
  });

  test("detects a module that imports itself", () => {
    write(root, "src/a/self.ts", 'import { s } from "./self";\nexport const s = s;\n');
    expect(files(root)).toEqual(["src/a/self.ts"]);
  });

  test("gives each module a representative cycle that starts and closes on it", () => {
    write(root, "src/a/index.ts", 'export { a } from "./leaf";\n');
    write(root, "src/a/leaf.ts", 'import { z } from "./sibling";\nexport const a = z;\n');
    write(root, "src/a/sibling.ts", 'import { a } from "./index";\nexport const z = a;\n');

    for (const m of findCyclicModules(root)) {
      expect(m.cycle[0]).toBe(m.file);
      expect(m.cycle.length).toBeGreaterThan(1);
    }
  });
});

describe("formatReport", () => {
  const mod = { file: "src/a/leaf.ts", cycle: ["src/a/leaf.ts", "src/a/index.ts"] };

  test("fails when no baseline exists", () => {
    const { ok, message } = formatReport([], null);
    expect(ok).toBe(false);
    expect(message).toContain("--update-baseline");
  });

  test("passes when the count matches the baseline", () => {
    const { ok, message } = formatReport([mod], { count: 1, updatedAt: "", modules: [mod.file] });
    expect(ok).toBe(true);
    expect(message).toContain("[OK]");
  });

  test("passes and notes improvement when the count drops", () => {
    const { ok, message } = formatReport([], { count: 3, updatedAt: "", modules: [] });
    expect(ok).toBe(true);
    expect(message).toContain("down 3");
  });

  test("fails on a newly cyclic module even when the total count drops", () => {
    const { ok, message } = formatReport([mod], {
      count: 3,
      updatedAt: "",
      modules: ["src/b/one.ts", "src/b/two.ts", "src/b/three.ts"],
    });
    expect(ok).toBe(false);
    expect(message).toContain("1 module");
    expect(message).toContain("src/a/leaf.ts");
  });

  test("fails and names the newly cyclic module when the count grows", () => {
    const { ok, message } = formatReport([mod], { count: 0, updatedAt: "", modules: [] });
    expect(ok).toBe(false);
    expect(message).toContain("1 module");
    expect(message).toContain("src/a/leaf.ts -> src/a/index.ts -> src/a/leaf.ts");
  });
});
