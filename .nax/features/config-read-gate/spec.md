# SPEC: Config Read Gate

## Summary

Let the native coding agent **read** the project's nax config (`.nax/config.json` and every
`.nax/mono/<package>/config.json`) once a scan has confirmed the files carry no literal secret,
while every write to them stays refused. The scan is one pure function, `scanConfigSecrets`,
shared by three consumers: a new `config-secrets` precheck warning (also reachable as the new
`nax doctor` command, an alias for `nax precheck --light`), the coding-tool owned-paths policy
that decides whether reads are refused, and the `.nax/` artifacts prompt section, which tells
the agent where the declared commands live only when it is actually allowed to read them.
Tracks nathapp-io/nax#2458.

## Motivation

`isNaxConfigFile` (`src/agents/nax-owned-writes.ts`) refuses nax config files to **every** tool,
reads included, through `resolveWithin` — the single containment seam in nax-agent. The reason
the refusal states is a write concern: `quality.commands` and `acceptance.command` run through a
shell without passing the permission gate, so a model that could edit the file could run an
ungated command on the next run. Blocking writes is sufficient for that concern; blocking reads
is collateral.

Agents do want to read the file, to learn the package's declared commands. Two live runs on
2026-10-11 produced 5 refused config reads, all of them command lookups — `grep "testScoped"
../../.nax/config.json`, `cat .nax/mono/apps/api/config.json` described as "Check root scripts
and nax api config commands", a `python3` dump of `.nax/config.json` next to `package.json`
scripts, and a `Read` of `.nax/mono/apps/runner/config.json`. Each costs a turn and ends in a
guess.

The residual risk of opening reads is secret exposure: the config schema accepts literal values in
`reporters.webhook.headers`, `reporters.otel.headers`, `agent.native.catalogOverrides[].headers`,
`models.<agent>.<tier>.env` and `mcp.servers.<id>.env`,
and anything the agent reads is sent to its model provider. Today's active project configs carry
none (credentials live under `~/.nax/`, outside the containment root), but nothing prevents one
being pasted in. Gating path-named reads on a scan narrows that without reopening writes.

## Design

### Approach

Three pieces, each with one job:

1. **Scanner** — `scanConfigSecrets(repoRoot)` reads the root config plus every mono config file and
   returns findings as `{ file, pointer, kind }`. It never returns a flagged value.
2. **Read gate** — `createConfigReadGatePolicy(base, configReadable)` wraps nax's existing
   `naxOwnedPathsPolicy` instead of editing `src/agents/nax-owned-writes.ts`. That file has a
   verbatim copy in `packages/nax-agent/test/helpers/nax-owned-paths.ts`, pinned by
   `test/unit/agents/nax-owned-writes-copy.test.ts`. A wrapper keeps both untouched, so no story
   crosses into `packages/nax-agent`.
3. **Prompt hint** — one paragraph appended by `buildNaxArtifactsSection` when an options flag is
   set; `TddPromptBuilder` sets it from a scan of the **repo root** it is handed through a new
   `configRoot(dir)` builder method (not the loader workdir, which is the package directory for a
   monorepo package story — `src/pipeline/types.ts:88-95`).

Secret detection reuses nax-agent's existing, already-exported `redactSecrets` from
`@nathapp/nax-agent/internal` (`packages/nax-agent/src/internal/redact.ts`). That function applies
the key-name pattern when given an object (`redactSecrets({ [key]: value })`) and the value
patterns (`sk-…`, GitHub, npm, AWS, Slack, PEM, JWT, `Bearer`/`Basic`, `url-credentials`,
`TOKEN=…` assignments) when given a string. A value counts as flagged when the redacted result
differs from the input. No pattern list is copied into nax.

Why the gate is narrower than "config is readable": nax-agent consults the port's
`configRefusal(root, resolved)` from `resolveWithin` for **every** path-bearing check, with no tool
context — typed tools, Exec positional paths, and the non-raw (`gated` / `escalate`) Bash checker
(`packages/nax-agent/src/tools/policy-bash.ts:151-231`, which resolves redirect targets and path
tokens through `resolveWithin` and never calls `bashRefusal`). Opening `configRefusal` therefore
also opens those paths, so the design closes them in the two places nax controls:

- `writeRefusal(tool, rel, …)` is called by nax-agent's `applyPathRules` for every path tool on the
  symlink-resolved `rel` (`packages/nax-agent/src/tools/policy.ts:169-171`). When reads are open,
  the wrapper refuses a nax config `rel` to every tool except an explicit read-only set
  (`Read`, `Grep`, `Glob`, `ScratchpadRead`, `ScratchpadList`). That covers `ScratchpadWrite`
  through a symlink, `Git` pathspecs (so committed config history is not readable), and any tool
  added later.
- `resolveCodingToolSupport` opens reads only when Bash is either not declared for the dispatch or
  runs in `raw` approval mode, where the raw screen consults `bashRefusal`. A dispatch that
  declares Bash under `gated` or `escalate` keeps reads closed.

### Integration

Source paths in this Design section are relative to `packages/nax` unless they start with `packages/`.

Read-only symbols (verified, unchanged by this spec):

- `isNaxConfigFile(root: string, resolved: string): boolean` — `src/agents/nax-owned-writes.ts:103`.
  True for `.nax/config.json` and `.nax/mono/<package…>/config.json` at any package depth; false
  for `.nax/mono/config.json` and `docs/nax/config.json`.
- `naxOwnedKind(rel: string): "prd" | "queue" | undefined` — `src/agents/nax-owned-writes.ts:166`.
- `NAX_CONFIG_REFUSAL: string` — `src/agents/nax-owned-writes.ts:301`; completes the
  `path "<x>" <text>` sentence built by nax-agent's `outOfRootReason`.
