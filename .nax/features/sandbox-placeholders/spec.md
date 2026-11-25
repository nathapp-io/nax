# SPEC: Linux sandbox placeholders: ledger, stale sweep, staging guard and git excludes

Closes: #2986

## Summary

On Linux, bubblewrap (through srt) leaves empty placeholder files and directories (`.bashrc`, `.profile`, `.mcp.json`, `.claude`, `.vscode`, ...) in the directory nax runs from. This feature makes four changes, all in the nax sandbox layer:

1. **Placeholder ledger.** The srt backend records, per process, every deny path srt will mount over that was absent when it wrapped a command, and the exact file or directory (device and inode) that then appeared there. The ledger lives at `<configDir>/sandbox/placeholders/<pid>.json`, cannot be written by sandboxed commands, and is deleted when the process exits.
2. **Stale sweep.** At each backend initialize, ledgers left by dead processes are swept. A path is removed only when it is still the very placeholder recorded (same device and inode, still empty, and for a file still read-only), checked again immediately before removal, and no process of this user has a live mount there.
3. **Staging guard.** `gitlinkSafeAdd`, through which every broad nax staging path runs, never stages an untracked placeholder-shaped file at a known placeholder path.
4. **git excludes.** On Linux, `.git/info/exclude` gains root-anchored entries for the shell startup names, so they do not show as untracked while a background command keeps them on disk.

## Motivation

Issue #2986 (body rewritten 2026-11-24 with the verified cause). Facts, from main `7d3664d08` and the srt sources (0.0.77 pinned, 0.0.83 compared):

- srt resolves its mandatory write-deny names (`DANGEROUS_FILES`: `.gitconfig`, `.gitmodules`, `.bashrc`, `.bash_profile`, `.zshrc`, `.zprofile`, `.profile`, `.ripgreprc`, `.mcp.json`, and `getDangerousDirectories()`: `.vscode`, `.idea`, `.claude/commands`, `.claude/agents`) against `process.cwd()`, not against the command's cwd. nax's own literal `denyWrite` entries (`.claude/settings.json`, `.claude/settings.local.json`, project-state entries, git guard files) are applied the same way. For a deny path that is absent and whose deepest existing ancestor is inside an allowed write root, bwrap creates a placeholder at the first missing path component: an empty regular file with mode 0444 and one link (leaf), or an empty directory (intermediate component).
- srt removes placeholders only when its single process-wide `activeSandboxCount` returns to zero, and on `process.on("exit")`. The deferral is a security requirement: unlinking the host path while another bwrap runs detaches that sandbox's bind mount, and the deny stops applying inside it. So placeholders must stay on disk while any sandboxed command, such as a background `Bash` task, still runs.
- A clean `nax chat` exit already removes them: `runShell` handles SIGTERM and SIGHUP, and `registerChatCommand` calls `process.exit()`, which runs srt's force cleanup. They stay behind only when the process dies without an `exit` event (SIGKILL, OOM, power loss).
- srt 0.0.77 re-adopts a leftover placeholder **file** in the same cwd (`isStaleBwrapMountPoint`), but never a leftover **directory**. srt 0.0.83 removed that re-adoption: its README says such leftovers are never removed, because they cannot be told from a user's own empty file or from another live process's mount point. nax can tell them apart, because it can record the exact inode it saw appear.
- Auto-commit (`packages/nax/src/utils/git.ts`), `nax finish` (`packages/nax/src/finish/commit.ts`), the review tree snapshot and the agent `GitCommit` tool stage through `gitlinkSafeAdd`, mostly with `-A`. A placeholder present at that moment would be committed as an empty `.mcp.json`, `.gitmodules`, `.claude/settings.json` or `.bashrc`. (Some nax paths stage explicit nax-owned files directly; those never name a placeholder.)

The user's safety requirement (2026-11-24): cleanup must never remove a user's own file. Example: a session started in the home directory (after `nax trust add ~ --force`) has the user's real `~/.bashrc` and `~/.profile` in scope. Those exist before any wrap, so they are never recorded; only a path the ledger saw absent, then saw become a placeholder, can ever be removed.

## Design

### Integration

Symbols this feature only reads:

- `packages/nax-agent/src/sandbox/types.ts`: `SandboxBackend` (`wrap(req)`, `commandFinished()`, `reset()`), `SandboxWrapRequest` (`command`, `shell`, `policy`, `cwd`, `commandId`), `SandboxPolicy` (`writeRoots`, `denyWrite`, `denyRead`, `network`).
- `packages/nax-agent/src/sandbox/launcher.ts`: `runWrapped` calls `backend.wrap(...)`, runs the argv, and calls `backend.commandFinished()` in a `finally`; a `wrap` that throws gets no `commandFinished`.
- `packages/nax-agent/src/internal/process-alive.ts`: `isProcessAlive(pid): boolean` (only ESRCH reports dead).
- `packages/nax-agent/src/internal/path-file-lock.ts`: `withPathFileLock(targetPath, operation, { timeoutMs })`.
- `packages/nax-agent/src/internal/git-exec.ts`: `gitWithTimeout(args, cwd, timeoutMs)`, the hardened git spawn.
- `packages/nax-agent/src/infra/credentials-config.ts`: `credentialsConfig().configDir()` returns the nax global config directory (`~/.nax` or `NAX_GLOBAL_CONFIG_DIR`); it throws `CREDENTIALS_NOT_CONFIGURED` when the host never called `configureCredentials`.
- `packages/nax-agent/src/sandbox/policy-inputs.ts`: `resolveGitLayout(root): Promise<GitLayout>` (`none` / `main { gitDir }` / `worktree { gitDir, commonDir }`).
- `packages/nax-agent/src/internal/realpath.ts`: `realOrRaw(path)` (the realpath of the nearest existing ancestor, used by `buildSandboxPolicy` for every `denyWrite` entry).
- `packages/nax/src/cli/chat.ts`: `runShell` (SIGTERM/SIGHUP handlers) and `registerChatCommand` (`deps.exit()`). Unchanged: they already reach `process.exit()`.

Symbols this feature changes. Each **Baseline** exists only to locate the code. Implement the **Target**, never the baseline.

