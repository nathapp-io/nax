# Native op tool declarations — closing the gap between "an op runs" and "an op can work"

Status: proposed
Amends ADR-029 section 2 (a second recorded override). Does not touch section 3 — bash stays deferred.

## 1. Premise

Phase C1 and C2 shipped the native coding tools and proved a native *implement* story can
reach a commit unaided. The natural next question is "what else does the native agent need
to build?", and the answer turns out to be: almost nothing. It needs ops to **declare what
they already require**.

`resolveDeclaredTools` (`src/operations/types.ts:11-14`) is `op.tools ?? DEFAULT_CODING_TOOLS`,
and `DEFAULT_CODING_TOOLS` is `["Read", "Glob", "Grep"]` (`src/config/permissions.ts:96`).
Of **25** run operations reachable through the operations barrel, **three declare `tools:`** —
`implementer`, `semantic-review`, `adversarial-review`. The other 22 silently receive read-only.

That default is why this went unnoticed for so long. It is not obviously wrong: read-only is
a sensible thing for most ops, and the doc comment on `tools` argues correctly that capability
is a per-op decision. And on acpx **nothing is broken at all** — the ACP agent brings its own
tools, so the declaration is inert there. It bites only on the native transport, which until
C1 had no tools to advertise in the first place.

Eight agent-dispatching ops need more than the read set and declare nothing:

| Session role | Ops | Actually needs |
| --- | --- | --- |
| `implementer` | `implementer` (**declared**), `autofix-implementer`, `rectify`, `full-suite-rectify` | write, run, commit |
| `test-writer` | `test-writer`, `autofix-test-writer` | write, run, commit |
| `verifier` | `verifier` | read, run — **not** write |
| `source-fix` | `acceptance-fix-source` | write, run |
| `test-fix` | `acceptance-fix-test` | write, run |
| `finish-fix` | `finish-fix` | write |

`acceptance-generate` is deliberately absent: it returns `testCode` and *nax* writes the file
(`src/pipeline/stages/acceptance-setup.ts:381`), so read-only is correct for it. This is the
distinction the design turns on — "the op produces content" and "the op edits the tree" are
different capabilities, and only the second needs `Write`.

## 2. What this is, and is not

**It is a declaration fix plus a gate.** No new tool, no new executor, no shell. ADR-029
section 3 names the direction explicitly — *"the next widening of the native tool set should
be more declared commands, not a shell"* — and this is narrower still: no new commands either,
only ops declaring the tools that already exist.

**It is not the fix-loop ops.** All seven of `autofix-implementer`, `autofix-test-writer`,
`rectify`, `full-suite-rectify`, `acceptance-fix-source`, `acceptance-fix-test` and `finish-fix`
stay undeclared and therefore
read-only on native. They fire on failure paths, which are hard to trigger deliberately and
easy to get silently wrong, and they are where a bad native edit actually costs something.
They get their own arc and their own evidence.

## 3. The invariant

The class defect is that capability is a property of the **session role** while the
declaration is written per **op**. `implementerOp` declares exactly what a
`role: "implementer"` session needs, and three sibling ops carrying the same role declare
nothing — it was written once and forgotten three times.

The fix is not to derive tools from the role. Deriving trades a silent under-grant for a
silent over-grant: a new op picks `role: "implementer"` and inherits `Write`/`Edit`/`GitCommit`
without anyone deciding it should. Under-granting degrades a run; over-granting hands file
mutation to an op nobody reviewed for it. The doc comment's principle stands — *"should a
reviewer write files is a capability question, not a permission one."*

So the invariant is **enforced, not applied**:

> An op whose `session.role` is write-capable must declare `Write` and `Edit`.
> An op whose role is `verifier` must declare `RunCommand`.

`scripts/check-op-tool-capability.ts` imports the operations barrel and inspects the exported
objects, rather than parsing source — it then reads exactly what dispatch reads, and cannot
drift from it. Wired into `lint`, so `check:gate-reachability` proves it runs in CI.

`SessionRole` (`src/runtime/session-role.ts`) is already the canonical registry and is the
table's anchor; a role added there without a capability decision is the case this catches.

