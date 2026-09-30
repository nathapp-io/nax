<!-- spec-writing: completed-through-phase-5 -->
# SPEC: Project trust gate

## Summary

Add a per-folder trust decision that gates every place nax runs repository-controlled code on the host. A trust store at `<globalConfigDir()>/trust.json` lists trusted folders; an entry covers its folder and every descendant. Gated CLI commands (`run`, `resume`, `plan`, `plugins list`, `setup`, `precheck`, `prompts`, `mcp lock`) call an entry gate that passes a trusted project, prompts on a TTY (`[y]es / [p]arent / [N]o`), and otherwise exits 2 naming `nax trust add <root>`. Every execution site (project plugins, context plugin providers, project hooks, MCP servers, quality/test/acceptance/setup commands) asserts against a process-scoped registry the entry gate fills, so a command that skips the gate fails closed. A new `nax trust list|add|rm|check` command manages the store. Closes #2293.

## Motivation

nax runs code the repository controls, outside the agent sandbox, with the user's privileges and read access to `~/.nax/credentials`, with no consent step (#2293). Plugins are one of several such paths:

- `.nax/plugins/*` and config `plugins[]` are imported in-process by `loadPlugins` (`src/plugins/loader.ts:433`).
- Config `context.v2.pluginProviders` are imported in-process by `loadPluginProviders` (`src/context/engine/providers/plugin-loader.ts:38`).
- `.nax/hooks.json` commands are spawned by `fireHook` (`src/hooks/runner.ts:225`).
- Config `mcp.servers` commands are spawned by the MCP pool (`src/mcp/pool.ts:86`).
- Quality, test, acceptance, new-package setup and worktree setup commands from config (or auto-detected from `package.json` scripts) are spawned unsandboxed by `runQualityCommand` (`src/quality/runner.ts:154`), `executeWithTimeout` (`src/verification/executor.ts:107`), the acceptance hardening pass (`src/acceptance/hardening.ts:179`), `maybeRunNewPackageSetup` (`src/execution/new-package-setup.ts:91`) and `prepareWorktreeDependencies` (`src/worktree/dependencies.ts:63`).

