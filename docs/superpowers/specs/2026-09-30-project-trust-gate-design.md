# Project trust gate — design

**Date:** 2026-09-30 · **Status:** designed; design review 2026-09-30 folded in (revision 2)
**Baseline:** `main` @ `af1e65de3` (v0.83.0). Citations below were read against it.
**Issue:** #2293 ("Project-local plugins load without a trust gate"), scope widened by ruling R-1
**Branch:** `feat/project-trust-gate` (off `main`)
**Spec:** `docs/specs/SPEC-project-trust-gate.md`

---

## 1. Problem

nax runs code the repository controls, on the host, outside the agent sandbox, with no consent
step. #2293 filed this for plugins. Plugins are one of several such paths:

| # | Repository-controlled source | Site | Runs as |
|---|---|---|---|
| S1 | `<project>/.nax/plugins/*` | `src/plugins/loader.ts:236-254`, import at `:433` | in-process `import()` |
| S2 | config `plugins[]` (file paths and bare package names) | `src/plugins/loader.ts:256-285`, import at `:433` | in-process `import()` |
| S3 | config `context.v2.pluginProviders` | `src/context/engine/providers/plugin-loader.ts:38` via `:188` | in-process `import()` |
| S4 | `<project>/.nax/hooks.json` | `src/hooks/runner.ts:225`, project branch of `fireHook` `:316-327` | argv spawn (no shell) |
| S5 | config `mcp.servers` (`command` + `args`) | `connectMcpServer`, `src/mcp/client.ts` (`_mcpClientDeps.createTransport`); reached from the pool (`src/mcp/pool.ts:86`) and `nax mcp lock` | spawned process |
| S6a | config quality / review commands | `src/quality/runner.ts:154` (`runQualityCommand`) | `/bin/sh -c` |
| S6b | config or auto-detected test commands | `src/verification/executor.ts:107` | `<shell> -c` |
| S6c | `acceptance.command` | `src/acceptance/hardening.ts:179` | `/bin/sh -c` |
| S6d | `quality.commands.setup` | `src/execution/new-package-setup.ts:91` | argv spawn |
| S6e | `execution.worktreeDependencies.setupCommand` | `src/worktree/dependencies.ts:63` (`runArgv`) | argv spawn |

Auto-detected commands (`src/quality/command-defaults.ts:121-131`, e.g. `<pm> run test`) run the
repository's `package.json` scripts through S6a/S6b. None of S6 is sandboxed. Running nax on a
repository therefore executes that repository's code with the user's privileges and read access
to `~/.nax/credentials`; a plugins-only gate would leave the same capability open through S4-S6.

Config reaching these sites is repository-controlled through more layers than
`.nax/config.json`: project profiles `<project>/.nax/profiles/<name>.json` are merged into the
profile chain (`src/config/profile.ts:79-108`), and per-package `.nax/mono/<pkg>/config.json`
overrides S6 commands (`src/config/merge.ts:100-170`).

The config `hooks` key is validated and merged but never executed (`fireHook` reads only
`hooks.json`), so it is not a site.

