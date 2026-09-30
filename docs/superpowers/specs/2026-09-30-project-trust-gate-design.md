# Project trust gate — design

**Date:** 2026-09-30 · **Status:** designed (brainstorm rulings 2026-09-30), awaiting spec review
**Baseline:** `main` @ `af1e65de3` (v0.83.0). Citations below were read against it.
**Issue:** #2293 ("Project-local plugins load without a trust gate"), scope widened by ruling R-1
**Branch:** `feat/project-trust-gate` (off `main`)

---

## 1. Problem

nax runs code that the repository controls, on the host, outside the agent sandbox, with no
consent step. #2293 filed this for plugins. Reading the code shows plugins are one of several
such paths:

| # | Repository-controlled source | Site | Runs as |
|---|---|---|---|
| S1 | `<project>/.nax/plugins/*` | `src/plugins/loader.ts:236-253` | in-process `import()` |
| S2 | project config `plugins[]` | `src/plugins/loader.ts:255-285` | in-process `import()` |
| S3 | project config `context.v2.pluginProviders` | `src/context/engine/providers/plugin-loader.ts:159` | in-process `import()` |
| S4 | `<project>/.nax/hooks.json` and project config `hooks` | `src/hooks/runner.ts:54`, `src/config/merger-special-cases.ts:73` | shell command |
| S5 | project config `mcp.servers` (`command` + `args`) | `src/config/schemas-mcp.ts:47`, pool `src/runtime/index.ts:372` | spawned process |
| S6 | project config quality / acceptance commands | `src/quality/runner.ts:278` (12 callers), `src/acceptance/hardening.ts:179` (direct `/bin/sh -c`) | shell command, secrets stripped from env, **not sandboxed** |

The agent sandbox wraps only the agent's own tool calls (`src/agents/coding-tool-sandbox.ts`).
S6 alone means running nax on a repository executes that repository's code (its test script and
everything the test runner loads) with the user's privileges and read access to
`~/.nax/credentials`. A plugins-only gate would leave the same capability open through S4-S6.