A plugins-only gate would leave the same capability open through the other paths, so the gate is per repository, not per plugin. The loop-handlers extension (#2288) gives project plugins a hook into every native agent turn, and fleet orchestrators clone repositories and run `nax run` in them unattended; both make the missing consent step urgent. Design: `docs/superpowers/specs/2026-09-30-project-trust-gate-design.md`.

## Design

### Approach

Three layers, all in a new `src/trust/` module plus CLI wiring:

1. **Store and matching** (`src/trust/types.ts`, `match.ts`, `store.ts`). Pure path matching over realpath-normalized absolute paths, and a JSON store read and written under a file lock.
2. **Registry and entry gate** (`src/trust/registry.ts`, `gate.ts`, `prompt.ts`; `src/cli/trust-gate.ts`). `ensureProjectTrusted` is the only code that prompts or persists from a gated command; on success it calls `markTrusted(root)`. `runTrustGate` wraps it for CLI actions and maps refusal to exit code 2.
3. **Backstops**. Each execution site calls `await assertTrusted(<cwd of the import/spawn>, <surface>)` immediately before it imports or spawns. The registry is process-scoped and append-only; no value is threaded through the runtime.

Every merged config entry (plugins, MCP servers, pluginProviders, commands) is treated as repository-controlled and needs trust, because project config, project profiles (`<project>/.nax/profiles/`) and per-package `.nax/mono/<pkg>/config.json` all feed the merge and no per-entry provenance exists. Only structurally separate global sources are exempt: the global plugin directory and built-in plugins in `loadPlugins`, and global hooks (`LoadedHooksConfig._global`) in `fireHook`.

### Trust model

- **Project root** — `resolveTrustRoot(workdir)`: `dirname(findProjectDir(workdir))` when `findProjectDir` (`src/config/loader.ts:285`) finds a `.nax/config.json` walking up from `workdir` **and** that `.nax` directory is not the global config directory (`realOrRaw(naxDir) !== realOrRaw(globalConfigDir())`); otherwise `resolve(workdir)`. Without the exclusion, every project-less folder under the home directory resolves to the home directory, because `~/.nax/config.json` is itself a `.nax/config.json`. The gate normalizes the result with `normalizeTrustPath`.
- **Normalization** — `normalizeTrustPath(path)` is `realOrRaw(path)` (`src/utils/realpath.ts:31`): the realpath of the nearest existing ancestor with the missing segments re-appended, so a not-yet-created directory under a symlinked parent (macOS `/var` -> `/private/var`) still matches a realpath-normalized entry. A trailing `/` is removed except on `/` itself.
- **Protected folders** — `/` and the home directory (`_trustGateDeps.homedir()` / `_cliTrustDeps.homedir()`, both `os.homedir()` in production). Neither the prompt nor `nax trust add` without `--force` grants them.
- **Coverage** — `findCoveringEntry(folders, normalizedPath)` returns the entry whose `path` equals `normalizedPath`, or is `/`, or is a prefix of `normalizedPath` followed by `/`. When several entries cover, the one with the longest `path` wins. `/a/foo` never covers `/a/foobar`.

### File format: `trust.json`

Path: `trustStorePath()` = `join(globalConfigDir(), "trust.json")` (`globalConfigDir()` honours `NAX_GLOBAL_CONFIG_DIR`, `src/config/paths/index.ts:61-65`).

```json
{
  "version": 1,
  "folders": [
    { "path": "/Users/w/workspace", "addedAt": "2026-09-30T00:00:00.000Z", "via": "prompt" },
    { "path": "/srv/koda/workspace", "addedAt": "2026-10-01T08:15:00.000Z", "via": "cli" }
  ]
}
```

- `version` — the number `1`.
- `folders[].path` — absolute, normalized path.
- `folders[].addedAt` — ISO-8601 timestamp from `_trustStoreDeps.now()`.
- `folders[].via` — `"prompt"` (entry gate) or `"cli"` (`nax trust add`).
- The file is validated by a zod schema `TrustStoreFileSchema`; invalid JSON or any shape mismatch (other `version`, `folders` not an array, a non-absolute or non-string `path`, `via` outside the two values) reads as `unparseable`.
- Writes: under `withPathFileLock(trustStorePath(), ...)` (`src/utils/path-file-lock.ts:27`), write a sibling temp file with mode `0o600`, then `rename` it over `trust.json`. The global config directory is created when missing.

### Module API (`src/trust/`, exported from `src/trust/index.ts`)

```ts
// types.ts
export interface TrustEntry { path: string; addedAt: string; via: "prompt" | "cli" }
export interface TrustStoreFile { version: 1; folders: TrustEntry[] }
export type TrustStoreRead =
  | { state: "missing" }
  | { state: "ok"; file: TrustStoreFile }
  | { state: "unparseable"; reason: string };
export type AddTrustResult =
  | { outcome: "added"; entry: TrustEntry }
  | { outcome: "already-covered"; coveredBy: TrustEntry };
export type RemoveTrustResult =
  | { outcome: "removed"; entry: TrustEntry }
  | { outcome: "not-found"; coveredBy: TrustEntry | null };
export type TrustSurface =
  | "plugins" | "context-plugin-providers" | "hooks" | "mcp"
  | "quality-command" | "test-command" | "acceptance-command" | "package-setup" | "worktree-setup";
export type TrustChoice = "yes" | "parent" | "no";

// match.ts
export function resolveTrustRoot(workdir: string): string;
export async function normalizeTrustPath(path: string): Promise<string>;
export function findCoveringEntry(folders: readonly TrustEntry[], normalizedPath: string): TrustEntry | null;

// store.ts
export const _trustStoreDeps: { now: () => Date };
export function trustStorePath(): string;
export async function readTrustStore(): Promise<TrustStoreRead>;
export async function addTrustEntry(path: string, via: TrustEntry["via"]): Promise<AddTrustResult>;
export async function removeTrustEntry(path: string): Promise<RemoveTrustResult>;

// registry.ts
export function markTrusted(normalizedRoot: string): void;
export async function assertTrusted(path: string, surface: TrustSurface): Promise<void>;
export function resetTrustRegistry(): void;

// prompt.ts
export const _trustPromptDeps: { ask: (question: string) => Promise<string | null> };
export async function promptTrustChoice(root: string, parent: string | null): Promise<TrustChoice>;

// gate.ts
export const _trustGateDeps: {
  prompt: (root: string, parent: string | null) => Promise<TrustChoice>;
  homedir: () => string;
};
export async function ensureProjectTrusted(root: string, options: { interactive: boolean }): Promise<void>;
```

- `addTrustEntry` normalizes `path`; when an existing entry covers it, it returns `already-covered` without writing. Otherwise it appends the entry and keeps any existing entries (including descendants).
- `removeTrustEntry` normalizes `path`; it removes only an entry whose `path` equals it. Otherwise it returns `not-found` with the covering entry, if any, and does not write.
- `assertTrusted` normalizes `path` and passes when a marked root covers it (same coverage rule as `findCoveringEntry`); otherwise it throws `PROJECT_UNTRUSTED` with `surface`.
- `promptTrustChoice` writes the question through `_trustPromptDeps.ask` and maps the trimmed, lower-cased answer: `y` or `yes` -> `"yes"`; `p` or `parent` -> `"parent"` when `parent` is not `null`; anything else, including an empty line, `null` (end of input), and `p` when `parent` is `null` -> `"no"`. With a parent the question is exactly `Trust <root>? nax will run this project's plugins, hooks, MCP servers and test commands. [y]es / [p]arent (<parent>) / [N]o `; with `parent` `null` it is exactly `Trust <root>? nax will run this project's plugins, hooks, MCP servers and test commands. [y]es / [N]o `. The production `ask` reads one line from stdin.
- `ensureProjectTrusted(root, { interactive })`, with `root` normalized:
  1. `readTrustStore()`; `unparseable` -> throw `TRUST_STORE_UNREADABLE`.
  2. A covering entry -> `markTrusted(root)`, return.
  3. `root` is a protected folder -> throw `PROJECT_UNTRUSTED` with `hint` `run: nax trust add <root> --force` without prompting.
  4. `interactive` -> `_trustGateDeps.prompt(root, parent)` where `parent` is `dirname(root)`, or `null` when `dirname(root)` is a protected folder. `"yes"` -> `addTrustEntry(root, "prompt")`; `"parent"` -> `addTrustEntry(dirname(root), "prompt")`; either way `markTrusted(root)` and return. `"no"` -> step 5.
  5. Throw `PROJECT_UNTRUSTED` with `hint` `run: nax trust add <root>`.

### CLI gate helper (`src/cli/trust-gate.ts`, exported from `src/cli/index.ts`)

```ts
export const _trustGateCliDeps: {
  isInteractive: () => boolean;   // process.stdin.isTTY === true && process.stdout.isTTY === true
  error: (text: string) => void;  // console.error
  exit: (code: number) => never;  // process.exit
};
export async function runTrustGate(workdir: string): Promise<void>;
```

`runTrustGate` computes `root = await normalizeTrustPath(resolveTrustRoot(workdir))` and calls `ensureProjectTrusted(root, { interactive: _trustGateCliDeps.isInteractive() })`. On a `NaxError` with code `PROJECT_UNTRUSTED` it calls `error` with `Project not trusted: <root>`, then `error` with the hint, then `exit(2)`. On `TRUST_STORE_UNREADABLE` it calls `error` with the error message, then `exit(2)`. Any other error propagates.

### CLI behaviour: gated commands

Each gated action calls `await runTrustGate(<its workdir>)` before loading hooks, plugins, a runtime or the TUI:

| Command | Workdir passed | Placement |
|---|---|---|
| `run` (including `--compare`) | the resolved `-d` directory | after the `naxDir` check (`bin/nax.ts:262-265`), before `maybeRunPlanPhase` (`:281`), the TUI (`:296-330`), `loadHooksConfig` (`:309`) and the `--schedule` wait (`:337`) |
| `resume` | `-d` | first statement of the action in `registerResumeCommand` (`src/commands/resume.ts:139-145`) |
| `plan` | `-d` | first statement after directory validation in the `plan` action (`bin/nax.ts:645-690`) |
| `plugins list` | `-d` | after `validateDirectory` in the action (`bin/nax.ts:1605`) |
| `setup` | `-d` | after `validateDirectory` in the action (`bin/nax.ts:173`) |
| `precheck` | `-d` | first statement of the action (`bin/nax.ts:1013`) |
| `prompts` | `-d` | after `validateDirectory`, only when neither `--init` nor `--export` is given (`bin/nax.ts:1237`) |
| `mcp lock` | `process.cwd()` | first statement of the action (`bin/nax.ts:939`) |

- Exit code `2` and two stderr lines (`Project not trusted: <root>`, `run: nax trust add <root>`) when refused. stdout carries nothing from the gate.
- Every other command is ungated, including `config`, `status`, `auth`, `sandbox probe`, `approvals`, `trust`, `generate`, `init`, `detect`, `accept`, `spec lint`, `rules`, `curator`, `context`, `logs`, `runs`, and `prompts --init` / `prompts --export`.

### CLI behaviour: `nax trust`

Handlers in `src/cli/trust.ts`, exported from `src/cli/index.ts`, each returning an exit code that `bin/nax.ts` passes to `process.exit`. A `trust` command group is registered in `bin/nax.ts` next to `approvals`.

```ts
export const _cliTrustDeps: {
  log: (text: string) => void;        // console.log  (stdout)
  error: (text: string) => void;      // console.error (stderr)
  isTTY: () => boolean;               // process.stdin.isTTY === true
  confirm: (question: string) => Promise<boolean>; // promptForConfirmation
  homedir: () => string;              // os.homedir()
  cwd: () => string;                  // process.cwd()
};
export async function trustListCommand(options: { json?: boolean }): Promise<number>;
export async function trustAddCommand(options: { path?: string; yes?: boolean; force?: boolean }): Promise<number>;
export async function trustRmCommand(options: { path: string }): Promise<number>;
export async function trustCheckCommand(options: { path?: string; json?: boolean }): Promise<number>;
```

Relative paths resolve against `_cliTrustDeps.cwd()`.

| Command | stdout | stderr | Exit |
|---|---|---|---|
| `nax trust list` | one line per entry: `* <path>  (via <via>, added <addedAt>)` for the entry covering `cwd`, the same line with a two-space prefix instead of `* ` for the rest; with no entries, `No trusted folders (<trustStorePath()>)` | — | 0 |
| `nax trust list --json` | `{ "path": <trustStorePath()>, "folders": [...entries], "coveringCwd": <path> \| null }` | — | 0 |
| `nax trust list` on an unparseable store | — | `trust.json could not be parsed: <reason>` | 1 |
| `nax trust add [path] --yes` | `Trusted <normalized path>` | — | 0 |
| `nax trust add` for an already-covered path | `Already trusted: <normalized path> is covered by <coveredBy.path>` | — | 0 |
| `nax trust add` of `/` or the home directory without `--force` | — | `Refusing to trust <path>: it covers every project under it. Pass --force to trust it anyway.` | 1 |
| `nax trust add` without `--yes` and not a TTY | — | `Refusing to trust <path> without confirmation: stdin is not a TTY. Pass --yes.` | 1 |
| `nax trust add` without `--yes`, TTY, declined | `Not trusted.` | — | 1 |
| `nax trust rm <path>` | `Removed <normalized path>` | — | 0 |
| `nax trust rm <path>`, no exact entry | — | `No trust entry for <normalized path>`, plus `<normalized path> is still trusted through <coveredBy.path>` when covered | 1 |
| `nax trust check [path]` | `trusted: <root> (covered by <coveredBy.path>)` or `untrusted: <root>` | — | 0 trusted, 1 untrusted |
| `nax trust check [path] --json` | `{ "root": <root>, "trusted": <boolean>, "coveredBy": <path> \| null }` | — | 0 trusted, 1 untrusted |

`trustAddCommand` applies its checks as an ordered pipeline, first match wins: (1) the normalized path is a protected folder and `force` is not set -> protected-folder refusal, exit 1; (2) an existing entry covers the path -> `Already trusted`, exit 0; (3) `yes` is not set and `isTTY()` is `false` -> TTY refusal, exit 1; (4) `yes` is not set -> `confirm`, and a `false` answer prints `Not trusted.` and exits 1; (5) `addTrustEntry(path, "cli")`, exit 0.

`nax trust check` reports on `root = normalizeTrustPath(resolveTrustRoot(path ?? cwd))` — the root the entry gate would check. A `TRUST_STORE_UNREADABLE` error from `add`, `rm` or `check` prints its message to stderr and exits 1. JSON documents are `JSON.stringify(value, null, 2)`.

### Integration

Symbols this feature reads but does not change:

- `findProjectDir(startDir: string): string | null` — `src/config/loader.ts:285`, exported from `@/config`; returns the `.nax` directory path.
- `globalConfigDir(): string` — `src/config/paths/index.ts:61`, exported from `@/config`.
- `withPathFileLock<T>(path, fn)` — `src/utils/path-file-lock.ts:27`.
- `realOrRaw(p: string): string` — `src/utils/realpath.ts:31`; realpath of the nearest existing ancestor.
- `NaxError(message, code, context)` — `src/errors.ts`; context always carries `stage`.
- `validateDirectory` — `src/config/path-security.ts:24-36`.
- The `nax approvals` handler pattern (`_cliApprovalsDeps`-style output seam, TTY refusal at `src/cli/approvals.ts:329-333`) — mirrored by `src/cli/trust.ts`.
- `promptForConfirmation(question: string): Promise<boolean>` — `src/cli/confirm.ts:63`; resolves `true` without a TTY, so `trustAddCommand` checks `isTTY()` before calling it.

Symbols this feature changes. Each baseline exists only to locate the code; it is never the interface to implement.

**`rejectGlobalOnlyKeys`** — `src/config/global-only-keys.ts:6-12` (US-001)
- Baseline: throws `AUTH_CONFIG_NOT_GLOBAL` when the layer has `auth`.
- Target: also throws `NaxError` code `TRUST_CONFIG_NOT_GLOBAL`, message `trust is global-only and cannot be set in <layerName>`, context `{ stage: "config", layerName }`, when the layer has own property `trust`.

**`loadPlugins`** — `src/plugins/loader.ts:107` (US-005)
- Target: same signature. Before `loadAndValidatePlugin` for each discovered project-directory plugin, and before resolving each `configPlugins` entry whose `enabled` is not `false`, it awaits `assertTrusted(effectiveProjectRoot, "plugins")`. Built-ins and the global-directory loop do not assert.

**`loadPluginProviders`** — `src/context/engine/providers/plugin-loader.ts:159` (US-005)
- Target: same signature. After the `enabled.length === 0` early return and before `Promise.allSettled` (`:169`), it awaits `assertTrusted(workdir, "context-plugin-providers")` once. The assertion must sit outside `loadSingleProvider`: `allSettled` drops rejected settlements, so a rejection inside `loadSingleProvider` would be converted into a skip.

**`fireHook`** — `src/hooks/runner.ts:293` (US-005)
- Target: same signature. When a project hook definition for `event` exists and is enabled, it awaits `assertTrusted(workdir, "hooks")` before the project hook's `try` block. The global hook branch does not assert.

**`createMcpPool`** — `src/mcp/pool.ts:57`, inner `open(serverId, workdir)` (US-005)
- Target: same signature. After the `server === undefined || !server.enabled` early return and before the connect retry loop, `open` awaits `assertTrusted(workdir, "mcp")`. The rejection propagates out of both `listTools` and `call`: a backstop firing means a gated command skipped its entry gate, which is a defect to surface, not a dead server to report as error-as-data.

**`runQualityCommand`** — `src/quality/runner.ts:278`, spawn at `:154` (US-006)
- Target: same signature; awaits `assertTrusted(opts.workdir, "quality-command")` before the first spawn.

**`executeWithTimeout`** — `src/verification/executor.ts:91`, spawn at `:107` (US-006)
- Target: same signature; awaits `assertTrusted(options?.cwd ?? resolve("."), "test-command")` before spawning. `resolve(".")` names the directory `Bun.spawn` itself uses when `cwd` is absent; it is not a config-scope read, so the `process.cwd()` ban in `.nax/rules/project-conventions.md` does not apply.

**acceptance hardening** — `processPackageGroup` (`src/acceptance/hardening.ts:70`, spawn at `:179`), reached from `runHardeningPass(ctx)` (`:291`) (US-006)
- Target: `processPackageGroup` awaits `assertTrusted(packageDir, "acceptance-command")` as its first statement, before `packages.resolve`, the `acceptanceRefineOp` / `acceptanceGenerateOp` calls and the test-file write, so an untrusted project gets no LLM call, no file write and no spawn. `runHardeningPass` keeps its existing non-blocking `catch` (`:330-336`), so the rejection is logged as a hardening failure.

**`maybeRunNewPackageSetup`** — `src/execution/new-package-setup.ts:74`, spawn at `:91` (US-006)
- Target: same signature; awaits `assertTrusted(packageDir, "package-setup")` after the existing `!runtime || !setupCommand` and `claimSetup` early returns and before the `for` loop over commands, outside the loop's per-command `try` (`:88-110`), which would otherwise swallow it.

**`prepareWorktreeDependencies`** — `src/worktree/dependencies.ts:25`, `runArgv` at `:63` (US-006)
- Target: same signature; in the path that runs `setupCommand`, awaits `assertTrusted(<the runArgv cwd>, "worktree-setup")` before `runArgv`.

**`SandboxPolicyInput` / `buildSandboxPolicy`** — `src/sandbox/policy-builder.ts:37,115` (US-006)
- Target: `SandboxPolicyInput` gains `readonly trustStoreFile?: string`; when present, `buildSandboxPolicy` appends it to `denyWrite` (same shape as `approvalsFile`, `:133`).

**`resolveSessionSandbox`** — `src/agents/coding-tool-sandbox.ts:96` (US-006)
- Target: the `buildSandboxPolicy` input it builds carries `trustStoreFile: trustStorePath()`.

**`bin/nax.ts`**, **`src/commands/resume.ts`** (US-003, US-004) — gate calls per the gated-commands table; `trust` command group registration.

**`docs/guides/cli-reference.md`**, **`README.md`**, **`CHANGELOG.md`** (US-004) — a `nax trust` reference section; a "Project trust" README section stating that trusting a parent folder covers every project cloned under it later; a **BREAKING** changelog entry with the CI recipe `nax trust add "$PWD" --yes`.

### Failure Handling

| # | Failure | Behaviour |
|---|---|---|
| F1 | `trust.json` missing | `readTrustStore` returns `missing`; no folder is trusted |
| F2 | `trust.json` is invalid JSON or fails `TrustStoreFileSchema` | `readTrustStore` returns `unparseable`; `addTrustEntry` / `removeTrustEntry` throw `TRUST_STORE_UNREADABLE` without rewriting the file; `ensureProjectTrusted` throws `TRUST_STORE_UNREADABLE`; `runTrustGate` exits 2 |
| F3 | Untrusted project, no TTY | `ensureProjectTrusted` throws `PROJECT_UNTRUSTED` without prompting; `runTrustGate` exits 2 |
| F4 | Untrusted project, TTY, answer is not yes/parent (including end of input) | `PROJECT_UNTRUSTED`; the store is unchanged |
| F5 | A backstop runs with no covering marked root | `assertTrusted` throws `PROJECT_UNTRUSTED` naming the surface; nothing is imported or spawned; the error propagates out of the site function (except `runHardeningPass`, which logs it as a non-blocking failure) |
| F6 | A non-global config layer sets `trust` | `rejectGlobalOnlyKeys` throws `TRUST_CONFIG_NOT_GLOBAL` |
| F7 | `nax trust add` of a protected folder without `--force`, or an entry gate whose root is a protected folder | `trust add`: stderr refusal, exit 1, store unchanged; entry gate: `PROJECT_UNTRUSTED` with hint `run: nax trust add <root> --force`, no prompt |
| F8 | `nax trust add` without `--yes` and without a TTY | stderr refusal, exit 1, `confirm` not called |
| F9 | A path that does not exist is normalized | `normalizeTrustPath` returns the realpath of its nearest existing ancestor with the missing segments appended |
| F10 | Two writers update the store at once | writes serialize under `withPathFileLock`; both entries survive |

## Out of Scope

- Sandboxing host-side commands (hooks, MCP servers, quality, test, acceptance and setup commands); the gate decides whether repository code runs and never confines code once it runs.
- Per-plugin or per-command trust decisions, and content hashes of repository files.
- A per-invocation bypass (`--trust` flag or environment variable) and any automatic migration that infers trust from run history.
- Tracking which config layer (global, project, profile, package) each merged `plugins[]`, `mcp.servers`, `context.v2.pluginProviders` or command entry came from; every merged entry needs trust.
- A backstop in `checkAgentCLI` (`src/precheck/checks-cli.ts:67`), which takes no workdir; its callers (`nax precheck`, run precheck) are gated.
- Backstops on the agent's own tool commands (`src/tools/bash.ts`, the argv path of `src/tools/run-command.ts`); they run only inside a session of a gated run.
- Fixing the bakeoff hooks path (`src/bakeoff/pipeline-adapter.ts:60` reads `<worktree>/hooks.json`).
- Changing how global-directory or built-in plugins, or global hooks, load.
- Concurrent readers during a store write beyond the atomic rename; readers are not locked.
- An acceptance criterion observing temp-file-plus-rename atomicity of the store write; the write uses it, but no test simulates an interrupted write.
- A `[p]arent` choice when the parent is a protected folder, and a prompt for a root that is itself a protected folder; both are refused rather than offered.
- Protecting `trust.json` from host-side commands of an already-trusted project, or from agent commands when a trusted project sets `execution.sandbox.enabled: false`.

## Stories

1. **US-001: Trust store and path matching** — no dependencies. `src/trust/types.ts`, `match.ts`, `store.ts`, `index.ts`: `resolveTrustRoot`, `normalizeTrustPath`, `findCoveringEntry`, `trustStorePath`, `readTrustStore`, `addTrustEntry`, `removeTrustEntry`, `TrustStoreFileSchema`; `trust` added to `rejectGlobalOnlyKeys`.
2. **US-002: Trust registry and entry gate** — depends on US-001. `src/trust/registry.ts`, `prompt.ts`, `gate.ts`: `markTrusted`, `assertTrusted`, `resetTrustRegistry`, `promptTrustChoice`, `ensureProjectTrusted`; `test/preload.ts` writes a `trust.json` trusting `/` into the isolated global config dir and calls `markTrusted("/")`; `test/helpers/trust.ts` exports `useUntrustedRegistry()`, which registers a `beforeEach` calling `resetTrustRegistry()` and an `afterEach` calling `markTrusted("/")`, re-exported from `test/helpers/index.ts`.
3. **US-003: Gate the CLI commands** — depends on US-002. `src/cli/trust-gate.ts`: `runTrustGate` and `_trustGateCliDeps`, exported from `src/cli/index.ts`; `runTrustGate` calls in the `run`, `resume`, `plan`, `plugins list`, `setup`, `precheck`, `prompts` and `mcp lock` actions per the gated-commands table.
4. **US-004: `nax trust` command** — depends on US-001. `src/cli/trust.ts` handlers and `_cliTrustDeps`; the `trust` group in `bin/nax.ts`; `docs/guides/cli-reference.md`, `README.md`, `CHANGELOG.md` entries.
5. **US-005: Backstops for imports, hooks and MCP** — depends on US-002. `assertTrusted` in `loadPlugins`, `loadSingleProvider`, `fireHook` and the MCP pool's `open`.
6. **US-006: Backstops for command spawns and the sandbox deny** — depends on US-002. `assertTrusted` in `runQualityCommand`, `executeWithTimeout`, the hardening spawn, `maybeRunNewPackageSetup` and `prepareWorktreeDependencies`; `trustStoreFile` in `SandboxPolicyInput`, `buildSandboxPolicy` and `resolveSessionSandbox`.

### Context Files

**US-001**
- `src/permissions/approvals-store.ts` — read/parse states and refuse-to-rewrite stance to mirror
- `src/utils/realpath.ts` — `realOrRaw`, the normalization primitive
- `src/config/global-only-keys.ts` — `rejectGlobalOnlyKeys` to extend
- `src/config/loader.ts` — `findProjectDir`
- `src/utils/path-file-lock.ts` — `withPathFileLock`

**US-002**
- `src/trust/store.ts` — created by US-001, read by the gate
- `src/trust/match.ts` — created by US-001, coverage rule reused by the registry
- `src/cli/confirm.ts` — existing stdin prompt helper and its `_confirmDeps` seam
- `test/preload.ts` — isolated `NAX_GLOBAL_CONFIG_DIR` set-up to extend
- `src/utils/realpath.ts` — `realOrRaw`, reused for normalization

**US-003**
- `bin/nax.ts` — gated command actions
- `src/commands/resume.ts` — `registerResumeCommand`
- `src/trust/gate.ts` — created by US-002, `ensureProjectTrusted` wrapped by `runTrustGate`
- `test/integration/cli/cli-run-preflight.test.ts` — subprocess CLI test pattern to mirror

**US-004**
- `src/cli/approvals.ts` — handler, output seam and TTY-refusal pattern to mirror
- `src/cli/approvals-format.ts` — list and JSON formatting pattern
- `src/trust/store.ts` — created by US-001
- `src/trust/match.ts` — created by US-001
- `bin/nax.ts` — `approvals` group registration to sit beside

**US-005**
- `src/plugins/loader.ts` — `loadPlugins`
- `src/context/engine/providers/plugin-loader.ts` — `loadPluginProviders`, `loadSingleProvider`, `_pluginLoaderDeps`
- `src/hooks/runner.ts` — `fireHook`, `LoadedHooksConfig`
- `src/mcp/pool.ts` — `createMcpPool`
- `src/mcp/client.ts` — `_mcpClientDeps.createTransport`

**US-006**
- `src/quality/runner.ts` — `runQualityCommand`, `_qualityRunnerDeps`
- `src/verification/executor.ts` — `executeWithTimeout`, `_executorDeps`
- `src/acceptance/hardening.ts` — `runHardeningPass`, `_hardeningDeps`
- `src/sandbox/policy-builder.ts` — `buildSandboxPolicy`, `approvalsFile` precedent
- `test/unit/agents/coding-tool-sandbox.test.ts` — "policy carries the approvals file" test pattern

### Creates

**US-001**
- `src/trust/types.ts`
- `src/trust/match.ts`
- `src/trust/store.ts`
- `src/trust/index.ts`
- `test/unit/trust/match.test.ts`
- `test/unit/trust/store.test.ts`

**US-002**
- `src/trust/registry.ts`
- `src/trust/prompt.ts`
- `src/trust/gate.ts`
- `test/helpers/trust.ts`
- `test/unit/trust/registry.test.ts`
- `test/unit/trust/gate.test.ts`

**US-003**
- `src/cli/trust-gate.ts`
- `test/unit/cli/trust-gate.test.ts`
- `test/integration/cli/cli-trust-gate.test.ts`

**US-004**
- `src/cli/trust.ts`
- `test/unit/cli/trust.test.ts`
- `test/integration/cli/cli-trust.test.ts`

**US-005**
- `test/unit/trust/backstops-imports.test.ts`

**US-006**
- `test/unit/trust/backstops-commands.test.ts`

### Modifies

**US-001**
- `test/unit/config/global-only-keys.test.ts` — gains the `trust` rejection case; no existing assertion changes, because `auth` handling is unchanged.

**US-002**
- `test/preload.ts` — after it sets NAX_GLOBAL_CONFIG_DIR (line 29), it writes a trust.json into that directory with one entry trusting the filesystem root (path "/", via "cli") and marks the filesystem root trusted in the registry. Replacing invariant: every existing test, including subprocess CLI tests that inherit NAX_GLOBAL_CONFIG_DIR, runs as trusted; tests of the untrusted path reset the registry or point NAX_GLOBAL_CONFIG_DIR at an empty directory, and restore the state after.
- `test/helpers/index.ts` — gains a re-export of useUntrustedRegistry from the new trust helper module; no existing export changes.

**US-003**

None. No existing test pins the ordering of statements in the gated actions, and the US-002 preload keeps every existing subprocess CLI test (`test/integration/cli/cli-run-*.test.ts`, `cli-profile-flag.test.ts`) trusted.

**US-004**

None. No existing assertion pins the CLI barrel's export list (`test/unit/cli/auth.test.ts` checks `typeof` per export) or `bin/nax.ts`'s command set.

**US-005**

None. Existing tests of `loadPlugins`, `loadPluginProviders`, `fireHook` and the MCP pool run under the US-002 preload's `markTrusted("/")`, so their assertions hold.

**US-006**
- `test/unit/sandbox/policy-builder.test.ts` — any test asserting the exact `denyWrite` array of a policy built without `trustStoreFile` still holds (the field is optional); a new case covers the field. No existing assertion changes.

### Seams

- US-001 -> US-002: `readTrustStore`, `addTrustEntry`, `findCoveringEntry` are consumed by `ensureProjectTrusted`; US-002's gate ACs run against a real store in a temp `NAX_GLOBAL_CONFIG_DIR`.
- US-002 -> US-003: `ensureProjectTrusted` is consumed by `runTrustGate`, which the gated actions call. US-003's ACs enter at the real CLI entry point (`bun bin/nax.ts <command>` in a subprocess with an empty `NAX_GLOBAL_CONFIG_DIR`), which proves each action calls the gate before it loads anything.
- US-002 -> US-005 and US-006: `assertTrusted` is consumed by each execution site. Each backstop AC calls the site's own production function (`loadPlugins`, `loadPluginProviders`, `fireHook`, the pool's `listTools`, `runQualityCommand`, `executeWithTimeout`, `runHardeningPass`, `maybeRunNewPackageSetup`, `prepareWorktreeDependencies`) with the registry reset, and asserts the import or spawn seam is never reached. The outermost entry point, a gated CLI command, is covered by US-003.
- US-001 -> US-004: the store API is consumed by the `nax trust` handlers; US-004 includes subprocess ACs through `bun bin/nax.ts trust`.
- US-001 -> US-006: `trustStorePath` is consumed by `resolveSessionSandbox`; the AC observes it in the policy the fake backend receives.

