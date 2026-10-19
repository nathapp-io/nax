# SPEC: October 19 issue bundle (features resolve status, global MCP lock, pre-run setup step, cost ledger query)

Closes: #2319, #2408, #2521, #2595

## Summary

Four independent fixes and additions, bundled into one run:

1. `nax features resolve` stops reporting a config-validation failure as `acceptance.status: "no-prd"`, and resolves config under the same profile chain `nax run` uses (#2319).
2. A global `mcp-lock.json` under the global config dir pins MCP tools for projects that have no lock of their own; a project lock, when present, fully overrides it (#2408).
3. A new `execution.preRun` config key runs blocking host-side setup commands (e.g. starting a compose test database) once per run, before the run-start test baseline and before any story; a failing step stops the run (#2521).
4. A new read-only `nax cost` command aggregates the per-call cost ledger across projects by date range, with token splits, grouping, and an exact-vs-estimated split (#2595).

The four parts share no code; each story is independently testable.

## Motivation

- **#2319.** `resolveFeatureAcceptance` (`packages/nax/src/cli/features-acceptance.ts`) catches every error, including `CONFIG_SCHEMA_INVALID` from `loadConfig`, and returns `status: "no-prd"`. `--json` callers (the nax-finish skill, `finish/context.ts`) cannot tell "no PRD" from "config invalid". It also calls `loadConfig(workdir)` with no profile, so a config that only validates under the profile the PRD was planned with always fails here even though `nax run` succeeds (`nax run` adopts the PRD's `routingProfile` via `resolveRunProfileOverride`).
- **#2408.** The MCP tool lock is read only from `<projectRoot>/.nax/mcp-lock.json` (`mcpLockPath` in `src/mcp/lock.ts`). A user who defines MCP servers once in `~/.nax/config.json` must lock and commit in every project; a lock under `~/.nax/` is ignored, and a project with no lock withholds every tool.
- **#2521.** Agent sessions are sandboxed and cannot start services the tests need. The only host-side hook today is `on-start`, which is fire-and-forget, logs-and-continues on failure, has a 5 s default timeout, and fires only after the run-start baseline has already run the test suite. A downstream run recently started with its test database down: the run-start baseline counted 80 failures it could not name and recorded them as pre-existing, so story gates could not tell a real DB-test regression from the outage.
- **#2595.** There is no CLI answer to "what did nax spend today, and on what?". `nax status --cost` reads one project's `metrics.json`, has no time window, no token split, no grouping, and cannot separate provider-reported (`confidence: "exact"`) from catalog-estimated cost. The data already exists in `~/.nax/<project>/cost/<runId>.jsonl`.

## Design

### Part A — features resolve (US-001)

#### Integration

This part changes two signatures. The baseline is stated only to locate the code; it is never the interface to implement.

**`AcceptanceResolutionStatus` / `AcceptanceResolution`** — `src/cli/features-acceptance.ts:37` (US-001)
- Baseline: `type AcceptanceResolutionStatus = "ok" | "disabled" | "no-prd"`; `AcceptanceResolution { status; enabled; groups }`.
- Target:
  ```typescript
  export type AcceptanceResolutionStatus = "ok" | "disabled" | "no-prd" | "error";
  export interface AcceptanceResolutionError {
    /** NaxError code when the thrown error is a NaxError (e.g. "CONFIG_SCHEMA_INVALID"), else "UNKNOWN". */
    code: string;
    /** errorMessage(err) of the caught error. */
    message: string;
  }
  export interface AcceptanceResolution {
    status: AcceptanceResolutionStatus;
    enabled: boolean;
    groups: AcceptanceGroupResult[];
    /** Present only when status === "error". */
    error?: AcceptanceResolutionError;
  }
  ```

**`resolveFeatureAcceptance`** — `src/cli/features-acceptance.ts:56` (US-001)
- Baseline: `resolveFeatureAcceptance(featureName: string, workdir: string): Promise<AcceptanceResolution>`.
- Target: `resolveFeatureAcceptance(featureName: string, workdir: string, configOverrides?: Record<string, unknown>): Promise<AcceptanceResolution>` — `configOverrides` is passed as the second argument of `loadConfig(workdir, configOverrides)`.

**`resolveFeatureSpec`** — `src/cli/features-resolve.ts` (US-001)
- Baseline: `resolveFeatureSpec(name: string | undefined, workdir: string): Promise<ResolveResult>`.
- Target: `resolveFeatureSpec(name: string | undefined, workdir: string, opts?: { profile?: string[]; envProfile?: string }): Promise<ResolveResult>`. `opts.envProfile` defaults to `process.env.NAX_PROFILE`. For a resolved feature it computes the profile chain once with `resolveRunProfileOverride({ prdPath: join(featureDir(repoRoot, name), "prd.json"), projectRoot: workdir, cliProfile: opts.profile, envProfile })` (`featureDir` is the helper at `src/config/paths/index.ts:119`) and, when the chain is non-empty, passes `{ profile: chain }` as the config overrides to both `resolveFeatureAcceptance` and the module-private `resolveTestPatterns`.

Read, not changed: `resolveRunProfileOverride` (`src/cli/resolve-run-profile.ts:21`, precedence CLI `--profile` > `NAX_PROFILE` > PRD `routingProfile`), `loadConfig(startDir?, cliOverrides?)` (`src/config/loader.ts:294`), `collectProfile` (`bin/nax.ts:139`), `NaxError.code`.

#### Status rules (ordered; first match wins)

| Condition | status | error |
|:---|:---|:---|
| No `.nax/` dir found from `workdir` | `no-prd` | absent |
| `loadConfig` throws | `error` | `{ code, message }` of the thrown error |
| `acceptance.enabled` resolves `false` | `disabled` | absent |
| `<naxDir>/features/<name>/prd.json` does not exist | `no-prd` | absent |
| `loadPRD`, grouping or command resolution throws | `error` | `{ code, message }` of the thrown error |
| otherwise | `ok` | absent |

`resolveFeatureAcceptance` still never throws. The existing `warn` log on a caught error stays.

#### CLI Behavior

`nax features resolve [name]` gains `--profile <name>` (comma-separated or repeated, using `collectProfile`, same as `run`/`plan`). The command's exit codes and stdout/stderr split are unchanged: exit 0 when `result.status === "ok"`, 1 on hard error or `not-a-nax-repo`, 2 otherwise; the JSON document goes to stdout. An `acceptance.status` of `"error"` does not change the exit code (the top-level `status` still decides it).

### Part B — global MCP lock (US-002)

#### Integration

**`McpWithheldEntry`** — `src/mcp/provider.ts:24` (US-002)
- Baseline: `{ serverId: string; name: string; reason: string }`.
- Target: adds `readonly lockSource: "project" | "global" | "none"` — which lock decided the withholding (`"none"` when no lock resolved).

**`createMcpProviders` default lock read** — `src/mcp/provider.ts:46` (US-002)
- Baseline: `const read = args.readLock ?? readMcpLock;`
- Target: `const read = args.readLock ?? resolveMcpLock;` The `readLock` seam keeps its type `(projectRoot: string) => Promise<McpLockFile | undefined>`. The provider derives `lockSource` from the resolved value: `undefined` → `"none"`; a value carrying `source` → that source; a value without `source` (a test stub returning a bare `McpLockFile`) → `"project"`.

**`runMcpLockCommand`** — `src/cli/mcp.ts:17` (US-002)
- Baseline: `runMcpLockCommand(workdir: string): Promise<void>` writes `<workdir>/.nax/mcp-lock.json`.
- Target: `runMcpLockCommand(workdir: string, opts?: { global?: boolean }): Promise<void>`; with `opts.global === true` it writes through `writeMcpLockAt(globalMcpLockPath(), lock)` instead and prints `Wrote <that path>`.

**`writeMcpLock`** — `src/mcp/lock.ts:61` (US-002)
- Baseline: `writeMcpLock(projectRoot, lock)` sorts and writes `join(projectRoot, ".nax", "mcp-lock.json")`.
- Target: the sort-and-serialise body moves into a new `writeMcpLockAt(path: string, lock: McpLockFile): Promise<void>` (creates the parent dir, writes only `version` and `servers`); `writeMcpLock(projectRoot, lock)` keeps its signature and delegates with `writeMcpLockAt(mcpLockPath(projectRoot), lock)`.

**`nax mcp lock` command** — `bin/nax.ts:992-999` (US-002)
- Baseline: `mcpCmd.command("lock")` with no options; action calls `runMcpLockCommand(process.cwd())` after `runTrustGate(process.cwd())`.
- Target: adds `.option("--global", "Write the lock to the global config dir instead of the project", false)`; the action passes `{ global: options.global === true }`. `runTrustGate` is unchanged.

New in `src/mcp/lock.ts` (exported through the `@/mcp` barrel):

```typescript
export interface ResolvedMcpLock extends McpLockFile {
  /** Which file the lock was read from. Never written to disk. */
  readonly source: "project" | "global";
}
/** <globalDir>/mcp-lock.json; globalDir defaults to globalConfigDir(). */
export function globalMcpLockPath(globalDir?: string): string;
/**
 * Project lock fully overrides the global lock:
 *  1. If <projectRoot>/.nax/mcp-lock.json EXISTS, parse it with readMcpLock's validation.
 *     Valid -> { ...lock, source: "project" }. Malformed -> undefined (fail closed; the
 *     global lock is NOT consulted).
 *  2. Otherwise parse globalMcpLockPath(globalDir). Valid -> { ...lock, source: "global" };
 *     missing or malformed -> undefined.
 */
export async function resolveMcpLock(projectRoot: string, globalDir?: string): Promise<ResolvedMcpLock | undefined>;
```

`writeMcpLockAt` (and so `writeMcpLock`) never writes a `source` field: it serialises only `version` and `servers`. A lock is keyed by server id only: a global lock entry for id `memory` applies to whichever server is configured under `memory` in a project with no project lock (see Out of Scope). The `[provider] <id>__<tool> withheld` warn log gains a `lockSource` field. The rollup (`buildMcpRollup`) carries `withheld` entries through unchanged, so each rollup entry now includes `lockSource`.

`globalConfigDir()` honours `NAX_GLOBAL_CONFIG_DIR` (`src/config/paths/index.ts:63`), which tests use to point at a temp dir.

#### CLI Behavior

`nax mcp lock --global` — same trust gate and same server listing as today; writes the global lock path. Exit codes unchanged (0 on success; thrown errors surface as today).

### Part C — `execution.preRun` (US-003)

#### File Format

```json
{
  "execution": {
    "preRun": [
      { "command": "docker compose -f docker-compose.test.yml up -d --wait", "timeoutSeconds": 180 },
      { "command": "./scripts/seed-test-db.sh" }
    ]
  }
}
```

- `command`: non-empty string, run with `/bin/sh -c` (shell features allowed), cwd = the run `workdir` (repo root).
- `timeoutSeconds`: optional positive integer, default `300`.
- `preRun` defaults to `[]` (no-op). Declared in the schema (`ExecutionConfigSchema` plus the outer `NaxConfigSchema` execution default literal, following the BUG-20 derived-default comment pattern), and on the hand-written `ExecutionConfig` interface in `src/config/runtime-types.ts`.
- The step type `PreRunStepConfig { readonly command: string; readonly timeoutSeconds: number }` is declared in `src/config/runtime-types-execution.ts` (beside `WorktreeDependenciesConfig`). `src/config/runtime-types.ts` is at 595 of its 600-line limit, so its only changes are the name `PreRunStepConfig` added to the existing `import ... from "./runtime-types-execution"` and a one-line `preRun: PreRunStepConfig[];` field with no doc comment; check its line count after formatting.

#### Approach

New module `src/execution/lifecycle/pre-run-steps.ts`:

```typescript
import type { PreRunStepConfig } from "@/config/runtime-types-execution";

export const _preRunDeps = {
  assertTrusted,          // from @/trust
  executeWithTimeout,     // from @/verification (shell "/bin/sh -c", cwd option)
  now: () => Date.now(),
};

/**
 * Runs every configured step in order, awaiting each. Throws NaxError
 * "PRE_RUN_FAILED" on the first step that exits non-zero or times out;
 * later steps do not run. No-op when steps is empty.
 */
export async function runPreRunSteps(opts: {
  steps: readonly PreRunStepConfig[];
  workdir: string;
}): Promise<void>;
```

Per step: `await _preRunDeps.assertTrusted(workdir, "pre-run")`, then `_preRunDeps.executeWithTimeout(step.command, step.timeoutSeconds, undefined, { cwd: workdir })`. `"pre-run"` is added to the `TrustSurface` union (`src/trust/types.ts`). (`executeWithTimeout` also asserts the `"test-command"` surface on the same cwd; the `"pre-run"` check comes first so a refusal names the pre-run step.)

The result is a `TestExecutionResult` (`src/verification/types.ts:22`): `{ success, timeout, exitCode?, output?, ... }`. A step fails when `success` is false. It timed out when `result.timeout` is true. In messages, a missing `exitCode` prints as `unknown`.

Wiring: `runExecutionPhase` (`src/execution/runner-execution.ts`) calls `runPreRunSteps({ steps: config.execution?.preRun ?? [], workdir })` after the `ensureStoryPackageDirs` block and **before** the `captureRunBaseline` block, in its own `if (!options.dryRun)` block placed between those two existing blocks, with no try/catch around it (unlike both neighbours). On a throw, `runExecutionPhase` sets `statusWriter.setRunStatus("failed")`, awaits `statusWriter.update(0, 0)`, and rethrows, so the run stops before the baseline and before any story dispatch. Classic and workflow mode both enter through `runExecutionPhase`, so both get the step; `nax resume` re-runs it (steps are expected to be idempotent).

#### Logging

All lines use stage `"execution"` and `storyId: "_run"` first.

| Event | Level | Message | Data (after storyId) |
|:---|:---|:---|:---|
| step succeeded | info | `Pre-run step completed` | `command`, `exitCode` (0), `durationMs` |
| step failed (non-zero exit) | error | `Pre-run step failed` | `command`, `exitCode`, `timedOut: false`, `durationMs`, `outputTail` (last 2000 chars of output) |
| step timed out | error | `Pre-run step failed` | `command`, `timedOut: true`, `timeoutSeconds`, `durationMs`, `outputTail` |

#### Failure Handling

- Step result has `success: false` and `timeout: false` → fail-closed: throw `NaxError` code `PRE_RUN_FAILED` with context `{ stage: "execution", command, exitCode }`, message `Pre-run step failed: <command> (exit <exitCode, or "unknown">)`; later steps skipped; run status `failed`; no baseline, no story.
- Step result has `timeout: true` → fail-closed: same code and context, message `Pre-run step failed: <command> (timed out after <timeoutSeconds>s)`.
- Project not trusted → `assertTrusted` throws `PROJECT_UNTRUSTED`; the command is never spawned; the error propagates (run status `failed`).
- No retries.

### Part D — `nax cost` (US-004, US-005)

#### Approach

Pure read of the JSONL ledger; no LLM call, no writes. Core in a new `src/cli/cost-ledger-query.ts` (US-004); the command in a new `src/cli/cost.ts` (US-005), registered from `bin/nax.ts` with `registerCostCommand(program)` — the same shape as `registerGatesCommand` (`src/cli/gates.ts:336`, deps seam `_gatesCliDeps`).

#### Core API (US-004)

```typescript
export type CostGroupKey = "model" | "stage" | "role" | "project" | "feature" | "run" | "story";

export interface CostQuery {
  /** Inclusive lower bound on row `ts` (epoch ms); undefined = unbounded. */
  readonly sinceMs?: number;
  /** Exclusive upper bound on row `ts` (epoch ms); undefined = unbounded. */
  readonly untilMs?: number;
  /** Keep only rows whose projectKey is one of these; undefined = all. */
  readonly projects?: readonly string[];
  readonly feature?: string;   // keep rows whose featureName equals it
  readonly runId?: string;     // keep rows whose runId equals it
  /** Group keys, in order; empty = total only. */
  readonly groupBy: readonly CostGroupKey[];
}

export interface CostTotals {
  readonly calls: number;       // rows counted
  readonly errorCalls: number;  // of those, rows with kind "error"
  readonly runs: number;        // distinct runId
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly costUsd: number;     // exactUsd + estimatedUsd
  readonly exactUsd: number;    // sum of costUsd over rows with confidence "exact"
  readonly estimatedUsd: number;// sum of costUsd over all other rows
}

export interface CostGroupRow extends CostTotals {
  /** One entry per groupBy key, in groupBy order; "(none)" when the row lacks the field. */
  readonly key: Readonly<Record<string, string>>;
}

export interface CostLedgerReport {
  readonly schemaVersion: 1;
  readonly sinceMs: number | null;
  readonly untilMs: number | null;
  readonly groups: readonly CostGroupRow[];  // sorted by costUsd descending
  readonly total: CostTotals;
  readonly skippedRows: number;
  readonly filesScanned: number;
}

/** Every `<root>/cost/*.jsonl` under each root (a project output dir), sorted. Missing dirs contribute nothing. */
export async function listCostLedgerFiles(roots: readonly string[]): Promise<string[]>;

/** Every `<globalDir>/<child>` that is a directory (stat-based, so symlinked children count) and contains a `cost/` dir; sorted. */
export async function listProjectOutputDirs(globalDir: string): Promise<string[]>;

export async function queryCostLedger(files: readonly string[], query: CostQuery): Promise<CostLedgerReport>;

/** Pure: turns CLI window flags into epoch-ms bounds. */
export function resolveCostWindow(opts: {
  today?: boolean;
  since?: string;   // YYYY-MM-DD
  until?: string;   // YYYY-MM-DD, inclusive day
  utc?: boolean;
  nowMs: number;
}): { sinceMs?: number; untilMs?: number };
```

Group key → row field: `model` → `model`, `stage` → `stage`, `role` → `sessionRole`, `project` → `projectKey`, `feature` → `featureName`, `run` → `runId`, `story` → `storyId`.

Row rules, applied in this order:
1. A line that is empty or whitespace-only is ignored (not counted as skipped).
2. A line that is not valid JSON, whose parsed value is not an object, whose `ts` is not a finite number, or whose `costUsd` is present but not a finite number, is skipped and counted in `skippedRows`.
3. The row's project is its `projectKey`; when the row has no `projectKey`, it is the basename of the project output dir the file sits in (the file is `<outputDir>/cost/<runId>.jsonl`, so the basename of `dirname(dirname(file))`). This project value is used by both the `projects` filter and the `project` group key.
4. A row outside `[sinceMs, untilMs)` or failing the `projects` / `feature` / `runId` filters is excluded silently (not counted as skipped).
5. A row with no `costUsd` contributes 0 dollars; missing `tokens` or a missing token field counts as 0.
6. A row counts as exact when `confidence === "exact"`, or when it is a `kind: "error"` row (which carries no `confidence`) whose `exactCostUsd` is a finite number; every other row counts as estimated.
7. Failed-dispatch rows (`kind: "error"`, `CostErrorEvent` in `src/runtime/cost-aggregator.ts`) are counted like any other row (calls, tokens, cost) and additionally in `CostTotals.errorCalls`. Rows with `partial: true` are counted like any other row.

`--until` earlier than `--since` is not an error; it yields an empty report.

Read failures: `queryCostLedger` rethrows any error from reading a ledger file (a file listed by `listCostLedgerFiles` that is unreadable or vanished); only unparseable lines are skipped. `listCostLedgerFiles` and `listProjectOutputDirs` treat a missing directory as empty and rethrow any other error.

`resolveCostWindow`: `--today` → `sinceMs` = 00:00 of the current day, `untilMs` undefined. `--since D` → 00:00 of D. `--until D` → 00:00 of the day after D. All in local time, or UTC when `utc` is true. `today` combined with `since` or `until` throws `NaxError` code `COST_USAGE` with context `{ stage: "cost" }`. A `since`/`until` not matching `YYYY-MM-DD` (or not a real calendar date) throws `NaxError` code `COST_USAGE` with context `{ stage: "cost" }`.

#### CLI deps seam (US-005)

```typescript
export interface CostCliDeps {
  log: (msg: string) => void;        // stdout
  logErr: (msg: string) => void;     // stderr
  exit: (code: number) => void;
  now: () => number;                 // epoch ms
  globalConfigDir: () => string;
  /** Output dir of the project at `dir`: projectOutputDir(config.name?.trim() || basename(dir), config.outputDir), config from loadConfig(dir) (re-implemented in cost.ts; status-cost's resolveProject is private). Like status-cost, a loadConfig failure falls back to projectOutputDir(basename(dir), undefined). */
  resolveProjectOutputDir: (dir: string) => Promise<string>;
  listProjectOutputDirs: typeof listProjectOutputDirs;
  listCostLedgerFiles: typeof listCostLedgerFiles;
  queryCostLedger: typeof queryCostLedger;
}
export const _costCliDeps: CostCliDeps; // real process.stdout/stderr/exit, Date.now, and the US-004 functions
export function registerCostCommand(program: Command, deps?: CostCliDeps): Command; // deps defaults to _costCliDeps
```

Usage errors (`COST_USAGE` from `resolveCostWindow`, or an unknown `--by` key) and any error thrown by `listProjectOutputDirs`, `listCostLedgerFiles`, `queryCostLedger` or `resolveProjectOutputDir` go to `deps.logErr` as `Error: <message>`, followed by `deps.exit(1)`. Success ends with `deps.exit(0)`. `--here` and `--project` combine: `--here` picks the root, and `--project` still filters rows.

#### CLI Behavior (US-005)

```
nax cost [--today] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--utc]
         [--by <key[,key...]>] [--project <name>] [--here] [--feature <name>] [--run <runId>]
         [--json] [-d, --dir <path>]
```

- Scan roots: by default every directory returned by `deps.listProjectOutputDirs(deps.globalConfigDir())`. `--here` replaces that with the single root `deps.resolveProjectOutputDir(dir)`. `--project <name>` filters rows by `projectKey` (it does not change the roots).
- `--by` accepts a comma list of `CostGroupKey`; an unknown key is a usage error.
- stdout, default: a fixed-width table — one column per group key, then `calls`, `runs`, `input`, `output`, `cacheRead`, `cacheWrite`, `costUsd`; one line per group; a final `TOTAL` line; then `exact $<exactUsd> / estimated $<estimatedUsd>`; then `skipped <skippedRows> unparseable row(s)` only when `skippedRows > 0`. Dollar amounts to 2 decimals.
- stdout, `--json`: exactly one JSON document, the `CostLedgerReport`.
- stderr: usage errors as `Error: <message>`.
- Exit 0: report produced (including an empty report with zero rows). Exit 1: usage error (`COST_USAGE`) or a read failure.

```
$ nax cost --today --by stage
stage      calls  runs  input     output   cacheRead   cacheWrite  costUsd
run          240    28  30123456  4800000  900000000   2000000     45.10
review        50    12   7000000   900000  150000000    400000     12.20
plan           8     4   1676544   260000   30000000     80000      3.10
TOTAL        298    32  38800000  5960000  1080000000  2480000     60.40
exact $18.74 / estimated $41.66
```

## Out of Scope

- Updating `docs/guides/configuration.md`, `docs/guides/mcp-and-interception.md` and a guide page for `nax cost` is a manual follow-up after this feature merges; no story edits docs.
- A post-run teardown step (`execution.postRun`) is not added; only `execution.preRun` is.
- `execution.preRun` is read from the merged root config only; per-package `.nax/mono/<pkg>/config.json` overrides of `preRun` are not supported, and it always runs once from the repo root.
- Pre-run step results are not written to `metrics.json`, `status.json` fields beyond the run status, or the run summary; the run log lines are the record.
- `on-start` hooks keep their current fire-and-forget behaviour; no `required` flag is added to hook definitions.
- Merging the project and global MCP locks per server id is not supported; a present project lock fully overrides the global lock.
- `nax status --cost` is unchanged; `nax cost` is a separate command.
- `nax cost` does not discover projects whose `outputDir` points outside the global config dir unless `--here` is used from that project.
- `nax cost` performs no budget checks, alerts, writes, or LLM calls.
- The finish flow is unchanged: an acceptance status of `"error"` arrives with `groups: []`, so `finish/route.ts` routes it as `unverified` (fail-closed); surfacing `error.message` in the finish stop reason is a follow-up.
- A global MCP lock is keyed by server id only and is not restricted to servers defined in the global config layer; this is accepted because a project lock fully overrides it and the MCP server spawn still requires project trust.
- `nax cost` does not validate duplicate `--by` keys.
- `nax cost` counts `runs` and groups `run` / `story` by the raw `runId` / `storyId` values, without qualifying them by project; ids that collide across projects are merged.
- Failed-dispatch ledger rows carry no `featureName`, so `nax cost --feature <name>` excludes them; attributing failed spend to a feature is not added.
- `src/cli/config-descriptions.ts` gains no entry for `execution.preRun` in this feature.
- Profile-awareness is added to `nax features resolve` only; other commands that call `loadConfig` without a profile are unchanged.

## Stories

1. **US-001: features resolve reports config errors and adopts the run's profile** — `Workdir: packages/nax` — No dependencies. Adds the `"error"` acceptance status with `{ code, message }`, the `configOverrides` parameter, profile-chain resolution in `resolveFeatureSpec`, and `--profile` on `nax features resolve`.
2. **US-002: global MCP lock fallback** — `Workdir: packages/nax` — No dependencies. Adds `resolveMcpLock`, `globalMcpLockPath`, `ResolvedMcpLock`, `lockSource` on withheld entries and logs, the provider's default read, and `nax mcp lock --global`.
3. **US-003: blocking `execution.preRun` steps** — `Workdir: packages/nax` — No dependencies. Adds the config key, the `"pre-run"` trust surface, `runPreRunSteps`, and its wiring before the run-start baseline in `runExecutionPhase`.
4. **US-004: cost ledger query core** — `Workdir: packages/nax` — No dependencies. Adds `src/cli/cost-ledger-query.ts` with `listProjectOutputDirs`, `listCostLedgerFiles`, `queryCostLedger`, `resolveCostWindow`.
5. **US-005: `nax cost` command** — `Workdir: packages/nax` — Depends on US-004. Adds `src/cli/cost.ts` with `registerCostCommand` and its deps seam, rendering, and registration in `bin/nax.ts`.

### Context Files

**US-001**
- `packages/nax/src/cli/features-acceptance.ts` — resolver to change
- `packages/nax/src/cli/features-resolve.ts` — `resolveFeatureSpec` and `resolveTestPatterns`
- `packages/nax/src/cli/resolve-run-profile.ts` — profile precedence to reuse
- `packages/nax/test/unit/cli/features-acceptance.test.ts` — fixture helpers (`initRepo`, `writePRD`)
- `packages/nax/bin/nax.ts` — `features resolve` command registration (`:614-662`) and `collectProfile` (`:139`)

**US-002**
- `packages/nax/src/mcp/lock.ts` — lock read/write and validation
- `packages/nax/src/mcp/provider.ts` — default lock read and withheld reporting
- `packages/nax/src/cli/mcp.ts` — `nax mcp lock` implementation
- `packages/nax/src/config/paths/index.ts` — `globalConfigDir` and `NAX_GLOBAL_CONFIG_DIR`
- `packages/nax/bin/nax.ts` — `nax mcp lock` registration (`:992-999`)

**US-003**
- `packages/nax/src/execution/runner-execution.ts` — wiring point before `captureRunBaseline`
- `packages/nax/src/verification/executor.ts` — `executeWithTimeout`
- `packages/nax/src/config/schemas-execution.ts` — `ExecutionConfigSchema`
- `packages/nax/src/trust/registry.ts` — `assertTrusted` refusal shape
- `packages/nax/test/unit/execution/runner-execution-capture.test.ts` — how tests drive `runExecutionPhase` with `_captureDeps` and `_unifiedExecutorDeps`

**US-004**
- `packages/nax/src/runtime/cost-aggregator.ts` — `CostEvent` row fields
- `packages/nax/src/runtime/paths.ts` — `projectOutputDir`
- `packages/nax/src/cli/status-cost.ts` — existing cost CLI conventions

**US-005**
- `packages/nax/src/cli/cost-ledger-query.ts` — created by US-004, consumed here
- `packages/nax/src/cli/gates.ts` — `registerGatesCommand` + `_gatesCliDeps` pattern to mirror
- `packages/nax/test/unit/cli/gates.test.ts` — CLI deps-seam test pattern
- `packages/nax/src/cli/status-cost.ts` — how the project output dir is resolved (its `resolveProject` is private; re-implement in `cost.ts`)

### Creates

**US-003**
- `packages/nax/src/execution/lifecycle/pre-run-steps.ts` — `runPreRunSteps` and `_preRunDeps`

**US-004**
- `packages/nax/src/cli/cost-ledger-query.ts` — ledger query core

**US-005**
- `packages/nax/src/cli/cost.ts` — `registerCostCommand`, `costCommand`, `_costCliDeps`

### Modifies

**US-001**
- `packages/nax/test/unit/cli/features-acceptance.test.ts` — two tests pin the old catch-all. (1) "returns status=no-prd when prd.json is malformed (never throws)" (`:106`) asserts `status` `no-prd` for an unparseable PRD file; replacing invariant: a malformed PRD file resolves to `status: "error"`, `groups: []`, and never throws. (2) "degrades to no-prd (never throws) when the config is invalid/legacy" (`:118`) asserts `status` `no-prd` when `loadConfig` throws; replacing invariant: an invalid/legacy config resolves to `status: "error"` with `error.message` naming the cause, `groups: []`, and never throws.
- `packages/nax/bin/nax.ts` — the `features resolve` command gains `.option("--profile <name>", ..., collectProfile, [])` and passes `{ profile: options.profile }` to `resolveFeatureSpec`.

**US-002**
- `packages/nax/test/unit/mcp/provider.test.ts` — the withheld assertion at `:97` uses `toEqual([{ serverId, name, reason }])`; US-002 adds the required `lockSource` field to `McpWithheldEntry`, and the test's `readLock` stub returns a bare `McpLockFile`, so the entry now carries `lockSource: "project"`. Replacing invariant: the same entry plus `lockSource: "project"`.
- `packages/nax/bin/nax.ts` — the `mcp lock` command gains `.option("--global", ...)` and passes `{ global: options.global === true }` to `runMcpLockCommand`; `runTrustGate` is unchanged.
- `packages/nax/src/mcp/lock.ts` — `writeMcpLock`'s body moves into the new `writeMcpLockAt(path, lock)`; `writeMcpLock(projectRoot, lock)` keeps its signature and output.
- `packages/nax/test/unit/mcp/rollup.test.ts` — the `withheld` literals at `:18` and `:45` are typed `McpWithheldEntry` and lack the new required `lockSource` field, which fails typecheck. Replacing invariant: each literal gains `lockSource: "project"`; the rollup still passes `withheld` through unchanged.

**US-003**
- `packages/nax/src/trust/types.ts` — `TrustSurface` gains the `"pre-run"` member.
- `packages/nax/src/config/runtime-types-execution.ts` — declares `PreRunStepConfig { readonly command: string; readonly timeoutSeconds: number }`.
- `packages/nax/src/config/runtime-types.ts` — the hand-written `ExecutionConfig` gains a one-line `preRun: PreRunStepConfig[];` field (no doc comment) and `PreRunStepConfig` joins the existing import from the sibling runtime-types-execution module; the file is at 595 of 600 lines, so nothing else is added.
- `packages/nax/src/config/schemas.ts` — the outer `NaxConfigSchema` `execution` default literal must include `preRun: []` (BUG-20: zod does not re-parse a `.default()` value, so omitting it leaves `execution.preRun` undefined under `NaxConfigSchema.parse({})`).

**US-005**
- `packages/nax/bin/nax.ts` — registers the command with `registerCostCommand(program)`, next to `registerGatesCommand(program)`.
- `packages/nax/src/cli/index.ts` — the cli barrel exports `registerCostCommand` (as it does `registerGatesCommand`).

### Seams

- SEAM-1 (US-004 → US-005): `queryCostLedger`, `listCostLedgerFiles`, `listProjectOutputDirs` and `resolveCostWindow` are produced by US-004 and invoked by the `nax cost` action in US-005; pinned by US-005's seam ACs that enter through `program.parseAsync([... "cost", ...])`.
- SEAM-2 (US-003 internal): `runPreRunSteps` is invoked by `runExecutionPhase` before `captureRunBaseline`; pinned by US-003's ordering and stop-the-run ACs entering through `runExecutionPhase`.
- SEAM-3 (US-002 internal): `resolveMcpLock` is the default lock read of `createMcpProviders`; pinned by US-002's ACs that construct providers with no `readLock` override.

## Acceptance Criteria

### US-001

- [unit] `resolveFeatureAcceptance("feat", workdir)` returns `status: "error"` when the project `.nax/config.json` fails schema validation (`execution.storyIsolation: "bogus"`) and `prd.json` exists.
- [unit] For that same invalid config, the returned `error.code` is `"CONFIG_SCHEMA_INVALID"`.
- [unit] For that same invalid config, the returned `error.message` contains `Invalid configuration`.
- [unit] `resolveFeatureAcceptance` returns `status: "error"` with `groups: []` when `prd.json` exists but is not valid JSON.
- [unit] `resolveFeatureAcceptance` returns `status: "no-prd"` with no `error` property when the config is valid and `prd.json` does not exist.
- [unit] `resolveFeatureAcceptance` returns no `error` property on an `ok` result.
- [unit] `resolveFeatureAcceptance("feat", workdir, { profile: ["fix"] })` returns `status: "ok"` when the project config is invalid on its own but valid once the project profile `.nax/profiles/fix.json` is overlaid.
- [unit] `resolveFeatureSpec("feat", workdir)` returns `acceptance.status: "ok"` when the config is invalid on its own, the PRD's `routingProfile` is `"fix"`, `.nax/profiles/fix.json` makes it valid, and `envProfile` is unset.
- [unit] `resolveFeatureSpec("feat", workdir, { profile: ["fix"] })` returns `acceptance.status: "ok"` when the PRD has no `routingProfile` and the config is valid only under `fix`.
- [unit] With `process.env.NAX_PROFILE` set to `"other"` (restored after the test) and a project profile `.nax/profiles/other.json` that leaves the config invalid, `resolveFeatureSpec("feat", workdir)` (no `opts`, so `envProfile` defaults to the env value) does not adopt the PRD's `routingProfile` `"fix"`, so `acceptance.status` is `"error"`.
- [unit] `resolveFeatureSpec("feat", workdir)` returns a defined `testPatterns` when the config is invalid on its own and the PRD's `routingProfile` `"fix"` makes it valid.
- [cli] `nax features resolve feat --json -d <dir>` exits with code 0 when the spec resolves and `acceptance.status` is `"error"` (invalid config, no profile).
- [cli] `nax features resolve feat --json --profile fix -d <dir>` prints a JSON document whose `acceptance.status` is `"ok"` for a project whose config is valid only under `fix` and whose PRD has no `routingProfile`.

### US-002

- [unit] `resolveMcpLock(projectRoot, globalDir)` returns the project lock with `source: "project"` when `<projectRoot>/.nax/mcp-lock.json` is valid, even when a valid global lock also exists.
- [unit] `resolveMcpLock(projectRoot, globalDir)` returns the global lock with `source: "global"` when no project lock file exists and `<globalDir>/mcp-lock.json` is valid.
- [unit] `resolveMcpLock` returns `undefined` when the project lock file exists but is malformed, even when a valid global lock exists.
- [unit] `resolveMcpLock` returns `undefined` when no project lock exists and the global lock is malformed.
- [unit] `resolveMcpLock` returns `undefined` when neither lock file exists.
- [unit] `globalMcpLockPath()` returns `join(globalConfigDir(), "mcp-lock.json")`, honouring `NAX_GLOBAL_CONFIG_DIR`.
- [integration] With `NAX_GLOBAL_CONFIG_DIR` pointing at a temp dir whose `mcp-lock.json` pins tool `search_graph` for server `memory`, and a project root with no lock, `createMcpProviders` built without a `readLock` override admits `search_graph` from a pool that advertises it.
- [integration] In that same setup, a tool `delete_project` advertised by the pool but absent from the global lock is reported to `onWithheld` with `lockSource: "global"`.
- [unit] A provider whose lock resolves to `undefined` reports each withheld tool to `onWithheld` with `lockSource: "none"`.
- [unit] The `[provider] <id>__<tool> withheld` warn log carries a `lockSource` field equal to the withheld entry's `lockSource`.
- [integration] `runMcpLockCommand(workdir, { global: true })`, with one enabled server backed by the fake MCP server fixture `test/fixtures/mcp/fake-server.ts`, writes the lock to `globalMcpLockPath()` and does not create `<workdir>/.nax/mcp-lock.json`.
- [unit] `writeMcpLockAt(path, lock)` output never contains a `source` key when given a `ResolvedMcpLock`.
- [cli] `nax mcp lock --global`, run in a trusted temp project with `NAX_GLOBAL_CONFIG_DIR` pointing at a temp dir and a stub MCP server configured, writes `<globalDir>/mcp-lock.json` and does not create `<cwd>/.nax/mcp-lock.json`.

### US-003

- [unit] `NaxConfigSchema.parse({})` yields `execution.preRun` equal to `[]`.
- [unit] A config with `execution.preRun: [{ command: "true" }]` parses to a step whose `timeoutSeconds` is `300`.
- [unit] A config with `execution.preRun: [{ command: "" }]` fails schema validation.
- [unit] A config with a pre-run step whose `timeoutSeconds` is `0`, `-1` or `1.5` fails schema validation.
- [unit] `runPreRunSteps` calls `_preRunDeps.executeWithTimeout` once per step, in configured order, each with `{ cwd: workdir }` and the step's `timeoutSeconds`.
- [unit] `runPreRunSteps` throws a `NaxError` with code `PRE_RUN_FAILED` and a message containing the command and `exit 3` when a step's result is `success: false`, `timeout: false`, `exitCode: 3`.
- [unit] `runPreRunSteps` throws `PRE_RUN_FAILED` with a message containing `exit unknown` when a failing step's result has no `exitCode`.
- [unit] `runPreRunSteps` does not call `executeWithTimeout` for a second step after the first step fails.
- [unit] `runPreRunSteps` throws `PRE_RUN_FAILED` with a message containing `timed out after 5s` when a step with `timeoutSeconds: 5` returns `success: false`, `timeout: true`.
- [unit] `runPreRunSteps` calls `_preRunDeps.assertTrusted(workdir, "pre-run")` before `executeWithTimeout`, and when `assertTrusted` throws `PROJECT_UNTRUSTED`, `executeWithTimeout` is never called and the error propagates.
- [unit] `runPreRunSteps` logs `Pre-run step completed` at info with `storyId: "_run"` as the first data key, plus `command`, `exitCode` and `durationMs`, for a successful step.
- [unit] `runPreRunSteps` logs `Pre-run step failed` at error with `storyId: "_run"` first, plus `command`, `exitCode`, `timedOut` and `outputTail`, for a failing step.
- [unit] `runPreRunSteps({ steps: [] })` resolves without calling `assertTrusted` or `executeWithTimeout`.
- [integration] `runExecutionPhase` with `execution.preRun: [{ command: "up" }]` invokes the stubbed `_preRunDeps.executeWithTimeout` before `_captureDeps.writeRunBaseline` (recorded call order).
- [integration] `runExecutionPhase` with a pre-run step whose stubbed result is `success: false` rejects with `PRE_RUN_FAILED`.
- [integration] In that failing case, `_captureDeps.writeRunBaseline` is never called and `_unifiedExecutorDeps.runIteration` is never called.
- [integration] In that failing case, `statusWriter.setRunStatus` is called with `"failed"`.
- [integration] `runExecutionPhase` with `dryRun: true` and a configured pre-run step never calls `_preRunDeps.executeWithTimeout`.

### US-004

- [unit] `listCostLedgerFiles([root])` returns every `<root>/cost/*.jsonl` path, sorted, and ignores non-`.jsonl` files.
- [unit] `listCostLedgerFiles` returns `[]` for a root with no `cost/` directory.
- [unit] `listProjectOutputDirs(globalDir)` returns each child directory of `globalDir` that contains a `cost/` directory, and omits children without one.
- [unit] `queryCostLedger` sums `tokens.input`, `tokens.output`, `tokens.cacheRead` and `tokens.cacheWrite` across rows into `total.input`, `total.output`, `total.cacheRead` and `total.cacheWrite`.
- [unit] `queryCostLedger` reports `total.calls` as the number of counted rows and `total.runs` as the number of distinct `runId` values.
- [unit] `queryCostLedger` adds a row's `costUsd` to `exactUsd` when its `confidence` is `"exact"`, and to `estimatedUsd` otherwise.
- [unit] `queryCostLedger` reports `total.costUsd` equal to `total.exactUsd + total.estimatedUsd`.
- [unit] `queryCostLedger` excludes a row whose `ts` equals `untilMs` and includes a row whose `ts` equals `sinceMs`.
- [unit] `queryCostLedger` counts an invalid-JSON line, and a row with a non-numeric `ts` or `costUsd`, in `skippedRows` without throwing.
- [unit] `queryCostLedger` ignores blank lines without counting them in `skippedRows`.
- [unit] `queryCostLedger` with `groupBy: ["stage"]` returns one `CostGroupRow` per distinct `stage`, sorted by `costUsd` descending.
- [unit] `queryCostLedger` with `groupBy: ["project", "feature"]` keys each group by both `project` (from `projectKey`) and `feature` (from `featureName`).
- [unit] `queryCostLedger` with `groupBy: ["role"]` keys groups by the row's `sessionRole`, using `"(none)"` when the row has no `sessionRole`.
- [unit] `queryCostLedger` with `projects: ["koda"]`, `feature: "f1"` or `runId: "r1"` counts only rows whose `projectKey`, `featureName` or `runId` match.
- [unit] `queryCostLedger` counts a row with no `tokens` field with 0 tokens while still adding its `costUsd`.
- [unit] `queryCostLedger` counts a `kind: "error"` row with no `costUsd` as one call and in `total.errorCalls`, adds 0 dollars for it, and does not count it in `skippedRows`.
- [unit] `queryCostLedger` adds a `kind: "error"` row's `costUsd` to `exactUsd` when the row carries a finite `exactCostUsd`, and to `estimatedUsd` when it does not.
- [unit] `queryCostLedger` assigns a row with no `projectKey`, read from `<globalDir>/koda/cost/r1.jsonl`, to project `koda` for both the `projects` filter and the `project` group key.
- [unit] `resolveCostWindow({ today: true, nowMs })` returns `sinceMs` equal to local midnight of `nowMs`'s day and no `untilMs`.
- [unit] `resolveCostWindow({ since: "2026-10-10", until: "2026-10-17", utc: true, nowMs })` returns `sinceMs` = `Date.UTC(2026, 9, 10)` and `untilMs` = `Date.UTC(2026, 9, 18)`.
- [unit] `resolveCostWindow({ today: true, since: "2026-10-10", nowMs })` throws a `NaxError` with code `COST_USAGE`.
- [unit] `resolveCostWindow({ since: "2026-13-40", nowMs })` throws a `NaxError` with code `COST_USAGE`.

### US-005

- [integration] Running `nax cost --today --by model` through `registerCostCommand(program, deps)` and `program.parseAsync`, with stubbed deps, calls `deps.queryCostLedger` once with a query whose `groupBy` is `["model"]` and whose `sinceMs` is local midnight of `deps.now()`.
- [integration] Running `nax cost --project koda --feature f1 --run r1` through `program.parseAsync` calls `deps.queryCostLedger` with `projects: ["koda"]`, `feature: "f1"` and `runId: "r1"`.
- [integration] Running `nax cost` with no `--here` passes `deps.listCostLedgerFiles` the roots returned by `deps.listProjectOutputDirs(deps.globalConfigDir())`.
- [integration] Running `nax cost --here -d <dir>` passes `deps.listCostLedgerFiles` exactly one root, the output dir of the project at `<dir>`, and never calls `deps.listProjectOutputDirs`.
- [cli] `nax cost --json` writes exactly one line to stdout that parses as a `CostLedgerReport` with `schemaVersion: 1`.
- [cli] `nax cost --today --by stage` prints one table line per group, then a line starting with `TOTAL`.
- [cli] `nax cost` prints a line `exact $<exactUsd> / estimated $<estimatedUsd>` with both amounts to 2 decimals.
- [cli] `nax cost` prints `skipped <n> unparseable row(s)` when the report's `skippedRows` is `n > 0`, and prints no such line when it is 0.
- [cli] `nax cost --by colour` writes `Error:` and the unknown key to stderr and exits with code 1.
- [cli] `nax cost --today --since 2026-10-10` writes `Error:` to stderr and exits with code 1.
- [cli] `nax cost` writes `Error:` and the thrown message to stderr and exits with code 1 when `deps.queryCostLedger` rejects with a file read error.
- [unit] `queryCostLedger` rejects when one of its listed ledger files does not exist.
- [cli] `nax cost` exits with code 0 and prints a `TOTAL` line with zero counts when no ledger rows match.
