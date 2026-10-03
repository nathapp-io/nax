# S2-6 Explicit `.ts` Specifiers and the nax-agent tsc Build: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make nax-agent's `src/` compile to Node-loadable ESM. Every relative import gets an explicit `.ts` path, and `bun run build` emits `dist/` through `tsc -p tsconfig.build.json`. The nax CLI is unchanged.

**Architecture:** First, pin the specifier-resolving gates against the `.ts` form, and fix the one gate that misses it (`check-sandbox-imports`). Next, add the nodenext build config. A fixture test proves the config rejects extensionless imports (TS2835 and TS2834) and rewrites `./x.ts` to `./x.js`. Then a scripted codemod adds `.ts` to all 420 relative specifiers in `src/`. A real-`src/` build test and the new CI build step keep later imports explicit. Workspace `exports` and `imports` still point at `.ts` source (R6). Bun, `bun test` and nax's `bun build` need no flags.

**Tech Stack:** TypeScript 7.0.2 (`tsc` from the `typescript` package), Bun 1.4 workspaces and bun:test, Biome 2.5.10, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-02-s2-nax-agent-node-ready-publish-design.md`: §5.1 (imports for Node ESM), §5.2 (build script and devDependencies), §9 (S2-6 row) and §10.5 (nax CLI unchanged). The arc SSOT is `/Users/williamkhoo/workspace/subrina-coder/projects/nax/nax-agent-master-plan.md`, rulings D17-D21. Read both before executing.

## Global Constraints

- Node floor: `>=22.19.0`. TypeScript: "nax-agent pins `typescript` to `7.0.2` like the root and nax-ai" (R7). This PR makes that pin exact.
- "The workspace `package.json` keeps `private: true` and source-pointing `exports`/`imports`, so `bun bin/nax.ts`, `bun test` and nax's `bun build` keep working with no flags" (R6). Do not add export conditions.
- `tsconfig.build.json`: "`include: ["src/**/*.ts"]`; `module` and `moduleResolution` `nodenext`; `allowImportingTsExtensions`; `rewriteRelativeImportExtensions`; `noEmit: false`; `declaration: true`; `rootDir: src`; `outDir: dist`; `types: ["node"]`."
- "`allowImportingTsExtensions: true` is added to nax-agent's `tsconfig.json` (tests stay in `bundler` mode and are not rewritten) **and** to `packages/nax/tsconfig.json`."
- Codemod scope: relative specifiers in `packages/nax-agent/src/` only. `#src/*` specifiers stay extensionless, because "the `imports` map supplies their extension". `test/`, nax and every other package are not rewritten.
- "A new extensionless import in `src/` fails the build step in CI."
- "nax-agent ships no Bun code." The build config allows Node types only (`types: ["node"]`).
- `packages/nax/package.json` `dependencies` must stay byte-identical, and nax-agent stays bundled (`check-bundle-externals`).
- Coverage: nax-agent at 80% lines and functions overall and 80% per file, with an empty baseline. This PR adds no `src/` file.
- Out of scope: curated `.` and the API snapshot (S2-7); `stage-publish`, vitest and tarball smoke (S2-8); publishing (S2-9).
- Never run bare `bun test` or `bun run nax`. Run package commands from the named package directory.
- `nax run` and `nax plan` need explicit approval at launch. This plan runs neither.

## Review Focus

1. **Directory specifiers `.`, `..` and a trailing `/`** must become `…/index.ts`. They must never pick up a same-named sibling file: for `.`, `resolve(dir, ".") + ".ts"` names the parent's sibling, so a naive rewrite produces `"..ts"`. Covered by Task 4's codemod test.
2. **A stem that is both `x.ts` and `x/index.ts`** must resolve to `x.ts`, matching bundler resolution. There are 0 such pairs in nax-agent today, so only a test can catch a regression here. Covered by Task 4's codemod test.
3. **Import-shaped text in comments, strings and template literals** must not be rewritten. The 4 `import("./x")` type expressions must be rewritten. Covered by Task 4's codemod test, which leans on `specifierSites`' comment and string handling.
4. **Biome's organizeImports reorders imports after the codemod.** `./loop-events/cache-boundary.ts` now sorts before `./loop-events/index.ts`, which changes module evaluation order in nax's bundle. Every move must be side-effect-free. Covered by Task 4 Step 7: a sorted-bundle diff plus a top-level side-effect review of each moved module.
5. **Emitted `.d.ts` keep `./x.ts` relative specifiers.** `rewriteRelativeImportExtensions` rewrites JS only. A nodenext consumer must still resolve them. The planning probe confirmed this. Task 4's real-src build test asserts the JS side. Task 5 re-runs the consumer probe as a recorded check, because S2-8 owns the tarball types smoke.

## Evidence (planning base: main `2f2cf776f`, S2-5 merged as #2334)

All numbers come from a scratch APFS clone of main, codemodded end to end:

- **Specifiers:** 420 relative specifiers across 116 of 197 `src/` files: 416 static and 4 `import("…")` type expressions. 400 name files and 20 name directories. 0 already carry an extension, 0 fail to resolve and 0 are `require`. There are 303 `#src/` specifiers. A plain `grep` count agrees (420). The spec's 412 was measured on `6419e1a3f`.
- **Codemod result:** `git diff --stat` = 116 files, 420 insertions, 420 deletions. Every insertion ends in `.ts`. `bun x biome check --write src/` then fixes 5 files, all safe fixes: organizeImports in `native/session/turn-loop.ts` and `turn-complete-step.ts`, and line-width formatting in `turn-loop-round-trip.ts`, `turn-types.ts` and `sandbox/index.ts`. Do not pass `--unsafe`: it renames stranded helpers to `_name`, a known trap.
- **Typecheck:** without `allowImportingTsExtensions`, both nax-agent and nax fail with TS5097. With it, both are green. nax's `typecheck` passes `--noEmit` on the command line, so its `declaration`/`outDir` settings do not trigger TS5096.
- **Build:** `bun x tsc -p tsconfig.build.json` exits 0 in about 0.2 s. It emits 197 `.js` and 197 `.d.ts` files. All 275 relative specifiers in the emitted JS end in `.js`. `#src/…` stays bare in both JS and `.d.ts`. The 247 relative specifiers in the `.d.ts` keep `.ts`. `@types/node` is not installed for nax-agent today: the isolated linker gives it only `@types/bun`. Add `"@types/node": "25.2.3"`, which is nax-ai's exact pin.
- **The build is a guard:** an extensionless relative import fails with TS2835, and a directory import fails with TS2834.
- **Node:** with a temp package whose `imports` maps `#src/*` to `dist/*.js`, Node 22.22.2 imports `dist/` and sees 210 names from `.` and 338 from `/internal`. A nodenext consumer with `skipLibCheck: false` typechecks against the emitted `.d.ts`. Its only error is third-party: `@anthropic-ai/sandbox-runtime`'s `mitm-ca.d.ts` lacks `@types/node-forge` (TS7016). Record this for S2-8. It is not fixed here.
- **Gates:** `check-import-cycles` resolves `./x.ts` through its existing exact-file fallback. The graph has 504 edges before and after the codemod. `check-package-boundaries` only asks whether a relative path leaves the package, so it does not care about extensions. `check-sandbox-imports`' orchestrator regex requires `/` or a quote after the module name, so `from "../pipeline.ts"` slips through. That is the one real gate fix. `check-nax-ai-imports` matches a bare package name and is unaffected. `check-alias-internals` only reads nax's `@/` and `@test/` specifiers, and nax is not codemodded, so it is unaffected. The Biome grit plugins (`no-as-never`, `no-empty-catch`, `no-process-cwd`, `no-absent-value`) never inspect specifiers. Biome's `noRestrictedImports` `../../*` group still matches `.ts` paths.
- **Tests and CLI:** nax-agent passes 2974 unit and 31 integration tests (unchanged). nax unit: 18950 pass, 7 skip, 0 fail. nax `--help`, `--version`, `config --help` and `auth --help` md5s are identical. nax's bundle is a pure line permutation: `diff <(sort before) <(sort after)` is empty. The only module move is `loop-events/cache-boundary.ts`, whose top level declares functions only, plus a one-line swap.
- **Main defect found while planning:** `2f2cf776f` committed `docs/superpowers/plans/2026-10-03-s2-5-glob-node-builtins.md` with 11 stash-pop conflict blocks (`<<<<<<< Updated upstream` / `>>>>>>> Stashed changes`). The "Updated upstream" side is byte-identical to the plan as merged in #2334 (`7b84b9c34`). Task 1 restores it.

## File Map

| Files | Responsibility |
|---|---|
| `docs/superpowers/plans/2026-10-03-s2-5-glob-node-builtins.md` | Restore the #2334 version (conflict markers) |
| `packages/repo-tooling/scripts/check-sandbox-imports.ts` | Orchestrator rule sees `../pipeline.ts` |
| `packages/repo-tooling/test/unit/scripts/{check-import-cycles,check-sandbox-imports}.test.ts` | `.ts` resolution pins and the sandbox RED test |
| `packages/nax/test/unit/scripts/{check-package-boundaries,import-specifiers}.test.ts` | `.ts` pins for the boundary rule and the specifier engine |
| `packages/nax-agent/tsconfig.json`, `packages/nax/tsconfig.json` | `allowImportingTsExtensions: true` |
| `packages/nax-agent/tsconfig.build.json` (new) | nodenext emit config |
| `packages/nax-agent/package.json`, `bun.lock` | `build` script, `@types/node` 25.2.3, `typescript` 7.0.2 exact |
| `packages/nax-agent/{.gitignore,.naxignore}` | `dist/` |
| `packages/nax-agent/test/unit/build/tsconfig-build.test.ts` (new) | Fixture tests for the build config, plus the real-`src/` build test |
| `.github/workflows/ci.yml` | nax-agent job runs `bun run build` |
| `packages/nax/scripts/lib/ts-extensions.ts`, `packages/nax/scripts/s2-6-ts-extensions.ts` (new, retired in Task 5) | Codemod core and CLI |
| `packages/nax/test/unit/scripts/ts-extensions.test.ts` (new, retired in Task 5) | Codemod tests |
| `packages/nax-agent/src/**` (generated) | 420 rewritten specifiers plus 5 Biome-fixed files |
| `.nax/mono/packages/nax-agent/context.md` and generated agent files | The explicit-`.ts` import rule |

---

### Task 1: Restore the S2-5 plan on main

**Files:**
- Modify: `docs/superpowers/plans/2026-10-03-s2-5-glob-node-builtins.md`

**Interfaces:** none.