## Acceptance Criteria

Unless an AC says otherwise: `NAX_GLOBAL_CONFIG_DIR` points at a fresh temp directory per test; "the store" is `trust.json` in it; temp project directories are created under the OS temp dir and referred to by their `realpath`; `_deps` objects are replaced and restored after each test. "Rejects with `CODE`" means the promise rejects with a `NaxError` whose `code` is `CODE`.

### US-001: Trust store and path matching

- [unit] `findCoveringEntry([{ path: "/a/foo", ... }], "/a/foo")` returns that entry.
- [unit] `findCoveringEntry([{ path: "/a/foo", ... }], "/a/foo/bar/baz")` returns that entry.
- [unit] `findCoveringEntry([{ path: "/a/foo", ... }], "/a/foobar")` returns `null`.
- [unit] `findCoveringEntry([{ path: "/", ... }], "/x/y")` returns the `/` entry.
- [unit] `findCoveringEntry` with entries `/a` and `/a/b` for the path `/a/b/c` returns the `/a/b` entry.
- [unit] `normalizeTrustPath` of a symlink pointing at a temp directory returns the directory's `realpath`.
- [unit] `normalizeTrustPath` of an existing directory given with a trailing `/` returns the same string as for the path without it.
- [unit] `normalizeTrustPath(<symlink to a temp directory>/not-yet/created)` returns the `realpath` of the temp directory followed by `/not-yet/created`.
- [unit] `resolveTrustRoot(<project>/src/deep)`, where `<project>/.nax/config.json` exists, returns `<project>`.
- [unit] `resolveTrustRoot(<dir>)`, where no `.nax/config.json` exists in `<dir>` or any ancestor, returns `resolve(<dir>)`.
- [unit] With `NAX_GLOBAL_CONFIG_DIR` set to `<home>/.nax` and `<home>/.nax/config.json` present, `resolveTrustRoot(<home>/x)`, where `<home>/x` has no `.nax/config.json`, returns `resolve(<home>/x)`.
- [unit] `readTrustStore()` with no store file returns `{ state: "missing" }`.
- [unit] `readTrustStore()` with a store containing `{not json` returns an object whose `state` is `"unparseable"`.
- [unit] `readTrustStore()` with a store containing `{"version":2,"folders":[]}` returns an object whose `state` is `"unparseable"`.
- [unit] With no store file and `_trustStoreDeps.now` returning `new Date("2026-09-30T00:00:00.000Z")`, `addTrustEntry(<dir>, "cli")` leaves a store that parses to `{ version: 1, folders: [{ path: <realpath dir>, addedAt: "2026-09-30T00:00:00.000Z", via: "cli" }] }`.
- [unit] After `addTrustEntry(<dir>, "cli")`, the store file's permission bits are `0o600`.
- [unit] With the store trusting `<dir>`, `addTrustEntry(<dir>/child, "cli")` returns `{ outcome: "already-covered", coveredBy }` with `coveredBy.path` equal to `<dir>`, and the store file's bytes are unchanged.
- [unit] With a store containing `{not json`, `addTrustEntry(<dir>, "cli")` rejects with `TRUST_STORE_UNREADABLE` and the store file's bytes are unchanged.
- [unit] Two concurrent calls `addTrustEntry(<dirA>, "cli")` and `addTrustEntry(<dirB>, "cli")` both resolve with outcome `"added"`, and the store afterwards lists both paths.
- [unit] With the store trusting `<dir>`, `removeTrustEntry(<dir>)` returns outcome `"removed"` and the store afterwards has no entry for `<dir>`.
- [unit] With the store trusting `<dir>` only, `removeTrustEntry(<dir>/child)` returns `{ outcome: "not-found", coveredBy }` with `coveredBy.path` equal to `<dir>`, and the store file's bytes are unchanged.
- [unit] With a store containing `{not json`, `removeTrustEntry(<dir>)` rejects with `TRUST_STORE_UNREADABLE`.
- [unit] `rejectGlobalOnlyKeys({ trust: {} }, "project config")` throws a `NaxError` with code `TRUST_CONFIG_NOT_GLOBAL` and message `trust is global-only and cannot be set in project config`.

