import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildImportGraph,
  findCyclicModules,
  formatReport,
  resolveSpecifier,
} from "@scripts/check-import-cycles";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

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
});

describe("findCyclicModules", () => {
  let root: string;
  beforeEach(() => {
    root = makeTempDir("nax-cycles-");
  });
  afterEach(() => cleanupTempDir(root));

  const files = (root: string) => findCyclicModules(root).map((m) => m.file).sort();

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
