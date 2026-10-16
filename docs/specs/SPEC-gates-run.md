# SPEC: Gates Run

## Summary

Phase 2 of #2569. A new command, `nax gates run [--gate <name>]... [--json]`, runs the project's configured root quality commands (`build`, `typecheck`, `lint`, `test`, `e2e`) through the same resolver and runner the workflow and finish phases use (`resolveGateCommands` + `runQualityGates`), one command per gate, and reports each gate as `passed`, `failed`, `not-run` or `timed-out`. Exit 127 (command not found) and 126 (not executable) mean the gate did not run, never that it ran and failed. `formatFix`, `formatFixScoped` and `lintFix` are never run. To report per gate, `runQualityGates` gains an optional `onGate` callback that hands the caller one record per gate as it finishes; its existing return value is unchanged. The command is mode-independent: it reads config and runs commands, and touches no workflow or PRD state.

## Motivation

The nax-finish skill's Step 6 ("Repo-root quality gates green") runs the gates by hand: the agent reads `quality.commands` out of the config itself and spawns each one. In one finish session a shell loop over the four configured commands returned exit 127 for every gate, because zsh does not word-split an unquoted `$cmd`, and the agent first reported the gates as having run. The skill now carries a paragraph of prose rules to prevent this: one tool call per gate, the command string exactly as configured, 127/126 is "did not run", never run `formatFix`/`lintFix` as a gate, use the unscoped variants. Every one of those rules is something nax already does correctly in `runQualityGates` (`packages/nax/src/finish/gates/quality.ts`): it resolves `quality.commands` through `loadConfig` (global layer, project file, active profile chain), runs `build -> typecheck -> lint -> test -> e2e` with no format/fix key, spawns each through `/bin/sh -c` from the project root, runs `e2e`'s `e2eSetup` bootstrap first, and treats "nothing configured" as not-verified. There is no CLI entry to it, so a finishing tool cannot reuse it.

`runQualityGates` also cannot say *how* a gate went red. It returns `{ passed, ran, failing, output }`, where `failing` lumps a 127 with a real test failure, and per-gate exit codes exist only inside the combined `output` text as `[<name>] exit=<n>` headers. A caller that wants `not-run` vs `failed` would have to parse that text. A per-gate record removes the parse.

## Design

### Integration

Symbols this feature **only reads** (verified on `main` `2896d01e9`):

