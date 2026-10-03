# S2-7 Curated Surface, API Snapshot, README and CHANGELOG: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `@nathapp/nax-agent`'s public surface explicit and guarded. `.` lists every export by name and exports no `_` name. The 20 `_` names live on `/internal`. A snapshot of both entries, extracted from the built `.d.ts`, is committed and gated in CI. The package gets a README and a CHANGELOG. The nax CLI is unchanged.

**Architecture:** One extraction library in `packages/repo-tooling` builds nax-agent's declarations into a temp project, opens it with the TypeScript 7 async API, and asks the checker for each entry's exports (name plus value/type kind). One gate script renders that into `api/nax-agent.api.txt`, diffs it against the committed file, and rejects any `_` name on `.` even under `--update`. `src/index.ts` is regenerated once from the old `export *` lines, and the snapshot diff proves the result equals the old surface minus the 20 seams.

**Tech Stack:** TypeScript 7.0.2 (`tsc`, plus `typescript/unstable/async` for the checker), Bun 1.4 workspaces and bun:test, Biome 2.5.10, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-02-s2-nax-agent-node-ready-publish-design.md`: §1, §2 (R3, R6), §3 (Surface), §5.2, §5.3, §8, §9 (S2-7 row), §10.4. The arc SSOT is `/Users/williamkhoo/workspace/subrina-coder/projects/nax/nax-agent-master-plan.md` (rulings D17-D21; read-only for this plan). Read the spec sections before executing.

## Global Constraints

- R3: "**Surface: `.` curated, `/internal` shipped as unstable.** `.` lists its exports by name and exports no `_` name. `/internal` still ships (nax needs it) and is documented as nax-only and outside semver."
- §5.3.1: "`src/index.ts` replaces `export *` with explicit `export { … }` and `export type { … }` lists."
- §5.3.2: "All **20** `_`-prefixed names (§3) leave `.` for `/internal`. The nax tests that import them from `.` switch to `/internal` by a scripted rewrite. A gate rejects any `_`-prefixed export from `.`."
- §5.3.3: "Otherwise `.` keeps today's content plus `setAgentRuntime`, `getAgentRuntime` and the runtime types."
- §5.3.4: "**API snapshot:** CI extracts the sorted exported names of `.` and `/internal` from the built `.d.ts` into `api/nax-agent.api.txt` and fails on any difference from the committed file."
- §5.3.5: "`src/internal.ts` gets a header stating it is nax-only and outside semver; the README says so too."
- First version `0.1.0`, new `CHANGELOG.md`. The README covers "install and the Node floor; the slots (logger, credentials, runtime); the three host-supplied ports (`runDeclaredCommand`, `ProtectedPathsPolicy`, `commandInterceptor`; S1-4); and the status of `/internal`." Node floor: `>=22.19.0`.
- R6: the workspace `package.json` keeps `private: true`, source-pointing `exports` and `imports`, and no export conditions. This PR does **not** bump `version` (`0.0.0`) and does **not** drop `private`. S2-8 owns `stage-publish`; S2-9 owns release wiring and the `0.1.0` publish.
- §5.4 / §10.5: `packages/nax/package.json` `dependencies` stay byte-identical; nax is bundled and its CLI is unchanged.
- Coverage: nax-agent gates 80% lines and functions overall and per file with an EMPTY baseline and `--require-all-files`. A new `src/` file needs tests to 80%. This plan adds no `src/` file. `src/index.ts` is a pure re-export barrel.
- Out of scope: `stage-publish`, vitest contract suite, tarball smoke, CI matrix (S2-8); release wiring and publishing (S2-9); the conversational API (S3).
- Never run bare `bun test` or `bun run nax`. Run scoped tests from the package directory with `--timeout=60000`. Never run `nax run` or `nax plan` (billed). Biome `--write` only, never `--unsafe`. nax-agent Biome has `useArraySortCompare`: use `.sort(byCodePoint)` (`#src/internal/sort` in nax-agent tests, `#scripts/lib/sort` in repo-tooling).
- Root `.gitignore` has a bare `build` entry: never put tracked files under a directory named `build/`. `api/` is not ignored (verified with `git check-ignore -v`).
- Conventional commits, no attribution lines. Do not push.

## Review Focus

1. **A `_` name leaking through an `export *` rather than a named export.** The old `.` leaked all 20 that way. The gate reads the built `.d.ts` exports, not the source text, so `export * from "./a.ts"` where `a.ts` exports `_seam` must fail. Task 1 test "reports a `_` name that arrives through `export *`".
2. **`--update` laundering a leak.** A contributor who sees the gate fail may run the update command. The update must refuse to write a snapshot whose `.` section holds a `_` name, and must leave the committed file untouched. Task 1 test "update refuses a `_` name on `.` and writes nothing".
3. **An extraction that silently drops names** (an unresolved module in the built `.d.ts` makes `export *` contribute nothing). The extractor must fail loudly on any diagnostic that belongs to the built declarations. Task 1 test "fails when the built declarations reference a missing module".
4. **A value exported as a type or the reverse.** Bun's per-file transpiler cannot elide `export { T } from` for a type, so an unmarked type is a runtime link error, and a `type` marker on a value hides it from JS consumers. The snapshot carries a `type ` marker per line, so the before/after comparison in Task 3 also proves no kind flipped. Task 1 test "marks type-only names"; Task 3 Step 5.
5. **`/internal` must hand back the same object the agent reads.** Moving `_commandShadowDeps` and `_systemOneClientDeps` to `/internal` must re-export the live binding, not a copy, or a nax test that patches the seam patches nothing. Task 2 test "the two command-safety seams are the very objects the modules read".

---

## Evidence (planning base: main `a755a5464`, S2-6 merged as #2335)

Measured in the repo and in a scratch APFS clone-free probe (nothing was committed):