- [ ] **Step 1: Confirm the defect and that the upstream side equals #2334's version**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax
F=docs/superpowers/plans/2026-10-03-s2-5-glob-node-builtins.md
grep -c '^<<<<<<< Updated upstream' "$F"    # expect 11
awk '/^<<<<<<< /{m=1;next} /^=======$/{if(m==1){m=2;next}} /^>>>>>>> /{m=0;next} m!=2{print}' "$F" | diff - <(git show 7b84b9c34:"$F") && echo SAME
```

Expected: `11`, then `SAME`. If the output is not `SAME`, stop and report the difference. Do not pick a side by hand.

- [ ] **Step 2: Restore and verify**

```bash
git show 7b84b9c34:"$F" > "$F"
grep -cE '^(<<<<<<<|=======$|>>>>>>>)' "$F"   # expect 0
```

- [ ] **Step 3: Commit**

```bash
git add "$F"
git commit -m "docs: restore the S2-5 plan; 2f2cf776f committed stash-pop conflict markers"
```

---

### Task 2: Specifier-resolving gates handle explicit `.ts`

**Files:**
- Modify: `packages/repo-tooling/scripts/check-sandbox-imports.ts` (the `ORCHESTRATOR` constant)
- Test: `packages/repo-tooling/test/unit/scripts/check-sandbox-imports.test.ts`
- Test: `packages/repo-tooling/test/unit/scripts/check-import-cycles.test.ts`
- Test: `packages/nax/test/unit/scripts/check-package-boundaries.test.ts`
- Test: `packages/nax/test/unit/scripts/import-specifiers.test.ts`

**Interfaces:**
- Consumes: `resolveSpecifier(rootDir, fromFile, spec): string | null` and `buildImportGraph(rootDir): Map<string, string[]>` (check-import-cycles); `findBoundaryViolations(repoRoot): BoundaryViolation[]`; `specifierSites(source)` and `rewriteSpecifiers(source, map)` (import-specifiers).
- Produces: no new names. After this task, the gates accept the codemod's output (Task 4).

- [ ] **Step 1: Write the RED test for check-sandbox-imports**

Add inside `describe("check-sandbox-imports", …)`, after the test "fails when src/sandbox imports an orchestrator module":

```ts
  // S2-6 gives every relative import an explicit `.ts`. The rule required `/` or
  // a quote after the module name, so a file-form import walked straight past it.
  test("fails when src/sandbox imports an orchestrator file through an explicit .ts specifier", () => {
    const root = tree({ "src/sandbox/launcher.ts": 'import { x } from "../pipeline.ts";\n' });
    const { code, out } = runGate(root);
    rmSync(root, { recursive: true, force: true });
    expect(code).not.toBe(0);
    expect(out).toContain("orchestrator");
  });

  test("still passes for an explicit .ts peer import that is not an orchestrator", () => {
    const root = tree({ "src/sandbox/launcher.ts": 'import { x } from "./pipeline-free.ts";\n' });
    const { code } = runGate(root);
    rmSync(root, { recursive: true, force: true });
    expect(code).toBe(0);
  });
```

- [ ] **Step 2: Run it and watch the first test fail**

Run (from `packages/repo-tooling`): `bun test test/unit/scripts/check-sandbox-imports.test.ts --timeout=60000`
Expected: FAIL on "…through an explicit .ts specifier" (exit code 0). The second new test passes.

- [ ] **Step 3: Fix the regex**

In `packages/repo-tooling/scripts/check-sandbox-imports.ts`, replace:

```ts
const ORCHESTRATOR = /from\s+["'](?:@\/|#src\/|(?:\.\.\/)+)(pipeline|execution|operations|prd|runtime)(?:\/|["'])/;
```

with:

```ts
// The module name ends at `/` (a deeper path), a quote (a barrel), or `.ts"`
// (an explicit file, nax-agent's form since S2-6).
const ORCHESTRATOR =
  /from\s+["'](?:@\/|#src\/|(?:\.\.\/)+)(pipeline|execution|operations|prd|runtime)(?:\/|\.ts["']|["'])/;
```

- [ ] **Step 4: Run it and see it pass**

Run: `bun test test/unit/scripts/check-sandbox-imports.test.ts --timeout=60000`
Expected: PASS, all tests.

- [ ] **Step 5: Add `.ts` pins to check-import-cycles**

These pass today through the exact-file fallback in `resolveSpecifier`. They stop a later "simplification" of that fallback from silently emptying nax-agent's graph. Add to `describe("resolveSpecifier", …)`:

```ts
  test("resolves explicit .ts specifiers to the file and to a directory index (nax-agent's form since S2-6)", () => {
    write(root, "src/b.ts", "export const b = 1;\n");
    const from = join(root, "src/a/leaf.ts");
    expect(resolveSpecifier(root, from, "../b.ts")).toBe(join(root, "src/b.ts"));
    expect(resolveSpecifier(root, from, "./index.ts")).toBe(join(root, "src/a/index.ts"));
    expect(resolveSpecifier(root, from, "../a/index.ts")).toBe(join(root, "src/a/index.ts"));
    expect(resolveSpecifier(root, from, "./missing.ts")).toBeNull();
  });
```

Add to `describe("buildImportGraph", …)`:

```ts
  test("records a value edge through an explicit .ts specifier", () => {
    write(root, "src/a/leaf.ts", 'import { b } from "./other.ts";\nexport const a = b;\n');
    write(root, "src/a/other.ts", "export const b = 1;\n");

    const graph = buildImportGraph(root);
    expect(graph.get(join(root, "src/a/leaf.ts"))).toEqual([join(root, "src/a/other.ts")]);
  });
```

Run: `bun test test/unit/scripts/check-import-cycles.test.ts --timeout=60000`
Expected: PASS. These are pins, so they pass on first run. To prove the pin can fail, temporarily delete the `if (existsSync(base) && statSync(base).isFile()) return base;` line in `resolveSpecifier`, see both new tests FAIL, then restore the line.

- [ ] **Step 6: Add `.ts` pins to check-package-boundaries and import-specifiers**

In `packages/nax/test/unit/scripts/check-package-boundaries.test.ts`, add after "nax-agent may not reach out of the package by a relative path":

```ts
  test("an explicit .ts relative path is judged by where it lands, not by its extension", () => {
    workspace();
    write("packages/nax-agent/src/ok.ts", 'import { r } from "./tools/index.ts";\nexport * from "../src/tools/index.ts";\n');
    write("packages/nax-agent/src/bad.ts", 'import { a } from "../../nax/src/config.ts";\n');
    expect(whys()).toEqual(["packages/nax-agent/src/bad.ts ../../nax/src/config.ts relative import leaves the package"]);
  });
