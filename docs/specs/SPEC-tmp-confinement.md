# SPEC: Temp-Write Confinement

## Summary

Agent shell commands still write to literal `/tmp` paths even though #2269 gave every session a
`$TMPDIR` and told the agent to use it: the sandbox allows writes to all of `/tmp`, so nothing
enforces the instruction. This feature moves the per-run temp root to `/tmp/nax/<runId>` (with a
per-user fallback), confines sandboxed temp writes to that run's root by default (opt-out flag
`execution.sandbox.filesystem.allowSharedTmp`), tells the agent to use `.nax/scratchpad/` as its
temp folder, and keeps the command-safety `tmpWrite` signal from counting nax's own temp tree.

## Motivation

- #2269 (US-004) set `TMPDIR`/`TMP`/`TEMP` for every launcher-driven Bash/Exec command to
  `/tmp/nax-<runId>/<session>` and added the prompt sentence "Put temporary files there (`$TMPDIR`
  or `mktemp`), not in `/tmp` directly." It only redirects tools that honour `TMPDIR`; a command
  that names `/tmp/foo` still writes there.
- The sandbox grants the whole of `/tmp`: `defaultTempRoots()` returns `[os.tmpdir(), "/tmp"]`
  (`src/sandbox/policy-inputs.ts:70`) and `buildSandboxPolicy` adds every temp root to
  `writeRoots` (`src/sandbox/policy-builder.ts:120`).
- Command-safety shadow rows measure the habit: before #2269, 4.9% of agent Bash commands named a
  literal `/tmp` path; in runs on a build that includes #2269 the rate is 0.4-2.4%, with one run
  at 35 such commands. Halved, not gone. These writes are also the largest class of
  `outside_project` positives in the P5 command-safety labels, which blocks a useful A-mode
  threshold.
- The scratchpad prompt section describes `.nax/scratchpad/` only as a place for notes and snippet
  scripts. It is the one temp location that every tool can reach (shell, Read/Write/Edit, and the
  Scratchpad tools), but the prompt never calls it a temp folder.
- A flat `/tmp/nax-<runId>` root is hard to find and list. A single `/tmp/nax/` parent is easier to
  inspect, but a shared parent created by one OS user is not writable by another, so it needs a
  fallback.

## Design

### Integration

The decision is recorded in `docs/adr/ADR-030-bash-approval-modes.md`, amendment 2026-09-28 ("temp writes are confined to the run's temp root"), committed with this spec.


Symbols read (unchanged):

- `ensureTmpDir` (`src/sandbox/launcher.ts:73-84`) creates `tmpDir` with `mkdir -p` before each run; `createCommandLauncher` (`src/sandbox/launcher.ts:157`) exports it via `tmpEnvPrefix` / `withTmpEnv`.
- `buildSandboxPolicy(input: SandboxPolicyInput)` (`src/sandbox/policy-builder.ts:115`) — puts `input.tempRoots` into `writeRoots`, plus `SRT_MACOS_TMPDIR` (`/tmp/claude`) on darwin. Every path goes through `literal()` → `realOrRaw()` (`src/utils/realpath.ts`), so on macOS `/tmp/...` roots appear as `/private/tmp/...`; tests compare against `realOrRaw(...)`, as `test/unit/sandbox/policy-builder.test.ts:202` does.
- `denialHintLine(writeRoots)` is called by the launcher when a wrapped command fails with a likely sandbox denial (`src/sandbox/launcher.ts:140`).
- `NAX_SCRATCHPAD_ENTRY` (`src/tools/nax-owned-writes.ts:23`) — the Write/Edit guard already exempts `.nax/scratchpad/` (`:286`).

Symbols changed. The baseline locates the code only; implement the target.

- `resolveDispatchLauncher(options, declared, sessionName)` — `src/agents/coding-tool-support-resolve.ts:364-380`.
  - Baseline: spreads `tmpDir: sessionTmpDir(options.runId, sessionName)` into `resolveSessionSandbox` when `options.runId` is defined.
  - Target: also spreads `runTmpRoot: runTmpRoot(options.runId)` under the same condition, importing `runTmpRoot` from `@/sandbox` beside `sessionTmpDir`.