Why now: the `loop-handlers` extension (#2288) gives S1/S2 a hook into every native agent turn,
and koda fleet runners clone repositories and run `nax run` in them unattended.

## 2. Rulings (brainstorm 2026-09-30)

- **R-1 Scope: whole-repo trust.** One decision per repository gates every repository-controlled
  host-side execution path (S1-S6). An untrusted repository refuses the gated commands.
- **R-2 Unit: folder path, covering descendants.** Trust attaches to a folder (after `realpath`);
  an entry covers that folder and everything under it. Trusting a parent (`~/workspace`, koda's
  `workspaceRoot`) covers every repository below it, including ones cloned later — the README
  says so plainly. No content hash: test code changes every commit.
- **R-3 Untrusted behavior: prompt, else fail closed.** With a TTY, prompt and persist the
  answer. Without one, fail with an error naming `nax trust add <root>`. No per-invocation bypass
  flag, no environment variable.
- **R-4 Enforcement: approach C.** One entry gate per gated command (the only place that
  prompts), plus a backstop at every execution site that refuses unless the entry gate recorded
  trust.
- **R-5 Backstop state: process-scoped registry**, not threaded through the runtime.
- **R-6 Provenance (design review):** no per-entry layer tracking in the config merge. Every
  merged config entry (plugins, MCP servers, pluginProviders, commands) is treated as
  project-sourced and needs trust. Only structurally separate global sources are exempt: the
  global plugin directory and built-ins in `loadPlugins`, and the global `hooks.json`
  (`LoadedHooksConfig._global`). Consequence: `nax plugins list` in an untrusted repository is
  refused by its entry gate rather than showing global plugins.

## 3. Trust model and store

**Project root.** `dirname(findProjectDir(workdir))` when a `.nax/config.json` is found walking
up from the workdir (`src/config/loader.ts:285`), else the workdir itself; then `realpath`. The
prompt and error name this root, never a subdirectory, so config found by walking up is always
covered.

**Matching.** A path `P` is covered by entry `E` when `realpath(P) === E`, or `E` is `/`, or
`realpath(P)` starts with `E + "/"`. `/a/foo` never matches `/a/foobar`. Entries are stored
realpath-resolved with no trailing separator (except `/`).

**Store:** `<globalConfigDir()>/trust.json` (`globalConfigDir()` honours
`NAX_GLOBAL_CONFIG_DIR`, `src/config/paths/index.ts:61-65`).

```json
{
  "version": 1,
  "folders": [
    { "path": "/Users/w/workspace", "addedAt": "2026-09-30T00:00:00.000Z", "via": "prompt" }
  ]
}
```

- Read-modify-write runs under `withPathFileLock` (`src/utils/path-file-lock.ts:27`); the write
  is a temp file created with mode `0o600` and renamed over the target.
- Missing file: no trust. Unparseable file or wrong shape: no trust, and any write refuses with
  `TRUST_STORE_UNREADABLE` without rewriting it (same stance as `approvals-store.ts:251-254`).
- Nothing inside a repository can grant trust. `trust` joins `rejectGlobalOnlyKeys`
  (`src/config/global-only-keys.ts:6-12`), which already runs on project config, CLI overrides,
  package configs and profiles (`loader.ts:139,228,400,475`, `profile.ts:112`).
- The agent sandbox denies writes to the store: `buildSandboxPolicy` adds `trustStoreFile` to
  `denyWrite` (`src/sandbox/policy-builder.ts:128-134`; deny beats allow). A default-config pin
  is not enough, because project config `execution.sandbox.filesystem.allowWrite` can name
  `~/.nax`. (A project that sets `execution.sandbox.enabled: false` runs agent commands
  unsandboxed; it can only do so after being trusted.)

## 4. CLI: `nax trust`

Modelled on `nax approvals` (`src/cli/approvals.ts`), including its refusal to confirm without a
TTY (`approvals.ts:329-333`) — `promptForConfirmation` resolves `true` on a non-TTY
(`src/cli/confirm.ts:70`), so it is never called without a TTY here.

| Command | Behavior |
|---|---|
| `nax trust list [--json]` | Print entries; mark the one covering cwd. |
| `nax trust add [path] [--yes] [--force]` | Default path = cwd. Confirms unless `--yes`; without a TTY and without `--yes` it refuses. Refuses `/` and the home directory unless `--force`. A path already covered is a no-op naming the covering entry. |
| `nax trust rm <path>` | Removes an exact entry. Says so when a parent entry still covers the path. |
| `nax trust check [path] [--json]` | Exit 0 trusted, 1 untrusted. |

## 5. Enforcement

### 5.1 Entry gate

`ensureProjectTrusted(root, { interactive })` in `src/trust/`: covered -> mark trusted; not
covered and interactive -> three-way prompt `[y]es / [p]arent / [N]o` (a new prompt, default No;
`promptForConfirmation` defaults to yes and cannot offer three choices) -> persist and mark;
otherwise throw `PROJECT_UNTRUSTED`. The CLI helper `runTrustGate` prints the message and hint to
stderr and exits **2** (handlers exit 1 on other errors, `bin/nax.ts:259-265`).

**Gated commands:** `run` (including `--compare`; gate before hooks load `:309`, the TUI
`:296-330` and the `--schedule` wait `:337`), `resume` (`src/commands/resume.ts:108`), `plan`
(its runtime starts MCP servers for the plan stage), `plugins list`, `setup` (verify runs quality
commands), `precheck` (spawns `agent.default --version`), `prompts` (runs the context stage,
which imports plugin providers), `mcp lock` (spawns servers). Everything else stays open,
including `config`, `status`, `auth`, `sandbox probe`, `approvals`, `trust`, `generate`, `init`,
`detect`, `accept`, `spec lint`, `rules *`, `curator *`, `context *`, `logs`, `runs`.

### 5.2 Registry

`src/trust/registry.ts`, process-scoped, append-only: `markTrusted(root)` (called only by
`ensureProjectTrusted`) and `assertTrusted(path, surface)` (passes when a marked root covers
`realpath(path)`, else throws `PROJECT_UNTRUSTED`). `resetTrustRegistry()` exists for tests.

### 5.3 Backstops

`assertTrusted` runs immediately before the import or spawn, **outside** any surrounding
`try/catch` that would turn it into a warning:

- S1 per project-directory plugin, S2 per config entry (`loadPlugins`); global directory and
  built-ins exempt.
- S3 per enabled entry, before the `try` in `loadSingleProvider`.
- S4 in `fireHook`, before the project hook's `try`; global hooks exempt.
- S5 in `connectMcpServer`, before `createTransport` (covers the pool and `mcp lock`).
- S6c exception: `runHardeningPass` wraps the whole pass in a non-blocking `catch` (`src/acceptance/hardening.ts:330-336`); the backstop still prevents the spawn, and the rejection is logged as a hardening failure.
- S6a-S6e at each spawn listed in §1, asserting the spawn's `cwd` (`workdir`, `packageDir`,
  worktree root; the executor falls back to the process working directory, as `Bun.spawn` does).

