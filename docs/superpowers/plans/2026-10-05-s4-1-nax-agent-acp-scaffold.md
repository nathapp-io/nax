# S4-1: `@nathapp/nax-agent-acp` scaffold — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `packages/nax-agent-acp` workspace package with its build, gates, API snapshot, coverage, CI jobs, release machinery and context files. It ships no ACP behaviour yet: S4-2 adds `acpBackend()`.

**Architecture:** The new package mirrors `packages/nax-agent`:
- The workspace manifest stays `private: true` and resolves `.ts` source.
- `tsc -p tsconfig.build.json` emits Node ESM `dist/`.
- `stage-publish` writes the `.publish/` manifest that npm ships.

Shared gates run from `packages/repo-tooling/scripts/` with `--package=.`. Two of them must learn things to cover the new package:
- The API snapshot reads entry points from `package.json` `exports` instead of hard-coding `.` and `./internal`.
- The repo-wide `check-package-boundaries` gate (default-deny) gains a nax-agent-acp rule.

R10 makes nax-agent and nax-agent-acp release in lockstep, so nax-agent's release helper bumps both packages and learns the `nax-agent-acp-v*` tag.

**Tech Stack:**
- Bun 1.4.0 workspaces with the isolated linker, TypeScript 7.0.2, Biome 2.5.10
- bun:test for unit tests, vitest 4.1.9 on real Node 22/24
- GitHub Actions, npm trusted publishing (OIDC)

**Spec:** `docs/superpowers/specs/2026-10-05-s4-acp-backend-design.md` (§4 boundary, §6.10 registry, §8 package and release, §10 S4-1 row).

## Global Constraints

- Package name `@nathapp/nax-agent-acp`, version `0.3.0`, ESM, `private: true` in the workspace (§8).
- Exports `./client` and `./server`. `./server` is an empty module with a doc comment (§8, R2).
- Dependencies: `@agentclientprotocol/sdk ~1.7.0`, `@modelcontextprotocol/sdk ^1.30.0`, `zod ^4.3.6` (§8).
- Peer dependency `@nathapp/nax-agent`: `workspace:*` in the workspace, rewritten to `^<version>` by `stage-publish` (§8). The `^0.3.0` range admits only 0.3.x (R10).
- nax-agent-acp imports only:
  - nax-agent's public entry `.`, never `./internal`
  - `@agentclientprotocol/sdk` (root only, never `/experimental`)
  - `@modelcontextprotocol/sdk`
  - `zod`
  - `node:` builtins

  (§4; §12 "no `/experimental` or v2")
- nax-agent-acp and nax-agent always share one version and are released together (R10). Release order: nax-ai → nax-agent → nax-agent-acp → nax (§8).
- Nothing is released in S4-1. No tag is pushed and nothing is published. Nothing is released before S4-6 (§10).
- `files` in the published tarball: `dist` plus documentation (`README.md`, `CHANGELOG.md`, `LICENSE`) (§8).
- Engines `node >=22.19.0`, matching nax-agent.
- No source under `src/` uses a Bun API (`check:no-bun-apis`).
- `nax` runtime is unchanged. Only `packages/nax/scripts/check-package-boundaries.ts` and its test change under `packages/nax/`.
- Never run bare `bun test` (no path) and never `bun run nax`. Package commands run from the package directory.
- Code snippets in this plan are not pre-formatted. Run `bun run lint:fix` in the package before every `check:all` or `lint` step, so Biome's formatter (120 columns) applies.
- No emojis in code, comments or docs. Edit `.nax/context.md` and `.nax/mono/packages/<pkg>/context.md` only, then regenerate. Never hand-edit `CLAUDE.md`, `AGENTS.md`, `GEMINI.md` or `codex.md`.

## Review Focus

1. **`workspace:*` leaking into the published manifest.** A consumer installing a manifest that says `workspace:*` gets an install error. The staged manifest must contain no `workspace:` string anywhere. Pinned in Task 5.
2. **Tag routing for `nax-agent-acp-v*`.** A tag routed to the wrong package publishes the wrong directory. The globs are disjoint (`nax-agent-v*` cannot match `nax-agent-acp-v...`), so arm order does not matter, but each acp tag must resolve to `packages/nax-agent-acp`, and a malformed acp tag must be rejected. Pinned in Task 7.
3. **Lockstep drift.** If nax-agent-acp's version differs from nax-agent's, the `^x.y.z` peer range points at a nax-agent that was never released with it. `stage-publish` and `release tag-acp` must both refuse. Pinned in Tasks 5 and 8.
4. **Publishing acp before its peer.** The acp release must fail when the nax-agent version it names is not on npm. This covers an E404, a registry error, and empty output. Pinned in Task 7.
5. **Registry lookups with prototype keys.** `registryEntry("__proto__")`, `registryEntry("toString")` or `registryEntry("constructor")` returning an object would make S4-2 launch an "agent" with no data. They must return `undefined`, and the table must be deeply frozen. Pinned in Task 4.

## Decisions taken in this plan (for review)

- **D-a. The registry (§6.10) is pulled forward from S4-2 into S4-1.** The coverage gate fails on a package with no measured `src/` lines ("the report measured no src/ lines"). The registry is pure data, fully specified in the spec, and S4-2 consumes it. It is not exported from `./client` (S4-2 decides the public surface together with `acpBackend()`). A placeholder module written only to satisfy the gate would be worse.
- **D-b. The boundary rule lives in the existing `packages/nax/scripts/check-package-boundaries.ts`.** That gate is default-deny: a new package with no rule fails nax's `check:all`. A second gate would duplicate its specifier scanning.
- **D-c. Bootstrap verification moves to repo-tooling.** Both packages now need it: nax-agent at 0.1.0, nax-agent-acp at 0.3.0. The repo context says gates shared by more than one package live in `packages/repo-tooling/scripts/`. The move is `scripts/verify-bootstrap.ts` plus `scripts/lib/bootstrap-artifact.ts`.
- **D-d. The staging libs stay per package.** acp's manifest differs (two entries, a peer rewrite, the lockstep check), and nax-agent's stage lib is untouched. A third publishing package would be the point to lift `missingStageInputs` and `assertPublishRepo` into repo-tooling.
- **D-e. One release helper releases both packages.** It is nax-agent's `scripts/release.ts`, following R10's "bump together". `release <kind>` bumps both versions and both changelogs in one PR, except when the new nax-agent version is still below acp's (acp then stays put). `release tag` pushes `nax-agent-v*`, as today. The new `release tag-acp` pushes `nax-agent-acp-v*` only after nax-agent at the same version is on npm.
- **D-f. Two mechanical release guards.** `stage-publish` refuses while the built `./client` is the bare scaffold, so the S4-1 package cannot ship. The acp first version (0.3.0) can only be tagged and verified after the manual publish, never uploaded through OIDC, which cannot create a package.

## Gap carried to S4-2 (not fixed here)

§5.7 says a backend throws "an `AgentSessionError` or `NaxError`", and that `ACP_STOP_*` are NaxError codes owned by nax-agent-acp. On main, `NaxError` is exported from `./internal` only (`api/nax-agent.api.txt:587`). `AgentSessionError`'s constructor types `code` as `AgentSessionErrorCode`. nax-agent-acp may import only `.`, so it cannot construct an `ACP_STOP_*` error without a cast. S4-2's plan must resolve this before the lifecycle task. One option is to export `NaxError` on `.`, which is a nax-agent 0.3.0 contract addition plus an API snapshot change. S4-1 does not touch it.

---

## File structure

**Create (package):**