### US-002: Trust registry and entry gate

These tests call `useUntrustedRegistry()`, so each starts with an empty registry and the preload's trusted state is restored after it.

- [unit] With nothing marked, `assertTrusted(<dir>, "hooks")` rejects with `PROJECT_UNTRUSTED` whose `context.surface` is `"hooks"`.
- [unit] After `markTrusted(<dir>)`, `assertTrusted(<dir>/sub, "plugins")` resolves.
- [unit] After `markTrusted("/a/foo")`, `assertTrusted("/a/foobar", "plugins")` rejects with `PROJECT_UNTRUSTED`.
- [unit] After `markTrusted(<dir>)` then `resetTrustRegistry()`, `assertTrusted(<dir>, "plugins")` rejects with `PROJECT_UNTRUSTED`.
- [unit] With the store trusting `<dir>`, `ensureProjectTrusted(<dir>, { interactive: false })` resolves, and `assertTrusted(<dir>/x, "mcp")` then resolves.
- [unit] With no store, `ensureProjectTrusted(<dir>, { interactive: false })` rejects with `PROJECT_UNTRUSTED` whose `context.root` is `<dir>` and `context.hint` is `run: nax trust add <dir>`.
- [unit] With no store, `ensureProjectTrusted(<dir>, { interactive: false })` never calls `_trustGateDeps.prompt`.
- [unit] With no store and `interactive: true`, `ensureProjectTrusted(<dir>, ...)` calls `_trustGateDeps.prompt` once with `(<dir>, dirname(<dir>))`.
- [unit] With no store, `interactive: true` and the prompt returning `"yes"`, after `ensureProjectTrusted(<dir>, ...)` resolves the store lists `<dir>` with `via` `"prompt"`.
- [unit] With no store, `interactive: true` and the prompt returning `"yes"`, after `ensureProjectTrusted(<dir>, ...)` resolves, `assertTrusted(<dir>, "hooks")` resolves.
- [unit] With no store, `interactive: true` and the prompt returning `"parent"`, after `ensureProjectTrusted(<dir>, ...)` resolves the store lists `dirname(<dir>)` with `via` `"prompt"`.
- [unit] With no store, `interactive: true` and the prompt returning `"no"`, `ensureProjectTrusted(<dir>, ...)` rejects with `PROJECT_UNTRUSTED` and no store file exists afterwards.
- [unit] With a store containing `{not json`, `ensureProjectTrusted(<dir>, { interactive: true })` rejects with `TRUST_STORE_UNREADABLE` without calling `_trustGateDeps.prompt`.
- [unit] With `_trustPromptDeps.ask` resolving `"Y"`, `promptTrustChoice("/r/p", "/r")` resolves `"yes"`.
- [unit] With `_trustPromptDeps.ask` resolving `" parent "`, `promptTrustChoice("/r/p", "/r")` resolves `"parent"`.
- [unit] With `_trustPromptDeps.ask` resolving `""`, `promptTrustChoice("/r/p", "/r")` resolves `"no"`.
- [unit] With `_trustPromptDeps.ask` resolving `null`, `promptTrustChoice("/r/p", "/r")` resolves `"no"`.
- [unit] `promptTrustChoice("/r/p", "/r")` calls `_trustPromptDeps.ask` with exactly `Trust /r/p? nax will run this project's plugins, hooks, MCP servers and test commands. [y]es / [p]arent (/r) / [N]o `.
- [unit] With `_trustPromptDeps.ask` resolving `"p"`, `promptTrustChoice("/r/p", null)` resolves `"no"`.
- [unit] `promptTrustChoice("/home/u/p", null)` calls `_trustPromptDeps.ask` with exactly `Trust /home/u/p? nax will run this project's plugins, hooks, MCP servers and test commands. [y]es / [N]o `.
- [unit] With no store, `_trustGateDeps.homedir` returning `<home>` and `interactive: true`, `ensureProjectTrusted(<home>/p, ...)` calls `_trustGateDeps.prompt` with `(<home>/p, null)`.
- [unit] With no store, `_trustGateDeps.homedir` returning `<home>` and `interactive: true`, `ensureProjectTrusted(<home>, ...)` rejects with `PROJECT_UNTRUSTED` whose `context.hint` is `run: nax trust add <home> --force`, without calling `_trustGateDeps.prompt`.

