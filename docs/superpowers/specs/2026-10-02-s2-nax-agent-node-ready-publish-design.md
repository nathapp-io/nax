# S2 — Node-ready + first publish of `nax-agent` (design)

- **Arc:** nax-agent. This is sub-project S2 of 7 (S0-S6).
- **Arc SSOT:** the nax-agent master plan, kept in the maintainer's workspace (not in this repo). It holds the arc decisions and all status. This spec holds S2's design only.
- **Date:** 2026-10-02.
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
| R3 | **Surface: `.` curated, `/internal` shipped as unstable.** `.` lists its exports by name and exports no `_` seams. `/internal` still ships (nax needs it) and is documented as nax-only and outside semver. |
| R4 | **Bun APIs: hybrid.** Bun APIs whose Node equivalents behave identically, or never leave the process, are replaced by `node:` built-ins directly. These are file read/write, sleep, hash, sha256 and which. Spawn and glob, whose behaviour the CLI or the agent can observe, go behind a `runtime` slot. It has a Node default; nax installs a Bun implementation. |
| R5 | **The Bun runtime lives in nax.** nax-agent ships no Bun code. Its no-Bun-APIs gate has no exceptions, and its build config allows Node types only. |
| R6 | **The repo resolves source; npm resolves `dist/`.** The workspace `package.json` keeps pointing at `.ts` sources. Publishing goes through a generated manifest in a staging directory. Export conditions were rejected **on measurement**: Bun applies a custom condition only with `--conditions=` on every command (a `bunfig.toml` `conditions` key had no effect), so forgetting the flag would silently run a stale `dist/`. |
| R7 | **TypeScript 7, pinned exactly.** nax-agent pins `typescript` to `7.0.2` like the root and nax-ai (today it declares `^7.0.2`; the lockfile already resolves `7.0.2`). |

## 3. Inventory (base commit)

**Bun APIs in `packages/nax-agent/src`:** 37 sites across 16 files.

| API | Sites | Disposition (R4) |
|---|---:|---|
| `Bun.spawn` | 10 (3 real call sites; the rest are comments and types) | runtime slot |
| `Bun.Glob` | 5 (`tools/glob.ts`, `tools/scratchpad.ts`) | runtime slot |
| `Bun.file` | 8 | `node:fs/promises` |
| `Bun.write` | 1 | `node:fs/promises` |
| `Bun.sleep` | 7 | `node:timers/promises` `setTimeout` |
| `Bun.hash` | 2 (`infra/spin-breaker`, in-memory dedupe keys, never persisted) | `node:crypto` |
| `Bun.CryptoHasher("sha256")` | 1 (`native/client.ts`) | `node:crypto` `createHash` |
| `Bun.which` | 3 | small `PATH` lookup over `node:fs` |

Spawn is already funnelled through `internal/bun-deps.ts` (`typedSpawn`, `spawn`), `internal/argv-exec.ts`, `internal/git-exec.ts` and `native/credentials/helper-process.ts`. Glob is already behind an injectable in `tools/glob.ts`.

**Imports:** `src/` has 412 relative import specifiers with no file extension. 20 of them name a directory. Node's ESM loader rejects both forms; Bun accepts them. The 287 `#src/*` imports all name files; the `imports` map supplies their extension.

**Tests:** 146 test files use `bun:test`. Tests contain about 70 direct `Bun.*` uses. They stay on Bun (R1).

**Surface:** `src/index.ts` is 20 `export *` lines. Through them `.` exports 16 `_…Deps` seams: tools 6, sandbox 7, command-safety 2, native 1. nax imports `@nathapp/nax-agent` from 171 sites and `@nathapp/nax-agent/internal` from 379.

**Coverage:** nax-agent's own tests reach 77.54% lines, with 54 files under 80%. nax's coverage job gates nax-agent today (96.80% lines combined).

**Helpers:** nax-agent exports `./test/helpers/*` (13 helpers). nax keeps a one-line shim per helper. Three helpers import nax-agent source (`command-safety`, `sandbox`, `systemone-stub`); ten do not.

**Gates:** nax-agent's `lint:checks` runs 15 gates from `../nax/scripts`. `check-alias-internals` is not parameterised for a package.

## 4. Runtime

### 4.1 Node built-ins (R4)

