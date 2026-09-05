# SPEC: Audit, cost and grep fidelity

## Summary

Four independent defects in which a nax run's own records or results misreport what
happened: prompt auditing aborts two CLI commands instead of degrading, sessionless
`complete()` audit records cannot be correlated to a stage or a session, native cost rows
are labelled as guessed when they were priced from real catalog rates, and the `Grep`
coding tool reports a mis-typed regex as a confident "no matches". Each is fixed in its
own story against a disjoint set of files.

## Motivation

The four defects are unrelated in mechanism and share one consequence: an operator (or a
reviewing agent) reading a run's artifacts is told something that is not true.

- **#1784** — `createRuntime` throws when `agent.promptAudit.enabled` is true and no
  feature name is supplied. `nax setup` and `nax prompts` never supply one, so both
  commands exit 1 for anyone who sets that preference globally. `nax setup` is the command
  a new project runs first, and the error names `promptAudit` and `featureName`, neither of
  which the user was thinking about.
- **#1828** — audit records written by the sessionless `complete()` path carry a constant
  `complete` filename suffix that discards the stage the record's own header knows, and
  carry no session identity even though that path derives a session id and sends it to the
  provider. Within one session the records are distinguishable only by their millisecond
  timestamp prefix, and correlate to nothing.
- **#1817** — on the native transport the cost figure is computed from nax-ai's real
  catalog rates while the row is stamped `pricingSource: "fallback-rates"`, which is
  documented to mean the number came from a generic $3/$15-per-1M card. The value exists so
  an operator can tell a guessed estimate from a real one; on this path it fires on
  estimates that are not guessed, so any triage filtering on it chases the wrong rows.
- **#1868** — `Grep` matches literal strings only, and a zero-match search returns an
  ordinary confident negative with `isError` unset. An agent that sends a regex is told the
  symbol does not occur, not that its pattern was matched literally. Measured instance: a
  native adversarial reviewer hunting callers of a changed function issued two regex
  patterns, received the miss string for both, concluded there were no callers, and a real
  caller-side regression shipped.

## Design

Each story is self-contained. US-004 depends on US-003 (it consumes the field US-003
produces); the other three have no dependencies and no shared files.

### Integration

Symbols this feature **changes**. The baseline is stated only to locate the code; it is
never the interface to implement.

**`createRuntime`** — `src/runtime/index.ts:274` (US-001)
- Baseline: when `config.agent.promptAudit.enabled` is true and `opts.featureName` is
  absent, throws `NaxError` with code `AUDIT_FEATURE_NAME_REQUIRED`.
- Target: that branch no longer throws. With no feature name available it resolves the
  same no-op auditor the disabled path already resolves, and `createRuntime` returns
  normally. With a feature name it is unchanged — a real `PromptAuditor`.

**`promptsCommand`** — `src/cli/prompts-main.ts:81` (US-001)
- Baseline: calls `_promptsMainDeps.createRuntime(config, workdir)`.
- Target: passes a third argument carrying `featureName` set to the command's already
  validated `feature` option, so `nax prompts` audits rather than silently degrading.

**`deriveAuditSuffix`** — `src/runtime/prompt-auditor.ts:145` (US-002)
- Baseline: returns the constant `"complete"` for a `complete` entry.
- Target: returns the entry's stage joined to `complete` (`acceptance-complete`) when
  `entry.stage` is set, and the bare `"complete"` when it is not — mirroring the `run`
  branch immediately above, which already puts the stage in the name.

**`CompleteResult`** — `src/agents/types.ts:382` (US-002, US-003)
- Baseline: `output`, `tokenUsage`, `estimatedCostUsd`, optional `exactCostUsd`,
  `adapterFailure`, `cancelled`.
- Target: the same, plus optional `sessionId` (US-002) and optional `pricingSource`
  (US-003). Both are absent on adapters that do not set them.