| Path | Responsibility |
|---|---|
| `packages/nax-agent-acp/package.json` | workspace manifest, scripts, deps, peer |
| `packages/nax-agent-acp/tsconfig.json` | typecheck config (mirrors nax-agent) |
| `packages/nax-agent-acp/tsconfig.build.json` | nodenext emit to `dist/` |
| `packages/nax-agent-acp/bunfig.toml` | bun:test + lcov config |
| `packages/nax-agent-acp/biome.json` | lint config (copy of nax-agent's) |
| `packages/nax-agent-acp/vitest.config.ts` | Node contract suite |
| `packages/nax-agent-acp/.gitignore`, `.naxignore` | build outputs out of git and out of nax scans |
| `packages/nax-agent-acp/LICENSE`, `README.md`, `CHANGELOG.md`, `RELEASING.md` | package docs |
| `packages/nax-agent-acp/src/client/index.ts` | `./client` entry (no exports in S4-1) |
| `packages/nax-agent-acp/src/server/index.ts` | `./server` entry, reserved for S5 |
| `packages/nax-agent-acp/src/client/registry.ts` | §6.10 registry data and lookup |
| `packages/nax-agent-acp/scripts/stage-publish.ts` | writes `.publish/` |
| `packages/nax-agent-acp/scripts/lib/stage-manifest.ts` | pure staged-manifest builder |
| `packages/nax-agent-acp/scripts/baselines/*.json` | gate baselines (generated) |
| `packages/nax-agent-acp/api/nax-agent-acp.api.txt` | API snapshot (generated) |
| `packages/nax-agent-acp/test/unit/client/registry.test.ts` | registry unit tests |
| `packages/nax-agent-acp/test/unit/packaging/*.test.ts` | workspace wiring, peer build probe, stage manifest |
| `packages/nax-agent-acp/test/node/registry.test.ts` | Node contract test |
| `.nax/mono/packages/nax-agent-acp/context.md`, `config.json` | nax context source and quality commands |

**Modify:**

| Path | Change |
|---|---|
| `packages/repo-tooling/scripts/lib/api-surface.ts` | entry points from `exports` |
| `packages/repo-tooling/test/unit/scripts/api-surface.test.ts` | fixtures declare `exports`; new cases |
| `packages/nax/scripts/check-package-boundaries.ts` | nax-agent-acp rule; others may not import it |
| `packages/nax/test/unit/scripts/check-package-boundaries.test.ts` | acp cases |
| `packages/nax-agent/scripts/release.ts` | lockstep bump, `tag-acp` |
| `packages/nax-agent/test/helpers/release-cli-fixture.ts`, `test/unit/packaging/release-cli.test.ts` | acp in fixture; new cases |
| `packages/nax-agent/test/helpers/release-shell.ts`, `test/unit/packaging/release-workflow.test.ts` | manifest override; acp routing |
| `packages/nax-agent/RELEASING.md` | lockstep, moved verifier path |
| `.github/workflows/release.yml` | acp tag, routing, checks, peer step, publish arm |
| `.github/workflows/ci.yml` | `nax-agent-acp` and `nax-agent-acp-node` jobs |
| `.nax/context.md`, `.nax/mono/packages/nax-agent/context.md` | layout, direction, releases |

**Move (Task 6):**
- `packages/nax-agent/scripts/verify-bootstrap.ts` → `packages/repo-tooling/scripts/verify-bootstrap.ts`
- `packages/nax-agent/scripts/lib/bootstrap-artifact.ts` → `packages/repo-tooling/scripts/lib/bootstrap-artifact.ts`
- `packages/nax-agent/test/unit/packaging/bootstrap-{artifact,cli}.test.ts` → `packages/repo-tooling/test/unit/scripts/`

---

### Task 1: API snapshot reads entry points from `package.json` `exports`

**Files:**
- Modify: `packages/repo-tooling/scripts/lib/api-surface.ts`
- Test: `packages/repo-tooling/test/unit/scripts/api-surface.test.ts`

**Interfaces:**
- Produces:
  - `export interface ApiEntryFile { readonly entry: string; readonly dts: string }`. `dts` is relative to the built `dist/`, for example `client/index.d.ts`.
  - `export function entryPointsOf(packageDir: string): ApiEntryFile[]`, sorted by `entry` (code point).
  - `export type ApiSurface = Readonly<Record<string, readonly ApiEntry[]>>`
  - `extractApiSurface(projectDir: string, entries: readonly ApiEntryFile[]): Promise<ApiSurface>`
  - `renderSnapshot(packageName, surface)` renders sections in sorted key order.
  - `privateNamesOnPublicEntry(surface)` checks every entry except `./internal`.
  - `checkApiSnapshot` and `extractPackageSurface` keep their signatures.
- nax-agent's committed `api/nax-agent.api.txt` must stay byte-identical.

- [ ] **Step 1: Write the failing tests**

In `api-surface.test.ts`, make the fixture declare its entries. Change `writeFixture`'s `package.json` line to:

```ts
    "package.json": JSON.stringify({
      name: "@scope/fixture",
      type: "module",
      exports: { ".": "./src/index.ts", "./internal": "./src/internal.ts" },
      imports: { "#src/*": "./src/*.ts" },
    }),
```

In the `extractApiSurface` describe, the existing call becomes:

```ts
    await expect(
      extractApiSurface(root, [
        { entry: ".", dts: "index.d.ts" },
        { entry: "./internal", dts: "internal.d.ts" },
      ]),
    ).rejects.toThrow(/missing\.ts/);
```

Add `entryPointsOf` to the import list and append:

```ts
describe("entryPointsOf", () => {
  test("maps each exports key to its built declaration, sorted by entry", () => {
    const root = fixture({
      ...FIXTURE_FILES,
      "package.json": JSON.stringify({
        name: "@scope/two",
        type: "module",
        exports: { "./server": "./src/server/index.ts", "./client": "./src/client/index.ts" },
      }),
    });
    expect(entryPointsOf(root)).toEqual([
      { entry: "./client", dts: "client/index.d.ts" },
      { entry: "./server", dts: "server/index.d.ts" },
    ]);
  });

  test("rejects a package with no exports, and an exports target outside ./src/*.ts", () => {
    const none = fixture({ ...FIXTURE_FILES, "package.json": JSON.stringify({ name: "@scope/none" }) });
    expect(() => entryPointsOf(none)).toThrow(/no "exports"/);
    const bad = fixture({
      ...FIXTURE_FILES,
      "package.json": JSON.stringify({ name: "@scope/bad", exports: { ".": "./dist/index.js" } }),
    });
    expect(() => entryPointsOf(bad)).toThrow(/\.\/src\/\*\.ts/);
  });
});

describe("multi-entry packages", () => {
  const TWO: Record<string, string> = {
    "package.json": JSON.stringify({
      name: "@scope/two",
      type: "module",
      exports: { "./client": "./src/client/index.ts", "./server": "./src/server/index.ts" },
      imports: { "#src/*": "./src/*.ts" },
    }),
    "src/client/index.ts": 'export { reg } from "./reg.ts";\n',
    "src/client/reg.ts": "export const reg = 1;\nexport const _hidden = 2;\n",
    "src/server/index.ts": "/** Reserved. */\nexport {};\n",
  };

  test("an entry with no exports is an empty section, not an error", async () => {
    const root = fixture(TWO);
    expect((await checkApiSnapshot(root, { update: true })).ok).toBe(true);
    expect(readFileSync(snapshotPathFor(root), "utf8")).toContain("\n[./client]\nreg\n\n[./server]\n");
  }, 60_000);

  test("a `_` name on any entry other than ./internal fails", async () => {
    const root = fixture({ ...TWO, "src/client/index.ts": 'export * from "./reg.ts";\n' });
    const result = await checkApiSnapshot(root, { update: true });
    expect(result.ok).toBe(false);
    expect(result.messages.join("\n")).toContain('"./client" exports 1 "_" name(s): _hidden');
  }, 60_000);
});
```

Update the `privateNamesOnPublicEntry` test's second call. The behaviour is unchanged: `./internal` is still exempt.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/repo-tooling && bun test ./test/unit/scripts/api-surface.test.ts --timeout=60000`
Expected: FAIL. `entryPointsOf` is not exported, and `extractApiSurface` ignores its second argument.

- [ ] **Step 3: Implement**

In `api-surface.ts`:
- Replace `ApiEntryPoint`, `ENTRY_POINTS` and `ENTRY_FILES` with the code below.
- Thread `entries` through `writeProjectFiles` (its `files` becomes `entries.map((e) => \`dist/${e.dts}\`)`), `extractApiSurface`, `extractPackageSurface`, `renderSnapshot` and `checkApiSnapshot`.
- Export `ApiSurface` as `Readonly<Record<string, readonly ApiEntry[]>>`.

```ts
export interface ApiEntryFile {
  readonly entry: string;
  /** Path of the entry's declaration file inside the built dist/. */
  readonly dts: string;
}

const SRC_TARGET = /^\.\/src\/(.+)\.ts$/;

/** The package's entry points, read from its workspace `exports` (each `./src/<x>.ts` builds to `dist/<x>.d.ts`). */
export function entryPointsOf(packageDir: string): ApiEntryFile[] {
  const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as { exports?: unknown };
  if (typeof pkg.exports !== "object" || pkg.exports === null) {
    throw new Error(`${packageDir}/package.json has no "exports" map`);
  }
  return Object.entries(pkg.exports as Record<string, unknown>)
    .map(([entry, target]) => {
      const match = typeof target === "string" ? SRC_TARGET.exec(target) : null;
      if (match === null) throw new Error(`exports["${entry}"] must be a ./src/*.ts path, got ${JSON.stringify(target)}`);
      return { entry, dts: `${match[1]}.d.ts` };
    })
    .sort((a, b) => byCodePoint(a.entry, b.entry));
}
```

In `extractApiSurface`, loop over `entries`. A missing source file still throws `${file} is missing or exports nothing`. A present file whose module symbol is `undefined` yields `[]` (an `export {}` module):

```ts
    const out: Record<string, ApiEntry[]> = {};
    for (const { entry, dts } of entries) {
      const file = join(root, "dist", dts);
      const sourceFile = await project.program.getSourceFile(file);
      if (sourceFile === undefined) throw new Error(`${file} is missing or exports nothing`);
      const moduleSymbol = await project.checker.getSymbolAtLocation(sourceFile);
      if (moduleSymbol === undefined) {
        out[entry] = [];
        continue;
      }
      const typeOnly = new TypeOnlyExports(project);
      const list: ApiEntry[] = [];
      for (const symbol of await project.checker.getExportsOfModule(moduleSymbol)) {
        list.push({ name: symbol.name, kind: await kindOf(project.checker, typeOnly, moduleSymbol, symbol) });
      }
      out[entry] = list.sort((a, b) => byCodePoint(a.name, b.name));
    }
    return out;
```

`renderSnapshot` iterates `Object.keys(surface).sort(byCodePoint)`. `privateNamesOnPublicEntry` returns `{ entry, names }[]`, so the message can name the entry:

```ts
/** `_` names are test seams and reset hooks: they belong on `./internal`, never on a public entry. */
export function privateNamesOnPublicEntry(surface: ApiSurface): { entry: string; names: string[] }[] {
  return Object.keys(surface)
    .filter((entry) => entry !== "./internal")
    .sort(byCodePoint)
    .map((entry) => ({
      entry,
      names: (surface[entry] ?? []).filter((e) => e.name.startsWith("_")).map((e) => e.name).sort(byCodePoint),
    }))
    .filter((leak) => leak.names.length > 0);
}
```

In `checkApiSnapshot`:
- The leak message becomes ``The public entry "${l.entry}" exports ${l.names.length} "_" name(s): ${l.names.join(", ")}``, one line per leak, followed by the existing "Move them there" line.
- The `--update` message becomes ``check-api-snapshot: wrote ${path} (${Object.entries(surface).map(([e, l]) => `${l.length} on "${e}"`).join(", ")})``.

Update the existing `privateNamesOnPublicEntry` test expectations to the new shape:

```ts
    expect(privateNamesOnPublicEntry(surface)).toEqual([{ entry: ".", names: ["_seam"] }]);
    expect(
      privateNamesOnPublicEntry({ ".": [{ name: "a", kind: "value" }], "./internal": [{ name: "_x", kind: "value" }] }),
    ).toEqual([]);
```

In `diffSnapshots flipped`, build the surface with a spread: `{ ...surface, ".": ... }`.

- [ ] **Step 4: Run the tests to verify they pass, and that nax-agent's snapshot is unchanged**

Run: `cd packages/repo-tooling && bun test ./test/unit/scripts/api-surface.test.ts --timeout=60000 && bun run typecheck && bun run check:all`
Expected: PASS.

Run: `cd packages/nax-agent && bun run check:api && git diff --exit-code api/`
Expected: `check-api-snapshot: clean`, no diff.

- [ ] **Step 5: Commit**

```bash
git add packages/repo-tooling/scripts/lib/api-surface.ts packages/repo-tooling/test/unit/scripts/api-surface.test.ts
git commit -m "refactor(repo-tooling): API snapshot entry points come from package exports"
```

---

### Task 2: Boundary rule for nax-agent-acp

**Files:**
- Modify: `packages/nax/scripts/check-package-boundaries.ts`
- Test: `packages/nax/test/unit/scripts/check-package-boundaries.test.ts`

**Interfaces:**
- Produces: `RULES["@nathapp/nax-agent-acp"]`. `@nathapp/nax-agent-acp` joins `NAX_PACKAGES`, so test-kit and repo-tooling may not import it. nax, nax-agent and nax-ai may not import it either: nax does not depend on it until S4b.

- [ ] **Step 1: Write the failing tests**

Append to the test file:

```ts
describe("nax-agent-acp", () => {
  function acp(): void {
    workspace();
    write(
      "packages/nax-agent-acp/package.json",
      JSON.stringify({
        name: "@nathapp/nax-agent-acp",
        dependencies: { "@agentclientprotocol/sdk": "~1.7.0", "@modelcontextprotocol/sdk": "^1.30.0", zod: "^4" },
        peerDependencies: { "@nathapp/nax-agent": "workspace:*" },
        devDependencies: { "@nathapp/nax-agent": "workspace:*", "@nathapp/nax-test-kit": "workspace:*", vitest: "4" },
      }),
    );
    write(
      "packages/nax-agent-acp/src/client/ok.ts",
      [
        'import { AgentSessionError } from "@nathapp/nax-agent";',
        'import type { SessionBackend } from "@nathapp/nax-agent";',
        'import { ClientSideConnection } from "@agentclientprotocol/sdk";',
        'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";',
        'import { z } from "zod";',
        'import { join } from "node:path";',
        'import { r } from "#src/client/registry";',
        'import { s } from "./sibling.ts";',
        "",
      ].join("\n"),
    );
    write(
      "packages/nax-agent-acp/test/unit/ok.test.ts",
      'import { test } from "bun:test";\nimport { t } from "@nathapp/nax-test-kit/bun/temp";\nimport { c } from "@nathapp/nax-agent-acp/client";\n',
    );
    write("packages/nax-agent-acp/test/node/ok.test.ts", 'import { test } from "vitest";\n');
  }

  test("a clean acp package passes", () => {
    acp();
    expect(whys()).toEqual([]);
  });

  test("acp may reach nax-agent only through its public entry, from src/ and test/ alike", () => {
    acp();
    write(
      "packages/nax-agent-acp/src/bad.ts",
      [
        'import { _clientDeps } from "@nathapp/nax-agent/internal";',
        'import type { X } from "@nathapp/nax-agent/internal";',
        'const m = await import("@nathapp/nax-agent/internal");',
        'import { y } from "@nathapp/nax-agent/src/index.ts";',
        "",
      ].join("\n"),
    );
    write("packages/nax-agent-acp/test/unit/bad.test.ts", 'import { s } from "@nathapp/nax-agent/internal";\n');
    expect(whys()).toEqual([
      "packages/nax-agent-acp/src/bad.ts @nathapp/nax-agent/internal only @nathapp/nax-agent (never ./internal or a deep path)",
      "packages/nax-agent-acp/src/bad.ts @nathapp/nax-agent/internal only @nathapp/nax-agent (never ./internal or a deep path)",
      "packages/nax-agent-acp/src/bad.ts @nathapp/nax-agent/internal only @nathapp/nax-agent (never ./internal or a deep path)",
      "packages/nax-agent-acp/src/bad.ts @nathapp/nax-agent/src/index.ts only @nathapp/nax-agent (never ./internal or a deep path)",
      "packages/nax-agent-acp/test/unit/bad.test.ts @nathapp/nax-agent/internal only @nathapp/nax-agent (never ./internal or a deep path)",
    ]);
  });

  test("acp src/ may import only the SDK root, the MCP SDK, zod and node builtins", () => {
    acp();
    write(
      "packages/nax-agent-acp/package.json",
      JSON.stringify({
        name: "@nathapp/nax-agent-acp",
        // chalk is declared, so only the src/ allowlist can reject it; the rest matches acp() so ok.ts stays clean.
        dependencies: {
          "@agentclientprotocol/sdk": "~1.7.0",
          "@modelcontextprotocol/sdk": "^1.30.0",
          zod: "^4",
          chalk: "^5",
        },
        devDependencies: { "@nathapp/nax-agent": "workspace:*", "@nathapp/nax-test-kit": "workspace:*", vitest: "4" },
      }),
    );
    write(
      "packages/nax-agent-acp/src/bad.ts",
      [
        'import { c } from "chalk";',
        'import { e } from "@agentclientprotocol/sdk/experimental";',
        'import { v } from "vitest";',
        'import { n } from "@nathapp/nax";',
        'import { a } from "@nathapp/nax-ai";',
        'import { B } from "bun";',
        'import { p } from "../../nax-agent/src/index.ts";',
        "",
      ].join("\n"),
    );
    expect(whys()).toEqual([
      "packages/nax-agent-acp/src/bad.ts chalk nax-agent-acp src/ may import only @agentclientprotocol/sdk, @modelcontextprotocol/sdk, zod",
      "packages/nax-agent-acp/src/bad.ts @agentclientprotocol/sdk/experimental only the @agentclientprotocol/sdk root",
      "packages/nax-agent-acp/src/bad.ts vitest devDependency vitest imported outside test/",
      "packages/nax-agent-acp/src/bad.ts @nathapp/nax imports nax",
      "packages/nax-agent-acp/src/bad.ts @nathapp/nax-ai imports nax-ai (reach it through @nathapp/nax-agent)",
      "packages/nax-agent-acp/src/bad.ts bun Bun import outside test/",
      "packages/nax-agent-acp/src/bad.ts ../../nax-agent/src/index.ts relative import leaves the package",
    ]);
  });

  test("no other package may import nax-agent-acp before S4b", () => {
    acp();
    write("packages/nax/src/bad.ts", 'import { c } from "@nathapp/nax-agent-acp/client";\n');
    write("packages/nax-agent/src/bad.ts", 'import { c } from "@nathapp/nax-agent-acp/client";\n');
    write("packages/nax-ai/src/bad.ts", 'import { c } from "@nathapp/nax-agent-acp/client";\n');
    write("packages/test-kit/src/bun/bad.ts", 'import { c } from "@nathapp/nax-agent-acp/client";\n');
    // Package directories are scanned in code-point order: nax, nax-agent, nax-agent-acp, nax-ai, ..., test-kit.
    expect(whys()).toEqual([
      "packages/nax/src/bad.ts @nathapp/nax-agent-acp/client nax does not depend on nax-agent-acp until S4b",
      "packages/nax-agent/src/bad.ts @nathapp/nax-agent-acp/client nax-agent imports nax-agent-acp",
      "packages/nax-ai/src/bad.ts @nathapp/nax-agent-acp/client nax-ai imports @nathapp/nax-agent-acp",
      "packages/test-kit/src/bun/bad.ts @nathapp/nax-agent-acp/client @nathapp/nax-test-kit imports @nathapp/nax-agent-acp",
    ]);
  });
});
```

Keep the order of the expected violations consistent with the gate's scan order: packages sorted by name, then `SCAN_DIRS` order, then file order. If an assertion fails only on order, fix the expectation's order, not the gate.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/nax && bun test test/unit/scripts/check-package-boundaries.test.ts --timeout=60000`
Expected: FAIL. `assertEveryPackageEnforced` throws "no boundary rule for these packages ... @nathapp/nax-agent-acp".

- [ ] **Step 3: Implement**

Add the constants and rule in `check-package-boundaries.ts`, and extend the header comment with a bullet:

```ts
 * - packages/nax-agent-acp (S4 spec section 4) reaches nax-agent only through
 *   `@nathapp/nax-agent`, never `./internal` or a deep path, from src/ and test/
 *   alike. Its src/ imports only the ACP SDK root, the MCP SDK, zod and node:
 *   builtins. No other package imports it (nax adopts it in S4b).
```

```ts
const ACP = "@nathapp/nax-agent-acp";
const ACP_SDK = "@agentclientprotocol/sdk";
const ACP_SRC_DEPS = new Set([ACP_SDK, "@modelcontextprotocol/sdk", "zod"]);
const NAX_PACKAGES = new Set(["@nathapp/nax", AGENT, "@nathapp/nax-ai", ACP, TEST_KIT, REPO_TOOLING]);

function acpViolation(pkg: PackageInfo, file: string, spec: string): string | null {
  const inTests = inDir(pkg, file, "test");
  if ((spec === "bun" || spec.startsWith("bun:")) && !inTests) return "Bun import outside test/";
  if (isBuiltin(spec) || spec.startsWith("#src/") || spec.startsWith("#test/")) return null;
  if (spec.startsWith(".")) return leavesPackage(pkg, file, spec) ? "relative import leaves the package" : null;
  const name = packageName(spec);
  if (name === pkg.name) return null;
  if (name === AGENT) return spec === AGENT ? null : `only ${AGENT} (never ./internal or a deep path)`;
  if (name === "@nathapp/nax") return "imports nax";
  if (name === "@nathapp/nax-ai") return `imports nax-ai (reach it through ${AGENT})`;
  if (name === ACP_SDK && spec !== ACP_SDK) return `only the ${ACP_SDK} root`;
  if (pkg.devDeps.has(name) && !pkg.deps.has(name)) {
    return inTests || inDir(pkg, file, "scripts") ? null : `devDependency ${name} imported outside test/`;
  }
  if (!pkg.deps.has(name)) return `undeclared dependency ${name}`;
  if (!inTests && inDir(pkg, file, "src") && !ACP_SRC_DEPS.has(name)) {
    return `nax-agent-acp src/ may import only ${[...ACP_SRC_DEPS].join(", ")}`;
  }
  return null;
}
```

Make these changes in the other rules:
- `agentViolation`: before `if (name === AGENT || pkg.deps.has(name)) return null;`, add `if (name === ACP) return "nax-agent imports nax-agent-acp";`.
- `naxAiViolation`: return a violation for `name === "@nathapp/nax" || name === AGENT || name === ACP`. Keep the message shape `nax-ai imports ${name}`.
- `naxViolation`: after the `leavesPackage` check, add `if (packageName(spec) === ACP) return "nax does not depend on nax-agent-acp until S4b";`.
- `RULES`: add `[ACP]: acpViolation,`.

- [ ] **Step 4: Run the tests and the real gate**

Run: `cd packages/nax && bun test test/unit/scripts/check-package-boundaries.test.ts --timeout=60000 && bun run check:package-boundaries`
Expected: tests PASS. The real gate prints `[OK] package boundaries hold`, because there is no acp package on disk yet.

- [ ] **Step 5: Commit**

```bash
git add packages/nax/scripts/check-package-boundaries.ts packages/nax/test/unit/scripts/check-package-boundaries.test.ts
git commit -m "feat(tooling): package-boundary rule for nax-agent-acp"
```

---

### Task 3: Package scaffold, build and peer build probe

**Files:**
- Create: `packages/nax-agent-acp/{package.json,tsconfig.json,tsconfig.build.json,bunfig.toml,biome.json,vitest.config.ts,.gitignore,.naxignore,LICENSE,README.md,CHANGELOG.md}`
- Create: `packages/nax-agent-acp/src/client/index.ts`, `packages/nax-agent-acp/src/server/index.ts`
- Test: `packages/nax-agent-acp/test/unit/packaging/workspace-wiring.test.ts`, `packages/nax-agent-acp/test/unit/packaging/peer-build.test.ts`
- Modify: `bun.lock` (via `bun install`)

**Interfaces:**
- Produces: package scripts `typecheck`, `build`, `lint`, `check:all`, `test`, `test:node`, `test:coverage*`, `check:api`, `api:update`, `stage-publish`, `check:test-satellites*`, `check:no-bun-apis`. Later tasks rely on these names.

- [ ] **Step 1: Write the manifests and configs**

`packages/nax-agent-acp/package.json`:

```json
{
  "name": "@nathapp/nax-agent-acp",
  "version": "0.3.0",
  "private": true,
  "description": "ACP (Agent Client Protocol) backend for @nathapp/nax-agent sessions: drive Claude Code and other ACP agents through the nax-agent session API.",
  "type": "module",
  "exports": {
    "./client": "./src/client/index.ts",
    "./server": "./src/server/index.ts"
  },
  "imports": {
    "#src/*": "./src/*.ts",
    "#test/*": "./test/*.ts"
  },
  "scripts": {
    "typecheck": "bun x tsc --noEmit",
    "build": "bun x tsc -p tsconfig.build.json",
    "stage-publish": "bun scripts/stage-publish.ts",
    "check:api": "bun ../repo-tooling/scripts/check-api-snapshot.ts --package=.",
    "api:update": "bun ../repo-tooling/scripts/check-api-snapshot.ts --package=. --update",
    "lint": "bun run lint:biome && bun run lint:checks",
    "lint:biome": "bun x biome check --error-on-warnings --diagnostic-level=warn src/ test/ scripts/",
    "lint:fix": "bun x biome check --write src/ test/ scripts/",
    "check:test-satellites": "bun ../repo-tooling/scripts/check-test-satellites.ts --package=.",
    "check:test-satellites:update": "bun ../repo-tooling/scripts/check-test-satellites.ts --package=. --update-baseline",
    "check:no-bun-apis": "bun ../repo-tooling/scripts/check-no-bun-apis.ts --package=.",
    "lint:checks": "bun run check:no-bun-apis && bun ../repo-tooling/scripts/check-nax-error.ts --package=. && bun ../repo-tooling/scripts/check-file-sizes.ts --package=. && bun ../repo-tooling/scripts/check-complexity.ts --package=. && bun ../repo-tooling/scripts/check-import-cycles.ts --package=. && bun ../repo-tooling/scripts/check-test-as-unknown-as.ts --package=. && bun ../repo-tooling/scripts/check-test-escape-hatches.ts --package=. && bun run check:test-satellites && bun ../repo-tooling/scripts/check-no-control-bytes.ts",
    "test": "bun test ./test/unit/ --timeout=60000",
    "test:node": "vitest --run",
    "check:all": "bun run --silent lint",
    "test:coverage": "bun ../repo-tooling/scripts/check-coverage.ts --require-all-files",
    "test:coverage:report": "bun ../repo-tooling/scripts/check-coverage.ts --require-all-files --report",
    "test:coverage:update": "bun ../repo-tooling/scripts/check-coverage.ts --require-all-files --update-baseline",
    "test:coverage:list": "bun ../repo-tooling/scripts/check-coverage.ts --require-all-files --list"
  },
  "dependencies": {
    "@agentclientprotocol/sdk": "~1.7.0",
    "@modelcontextprotocol/sdk": "^1.30.0",
    "zod": "^4.3.6"
  },
  "peerDependencies": {
    "@nathapp/nax-agent": "workspace:*"
  },
  "devDependencies": {
    "@biomejs/biome": "2.5.10",
    "@nathapp/nax-agent": "workspace:*",
    "@nathapp/nax-test-kit": "workspace:*",
    "@types/bun": "^1.3.8",
    "@types/node": "25.2.3",
    "bun-types": "^1.3.9",
    "typescript": "7.0.2",
    "vitest": "4.1.9"
  },
  "license": "MIT",
  "author": "William Khoo",
  "homepage": "https://github.com/nathapp-io/nax/tree/main/packages/nax-agent-acp",
  "bugs": {
    "url": "https://github.com/nathapp-io/nax/issues"
  },
  "keywords": ["acp", "agent-client-protocol", "coding-agent", "claude-code", "nax"]
}
```

Notes on the manifest:
- The package never imports repo-tooling: gates run by path, so it is not a devDependency.
- `check-no-real-global-nax`, `check-permission-mode-ssot`, `check-feature-dir-ssot`, `check-package-frame-derivation`, `check-git-spawn-env`, `check-sandbox-imports` and `check-nax-ai-imports` are left out on purpose. They guard nax-agent and nax concerns this package does not have.
- The boundary rule runs in nax's `check:all` (Task 2).

`tsconfig.json`: copy `packages/nax-agent/tsconfig.json` verbatim, with `"exclude": ["node_modules", "test/tmp", "dist"]`.

`tsconfig.build.json`: copy `packages/nax-agent/tsconfig.build.json` verbatim.

`bunfig.toml`:

```toml
# Bun test configuration for nax-agent-acp (mirrors packages/nax-agent/bunfig.toml, without a preload:
# this package has no global state to isolate yet).

[test]
smol = true
root = "./test"
timeout = 5000

# Coverage, only when `--coverage` is passed (`bun run test:coverage`): lcov only, test files skipped,
# floors enforced by packages/repo-tooling/scripts/check-coverage.ts, which parses coverage/lcov.info.
coverageSkipTestFiles = true
coverageReporter = ["lcov"]
coverageDir = "coverage"
```

`biome.json`: copy `packages/nax-agent/biome.json` verbatim. Its plugin paths `../nax/biome-plugins/*.grit` resolve the same from a sibling package.

`vitest.config.ts`: copy `packages/nax-agent/vitest.config.ts` verbatim.

`.gitignore`: copy nax-agent's, which has `coverage/`, `test/tmp/`, `node_modules/`, `dist/` and `.publish/`. `.naxignore`: copy nax-agent's.

`LICENSE`: `cp packages/nax-agent/LICENSE packages/nax-agent-acp/LICENSE`.

`README.md`:

```markdown
# @nathapp/nax-agent-acp

ACP (Agent Client Protocol) backend for `@nathapp/nax-agent` sessions. It lets the
nax-agent session API (`createAgentSession`, `send()`, `answer()`, `cancel()`, `close()`)
drive external coding agents such as Claude Code over ACP.

**Status: pre-release.** The package is being built in stages (S4-1 to S4-6) and is not
published yet. `./client` gains `acpBackend()` in S4-2; `./server` is reserved for a
later ACP server.

nax-agent-acp and `@nathapp/nax-agent` share one version and are released together.
```

`CHANGELOG.md`:

```markdown
# Changelog

All notable changes to `@nathapp/nax-agent-acp` are recorded here. Versions move in
step with `@nathapp/nax-agent`.

## [Unreleased]

- Package scaffold: `./client` and `./server` entries, build, gates and release wiring.
```

`src/client/index.ts`:

```ts
/**
 * `@nathapp/nax-agent-acp/client`: the ACP backend for nax-agent sessions.
 *
 * Empty until S4-2, which adds `acpBackend()`. Nothing is released before S4-6,
 * so this partial entry is never published.
 */
export {};
```

`src/server/index.ts`:

```ts
/**
 * `@nathapp/nax-agent-acp/server`: reserved for the ACP server (S5).
 * Intentionally empty in S4.
 */
export {};
```

- [ ] **Step 2: Install and write the failing tests**

Run: `bun install` (repo root).
Expected: `bun.lock` gains `@agentclientprotocol/sdk` and the workspace entry. If bun rejects `workspace:*` under `peerDependencies`, stop and report; do not change the peer's form without approval, since §8 prescribes it.

`test/unit/packaging/workspace-wiring.test.ts`:

```ts
/**
 * The workspace links nax-agent as this package's peer, so tests and (from S4-2)
 * src/ resolve `@nathapp/nax-agent` to the workspace source, not a registry copy.
 */
import { describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AgentSessionError } from "@nathapp/nax-agent";

describe("workspace wiring", () => {
  test("@nathapp/nax-agent resolves to the workspace package's public entry", () => {
    const resolved = realpathSync(fileURLToPath(import.meta.resolve("@nathapp/nax-agent")));
    expect(resolved.endsWith("/packages/nax-agent/src/index.ts")).toBe(true);
  });

  test("the public entry carries AgentSessionError", () => {
    const error = new AgentSessionError("closed", "AGENT_SESSION_CLOSED");
    expect(error.code).toBe("AGENT_SESSION_CLOSED");
  });
});
```

`test/unit/packaging/peer-build.test.ts` proves S4-2's build path now. A source file importing the peer must build under this package's `tsconfig.build.json` without emitting nax-agent's sources or hitting a `rootDir` error.

```ts
/**
 * The published build against the peer (S4 spec §8): a src/ file importing
 * `@nathapp/nax-agent` compiles with tsconfig.build.json, keeps the bare
 * specifier in its emit, and emits none of nax-agent's own files.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const PKG = resolve(import.meta.dir, "../../..");
const TMP = join(PKG, "test/tmp/peer-build");

afterEach(() => rmSync(TMP, { recursive: true, force: true }));

test("a source file importing the peer builds and emits only itself", () => {
  mkdirSync(join(TMP, "src"), { recursive: true });
  writeFileSync(
    join(TMP, "src/probe.ts"),
    [
      'import { AgentSessionError } from "@nathapp/nax-agent";',
      'export const make = (): AgentSessionError => new AgentSessionError("m", "AGENT_SESSION_CLOSED");',
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(TMP, "tsconfig.json"),
    JSON.stringify({
      extends: "../../../tsconfig.build.json",
      compilerOptions: { rootDir: "src", outDir: "out" },
      include: ["src/**/*.ts"],
      // The base config's exclude ("test", resolved against the base's directory) covers this probe; reset it.
      exclude: [],
    }),
  );
  const proc = Bun.spawnSync(["bun", "x", "tsc", "-p", join(TMP, "tsconfig.json")], { cwd: PKG });
  expect(proc.stdout.toString() + proc.stderr.toString()).toBe("");
  expect(proc.exitCode).toBe(0);
  expect(readdirSync(join(TMP, "out")).sort()).toEqual(["probe.d.ts", "probe.js"]);
  expect(readFileSync(join(TMP, "out/probe.js"), "utf8")).toContain('from "@nathapp/nax-agent"');
});
```

- [ ] **Step 3: Run the tests**

Run: `cd packages/nax-agent-acp && bun test ./test/unit/packaging/ --timeout=60000`
Expected: PASS. TypeScript treats the peer's `.ts` source, reached through the `node_modules` symlink, as an external library: it type-checks it but neither emits it nor applies `rootDir` to it.

If `peer-build.test.ts` fails (TS6059, or nax-agent files emitted), STOP and report the output. Do not improvise a fix. A `paths` mapping to `../nax-agent/dist/index.d.ts` is NOT a ready fallback: nax-agent's built declarations keep `#src/...` specifiers, which resolve back to its `.ts` source. S4-2 cannot build without this path working, so the fix is a design decision for the maintainer.

- [ ] **Step 4: Build, typecheck, lint, and create baselines**

Run from `packages/nax-agent-acp`:
```bash
bun run typecheck
bun run build && ls dist/client dist/server
bun ../repo-tooling/scripts/check-nax-error.ts --package=. --update-baseline
bun ../repo-tooling/scripts/check-file-sizes.ts --package=. --update-baseline
# check-complexity refuses to create a missing baseline with --update-baseline (it only lowers one).
bun ../repo-tooling/scripts/check-complexity.ts --package=. --init-baseline
bun ../repo-tooling/scripts/check-import-cycles.ts --package=. --update-baseline
bun ../repo-tooling/scripts/check-test-as-unknown-as.ts --package=. --update-baseline
bun ../repo-tooling/scripts/check-test-escape-hatches.ts --package=. --update-baseline
bun run check:test-satellites:update
bun run lint:fix
bun run check:all
```
Expected:
- `dist/client/index.{js,d.ts}` and `dist/server/index.{js,d.ts}` exist.
- Every baseline under `scripts/baselines/` is empty-shaped: count 0, `byFile` `{}`. A non-empty baseline means a real violation; fix it, never commit it.
- `check:all` exits 0.

Run from the repo root: `cd packages/nax && bun run check:package-boundaries`
Expected: `[OK] package boundaries hold` (the acp package is now on disk).

Run from the repo root: `bun install --frozen-lockfile`
Expected: exit 0, no lockfile change. This is what CI runs, and it proves the `workspace:*` peer plus devDependency resolve under the isolated linker.

- [ ] **Step 5: Commit**

```bash
git add packages/nax-agent-acp bun.lock
git commit -m "feat(nax-agent-acp): package scaffold, build and gates"
```

---

### Task 4: Agent registry (§6.10), coverage, API snapshot, Node contract

**Files:**
- Create: `packages/nax-agent-acp/src/client/registry.ts`
- Test: `packages/nax-agent-acp/test/unit/client/registry.test.ts`, `packages/nax-agent-acp/test/node/registry.test.ts`
- Create (generated): `packages/nax-agent-acp/api/nax-agent-acp.api.txt`, `packages/nax-agent-acp/scripts/baselines/coverage-per-file-baseline.json`

**Interfaces:**
- Produces (internal to the package, NOT exported from `./client`; S4-2's `launch.ts`, `capabilities.ts` and `backend.ts` consume them):

```ts
export type AcpAgentName = "claude" | "codex" | "gemini" | "opencode" | "pi";
export interface LaunchCandidate { readonly command: string; readonly args: readonly string[] }
export interface ModeSetting { readonly configId: string; readonly value: string }
export interface AgentRegistryEntry {
  readonly name: AcpAgentName;
  readonly launch: readonly LaunchCandidate[];
  readonly readOnlyMode: ModeSetting | undefined;
  readonly defaultMode: ModeSetting | undefined;
  readonly preApproval: "claudeCode.allowedTools" | undefined;
  readonly authEnv: readonly string[];
}
export const ACP_AGENT_NAMES: readonly AcpAgentName[];
export function isAcpAgentName(name: string): name is AcpAgentName;
export function registryEntry(name: string): AgentRegistryEntry | undefined;
```

- [ ] **Step 1: Write the failing unit test**

`test/unit/client/registry.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { ACP_AGENT_NAMES, isAcpAgentName, registryEntry } from "#src/client/registry";

describe("ACP agent registry (S4 spec §6.10)", () => {
  test("registers exactly the five agents", () => {
    expect([...ACP_AGENT_NAMES]).toEqual(["claude", "codex", "gemini", "opencode", "pi"]);
  });

  test("claude: local adapter first, pinned npx fallback, plan/default modes, pre-approval, auth env", () => {
    expect(registryEntry("claude")).toEqual({
      name: "claude",
      launch: [
        { command: "claude-agent-acp", args: [] },
        { command: "npx", args: ["-y", "@agentclientprotocol/claude-agent-acp@~0.85.1"] },
      ],
      readOnlyMode: { configId: "mode", value: "plan" },
      defaultMode: { configId: "mode", value: "default" },
      preApproval: "claudeCode.allowedTools",
      authEnv: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
    });
  });

  test.each([
    [
      "codex",
      [
        { command: "codex-acp", args: [] },
        { command: "npx", args: ["-y", "@agentclientprotocol/codex-acp@~2.1.1"] },
      ],
      ["OPENAI_API_KEY"],
    ],
    ["gemini", [{ command: "gemini", args: ["--acp"] }], ["GEMINI_API_KEY"]],
    ["opencode", [{ command: "opencode", args: ["acp"] }], []],
    [
      "pi",
      [
        { command: "pi-acp", args: [] },
        { command: "npx", args: ["-y", "pi-acp@0.0.34"] },
      ],
      [],
    ],
  ])("%s: launch candidates and auth env; no read-only mode, no pre-approval", (name, launch, authEnv) => {
    expect(registryEntry(name)).toEqual({
      name,
      launch,
      readOnlyMode: undefined,
      defaultMode: undefined,
      preApproval: undefined,
      authEnv,
    });
  });

  test("pi's npx fallback pins an exact version (a tilde does not pin 0.0.x)", () => {
    expect(registryEntry("pi")?.launch.at(-1)?.args.at(-1)).toBe("pi-acp@0.0.34");
  });

  test.each(["__proto__", "toString", "constructor", "hasOwnProperty", "Claude", "", "custom"])(
    "an unregistered or prototype name %j has no entry",
    (name) => {
      expect(registryEntry(name)).toBeUndefined();
      expect(isAcpAgentName(name)).toBe(false);
    },
  );

  test("entries are deeply frozen", () => {
    const entry = registryEntry("claude");
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry?.launch)).toBe(true);
    expect(Object.isFrozen(entry?.launch[1]?.args)).toBe(true);
    expect(Object.isFrozen(entry?.readOnlyMode)).toBe(true);
    expect(Object.isFrozen(entry?.authEnv)).toBe(true);
    expect(Object.isFrozen(ACP_AGENT_NAMES)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/nax-agent-acp && bun test ./test/unit/client/registry.test.ts`
Expected: FAIL, "Cannot find module '#src/client/registry'".

- [ ] **Step 3: Implement**

`src/client/registry.ts`:

```ts
/**
 * Launch and policy data per registered ACP agent (S4 spec §6.10).
 *
 * The capability record built from `initialize` is authoritative at runtime and
 * only narrows what this table allows. Versions are bumped deliberately. Custom
 * agents (`{ name, command }`) have no entry: no mode ids, no pre-approval and no
 * auth variables, so their requirements fail closed.
 */

export type AcpAgentName = "claude" | "codex" | "gemini" | "opencode" | "pi";

export interface LaunchCandidate {
  readonly command: string;
  readonly args: readonly string[];
}

/** A session config option and the value that selects a mode (Claude: option `mode`). */
export interface ModeSetting {
  readonly configId: string;
  readonly value: string;
}

export interface AgentRegistryEntry {
  readonly name: AcpAgentName;
  /** Tried in order; the first command found wins (S4-2 launch). */
  readonly launch: readonly LaunchCandidate[];
  /** Mode for profiles `none` and `read`; undefined means those profiles are unsupported (§6.4). */
  readonly readOnlyMode: ModeSetting | undefined;
  /** Mode for profiles `ask` and `full`; undefined means the agent's own default is kept. */
  readonly defaultMode: ModeSetting | undefined;
  /** How embedder tools are pre-approved at the adapter (R12); undefined means tools are unsupported. */
  readonly preApproval: "claudeCode.allowedTools" | undefined;
  /** Variables passed through the env allowlist so the adapter can authenticate itself (§6.2). */
  readonly authEnv: readonly string[];
}

const local = (command: string, ...args: string[]): LaunchCandidate => ({ command, args });
const npx = (spec: string): LaunchCandidate => ({ command: "npx", args: ["-y", spec] });

function entry(
  name: AcpAgentName,
  launch: LaunchCandidate[],
  authEnv: string[],
  claude?: Pick<AgentRegistryEntry, "readOnlyMode" | "defaultMode" | "preApproval">,
): AgentRegistryEntry {
  return Object.freeze({
    name,
    launch: Object.freeze(launch.map((c) => Object.freeze({ command: c.command, args: Object.freeze([...c.args]) }))),
    readOnlyMode: claude?.readOnlyMode === undefined ? undefined : Object.freeze({ ...claude.readOnlyMode }),
    defaultMode: claude?.defaultMode === undefined ? undefined : Object.freeze({ ...claude.defaultMode }),
    preApproval: claude?.preApproval,
    authEnv: Object.freeze([...authEnv]),
  });
}

const REGISTRY: ReadonlyMap<AcpAgentName, AgentRegistryEntry> = new Map([
  [
    "claude",
    entry(
      "claude",
      [local("claude-agent-acp"), npx("@agentclientprotocol/claude-agent-acp@~0.85.1")],
      ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
      {
        readOnlyMode: { configId: "mode", value: "plan" },
        defaultMode: { configId: "mode", value: "default" },
        preApproval: "claudeCode.allowedTools",
      },
    ),
  ],
  ["codex", entry("codex", [local("codex-acp"), npx("@agentclientprotocol/codex-acp@~2.1.1")], ["OPENAI_API_KEY"])],
  ["gemini", entry("gemini", [local("gemini", "--acp")], ["GEMINI_API_KEY"])],
  ["opencode", entry("opencode", [local("opencode", "acp")], [])],
  // Exact pin: a tilde range does not pin 0.0.x.
  ["pi", entry("pi", [local("pi-acp"), npx("pi-acp@0.0.34")], [])],
]);

export const ACP_AGENT_NAMES: readonly AcpAgentName[] = Object.freeze([...REGISTRY.keys()]);

export function isAcpAgentName(name: string): name is AcpAgentName {
  return (ACP_AGENT_NAMES as readonly string[]).includes(name);
}

/** The registry entry for a registered agent name; undefined for anything else (custom agents included). */
export function registryEntry(name: string): AgentRegistryEntry | undefined {
  return isAcpAgentName(name) ? REGISTRY.get(name) : undefined;
}
```

A `Map` keyed by name rather than an object literal means prototype keys can never resolve.

- [ ] **Step 4: Run the unit test, then the Node contract test**

Run: `cd packages/nax-agent-acp && bun test ./test/unit/client/registry.test.ts`
Expected: PASS.

Create `test/node/registry.test.ts`:

```ts
/** The registry on real Node (the runtime the package ships to). */
import { expect, test } from "vitest";
import { ACP_AGENT_NAMES, registryEntry } from "#src/client/registry";

test("the contract suite runs on Node, not Bun", () => {
  expect(process.versions.bun).toBeUndefined();
});

test("the registry loads and answers on Node", () => {
  expect(ACP_AGENT_NAMES).toHaveLength(5);
  expect(registryEntry("claude")?.preApproval).toBe("claudeCode.allowedTools");
});
```

Run: `cd packages/nax-agent-acp && bun run test:node`
Expected: 2 tests PASS.

- [ ] **Step 5: Coverage and API snapshot**

Run from `packages/nax-agent-acp`:
```bash
bun run test:coverage:update
bun run test:coverage
bun run api:update
bun run check:api
cat api/nax-agent-acp.api.txt
```
Expected:
- `coverage-per-file-baseline.json` has `"byFile": {}`. The registry is fully covered; a non-empty `byFile` means a test is missing.
- The snapshot is:

```
# @nathapp/nax-agent-acp public API. Generated by `bun run api:update`; do not edit by hand.
# One line per exported name, sorted by code point. `type ` marks a name with no runtime value.

[./client]

[./server]
```

- `check:api` prints `check-api-snapshot: clean`.

Run: `bun run check:all`
Expected: exit 0.

- [ ] **Step 6: Record D-a in the spec**

In `docs/superpowers/specs/2026-10-05-s4-acp-backend-design.md` §10, edit two rows so the S4-2 plan does not rebuild the registry:
- S4-1 row: append `, and the agent registry data (§6.10, \`src/client/registry.ts\`, not exported)`.
- S4-2 row: replace `` `launch`, `registry`, `connection` `` with `` `launch` (on the S4-1 registry), `connection` ``.

- [ ] **Step 7: Commit**

```bash
git add packages/nax-agent-acp docs/superpowers/specs/2026-10-05-s4-acp-backend-design.md
git commit -m "feat(nax-agent-acp): agent registry (S4 spec 6.10), coverage, API snapshot, Node contract"
```

---

### Task 5: `stage-publish` and the lockstep peer range

**Files:**
- Create: `packages/nax-agent-acp/scripts/lib/stage-manifest.ts`, `packages/nax-agent-acp/scripts/stage-publish.ts`
- Test: `packages/nax-agent-acp/test/unit/packaging/stage-manifest.test.ts`, `packages/nax-agent-acp/test/unit/packaging/release-metadata.test.ts`

**Interfaces:**
- Produces:
  - `STAGE_INPUTS`
  - `missingStageInputs(pkgDir: string): string[]`
  - `assertPublishRepo(githubRepository: string | undefined): void`
  - `peerRangeFor(naxAgentVersion: string, ownVersion: string): string`
  - `buildStagedManifest(source, { repository, directory, naxAgentVersion }): Record<string, unknown>`
- `.publish/package.json` carries `peerDependencies["@nathapp/nax-agent"]` = `^<version>`. Task 7's release step reads it.

- [ ] **Step 1: Write the failing tests**

`test/unit/packaging/stage-manifest.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import {
  assertClientNotEmpty,
  assertPublishRepo,
  buildStagedManifest,
  missingStageInputs,
  peerRangeFor,
  STAGE_INPUTS,
  // biome-ignore lint/style/noRestrictedImports: the staging lib is a script, not part of the package's importable surface; tests reach it by path
} from "../../../scripts/lib/stage-manifest.ts";

const source = {
  name: "@nathapp/nax-agent-acp",
  version: "0.3.0",
  private: true,
  description: "ACP backend.",
  license: "MIT",
  author: "William Khoo",
  homepage: "https://github.com/nathapp-io/nax/tree/main/packages/nax-agent-acp",
  bugs: { url: "https://github.com/nathapp-io/nax/issues" },
  keywords: ["acp"],
  type: "module",
  exports: { "./client": "./src/client/index.ts", "./server": "./src/server/index.ts" },
  scripts: { build: "tsc" },
  dependencies: { "@agentclientprotocol/sdk": "~1.7.0", "@modelcontextprotocol/sdk": "^1.30.0", zod: "^4.3.6" },
  peerDependencies: { "@nathapp/nax-agent": "workspace:*" },
  devDependencies: { "@nathapp/nax-agent": "workspace:*", typescript: "7.0.2" },
};
const opts = {
  repository: "git+https://github.com/nathapp-io/nax.git",
  directory: "packages/nax-agent-acp",
  naxAgentVersion: "0.3.0",
};

describe("peerRangeFor", () => {
  test("caret on the shared version", () => {
    expect(peerRangeFor("0.3.0", "0.3.0")).toBe("^0.3.0");
    expect(peerRangeFor("0.3.1-canary.2", "0.3.1-canary.2")).toBe("^0.3.1-canary.2");
  });

  test.each([
    ["0.2.0", "0.3.0"],
    ["0.3.1", "0.3.0"],
    ["0.3.0", "0.3.0-canary.1"],
  ])("refuses nax-agent %s next to nax-agent-acp %s (R10 lockstep)", (agent, own) => {
    expect(() => peerRangeFor(agent, own)).toThrow(/lockstep/);
  });
});

describe("buildStagedManifest", () => {
  const staged = buildStagedManifest(source, opts);

  test("points both entries at dist and rewrites the peer to the caret range", () => {
    expect(staged.exports).toEqual({
      "./client": { types: "./dist/client/index.d.ts", import: "./dist/client/index.js" },
      "./server": { types: "./dist/server/index.d.ts", import: "./dist/server/index.js" },
    });
    expect(staged.peerDependencies).toEqual({ "@nathapp/nax-agent": "^0.3.0" });
    expect(staged.dependencies).toEqual(source.dependencies);
    expect(staged.engines).toEqual({ node: ">=22.19.0" });
    expect(staged.repository).toEqual({ type: "git", url: opts.repository, directory: opts.directory });
    expect(staged.publishConfig).toEqual({
      access: "public",
      registry: "https://registry.npmjs.org/",
      provenance: true,
      tag: "latest",
    });
  });

  test("drops workspace-only fields, and no workspace: protocol survives anywhere", () => {
    for (const key of ["private", "scripts", "devDependencies"]) expect(staged).not.toHaveProperty(key);
    expect(JSON.stringify(staged)).not.toContain("workspace:");
  });

  test("a workspace: protocol in dependencies is refused rather than shipped", () => {
    const leaky = { ...source, dependencies: { ...source.dependencies, "@nathapp/nax-agent": "workspace:*" } };
    expect(() => buildStagedManifest(leaky, opts)).toThrow(/workspace:/);
  });
});

describe("assertClientNotEmpty", () => {
  test("refuses the bare scaffold entry and accepts an entry that exports something", () => {
    expect(() => assertClientNotEmpty("export {};\n")).toThrow(/not releasable before S4 acceptance/);
    expect(() => assertClientNotEmpty("export declare function acpBackend(): unknown;\n")).not.toThrow();
  });
});

describe("staging inputs and repository", () => {
  test("lists both entries' JS and declarations plus the docs, and every emitted module", () => {
    const dir = makeTempDir("acp-stage-");
    try {
      expect(missingStageInputs(dir)).toEqual([...STAGE_INPUTS]);
      mkdirSync(join(dir, "src/client"), { recursive: true });
      writeFileSync(join(dir, "src/client/registry.ts"), "export {};\n");
      expect(missingStageInputs(dir)).toContain(join("dist", "client", "registry.js"));
    } finally {
      cleanupTempDir(dir);
    }
  });

  test("refuses to stage from a fork; allows local runs", () => {
    expect(() => assertPublishRepo("someone/nax")).toThrow(/nathapp-io\/nax/);
    expect(() => assertPublishRepo(undefined)).not.toThrow();
    expect(() => assertPublishRepo("nathapp-io/nax")).not.toThrow();
  });
});
```

`test/unit/packaging/release-metadata.test.ts`:

```ts
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
// biome-ignore lint/style/noRestrictedImports: release staging is a script, outside the package source surface
import { buildStagedManifest } from "../../../scripts/lib/stage-manifest.ts";

test("the real manifest stages with a caret peer on its own version and keeps workspace exports on source", () => {
  const source = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
  expect(source.private).toBe(true);
  expect(source.exports).toEqual({ "./client": "./src/client/index.ts", "./server": "./src/server/index.ts" });
  expect(source.peerDependencies).toEqual({ "@nathapp/nax-agent": "workspace:*" });
  expect(Object.keys(source.dependencies).sort()).toEqual(["@agentclientprotocol/sdk", "@modelcontextprotocol/sdk", "zod"]);
  const staged = buildStagedManifest(source, {
    repository: "git+https://github.com/nathapp-io/nax.git",
    directory: "packages/nax-agent-acp",
    naxAgentVersion: source.version,
  });
  expect(staged.version).toBe(source.version);
  expect(staged.peerDependencies).toEqual({ "@nathapp/nax-agent": `^${source.version}` });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/nax-agent-acp && bun test ./test/unit/packaging/ --timeout=60000`
Expected: FAIL, "Cannot find module ../../../scripts/lib/stage-manifest.ts".

- [ ] **Step 3: Implement**

`scripts/lib/stage-manifest.ts`:

```ts
/**
 * The generated manifest and staging inputs for `bun run stage-publish` (S4 spec §8).
 * Pure so the unit tests can pin it. nax-agent's own staging lib has the same shape;
 * a third publishing package is the point to lift the shared parts into repo-tooling.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const STAGE_INPUTS = [
  "dist/client/index.js",
  "dist/client/index.d.ts",
  "dist/server/index.js",
  "dist/server/index.d.ts",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
] as const;

export function missingStageInputs(pkgDir: string): string[] {
  const src = join(pkgDir, "src");
  const emitted = existsSync(src)
    ? readdirSync(src, { recursive: true, encoding: "utf8" })
        .filter((rel) => rel.endsWith(".ts") && !rel.endsWith(".d.ts") && statSync(join(src, rel)).isFile())
        .flatMap((rel) => [join("dist", rel.replace(/\.ts$/, ".js")), join("dist", rel.replace(/\.ts$/, ".d.ts"))])
    : [];
  return [...new Set([...STAGE_INPUTS, ...emitted])].filter(
    (rel) => !existsSync(join(pkgDir, rel)) || !statSync(join(pkgDir, rel)).isFile(),
  );
}

export function assertPublishRepo(githubRepository: string | undefined): void {
  if (githubRepository !== undefined && githubRepository !== "nathapp-io/nax") {
    throw new Error(`stage-publish: refusing to stage from ${githubRepository}; provenance requires nathapp-io/nax`);
  }
}

/**
 * Nothing is released before S4 acceptance (spec §10). Until S4-2 adds `acpBackend()`,
 * the built client entry is the bare `export {};` and staging refuses it. The maintainer's
 * S4-6 approval stays the real gate for S4-2 to S4-5.
 */
export function assertClientNotEmpty(clientDts: string): void {
  if (clientDts.trim() === "export {};") {
    throw new Error("stage-publish: ./client exports nothing yet; nax-agent-acp is not releasable before S4 acceptance");
  }
}

/** R10: both packages share one version, so the peer range is a caret on it. */
export function peerRangeFor(naxAgentVersion: string, ownVersion: string): string {
  if (naxAgentVersion !== ownVersion) {
    throw new Error(
      `stage-publish: nax-agent ${naxAgentVersion} and nax-agent-acp ${ownVersion} must share one version (R10 lockstep)`,
    );
  }
  return `^${ownVersion}`;
}

type Json = Record<string, unknown>;

export interface StageManifestOptions {
  readonly repository: string;
  readonly directory: string;
  readonly naxAgentVersion: string;
}

const entry = (name: string) => ({ types: `./dist/${name}/index.d.ts`, import: `./dist/${name}/index.js` });

export function buildStagedManifest(source: Json, opts: StageManifestOptions): Json {
  const dependencies = (source.dependencies ?? {}) as Record<string, string>;
  const leaked = Object.entries(dependencies).filter(([, range]) => range.startsWith("workspace:"));
  if (leaked.length > 0) {
    throw new Error(`stage-publish: workspace: dependencies cannot ship: ${leaked.map(([name]) => name).join(", ")}`);
  }
  return {
    name: source.name,
    version: source.version,
    description: source.description,
    license: source.license,
    author: source.author,
    homepage: source.homepage,
    bugs: source.bugs,
    keywords: source.keywords,
    repository: { type: "git", url: opts.repository, directory: opts.directory },
    type: "module",
    exports: { "./client": entry("client"), "./server": entry("server") },
    imports: { "#src/*": { types: "./dist/*.d.ts", default: "./dist/*.js" } },
    engines: { node: ">=22.19.0" },
    dependencies,
    peerDependencies: { "@nathapp/nax-agent": peerRangeFor(opts.naxAgentVersion, String(source.version)) },
    publishConfig: {
      access: "public",
      registry: "https://registry.npmjs.org/",
      provenance: true,
      tag: "latest",
    },
  };
}
```

`scripts/stage-publish.ts`:

```ts
#!/usr/bin/env bun
/**
 * Builds `.publish/`, the exact directory `npm publish` ships (S4 spec §8).
 * The workspace manifest points at `.ts` sources and a `workspace:*` peer, so the
 * published manifest is generated here, with the peer range taken from nax-agent.
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  assertClientNotEmpty,
  assertPublishRepo,
  buildStagedManifest,
  missingStageInputs,
} from "./lib/stage-manifest.ts";

const PKG = resolve(import.meta.dir, "..");
const OUT = join(PKG, ".publish");
const REPOSITORY = "git+https://github.com/nathapp-io/nax.git";
const DIRECTORY = "packages/nax-agent-acp";

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function main(): void {
  const missing = missingStageInputs(PKG);
  if (missing.length > 0) {
    throw new Error(`stage-publish: missing ${missing.join(", ")}; run \`bun run build\` first`);
  }
  assertPublishRepo(process.env.GITHUB_REPOSITORY);
  const source = readJson(join(PKG, "package.json"));
  assertClientNotEmpty(readFileSync(join(PKG, "dist/client/index.d.ts"), "utf8"));
  const naxAgentVersion = String(readJson(join(PKG, "../nax-agent/package.json")).version);
  const manifest = buildStagedManifest(source, { repository: REPOSITORY, directory: DIRECTORY, naxAgentVersion });
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  cpSync(join(PKG, "dist"), join(OUT, "dist"), { recursive: true });
  for (const file of ["README.md", "CHANGELOG.md", "LICENSE"]) cpSync(join(PKG, file), join(OUT, file));
  writeFileSync(join(OUT, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`staged ${OUT}`);
}

