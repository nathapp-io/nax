import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findBoundaryEdges, formatEdge, specifiersOf } from "@scripts/check-agent-boundary";
import { parseMoveManifest } from "@scripts/lib/agent-move-manifest";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { byCodePoint } from "@/utils/sort";

let root = "";
afterEach(() => {
  if (root) cleanupTempDir(root);
  root = "";
});

function write(rel: string, content: string): void {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf8");
}

const MANIFEST = parseMoveManifest({
  entries: [
    { from: "src/agent/", to: "agent/" },
    { from: "src/util/moving.ts", to: "internal/moving.ts" },
  ],
});

describe("specifiersOf", () => {
  test("collects static, type-only, re-export, side-effect and dynamic specifiers", () => {
    const src = [
      'import { a } from "./a";',
      'import type { B } from "@/b";',
      'export { c } from "../c";',
      'import "./side";',
      'type D = import("./d").D;',
    ].join("\n");
    expect(specifiersOf(src).sort(byCodePoint)).toEqual(["../c", "./a", "./d", "./side", "@/b"]);
  });

  test("ignores specifiers inside comments", () => {
    expect(specifiersOf('// import { x } from "./x";\n/* import("./y") */\n')).toEqual([]);
  });
});

describe("findBoundaryEdges", () => {
  test("counts only edges from the move set to files outside it", () => {
    root = makeTempDir("agent-boundary-");
    write(
      "src/agent/a.ts",
      'import { b } from "./b";\nimport { s } from "@/stay/s";\nimport type { M } from "@/util/moving";\n',
    );
    write("src/agent/b.ts", 'export type T = import("../stay/t").T;\nexport const b = 1;\n');
    write("src/util/moving.ts", 'import { s } from "../stay/s";\nexport type M = string;\n');
    write("src/stay/s.ts", 'import { b } from "../agent/b";\nexport const s = b;\n');
    write("src/stay/t.ts", "export type T = number;\n");

    const edges = findBoundaryEdges(root, MANIFEST).map(formatEdge);
    expect(edges).toEqual([
      "src/agent/a.ts -> src/stay/s.ts",
      "src/agent/b.ts -> src/stay/t.ts",
      "src/util/moving.ts -> src/stay/s.ts",
    ]);
  });

  test("bare package imports are not edges", () => {
    root = makeTempDir("agent-boundary-");
    write("src/agent/a.ts", 'import { createClient } from "@nathapp/nax-ai";\nimport { join } from "node:path";\n');
    expect(findBoundaryEdges(root, MANIFEST)).toEqual([]);
  });

  test("membership change: adding a target to the manifest removes its edges", () => {
    root = makeTempDir("agent-boundary-");
    write("src/agent/a.ts", 'import { s } from "@/stay/s";\n');
    write("src/stay/s.ts", "export const s = 1;\n");
    expect(findBoundaryEdges(root, MANIFEST)).toHaveLength(1);
    const widened = parseMoveManifest({
      entries: [...MANIFEST.entries, { from: "src/stay/s.ts", to: "internal/s.ts" }],
    });
    expect(findBoundaryEdges(root, widened)).toEqual([]);
  });
});
