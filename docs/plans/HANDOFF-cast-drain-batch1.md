# HANDOFF — `as unknown as` drain, batch 1

Delegation brief for the current target in `STATUS-test-debt-drain.md` §1. Read that doc's
§2–§5 (the loop, the forbidden list, the escalation rules) before starting. They are binding
and are not repeated in full here.

Branch: `chore/test-debt-cast-drain`. Baseline at hand-off: **91** (was 101; recipes A and B
below are already applied and committed).

---

## 0. What you must not do

The three that matter most here, restated because every previous round tripped one of them:

- **No counter may rise so another can fall.** `as any`, `as never`, `as X`, `@ts-expect-error`,
  `absentValue<T>()`, `// test-ratchet-allow` — all are counted, all are trades, all are
  refused at review. `git diff scripts/baselines/` is the check: the cast count DOWN, every
  other counter FLAT.
- **Never weaken a type in `src/` so a fixture fits.** The fixture is wrong, not the type. If
  the compiler says the source type is wrong, that is an escalation, not an edit.
- **Do not delete a comment that merely mentions the phrase.** Three of the 101 are prose in
  doc comments (`test/helpers/spawn.ts:6` ×2, `test/helpers/mock-logger.ts:16`). They are not
  work. Landing at 3 is the correct end state for this target.

## 1. Out of scope — do not touch these

**The `test/helpers/*.ts` containment casts (15 sites).** Each shared helper ends with one
`return x as unknown as MockY`, and each header explains why: the real type is a class with
private state, so a stub cannot satisfy it structurally, and the helper is the deliberate
single containment point for what used to be 12–17 casts at call sites. Removing them pushes
casts back out to consumers, or trades for `looseCast`/`absentValue`. They are:

```
test/helpers/{status-writer,context-orchestrator,plugin-registry,interaction-chain,
              merge-engine,debate-runner,mock-logger,agent-manager-internals,
              interaction-internals,mock-nax-config,pipeline-context,spawn}.ts
test/unit/findings/_cycle-fixtures.ts
```

If you think one of these is drainable, escalate with the reason — do not edit it.

## 2. Proven recipes — already applied, listed so you recognise the shape

### Recipe A — `DEFAULT_CONFIG` spread (6 sites, done)

```ts
// before
...(DEFAULT_CONFIG as unknown as Record<string, unknown>),
// after
...DEFAULT_CONFIG,
```

Spreading a typed object into an untyped literal never needed the widening. Verified: test
typecheck 0, 47 tests pass across the 4 files.

### Recipe B — `expect(x as unknown as Record<…>).toHaveProperty(…)` (4 sites, done)

```ts
// before
expect(config.review as unknown as Record<string, unknown>).not.toHaveProperty("dialogue");
// after
expect(config.review).not.toHaveProperty("dialogue");
```

`toHaveProperty` takes any object. The same file already used the bare form at two other
lines, which is what proved it. Verified: 49 tests pass.

**Note both recipes deleted a cast rather than replacing it.** That is the shape to look for
first, every time: *is this cast doing anything at all?* A meaningful fraction of the
remainder is load-bearing on nothing.

## 3. Your work — two clusters, in this order

### Cluster 1 — `.mock.calls[0] as unknown as [ … ]` (6 sites)

```
test/unit/operations/build-hop-callback.test.ts:522,585,591,635
test/unit/plan/debate-strategy.test.ts:163,188
```

