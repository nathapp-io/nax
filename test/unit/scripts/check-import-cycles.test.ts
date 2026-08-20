import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildImportGraph,
  findImportCycles,
  formatReport,
  resolveSpecifier,
} from "../../../scripts/check-import-cycles";
import { cleanupTempDir, makeTempDir } from "../../helpers/temp";

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

describe("findImportCycles", () => {
  let root: string;
  beforeEach(() => {
    root = makeTempDir("nax-cycles-");
  });
  afterEach(() => cleanupTempDir(root));

  test("reports nothing for an acyclic graph", () => {
    write(root, "src/a/index.ts", 'export { a } from "./leaf";\n');
    write(root, "src/a/leaf.ts", "export const a = 1;\n");
    expect(findImportCycles(root)).toEqual([]);
  });

  test("detects a barrel cycle", () => {
    write(root, "src/a/index.ts", 'export { a } from "./leaf";\n');
    write(root, "src/a/leaf.ts", 'import { z } from "./sibling";\nexport const a = z;\n');
    write(root, "src/a/sibling.ts", 'import { a } from "./index";\nexport const z = a;\n');

    const cycles = findImportCycles(root);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.files).toContain("src/a/index.ts");
  });

  test("a type-only edge does not close a cycle", () => {
    write(root, "src/a/index.ts", 'export { a } from "./leaf";\n');
    write(root, "src/a/leaf.ts", 'import { z } from "./sibling";\nexport const a = z;\n');
    write(root, "src/a/sibling.ts", 'import type { A } from "./index";\nexport const z: A | number = 1;\n');

    expect(findImportCycles(root)).toEqual([]);
  });

  test("reports one cycle regardless of the entry point it is found from", () => {
    write(root, "src/a/one.ts", 'import { t } from "./two";\nexport const o = t;\n');
    write(root, "src/a/two.ts", 'import { o } from "./one";\nexport const t = o;\n');
    write(root, "src/a/entry-x.ts", 'import { o } from "./one";\nexport const x = o;\n');
    write(root, "src/a/entry-y.ts", 'import { t } from "./two";\nexport const y = t;\n');

    expect(findImportCycles(root)).toHaveLength(1);
  });
});

describe("formatReport", () => {
  const cycle = { files: ["src/a/index.ts", "src/a/leaf.ts"], key: "src/a/index.ts -> src/a/leaf.ts" };

  test("fails when no baseline exists", () => {
    const { ok, message } = formatReport([], null);
    expect(ok).toBe(false);
    expect(message).toContain("--update-baseline");
  });

  test("passes when the count matches the baseline", () => {
    const { ok, message } = formatReport([cycle], { count: 1, updatedAt: "", keys: [cycle.key] });
    expect(ok).toBe(true);
    expect(message).toContain("[OK]");
  });

  test("passes and notes improvement when the count drops", () => {
    const { ok, message } = formatReport([], { count: 3, updatedAt: "", keys: [] });
    expect(ok).toBe(true);
    expect(message).toContain("down 3");
  });

  test("fails and names the new cycle when the count grows", () => {
    const { ok, message } = formatReport([cycle], { count: 0, updatedAt: "", keys: [] });
    expect(ok).toBe(false);
    expect(message).toContain("1 new runtime import cycle");
    expect(message).toContain("src/a/index.ts -> src/a/leaf.ts");
  });
});