- `resolveGateCommands(repoRoot: string, packageDirs: string[]): Promise<GateCommand[]>` (`packages/nax/src/finish/gates/quality.ts:89`). With `packageDirs = []` it returns only the root gates, in `GATE_ORDER` (`["build", "typecheck", "lint", "test", "e2e"]`, `quality.ts:41`), skipping a gate whose command is unset or blank, and attaching `e2eSetup` as `setup` on the `e2e` gate. It never yields `formatFix`, `formatFixScoped`, `lintFix` or any `*Scoped` key. It loads config through `_qualityGateDeps.loadConfig(repoRoot)`, which throws on an invalid config.
- `GateCommand` (`quality.ts:46`): `{ name: string; command: QualityCommandSpec; cwd: string; setup?: QualityCommandSpec }`. Root gates have `name` equal to the gate key and `cwd` equal to `repoRoot`.
- `DEFAULT_GATE_TIMEOUT_MS = 900_000` (`quality.ts:44`).
- `runQualityCommand(opts: QualityCommandOptions): Promise<QualityCommandResult>` (`packages/nax/src/quality/runner.ts:326`), reached through `_qualityGateDeps.run`. `QualityCommandResult` is `{ commandName, command: string, success, exitCode: number, output, durationMs, timedOut }` (`runner.ts:75`). A timeout returns `exitCode: -1, timedOut: true`; a spawn error returns `exitCode: -1, timedOut: false`; a shell that cannot find or execute the command returns the shell's 127 or 126. A list-valued spec runs every entry and reports the first non-zero exit code (`aggregateResults`, `src/quality/aggregate.ts:8`). It calls `assertTrusted(workdir, "quality-command")` first and throws `NaxError` code `PROJECT_UNTRUSTED` for an untrusted workdir.
- `ensureProjectTrusted(root: string, options: { interactive: boolean }): Promise<void>` (`src/trust/gate.ts:46`): marks the root trusted for this process when the trust store covers it, prompts when `interactive` is true, and otherwise throws `NaxError` code `PROJECT_UNTRUSTED` (with `context.hint`, the grant command) or `TRUST_STORE_UNREADABLE`.
- `findProjectDir(startDir: string): string | null` (`src/config`): the nearest `.nax` directory at or above `startDir` that holds a `config.json`, or `null`. It can return the global config directory when `startDir` sits under it.
- `globalConfigDir(): string` (`src/config/paths/index.ts:63`): `process.env[GLOBAL_CONFIG_DIR_ENV]` when set, else `~/.nax`.
- `normalizeTrustPath(path: string): Promise<string>` (`src/trust/match.ts:49`): the absolute, symlink-resolved form of a path (on macOS a temp dir under `/var` becomes `/private/var`).
- `resolveTrustRoot(workdir)` (`src/trust/match.ts:30`) and `realOrRaw(path)` (imported by `match.ts` from `@nathapp/nax-agent/internal`; `src/cli/gates.ts` imports it from there too): the precedent for the root derivation below; `resolveTrustRoot` excludes the global config directory by comparing `realOrRaw(naxDir)` with `realOrRaw(globalConfigDir())`, and falls back to `resolve(workdir)` instead of signalling "no project", so the command does not call it.
- `runTrustGate(workdir)` (`src/cli/trust-gate.ts:48`): the shared CLI trust gate. It exits the process with code 2 on refusal. The gates command does not call it, because exit 2 means "the gates ran and something is not green" here; an untrusted project means nax could not run the gates at all, which is exit 1. The command calls `ensureProjectTrusted` itself and maps the same two refusal codes, with the same messages, to exit 1.
- The workflow's red-gate excerpt keeps 40 lines (`GATE_EXCERPT_LINES`, `src/workflow/repo-gates.ts:8`). The new `gateOutputTail` helper (US-001) lives in `src/finish/gates/quality.ts` with its own 40-line default, and `src/cli/gates.ts` does **not** import `src/workflow/repo-gates.ts`: that module imports `./feature-deps`, which imports the `@/finish` barrel, whose `context.ts` value-imports from `@/cli`, which re-exports `src/cli/gates.ts` — a runtime import cycle.
- `registerWorkflowCommand(program, deps)` / `_workflowCliDeps` / `guarded` (`src/cli/workflow.ts`): the pattern for a command group with injectable `log` / `logErr` / `exit`, `--json` printing one document to stdout, and `{"error": "<message>"}` on stdout for a `--json` error. Registered in `bin/nax.ts` and re-exported from `src/cli/index.ts`.

Symbols this feature **changes**. The baseline only locates the code; it is never the interface to implement.

- `runQualityGates` (`src/finish/gates/quality.ts:175`)
  - Baseline: `runQualityGates(repoRoot: string, commands: GateCommand[], opts: { timeoutMs?: number } = {}): Promise<QualityGateResult>`
  - Target: `opts: { timeoutMs?: number; onGate?: (record: GateRunRecord) => void }`. When `onGate` is given it is called exactly once per gate, synchronously, after that gate finishes and before the next gate starts, in run order. An exception thrown by `onGate` propagates out of `runQualityGates`. The returned `QualityGateResult` (`{ passed, ran, failing, output }`) is byte-for-byte what it is today, with or without `onGate`: a `not-run` or `timed-out` gate is still in `failing`.
- `GATE_ORDER` (`quality.ts:41`)
  - Baseline: file-local `const GATE_ORDER = ["build", "typecheck", "lint", "test", "e2e"] as const`.
  - Target: the same value, exported and re-exported from `src/finish/index.ts`, so `src/cli/gates.ts` validates `--gate` against it instead of a second copy of the list.
- `runGateSetup` (`quality.ts:155`, file-local)
  - Baseline: returns the failure chunk string, or `null` when there is no setup or it passed.
  - Target: free to change shape (it is not exported) so that `runQualityGates` can build a `GateRunRecord` from the setup's `QualityCommandResult` when the setup fails. The failure chunk written to `output` is unchanged.

New symbols, exported from `src/finish/gates/quality.ts` and re-exported from `src/finish/index.ts`:

```typescript
export type GateRunStatus = "passed" | "failed" | "not-run" | "timed-out";

export interface GateRunRecord {
  /** The GateCommand name: "build", "test", ... */
  readonly name: string;
  /** Absolute directory the command was spawned from. */
  readonly cwd: string;
  readonly status: GateRunStatus;
  /** The exit code that decided the status: -1 for a single command's timeout or spawn error; for a list-valued command, the first non-zero step's code. */
  readonly exitCode: number;
  readonly durationMs: number;
  /** Present, as "setup", only when the gate's setup bootstrap failed and the command never ran. */
  readonly failedPhase?: "setup";
  /** The raw output of whichever run decided the status (setup or command). */
  readonly output: string;
}

/** The status for one QualityCommandResult. */
export function classifyGateExit(res: { readonly exitCode: number; readonly timedOut: boolean }): GateRunStatus;

/** The last `lines` lines of `output` after trailing newlines are removed, joined with "\n"; "" when nothing is left. */
export function gateOutputTail(output: string, lines?: number): string; // lines defaults to 40
```

`classifyGateExit` rules, applied in this order: `timedOut === true` -> `timed-out`; `exitCode === 0` -> `passed`; `exitCode` is `127`, `126` or `-1` -> `not-run`; any other exit code -> `failed`.

New module `src/cli/gates.ts`:

```typescript
export interface GatesCliDeps {
  log: (msg: string) => void;
  logErr: (msg: string) => void;
  exit: (code: number) => void;
  isInteractive: () => boolean;
  ensureProjectTrusted: typeof ensureProjectTrusted;
  resolveGateCommands: typeof resolveGateCommands;
  runQualityGates: typeof runQualityGates;
}
export const _gatesCliDeps: GatesCliDeps;

export interface GatesRunOptions {
  readonly dir: string;
  /** Gate keys to run; empty means every configured root gate. */
  readonly gates: readonly string[];
  readonly json: boolean;
}

export interface GatesRunReport {
  /** Absolute project root the gates ran from. */
  readonly projectDir: string;
  /** True only when at least one gate ran and every gate is "passed". */
  readonly passed: boolean;
  readonly gates: readonly GateReportEntry[];
  readonly summary: { readonly passed: number; readonly failed: number; readonly notRun: number; readonly timedOut: number };
}

export interface GateReportEntry {
  readonly name: string;
  readonly status: GateRunStatus;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly failedPhase?: "setup";
  /** `gateOutputTail(record.output)`; absent for a "passed" gate. */
  readonly outputTail?: string;
}

/** Runs the gates, prints the report, and returns the exit code. */
export function gatesRunCommand(opts: GatesRunOptions, deps?: GatesCliDeps): Promise<number>;

/** Registers `nax gates` with its `run` subcommand. */
export function registerGatesCommand(program: Command, deps?: GatesCliDeps): Command;
```

`src/cli/gates.ts` imports `resolveGateCommands`, `runQualityGates` and the new types from `../finish/gates/quality` by relative path, not through the `@/finish` barrel, because `src/finish` imports types from `@/cli` and `@/cli` re-exports this module; `bun run check:import-cycles` must stay clean (the same reason `src/cli/workflow.ts` gives for its relative imports).

### CLI Behavior

```
nax gates run [-d, --dir <path>] [--gate <name>]... [--json]
```

