# Command interception for the native agent, with rtk as first consumer

Design only. Status: **design approved, not yet implemented.** No code changes are to be
made against this spec while the import-cycles refactor is in flight.

Companion spec: `2026-09-13-nax-mcp-client-design.md`. The two share no files and may land
in either order, but see §3 R5 for one mechanism they both need.

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

- **`RunCommand`** (`src/tools/run-command.ts:226-363`) — the model names a *key* from
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

Site 1 is the highest-value by a wide margin: it is one function covering both the
harness's own gates and the agent's only shell-reaching tool.

### 2.4 What rtk offers

- **`rtk rewrite "<cmd>"`** — a real integration API with an exit-code protocol:
  `0`+stdout = rewritten, `1` = no equivalent, `2` = deny rule matched, `3`+stdout =
  rewrite but ask. This is what every other agent's PreToolUse hook consumes, and it is
  what site 1 and 2 should use rather than blindly prefixing `rtk`.
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

**R4 — rtk's recovery hints are stripped.** A nax agent has no shell and no `noCompact`
field, so `[full diff: rtk git diff --no-compact]` and `[+N hidden: rtk recall <hash>]`
are instructions it cannot follow. Passing them through reproduces nax#1800's failure
mode (prompts implying a shell that does not exist) and burns turns on denials.

**R5 — The recall escape hatch is a tool contributed by the interceptor**, not a nax
built-in. Otherwise "generic seam" is fiction and nax hard-depends on rtk.

This needs the same mechanism as the MCP spec: **externally-provided tools injected
through `extraTools` (`src/tools/runtime.ts:90`) with dynamic names and config-driven
grants.** Whichever spec lands second reuses the first's plumbing rather than building a
parallel one. This is the only coupling between the two specs.

**R6 — Rewrite output is validated against nax's own escape-flag ban.** rtk accepts git
global options nax deliberately refuses (`-C`, `-c`, `--git-dir`, `--work-tree`,
`--exec-path` — `GIT_ESCAPE_FLAGS`, `src/tools/git.ts:180`; `-c` is included because
`-c core.pager=<cmd>` is code execution). A rewrite that changes cwd or introduces one of
these is rejected. nax runs stories in parallel worktrees, where targeting the wrong tree
fails silently rather than loudly.

**R7 — Opt-in.** `enabled: false` by default. Interception changes what the agent sees;
it should not switch on because a binary happens to be installed.

**R8 — Measurement decides the verb table.** `sites` and `git.verbs` ship conservative and
are opened by US-001's data, not by this document's assertions.

## 4. Design

### US-001 — Measurement harness

**First story, and a gate on the rest.** Build a corpus from real data, not invented
commands:

- `quality.commands` specs from the repos nax actually runs against
- real argv shapes mined from existing tool-audit ledgers, which already record every
  `Git` and `RunCommand` invocation (`src/tools/tool-audit.ts`)

Run each raw and through rtk, recording:

| Metric | Why |
|---|---|
| bytes before/after | the headline |
| bytes after nax's 40 000-byte slice | **the number that matters** — reducing 2 MB to 200 KB buys nothing when both get cut to 40 KB |
| **exit-code parity** | a correctness gate, not a savings metric. Any divergence disqualifies that verb outright |
| output-equivalence class | identical / reduced-but-faithful / restructured |
| wall-clock delta | rtk adds a process hop |
| SQLite contention under parallel invocation | H5 below; rtk writes tracking rows on every call and nax runs parallel worktrees |

Output is the per-verb table that populates `sites` and `git.verbs`.