- **Names exported today** (from the built `dist/*.d.ts`, resolved by the TS 7 checker): `.` = **367** names (**210** values, **157** types); `/internal` = **515** (**338** values, **177** types). The value counts equal S2-6's counts taken from the emitted JS (210 and 338), which cross-checks the extractor.
- **`_`-prefixed names on `.`: 20.** Exactly the spec's set: 17 `…Deps` seams (`_adapterDeps`, `_approvalsTaintDeps`, `_bashToolDeps`, `_codingToolDeps`, `_commandShadowDeps`, `_editDeps`, `_gitGuardDeps`, `_globDeps`, `_grepDeps`, `_launcherDeps`, `_policyInputDeps`, `_probeDeps`, `_sandboxRegistryDeps`, `_sessionTmpDeps`, `_spillDeps`, `_srtBackendDeps`, `_systemOneClientDeps`) and 3 reset hooks (`_resetBuiltinsForTest`, `_resetRegistryForTest`, `_resetSandboxRegistryForTests`). `/internal` carries 31 `_` names today.
- **18 of the 20 are already on `/internal`.** `_commandShadowDeps` and `_systemOneClientDeps` are not: `/internal` does not export the command-safety barrel. Both are defined in `src/command-safety/shadow.ts` and `systemone-client.ts` and are used only by nax-agent's own tests, which import them through `#src/command-safety/index`. Task 2 adds explicit `/internal` exports for them.
- **Scripted rewrite has zero sites.** A scan with `specifierSites` over all 3094 tracked `.ts` files found no import of `@nathapp/nax-agent` (exact specifier, static or dynamic) that names any of the 20. nax's 20 test files and 2 src files that use the seams (`approvals.ts`, `approvals-format.ts`) already import them from `@nathapp/nax-agent/internal`, as S1-5 left them. So the spec's "scripted rewrite of nax tests" is moot; no codemod is written, and the typecheck of nax-agent, nax and test-kit after Task 3 is the proof (Ruling in the ledger). The remaining `_`-name uses in nax-agent's own tests go through `#src/…`.
- **Consumers of `.`:** nax imports `@nathapp/nax-agent` from 161 files. Every name it needs survives, because the curated lists are generated from the old barrels (Task 3) and nax's typecheck verifies it.
- **Extraction mechanism, probed.** `typescript/unstable/sync` fails under Bun (`stdout._handle.fd` is undefined). `typescript/unstable/async` works under Bun 1.4.2: `new API({cwd}).updateSnapshot({openProject})`, `project.program.getSourceFile`, `project.checker.getSymbolAtLocation(sourceFile)`, `project.checker.getExportsOfModule(moduleSymbol)`, and `getAliasedSymbol` for the kind. Run time: about 0.1 s for both entries. Re-exported names are `Alias` symbols; the kind is read from the aliased target (`SymbolFlags.Value` set means a value, otherwise a type). Importing the built JS only sees values, so it cannot be the whole answer.
- **Built declarations keep `#src/…`.** Resolved against the package's own `package.json`, `#src/*` points at `src/*.ts`, which is the source, not the build. The extractor therefore builds into a temp directory with its own `package.json` whose `imports` map `#src/*` to `./dist/*.d.ts`, symlinks the package's `node_modules`, and opens that. With `skipLibCheck: false` the only semantic diagnostic anywhere is third-party (`@anthropic-ai/sandbox-runtime`'s `mitm-ca.d.ts`, TS7016, already recorded by S2-6); zero belong to nax-agent's `dist/`. The extractor fails on any diagnostic whose file is under the temp `dist/` and ignores the rest.
- **Explicit-list generation, probed.** The old `index.ts` is 18 `export *` lines plus 2 named statements. Walking each `export *` target's exports through the checker and assigning every name to its first source barrel gives 353 assigned names plus 14 already named (infra, runtime and `NO_OP_INTERACTION_HANDLER`) = 367, with none left over; dropping the 20 `_` names yields **347** names on `.` (190 values, 157 types).
- **Gates.** `check-gate-reachability` counts a repo-tooling gate as reachable when a CI step reaches a script that invokes it; `bun run check:api` in the nax-agent job does that. A bare `bun x tsc` from a temp directory would resolve the wrong `tsc` package; the extractor runs `bun x tsc` with `cwd` at repo-tooling, which has `typescript` 7.0.2 as a devDependency.
- **CLI baseline (main bundle, `--define 'GIT_COMMIT="x"'`, run in an empty temp dir with an empty `HOME`):**

| command | md5 | lines |
|---|---|---|
| `--help` | f30ce1b1904dea0006ac13d9cd9362bf | 51 |
| `--version` | 077a233a64f02933a0900ff6eb263586 | 0 |
| `config` | 2e130e5a57f71695c9e7a60bccc6fd91 | 521 |
| `auth list` | c309df82b5a4fa55f0da2b6442bcd951 | 1 |
| `agents` | 4f505c592c8cf13ee5b41e039a0e75c6 | 10 |

  Bundle: 5183639 bytes, md5 `b16bccfeaa039dd9a0b550f3fd553d97`. (`models` is not a nax command.) Task 6 repeats this on the branch.
- **The three host ports, verified in code (the README states exactly this).**
  - `runDeclaredCommand` (`src/tools/run-command.ts:298-303`): absent, the `RunCommand` tool answers `{ success: false, exitCode: 1, output: "no declared-command runner is configured for this session" }` and spawns nothing. Fails closed.
  - `ProtectedPathsPolicy` (`src/tools/protected-paths.ts`): optional on the tool context. Absent, `gitExcludePathspecsOf` and `gitIgnorePatternsOf` return `[]`, so the Git tool excludes nothing and `GitCommit` ignores no pattern. That is **not** fail-closed: no host paths are protected. `resolveSessionSandbox` (`/internal`) requires the policy and reads `credentialDir`, `projectStateDir` and `trustStoreFile` from it; without it the call throws a `TypeError`. The spec's "fail closed when absent" is accurate only for `runDeclaredCommand`; the README documents the real behaviour and the ledger records a Ruling.
  - `commandInterceptor` (`CommandInterceptor` on the tool context, `src/command-interceptor/`): absent, `interceptShell` and `interceptArgv` return the command unchanged (pass-through, not fail-closed). A present interceptor that throws, or whose rewrite fails validation, is treated as a decline and the original command runs.
  - Slots: `getSafeLogger()` is `null` and `getLogger()` is a silent no-op until `setAgentLogger` is called; `setAgentRuntime(null)` clears and `getAgentRuntime()` falls back to `nodeRuntime`; the first credential read without `configureCredentials` throws `NaxError` code `CREDENTIALS_NOT_CONFIGURED`.

## File Map

| Files | Responsibility |
|---|---|
| `packages/repo-tooling/scripts/lib/api-surface.ts` (new) | Build declarations to a temp project, extract entries with the TS async API, render, diff, check |
| `packages/repo-tooling/scripts/check-api-snapshot.ts` (new) | CLI: `--package=<dir> [--update]` |
| `packages/repo-tooling/test/unit/scripts/api-surface.test.ts` (new) | Extraction, render, diff and check tests over fixture packages |
| `packages/nax-agent/src/internal.ts` | Header (nax-only, outside semver); two command-safety seam exports |
| `packages/nax-agent/src/index.ts` | Explicit `export { … }` lists; no `_` name |
| `packages/nax-agent/test/unit/packaging/public-surface.test.ts` (new) | Runtime surface pins: no `_` key on `.`, 20 seams on `/internal`, identity of the two new seam exports |
| `packages/nax-agent/api/nax-agent.api.txt` (new, generated) | The committed snapshot |
| `packages/nax-agent/package.json` | Scripts `check:api`, `api:update` |
| `.github/workflows/ci.yml` | nax-agent job runs `bun run check:api` after Build |
| `packages/nax-agent/README.md`, `packages/nax-agent/CHANGELOG.md` (new) | Install, Node floor, slots, ports, `/internal` status; `0.1.0` unreleased |
| `.nax/mono/packages/nax-agent/context.md` and generated agent files | Public-surface rule, API commands, the stale Runtime row |

---

### Task 1: The API surface extractor and the snapshot gate

**Files:**
- Create: `packages/repo-tooling/scripts/lib/api-surface.ts`
- Create: `packages/repo-tooling/scripts/check-api-snapshot.ts`
- Test/Create: `packages/repo-tooling/test/unit/scripts/api-surface.test.ts`

**Interfaces:**
- Consumes: `byCodePoint` from `#scripts/lib/sort`; `gatePackageRoot()` from `#scripts/lib/package-root`; `API`, `SymbolFlags` from `typescript/unstable/async`.
- Produces (Tasks 3 and 4 use these exact names):
  - `type ApiEntryPoint = "." | "./internal"`; `const ENTRY_POINTS: readonly ApiEntryPoint[]`
  - `interface ApiEntry { readonly name: string; readonly kind: "value" | "type" }`
  - `type ApiSurface = Readonly<Record<ApiEntryPoint, readonly ApiEntry[]>>`
  - `extractPackageSurface(packageDir: string): Promise<ApiSurface>` (builds, extracts, always cleans up)
  - `extractApiSurface(projectDir: string): Promise<ApiSurface>` (projectDir already holds `dist/index.d.ts`, `dist/internal.d.ts`, `package.json`, `tsconfig.json`)
  - `renderSnapshot(packageName: string, surface: ApiSurface): string`
  - `diffSnapshots(committed: string, actual: string): { added: string[]; removed: string[] }`
  - `privateNamesOnPublicEntry(surface: ApiSurface): string[]`
  - `snapshotPathFor(packageDir: string): string` (`<dir>/api/<unscoped package name>.api.txt`)
  - `checkApiSnapshot(packageDir: string, options: { update: boolean }): Promise<{ ok: boolean; messages: string[] }>`

- [ ] **Step 1: Write the failing tests**

Create `packages/repo-tooling/test/unit/scripts/api-surface.test.ts`:

```ts
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
    expect(surface["."]).toEqual(
      [
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
      ],
    );
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
      ".": surface["."].filter((e) => e.name !== "Zed").map((e) => (e.name === "Klass" ? { ...e, kind: "type" as const } : e)),
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
    expect(privateNamesOnPublicEntry({ ".": [{ name: "a", kind: "value" }], "./internal": [{ name: "_x", kind: "value" }] })).toEqual(
      [],
    );
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
    writeFileSync(join(root, "src/index.ts"), 'export { alpha, type Id } from "./a.ts";\nexport { hidden } from "./b.ts";\n');
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
```

Run (from `packages/repo-tooling`): `bun test ./test/unit/scripts/api-surface.test.ts --timeout=60000`
Expected: FAIL. The module `#scripts/lib/api-surface` cannot be found.

- [ ] **Step 2: Implement the extractor library**

Create `packages/repo-tooling/scripts/lib/api-surface.ts`:

```ts
/**
 * A package's public API, read from its BUILT declarations.
 *
 * The published surface is whatever `dist/index.d.ts` and `dist/internal.d.ts`
 * export, after every `export *`, rename and `export type` has been resolved.
 * Reading source text would miss a `_` name that arrives through `export *`,
 * and importing the built JS would see values only. So the package is built
 * into a temp project and the TypeScript 7 checker is asked for each entry's
 * exports. The temp project maps `#src/*` to the built declarations: against
 * the real package.json the same specifier would resolve to `src/*.ts`.
 *
 * `typescript/unstable/async` is used because the sync client fails under Bun.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { API, SymbolFlags } from "typescript/unstable/async";
import { byCodePoint } from "#scripts/lib/sort";

export type ApiEntryPoint = "." | "./internal";
export const ENTRY_POINTS: readonly ApiEntryPoint[] = [".", "./internal"];
const ENTRY_FILES: Readonly<Record<ApiEntryPoint, string>> = { ".": "index.d.ts", "./internal": "internal.d.ts" };

export interface ApiEntry {
  readonly name: string;
  readonly kind: "value" | "type";
}
export type ApiSurface = Readonly<Record<ApiEntryPoint, readonly ApiEntry[]>>;

/** repo-tooling owns `typescript`, so `bun x tsc` run from here is TypeScript 7 (a bare temp dir would fetch the wrong `tsc`). */
const TOOLING_ROOT = fileURLToPath(new URL("../..", import.meta.url));

function buildDeclarations(packageDir: string, outDir: string): void {
  const proc = spawnSync(
    process.execPath,
    ["x", "tsc", "-p", join(packageDir, "tsconfig.build.json"), "--outDir", outDir],
    { cwd: TOOLING_ROOT, encoding: "utf8" },
  );
  if (proc.status !== 0) throw new Error(`tsc failed for ${packageDir}:\n${proc.stdout}${proc.stderr}`);
}

function writeProjectFiles(projectDir: string, packageDir: string): void {
  writeFileSync(
    join(projectDir, "package.json"),
    JSON.stringify({ name: "api-surface-probe", type: "module", imports: { "#src/*": "./dist/*.d.ts" } }),
  );
  writeFileSync(
    join(projectDir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ESNext",
        module: "nodenext",
        moduleResolution: "nodenext",
        noEmit: true,
        skipLibCheck: false,
        allowImportingTsExtensions: true,
        types: ["node"],
      },
      files: ENTRY_POINTS.map((e) => `dist/${ENTRY_FILES[e]}`),
    }),
  );
  const modules = join(packageDir, "node_modules");
  if (existsSync(modules)) symlinkSync(modules, join(projectDir, "node_modules"));
}