### 5.4 Tests

`test/preload.ts` already isolates `globalConfigDir()` per run (`:29`). It gains a `trust.json`
there trusting `/` and calls `markTrusted("/")`, so the ~33 existing test files touching guarded
seams, and subprocess CLI tests (they inherit `NAX_GLOBAL_CONFIG_DIR`), keep passing. Tests of
the untrusted path reset the registry or point `NAX_GLOBAL_CONFIG_DIR` at an empty directory.
There is no production bypass.

## 6. Errors

| Code | When | Payload |
|---|---|---|
| `PROJECT_UNTRUSTED` | entry gate refusal or backstop | `{ stage: "trust", root, surface?, hint }` |
| `TRUST_STORE_UNREADABLE` | write against an unparseable `trust.json` | `{ stage: "trust", path, reason }` |
| `TRUST_CONFIG_NOT_GLOBAL` | a non-global layer sets `trust` | `{ stage: "config", layerName }` |

## 7. Rollout

- Breaking; next minor. CHANGELOG **BREAKING** entry; README section "Project trust".
- Existing users: first gated command per repository prompts once. No warn-only phase and no
  automatic migration.
- CI: `nax trust add "$PWD" --yes` before `nax run`.
- Koda (separate issue after this ships): `koda-runner install-service` runs
  `nax trust add <workspaceRoot> --yes`; after checkout `nax trust check <clone> --json`, failing
  the job with `stateReason = 'project untrusted'` before spawning nax.

## 8. Non-goals

- Sandboxing host-side commands; per-plugin decisions; content hashes; a bypass flag or env var.
- Changing global or built-in plugin loading.
- A backstop in `checkAgentCLI` (`src/precheck/checks-cli.ts:67`): it takes no workdir, and its
  only callers (`nax precheck`, run precheck) are gated.
- The agent's own tool commands (`src/tools/bash.ts`, `run-command.ts` argv path): they run only
  inside a session of a run that passed the entry gate.
- Fixing the bakeoff hooks path (`src/bakeoff/pipeline-adapter.ts:60` loads
  `<worktree>/hooks.json`, not `<worktree>/.nax/hooks.json`) — a separate issue.