**`TurnResult`** — `src/agents/session-types.ts:150` (US-003)
- Baseline: carries `estimatedCostUsd` and `exactCostUsd` but nothing about which rate card
  produced them.
- Target: the same, plus optional `pricingSource`.

**`CompleteDispatchEvent`** — `src/runtime/dispatch-events.ts:83` (US-002, US-004)
- Baseline: adds only `kind: "complete"` to `DispatchEventBase`.
- Target: additionally carries an optional `sessionId` (US-002). It is a plain field rather
  than the sibling `protocolIds` object because a one-shot has no record id and no turn id.

**`DispatchEventBase`** — `src/runtime/dispatch-events.ts` (US-004)
- Target: carries an optional `pricingSource`, so both event kinds can report the rate card
  their producer actually used.

**`buildRateCard`** — `src/agents/native/models.ts:209` (US-003)
- Baseline: `buildRateCard(catalog, override) -> TokenPricing`, returning the override
  wholesale when present and a card built from the catalog otherwise.
- Target: returns both the card and the branch it took — the rate object plus a `source`
  discriminant that is `config-override` when an override was supplied and `catalog-rates`
  otherwise. Its two call sites are `src/agents/native/adapter.ts:187` and `:224`.

**`resolvePricingSource`** — `src/agents/cost/calculate.ts:192` (US-004)
- Baseline: returns `"model-rates" | "fallback-rates" | "unknown-model"`.
- Target: the same function and the same `MODEL_PRICING` predicate, with the return union
  widened to admit `"catalog-rates"` and `"config-override"` so producer-supplied values
  type-check through it.

**`CostEvent.pricingSource`** — `src/runtime/cost-aggregator.ts:70` (US-004)
- Baseline: an inline union `"wire" | "model-rates" | "fallback-rates" | "unknown-model"`,
  declared independently of `resolvePricingSource`'s return type.
- Target: the same inline union widened with `"catalog-rates"` and `"config-override"`.
  This is a second, separate declaration site — widening only one of the two leaves the
  feature half-landed and failing typecheck.

**`attachCostSubscriber`** — `src/runtime/middleware/cost.ts:97` (US-004)
- Baseline: `pricingSource: hasWireExactCost ? "wire" : resolvePricingSource(event.model)`.
- Target: a wire-exact cost still wins; otherwise a `pricingSource` carried on the event is
  used as-is, and `resolvePricingSource(event.model)` is consulted only when the event
  carries none. This is the same producer-supplied-wins precedent the `"wire"` branch on
  that line already sets.

**`attachAuditSubscriber`** — `src/runtime/middleware/audit.ts:5` (US-002)
- Baseline: populates `sessionId` on the audit entry only in the `session-turn` branch,
  from `event.protocolIds.sessionId`.
- Target: a `complete` event's `sessionId`, when present, reaches the audit entry's
  existing `sessionId` field.

**`grepTool.run`** — `src/tools/grep.ts:87` (US-005)
- Baseline: a zero-match search returns `{ content: 'no matches for "<pattern>"' }`.
- Target: the same result, with a clause appended when the pattern contains a regex
  metacharacter, stating that the search was performed literally and that regex
  metacharacters are not interpreted. `isError` stays unset in both cases.

Symbols this feature reads but does **not** change:

- `createNoOpPromptAuditor` — `src/runtime/index.ts:284`, the auditor the disabled path
  already resolves.
- `nativeSessionId` — used at `src/agents/native/adapter.ts:180` to derive the id the
  one-shot path already sends to the provider as `sessionId`.
- `PromptAuditEntry.sessionId` — `src/runtime/prompt-auditor.ts:53`, already declared; the
  txt renderer at `:170` already prints a `SessionId:` line whenever it is set. Only the
  producer side is missing.
- `_promptsMainDeps` — `src/cli/prompts-main.ts`, the injectable used to stub
  `createRuntime` in tests.
- `_grepDeps` — `src/tools/grep.ts:21`, the injectable `which`/`spawn` pair used to drive
  `grepTool.run` in tests without depending on the machine's binaries.
