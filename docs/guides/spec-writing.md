# Spec Writing Guide

How to write specs that produce high-quality PRDs and successful nax runs.

## Structure

A good spec has 5 sections. **All are required.**

```markdown
# SPEC: [Feature Name]

## Summary
One paragraph: what this feature does and why it matters.

## Motivation
What problem does this solve? What's broken or missing today?

## Design
Key interfaces, data flow, or architecture decisions.
Include TypeScript signatures when defining new APIs.
For CLI tools: specify exit codes, stdout/stderr behavior, and file formats precisely.

## Stories
Break the feature into implementation units.
Each story should be independently testable.
Include context files and dependency markers (see below).

## Acceptance Criteria
Per-story behavioral criteria (see format below).
```

## Acceptance Criteria Format

Every AC must be **behavioral and independently testable**.

### Use This Format

```
- [function/method] returns/throws/emits [specific value] when [condition]
- When [action], then [expected outcome]
- Given [precondition], when [action], then [result]
```

### Rules

1. **One AC = one assertion.** If an AC has "and" in it, split it.
2. **Use concrete identifiers.** Function names, return types, error messages, log levels.
3. **Specify HOW things connect.** "logger forwards to the run's logger" not "logger exists".
4. **Never list quality gates.** Typecheck, lint, and build are run automatically — don't waste ACs on them.
5. **Never use vague verbs.** "works correctly", "handles properly", "is valid" are untestable.
6. **Never write ACs about tests.** "Tests pass" or "test file exists" are meta-criteria, not behavior.
7. **Stay in scope.** Only write ACs for behavior described in the spec. Don't invent features not in the requirements.
8. **Be consistent.** If the spec says "url", don't use "uri" in interfaces. Match terminology exactly.

### Examples

❌ **Bad:**
- "TypeScript strict mode compiles with no errors" → quality gate
- "Interface defined with all required fields" → existence, not behavior
- "Function handles edge cases correctly" → vague
- "Tests added and passing" → meta

✅ **Good:**
- `buildPostRunContext()` returns `PostRunContext` where `logger.info('msg')` forwards to the run logger with `stage='post-run'`
- `getPostRunActions()` returns empty array when no plugins provide `'post-run-action'`
- `validatePostRunAction()` returns `false` and logs warning when `postRunAction.execute` is not a function
- When `action.execute()` throws, `cleanupRun()` logs at warn level and continues to the next action

## `[verbatim]` ACs — preserve executable assertions through `nax plan`

Any AC that contains a **shell command, grep pattern, file-existence check, or
architectural-invariant test** must be prefixed `[verbatim]`. The marker
signals to `nax plan` and the spec-review PRD-fidelity phase that the AC must
appear character-for-character in `prd.json`. Without the marker, `nax plan`
will paraphrase the assertion into prose, which strips the executable
verification mechanism.

> **Status:** the planner-side enforcement is a tracked follow-up (see
> [`docs/findings/nax-plan-prd-fidelity.md`](../findings/nax-plan-prd-fidelity.md)
> for the US-005 case study and the proposed contract). Until that lands,
> `[verbatim]` ACs are enforced post-plan by spec-review phase 9 — run it
> after every `nax plan` invocation.

### When to mark `[verbatim]`

| AC kind | Required? |
|:---|:---|
| `grep -rn "<symbol>" src/ test/` returns `0` | ✅ required |
| `File path X does not exist after this story` | ✅ required |
| `File path X exists and contains symbol Y` | ✅ required |
| Architectural-invariant test (e.g. "only 3 edit points") | ✅ required |
| Exact CLI exit code / stdout shape | ✅ required |
| Behavioural assertion ("returns X when Y") | ❌ not needed |

### Examples

```markdown
- [verbatim] `grep -rn "runThreeSessionTdd" src/ test/ | wc -l` returns `0`
- [verbatim] File `src/tdd/orchestrator.ts` does not exist after this story
- [verbatim] `grep -rn "ThreeSessionTddResult" src/ test/ | wc -l` returns `0`
- [verbatim] `test/unit/execution/builder-extensibility.test.ts` exits `0` and
  asserts new-phase edits appear only in `src/operations/`, `src/execution/story-orchestrator.ts`,
  and `src/execution/build-plan-for-strategy.ts`
```

### Rules