Why now: the `loop-handlers` extension (#2288) gives S1/S2 a hook into every native agent turn,
and koda fleet runners (koda slice 3) clone repositories and run `nax run` in them unattended.

## 2. Rulings (brainstorm 2026-09-30)

- **R-1 Scope: whole-repo trust.** One decision per repository gates every repository-controlled
  host-side execution path (S1-S6). An untrusted repository refuses the gated commands.
- **R-2 Unit: folder path, covering descendants.** Trust attaches to a folder (after `realpath`);
  an entry covers that folder and everything under it, so trusting a parent (e.g. `~/workspace`,
  or koda's `workspaceRoot`) covers every repository below it. No content hash: test code changes
  every commit, so hashing config files would not cover the most likely vector.
- **R-3 Untrusted behavior: prompt, else fail closed.** With a TTY, prompt and persist the answer.
  Without one, fail with an error naming `nax trust add <root>`. No per-invocation bypass flag, no
  environment variable.
- **R-4 Enforcement: approach C.** One entry gate per gated command (the only place that prompts),
  plus a backstop at every execution site that refuses unless the entry gate recorded trust.
- **R-5 Backstop state: process-scoped registry** rather than threading a value through the
  runtime, because several S6 callers never receive the runtime.

## 3. Trust model and store

**Project root.** The folder nax resolves as the workdir (`-d`, else cwd), after `realpath`.
In a monorepo that is the repository root; its packages are descendants and therefore covered.

**Matching.** A root `R` is trusted when some entry `E` satisfies `realpath(R) === E` or
`realpath(R)` starts with `E + path.sep`. Entries are stored already resolved; trailing
separators are stripped on write. `/a/foo` never matches `/a/foobar`.

**Store:** `<globalConfigDir()>/trust.json`.

```json
{
  "version": 1,
  "folders": [
    { "path": "/Users/w/workspace", "addedAt": "2026-09-30T00:00:00.000Z", "via": "prompt" }
  ]
}
```

- `via` is `"prompt"` or `"cli"`.
- Writes are atomic (temp file + rename) with mode `0600`.
- A missing file means no trust. An unreadable or malformed file means no trust and raises
  `TRUST_STORE_UNREADABLE`; nax never rewrites a file it could not parse (same stance as
  `approvals-store.ts:254`).
- Nothing inside a repository can grant trust: no project config key, no profile key, no
  environment variable is read. `trust` is added to the global-only keys
  (`src/config/global-only-keys.ts`), so a project layer that sets it fails with
  `TRUST_CONFIG_NOT_GLOBAL`.
- The agent sandbox's `writeRoots` (`src/sandbox/srt-backend.ts:44`) do not cover
  `globalConfigDir()`; a test pins that `trust.json` stays outside them. Host-side commands only
  run after trust is granted; a trusted repository's code could add further entries, which is
  accepted (it already has the user's privileges).

## 4. CLI: `nax trust`

Modelled on `nax approvals` (`src/cli/approvals.ts`).

| Command | Behavior |
|---|---|
| `nax trust list [--json]` | Print entries; mark the entry covering cwd, if any. |
| `nax trust add [path] [--yes] [--force]` | Default path = cwd. Confirms via `promptForConfirmation` unless `--yes`. Refuses `/` and the home directory unless `--force`. Adding a path already covered by an entry is a no-op that names the covering entry. |
| `nax trust rm <path>` | Removes an exact entry only. If a parent entry still covers the path, says so. |
| `nax trust check [path] [--json]` | Exit 0 trusted, 1 untrusted. `--json`: `{ "root": string, "trusted": boolean, "coveredBy": string \| null }`. |

`trust` subcommands are never gated.

## 5. Enforcement

### 5.1 Entry gate

`ensureProjectTrusted(root, { interactive }): Promise<void>` in `src/trust/`.

1. Resolve `realpath(root)`; read the store.
2. Covered: `markTrusted(root)`; return.
3. Not covered, `interactive` (stdin and stdout are TTYs): prompt
   `Trust <root>? nax will run this project's plugins, hooks, MCP servers and test commands.
   [y]es / [p]arent (<parent>) / [N]o`. `y` or `p` persists the entry (`via: "prompt"`),
   marks trusted, returns. Anything else falls through to step 4.
4. Throw `PROJECT_UNTRUSTED` with `{ root, hint: "run: nax trust add <root>" }`.

The CLI prints the hint and **exits 2** on `PROJECT_UNTRUSTED` — a deliberate exception to nax's
exit-0-on-error behavior, so automation (koda) can detect it.

**Gated commands:** `run`, `resume`, `plan`, `plugins list`, `bakeoff`, `setup` (its verify step
runs quality commands, `src/cli/setup-verify.ts`). The spec classifies every remaining command in
`bin/nax.ts` (e.g. `precheck`, `accept`, `dryrun`, `context eval`) by whether it reaches S1-S6;
any that do are gated. Read-only commands stay open: `config`, `status`, `auth`, `sandbox probe`,
`trust`, `approvals`, `generate`, `logs`, `runs`. (Koda's capability probe runs
`nax config --profile <p> --json` from an empty temp dir and must keep working.)

### 5.2 Registry

`src/trust/registry.ts`, process-scoped, append-only:

- `markTrusted(root)`: called only by `ensureProjectTrusted`.
- `assertTrusted(path, surface)`: passes when some marked root contains `realpath(path)`;
  otherwise throws `PROJECT_UNTRUSTED` with `{ root: path, surface, hint }`.
- `_trustRegistryDeps` for tests (repo `_xDeps` pattern), including a reset for test isolation.

Module-level state is a deliberate exception to the no-mutation style: one writer, append-only,
and the alternative (threading `ProjectTrust` through twelve `runQualityCommand` callers) touches
far more code for a backstop.

### 5.3 Backstops

Each site calls `assertTrusted` before importing or spawning anything repository-controlled:

- **S1, S2** `loadPlugins`: before each project-directory plugin and each project-sourced
  `plugins[]` entry. Global directory and built-ins are exempt.
- **S3** `loadPluginProviders`: before each project-sourced entry.
- **S4** `loadHooksConfig` for the project `hooks.json`, and wherever project-sourced config
  `hooks` are executed.
- **S5** MCP pool: before connecting a project-sourced server.
- **S6** `runQualityCommand` (every call), `src/acceptance/hardening.ts` direct spawn, and every
  other host-side spawn of a config-derived command. **The spec must include a full inventory**
  of host-side `spawn` / `Bun.spawn` / `/bin/sh -c` sites that run config-derived commands,
  each with its backstop.

A command that skips the entry gate therefore fails at its first backstop instead of executing
repository code. Missing an entry gate fails closed.

**Layer provenance.** Global-sourced plugins, hooks and MCP servers do not need trust. Merged
config (`plugins[]`, `mcp.servers`, `hooks`, `context.v2.pluginProviders`) must let the site tell
a project-sourced entry from a global one. The spec picks one: record provenance during merge,
or treat every merged entry as project-sourced. The second is safe because an untrusted project
already refuses the gated commands, but it would make `nax plugins list` in an untrusted project
unable to show global plugins; the spec states which trade-off it takes.

## 6. Errors

| Code | When | Payload |
|---|---|---|
| `PROJECT_UNTRUSTED` | entry gate refusal or backstop | `{ root, surface?, hint }` |
| `TRUST_STORE_UNREADABLE` | malformed or unreadable `trust.json` | `{ path, reason }` |
| `TRUST_CONFIG_NOT_GLOBAL` | a non-global layer sets `trust` | `{ layerName }` |

## 7. Rollout

- Breaking; ships in the next minor. CHANGELOG entry under **BREAKING**; README section
  "Project trust".
- Existing users: the first gated command in each repository prompts once; `[p]arent` on a
  workspace folder covers all repositories under it. No warn-only phase, no automatic migration
  (inferring trust from run history would let a repository vouch for itself, since part of that
  history lives in the repository).
- CI: add `nax trust add "$PWD" --yes` before `nax run`.
- Koda (separate koda issue, filed after this spec merges; 3a-2 unaffected):
  `koda-runner install-service` runs `nax trust add <workspaceRoot> --yes`; after checkout the
  runner calls `nax trust check <clone> --json` and fails the job with
  `stateReason = 'project untrusted'` before spawning nax.

## 8. Testing

Repo test commands only (never bare `bun test`).

- **Unit:** path matching (segment boundary, symlinks, trailing separators, `/` and home refused
  without `--force`); store (atomic write, `0600`, malformed file refused and left untouched,
  missing file = empty); registry (mark, assert, containment, reset); prompt branches (TTY vs no
  TTY, `y` / `p` / `N`) via `_deps`; CLI `list` / `add` / `rm` / `check` including `--json`
  shapes and exit codes; `trust` rejected in project config.
- **Backstops:** for each of S1-S6, in an untrusted state the site throws `PROJECT_UNTRUSTED` and
  never imports or spawns: fixtures (a project plugin, a `hooks.json` command, an MCP server
  command, a quality command) each write a sentinel file, and the sentinel never appears.
  Global plugins, global hooks and global MCP servers still load without trust.
- **Integration:** `bun bin/nax.ts run` in a temp repository with no trust exits 2 with the hint
  before a runtime is created; after `nax trust add` it passes the gate. Same for `plan`.
- **Sandbox:** a test pins that the agent sandbox policy's `writeRoots` do not cover
  `trust.json`.

## 9. Non-goals

- Sandboxing host-side commands (hooks, MCP servers, quality/acceptance commands). A gate decides
  whether repository code runs; it does not contain it.
- Per-plugin trust decisions, content hashes, a `--trust` flag or environment variable.
- Changing global or built-in plugin loading.