- `src/cli/plan-runtime.ts:83` — the correct three-argument
  `createRuntime(cfg, wd, { featureName })` form already in use. Note its own injectable at
  `:29` takes `featureName` as a bare string and wraps it in the object at `:83`; US-001
  wraps at the call site instead, matching `:83`.

### Approach

**Regex metacharacter detection (US-005).** The disclosure fires when the pattern contains
at least one regex metacharacter -- `.` `*` `+` `?` `(` `)` `[` `]` `{` `}` `^` `$`
`\` or the alternation bar -- and the search returned zero matches. Both
conditions are required, so a literal pattern that legitimately finds nothing is unaffected,
and a metacharacter pattern that does match is unaffected. The false-positive case — a
literal search for a filename such as `foo.ts` that genuinely has no occurrences — receives
one extra explanatory clause on an already-failed search, which is an acceptable cost for
turning a false negative into a correctable one. Detection is a module-private helper, not a
new export.

**Why the pricing source is reported rather than re-derived (US-003, US-004).**
`resolvePricingSource` re-states the `MODEL_PRICING[bareModel]` predicate that the estimator
uses, and that duplication is the defect: on the native path the estimator prices from
nax-ai's catalog while the label consults a table the catalog was chosen to avoid
maintaining. The fix therefore does not add a second predicate anywhere. `buildRateCard`
already owns the single `override !== undefined` branch that decides which card is used, so
it reports the branch it took, and that value travels with the result to the row. Adding a
sibling helper that re-tested the same condition would reproduce the exact failure mode
being fixed.

### Failure Handling

| Condition | Behaviour | Owning story |
|:---|:---|:---|
| Prompt auditing enabled, no feature name available | No throw; the no-op auditor is used and the command proceeds | US-001 |
| `complete` audit entry with no `stage` | Filename keeps the bare `complete` suffix rather than emitting an empty segment | US-002 |
| Dispatch event carries no `pricingSource` | The cost row falls back to `resolvePricingSource(event.model)`, so the ACP path is unchanged | US-004 |
| Dispatch event carries both `pricingSource` and a finite `exactCostUsd` | `"wire"` still wins — an exact wire cost outranks any estimated rate card | US-004 |
| Zero-match search whose pattern has no regex metacharacters | The miss string is returned unchanged, with no appended clause | US-005 |

## Out of Scope

- US-005 only: opt-in regex matching for `Grep` — an input that drops `--fixed-strings`/`-F`
  and accepts a real regex — is deferred. This story makes the existing literal restriction
  visible in the result; widening the tool schema is a separate decision affecting the 15
  operations that hold `Grep`.
- US-005 only: auto-detecting a regex-shaped pattern and silently re-running the search as a
  regex is deferred.
- US-005 only: rewording the `Grep` tool `description` or its `pattern` property
  description is out of scope — both already say "literal" and did not deter the failure.
- US-001 only: emitting a warning when prompt auditing degrades to the no-op auditor is
  deferred. `nax setup` has no feature by design and would warn on every invocation.
- US-002 only: the per-conversation ordinal that `run` records gained in #1824 is not
  extended to `complete` records here; an ordinal for a sessionless path needs its own
  counter design.
- US-002 only: session ids written into audit files are correlation identifiers, not
  credentials. Redaction, rotation, and access control for the prompt-audit directory are
  out of scope, and the session-turn path already writes them.
- US-004 only: honouring nax-ai's tiered pricing (`inputTokensAbove`) is out of scope and
  tracked separately in #1843. This feature changes the pricing label, not the pricing
  arithmetic.
- Adding provider-prefixed model ids to `MODEL_PRICING` in `src/agents/cost/pricing.ts` is
  out of scope; requiring that table to track nax-ai's catalog is the maintenance burden
  #1817 exists to avoid.
- Changing the documented meaning of the existing `wire`, `model-rates`, `fallback-rates`
  and `unknown-model` values is out of scope. This feature only adds values.
- Backfilling `pricingSource` on cost rows already written to disk is out of scope.
- Changing which stages or operations run on the native transport is out of scope; this
  feature changes what runs record, not what runs do.

## Stories

Five stories. US-004 depends on US-003. US-001, US-002 and US-005 are independent of every
other story and of each other.

### US-001: Prompt auditing degrades instead of blocking feature-less commands

Fixes #1784. `createRuntime`'s audit branch stops throwing when no feature name is
available, and `nax prompts` threads its already-validated `--feature` value through so the
command still audits rather than silently degrading. `src/cli/setup.ts` needs no change:
once the throw is gone, its two-argument call resolves the no-op auditor, which is the
correct outcome for a command that has no feature.

- Depends on: none

#### Context Files
- `src/runtime/index.ts` — the `createRuntime` audit branch that throws (`:274`)
- `src/cli/prompts-main.ts` — the call site missing the third argument
- `src/cli/plan-runtime.ts` — the correct three-argument form to mirror
- `src/cli/setup.ts` — the second feature-less call site, deliberately unchanged
- `test/unit/runtime/runtime.test.ts` — existing `createRuntime` test patterns

#### Acceptance Criteria
1. `[unit]` `createRuntime(config, workdir)` with `agent.promptAudit.enabled` set to true
   and no options argument resolves to a runtime instead of throwing.
2. `[unit]` For that same runtime, recording a prompt-audit entry and flushing the auditor
   writes no file into the configured prompt-audit directory.
3. `[unit]` `createRuntime(config, workdir, { featureName: "demo" })` with
   `agent.promptAudit.enabled` set to true resolves to a runtime whose auditor, after
   recording an entry and flushing, has written a file under the prompt-audit directory —
   the enabled-with-feature path is unchanged.
4. `[unit]` Invoking `promptsCommand` with `feature` set to a feature whose `prd.json`
   exists calls `_promptsMainDeps.createRuntime` with a third argument whose `featureName`
   equals that same feature string.

### US-002: Sessionless `complete()` audit records carry their stage and session id

Fixes #1828. Two independent gaps in one story because both are edits to the prompt-audit
record for the same call shape: the filename suffix discards the stage, and the one-shot
session id the native adapter already sends to the provider is recorded nowhere. The audit
entry already declares a `sessionId` field and the txt renderer already prints it, so only
the producer chain is missing.

- Depends on: none

#### Context Files
- `src/runtime/prompt-auditor.ts` — `deriveAuditSuffix`, the entry type, the txt renderer
- `src/runtime/dispatch-events.ts` — `CompleteDispatchEvent` and the session-turn sibling
- `src/runtime/middleware/audit.ts` — where `sessionId` reaches the audit entry today
- `src/agents/manager-dispatch.ts` — `buildCompleteEvent`, which assembles the event
- `src/agents/native/adapter.ts` — the one-shot `complete()` path that derives the id

#### Acceptance Criteria
1. `[unit]` Recording a `complete` audit entry with a session name and stage `acceptance`,
   then flushing, writes a file whose name ends with `-acceptance-complete.txt`.
2. `[unit]` Recording a `complete` audit entry with a session name and no stage, then
   flushing, writes a file whose name ends with `-complete.txt` and contains no empty
   segment before that suffix.
3. `[unit]` Recording a `run` audit entry with a session name, stage `run` and turn 1, then
   flushing, writes a file whose name ends with `-run-t01.txt` — the `run` branch's suffix
   is unchanged by this story.
4. `[unit]` `buildCompleteEvent` called with a `sessionId` of `nax-abc12345` returns an
   event whose `sessionId` is `nax-abc12345`.
5. `[unit]` `buildCompleteEvent` called with no `sessionId` returns an event that has no
   `sessionId` property.
6. `[integration]` With the audit subscriber attached to a dispatch event bus, emitting a
   `complete` dispatch event carrying `sessionId` `nax-abc12345` causes the auditor to
   receive an entry whose `sessionId` is `nax-abc12345`.
7. `[unit]` `NativeAgentAdapter.complete()` returns a `CompleteResult` whose `sessionId`
   equals the `sessionId` the adapter passed to the nax-ai client's `complete` call.
8. `[unit]` Two successive `NativeAgentAdapter.complete()` calls on the same adapter
   instance return the same non-empty `sessionId`, because one-shots share a backend to keep
   the provider's prompt cache warm.

### US-003: The native adapter reports which rate card priced the call

First half of #1817. `buildRateCard` already owns the single branch that decides between a
config-supplied override and nax-ai's catalog, so it reports that branch, and the adapter
puts the answer on the result it returns. Nothing consumes the field yet — US-004 does.

- Depends on: none

#### Context Files
- `src/agents/native/models.ts` — `buildRateCard` and the pricing types it maps
- `src/agents/native/adapter.ts` — the `complete()` and `sendTurn()` call sites
- `src/agents/types.ts` — `CompleteResult`
- `src/agents/session-types.ts` — `TurnResult`

#### Acceptance Criteria
1. `[unit]` `buildRateCard` called with a catalog and no override reports its source as
   `catalog-rates`, and the rate object it returns carries the catalog's cache-read and
   cache-write rates.
2. `[unit]` `buildRateCard` called with a catalog and an explicit override reports its
   source as `config-override`, and the rate object it returns is the override object
   itself, not merged with the catalog.
3. `[unit]` `buildRateCard` called with a catalog carrying tiers reports its source as
   `catalog-rates` and returns the tiers translated to nax's field names.
4. `[unit]` `NativeAgentAdapter.complete()` with a `modelDef` that carries no `pricing`
   returns a `CompleteResult` whose `pricingSource` is `catalog-rates`.
5. `[unit]` `NativeAgentAdapter.complete()` with a `modelDef` that carries an explicit
   `pricing` override returns a `CompleteResult` whose `pricingSource` is `config-override`.
6. `[unit]` A turn sent through `NativeAgentAdapter.sendTurn()` on a session whose
   `modelDef` carries no `pricing` returns a `TurnResult` whose `pricingSource` is
   `catalog-rates`.

### US-004: Cost rows record the pricing source their producer reported

Second half of #1817. The event carries the producer's answer and the cost subscriber
prefers it, exactly as it already prefers a wire-exact cost over an estimate on the same
line. The ACP path supplies no value and is unaffected.

- Depends on: US-003

#### Context Files
- `src/runtime/dispatch-events.ts` — `DispatchEventBase` and both event kinds
- `src/agents/manager-dispatch.ts` — `buildCompleteEvent` and `buildSessionTurnEvent`
- `src/runtime/middleware/cost.ts` — the `pricingSource` derivation
- `src/runtime/cost-aggregator.ts` — the second, independent declaration of the union
- `src/agents/cost/calculate.ts` — `resolvePricingSource` and its documented meanings

#### Acceptance Criteria
1. `[integration]` With the cost subscriber attached to a dispatch event bus, emitting a
   `complete` event that carries token usage, no `exactCostUsd`, and `pricingSource`
   `catalog-rates` records a cost row whose `pricingSource` is `catalog-rates`.
2. `[integration]` Emitting the same event with `pricingSource` `config-override` records a
   cost row whose `pricingSource` is `config-override`.
3. `[integration]` Emitting an event that carries token usage and no `pricingSource` records
   a cost row whose `pricingSource` equals what `resolvePricingSource` returns for that
   event's model — the ACP path is unchanged.
4. `[integration]` Emitting an event that carries both `pricingSource` `catalog-rates` and a
   finite `exactCostUsd` records a cost row whose `pricingSource` is `wire`.
5. `[unit]` `resolvePricingSource` called with a model id absent from `MODEL_PRICING` still
   returns `fallback-rates`, and called with one present still returns `model-rates`.
6. `[unit]` A `CostEvent` constructed with `pricingSource` `catalog-rates` is accepted by
   the aggregator and read back from the recorded row with that same value, so the
   aggregator's own union admits the new values.
7. `[unit]` `buildSessionTurnEvent` called with a `TurnResult` whose `pricingSource` is
   `catalog-rates` returns an event whose `pricingSource` is `catalog-rates`.

### US-005: `Grep` discloses that a zero-match search was performed literally

Fixes #1868. The tool keeps its literal-only semantics; what changes is that a miss on a
pattern containing regex metacharacters says so, turning a false negative into a correctable
one.

- Depends on: none

#### Context Files
- `src/tools/grep.ts` — the argv builder and the miss branch
- `src/tools/registry.ts` — the `ToolResult` and `ToolRunContext` shapes
- `test/unit/tools/grep.test.ts` — existing patterns for driving the tool via `_grepDeps`

#### Acceptance Criteria
1. `[unit]` `grepTool.run` with pattern `export.*divide` against a tree with no literal
   occurrence of that string returns content that includes `no matches for` and the pattern,
   and additionally states that the search was performed literally and that regex
   metacharacters were not interpreted.
2. `[unit]` `grepTool.run` with pattern `divide` against a tree with no occurrence returns
   content that includes `no matches for` and the pattern, and does not mention regex
   metacharacters.
3. `[unit]` The result returned for a zero-match search on a pattern containing regex
   metacharacters has no `isError` set, because a search that genuinely matched nothing is
   not a failure.
4. `[unit]` `grepTool.run` with a pattern containing regex metacharacters that does produce
   matching rows returns those rows and does not mention regex metacharacters.
5. `[unit]` `grepTool.run` on a machine where neither `rg` nor `grep` resolves returns a
   result with `isError` set — unchanged by this story.

### Modifies

**US-002**
- `test/unit/runtime/prompt-auditor.test.ts` — the test named "flush() writes legacy
  session-style complete filename for complete entries" records a `complete` entry with
  `stage: "acceptance"` and `sessionName: "nax-abc12345-my-feature-us-000-refine"`, then
  asserts the written path is exactly
  `1234567890000-nax-abc12345-my-feature-us-000-refine-complete.txt`. Under US-002 AC 1 a
  `complete` entry that has a stage puts that stage in the suffix, so the assertion fails
  against a correct implementation. US-002 owns updating it to the replacing invariant: the
  filename is the timestamp, the session name, the stage, then `complete` —
  `1234567890000-nax-abc12345-my-feature-us-000-refine-acceptance-complete.txt`.

**US-003**
- `test/unit/agents/native/models.test.ts` — the three tests in the `buildRateCard` describe
  block assert on the function's return value as if it were the rate object itself
  (`expect(buildRateCard(catalog, undefined)).toEqual({ inputPer1M: 2, ... })`,
  `rates.tiers` equality, and `expect(rates).toBe(override)`). Under US-003 the function
  returns the card together with the source discriminant, so all three fail against a
  correct implementation. US-003 owns updating them to the replacing invariant: each test
  asserts the same rate values on the returned card, and additionally asserts the reported
  source is `catalog-rates` for the two catalog cases and `config-override` for the override
  case.

### Seams

- `[integration]` US-002: with the audit subscriber attached to a dispatch event bus, emit a
  `complete` dispatch event carrying a `sessionId`; assert the auditor received an entry
  carrying that same id. This is the wiring between `buildCompleteEvent` and the audit
  record, which no unit test of either side alone can prove.
- `[integration]` US-004: with the cost subscriber attached to a dispatch event bus, emit a
  dispatch event carrying a `pricingSource`; assert the recorded cost row carries it rather
  than the value `resolvePricingSource` would have derived from the model string. This is
  the wiring between the producer's report and the persisted row.

<!-- spec-writing: completed-through-phase-6 -->