main();
```

The manifest is built before `.publish/` is cleared, so a lockstep failure leaves nothing half-staged.

The staged manifest has no `files` field, as nax-agent's has none: `.publish/` itself holds only `dist/`, the three docs and `package.json`, which satisfies §8's "files: dist and docs".

- [ ] **Step 4: Run the tests, then stage for real**

Run: `cd packages/nax-agent-acp && bun test ./test/unit/packaging/ --timeout=60000`
Expected: PASS.

Run: `cd packages/nax-agent-acp && bun run build && bun run stage-publish`
Expected: FAIL with "./client exports nothing yet; nax-agent-acp is not releasable before S4 acceptance". This is the intended guard; after S4-2 the next guard in line is the lockstep check, which fails while main's nax-agent is still 0.2.0. The real stage succeeds only after S4 acceptance and the joint release PR. Confirm `.publish/` was not created: `test ! -e .publish`.

Run: `bun run check:all && bun run test:coverage`
Expected: exit 0. Scripts are outside `src/`, so coverage is unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/nax-agent-acp
git commit -m "feat(nax-agent-acp): stage-publish with the lockstep peer range"
```

---

### Task 6: Move bootstrap verification to repo-tooling

**Files:**
- Move: `packages/nax-agent/scripts/lib/bootstrap-artifact.ts` → `packages/repo-tooling/scripts/lib/bootstrap-artifact.ts` (content unchanged)
- Move + modify: `packages/nax-agent/scripts/verify-bootstrap.ts` → `packages/repo-tooling/scripts/verify-bootstrap.ts`
- Move: `packages/nax-agent/test/unit/packaging/bootstrap-artifact.test.ts` → `packages/repo-tooling/test/unit/scripts/bootstrap-artifact.test.ts`
- Move + rewrite: `packages/nax-agent/test/unit/packaging/bootstrap-cli.test.ts` → `packages/repo-tooling/test/unit/scripts/verify-bootstrap.test.ts`
- Modify: `.github/workflows/release.yml` (one line), `packages/nax-agent/test/unit/packaging/release-workflow.test.ts`, `packages/nax-agent/RELEASING.md`