Verification note: the `test/preload.ts` change and `useUntrustedRegistry` are test infrastructure with no AC; the full suite passing under `bun run test` after US-005 and US-006 land is its check.

### US-003: Gate the CLI commands

The unit ACs call `runTrustGate` with `_trustGateCliDeps.isInteractive`, `error` and `exit` replaced (`exit` records its argument and throws a sentinel so the call stops). Each integration AC spawns `bun <absolute path of bin/nax.ts> ...` with `NAX_GLOBAL_CONFIG_DIR` set to an empty temp directory, stdin `"ignore"`, and a temp project `<dir>` whose `.nax/config.json` is `{}`, unless the AC says otherwise; the working directory is the repository root unless the AC names another. Each subprocess case passes an explicit test timeout of 60_000 ms.

- [unit] With no store and `isInteractive` returning `false`, `runTrustGate(<dir>)` calls `exit` with `2`.
- [unit] With no store and `isInteractive` returning `false`, `runTrustGate(<dir>)` calls `error` with `Project not trusted: <dir>` and then with `run: nax trust add <dir>`.
- [unit] With a store containing `{not json`, `runTrustGate(<dir>)` calls `exit` with `2`.
- [unit] With the store trusting `<dir>` and `<dir>/.nax/config.json` present, `runTrustGate(<dir>/src)` returns without calling `exit`.
- [integration] `run -f demo -d <dir> --headless` exits with code `2`.
- [integration] The stderr of `run -f demo -d <dir> --headless` contains `run: nax trust add <dir>`.
- [integration] With `<dir>/.nax/plugins/sentinel.ts` writing `<dir>/imported` when imported, `run -f demo -d <dir> --headless` exits `2` and `<dir>/imported` does not exist afterwards.
- [integration] `run -f demo -d <dir> --headless --schedule 1h` exits with code `2` within 30 seconds.
- [integration] `resume -f demo -d <dir>` exits with code `2`.
- [integration] `plan -f demo --from <dir>/spec.md -d <dir>`, with `<dir>/spec.md` present, exits with code `2`.
- [integration] `plugins list -d <dir>` exits with code `2`.
- [integration] `setup -d <dir> --dry-run` exits with code `2`.
- [integration] `precheck -f demo -d <dir>` exits with code `2`.
- [integration] `prompts -f demo -d <dir>` exits with code `2`.
- [integration] `prompts --export implementer -d <dir>` exits with code `0`.
- [integration] `mcp lock`, spawned with cwd `<dir>`, exits with code `2`.
- [integration] With `NAX_GLOBAL_CONFIG_DIR` containing a store that trusts `<dir>`, `plugins list -d <dir>` exits with code `0`.
- [integration] `config --json`, spawned with cwd `<dir>`, exits with code `0`.