- `createSrtBackend(network)` and `_srtBackendDeps` (`packages/nax-agent/src/sandbox/srt-backend.ts`).
  - Baseline: `_srtBackendDeps` is `{ load, platform, mkdir }`. `initialize()` loads srt and calls `SandboxManager.initialize`; `wrap` returns `(await wrapWithSandboxArgv(...)).argv`; `commandFinished` calls `cleanupAfterCommand()`; `reset` calls `SandboxManager.reset()` and clears `initialized`.
  - Target: `_srtBackendDeps` gains `cwd: () => process.cwd()` (US-003), `sweep: sweepStalePlaceholders` (US-004) and `ensureExcludes: ensurePlaceholderExcludes` (US-007). When `platform()` is `"linux"`:
    - `initialize` runs `deps.sweep()` and then `deps.ensureExcludes(deps.cwd())` before `SandboxManager.initialize`; an error from either is caught and logged at warn, never thrown. They run once per initialize (again after a `reset`).
    - Each `wrap` obtains the process ledger with `placeholderLedger()` (US-002); when it is defined, `wrap` calls `ledger.recordAbsent(candidatePaths(deps.cwd(), req.policy))` and `ledger.observe()` before `wrapWithSandboxArgv`. `commandFinished` calls `ledger.observe()` BEFORE `cleanupAfterCommand()` and `ledger.prune()` after it. `reset` calls `ledger.prune()` after `SandboxManager.reset()`.
    - On every other platform none of this runs and srt is called exactly as before.
- `gitlinkSafeAdd(git, cwd, opts)` (`packages/nax-agent/src/internal/git-add.ts`).
  - Baseline: lists gitlinks with `ls-files --stage -z -- <pathspecs>`, then runs `git add <flags> -- <pathspecs> <gitlink excludes>`.
  - Target: also appends `:(exclude,literal)<rel>` for every path in `stagingPlaceholderPaths(cwd, trackedPaths)` (US-006), where `trackedPaths` are the paths the existing `ls-files --stage` call printed.
- `SandboxPolicyInput` and `buildSandboxPolicy` (`packages/nax-agent/src/sandbox/policy-builder.ts`).
  - Target: `SandboxPolicyInput` gains `readonly placeholderLedgerDir?: string`; when present, `buildSandboxPolicy` appends it to `denyWrite` (after `trustStoreFile`). `resolveSessionSandbox`'s `policyFor` (`packages/nax-agent/src/coding-tools/coding-tool-sandbox.ts`) passes `placeholderLedgerDirForPolicy()` (US-005) when it returns a path.
- `RESERVED_PROJECT_NAMES` (`packages/nax/src/config/paths/index.ts`).
  - Baseline: `global`, `profiles`, `runs`, `events`, `plugins`, `acp`, `memory`, `hooks`, `_archive`.
  - Target: the same nine followed by `sandbox`, with a doc-comment line `sandbox — packages/nax-agent/src/sandbox/placeholder-ledger.ts (placeholder ledgers)`.

### Test seams

`packages/nax-agent/src/sandbox/placeholder-deps.ts` (US-001) exports one deps object, `_placeholderDeps`, which every new module reads. It is not re-exported from `src/internal.ts`.

| Field | Default | Shape |
|:---|:---|:---|
| `platform()` | `process.platform` | `NodeJS.Platform` |
| `ledgerDir()` | `join(credentialsConfig().configDir(), "sandbox", "placeholders")` | `string`; may throw |
| `bootId()` | trimmed `/proc/sys/kernel/random/boot_id` | `string`; may throw |
| `startTicks(pid)` | `parseStartTicks(<content of /proc/<pid>/stat>)` | `number`; throws with errno `ENOENT` when the process is gone, other codes when unreadable |
| `isProcessAlive(pid)` | `isProcessAlive` from `internal/process-alive.ts` | `boolean` |
| `uid()` | `process.getuid()` | `number` |
| `homedir()` | `os.homedir()` | `string` |
| `proc` | real `/proc` reader | `{ listPids(): number[]; realUid(pid): number; mountNs(pid): string; mountinfo(pid): string }`. `realUid` is the first number of the `Uid:` line of `/proc/<pid>/status` (readable for every process, unlike `/proc/<pid>` ownership, which turns to root for non-dumpable processes). `mountNs` is the target of the `/proc/<pid>/ns/mnt` link. Each method may throw with an errno `code`. |
| `remove(path, kind)` | `unlinkSync` for `file`, `rmdirSync` for `dir` | `void`; may throw |
| `onExit(listener)` | `process.once("exit", listener)` | `void` |
| `lockTimeoutMs` | `2000` | `number` |

`_resetPlaceholderLedgerForTests()` (US-002) clears the process ledger singleton and its exit-hook flag, following `_resetSandboxRegistryForTests` in `registry.ts`.

nax-agent is a Node library and these modules use synchronous `node:fs` calls, as `sandbox/session-tmp.ts` does, because `commandFinished` and the exit listener are synchronous.

### Placeholder shape and identity (US-001)

A path is **placeholder-shaped** when `lstat` (no symlink follow) shows either:

- a regular file with `size === 0`, `(mode & 0o222) === 0` and `nlink === 1`, or
- a directory with zero entries.

Its **identity** (`placeholderIdentity(path)`) is `{ kind: "file" | "dir", dev, ino }` from that `lstat`, or `undefined` when the path is not placeholder-shaped. A recorded entry **matches** the disk when `placeholderIdentity(path)` returns the same `kind`, `dev` and `ino`.

### Candidate paths (US-001)

`candidatePaths(cwd, policy)` (`packages/nax-agent/src/sandbox/placeholder-paths.ts`) returns absolute, normalised paths, deduplicated, in this order:

1. `SRT_MANDATORY_DENY_FILES` resolved against `cwd`, then `SRT_MANDATORY_DENY_DIRS` resolved against `cwd`. Both are new constants in `packages/nax-agent/src/sandbox/defaults.ts`, mirroring srt's `DANGEROUS_FILES` (`.gitconfig`, `.gitmodules`, `.bashrc`, `.bash_profile`, `.zshrc`, `.zprofile`, `.profile`, `.ripgreprc`, `.mcp.json`) and `getDangerousDirectories()` (`.vscode`, `.idea`, `.claude/commands`, `.claude/agents`).
2. `join(cwd, ".git/hooks")` and `join(cwd, ".git/config")` when `<cwd>/.git` is a directory.
3. Every `policy.denyWrite` entry.