**Stated expectation, so the data can falsify it:** sites 1 and 2 carry nearly all the
value; `git diff` and `show` carry some; `status`, `log --name-only` and `blame` carry
none. If that holds, `git.verbs` ships `["diff","show"]`. If the measurement disagrees,
the measurement wins.

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
```

A rewritten result must match the request's shape. Validation per R6 runs on every
rewritten result before it reaches a spawn.

**Acceptance:** a fake interceptor returning `unchanged` leaves every call site
byte-identical to today; a fake returning a shape mismatch is rejected; a fake introducing
`-C` is rejected.

### US-003 — Wiring the three sites

- **Site 1**, `src/quality/runner.ts:150-165` — intercept between command resolution and
  the `/bin/sh -c` spawn. Covers `RunCommand` and every harness gate at once. Reuses
  `_qualityRunnerDeps.spawn` for test injection.
- **Site 2**, `src/verification/executor.ts:85-125` — same shape.
- **Site 3**, `src/utils/git.ts:71-91` — argv shape, gated by `git.verbs`.

`GitCommit` is included at site 3 only if US-001 shows a benefit; rtk's `run_commit`
inherits stdin for editor/GPG/credential-helper prompts, which is correct behaviour but
interacts with nax's timeouts.

**Acceptance:** with the interceptor disabled, all three sites produce byte-identical
behaviour to today, proven by tests that do not reference rtk.

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
3. **Preserve the recall hash** out-of-band, for US-006.

**Acceptance:** no rtk hint string survives into a tool result; a truncated `RunCommand`
result carries a marker; a non-truncated one does not.

### US-006 — The recall tool

An interceptor-contributed tool (R5) exposing `rtk recall <hash>`, so the escape hatch is
expressible rather than a dead end. Gated by config and by the policy layer like any other
tool, injected through `extraTools`.

Dependent on the externally-provided-tools mechanism shared with the MCP spec. If the MCP
spec lands first, this reuses it; if this lands first, MCP reuses it.

**Acceptance:** a hash from a stripped hint can be retrieved through the tool; an
ungranted call is denied like any other tool; with the interceptor disabled the tool is
not advertised.

### US-007 — Config

```json
{
  "execution": {
    "commandInterceptor": {
      "provider": "rtk",
      "enabled": false,
      "sites": ["quality", "verification"],
      "git": { "verbs": [] },
      "failuresBeforeDisable": 3
    }
  }
}
```

One interceptor, not a list — a second provider can widen the schema when one exists.
`.strict()`, mounted in the existing `execution` block, documented in
`src/cli/config-descriptions.ts`.

**Acceptance:** default config leaves behaviour unchanged; an unknown key fails with
`CONFIG_SCHEMA_INVALID`; `sites: []` disables interception without disabling the provider.

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
| H7 | **stdin.** rtk's filtered modes default stdin to null; `rtk proxy` does not wire it at all | Sites 1 and 2 never use stdin. Site 3's `GitCommit` does, which is why it is gated on US-001 |

## 6. Sequence

US-001 (measurement) gates everything — it decides whether sites 2 and 3 are worth wiring
at all. US-002 (interface) → US-003 (sites) → US-004 (provider) is then a chain, with
US-007 (config) alongside US-002. US-005 depends on US-004. US-006 depends on US-005 and
on the shared externally-provided-tools mechanism (R5). US-008 lands with US-003.

The first end-to-end verifiable slice is US-004 against site 1 only.

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

- **ACP.** Sites 1 and 2 are harness-side and shared, but the tool-facing half of this
  design (site 3, US-005, US-006) is native-only by construction — coding tools never
  reach the ACP adapter. No ACP-specific guard is added.
- **A second interceptor provider.** The schema admits one; widening it is cheap when a
  real second consumer exists.
- **`rtk init` / rtk's own hook installation.** nax calls rtk as a library-shaped CLI; it
  does not participate in rtk's hook-installation flow, and must not write to the user's
  agent settings files.
- **Rewriting `Exec`** (`src/tools/run-command-exec.ts`). Its no-shell guarantee is
  structurally enforced by a test that reads the file whole; routing it through a rewriter
  would weaken a deliberate security property for an unmeasured gain.
- **`rtk pipe`, `rtk learn`, `rtk discover`, `rtk gain`** and the rest of rtk's analytics
  surface. Only `rewrite`, `recall`, `--version` and the filtered command verbs are used.