- `naxOwnedPathsPolicy: OwnedPathsPolicy` — `src/agents/nax-owned-writes.ts:323`.
- `OwnedPathsPolicy` / `OwnedBashCandidate` — `packages/nax-agent/src/tools/owned-paths.ts:15-45`.
- `redactSecrets<T>(input: T): T` — `packages/nax-agent/src/internal/redact.ts:150`, exported via
  `@nathapp/nax-agent/internal`.
- `resolvePermissions(config, stage).bashApproval: "raw" | "gated" | "escalate"` — already computed
  as `resolved` at the top of `resolveCodingToolSupport`.
- `runEnvironmentPrecheck(config, workdir, options?: { format?, silent? })` /
  `EnvironmentPrecheckResult { passed, blockers, warnings }` and `Check { name, tier, passed, message }`
  — `src/precheck/index.ts:253`, `src/precheck/types.ts`. With `format: "json"` and not silent it
  prints `{ passed, blockers, warnings }`.
- `precheckCommand(options: { feature?, dir?, json?, light? })` — `src/commands/precheck.ts:36`.
  With `light: true` it runs `runEnvironmentPrecheck` and exits 1 only when a blocker fails.
- `runTrustGate(dir)` — called by the `precheck` action in `bin/nax.ts` before `precheckCommand`.

Mutated symbols. The baseline exists only to locate the code; implement the **Target**.

- `runEnvironmentPrecheck` — `src/precheck/index.ts:253`, and `runPrecheck` — `src/precheck/index.ts:312`.
  - Baseline: environment warnings (`getEnvironmentWarnings`) run only when `blockers.length === 0`
    (`:288`, `:368`).
  - Target: both functions also run `checkConfigSecrets(workdir)` **regardless of blockers**, after
    the blocker phase, filing the result under `passed` or `warnings` and printing it like any other
    check. `getEnvironmentWarnings` is unchanged. The added logic lives in a helper exported from
    `src/precheck/checks-config-secrets.ts`; the complexity baselines for `runEnvironmentPrecheck`
    and `runPrecheck` in `complexity-baseline.json` are not raised.
- `_codingToolSupportDeps` — `src/agents/coding-tool-support-resolve.ts:432`.
  - Baseline: `{ loadConfigForPackage, runDeclaredCommand, protectedPaths, ownedPaths }`.
  - Target: the same fields plus `scanConfigSecrets: typeof scanConfigSecrets`.
- `resolveCodingToolSupport(options)` — `src/agents/coding-tool-support-resolve.ts:460`.
  - Baseline: passes `ownedPaths: _codingToolSupportDeps.ownedPaths` to `buildCodingToolSupport`.
  - Target: awaits `_codingToolSupportDeps.scanConfigSecrets(options.codingToolRoot)` and passes
    `ownedPaths: createConfigReadGatePolicy(_codingToolSupportDeps.ownedPaths, readable)`, where
    `readable = scan.clean && (resolved.bashApproval === "raw" || !declaredWithProviders.includes("Bash"))`.
  - When `options.codingToolRoot` is undefined no scan runs and `readable` is `false`; `readable` is
    also `false` when the scan rejects. The scan happens only on the path that reaches
    `buildCodingToolSupport`, so an early `return undefined` (no declared tools) does no scan.
- `buildNaxArtifactsSection(role, variant?, isolation?)` — `src/prompts/sections/nax-artifacts.ts:21`.
  - Baseline: three parameters.
  - Target: `buildNaxArtifactsSection(role, variant?, isolation?, options?: { configReadable?: boolean })`.
    With `options` omitted or `configReadable` not `true`, it returns exactly the baseline text.
- `TddPromptBuilder` — `src/prompts/builders/tdd-builder.ts`.
  - Baseline: no repo-root input; section (6.71) at `:305` calls
    `buildNaxArtifactsSection(this.role, variant, isolation)`.
  - Target: a new chainable `configRoot(dir: string): this`. When it was called, `build()` awaits
    `_tddPromptBuilderDeps.scanConfigSecrets(dir)` and passes
    `{ configReadable: scan.clean && scan.files.includes(".nax/config.json") }`; when it was not,
    no scan runs and no options are passed. The scan and its error handling live in a private
    helper; the `TddPromptBuilder.build` complexity baseline is not raised.
- `TddPromptBuilder.buildForRole(role, workdir, config, story, opts)` — `src/prompts/builders/tdd-builder.ts:343`,
  the builder for three-session TDD sessions (called from `src/execution/plan-inputs.ts` and
  `render-phase-bundle.ts`; `promptStage` is disabled for those strategies).
  - Baseline: chains `withLoader(workdir, config)` with no repo-root input.
  - Target: also chains `configRoot(opts.root)` when `opts.root` is defined (documented as the repo root
    where `.nax/` lives).
- `promptStage.execute(ctx)` — `src/pipeline/stages/prompt.ts:45`.
  - Baseline: both builder chains (batch at `:75`, single at `:91`) call `withLoader(ctx.workdir, ctx.config)`.
  - Target: both chains also call `configRoot(ctx.projectDir)`.

New symbols:

```typescript
// src/config/secret-scan.ts  (exported from the src/config barrel)
export type ConfigSecretKind = "literal-header" | "secret-env" | "token-shape" | "unscannable";
export interface ConfigSecretFinding {
  readonly file: string;     // repo-root-relative, posix: ".nax/config.json" | ".nax/mono/apps/api/config.json"
  readonly pointer: string;  // RFC 6901 JSON pointer to the flagged string; "" for "unscannable"
  readonly kind: ConfigSecretKind;
}
export interface ConfigSecretScan {
  readonly clean: boolean;                          // findings.length === 0
  readonly files: readonly string[];                // repo-root-relative paths actually scanned
  readonly findings: readonly ConfigSecretFinding[];
}
export async function scanConfigSecrets(repoRoot: string): Promise<ConfigSecretScan>;

// src/precheck/checks-config-secrets.ts  (exported from the src/precheck barrel)
export const _configSecretsCheckDeps: { scanConfigSecrets: typeof scanConfigSecrets };
export async function checkConfigSecrets(workdir: string): Promise<Check>; // name "config-secrets", tier "warning"

// src/commands/doctor.ts  (exported from the src/commands barrel)
export const _doctorDeps: { runTrustGate: typeof runTrustGate; precheckCommand: typeof precheckCommand };
export async function doctorCommand(options: { dir: string; json?: boolean }): Promise<void>;

// src/agents/nax-config-read-gate.ts
export const NAX_CONFIG_READ_TOOLS: ReadonlySet<string>; // Read, Grep, Glob, ScratchpadRead, ScratchpadList
export const NAX_CONFIG_WRITE_REFUSAL: string;
export const NAX_CONFIG_READ_DISABLED_SUFFIX: string;
export function createConfigReadGatePolicy(base: OwnedPathsPolicy, configReadable: boolean): OwnedPathsPolicy;

// src/prompts/builders/tdd-builder.ts
export const _tddPromptBuilderDeps: { scanConfigSecrets: typeof scanConfigSecrets };
```

`src/config/secret-scan.ts` imports nothing from `src/agents/`; it applies the mono-path rule
itself (below), so no `config` → `agents` dependency is added.

### Scanner rules

Files scanned:
- `<repoRoot>/.nax/config.json`, when present.
- Every `config.json` under `<repoRoot>/.nax/mono/` with **at least one** directory segment between
  `mono/` and `config.json` — `.nax/mono/apps/api/config.json` and `.nax/mono/packages/app/config.json`
  are scanned; `.nax/mono/config.json` is not. This is the same set `isNaxConfigFile` accepts.

`files` is sorted lexicographically, and `findings` are grouped by file in that order, each file's in
depth-first traversal order. A missing root config or a missing `mono/` directory is not a finding. When nothing is scanned,
`files` is empty and `clean` is `true`.

A file that cannot be read, is not valid JSON, or whose top-level JSON value is not an object yields
one finding, `{ file, pointer: "", kind: "unscannable" }`, and no other findings for that file.
Scanning the remaining files continues.

Each parsed object is walked depth-first, through nested objects and arrays (array elements get
their index as the pointer segment). Only string leaves are tested; numbers, booleans and `null`
are ignored. Pointer segments are escaped per RFC 6901 (`~` → `~0`, `/` → `~1`), so a header key
`X/Token` appears as `X~1Token`.

**Environment references.** `$VAR` and `${VAR}` (name `[A-Za-z_][A-Za-z0-9_]*`) are references. For
each leaf, `stripped` is the value with every reference removed.

A string leaf yields **at most one finding**; the first rule that matches wins, in this fixed order:

1. **`literal-header`** — an ancestor key is `headers`, the leaf key (case-insensitive) is not one
   of `content-type`, `accept`, `user-agent`, `http-referer`, `x-title`, and the value contains no
   reference.
2. **`secret-env`** — an ancestor key is `env`, the value contains no reference, and
   `redactSecrets({ [leafKey]: value })[leafKey] !== value`. This flags a secret-looking key
   (`API_TOKEN`, `DATABASE_URL`) or a token-shaped value under any key, and leaves `NODE_ENV: "test"`
   alone.
3. **`token-shape`** — anywhere, `redactSecrets(stripped) !== stripped`.

So `"Bearer ${OPENROUTER_KEY}"` under `headers` is clean (it carries a reference and its stripped
remainder `"Bearer "` is not token-shaped), while `"Bearer ${KEY} sk-abcdefghijklmnopqrstu"` is a
`token-shape` finding.

### CLI Behavior

`nax doctor [-d <dir>] [--json]` is an alias for `nax precheck --light [-d <dir>] [--json]`:
`doctorCommand` awaits `_doctorDeps.runTrustGate(dir)` and then
`_doctorDeps.precheckCommand({ dir, json, light: true })`. Output (human and `--json`) and exit codes
(`0` when no blocker fails, `1` when one does) are therefore those of `precheck --light`.

`config-secrets` is a Tier-2 warning that runs even when a blocker fails, so it is reported on a dirty
or non-git working tree; a finding never changes the exit code. When the check fails, its `message`
names each finding's `file`, `pointer` and `kind` and tells the user to move the value into an
environment-variable reference or into the global `~/.nax/config.json` (which agents cannot reach).
An invalid-JSON project config fails `loadConfig` before precheck runs, so through `nax doctor` it
surfaces as a config-load error rather than an `unscannable` finding. The flagged value never appears in the output.

### Read gate behaviour

`createConfigReadGatePolicy(base, configReadable)` returns a policy that keeps `base`'s
`deniedEntries`, `rootWriteDenies`, `scratchpadEntry` and `writeOptIns` unchanged. "Config `rel`"
below means a root-relative path that `isNaxConfigFile` accepts.

