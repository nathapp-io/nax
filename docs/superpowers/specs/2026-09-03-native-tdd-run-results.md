# Results — the first full native three-session TDD run

Date: 2026-09-03. nax at `b075d7277` (branch `feat/native-op-tool-declarations`), nax-ai 0.1.6.
Fixture: `tdd-calc` on `nax-context-dogfood` branch `exp/native-tdd-full`, model
`openrouter/deepseek/deepseek-v4-flash` at every tier.

## Outcome

**The story passed.** 12m 0s, $0.0649, 125 coding-tool calls, `agent.protocol: "hybrid"` with
`agent.default: "native"` so every session ran on the native transport.

This is the first time a nax story has gone test-writer → implementer → verifier entirely on the
native agent.

## Per-role ledger

Read from `~/.nax/nax-tdd-calc-native/tool-audit/tdd-calc/`, not from the run verdict — per
ADR-029's first caution, a parity claim must confirm from the run record that tools were
*invoked*, never that they were configured.

| Role | Tool calls |
| --- | --- |
| `test-writer` | Read 2, **Write 1**, **RunCommand 3**, **GitCommit 1** |
| `implementer` | Read 7, Glob 3, **Edit 1**, **RunCommand 2**, **GitCommit 1** |
| `verifier` | Read 5, Glob 5, Grep 1, **Git 5**, **RunCommand 2** |
| `reviewer-semantic` | Read 9, Glob 7, Git 3 |
| `reviewer-adversarial` | Read 8, Glob 6, Git 3 |
| `test-fix` | Read 20, Glob 23, Grep 7 |

Attribution by role exists only because of the `buildLedgerSessionName` change in this branch.
Before it every one of these sessions was named `US-001`, and this table could not have been
produced.

## The prediction this run was built to test

Phase B recorded `tdd-verifier` failing identically across two models and two providers and
concluded it was *"a Phase C op (needs Write+fs)"*. **That diagnosis was wrong.**

The verifier ran, verbatim from the ledger:

```json
{"command": "testScoped", "values": {"files": "src/calc.test.ts"}}   outcome: ok
```

It needed neither `Write` nor a filesystem beyond reads. It needed `RunCommand`, which is one line
of declaration. It also made 5 `Git` calls, exercising the second half of its role
("check whether the implementer modified test files").

## What the run showed that was not predicted

**The test-writer committed its own RED state, unprompted.** Task 3's review argued that declaring
`GitCommit` would not produce the committed boundary because no prompt step directs a commit — the
`test-writer` role prompt genuinely has no such step, and `autoCommitIfDirty` is never called on the
per-TDD-session path. The model committed anyway:

```
ea04856 test: add failing tests for divide function with zero-division guard
692c751 feat(US-001): add divide(a, b) with zero-division guard
```

Two agent-authored commits, test-writer then implementer. The boundary materialised. The comment in
`write-test.ts` remains literally accurate (no prompt *directs* it) but its pessimism was unwarranted.

**`test-fix` is the baseline debt, made visible.** `acceptance-fix-test` (role `test-fix`) is one of
the seven ops still grandfathered as undeclared. It ran **four sessions and 50 tool calls — every one
of them `Read`, `Glob` or `Grep`.** It has no `Write` or `Edit`, so it cannot make the fix it exists
to make. It searched, repeatedly, and could do nothing. That is the clearest possible argument for
the follow-up arc that drains the baseline.

**Read failures in the review sessions** (`Read error` ×2 in each reviewer) are nax#1807 — `Git`
emits repo-relative paths while `Read` resolves against the permitted root.

## The ADR-029 section 3 trigger

**`RequestCapability` rows: 0**, across all 125 calls.

This is the weakest row in the ledger and must not be reported as "nothing was needed". A model told
it has no shell will not ask for one; it works around the gap or stops. Absence of a request is not
evidence of absence of need. None of section 3's three reopen triggers fired.

## What this run does NOT show

- **Not quality parity.** `tdd-calc`'s acceptance criteria are pinned to exact strings, which
  flatters a weak test-writer. Passing here is a floor, not evidence that native implementation
  matches acpx.
- **One story, one fixture, one model, n=1.**
- **The verifier's scope limitation is unobserved, not absent.** It called `testScoped` correctly
  rather than reaching for the full `test` suite — but under the `unrestricted` profile nothing
  stopped it, so this run is one data point about model behaviour, not evidence of a constraint.
- **A first run failed for an unrelated reason** — `agent.protocol: "native"` is rejected when the
  global config declares acpx agent models, and only `models.native.fast` was declared, so a tier
  escalation to `balanced` aborted the story after 13m and $0.051. Both are fixture-configuration
  facts, not findings about the tool declarations.

## Conclusion

The two declarations do what the design said they would, and the ledger proves the tools were
invoked rather than merely configured. The verifier's Phase B failure is explained and resolved.