1. Use full backtick-quoted commands, not English descriptions of commands.
2. Pair `[verbatim]` with a behavioural AC where useful. Example: a behavioural
   AC asserts "the new gate runs after implementer," a `[verbatim]` AC asserts
   the grep guarding against regression of that ordering.
3. Removal/migration ACs (see below) are almost always `[verbatim]`.

## Story Sizing

| Size | ACs | LOC | Files | Guideline |
|:-----|:----|:----|:------|:----------|
| Simple | 3-5 | ≤50 | 1-2 | Single concern, purely additive |
| Medium | 5-8 | 50-200 | 2-5 | Standard patterns, clear requirements |
| Complex | 6-10 | 200-500 | 5+ | New abstractions, multiple modules |

### Hard splitting rules (no exceptions)

**Must split** — these are non-negotiable. The "single story with sub-deliverables"
framing is banned (see Anti-Patterns); it licenses `nax plan` to re-decompose the
spec freely and is the documented cause of the US-005 drift.

- More than 8 ACs in one story
- Story `Context Files` list has more than 5 entries
- Story contains both additive ACs ("add X", "introduce Y") and destructive ACs
  ("delete X", "remove Y", "rename X", "consolidate X into Y") — split the
  destruction into a terminal story that depends on the additive one
- Story has both "add new feature" and "refactor existing code"

**Terminal-cleanup story rule.** When a spec includes any removal/rename/consolidation
ACs, the last story must be **deletion-only** — no new code, only `[verbatim]`
grep-zero checks, file deletions, caller migrations, and import removals. This
prevents the well-known attractor where additive slices land green and cleanup
is silently dropped.

**Merge if:**
- Two stories share the same module and have <4 ACs each
- A story only makes sense as part of another (e.g., "parse schema" is not useful without "validate against schema")

**Target 3-5 stories per spec.** More than 5 usually means stories are too granular — each story should deliver a user-visible capability, not a single function.

## Context Hints (Required)

Every story **must** list relevant context files. Without them, the agent guesses which patterns to follow.

```markdown
### Context Files
- `src/plugins/extensions.ts` — existing extension interfaces (follow this pattern)
- `src/plugins/registry.ts` — registry getter pattern to replicate
- `test/unit/plugins/registry.test.ts` — existing test patterns
```

The plan phase uses these to populate `contextFiles` in the PRD, which the agent reads before coding.

For new projects with no existing code, list the files the story will **create** and their purpose:

```markdown
### Context Files
- `src/validator.ts` — core validation logic (to be created)
- `src/types.ts` — all interfaces defined in Design section (to be created)
```

## Removal & Migration ACs

