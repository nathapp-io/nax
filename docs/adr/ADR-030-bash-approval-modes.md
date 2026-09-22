# ADR-030: Bash Approval Modes

**Status:** Accepted
**Date:** 2026-09-22
**Author:** William Khoo, Claude
**Builds on:** ADR-029 (Phase C scope and constraints), ADR-028 (native sessions and the pull-tool loop)
**Amends:** ADR-029 §3 — see the 2026-09-22 amendment appended to that section
**Design:** `docs/superpowers/specs/2026-09-22-bash-approval-modes-design.md`
**Implementation:** none yet — plan at `docs/superpowers/plans/2026-09-22-bash-approval-modes.md`

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
| `gated` | ADR-029 §3 behaviour, unchanged: lexer refusal → deny; deny rules; per-segment allow matching; payload and containment guards; ask rules. |
| `escalate` | `gated`, except a denial the gate could not **adjudicate** resolves to the `ask` tier instead of `deny`. |
| `raw` | Pass-through. No lexer refusal, no per-segment grant matching, no root containment. One exception: a best-effort protected-path screen. |

**The default is `raw`.**

### Why `escalate` splits denials in two

`checkBashCommand` denies for two materially different reasons, and only one of them is a
question a human can usefully answer.

- **Category A — the gate could not adjudicate.** The lexer refused the command, or no allow
  rule covered a segment. The command may be perfectly fine; the gate simply cannot tell.
  **These escalate.**
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

**This screen is advisory by construction and must never be described otherwise.** A command
using substitution is not parsed, and therefore is not screened:
`sh -c "$(echo rm) .nax/features/f/prd.json"` passes straight through. It catches a naive
mistake at near-zero cost, which is exactly the threat model below. It is not a boundary, and
it must never be grown into a general gate — gating lives in policy, once.

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
than `denied`, with the matched rule attached. That difference is the metering ADR-029 §3 asks
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