| Hook | `configReadable: true` | `configReadable: false` |
|:---|:---|:---|
| `configRefusal(root, resolved)` | `undefined` | `base` refusal text followed by `NAX_CONFIG_READ_DISABLED_SUFFIX` (names `nax doctor`); `undefined` where `base` returns `undefined` |
| `writeRefusal(tool, rel, ctx)` | config `rel` and `tool` not in `NAX_CONFIG_READ_TOOLS`: `"<rel>" ` + `NAX_CONFIG_WRITE_REFUSAL`; config `rel` and `tool` in `NAX_CONFIG_READ_TOOLS`: `undefined`; any other `rel`: `base.writeRefusal(tool, rel, ctx)` | `base.writeRefusal(tool, rel, ctx)` (config paths stay refused by `configRefusal` before `writeRefusal` is reached) |
| `bashRefusal(tool, token, candidates, ctx)` | `undefined` when `ctx.verb === "names"`, `ctx.sandboxWrapped` is true, a candidate is a nax config file and no candidate is a PRD or queue file; otherwise `base.bashRefusal(...)` | `base.bashRefusal(...)` |

`NAX_CONFIG_WRITE_REFUSAL` says the file is nax configuration that only `Read`, `Grep` and `Glob` may
open and no tool may modify, and gives the `quality.commands` / `acceptance.command` ungated-shell
reason.

The `bashRefusal` row mirrors the existing sandbox-wrapped PRD exemption in
`naxOwnedPathsPolicy.bashRefusal`: under the OS sandbox, a raw command that only names the file is
admitted and the sandbox's write deny on `config.json` / `mono` stops any write. A redirect into the
file (`verb: "redirects into"`) is refused in every state.

### Prompt hint

With `configReadable: true`, `buildNaxArtifactsSection` appends this paragraph after its last
paragraph:

```
The project's declared commands (test, testScoped, lint, typecheck, build, ...) are in
`.nax/config.json` under `quality.commands`. In a monorepo, `.nax/mono/<package>/config.json`
overrides them per key for that package: a key set there wins, every other key comes from the
root file. Read them with the `Read` tool. Do not modify either file; nax config cannot be changed
from inside a run.
```

The per-key wording matches `quality.commands` deep-merge semantics (`src/config/merge.ts:61`).
The hint keys off the scan alone, not the dispatch's Bash mode; in a `gated`/`escalate` Bash session
the `Read` it points to is refused with the read-disabled reason.

### Failure Handling

| Failure | Behaviour | Fail mode |
|:---|:---|:---|
| A scanned file is unreadable, invalid JSON or a non-object JSON value | `unscannable` finding; `clean: false` | closed |
| `_codingToolSupportDeps.scanConfigSecrets` rejects | `resolveCodingToolSupport` uses `configReadable: false`; it does not throw | closed |
| `_configSecretsCheckDeps.scanConfigSecrets` rejects inside `checkConfigSecrets` | returns `{ name: "config-secrets", tier: "warning", passed: false }` with a message saying the nax config could not be scanned | closed |
| `_tddPromptBuilderDeps.scanConfigSecrets` rejects inside `build()` | the hint is omitted; `build()` resolves normally | closed |

## Out of Scope

- Any write access to `.nax/config.json` or `.nax/mono/**/config.json` — `NAX_NEVER_OPT_IN`, the OS sandbox write denies and the raw-Bash redirect refusal are unchanged.
- Editing `src/agents/nax-owned-writes.ts` or its verbatim copy `packages/nax-agent/test/helpers/nax-owned-paths.ts` — the read gate wraps `naxOwnedPathsPolicy` instead.
- Any change to `packages/nax-agent` — the port, `resolveWithin`, `outOfRootReason`, `policy-bash.ts` and `redactSecrets` are consumed as they are.
- Reads of global `~/.nax/` files (global config, profiles, credentials) — they sit outside the containment root and stay unreachable.
- ACP agent sessions (Claude, Codex adapters) — they do not use the native coding-tool policy.
- Redacting or masking secrets inside the Read result — a config with any finding is refused to `Read`, `Glob` and path-naming tools as a whole.
- Content searches that do not name a config file — `Grep` over a directory such as `.nax`, `.nax/mono` or the repo root (its `rg` / `grep -r` child reads every file beneath without a per-file `resolveWithin` check), and raw Bash that builds a config path dynamically (for example `python3 -c` opening it) — can read config contents whatever the scan result. This residual exists today and is accepted; the gate covers tools and commands that name a config path.
- A user-configurable allow-list for scanner false positives — the remedy is moving the value into an environment-variable reference (`reporters.*.headers` expand `${VAR}`), into the global `~/.nax/config.json`, or renaming it.
- False positives inherited from the shared `redactSecrets` value patterns, such as an `sk-` run inside a longer command word (`test:task-runner-integration-suite`) — accepted; `nax doctor` names the pointer so the user can rename it.
- A generic high-entropy detector — only the existing `redactSecrets` key and value patterns are used.
- Scanning committed git history for secrets — the `Git` tool is refused explicit nax config `paths`/`refs` by the read gate, and pathless diff/log/show already exclude `.nax` (`NAX_OWNED_GIT_EXCLUDE_PATHSPECS`).
- The rectifier prompt path (`src/prompts/builders/rectifier-builder-helpers.ts`, `CONTRADICTION_ESCAPE_HATCH`) and the `nax prompts` export CLI (`src/cli/prompts-tdd.ts`, `src/cli/prompts-export.ts`) — they do not call `configRoot`, so they keep the current `.nax/` artifacts text; rectifier sessions are still covered by the read gate.
- Other `nax doctor` checks (git-tracked generated files, stale-artifact cleanup) — `nax doctor` runs exactly the `nax precheck --light` check set.
- US-003 only: whether Exec (`RunCommand` with `argv`) admits a positional `./.nax/config.json` under a clean scan is not pinned — Exec positional paths are checked through `resolveWithin` only and Exec runs package managers, while writes stay blocked by the OS sandbox and the write refusal.
- US-003 only: an undefined `codingToolRoot` keeps the existing `CODING_TOOL_ROOT_MISSING` behaviour; the read gate adds nothing on that path.
- US-003 only: the sandbox launcher (`resolveDispatchLauncher`) keeps receiving the unwrapped `naxOwnedPathsPolicy`, so the OS-level write denies are unchanged.
- US-003 only: config edits made by a human mid-run are honoured at the next dispatch, because the scan runs per `resolveCodingToolSupport` call; no run-level caching is added.

