# Phase C2 — the smallest native story loop, and the instrument that sizes the rest

Status: proposed
Supersedes nothing. Amends ADR-029 sections 1 and 3 in the direction described in section 8.

## 1. Premise

Phase C1 shipped native filesystem tools (`Read`, `Glob`, `Grep`, `Write`, `Edit`, and a
read-only `Git`). The obvious reading of what remains is "C2 = `Bash` + a sandbox", because
`Bash` is the one member of ADR-029 section 1's tool list that C1 did not ship.

That reading assumes we know what a native run needs. We do not, and the gap is structural
rather than incidental:

- **The acpx arm keeps no record.** `src/session/types.ts:196` states it plainly for
  `transcriptDir`: "ACP ignores it." nax has no stored trace of any command acpx has ever
  executed, so the question cannot be answered from run history.
- **Agents improvise, and we only know because a prompt forbids it.**
  `src/prompts/builders/rectifier-builder.ts:460` warns that running a dependency-install
  command alone (`bun install`, `npm install`, `go mod tidy`, `pip install`, `cargo fetch`)
  does not satisfy a fix. A rule like that gets written because the behaviour was observed.
  The behaviour itself was never recorded.

So the tool set is this phase's **output**, not its input. C2 builds the smallest set that
lets a native story reach a commit, plus the instrument that records what was missing. What
C3 should be — including whether a sandboxed shell is worth building at all — is a
conclusion drawn from that instrument, not a premise carried into it.

## 2. What a story actually demands, as written

nax authors its own prompts, so the demanded surface is a closed set. For the implementer
role (`src/prompts/sections/role-task.ts`, standard variant):

| Prompt step | Capability | Status after C1 |
| --- | --- | --- |
| Read every failing test in scope | `Read` | shipped |
| Run the scoped test files for a baseline | scoped test command | absent |
| Implement source in the package's source location | `Write` / `Edit` | shipped |
| Re-run only the scoped test files after each change | scoped test command | absent |
| Stage and commit all changed files, with a body | git write verbs | absent |

Two observations follow.

First, the missing capabilities are narrower than `Bash`. The scoped test command is already
declared in configuration — this repository's own `.nax/config.json` carries
`quality.commands.testScoped` as `CI=1 bun test --timeout=60000 {{files}}`. The `{{files}}`
placeholder is precisely the Git tool's shape: a fixed command, an argv nax constructs, and a
model that supplies structure rather than a command string.

Second, the table describes the happy path. It says nothing about what an agent reaches for
when a test fails for a reason the story did not anticipate. That residue is the subject of
section 4.

## 3. Scope

### 3.1 Git write verbs: `add` and `commit`

`src/tools/git.ts` currently exposes `GIT_READ_VERBS = ["diff", "log", "show", "status",
"blame"]` and states that mutating verbs are not representable in the input type. C2 makes
`add` and `commit` representable, and nothing else.

The safety argument that licensed the read-only `Git` tool carries over unchanged: a fixed
binary, an argv built entirely by nax, no shell, and `GIT_ESCAPE_FLAGS` (`-C`, `--git-dir`,
`--work-tree`, `--exec-path`, `-c`) asserted absent from every built argv. The model supplies
a message string and a path list, never a command.

What is genuinely new is mutation. It is bounded by the same root that bounds every other
tool: a commit can only affect the repository `resolveWithin` already contains. The decision
this asks for is therefore narrow — whether mutation inside the root is acceptable — and it
is not the decision ADR-029 section 3 deferred, which was about a shell.

The message must support a body. The implementer prompt requires one: a test-modification
exception must be named "in the commit body" before any test file is edited, so a
subject-only `commit -m` cannot satisfy the role as written.

Neither verb joins `DEFAULT_CODING_TOOLS`. Both require an explicit grant, as `Write`,
`Edit` and `Git` already do.

### 3.2 `RunCommand`: declared commands only

A tool whose closed set is whatever the repository's configuration declares. The model names
a key the project has declared (in this repository those are `test`, `testScoped`,
`typecheck`, `lint` and `build`; the set is per-project, not fixed by nax) and supplies
values for the declared template variables; nax substitutes and builds the argv.

