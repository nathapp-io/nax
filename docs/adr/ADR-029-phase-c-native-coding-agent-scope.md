# ADR-029: Phase C — Scope and Constraints for a Native Coding Agent

**Status:** Proposed — scope only
**Date:** 2026-09-02
**Author:** William Khoo, Claude
**Builds on:** ADR-027 (adapter-protocol split), ADR-028 (native sessions and the pull-tool loop)
**Related:** #374 (scoped tool allowlists, PERM-002 Phase 2), the "Nax Native LLM Harness" feasibility analysis §9, §10, §11
**Implementation:** Phase C1 (filesystem tools + read-only Git; Bash severed)
shipped in PR #1798, under an explicit override of the §2 entry condition — see
the parity status appended to §2. Phase C2 (the native story loop: `GitCommit`,
`RunCommand` over declared commands, `RequestCapability`, and the tool-audit
ledger; Bash still severed) shipped in PR #1804 without requesting a second
override, because it excludes the capability the entry condition guards — see the
amendment appended to §3.

---

## What this ADR is, and what it deliberately is not

This records the decisions about Phase C that **are** settled, so they are not
re-argued or accidentally violated by earlier phases. It does **not** design the
permission gate, the tool set, or the executor.

That restraint is itself the decision. From the feasibility analysis:

> Permissions cannot be designed correctly yet, and that decides it. A gate's
> shape depends on what it gates, and the thing it would gate — nax's own
> executor for Read/Write/Edit/Bash — does not exist and is Phase C, which §9
> calls severable. Designing it now means inventing an interface for a consumer
> nobody has written.

An ADR that invented that interface today would be the same mistake ADR-027 §8
avoided for nax-ai: narrowing a proven surface is sound, inventing one for a
single hypothetical consumer is not. So this ADR fixes the boundary and the entry
conditions, and leaves the design to the ADR that supersedes it.

## Context

Phases A and B put nax's one-shot and read-only agentic ops on the native
transport. What remains is the implement and rectify ops — the work that edits
files and runs commands.

The asymmetry that makes this a different kind of project: **today nax never
executes a coding tool at all.** Claude Code inside acpx does, and enforces its
own approval policy. `resolvePermissions` (`src/config/permissions.ts:80`)
decides a mode once and it becomes a spawn flag — the comment at
`spawn-client-session.ts:119` says it "decides nothing". There is no
`canUseTool`-style callback anywhere in `src/agents/`, and the stream never
pauses for approval.

Against a stateless client, nax becomes the executor of every tool call. It must
then build a gate it has never needed.

## Decisions

### 1. Scope

Read, Write, Edit, Bash, Glob and Grep, executed in-process by nax, with
permission enforcement and per-story working-directory scoping. This is where
#374's scoped allowlists (`Write(src/**)`, `Bash(bun test*)`) finally become
implementable, because there is finally something to scope.

Estimated at ~5–8k LOC including tests — several times Phases A and B combined.

### 2. Phase C is severable, and stays severed until its entry conditions are met

It does not start until **Phases A and B have proven cost and quality parity on
real ops**. Not "shipped" — *proven*, by the same per-op A/B method Phase A used
and Phase B adopts.

The reason is not caution for its own sake. Frontier-lab CLIs ship heavily-tuned
tool prompts, and a first-cut native toolset will underperform Claude Code on
implementation quality. That is acceptable **only** because the target is cheap
API-key models for implementation work, not replacing Claude. If A and B have not
demonstrated parity on easier ops, that premise is unproven and C is a bet rather
than a step.

#### Parity status (updated 2026-09-03)

**Cost: demonstrated.** Phase B measured native at roughly a tenth of acpx's
per-op cost on the review ops. That result has not been retracted, but note it
has not reproduced at the same magnitude: the Phase C1 A/B measured native ~2.1x
cheaper on a whole run, not ~10x.

**Quality: partially demonstrated, and not by the method this section names.**

Phase B could not demonstrate it. Native reviewed the diff only, and the fixture
carried no planted defect, so "both arms clean" was uninformative.