All six destructure a captured mock call into a hand-written tuple. The cast exists because
the mock was created untyped, so `.mock.calls[0]` is `any[]`/`unknown[]`. **The fix is at the
mock, not at the read:** give `mock()` a typed implementation (or annotate the mock at the
real function's signature) and `.mock.calls[0]` types itself, tuple and all.

Prototype **one** site, confirm the tuple names the same types the hand-written one did, then
apply to the rest. If the typed mock changes what a `toHaveBeenCalledWith` elsewhere in the
file accepts, that is an escalation.

### Cluster 2 — `} as unknown as <Type>` incomplete fixture literals (~30 sites)

The largest family. An object literal is missing properties the type requires, so it is cast
in wholesale. Two shapes, and **the fix differs, so identify which before editing**:

- **A correct factory already exists and the call site routes around it.** Migrate the call
  site; do not touch the factory. Known factories: `makeTestContext()` in
  `test/helpers/pipeline-context.ts` for the 4 `PipelineContext` sites, `makePRD` / `makeStory`
  for the `PRD` and story sites, `makeNaxConfig()` in `test/helpers/mock-nax-config.ts` for
  config shapes.
- **No factory exists.** Complete the literal — add what the compiler asks for. If the missing
  properties are many and the same literal recurs across files, stop and propose a factory
  rather than completing it five times.

Sites (verify against `bun run scripts/check-test-as-unknown-as.ts --list`, this list is a
snapshot):

```
PipelineContext:  gating-preservation.test.ts:69 · iteration-runner-memory.test.ts:23
                  stage-assembler.test.ts:262 · stage-assembler-extra-provider-ids.test.ts:31
PRD / story:      deferred-review.test.ts:297,317 · acceptance-fix.test.ts:48
                  adversarial-advisory-findings.test.ts:6,24 · classify-route.test.ts:82
config shapes:    deferred-review.test.ts:57 · merge.test.ts:493,499,510,523
                  review-builder.test.ts:290 · adversarial-review-builder.test.ts:438
                  query-feature-context-fragments.test.ts:59 · manager-narrowed.test.ts:14
one-offs:         curator-gc.test.ts:58 · curator.test.ts:60 · verify-recover.test.ts:11
                  post-run-inspection-exhaustion.test.ts:370 · machine-invariants.test.ts:289
                  fallback-aggregates.test.ts:146 · mutation-summary-completion.test.ts:73
                  build-hop-callback.test.ts:61 · fidelity-survives-recovery.test.ts:75,92,164
                  semantic-debate-audit-shape.test.ts:74
```

The four `merge.test.ts` sites are the same literal four times — one decision covers all four.

## 4. Not in this batch

Left for the owner; do not start them.

- **Property-poke sites** — `(x as unknown as { k: T }).k = v`, ~10 sites. Each is reaching
  private or test-only state and needs a per-site ruling about whether the property should
  exist at all. Two of them (`phase4-registry-cleanup.test.ts:50,53`) read `_registry`, which
  is exactly the shape that produced a real `src/` issue last round.
- **`Parameters<typeof f>[0]`** — 6 sites. Known trap: `Parameters<…>[0]` on a *defaulted*
  parameter yields `… | undefined`, so the cast is papering over an indexing bug at the test
  site, not a source gap. Needs the ruling written before it is worth delegating.
- **spawn-mock family** — may legitimately need a typed helper built first.

## 5. Per-commit gate — all of it, in this order, every commit

```bash
bun run typecheck                            # all three projects, must be 0
bun run check:all                            # 24 gates, green BEFORE any baseline update
bun run test                                 # full suite green
bun run check:test-as-unknown-as:update
bun run check:test-escape-hatches:update
git diff scripts/baselines/                  # casts DOWN, every other counter FLAT
```

Commit as `test: <what>` with a body line `casts: P → Q`.

Batch 5–15 files per commit. Never run `--update-baseline` before `check:all` is green — it
writes whatever it finds, including a regression.

## 6. Stop and hand back when

- The same file fails twice. Two attempts, then report it.
- The error names a **source** type rather than the fixture.
- Removing a cast changes what a test asserts, or makes a *different* test fail.
- You cannot remove a cast without adding another counter.

Report per cluster: sites attempted, sites drained, the exact before/after counter numbers
from `git diff scripts/baselines/`, and every escalation with its file:line and reason.
**Do not report a count you have not read out of the ratchet.**
