# SPEC: Approval and escalation residuals

## Summary

Three independent fixes to nax's Bash approval surface, bundled for one run. The first (nax#2194)
reorders `checkBashCommand` so that, under `bashApproval: "escalate"`, a command that is out of
bounds (a root escape, `.git/` access, a denied flag, an unexpandable token, a deny-rule match) is
refused outright instead of being sent to a human for approval: the payload and deny checks run
before the two escalatable denials, and on the part of an unparseable command that does parse. The
second (nax#2212) seals the approvals cache one last time at the end of a forge-capable run, from
both the normal cleanup path and the signal teardown path, so an agent that ran after the last
dispatch scope cannot leave forged entries for a later trusted run. The third (nax#2213 item 3)
closes the textual blind spot in the git-spawn hardening gate: a spawn whose argv is not a literal
must now declare itself.

## Motivation

**nax#2194.** ADR-030 § "Why `escalate` splits denials in two" says a Category B denial (path
outside the root, `.git/`, a `DENIED_FLAGS`-class flag, an explicit deny rule, a redirect or `cd`
outside the root) never escalates. `checkBashCommand` (`src/tools/policy-bash.ts:228`) returns the
escalatable grant-miss denial at `:251-256` before `checkPayload` runs at `:258-263`, and the
escalatable lexer refusal at `:234-241` before the deny rules at `:243-249`. So an UNGRANTED
command that escapes the root reaches the human and, if allowed, runs as written. This happened in
real runs: of every Bash call in 1,135 local tool-audit files, exactly two were escalated
(`denied:ask`), and both were this class — `cat .git/info/exclude 2>/dev/null; ...` and
`ls -la <an absolute path outside the root>`. ADR-030 carries a "disclosed divergence" section and
the `escalate` Bash description hedges around it ("unless it cannot be analysed"); both flip with
this fix.

**nax#2212.** A forge-capable run (any `bashApproval: raw` stage with the sandbox off) taints
`approvals.json` before and after each dispatch scope (`buildDispatchAskWiring`,
`src/interaction/dispatch-ask.ts:103-192`). Nothing re-taints at run end, so an agent dispatched
outside a dispatch-ask scope after the last re-taint can strip the marker and forge entries that a
later trusted run then honours. `cleanupRun` (`src/execution/lifecycle/run-cleanup.ts:230`) runs in
the runner's `finally` after post-run actions, which may dispatch agents; the signal path
(`performTeardown`, `src/execution/crash-signals.ts:108`) calls `process.exit` and never reaches
`cleanupRun`. A final taint on both paths closes the agents-outside-a-scope residual and narrows the
killed-run residual to deaths no handler sees.

**nax#2213 item 3.** `scripts/check-git-spawn-env.ts` only matches argv literals whose head is the
literal `"git"`. A spawn whose argv is a variable (`Bun.spawn(argv, ...)`) or an identifier-headed
literal (`[gitBin, ...]`) is invisible to it, and the script documents this as a known blind spot.
About ten `src/` spawn sites pass a non-literal argv today; most are not git (hooks, acpx, test
commands), but nothing in the text says so.

## Design

### Integration

The baselines below exist only to locate the code. The **Target** lines are the interface to
implement; a baseline is never the interface.

**Changed:**

**`BashLexResult`** — `src/permissions/bash-lex.ts:46` (US-001)
- Baseline: `{ kind: "ok"; segments: readonly BashSegment[] } | { kind: "refused"; construct: string }`
- Target: the refused variant also carries `prefix: readonly BashSegment[]` — the segments the lexer
  completed before the refused construct, followed by the segment it was building when it refused
  (its completed tokens and completed redirects only). The word being built at the moment of
  refusal is dropped, as is a redirect operator still waiting for its target. A trailing segment
  with no tokens and no redirects is omitted. `prefix` is `[]` when the refusal comes before any
  word completes.

**`lexBashCommand(command: string): BashLexResult`** — `src/permissions/bash-lex.ts:68` (US-001)
- Baseline: returns `refused(construct)` at each refusal site.
- Target: every refusal site returns the refused variant with `prefix` populated as above. The
  `ok` result is unchanged. `src/permissions` keeps zero imports.

**`checkBashCommand(args: BashCheckArgs): BashCheck`** — `src/tools/policy-bash.ts:228` (US-001)
- Baseline order: lexer refusal (escalatable) → deny rules → grant (escalatable miss) →
  `checkPayload` per segment → ask rules → allow.
- Target order, where `S` is `lexed.segments` on `ok` and `lexed.prefix` on `refused`:
  1. `"command" must be a string` / `must not be empty` guards, unchanged.
  2. Deny rules over every segment of `S` → non-escalatable deny, reason naming the rule (unchanged text).
  3. `checkPayload` over every segment of `S`, threading the working directory with
     `nextWorkingDirectories` exactly as today → its refusal, with `breach` as today. The
     affirmatively out-of-bounds refusals (containment, `.git/`, a denied flag, expansion, a bare
     `cd`) stay `escalatable: false`; the option-shaped-`cd` refusal is `escalatable: true`
     (Category A — the gate cannot model where the target lands), so the reorder never lets it
     preempt the grant miss for an ungranted command.
  4. If the lexer refused → the existing escalatable refusal (`command contains <construct>, which cannot be analysed ...`).
  5. Grant check over every segment → the existing escalatable `is not granted` denial.
  6. Ask rules → `ask`; otherwise `allow`.
  The header comment's precedence list is rewritten to this order. `escalatable: true` is produced
  at three sites: the two escalatable denials (steps 4 and 5) and `checkPayload`'s option-shaped-
  `cd` refusal in step 3. Each is a Category A "the gate could not adjudicate" denial; the deny
  rules and the affirmatively out-of-bounds payload checks still run before the two escalatable
  denials.

**`escalateDescription(shell, patterns)`** — `src/tools/bash.ts:123` (US-001)
- Baseline: "A command whose every segment matches a granted form is checked further: ..." and
  "A command matching a deny rule is refused without asking unless it cannot be analysed."
- Target: the sentence opens "Every command, granted or not, is checked first:" and lists the
  existing refused-without-asking checks plus "a command matching a deny rule"; it adds "for a
  command using a construct that cannot be analysed, these checks cover the part before that
  construct". The "unless it cannot be analysed" sentence is deleted. The phrases
  "cannot be analysed", "sent to a human for approval", "exactly as written" and
  "refused without asking" all remain. The doc comment's nax#2194 caveat is removed.

**`RunSetupResult`** — `src/execution/lifecycle/run-setup.ts:110` (US-002)
- Target: gains a required `sealApprovals: () => Promise<void>`.

**`RunnerSetupResult`** — `src/execution/runner-setup.ts:46` (US-002)
- Target: gains a required `sealApprovals` field typed from `setupRun`'s result, like its siblings;
  `runSetupPhase` returns it unchanged from `setupRun`.

**`RunCleanupOptions`** — `src/execution/lifecycle/run-cleanup.ts:68` (US-002)
- Target: gains an optional `sealApprovals?: () => Promise<void>`. `run()` in
  `src/execution/runner.ts` passes `setupResult.sealApprovals` into its `cleanupRun` call.

**`CrashRecoveryContext`** — `src/execution/crash-recovery.ts:34`, and **`SignalHandlerContext`** —
`src/execution/crash-signals.ts:27` (US-002)
- Target: both gain an optional `sealApprovals?: () => Promise<void>`.

**`performTeardown(ctx: SignalHandlerContext)`** — `src/execution/crash-signals.ts:108` (US-002)
- Baseline: abort → `onShutdown` → `pidRegistry.freeze()` → `pidRegistry.killAll()`.
- Target: the same, then `await ctx.sealApprovals?.()` as the last step, with any rejection
  swallowed.

**`_runSetupDeps`** — `src/execution/lifecycle/run-setup.ts:69` (US-002)
- Target: gains `buildApprovalsSeal`, so tests can stub it.

**`findGitSpawnViolations(source: string): GitSpawnViolation[]`** — `scripts/check-git-spawn-env.ts:120` (US-003)
- Baseline: flags `["git", ...]` literals not inside a hardened spawn call, and unwrapped status/diff argv.
- Target: also flags any `spawn(` / `spawnSync(` call (same `SPAWN_CALLEE` match, on the
  comment-masked source) whose first argument is not an array literal headed by a string literal,
  unless the call's arguments contain `gitSpawnEnv(` or `hardenedGitEnv(`, or the call's line or
  the line above carries a non-empty `// nax-git-env-allow: <reason>`. Such a violation has
  `why: "spawn argv is not a literal: pass env: gitSpawnEnv(...) or mark // nax-git-env-allow: <reason>"`
  and `line` = the line holding the `spawn` callee. Existing rules and their `why` strings are unchanged.

**New:**

**`buildApprovalsSeal`** — `src/interaction/dispatch-ask.ts`, exported from `src/interaction/index.ts` (US-002)

```ts
export interface ApprovalsSealOptions {
  readonly projectDir: string;
  /** The run's root config. `execution.sandbox` is a root-only key (ROOT_ONLY_EXECUTION_KEYS). */
  readonly rootConfig: NaxConfig;
  /** Every story's package dir (`prd.userStories.map(storyPackageDir)`). */
  readonly packageDirs: readonly (string | undefined)[];
  /** Run output dir; the approvals file is `approvalsPath(outputDir)`. */
  readonly outputDir: string;
  readonly runId: string;
}

/** Decide once whether this run is forge-capable; return the end-of-run seal. Never rejects. */
export async function buildApprovalsSeal(
  opts: ApprovalsSealOptions,
  deps: DispatchAskDeps = _dispatchAskDeps,
): Promise<() => Promise<void>>;
```

It computes `isForgeCapable(await collectEffectiveRunStageModes({ projectDir, rootConfig, packageDirs }, deps), rootConfig.execution?.sandbox?.enabled === true)`
once. For a forge-capable run it returns a closure that calls
`deps.prepareApprovalsStore({ approvalsFile: approvalsPath(outputDir), runId, forgeCapable: true })`;
otherwise it returns a closure that does nothing. `prepareApprovalsStore` already never throws and
logs a failed taint.

**Read-only (verified, not changed):**

- `checkPayload(args, segment, cwd)` — `src/tools/policy-bash.ts:144`; `nextWorkingDirectories` — `src/tools/bash-cwd.ts`.
- `escalate` conversion — `src/tools/policy-command-branch.ts:81`: converts a deny to `ask` only when `result.escalatable`.
- `isForgeCapable`, `prepareApprovalsStore`, `taintApprovals`, `clearApprovalsTaint` — `src/permissions/approvals-taint.ts:69-153`.
- `collectEffectiveRunStageModes` — `src/interaction/dispatch-ask.ts:236`; `approvalsPath` — `src/permissions`.
- `storyPackageDir` — `src/utils/path-frame.ts:126`.
- `readApprovalsFile` / `writeApprovalsFile` — `src/permissions/approvals-store.ts`.

### Approach

**US-001.** A deterministic reorder inside `checkBashCommand` plus the lexer's `prefix`. No new
policy concept: the same deny matcher and the same `checkPayload` run earlier, over the lexed
segments or the prefix. A refused command whose prefix passes both checks keeps today's escalatable
refusal, so Category A keeps its meaning ("the gate could not adjudicate"), and the human still sees
the full command for anything past the refused construct.

**US-002.** `setupRun` builds the seal once, right after `initializeAfterLock` returns the loaded
PRD, by calling `_runSetupDeps.buildApprovalsSeal({ projectDir: options.workdir, rootConfig: options.config, packageDirs: initResult.prd.userStories.map(storyPackageDir), outputDir: runtime.outputDir, runId: options.runId })`.
The crash handlers are installed earlier, before the PRD loads, so the context passed to
`installCrashHandlers` carries a forwarder `sealApprovals: () => seal()` over a variable assigned
once the seal is built; before that, the forwarder does nothing. `setupRun` returns the built seal
as `sealApprovals`. `cleanupRun` awaits `options.sealApprovals?.()` after `runPostRunActions` and
plugin teardown and before the interaction chain is destroyed. `performTeardown` awaits
`ctx.sealApprovals?.()` after `pidRegistry.killAll()`, so no tracked agent process survives to strip
the marker again. Deciding forge-capability at setup keeps config loads out of signal-time teardown,
which runs under `FATAL_TEARDOWN_DEADLINE_MS`.

**US-003.** A textual extension of the existing gate, reusing its masking (`mask`) and bracket
matching (`matchingClose`). Every existing `src/` site that the new rule flags gets a one-line
`// nax-git-env-allow: <reason>` stating what the argv is (for example "not git: hook argv
(`hooks.*.command`)", "not git: acpx client", "generic `_deps` wrapper; git callers are checked at
their own literal"). The exact set is whatever the gate reports on its first run; no call site's
behaviour changes.

**Documentation (non-normative, same PR).** ADR-030: US-001 deletes § "A disclosed divergence:
Category B does not always stay out of the ask tier" and adds one sentence under Category A saying
deny rules and payload checks run on the part of an unanalysable command that lexes. US-002 updates
the RESIDUAL RISK comment in `src/permissions/approvals-taint.ts`: the "agents outside a
dispatch-ask scope" bullet is removed, the "killed run" bullet narrows to deaths no handler sees, and
the "process that outlives its scope" bullet stays as accepted because the sandbox, on by default,
is the boundary. US-003 replaces the "Known blind spot" sentence in the script header with the new rule.

### Failure Handling

| Situation | Behaviour |
|:---|:---|
| The lexer refuses before any word completes (`(cat /etc/passwd)`) | `prefix` is `[]`; no deny or payload check fires; the escalatable lexer refusal is returned as today. |
| A segment matches a deny rule and also fails `checkPayload` | The deny-rule denial wins (step 2 runs before step 3); `breach` is `false`. |
| An ungranted command also fails `checkPayload` (other than an option-shaped `cd`) | The payload refusal is returned, not the grant miss; `escalatable` is `false`. |
| An ungranted command's `cd` target is option-shaped (`cd -`) | `checkPayload`'s option-shaped-`cd` refusal is returned with `escalatable: true`: the gate cannot model where it lands, so it escalates as Category A. |
| The seal's taint write fails (unwritable file, lock failure) | `prepareApprovalsStore` logs `[approvals] could not update the store's taint marker` at warn; the seal resolves; cleanup or teardown continues. |
| The run is trusted (sandbox on, or no `raw` stage) | The seal does nothing; `approvals.json` is untouched. |
| `sealApprovals` rejects inside `performTeardown` | Swallowed; `performTeardown` resolves. |
| A non-literal spawn carries an empty `// nax-git-env-allow:` marker | Still a violation, matching the existing marker rule. |

## Out of Scope

- Growing the Bash lexer's modelled language (for example accepting `2>&1` or `$(...)`). Only the refused result gains a `prefix`; every construct refused today stays refused.
- Matching deny rules against commands that appear only after a refused construct (for example `$(x); rm -rf y`). Deny rules are prefix-anchored, and the part after a refused construct is not lexed; the human sees the full command.
- Changing `raw` mode, the raw protected-path screen (`src/tools/policy-bash-raw.ts`), or the `gated` Bash description.
- Changing the denial redirect text in `src/tools/denial-redirect.ts`.
- Changing the `approvals.json` format, the cache link's trust rules (`src/permissions/approvals-link.ts`), or the per-scope taint in `buildDispatchAskWiring`.
- P5 command-safety shadow scoring and A-mode promotion.
- US-002 only: a process an agent leaves running past its scope (a detached `sleep; rewrite`) that forges after the final seal. Accepted: the sandbox, on by default, write-denies the approvals file and is the boundary.
- US-002 only: a run killed by a signal no handler sees (SIGKILL, power loss) after an agent stripped the marker. No on-disk record can be made safe from an unsandboxed raw shell running as the same user.
- US-002 only: a fatal signal that arrives during `setupRun` before the seal is built. No dispatch scope has run yet, so there is nothing to seal.
- US-002 only: killing every process group the native Bash tool started when a scope ends.
- US-003 only: routing every git spawn through one helper and banning direct spawns (37 call sites).
- US-003 only: scanning `scripts/`, `bin/` or `test/`; the gate still walks `src/` only.

## Stories

**US-001 — Out-of-bounds Bash commands never escalate** (no dependencies)
`lexBashCommand` returns the lexed `prefix` on a refusal; `checkBashCommand` runs deny rules and
`checkPayload` before its two escalatable denials; the `escalate` Bash description and ADR-030 stop
hedging (nax#2194).

**US-002 — Seal the approvals cache at run end** (no dependencies)
`buildApprovalsSeal`; `setupRun` builds it and threads it to the crash handlers and to
`RunSetupResult`; `run()` hands it to `cleanupRun`; `cleanupRun` and `performTeardown` call it after
every agent has stopped (nax#2212). Also touches `src/execution/runner.ts`,
`src/execution/runner-setup.ts` and `src/execution/crash-recovery.ts`.

**US-003 — Non-literal spawns declare whether they are git** (no dependencies)
The git-spawn gate flags a spawn with a non-literal or identifier-headed argv unless it is hardened
or carries an allow marker; existing `src/` sites get their markers (nax#2213 item 3).

### Context Files

**US-001**
- `src/tools/policy-bash.ts` — `checkBashCommand` and `checkPayload`, the order to change.
- `src/permissions/bash-lex.ts` — `lexBashCommand`, `flushWord`, `flushSegment`, and the refusal sites.
- `src/tools/policy-command-branch.ts` — the `escalate` conversion that reads `escalatable`.
- `src/tools/bash.ts` — `escalateDescription`.
- `docs/adr/ADR-030-bash-approval-modes.md` — § "Why `escalate` splits denials in two" and § "A disclosed divergence".

**US-002**
- `src/permissions/approvals-taint.ts` — `isForgeCapable`, `prepareApprovalsStore`, the RESIDUAL RISK comment.
- `src/interaction/dispatch-ask.ts` — `buildDispatchAskWiring`, `collectEffectiveRunStageModes`, `_dispatchAskDeps`.
- `src/execution/lifecycle/run-setup.ts` — `setupRun`, `_runSetupDeps`, the `installCrashHandlers` call.
- `src/execution/lifecycle/run-cleanup.ts` — `cleanupRun`, `RunCleanupOptions`.
- `src/execution/crash-signals.ts` — `performTeardown`, `SignalHandlerContext`.

**US-003**
- `scripts/check-git-spawn-env.ts` — `findGitSpawnViolations`, `mask`, `matchingClose`, the CLI walk.
- `test/unit/scripts/check-git-spawn-env.test.ts` — fixture shapes the existing rule accepts and flags.
- `src/utils/git-env.ts` — `gitSpawnEnv`, `hardenedGitEnv`, `hardenedGitArgv`.

### Creates

**US-001**
- `test/unit/tools/policy-bash-order.test.ts` — the reordered precedence under a narrow grant, and the escalate cases.

**US-002**
- `test/unit/interaction/dispatch-ask-seal.test.ts` — `buildApprovalsSeal` behaviour against a real approvals file.
- `test/unit/execution/lifecycle/run-cleanup-approvals-seal.test.ts` — `cleanupRun` calls the seal. New file because `run-cleanup.test.ts` is 767 lines against the 800-line test gate.
- `test/unit/execution/lifecycle/run-setup-approvals-seal.test.ts` — `setupRun` builds and threads the seal. New file because `run-setup.test.ts` is 772 lines.

### Modifies

**US-001**
- `test/unit/agents/coding-tool-bash-escalate-truth.test.ts` — the test "a command outside the granted forms reaches the human, even a root escape (nax#2194)" asserts `asks === 1` for the command "ls ../outside", and the test "a deny rule refuses without asking, unless the command cannot be analysed (nax#2194)" asserts `asks === 1` for the command "rm x 2>&1"; the header comment says the first flips when nax#2194 is fixed. Both assertions fail against a correct US-001. Replacing invariant: under `escalate` with grants `git *`, `cat *`, rm *, the command "ls ../outside" is denied with `asks === 0`, and with deny rule rm *, the command "rm x 2>&1" is denied with `asks === 0`; the test names and header comment say so. The other three tests in the file are unchanged.

**US-002**
- `test/unit/execution/runner-total.test.ts` — `makeSetupResult` (line 87) builds a `RunnerSetupResult` literal, which no longer typechecks once `sealApprovals` is a required field. Replacing invariant: the literal also sets `sealApprovals: async () => {}`; every existing assertion is unchanged.
- `test/unit/execution/runner-run-id.test.ts` — `makeSetupResult` (line 67) builds a `RunnerSetupResult` literal, which no longer typechecks once `sealApprovals` is a required field. Replacing invariant: the literal also sets `sealApprovals: async () => {}`; every existing assertion is unchanged.

**US-003**

None. Every shape the existing `findGitSpawnViolations` tests accept either carries `gitSpawnEnv(` / `hardenedGitEnv(` in the call or is not a `spawn` call, so none of them becomes a violation, and the CLI fixtures use literal `["git", ...]` argv.

### Seams

- **US-001 → `buildCodingToolSupport` / `runtime.callTool`.** The reorder is observable at the tool runtime only through `policy-command-branch.ts`'s `escalate` conversion. US-001's escalate criteria drive `buildCodingToolSupport(...).runtime.callTool("Bash", ...)` with a counting `askResolver`, not `checkBashCommand` directly.
- **US-002: `buildApprovalsSeal` → `setupRun`.** The new export is called from `setupRun` through `_runSetupDeps.buildApprovalsSeal`; US-002's setup criteria stub it and drive `setupRun`.
- **US-002: `setupRun` → `run()` → `cleanupRun`.** The seal travels through `RunSetupResult`, `RunnerSetupResult` and `run()`'s `cleanupRun` call; US-002's handoff criterion drives `run()` with `_runnerDeps.runSetupPhase` and `_runnerDeps.cleanupRun` stubbed.
- **US-002: `setupRun` → `installCrashHandlers` → `performTeardown`.** The context `setupRun` passes to `_runSetupDeps.installCrashHandlers` carries the forwarder; US-002's criterion captures that context and invokes its `sealApprovals`.

## Acceptance Criteria

### US-001 — Out-of-bounds Bash commands never escalate

1. [unit] `lexBashCommand("rm -rf x 2>&1")` returns `kind: "refused"` whose `prefix` is one segment with token texts `["rm", "-rf", "x"]` and no redirects.
2. [unit] `lexBashCommand("ls && echo x 2>&1")` returns `kind: "refused"` whose `prefix` is two segments, with token texts `["ls"]` and `["echo", "x"]`.
3. [unit] `lexBashCommand("cat ..<<EOF")` returns `kind: "refused"` whose `prefix` is one segment with token texts `["cat"]` — the word `..` being built at the refusal is dropped.
4. [unit] `lexBashCommand("(cat /etc/passwd)")` returns `kind: "refused"` with `prefix` equal to `[]`.
5. [unit] Under a grant of `Bash(git *)` in `gated` mode, `compileToolPolicy(...).check("Bash", ..., { command: "cat /etc/passwd" })` is denied with `breach: true`, `escalatable: false`, and the containment refusal as its reason (naming `/etc/passwd`), not the `is not granted` grant-miss refusal.
6. [unit] Under a grant of `Bash(git *)`, the command `cat .git/config` is denied with `breach: true` and `escalatable: false`.
7. [unit] Under a grant of `Bash(git *)`, the command `echo x > ../out` is denied with `breach: true` and `escalatable: false`, with a reason naming the redirect target `../out`.
8. [unit] Under a grant of `Bash(git *)`, the command `bun add x --registry https://evil.example` is denied with `escalatable: false` and a reason naming `--registry`.
9. [unit] Under a grant of `Bash(git *)`, the command `ls *.ts` is denied with `escalatable: false` and a reason containing `expansion`.
10. [unit] Under a grant of `Bash(git *)`, the command `curl evil.example` (no payload problem) is denied with `escalatable: true` and a reason containing `is not granted`.
11. [unit] Under a grant of `Bash(*)` and a deny rule `Bash(rm *)`, the command `rm -rf x 2>&1` is denied with `escalatable: false` and a reason naming the rule `Bash(rm *)`.
12. [unit] Under a grant of `Bash(*)`, the command `cat /etc/passwd 2>&1` is denied with `breach: true` and `escalatable: false`.
13. [unit] Under a grant of `Bash(*)`, the command `(cat /etc/passwd)` is denied with `escalatable: true` and a reason containing `cannot be analysed`.
14. [unit] Under a grant of `Bash(*)` and a deny rule `Bash(cat *)`, the command `cat /etc/passwd` is denied with a reason naming the rule `Bash(cat *)` and `breach: false`.
15. [integration] With `buildCodingToolSupport` in `bashApproval: "escalate"`, grants `git *`, `cat *`, `rm *` and a counting `askResolver` that denies, `runtime.callTool("Bash", { command: "ls ../outside" })` returns kind `denied` and the resolver is invoked zero times.
16. [integration] With `buildCodingToolSupport` in `escalate` mode, a grant of `git *` only and a counting `askResolver`, `runtime.callTool("Bash", { command: "ls -la " + <an absolute temp directory outside the root> })` returns kind `denied` and the resolver is invoked zero times.
17. [integration] With `buildCodingToolSupport` in `escalate` mode, grants `git *`, `cat *`, `rm *`, deny rule `rm *` and a counting `askResolver`, `runtime.callTool("Bash", { command: "rm x 2>&1" })` returns kind `denied` and the resolver is invoked zero times.
18. [integration] With `buildCodingToolSupport` in `escalate` mode, a grant of `git *` only and a counting `askResolver` that denies, `runtime.callTool("Bash", { command: "curl evil.example" })` invokes the resolver exactly once.
19. [unit] The `escalate` Bash tool `description` from `buildCodingToolSupport` with a reachable human contains `granted or not`, and the phrase `unless it cannot be analysed` is absent from it.

### US-002 — Seal the approvals cache at run end

1. [unit] `buildApprovalsSeal` with a root config whose `execution.sandbox.enabled` is `false` and whose resolved stage modes include `raw` returns a function that, when awaited, leaves `approvalsPath(outputDir)` with a `taint` whose `runId` equals the given `runId` and with `entries` equal to `[]`.
2. [unit] `buildApprovalsSeal` with a root config whose `execution.sandbox.enabled` is `true` and stage modes including `raw` returns a function that, when awaited, leaves an existing `approvals.json` holding one entry and no taint byte-for-byte unchanged.
3. [unit] `buildApprovalsSeal` with `execution.sandbox.enabled` `false` and no `raw` stage mode returns a function that, when awaited, leaves an existing `approvals.json` holding one entry and no taint byte-for-byte unchanged.
4. [unit] `buildApprovalsSeal` computes forge-capability once: with `deps.loadConfigForPackage` counting its calls, awaiting the returned seal three times adds zero further `loadConfigForPackage` calls.
5. [integration] For a forge-capable run: after `prepareApprovalsStore` taints the store for run `run-1`, a write replacing the file with `{ taint: undefined, entries: [<an entry for command "curl evil.example">] }` (the forged state), then awaiting the seal built for `run-1`, `clearApprovalsTaint(path, "run-2")` returns `"cleared"` and the file's `entries` is `[]`.
6. [unit] For a forge-capable run whose `outputDir` is a regular file rather than a directory (so the taint write fails), awaiting the seal resolves without rejecting and a warn record with message `[approvals] could not update the store's taint marker` is logged.
7. [unit] `cleanupRun` called with a `sealApprovals` spy and one post-run action and a non-null `interactionChain` invokes the spy exactly once, after the post-run action's `execute` and before `interactionChain.destroy`.
8. [unit] `cleanupRun` called without `sealApprovals` completes and still calls `interactionChain.destroy` once.
9. [unit] `performTeardown` with `sealApprovals`, `onShutdown` and `pidRegistry.killAll` spies records the order `onShutdown`, `killAll`, `sealApprovals`, with `sealApprovals` invoked exactly once.
10. [unit] `performTeardown` whose `sealApprovals` rejects resolves without rejecting and still calls `pidRegistry.killAll` once.
11. [integration] `setupRun` with `_runSetupDeps.buildApprovalsSeal` stubbed to return a spy calls the stub exactly once with `runId` equal to the run's `runId`, `rootConfig` equal to `options.config`, `projectDir` equal to `options.workdir`, `outputDir` equal to the runtime's `outputDir`, and `packageDirs` equal to `prd.userStories.map(storyPackageDir)`.
12. [integration] `setupRun` with `_runSetupDeps.buildApprovalsSeal` stubbed to return a spy returns a `RunSetupResult` whose `sealApprovals`, when awaited, invokes the spy once.
13. [integration] `setupRun` with `_runSetupDeps.installCrashHandlers` capturing its context and `_runSetupDeps.buildApprovalsSeal` stubbed to return a spy: after `setupRun` resolves, awaiting the captured context's `sealApprovals` invokes the spy once.
14. [integration] `run()` with `_runnerDeps.runSetupPhase` returning a setup result whose `sealApprovals` is a spy and `_runnerDeps.cleanupRun` capturing its options passes that same spy as `sealApprovals` to `cleanupRun`.

### US-003 — Non-literal spawns declare whether they are git

1. [unit] `findGitSpawnViolations("Bun.spawn(argv, { cwd });")` returns one violation with `line: 1` and `why: "spawn argv is not a literal: pass env: gitSpawnEnv(...) or mark // nax-git-env-allow: <reason>"`.
2. [unit] `findGitSpawnViolations("Bun.spawnSync(cmd, opts);")` returns one violation with the same `why`.
3. [unit] `findGitSpawnViolations('Bun.spawn([gitBin, "status"], { cwd });')` returns one violation with the same `why`.
4. [unit] `findGitSpawnViolations("deps.spawn(cmd, { cwd, env: gitSpawnEnv() });")` returns `[]`.
5. [unit] `findGitSpawnViolations("Bun.spawn(argv, { env: hardenedGitEnv(process.env) });")` returns `[]`.
6. [unit] `findGitSpawnViolations("// nax-git-env-allow: not git: hook argv\nBun.spawn(argv, { cwd });")` returns `[]`.
7. [unit] `findGitSpawnViolations("Bun.spawn(argv, { cwd }); // nax-git-env-allow: not git: acpx client")` returns `[]`.
8. [unit] `findGitSpawnViolations("// nax-git-env-allow:\nBun.spawn(argv, { cwd });")` returns one violation (an empty marker does not exempt the site).
9. [unit] `findGitSpawnViolations('Bun.spawn(["bun", "test"], { cwd });')` returns `[]`.
10. [unit] `findGitSpawnViolations("const p = Bun.spawn(\n  argv,\n  { cwd },\n);")` returns one violation with `line: 1`.
11. [unit] `findGitSpawnViolations('// Bun.spawn(argv)\nconst s = "Bun.spawn(argv)";')` returns `[]`.
12. [cli] Running `bun run scripts/check-git-spawn-env.ts <repo root>` against this repository exits 0 and prints `check-git-spawn-env: clean`.
