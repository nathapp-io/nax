# ADR-030: Bash Approval Modes

**Status:** Accepted
**Date:** 2026-09-22
**Author:** William Khoo, Claude
**Builds on:** ADR-029 (Phase C scope and constraints), ADR-028 (native sessions and the pull-tool loop)
**Amends:** ADR-029 §3 — see the 2026-09-22 amendment appended to that section
**Design:** `docs/superpowers/specs/2026-09-22-bash-approval-modes-design.md`
**Implementation:** P1 modes merged in PR #2184 (`7b37dbf74`); P2 ask-tier resolver chain on branch `feat/p2-interactive-approval-gate` (PR/merge pending) — plan at `docs/superpowers/plans/2026-09-22-p2-interactive-approval-gate.md`

---

## Context

ADR-029 §3 shipped a bash gate that is **safe-by-refusal**. A model-authored command runs only
where a human wrote a `Bash(...)` allow rule for that stage; every segment must match; and any
construct the lexer cannot read — command and process substitution, backticks, here-documents,
fd duplication, unbalanced quotes, brace and glob expansion — is refused by name. That gate is
enforced in one place (`src/tools/policy-bash.ts`) and is tested by a deny suite that ADR-029
correctly calls the feature's acceptance spine.

The posture was chosen deliberately and it has held. What has changed is that the cost of it is
now measured rather than assumed.

**Cost 1 — the gate makes the agent read more.** An agent that cannot pipe, filter or redirect
cannot reduce a large output before it enters the transcript. It reads whole files instead of
grepping them, and re-reads them instead of diffing. Tool-result bytes are the dominant driver
of transcript growth on the native path, and transcript growth is what the run pays for on
every subsequent turn.

**Cost 2 — some operations are not expressible at all.** ADR-029 §3's own 2026-09-14 amendment
recorded this trigger firing for the fix-shaped roles and shipped `Bash` for them. A later
measurement found the same shape in a role that did *not* get a shell: a verifier session issued
**13 sequential `Git` tool calls** to walk history and hit **3 hard failures** attempting
`git log --all`, `git diff --stat` and `git show -1` — none of which the typed `Git` tool can
express. The verifier has no way to ask for them, and correctly cannot be handed a shell
(ADR-029 §3, ruled 2026-09-14). That case is **not** addressed by this ADR and remains open.

## Decision

Introduce a mode axis, config key `bashApproval`, resolved per stage in
`resolvePermissions()` and compiled into the policy.