Each candidate is mapped to its **first missing component**: walk up from the path while the parent does not exist, so `<cwd>/.claude/commands` maps to `<cwd>/.claude` when `.claude` is absent. A candidate whose path already exists is dropped. A candidate is also dropped unless its deepest existing ancestor is equal to or inside one of `policy.writeRoots` (srt makes no placeholder elsewhere).

### `/proc` parsers (US-001)

- `parseStartTicks(statLine): number` returns field 22 of a `/proc/<pid>/stat` line, counting fields after the LAST `)` (the command name may hold spaces and parentheses). It throws when the line has no `)` or too few fields.
- `parseMountPoints(mountinfoText): string[]` returns field 5 of every non-empty line, with the octal escapes `\040` (space), `\011` (tab), `\012` (newline) and `\134` (backslash) decoded.

### Ledger file (US-002)

`<ledgerDir>/<pid>.json`, mode 0600, written atomically (a temp file named `.<pid>.tmp` in the same directory, then rename). The ledger directory is created (`mkdir -p`, mode 0700) when the ledger is first created, before any `wrapWithSandboxArgv` call of the process, so it exists before any policy denies it.

```json
{
  "version": 1,
  "pid": 41237,
  "bootId": "8c1e2a4f-0d6b-4a57-9d0e-3f1b7c2a9e10",
  "startTicks": 1234567,
  "entries": [
    { "path": "/home/u/repo/.zprofile", "kind": "file", "dev": 2049, "ino": 3801123 },
    { "path": "/home/u/repo/.claude" }
  ]
}
```

An entry without `kind`/`dev`/`ino` is **pending**: the path was absent at wrap time and no placeholder has been seen there yet.

`readLedgerFile(path): LedgerFile | undefined` (`placeholder-ledger.ts`) is the only reader and performs the **trust check**: the file must be a regular file (by `lstat`) owned by `_placeholderDeps.uid()` with `(mode & 0o077) === 0`; its content must parse as JSON with `version` 1; its base name must equal `<pid>.json` for its `pid`; and every entry `path` must be absolute and equal to its normalised form. On any failure it returns `undefined` and logs one warn naming the file.

`placeholderLedger(): PlaceholderLedger | undefined` returns the process-wide ledger, created on first call. It returns `undefined` (and logs one debug `sandbox: placeholder ledger disabled`) when `_placeholderDeps.platform()` is not `"linux"`, or `ledgerDir()`, `bootId()` or `startTicks(process.pid)` throws. On creation it registers, through `_placeholderDeps.onExit`, one listener that deletes the process's ledger file and ignores any error. All methods are synchronous:

- `recordAbsent(paths)`: adds each path not already in the ledger as a pending entry; writes the file only when it changed.
- `observe()`: for each pending entry whose path now has a `placeholderIdentity`, records that identity. Writes only when changed.
- `prune()`: drops every entry with an identity that no longer matches the disk. Pending entries are kept (another wrapped command may still be starting). Deletes the file when no entries remain; otherwise writes it when changed.

### Ledger directory deny (US-005)

`placeholderLedgerDirForPolicy(): string | undefined` (`placeholder-ledger.ts`) returns `ledgerDir()` only when `placeholderLedger()` is defined, so the deny exists exactly when a ledger does (never on darwin, never when the ledger is disabled).

### Stale sweep (US-004)

`sweepStalePlaceholders()` (`packages/nax-agent/src/sandbox/placeholder-sweep.ts`):

1. List the `*.json` files in `_placeholderDeps.ledgerDir()`. Skip the current process's own file. A missing directory means nothing to do.
2. Read each with `readLedgerFile`; an `undefined` result leaves the file untouched and removes nothing from it.
3. **Owner check**: the owner is **dead** when `bootId` differs from `bootId()`, or `isProcessAlive(pid)` is false, or `startTicks(pid)` throws `ENOENT`, or returns a value different from the recorded one. When `startTicks(pid)` throws with any other code, the owner is treated as alive. A live owner's ledger is left untouched.
4. For a dead owner, under `withPathFileLock(<ledger path>, ..., { timeoutMs: lockTimeoutMs })`, re-read the file with `readLedgerFile` (skip it if it is gone: another sweep handled it). Every entry with an identity that matches the disk is a removal candidate. Pending entries, entries that no longer match, and entries whose fields are malformed are dropped without touching the disk.
5. If there is at least one candidate, read the **live mount set** once with `readLiveMountPoints()`: for every pid in `proc.listPids()` with `proc.realUid(pid) === uid()`, read `proc.mountNs(pid)`; for each namespace not yet seen, read `proc.mountinfo(pid)` and add `parseMountPoints(...)`. A method throwing `ENOENT` or `ESRCH` (the process left) skips that pid. Any other throw makes the set **unknown**.
6. When the set is unknown, nothing is removed and the ledger is left unchanged. Otherwise, for each candidate whose path (compared after `realOrRaw` of its parent) is not in the set: re-check `placeholderIdentity(path)` against the entry immediately before calling `remove(path, kind)`, in the same synchronous step; a mismatch keeps the file and drops the entry. A candidate in the set, or whose `remove` throws, is kept.
7. The ledger file is deleted when no entries are kept, otherwise rewritten with the kept entries.
8. One `info` log `sandbox: removed stale placeholders` with `{ removed: [paths] }` when anything was removed.

### Staging guard (US-006)

`stagingPlaceholderPaths(cwd, trackedPaths): string[]` (`packages/nax-agent/src/sandbox/staging-placeholders.ts`, synchronous) returns paths relative to `cwd`:

- Sources: `SRT_MANDATORY_DENY_FILES` resolved against `cwd`, plus every entry `path` (pending or identified) of every ledger in `_placeholderDeps.ledgerDir()` that `readLedgerFile` accepts, when the path is inside `cwd`, whatever the owner's state.
- Filter: `placeholderIdentity(path)` is a `file` identity, and the path relative to `cwd` is not in `trackedPaths`.
- When `ledgerDir()` throws or the directory cannot be read, only the mandatory names are used. When `lstat` of a source path fails, that path is not returned.

### git excludes (US-007)

`ensurePlaceholderExcludes(cwd)` (`packages/nax-agent/src/sandbox/placeholder-excludes.ts`):