```

In `packages/nax/test/unit/scripts/import-specifiers.test.ts`, add a top-level test:

```ts
test("explicit .ts specifiers are found and rewritten like any other (S2-6 codemod input and output)", () => {
  const src = 'import { a } from "./a.ts";\nexport * from "../b/index.ts";\ntype C = import("./c.ts").C;\n';
  expect(specifierSites(src).map((s) => s.spec)).toEqual(["./a.ts", "../b/index.ts", "./c.ts"]);
  expect(rewriteSpecifiers(src, (s) => (s.spec === "./a.ts" ? "./a2.ts" : null))).toBe(
    src.replace('"./a.ts"', '"./a2.ts"'),
  );
});
```

Run (from `packages/nax`): `bun test test/unit/scripts/check-package-boundaries.test.ts test/unit/scripts/import-specifiers.test.ts --timeout=60000`
Expected: PASS (pins).

- [ ] **Step 7: Lint and commit**

```bash
(cd packages/repo-tooling && bun run check:all && bun run test)
(cd packages/nax && bun x biome check --error-on-warnings test/unit/scripts/check-package-boundaries.test.ts test/unit/scripts/import-specifiers.test.ts)
git add packages/repo-tooling packages/nax/test/unit/scripts
git commit -m "fix: check-sandbox-imports sees explicit .ts orchestrator imports; pin .ts resolution in the specifier gates"
```

---

### Task 3: The nodenext build config, the `build` script and CI

**Files:**
- Create: `packages/nax-agent/tsconfig.build.json`
- Modify: `packages/nax-agent/tsconfig.json`, `packages/nax/tsconfig.json`
- Modify: `packages/nax-agent/package.json`, `bun.lock`
- Modify: `packages/nax-agent/.gitignore`, `packages/nax-agent/.naxignore`
- Modify: `.github/workflows/ci.yml` (nax-agent job)
- Test/Create: `packages/nax-agent/test/unit/build/tsconfig-build.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `packages/nax-agent/tsconfig.build.json`; the script `bun run build` (= `bun x tsc -p tsconfig.build.json`, output `dist/`); and these helpers inside `tsconfig-build.test.ts`, which Task 4 reuses: `PKG: string`, `BUILD_CONFIG: string`, `tsc(project: string, outDir?: string): { code: number; out: string }` and `relativeSpecifiers(js: string): string[]`.

- [ ] **Step 1: Write the failing fixture tests**

Create `packages/nax-agent/test/unit/build/tsconfig-build.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it and watch it fail**

Run (from `packages/nax-agent`): `bun test ./test/unit/build/tsconfig-build.test.ts --timeout=60000`
Expected: FAIL. `tsconfig.build.json` does not exist yet, so tsc reports that it cannot find the base config.

- [ ] **Step 3: Add the build config, tsconfig flags, manifest changes and ignores**

Create `packages/nax-agent/tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "allowImportingTsExtensions": true,
    "rewriteRelativeImportExtensions": true,
    "noEmit": false,
    "declaration": true,
    "rootDir": "src",
    "outDir": "dist",
    "types": ["node"]
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "test", "dist"]
}
```

In both `packages/nax-agent/tsconfig.json` and `packages/nax/tsconfig.json`, insert after `"resolveJsonModule": true,`:

```json
    "allowImportingTsExtensions": true,
```

In `packages/nax-agent/package.json`, add to `scripts`, after `"typecheck"`:

```json
    "build": "bun x tsc -p tsconfig.build.json",
```

Then set `devDependencies` to:

```json
  "devDependencies": {
    "@biomejs/biome": "2.5.10",
    "@nathapp/nax-test-kit": "workspace:*",
    "@types/bun": "^1.3.8",
    "@types/node": "25.2.3",
    "bun-types": "^1.3.9",
    "typescript": "7.0.2"
  },
```

Append `dist/` to `packages/nax-agent/.gitignore` and to `packages/nax-agent/.naxignore`. The root `.gitignore` already ignores `dist`. The package-level lines match nax-ai and keep the context engine out of build output.

Run from the repo root: `bun install`. Expected: `bun.lock` gains the `@types/node` line and pins `typescript` exactly. Then check that nothing outside nax-agent's manifest entry changed: `git diff --stat bun.lock`.

- [ ] **Step 4: Run the tests and both typechecks**

```bash
cd packages/nax-agent && bun test ./test/unit/build/tsconfig-build.test.ts --timeout=60000 && bun run typecheck
cd ../nax && bun run typecheck
```

Expected: 2 pass; both typechecks print no errors. nax-agent's real `src/` does not build yet (420 TS2835 and TS2834 errors). Task 4 fixes that, so do not run `bun run build` here.

- [ ] **Step 5: Add the CI build step**

In `.github/workflows/ci.yml`, in the `nax-agent` job, insert after the `Check all` step and before `Test (unit)`:

```yaml
      # S2-6: tsc nodenext emit. Also the guard that rejects a new extensionless
      # relative import in src/ (TS2835/TS2834).
      - name: Build
        run: bun run build
```

The root `build` script (`bun run --filter '*' build`) now runs nax-agent's build as well. No change is needed there.

- [ ] **Step 6: Commit**

The build step stays red until Task 4. CI runs per PR, not per commit, so this does not break anything on its own.

```bash
git add packages/nax-agent/tsconfig.build.json packages/nax-agent/tsconfig.json packages/nax/tsconfig.json \
  packages/nax-agent/package.json bun.lock packages/nax-agent/.gitignore packages/nax-agent/.naxignore \
  packages/nax-agent/test/unit/build/tsconfig-build.test.ts .github/workflows/ci.yml
git commit -m "build: nax-agent nodenext tsc build config, build script and CI step"
```

---

### Task 4: The codemod, run it, and prove the real build

**Files:**
- Create: `packages/nax/scripts/lib/ts-extensions.ts`, `packages/nax/scripts/s2-6-ts-extensions.ts`
- Test/Create: `packages/nax/test/unit/scripts/ts-extensions.test.ts`
- Modify (generated): 116 files under `packages/nax-agent/src/`
- Modify: `packages/nax-agent/test/unit/build/tsconfig-build.test.ts` (real-`src/` test)
- Modify: `.nax/mono/packages/nax-agent/context.md`, then regenerate the agent files

**Interfaces:**
- Consumes: `rewriteSpecifiers(source, map: (site: SpecifierSite) => SiteRewrite): string` and `SpecifierSite` from `packages/nax/scripts/lib/import-specifiers.ts`; `PKG`, `BUILD_CONFIG`, `tsc()` and `relativeSpecifiers()` from Task 3's test file.
- Produces: `explicitTsSpecifier(spec: string, fromFile: string, isFile: (abs: string) => boolean): string | null` and `rewriteTsExtensions(source: string, fromFile: string, isFile: (abs: string) => boolean): { source: string; rewritten: number }`. Task 5 deletes both.

- [ ] **Step 1: Write the failing codemod tests**

Create `packages/nax/test/unit/scripts/ts-extensions.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { explicitTsSpecifier, rewriteTsExtensions } from "@scripts/lib/ts-extensions";

