# S2 — Node-ready + first publish of `nax-agent` (design)

- **Arc:** nax-agent. This is sub-project S2 of 7 (S0-S6).
- **Arc SSOT:** the nax-agent master plan, kept in the maintainer's workspace (not in this repo). It holds the arc decisions and all status. This spec holds S2's design only.
- **Date:** 2026-10-02. Revised the same day after a final review: two read-only reviewers checked it against the codebase and probed the build and runtime claims.
- **Base:** `main` @ `6419e1a3f` (S1 complete; S1 acceptance smoke passed 2026-10-02).
- **Inputs:** every count below was measured on the base commit.

## 1. Goal

Publish `@nathapp/nax-agent` to npm so an embedder running on Node (>= 22.19) can install it and run the native agent. The nax CLI stays behaviourally unchanged.

**Done means:**
- nax-agent's shipped source uses no Bun API. A tarball built from it imports and runs on Node 22 and Node 24.
- nax-agent gates its own coverage on its own tests: 80% lines and functions overall, and 80% per file with no baseline exceptions.
- The published surface is explicit, snapshotted and free of test seams.
- `nax run` behaves exactly as before, and nax still bundles nax-agent.

**Out of scope:** the conversational session API (S3); the acpx backend (S4); hoisting Biome rules (a separate chore); `docs/architecture` paths (#2323); shrinking `/internal`.

## 2. Rulings (from the S2 brainstorm, 2026-10-02)

| # | Ruling |
|---|---|
| R1 | **Node is proven by a contract suite, not by porting the suite.** The existing `bun:test` suite stays as it is. A small `vitest` suite runs on Node 22 and 24. It covers the Node runtime's behaviour cases, each Node built-in replacement and a smoke run against the packed tarball. |
| R2 | **S2 includes the test port and the self-hosted coverage gate.** nax-agent publishes only once it gates its own coverage (>= 80% per file on its own tests, no baseline exceptions). |
| R3 | **Surface: `.` curated, `/internal` shipped as unstable.** `.` lists its exports by name and exports no `_` name. `/internal` still ships (nax needs it) and is documented as nax-only and outside semver. |
| R4 | **Bun APIs: hybrid.** Bun APIs whose Node equivalents behave identically, or never leave the process, are replaced by `node:` built-ins directly. These are file read/write, sleep, hash, sha256 and which. Spawn and glob, whose behaviour the CLI or the agent can observe, go behind a `runtime` slot. It has a Node default; nax installs a Bun implementation. |
| R5 | **The Bun runtime lives in nax.** nax-agent ships no Bun code. Its no-Bun-APIs gate has no exceptions, and its build config allows Node types only. |
| R6 | **The repo resolves source; npm resolves `dist/`.** The workspace `package.json` keeps pointing at `.ts` sources. Publishing goes through a generated manifest in a staging directory. Export conditions were rejected **on measurement**: Bun applies a custom condition only with `--conditions=` on every command (a `bunfig.toml` `conditions` key had no effect), so forgetting the flag would silently run a stale `dist/`. |
| R7 | **TypeScript 7, pinned exactly.** nax-agent pins `typescript` to `7.0.2` like the root and nax-ai (today it declares `^7.0.2`; the lockfile already resolves `7.0.2`). |

## 3. Inventory (base commit)

**Bun APIs in `packages/nax-agent/src`:** 37 text occurrences across 16 files. Most are comments and types. The real code sites are:

| API | Real code sites | Disposition |
|---|---|---|
| `Bun.spawn` | `internal/bun-deps.ts:40` (`typedSpawn`), `:96` (`spawn` re-export), `native/credentials/helper-process.ts:66` (direct) | runtime slot (§4.2); nax's uses move to nax (§4.4) |
| `Bun.Glob` | `tools/glob.ts:42`, `tools/scratchpad.ts:178` (`scanSync`) | runtime slot |
| `Bun.file` | 5, incl. `permissions/approvals-store.ts:147`, `tools/read-file.ts:67` (`.size`), `tools/scratchpad.ts:120` (`.size`), `sandbox/git-guards.ts:64` | `node:fs` (§4.1) |
| `Bun.write` | `tools/spill.ts:52` (its caller already `mkdir`s, `spill.ts:107`) | `node:fs/promises` `writeFile` |
| `Bun.sleep` | `internal/bun-deps.ts:50` | `node:timers/promises` |
| `Bun.which` | `internal/bun-deps.ts:45` | `PATH` lookup over `node:fs` |
| `Bun.hash` | `infra/spin-breaker/index.ts:154`, `:166` (in-memory dedupe keys, never persisted) | `node:crypto` |
| `Bun.CryptoHasher("sha256")` | `native/client.ts:172` | `node:crypto` `createHash` (identical bytes) |

The `Bun.spawn` mentions in `internal/argv-exec.ts`, `internal/git-exec.ts` and `tools/run-command-exec.ts` are comments, but their `_deps` seams (and `tools/grep.ts`'s) are typed `typeof Bun.spawn`. No `Bun.spawnSync`, `Bun.env`, `Bun.stdin`, `Bun.serve`, `import.meta.dir`, `bun:` import or `globalThis.Bun` exists in `src/`.

**`/internal` re-exports Bun-backed helpers to nax:** `src/internal.ts:27` does `export * from "#src/internal/bun-deps"`, which hands nax `spawn` (`typeof Bun.spawn`), `typedSpawn`, `which`, `sleep` and `file`. nax imports them at 16 or more sites (e.g. `verification/executor.ts`, `version-detection.ts`, `acp/spawn-client-deps.ts`, `adapter-lifecycle.ts`, `run-initialization.ts`, `merge-conflict-rectify.ts`).

**Imports:** `src/` has 412 relative import specifiers with no file extension (static `from`, `export … from`, and `import("…")` type expressions); 20 of them name a directory. Node's ESM loader rejects both forms; Bun accepts them. The 287 static `#src/*` imports all name files; the `imports` map supplies their extension.

**Tests:** 145 test files import `bun:test`; tests contain 67 direct `Bun.*` lines. They stay on Bun (R1).

**Surface:** `src/index.ts` is 18 `export *` lines plus 2 named lines. Through them `.` exports **20** `_`-prefixed names: 17 `…Deps` seams (`_adapterDeps`, `_approvalsTaintDeps`, `_bashToolDeps`, `_codingToolDeps`, `_commandShadowDeps`, `_editDeps`, `_gitGuardDeps`, `_globDeps`, `_grepDeps`, `_launcherDeps`, `_policyInputDeps`, `_probeDeps`, `_sandboxRegistryDeps`, `_sessionTmpDeps`, `_spillDeps`, `_srtBackendDeps`, `_systemOneClientDeps`) and 3 reset hooks (`_resetBuiltinsForTest`, `_resetRegistryForTest`, `_resetSandboxRegistryForTests`). nax imports `@nathapp/nax-agent` from 171 sites and `@nathapp/nax-agent/internal` from 379.

**Coverage:** nax-agent's own tests reach 77.54% lines, with 54 files under 80%. nax's coverage job gates nax-agent today (96.80% lines combined). nax's per-file baseline holds 2 nax-only files.

**Helpers:** nax-agent exports `./test/helpers/*` (13 helpers). nax re-exports them through shims and its `test/helpers/index.ts`. Three helpers import nax-agent source (`command-safety`, `sandbox`, `systemone-stub`). Several are Bun-test-specific (`deps.ts` and `spawn.ts` import from `bun:test`; `spawn.ts` types against `typeof Bun.spawn`).

**Gates:** nax-agent's `lint:checks` runs 15 gates from `../nax/scripts`. `check-alias-internals` is not run for nax-agent and takes no package argument. Three gates (`check-nax-error`, `check-complexity`, `check-test-satellites`) import `byCodePoint` from `@nathapp/nax-agent/internal`. 38 nax test files, and nax-agent's `test/unit/tools/policy.test.ts`, reference `scripts/check-*` paths. `check-package-boundaries` is default-deny for any `packages/*` directory without a rule, allows `bun`/`bun:` builtins for nax-agent (`:83`), and allows `@nathapp/nax-agent/test/helpers/*` for nax (`:51`).

## 4. Runtime

### 4.1 Node built-ins (R4)

Replacements happen in place. Only `git-guards.ts:64` and `spill.ts:52` sit behind a `_deps` seam today; those seams keep their names and shapes. Semantics to preserve:
- **`approvals-store.ts:147`** (`exists()` then `text()`) → `readFile`, mapping **only** `ENOENT` to "missing". `EACCES` and other errors still propagate, as its doc comment requires.
- **`.size` reads** (`read-file.ts:67`, `scratchpad.ts:120`) are synchronous today → `statSync(p).size`. Bun reports 0 for a missing file where `stat` throws; each site keeps its current behaviour (catch `ENOENT` → 0) unless the plan shows the file is guaranteed to exist.
- **`Bun.write`** → `writeFile`. No call site relies on implicit parent creation.
- **`Bun.sleep(ms)`** → `setTimeout` from `node:timers/promises`.
- **`Bun.hash(s)`** → `createHash("sha256")`, first 16 hex characters (64 bits), so spin-breaker keys keep at least Bun.hash's 64-bit collision resistance. The values change, which is safe: they are in-memory keys only.
- **`new Bun.CryptoHasher("sha256")`** → `createHash("sha256")`. The digest bytes are identical.
- **`Bun.which(name)`** → a `which()` helper that walks `PATH` and checks the executable bit. Windows is unsupported, as for nax.

### 4.2 The runtime slot (R4, R5)

nax-agent declares, in `src/runtime/`:

```ts
export interface AgentRuntime {
  spawn(cmd: readonly string[], opts: SpawnOptions): SpawnResult;
  glob(pattern: string, opts: GlobOptions): AsyncIterable<string>;
  globSync(pattern: string, opts: GlobOptions): Iterable<string>;
}
export function setAgentRuntime(runtime: AgentRuntime): void;
export function getAgentRuntime(): AgentRuntime; // Node default when unset
```

**`SpawnOptions`** is today's (`cwd`, `stdin`, `stdout`, `stderr`, `env`, `detached`). **`SpawnResult`** extends today's (`stdout`/`stderr` web `ReadableStream`, `exited: Promise<number>`, `pid`, optional `stdin`, `kill(signal)`) with:
- `exitCode: number | null` and `signalCode: string | null`. `helper-process.ts` branches on `exitCode === null` ("killed before it could answer").
- **Signal exit:** `exited` resolves to `128 + signal number` and `exitCode` is `null` (Bun: `kill("SIGKILL")` → `exited` 137, `signalCode` `"SIGKILL"`; measured).
- **Spawn failure is synchronous:** a missing binary or a missing `cwd` throws from `spawn()` (Bun's behaviour, measured; callers such as `grep.ts:115` and `helper-process.ts:275` rely on try/catch).
- **stdin:** `write()` returns the byte count; `end()`; `flush()` (a no-op where the runtime has nothing to flush). `EPIPE` on write is surfaced the way `helper-process.ts:161` expects.
- With `stderr: "inherit"` there is no stream to read; callers that inherit never read it, and the Node runtime returns an empty stream to keep the type total.

**`GlobOptions`** offers only what both runtimes honour: `cwd`, `absolute`. Results are **files only** and **exclude dotfiles**, which is what both call sites use today (Bun's defaults). A missing `cwd` throws `ENOENT` (Bun's behaviour).

**Node default** (`src/runtime/node-runtime.ts`):
- `spawn`: `child_process.spawn` adapted to `SpawnResult` (`Readable.toWeb` for streams; the `close` event's `(code, signal)` mapped as above; pre-checks `cwd` with `statSync` and the binary with the `which()` helper so failure stays synchronous; `detached: true` calls `setsid`, so process-group kill keeps the ORPHAN-1 fix).
- `glob`/`globSync`: `fs.promises.glob` / `fs.globSync` with `withFileTypes`, filtered to files, dot-segments excluded, paths made relative or absolute per `absolute`. Both functions exist without an experimental warning on Node 22.22; S2-5 confirms the status at exactly 22.19.0 in CI and raises the floor if needed.

**Install point.** nax installs its Bun runtime from a side-effect module, `packages/nax/src/agent-runtime/install.ts`, imported **first** in `packages/nax/bin/nax.ts` and in `packages/nax/test/preload.ts`. It is not tied to `initLogger` (which can be skipped, e.g. `--help`) and is never reset. So every nax CLI path and every nax test runs the Bun runtime. nax-agent's own tests cannot import nax, so they run the Node default under Bun; that is intended (it is also how the Node runtime is covered, §7.2).

Like the logger slot, the runtime slot is module-level and process-wide. S3 decides whether it becomes per-session.

### 4.3 Behaviour cases

One table of spawn and glob cases lives in the **runner-neutral** part of `packages/test-kit` (`cases/`, §6.2). It is plain data plus assertions over an `AgentRuntime`, with no `bun:test`, `vitest` or Bun types. It is run three ways:
- nax: `bun test` against the Bun runtime;
- nax-agent: `bun test` against the Node default (counted by the coverage gate);
- nax-agent: `vitest` on real Node 22.19.0, 22 latest and 24, Ubuntu and macOS (the contract suite, §7.3).

**Spawn cases:** exit codes; stdout/stderr bytes; `new Response(stdout).text()` and `stdout.cancel()`; stdin `write` byte count, `end`, `flush`; `EPIPE` on write after the child exits; `env` inheritance and overlay; `cwd`; a missing binary and a missing `cwd` throwing synchronously; kill by signal (`exited` = 128+n, `exitCode` null, `signalCode` set); `detached` making the child its own process-group leader; killing the group leaving no descendants (ORPHAN-1).

**Glob cases:** files only (no directories); dotfiles excluded; relative vs absolute; sorted by the caller; braces and character classes; a malformed pattern; a missing `cwd`; a symlinked file and a symlinked directory (the case records Bun's behaviour; the Node runtime matches it).

Where the two runtimes differ natively, the Node runtime normalises to the table. The table records Bun's current behaviour.

### 4.4 What happens to `internal/bun-deps.ts`

- **The file moves to nax** as `packages/nax/src/utils/bun-deps.ts`, unchanged: `spawn`, `typedSpawn`, `which`, `sleep` and `file` keep wrapping Bun directly for nax. nax's 16+ import sites switch from `@nathapp/nax-agent/internal` to the local module (scripted). nax's own spawn paths therefore keep today's behaviour and do not go through the slot.
- **nax-agent's own users** switch to the slot (`getAgentRuntime().spawn`) or the §4.1 helpers. `helper-process.ts:66` moves onto the slot.
- **The spawn type** for nax-agent's seams (`argv-exec`, `git-exec`, `grep`, `run-command-exec`) changes from `typeof Bun.spawn` to `AgentRuntime["spawn"]`. Tests that stub those seams retype their stubs; the spawn stub helper (`test/helpers/spawn.ts`) gains an `AgentRuntime`-typed variant.
- `SpawnOptions` and `SpawnResult` stay in nax-agent (they are the runtime contract); nax's `bun-deps.ts` imports them as types.

### 4.5 Gate

nax-ai's `check-no-bun-apis` moves to `packages/repo-tooling` (§6.1), gains `--package=<dir>`, and runs over nax-agent's `src/` with no exceptions. It is widened to catch `globalThis.Bun`, `typeof Bun` and `import.meta.dir`. Single-line `/** … Bun.x */` comments in nax-agent are reworded so the gate stays exact. `check-package-boundaries` stops allowing `bun`/`bun:` for nax-agent. nax-agent's `tsconfig.build.json` sets `types: ["node"]`, so a stray `Bun.*` also fails the build.

## 5. Build, packaging and surface

### 5.1 Imports for Node ESM (nax-ai's model)

- A scripted codemod adds an explicit `.ts` extension to the 412 relative specifiers in `src/` (static `from`, `export … from`, and `import("…")` type expressions) and rewrites the 20 directory imports to `…/index.ts`. It is generated and reviewed by sampling, like the S1-5 move.
- `tsconfig.build.json` extends `tsconfig.json`: `include: ["src/**/*.ts"]`; `module` and `moduleResolution` `nodenext`; `allowImportingTsExtensions`; `rewriteRelativeImportExtensions`; `noEmit: false`; `declaration: true`; `rootDir: src`; `outDir: dist`; `types: ["node"]`. Probed: tsc 7.0.2 emits `./x.js` for `./x.ts`, keeps `#src/…` in JS and `.d.ts`, and the result runs on Node 22.22.
- **`allowImportingTsExtensions: true`** is added to nax-agent's `tsconfig.json` (tests stay in `bundler` mode and are not rewritten) **and** to `packages/nax/tsconfig.json`, which typechecks nax-agent sources through the workspace link. Without it both fail with TS5097 (probed).
- Gates that resolve specifiers (`import-specifiers.ts`, `check-import-cycles`' `RESOLVE_SUFFIXES`, `check-alias-internals`, `check-sandbox-imports`, `check-nax-ai-imports`, `check-package-boundaries`, the Biome plugins) learn explicit `.ts` specifiers before the codemod lands.
- A new extensionless import in `src/` fails the build step in CI.

### 5.2 Source in the repo, `dist/` on npm (R6)

The workspace `package.json` keeps `private: true` and source-pointing `exports`/`imports`, so `bun bin/nax.ts`, `bun test` and nax's `bun build` keep working with no flags. It gains scripts `build` (`tsc -p tsconfig.build.json`), `stage-publish`, `test:node` (`vitest --run`), `release`, and devDependencies `vitest` (nax-ai's version) and `@types/node`. The lockfile is updated in the same PR.

`scripts/stage-publish.ts` builds `.publish/`:
- copies `dist/`, `README.md`, `CHANGELOG.md` and `LICENSE`;
- writes a generated `package.json`: `name`, `version`, `description`, `license`, `author`, `homepage`, `bugs`, `keywords` copied; `repository: { type: "git", url: "git+https://github.com/nathapp-io/nax.git", directory: "packages/nax-agent" }` (provenance requires the URL to match the publishing repo; the script asserts it against `$GITHUB_REPOSITORY` when set); `type: module`; `exports` `.` and `./internal` with `types` and `import` into `dist/`; `imports` `#src/*` → `{ "types": "./dist/*.d.ts", "default": "./dist/*.js" }`; `engines.node: ">=22.19.0"`; `dependencies` copied verbatim; `publishConfig` matching nax-ai's; no `scripts`, `devDependencies`, `private`, or `./test/helpers/*`.

`npm publish .publish/` publishes exactly the directory the CI smoke packed.

**Runtime dependencies** stay as they are: `@nathapp/nax-ai` (exact pin; must already be on npm), `@anthropic-ai/sandbox-runtime` (exact pin; loaded lazily; `engines.node >= 20.11`), `zod`.

### 5.3 Surface (R3)

1. `src/index.ts` replaces `export *` with explicit `export { … }` and `export type { … }` lists.
2. All **20** `_`-prefixed names (§3) leave `.` for `/internal`. The nax tests that import them from `.` switch to `/internal` by a scripted rewrite. A gate rejects any `_`-prefixed export from `.`.
3. Otherwise `.` keeps today's content plus `setAgentRuntime`, `getAgentRuntime` and the runtime types. S3 designs the embedder API; `0.x` lets it reshape `.` with a minor bump.
4. **API snapshot:** CI extracts the sorted exported names of `.` and `/internal` from the built `.d.ts` into `api/nax-agent.api.txt` and fails on any difference from the committed file.
5. `src/internal.ts` gets a header stating it is nax-only and outside semver; the README says so too.

**First version:** `0.1.0`. New `CHANGELOG.md`. The README covers install and the Node floor; the slots (logger, credentials, runtime); the three host-supplied ports that fail closed when absent (`runDeclaredCommand`, `ProtectedPathsPolicy`, `commandInterceptor`; S1-4); and the status of `/internal`.

### 5.4 nax is unchanged

nax keeps `@nathapp/nax-agent` as a `devDependency` (`workspace:*`) and bundles it. `packages/nax/package.json` `dependencies` stay byte-identical. `check-bundle-externals` keeps asserting that nax-agent is bundled.

## 6. Tooling

### 6.1 `packages/repo-tooling` (private, never published)

- Holds every check script used by more than one package: the 15 nax-agent runs today, plus `check-no-bun-apis` (§4.5). Their tests move with them (from the 38 nax test files and nax-agent's `policy.test.ts`); tests of nax-only gates stay.
- **No package dependencies.** The three gates that import `byCodePoint` from nax-agent use a local copy of that one-line comparator, so there is no `repo-tooling` ↔ `nax-agent` cycle.
- One implementation per gate. Baselines stay in the package they govern (`<pkg>/scripts/baselines/`).
- Gates used only by nax stay in `packages/nax/scripts`.
- `check-alias-internals` gains `--package` and is **newly wired** into nax-agent's `lint:checks`.
- nax, nax-agent and nax-ai call the gates through the workspace package path, not `../nax/scripts`.
- `check-package-boundaries` gains rules for `packages/repo-tooling` (imports `node:` and itself only) and `packages/test-kit` (§6.2), and loses the `@nathapp/nax-agent/test/helpers/*` allowance once the export is gone.

### 6.2 `packages/test-kit` (private, never published)

Two parts, each with its own subpath export:
- **`@nathapp/nax-test-kit/cases`**: runner-neutral, Bun-type-free. The runtime behaviour cases (§4.3). Imported by Bun tests and by vitest.
- **`@nathapp/nax-test-kit/bun`**: the ten generic helpers (`absent`, `assert-defined`, `deps`, `fake-clock`, `fs`, `mock-fetch`, `session-tmp-deps`, `spawn`, `temp`, `timeout`). They may use `bun:test` and Bun APIs; only Bun suites import them.

test-kit depends on no nax package, so there is no cycle. nax's shims and its `test/helpers/index.ts` re-exports are retargeted to `@nathapp/nax-test-kit/bun` (or deleted where unused). nax-agent's `./test/helpers/*` export is removed.

The three helpers that import nax-agent source (`command-safety`, `sandbox`, `systemone-stub`) stay unexported inside nax-agent. After the test port the plan measures which nax tests still use them; those get an equivalent built on `/internal` in nax's own `test/helpers` (at most three files). The export is never restored.

## 7. Tests and coverage

### 7.1 Porting the 177 tests (R2)

A script sorts every nax test that reaches nax-agent code:
- **Move:** every import resolves to nax-agent, `/internal`, test-kit or a helper. The file keeps its name under `packages/nax-agent/test/`.
- **Stay:** it imports a nax module that is not a helper. It tests nax's wiring and stays in nax.
- **Unblock, then move:** the 8 blocked only by a nax-bound helper (`mock-logger`, `warn-spy`, `assert-nax-error`, `mock-nax-config`, `runtime`). Each gets an equivalent built on nax-agent's own ports (for example, a capture logger installed through `setAgentLogger`) and then moves.

The total test count is conserved across the two packages at each move. No test is edited to make it pass.

**Measurement checkpoint:** S2-2 ends by measuring nax-agent's own coverage after both moves (overall lines/functions and the list of files under 80%). That list is S2-3's work list; S2-3 is split further if the list is long.

### 7.2 nax-agent's own coverage gate

- `check-coverage` (moves to repo-tooling) gains `--package`. In nax-agent it runs nax-agent's unit and integration suites, plus the behaviour cases against the Node runtime (§4.3), under nax-agent's preload, and applies nax's floors: 80% lines, 80% functions, 80% per file, and an **empty** per-file baseline at publish time (R2).
- **Files on disk, not just files in the report:** the gate enumerates `src/**/*.ts` and fails on any file missing from the lcov report. Today's missing-file guard (`check-coverage.ts:49-58`) only checks baselined files, which an empty baseline would turn into a silent pass.
- The gap is closed with new tests in nax-agent, never by lowering a floor.
- Once nax-agent's gate is green, nax's `check-coverage` drops the nax-agent suites and the `../nax-agent/src/` scope, and nax's own floors are re-measured on nax alone.
- The `nax-agent` CI job gains the coverage step.

### 7.3 Node contract suite (R1)

`packages/nax-agent/test/node/`, run by `vitest` in a new CI matrix job: Node 22.19.0, Node 22 latest and Node 24, on Ubuntu, plus macOS for the spawn cases:
- the runtime behaviour cases against the Node runtime;
- one test per Node built-in replacement (§4.1);
- **the tarball smoke:** `build`, `stage-publish`, `npm pack .publish/`, install into a temporary Node project, then `import` from `@nathapp/nax-agent`. Against a stub provider it runs one tool round-trip and one native session turn. On Linux it also runs one sandboxed command.

## 8. Release

`release.yml` changes:
- tag patterns `nax-agent-v*.*.*` and `nax-agent-v*.*.*-canary.*`; a `nax-agent-v*` arm in "Resolve package", placed before `v*`;
- "Set release info" gains a nax-agent arm: `0.x` versions are marked prerelease (as nax-ai's are), canaries go to the `canary` dist-tag;
- "Pre-publish checks" gains a nax-agent arm: `check:all`, typecheck, `build`, `test:node` (Ubuntu, Node 24 — the full Node matrix runs in CI before merge), `stage-publish`;
- "Publish to npm" publishes `.publish/` for nax-agent (`npm publish .publish/ --access public --provenance`); nax and nax-ai keep publishing their package directory;
- the "pin is published" step also runs for nax-agent's `@nathapp/nax-ai` pin;
- "Validate version" and "Extract release notes" read nax-agent's workspace `package.json` and `CHANGELOG.md`, which works unchanged.

`packages/nax-agent/scripts/release.ts`, modelled on nax-ai's, bumps the version and changelog and creates the tag.

**First publish:** npm trusted publishing (OIDC) is configured on an existing package. npm currently has no flow for a package that does not exist yet, so **`0.1.0` is expected to need a one-off publish by the maintainer** (from `.publish/`, without provenance), after which the maintainer adds the trusted publisher (repository `nathapp-io/nax`, workflow `release.yml`, environment `npm`) and every later version publishes from CI with provenance. S2-9 re-checks npm's documentation and states the exact steps.

`.nax/context.md` (Layout and Releases) and nax-agent's package context stop calling nax-agent private-only and add the `nax-agent-vX.Y.Z` tag and its release order (nax-ai first, then nax-agent, then nax); the generated agent files are regenerated with `nax generate`.

Nothing is published without the maintainer's approval of that release.

## 9. Delivery

Small PRs merged to `main`, each green and behaviour-neutral for the nax CLI.

| PR | Content | Depends on |
|---|---|---|
| S2-0 | `repo-tooling` (gates + their tests, `byCodePoint` copy, `check-package-boundaries` rules) and `test-kit` (`cases/` empty, `bun/` helpers); shims retargeted; `./test/helpers/*` export removed | — |
| S2-1 | Sort the 177 tests; move the movable ones | S2-0 |
| S2-2 | Unblock the 8; move them; **measure** nax-agent's own coverage | S2-1 |
| S2-3 | Close the coverage gap; `check-coverage --package` with the on-disk file check; nax-agent's own gate; nax stops counting nax-agent | S2-2 |
| S2-4 | `bun-deps.ts` to nax; runtime slot with spawn (Node default + nax's Bun runtime + install module); spawn behaviour cases; seam retyping | S2-0 |
| S2-5 | Runtime slot: glob; Node built-ins (§4.1); glob cases; `check-no-bun-apis` on with no exceptions; Node 22.19.0 `fs.glob` confirmed | S2-4 |
| S2-6 | Specifier-resolving gates learn `.ts`; `allowImportingTsExtensions` in nax-agent and nax tsconfigs; import codemod; `tsconfig.build.json`; `build` | S2-5 |
| S2-7 | Curated `.`, the 20 `_` names to `/internal`, API snapshot, README, CHANGELOG | S2-3, S2-6 |
| S2-8 | `stage-publish`, Node contract suite, tarball smoke, CI matrix job | S2-7 |
| S2-9 | Release wiring, context update; `0.1.0` (with approval; first publish by the maintainer) | S2-8 |

S2-4 to S2-6 can run in parallel with S2-1 to S2-3. Conflict risk: S2-1/S2-2 move tests, while S2-4 retypes test stubs and S2-6's codemod rewrites `src/`. Whichever lands second rebases; the codemod and the moves are scripted, so they are re-run rather than hand-merged. S2-7 waits for both tracks because it rewrites seam imports in tests the port moves.

## 10. Acceptance

1. `check-no-bun-apis` is green on nax-agent's `src/` with no exceptions; the build config allows Node types only; `check-package-boundaries` allows no `bun` import in nax-agent.
2. On Node 22.19.0, Node 22 latest and Node 24, the packed tarball imports and completes one tool round-trip and one native session turn against a stub provider.
3. nax-agent's own coverage gate is green (80% overall and per file, empty baseline, every `src/` file present in the report). nax's coverage job no longer counts nax-agent.
4. The API snapshot is committed; `.` exports no `_` name; `./test/helpers/*` is gone.
5. The nax CLI is unchanged:
   - `packages/nax/package.json` `dependencies` are byte-identical and nax-agent is bundled;
   - the md5s of `--help`, `config`, `auth list`, `agents` and `models` output match the base commit;
   - a billed `nax run` smoke on the S1 acceptance recipe (same PRD, fresh clone, `nax trust add --yes`) gives the same story outcome, a shape-identical tool-audit ledger and the same cost-row schema. It needs approval at launch.
6. The arc SSOT records every PR and these rulings.

## 11. Risks

- **Spawn semantics** (sync failure, signal exit codes, process groups, `detached`, group kill) are where Node and Bun differ most. They lead the behaviour cases and run on both runtimes, Linux and macOS.
- **Glob semantics** (directories, dotfiles, braces, symlinks, missing `cwd`) differ between `fs.glob` and `Bun.Glob`. The Node runtime filters and normalises to the cases.
- **`fs.glob` at the Node floor.** If it is experimental at 22.19.0, the floor rises; no dependency is added without saying so.
- **`@anthropic-ai/sandbox-runtime` on Node.** It is loaded lazily and declares Node >= 20.11; its own `which` falls back from `Bun.which` to `spawnSync`. The tarball smoke runs one sandboxed command on Linux.
- **Test-port size.** It is split over three PRs with a measurement checkpoint, each conserving the test count.
- **First publish.** Expected to need a manual maintainer publish without provenance (§8).