Each direct replacement keeps the call site's existing `_deps` seam, so tests that mock it are untouched:
- `Bun.file(p).text()` / `.exists()` / `.size` → `readFile`, `access`/`stat` from `node:fs/promises`. `Bun.write` → `writeFile` (with `mkdir -p` wherever Bun's implicit parent creation was relied on; the plan lists those call sites).
- `Bun.sleep(ms)` → `setTimeout` from `node:timers/promises`.
- `Bun.hash(s)` → a stable non-cryptographic digest from `node:crypto` (e.g. `createHash("sha1")`, truncated). The values change, which is safe: they are in-memory keys only.
- `new Bun.CryptoHasher("sha256")` → `createHash("sha256")`. The digest bytes are identical.
- `Bun.which(name)` → a `which()` helper that walks `PATH` and checks the executable bit. Windows is unsupported, as for nax.

### 4.2 The runtime slot (R4, R5)

nax-agent declares:

```ts
export interface AgentRuntime {
  spawn(cmd: readonly string[], opts: SpawnOptions): SpawnResult;
  glob(pattern: string, opts: GlobOptions): AsyncIterable<string>;
  globSync(pattern: string, opts: GlobOptions): Iterable<string>;
}
export function setAgentRuntime(runtime: AgentRuntime): void;
```

- `SpawnOptions` and `SpawnResult` are the types `internal/bun-deps.ts` already declares (web `ReadableStream` stdout/stderr, `exited: Promise<number>`, `pid`, optional `stdin`, `kill(signal)`, `detached`).
- `GlobOptions` covers what the two glob call sites pass today (`cwd`, `absolute`, `onlyFiles`, dotfile handling).
- **Default:** a Node implementation (`child_process.spawn` adapted to `SpawnResult` with `Readable.toWeb`; `fs.promises.glob` / `fs.globSync`, available as functions on Node 22.22 — the plan confirms they are non-experimental at the 22.19 floor or raises the floor).
- **nax** installs a Bun implementation at startup, next to `setAgentLogger`, from `packages/nax/src/agent-runtime/`. It wraps `Bun.spawn` and `Bun.Glob` exactly as today's code does, so the CLI's spawn and glob behaviour is unchanged.
- Like the logger slot, it is module-level and process-wide. S3 decides whether it becomes per-session.

### 4.3 Behaviour cases

One table of spawn and glob cases lives in `packages/test-kit` (§6.2). Both runtimes are tested against it:
- nax runs it under `bun test` against the Bun runtime.
- nax-agent's Node contract suite runs it under `vitest` against the Node runtime.

**Cases first:**
- **Spawn:** exit codes, stdout/stderr bytes, stdin write/end, environment inheritance and the `env` overlay, `cwd`, killing by signal, `detached` creating a process group whose leader PID equals the child PID, killing a process group leaving no descendants (ORPHAN-1).
- **Glob:** ordering (results are sorted by the caller), dotfiles, `onlyFiles`, relative vs absolute results, a malformed pattern, a missing `cwd`.

Where the two runtimes differ natively, the Node runtime normalises its output to the table. The table records Bun's current behaviour.

### 4.4 Gate

nax-ai's `check-no-bun-apis` moves to `packages/repo-tooling` (§6.1) and runs over nax-agent's `src/` with no exceptions. nax-agent's `tsconfig.build.json` sets `types: ["node"]`, so a stray `Bun.*` also fails the build.

## 5. Build, packaging and surface

### 5.1 Imports for Node ESM (nax-ai's model)

- A scripted codemod adds an explicit `.ts` extension to the 412 relative imports in `src/` and rewrites the 20 directory imports to `…/index.ts`. It is generated and reviewed by sampling, like the S1-5 move.
- `tsconfig.build.json`: `src/` only; `module` and `moduleResolution` `nodenext`; `allowImportingTsExtensions`; `rewriteRelativeImportExtensions`; `rootDir: src`; `outDir: dist`; `declaration: true`; `types: ["node"]`.
- Tests keep today's `bundler`-mode `tsconfig.json` and are not rewritten. A new extensionless import in `src/` fails the build step in CI.

### 5.2 Source in the repo, `dist/` on npm (R6)

The workspace `package.json` is unchanged in shape: `exports` and `imports` point at `.ts` sources, so `bun bin/nax.ts`, `bun test` and nax's `bun build` keep working with no flags.

`scripts/stage-publish.ts` builds `.publish/`:
- copies `dist/`, `README.md`, `CHANGELOG.md` and `LICENSE`;
- writes a generated `package.json`: `name` and `version` copied; `type: module`; `exports` `.` and `./internal` with `types` and `import` into `dist/`; `imports` `#src/*` → `{ "types": "./dist/*.d.ts", "default": "./dist/*.js" }`; `engines.node: ">=22.19.0"`; `dependencies` copied verbatim; no `scripts`, `devDependencies`, `private`, or `./test/helpers/*`; `publishConfig` matching nax-ai's.

`npm publish .publish/` publishes exactly the directory the CI smoke packed.

**Runtime dependencies** stay as they are: `@nathapp/nax-ai` (exact pin; must already be on npm), `@anthropic-ai/sandbox-runtime` (exact pin; loaded lazily), `zod`.

### 5.3 Surface (R3)

1. `src/index.ts` replaces `export *` with explicit `export { … }` and `export type { … }` lists.
2. All 16 `_…Deps` seams leave `.` for `/internal`. The nax tests that import them from `.` switch to `/internal` by a scripted rewrite. A gate rejects any `_`-prefixed export from `.`.
3. Otherwise `.` keeps today's content plus `setAgentRuntime` and the `AgentRuntime` types. S3 designs the embedder API; `0.x` lets it reshape `.` with a minor bump.
4. **API snapshot:** CI extracts the sorted exported names of `.` and `/internal` from the built `.d.ts` into `api/nax-agent.api.txt` and fails on any difference from the committed file.
5. `src/internal.ts` gets a header stating it is nax-only and outside semver; the README says so too.

**First version:** `0.1.0`. New `CHANGELOG.md`. The README covers install and the Node floor; the slots (logger, credentials, runtime); the three host-supplied ports that fail closed when absent (`runDeclaredCommand`, `ProtectedPathsPolicy`, `commandInterceptor`; S1-4); and the status of `/internal`.

### 5.4 nax is unchanged

nax keeps `@nathapp/nax-agent` as a `devDependency` (`workspace:*`) and bundles it. `packages/nax/package.json` `dependencies` stay byte-identical. `check-bundle-externals` keeps asserting that nax-agent is bundled.

## 6. Tooling

### 6.1 `packages/repo-tooling` (private, never published)

- Holds every check script used by more than one package: the 15 nax-agent runs today, plus `check-no-bun-apis`.
- One implementation per gate. Baselines stay in the package they govern (`<pkg>/scripts/baselines/`).
- Gates used only by nax stay in `packages/nax/scripts`.
- `check-alias-internals` gains `--package` and is wired for nax-agent.
- nax, nax-agent and nax-ai call the gates through the workspace package, not through `../nax/scripts`.

### 6.2 `packages/test-kit` (private, never published)

- Holds the ten generic helpers (`absent`, `assert-defined`, `deps`, `fake-clock`, `fs`, `mock-fetch`, `session-tmp-deps`, `spawn`, `temp`, `timeout`) and the runtime behaviour cases (§4.3).
- It has no dependency on nax-agent, so there is no package cycle.
- nax's shims are retargeted to it (or deleted where nothing uses them). nax-agent's `./test/helpers/*` export is removed.
- The three helpers that import nax-agent source (`command-safety`, `sandbox`, `systemone-stub`) stay unexported inside nax-agent. After the test port the plan measures which nax tests still use them; those get an equivalent built on `/internal` in nax's own `test/helpers` (at most three files). The export is never restored.

## 7. Tests and coverage

### 7.1 Porting the 177 tests (R2)

A script sorts every nax test that reaches nax-agent code:
- **Move:** every import resolves to nax-agent, `/internal`, test-kit or a helper. The file keeps its name under `packages/nax-agent/test/`.
- **Stay:** it imports a nax module that is not a helper. It tests nax's wiring and stays in nax.
- **Unblock, then move:** the 8 blocked only by a nax-bound helper (`mock-logger`, `warn-spy`, `assert-nax-error`, `mock-nax-config`, `runtime`). Each gets an equivalent built on nax-agent's own ports (for example, a capture logger installed through `setAgentLogger`) and then moves.

The total test count is conserved across the two packages at each move. No test is edited to make it pass.

### 7.2 nax-agent's own coverage gate

- `check-coverage` gains `--package`. In nax-agent it runs nax-agent's unit and integration suites under nax-agent's preload and applies nax's floors: 80% lines, 80% functions, 80% per file, and an **empty** per-file baseline at publish time (R2).
- The gap left after the port is closed with new tests in nax-agent, never by lowering a floor.
- Once nax-agent's gate is green, nax's `check-coverage` drops the nax-agent suites and the `../nax-agent/src/` scope, and nax's own floors are re-measured on nax alone.
- The `nax-agent` CI job gains the coverage step.

### 7.3 Node contract suite (R1)

`packages/nax-agent/test/node/`, run by `vitest` in a new CI matrix job on Node 22 and Node 24 (Ubuntu and macOS for the spawn cases):
- the runtime behaviour cases against the Node runtime;
- one test per Node built-in replacement (§4.1);
- **the tarball smoke:** `stage-publish`, then `npm pack .publish/`, then install into a temporary Node project, then `import` from `@nathapp/nax-agent`. Against a stub provider it runs one tool round-trip and one native session turn. On Linux it also runs one sandboxed command.

## 8. Release

- `release.yml` gains tag patterns `nax-agent-v*.*.*` and `nax-agent-v*.*.*-canary.*` and a `nax-agent-v*` arm in "Resolve package".
- Pre-publish for nax-agent: `check:all`, typecheck, build, the Node contract suite (including the tarball smoke), then `npm publish .publish/ --access public --provenance`.
- The "pin is published" step also runs for nax-agent's `@nathapp/nax-ai` pin.
- `packages/nax-agent/scripts/release.ts`, modelled on nax-ai's, bumps the version and changelog and creates the tag.
- **Open item for the plan:** npm trusted publishing (OIDC) is configured per package on npmjs.com, which may require the package to exist first. The plan checks npm's current documentation before S2-9 and states whether `0.1.0` needs a one-off publish by the maintainer.
- `.nax/context.md` (Layout and Releases) and nax-agent's package context stop calling nax-agent private-only and add the `nax-agent-vX.Y.Z` tag and its release order (nax-ai first, then nax-agent, then nax); the generated agent files are regenerated with `nax generate`.
- Nothing is published without the maintainer's approval of that release.

## 9. Delivery

Small PRs merged to `main`, each green and behaviour-neutral for the nax CLI.

| PR | Content | Depends on |
|---|---|---|
| S2-0 | `repo-tooling` and `test-kit` packages; gates moved; shims retargeted | — |
| S2-1 | Sort the 177 tests; move the movable ones | S2-0 |
| S2-2 | Unblock the 8; move them | S2-1 |
| S2-3 | Close the coverage gap; nax-agent's own coverage gate; nax stops counting nax-agent | S2-2 |
| S2-4 | Runtime slot: spawn (Node default + nax's Bun runtime) and its behaviour cases | S2-0 |
| S2-5 | Runtime slot: glob; Node built-ins for file, sleep, hash, sha256, which; no-Bun gate on | S2-4 |
| S2-6 | Import codemod, `tsconfig.build.json`, build | S2-5 |
| S2-7 | Curated `.`, seams to `/internal`, API snapshot, README, CHANGELOG | S2-3, S2-6 |
| S2-8 | `stage-publish`, Node contract suite, tarball smoke in CI | S2-7 |
| S2-9 | Release wiring; `0.1.0` (with approval) | S2-8 |

S2-4 to S2-6 can run in parallel with S2-1 to S2-3. S2-7 waits for both: moving the seams rewrites imports in tests that S2-1 to S2-3 move.

## 10. Acceptance

1. `check-no-bun-apis` is green on nax-agent's `src/` with no exceptions, and the build config allows Node types only.
2. On Node 22 and Node 24, the packed tarball imports and completes one tool round-trip and one native session turn against a stub provider.
3. nax-agent's own coverage gate is green (80% overall and per file, empty baseline). nax's coverage job no longer counts nax-agent.
4. The API snapshot is committed; `.` exports no `_` name; `./test/helpers/*` is gone.
5. The nax CLI is unchanged:
   - `packages/nax/package.json` `dependencies` are byte-identical and nax-agent is bundled;
   - the md5s of `--help`, `config`, `auth list`, `agents` and `models` output match the base commit;
   - a billed `nax run` smoke on the S1 acceptance recipe (same PRD, fresh clone, `nax trust add --yes`) gives the same story outcome, a shape-identical tool-audit ledger and the same cost-row schema. It needs approval at launch.
6. The arc SSOT records every PR and these rulings.

## 11. Risks

- **Spawn semantics** (process groups, `detached`, group kill) are where Node and Bun most likely differ. They lead the behaviour cases and run on both runtimes on Linux and macOS.
- **Glob semantics** (dotfiles, ordering, malformed patterns) differ between `fs.glob` and `Bun.Glob`. The Node runtime normalises to the cases.
- **`fs.glob` at the Node floor.** If it is still experimental at 22.19, the plan raises the floor or ships a small walker; it does not add a dependency without saying so.
- **`@anthropic-ai/sandbox-runtime` on Node.** It is loaded lazily; the tarball smoke runs one sandboxed command on Linux.
- **Test-port size.** It is split over three PRs, each conserving the test count.