// A fake tree: /p/src/{index.ts, a.ts, both.ts, both/index.ts, dir/index.ts, sub.ts, sub/index.ts, sub/leaf.ts}.
const FILES = new Set([
  "/p/src/a.ts",
  "/p/src/both.ts",
  "/p/src/both/index.ts",
  "/p/src/dir/index.ts",
  "/p/src/sub/leaf.ts",
  "/p/src/sub/index.ts",
  "/p/src/sub.ts",
  "/p/src/index.ts",
]);
const isFile = (abs: string) => FILES.has(abs);
const FROM = "/p/src/main.ts";

describe("explicitTsSpecifier", () => {
  test("a file gets .ts; a directory gets /index.ts", () => {
    expect(explicitTsSpecifier("./a", FROM, isFile)).toBe("./a.ts");
    expect(explicitTsSpecifier("./dir", FROM, isFile)).toBe("./dir/index.ts");
    expect(explicitTsSpecifier("../a", "/p/src/sub/leaf.ts", isFile)).toBe("../a.ts");
  });

  test("when x.ts and x/index.ts both exist, the file wins (bundler resolution order)", () => {
    expect(explicitTsSpecifier("./both", FROM, isFile)).toBe("./both.ts");
  });

  test(". and .. and a trailing slash are directory-only; a same-named sibling file is never picked", () => {
    // resolve("/p/src/sub", ".") + ".ts" is /p/src/sub.ts, which exists: a naive rewrite writes "..ts".
    expect(explicitTsSpecifier(".", "/p/src/sub/leaf.ts", isFile)).toBe("./index.ts");
    expect(explicitTsSpecifier("..", "/p/src/sub/leaf.ts", isFile)).toBe("../index.ts");
    expect(explicitTsSpecifier("./sub/", FROM, isFile)).toBe("./sub/index.ts");
  });

  test("already explicit, #src/ and bare specifiers are left alone", () => {
    expect(explicitTsSpecifier("./a.ts", FROM, isFile)).toBeNull();
    expect(explicitTsSpecifier("./dir/index.ts", FROM, isFile)).toBeNull();
    expect(explicitTsSpecifier("#src/a", FROM, isFile)).toBeNull();
    expect(explicitTsSpecifier("zod", FROM, isFile)).toBeNull();
    expect(explicitTsSpecifier("node:fs", FROM, isFile)).toBeNull();
  });

  test("an unresolvable relative specifier throws naming the file and the specifier", () => {
    expect(() => explicitTsSpecifier("./nope", FROM, isFile)).toThrow('/p/src/main.ts: cannot resolve "./nope"');
  });
});

describe("rewriteTsExtensions", () => {
  test("rewrites static, export-from, multi-line, side-effect and import() type sites; counts them", () => {
    const src = [
      'import { a } from "./a";',
      'export * from "./dir";',
      "import {",
      "  x,",
      '} from "./both";',
      'import "./sub";',
      'type T = import("./a").T;',
      'import { s } from "#src/a";',
      "",
    ].join("\n");
    const out = rewriteTsExtensions(src, FROM, isFile);
    expect(out.rewritten).toBe(5);
    expect(out.source).toBe(
      [
        'import { a } from "./a.ts";',
        'export * from "./dir/index.ts";',
        "import {",
        "  x,",
        '} from "./both.ts";',
        'import "./sub.ts";',
        'type T = import("./a.ts").T;',
        'import { s } from "#src/a";',
        "",
      ].join("\n"),
    );
  });

  test("import-shaped text in comments, strings and templates is not rewritten", () => {
    const src = [
      '// import { a } from "./a";',
      '/* export * from "./dir"; */',
      "const s = 'import { a } from \"./a\";';",
      'const t = `await import("./a")`;',
      "",
    ].join("\n");
    expect(rewriteTsExtensions(src, FROM, isFile)).toEqual({ source: src, rewritten: 0 });
  });

  test("is idempotent", () => {
    const once = rewriteTsExtensions('import { a } from "./a";\nexport * from "./dir";\n', FROM, isFile);
    expect(rewriteTsExtensions(once.source, FROM, isFile)).toEqual({ source: once.source, rewritten: 0 });
  });
});
```

Run (from `packages/nax`): `bun test test/unit/scripts/ts-extensions.test.ts --timeout=60000`
Expected: FAIL. The module `@scripts/lib/ts-extensions` cannot be found.

- [ ] **Step 2: Implement the codemod core**

Create `packages/nax/scripts/lib/ts-extensions.ts`:

```ts
/**
 * S2-6 codemod core: give every relative specifier in nax-agent's src/ an
 * explicit `.ts` path (a file -> `x.ts`, a directory -> `x/index.ts`) so tsc's
 * nodenext build emits Node-loadable `./x.js`. One-shot: retired once S2-6
 * lands; from then on the build's TS2835/TS2834 errors keep imports explicit.
 */
import { dirname, join, resolve } from "node:path";
import { rewriteSpecifiers } from "./import-specifiers";

function isRelative(spec: string): boolean {
  return spec === "." || spec === ".." || spec.startsWith("./") || spec.startsWith("../");
}

/** `.`, `..` and a trailing `/` name a directory; they never resolve to a sibling file. */
function isDirectoryOnly(spec: string): boolean {
  return spec === "." || spec === ".." || spec.endsWith("/");
}