- `_sessionTmpDeps` — new in `src/sandbox/session-tmp.ts`, re-exported from `src/sandbox/index.ts`. Shape: `{ lstat(path): { isDirectory(): boolean; isSymbolicLink(): boolean }, access(path, mode): void, uid(): number }`, synchronous and throw-based like `lstatSync` / `accessSync`; production values are `lstatSync`, `accessSync` and `process.getuid`.
- `runTmpRoot(runId: string): string` — `src/sandbox/session-tmp.ts`.
  - Baseline: returns `/tmp/nax-<sanitized runId>`.
  - Target: returns `<parent>/<sanitized runId>`, where `<parent>` is `/tmp/nax` when that path is absent or is a real directory writable by the current user, and `/tmp/nax-<uid>` otherwise (see Approach).
- `sessionTmpDir(runId, sessionName)` — same file. The target is `runTmpRoot(runId)/<sanitized sessionName>`, with sanitization unchanged.
- `detectTmpWrite(command, cwd?)` — `src/command-safety/tmp-write.ts`.
  - Baseline: excludes paths under `<root>/nax-*`.
  - Target: also excludes paths under `<root>/nax/`, for both `/tmp` and `/private/tmp`.
- `defaultTempRoots(): string[]` (`src/sandbox/policy-inputs.ts:70`). The target keeps the function as the shared-tmp roots and adds `runTempRoots(opts: { runTmpRoot: string; tmpdir: string }): string[]` next to it.
- `_sessionSandboxDeps` / `resolveSessionSandbox(args)` — `src/agents/coding-tool-sandbox.ts:28-106`.
  - Baseline: `tempRoots: _sessionSandboxDeps.tempRoots()`.
  - Target:
    - `args` gains `readonly runTmpRoot?: string`, supplied by `resolveDispatchLauncher` as `runTmpRoot(options.runId)` whenever it supplies `tmpDir`;
    - `_sessionSandboxDeps` gains `mkdir`, `tmpdir` (`() => os.tmpdir()`) and `runTempRoots`, so `resolveSessionSandbox` makes no un-injected external read;
    - temp roots are chosen as described under Approach.