## Stories

### US-001 — Config secret scanner

Workdir: `packages/nax`

Adds `scanConfigSecrets`, its result types and its three-rule walk over the root and mono config
files, exported from the `src/config` barrel.

Dependencies: none.

### US-002 — `config-secrets` precheck warning and `nax doctor`

Workdir: `packages/nax`

Adds `checkConfigSecrets`, run by `runEnvironmentPrecheck` and `runPrecheck` regardless of blockers,
plus `doctorCommand` and the `doctor` command in `bin/nax.ts`, which runs the trust gate and then
`precheckCommand` with `light: true`.

Dependencies: US-001.

### US-003 — Read gate policy and its wiring into coding-tool support

Workdir: `packages/nax`

Adds `createConfigReadGatePolicy` with its read-only tool set and constants, and wires
`resolveCodingToolSupport` to scan per dispatch, open reads only for a clean scan with raw or absent
Bash, and wrap `_codingToolSupportDeps.ownedPaths`, failing closed.

Dependencies: US-001.

### US-004 — Config-read hint in the `.nax/` artifacts prompt section

Workdir: `packages/nax`

Adds the `options.configReadable` parameter to `buildNaxArtifactsSection`, the
`TddPromptBuilder.configRoot(dir)` method that drives it, the `configRoot(ctx.projectDir)` call in
both builder chains of `promptStage`, and the `configRoot(opts.root)` call in `buildForRole`.

Dependencies: US-001.

Story split rationale: the project's `maxAcCount` is 24. The scanner (US-001) and its CLI surface
(US-002) together would carry more than 24 assertions, so they are split at the module boundary
(`src/config/` vs `src/precheck/` + `src/commands/`). US-003 and US-004 both consume the scanner but
touch disjoint modules (`src/agents/` vs `src/prompts/` + `src/pipeline/`), and merged they would
exceed the cap.

### Context Files

**US-001**
- `packages/nax-agent/src/internal/redact.ts` — `redactSecrets`, the detection primitive reused by the scanner
- `packages/nax/src/agents/nax-owned-writes.ts` — `isNaxConfigFile`, the mono-path rule the scanner mirrors (do not import it)
- `packages/nax/src/config/index.ts` — the `src/config` barrel the scanner is exported from

**US-002**
- `packages/nax/src/precheck/index.ts` — `runEnvironmentPrecheck` and `runPrecheck`, where the check runs after the blocker phase
- `packages/nax/src/precheck/checks-warnings.ts` — existing Tier-2 warning checks; follow their `Check` shape
- `packages/nax/src/commands/precheck.ts` — `precheckCommand`, which `doctorCommand` delegates to
- `packages/nax/src/config/secret-scan.ts` — created by US-001, consumed here
- `packages/nax/test/integration/cli/cli-trust-gate.test.ts` — how CLI integration tests spawn the nax bin in a fixture project

**US-003**
- `packages/nax/src/agents/nax-owned-writes.ts` — `naxOwnedPathsPolicy`, `isNaxConfigFile`, `naxOwnedKind`, `NAX_CONFIG_REFUSAL`
- `packages/nax/src/agents/coding-tool-support-resolve.ts` — `_codingToolSupportDeps` and `resolveCodingToolSupport`
- `packages/nax-agent/src/tools/policy.ts` — `applyPathRules`, which calls `writeRefusal` for every path tool
- `packages/nax/src/config/secret-scan.ts` — created by US-001, consumed here
- `packages/nax/test/unit/agents/coding-tool-support-owned-paths.test.ts` — the owned-paths suite this story extends

**US-004**
- `packages/nax/src/prompts/sections/nax-artifacts.ts` — `buildNaxArtifactsSection`
- `packages/nax/src/prompts/builders/tdd-builder.ts` — builder methods and section (6.71)
- `packages/nax/src/pipeline/stages/prompt.ts` — `promptStage`, which gains the `configRoot(ctx.projectDir)` call
- `packages/nax/src/config/secret-scan.ts` — created by US-001, consumed here
- `packages/nax/test/unit/prompts/sections/nax-artifacts.test.ts` — existing section tests

### Creates

**US-001**
- `packages/nax/src/config/secret-scan.ts` — `scanConfigSecrets` and its types
- `packages/nax/test/unit/config/secret-scan.test.ts` — scanner unit tests

**US-002**
- `packages/nax/src/precheck/checks-config-secrets.ts` — `checkConfigSecrets`, its deps and the precheck helper
- `packages/nax/src/commands/doctor.ts` — `doctorCommand` and `_doctorDeps`
- `packages/nax/test/unit/precheck/checks-config-secrets.test.ts` — precheck check unit tests
- `packages/nax/test/unit/commands/doctor.test.ts` — `doctorCommand` unit tests
- `packages/nax/test/integration/cli/cli-doctor.test.ts` — `nax doctor` CLI tests