/**
 * The explicit form of one specifier, or `null` to leave it unchanged (not
 * relative, or already naming a file). A file beats a same-named directory,
 * matching bundler resolution. Throws when neither exists.
 */
export function explicitTsSpecifier(spec: string, fromFile: string, isFile: (abs: string) => boolean): string | null {
  if (!isRelative(spec)) return null;
  const base = resolve(dirname(fromFile), spec);
  if (isFile(base)) return null;
  const stem = spec.replace(/\/+$/, "");
  if (!isDirectoryOnly(spec) && isFile(`${base}.ts`)) return `${stem}.ts`;
  if (isFile(join(base, "index.ts"))) return `${stem}/index.ts`;
  throw new Error(`${fromFile}: cannot resolve "${spec}" to a .ts file or a directory index.ts`);
}

export function rewriteTsExtensions(
  source: string,
  fromFile: string,
  isFile: (abs: string) => boolean,
): { source: string; rewritten: number } {
  let rewritten = 0;
  const out = rewriteSpecifiers(source, (site) => {
    const next = explicitTsSpecifier(site.spec, fromFile, isFile);
    if (next !== null) rewritten += 1;
    return next;
  });
  return { source: out, rewritten };
}
```

Run: `bun test test/unit/scripts/ts-extensions.test.ts --timeout=60000`
Expected: PASS, 8 tests.

- [ ] **Step 3: Add the CLI wrapper**

Create `packages/nax/scripts/s2-6-ts-extensions.ts`:

```ts
#!/usr/bin/env bun
/**
 * One-shot S2-6 codemod over a package's src/ (nax-agent). Retired after S2-6.
 *
 *   bun scripts/s2-6-ts-extensions.ts ../nax-agent --dry-run   # count only
 *   bun scripts/s2-6-ts-extensions.ts ../nax-agent             # rewrite in place
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { rewriteTsExtensions } from "./lib/ts-extensions";

function* tsFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* tsFiles(full);
    else if (entry.name.endsWith(".ts")) yield full;
  }
}

function isFile(abs: string): boolean {
  try {
    return statSync(abs).isFile();
  } catch {
    return false;
  }
}

const [target, flag] = process.argv.slice(2);
if (!target) throw new Error("usage: s2-6-ts-extensions.ts <packageDir> [--dry-run]");
const pkg = resolve(target);
let specifiers = 0;
let files = 0;
for (const file of tsFiles(join(pkg, "src"))) {
  const before = readFileSync(file, "utf8");
  const { source, rewritten } = rewriteTsExtensions(before, file, isFile);
  if (rewritten === 0) continue;
  specifiers += rewritten;
  files += 1;
  if (flag !== "--dry-run") writeFileSync(file, source);
  process.stdout.write(`${relative(pkg, file)}: ${rewritten}\n`);
}
process.stdout.write(`${flag === "--dry-run" ? "would rewrite" : "rewrote"} ${specifiers} specifiers in ${files} files\n`);
```

Lint both new files: `bun x biome check --error-on-warnings scripts/lib/ts-extensions.ts scripts/s2-6-ts-extensions.ts test/unit/scripts/ts-extensions.test.ts`.

- [ ] **Step 4: Commit the tool**

```bash
git add packages/nax/scripts/lib/ts-extensions.ts packages/nax/scripts/s2-6-ts-extensions.ts packages/nax/test/unit/scripts/ts-extensions.test.ts
git commit -m "chore: S2-6 codemod adding explicit .ts to nax-agent relative imports"
```

- [ ] **Step 5: Write the failing real-`src/` build test**

Append to `packages/nax-agent/test/unit/build/tsconfig-build.test.ts`. Add `readdirSync` to the existing `node:fs` import, and `relative` to the `node:path` import:

```ts
function walk(dir: string, suffix: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name), suffix) : e.name.endsWith(suffix) ? [join(dir, e.name)] : [],
  );
}

describe("bun run build (real src/)", () => {
  test("compiles clean; every relative specifier in emitted JS ends in .js; one .js and .d.ts per source", () => {
    root = makeTempDir("nax-agent-dist-");
    const { code, out } = tsc(BUILD_CONFIG, root);
    expect(out).toBe("");
    expect(code).toBe(0);
    const sources = walk(join(PKG, "src"), ".ts").map((f) => relative(join(PKG, "src"), f).replace(/\.ts$/, ""));
    const emitted = walk(root, ".js");
    expect(emitted.map((f) => relative(root, f).replace(/\.js$/, "")).sort()).toEqual(sources.sort());
    expect(walk(root, ".d.ts")).toHaveLength(sources.length);
    const bad = emitted.flatMap((f) =>
      relativeSpecifiers(readFileSync(f, "utf8"))
        .filter((s) => !s.endsWith(".js"))
        .map((s) => `${relative(root, f)}: ${s}`),
    );
    expect(bad).toEqual([]);
  });
});
```

Run (from `packages/nax-agent`): `bun test ./test/unit/build/tsconfig-build.test.ts --timeout=60000`
Expected: the new test FAILS, and `out` lists TS2835 and TS2834 errors in `src/`. The 2 fixture tests pass.

- [ ] **Step 6: Dry-run, run the codemod, then Biome's safe fixes**

```bash
cd packages/nax
bun scripts/s2-6-ts-extensions.ts ../nax-agent --dry-run | tail -1   # expect: would rewrite 420 specifiers in 116 files
bun scripts/s2-6-ts-extensions.ts ../nax-agent | tail -1             # expect: rewrote 420 specifiers in 116 files
bun scripts/s2-6-ts-extensions.ts ../nax-agent --dry-run | tail -1   # expect: would rewrite 0 specifiers in 0 files
cd ../nax-agent
git diff --numstat -- src | awk '{a+=$1; d+=$2} END {print NR, a, d}'   # expect: 116 420 420
git diff -- src | grep '^+[^+]' | grep -vcE '\.ts"'                    # expect: 0 (every added line ends a .ts specifier)
bun x biome check --write src/     # safe fixes only; NEVER --unsafe
git diff --stat -- src | tail -1   # expect: 116 files changed (5 of them gained Biome fixes)
```

If the counts differ from 420/116 because main moved after `2f2cf776f`, record the new counts in the commit message. Any throw names the unresolvable specifier: stop and investigate it. Do not hand-edit around it.

Review the generated diff by sampling, like the S1-5 move: read 10 random files (`git diff --name-only -- src | sort -R | head -10`), plus every file that has a `/index.ts` rewrite (`git diff -- src | grep -B20 '^+.*/index\.ts"' | grep '^+++'`) and the 4 `import("…")` type sites (`git diff -- src | grep '^+.*import("\.'`).