Exactly ten ops carry a role in the table. One (`implementer`) is already declared, two are
declared by this design, and seven go to the baseline. Two write-capable roles —
`repo-scoped-test-fix` and `fix-gen` — have **no operation at all** today; the invariant covers
them prospectively, so the first op to claim one is forced to decide its capability rather than
inherit read-only by silence.

Two properties of the barrel the check must handle, both established by probing it rather than
by reading source. **Ops are exported under aliases**: `implementerOp` and `implementTddOp` are
the same object, as are `testWriterOp`/`writeTddTestOp` and `verifierOp`/`verifyTddOp`, so
iterating `Object.entries` double-counts unless it dedupes by object identity. And **a module
can define more than one op**: `src/operations/acceptance-fix.ts` exports both
`acceptance-fix-source` and `acceptance-fix-test`, which a per-file scan reading the first
`name:` silently misses. Both are reasons the check imports the barrel instead of parsing
files.

**The check fails on the seven out-of-scope ops today, and that is intended.** It ships with
those seven in an explicit baseline, the same ratchet idiom as `check:nax-error` (90 against a
baseline of 104) and `check:file-sizes`. The debt becomes a countdown the follow-up arc lowers,
rather than an omission nothing records.

## 4. The two declarations

**`verifier`** — `["Read", "Glob", "Grep", "Git", "RunCommand"]`

`Git` because the role's own instructions require a diff it cannot currently take: *"Check
whether the implementer modified test files after the test-writer phase."* `VerifierInput`
already carries `beforeRef` for exactly that comparison. `RunCommand` because the first
instruction is *"Run ONLY the story's scoped test files"*.

No `Write`, no `Edit`, no `GitCommit`. A verifier that can repair what it is judging is not a
verifier, and the isolation check it exists to perform assumes it changed nothing.

**`test-writer`** — `["Read", "Glob", "Grep", "Write", "Edit", "RunCommand", "GitCommit"]`

`Write`/`Edit` to create test files and compile-only stubs; `RunCommand` because step 6 of the
role is *"Run the new test files. Confirm tests compile AND fail with ASSERTION failures"* —
a test-writer that cannot execute cannot distinguish the RED it is required to produce from an
import error, which is the one distinction its prompt insists on.

`GitCommit` so the session commits its own RED state. This makes the phase boundary explicit
rather than incidental: the implementer's `beforeRef` then starts from a committed test-only
tree, which is what `verifyImplementerIsolation` compares against. The alternative — leaving it
to the orchestrator's `autoCommitIfDirty` — works today but attributes the test-writer's output
to whichever auto-commit happens to sweep it up.

## 5. A limitation this records rather than fixes

`RunCommand`'s enum is every `quality.commands` key, so under the `unrestricted` profile the
verifier can invoke `test` — the full suite — despite its prompt forbidding exactly that.

The narrowing already exists and is implemented: `RunCommand` declares `verbField: "command"`
with `allowedVerbs`, `parseToolExpression` already parses `RunCommand(testScoped)`, and
`resolveScopedPermissions` (`src/config/permissions.ts:167`) resolves per-stage `allowedTools`
with inherit chains. Under a `scoped` profile, `RunCommand(testScoped)` at stage `verify` is
the precise grant.

That is the **permission** axis, not the capability axis, and it belongs to #374. Noted here
so the gap is known rather than discovered. Worth flagging separately: #374 is labelled
`blocked`, but the mechanism above appears substantially built — that label should be
re-checked against the code rather than trusted.

## 6. Verification

### 6.1 The falsifiable prediction

Phase B recorded `tdd-verifier` failing identically across two models and two providers, and
concluded it was *"a Phase C op (needs Write+fs)"*. This design says that diagnosis was wrong:
the verifier needs neither Write nor a filesystem beyond reads — it needs to run a command.

Adding one tool either fixes a 2x2-reproduced failure or it does not. Both outcomes are worth
the run, and the second retires this design's central claim rather than the ADR's.

### 6.2 The full native TDD run