async function kindOf(
  checker: { getAliasedSymbol(s: never): Promise<{ flags: number }> },
  symbol: { flags: number },
): Promise<ApiEntry["kind"]> {
  const target = symbol.flags & SymbolFlags.Alias ? await checker.getAliasedSymbol(symbol as never) : symbol;
  return target.flags & SymbolFlags.Value ? "value" : "type";
}

/** The exports of each entry of an already-built project. Fails on any diagnostic inside its `dist/`. */
export async function extractApiSurface(projectDir: string): Promise<ApiSurface> {
  const root = realpathSync(projectDir);
  const api = new API({ cwd: root });
  try {
    const snapshot = await api.updateSnapshot({ openProject: join(root, "tsconfig.json") });
    const project = snapshot.getProjects()[0];
    if (project === undefined) throw new Error(`no TypeScript project opened in ${root}`);
    const own = (await project.program.getSemanticDiagnostics()).filter((d) => d.fileName?.startsWith(join(root, "dist")));
    if (own.length > 0) {
      const lines = own.slice(0, 5).map((d) => `${d.fileName}: TS${d.code} ${d.text}`);
      throw new Error(`the built declarations do not type-check, so the API cannot be read reliably:\n${lines.join("\n")}`);
    }
    const out: Partial<Record<ApiEntryPoint, ApiEntry[]>> = {};
    for (const entry of ENTRY_POINTS) {
      const file = join(root, "dist", ENTRY_FILES[entry]);
      const sourceFile = await project.program.getSourceFile(file);
      const moduleSymbol = sourceFile && (await project.checker.getSymbolAtLocation(sourceFile));
      if (moduleSymbol === undefined) throw new Error(`${file} is missing or exports nothing`);
      const entries: ApiEntry[] = [];
      for (const symbol of await project.checker.getExportsOfModule(moduleSymbol)) {
        entries.push({ name: symbol.name, kind: await kindOf(project.checker, symbol) });
      }
      out[entry] = entries.sort((a, b) => byCodePoint(a.name, b.name));
    }
    return out as ApiSurface;
  } finally {
    await api.close();
  }
}