A correction to an earlier draft of this section, which claimed the tool uses no shell. It
does. `src/quality/runner.ts` executes every configured command through one, and its own
comment says why: "Execute via shell to preserve quoting semantics of configured commands."
The claim was not merely imprecise but unimplementable — this repository's `testScoped` is
`CI=1 bun test --timeout=60000 {{files}}`, and `CI=1` is a shell environment assignment, not
a binary. There is no argv for it to be.

So `RunCommand` reuses `runQualityCommand` rather than building a second execution path. The
same command then behaves identically whether nax runs it or an agent does, which is worth
more than a purity claim.

The property that survives is narrower and should be stated as such: **the model does not
author the command string.** It names a declared key and supplies values for declared
placeholders. Those values are the entire injection surface, and they are quoted with
`shellQuoteArg` from `src/verification/shell-quote.ts` — the same helper
`src/quality/command-resolver.ts:77` already applies to `{{package}}`.

This is a weaker guarantee than the `Git` tool's, which genuinely constructs an argv and
never reaches a shell. The difference is recorded rather than smoothed over: `Git` is safe
by construction, `RunCommand` is safe by quoting, and quoting is a thing that can be got
wrong. Section 7 carries the corresponding risk.

`QualityCommandOptions.stripEnvVars` is passed for agent-invoked commands, so a command an
agent runs need not inherit secrets that nax's own invocation would. A repository that
declares nothing grants nothing.

The power of the tool is therefore a property of the project's own configuration rather than
of the tool, which also means a project can widen or narrow it without a nax change.

Template substitution is the one place a command string is assembled, so it is where
injection would live if it lived anywhere. Substituted values are argv elements, never
re-parsed, and a value that fails the tool's own scope check is refused rather than escaped.

### 3.3 The instrument

Every tool outcome — `ok`, `error`, `denied`, `breach` — is recorded to a persistent audit
record under `.nax/tool-audit/<feature>/`, following the shape `src/review/review-audit.ts`
already uses for reviews (one JSON file per session, named `<epochMs>-<sessionName>.json`).

`src/tools/runtime.ts` already logs every outcome, denials included, and its own comment
explains why: "a refused call that leaves no trace" is the failure it exists to prevent. But
it logs through `getSafeLogger()`, and that is not sufficient for a decision that will be
read back later. Issue #1359 closed on a measured rate of zero for exactly such a counter;
the finding did fire, ten times inside the window it measured, and the persisted audit
records still hold them. The zero meant "no data retained", and was read as "did not happen".

This section therefore states a requirement rather than a preference: **a signal that a
later decision depends on is written to the audit records, not to the logger.** The logger
keeps its existing calls for operator visibility. Neither replaces the other.

### 3.4 `RequestCapability`

A denial is only produced if the model attempts the call. A model told it has no shell will
not attempt one, and the absence of denials would then be indistinguishable from the absence
of need.

This is not speculative. Issue #1800 records an adversarial reviewer responding, verbatim,
"The context store is empty and I have no file/shell access tool in this environment" — and
then returning a pass. The model recognised the gap, reported it in prose, and nothing
structured captured it.

`RequestCapability` is a tool that performs no work. The model calls it to declare a need it
cannot satisfy — a command it would have run, a file it would have reached — and receives a
refusal. The call is recorded like any other outcome.

Its purpose is to turn improvisation into a ledger. The dependency-install behaviour that
`rectifier-builder.ts:460` prohibits is the worked example: today it is folklore preserved in
a prompt, and it should be a row.

### 3.5 Out of scope, deliberately

`Bash`, any sandbox, and any network capability. ADR-029 section 3 is untouched by this
phase, and section 8 records what would have to be true before it is opened.

Recording the exclusion matters more than usual here, because C2's whole claim is that the
shell may not be needed. An unstated omission would read as an oversight rather than as the
question the phase exists to answer.

## 4. Permission posture: restrictive first, relaxed on evidence

Two directions were available: grant broadly and withdraw what proves unnecessary, or grant
narrowly and extend on demonstrated need. C2 takes the second.

- It is already what C1 built. `DEFAULT_CODING_TOOLS` is `[Read, Glob, Grep]`, `Write`,
  `Edit` and `Git` require explicit declaration, and the advertised set is the intersection
  of what an operation declares and what policy grants, where both can only narrow.