- `-d, --dir <path>` (default `process.cwd()`): any directory inside the project. `naxDir = findProjectDir(dir)`. When `naxDir` is `null`, or `realOrRaw(naxDir)` equals `realOrRaw(globalConfigDir())`, there is no project `.nax/config.json` at or above `dir` and the command fails with `no nax project found at or above <dir>`. Otherwise `projectDir = await normalizeTrustPath(dirname(naxDir))`; every later step (trust, `resolveGateCommands`, `runQualityGates`, the report's `projectDir`) uses that value.
- `--gate <name>`: repeatable. Each value must be one of `build`, `typecheck`, `lint`, `test`, `e2e`. Gates run in `GATE_ORDER` whatever order the flags were given in, and a repeated value runs once. A value outside that list fails with `unknown gate <name>; expected one of build, typecheck, lint, test, e2e`. A known gate that the project does not configure fails with `gate <name> is not configured; configured gates: <names>` (`configured gates: none` when there are none). No gate runs in either case.
- `--json`: stdout carries exactly one JSON document, the `GatesRunReport`, or `{"error": "<message>"}` when the command fails before reporting. Nothing else is written to stdout.
- Trust: before any config is loaded or command spawned, the command calls `ensureProjectTrusted(projectDir, { interactive })`, where `interactive` is `deps.isInteractive()` and `--json` is not set. `PROJECT_UNTRUSTED` fails the command with the two lines `Project not trusted: <projectDir>` and the error's `context.hint` (or `run: nax trust add <projectDir>` when the hint is absent); `TRUST_STORE_UNREADABLE` fails it with the error's message.
- Validation order, each step running only when every earlier one passed: (1) every `--gate` value is a known gate key (pure, no I/O); (2) project root resolution; (3) trust; (4) `resolveGateCommands(projectDir, [])`; (5) every `--gate` value is configured; (6) the gates run. A failure at any step returns before the next step starts.
- Sequence: the gates run one at a time, through `runQualityGates(projectDir, commands, { onGate })`, with the default timeout. The run is not stopped by a red gate; every selected gate runs.
- Error output: `gatesRunCommand` wraps steps 1-6 in one try/catch, like `workflowStatusCommand`, so any failure in any step (including an error thrown by `runQualityGates` mid-run, such as `assertTrusted` refusing inside `runQualityCommand`) returns 1 and is reported, and records of gates that already finished are discarded. Without `--json` the message lines go to stderr through `deps.logErr`, one call per line, with no prefix, and nothing goes to stdout. With `--json` stdout gets one line, `JSON.stringify({ error: message })`, where a two-line message (the untrusted case) is joined with `"; "`, and nothing goes to stderr. `guarded` (as in `src/cli/workflow.ts`) only catches what escapes that try/catch.
- Logging: `registerGatesCommand` does not call `initLogger`, so `runQualityCommand`'s log records never reach stdout and the `--json` single-document guarantee holds.

Exit codes (the same convention as `nax workflow status`: 1 = nax could not answer, 2 = a human must look):

| Exit | Meaning |
|:---|:---|
| 0 | At least one gate ran and every gate is `passed`. |
| 1 | The command failed before reporting: no project, untrusted project, unreadable trust store, invalid config, unknown or unconfigured `--gate`, or any other thrown error. |
| 2 | The gates were resolved and run, and at least one is `failed`, `not-run` or `timed-out`; or no gate is configured at all (nothing was verified). |

Plain output (stdout), one line per gate in run order, then the tail of each gate that did not pass, then a summary line:

```
passed     build      12.3s
failed     test       exit=1    48.0s
not-run    lint       exit=127  0.0s  (command not found or not executable; the gate did not run)
timed-out  e2e        900.0s

--- test (last 40 lines) ---
<outputTail>

--- lint (last 40 lines) ---
<outputTail>

--- e2e (last 40 lines) ---
<outputTail>

gates: 1 passed, 1 failed, 1 not run, 1 timed out
```

Every non-passed gate, `timed-out` included, gets a tail block. The column widths and the duration format in the example are illustrative and left to the builder. A gate line shows `exit=<n>` for every status except `passed` and `timed-out`; the `not-run` line always carries the same note, whatever the code (127, 126 or -1). A setup failure appends `(setup failed)` to its gate line. With nothing configured, plain output is the single line `no quality.commands configured in <projectDir>/.nax/config.json; nothing was verified`.

`outputTail` is `gateOutputTail(record.output)`: trailing newlines removed, split on `\n`, the last 40 lines joined with `\n`. An `output` that is empty after trimming gives an empty `outputTail` string, which is still present on a non-passed entry.

A list-valued command reports the first non-zero exit code among its steps (`aggregateResults`). So a list whose first step exits 127 is `not-run` even when a later step ran and failed; the gate is red either way, and the `outputTail` shows every step's output.

`--json` example:

```json
{
  "projectDir": "/repo",
  "passed": false,
  "gates": [
    { "name": "build", "status": "passed", "exitCode": 0, "durationMs": 12300 },
    { "name": "lint", "status": "not-run", "exitCode": 127, "durationMs": 4, "outputTail": "/bin/sh: biome: command not found" }
  ],
  "summary": { "passed": 1, "failed": 0, "notRun": 1, "timedOut": 0 }
}
```

### Failure Handling

| Case | Behaviour |
|:---|:---|
| No `.nax/config.json` at or above `--dir` | Exit 1, `no nax project found at or above <dir>`; nothing loaded or spawned. |
| Untrusted project | Exit 1, `Project not trusted: <root>` plus the grant hint; nothing loaded or spawned (fail-closed). |
| Trust store unreadable | Exit 1 with the store error's message; nothing spawned. |
| Invalid config (`resolveGateCommands` throws) | Exit 1 with the thrown message. |
| Unknown or unconfigured `--gate` | Exit 1 with the message above; no gate runs. |
| No gate configured | Exit 2; `passed: false`, `gates: []` in JSON. Not a pass. |
| Gate exits 127 or 126, or fails to spawn (-1, not timed out) | `not-run`; counted in `summary.notRun`; exit 2. |
| Gate times out | `timed-out`; exit 2. |
| `e2e` setup fails | The gate's status is `classifyGateExit` of the setup result, `failedPhase: "setup"`; the `e2e` command is not run. |
| A red gate | Later gates still run; no retry. |

## Out of Scope

- Package overlay gates (`<gate>@<packageDir>` from `.nax/mono/<pkg>/config.json`) are not run by `nax gates run`; it runs the root `quality.commands` only, matching the nax-finish Step 6 contract that root commands delegate to the workspace orchestrator.
- `formatFix`, `formatFixScoped`, `lintFix` and every `*Scoped` command are never run by `nax gates run`, and no flag enables them.
- A `--profile` flag on `nax gates run` is out of scope; the profile chain applies through `NAX_PROFILE` and the config files, as `loadConfig` already resolves it.
- A `--timeout` flag is out of scope; each gate uses `DEFAULT_GATE_TIMEOUT_MS`.
- Running gates in parallel is out of scope; they run sequentially in `GATE_ORDER`.
- The workflow's own repo and final gates (`runRepoGates`, `src/workflow/repo-gates.ts`) keep their current behaviour; they do not adopt `GateRunStatus`, and a 127 there stays a red gate.
- `nax workflow record` and `nax workflow promote` are phase 3 of #2569 and are not part of this spec.
- Updating the nax-finish skill to call `nax gates run` happens in the nax-toolkit-skills repo, outside this run.

## Stories

### US-001: Per-gate run records from runQualityGates

Workdir: `packages/nax`. No dependencies.

Add `GateRunStatus`, `GateRunRecord`, `classifyGateExit` and `gateOutputTail` to `src/finish/gates/quality.ts`, export `GATE_ORDER`, re-export all of them from `src/finish/index.ts`, and add the optional `onGate` callback to `runQualityGates`'s options. `runQualityGates` builds one record per gate from the `QualityCommandResult` that decided it (the setup result when setup failed, otherwise the command result) and passes it to `onGate`. The `QualityGateResult` it returns does not change.

### US-002: The nax gates run command

Workdir: `packages/nax`. Depends on US-001.

Add `src/cli/gates.ts` with `gatesRunCommand`, `registerGatesCommand`, `_gatesCliDeps` and the report types, following the `src/cli/workflow.ts` pattern. Register it in `bin/nax.ts` next to `registerWorkflowCommand(program)` and re-export it from `src/cli/index.ts`; like the `workflow` group, the `bin/nax.ts` line is verified by `bun run build`, `bun run typecheck` and `bun run check:import-cycles`, not by an acceptance criterion. Add a `### nax gates run` section to `docs/guides/cli-reference.md` describing the flags, the four statuses and the exit codes.

### Context Files

**US-001**

- `packages/nax/src/finish/gates/quality.ts` — `runQualityGates`, `runGateSetup`, `GateCommand`, `GATE_ORDER`
- `packages/nax/src/quality/runner.ts` — `QualityCommandResult`, timeout and spawn-error exit codes
- `packages/nax/src/quality/aggregate.ts` — the exit code a list-valued command reports
- `packages/nax/src/finish/index.ts` — the finish barrel's existing re-exports
- `packages/nax/test/unit/finish/gates-quality.test.ts` — the `_qualityGateDeps` stubbing pattern

**US-002**

- `packages/nax/src/cli/workflow.ts` — the command-group pattern to mirror (deps, `--json`, `guarded`, exit codes)
- `packages/nax/src/finish/gates/quality.ts` — `resolveGateCommands`, `runQualityGates`, `GateRunRecord`, `classifyGateExit`
- `packages/nax/src/trust/gate.ts` — `ensureProjectTrusted` and its two refusal codes
- `packages/nax/bin/nax.ts` — where `registerWorkflowCommand(program)` is registered
- `packages/nax/test/unit/cli/workflow-status.test.ts` — the CLI test pattern with injected deps

### Creates

**US-002**

- `packages/nax/src/cli/gates.ts`
- `packages/nax/test/unit/cli/gates.test.ts`

### Modifies

**US-001**
- `packages/nax/src/finish/gates/quality.ts` — adds `GateRunStatus`, `GateRunRecord`, `classifyGateExit`, `gateOutputTail`, exports `GATE_ORDER`, and adds the optional `onGate` option on `runQualityGates`; `runGateSetup` may change shape so a failed setup yields its `QualityCommandResult`. The returned `QualityGateResult` and the `output` text are unchanged, so no existing gate-runner or workflow repo-gate test assertion breaks.
- `packages/nax/src/finish/index.ts` — re-exports `GateRunStatus`, `GateRunRecord`, `classifyGateExit`, `gateOutputTail` and `GATE_ORDER` next to the existing `runQualityGates` export.
- `packages/nax/test/unit/finish/gates-quality.test.ts` — US-001's acceptance tests are added to this file (the project's test-architecture rule: an existing file under ~650 lines takes new tests); no existing test in it changes.