/** Builds `packageDir` into a temp project, reads its surface, and always removes the temp project. */
export async function extractPackageSurface(packageDir: string): Promise<ApiSurface> {
  const projectDir = realpathSync(mkdtempSync(join(tmpdir(), "api-surface-")));
  try {
    buildDeclarations(packageDir, join(projectDir, "dist"));
    writeProjectFiles(projectDir, packageDir);
    return await extractApiSurface(projectDir);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
}

export function renderSnapshot(packageName: string, surface: ApiSurface): string {
  const lines = [
    `# ${packageName} public API. Generated by \`bun run api:update\`; do not edit by hand.`,
    "# One line per exported name, sorted by code point. `type ` marks a name with no runtime value.",
  ];
  for (const entry of ENTRY_POINTS) {
    const sorted = [...surface[entry]].sort((a, b) => byCodePoint(a.name, b.name));
    lines.push("", `[${entry}]`, ...sorted.map((e) => (e.kind === "type" ? `type ${e.name}` : e.name)));
  }
  return `${lines.join("\n")}\n`;
}

/** `[section] line` for every entry line, in file order. */
function sectionedLines(text: string): string[] {
  let section = "";
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("[") && line.endsWith("]")) section = line;
    else out.push(`${section} ${line}`);
  }
  return out;
}

export function diffSnapshots(committed: string, actual: string): { added: string[]; removed: string[] } {
  const before = new Set(sectionedLines(committed));
  const after = new Set(sectionedLines(actual));
  return {
    added: [...after].filter((l) => !before.has(l)).sort(byCodePoint),
    removed: [...before].filter((l) => !after.has(l)).sort(byCodePoint),
  };
}

/** `_` names are test seams and reset hooks: they belong on `./internal`, never on `.`. */
export function privateNamesOnPublicEntry(surface: ApiSurface): string[] {
  return surface["."].filter((e) => e.name.startsWith("_")).map((e) => e.name).sort(byCodePoint);
}

function packageNameOf(packageDir: string): string {
  const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as { name?: string };
  if (typeof pkg.name !== "string") throw new Error(`${packageDir}/package.json has no name`);
  return pkg.name;
}

export function snapshotPathFor(packageDir: string): string {
  const unscoped = packageNameOf(packageDir).replace(/^@[^/]+\//, "");
  return join(packageDir, "api", `${unscoped}.api.txt`);
}

export interface ApiCheckResult {
  readonly ok: boolean;
  readonly messages: string[];
}

export async function checkApiSnapshot(packageDir: string, options: { update: boolean }): Promise<ApiCheckResult> {
  const surface = await extractPackageSurface(packageDir);
  const leaked = privateNamesOnPublicEntry(surface);
  if (leaked.length > 0) {
    return {
      ok: false,
      messages: [
        `The public entry "." exports ${leaked.length} "_" name(s): ${leaked.join(", ")}`,
        'Test seams and reset hooks belong on "./internal". Move them there; the snapshot is not updated.',
      ],
    };
  }
  const actual = renderSnapshot(packageNameOf(packageDir), surface);
  const path = snapshotPathFor(packageDir);
  if (options.update) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, actual);
    return { ok: true, messages: [`check-api-snapshot: wrote ${path} (${surface["."].length} on ".", ${surface["./internal"].length} on "./internal")`] };
  }
  if (!existsSync(path)) {
    return { ok: false, messages: [`${path} does not exist. Run \`bun run api:update\` and commit the file.`] };
  }
  const committed = readFileSync(path, "utf8");
  if (committed === actual) return { ok: true, messages: ["check-api-snapshot: clean"] };
  const { added, removed } = diffSnapshots(committed, actual);
  return {
    ok: false,
    messages: [
      "The built public API differs from the committed snapshot:",
      ...removed.map((l) => `  - ${l}`),
      ...added.map((l) => `  + ${l}`),
      "If the change is intended, run `bun run api:update` and commit the file.",
    ],
  };
}
```

Create `packages/repo-tooling/scripts/check-api-snapshot.ts`:

```ts
#!/usr/bin/env bun
/**
 * Gate: the built public API of a package equals its committed snapshot, and
 * the public entry exports no `_` name.
 *
 *   bun ../repo-tooling/scripts/check-api-snapshot.ts --package=.            # check
 *   bun ../repo-tooling/scripts/check-api-snapshot.ts --package=. --update   # rewrite the snapshot
 *
 * One tool for both rules: the `_` check reads the same resolved exports as
 * the snapshot, so it sees a seam that leaks through `export *`, and `--update`
 * cannot write a snapshot that contains one.
 */
import { checkApiSnapshot } from "#scripts/lib/api-surface";
import { gatePackageRoot } from "#scripts/lib/package-root";

async function main(): Promise<void> {
  const result = await checkApiSnapshot(gatePackageRoot(), { update: process.argv.includes("--update") });
  for (const message of result.messages) (result.ok ? console.log : console.error)(message);
  if (!result.ok) process.exit(1);
}

if (import.meta.main) await main();
```

- [ ] **Step 3: Run the tests to verify they pass**

Run (from `packages/repo-tooling`): `bun test ./test/unit/scripts/api-surface.test.ts --timeout=60000`
Expected: PASS, 13 tests. If the first test's expected lists differ, read the actual list before touching the code: the sort is by code point, so `Id` precedes `_seam`, which precedes `alpha`.

- [ ] **Step 4: Lint, typecheck and run the whole repo-tooling suite**

```bash
cd packages/repo-tooling
bun x biome check --write scripts/ test/ && bun x biome check --error-on-warnings --diagnostic-level=warn scripts/ test/
bun run typecheck
bun run test > /dev/null 2>&1; echo $?   # also keep the tail: bun run test 2>&1 | tail -5
```

Expected: Biome clean (the `--write` pass may reformat the two new files; never `--unsafe`), typecheck clean, suite green. If typecheck rejects the `kindOf` parameter types, replace the structural `checker` type with `Pick<Checker, "getAliasedSymbol">` imported from `typescript/unstable/async`; do not use `any`.

- [ ] **Step 5: Commit**

```bash
git add packages/repo-tooling/scripts/lib/api-surface.ts packages/repo-tooling/scripts/check-api-snapshot.ts packages/repo-tooling/test/unit/scripts/api-surface.test.ts
git commit -m "feat: check-api-snapshot reads a package's built public API with the TS 7 checker"
```

---

### Task 2: `/internal` header and the two command-safety seams

**Files:**
- Modify: `packages/nax-agent/src/internal.ts`
- Test/Create: `packages/nax-agent/test/unit/packaging/public-surface.test.ts`

**Interfaces:**
- Consumes: `_commandShadowDeps` (`src/command-safety/shadow.ts`) and `_systemOneClientDeps` (`src/command-safety/systemone-client.ts`), exported today by `src/command-safety/index.ts`.
- Produces: both names importable from `@nathapp/nax-agent/internal`, as the same objects. Task 3 appends tests to the same test file.

- [ ] **Step 1: Write the failing test**

Create `packages/nax-agent/test/unit/packaging/public-surface.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import * as internal from "@nathapp/nax-agent/internal";
import { _commandShadowDeps, _systemOneClientDeps } from "#src/command-safety/index";
import { byCodePoint } from "#src/internal/sort";