The Phase C1 A/B used a fixture with a cross-file regression invisible in the
diff: a signature swap breaking an unchanged caller, with no test covering it.
Result, n=1: the native reviewer found it and acpx did not. The finding cites the
file by name with a `verifiedBy.command` of `Read`, and the file appears nowhere
in the reviewer's prompt — so the tools, not the prompt, are what produced it.

This is one defect class, one model, one fixture. It is direct evidence that
native tool use closes the specific gap Phase B left open. It is **not** evidence
of general review-quality parity, and this section should not be read as
satisfied.

**Two cautions attached to that result:**

1. It was obtained only after fixing a wiring defect that had made coding tools
   unreachable on the real dispatch path — every native review op declared four
   tools, was granted four, and was advertised none. The first A/B run measured
   a capability that was not connected. Any future parity claim must confirm
   from the run record that tools were actually invoked, never that they were
   configured.
2. The regression was reported as `warning`, not `error`, because no acceptance
   criterion names the affected symbol and the prompt's AC-grounding rule forbids
   blocking on it. It was corrected only because rectification acts on advisory
   findings. A real regression that provably cannot block a story is a separate
   design problem, in review grounding rather than in Phase C.

**Entry condition disposition.** The condition above was **overridden by the
project owner** for Phase C1, with unproven quality parity accepted as a known
risk. The override is recorded here so the gap between "the rule" and "what
happened" is not left to be rediscovered. The condition still stands, unmet as
written, for any Phase C work beyond C1 — in particular for Bash (§3).

**Second override: native op tool declarations (2026-09-03).** The branch
`feat/native-op-tool-declarations` gave two ops an explicit tool declaration
for the first time: `verifier` (`Read`, `Glob`, `Grep`, `Git`, `RunCommand`)
and `test-writer` (`Read`, `Glob`, `Grep`, `Write`, `Edit`, `RunCommand`,
`GitCommit`). Neither op held no tools before this branch — an undeclared
`tools` field resolves to the read-only default (`Read`, `Glob`, `Grep`), so
both already ran with that in effect. What changed is that `test-writer` now
declares `Write`, `Edit`, `RunCommand`, and `GitCommit` on top of the
`Read`/`Glob`/`Grep` it already had by default. That addition is write-capable,
and write-capability is exactly what this section's entry condition guards. That
puts this branch in the same position C1 was in, not the position C2 was in
below: C2 proceeded without an override because it was scoped to exclude the
capability the condition names, and could therefore never come into contact
with the gate. This branch widens native implementation to a write-capable op
directly, so it cannot proceed by exclusion, and needs a recorded override in
the same form and for the same reason as the C1 one above.

The measured outcome, recorded in full at
`docs/superpowers/specs/2026-09-03-native-tdd-run-results.md`: the `tdd-calc`
fixture's story passed end to end — 12m 0s, $0.0649, 125 coding-tool calls —
with every session in the story, test-writer through verifier, running on the
native transport. The verifier issued `RunCommand{command: "testScoped"}` and
it succeeded. That retires the Phase B conclusion, recorded in the results
document above, that `tdd-verifier` "needs Write+fs": what it needed was
`RunCommand`, one line of declaration, not a filesystem.

That result is a floor, not the parity this section names, and should not be
read as satisfying it. `tdd-calc`'s acceptance criteria are pinned to exact
strings, a shape that a weak test-writer can pass as easily as a strong one,
so the run does not distinguish "the test-writer wrote a correct test" from
"the test-writer wrote a test the fixture cannot fail." It is also one story,
one fixture, one model — n=1.

Section 3's reopen triggers did not fire on this run either: `RequestCapability`
rows were 0 across all 125 tool calls, and none of the three conditions named
there was met. Per section 3's own caution, a zero row here is the weakest
entry in the ledger, not proof that nothing was needed — a model given no
shell does not ask for one, it works around the gap or stops — and this run
should not be reported as showing that nothing was needed. (Per-role
attribution in that ledger was itself possible only because this branch
changed the tool-audit session name to carry the session's role; before it,
every session in a story shared one name and no per-op distinction could have
been read back from it.)