- Skipped when `cwd` is `_placeholderDeps.homedir()` or `/`, when `resolveGitLayout(cwd)` is `none`, or when `gitWithTimeout(["rev-parse", "--show-toplevel"], cwd, ...)` does not print `cwd` (compared after `realOrRaw`): root-anchored patterns only match at the top level.
- The info dir is `<commonDir>/info` for a worktree and `<gitDir>/info` otherwise; it is created when absent. Under `withPathFileLock(<info>/exclude)`, it appends any of `PLACEHOLDER_EXCLUDE_ENTRIES` not already present as an exact trimmed line, under the header `# nax: Linux sandbox mount points`. A file whose content does not end with a newline gets one first. Existing lines are never rewritten or reordered.
- `PLACEHOLDER_EXCLUDE_ENTRIES` = `/.bashrc`, `/.bash_profile`, `/.profile`, `/.zshrc`, `/.zprofile`, `/.ripgreprc`. `.gitconfig`, `.gitmodules`, `.mcp.json`, `.vscode`, `.idea` and `.claude` are deliberately absent, because repositories commit them.

### Failure Handling

| Case | Behaviour |
|:---|:---|
| `ledgerDir()`, `bootId()` or `startTicks(process.pid)` throws | `placeholderLedger()` returns `undefined`; no ledger, no deny, wrapping proceeds; one `debug` log `sandbox: placeholder ledger disabled`. |
| Writing the ledger file fails | One `warn` log per process, `sandbox: placeholder ledger write failed`; the command still runs; later writes are still attempted. |
| Deleting the ledger file at exit fails | Ignored; the next sweep finds a dead owner. |
| A ledger fails the trust check | `readLedgerFile` returns `undefined` with one warn naming the file; the sweep leaves it untouched and the staging guard ignores it. |
| `startTicks(pid)` of another owner throws other than `ENOENT` | That owner is treated as alive; its ledger is left untouched. |
| The ledger was deleted between listing and locking | Skipped silently. |
| The live mount set is unknown | Nothing removed; the ledger left unchanged; one `debug` log. |
| The identity re-check right before removal fails | The file is kept and its entry dropped. |
| `remove(path, kind)` throws | The entry is kept in the ledger; the sweep continues with the next entry. |
| The ledger lock is not taken within `lockTimeoutMs` | That ledger is skipped for this sweep. |
| The sweep or the excludes step throws | Caught in `initialize`, logged at warn, and `wrap` proceeds. |
| `ensurePlaceholderExcludes` cannot write the exclude file | One `warn` log `sandbox: could not update git excludes`; nothing else changes. |
| The staging guard cannot read the ledger directory | Only the mandatory names are excluded. |

## Out of Scope

