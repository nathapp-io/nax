import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import {
  type ApiSurface,
  checkApiSnapshot,
  diffSnapshots,
  extractApiSurface,
  extractPackageSurface,
  privateNamesOnPublicEntry,
  renderSnapshot,
  snapshotPathFor,
} from "#scripts/lib/api-surface";

const BUILD_CONFIG = {
  compilerOptions: {
    target: "ESNext",
    module: "nodenext",
    moduleResolution: "nodenext",
    strict: true,
    skipLibCheck: true,
    allowImportingTsExtensions: true,
    rewriteRelativeImportExtensions: true,
    declaration: true,
    rootDir: "src",
    outDir: "dist",
    types: [],
  },
  include: ["src/**/*.ts"],
};

const FIXTURE_FILES: Record<string, string> = {
  "src/a.ts": [
    "export const alpha = 1;",
    "export function Zed(): void {}",
    "export interface Shape { n: number }",
    "export class Klass {}",
    "export enum Mode { A }",
    "export type Id = string;",
    "export const _seam = { now: () => 0 };",
    "",
  ].join("\n"),
  "src/b.ts": "export const hidden = 2;\nexport interface Opts { x: number }\n",
  "src/index.ts": [
    'export * from "#src/a";',
    'export { hidden as renamed } from "./b.ts";',
    'export type { Opts } from "./b.ts";',
    'export * as ns from "./b.ts";',
    "",
  ].join("\n"),
  "src/internal.ts": 'export * from "./a.ts";\nexport const only = 1;\n',
};

function writeFixture(root: string, files: Record<string, string>): void {
  const all: Record<string, string> = {
    "package.json": JSON.stringify({ name: "@scope/fixture", type: "module", imports: { "#src/*": "./src/*.ts" } }),
    "tsconfig.build.json": JSON.stringify(BUILD_CONFIG),
    ...files,
  };
  for (const [rel, body] of Object.entries(all)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body, "utf8");
  }
}

const roots: string[] = [];
function fixture(files: Record<string, string> = FIXTURE_FILES): string {
  const root = makeTempDir("api-surface-");
  roots.push(root);
  writeFixture(root, files);
  return root;
}
afterAll(() => {
  for (const r of roots) cleanupTempDir(r);
});

let surface: ApiSurface;
beforeAll(async () => {
  surface = await extractPackageSurface(fixture());
}, 60_000);

const names = (entries: ApiSurface["."]) => entries.map((e) => e.name);

describe("extractPackageSurface", () => {
  test("lists every export of each entry with its kind, through export *, renames, export type and namespaces", () => {
    expect(surface["."]).toEqual([
      { name: "Id", kind: "type" },
      { name: "Klass", kind: "value" },
      { name: "Mode", kind: "value" },
      { name: "Opts", kind: "type" },
      { name: "Shape", kind: "type" },
      { name: "Zed", kind: "value" },
      { name: "_seam", kind: "value" },
      { name: "alpha", kind: "value" },
      { name: "ns", kind: "value" },
      { name: "renamed", kind: "value" },
    ]);
    expect(names(surface["./internal"])).toEqual(["Id", "Klass", "Mode", "Shape", "Zed", "_seam", "alpha", "only"]);
  });

  test("marks type-only names: an interface, an alias and an `export type` re-export are types; a class and an enum are values", () => {
    const kind = (n: string) => surface["."].find((e) => e.name === n)?.kind;
    expect([kind("Shape"), kind("Id"), kind("Opts"), kind("Klass"), kind("Mode")]).toEqual([
      "type",
      "type",
      "type",
      "value",
      "value",
    ]);
  });

  test("fails when the package does not build", async () => {
    const bad = fixture({ ...FIXTURE_FILES, "src/index.ts": 'export * from "not-installed-anywhere";\n' });
    await expect(extractPackageSurface(bad)).rejects.toThrow(/tsc failed/);
  }, 60_000);
});

describe("extractApiSurface", () => {
  test("fails when the built declarations reference a missing module, instead of dropping its names", async () => {
    const root = makeTempDir("api-surface-dts-");
    roots.push(root);
    const files: Record<string, string> = {
      "package.json": JSON.stringify({ type: "module", imports: { "#src/*": "./dist/*.d.ts" } }),
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          module: "nodenext",
          moduleResolution: "nodenext",
          target: "esnext",
          noEmit: true,
          skipLibCheck: false,
          allowImportingTsExtensions: true,
          types: [],
        },
        files: ["dist/index.d.ts", "dist/internal.d.ts"],
      }),
      "dist/index.d.ts": 'export * from "./missing.ts";\nexport declare const ok: number;\n',
      "dist/internal.d.ts": "export declare const inner: number;\n",
    };
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), body, "utf8");
    }
    await expect(extractApiSurface(root)).rejects.toThrow(/missing\.ts/);
  }, 60_000);
});