### US-004: `nax trust` command

Unit ACs call the handlers with `_cliTrustDeps.log`, `error`, `isTTY`, `confirm`, `homedir` and `cwd` replaced; "stdout" and "stderr" mean the captured `log` and `error` calls.

- [unit] With the store trusting `<a>` and `<b>` and `cwd` returning `<a>/x`, `trustListCommand({})` logs the line for `<a>` starting with `* ` and the line for `<b>` starting with two spaces.
- [unit] With the store trusting `<a>` and `cwd` returning `<a>`, the stdout of `trustListCommand({ json: true })` parses to `{ path: trustStorePath(), folders: [<the a entry>], coveringCwd: <a> }`.
- [unit] With no store, `trustAddCommand({ path: <dir>, yes: true })` returns `0` and the store lists `<dir>` with `via` `"cli"`.
- [unit] With no store and `cwd` returning `<dir>`, `trustAddCommand({ yes: true })` adds `<dir>`.
- [unit] With the store trusting `<dir>`, `trustAddCommand({ path: <dir>/c, yes: true })` returns `0` and logs `Already trusted: <dir>/c is covered by <dir>`.
- [unit] `trustAddCommand({ path: "/", yes: true })` returns `1`, writes a stderr line containing `Pass --force`, and leaves no store file.
- [unit] With `homedir` returning `<home>`, `trustAddCommand({ path: <home>, yes: true })` returns `1` and leaves no store file.
- [unit] `trustAddCommand({ path: "/", yes: true, force: true })` returns `0` and the store lists `/`.
- [unit] With the store trusting `/`, `trustAddCommand({ path: "/", yes: true })` returns `1` (the protected-folder check runs before the already-covered check).
- [unit] With `homedir` returning `<home>` and `isTTY` returning `false`, `trustAddCommand({ path: <home> })` writes a stderr line containing `Pass --force` and no line containing `stdin is not a TTY`.
- [unit] With the store trusting `<dir>` and `isTTY` returning `false`, `trustAddCommand({ path: <dir>/c })` returns `0` (the already-covered check runs before the TTY check).
- [unit] With `isTTY` returning `false`, `trustAddCommand({ path: <dir> })` returns `1`, never calls `confirm`, and leaves no store file.
- [unit] With `isTTY` returning `true` and `confirm` resolving `false`, `trustAddCommand({ path: <dir> })` returns `1`, logs `Not trusted.`, and leaves no store file.
- [unit] With `isTTY` returning `true` and `confirm` resolving `true`, `trustAddCommand({ path: <dir> })` returns `0` and the store lists `<dir>`.
- [unit] With the store trusting `<dir>`, `trustRmCommand({ path: <dir> })` returns `0`, logs `Removed <dir>`, and the store no longer lists `<dir>`.
- [unit] With no store, `trustRmCommand({ path: <dir> })` returns `1` and writes `No trust entry for <dir>` to stderr.
- [unit] With the store trusting `<dir>` only, `trustRmCommand({ path: <dir>/c })` writes `<dir>/c is still trusted through <dir>` to stderr.
- [unit] With the store trusting `<dir>`, `trustCheckCommand({ path: <dir> })` returns `0`.
- [unit] With no store, `trustCheckCommand({ path: <dir> })` returns `1` and logs `untrusted: <dir>`.
- [unit] With the store trusting `<dir>` and `<dir>/.nax/config.json` present, the stdout of `trustCheckCommand({ path: <dir>/src, json: true })` parses to `{ root: <dir>, trusted: true, coveredBy: <dir> }`.
- [unit] With a store containing `{not json`, `trustCheckCommand({ path: <dir> })` returns `1`.
- [integration] Spawning `bun bin/nax.ts trust check <dir> --json` with an empty `NAX_GLOBAL_CONFIG_DIR` exits `1` and its stdout parses to an object with `trusted` `false`.
- [integration] After spawning `bun bin/nax.ts trust add <dir> --yes` with the same `NAX_GLOBAL_CONFIG_DIR`, spawning `bun bin/nax.ts trust check <dir>` exits `0`.

