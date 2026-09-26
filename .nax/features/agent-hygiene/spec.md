# SPEC: Agent hygiene — reachable spill paths, tighter raw-Bash screen, NBF restore diagnostics, per-run TMPDIR

## Summary

Five independent fixes for agent side effects and harness blind spots found in the 2026-09-24..26
tool-audit and the `fix-review` run. The truncation marker names a spill path the session can actually
open (#2259). The raw Bash screen refuses whole-filesystem `find` and, when the sandbox wraps the
command, stops refusing read-only commands that merely name a feature `prd.json` (#2259, #2258). The
non-blocking fix (NBF) classifies `.nax/` control-path changes separately from source size and logs
which paths and commits a restore discarded (#2261). Agent Bash and Exec commands get a per-session
`TMPDIR` under `/tmp/nax-<runId>/`, wiped when the run ends, and the command-safety shadow records
Bash commands that write to a literal `/tmp` path (#2262).

## Motivation

Verified on `main` @ `08e3d8f36`; re-verified after rebase onto `5fca1321e` (fix-review #2267/#2268, tracked acceptance tests #2266 — only US-003 is affected, see its section):

- **Spill marker (#2259).** `markerShapes` (`src/tools/spill.ts`) renders
  `... [truncated: full output at spill/<x>.txt; ...]`. That path is relative to `.nax/scratchpad`
  and resolves only through `ScratchpadRead`; the marker does not say so. A test-writer ran
  `cat "spill/Bash-call_00_<id>.txt"` from the repo root, failed, then ran `find / -name ...`, which
  burned the full 300 s Bash timeout. Both callers of `applyModelTruncationPolicy` run with the repo
  root as the working directory (`storyExecRoot`, `src/operations/call-run-options.ts`), and neither
  `Read` nor Bash is refused under `.nax/scratchpad/`.
- **`find /` (#2259).** A second test-writer ran `find / -name "approvals.ts" -path "*/cli/*"` and also
  hit the 300 s timeout (`BASH_TIMEOUT_MS`, `src/tools/bash.ts`).
- **prd.json reads (#2258).** 22 of 22 Bash denials in 314 sessions came from
  `naxOwnedBashRefusal(..., "prd", ..., "names")` in `screenRawBashCommand`
  (`src/tools/policy-bash-raw.ts`); 17 were read-only (`git diff <prd>`, `git log <prd>`,
  `cat <prd> | head`). All ran sandbox-wrapped. Since #2263, `buildSandboxPolicy`
  (`src/sandbox/policy-builder.ts`) denies writes to the whole of `.nax/features/`, so under the sandbox
  a prd write fails at the kernel however it is spelled. The screen cannot tell: `commandBranch`
  (`src/tools/policy-command-branch.ts`) receives only `rawBashRefusal`, set when the sandbox is
  unavailable.
- **NBF restore diagnostics (#2261).** `createMeasureSourceDiff` (`src/execution/non-blocking-fix.ts`)
  keeps counts only. A pass that fixed all 8 findings with 5 files / ~200 lines tripped
  `sourceDiffCap` at 211 files because an agent ran `rm -rf .nax`; the log said only
  `{"fileCount":211,"sourceLineCount":198}`. `restoreToSnapshot` hard-resets without recording the
  commits it discarded; recovering them took the reflog.
- **`/tmp` side effects (#2262).** Agents wrote scratch files to literal `/tmp` through Bash (4, 25 and
  33 commands in three sessions of one run). A stray `/tmp/tsconfig.json` survived an NBF restore and
  turned a later story's full-suite gate red. The Bash tool passes no environment overlay
  (`src/tools/bash.ts`), and on macOS srt forces `TMPDIR=/tmp/claude` and discards the child
  environment (`src/sandbox/srt-backend.ts`), so today every `mktemp` / `os.tmpdir()` lands in a shared
  directory nax never cleans. The command-safety shadow's `outside_project` rule family
  (`src/command-safety/rule-scorer.ts`) does not match `/tmp`, so the frequency is unmeasured.

## Design

### Integration

Read-only symbols (verified, used as-is):

- `SCRATCHPAD_DIR = ".nax/scratchpad"` (`src/tools/scratchpad.ts`); `SPILL_DIR = "spill"` and
  `spillRelativePath(toolName, callId)` (`src/tools/spill.ts`).
- `nativeSessionScratchpadRoots` / `nativeTranscriptDirs` (`src/agents/native/session/session.ts`).
- `lexBashCommand` (`src/permissions/bash-lex.ts`): `BashToken { text; opaque }`, where `opaque` marks
  `$`-expansion; a `refused` result means the screen allows the command unscreened.
- `naxOwnedKind(rel): "prd" | "queue" | undefined` (`src/tools/nax-owned-writes.ts`).
- `captureSnapshotRef` / `rollbackToRef` / `SnapshotRef` (`src/tdd/rollback.ts`);
  `hardenedGitArgv` / `gitSpawnEnv` (`src/utils/git-env.ts`).
- `buildLedgerSessionName({ storyId, sessionRole, featureName })` (`src/agents/coding-tool-support.ts`),
  e.g. `"US-001-implementer"`.
- `wipeScratchpad` (`src/execution/lifecycle/scratchpad-wipe.ts`) and its call in `cleanupRun`
  (`src/execution/lifecycle/run-cleanup.ts`), the pattern the run-tmp wipe mirrors.
- `scoreRules` and `RULE_SET_VERSION` (`src/command-safety/rule-scorer.ts`) — unchanged.

Mutated symbols. The baseline exists only to locate the code; it is never the interface to implement.

- `ModelTruncationOptions` (`src/tools/spill.ts`)
  - Baseline: `{ toolName; callId; root?; maxBytes? }`
  - Target: adds `spillPathStyle?: "root-relative" | "absolute"` (default `"root-relative"`).
- `RawScreenArgs` (`src/tools/policy-bash-raw.ts`)
  - Baseline: `{ tool; command; initialPath; resolvePath; root }`
  - Target: adds `sandboxWrapped?: boolean` (default `false`).
- `naxOwnedBashRefusal` (`src/tools/nax-owned-writes.ts`)
  - Baseline: `(tool, kind, hit, verb) => string`
  - Target: `(tool, kind, hit, verb, opts?: { sandboxWrapped?: boolean }) => string`.
- `BashCommandBranchArgs` (`src/tools/policy-command-branch.ts`) and `ToolPolicyOptions`
  (`src/tools/policy.ts`)
  - Baseline: carry `rawBashRefusal?: string`
  - Target: also carry `sandboxWrapped?: boolean`, passed through to `screenRawBashCommand`.
- `SourceDiffMetrics` (`src/execution/non-blocking-fix.ts`)
  - Baseline: `{ fileCount; sourceLineCount }`
  - Target: adds optional `paths?: SourceDiffPaths` and `controlPaths?: readonly string[]`.
- `NonBlockingFixDeps` (`src/execution/non-blocking-fix.ts`)
  - Target: adds `listCommitsSince: (workdir: string, ref: string) => Promise<string[]>`.
- `CommandLauncherOptions` (`src/sandbox/launcher.ts`)
  - Baseline: `{ state; backend?; policyFor?; afterWrapped? }`
  - Target: adds `tmpDir?: string`.
- `resolveSessionSandbox` args (`src/agents/coding-tool-sandbox.ts`)
  - Target: adds `tmpDir?: string`, forwarded to every `createCommandLauncher` call in it.
- `CommandSafetyRow` (`src/command-safety/types.ts`)
  - Target: adds `signals: { readonly tmpWrite: boolean }`.

File-size constraints: `src/agents/coding-tool-support.ts` is at the 600-line source limit
(`scripts/check-file-sizes.ts`), so its edits (US-002, US-004) must not add net lines.
`src/tools/policy.ts` is at 590.

### US-001 — Spill marker names a reachable path

- The marker's widest shape becomes
  `... [truncated: full output at <path> (open with Read or ScratchpadRead); showing N of M bytes]`.
  The two narrower fallback shapes are unchanged.
- `<path>` is `.nax/scratchpad/spill/<Tool>-<callId>.txt` when `spillPathStyle` is `"root-relative"`
  (the spill root is the directory the session's tools and shell start in), and the absolute path of
  the written spill file when it is `"absolute"`. `writeSpill` keeps returning the
  scratchpad-relative `spill/<Tool>-<callId>.txt`; `applyModelTruncationPolicy` turns it into the
  marker path before calling `composeHead` / `composeTail`: `${SCRATCHPAD_DIR}/${relative}` for
  `"root-relative"`, `join(root, SCRATCHPAD_DIR, relative)` for `"absolute"`. The composers receive
  the finished path and are otherwise unchanged.
- `shapeToolResult` (`src/tools/runtime.ts`) keeps the default. `truncateNativeToolResult`
  (`src/agents/native/session/truncation-handler.ts`) passes `"root-relative"` when the root came from
  `nativeSessionScratchpadRoots` and `"absolute"` when it fell back to `nativeTranscriptDirs`.
- `pathsBranch` in `compileToolPolicy` (`src/tools/policy.ts`): for a tool whose scope declares
  `confineTo`, a path value that starts with `<confineTo>/` has that prefix removed before
  `resolveWithin` runs. `ScratchpadRead`, `ScratchpadWrite` therefore accept both `spill/x.txt` and
  `.nax/scratchpad/spill/x.txt`. Containment is unchanged: the stripped value is still resolved
  inside the confined root. `src/tools/policy.ts` has 10 lines of headroom under the 600-line
  limit, so the stripping must fit in them.

### US-002 — Raw Bash screen: whole-filesystem `find`, prd reads under the sandbox

- **`find` refusal.** In `screenRawBashCommand`, a segment whose first token is `find` is denied when
  any of its start paths is exactly `/`, `~`, `~/`, `$HOME`, `$HOME/`, `${HOME}` or `${HOME}/`. Start
  paths are the tokens after `find` and after any leading `-H`, `-L` or `-P`, up to the first token
  that begins with `-`, `(` or `!`. The comparison uses the token text, including an opaque token.
  The refusal is non-escalatable and reads
  `` `find <start>` searches the whole filesystem and runs into the 300s Bash timeout. Search within the repository root instead: <root> ``.
- The file header's "must never grow into a general gate" paragraph gains one sentence naming the
  whole-filesystem `find` refusal as the single deliberate exception (a cost guard, not a boundary).
- **prd reads.** When `sandboxWrapped` is `true`, a token hit of kind `"prd"` is not refused; a
  redirect hit of kind `"prd"` is still refused. Kinds `"config"` and `"queue"` are unchanged in both
  modes, and with `sandboxWrapped` absent or `false` the screen behaves exactly as today.
- Under `sandboxWrapped` only a redirect into a prd can still be refused, so the changed text is seen
  only on that path. The prd refusal text replaces "Bash commands naming it are refused, reads
  included -- leave it as is." with "Reading it through Bash is allowed; writing it is not -- nax
  updates it itself."
- **Plumbing.** New `rawScreenOptionsFor(launcher): { rawBashRefusal?: string; sandboxWrapped?: true }`
  in `src/agents/coding-tool-sandbox.ts` returns `rawBashRefusal` exactly as `rawRefusalFor` does and
  `sandboxWrapped: true` when `launcher.state.kind === "available"`. `buildCodingToolSupport` spreads
  it into the `compileToolPolicy` options in place of the current `rawBashRefusal` computation.
  `rawRefusalFor` itself is kept and exported unchanged; `rawScreenOptionsFor` calls it.
- The raw-mode Bash tool description (`rawDescription`, `src/tools/bash.ts`) gains one sentence
  stating that `find` from `/`, `~` or `$HOME` is refused and to search within the repository.

### US-003 — NBF control paths and restore diagnostics

```ts
export interface SourceDiffPaths {
  readonly added: readonly string[];
  readonly modified: readonly string[];
  readonly deleted: readonly string[];
}
/** Entries logged per path list; the full count is logged beside it. */
export const NBF_LOGGED_PATH_LIMIT = 20;
```

- `createMeasureSourceDiff` classifies every changed path against `fromRef`. A path whose first
  segment is `.nax` goes to `controlPaths` and adds nothing to `fileCount` or `sourceLineCount`.
  This check runs **before** the test-file exclusion: since #2266 a feature's acceptance test
  (`.nax/features/<f>/.nax-acceptance.test.ts`) is tracked and matches the test-file patterns, but it
  is nax state, and excluding it as a test would hide an NBF pass that rewrote it. Test files outside
  `.nax/` are then excluded, as today. Every other path goes to exactly one of
  `paths.added`, `paths.modified` or `paths.deleted`. Paths are repo-root-relative, as `git diff`
  prints them. One way to get the status (non-normative): a second `git diff --name-status <fromRef>`
  spawn through `hardenedGitArgv` / `gitSpawnEnv`.
- In `runNonBlockingFix`, inside the existing `if (cap)` block, after measuring and before the cap
  comparison: when `controlPaths` is
  non-empty, log
  `logger?.warn("non-blocking-fix", "NBF pass touched nax control files — restoring", { storyId, controlPathCount, controlPaths })`
  with `controlPaths` capped at `NBF_LOGGED_PATH_LIMIT`, and restore.
- The existing `"source diff exceeded cap — restoring"` info log gains `added`, `modified`, `deleted`
  (each capped at `NBF_LOGGED_PATH_LIMIT`) and `addedCount`, `modifiedCount`, `deletedCount`.
- A `SourceDiffMetrics` without `paths` / `controlPaths` (a custom `measureSourceDiff`) is treated as
  empty lists, so existing callers and test doubles keep working.
- Ordering against the ADR-033 scoped fix review (#2267): `runNonBlockingFix` now runs
  `_deps.reviewFix(restoreRef.sha)` after the `if (cap)` block and before keeping the pass. The
  control-path restore and the cap restore both happen inside the `if (cap)` block, so they return
  before `reviewFix` is reached: a pass that touched nax control files is never sent to the LLM
  review. No change to the fix-review block itself.
- `restoreToSnapshot` calls `_deps.listCommitsSince(args.workdir, restoreRef.sha)` before
  `rollbackToRef`, and adds `discardedCommits` (the returned SHAs) to its
  `"best-effort fix exhausted — restored to adversarial-passed"` log. If `listCommitsSince` rejects,
  `discardedCommits` is `[]` and the restore proceeds.
- The default `listCommitsSince` runs `git rev-list <ref>..HEAD` in `workdir` through
  `hardenedGitArgv` / `gitSpawnEnv` and returns the SHAs newest first; a non-zero exit rejects.

### US-004 — Per-session TMPDIR under `/tmp/nax-<runId>/`

New module `src/sandbox/session-tmp.ts`, exported from the `src/sandbox` barrel:

```ts
/** `/tmp/nax-<runId>` — the per-run parent of every session temp directory. */
export function runTmpRoot(runId: string): string;
/** `/tmp/nax-<runId>/<sessionName>`, each part reduced to [A-Za-z0-9_-] (others become "_"). */
export function sessionTmpDir(runId: string, sessionName: string): string;
```

- `createCommandLauncher` with `tmpDir` set: before each `run`, create `tmpDir` recursively. On
  success, the command runs with `TMPDIR`, `TMP` and `TEMP` set to `tmpDir`:
  - unwrapped (state `disabled` or `unavailable`): as an `env` overlay to `runArgv`, where a key the
    request's own `env` sets wins over the overlay;
  - wrapped (state `available`): the shell command handed to `backend.wrap` is prefixed with
    `export TMPDIR=<q> TMP=<q> TEMP=<q>; `, where `<q>` is `tmpDir` single-quoted for the shell, because
    srt replaces the child environment. The result's `executed` stays the logical argv of the
    unprefixed command, so the tool-audit ledger records what the agent wrote.
- If creating `tmpDir` fails, log
  `getSafeLogger()?.warn("sandbox", "could not create session temp dir — running without TMPDIR override", { tmpDir, error })`
  and run the command with no override.
- `resolveCodingToolSupport` passes `tmpDir: sessionTmpDir(options.runId, sessionName)` to
  `resolveSessionSandbox` when `options.runId` is defined, and no `tmpDir` otherwise. `sessionName` is
  the existing `buildLedgerSessionName(...)` value. `coding-tool-support.ts` is at the 600-line limit:
  import `sessionTmpDir` by widening the existing `import type { CommandLauncher } from "@/sandbox"`
  line to `import { type CommandLauncher, sessionTmpDir } from "@/sandbox"`, and fund the added
  `tmpDir` line by merging the two-line comment above the `launcher` const (it begins
  `// P4: the probe is async`) into one line.
- New `wipeRunTmp(runId, opts?: { dryRun?: boolean })` in new
  `src/execution/lifecycle/run-tmp-wipe.ts` removes `runTmpRoot(runId)` recursively, tolerating
  absence; any other failure is logged at warn and swallowed. It mirrors `wipeScratchpad`
  (`_runTmpWipeDeps.remove` seam). `cleanupRun` calls it through `_runCleanupDeps` whenever
  `!options.dryRun`, whether or not the run completed: a failed run's `/tmp` files are not kept for
  inspection, because no later run can find them to clear.
- `buildScratchpadSection` (`src/prompts/sections/scratchpad.ts`) gains, after the paragraph that
  mentions `/tmp`: "Shell commands run with `$TMPDIR` set to a temp directory for this session, which
  nax deletes when the run ends. Put temporary files there (`$TMPDIR` or `mktemp`), not in `/tmp`
  directly."

### US-005 — Shadow `tmpWrite` signal

New module `src/command-safety/tmp-write.ts`:

```ts
/** True when the command writes to a literal /tmp or /private/tmp path outside nax's own /tmp/nax-* dirs. */
export function detectTmpWrite(command: string, cwd?: string): boolean;
```

- Lexes with `lexBashCommand`. On a `refused` lex it scans the result's `prefix` segments (the lexable
  part before the unreadable construct), so `cd /tmp && cat > f <<'EOF'` is still seen; an empty
  prefix returns `false`.
- Tracks the working directory across segments: a segment `cd <target>` with a non-opaque target
  moves the frame to `target` resolved against the current frame (starting at `cwd`, or unknown when
  `cwd` is absent, in which case relative targets are ignored).
- Write targets per segment: every redirect target except those of input redirects (`<`, `<<`,
  `<<<`); for first token `tee`, `touch` or `mkdir`, every later token not starting with `-`; for
  first token `cp` or `mv`, the last token not starting with `-`. Opaque targets and targets starting
  with `~` are skipped.
- A target resolved against the frame counts when it equals `/tmp` or `/private/tmp` or lies under
  either, and does not lie under `/tmp/nax-` or `/private/tmp/nax-` (nax's own per-run dirs).
- The shadow's `toRow` (`src/command-safety/shadow.ts`) sets
  `signals: { tmpWrite: detectTmpWrite(obs.command, cwd) }` using the same `cwd` it records. The
  signal is recorded only: it is not a `QuestionId`, not in `rules.hits`, and does not change
  `RULE_SET_VERSION`.

### Failure Handling

| Condition | Behaviour | Story |
|---|---|---|
| Spill write fails | marker names no path (unchanged) | US-001 |
| Widest marker does not fit the byte cap | narrower shape, output stays within `maxBytes` (unchanged) | US-001 |
| Scratchpad path with prefix climbs out (`.nax/scratchpad/../config.json`) | denied by containment | US-001 |
| Command the lexer refuses (e.g. `find $(pwd)/..`) | allowed unscreened (unchanged) | US-002 |
| `measureSourceDiff` throws | warn and restore (unchanged) | US-003 |
| `listCommitsSince` rejects | restore proceeds, `discardedCommits: []` | US-003 |
| Session temp dir cannot be created | warn, command runs without TMPDIR override | US-004 |
| `wipeRunTmp` removal fails | warn, run outcome unaffected | US-004 |
| Shadow row construction | `detectTmpWrite` never throws; a refused lex is judged on its lexable prefix | US-005 |

## Out of Scope

- Making `test/unit/operations/typecheck-check.test.ts` AC6 hermetic (mocking `fileExists`); that is a separate manual follow-up.
- Refusing or blocking Bash writes to a literal `/tmp`, or removing `/tmp` from the sandbox write roots; this feature only measures them.
- Snapshotting or diffing `/tmp` around an NBF pass.
- A run-start sweep of `/tmp/nax-*` directories; a concurrent run's live directories share the prefix, so only a run's own `runTmpRoot` is removed, at its end. A crashed run's directory is left for the OS to clear.
- Setting `TMPDIR` for ACP agent sessions or for commands run outside the coding-tool launcher (quality gates run by nax itself).
- Changing the Bash timeout, or adding a timeout hint to the `timed out after` message.
- Stating the absolute working directory in the Bash tool description or the session preamble (#2259 proposal 3).
- Screening `find` in gated or escalate Bash mode, whose root containment already governs start paths.
- Changing the raw screen for `config` or `queue` paths, or its behaviour when the sandbox is disabled.
- Changing `sourceDiffCap` defaults or `review.nonBlockingFix` defaults.
- Measuring the NBF diff when `sourceDiffCap` is absent from the resolved config; the control-path check runs only where the measurement already runs (the schema always defaults the cap).
- Changing which roles are granted `ScratchpadRead`.
- Adding `/tmp` patterns to the command-safety `outside_project` rule family or bumping `RULE_SET_VERSION`.
- Excluding `.nax/scratchpad/` from context-engine scans.

## Stories

1. **US-001: Spill marker names a path the session can open** — no dependencies
2. **US-002: Raw Bash screen refuses whole-filesystem `find` and allows prd reads under the sandbox** — no dependencies
3. **US-003: NBF classifies `.nax/` control paths and logs what a restore discarded** — no dependencies
4. **US-004: Per-session TMPDIR under `/tmp/nax-<runId>/`, wiped at run end** — no dependencies
5. **US-005: Command-safety shadow records `/tmp` writes** — no dependencies

### Context Files

**US-001**
- `src/tools/spill.ts` — `markerShapes`, `composeHead`, `composeTail`, `applyModelTruncationPolicy`
- `src/agents/native/session/truncation-handler.ts` — `spillRootFor`, `truncateNativeToolResult`
- `src/tools/policy.ts` — `pathsBranch` and its `confineTo` handling
- `src/tools/scratchpad.ts` — `SCRATCHPAD_DIR`, `scratchpadReadTool`
- `test/unit/tools/spill-recovery.test.ts` — spill marker test patterns

**US-002**
- `src/tools/policy-bash-raw.ts` — `screenRawBashCommand`, `protectedHit`
- `src/tools/policy-command-branch.ts` — `commandBranch`
- `src/agents/coding-tool-sandbox.ts` — `rawRefusalFor`, `resolveSessionSandbox`
- `src/tools/nax-owned-writes.ts` — `naxOwnedBashRefusal`, `naxOwnedKind`
- `src/tools/bash.ts` — `rawDescription`

**US-003**
- `src/execution/non-blocking-fix.ts` — `createMeasureSourceDiff`, `runNonBlockingFix`, `restoreToSnapshot`
- `src/tdd/rollback.ts` — `captureSnapshotRef`, `rollbackToRef`
- `src/utils/git-env.ts` — `hardenedGitArgv`, `gitSpawnEnv`
- `test/unit/execution/non-blocking-fix.test.ts` — the `sourceDiffCap` describe block

**US-004**
- `src/sandbox/launcher.ts` — `createCommandLauncher`, `runWrapped`, `runUnwrapped`
- `src/agents/coding-tool-sandbox.ts` — `resolveSessionSandbox`
- `src/agents/coding-tool-support.ts` — `resolveCodingToolSupport`, `buildLedgerSessionName`
- `src/execution/lifecycle/scratchpad-wipe.ts` — `wipeScratchpad`, the pattern to mirror
- `src/execution/lifecycle/run-cleanup.ts` — `cleanupRun`, `_runCleanupDeps`

**US-005**
- `src/command-safety/shadow.ts` — `toRow`
- `src/command-safety/types.ts` — `CommandSafetyRow`
- `src/permissions/bash-lex.ts` — `lexBashCommand`
- `test/unit/command-safety/shadow.test.ts` — row test patterns

### Creates

**US-004**
- `src/sandbox/session-tmp.ts` — `runTmpRoot`, `sessionTmpDir`
- `src/execution/lifecycle/run-tmp-wipe.ts` — `wipeRunTmp`, `_runTmpWipeDeps`

**US-005**
- `src/command-safety/tmp-write.ts` — `detectTmpWrite`

### Modifies

**US-004**
- `test/unit/prompts/__snapshots__/rectifier-builder.test.ts.snap` — embeds `buildScratchpadSection()` text verbatim; the new `$TMPDIR` sentence changes it. Regenerate the snapshot; the replacing invariant is that the section still appears once, now including the `$TMPDIR` sentence.
- `test/unit/prompts/builders/__snapshots__/rectifier-builder-helpers.test.ts.snap` — embeds `buildScratchpadSection()` text verbatim; the new `$TMPDIR` sentence changes it. Regenerate the snapshot; the replacing invariant is that the section still appears once, now including the `$TMPDIR` sentence.
- `test/unit/prompts/__snapshots__/review-builder.test.ts.snap` — embeds `buildScratchpadSection()` text verbatim; the new `$TMPDIR` sentence changes it. Regenerate the snapshot; the replacing invariant is that the section still appears once, now including the `$TMPDIR` sentence.

**US-005**
- `test/unit/command-safety/row.test.ts` — its `row()` helper builds a complete `CommandSafetyRow` literal with no `signals` key, which stops typechecking once `signals` is a required field. Add `signals: { tmpWrite: false }` to the literal; the replacing invariant is that the appended JSONL line still round-trips the row, now including `signals`.

### Seams

- US-001 AC10: Bash tool result over the cap → `Read` of the path the marker names, through one `createCodingToolRuntime`.
- US-002 AC14: `buildCodingToolSupport` with an available launcher → `screenRawBashCommand` receives `sandboxWrapped: true`.
- US-004 AC12: `resolveCodingToolSupport` with a `runId` → the Bash tool's command runs with `TMPDIR` equal to `sessionTmpDir(runId, sessionName)`.
- US-004 AC17: `cleanupRun` → `wipeRunTmp(runId)`.
- US-005 AC10: `createCommandShadow(...).observe` + `settle` → the written row carries `signals.tmpWrite`.

## Acceptance Criteria

### US-001

1. [unit] `applyModelTruncationPolicy` with a `root` and a `Read`-tool body over `maxBytes` returns content whose last line is `... [truncated: full output at .nax/scratchpad/spill/Read-<callId>.txt (open with Read or ScratchpadRead); showing N of M bytes]` with `N` the delivered and `M` the original byte count.
2. [unit] `applyModelTruncationPolicy` with a `root` and a `Bash`-tool body over `maxBytes` returns content containing a marker line naming `.nax/scratchpad/spill/Bash-<callId>.txt (open with Read or ScratchpadRead)`.
3. [unit] `applyModelTruncationPolicy` with `spillPathStyle: "absolute"` returns a marker naming the absolute path `<root>/.nax/scratchpad/spill/<Tool>-<callId>.txt`.
4. [unit] Reading the file at `join(root, <path named by a root-relative marker>)` returns the untruncated body passed to `applyModelTruncationPolicy`.
5. [unit] When the spill write rejects, `applyModelTruncationPolicy` returns a marker of the form `... [truncated: showing N of M bytes]`, naming no path.
6. [unit] With a `maxBytes` too small for the widest marker shape, `applyModelTruncationPolicy` returns content whose byte length is at most `maxBytes`.
7. [unit] `truncateNativeToolResult` for a session registered in `nativeSessionScratchpadRoots` with workdir `W` returns a marker naming `.nax/scratchpad/spill/...`, and the spill file exists under `W/.nax/scratchpad/spill/`.
8. [unit] `truncateNativeToolResult` for a session registered only in `nativeTranscriptDirs` with directory `T` returns a marker naming an absolute path that starts with `T`.
9. [unit] A `ScratchpadRead` call with path `.nax/scratchpad/spill/x.txt` returns the content of `<root>/.nax/scratchpad/spill/x.txt`.
10. [integration] Through one `createCodingToolRuntime`, a `Bash` call whose output exceeds the model cap, followed by a `Read` call on the path named in its marker, returns content that includes the last line of the untruncated command output.
11. [unit] A `ScratchpadRead` call with path `spill/x.txt` still returns the content of `<root>/.nax/scratchpad/spill/x.txt`.
12. [unit] A `ScratchpadWrite` call with path `.nax/scratchpad/notes.md` writes `<root>/.nax/scratchpad/notes.md`, and no file is created at `<root>/.nax/scratchpad/.nax/scratchpad/notes.md`.
13. [unit] `compileToolPolicy(...).check` for `ScratchpadRead` with path `.nax/scratchpad/../config.json` returns a denied verdict.

### US-002

1. [unit] `screenRawBashCommand` with command `find / -name approvals.ts` returns a non-escalatable deny whose reason names the repository root passed as `root`.
2. [unit] `screenRawBashCommand` denies `find ~ -name x`.
3. [unit] `screenRawBashCommand` denies `find $HOME -name x`.
4. [unit] `screenRawBashCommand` denies `find -L / -name x`.
5. [unit] `screenRawBashCommand` denies `git status; find / -name x | head`, a compound command whose second segment is a whole-filesystem `find`.
6. [unit] `screenRawBashCommand` allows `find /usr/lib -name x`.
7. [unit] `screenRawBashCommand` allows `find . -name x`.
8. [unit] `screenRawBashCommand` allows `find ~/proj -name x`.
9. [unit] `screenRawBashCommand` with `sandboxWrapped: true` allows `git diff .nax/features/f/prd.json`.
10. [unit] `screenRawBashCommand` with `sandboxWrapped: true` denies `echo x > .nax/features/f/prd.json`, with a reason that includes "Reading it through Bash is allowed".
11. [unit] `screenRawBashCommand` with `sandboxWrapped: true` denies `cat .nax/config.json`.
12. [unit] `screenRawBashCommand` with `sandboxWrapped` absent denies `git diff .nax/features/f/prd.json` with a reason that includes "reads included".
13. [unit] `rawScreenOptionsFor` returns `{ sandboxWrapped: true }` for a launcher in state `available`, `{ rawBashRefusal }` for state `unavailable`, and `{}` for state `disabled`.
14. [integration] `buildCodingToolSupport` in `raw` Bash mode with an `available` launcher and a Bash grant yields a runtime whose policy allows the Bash command `git diff .nax/features/f/prd.json`, and with a `disabled` launcher denies it.
15. [unit] The raw-mode Bash tool description includes a sentence stating that `find` from `/`, `~` or `$HOME` is refused.

### US-003

1. [integration] In a temporary git repo, after modifying tracked `src/a.ts`, adding `src/b.ts` and deleting tracked `src/c.ts` and committing, `createMeasureSourceDiff(...)(workdir, ref)` returns `paths` equal to `{ added: ["src/b.ts"], modified: ["src/a.ts"], deleted: ["src/c.ts"] }`.
2. [integration] A changed test file appears in none of `paths.added`, `paths.modified`, `paths.deleted` or `controlPaths`, and adds nothing to `fileCount`.
3. [integration] Deleting tracked `.nax/features/f/stories/US-001.json` yields `controlPaths` containing that path, `fileCount` `0` and `sourceLineCount` `0`.
4. [unit] `runNonBlockingFix` with `measureSourceDiff` returning `controlPaths: [".nax/rules/a.md"]` and counts within the cap returns `{ kept: false, restored: true }`.
5. [unit] In that case `runNonBlockingFix` logs `"NBF pass touched nax control files — restoring"` at warn level with `controlPaths` `[".nax/rules/a.md"]` and `controlPathCount` `1`.
6. [unit] With 25 control paths, the warn log's `controlPaths` has 20 entries and `controlPathCount` is `25`.
7. [unit] When the cap trips, the `"source diff exceeded cap — restoring"` log carries `added`, `modified`, `deleted` equal to the metrics' path lists and `addedCount`, `modifiedCount`, `deletedCount` equal to their lengths.
8. [unit] With 30 added paths, the cap log's `added` has 20 entries and `addedCount` is `30`.
9. [unit] `runNonBlockingFix` with `measureSourceDiff` returning only `{ fileCount: 1, sourceLineCount: 10 }` within the cap returns `kept: true`.
10. [unit] On a restore, `runNonBlockingFix` calls `listCommitsSince` with the workdir and the snapshot `sha` before it calls `rollbackToRef`.
11. [unit] On a restore, the `"best-effort fix exhausted — restored to adversarial-passed"` log carries `discardedCommits` equal to the array `listCommitsSince` resolved.
12. [unit] When `listCommitsSince` rejects, `runNonBlockingFix` still calls `rollbackToRef` and logs `discardedCommits` `[]`.
13. [unit] On a kept pass, `runNonBlockingFix` never calls `listCommitsSince`.
14. [integration] The default `listCommitsSince(workdir, ref)` in a temporary git repo with two commits after `ref` returns both commit SHAs, newest first.
15. [integration] Modifying the tracked `.nax/features/f/.nax-acceptance.test.ts` yields `controlPaths` containing that path, not an exclusion as a test file, with `fileCount` `0`.
16. [unit] With a `reviewFix` dependency provided and `measureSourceDiff` returning a non-empty `controlPaths` within the cap, `runNonBlockingFix` restores and never calls `reviewFix`.

### US-004

1. [unit] `sessionTmpDir("run-1", "US-001-implementer")` returns `"/tmp/nax-run-1/US-001-implementer"`.
2. [unit] `sessionTmpDir("run-1", "a/b")` returns `"/tmp/nax-run-1/a_b"`.
3. [unit] `runTmpRoot("run-1")` returns `"/tmp/nax-run-1"`.
4. [unit] A launcher in state `disabled` created with `tmpDir` `T` calls `runArgv` with an `env` whose `TMPDIR`, `TMP` and `TEMP` are all `T`.
5. [unit] A launcher in state `disabled` created with `tmpDir` `T`, running a request whose `env` sets `TMPDIR` to `X`, calls `runArgv` with `env.TMPDIR` `X`.
6. [unit] A launcher in state `available` created with `tmpDir` `T` hands `backend.wrap` a command equal to `export TMPDIR='T' TMP='T' TEMP='T'; ` followed by the original command.
7. [unit] That wrapped launcher's result has `executed` equal to `[shell, "-c", <original command>]`.
8. [unit] A launcher created with `tmpDir` `T` creates `T` recursively before running the command.
9. [unit] When creating `T` rejects, the launcher still runs the command, with no `TMPDIR` in the `runArgv` env, and logs `"could not create session temp dir — running without TMPDIR override"` at warn level.
10. [unit] A launcher created without `tmpDir` calls `runArgv` with no `env` when the request sets none.
11. [unit] `resolveSessionSandbox` with a disabled sandbox config and `tmpDir` `T` returns a launcher whose command runs with `TMPDIR` `T`.
12. [integration] `resolveCodingToolSupport` with `runId` `"r1"`, `storyId` `"US-001"`, `sessionRole` `"implementer"`, a declared and granted Bash tool and the sandbox disabled, then a Bash tool call with `runArgv` stubbed, runs the command with `env.TMPDIR` equal to `"/tmp/nax-r1/US-001-implementer"`.
13. [unit] `resolveCodingToolSupport` with no `runId` yields a Bash tool whose command runs with no `TMPDIR` in its env.
14. [integration] A `disabled` launcher with `tmpDir` set to a fresh temporary directory `T`, running `echo "$TMPDIR"`, returns stdout `T`.
15. [unit] `wipeRunTmp("r1")` calls `_runTmpWipeDeps.remove` with `"/tmp/nax-r1"`.
16. [unit] `wipeRunTmp("r1")` resolves and logs a warning when `_runTmpWipeDeps.remove` rejects.
17. [unit] `cleanupRun` with `runId` `"r1"`, `runCompleted: false` and `dryRun` unset calls `wipeRunTmp` with `"r1"`.
18. [unit] `cleanupRun` with `dryRun: true` does not call `wipeRunTmp`.
19. [unit] `buildScratchpadSection()` output includes the sentence "Put temporary files there (`$TMPDIR` or `mktemp`), not in `/tmp` directly."

### US-005

1. [unit] `detectTmpWrite("echo x > /tmp/a.txt")` returns `true`.
2. [unit] `detectTmpWrite("cd /tmp && cat > tsconfig.json <<'EOF'\n{}\nEOF")` returns `true`.
3. [unit] `detectTmpWrite("tee /tmp/out.log")` returns `true`.
4. [unit] `detectTmpWrite("cp src/a.ts /private/tmp/")` returns `true`.
5. [unit] `detectTmpWrite("mkdir -p /tmp/probe")` returns `true`.
6. [unit] `detectTmpWrite("cat /tmp/a.txt")` returns `false`.
7. [unit] `detectTmpWrite("echo x > /tmp/nax-r1/US-001-implementer/a.txt")` returns `false`.
8. [unit] `detectTmpWrite("echo x > out.txt", "/tmp")` returns `true`, and `detectTmpWrite("echo x > out.txt", "/repo")` returns `false`.
9. [unit] `detectTmpWrite("echo x > \"$TMPDIR/a\"")` returns `false`.
10. [integration] A shadow from `createCommandShadow` that observes and settles the Bash command `cd /tmp && echo x > a.txt` writes a row whose `signals.tmpWrite` is `true`.
11. [integration] A shadow that observes and settles the Bash command `ls` writes a row whose `signals.tmpWrite` is `false` and whose `rules.version` equals `RULE_SET_VERSION`.