**Interfaces:**
- Produces the CLI `bun ../repo-tooling/scripts/verify-bootstrap.ts --package=<dir> --version=<x.y.z>`. It packs `<name>@<version>` from npm, where `<name>` comes from `<dir>/package.json`, and compares the result to `<dir>/.publish`. Task 7 calls it for both packages.

- [ ] **Step 1: Move the files and write the failing CLI test**

```bash
git mv packages/nax-agent/scripts/lib/bootstrap-artifact.ts packages/repo-tooling/scripts/lib/bootstrap-artifact.ts
git mv packages/nax-agent/scripts/verify-bootstrap.ts packages/repo-tooling/scripts/verify-bootstrap.ts
git mv packages/nax-agent/test/unit/packaging/bootstrap-artifact.test.ts packages/repo-tooling/test/unit/scripts/bootstrap-artifact.test.ts
git mv packages/nax-agent/test/unit/packaging/bootstrap-cli.test.ts packages/repo-tooling/test/unit/scripts/verify-bootstrap.test.ts
```

In `bootstrap-artifact.test.ts`, replace the two helper imports with:

```ts
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { assertBootstrapArtifact } from "#scripts/lib/bootstrap-artifact";
```

and delete the `biome-ignore` comment.

Replace the body of `verify-bootstrap.test.ts`:

```ts
import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";

const SCRIPT = join(import.meta.dir, "../../../scripts/verify-bootstrap.ts");

test("verify-bootstrap packs <name>@<version>, compares the payload, and cleans up on success or failure", () => {
  const dir = makeTempDir("verify-bootstrap-");
  try {
    const pkgDir = join(dir, "pkg");
    mkdirSync(pkgDir);
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "@nathapp/nax-agent-acp", version: "0.3.0" }));
    const registryPkg = join(dir, "registry/package");
    mkdirSync(registryPkg, { recursive: true });
    writeFileSync(join(registryPkg, "package.json"), JSON.stringify({ publishConfig: { provenance: false } }));
    writeFileSync(join(registryPkg, "index.js"), "export const answer = 42;");
    cpSync(registryPkg, join(pkgDir, ".publish"), { recursive: true });
    execFileSync("tar", ["-czf", join(dir, "registry.tgz"), "-C", join(dir, "registry"), "package"]);
    mkdirSync(join(dir, "bin"));
    writeFileSync(
      join(dir, "bin/npm"),
      `#!/bin/sh
echo "$*" > "$CALL_LOG"
if [ "$NPM_FAIL" = "1" ]; then exit 1; fi
cp "$REGISTRY_TARBALL" ./registry.tgz
echo '[{"filename":"registry.tgz"}]'
`,
    );
    chmodSync(join(dir, "bin/npm"), 0o755);
    const tmp = join(dir, "tmp");
    mkdirSync(tmp);
    const run = (args: string[], env: Record<string, string> = {}) =>
      spawnSync(process.execPath, [SCRIPT, ...args], {
        cwd: pkgDir,
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env,
          TMPDIR: tmp,
          PATH: `${join(dir, "bin")}:${process.env.PATH}`,
          CALL_LOG: join(dir, "calls"),
          REGISTRY_TARBALL: join(dir, "registry.tgz"),
          ...env,
        },
      });
    const ok = run(["--package=.", "--version=0.3.0"]);
    expect(ok.stderr).toBe("");
    expect(ok.status).toBe(0);
    expect(readFileSync(join(dir, "calls"), "utf8")).toBe("pack @nathapp/nax-agent-acp@0.3.0 --json --ignore-scripts\n");
    expect(run(["--package=."]).status).not.toBe(0);
    expect(run(["--package=.", "--version=0.3"]).status).not.toBe(0);
    writeFileSync(join(pkgDir, ".publish/index.js"), "wrong");
    expect(run(["--package=.", "--version=0.3.0"]).status).not.toBe(0);
    expect(run(["--package=.", "--version=0.3.0"], { NPM_FAIL: "1" }).status).not.toBe(0);
    expect(readdirSync(tmp)).toEqual([]);
  } finally {
    cleanupTempDir(dir);
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/repo-tooling && bun test ./test/unit/scripts/verify-bootstrap.test.ts ./test/unit/scripts/bootstrap-artifact.test.ts --timeout=60000`
Expected: `bootstrap-artifact` PASSES. `verify-bootstrap` FAILS: the script still packs a hard-coded `@nathapp/nax-agent@0.1.0` and imports `./lib/bootstrap-artifact.ts`.

- [ ] **Step 3: Implement**

`packages/repo-tooling/scripts/verify-bootstrap.ts`:

```ts
#!/usr/bin/env bun
/**
 * Verifies a manually bootstrapped first publish (the D23 procedure): packs
 * `<name>@<version>` from npm and compares it with the package's staged
 * `.publish/`. Only the deliberately disabled provenance metadata may differ.
 *
 *   bun ../repo-tooling/scripts/verify-bootstrap.ts --package=. --version=0.3.0
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { assertBootstrapArtifact } from "#scripts/lib/bootstrap-artifact";
import { gatePackageRoot } from "#scripts/lib/package-root";

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function versionArg(argv: readonly string[]): string {
  const version = argv.find((a) => a.startsWith("--version="))?.slice("--version=".length);
  if (version === undefined || !VERSION.test(version)) throw new Error("bootstrap: --version=X.Y.Z is required");
  return version;
}

function main(): void {
  const pkgDir = gatePackageRoot();
  const version = versionArg(process.argv);
  const name: unknown = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).name;
  if (typeof name !== "string") throw new Error("bootstrap: package.json has no name");
  const temp = mkdtempSync(join(tmpdir(), `bootstrap-${name.replace(/^@[^/]+\//, "")}-`));
  try {
    const output = execFileSync("npm", ["pack", `${name}@${version}`, "--json", "--ignore-scripts"], {
      cwd: temp,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const filename: unknown = JSON.parse(output)[0]?.filename;
    if (typeof filename !== "string" || basename(filename) !== filename || !filename.endsWith(".tgz")) {
      throw new Error("bootstrap: npm pack returned an invalid filename");
    }
    const tarball = join(temp, filename);
    const entries = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8", timeout: 30_000 });
    for (const entry of entries.trim().split("\n")) {
      if (!entry.startsWith("package/") || entry.split("/").includes("..")) {
        throw new Error(`bootstrap: unsafe tar entry ${entry}`);
      }
    }
    execFileSync("tar", ["-xzf", tarball, "-C", temp], { timeout: 30_000 });
    assertBootstrapArtifact(join(pkgDir, ".publish"), join(temp, "package"));
    console.log(`bootstrap: registry ${name}@${version} matches the prepared artifact; upload already complete`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

main();
```

In `.github/workflows/release.yml`'s "Publish to npm" step, the line `bun scripts/verify-bootstrap.ts` becomes `bun ../repo-tooling/scripts/verify-bootstrap.ts --package=. --version=0.1.0`. Task 7 generalises the rest of that step.

In nax-agent's `release-workflow.test.ts`, test "0.1.0 verifies the existing artifact before skipping upload":
- The expected second call becomes `"bun ../repo-tooling/scripts/verify-bootstrap.ts --package=. --version=0.1.0"`.
- `BUN_FAIL` becomes `"../repo-tooling/scripts/verify-bootstrap.ts --package=. --version=0.1.0"`.

In `packages/nax-agent/RELEASING.md`, the recovery block's `rtk bun scripts/verify-bootstrap.ts` becomes `rtk bun ../repo-tooling/scripts/verify-bootstrap.ts --package=. --version=0.1.0`.

- [ ] **Step 4: Run all affected suites**

Run: `cd packages/repo-tooling && bun run test && bun run typecheck && bun run check:all`
Run: `cd packages/nax-agent && bun test ./test/unit/packaging/ --timeout=60000 && bun run typecheck && bun run check:all`
Expected: PASS. If `check-test-satellites` or `check-file-sizes` in nax-agent reports a stale baseline entry for a moved file, refresh that baseline with its `--update-baseline` flag and confirm the diff only removes moved paths.

- [ ] **Step 5: Commit**

```bash
git add -A packages/repo-tooling packages/nax-agent .github/workflows/release.yml
git commit -m "refactor(release): bootstrap verification is shared repo-tooling, keyed by package and version"
```

---

### Task 7: `release.yml` learns `nax-agent-acp-v*`

**Files:**
- Modify: `.github/workflows/release.yml`
- Modify: `packages/nax-agent/test/helpers/release-shell.ts` (optional manifest override)
- Test: `packages/nax-agent/test/unit/packaging/release-workflow.test.ts`

**Interfaces:**
- Consumes: Task 5's `.publish/package.json` `peerDependencies["@nathapp/nax-agent"]` (`^X.Y.Z`), and Task 6's verifier CLI.
- Produces: the steps "Resolve package", "Pre-publish checks", "Set release info", "nax-agent peer is published" and "Publish to npm" handle `@nathapp/nax-agent-acp`.

- [ ] **Step 1: Write the failing tests**

In `release-shell.ts`, let a test replace the fixture manifest. Change the signature to `makeReleaseShell(opts: { manifest?: Record<string, unknown> } = {})` and use:

```ts
  const manifest = opts.manifest ?? {
    version: "0.1.0",
    dependencies: { "@nathapp/nax-ai": "0.1.16" },
    publishConfig: { tag: "latest" },
  };
```

In `release-workflow.test.ts`:
- Add a routing row: `["nax-agent-acp-v0.3.0", "packages/nax-agent-acp", "@nathapp/nax-agent-acp", "0.3.0"]` and `["nax-agent-acp-v0.3.1-canary.1", "packages/nax-agent-acp", "@nathapp/nax-agent-acp", "0.3.1-canary.1"]`.
- Add invalid tags `"nax-agent-acp-v"` and `"nax-agent-acp-v0.3"`.
- Extend the trigger test with `expect(releaseWorkflow.on.push.tags).toContain("nax-agent-acp-v*.*.*");` and `...("nax-agent-acp-v*.*.*-canary.*")`.
- Add release-info rows `["@nathapp/nax-agent-acp", "0.3.0", "latest", "true", "false"]` and `["@nathapp/nax-agent-acp", "0.3.1-canary.1", "canary", "true", "false"]`.

Then append:

```ts
describe("nax-agent-acp release", () => {
  const ACP = { NAME: "@nathapp/nax-agent-acp", VERSION: "0.3.0", TAG: "nax-agent-acp-v0.3.0" };
  const acpManifest = {
    version: "0.3.0",
    peerDependencies: { "@nathapp/nax-agent": "^0.3.0" },
    publishConfig: { tag: "latest" },
  };

  test("runs the same gates as nax-agent", () => {
    const shell = makeReleaseShell();
    try {
      expect(shell.run("Pre-publish checks", ACP).calls).toEqual([
        "bun run check:all",
        "bun run typecheck",
        "bun run build",
        "bun run check:api",
        "bun run test:coverage",
        "bun run test:node",
        "bun run stage-publish",
      ]);
    } finally {
      cleanupTempDir(shell.dir);
    }
  });

  test("the peer step checks the exact nax-agent version the staged range names", () => {
    const step = releaseStep("nax-agent peer is published");
    expect(step.if).toBe("steps.pkg.outputs.name == '@nathapp/nax-agent-acp'");
    expect(step["working-directory"]).toBe(`\${{ steps.pkg.outputs.dir }}`);
    const shell = makeReleaseShell({ manifest: acpManifest });
    try {
      expect(shell.run("nax-agent peer is published", ACP).calls).toEqual([
        "npm view @nathapp/nax-agent@0.3.0 version",
      ]);
      for (const code of ["E404", "E401", "ETIMEDOUT"]) {
        expect(shell.run("nax-agent peer is published", { ...ACP, NPM_ERROR: code }).status).not.toBe(0);
      }
      expect(shell.run("nax-agent peer is published", { ...ACP, NPM_VIEW_EMPTY: "1" }).status).not.toBe(0);
    } finally {
      cleanupTempDir(shell.dir);
    }
  });

  test("a staged manifest without the peer range fails the peer step", () => {
    const shell = makeReleaseShell({ manifest: { version: "0.3.0", publishConfig: { tag: "latest" } } });
    try {
      const result = shell.run("nax-agent peer is published", ACP);
      expect(result.status).not.toBe(0);
      expect(result.calls).toEqual([]);
    } finally {
      cleanupTempDir(shell.dir);
    }
  });

  test("0.3.0 is the acp bootstrap: verifies the existing artifact and skips upload", () => {
    const shell = makeReleaseShell({ manifest: acpManifest });
    try {
      const result = shell.run("Publish to npm", ACP);
      expect(result.status).toBe(0);
      expect(result.calls).toEqual([
        "npm view @nathapp/nax-agent-acp@0.3.0 version --json",
        "bun ../repo-tooling/scripts/verify-bootstrap.ts --package=. --version=0.3.0",
      ]);
    } finally {
      cleanupTempDir(shell.dir);
    }
  });

  test("0.3.0 absent from npm stops with a manual-publish error instead of an OIDC upload", () => {
    const shell = makeReleaseShell({ manifest: acpManifest });
    try {
      const result = shell.run("Publish to npm", { ...ACP, NPM_ERROR: "E404" });
      expect(result.status).not.toBe(0);
      expect(result.output).toContain("publish it manually first");
      expect(result.calls.some((call) => call.startsWith("npm publish"))).toBe(false);
    } finally {
      cleanupTempDir(shell.dir);
    }
  });

  test("later acp versions publish .publish/ with the selected dist-tag", () => {
    const shell = makeReleaseShell({ manifest: { ...acpManifest, version: "0.3.1" } });
    try {
      const result = shell.run("Publish to npm", { ...ACP, VERSION: "0.3.1", NPM_TAG: "canary" });
      expect(result.status).toBe(0);
      expect(result.calls).toEqual(["npm publish ./.publish/ --access public --tag canary --provenance"]);
      expect(JSON.parse(readFileSync(join(shell.dir, ".publish/package.json"), "utf8")).publishConfig.tag).toBe(
        "canary",
      );
    } finally {
      cleanupTempDir(shell.dir);
    }
  });
});
```

The fake `npm` in `release-shell.ts` needs one more branch, for a successful but empty `npm view`. In its `view)` case, insert before `echo '"0.1.0"'`:

```sh
    if [ -n "$NPM_VIEW_EMPTY" ]; then exit 0; fi
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/nax-agent && bun test ./test/unit/packaging/release-workflow.test.ts --timeout=60000`
Expected: FAIL. The acp tag is "Unrecognised", there is no "nax-agent peer is published" step, and acp is not a library in release info.

- [ ] **Step 3: Implement in `release.yml`**

Triggers: add `- "nax-agent-acp-v*.*.*"` and `- "nax-agent-acp-v*.*.*-canary.*"` under `on.push.tags`.

"Resolve package": add as the FIRST case arm (before `nax-agent-v*`):

```sh
            nax-agent-acp-v*) V="${TAG#nax-agent-acp-v}"; echo "dir=packages/nax-agent-acp" >> "$GITHUB_OUTPUT"; echo "name=@nathapp/nax-agent-acp" >> "$GITHUB_OUTPUT" ;;
```

"Pre-publish checks": the first condition becomes `if [ "$NAME" = "@nathapp/nax-agent" ] || [ "$NAME" = "@nathapp/nax-agent-acp" ]; then`, with the body unchanged.

"Set release info": the library condition becomes `if [ "$NAME" = "@nathapp/nax-ai" ] || [ "$NAME" = "@nathapp/nax-agent" ] || [ "$NAME" = "@nathapp/nax-agent-acp" ]; then`.

New step, placed directly after "nax-ai pin is published":

```yaml
      # nax-agent-acp peers on @nathapp/nax-agent at the same version (R10), so an acp
      # release is only installable once that nax-agent version is on npm.
      - name: nax-agent peer is published
        if: steps.pkg.outputs.name == '@nathapp/nax-agent-acp'
        working-directory: ${{ steps.pkg.outputs.dir }}
        run: |
          RANGE=$(node -p "require('./.publish/package.json').peerDependencies?.['@nathapp/nax-agent'] ?? ''")
          PEER="${RANGE#^}"
          if [ -z "$PEER" ] || [ "$PEER" = "$RANGE" ]; then echo "::error::staged manifest has no ^X.Y.Z @nathapp/nax-agent peer range"; exit 1; fi
          OUT=$(npm view "@nathapp/nax-agent@$PEER" version) || { echo "::error::@nathapp/nax-agent@$PEER is not on npm; release nax-agent first"; exit 1; }
          if [ -z "$OUT" ]; then echo "::error::@nathapp/nax-agent@$PEER is not on npm; release nax-agent first"; exit 1; fi
```

"Publish to npm": generalise the nax-agent arm to both packages, with each package's bootstrap version:

```sh
          if [ "$NAME" = "@nathapp/nax-agent" ] || [ "$NAME" = "@nathapp/nax-agent-acp" ]; then
            # Each package's first version was published manually (D23); its tag only verifies it.
            if [ "$NAME" = "@nathapp/nax-agent" ]; then BOOTSTRAP=0.1.0; else BOOTSTRAP=0.3.0; fi
            if [ "$VERSION" = "$BOOTSTRAP" ]; then
              if REGISTRY_RESULT=$(npm view "$NAME@$BOOTSTRAP" version --json); then
                bun ../repo-tooling/scripts/verify-bootstrap.ts --package=. --version="$BOOTSTRAP"
                exit 0
              else
                REGISTRY_RESULT="$REGISTRY_RESULT" node -e '
                  const result = JSON.parse(process.env.REGISTRY_RESULT || "{}");
                  if (result.error?.code !== "E404") throw new Error("bootstrap registry check failed: " + JSON.stringify(result));
                '
                # Trusted publishing cannot create a package: the acp first version must already exist.
                if [ "$NAME" = "@nathapp/nax-agent-acp" ]; then
                  echo "::error::@nathapp/nax-agent-acp@$BOOTSTRAP is not on npm; publish it manually first (packages/nax-agent-acp/RELEASING.md)"
                  exit 1
                fi
              fi
            fi
```

nax-agent keeps its existing E404 fall-through, so its tests stay unchanged.

Keep the rest of that arm (the `publishConfig.tag` rewrite and `npm publish ./.publish/ ...`) as it is.

The shell expands `--version="$BOOTSTRAP"` to `--version=0.1.0`, so the existing nax-agent expectation from Task 6 still matches.

- [ ] **Step 4: Run the workflow tests**

Run: `cd packages/nax-agent && bun test ./test/unit/packaging/ --timeout=60000 && bun run check:all`
Expected: PASS, with every pre-existing routing, publish and bootstrap test still green.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/release.yml packages/nax-agent/test
git commit -m "ci(release): route and publish nax-agent-acp-v* tags after their nax-agent peer"
```

---

### Task 8: Release helper bumps both packages and learns `tag-acp`; RELEASING docs

**Files:**
- Modify: `packages/nax-agent/scripts/release.ts`
- Modify: `packages/nax-agent/test/helpers/release-cli-fixture.ts`
- Test: `packages/nax-agent/test/unit/packaging/release-cli.test.ts`
- Create: `packages/nax-agent-acp/RELEASING.md`
- Modify: `packages/nax-agent/RELEASING.md`

**Interfaces:**
- `bun run release [--dry-run] <canary|promote|patch|minor|major|X.Y.Z>` (from `packages/nax-agent`) computes `next` from nax-agent.
  - When `next` is at or above nax-agent-acp's current version, it sets BOTH packages to `next`, updates both `## [Unreleased]` changelog sections, and commits five files: both `package.json`, both `CHANGELOG.md`, and `bun.lock`.
  - When `next` is below acp's version, acp is left untouched and its notes are not required. Before the first joint release acp sits at 0.3.0 ahead of nax-agent, and a nax-agent 0.2.x patch must neither downgrade it nor need acp notes. It prints `nax-agent-acp stays at <v> (ahead of nax-agent)`.
- `compareVersions(a, b): number` is exported from `scripts/lib/release-version.ts` (semver precedence; a prerelease sorts below its release).
- `release tag` is unchanged and pushes `nax-agent-v<version>`.
- `release [--dry-run] tag-acp` pushes `nax-agent-acp-v<version>`. It requires:
  - clean main, both versions equal, and no existing tag
  - `npm view @nathapp/nax-agent@<version> version` returning non-empty output
  - at the bootstrap version 0.3.0, `npm view @nathapp/nax-agent-acp@0.3.0 version` also returning non-empty output, because the first publish is manual and the tag only verifies it

- [ ] **Step 1: Write the failing tests**

In `release-cli-fixture.ts`, after writing nax-agent's files and BEFORE the fixture's `git add .` / initial commit, add the acp package:

```ts
  const acp = join(dir, "packages/nax-agent-acp");
  mkdirSync(acp, { recursive: true });
  writeFileSync(join(acp, "package.json"), JSON.stringify({ name: "@nathapp/nax-agent-acp", version: "0.1.0", private: true }));
  writeFileSync(join(acp, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\n- ACP backend.\n");
```

Add an `npm` stub to the fixture's fake bin map. It logs the call. `NPM_VIEW_FAIL=1` exits 1, `NPM_VIEW_EMPTY=1` prints nothing, and `NPM_VIEW_MISSING=<name@version>` exits 1 for that one spec only:

```ts
    npm: `if [ "$NPM_VIEW_FAIL" = "1" ]; then exit 1; fi
if [ -n "$NPM_VIEW_MISSING" ] && [ "$2" = "$NPM_VIEW_MISSING" ]; then exit 1; fi
if [ "$NPM_VIEW_EMPTY" = "1" ]; then exit 0; fi
echo "0.1.0"`,
```

In `release-cli.test.ts`:
- In the first test's arg list, add `{ args: ["--dry-run", "tag-acp"] }` and `{ args: ["tag-acp"] }`. Extend its forbidden-call regex to `/^(gh |bun |npm (?!view)|git (pull|push|add|commit|checkout)\b|git tag (?!--list))/`.
- In the "confirmed bump" test, the changed-files expectation becomes:

```ts
      expect(changed).toEqual([
        "bun.lock",
        "packages/nax-agent-acp/CHANGELOG.md",
        "packages/nax-agent-acp/package.json",
        "packages/nax-agent/CHANGELOG.md",
        "packages/nax-agent/package.json",
      ]);
      expect(
        JSON.parse(f.git("show", "release/nax-agent-v0.1.1:packages/nax-agent-acp/package.json")).version,
      ).toBe("0.1.1");
      expect(f.git("show", "release/nax-agent-v0.1.1:packages/nax-agent-acp/CHANGELOG.md")).toMatch(
        /## \[0\.1\.1\] - \d{4}-\d{2}-\d{2}/,
      );
```

Append:

```ts
describe("lockstep with nax-agent-acp", () => {
  test("a bump refuses to mutate when acp has no unreleased notes", () => {
    const f = makeReleaseCliFixture();
    try {
      writeFileSync(join(f.dir, "packages/nax-agent-acp/CHANGELOG.md"), "# Changelog\n");
      f.git("commit", "-am", "no acp notes");
      const result = f.run(["patch"], "y\n");
      expect(result.status).not.toBe(0);
      expect(result.output).toContain("nax-agent-acp");
      expect(result.calls.some((call) => /^git (pull|checkout|push)\b/.test(call))).toBe(false);
    } finally {
      cleanupTempDir(f.dir);
    }
  });

  test("dry-run names both tags", () => {
    const f = makeReleaseCliFixture();
    try {
      const out = f.run(["minor", "--dry-run"]).output;
      expect(out).toContain("nax-agent-v0.2.0");
      expect(out).toContain("nax-agent-acp-v0.2.0");
    } finally {
      cleanupTempDir(f.dir);
    }
  });

  test("tag-acp pushes nax-agent-acp-v<version> once nax-agent at that version is on npm", () => {
    const f = makeReleaseCliFixture();
    try {
      const result = f.run(["tag-acp"], "y\n");
      expect(result.status).toBe(0);
      expect(result.calls).toContain("npm view @nathapp/nax-agent@0.1.0 version");
      expect(result.calls).toContain("git push origin nax-agent-acp-v0.1.0");
      expect(f.git("tag", "--list")).toBe("nax-agent-acp-v0.1.0");
    } finally {
      cleanupTempDir(f.dir);
    }
  });

  test.each([{ NPM_VIEW_FAIL: "1" }, { NPM_VIEW_EMPTY: "1" }])(
    "tag-acp refuses when the nax-agent peer is not on npm (%j)",
    (env) => {
      const f = makeReleaseCliFixture();
      try {
        const result = f.run(["tag-acp"], "y\n", env);
        expect(result.status).not.toBe(0);
        expect(result.calls.some((call) => /^git (push|tag nax-agent-acp)\b/.test(call))).toBe(false);
      } finally {
        cleanupTempDir(f.dir);
      }
    },
  );

  test("tag-acp refuses when the two versions differ", () => {
    const f = makeReleaseCliFixture();
    try {
      writeFileSync(
        join(f.dir, "packages/nax-agent-acp/package.json"),
        JSON.stringify({ name: "@nathapp/nax-agent-acp", version: "0.3.0", private: true }),
      );
      f.git("commit", "-am", "drift");
      const result = f.run(["tag-acp"], "y\n");
      expect(result.status).not.toBe(0);
      expect(result.output).toContain("lockstep");
      expect(result.calls.some((call) => call.startsWith("npm ") || /^git push\b/.test(call))).toBe(false);
    } finally {
      cleanupTempDir(f.dir);
    }
  });

  function setVersions(f: ReturnType<typeof makeReleaseCliFixture>, agent: string, acp: string): void {
    for (const [rel, version] of [
      ["packages/nax-agent/package.json", agent],
      ["packages/nax-agent-acp/package.json", acp],
    ] as const) {
      const path = join(f.dir, rel);
      writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), version }));
    }
    f.git("commit", "-am", `versions ${agent} ${acp}`);
  }

  test("tag-acp dry-run reports the bootstrap action at 0.3.0", () => {
    const f = makeReleaseCliFixture();
    try {
      setVersions(f, "0.3.0", "0.3.0");
      expect(f.run(["tag-acp", "--dry-run"]).output).toContain("manual");
    } finally {
      cleanupTempDir(f.dir);
    }
  });

  test("tag-acp at 0.3.0 refuses until the manual acp publish exists on npm", () => {
    const f = makeReleaseCliFixture();
    try {
      setVersions(f, "0.3.0", "0.3.0");
      const result = f.run(["tag-acp"], "y\n", { NPM_VIEW_MISSING: "@nathapp/nax-agent-acp@0.3.0" });
      expect(result.status).not.toBe(0);
      expect(result.output).toContain("manual");
      expect(result.calls.some((call) => /^git (push|tag nax-agent-acp)\b/.test(call))).toBe(false);
    } finally {
      cleanupTempDir(f.dir);
    }
  });

  test("a nax-agent release below acp's version leaves acp and its notes alone", () => {
    const f = makeReleaseCliFixture();
    try {
      setVersions(f, "0.1.0", "0.3.0");
      writeFileSync(join(f.dir, "packages/nax-agent-acp/CHANGELOG.md"), "# Changelog\n");
      f.git("commit", "-am", "acp has no notes");
      const result = f.run(["patch"], "y\n");
      expect(result.status).toBe(0);
      expect(result.output).toContain("nax-agent-acp stays at 0.3.0");
      expect(f.git("diff", "--name-only", "main", "release/nax-agent-v0.1.1").split("\n")).toEqual([
        "bun.lock",
        "packages/nax-agent/CHANGELOG.md",
        "packages/nax-agent/package.json",
      ]);
    } finally {
      cleanupTempDir(f.dir);
    }
  });

  test("the first joint release lifts nax-agent to acp's version and bumps both", () => {
    const f = makeReleaseCliFixture();
    try {
      setVersions(f, "0.2.0", "0.3.0");
      const result = f.run(["minor"], "y\n");
      expect(result.status).toBe(0);
      const show = (rel: string) => JSON.parse(f.git("show", `release/nax-agent-v0.3.0:${rel}`)).version;
      expect(show("packages/nax-agent/package.json")).toBe("0.3.0");
      expect(show("packages/nax-agent-acp/package.json")).toBe("0.3.0");
    } finally {
      cleanupTempDir(f.dir);
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/nax-agent && bun test ./test/unit/packaging/release-cli.test.ts --timeout=60000`
Expected: FAIL. `tag-acp` is treated as an explicit version and rejected as invalid, and the bump changes three files instead of five.

Also add `compareVersions` cases to `test/unit/packaging/release-version.test.ts`:

```ts
test("compareVersions orders by semver precedence; a canary sorts below its release", () => {
  expect(compareVersions("0.3.0", "0.3.0")).toBe(0);
  expect(compareVersions("0.2.1", "0.3.0")).toBeLessThan(0);
  expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
  expect(compareVersions("0.3.0-canary.1", "0.3.0")).toBeLessThan(0);
  expect(compareVersions("0.3.0-canary.10", "0.3.0-canary.9")).toBeGreaterThan(0);
  expect(compareVersions("0.3.1-canary.1", "0.3.0")).toBeGreaterThan(0);
});
```

(import `compareVersions` alongside the existing imports from the release-version lib.)

- [ ] **Step 3: Implement in `scripts/release.ts`**

Add the constants and helpers:

```ts
const ACP = resolve(PKG, "../nax-agent-acp");
const ACP_PKG_PATH = join(ACP, "package.json");
const ACP_NOTES_PATH = join(ACP, "CHANGELOG.md");
const ACP_BOOTSTRAP = "0.3.0";

function readJsonAt(path: string): { version: string; [key: string]: unknown } {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** R10: nax-agent and nax-agent-acp always share one version. */
function lockstepVersion(): string {
  const agent = readPackage().version;
  const acp = readJsonAt(ACP_PKG_PATH).version;
  if (agent !== acp) throw new Error(`nax-agent ${agent} and nax-agent-acp ${acp} must share one version (R10 lockstep)`);
  return agent;
}

/** True only when npm reports the exact `name@version`; any registry failure counts as not published. */
function onNpm(spec: string): boolean {
  try {
    const out = execFileSync("npm", ["view", spec, "version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
    return out.trim() !== "";
  } catch {
    return false;
  }
}
```

`onNpm`'s `catch` returns `false` on purpose: any registry failure means "not proven published", and the caller refuses. Write it with no bare empty catch, so the `no-empty-catch` plugin stays satisfied.

Add `tagAcpRelease(dryRun)`:

```ts
async function tagAcpRelease(dryRun: boolean): Promise<void> {
  requireCleanMain();
  const version = lockstepVersion();
  const tag = `nax-agent-acp-v${version}`;
  rejectExistingTag(tag);
  const action =
    version === ACP_BOOTSTRAP
      ? `Verify the manual ${ACP_BOOTSTRAP} publish and create its GitHub prerelease`
      : `Publish through OIDC under ${distTagsFor(version).join(" + ")}`;
  console.log(`${tag}: ${action}`);
  if (dryRun) {
    console.log("Dry run; no tag created or pushed.");
    return;
  }
  if (!onNpm(`@nathapp/nax-agent@${version}`)) {
    throw new Error(`@nathapp/nax-agent@${version} is not on npm; release nax-agent first (release order)`);
  }
  if (version === ACP_BOOTSTRAP && !onNpm(`@nathapp/nax-agent-acp@${ACP_BOOTSTRAP}`)) {
    throw new Error(`@nathapp/nax-agent-acp@${ACP_BOOTSTRAP} must be published manually first (RELEASING.md)`);
  }
  if (!(await confirm(`Push ${tag}? ${action}.`))) {
    console.log("Aborted.");
    return;
  }
  git("tag", tag);
  git("push", "origin", tag);
  console.log(`Pushed ${tag}; watch https://github.com/nathapp-io/nax/actions`);
}
```

Add `compareVersions` to `scripts/lib/release-version.ts`, reusing its `parseVersion`:

```ts
/** Semver precedence: -1, 0 or 1. A prerelease sorts below its release; numeric identifiers compare numerically. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (const key of ["major", "minor", "patch"] as const) {
    if (x[key] !== y[key]) return x[key] < y[key] ? -1 : 1;
  }
  if (x.prerelease === y.prerelease) return 0;
  if (x.prerelease === undefined) return 1;
  if (y.prerelease === undefined) return -1;
  const left = x.prerelease.split(".");
  const right = y.prerelease.split(".");
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = left[i];
    const r = right[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;
    const ln = /^\d+$/.test(l) ? Number(l) : undefined;
    const rn = /^\d+$/.test(r) ? Number(r) : undefined;
    if (ln !== undefined && rn !== undefined) return ln < rn ? -1 : 1;
    if (ln !== undefined) return -1;
    if (rn !== undefined) return 1;
    return l < r ? -1 : 1;
  }
  return 0;
}
```

In `bumpRelease`:
- Read `acpCurrent = readJsonAt(ACP_PKG_PATH).version` and decide `const withAcp = compareVersions(next, acpCurrent) >= 0;`. When `withAcp` is false, log `nax-agent-acp stays at ${acpCurrent} (ahead of nax-agent)` and skip every acp step below (notes, writes, `git add`, PR-body line).
- Read `originalAcpNotes = readFileSync(ACP_NOTES_PATH, "utf8")`.
- The dry-run log adds `Tags: ${tag}, nax-agent-acp-v${next}` when `withAcp`.
- Before any mutation, and only when `withAcp`, compute `acpNotes`, with the error naming the package:

```ts
  let acpNotes: string;
  try {
    acpNotes = updateChangelog(originalAcpNotes, next, today);
  } catch (error) {
    throw new Error(`nax-agent-acp: ${error instanceof Error ? error.message : String(error)}`);
  }
```

  `today` is the same date string used for `notes`. Compute it once.
- The post-pull guard also compares `readFileSync(ACP_NOTES_PATH, "utf8") !== originalAcpNotes` and `readJsonAt(ACP_PKG_PATH).version` against its pre-pull value.
- Write `ACP_PKG_PATH` as `{ ...readJsonAt(ACP_PKG_PATH), version: next }`, and `ACP_NOTES_PATH` as `acpNotes`.
- `git add` adds `packages/nax-agent-acp/package.json` and `packages/nax-agent-acp/CHANGELOG.md`.
- The PR body adds: `Also bumps @nathapp/nax-agent-acp to ${next} (R10 lockstep). After nax-agent-v${next} is published, run \`bun run release tag-acp\`.`

In `main`:
- Route `kinds[0] === "tag-acp"` to `tagAcpRelease`.
- The usage line becomes `bun run release [--dry-run] <canary|promote|patch|minor|major|tag|tag-acp|X.Y.Z>`.

If `release.ts` grows past a complexity or size baseline, split `tagAcpRelease` and the helpers into `scripts/lib/release-acp.ts` rather than raising a baseline. In that case `release-cli-fixture.ts` must also copy `lib/release-acp.ts` (it copies only `release.ts` and `lib/release-version.ts` today).

- [ ] **Step 4: Write the RELEASING docs**

`packages/nax-agent-acp/RELEASING.md`:

```markdown
# Releasing nax-agent-acp

nax-agent-acp and `@nathapp/nax-agent` share one version and are always released
together (S4 spec R10). Release order: **nax-ai -> nax-agent -> nax-agent-acp -> nax**.
Nothing is released before S4 acceptance (S4-6): a partial `./client` is never published.

All commands run from `packages/nax-agent`, whose release helper bumps both packages.
Every publish and every tag push needs separate maintainer approval.

## Prepare a release

Add notes under `## [Unreleased]` in BOTH `packages/nax-agent/CHANGELOG.md` and
`packages/nax-agent-acp/CHANGELOG.md`. On clean, up-to-date main:

```sh
rtk bun run release --dry-run minor
rtk bun run release minor
```

The helper sets both versions, dates both changelogs, refreshes the lockfile and
opens one PR. Review and merge it.

## Publish nax-agent, then nax-agent-acp

1. `rtk bun run release tag` pushes `nax-agent-vX.Y.Z` (see `packages/nax-agent/RELEASING.md`).
   Wait until `rtk npm view @nathapp/nax-agent@X.Y.Z version` prints the version.
2. `rtk bun run release --dry-run tag-acp`, then `rtk bun run release tag-acp`. It refuses
   while the two versions differ or while nax-agent X.Y.Z is not on npm. The workflow
   reruns the gates, checks the peer again, and publishes `.publish/` (peer `^X.Y.Z`).

## First publish: 0.3.0 (manual, maintainer 2FA)

npm trusted publishing needs an existing package, so 0.3.0 follows the D23 procedure
used for nax-agent 0.1.0. After nax-agent 0.3.0 is on npm, from `packages/nax-agent-acp`:

```sh
rtk bun run check:all && rtk bun run typecheck && rtk bun run build
rtk bun run check:api && rtk bun run test:coverage && rtk bun run test:node
rtk bun run stage-publish
rtk npm pack ./.publish/ --dry-run --json
```

Review the staged name, version, `peerDependencies` (`^0.3.0`), exports and file
inventory. Then disable provenance in the staging manifest only, and publish in the
maintainer's own terminal:

```sh
rtk node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from "node:fs";
const path = ".publish/package.json";
const pkg = JSON.parse(readFileSync(path, "utf8"));
if (pkg.name !== "@nathapp/nax-agent-acp" || pkg.version !== "0.3.0") {
  throw new Error("Expected the approved nax-agent-acp 0.3.0 artifact");
}
pkg.publishConfig.provenance = false;
writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
JS
rtk npm publish ./.publish/ --access public --tag latest --provenance=false
```

Never send an OTP in chat or store it anywhere. If publish errors, check registry
state before retrying, and never republish an existing version:

```sh
rtk npm view @nathapp/nax-agent-acp@0.3.0 version dist.integrity
rtk bun run stage-publish
rtk bun ../repo-tooling/scripts/verify-bootstrap.ts --package=. --version=0.3.0
```

Then add the trusted publisher in the package's npm settings (2FA), with the same values
as nax-agent: organization `nathapp-io`, repository `nax`, workflow `release.yml`,
environment `npm`, allowed action "Enable direct `npm publish`" (`--allow-publish`).
An entry without the publish action fails later uploads with E403 "OIDC permission
denied for this action".

Finally `rtk bun run release tag-acp` from `packages/nax-agent`: the 0.3.0 tag verifies
the already-published artifact, skips the upload and creates the GitHub prerelease.
Later versions publish through OIDC with provenance.
```

In `packages/nax-agent/RELEASING.md`'s "Subsequent releases" section, add after the first paragraph:

```markdown
Since S4-1 the helper also bumps `@nathapp/nax-agent-acp` to the same version (R10),
so its `## [Unreleased]` notes are required too. Publish nax-agent first with
`release tag`; `release tag-acp` publishes nax-agent-acp afterwards. See
`packages/nax-agent-acp/RELEASING.md`.
```

- [ ] **Step 5: Run the tests and gates**

Run: `cd packages/nax-agent && bun test ./test/unit/packaging/ --timeout=60000 && bun run typecheck && bun run check:all`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/nax-agent packages/nax-agent-acp/RELEASING.md
git commit -m "feat(release): nax-agent release helper bumps nax-agent-acp in lockstep and tags it after its peer"
```

---

### Task 9: CI jobs

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces the CI checks `nax-agent-acp` and `nax-agent-acp: node {22,24}`.

- [ ] **Step 1: Add the jobs**

Insert after the `nax-agent-node` job:

```yaml
  # S4-1: the ACP backend package. Same gates as nax-agent, without the OS
  # sandbox (this package never sandboxes; the agent process runs on the host, R7).
  nax-agent-acp:
    name: nax-agent-acp
    runs-on: ubuntu-latest
    timeout-minutes: 10
    defaults:
      run:
        working-directory: packages/nax-agent-acp
    steps:
      - uses: actions/checkout@v5

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: "1.4.0"

      - name: Cache bun dependencies
        uses: actions/cache@v5
        with:
          path: ~/.bun/install/cache
          key: bun-${{ runner.os }}-${{ hashFiles('bun.lock') }}
          restore-keys: |
            bun-${{ runner.os }}-

      # Root install: links the workspace (nax-agent as the peer) and runs nax-ai's
      # `prepare`, whose dist/ the peer's source resolves @nathapp/nax-ai to.
      - name: Install dependencies
        run: bun install --frozen-lockfile
        working-directory: .

      - name: Typecheck
        run: bun run typecheck

      - name: Check all
        run: bun run check:all

      - name: Build
        run: bun run build

      # The built API of ./client and ./server equals api/nax-agent-acp.api.txt.
      - name: API snapshot
        run: bun run check:api

      - name: Test (unit)
        run: bun test ./test/unit/ --timeout=60000 --bail

      # 80% lines and functions overall and per src/ file; every src/ file with code
      # must appear in the report. The per-file baseline stays empty.
      - name: Coverage floor
        run: bun run test:coverage

  nax-agent-acp-node:
    name: "nax-agent-acp: node ${{ matrix.node }}"
    runs-on: ubuntu-latest
    timeout-minutes: 10
    strategy:
      fail-fast: false
      matrix:
        node: ["22", "24"]
    defaults:
      run:
        working-directory: packages/nax-agent-acp
    steps:
      - uses: actions/checkout@v5

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: "1.4.0"

      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}

      - name: Cache bun dependencies
        uses: actions/cache@v5
        with:
          path: ~/.bun/install/cache
          key: bun-${{ runner.os }}-${{ hashFiles('bun.lock') }}
          restore-keys: |
            bun-${{ runner.os }}-

      - name: Install dependencies
        run: bun install --frozen-lockfile
        working-directory: .

      - run: node --version

      - name: Node contract suite
        run: bun run test:node
```

Not added, on purpose: the OS sandbox setup (the agent process runs unsandboxed, R7), a glob-floor job, and the packed-tarball smoke (spec §10 puts it in S4-6).

- [ ] **Step 2: Validate the YAML**

Run (repo root): `bun -e 'const y = Bun.YAML.parse(await Bun.file(".github/workflows/ci.yml").text()); for (const j of ["nax-agent-acp", "nax-agent-acp-node"]) if (!y.jobs[j]) throw new Error(j); console.log("ok")'`
Expected: `ok`.

Run locally, as the job does: `cd packages/nax-agent-acp && bun run typecheck && bun run check:all && bun run build && bun run check:api && bun test ./test/unit/ --timeout=60000 --bail && bun run test:coverage && bun run test:node`
Expected: all exit 0.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: nax-agent-acp job and Node 22/24 contract matrix"
```

---

### Task 10: Context files

**Files:**
- Modify: `.nax/context.md`
- Create: `.nax/mono/packages/nax-agent-acp/context.md`, `.nax/mono/packages/nax-agent-acp/config.json`
- Modify: `.nax/mono/packages/nax-agent/context.md`
- Regenerated (never hand-edited): root and per-package `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `codex.md`

- [ ] **Step 1: Edit the root context**

In `.nax/context.md`:
- Add a Layout row after nax-agent:
  `| \`packages/nax-agent-acp\` | \`@nathapp/nax-agent-acp\` | ACP backend for nax-agent sessions (\`./client\`; \`./server\` reserved); Node library, nax-agent peer, versioned in lockstep with nax-agent (workspace private; npm uses staged manifest) |`
- The dependency line becomes: `Dependency direction: \`nax-ai\` -> \`nax-agent\` -> \`nax\`, and \`nax-agent\` -> \`nax-agent-acp\` (peer). No package imports nax-agent-acp until S4b; it reaches nax-agent only through its public entry. \`check:package-boundaries\` (packages/nax) enforces both.`
- Releases: add `\`nax-agent-acp-vX.Y.Z\` publishes \`@nathapp/nax-agent-acp\` from \`.publish/\` after the same nax-agent version is on npm.` The release order becomes `nax-ai -> nax-agent -> nax-agent-acp -> nax.` Append `nax-agent and nax-agent-acp share one version; nax-agent's release helper bumps both. See \`packages/nax-agent-acp/RELEASING.md\`.`

- [ ] **Step 2: Add the package context and config**

`.nax/mono/packages/nax-agent-acp/config.json`:

```json
{
  "quality": {
    "commands": {
      "test": "bun run --cwd ../nax-ai build && bun run test",
      "typecheck": ["bun run --cwd ../nax-ai build", "bun run typecheck"],
      "lint": "AGENT=1 bun run check:all",
      "build": "bun run typecheck",
      "testScoped": "CI=1 AGENT=1 bun test --timeout=60000 {{files}}",
      "lintFix": "bun run lint:fix",
      "formatFix": "bun run lint:fix"
    }
  }
}
```

`.nax/mono/packages/nax-agent-acp/context.md`:

```markdown
# nax-agent-acp — ACP backend for nax-agent sessions

`@nathapp/nax-agent-acp` lets the nax-agent session API drive external coding agents
(Claude Code first-class; Codex, Gemini CLI, OpenCode, pi registered) over ACP, the
Agent Client Protocol. It is nax-agent's own ACP client on `@agentclientprotocol/sdk`.
Design: `docs/superpowers/specs/2026-10-05-s4-acp-backend-design.md`.

> Edit this file to update AI agent context — do not edit `CLAUDE.md`, `AGENTS.md`,
> `.cursorrules`, `GEMINI.md` or other generated agent files directly.
> Run `nax generate` after changing it.

## Status

Built in stages S4-1 to S4-6. S4-1 is the scaffold plus the agent registry
(`src/client/registry.ts`); `./client` exports nothing until S4-2 adds `acpBackend()`.
`./server` is reserved for S5 and stays empty. Nothing is released before S4-6.

## Boundaries

- Import nax-agent only as `@nathapp/nax-agent` (its public entry). Never
  `@nathapp/nax-agent/internal` or a deep path, in src/ or test/.
- `src/` imports only `@agentclientprotocol/sdk` (root, never `/experimental`),
  `@modelcontextprotocol/sdk`, `zod` and `node:` builtins. No Bun API in `src/`.
- No other package imports this one until S4b.
- `bun run check:package-boundaries` in packages/nax enforces these rules.

## Commands (from packages/nax-agent-acp)

| Command | Purpose |
|:--------|:--------|
| `bun run typecheck` | `tsc --noEmit` over src/, test/ and scripts/ |
| `bun run build` | nodenext emit to `dist/` |
| `bun run test` | bun:test unit suite |
| `bun run test:node` | vitest on real Node 22/24 |
| `bun run test:coverage` | 80% floor, overall and per file; per-file baseline stays empty |
| `bun run check:api` / `api:update` | API snapshot of `./client` and `./server` |
| `bun run check:all` | Biome plus the shared repo-tooling gates |
| `bun run stage-publish` | `.publish/` with the peer rewritten to `^<version>`; refuses version drift from nax-agent |

## Releases

Versioned in lockstep with nax-agent and released by nax-agent's helper
(`bun run release ...`, then `release tag`, then `release tag-acp`). See `RELEASING.md`.
```

- [ ] **Step 3: Note the lockstep in nax-agent's context**

In `.nax/mono/packages/nax-agent/context.md`, after the paragraph ending "...subsequent `nax-agent-vX.Y.Z` tags publish through OIDC with provenance.", add:

```markdown
`@nathapp/nax-agent-acp` peers on this package at the same version (S4 R10): the
release helper bumps both, and `release tag-acp` publishes it after this package.
Its only allowed import of nax-agent is the public entry `.`, so any symbol the ACP
backend needs must be exported from `.`, never `./internal`.
```

- [ ] **Step 4: Regenerate and verify**

Run (repo root):
```bash
bun packages/nax/bin/nax.ts generate
bun packages/nax/bin/nax.ts generate --all-packages
git status --short
```
Expected:
- Root and per-package `CLAUDE.md`, `AGENTS.md`, `GEMINI.md` and `codex.md` are updated.
- New files exist under `packages/nax-agent-acp/`.
- No `.nax/` source changes beyond Steps 1 to 3.

Run: `cd packages/nax && bun run check:all`
Expected: exit 0 (includes `check:rules-drift` and `check:package-boundaries`).

- [ ] **Step 5: Commit**

```bash
git add .nax packages/*/CLAUDE.md packages/*/AGENTS.md packages/*/GEMINI.md packages/*/codex.md CLAUDE.md AGENTS.md GEMINI.md codex.md
git commit -m "docs(context): record nax-agent-acp, its boundary and lockstep releases"
```

---

### Task 11: Whole-repo gates, review, PR

- [ ] **Step 1: Run the repo-wide gates**

Run (repo root):
```bash
bun run typecheck
bun run check:all
bun run build
bun run test
```
Expected: all exit 0.

Run from each package as CI does:
- `cd packages/nax-agent && bun run check:api && bun run test:coverage && bun run test:node`
- `cd packages/nax-agent-acp && bun run check:api && bun run test:coverage && bun run test:node`

Expected: all exit 0. nax-agent's `api/nax-agent.api.txt` is unchanged (`git diff --exit-code origin/main -- packages/nax-agent/api/`).

- [ ] **Step 2: Confirm the scope fence**

Run: `git diff --stat origin/main -- packages/nax/ | cat`
Expected: exactly `scripts/check-package-boundaries.ts` and `test/unit/scripts/check-package-boundaries.test.ts`. The root context feeds only the root generated files, so `packages/nax/CLAUDE.md` and its siblings must not change. Spec §11.4 ("`packages/nax/` diff empty") is measured against the merged S4-1 main, which S4-2 to S4-6 branch from.

Run: `git diff --stat origin/main -- packages/nax-agent/src/ | cat`
Expected: empty. S4-1 does not touch nax-agent source, so no billed `nax run` smoke is needed.

- [ ] **Step 3: Review before push**

Dispatch one code-review subagent (sonnet) over `git diff origin/main...HEAD`. Give it the spec §4, §8 and §10 and this plan's Review Focus list. Fix CRITICAL and HIGH findings, with at most two fix rounds.

- [ ] **Step 4: Push and open the PR (maintainer approval first)**

After approval:
```bash
git push -u origin feat/s4-1-acp-scaffold
gh pr create --base main --title "feat(nax-agent-acp): S4-1 package scaffold, gates and release wiring" --body-file <body>
```

The body covers:
- the S4-1 scope (spec §10 row)
- decisions D-a to D-f
- the S4-2 gap: `NaxError` is not on `.`
- the test plan: CI jobs `nax-agent-acp`, `nax-agent-acp: node 22/24`, `tooling`, `nax`, `nax-agent`
- a statement that nothing is released

---

## Self-review notes

- **Spec coverage, §10 S4-1 row:**
  - workspace: Task 3
  - tsc build: Task 3
  - gates incl. boundary: Tasks 2 and 3
  - API snapshot: Tasks 1 and 4
  - coverage: Task 4
  - CI job: Task 9
  - release machinery §8: Tasks 5 to 8
  - context files: Task 10
- **Spec coverage, §8 sub-items:**
  - the `release.yml` tag trigger, resolve case, pre-publish checks and nax-agent peer check: Task 7
  - "The release helper learns the tag": Task 8
  - package `RELEASING.md`: Task 8
  - `.nax/context.md` and package context, then `nax generate`: Task 10
  - stage-publish rewriting `workspace:*` to `^0.3.0`: Task 5
- **Deferred by the spec, not in this plan:** the packed-tarball smoke (S4-6), the live-smoke fixture (S4-6), and `acpBackend()` (S4-2).
- **Consistent names:**
  - `peerRangeFor` and `buildStagedManifest(..., { naxAgentVersion })` (Task 5) are the ones `stage-publish.ts` and the tests use.
  - `entryPointsOf` and `ApiEntryFile` (Task 1) are used only inside repo-tooling.
  - The `tag-acp` subcommand name is the same in Task 8's code, tests, RELEASING.md and Task 10's context.
