# Agent Instructions

This file is auto-generated from `.nax/context.md`.
DO NOT EDIT MANUALLY — run `nax generate` to regenerate.

These instructions apply to all AI coding agents in this project.

---

## Project Metadata

> Auto-injected by `nax generate`

**Project:** `@nathapp/nax-agent`

**Language:** TypeScript

**Key dependencies:** zod, @types/bun, bun-types, typescript, vitest

**Commands:** test: `bun run test` | lint: `bun run check:all` | typecheck: `bun run typecheck`

---
# nax-agent — nax's native coding agent, as a package

`@nathapp/nax-agent` holds the native coding agent: the session contract, the native
session adapter and its turn loop, the tool set, permission resolution, the OS sandbox,
command-safety, cost, config and the process-level helpers beneath them. nax keeps the
orchestration — the runner, the pipeline, the agent registry, `AgentAdapter` — and reaches
the agent through this one package.

The workspace manifest remains `private: true` and resolves `.ts` source. The npm
library uses the generated `.publish/` manifest pointing at Node ESM `dist/`.
nax keeps a workspace devDependency and bundles the same source; its
`bun run check:bundle-externals` asserts the agent is inlined into `dist/nax.js`.
Releases are lockstep with the other published nax packages (repo-root `RELEASING.md`); tags publish through OIDC with provenance.

`@nathapp/nax-agent-acp` peers on this package at the same version (S4 R10): the
lockstep release bumps both, and the release workflow publishes it after this package.
Its only allowed import of nax-agent is the public entry `.`, so any symbol the ACP
backend needs must be exported from `.`, never `./internal`.

> Edit this file to update AI agent context — do not edit `CLAUDE.md`, `AGENTS.md`,
> `.cursorrules`, `GEMINI.md` or other generated agent files directly.
> Run `nax generate` after changing it.

## Tech Stack

| Layer | Choice |
|:------|:-------|
| Runtime | **Bun 1.4.0** for dev and tests; the shipped source is Node-compatible (>=22.19.0) and uses no Bun API (`bun run check:no-bun-apis`) |
| Language | **TypeScript strict** — no `any` without explicit justification |
| Test | **`bun:test`** for unit/integration coverage; **vitest on real Node 22/24** for runtime contracts and packed-tarball smoke |
| Lint/Format | **Biome** (`bun run lint:biome`), plus nax's own gate scripts |
| Build | `bun run build` — `tsc -p tsconfig.build.json` (nodenext) to `dist/`, for the npm package; nax still bundles the source |

## Commands

| Command | Purpose |
|:--------|:--------|
| `bun run typecheck` | `tsc --noEmit` over `src/` and `test/` |
| `bun run build` | `tsc -p tsconfig.build.json`: Node ESM `dist/`; fails on an extensionless relative import |
| `bun run stage-publish` | Generate `.publish/` from the built `dist/` and documentation; workspace exports remain source-pointing |
| `bun run test:node` | Real-Node vitest contracts plus packed-tarball/consumer smoke |
| `bun run check:api` | Build, read the exports of `.` and `./internal` from the declarations, diff against `api/nax-agent.api.txt`; fails if `.` exports a `_` name |
| `bun run api:update` | Rewrite `api/nax-agent.api.txt` after an intended surface change (refuses a `_` name on `.`) |
| `bun run check:all` | Biome plus every repo gate (`lint`) |
| `bun run lint:fix` | Biome lint fix |
| `bun test ./test/unit/foo.test.ts --timeout=60000` | Targeted test during iteration with timeout |
| `bun run test` | `test/unit/` then `test/integration/` |

Run all of them from `packages/nax-agent`. Never run bare `bun test` with no path: it
would pick up every file in the package.

`check:all` runs Biome over `src/` and `test/` and then the shared gate scripts with
`--package=.`, so the source and test ratchets apply to this package's files. The gate
scripts themselves live in `packages/repo-tooling/scripts/` and are invoked as
`bun ../repo-tooling/scripts/check-*.ts`; that is deliberate — one gate implementation,
scoped to each package, rather than a fork per package.

**Coverage is gated here.** `bun run test:coverage` runs `test/unit/` and `test/integration/`
with coverage and enforces 80% lines and functions overall and 80% per `src/` file against
`scripts/baselines/coverage-per-file-baseline.json`. With `--require-all-files` it also fails on
any `src/` file that holds code but has no record in the report. CI runs it in this package's
job. The baseline only shrinks, and it must be empty before the first publish (spec S2 R2).

## Architecture

```text
src/
├── session/            # the session contract both transports satisfy (types, events, deadlines)
├── native/             # the native session adapter and its turn loop over @nathapp/nax-ai
├── tools/              # the tool set: registry, policy, exec, read/write, git, package managers
├── permissions/        # permission resolution, the ask chain, bash lexing, approval taint
├── sandbox/            # the OS sandbox: policy builder, launcher, probe, srt backend
├── command-safety/     # the rule scorer and its build/guard/tap/shadow surfaces
├── coding-tools/       # coding-tool wrappers (bash, sandbox, support) over tools/
├── command-interceptor/# the shell interception surface
├── cost/               # usage → cost math, model specs, the nax-ai type re-export
├── config/             # sandbox/approval/catalog config schemas and the native-agent config
├── infra/              # NaxError, the logger slot, credential config, the spin breaker
├── internal/           # below-the-line helpers: git, locks, argv exec, redaction, command-spec
├── runtime/            # the runtime slot: AgentRuntime contract, Node default, which
├── index.ts            # the `.` entry
└── internal.ts         # the `./internal` entry
```