**US-002**
- `packages/nax/bin/nax.ts` — registers the `gates` command group with `registerGatesCommand(program)` next to `registerWorkflowCommand(program)`.
- `packages/nax/src/cli/index.ts` — re-exports `registerGatesCommand`, `gatesRunCommand`, `_gatesCliDeps` and the `GatesCliDeps`, `GatesRunOptions`, `GatesRunReport` and `GateReportEntry` types.
- `docs/guides/cli-reference.md` — adds a `### nax gates run` section: the flags, the four statuses and the exit codes.

### Seams

- US-002 consumes `runQualityGates`'s `onGate` callback and `classifyGateExit`'s statuses from US-001. US-002's tests stub `runQualityGates` through `_gatesCliDeps` and drive `onGate` with `GateRunRecord`s, and one test runs the real `runQualityGates` with a stubbed `_qualityGateDeps.run` so that the exit code reaching the report comes from the runner.

## Acceptance Criteria

### US-001

1. [unit] `classifyGateExit({ exitCode: 0, timedOut: false })` returns `"passed"`.
2. [unit] `classifyGateExit({ exitCode: 1, timedOut: false })` returns `"failed"`.
3. [unit] `classifyGateExit({ exitCode: 2, timedOut: false })` returns `"failed"`.
4. [unit] `classifyGateExit({ exitCode: 127, timedOut: false })` returns `"not-run"`.
5. [unit] `classifyGateExit({ exitCode: 126, timedOut: false })` returns `"not-run"`.
6. [unit] `classifyGateExit({ exitCode: -1, timedOut: false })` returns `"not-run"`.
7. [unit] `classifyGateExit({ exitCode: -1, timedOut: true })` returns `"timed-out"`.
8. [unit] `classifyGateExit({ exitCode: 0, timedOut: true })` returns `"timed-out"`, because the timeout check comes before the exit-code check.
9. [unit] With `_qualityGateDeps.run` stubbed to return exit codes 0, 127 and 1 for gates `build`, `lint` and `test` (each from cwd `/repo`), `runQualityGates("/repo", commands, { onGate })` calls `onGate` exactly three times, with records whose `name` values are `build`, `lint`, `test` in that order and whose `status` values are `passed`, `not-run`, `failed`.
10. [unit] In the same run, each record's `exitCode`, `durationMs` and `output` equal the stubbed `QualityCommandResult`'s `exitCode`, `durationMs` and `output` for that gate, and its `cwd` equals the gate's `GateCommand.cwd`.
11. [unit] `onGate` for a gate is called before `_qualityGateDeps.run` is called for the next gate: with two gates, the stub records the order of calls, and the first `onGate` call comes before the second `run` call.
12. [unit] The `QualityGateResult` returned by `runQualityGates` for the same three stubbed gates is identical with and without `onGate`: `passed` false, `ran` `["build", "lint", "test"]`, `failing` `["lint", "test"]`, and the same `output` text.
13. [unit] When an `e2e` gate's `setup` command returns exit code 1, `onGate` receives one record for `e2e` with `status` `"failed"`, `failedPhase` `"setup"`, `exitCode` 1 and the setup result's `output`, and `_qualityGateDeps.run` is never called with the `e2e` command itself.
14. [unit] When an `e2e` gate's `setup` command returns exit code 127, its record's `status` is `"not-run"` and `failedPhase` is `"setup"`.
15. [unit] When a gate's setup passes and its command returns exit code 0, the record's `status` is `"passed"` and the record has no `failedPhase` key.
16. [unit] When `_qualityGateDeps.run` returns `{ exitCode: -1, timedOut: true }` for `test`, the `test` record's `status` is `"timed-out"` and `exitCode` is -1.
17. [unit] `runQualityGates("/repo", [], { onGate })` never calls `onGate` and still returns `passed` false with `ran` `[]`.
18. [unit] `classifyGateExit` imported from `@/finish` (not from `src/finish/gates/quality.ts`) returns `"not-run"` for exit code 127.
19. [unit] `gateOutputTail` called with 100 lines `line1` to `line100` followed by a trailing newline returns `line61` to `line100` joined with `\n`, with no trailing newline.
20. [unit] `gateOutputTail("")` and `gateOutputTail("\n\n")` both return the empty string.
21. [unit] `GATE_ORDER` imported from `@/finish` equals `["build", "typecheck", "lint", "test", "e2e"]`.