Verification note: the `docs/guides/cli-reference.md`, `README.md` and `CHANGELOG.md` entries are documentation with no test.

### US-005: Backstops for imports, hooks and MCP

These tests call `useUntrustedRegistry()`, so each starts with an empty registry and the preload's trusted state is restored after it. "Sentinel" fixtures write a marker file when imported or executed.

- [unit] `loadPlugins(<emptyGlobalDir>, <projectPluginsDir with a sentinel plugin>, [], <project>)` rejects with `PROJECT_UNTRUSTED` whose `context.surface` is `"plugins"`.
- [unit] After `loadPlugins(<emptyGlobalDir>, <projectPluginsDir with a sentinel plugin>, [], <project>)` rejects, the sentinel marker file does not exist.
- [unit] `loadPlugins(<globalDir with one valid plugin>, <emptyProjectDir>, [], <project>)` resolves to a registry whose `plugins` include that global plugin.
- [unit] `loadPlugins(<emptyGlobalDir>, <emptyProjectDir>, [{ module: "./p.ts" }], <project>)` rejects with `PROJECT_UNTRUSTED`.
- [unit] After `markTrusted(<project>)`, `loadPlugins(<emptyGlobalDir>, <projectPluginsDir with a valid plugin>, [], <project>)` resolves to a registry whose `plugins` include that plugin.
- [unit] `loadPluginProviders([{ module: "./prov.ts" }], <project>)` rejects with `PROJECT_UNTRUSTED` whose `context.surface` is `"context-plugin-providers"`.
- [unit] After `loadPluginProviders([{ module: "./prov.ts" }], <project>)` rejects, `_pluginLoaderDeps.dynamicImport` has not been called.
- [unit] `loadPluginProviders([{ module: "./prov.ts", enabled: false }], <project>)` resolves to `[]`.
- [unit] `fireHook` with a `LoadedHooksConfig` whose project `hooks["on-start"]` is a sentinel command rejects with `PROJECT_UNTRUSTED` whose `context.surface` is `"hooks"`.
- [unit] After that `fireHook` call rejects, the project hook's sentinel marker file does not exist.
- [unit] `fireHook` with a `LoadedHooksConfig` that has only a `_global` `on-start` sentinel hook resolves, and the global hook's sentinel marker file exists afterwards.
- [unit] With `_mcpClientDeps.createTransport` replaced by a spy, `createMcpPool({ servers: { s: <enabled stdio server> } }).listTools("s", <project>)` rejects with `PROJECT_UNTRUSTED` whose `context.surface` is `"mcp"`.
- [unit] After that `listTools` call rejects, `_mcpClientDeps.createTransport` has not been called.
- [unit] With `_mcpClientDeps.createTransport` replaced by a spy, `createMcpPool({ servers: { s: <enabled stdio server> } }).call("s", <project>, "t", {}, { timeoutMs: 1000, maxBytes: 1000 })` rejects with `PROJECT_UNTRUSTED`.
- [unit] After `markTrusted(<project>)`, with `_mcpClientDeps.createTransport` and `createClient` replaced by fakes, `createMcpPool({ servers: { s: <enabled stdio server> } }).listTools("s", <project>)` calls `createTransport` once.