- The directions are not symmetric. Extending a grant is additive: nothing that worked
  stops working. Withdrawing one removes capability from a pipeline already depending on it,
  and surfaces as a mid-run failure someone has to diagnose.
- A permissive system produces no evidence. If everything is permitted, nothing is refused,
  and there is no signal about what was required. Under a narrow grant every refusal names
  exactly one missing capability, which is the same measurement argument section 3.3 makes.

The cost is real and should not be hidden: a narrow grant produces mid-run refusals that a
broad one would not, and the first fixture runs will be slower and noisier for it. That cost
is acceptable here specifically because the phase's product is evidence rather than
throughput.

## 5. Validation

On the `tdd-calc` fixture, not on a live repository. The existing
`scripts/probe-native-coding-tools.ts` and `scripts/probe-native-tool-round-trip.ts` are the
starting point, and the live-probe requirement from C1 carries over: compiling proves the
parts typecheck, and only an end-to-end trace proves the loop runs.

Success is not parity with acpx. It is:

1. A native implement story reaches a commit without human intervention.
2. The ledger from section 3.3 is non-empty, readable, and attributable to a story.

A run that fails to complete but produces a well-formed ledger satisfies this phase's
purpose. That is an unusual success criterion and is stated explicitly so it is not quietly
replaced by a completion rate during implementation.

The fixture choice is itself a limitation worth stating: a fixture exercises the demanded
surface of section 2 well and the improvised surface of section 4 poorly, because a fixture
story is one nobody had to fight. The ledger it produces is therefore a lower bound on need.

## 6. Consequences

- `Write` and `Edit`, which C1 shipped without a production consumer, acquire one.
- `tdd-verifier` becomes expressible on the native path for the first time, because its
  blocking requirement was running the story's scoped test files, and section 3.2 supplies
  exactly that. This does not mean it is unblocked in practice — issue #1800's prompt gap is
  independent of this phase and is not addressed here.
- The implement and rectify operations remain on acpx by default. ADR-029 calls that the
  correct default and this phase does not challenge it; it makes a native alternative
  measurable, not preferred.
- nax gains a per-tool-call audit record it has not had, for the native path only. The acpx
  path remains unobservable, and any comparison between arms inherits that asymmetry.

## 7. Risks

- **`RequestCapability` may go unused.** It depends on a model choosing to declare a want
  rather than silently working around it. This is the design's least certain element. An
  empty ledger is still informative but is weak evidence, and must not be reported as
  "nothing was needed".
- **A fixture understates need**, per section 5.
- **`RunCommand` is safe by quoting, not by construction.** Unlike `Git`, it reaches a
  shell, so a substitution value that escapes `shellQuoteArg` is a command-injection vector.
  This is the single highest-severity defect this phase can ship and needs a test that
  attempts the escape rather than one that asserts the helper was called.
- **Mutation inside the root is a real widening.** It is small and bounded, but a `commit`
  is the first native tool that changes state the user keeps.
- **Two arms, one observable.** Every quantitative claim comparing native to acpx after this
  phase rests on data that exists for one arm only.

## 8. Exit criterion

C2 ends by answering the question that outranks it: does a native run need a shell?

- If the ledger is dominated by declared commands and git verbs, ADR-029 section 3 should be
  **amended** rather than implemented, and C3 is a widening of declared commands.
- If it is dominated by improvised commands, the ledger is the list, and the threat model
  section 3 asks for finally has a subject rather than a hypothesis.

Either way the answer is written down before the expensive work is scoped. ADR-029 section 2
records that Phase C1 proceeded under an override of its parity entry condition; nothing in
this phase requests a second override, because nothing here depends on parity having been
proven.

## 9. Open questions

1. Does `RequestCapability` belong in the default tool set? It grants nothing, which argues
   for always-on; but a tool that exists only to be refused may distort the model's planning.
2. Should `RunCommand` expose the declared command's own text to the model, or only its key?
   Showing it aids reasoning about failures and leaks the project's toolchain into the
   prompt.
3. Does the ledger need the model's stated *reason* for a `RequestCapability` call, or only
   the command? The reason is the more useful datum and the least verifiable one.