Phase C2 proceeded under no override. The condition guards a capability, not a
phase number, and C2 was scoped to exclude that capability, so it never came into
contact with the gate. Re-scoping a phase out from under an entry condition is
legitimate exactly when the condition names what it names; it would not have been
legitimate had C2 shipped a shell under a different label.

### 3. Sandboxing bash is a security responsibility nax has never carried

Named here so it is budgeted honestly rather than discovered. The analysis is
blunt about the failure mode: do not ship `--approve-all` semantics under a new
name.

A model-requested shell command executed in-process, in the user's repository,
with the user's credentials in the environment, is a materially different risk
from anything nax does today. Whatever gate is designed must be able to say no,
and must be tested on its ability to say no.

#### Amendment, 2026-09-03: what Phase C2 measured, and why this section stays open

Phase C2 (PR #1804) was built to answer the question this section budgets for:
does a native run need a shell at all? Rather than assume the answer, it shipped
the narrowest set that lets a native story reach a commit — `GitCommit`,
`RunCommand` over commands the project has **already declared** in its own
configuration, and `RequestCapability`, a tool that grants nothing and exists so
that an unmet need becomes a recorded row instead of an improvisation. Every tool
outcome is persisted to a per-story ledger under the run's output directory
(`~/.nax/<project>/tool-audit/<feature>/`), beside prompt-audit and review-audit.

As first shipped the ledger was written under the coding-tool root instead — the
story's package workdir, inside the git worktree that `pipeline-result-handler.ts`
removes on completion. Every real story would have destroyed its own evidence,
leaving only fixture runs legible, and a later count would have read zero and been
taken to mean no capability was ever wanted. That is the #1359 false-zero this
ledger exists to prevent, so the location was corrected before any of the triggers
below could be relied on.

**What the ledger recorded.** On the `tdd-calc` fixture, a native implement story
(US-001) reached a commit unaided. The ledger held 93 tool calls attributable to
the story: `RunCommand` 3 (the declared `testScoped` twice, `typecheck` once),
`GitCommit` 1, `RequestCapability` 0, and no improvised commands of any kind.

**The verdict, and its exact scope.** On this evidence the demanded surface of an
implement story is covered by declared commands and git verbs. The next widening
of the native tool set should therefore be **more declared commands, not a
shell** — that is a cheaper build, and it preserves the property that nax
constructs every argv rather than executing a string a model authored.

**This section is deferred, not retired.** The distinction matters and is the
reason this is an amendment rather than a supersession. Three limits keep the
question genuinely open:

- **The evidence is a lower bound by construction.** One story, on a fixture. A
  fixture story is one nobody had to fight, so it exercises the happy path well
  and the improvised path — the path that reaches for a shell — barely at all.
- **A zero from `RequestCapability` is the weakest row in the ledger.** A model
  told it has no shell will not ask for one; it will work around the gap or stop.
  Absence of a request is not evidence of absence of need, and must never be
  reported as "nothing was needed".
- **Only one arm is observable.** ACP ignores `transcriptDir`, so nax still holds
  no record of what acpx has ever executed. The comparison that would settle this
  cannot yet be made, and any claim that spans both arms inherits that asymmetry.

Note also that the ledger is a run artifact and is gitignored, so the figures above
are transcribed from the run recorded in PR #1804 and are not independently
re-derivable from this repository. Treat them as a reported measurement, not as a
fixture the test suite reproduces.

**What reopens this section.** The instrument is now permanent, so the trigger is
measurable rather than a matter of judgement. Any of the following moves bash
from deferred back to scoped work, and this section's requirements — a gate that
can say no, tested on its ability to say no, and a written threat model — apply
in full and unchanged when it does:

1. Ledgers from real (non-fixture) stories show a material rate of
   `RequestCapability` rows, or of stories that fail for want of a command.
2. The set of commands a project must declare to keep native stories working
   grows until "declared commands" is a shell in all but name. A general
   `RunCommand("bash", ...)` entry in a project's config is that line being
   crossed, and should be read as this section reopening, not as configuration.
3. An op that cannot be expressed over declared commands becomes required on the
   native path.

**One shell-shaped risk has already landed.** `RunCommand` reuses the existing
quality runner, which reaches a shell, so its safety property is
**safe-by-quoting, not safe-by-construction** — unlike `Git` and `GitCommit`,
whose argv nax builds element by element. Its substitution values are shell-quoted
and the test attempts a real escape rather than asserting the quoting helper was
called. This does not make the deferral unsound, but it does mean the first
shell-adjacent surface is in the codebase now, and it is where a future threat
model should start rather than at a blank page.

#### Amendment, 2026-09-06: an argv branch for `RunCommand`, and why it is an override

This is not the widening the "more declared commands" verdict above anticipated.
It grants a model-authored argv, and the entry condition this section and §2
guard is write-capability reaching the model's own authorship, not the shape of
the executor. Recording it here follows the same rule the C1 override followed:
a widening of what a model may cause to run gets recorded as an override, not
folded silently into an existing deferral.

**What is granted.** A second input branch on `RunCommand`: a model-authored
argv, executed with `shell: false`, gated by an allowlist that is empty by
default outside a built-in, nax-controlled install list (the restore and add
forms for npm, bun, pnpm, yarn, pip, uv, go, and cargo). Two independent gates
must both pass — an `Exec` marker in the op's `tools` declaration, and an
`Exec(...)` grant compiled by the existing policy. Neither alone is sufficient:
a marker without a grant advertises nothing, and a grant without the marker
cannot be reached because `Exec` is excluded from `unconditionalGrants()`, so
the default `unrestricted` profile grants the built-in list, never a wildcard.

**Why it is not the shell this section defers.** The model never authors a
command string that reaches a shell. It supplies an argv — a list of tokens,
validated before matching and denylisted on install-shaped flags after
matching — and the grant names what may run, matched token-wise against the
argv nax itself constructs. There is no interpolation point at which a
semicolon, a pipe, or a substitution could reach `/bin/sh`, because there is no
`/bin/sh` in this path.

**What it nonetheless is.** It is the first model-authored execution nax
performs. Every tool that runs today runs an argv nax built element by element
— `Git`, `GitCommit`, the declared branch of `RunCommand` — from inputs the
model supplied as *values*, never as the verb or the flags. The argv branch
lets the model supply the verb. That is new in kind, not degree, so the entry
condition in §2 applies to it, and this is recorded as an override of that
condition rather than a continuation of the "more declared commands" path,
exactly as the C1 override above was recorded rather than assumed.

**The containment carve-out.** `Exec` is the one tool by which a package-scoped
story reaches outside its permitted root. Workspace package managers write to
the repo root by design — `bun add` in a package directory walks up and mutates
the root lockfile and `node_modules`, pnpm resolves `pnpm-workspace.yaml`
upward, `cargo add` edits the member manifest while the root `Cargo.lock`
moves with it. For this tool the permitted root is a cwd choice the model
names (`target: "package"` or `target: "repoRoot"`), not a sandbox nax
enforces. The gate carrying the safety property is the allowlist plus the
no-scripts default nax appends and the model cannot remove, not containment.
A second, narrower carve-out follows from the first: `GitCommit` may stage a
manifest or lockfile that an install in the same hop actually touched. That
allowance is exact-match, hop-scoped, and populated only from installs nax
itself normalized and ran — never a directory, never a path the model names
directly.

**The evidence that motivated it.** From the 2026-09-06 `hello-lint` run
(fixture copy, MiniMax-M3), quoted verbatim from the tool-audit ledger:

```
RunCommand {"command": "bun add -d bun-types"}      -> denied
RunCommand {"command": "bun x tsc --noEmit"}        -> denied
Glob       {"pattern": "/**/bun-types/package.json"} -> error
RequestCapability                                    -> 0 rows
```

With no legal way to install and no legal way to run the check directly, the
model removed `types: ["bun-types"]` from `tsconfig.json` and narrowed
`include` until the requirement vanished, and the story passed. It did not
file a `RequestCapability` row; it tried to author a command string through a
field built to accept only a declared key.

**What would reopen it.** Any denial pattern in the tool-audit ledger showing
the allowlist is systematically too narrow — install-shaped calls refused
across multiple real stories for managers or verbs a project legitimately
needs. And any observed use of `target: "repoRoot"` to add a dependency the
story did not need — that would mean the root-scoping form is being reached
for as a way around containment rather than as the only correct place to add a
workspace-wide dev dependency.

**One coupling worth recording, not designed away.** The built-in install list
is available under the default `unrestricted` profile, so a project gets the
observed failure's fix with no configuration. But widening `Exec` to generic
commands (`bun x tsc*`, `make build`, anything past the install table) requires
writing an explicit `Exec(...)` expression, and today that expression lives in
the `scoped` profile's `execution.permissions.<stage>.allowedTools` — there is
no way to add a scoped grant on top of `unrestricted`. Selecting `scoped` to
get that grant also switches the permission mode to `approve-reads`, because
`resolveScopedPermissions` always resolves that mode regardless of what the
allowlist contains. Nobody chose that coupling for this feature; it falls out
of where grants happen to live in the existing profile structure. It is
recorded here as a known sharp edge, not solved: a project that wants a wider
`Exec` allowlist today accepts a stricter default posture on every other tool
as a side effect of asking for it.

### 4. Permission policy stays in nax

nax-ai executes nothing and holds no policy — its own scope statement excludes
permission policy, and that boundary survives Phase C. nax already holds the SSOT
at `src/config/permissions.ts` and in #374's spec; a second home for policy
invites two definitions drifting apart.

### 5. What Phase C may not assume from Phase B

Phase B's tool loop is built for read-only tools whose failures are safe: a
budget breach or a handler throw returns a `tool-result` with `isError` and the
conversation continues. **That contract does not generalise.** A rejected `Write`
or a refused `Bash` is not the same event as a pull tool running out of budget,
and reusing the same path for both would make a denied permission look like a
recoverable tool error.

Phase B's loop is therefore a starting point, not a foundation. Whether it is
extended or replaced is a Phase C decision.

## Consequences

- **#374 stays blocked** until Phase C lands. It is blocked today regardless, so
  this costs nothing new.
- **The implement and rectify ops stay on acpx indefinitely**, which is the
  correct default: those agents are good at exactly this, and that is why acpx
  exists.
- **A capability is given up on the native path.** The analysis records that MCP
  and skills belong to the ACP agents; an op moved native loses them. That trade
  is tolerable for read-only review work and is a real question for coding work.

## Open Questions

Left open deliberately — each needs the executor to exist before it can be
answered honestly.

1. What is the tool set, exactly, and does it mirror Claude Code's or nax's own
   needs?
2. What shape is the gate — a synchronous predicate per call, a policy object
   compiled once, or something that can pause a turn for human approval (which
   nothing in nax can do today)?
3. How is bash sandboxed, and what is the threat model it is sandboxed against?
   Still open, and now deferred on measured evidence rather than assumed need —
   see the §3 amendment, which also names the conditions that reopen it.
4. Does the Phase B turn loop extend to coding tools, or does Phase C need its
   own? See §5.
5. Does the permission gate turn out provider-shaped rather than nax-shaped? If
   it does, that is one of ADR-028 §8's triggers for revisiting the package
   split.

## Supersession

This ADR is expected to be superseded by a full Phase C design once its entry
conditions (§2) are met. Until then it exists to keep the boundary honest: Phases
A and B may not quietly acquire a coding tool, and Phase C may not quietly start
without the parity evidence that justifies it.

Phase C1 started under an explicit, recorded override rather than quietly — which
is the outcome this section was written to force. Open questions 1, 2 and 4 are
answered by the C1 design. Question 5 (whether the gate is provider-shaped)
remains open.

Question 3 (bash sandboxing) also remains open, but no longer gates all Phase C
work beyond C1: Phase C2 shipped by excluding bash rather than by answering for
it, and the §3 amendment records both the measurement behind that deferral and
the conditions under which the question returns. What question 3 still gates is
bash itself, and anything that amounts to bash.