- Placeholders stay visible on disk while any sandboxed command is running (for example a background `Bash` task); removing them then would detach a live sandbox's deny. Changing the deny mechanism (for example an overlay) is srt's, not nax's.
- macOS and every non-Linux platform: seatbelt creates no placeholders; no ledger, sweep, deny or exclude runs there.
- Upgrading `@anthropic-ai/sandbox-runtime` from 0.0.77 is not part of this feature.
- The issue's earlier hypothesis that chat leaves placeholders on SIGHUP was disproved (`nax chat` already exits through `process.exit()` on SIGTERM and SIGHUP), so no signal-handling change is made.
- A process that resolves srt's mandatory denies from a directory other than the project root (for example `nax chat -d <dir>` launched elsewhere) is not changed here.
- Reserving `sandbox` makes an existing project config named `sandbox` fail validation, like the other reserved names; such a project must be renamed.
- Confirming the real `/proc` readers against a live bwrap sandbox (for example that `realUid` and `mountinfo` of a sandboxed process are readable) is a manual Linux live check after merge, not an AC.
- US-002 only: a process killed after a wrap and before any later `observe()` leaves only pending entries; those placeholders are not removed by the sweep (srt 0.0.77's own re-adoption still removes leftover files in the same cwd).
- US-002 only: an empty directory that a user or editor creates at a recorded pending name, between a wrap and the next `observe()`, is indistinguishable from a bwrap placeholder directory; if the process is then killed and the directory is still empty at the next sweep, it is removed. Accepted: it is an empty directory at a protected name.
- US-004 only: mounts held by processes of other users are not inspected; only processes whose real uid is the current uid are read.
- US-004 only: the live mount set is read once per sweep; a sandbox of another process that starts between that read and the `remove` call is not re-checked.
- US-004 only: the sweep runs at backend initialize; it does not run on a timer or at `nax` startup without a sandboxed command.
- US-006 only: placeholder directories are not handled by the staging guard, because git never stages an empty directory.
- US-007 only: entries written to `.git/info/exclude` are never removed by nax; in a repository that tracks dotfiles, a new untracked `.zshrc` or `.profile` at the root is hidden from `git status` once the entries exist.

## Stories

Eight stories, one capability (cleaning up the Linux sandbox placeholders of #2986); the split keeps each story under the 24-AC gate.

**US-001: placeholder paths, shape, identity, `/proc` parsers and test seams.** Workdir: `packages/nax-agent`. No dependencies. Adds `SRT_MANDATORY_DENY_FILES` / `SRT_MANDATORY_DENY_DIRS`, `_placeholderDeps` (`placeholder-deps.ts`), and `candidatePaths`, `isPlaceholderShaped`, `placeholderIdentity`, `parseStartTicks`, `parseMountPoints` (`placeholder-paths.ts`).

**US-002: the process ledger.** Workdir: `packages/nax-agent`. Depends on US-001. Adds `readLedgerFile` (with the trust check), `placeholderLedger()` and `PlaceholderLedger` (`recordAbsent`, `observe`, `prune`, exit listener), and `_resetPlaceholderLedgerForTests`.

**US-003: srt backend records placeholders on Linux.** Workdir: `packages/nax-agent`. Depends on US-002. Wires the ledger into `createSrtBackend` (`wrap`, `commandFinished`, `reset`) and adds `_srtBackendDeps.cwd`.

**US-004: sweep ledgers of dead processes.** Workdir: `packages/nax-agent`. Depends on US-003. Adds `sweepStalePlaceholders` and `readLiveMountPoints` and runs the sweep from `initialize` on Linux.

**US-005: deny the ledger directory to sandboxed commands.** Workdir: `packages/nax-agent`. Depends on US-002. Adds `placeholderLedgerDirForPolicy` and `SandboxPolicyInput.placeholderLedgerDir`.

**US-006: staging never adds a placeholder.** Workdir: `packages/nax-agent`. Depends on US-002. Adds `stagingPlaceholderPaths` and makes `gitlinkSafeAdd` exclude its result.

**US-007: root-anchored git excludes for the shell startup names.** Workdir: `packages/nax-agent`. Depends on US-004. Adds `ensurePlaceholderExcludes` and runs it from `initialize` on Linux after the sweep.

**US-008: reserve the `sandbox` project name.** Workdir: `packages/nax`. No dependencies. Adds `sandbox` to `RESERVED_PROJECT_NAMES`.

### Context Files

**US-001**
- `packages/nax-agent/src/sandbox/defaults.ts` — existing sandbox constants
- `packages/nax-agent/src/sandbox/session-tmp.ts` — precedent for synchronous `node:fs` and a `_deps` seam in the sandbox module
- `packages/nax-agent/src/internal/process-alive.ts` — `isProcessAlive`
- `packages/nax-agent/src/infra/credentials-config.ts` — `credentialsConfig().configDir()`

**US-002**
- `packages/nax-agent/src/sandbox/placeholder-deps.ts` — created by US-001; `_placeholderDeps`
- `packages/nax-agent/src/sandbox/placeholder-paths.ts` — created by US-001; `placeholderIdentity`
- `packages/nax-agent/src/sandbox/registry.ts` — `_resetSandboxRegistryForTests`, the process-singleton precedent

**US-003**
- `packages/nax-agent/src/sandbox/srt-backend.ts` — `createSrtBackend`, `_srtBackendDeps`, `wrap`, `commandFinished`, `reset`
- `packages/nax-agent/src/sandbox/placeholder-ledger.ts` — created by US-002; `placeholderLedger`
- `packages/nax-agent/src/sandbox/launcher.ts` — `runWrapped`: `wrap`, run, `commandFinished` in `finally`
- `packages/nax-agent/test/unit/sandbox/srt-backend.test.ts` — backend test patterns and the `_srtBackendDeps` seam

**US-004**
- `packages/nax-agent/src/sandbox/placeholder-ledger.ts` — created by US-002; `readLedgerFile`, ledger format
- `packages/nax-agent/src/sandbox/placeholder-paths.ts` — created by US-001; `placeholderIdentity`, `parseMountPoints`
- `packages/nax-agent/src/internal/path-file-lock.ts` — `withPathFileLock`
- `packages/nax-agent/src/sandbox/srt-backend.ts` — `initialize`

**US-005**
- `packages/nax-agent/src/sandbox/policy-builder.ts` — `SandboxPolicyInput`, `buildSandboxPolicy` `denyWrite`
- `packages/nax-agent/src/coding-tools/coding-tool-sandbox.ts` — `policyFor`, where `trustStoreFile` is passed
- `packages/nax-agent/test/unit/coding-tools/coding-tool-sandbox.test.ts` — `realOrRaw` assertions on `denyWrite`

**US-006**
- `packages/nax-agent/src/internal/git-add.ts` — `gitlinkSafeAdd`, `parseGitlinks`
- `packages/nax-agent/src/sandbox/placeholder-ledger.ts` — created by US-002; `readLedgerFile`
- `packages/nax-agent/test/unit/internal/git-add.test.ts` — existing `gitlinkSafeAdd` tests
- `packages/nax-agent/src/tools/git-commit.ts` — the `GitCommit` caller of `gitlinkSafeAdd`
- `packages/nax-agent/test/unit/tools/git-commit.test.ts` — `testProtectedPaths` and the real-repository GitCommit fixtures

**US-007**
- `packages/nax-agent/src/sandbox/policy-inputs.ts` — `resolveGitLayout`
- `packages/nax-agent/src/internal/git-exec.ts` — `gitWithTimeout`
- `packages/nax-agent/src/sandbox/srt-backend.ts` — `initialize`
- `packages/nax-agent/test/preload.ts` — the suite-wide preload
- `packages/nax/src/worktree/manager.ts` — `ensureGitExcludes`, the precedent for an additive, line-exact, locked `info/exclude` update

**US-008**
- `packages/nax/src/config/paths/index.ts` — `RESERVED_PROJECT_NAMES` and its doc comment

### Creates

**US-001**
- `packages/nax-agent/src/sandbox/placeholder-deps.ts` — `_placeholderDeps` with the real `/proc`, credentials and fs defaults
- `packages/nax-agent/src/sandbox/placeholder-paths.ts` — `candidatePaths`, `isPlaceholderShaped`, `placeholderIdentity`, `parseStartTicks`, `parseMountPoints`
- `packages/nax-agent/test/unit/sandbox/placeholder-paths.test.ts` — candidate, shape, identity and parser tests
- `packages/nax-agent/test/unit/sandbox/placeholder-deps.test.ts` — Linux-only checks of the real defaults

**US-002**
- `packages/nax-agent/src/sandbox/placeholder-ledger.ts` — `readLedgerFile`, `placeholderLedger`, `PlaceholderLedger`, `_resetPlaceholderLedgerForTests`
- `packages/nax-agent/test/unit/sandbox/placeholder-ledger.test.ts` — trust check and ledger tests over a temp directory

**US-003**

None. The backend tests are added to `packages/nax-agent/test/unit/sandbox/srt-backend.test.ts`.

**US-004**
- `packages/nax-agent/src/sandbox/placeholder-sweep.ts` — `sweepStalePlaceholders`, `readLiveMountPoints`
- `packages/nax-agent/test/unit/sandbox/placeholder-sweep.test.ts` — sweep tests with an injected `proc` reader

**US-005**

None. The tests are added to the existing policy-builder and coding-tool-sandbox test files.

**US-006**
- `packages/nax-agent/src/sandbox/staging-placeholders.ts` — `stagingPlaceholderPaths`
- `packages/nax-agent/test/unit/sandbox/staging-placeholders.test.ts` — staging guard tests over a temp git repository

**US-007**
- `packages/nax-agent/src/sandbox/placeholder-excludes.ts` — `ensurePlaceholderExcludes`, `PLACEHOLDER_EXCLUDE_ENTRIES`
- `packages/nax-agent/test/unit/sandbox/placeholder-excludes.test.ts` — exclude tests over a temp git repository

**US-008**

None. The existing reserved-name test is changed (see Modifies).

### Modifies

**US-001**
- `packages/nax-agent/src/sandbox/defaults.ts` — gains `SRT_MANDATORY_DENY_FILES` and `SRT_MANDATORY_DENY_DIRS`.

**US-002**

None. Only new files.

**US-003**
- `packages/nax-agent/src/sandbox/srt-backend.ts` — `createSrtBackend` gains the Linux-only ledger wiring and `_srtBackendDeps.cwd`; on darwin and other platforms `wrap`, `commandFinished` and `reset` call srt exactly as before.

**US-004**
- `packages/nax-agent/src/sandbox/srt-backend.ts` — `_srtBackendDeps` gains `sweep`; `initialize` runs it once on Linux before `SandboxManager.initialize` and catches any error from it.

**US-005**
- `packages/nax-agent/src/sandbox/policy-builder.ts` — `SandboxPolicyInput` gains optional `placeholderLedgerDir`, appended to `denyWrite` when present; a policy built without it is unchanged.
- `packages/nax-agent/src/coding-tools/coding-tool-sandbox.ts` — `policyFor` passes `placeholderLedgerDir` when `placeholderLedgerDirForPolicy()` returns a path.

**US-006**
- `packages/nax-agent/src/internal/git-add.ts` — `gitlinkSafeAdd` appends `:(exclude,literal)` pathspecs for `stagingPlaceholderPaths(cwd, trackedPaths)` after the gitlink excludes; an argv for a tree with no placeholder is unchanged, because the list is empty there.

**US-007**
- `packages/nax-agent/src/sandbox/srt-backend.ts` — `_srtBackendDeps` gains `ensureExcludes`; `initialize` runs it once on Linux after the sweep and catches any error from it.
- `packages/nax-agent/test/preload.ts` — replaces `_srtBackendDeps.ensureExcludes` with a no-op for the whole suite, so the existing srt-backend and allow-local-binding tests on Linux never write the real checkout's git exclude file; the US-007 tests restore the real function themselves.

**US-008**
- `packages/nax/src/config/paths/index.ts` — `RESERVED_PROJECT_NAMES` gains `sandbox` after `_archive`, and the doc-comment list gains its owner line.
- `packages/nax/test/unit/config/reserved-project-names.test.ts` — the "lists every global directory nax owns, in order" assertion becomes the ten names `global`, `profiles`, `runs`, `events`, `plugins`, `acp`, `memory`, `hooks`, `_archive`, `sandbox`.

### Seams

- US-003 drives `placeholderLedger()` (US-002) through `createSrtBackend(...).wrap` and `commandFinished`.
- US-004 and US-007 drive their functions through the first `createSrtBackend(...).wrap` of a fresh backend.
- US-005 drives `placeholderLedgerDirForPolicy()` through `resolveSessionSandbox`.
- US-006 drives `stagingPlaceholderPaths` through `gitlinkSafeAdd` and the `GitCommit` tool.
- Every consumer AC runs against real files in a temp directory, so the wiring is proven by behaviour, not by a stub.

## Acceptance Criteria

Fixture conventions, unless an AC says otherwise: a real temp directory as `cwd`; `_placeholderDeps.platform` returns `"linux"`, `ledgerDir` returns a temp ledger directory, `bootId` returns `"boot-A"`, `startTicks` returns `100` for `process.pid`, `uid` returns the test process's uid, and `onExit` records its listener instead of registering it; `_resetPlaceholderLedgerForTests()` runs before each test. For backend ACs, `_srtBackendDeps.platform` returns `"linux"`, `_srtBackendDeps.cwd` returns `cwd`, `_srtBackendDeps.load` returns a stub srt module whose `wrapWithSandboxArgv` resolves `{ argv: ["true"], env: {} }`, and the request's `policy.writeRoots` is `[cwd]`. "Make a placeholder at P" means: create an empty file at P and `chmod` it to 0444, or create an empty directory. These tests run on every platform, because every platform fact is injected, except where an AC says Linux only.

### US-001

1. [unit] `candidatePaths(cwd, policy)` with an empty `cwd`, `writeRoots: [cwd]` and an empty `denyWrite` returns the nine `SRT_MANDATORY_DENY_FILES` names joined to `cwd`, then `join(cwd, ".vscode")`, `join(cwd, ".idea")` and `join(cwd, ".claude")`.
2. [unit] `candidatePaths` lists `join(cwd, ".claude")` once although both `.claude/commands` and `.claude/agents` map to it.
3. [unit] With a real `<cwd>/.bashrc` present, `candidatePaths` omits `join(cwd, ".bashrc")`.
4. [unit] `candidatePaths` returns an empty array when no entry of `policy.writeRoots` is `cwd` or an ancestor of `cwd`.
5. [unit] With `<cwd>/.git` a directory without `hooks`, `candidatePaths` includes `join(cwd, ".git/hooks")`.
6. [unit] With `<cwd>/.git` a file, `candidatePaths` includes neither `join(cwd, ".git/hooks")` nor `join(cwd, ".git/config")`.
7. [unit] With `<cwd>/.claude` absent, a `policy.denyWrite` entry `<cwd>/.claude/settings.json` maps to `<cwd>/.claude`.
8. [unit] With `<cwd>/.claude` present as a directory, the same entry is returned as `<cwd>/.claude/settings.json`.
9. [unit] `isPlaceholderShaped` returns true for an empty 0444 file and for an empty directory.
10. [unit] `isPlaceholderShaped` returns false for each of: an empty 0644 file, a 0444 file holding one byte, a 0444 empty file with a second hard link, a symlink to a 0444 empty file, and a directory holding one entry.
11. [unit] `placeholderIdentity` of an empty 0444 file returns `kind` `file` with that file's `dev` and `ino`, and returns `undefined` for an empty 0644 file.
12. [unit] `parseStartTicks` of the line `4242 (a) b (c) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 777 19` returns `777`.
13. [unit] `parseStartTicks` throws for a line with no `)`.
14. [unit] `parseMountPoints` of a two-line mountinfo sample whose fifth fields are `/` and `/home/u/my\040repo/.zprofile` returns `["/", "/home/u/my repo/.zprofile"]`.
15. [unit] `parseMountPoints` decodes `\134` to a backslash and `\011` to a tab.
16. [unit] `SRT_MANDATORY_DENY_FILES` equals srt 0.0.77's `DANGEROUS_FILES`, imported from `@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js`.
17. [unit] `SRT_MANDATORY_DENY_DIRS` equals srt 0.0.77's `getDangerousDirectories()` result.
18. [integration] Linux only (skipped elsewhere): the real `_placeholderDeps.startTicks(process.pid)` returns a positive integer, `_placeholderDeps.proc.realUid(process.pid)` equals `process.getuid()`, and `parseMountPoints(_placeholderDeps.proc.mountinfo(process.pid))` includes `/`.

### US-002

1. [unit] `readLedgerFile` returns the parsed ledger for a mode 0600 file named `999.json` holding `version` 1, `pid` 999 and one absolute entry.
2. [unit] `readLedgerFile` returns `undefined` for that file with mode 0644.
3. [unit] `readLedgerFile` returns `undefined` when `_placeholderDeps.uid` returns a uid other than the file's owner.
4. [unit] `readLedgerFile` returns `undefined` for a file holding invalid JSON.
5. [unit] `readLedgerFile` returns `undefined` for a file holding `version` 2.
6. [unit] `readLedgerFile` returns `undefined` for the valid content saved as `123.json`.
7. [unit] `readLedgerFile` returns `undefined` for an entry path `rel/.zprofile`, and for an entry path `/a/../b`.
8. [unit] After `placeholderLedger()!.recordAbsent([join(cwd, ".zprofile")])`, the file `<ledgerDir>/<process.pid>.json` has mode 0600 and holds `pid` `process.pid`, `bootId` `"boot-A"`, `startTicks` `100` and the entry `{ path: join(cwd, ".zprofile") }`.
9. [unit] `observe()` after making a placeholder at a pending path records that placeholder's `kind`, `dev` and `ino` in the file.
10. [unit] A pending path that the user then creates as a 0644 file with content stays pending through `observe()`.
11. [unit] `prune()` drops an identified entry whose file was deleted, and deletes the ledger file when that was its last entry.
12. [unit] `prune()` keeps a pending entry whose path does not exist.
13. [unit] `placeholderLedger()` returns the same instance on two calls, and `onExit` records exactly one listener.
14. [unit] Calling the recorded exit listener deletes `<ledgerDir>/<process.pid>.json` even while its entries still match placeholders on disk.
15. [unit] Calling the recorded exit listener when the ledger file is already gone does not throw.
16. [unit] `placeholderLedger()` returns `undefined` when `_placeholderDeps.platform` returns `"darwin"`.
17. [unit] `placeholderLedger()` returns `undefined` when `ledgerDir()` throws an error with code `CREDENTIALS_NOT_CONFIGURED`.
18. [unit] `placeholderLedger()` returns `undefined` when `bootId()` throws.
19. [unit] `placeholderLedger()` returns `undefined` when `startTicks(process.pid)` throws.
20. [unit] When `<ledgerDir>/<process.pid>.json` is an existing directory, two `recordAbsent` calls with new paths do not throw and `sandbox: placeholder ledger write failed` is logged at warn exactly once.

### US-003

1. [integration] After `backend.wrap(req)` in an empty `cwd`, `<ledgerDir>/<process.pid>.json` holds a pending entry `{ path: join(cwd, ".zprofile") }`.
2. [integration] After `wrap`, making a placeholder at `<cwd>/.zprofile`, then `backend.commandFinished()`, the ledger entry for `<cwd>/.zprofile` carries that file's `dev` and `ino`.
3. [integration] After `wrap`, making a placeholder at `<cwd>/.zprofile`, then `backend.commandFinished()`, the ledger file content that the stub `cleanupAfterCommand` reads when it is called already holds that identity.
4. [integration] After `wrap`, a placeholder at `<cwd>/.zprofile`, a first `commandFinished()`, deleting `<cwd>/.zprofile` (as srt's cleanup would) and a second `commandFinished()`, the ledger has no entry for `<cwd>/.zprofile`.
5. [integration] A `<cwd>/.bashrc` with content that existed before the first `wrap` never appears in the ledger through two `wrap` and two `commandFinished` calls.
6. [integration] After a placeholder was identified, `backend.reset()` with the placeholder deleted leaves no entry for it in the ledger.
7. [integration] With `_srtBackendDeps.platform` and `_placeholderDeps.platform` returning `"darwin"`, `wrap` and `commandFinished` create no ledger directory or file, and the stub's `wrapWithSandboxArgv` and `cleanupAfterCommand` are each called once per call.
8. [integration] When `ledgerDir()` throws an error with code `CREDENTIALS_NOT_CONFIGURED`, `wrap` resolves `["true"]` and no file exists under the temp directory's ledger path.

### US-004

The "stale fixture": a placeholder made at `<cwd>/.zprofile`; a ledger file `<ledgerDir>/999999.json` with mode 0600, `version` 1, `pid` 999999, `bootId` `"boot-A"`, `startTicks` 5, and one entry with the `kind`, `dev` and `ino` of that placeholder; `_placeholderDeps.isProcessAlive` reports 999999 dead; `_placeholderDeps.proc` lists one pid whose `realUid` is `uid()` and whose mountinfo has no mount at `<cwd>/.zprofile`. Each AC triggers the sweep through the first `backend.wrap(req)` of a fresh backend.

1. [integration] In the stale fixture, the first `wrap` removes `<cwd>/.zprofile`.
2. [integration] In the stale fixture, the first `wrap` deletes `<ledgerDir>/999999.json`.
3. [integration] In the stale fixture where the placeholder was replaced before the sweep by a new 0444 empty file created under a temp name and renamed over the path (the test asserts the two inodes differ), the first `wrap` leaves the file on disk.
4. [integration] In the stale fixture with one byte written to `<cwd>/.zprofile`, the first `wrap` leaves the file on disk with its content.
5. [integration] In the stale fixture where `proc.mountinfo` also replaces `<cwd>/.zprofile` with a new 0444 empty file (a different inode) when it is called, the first `wrap` leaves that new file on disk (the identity re-check right before removal).
6. [integration] In the stale fixture with the injected mountinfo listing a mount at `<cwd>/.zprofile`, the first `wrap` leaves the file on disk and keeps that entry in `<ledgerDir>/999999.json`.
7. [integration] In the stale fixture with `proc.mountinfo` throwing an error with code `EACCES` for the one pid, the first `wrap` removes nothing and leaves `<ledgerDir>/999999.json` byte for byte unchanged.
8. [integration] In the stale fixture with a second listed pid whose `proc.mountinfo` throws code `ENOENT`, the first `wrap` still removes `<cwd>/.zprofile`.
9. [integration] In the stale fixture with a second listed pid whose `realUid` is another uid, `proc.mountinfo` is never called for that pid.
10. [integration] In the stale fixture with two same-uid pids sharing one `mountNs` value, `proc.mountinfo` is called once.
11. [integration] In the stale fixture with `isProcessAlive(999999)` true and `startTicks(999999)` returning 5, the first `wrap` leaves the file and the ledger untouched.
12. [integration] In the stale fixture with `isProcessAlive(999999)` true and `startTicks(999999)` returning 6 (pid reuse), the first `wrap` removes the placeholder.
13. [integration] In the stale fixture with `isProcessAlive(999999)` true and `startTicks(999999)` throwing code `EACCES`, the first `wrap` leaves the file and the ledger untouched.
14. [integration] In the stale fixture with the ledger's `bootId` `"boot-B"`, the first `wrap` removes the placeholder although `isProcessAlive` reports 999999 alive.
15. [integration] An empty placeholder directory recorded with `kind` `dir` is removed by the sweep; the same directory holding one file is left on disk.
16. [integration] A pending entry (no `ino`) in a dead owner's ledger is dropped and its placeholder-shaped path is left on disk.
17. [integration] The stale fixture's ledger with mode 0644 is left on disk byte for byte and `<cwd>/.zprofile` is left on disk.
18. [integration] In the stale fixture with `_placeholderDeps.remove` throwing, `<cwd>/.zprofile` stays and its entry stays in the rewritten ledger.
19. [integration] In the stale fixture with the ledger's lock file held by the test and `lockTimeoutMs` 50, the first `wrap` resolves and leaves the file and the ledger untouched.
20. [integration] In the stale fixture where the ledger file is deleted by `isProcessAlive` when it is called (a concurrent sweep), the first `wrap` resolves and `<cwd>/.zprofile` stays.
21. [integration] With `_srtBackendDeps.sweep` replaced by a function that throws, `wrap` resolves `["true"]`.
22. [integration] With `_srtBackendDeps.sweep` replaced by a counting function, three `wrap` calls on one backend call it once, and a `wrap` after `backend.reset()` calls it a second time.

### US-005

1. [integration] `resolveSessionSandbox` with an available sandbox, `_placeholderDeps.platform` returning `"linux"` and `ledgerDir` returning a temp path `D` yields a policy whose `denyWrite` includes `realOrRaw(D)`.
2. [integration] With `_placeholderDeps.platform` returning `"darwin"`, the policy's `denyWrite` omits `realOrRaw(D)`.
3. [integration] With `bootId()` throwing (ledger disabled), the policy is still built and its `denyWrite` omits `realOrRaw(D)`.
4. [unit] `buildSandboxPolicy` with `placeholderLedgerDir` absent returns the same `denyWrite` as before the change for the existing policy-builder fixture.

### US-006

1. [integration] In a temp git repository with an untracked 0444 empty `.mcp.json` at the root and an untracked `notes.md`, `gitlinkSafeAdd(gitWithTimeout, root, { flags: ["-A"] })` stages `notes.md` and leaves `.mcp.json` untracked.
2. [integration] The same repository with `.mcp.json` as an untracked 0644 empty file stages `.mcp.json`.
3. [integration] An untracked 0444 empty `.claude/settings.json` that is the path of an entry in a trusted ledger in the injected ledger directory is left untracked by `gitlinkSafeAdd` with `-A`.
4. [integration] An untracked 0444 empty `docs/x` listed only in a ledger file with mode 0644 is staged.
5. [integration] An untracked 0444 empty `docs/readme.txt` that is neither a mandatory-deny name nor a ledger entry is staged.
6. [integration] A committed `.gitmodules` that is changed to a 0444 empty file is staged as that change.
7. [integration] With `_placeholderDeps.ledgerDir` throwing, `gitlinkSafeAdd` with `-A` still leaves an untracked 0444 empty `.mcp.json` untracked and stages `notes.md`.
8. [unit] `stagingPlaceholderPaths(cwd, [])` returns `[".mcp.json"]` for a directory holding only a 0444 empty `.mcp.json`, and `[]` for an empty directory.
9. [integration] The `GitCommit` tool run with `protectedPaths` from `testProtectedPaths` in a temp repository, asked to commit `.mcp.json` (a 0444 empty untracked file) and `notes.md`, creates a commit that holds `notes.md` and not `.mcp.json`.

### US-007

Each AC triggers the step through the first `backend.wrap(req)` of a fresh backend, with `_srtBackendDeps.ensureExcludes` set to the real `ensurePlaceholderExcludes` and `_placeholderDeps.homedir` returning a separate temp directory.

1. [integration] With `cwd` a fresh temp git repository, `.git/info/exclude` ends with the header `# nax: Linux sandbox mount points` followed by `/.bashrc`, `/.bash_profile`, `/.profile`, `/.zshrc`, `/.zprofile`, `/.ripgreprc`, one per line.
2. [integration] An exclude file holding user lines and `/.profile`, with no trailing newline, keeps every existing line unchanged and in order, and gains the header and the five missing entries on new lines.
3. [integration] A second backend in the same repository leaves the exclude file byte for byte unchanged.
4. [integration] In a linked worktree, the entries are written to `<commonDir>/info/exclude`.
5. [integration] With `cwd` a subdirectory of the repository, the exclude file is not changed.
6. [integration] With `cwd` equal to the injected home directory, the exclude file is not changed.
7. [integration] With `cwd` a directory that is not a git repository, no exclude file is created.
8. [integration] After the step, `git status --porcelain` lists no untracked `.bashrc` at the root, and still lists untracked `.gitconfig` and `.mcp.json` files created there.
9. [integration] When `.git/info/exclude` is a directory, `wrap` resolves `["true"]` and `sandbox: could not update git excludes` is logged at warn.
10. [integration] With `_srtBackendDeps.ensureExcludes` replaced by a function that throws, `wrap` resolves `["true"]`.

### US-008

1. [unit] `RESERVED_PROJECT_NAMES` equals the ten names `global`, `profiles`, `runs`, `events`, `plugins`, `acp`, `memory`, `hooks`, `_archive`, `sandbox`, in that order.
2. [unit] Validating a project config with `name` `sandbox` fails with the same reserved-name error the other reserved names produce.