- [ ] **Step 7: Verify that Biome's import reorders are behaviour-neutral (Review Focus 4)**

Build nax's bundle before and after with the same `GIT_COMMIT` define, so only real changes show:

```bash
cd packages/nax
SCRATCH=$(mktemp -d)
build() { bun build bin/nax.ts --outdir "$1" --target bun --external "@nathapp/nax-ai" --external "@anthropic-ai/sandbox-runtime" --define 'GIT_COMMIT="s2-6"' >/dev/null; }
build "$SCRATCH/after"
git stash push -q -- ../nax-agent/src && build "$SCRATCH/before"; git stash pop -q
diff <(sort "$SCRATCH/before/nax.js") <(sort "$SCRATCH/after/nax.js") && echo PERMUTATION
diff "$SCRATCH/before/nax.js" "$SCRATCH/after/nax.js" | grep -E '^[<>] // \.\./nax-agent/src/' | sort -u
```

Expected: `PERMUTATION`. Then list the modules whose position moved. At planning this was `native/session/loop-events/cache-boundary.ts` only. For each moved module, open its source and confirm the top level holds only `import`, function, type and `const` declarations of literals: no calls, registrations or mutation of shared state. Record the list in the commit message. If any moved module has a top-level side effect, stop and report it.

- [ ] **Step 8: Run the real build test and the package gates**

```bash
cd packages/nax-agent
bun test ./test/unit/build/tsconfig-build.test.ts --timeout=60000   # 3 pass
bun run typecheck && bun run build && rm -rf dist
bun run check:all
bun test ./test/unit/ --timeout=60000 && bun test ./test/integration/ --timeout=60000   # expect 2977 unit (2974 + 3 build tests) + 31 integration, 0 fail
cd ../nax && bun run typecheck && bun run build && bun scripts/check-package-boundaries.ts && bun run scripts/check-bundle-externals.ts
```

Expected: all green. If main moved after `2f2cf776f`, the unit count is main's count + 3.

- [ ] **Step 9: Record the rule in agent guidance**

In `.nax/mono/packages/nax-agent/context.md`, replace the bullet that starts `- **Import with \`#src/\`, never \`@/\`.**` with:

```markdown
- **Import with `#src/`, never `@/`.** The package's own `imports` map defines `#src/*` and
  `#test/*`; `@/` is nax's tsconfig alias and does not resolve here. Relative imports that
  leave the package are rejected by the same gate.
- **Relative imports in `src/` name the file: `./x.ts`, `./dir/index.ts`.** The published build
  (`bun run build`, tsc nodenext) rewrites them to `.js` and rejects an extensionless one
  (TS2835/TS2834). `#src/…` specifiers stay extensionless. Tests are not built and keep either form.
```

Regenerate every output from the repo root, using the local build (the published canary may predate this change):

```bash
bun packages/nax/bin/nax.ts generate && bun packages/nax/bin/nax.ts generate --all-packages
git status --short -- '*.md' | head    # expect nax-agent's CLAUDE.md/AGENTS.md/GEMINI.md/codex.md plus the context.md
```

If root files change for reasons unrelated to this edit, revert those files and report it. Do not commit generator drift.

- [ ] **Step 10: Commit (generated change, then guidance)**

```bash
git add packages/nax-agent/src packages/nax-agent/test/unit/build/tsconfig-build.test.ts
git commit -m "refactor: explicit .ts on nax-agent's 420 relative imports (generated by s2-6-ts-extensions; biome safe fixes; moved modules: <list from Step 7>)"
git add .nax/mono/packages/nax-agent/context.md packages/nax-agent/CLAUDE.md packages/nax-agent/AGENTS.md packages/nax-agent/GEMINI.md packages/nax-agent/codex.md
git commit -m "docs: nax-agent relative imports name their .ts file"
```

---

### Task 5: Retire the codemod and close out

**Files:**
- Delete: `packages/nax/scripts/lib/ts-extensions.ts`, `packages/nax/scripts/s2-6-ts-extensions.ts`, `packages/nax/test/unit/scripts/ts-extensions.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: the PR.

- [ ] **Step 1: Retire the codemod (S1-5 precedent, `b4a53326e`)**

```bash
git rm -q packages/nax/scripts/lib/ts-extensions.ts packages/nax/scripts/s2-6-ts-extensions.ts packages/nax/test/unit/scripts/ts-extensions.test.ts
grep -rn "ts-extensions" packages --include='*.ts' --include='*.json' | grep -v node_modules   # expect nothing
git commit -m "chore: retire the S2-6 codemod; the build's TS2835/TS2834 guard explicit imports from here"
```

- [ ] **Step 2: Full verification from the repo root**

```bash
bun run typecheck && bun run check:all && bun run build
(cd packages/nax-agent && bun run test:coverage)     # baseline still empty; planning: 97.64% lines / 95.53% fn
(cd packages/nax && bun run test:coverage)           # planning: 96.54% lines / 93.72% fn, baseline unchanged
(cd packages/repo-tooling && bun run test)
git diff main -- packages/nax/package.json | grep -A3 '"dependencies"' ; git diff --quiet main -- packages/nax/package.json && echo NAX-MANIFEST-UNCHANGED
```