### US-006: Backstops for command spawns and the sandbox deny

These tests call `useUntrustedRegistry()`, so each starts with an empty registry and the preload's trusted state is restored after it. Each spawn seam (`_qualityRunnerDeps.spawn`, `_executorDeps.spawn`, `_hardeningDeps.spawn`, `_newPackageSetupDeps.spawn`, `_worktreeDependencyDeps` spawn) is replaced by a spy.

- [unit] `runQualityCommand({ commandName: "test", command: "echo hi", workdir: <project> })` rejects with `PROJECT_UNTRUSTED` whose `context.surface` is `"quality-command"`.
- [unit] After that `runQualityCommand` call rejects, `_qualityRunnerDeps.spawn` has not been called.
- [unit] `executeWithTimeout("echo hi", 5, undefined, { cwd: <project> })` rejects with `PROJECT_UNTRUSTED` whose `context.surface` is `"test-command"`.
- [unit] After that `executeWithTimeout` call rejects, `_executorDeps.spawn` has not been called.
- [unit] `executeWithTimeout("echo hi", 5)` with no `cwd` rejects with `PROJECT_UNTRUSTED`.
- [unit] With `_hardeningDeps.callOp`, `savePRD`, `detectLanguage` and `spawn` replaced by spies, `runHardeningPass` for a context whose PRD has one story with one suggested criterion resolves to `{ promoted: [], discarded: [] }`.
- [unit] After that `runHardeningPass` call, `_hardeningDeps.callOp` has not been called.
- [unit] After that `runHardeningPass` call, `_hardeningDeps.spawn` has not been called.
- [unit] With `runtime = {}` and `markNewPackageDirs(runtime, [<project>/pkg])` called first, `maybeRunNewPackageSetup({ runtime, storyId: "US-001", packageDir: <project>/pkg, setupCommand: "echo hi" })` rejects with `PROJECT_UNTRUSTED` whose `context.surface` is `"package-setup"`.
- [unit] After that `maybeRunNewPackageSetup` call rejects, `_newPackageSetupDeps.spawn` has not been called.
- [unit] `prepareWorktreeDependencies({ projectRoot: <project>, worktreeRoot: <project>/.nax-wt/w1, storyId: "US-001", config })`, where `config.execution.worktreeDependencies` has `mode` `"provision"` and `setupCommand` `"echo hi"` and `<project>/.nax-wt/w1` exists, rejects with `PROJECT_UNTRUSTED` whose `context.surface` is `"worktree-setup"`.
- [unit] After that `prepareWorktreeDependencies` call rejects, the `_worktreeDependencyDeps` spawn has not been called.
- [unit] `buildSandboxPolicy` with `trustStoreFile` set to `<home>/.nax/trust.json` and `config.filesystem.allowWrite` `["~/.nax"]` returns a policy whose `denyWrite` contains `<home>/.nax/trust.json`.
- [unit] `buildSandboxPolicy` without `trustStoreFile` returns a policy whose `denyWrite` has no `undefined` entry.
- [unit] With the sandbox enabled and the fake backend available, a command run through the launcher `resolveSessionSandbox({ config: enabled, root, needsLauncher: true })` returns reaches the backend with a policy whose `denyWrite` contains `realOrRaw(trustStorePath())`.