/** The 20 names S2-7 moves off `.`: 17 `…Deps` seams and 3 reset hooks. */
const SEAMS = [
  "_adapterDeps",
  "_approvalsTaintDeps",
  "_bashToolDeps",
  "_codingToolDeps",
  "_commandShadowDeps",
  "_editDeps",
  "_gitGuardDeps",
  "_globDeps",
  "_grepDeps",
  "_launcherDeps",
  "_policyInputDeps",
  "_probeDeps",
  "_resetBuiltinsForTest",
  "_resetRegistryForTest",
  "_resetSandboxRegistryForTests",
  "_sandboxRegistryDeps",
  "_sessionTmpDeps",
  "_spillDeps",
  "_srtBackendDeps",
  "_systemOneClientDeps",
] as const;

describe("/internal", () => {
  test("carries all 20 test seams and reset hooks", () => {
    const missing = SEAMS.filter((name) => !(name in internal));
    expect(missing.sort(byCodePoint)).toEqual([]);
    expect(SEAMS).toHaveLength(20);
  });

  test("the two command-safety seams are the very objects the modules read", () => {
    // A copy would make a test that patches the seam patch nothing.
    expect(internal._commandShadowDeps).toBe(_commandShadowDeps);
    expect(internal._systemOneClientDeps).toBe(_systemOneClientDeps);
  });
});
```

Run (from `packages/nax-agent`): `bun test ./test/unit/packaging/public-surface.test.ts --timeout=60000`
Expected: FAIL. `missing` lists `_commandShadowDeps` and `_systemOneClientDeps`, and the identity test fails on `undefined`.

- [ ] **Step 2: Add the exports and the header**

In `packages/nax-agent/src/internal.ts`, replace the header comment with:

```ts
/**
 * @nathapp/nax-agent/internal: what nax reaches below the public entry -- shared
 * helpers, NaxError, deep modules and the _*Deps test seams.
 *
 * NAX-ONLY AND OUTSIDE SEMVER. Nothing here is a supported API for any other
 * consumer: names, shapes and behaviour change in any release, patch included.
 * It exists because nax bundles this package and its tests patch the seams. It
 * re-exports the same module instances, so patching a seam here patches the
 * object the agent reads. `.` exports no "_" name; every seam and reset hook
 * lives here (S2 spec section 5.3).
 *
 * Written by the S1-5 move script; maintained by hand from here on.
 */
```

and add, in alphabetical position among the `export *` lines (after `export * from "#src/command-interceptor/index";`):

```ts
export { _commandShadowDeps } from "#src/command-safety/shadow";
export { _systemOneClientDeps } from "#src/command-safety/systemone-client";
```

Run: `bun test ./test/unit/packaging/public-surface.test.ts --timeout=60000`
Expected: PASS, 2 tests.

- [ ] **Step 3: Lint and typecheck**

```bash
cd packages/nax-agent
bun x biome check --write src/internal.ts test/unit/packaging/public-surface.test.ts
bun run typecheck && bun run lint:biome
```

Expected: clean. (Biome may move the two new lines to its preferred order; accept.)

- [ ] **Step 4: Commit**

```bash
git add packages/nax-agent/src/internal.ts packages/nax-agent/test/unit/packaging/public-surface.test.ts
git commit -m "refactor: /internal states it is nax-only, and carries the two command-safety seams"
```

---

### Task 3: The curated `.` (explicit export lists)

**Files:**
- Modify: `packages/nax-agent/src/index.ts`
- Test: `packages/nax-agent/test/unit/packaging/public-surface.test.ts`
- Scratch (not committed): `$WS/curate-index.mjs`, `$WS/api-before.txt`, `$WS/api-after.txt` where `$WS` is the plan workspace printed by `sdd-workspace`.

**Interfaces:**
- Consumes: `extractPackageSurface`, `renderSnapshot`, `diffSnapshots` from Task 1; the `/internal` seams from Task 2.
- Produces: `src/index.ts` with explicit lists, exporting **347** names (190 values, 157 types), the old 367 minus the 20 `_` names.

- [ ] **Step 1: Add the failing runtime test**

Append to `packages/nax-agent/test/unit/packaging/public-surface.test.ts` (add `import * as pub from "@nathapp/nax-agent";` to the imports):

```ts
describe(".", () => {
  test("exports no `_` name: the seams and reset hooks are /internal's", () => {
    expect(
      Object.keys(pub)
        .filter((key) => key.startsWith("_"))
        .sort(byCodePoint),
    ).toEqual([]);
  });

  test("keeps the runtime slot, the logger slot and the credentials slot", () => {
    expect(pub.setAgentRuntime).toBeFunction();
    expect(pub.getAgentRuntime).toBeFunction();
    expect(pub.setAgentLogger).toBeFunction();
    expect(pub.configureCredentials).toBeFunction();
    expect(pub.nodeRuntime.spawn).toBeFunction();
  });
});
```

Run (from `packages/nax-agent`): `bun test ./test/unit/packaging/public-surface.test.ts --timeout=60000`
Expected: the "exports no `_` name" test FAILS listing the 20 names; the slot test and the two `/internal` tests pass.

- [ ] **Step 2: Capture the before-snapshot**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax
WS=$(/Users/williamkhoo/.claude/plugins/cache/claude-plugins-official/superpowers/6.4.1/skills/subagent-driven-development/scripts/sdd-workspace docs/superpowers/plans/2026-10-03-s2-7-curated-surface.md)
cat > "$WS/dump-surface.ts" <<'EOF'
import { extractPackageSurface, renderSnapshot } from "/Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax/packages/repo-tooling/scripts/lib/api-surface";
const dir = process.argv[2] ?? "";
process.stdout.write(renderSnapshot("@nathapp/nax-agent", await extractPackageSurface(dir)));
EOF
(cd packages/repo-tooling && bun "$WS/dump-surface.ts" /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax/packages/nax-agent > "$WS/api-before.txt")
awk '/^\[\.\]/{s=1;next} /^\[\.\/internal\]/{s=2;next} s==1&&NF{a++} s==2&&NF{b++} END{print a, b}' "$WS/api-before.txt"
```

Expected: `367 517` (`.` unchanged from the planning measurement; `/internal` 515 + the 2 seams from Task 2). Keep `$WS/api-before.txt`.

- [ ] **Step 3: Generate the explicit lists from the old barrels**

Write `$WS/curate-index.mjs`. It reads the CURRENT `src/index.ts`, resolves each `export * from "…"` target's exports through the checker, assigns every public name to the first barrel that provides it (names already exported by the file's explicit statements stay where they are), marks type-only names with `type`, and drops the `_` names:

```js
import { API, SymbolFlags } from "typescript/unstable/async";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [pkg, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
writeFileSync(
  join(out, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      target: "ESNext", module: "ESNext", moduleResolution: "bundler", lib: ["ESNext"], types: ["bun-types"],
      strict: true, skipLibCheck: true, allowImportingTsExtensions: true, noEmit: true,
      typeRoots: [`${pkg}/node_modules/@types`, `${pkg}/../../node_modules/@types`],
    },
    files: [`${pkg}/src/index.ts`],
  }),
);
try { symlinkSync(`${pkg}/../../node_modules`, join(out, "node_modules")); } catch {}

const api = new API({ cwd: out });
const snapshot = await api.updateSnapshot({ openProject: join(out, "tsconfig.json") });
const project = snapshot.getProjects()[0];
const checker = project.checker;

async function exportsOf(file) {
  const sf = await project.program.getSourceFile(file);
  if (!sf) return undefined;
  const sym = await checker.getSymbolAtLocation(sf);
  const list = [];
  for (const s of await checker.getExportsOfModule(sym)) {
    const t = s.flags & SymbolFlags.Alias ? await checker.getAliasedSymbol(s) : s;
    list.push({ name: s.name, value: Boolean(t.flags & SymbolFlags.Value) });
  }
  return list;
}

const source = readFileSync(`${pkg}/src/index.ts`, "utf8");
const final = new Map((await exportsOf(`${pkg}/src/index.ts`)).map((e) => [e.name, e.value]));

// Names the file already exports by name stay in their explicit statements (kept verbatim below).
const named = new Set();
for (const m of source.matchAll(/export (?:type )?\{([^}]*)\} from "[^"]+";/g)) {
  for (const raw of m[1].split(",")) {
    const n = raw.trim().replace(/^type /, "");
    if (n) named.add(n);
  }
}

const stars = [...source.matchAll(/^export \* from "([^"]+)";$/gm)].map((m) => m[1]);
const assigned = new Set(named);
const statements = [];
for (const spec of stars) {
  const rel = spec.replace("#src/", "");
  const list = (await exportsOf(`${pkg}/src/${rel}.ts`)) ?? (await exportsOf(`${pkg}/src/${rel}/index.ts`));
  if (!list) throw new Error(`cannot resolve ${spec}`);
  const mine = list.filter((e) => final.has(e.name) && !assigned.has(e.name));
  for (const e of mine) assigned.add(e.name);
  const kept = mine.filter((e) => !e.name.startsWith("_")).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (kept.length > 0) statements.push(`export {\n${kept.map((e) => `  ${e.value ? "" : "type "}${e.name},`).join("\n")}\n} from "${spec}";`);
}
const leftover = [...final.keys()].filter((n) => !assigned.has(n));
if (leftover.length > 0) throw new Error(`names with no source barrel: ${leftover.join(", ")}`);

// Keep the file's own explicit statements (infra, runtime, NO_OP_INTERACTION_HANDLER) as they are.
const explicit = [...source.matchAll(/^export (?:type )?\{[\s\S]*?\} from "[^"]+";$/gm)].map((m) => m[0]);
writeFileSync(join(out, "generated-body.ts"), `${[...statements, ...explicit].join("\n")}\n`);
console.log({ finalNames: final.size, assigned: assigned.size, statements: statements.length });
await api.close();
```

Run it from the repository root so `typescript/unstable/async` resolves:

```bash
node_modules/.bin/bun "$WS/curate-index.mjs" "$PWD/packages/nax-agent" "$WS/curate" 2>/dev/null || bun "$WS/curate-index.mjs" "$PWD/packages/nax-agent" "$WS/curate"
```

Expected: `finalNames: 367`, `assigned: 367`, no throw. (If `typescript/unstable/async` does not resolve from `$WS`, copy the script next to `packages/repo-tooling/scripts` temporarily, run it there, and delete the copy; do not commit it.)

Now write the new `src/index.ts`: the header below, then the content of `$WS/curate/generated-body.ts`:

```ts
/**
 * @nathapp/nax-agent public entry (S1 spec section 4.4, S2 spec section 5.3).
 *
 * Every export is named: nothing reaches this entry through `export *`. No "_"
 * name belongs here; test seams and reset hooks live on ./internal. The built
 * surface of both entries is pinned by api/nax-agent.api.txt (`bun run check:api`).
 *
 * Generated once by S2-7 from the previous `export *` barrels; maintained by hand.
 */
```

Then:

```bash
cd packages/nax-agent
bun x biome check --write src/index.ts      # sorts and wraps; safe fixes only
```

- [ ] **Step 4: Typecheck everything that consumes `.`, and run the new tests**

```bash
cd packages/nax-agent && bun run typecheck && bun test ./test/unit/packaging/public-surface.test.ts --timeout=60000
cd ../nax && bun run typecheck
cd ../test-kit && bun run typecheck 2>&1 | tail -3
```

Expected: all green; the previously failing "exports no `_` name" test now PASSES (4 tests in the file). A TS2305/TS2724 in nax means a name nax imports did not survive; do not add it by hand, inspect the generator output for it.

- [ ] **Step 5: Prove the surface is the old one minus the 20 seams, kinds intact**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax
(cd packages/repo-tooling && bun "$WS/dump-surface.ts" /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax/packages/nax-agent > "$WS/api-after.txt")
diff "$WS/api-before.txt" "$WS/api-after.txt" | grep '^[<>]' | sort | uniq -c | awk '{print $2}' | sort | uniq -c
diff "$WS/api-before.txt" "$WS/api-after.txt" | grep '^>' | wc -l          # expect 0 (nothing added, no kind flipped)
diff "$WS/api-before.txt" "$WS/api-after.txt" | grep '^<' | sed 's/^< //' | sort | tr '\n' ' '
awk '/^\[\.\]/{s=1;next} /^\[\.\/internal\]/{s=2;next} s==1&&NF{a++} s==2&&NF{b++} END{print a, b}' "$WS/api-after.txt"
```

Expected: no `>` lines; exactly the 20 `_` names as `<` lines (all from `[.]`, so `/internal` is byte-identical); counts `347 517`. Any other removed name, any added line, or any `type ` flip is a defect in the generated lists: fix `index.ts` (never the snapshot) and repeat.

- [ ] **Step 6: Package tests and gates**

```bash
cd packages/nax-agent
bun run lint:biome && bun run lint:checks > "$WS/t3-lint.txt" 2>&1; tail -3 "$WS/t3-lint.txt"
bun test ./test/unit/ --timeout=60000 > "$WS/t3-unit.txt" 2>&1; tail -6 "$WS/t3-unit.txt"
```

Expected: lint clean; unit suite green (main's count plus the 4 new tests; main's count is recorded by `task-start`'s BASE run in the ledger at the first full run).

- [ ] **Step 7: Commit**

```bash
git add packages/nax-agent/src/index.ts packages/nax-agent/test/unit/packaging/public-surface.test.ts
git commit -m "refactor: curate nax-agent's public entry; the 20 _ seams leave . (347 names, was 367)"
```

---

### Task 4: Commit the snapshot, wire the gate, add the CI step

**Files:**
- Create (generated): `packages/nax-agent/api/nax-agent.api.txt`
- Modify: `packages/nax-agent/package.json`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `check-api-snapshot.ts` (Task 1); the curated entries (Tasks 2 and 3).
- Produces: scripts `check:api` and `api:update` in nax-agent; a CI step.

- [ ] **Step 1: Add the scripts and watch the gate fail on a missing snapshot**

In `packages/nax-agent/package.json` `scripts`, after `"build"`:

```json
    "check:api": "bun ../repo-tooling/scripts/check-api-snapshot.ts --package=.",
    "api:update": "bun ../repo-tooling/scripts/check-api-snapshot.ts --package=. --update",
```

Run (from `packages/nax-agent`): `bun run check:api; echo "exit $?"`
Expected: FAIL, exit 1, message `…/api/nax-agent.api.txt does not exist. Run \`bun run api:update\` and commit the file.`

- [ ] **Step 2: Generate the snapshot and re-run the gate**