Expected: every command green, and `NAX-MANIFEST-UNCHANGED`.

- [ ] **Step 3: nax CLI unchanged (spec §10.5, non-billed part)**

Build main's bundle and the branch's bundle with the same define, then compare command output:

```bash
cd packages/nax
SCRATCH=$(mktemp -d)
build() { bun build bin/nax.ts --outdir "$1" --target bun --external "@nathapp/nax-ai" --external "@anthropic-ai/sandbox-runtime" --define 'GIT_COMMIT="s2-6"' >/dev/null; }
build "$SCRATCH/branch"
test -z "$(git status --porcelain)" || { echo 'commit or clean the tree first'; exit 1; }
git checkout -q main && build "$SCRATCH/main"; git checkout -q feat/s2-6-ts-specifiers-build
for c in "--help" "--version" "config" "auth list" "agents" "models"; do
  printf '%-10s %s %s\n' "$c" "$(bun "$SCRATCH/main/nax.js" $c 2>&1 | md5)" "$(bun "$SCRATCH/branch/nax.js" $c 2>&1 | md5)"
done
```

Expected: every row shows two identical md5s. The billed `nax run` smoke in §10.5 belongs to S2-9 acceptance and is not run here.

- [ ] **Step 4: Consumer types re-check (Review Focus 5, recorded and not committed)**

Repeat the planning probe against the branch build: a temp package with `exports` and `imports` into a copied `dist/`, a nodenext consumer with `skipLibCheck: false`, and `node` importing `.` and `/internal`. Expected: Node prints two non-zero export counts. tsc's only errors come from `@anthropic-ai/sandbox-runtime` (`node-forge` types, TS7016). Paste the result into the PR body under "Observed, for S2-8".

- [ ] **Step 5: Code review before push, then the PR**

Get a fresh-context review of `git diff main...HEAD`, excluding the generated `src/` hunks. Review those by sampling, as in Task 4 Step 6. Fix Critical and Important findings test-first, with at most 2 fix rounds. Then push and open the PR:

```bash
git push -u origin feat/s2-6-ts-specifiers-build
gh pr create --title "build: S2-6 — explicit .ts specifiers and the nax-agent tsc build" --body-file <(cat <<'EOF'
## Summary
- check-sandbox-imports now sees `../pipeline.ts`-style orchestrator imports. The other specifier gates get `.ts` pins (they already resolved the form).
- nax-agent: `tsconfig.build.json` (nodenext, rewriteRelativeImportExtensions, Node types only), `bun run build`, `@types/node` 25.2.3, `typescript` pinned to 7.0.2, and a CI Build step.
- `allowImportingTsExtensions` in the nax-agent and nax tsconfigs.
- Generated: 420 relative specifiers in 116 `src/` files gained an explicit `.ts`. Biome's safe fixes reordered and rewrapped 5 files. The reorders are side-effect-free (the nax bundle is a line permutation).
- Restored the S2-5 plan, which `2f2cf776f` committed with stash conflict markers.

## Test plan
- [ ] build test: fixture TS2835/TS2834 rejection, `.ts` to `.js` emit, real `src/` emits only `.js` relative specifiers
- [ ] nax-agent coverage gate green, baseline empty
- [ ] nax coverage, typecheck, check:all, build, boundaries and bundle-externals green
- [ ] nax CLI md5s (`--help`, `--version`, `config`, `auth list`, `agents`, `models`) identical to main
- [ ] CI nax-agent Build step green

## Observed, for S2-8
- Emitted `.d.ts` keep `./x.ts` specifiers. A nodenext consumer resolves them.
- A consumer with `skipLibCheck: false` hits TS7016 from `@anthropic-ai/sandbox-runtime` (`node-forge` types).
- `check-sandbox-imports` lists `runtime` as an orchestrator. In nax-agent, `src/runtime/` is the S2-4 runtime slot, so a sandbox import of it would be flagged.
EOF
)
```

Do not merge. Merge needs the user's call.

---

## Self-review

| Spec requirement (§5.1, §5.2, §9 S2-6) | Task |
|---|---|
| Specifier-resolving gates learn explicit `.ts` (import-specifiers, check-import-cycles, check-alias-internals, check-sandbox-imports, check-nax-ai-imports, check-package-boundaries, Biome plugins) | Task 2. Fixed: check-sandbox-imports. Pinned: import-cycles, boundaries, import-specifiers. Verified unaffected (Evidence): nax-ai-imports, alias-internals, grit plugins. |
| Scripted codemod: 412 (now 420) relative specifiers, 20 directory imports to `…/index.ts`, reviewed by sampling | Task 4 |
| `tsconfig.build.json` with the listed options | Task 3 |
| `allowImportingTsExtensions` in the nax-agent and nax tsconfigs | Task 3 |
| `build` script, `@types/node` devDependency, lockfile updated in the same PR | Task 3 (vitest is S2-8) |
| R7: TypeScript pinned exactly to 7.0.2 | Task 3 |
| A new extensionless import in `src/` fails the build step in CI | Task 3 (CI step, fixture test) and Task 4 (real-src test) |
| nax unchanged: dependencies byte-identical, bundled, CLI output identical | Task 4 Steps 7-8, Task 5 Steps 2-3 |
| Arc SSOT records the PR | After merge, in the maintainer's workspace (not a repo task) |

Placeholder scan: the only angle-bracket text is `<list from Step 7>` in a commit message, which is filled from Step 7's output. Type consistency: `explicitTsSpecifier` and `rewriteTsExtensions` are used with the same signatures in the tests, the script and the Interfaces block, and `tsc`, `relativeSpecifiers`, `PKG` and `BUILD_CONFIG` are defined in Task 3 and reused in Task 4. Review Focus: items 1-3 are tests in Task 4 Step 1, item 4 is Task 4 Step 7, and item 5 is Task 4 Step 5 (JS side) plus Task 5 Step 4.