**US-003**
- `packages/nax/src/agents/nax-config-read-gate.ts` — `createConfigReadGatePolicy` and its constants
- `packages/nax/test/unit/agents/nax-config-read-gate.test.ts` — policy unit tests

### Modifies

**US-001**

None. US-001 only adds a new module and a barrel export.

**US-002**

None. The existing precheck suites assert individual checks, not the contents or length of the
`warnings` array, and a passing `config-secrets` check is filed under `passed`.

**US-003**
- `packages/nax/test/unit/agents/coding-tool-support-owned-paths.test.ts` — the test "Read of nax config is refused like a write" (line 91) asserts that Read of the root nax config is denied with CONFIG_REASON. Its fixture writes an empty JSON object to the root nax config, which the scan reports clean, so under US-003 that Read succeeds against a correct implementation. US-003 owns rewriting the test: with a fixture config holding a literal reporters.webhook.headers.Authorization value, the Read is denied with a reason that starts with CONFIG_REASON and ends with NAX_CONFIG_READ_DISABLED_SUFFIX.
- `packages/nax/test/unit/agents/coding-tool-support-owned-paths.test.ts` — the test "Glob does not list nax config" (line 110) asserts that the naxcfg.json symlink to the root nax config yields "no matches". With the clean empty-object fixture, resolveWithin now admits the symlink target and Glob lists it. US-003 owns moving the "no matches" assertion onto a fixture whose root nax config holds a literal header value.
- `packages/nax/test/unit/agents/coding-tool-support-owned-paths.test.ts` — the test "Exec refuses a positional path to nax config" (line 125) asserts that RunCommand with argv bun add ./.nax/config.json errors with "resolves outside the permitted root". With the clean empty-object fixture the positional path is now admitted. US-003 owns moving that assertion onto a fixture whose root nax config holds a literal header value, where the error text is unchanged.

**US-004**

None. `buildNaxArtifactsSection` returns the baseline text when `options` is omitted, and
`TddPromptBuilder` scans only when `configRoot` was called, which no existing test does.

### Seams

- `scanConfigSecrets` (US-001) → `checkConfigSecrets` (US-002) → `runEnvironmentPrecheck` / `runPrecheck`; entry point `nax doctor` / `nax precheck`.
- `scanConfigSecrets` (US-001) → `resolveCodingToolSupport` through `_codingToolSupportDeps.scanConfigSecrets` (US-003); entry point `resolveCodingToolSupport`, the function both production hops (`src/runtime/session-run-hop.ts`, `src/operations/build-hop-callback-hop.ts`) call.
- `createConfigReadGatePolicy` (US-003) → `buildCodingToolSupport`'s `ownedPaths`; observed through `support.runtime.callTool`.
- `scanConfigSecrets` (US-001) → `TddPromptBuilder.build()` through `_tddPromptBuilderDeps.scanConfigSecrets` (US-004); entry points `promptStage.execute(ctx)` (single-session) and `TddPromptBuilder.buildForRole` (three-session TDD).

## Acceptance Criteria

### US-001

- [unit] `scanConfigSecrets(root)` resolves to `{ clean: true, files: [".nax/config.json"], findings: [] }` when `.nax/config.json` is `{}` and no `.nax/mono/` directory exists.
- [unit] `scanConfigSecrets(root)` resolves to `{ clean: true, files: [], findings: [] }` when `root` has no `.nax/config.json`.
- [unit] `scanConfigSecrets(root)` reports `{ file: ".nax/config.json", pointer: "/reporters/webhook/headers/Authorization", kind: "literal-header" }` and `clean: false` when that header holds the literal `"Bearer abc12345xyz"`.
- [unit] `scanConfigSecrets(root)` reports no finding for a `reporters.webhook.headers.Authorization` value of `"Bearer ${OPENROUTER_KEY}"`.
- [unit] `scanConfigSecrets(root)` reports no finding for a `reporters.webhook.headers.Authorization` value of `"$OPENROUTER_KEY"`.
- [unit] `scanConfigSecrets(root)` reports no finding for a `reporters.webhook.headers.HTTP-Referer` value of `"https://example.com"`.
- [unit] `scanConfigSecrets(root)` reports `{ pointer: "/mcp/servers/github/env/GITHUB_TOKEN", kind: "secret-env" }` when `mcp.servers.github.env.GITHUB_TOKEN` holds the literal `"abc"`.
- [unit] `scanConfigSecrets(root)` reports no finding for `models.native.fast.env.NODE_ENV` holding `"test"`.
- [unit] `scanConfigSecrets(root)` reports exactly one finding, of kind `secret-env`, for `models.native.fast.env.NODE_ENV` holding `"sk-abcdefghijklmnopqrstu"`.
- [unit] `scanConfigSecrets(root)` reports exactly one finding, of kind `literal-header`, for a `reporters.webhook.headers.Authorization` value of `"sk-abcdefghijklmnopqrstu"`.
- [unit] `scanConfigSecrets(root)` reports `{ pointer: "/quality/commands/test", kind: "token-shape" }` when `quality.commands.test` is `"DATABASE_URL=postgres://u:p@localhost/db bun test"`.
- [unit] `scanConfigSecrets(root)` reports no finding when `quality.commands` holds `test: "bun run test"` and `testScoped: "bunx vitest run {{files}}"`.
- [unit] `scanConfigSecrets(root)` reports a finding with pointer `/mcp/servers/x/args/1` and kind `token-shape` when `mcp.servers.x.args` is `["--token", "ghp_abcdefghijklmnopqrstuvwx"]`.
- [unit] `scanConfigSecrets(root)` reports pointer `/reporters/webhook/headers/X~1Token` for a literal value under the header key `X/Token`.
- [unit] `scanConfigSecrets(root)` reports `{ pointer: "/agent/native/catalogOverrides/0/headers/Authorization", kind: "literal-header" }` when `agent.native.catalogOverrides[0].headers.Authorization` holds the literal `"Bearer abc12345xyz"`.
- [unit] `scanConfigSecrets(root)` reports a `token-shape` finding whose `file` is `".nax/mono/packages/app/config.json"` when that mono file's `quality.commands.test` embeds `postgres://u:p@localhost/db`.
- [unit] `scanConfigSecrets(root)` leaves `.nax/mono/config.json` out of `files` and reports `clean: true` when only that file embeds `postgres://u:p@localhost/db`.
- [unit] `scanConfigSecrets(root)` reports `{ file: ".nax/config.json", pointer: "", kind: "unscannable" }` when `.nax/config.json` holds `not json`.
- [unit] `scanConfigSecrets(root)` reports `{ file: ".nax/config.json", pointer: "", kind: "unscannable" }` when `.nax/config.json` holds the JSON string `"sk-abcdefghijklmnopqrstu"`.
- [unit] `scanConfigSecrets(root)` still reports the `token-shape` finding of a valid `.nax/mono/apps/api/config.json` when `.nax/config.json` holds `not json`.
- [unit] The JSON serialisation of the `ConfigSecretScan` returned for the `"Bearer abc12345xyz"` header config omits the string `abc12345xyz`.