describe("renderSnapshot and diffSnapshots", () => {
  test("renders sorted sections, `type ` markers, and a trailing newline", () => {
    const text = renderSnapshot("@scope/fixture", surface);
    expect(text.split("\n").slice(0, 4)).toEqual([
      "# @scope/fixture public API. Generated by `bun run api:update`; do not edit by hand.",
      "# One line per exported name, sorted by code point. `type ` marks a name with no runtime value.",
      "",
      "[.]",
    ]);
    expect(text).toContain("\n[.]\ntype Id\nKlass\nMode\ntype Opts\ntype Shape\nZed\n_seam\nalpha\nns\nrenamed\n");
    expect(text).toContain("\n[./internal]\ntype Id\n");
    expect(text.endsWith("\n")).toBe(true);
  });

  test("diffSnapshots reports added and removed lines per section, and a kind flip as one of each", () => {
    const before = renderSnapshot("p", surface);
    const flipped: ApiSurface = {
      ".": surface["."]
        .filter((e) => e.name !== "Zed")
        .map((e) => (e.name === "Klass" ? { ...e, kind: "type" as const } : e)),
      "./internal": surface["./internal"],
    };
    expect(diffSnapshots(before, renderSnapshot("p", flipped))).toEqual({
      added: ["[.] type Klass"],
      removed: ["[.] Klass", "[.] Zed"],
    });
    expect(diffSnapshots(before, before)).toEqual({ added: [], removed: [] });
  });
});

describe("privateNamesOnPublicEntry", () => {
  test("reports a `_` name that arrives through export *, and ignores `_` names on /internal", () => {
    expect(privateNamesOnPublicEntry(surface)).toEqual(["_seam"]);
    expect(
      privateNamesOnPublicEntry({ ".": [{ name: "a", kind: "value" }], "./internal": [{ name: "_x", kind: "value" }] }),
    ).toEqual([]);
  });
});

describe("checkApiSnapshot", () => {
  const CLEAN: Record<string, string> = {
    ...FIXTURE_FILES,
    "src/index.ts": 'export { alpha, Zed, type Id } from "./a.ts";\n',
    "src/internal.ts": 'export * from "./a.ts";\nexport const only = 1;\n',
  };

  test("a missing snapshot fails and names the update command", async () => {
    const root = fixture(CLEAN);
    const result = await checkApiSnapshot(root, { update: false });
    expect(result.ok).toBe(false);
    expect(result.messages.join("\n")).toContain("bun run api:update");
  }, 60_000);

  test("update writes the snapshot; an unchanged package then passes", async () => {
    const root = fixture(CLEAN);
    expect((await checkApiSnapshot(root, { update: true })).ok).toBe(true);
    const path = snapshotPathFor(root);
    expect(path).toBe(join(root, "api", "fixture.api.txt"));
    expect(readFileSync(path, "utf8")).toContain("\n[.]\ntype Id\nZed\nalpha\n");
    expect((await checkApiSnapshot(root, { update: false })).ok).toBe(true);
  }, 60_000);

  test("drift fails and lists exactly the added and removed names", async () => {
    const root = fixture(CLEAN);
    await checkApiSnapshot(root, { update: true });
    writeFileSync(
      join(root, "src/index.ts"),
      'export { alpha, type Id } from "./a.ts";\nexport { hidden } from "./b.ts";\n',
    );
    const result = await checkApiSnapshot(root, { update: false });
    expect(result.ok).toBe(false);
    const text = result.messages.join("\n");
    expect(text).toContain("+ [.] hidden");
    expect(text).toContain("- [.] Zed");
  }, 60_000);

  test("a `_` name on `.` fails the check, even when the committed snapshot lists it", async () => {
    const root = fixture({ ...CLEAN, "src/index.ts": 'export { alpha, _seam } from "./a.ts";\n' });
    const result = await checkApiSnapshot(root, { update: false });
    expect(result.ok).toBe(false);
    expect(result.messages.join("\n")).toContain("_seam");
  }, 60_000);

  test("update refuses a `_` name on `.` and writes nothing", async () => {
    const root = fixture({ ...CLEAN, "src/index.ts": 'export * from "./a.ts";\n' });
    const result = await checkApiSnapshot(root, { update: true });
    expect(result.ok).toBe(false);
    expect(result.messages.join("\n")).toContain("_seam");
    expect(existsSync(snapshotPathFor(root))).toBe(false);
  }, 60_000);
});