- `SandboxState` `available` variant — `src/sandbox/types.ts:48`. The target adds an OPTIONAL `readonly sharedTmp?: boolean`: absent means shared temp roots (today's behaviour), so every existing construction of the variant stays valid. `resolveSessionSandbox` sets `sharedTmp: false` only when it confines, and omits the field otherwise.
- `SandboxConfigSchema.filesystem` — `src/config/schemas-sandbox.ts:26`. The target adds `allowSharedTmp: z.boolean().default(false)`.
- `sandboxSentence(network)` — `src/sandbox/messages.ts`. The target is `sandboxSentence(network, sharedTmp = true)`; single-argument calls keep today's text. Callers `src/tools/bash.ts:188,203` and `src/tools/run-command.ts:263` pass `state.sharedTmp !== false`.
- `denialHintLine(writeRoots)` — same file. The target appends the temp-folder sentence.
- `buildScratchpadSection()` — `src/prompts/sections/scratchpad.ts`. The target replaces the `$TMPDIR` paragraph.

### Approach

**Temp root layout (US-001).** `runTmpRoot` resolves the parent on every call. That's a few
synchronous `lstat`/`access` calls through an injectable `_sessionTmpDeps`
(`{ lstat, access, uid }`), and there is no cache.

1. `lstat("/tmp/nax")` fails with ENOENT: the parent is `/tmp/nax`. `mkdir -p` in the launcher
   creates it with the default mode.
2. `lstat` reports a directory (not a symlink), and `access(W_OK | X_OK)` succeeds: the parent is
   `/tmp/nax`.
3. Otherwise the parent is `/tmp/nax-<uid>`, where `<uid>` is `process.getuid()`. The otherwise
   case covers: a symlink, a regular file, `access` failing, or `lstat` failing with anything
   other than ENOENT.

The wipe removes `runTmpRoot(runId)` only, never the parent, so concurrent runs under
`/tmp/nax/` are untouched.

**Temp roots (US-002).** In `resolveSessionSandbox`:

- `config.filesystem.allowSharedTmp` is true, or `args.runTmpRoot` is undefined: the temp roots
  are `_sessionSandboxDeps.tempRoots()` (today's call, still `defaultTempRoots` in production, so
  `test/integration/sandbox/sandbox-live.test.ts` keeps its stub) and the state omits `sharedTmp`.
- Otherwise, create `args.tmpDir` with `_sessionSandboxDeps.mkdir` before building the policy.
  - Creation fails: log `warn` (stage `sandbox`) and use `_sessionSandboxDeps.tempRoots()`; the
    state omits `sharedTmp`.
  - Creation succeeds: use `_sessionSandboxDeps.runTempRoots({ runTmpRoot, tmpdir: _sessionSandboxDeps.tmpdir() })`,
    and the state carries `sharedTmp: false`.

`runTempRoots` returns `[runTmpRoot]`, prefixed by `tmpdir` only when `tmpdir` is neither `/tmp`,
`/private/tmp`, nor under either. On Linux, `os.tmpdir()` is usually `/tmp`, and keeping it would
re-grant all of `/tmp`. The darwin `/tmp/claude` root that srt needs stays, because
`buildSandboxPolicy` adds it independently of `tempRoots`.

**Agent-facing text (US-003).** Exact strings:

- `sandboxSentence(network, false)` replaces "the system temp directories" with "this run's temp
  directory ($TMPDIR)". `sandboxSentence(network, true)` returns today's text unchanged.
- `denialHintLine(writeRoots)` appends: ` For temporary files use $TMPDIR or .nax/scratchpad/, not /tmp.`
- `buildScratchpadSection()` replaces the paragraph beginning "Shell commands run with `$TMPDIR`"
  with:

```
Use the scratchpad as your temp folder. Files you make while working — command output you want to
re-read, generated inputs, one-off scripts — go under `.nax/scratchpad/`: the shell, the file tools
and the scratchpad tools can all reach it, and it is cleared after the run. For throwaway files a
command creates on its own, shell commands run with `$TMPDIR` set to this run's temp directory; use
`$TMPDIR` or `mktemp` for those. Never write to `/tmp` directly: in the sandbox, `/tmp` outside
`$TMPDIR` is not writable and the write fails.
```

### Failure Handling

| Condition | Behaviour |
|:--|:--|
| `/tmp/nax` exists but is not a writable real directory (another user's, a symlink, a file) | `runTmpRoot` uses `/tmp/nax-<uid>`; no error |
| `lstat("/tmp/nax")` fails with anything other than ENOENT | same fallback |
| The session temp dir cannot be created in `resolveSessionSandbox` | `warn` log, shared temp roots, `sharedTmp` omitted — the session is never left with a TMPDIR the sandbox cannot write |
| `allowSharedTmp: true` | today's roots, `sharedTmp` omitted |
| No `runId` (no `tmpDir`) | today's roots, `sharedTmp` omitted |
| An agent command writes to literal `/tmp/x` under a confined policy | the sandbox denies it; the launcher's existing denial path appends `denialHintLine`, which now names `$TMPDIR` and `.nax/scratchpad/` |

## Out of Scope

- Rewriting agent commands to replace `/tmp` paths — nax never edits agent-authored commands.
- The unsandboxed path (sandbox disabled or unavailable): writes to `/tmp` stay allowed there; only the prompt text applies.
- Windows and any platform without `process.getuid` — `/tmp` paths already assume POSIX.
- A `/tmp/nax-*` or `/tmp/nax/*` sweep of stale directories from crashed runs — the wipe stays run-scoped.
- The command-safety question set, model, labels and the `outside_project` rule regexes — the rule scorer never matches `/tmp`, so no rule change is needed.
- Making `/tmp/nax` world-writable (mode 1777) — the per-user fallback covers multi-user hosts instead.

## Stories

**US-001 — Per-run temp root at `/tmp/nax/<runId>` with a per-user fallback**

Change `runTmpRoot`/`sessionTmpDir` to the new layout with the fallback, keep the wipe run-scoped,
and teach `detectTmpWrite` the `/tmp/nax/` subtree. No dependency.

**US-002 — The sandbox confines temp writes to the run's temp root**

Add `allowSharedTmp`, `runTempRoots` and the optional `SandboxState.sharedTmp`; choose the temp
roots in `resolveSessionSandbox` from the run root, with fail-open to shared roots; thread
`runTmpRoot` from `resolveDispatchLauncher`. Depends on US-001 (`runTmpRoot` layout).

**US-003 — Agent-facing text names `$TMPDIR` and the scratchpad as the temp folder**

Update `sandboxSentence`, `denialHintLine` and `buildScratchpadSection`; pass `state.sharedTmp` at
the tool-description call sites. Depends on US-002 (`SandboxState.sharedTmp`).

### Dependencies

- **US-001**: no dependencies.
- **US-002**: US-001.
- **US-003**: US-002.

### Context Files

**US-001**

- `src/sandbox/session-tmp.ts`
- `src/execution/lifecycle/run-tmp-wipe.ts`
- `src/command-safety/tmp-write.ts`
- `src/sandbox/index.ts`

**US-002**

- `src/agents/coding-tool-sandbox.ts`
- `src/agents/coding-tool-support-resolve.ts`
- `src/sandbox/policy-inputs.ts`
- `src/sandbox/types.ts`
- `src/config/schemas-sandbox.ts`

**US-003**

- `src/sandbox/messages.ts`
- `src/tools/bash.ts`
- `src/tools/run-command.ts`
- `src/prompts/sections/scratchpad.ts`

### Creates

None. Every change is to a file listed above.

### Modifies

**US-001**

- `test/unit/sandbox/session-tmp.test.ts` — the tests at lines 20-36 assert flat per-run roots of the form /tmp/nax-run-1/US-001-implementer, and the test at lines 43-45 asserts the session directory is a flat child of a /tmp/nax- prefix. The new layout necessarily breaks both. Replace them with the invariant: with the stubbed deps reporting /tmp/nax absent, the session directory for run "run-1" and session "a/b" is /tmp/nax/run-1/a_b, and sanitization is unchanged.
- `test/unit/execution/lifecycle/run-tmp-wipe.test.ts` — line 27 expects the removed path to be /tmp/nax-r1. Replace it with the invariant: the removed path equals runTmpRoot("r1") under the stubbed layout (/tmp/nax/r1), and the /tmp/nax parent is never removed.
- `test/unit/agents/coding-tool-support-session-tmp.test.ts` — line 21 fixes the run root at /tmp/nax-r1, and line 75 expects TMPDIR to be /tmp/nax-r1/US-001-implementer. Replace them with the invariant: TMPDIR equals sessionTmpDir("r1", "US-001-implementer") under the stubbed layout, and the afterEach cleanup at line 29 removes runTmpRoot("r1") so the test still clears the directory it creates.

**US-002**

None. `sharedTmp` is optional and omitted unless the session is confined, so the existing deep-equality assertion on the available state (coding-tool-sandbox.test.ts line 95, no run temp root) and the 19 other constructions of that variant stay valid; the shared-roots branch keeps calling the stubbed temp-roots dependency, so the live sandbox suite is unaffected.

**US-003**

- `test/unit/sandbox/messages.test.ts` — line 24 asserts the denial hint ends with "writable roots: /a, /b." and the new appended temp-folder sentence necessarily breaks it. Replace it with the invariant: the hint contains "writable roots: /a, /b." and ends with "For temporary files use $TMPDIR or .nax/scratchpad/, not /tmp."
- `test/unit/prompts/sections/scratchpad.test.ts` — lines 61 and 66 pin the old sentence "Put temporary files there ($TMPDIR or mktemp), not in /tmp directly." Replace them with the invariant: the section includes the "Use the scratchpad as your temp folder." paragraph exactly once.
- `test/unit/prompts/__snapshots__/rectifier-builder.test.ts.snap` — the snapshots embed the old scratchpad paragraph. Regenerate them so they embed the new paragraph; no other snapshot text changes.
- `test/unit/prompts/__snapshots__/review-builder.test.ts.snap` — the snapshots embed the old scratchpad paragraph. Regenerate them so they embed the new paragraph; no other snapshot text changes.
- `test/unit/prompts/builders/__snapshots__/rectifier-builder-helpers.test.ts.snap` — the snapshots embed the old scratchpad paragraph. Regenerate them so they embed the new paragraph; no other snapshot text changes.

### Seams

- `runTmpRoot` (US-001) is consumed by US-002's `resolveDispatchLauncher` change. US-002's dispatch-setup AC triggers `resolveDispatchLauncher` with a `runId` and asserts the policy the stubbed backend receives contains `runTmpRoot(runId)`.
- `SandboxState.sharedTmp` (US-002) is consumed by US-003's tool descriptions. US-003's Bash-description AC builds the Bash tool description from an available state with `sharedTmp: false` and asserts the confined wording.
- `runTempRoots` (US-002) is exported and consumed in the same story. Its four direct `runTempRoots` ACs exercise it directly, and the dispatch-setup AC through the production path.

## Acceptance Criteria

### US-001

1. `[unit]` With `_sessionTmpDeps.lstat` failing with ENOENT for `/tmp/nax`, `runTmpRoot("run-1")` returns `/tmp/nax/run-1`.
2. `[unit]` With `_sessionTmpDeps.lstat` reporting `/tmp/nax` as a directory and `_sessionTmpDeps.access` succeeding, `runTmpRoot("run-1")` returns `/tmp/nax/run-1`.
3. `[unit]` With `/tmp/nax` a directory and `_sessionTmpDeps.access` throwing EACCES, and `_sessionTmpDeps.uid` returning 501, `runTmpRoot("run-1")` returns `/tmp/nax-501/run-1`.
4. `[unit]` With `_sessionTmpDeps.lstat` reporting `/tmp/nax` as a symbolic link, `_sessionTmpDeps.access` succeeding and `_sessionTmpDeps.uid` returning 501, `runTmpRoot("run-1")` returns `/tmp/nax-501/run-1`.
5. `[unit]` With `_sessionTmpDeps.lstat` reporting `/tmp/nax` as a regular file and `_sessionTmpDeps.uid` returning 501, `runTmpRoot("run-1")` returns `/tmp/nax-501/run-1`.
6. `[unit]` With `_sessionTmpDeps.lstat` failing with EACCES and `_sessionTmpDeps.uid` returning 501, `runTmpRoot("run-1")` returns `/tmp/nax-501/run-1`.
7. `[unit]` With `/tmp/nax` absent, `sessionTmpDir("run-1", "US 001/impl")` returns `/tmp/nax/run-1/US_001_impl`, and `runTmpRoot("../x")` returns `/tmp/nax/.._x` with no `/` after the parent.
8. `[unit]` With `/tmp/nax` absent, `wipeRunTmp("r1")` calls `_runTmpWipeDeps.remove` exactly once, with `/tmp/nax/r1`.
9. `[unit]` `detectTmpWrite("echo x > /tmp/nax/r1/US-001-implementer/a.txt")` returns false.
10. `[unit]` `detectTmpWrite("touch /private/tmp/nax/r1/a")` returns false.
11. `[unit]` `detectTmpWrite("echo x > /tmp/nax-501/r1/a.txt")` returns false.
12. `[unit]` `detectTmpWrite("echo x > /tmp/naxfoo/a.txt")` returns true.
13. `[unit]` `detectTmpWrite("echo x > /tmp/other/a.txt")` returns true.

### US-002

1. `[unit]` Parsing `SandboxConfigSchema` from `{}` yields `filesystem.allowSharedTmp === false`.
2. `[unit]` Parsing `SandboxConfigSchema` from `{ filesystem: { allowSharedTmp: true } }` yields `filesystem.allowSharedTmp === true`, with `allowWrite` still `[]`.
3. `[unit]` `runTempRoots({ runTmpRoot: "/tmp/nax/r1", tmpdir: "/var/folders/x/T" })` returns `["/var/folders/x/T", "/tmp/nax/r1"]`.
4. `[unit]` `runTempRoots({ runTmpRoot: "/tmp/nax/r1", tmpdir: "/tmp" })` returns `["/tmp/nax/r1"]`.
5. `[unit]` `runTempRoots({ runTmpRoot: "/tmp/nax/r1", tmpdir: "/tmp/user-tmp" })` returns `["/tmp/nax/r1"]`.
6. `[unit]` `runTempRoots({ runTmpRoot: "/tmp/nax/r1", tmpdir: "/private/tmp" })` returns `["/tmp/nax/r1"]`.
7. `[unit]` The confined-session setup: `resolveSessionSandbox` is given an enabled sandbox config, an available stubbed backend and probe, `_sessionSandboxDeps.tmpdir` returning `/var/folders/x/T`, `runTmpRoot: "/tmp/nax/r1"` and `tmpDir: "/tmp/nax/r1/s"`. It returns a launcher whose `state` is `{ kind: "available", backend: "srt", network: "open", sharedTmp: false }`, and it calls `_sessionSandboxDeps.mkdir` with `/tmp/nax/r1/s` before building the policy.
8. `[unit]` In the confined-session setup, running a shell command through the returned launcher passes a policy to the stubbed backend's `wrap` whose `writeRoots` include `realOrRaw("/tmp/nax/r1")` and exclude `realOrRaw("/tmp")`.
9. `[integration]` The dispatch setup: `resolveDispatchLauncher` is called with `runId: "r1"`, a coding-tool root, Bash declared, an enabled sandbox config, a stubbed available backend and probe, and `/tmp/nax` absent. A shell command run through the returned launcher reaches the stubbed backend's `wrap` with a policy whose `writeRoots` include `realOrRaw(runTmpRoot("r1"))` and exclude `realOrRaw("/tmp")`.
10. `[unit]` In the confined-session setup with `filesystem.allowSharedTmp: true` and `_sessionSandboxDeps.tempRoots` returning `["/tmp"]`, the policy passed to `wrap` has `writeRoots` including `realOrRaw("/tmp")`, and the state has no `sharedTmp` field.
11. `[unit]` In the confined-session setup with `runTmpRoot` and `tmpDir` omitted and `_sessionSandboxDeps.tempRoots` returning `["/tmp"]`, the policy passed to `wrap` has `writeRoots` including `realOrRaw("/tmp")`, and the state has no `sharedTmp` field.
12. `[unit]` In the confined-session setup with `_sessionSandboxDeps.mkdir` rejecting and `_sessionSandboxDeps.tempRoots` returning `["/tmp"]`, the policy passed to `wrap` has `writeRoots` including `realOrRaw("/tmp")`, the state has no `sharedTmp` field, and one `warn` is logged with stage `sandbox`.
13. `[unit]` In the confined-session setup on platform `darwin`, the policy passed to `wrap` has `writeRoots` including `realOrRaw("/tmp/claude")`.
14. `[integration]` The live srt setup: when the srt backend is available on the host (skipped otherwise, following `test/integration/sandbox/sandbox-live.test.ts`), a launcher resolved with `runTmpRoot` and `tmpDir` under a unique run id runs `echo x > "$TMPDIR/ok.txt"` with exit code 0 and the file present afterwards.
15. `[integration]` In the live srt setup, the launcher runs a command writing a file directly under `/tmp` (a name unique to the test, outside `/tmp/nax/`) with a non-zero exit code, and that file is absent afterwards.

### US-003

1. `[unit]` `sandboxSentence("open", false)` returns a sentence that names `this run's temp directory ($TMPDIR)` as a writable root in place of `the system temp directories`.
2. `[unit]` `sandboxSentence("open", true)` and `sandboxSentence("open")` both equal the pre-change sentence for network `"open"`.
3. `[unit]` `denialHintLine(["/repo"])` ends with `For temporary files use $TMPDIR or .nax/scratchpad/, not /tmp.`
4. `[unit]` The Bash tool description built for a launcher whose state is `{ kind: "available", backend: "srt", network: "open", sharedTmp: false }` contains `this run's temp directory ($TMPDIR)`.
5. `[unit]` The `run-command` tool description built for an available state with `sharedTmp: false` contains `this run's temp directory ($TMPDIR)`.
6. `[unit]` `buildScratchpadSection()` contains `Use the scratchpad as your temp folder.` exactly once.
7. `[unit]` `buildScratchpadSection()` contains `Never write to \`/tmp\` directly` and `$TMPDIR`.
8. `[unit]` `buildScratchpadSection()` returns text without the retired sentence beginning `Put temporary files there`.