### US-002

- [unit] `checkConfigSecrets(root)` returns `{ name: "config-secrets", tier: "warning", passed: true }` when `root/.nax/config.json` is `{}`.
- [unit] `checkConfigSecrets(root)` returns `passed: false` with a `message` naming `/reporters/webhook/headers/Authorization` when that header holds the literal `"Bearer abc12345xyz"`.
- [unit] `checkConfigSecrets(root)` returns a `message` that omits `abc12345xyz` when `reporters.webhook.headers.Authorization` holds the literal `"Bearer abc12345xyz"`.
- [unit] `checkConfigSecrets(root)` returns `passed: false` with a `message` naming "could not scan" when `_configSecretsCheckDeps.scanConfigSecrets` rejects.
- [integration] `runEnvironmentPrecheck(config, root, { format: "json", silent: true })` resolves with a `blockers` entry and a `warnings` entry named `config-secrets` when `root` is a plain non-git directory whose `.nax/config.json` holds a literal `reporters.webhook.headers.Authorization` value.
- [integration] `runPrecheck(config, prd, { workdir: root, format: "json", silent: true })` resolves with a `result.warnings` entry named `config-secrets` when `root/.nax/config.json` holds a literal `reporters.webhook.headers.Authorization` value.
- [unit] `doctorCommand({ dir: "/repo", json: true })` awaits `_doctorDeps.runTrustGate("/repo")` before invoking `_doctorDeps.precheckCommand`.
- [unit] `doctorCommand({ dir: "/repo", json: true })` invokes `_doctorDeps.precheckCommand` once with `{ dir: "/repo", json: true, light: true }`.
- [cli] Running `nax doctor --json -d <fixture>`, where `<fixture>` is a plain non-git directory whose `.nax/config.json` holds a literal header value, prints JSON whose `warnings` include an entry named `config-secrets`.
- [cli] Running `nax doctor --json -d <fixture>` prints the same JSON payload as `nax precheck --light --json -d <fixture>` on the same fixture.

### US-003