```bash
bun run api:update          # expect: wrote …/api/nax-agent.api.txt (347 on ".", 517 on "./internal")
bun run check:api           # expect: check-api-snapshot: clean
cmp api/nax-agent.api.txt "$WS/api-after.txt" | head -1   # headers differ only if the dump script's header differs; expect no output
grep -c '^_' api/nax-agent.api.txt        # `_` lines: expect 31 (all under [./internal])
awk '/^\[\.\]/{s=1;next} /^\[\.\/internal\]/{s=2;next} s==1&&/^_/{n++} END{print n+0}' api/nax-agent.api.txt   # expect 0
git check-ignore -v api/nax-agent.api.txt; echo "ignored: $?"   # expect: ignored: 1 (not ignored)
```

Then prove the gate trips. Temporarily append `export { _globDeps } from "#src/tools/index";` to `src/index.ts` (Biome would reorder; do not format it), run `bun run check:api`, expect exit 1 naming `_globDeps`, then `git checkout src/index.ts`. Also edit one name in the snapshot file, run the gate, expect a `-`/`+` pair, then `git checkout api/` is not possible (the file is untracked): re-run `bun run api:update` instead and confirm `clean`.

- [ ] **Step 3: CI step**

In `.github/workflows/ci.yml`, in the `nax-agent` job, after the `Build` step:

```yaml
      # S2-7: the built public API of "." and "./internal" equals api/nax-agent.api.txt,
      # and "." exports no "_" name. Intended changes: `bun run api:update`, commit the file.
      - name: API snapshot
        run: bun run check:api
```

- [ ] **Step 4: Reachability and boundary gates**

```bash
cd packages/nax
bun scripts/check-gate-reachability.ts && bun scripts/check-package-boundaries.ts
cd ../nax-agent && bun run check:all > "$WS/t4-checkall.txt" 2>&1; tail -3 "$WS/t4-checkall.txt"
```

Expected: both gates exit 0 (`check-api-snapshot.ts` is reachable through `bun run check:api` in the workflow); `check:all` green.

- [ ] **Step 5: Commit**

```bash
git add packages/nax-agent/api/nax-agent.api.txt packages/nax-agent/package.json .github/workflows/ci.yml
git commit -m "ci: pin nax-agent's built public API in api/nax-agent.api.txt (347 on ., 517 on /internal)"
```

---

### Task 5: README, CHANGELOG and agent guidance

**Files:**
- Create: `packages/nax-agent/README.md`, `packages/nax-agent/CHANGELOG.md`
- Modify: `.nax/mono/packages/nax-agent/context.md`
- Modify (generated): `packages/nax-agent/{CLAUDE,AGENTS,GEMINI}.md`, `packages/nax-agent/codex.md`, and any root-level generated file `nax generate` rewrites

**Interfaces:** none (documentation). Every claim in the README is one verified in the Evidence section.

- [ ] **Step 1: Write the README**

Create `packages/nax-agent/README.md`:

````markdown
# @nathapp/nax-agent

nax's native coding agent as a package: the session contract, the native session adapter and its turn loop over `@nathapp/nax-ai`, the tool set, permission resolution, the OS sandbox, command-safety and cost accounting.

> **Pre-1.0, not yet published.** `0.1.0` is the first planned version. Until `1.0` the API of `.` may change in any minor release. Pin an exact version.

## Install

```bash
npm install @nathapp/nax-agent
```

Requires **Node.js >= 22.19.0**. The package is ESM only and ships no Bun code: it runs on Node, and on Bun, with the default runtime.

## Entry points

- **`@nathapp/nax-agent`** is the supported entry. Every export is named, and none starts with `_`. Its exact names are pinned in [`api/nax-agent.api.txt`](api/nax-agent.api.txt), which CI compares with the built declarations.
- **`@nathapp/nax-agent/internal`** is **nax-only and outside semver.** nax bundles this package and reaches below the public entry for shared helpers, `NaxError`, deep modules and the `_*Deps` test seams. Names, shapes and behaviour there can change in any release, patch included, and a change there is not a breaking change. Do not import it from another project.

## Process-wide slots

The host installs these once, near startup. They are module-level, so they apply to everything in the process.

| Slot | Install | When unset |
|:-----|:--------|:-----------|
| Logger | `setAgentLogger(logger)` (`null` clears) | Logging is silent: `getLogger()` is a no-op logger and `getSafeLogger()` is `null`. |
| Credentials | `configureCredentials({ configDir, readAuthConfig })` | The first credential read throws `NaxError` with code `CREDENTIALS_NOT_CONFIGURED`. There is no default config directory. |
| Runtime | `setAgentRuntime(runtime)` (`null` clears) | `getAgentRuntime()` returns `nodeRuntime`, built on `node:child_process` and `node:fs`. |

`AgentRuntime` is the process and glob contract (`spawn`, `glob`, `globSync`). The Node default is complete; install your own only to change how the agent spawns processes or expands globs.

## Ports the host supplies

Three pieces of host knowledge are passed in as data or functions, because the package cannot know them. Their behaviour when you omit them differs, so check each one.

- **`runDeclaredCommand`** runs a command your project declared (a test or lint command), never one the model wrote. If you do not supply it, the `RunCommand` tool answers `exit 1` with "no declared-command runner is configured for this session" and starts no process. It fails closed.
- **`ProtectedPathsPolicy`** names the paths you own and want kept away from the agent: git pathspecs the Git tool excludes from its default view, gitignore patterns `GitCommit` refuses to stage, the project state directory, the credential directory and the trust-store file the sandbox protects. If you do not supply it, the coding tools protect no host paths: the Git tool excludes nothing and `GitCommit` refuses no pattern. Supply it whenever the agent works in a directory that holds files you own. Building a sandboxed session requires it.
- **`commandInterceptor`** may rewrite a command before it runs (for example to prefix a wrapper binary). Rewrites are validated: an argv rewrite may only prefix the original argv with the provider's own binary, and a shell rewrite goes through the same narrowing. If you do not supply one, commands run unchanged. An interceptor that throws, or returns a rewrite that fails validation, is treated as a decline, and the original command runs.

## Status and roadmap

The embedder-facing session API is still being designed, so `0.x` may reshape `.` with a minor bump. See [`CHANGELOG.md`](CHANGELOG.md).

## License

MIT
````

- [ ] **Step 2: Write the CHANGELOG**

Create `packages/nax-agent/CHANGELOG.md`. The release workflow extracts a section with `## [<version>]`, so keep that heading shape:

```markdown
# Changelog

All notable changes to `@nathapp/nax-agent` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). While the version is `0.x`, a minor
release may change the public API.

## [0.1.0] - Unreleased

First published version. Extracted from nax, where it was the native agent.

### Added

- The session contract, the native session adapter and `nativeComplete`, the tool set, permission
  resolution, the OS sandbox, command-safety and the cost core, behind `@nathapp/nax-agent`.
- Process-wide slots: `setAgentLogger`, `configureCredentials`, and `setAgentRuntime` with a Node
  default (`nodeRuntime`).
- Host ports: `runDeclaredCommand`, `ProtectedPathsPolicy`, `commandInterceptor`.
- `@nathapp/nax-agent/internal`, nax-only and outside semver.
- `api/nax-agent.api.txt`: the built public API, checked in CI.

### Notes

- Requires Node.js >= 22.19.0. No Bun APIs ship in the package.
- `.` exports no `_`-prefixed name; test seams and reset hooks are on `./internal` only.
```