| mode | behaviour |
|---|---|
| `gated` | ADR-029 §3 behaviour, unchanged: lexer refusal → deny; deny rules; per-segment allow matching; payload and containment guards; ask rules. Bash is offered for the stage only when a SINGLE `Bash(...)` allow rule resolves for that stage in `permissions.<stage>.allow` — see [§ Inert stages](#inert-stages) below. |
| `escalate` | `gated`, except a denial the gate could not **adjudicate** resolves to the `ask` tier instead of `deny`. Same rule requirement as `gated`: a `Bash(...)` allow rule per stage is required for the tool to be offered at all — without one, nothing ever reaches the ask tier because nothing is ever offered to escalate. |
| `raw` | Pass-through. No lexer refusal, no per-segment grant matching, no root containment. One exception: a best-effort protected-path screen. |

**The default is `raw`.**

### Inert stages

Under `gated` and `escalate`, the Bash tool is offered for a stage only when the stage's
resolved grants contain a `Bash` entry — and that entry comes solely from a human-written
`Bash(...)` allow rule. Nothing else in nax grants Bash: see `unconditionalGrants` in
`src/config/permissions.ts` and the deny suite at
`test/integration/permissions/bash-deny-suite.test.ts`. A stage that declares the Bash tool
while its resolved grants hold no `Bash` entry is therefore *inert* — the mode is configured,
the tool is never offered, and nothing can escalate.

The warning lives in `src/execution/lifecycle/run-setup-warnings.ts` as `warnInertBashStages`,
called once from `setupRun` next to `warnFallbackMisconfiguration`. It reads
`resolvePermissions(config, stage)` directly — the same grant list `resolveBashSupport` searches
— so the warning and the tool offer cannot disagree. A single warning is emitted per inert stage
under stage `"permissions"`, with `storyId: "_setup"`, the inert `stage`, and `bashApproval` in
the data object, and a message that names the rule that would fix it:

```
bashApproval "escalate" on stage "run" grants no Bash (no Bash(...) allow rule)
  -- the agent is not offered Bash, so nothing can escalate.
  Add one rule: "allow": ["Bash(ls *, cat *, git status*)"]
```

The warning is logged, never raised: `gated` without a `Bash(...)` rule is a legitimate "no shell"
posture. It is only worth saying out loud because the alternative reading — "the agent can ask,
and a human approves" — is what the mode name suggests and is not what happens.

The rule that un-inerts a stage is a single expression in the stage's allow list:

```jsonc
"permissions": {
  "run": { "allow": ["Bash(ls *, cat *, git status*)"] }
}
```

One expression per stage, by design: a second `Bash(...)` entry in the same allow list is a
config load error (Bash is granted by exactly one rule per stage, not by union). The detector
mirrors the `stage` field of the nine operations that declare `Bash` — `implementerOp` /
`testWriterOp` (run), `rectifyOp` (review), the four rectification ops, and the two acceptance
fix ops — through the `BASH_DECLARING_STAGES` constant, so the warning never fires on a stage
that cannot declare Bash in the first place.

### Why `escalate` splits denials in two

`checkBashCommand` denies for two materially different reasons, and only one of them is a
question a human can usefully answer.

- **Category A — the gate could not adjudicate.** The lexer refused the command, or no allow
  rule covered a segment. The command may be perfectly fine; the gate simply cannot tell.
  **These escalate.** The deny matcher and the payload checks run *first*, and on a refused
  command they run over the lexer's `prefix` — the completed segments and completed tokens
  before the unreadable construct, with the in-progress word dropped. So a refused command
  whose lexable prefix matches a deny rule or breaches containment is a Category B denial, not
  a Category A one; only a refusal whose prefix is clean (or empty, when the refusal precedes
  any completed word) escalates. Everything past the construct is not lexed and is shown to
  the human as part of the full command.
- **Category B — the command is affirmatively out of bounds.** A path resolves outside the
  permitted root, a `.git/` refusal, a `DENIED_FLAGS`-class flag, an explicit deny rule, a
  redirect or `cd` target outside the root. **These never escalate.**

A Category B denial carries `breach`, which `src/tools/runtime.ts` logs as a possible prompt
injection. Escalating it would dissolve that signal into an approval prompt and invite a
reflexive yes to a root escape. The distinction is carried in the data — an `escalatable` flag
set at exactly the two Category A sites — never inferred from message text, because reason
strings are prose and prose drifts.

### Why `raw` is compiled in, not applied afterwards

`checkBashCommand` lexes **before** it evaluates grants. A `Bash(*)` wildcard therefore cannot
produce pass-through; the lexer refuses first. And converting a denial to an allowance *after*
the check would be a widening transform that could not distinguish a lexer refusal from a
containment breach without matching on reason text — it would silently widen path-escape
denials. So the mode reaches `compileToolPolicy` as an input and the Bash branch dispatches on
it. One gate, deterministic, fully covered by the deny suite.

### The protected-path screen

Under `raw` the lexer still runs, advisorily. If it **can** parse the command and a segment
names or redirects into a path nax owns — `.nax/config.json`, `.nax/mono/*/config.json`,
`.nax/features/**/prd.json`, the root queue-control files — the command is denied. If it
**cannot** parse the command, the command runs.

A parseable `cd` moves every later segment's frame of reference, so the screen tracks it
across segments (shared with the gated path via `src/tools/bash-cwd.ts`). Where the gated
policy REFUSES a `cd` it cannot model — an option-shaped target, an opaque one, one leaving
the root — this screen must not, or `raw` has re-gated itself through the back door of `cd`
modelling. Instead the frame set holds its last known value and screening continues. Failing
open on the `cd` must never mean abandoning the screen for the rest of the command: that
would make any everyday idiom a skeleton key (`cd - ; echo ABORT > .queue.txt`), which is
strictly worse than pinning every candidate to the initial directory.

**This screen is advisory by construction and must never be described otherwise.** Six gaps
are known and accepted, not defects to be closed:

1. A command using substitution is not parsed, and therefore is not screened:
   `sh -c "$(echo rm) .nax/features/f/prd.json"` passes straight through.
2. After an unmodellable `cd` the tracked frame is an ESTIMATE, so the screen can refuse a
   write the shell would in fact have placed somewhere harmless. A false refusal costs one
   turn and states its reason; a false pass can abort the run, so the trade is deliberate.
3. That same estimate admits a residual miss in the other direction: an unmodellable `cd`
   INTO a protected directory (`cd -P .nax && echo x > config.json`) is screened against the
   pre-`cd` frame and passes. Closing it would require modelling every `cd` form, which is
   the containment gate `raw` exists not to be.
4. The screen matches exact file paths. A directory target (`cp evil/config.json .nax/`,
   `cp -R evil/ .nax`) or a glob (`.nax/confi?.json`) names no protected file and passes.
5. Writers that take the target as an option or a nested script are not modelled:
   `tar -C .nax -xf x.tar`, `dd of=.nax/config.json`, `sh -c 'echo x > .nax/config.json'`.
6. A symlink alias (`ln -s .nax n && echo x > n/config.json`) passes: the screen does not
   resolve links.

It catches a naive mistake at near-zero cost, which is exactly the threat model below. It is
not a boundary, and it must never be grown into a general gate — gating lives in policy, once.

## Consequences

**`raw` by default removes the only mechanical boundary around a bash call.** ADR-029 §3 already
recorded that no OS-level sandbox exists: *"a granted command runs with the privileges of the
nax process, inside the permitted root. The gate bounds WHICH commands run and WHERE their
paths may point; it does not contain what a granted command then does."* Under `raw`, the
second sentence no longer holds either. The gate bounds neither which commands run nor where
their paths point. A `raw` bash call runs with the privileges of the nax process and may write
anywhere that process can reach, inside the repository or outside it.

Anyone reading this section for a containment guarantee should read that paragraph twice.

This is accepted under a threat model of **agent mistakes, not hostile repository content** —
destructive deletes, out-of-repo writes, global installs — on repositories the operator already
trusts. Hostile repository content is not in the threat model and this ADR does not change that.

Two properties bound the blast radius, and neither may regress:

1. **An operation that does not declare `Bash` receives no shell under any mode.** The tool is
   constructed only when the op declared it, and the synthetic grant that `raw` introduces is
   conditioned on that same declaration. Review operations and the verifier declare no `Bash`,
   so no mode hands them one. This is the narrowing that survives — structural rather than
   configured.
2. **The deny path stays deterministic and fail-closed.** `src/tools/bash.ts` still gates
   nothing; an unrecognised permission profile resolves to `gated`, not `raw`.

**`escalate` ships against the existing deny-always resolver.** The `AskResolver` seam's only
implementation refuses (ADR-029 §3's reopen condition). So `escalate` refuses in exactly the
cases `gated` refuses, and differs only in the ledger outcome it records: `denied:ask` rather
than `denied`, with the original denial reason attached (a Category-A denial matched no rule;
the runtime records `verdict.rule ?? verdict.reason`). That difference is the metering ADR-029 §3 asks
for before an interactive approval channel is built. The measured baseline before this change is
**zero** such rows.

### The alternative that was considered and rejected

**Defaulting to `gated`, with `raw` opt-in per stage.** This was recommended during design: it
carries zero regression risk, it keeps the mechanical boundary until a sandbox exists, and it
makes the posture change explicit at each site that wants it.

It was rejected because it would ship the capability and give it to nobody. The costs in the
Context section are paid on *every* run by default; an opt-in default means they keep being paid
until each stage is individually migrated, and the arc's premise — that full shell power is a
token-economy fix as much as a capability fix — would go untested in practice. The operator
accepts the blast radius above for trusted repositories, and prefers to measure the real
posture rather than a conservative one nobody enables.

The conservative posture remains one config key away, per stage, and an unrecognised profile
still fails closed to `gated`.

### What this does not decide

- **OS-level sandboxing.** Still out of scope and unclaimed, as in ADR-029 §3. It is the
  intended precondition for `raw`: once a sandbox ships, the expectation is that `raw` requires
  it and refuses — naming the fallback — when it is unavailable, rather than silently
  downgrading. Until then, `raw` is a posture choice made with the blast radius stated above.
- **Any interactive approval channel.** `escalate` exists to produce the demand signal, not to
  consume it.
- **Model-based auto-approval.** A later classifier attaches at the post-allow seam, narrowing
  allow → ask. It is not part of this decision.
- **Per-role permission overrides.** `resolvePermissions` takes a stage, not a role, and the
  verifier exclusion is enforced by op-level tool declaration instead. No role axis is built.
- **The verifier's inexpressibility.** ADR-029 §3 left it open with a stated bar — *"a concrete
  verify-stage need that no declared command can express, and a gate narrower than 'the verifier
  may run commands of its own'."* The 13-call, 3-failure measurement in the Context section is a
  concrete instance of the first half. The narrower gate would be a richer typed `Git` surface,
  not a shell. That decision is deferred pending measurement after this ships, because `raw`
  changes nothing for the roles that never declare `Bash`.

---

## Amendment — 2026-09-22: the ask tier gets a resolver (P2)

**Supersedes:** the "Any interactive approval channel" bullet under "What this does not decide".
`escalate` no longer only produces a demand signal; P2 builds the channel that consumes it.

Phase 2 of the native-coding-agent arc shipped on branch `feat/p2-interactive-approval-gate`
(PR/merge pending). This ADR is amended because its central claim about `escalate` — that it
refuses in exactly the cases `gated` refuses, and "differs only in the ledger outcome it records"
(Consequences) — is no longer true.

### The resolver is now a chain, and the single permission decision point

The `AskResolver` seam now has a real implementation: `chainAskLinks(...)`
(`src/permissions/ask-chain.ts`), a first-non-abstain chain that appends its OWN terminal deny.
It is the ONE decision point for the ask tier; the interaction channel is not a peer of it — the
human link talks to the channel. The chain, in order:

1. **approvals cache** (`createApprovalsLink`) — a remembered human decision, matched byte-exact
   on `(stage, command)`. A hit allows as `decidedBy: "cache"`.
2. **[P5 classifier slot]** — reserved and empty. P5's typed-decision auto-approval attaches here,
   narrowing allow → ask. Not part of P2.
3. **human** (`createHumanAskLink`) — an adapter that renders the request into the interaction
   subsystem's existing `choose` vocabulary and dispatches through the configured chain. Resolves
   `human` on a tap, `timeout` when nobody answers, `unavailable` when no channel is configured
   or the command exceeds the prompt budget. Before prompting, the human link masks inert secret
   spans in the command; when a secret span would contain shell syntax it denies without
   prompting, attributed `unshowable` (review #9).
4. **terminal deny** — appended by the chain itself, so an exhausted or all-abstaining chain
   denies whether or not the last link is total. A link that throws abstains, never allows.

Fail-closed by construction: an empty chain (`chainAskLinks([])`) denies as `unavailable`,
preserving `headlessAskResolver()`'s old totality.

### `escalate`'s advertised description was revisited and deliberately kept conservative

During P1, `escalate`'s Bash tool description was byte-identical to `gated`'s *because the
resolver always denied* — advertising a human channel would have been false. That reason has now
expired: the resolver is real and a human can approve.

It was revisited and deliberately kept byte-identical anyway. `bashToolDescription(shell, opts)`
knows only the mode and the configured patterns; it cannot see whether an interaction channel is
configured, which is a SEPARATE config axis. Reachability is config-dependent: a headless or
unconfigured run resolves to `unavailable` and denies. Advertising "a human can approve" from the
mode alone would be false in exactly those runs — the D13a fail-open shape stated in prose. The
pin test (`test/unit/agents/coding-tool-bash.test.ts`) that asserts `escalate`'s description
equals `gated`'s therefore stays.

**The default remains `raw`.** This amendment adds a consumer for `escalate`'s demand signal; it
does not change the posture chosen above, and it does not change the default.

### The approvals cache's trust boundary

A remembered approval is a CACHED HUMAN DECISION, not a rule: a synthesized `Bash(...)` rule would
be broader than what was approved, because rule matching is a token-wise prefix match with no
length ceiling (`src/tools/policy-bash.ts:72-83`). The cache is therefore a resolver-side
byte-exact link, never a grant. Grants are listed and revoked with `nax approvals`, which never
clears a taint.

Living outside `repoRoot` protects the approvals file from the typed path-bearing tools but **not
from Bash**: `src/tools/nax-owned-writes.ts:52-58` excludes Bash by design, and under `raw` mode
`screenRawBashCommand`'s protected-path screen skips every path outside the root
(`src/tools/policy-bash-raw.ts:84`). A `raw` shell can forge entries. That is not a new
vulnerability — a `raw` shell needs no forged permission to run a command — but it IS a
cross-stage escalation in a MIXED-mode run, where a `raw` stage poisons the cache an `escalate`
stage later trusts.

Two fail-closed preconditions bound that, both implemented in `createApprovalsLink`:

1. **No stage in the run resolves to `raw`.** If any does, the cache disables itself.
2. **The approvals file must lie outside `repoRoot`.** If it resolves inside, the cache disables
   itself.

Both fail by **abstaining**, which escalates to the human, so a failure costs prompts rather than
safety. Integrity signing was deliberately not attempted: any key the nax process can read, a
`raw` shell as that process can read. P4's sandbox closes the underlying hole; disclosed, not
fixed. Both preconditions see only the current run; entries left by an EARLIER run are
covered by the taint marker described under the P4 amendment's "Cross-run provenance".

---

## Amendment — 2026-09-23: the sandbox backend (P4)

**Supersedes:** the "OS-level sandboxing" bullet under "What this does not decide". The intended
precondition for `raw` is now implemented, and that bullet's stated expectation — `raw`
requires it and refuses, naming the fallback, rather than silently downgrading — is the posture
below.

Phase 4 of the native-coding-agent arc shipped on branch `feat/p4-sandbox-backend` (PR/merge
pending). Design: `docs/superpowers/specs/2026-09-23-p4-sandbox-backend-design.md`. The default
flip is not part of this phase.

### Decision

`execution.sandbox` wraps the two agent-authored spawn sites — Bash and RunCommand `Exec` — in
an OS sandbox behind a `SandboxBackend` interface (`src/sandbox/`); srt
(`@anthropic-ai/sandbox-runtime`, pinned exactly `0.0.77`) is the first backend, and a
container backend would implement the same interface without touching a call site. Opt-in
(`enabled: false`) until the P4 exit runs; the flip to default-on is a separate change. The
launcher is handed to those two sites and nothing else, so nax's own declared-command runs
(quality commands, acceptance, worktree installs) cannot be wrapped — D14 holds by
construction — and the launcher changes HOW a command runs, never WHETHER: the single-gate
rule is preserved.

### Posture when enabled

`raw` requires the sandbox. If the probe finds it unavailable, every raw Bash call is refused
with a reason naming `gated`/`escalate` — a policy verdict compiled in
(`src/tools/policy-command-branch.ts`), not a runtime downgrade — and the tool description says
the same, so the model does not spend a turn discovering it. `gated`/`escalate` run unwrapped
with one warning per process; their mechanical gate is still the boundary. No mode silently
changes posture in either direction. The probe is a real wrapped command that also proves
enforcement (an allowed write lands, a denied write does not), never a dependency check: a
sandbox that runs but does not enforce is treated as absent.

### Threat model unchanged (D1)

The sandbox is a blast-radius limiter for the agent's own mistakes, not a security boundary
against hostile repository content. Network is open by default for that reason; an allow-list
(`network.allowedDomains`) exists, but the default posture bounds writes and credential reads,
not egress.

### Literal paths, and why

srt on Linux silently drops glob `denyWrite` entries, logged at debug only — a glob deny is a
guarantee that exists on macOS only. Every policy path is therefore literal and
`realOrRaw`-resolved; the builder never emits a glob character, and the policy is rebuilt per
call so a feature directory created mid-run still gets its `prd.json` deny.

### Worktrees

From a worktree, `git commit` needs the git common dir writable, which strips srt's hook guard
(scoped to the cwd's `.git`). The policy adds the common dir as a write root and denies
`<common>/hooks`, `<common>/config` and every worktree pointer file explicitly. Known
limitation, recorded so nobody later calls it a regression: an agent mistake can move other
refs in the common dir (`refs/`, `packed-refs`). Accepted under D1 — hooks and config, the
code-execution paths, are what is denied.

### Two disclosed holes close when sandboxed

D13a gap 3 — the screen's third accepted gap, an unmodellable `cd` into a protected directory
followed by the protected write — is blocked by containment instead of an estimated frame. The
P2 approvals-cache forgery closes because the approvals file is ALWAYS write-denied (its
`outputDir` is configurable and can land inside a write root, so "outside the roots" was never
the guarantee). The cache's raw precondition relaxes accordingly: disabled only when a stage
resolves to `raw` AND the sandbox is disabled — config-only, no dependency on the probe, since
an enabled sandbox leaves `raw` either wrapped or refused outright. Unsandboxed, both holes
remain disclosed, not fixed.

**Cross-run provenance (#2199).** Both preconditions above read only the CURRENT run's
config, but `approvals.json` is project-scoped and outlives the run: an earlier `raw`,
unsandboxed run could append an entry that a later `escalate` + sandbox run then honours as
`decidedBy: "cache"`. Signing entries does not fix this for the reason already given — an
unsandboxed same-user shell can read any key nax can. Instead nax, from its own process and
at points where no agent of that story runs, keeps a taint marker in the store
(`src/permissions/approvals-taint.ts`):

- a forge-capable run (any stage `raw` with the sandbox off) drops every entry and writes
  `taint` before each story's agents start, and again after they finish;
- the cache link abstains on a tainted store, re-reading it on every ask;
- a run that trusts the cache clears the taint before its link is built, discarding the
  entries beside it rather than promoting them, unless the tainting run may still be
  writing (the same run, via a sibling story in a forge-capable package, or another nax
  process that is still alive).

Entry `root` must also be the project root or lie inside it (worktrees and package dirs
do). That is hygiene against a shared `outputDir`, not authentication: a forger sets `root`.

Residual, disclosed: this defeats an agent that forges entries during its story, not a
hostile one that knows the scheme — a process it leaves running past the story's end
re-taint, a run killed between an agent stripping the marker and that re-taint, and
agents in a forge-capable run that are not dispatched inside a dispatch-ask scope (e.g.
acceptance generation) can all still leave trusted-looking entries. The execution stage,
the acceptance-fix loop, the deferred regression gate and `nax finish` all taint and
re-taint through `buildDispatchAskWiring` (#2201). An unsandboxed `raw` shell can equally edit
shell rc files or git hooks; the sandbox, which always write-denies the file, remains the
boundary.

### Environment

srt's returned `env` is `process.env` itself; applied as a `runArgv` overlay it re-adds every
stripped secret (reproduced during the design review). It is discarded. `stripEnvVars` applies
exactly as before, and the launcher forwards only the caller's own env overlay.

### Platform requirements

macOS: `sandbox-exec` (built in). Linux: `bwrap`, `socat`, `rg`; in a container
`--security-opt systempaths=unconfined` or the probe reports unavailable; on Ubuntu 24.04
`kernel.apparmor_restrict_unprivileged_userns=0`. Windows: unavailable (probe). The live suite
runs in CI with bubblewrap, socat and ripgrep installed and `NAX_SANDBOX_REQUIRED=1`; nothing
beyond the requirements above was needed — the first PR CI run passed the live suite 9/9 on
Linux (2026-09-23).

## Amendment — 2026-09-23: `escalate` describes escalation when a human is reachable

**Supersedes:** "`escalate`'s advertised description was revisited and deliberately kept
conservative" (2026-09-22 amendment, above). The pin that `escalate`'s description equals
`gated`'s now holds only when no human is reachable.

### Why the conservative wording was dropped

That amendment kept `escalate` byte-identical to `gated`, telling the model "anything else is
refused". Its reason was mechanical: `bashToolDescription` could see only the mode and the
patterns, not whether an interaction channel exists, and promising a human in a headless run
would be the D13a fail-open shape stated in prose.

The reason was a missing input, not a design limit. P4 had the same shape for the sandbox
(availability resolved once, passed to the tool as data), and reachability is resolved the same
way. The cost of the conservative wording was measured in the P2 exit runs (2026-09-23): across
two `escalate` runs totalling about 2¼ hours of agent time, only **6** commands reached the
human. The agent, told everything else is refused, composed around the grant instead of
producing the Category A denials that are `escalate`'s entire output and P5's training corpus.

### Decision

- The execution stage marks its `AskResolver` with `humanReachable`: true when the run has an
  interaction chain (`ctx.interaction` present) and, for the `cli` plugin, stdin is a TTY.
  `initInteractionChain` already returns none for a headless CLI run and for an unconfigured
  one, and a `cli` chain without a TTY stdin never opens readline, so all of these resolve false.
  Every other `AskResolver` (the headless default used outside the execution stage) leaves the
  flag absent, which reads as false. One known over-promise remains and fails closed: Telegram
  with a non-numeric `chatId` gets a chain but can never match a reply, so every ask times out.
- `buildCodingToolSupport` forwards it to the Bash tool as `humanApproval`. Only `escalate`
  reads it.
- **Reachable:** the description states `checkBashCommand`'s actual evaluation order. Every
  command, granted or not, is checked first: a path outside the root, `.git/` access, a denied
  flag, an unexpanded `$VAR`, glob or brace characters, `~`, a bare `cd`, or a command matching a
  deny rule is refused without asking, and for a command using a construct that cannot be analysed
  these checks cover the part before that construct. A command outside the granted forms, or one
  using a construct that cannot be analysed (an option-shaped `cd` among them — the gate cannot
  model where it lands, so it too is Category A), is sent to a human and, if allowed, runs exactly
  as written. The model is told to prefer the granted forms. A test pins these claims against the
  policy (`coding-tool-bash-escalate-truth.test.ts`).
- **Not reachable:** byte-identical to `gated`, as before.
- The verdict path is unchanged. The flag shapes only the description; a channel that fails
  mid-run still resolves `unavailable` and denies, so an over-promising description fails
  closed.

### Consequences

- More prompts reach the human in `escalate` runs. That is the mode's purpose, and it grows the
  P5 corpus.
- Runs before and after this change are not comparable on escalation counts or Bash usage under
  `escalate`.
- `escalate` still offers no Bash at all without a human-written `Bash(...)` allow rule
  (ADR-029 §3); nax#2192 tracks documenting and warning about that.

## Amendment — 2026-09-23: the command-safety shadow (P5)

**Context.** The master plan's D4 planned an in-process typed-decision model whose live
end-state auto-approves high-confidence commands. Zero-shot measurements on shell commands
showed no threshold that auto-approves a useful share of harmless commands without also
letting dangerous ones through; used as a flag on top of rules, a model adds catches.

**Decision.**
1. The end-state target (called A) is a **flag-for-review guardrail**: a flagged, mechanically
   allowed command is narrowed to `ask` at the post-allow seam. It never grants. A requires its
   own spec and the user's sign-off on the P5 eval report.
2. P5 ships a **shadow only**. Every agent-authored `Bash` / `Exec` command in a runtime that
   receives the ask resolver is classified by a deterministic rule scorer and by a typed-decision
   model over a generic SystemOne HTTP endpoint, and one row per call is written to
   `<outputDir>/command-safety/<runId>.jsonl` beside the mechanical verdict and the ledger
   outcome. It is off by default (`execution.commandSafety.shadow` absent).
3. **Transport** is a configured URL, **loopback only** unless `allowRemote: true`, enforced in the
   config schema. nax carries no model runtime.
4. The ask-tier model link stays reserved and empty.

**What stops on failure** (never the call): a hanging, failing or malformed classifier stops the
row's model half (`unavailable`); a failing rule scorer stops the rule half; a failed append stops
that row; `drain()` is bounded by one timeout per story and writes whatever is pending.

**Consequences.** The single-gate rule holds: nothing in the policy reads the shadow. Coverage is
the ask resolver's coverage (execution-stage operations); rows report it. Whatever serves the URL
may forward commands elsewhere; nax cannot see that, and the loopback rule guarantees only that
nax itself opens no remote connection.

---

## Amendment — 2026-09-25: the sandbox is on by default

**Supersedes:** the P4 amendment's "Opt-in (`enabled: false`) until the P4 exit runs; the flip
to default-on is a separate change." This is that change.

The P4 exit runs passed on 2026-09-23 with `sandbox.enabled` + `raw` (every agent Bash call
wrapped, no protected or out-of-root write), so `execution.sandbox.enabled` now defaults to
`true`. The default posture is therefore **raw bash inside the sandbox**, which is the end state
the P4 amendment named. Nothing else about the posture changes: when the probe finds the
sandbox unavailable, `raw` refuses with a reason naming `gated`/`escalate`, and those modes
run unwrapped with a warning. A host without a working sandbox (for example Linux without a
usable bubblewrap) now sees that refusal by default rather than unsandboxed raw bash; setting
`execution.sandbox.enabled: false` restores the previous behaviour explicitly.

The approvals-cache precondition is unchanged in rule — the cache abstains while any stage is
`raw` AND the sandbox is disabled — but with the new default a `raw` run keeps the cache
enabled unless a config turns the sandbox off.

The same change makes the native agent the default (ADR-027 amendment of the same date).

---

## See also

- ADR-031: the bash approval mode, approval timeout, sandbox and command-safety keys are root-scoped.