- [unit] `createConfigReadGatePolicy(naxOwnedPathsPolicy, true).configRefusal(root, join(root, ".nax", "config.json"))` returns `undefined`.
- [unit] `createConfigReadGatePolicy(naxOwnedPathsPolicy, false).configRefusal(root, join(root, ".nax", "config.json"))` returns `NAX_CONFIG_REFUSAL` followed by `NAX_CONFIG_READ_DISABLED_SUFFIX`, and the suffix names `nax doctor`.
- [unit] `createConfigReadGatePolicy(naxOwnedPathsPolicy, false).configRefusal(root, join(root, "src", "a.ts"))` returns `undefined`.
- [unit] `createConfigReadGatePolicy(naxOwnedPathsPolicy, true).writeRefusal(tool, ".nax/mono/apps/api/config.json", { optIns: new Set() })` returns `'".nax/mono/apps/api/config.json" ' + NAX_CONFIG_WRITE_REFUSAL` for each `tool` in `Write`, `Edit`, `Delete`, `GitCommit`, `Git`, `ScratchpadWrite`.
- [unit] `createConfigReadGatePolicy(naxOwnedPathsPolicy, true).writeRefusal(tool, ".nax/config.json", { optIns: new Set() })` returns `undefined` for each `tool` in `NAX_CONFIG_READ_TOOLS`.
- [unit] `createConfigReadGatePolicy(naxOwnedPathsPolicy, true).writeRefusal("Write", ".nax/features/f/prd.json", { optIns: new Set() })` returns the same string as `naxOwnedPathsPolicy.writeRefusal` for those arguments.
- [unit] `createConfigReadGatePolicy(naxOwnedPathsPolicy, true).bashRefusal("Bash", ".nax/config.json", [configCandidate], { root, verb: "names", sandboxWrapped: true })` returns `undefined`.
- [unit] `createConfigReadGatePolicy(naxOwnedPathsPolicy, true).bashRefusal("Bash", ".nax/config.json", [configCandidate], { root, verb: "names", sandboxWrapped: false })` returns the same string as `naxOwnedPathsPolicy.bashRefusal` for those arguments.
- [unit] `createConfigReadGatePolicy(naxOwnedPathsPolicy, true).bashRefusal("Bash", ".nax/config.json", [configCandidate], { root, verb: "redirects into", sandboxWrapped: true })` returns the same string as `naxOwnedPathsPolicy.bashRefusal` for those arguments.
- [unit] `createConfigReadGatePolicy(naxOwnedPathsPolicy, true).bashRefusal("Bash", "x", [configCandidate, queueCandidate], { root, verb: "names", sandboxWrapped: true })` returns the same string as `naxOwnedPathsPolicy.bashRefusal` for those arguments.
- [unit] `createConfigReadGatePolicy(naxOwnedPathsPolicy, true).deniedEntries` is the same array as `naxOwnedPathsPolicy.deniedEntries`.
- [integration] Through `resolveCodingToolSupport` with `codingToolRoot` set to a root whose `.nax/config.json` is `{}` and `bashApproval` `"raw"`, `support.runtime.callTool("Read", { path: ".nax/config.json" })` returns kind `ok` with content `{}`.
- [integration] Through `resolveCodingToolSupport` with a root whose `.nax/config.json` is `{}`, `support.runtime.callTool("Write", { path: ".nax/config.json", content: "x" })` returns kind `denied` with a reason mentioning `quality.commands`, and the file still holds `{}`.
- [integration] Through `resolveCodingToolSupport` with declared tools including `ScratchpadWrite` and a root whose `.nax/config.json` is `{}`, `support.runtime.callTool("ScratchpadWrite", …)` targeting a scratchpad symlink that points at `.nax/config.json` returns kind `denied`, and the file still holds `{}`.
- [integration] Through `resolveCodingToolSupport` with declared tools including `Bash`, `bashApproval` `"gated"` and a root whose `.nax/config.json` is `{}`, `support.runtime.callTool("Read", { path: ".nax/config.json" })` returns kind `denied` with a reason naming `nax doctor`.
- [integration] Through `resolveCodingToolSupport` with `bashApproval` `"gated"` and a root whose `.nax/config.json` is `{}`, `support.runtime.callTool("Bash", { command: "echo x > .nax/config.json" })` returns kind `denied`, and the file still holds `{}`.
- [integration] Through `resolveCodingToolSupport` with a root whose `.nax/config.json` holds a literal `reporters.webhook.headers.Authorization` value, `support.runtime.callTool("Read", { path: ".nax/config.json" })` returns kind `denied` with a reason naming `nax doctor`.
- [integration] Through `resolveCodingToolSupport` with a root whose `.nax/config.json` is `{}` but whose `.nax/mono/apps/api/config.json` holds a literal header value, `support.runtime.callTool("Read", { path: ".nax/config.json" })` returns kind `denied`.
- [integration] `resolveCodingToolSupport({ codingToolRoot: root, declaredTools: ["Read"], … })` invokes `_codingToolSupportDeps.scanConfigSecrets` once with `root`.
- [integration] When `_codingToolSupportDeps.scanConfigSecrets` rejects, `resolveCodingToolSupport` resolves, and `support.runtime.callTool("Read", { path: ".nax/config.json" })` returns kind `denied`.

### US-004

- [unit] `buildNaxArtifactsSection("implementer", undefined, undefined, { configReadable: true })` returns text that includes `.nax/mono/<package>/config.json` and `quality.commands`.
- [unit] `buildNaxArtifactsSection("implementer")` returns the same string as `buildNaxArtifactsSection("implementer", undefined, undefined, { configReadable: false })`, and that string omits `quality.commands`.
- [integration] `PromptBuilder.for("tdd-simple").withLoader(join(root, "packages", "app"), config).configRoot(root).story(story).build()` resolves to a prompt that includes `.nax/mono/<package>/config.json` when `root/.nax/config.json` is `{}`.
- [integration] `PromptBuilder.for("tdd-simple").withLoader(root, config).configRoot(root).story(story).build()` resolves to a prompt that omits `.nax/mono/<package>/config.json` when `root/.nax/config.json` holds a literal `reporters.webhook.headers.Authorization` value.
- [integration] `PromptBuilder.for("tdd-simple").withLoader(root, config).configRoot(root).story(story).build()` resolves to a prompt that omits `.nax/mono/<package>/config.json` when `root` has no `.nax/config.json`.
- [integration] `PromptBuilder.for("tdd-simple").withLoader(root, config).story(story).build()` resolves to a prompt that omits `.nax/mono/<package>/config.json`, without invoking `_tddPromptBuilderDeps.scanConfigSecrets`, when `configRoot` is not called and `root/.nax/config.json` is `{}`.
- [integration] `PromptBuilder.for("tdd-simple").withLoader(root, config).configRoot(root).story(story).build()` resolves, with a prompt that omits `.nax/mono/<package>/config.json`, when `_tddPromptBuilderDeps.scanConfigSecrets` rejects.
- [integration] `promptStage.execute(ctx)`, with `ctx.projectDir` set to a root whose `.nax/config.json` is `{}` and `ctx.workdir` set to `join(root, "packages", "app")`, sets `ctx.prompt` to text that includes `.nax/mono/<package>/config.json`.
- [integration] `promptStage.execute(ctx)` invokes `_tddPromptBuilderDeps.scanConfigSecrets` once with `ctx.projectDir`.
- [integration] `TddPromptBuilder.buildForRole("implementer", join(root, "packages", "app"), config, story, { root })` resolves to a prompt that includes `.nax/mono/<package>/config.json` when `root/.nax/config.json` is `{}`.
- [integration] `TddPromptBuilder.buildForRole("implementer", root, config, story, {})` resolves to a prompt that omits `.nax/mono/<package>/config.json` when `opts.root` is undefined.