Two entries, and only two:

- **`.`** (`src/index.ts`) — the supported contract. Every export is **named** (no `export *`)
  and none starts with `_`. Adding or removing a name changes `api/nax-agent.api.txt`: run
  `bun run api:update` and commit it. CI (`bun run check:api`) compares the built declarations.
- **`./internal`** (`src/internal.ts`) — nax-only, outside semver (see its header). It holds the
  shared helpers, `NaxError`, deep modules and **every `_*Deps` seam and `_reset…` hook**; a new
  seam is exported here, never from `.`. It re-exports the same module instances, so patching a
  seam here patches the object the agent reads.

nax-agent exports no test helpers. Its own helpers live in `test/helpers/` (imported as
`#test/helpers/index`). The ten generic ones live in `@nathapp/nax-test-kit/bun/*`, which nax
and nax-agent share. nax keeps its own copies of `command-safety` and `sandbox` for the four
nax wiring tests that use them.

## Engineering Rules

- **Spawn only through the runtime slot.** `runtimeSpawn` / `getAgentRuntime().spawn` from `#src/runtime/index`; never `Bun.spawn` or `node:child_process` directly. The Node runtime is the default; nax installs a Bun runtime (`packages/nax/src/agent-runtime/install.ts`). New spawn behaviour gets a case in `@nathapp/nax-test-kit/cases/spawn-cases`, which both runtimes run.
- **The package boundary is a gate, not a convention.** `bun run check:package-boundaries`
  (from `packages/nax`) scans every package. Shipped nax-agent source imports only Node builtins, its
  declared dependencies, `#src/` and `#test/`, relative paths that stay inside the package,
  and itself. Never `@nathapp/nax`, never a relative path into another package, and never a
  tsconfig alias. A `packages/*` directory with a `package.json` but no rule in that gate
  is a hard failure, so adding a package cannot silently escape it.
- **Import with `#src/`, never `@/`.** The package's own `imports` map defines `#src/*` and
  `#test/*`; `@/` is nax's tsconfig alias and does not resolve here. Relative imports that
  leave the package are rejected by the same gate.
- **Relative imports in `src/` name the file: `./x.ts`, `./dir/index.ts`.** The published build
  (`bun run build`, tsc nodenext) rewrites them to `.js` and rejects an extensionless one
  (TS2835/TS2834). `#src/…` specifiers stay extensionless. Tests are not built and keep either form.
- **The dependency direction is `nax-ai` → `nax-agent` → `nax`.** A package never imports
  one to its right. nax-agent depends on `@nathapp/nax-ai`, never the reverse.
- **`@nathapp/nax-ai` is importable from two sites only:** `src/native/` and the re-export
  `src/cost/standard-types.ts`. `bun run check:nax-ai-imports .` enforces it in this
  package; the same script enforces nax's single site, `src/agents/catalog/`. The client
  stays swappable only while its surface has one consumer.
- **Leaf code stays cost-blind.** Selectors and helpers that influence routing or execution
  decisions must not read cost data. Cost belongs to the orchestration layers above.
- **Permission decisions go through the resolved mode.** Resolve once and pass it down; never
  hardcode `approve-all`/`approve-reads`. `bun run check:permission-mode-ssot` enforces the
  single source of truth and a consumer of an already-resolved mode takes a
  `// nax-permission-mode-allow: <reason>` marker.
- **`_*Deps` seams, not monkey-patched globals.** External calls (spawn, fs, fetch) go
  through an exported `_deps` object so tests can override them.
- **Opaque values stay opaque.** A credential `key` is never inspected, logged or synthesised.
  Pass through or omit; never substitute `""`.
- **`errorMessage()` lives at `#src/infra/errors`** here; nax takes the same helper from
  `@nathapp/nax-agent/internal`. Never re-implement it inline.

## Testing Rules

- Tests live under `test/`, mirroring `src/`, named `*.test.ts`.
- Shared fixtures and mocks live in `test/helpers/`. Generic helpers belong in
  `@nathapp/nax-test-kit/bun/*`. A nax-agent helper that nax also needs is copied into nax's
  `test/helpers/` with a first-line note naming the original; that is the one sanctioned
  duplicate (spec S2 §6.2). Otherwise extend the shared helper instead of re-implementing it inline.
- `test/fixtures/` holds recorded fixtures. The sandbox tests that probe for a working `bwrap`
  use `test.skipIf(!probe.available)`, so they pass by skipping when one is unavailable —
  a green local run is not evidence they ran. CI installs `bubblewrap`, `socat` and
  `ripgrep` so they do.
- **A regression test must be shown to fail against the old code before it counts.**