When a story deletes, renames, consolidates, or replaces existing code, the
ACs must include **negative assertions** — `[verbatim]` checks that the old
thing is gone. Positive ACs alone let the agent ship scaffolding alongside the
old code without removing it (US-005 drift cause #1).

Every story whose summary or design contains "remove", "delete", "consolidate",
"replace", "migrate", or "rename" must include at least one `[verbatim]`
negative assertion. The terminal-cleanup story (see Story Sizing) should be
composed almost entirely of these.

### Example — removal story for `runThreeSessionTdd`

```markdown
- [verbatim] `grep -rn "runThreeSessionTdd" src/ test/ | wc -l` returns `0`
- [verbatim] File `src/tdd/orchestrator.ts` does not exist after this story
- [verbatim] `src/tdd/index.ts` does not export `runThreeSessionTdd`
- Behaviour previously covered by `runThreeSessionTdd` is now covered by
  the migrated tests under `test/integration/execution/`
```

The last AC is behavioural (paired with the verbatim ones). Verbatim ACs alone
prove the symbol is gone; the behavioural AC proves the capability is preserved.

## Seams — wiring producer to consumer

When a story produces a new exported symbol (e.g. `builder.addRectification`)
and a consumer (e.g. `pipeline/stages/execution.ts`) is expected to call it,
the spec must declare a **Seam** with a `[verbatim]` invariant. Without a seam
AC, multi-slice execution drops the handoff: the producer slice adds the
method, the consumer slice never wires the call, and both slices ship green.

```markdown
### Seams

- [verbatim] [grep] `grep -n "buildPlanForStrategy(" src/pipeline/stages/execution.ts`
  shows ≥1 call site after this story
- [verbatim] [grep] `grep -n "fullSuiteGateOp" src/execution/build-plan-for-strategy.ts`
  shows ≥1 reference after this story
```

Multi-story seams (producer in US-A, consumer in US-B) declare the invariant in
US-B's ACs and tag both stories with the same seam ID for traceability.

## Verification anchors — two-track ACs

Every AC needs a verification mechanism. Tag each AC with one of:

- `[grep]` — verified by a grep command embedded in the AC (almost always `[verbatim]`)
- `[file]` — verified by file-existence or non-existence (`[verbatim]`)
- `[unit]` — verified by a named unit test
- `[integration]` — verified by a named integration test
- `[cli]` — verified by running a CLI command and asserting exit code / output

**The two-anchor rule:** ACs verified only by `[unit]` on an isolated function
do not prove the production path is wired. They satisfy the agent's "make
tests green" objective without integrating the change. Pair every `[unit]` AC
that introduces a new exported symbol with either a `[grep]` or `[integration]`
AC asserting the production caller invokes it.

❌ **Insufficient (US-005 AC#3 pattern):**
- `[unit]` "test adds a failing gate and asserts verifier slot does not dispatch"

✅ **Two-track:**
- `[unit]` "test adds a failing gate and asserts verifier slot does not dispatch"
- `[verbatim] [grep]` `grep -n "fullSuiteGateOp" src/execution/build-plan-for-strategy.ts` returns ≥1

## Meta-ACs (architectural invariants)

ACs that assert architectural properties ("adding a new phase requires edits
in three places," "wrapper is read-only over `phaseOutputs`") must spell out
the exact executable check that verifies them. Without an executable backing,
meta-ACs are aspirational prose that `nax plan` will paraphrase away.

❌ **Aspirational:**
- "Adding a new phase requires edits in three places"

✅ **Executable:**
- `[verbatim] [integration]` `bun test test/unit/execution/builder-extensibility.test.ts`
  exits `0`. The test greps for `addX` overloads outside
  `src/operations/`, `src/execution/story-orchestrator.ts`, and
  `src/execution/build-plan-for-strategy.ts` and fails if any are found.

If you cannot write the command in the AC, the AC is not behavioural — remove it.

## Dependencies

Mark story dependencies explicitly:

```markdown
### Stories
1. **US-001: Add types** — no dependencies
2. **US-002: Registry support** — depends on US-001
3. **US-003: Runner integration** — depends on US-002
```

nax executes stories in dependency order. Independent stories can run in parallel.

## CLI Tools

When speccing a CLI tool, the Design section **must** include:

1. **Exit codes** — what code means success, what means failure, any special codes
2. **stdout vs stderr** — what goes where (e.g., results to stdout, errors/warnings to stderr)
3. **Output format** — exact shape of output (JSON schema, line format, etc.)

```markdown
### CLI Behavior
- Exit 0: all validations pass
- Exit 1: one or more validation errors
- stdout: validation results (human-readable by default, JSON with `--format json`)
- stderr: warnings (e.g., unknown variables) and fatal errors (e.g., file not found)
```

Without this, the agent invents its own I/O contract and it rarely matches what you expect.

## File Formats

When a feature introduces a new file format (config, schema, data), **specify the exact format** in the Design section. Use a concrete example with every supported field.

❌ **Bad:** "The schema file defines variable types and constraints"

✅ **Good:**
```json
{
  "variables": {
    "PORT": { "type": "number", "required": true, "default": "3000" },
    "DEBUG": { "type": "boolean", "required": false }
  }
}
```

Ambiguous formats → the agent guesses → the tests assert the wrong shape → rectification loop.

**Prefer JSON or YAML** for new file formats. Custom line-based formats (e.g., `KEY=type,modifier`) require the agent to write a parser from scratch — more code, more bugs, more ACs. JSON/YAML parsing is free with standard libraries.

## Extending an Existing System

When a feature extends existing code (not greenfield), the Design section **must** include:

1. **Existing types to extend** — name the exact types, interfaces, or unions the agent must modify. Don't assume the agent knows the codebase.
2. **Integration point** — where does new code plug in? Name the function, stage, or hook.
3. **Existing patterns to follow** — point to a similar feature already implemented as a reference.
4. **First story = types + config** — when adding a new capability to an existing system, the first story should extend the type system and config schema. Implementation stories depend on it.

```markdown
### Integration
- Extend `ReviewCheckName` union in `src/review/types.ts` to include `"semantic"`
- Wire into `runReview()` in `src/review/runner.ts` (same pattern as `"lint"` check)
- Add `SemanticReviewConfig` to `ReviewConfig` in `src/config/runtime-types.ts`
- Follow the same `ReviewCheckResult` return shape as existing checks
```

Without this, the agent invents its own types and wiring — which won't compile against the existing code.

## Implementation Approach

The Design section must state **how** the feature works — not just what it does. If the agent has to guess the approach, it will guess wrong.

```markdown
### Approach
This uses an LLM call (not AST analysis) to review the diff.
```

This is especially critical for features that could be implemented multiple ways (LLM vs regex vs AST, polling vs webhook, sync vs async).

## Failure Modes

Every spec should state what happens when things go wrong:

- **Fail-open vs fail-closed** — does a failure block the pipeline or get logged and skipped?
- **Retry behavior** — does the system retry? How many times? What context does the retry get?
- **Error output** — what does the user see on failure?

```markdown
### Failure Handling
- If LLM response is not valid JSON → fail-open (log warning, treat as passed)
- If review fails → autofix stage retries with findings as context
- If autofix exhausted → escalate (same as lint/typecheck exhaustion)
```

Without this, the agent either ignores errors entirely or adds overly defensive error handling that blocks on non-critical failures.

## Anti-Patterns

| Pattern | Problem | Fix |
|:--------|:--------|:----|
| Giant story (15+ ACs) | Agent gets confused, fails | Split into 2-3 focused stories |
| "Make it work" AC | Untestable | Specify exact behavior |
| Test-only story | Pipeline handles tests | Delete — each story gets tests automatically |
| Doc-only story | Not code | Put in analysis field or skip |
| Quality gate AC | Already automatic | Remove from ACs |
| Vague description | Agent guesses wrong | Include function signatures, types |
| Scope creep in ACs | Agent builds unrequested features | ACs must trace back to a requirement in Summary/Design |
| Ambiguous file format | Agent invents wrong schema shape | Show exact example with all fields in Design |
| Missing CLI contract | Agent guesses exit codes/output | Specify exit codes, stdout/stderr, output format |
| No integration context | Agent invents types that don't fit existing code | List exact types/interfaces to extend in Design |
| Missing implementation approach | Agent guesses wrong method (AST vs LLM vs regex) | State the approach explicitly in Design |
| No failure modes | Agent ignores errors or over-blocks | Specify fail-open/closed, retry, error output |
| Too many stories | Overhead per story; tiny stories are fragile | Target 3-5 stories; merge if <4 ACs each |
| Integration-only story | Duplicates ACs from earlier stories | Integration behavior belongs in the story that implements it |
| Custom file format | Agent writes a fragile parser | Use JSON/YAML unless there's a strong reason not to |
| "Single story with sub-deliverables" | `nax plan` re-decomposes freely and paraphrases load-bearing assertions (US-005 drift) | Pre-decompose into US-Xa/b/c with explicit dependencies — the planner becomes a verification step, not a decomposition step |
| Additive + destructive ACs in one story | Agent ships additive half green, defers cleanup | Split deletions into a terminal-cleanup story that depends on the additive story |
| Test-shape AC (`{ foo: true }` field assertions) | Agent reshapes API to be easy to assert | Write ACs against the contract (plan executes step N before M), not the object shape |
| Mechanical assertion as English prose | `nax plan` strips the executable verification mechanism | Mark as `[verbatim]` and embed the literal grep / shell command |
| Missing seam AC for producer/consumer pairs | Producer slice ships green; consumer slice never wires call | Add a `[verbatim] [grep]` seam AC asserting the call site exists |
| `[unit]`-only AC for new exported symbol | Isolated test passes; production caller never invokes the symbol | Pair with a `[grep]` or `[integration]` AC asserting the production wiring |
| Aspirational meta-AC ("only N edit points") | No executable check; paraphrased away | Spell out the exact grep test and the file that runs it |
| Novel code shape with no codebase precedent | Agent defaults to nearest familiar template (pattern gravity) | Either cite an existing file with the same shape or include a complete worked skeleton in Design |

## Real Example

**Bad spec (vague):**
> Add a post-run action system to the plugin framework.
> Stories: 1) Add types 2) Add registry 3) Add runner integration

**Good spec:**
> See `docs/specs/SPEC-post-run-actions.md` — includes:
> - Interface definitions with TypeScript signatures
> - Per-story ACs with function names and expected behavior
> - Context files pointing to existing patterns
> - Clear dependency chain (US-001 → US-002 → US-003)

---

*See also: `docs/specs/` for real spec examples.*