Do not touch `package.json` `version` or `private`.

- [ ] **Step 3: Update the package context**

Edit `.nax/mono/packages/nax-agent/context.md`:

1. Replace the stale Runtime row `| Runtime | **Bun 1.4.0** — Bun-native APIs only, no Node.js equivalents |` with:
   `| Runtime | **Bun 1.4.0** for dev and tests; the shipped source is Node-compatible (>=22.19.0) and uses no Bun API (`bun run check:no-bun-apis`) |`
2. In the Commands table add two rows after `bun run build`:
   `| `bun run check:api` | Build, read the exports of `.` and `./internal` from the declarations, and diff against `api/nax-agent.api.txt`; fails if `.` exports a `_` name |`
   `| `bun run api:update` | Rewrite `api/nax-agent.api.txt` after an intended surface change (refuses a `_` name on `.`) |`
3. Replace the "Two entries, and only two:" bullet list so it reads:
   - **`.`** (`src/index.ts`): the supported contract. Every export is **named** (no `export *`), none starts with `_`. Adding or removing a name changes `api/nax-agent.api.txt`; run `bun run api:update` and commit it.
   - **`./internal`** (`src/internal.ts`): nax-only, outside semver (see its header). It holds the shared helpers, `NaxError`, deep modules and **every `_*Deps` seam and `_reset…` hook**. A new seam is exported here, never from `.`.
4. Leave the "private and bundled, never installed" paragraph for S2-9 (it owns the publishing wording).

Regenerate every output from the repo root with the local build (never hand-edit the generated files):

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax
bun packages/nax/bin/nax.ts generate && bun packages/nax/bin/nax.ts generate --all-packages
git status --short | head -20
```

Expected: `context.md` plus nax-agent's `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `codex.md` modified, and nothing under `packages/nax-agent/src`. If other packages' generated files change, `git diff` them: a change unrelated to this edit means the global install and the local build disagree; keep only nax-agent's and revert the rest with `git checkout -- <file>`.

- [ ] **Step 4: Commit**

```bash
git add packages/nax-agent/README.md packages/nax-agent/CHANGELOG.md .nax/mono/packages/nax-agent/context.md packages/nax-agent/CLAUDE.md packages/nax-agent/AGENTS.md packages/nax-agent/GEMINI.md packages/nax-agent/codex.md
git commit -m "docs: nax-agent README and CHANGELOG (0.1.0, unreleased); context records the curated surface"
```

---

### Task 6: Full verification and the CLI comparison

**Files:** none modified (evidence only; record numbers in the ledger).

**Interfaces:** none.

- [ ] **Step 1: Root gates**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax
bun run typecheck > "$WS/v-typecheck.txt" 2>&1; echo "typecheck $?"
bun run check:all > "$WS/v-checkall.txt" 2>&1; echo "check:all $?"
bun run build > "$WS/v-build.txt" 2>&1; echo "build $?"
git status --short | head        # expect clean: build output is ignored; no stray files
```

Expected: three zeros. `bun run build` includes nax-agent's `tsc` build (the `dist/` stays ignored).

- [ ] **Step 2: Package suites**

```bash
cd packages/nax-agent
bun run test:coverage > "$WS/v-agent-cov.txt" 2>&1; tail -15 "$WS/v-agent-cov.txt"
cd ../repo-tooling && bun run test > "$WS/v-tooling.txt" 2>&1; tail -5 "$WS/v-tooling.txt"
cd ../nax && bun run test:coverage > "$WS/v-nax-cov.txt" 2>&1; tail -15 "$WS/v-nax-cov.txt"
```

Expected: nax-agent coverage gate green (80% lines and functions, per-file baseline still empty) with unit + integration passing; repo-tooling green; nax green (pass/skip/fail as on main: 18950 pass, 7 skip, 0 fail at S2-6, plus any later main change). Record the exact numbers.

- [ ] **Step 3: nax is unchanged**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax
git diff main -- packages/nax/package.json | wc -l            # expect 0
S=/private/tmp/claude-501/-Users-williamkhoo-workspace-subrina-coder-projects-nax/394c2b09-5f9e-43ff-8e0c-3469b14bdf43/scratchpad
cd packages/nax && bun build bin/nax.ts --outdir $S/cli/after --target bun --external "@nathapp/nax-ai" --external "@anthropic-ai/sandbox-runtime" --define 'GIT_COMMIT="x"' | tail -1
$S/cli-md5.sh $S/cli/after/nax.js after
diff $S/cli-before.txt $S/cli-after.txt && echo CLI-IDENTICAL
md5 -q $S/cli/before/nax.js $S/cli/after/nax.js; wc -c $S/cli/before/nax.js $S/cli/after/nax.js
diff <(sort $S/cli/before/nax.js) <(sort $S/cli/after/nax.js) | head -20 | cut -c1-160
bun run scripts/check-bundle-externals.ts
```

Expected: `package.json` diff 0 lines; `CLI-IDENTICAL` (the five md5 rows equal the Evidence table). The bundle: if the md5 differs, the sorted diff must be empty (a line permutation from the explicit exports) or limited to comments that name the barrel; any added or removed code line is a finding to explain in a Ruling. `check-bundle-externals` exits 0.

- [ ] **Step 4: Review package**

```bash
BASE=$(git merge-base main HEAD)
/Users/williamkhoo/.claude/plugins/cache/claude-plugins-official/superpowers/6.4.1/skills/subagent-driven-development/scripts/review-package docs/superpowers/plans/2026-10-03-s2-7-curated-surface.md "$BASE" HEAD
```

Expected: it prints the package path. Do not dispatch a reviewer, delete the workspace or push: the parent session reviews.

---

## Self-review

**Spec coverage.** §5.3.1 curated lists: Task 3. §5.3.2 the 20 names to `/internal`: Task 2 (the two that were missing) and Task 3 (off `.`); the nax rewrite has 0 sites (Evidence) and typecheck proves it; the gate: Task 1 and Task 4. §5.3.3 `.` keeps the runtime slot: Task 3 test and the before/after proof. §5.3.4 snapshot with update command, tests and CI step: Tasks 1 and 4. §5.3.5 header and README: Tasks 2 and 5. First version `0.1.0` and CHANGELOG: Task 5, version untouched. §5.4/§10.5 nax unchanged: Task 6. §10.4 snapshot committed and `.` exports no `_` name: Task 4. The `./test/helpers/*` item of §10.4 was done in S2-0. No gap found.

**Placeholder scan.** No TBD or "similar to". The generator and dump scripts are given in full. 

**Type consistency.** `ApiSurface`, `ApiEntry`, `extractPackageSurface`, `extractApiSurface`, `renderSnapshot`, `diffSnapshots`, `privateNamesOnPublicEntry`, `snapshotPathFor`, `checkApiSnapshot` are defined in Task 1 and used with the same names in Tasks 3 and 4. Counts: `.` 367 before, 20 `_`, 347 after; `/internal` 515, +2 = 517.

**Review Focus.** Each of the five lines has a named test: 1 and 2 and 3 and 4 in Task 1 (plus Task 3 Step 5 for kinds), 5 in Task 2.