### US-002

All US-002 tests inject `GatesCliDeps` with recording `log` / `logErr` / `exit` stubs. Except in AC19, AC20, AC21 and AC22, `dir` is a temporary directory holding `.nax/config.json`, so project resolution passes and `projectDir` is its `normalizeTrustPath` form, written `/repo` below for brevity.

1. [unit] With `resolveGateCommands` stubbed to return `build`, `lint` and `test` and `runQualityGates` stubbed to call `onGate` with records of status `passed`, `not-run` (exit 127) and `failed` (exit 1), `gatesRunCommand({ dir, gates: [], json: true }, deps)` returns 2 and logs exactly one line to stdout that parses as JSON with `passed` false and `summary` `{ passed: 1, failed: 1, notRun: 1, timedOut: 0 }`.
2. [unit] In that JSON report, the `gates` entries carry `name`, `status`, `exitCode` and `durationMs` from their records in run order, the `lint` entry has `status` `"not-run"` and `exitCode` 127, and the `build` entry (status `passed`) has no `outputTail` key.
3. [unit] When a `failed` record's `output` is 100 lines `line1` to `line100` followed by a trailing newline, its report entry's `outputTail` is `line61` to `line100` joined with `\n`, with no trailing newline.
4. [unit] When every record is `passed`, `gatesRunCommand` returns 0 and the JSON report has `passed` true.
5. [unit] When one record is `timed-out` and the rest are `passed`, `gatesRunCommand` returns 2 and `summary.timedOut` is 1.
6. [unit] When `resolveGateCommands` returns `[]`, `gatesRunCommand` returns 2 without calling `runQualityGates`, and the JSON report has `passed` false and `gates` `[]`.
7. [unit] When `resolveGateCommands` returns `[]` and `json` is false, the only stdout line is `no quality.commands configured in /repo/.nax/config.json; nothing was verified`.
8. [unit] `gatesRunCommand` calls `resolveGateCommands` with the project root `/repo` and an empty `packageDirs` array, and calls `runQualityGates` with `/repo` as its first argument.
9. [unit] With `gates: ["test", "build", "test"]` and `build`, `lint` and `test` configured, `runQualityGates` receives exactly the `build` and `test` `GateCommand`s, in that order, each once.
10. [unit] With `gates: ["format"]` and `json` true, `gatesRunCommand` returns 1, calls none of `ensureProjectTrusted`, `resolveGateCommands` and `runQualityGates`, and logs exactly one stdout line, which parses as JSON equal to `{ error: "unknown gate format; expected one of build, typecheck, lint, test, e2e" }`.
11. [unit] With `gates: ["e2e"]` and only `build` and `test` configured, `gatesRunCommand` returns 1, never calls `runQualityGates`, and with `json` true the error message is `gate e2e is not configured; configured gates: build, test`.
12. [unit] When `ensureProjectTrusted` throws a `NaxError` with code `PROJECT_UNTRUSTED` and `context.hint` `run: nax trust add /repo`, and `json` is false, `gatesRunCommand` returns 1, never calls `resolveGateCommands`, calls `logErr` with `Project not trusted: /repo` and then with `run: nax trust add /repo`, and logs nothing to stdout.
13. [unit] In the same untrusted case with `json` true, the only stdout line parses as JSON equal to `{ error: "Project not trusted: /repo; run: nax trust add /repo" }` and `logErr` is never called.
14. [unit] When `ensureProjectTrusted` throws a `NaxError` with code `TRUST_STORE_UNREADABLE`, `gatesRunCommand` returns 1 and never calls `resolveGateCommands`.
15. [unit] `gatesRunCommand` calls `ensureProjectTrusted` with `{ interactive: false }` when `json` is true, even when `isInteractive()` returns true, and with `{ interactive: true }` when `json` is false and `isInteractive()` returns true.
16. [unit] When `resolveGateCommands` throws `Error("invalid config: quality.commands.test")`, `gatesRunCommand` returns 1 and with `json` true logs exactly one stdout line, which parses as JSON equal to `{ error: "invalid config: quality.commands.test" }`.
17. [unit] With `json` false and records `passed` for `build` and `not-run` (exit 126) for `lint`, stdout includes a `lint` line containing `not-run`, `exit=126` and `the gate did not run`, a `--- lint (last 40 lines) ---` line, and the summary line `gates: 1 passed, 0 failed, 1 not run, 0 timed out`.
18. [unit] With `json` false and an `e2e` record with status `failed` and `failedPhase` `"setup"`, the `e2e` gate line ends with `(setup failed)`.
19. [unit] When `dir` is a temporary directory with no `.nax/config.json` at or above it and `json` is false, `gatesRunCommand` returns 1, never calls `ensureProjectTrusted`, calls `logErr` once with `no nax project found at or above <dir>`, and logs nothing to stdout.
20. [unit] When the global config directory env override (`GLOBAL_CONFIG_DIR_ENV`) points at `<tmp>/home/.nax`, that directory holds a `config.json`, and `dir` is `<tmp>/home`, `gatesRunCommand` returns 1 with `no nax project found at or above <tmp>/home` and never calls `ensureProjectTrusted`.
21. [unit] When `dir` is `<root>/packages/a` inside a temporary project whose `.nax/config.json` sits at `<root>`, `ensureProjectTrusted` and `resolveGateCommands` both receive `await normalizeTrustPath(<root>)`, not `<root>/packages/a`.
22. [integration] In a temporary project whose `.nax/config.json` exists, with `_qualityGateDeps.loadConfig` stubbed to configure `lint: "biome check ."` and `formatFix: "biome format --write ."`, `_qualityGateDeps.run` stubbed to return exit code 127, and `ensureProjectTrusted` stubbed to resolve, `gatesRunCommand` run with the real `resolveGateCommands` and `runQualityGates` returns 2, reports `lint` as `not-run` with `exitCode` 127, and `_qualityGateDeps.run` is called exactly once, with `commandName` `lint`, never with the `formatFix` command.
23. [unit] `registerGatesCommand(program, deps)` imported from `@/cli` registers a `gates` command whose only subcommand is `run`, and parsing `gates run --gate test --gate build --json -d <dir>` calls `deps.exit` with the code `gatesRunCommand` returns for `{ dir: <dir>, gates: ["test", "build"], json: true }`.
24. [unit] When `runQualityGates` throws `Error("spawn refused")` after calling `onGate` once with a `passed` record, `gatesRunCommand` with `json` true returns 1 and logs exactly one stdout line, which parses as JSON equal to `{ error: "spawn refused" }`.
