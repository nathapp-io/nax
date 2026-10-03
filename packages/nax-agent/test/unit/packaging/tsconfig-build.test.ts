/**
 * The published build (S2-6): tsc with nodenext resolution turns explicit
 * `./x.ts` imports into `./x.js` and rejects extensionless ones, so a new
 * extensionless import in src/ fails `bun run build` (CI) and this suite.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cleanupTempDir, makeTempDir } from "#test/helpers/index";

const PKG = resolve(import.meta.dir, "../../..");
const BUILD_CONFIG = join(PKG, "tsconfig.build.json");

function tsc(project: string, outDir?: string): { code: number; out: string } {
  const args = ["bun", "x", "tsc", "-p", project, ...(outDir ? ["--outDir", outDir] : [])];
  const proc = Bun.spawnSync(args, { cwd: PKG });
  return { code: proc.exitCode, out: proc.stdout.toString() + proc.stderr.toString() };
}

/** Relative specifiers in emitted JS: `from "./x"`, `import("./x")`, side-effect `import "./x"`. */
function relativeSpecifiers(js: string): string[] {
  return [...js.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)"(\.{1,2}\/[^"]+)"/g)].map((m) => m[1] ?? "");
}

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

/** A tiny ESM package compiled with the real build config (paths and types overridden). */
function fixture(files: Record<string, string>): string {
  root = makeTempDir("nax-agent-build-");
  write("package.json", JSON.stringify({ type: "module", imports: { "#src/*": "./src/*.ts" } }));
  write(
    "tsconfig.json",
    JSON.stringify({
      extends: BUILD_CONFIG,
      compilerOptions: { rootDir: "src", outDir: "dist", types: [] },
      include: ["src/**/*.ts"],
    }),
  );
  write("src/a.ts", "export const a = 1;\n");
  write("src/b.ts", "export const b = 2;\n");
  write("src/dir/index.ts", "export const d = 3;\n");
  write("src/t.ts", "export interface T { n: number }\n");
  for (const [rel, body] of Object.entries(files)) write(rel, body);
  return join(root, "tsconfig.json");
}

describe("tsconfig.build.json", () => {
  test("rejects an extensionless relative import (TS2835) and a directory import (TS2834)", () => {
    const project = fixture({ "src/main.ts": 'export { a } from "./a";\nexport * from "./dir";\n' });
    const { code, out } = tsc(project);
    expect(code).not.toBe(0);
    expect(out).toContain("TS2835");
    expect(out).toContain("TS2834");
  });

  test("emits .js for explicit .ts relative imports, keeps #src/ bare, and writes declarations", () => {
    const project = fixture({
      "src/main.ts": [
        'export { a } from "./a.ts";',
        'export * from "./dir/index.ts";',
        'export { b } from "#src/b";',
        'export type { T } from "./t.ts";',
        'export const lazy = () => import("./a.ts");',
        "",
      ].join("\n"),
    });
    const { code, out } = tsc(project);
    expect(out).toBe("");
    expect(code).toBe(0);
    const js = readFileSync(join(root, "dist/main.js"), "utf8");
    expect(relativeSpecifiers(js).sort()).toEqual(["./a.js", "./a.js", "./dir/index.js"]);
    expect(js).toContain('"#src/b"');
    expect(js).not.toContain('.ts"');
    expect(existsSync(join(root, "dist/main.d.ts"))).toBe(true);
  });
});