The end-to-end demonstration is `tdd-calc` with **all three TDD session roles pinned native** —
`test-writer`, `implementer` and `verifier` — so the claim under test is "a native agent can run
a complete three-session story", not "an op gained a tool".

Two fixture prerequisites, both real gaps rather than incidental setup:

- **`tdd-calc` declares no `testScoped`.** Its `quality.commands` is `test`/`typecheck`/`lint`,
  none carrying `{{files}}`. Neither the test-writer's "run the new test files" nor the
  verifier's "run ONLY the scoped test files" is expressible without it. Add
  `"testScoped": "bun test {{files}}"`.
- **The three roles must be pinned.** `tdd.sessionTiers` supports `{ agent: "native", model }`
  per role; `review.*.model` takes the same shape.

Evidence is read from `~/.nax/<project>/tool-audit/<feature>/`, not from the verdict. Per
ADR-029's first caution, a parity claim must confirm from the run record that tools were
*invoked*, never that they were configured — the C1 A/B measured a capability that was not
connected, and only the ledger caught it.

**Two corrections to how that run must be set up, both found by review rather than by
reading the config schema.**

`tdd.sessionTiers.implementer` **is not consumed.** `src/config/schemas-execution.ts:376-378`
says so outright — *"implementer is routing-driven (story.routing.modelTier + escalation); this
field is intentionally NOT consumed"* — and `implementerOp.model` reads `story.routing`. Pinning
the implementer through `sessionTiers` would leave it silently on acpx while the run reported
three native roles. The fixture therefore sets `agent.protocol: "native"` with
`agent.default: "native"`, which routes every session natively and needs no per-role pin at all.

**The ledger cannot currently attribute a row to a role.**
`src/agents/coding-tool-support.ts:125` names each session `options.storyId ?? featureName ??
"unattached"`, so all three roles in one story write files named for the *story*. The evidence
this section calls for — "`RunCommand` rows for the verifier, `Write` rows for the
test-writer" — is not derivable from that artifact. `AgentRunOptions` already carries
`sessionRole`; it is simply absent from the `Pick` this function accepts. Folding the role into
the session name is a precondition of this verification, not an optional extra.

Specifically: `RunCommand` rows attributable to the verifier; `Write`/`Edit` rows for the
test-writer; and `RequestCapability` rows across all three, whose count is the ADR-029 section 3
trigger. A zero there remains the weakest row in the ledger and must not be reported as
"nothing was needed".

### 6.3 Unit

The check script fails on a synthetic op whose role is write-capable and whose tools omit
`Write`, and passes on the real registry with the baseline applied. Both declarations are
asserted through `resolveDeclaredTools`, not by reading the literal, so the test exercises the
same path dispatch does.

## 7. Risks

**A native test-writer writing plausible but weak tests.** This is precisely the implementation
quality ADR-029 section 2 guards, and one fixture run will not settle it. `tdd-calc`'s
acceptance criteria are pinned to exact strings, which flatters a weak test-writer — passing
there is a floor, not parity. The override paragraph must say so rather than let the run imply
more than it shows.

**The verifier gaining `Git` widens what it reads.** Read-only, root-contained, and it already
receives `beforeRef`, so this is the smallest widening that makes its stated job possible. Noted
because "the verifier can now diff" is a real change in what that session sees.

**Attribution.** `GitCommit` on the test-writer changes which commits exist mid-story. The
isolation check compares against a ref rather than counting commits, so this should be inert —
but `verifyImplementerIsolation` is the thing to re-run rather than reason about.

## 8. ADR-029 section 2 override

Section 2's entry condition — proven cost *and quality* parity — is still unmet as written, and
this work widens native **implementation** to a write-capable op (`test-writer`), which is what
that condition guards. Phase C1 proceeded under a recorded override; C2 proceeded without one
because it excluded the capability the condition names. This work does not exclude it.

So it needs a second recorded override, in the same form and for the same reason C1's exists:
so the gap between the rule and what happened is written down rather than rediscovered. The
paragraph must state the limit in section 7 — that the fixture's exact-string ACs make a
passing run a floor rather than evidence of parity.
