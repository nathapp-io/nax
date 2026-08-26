# Test-debt drain — status

The live doc for draining `test/`'s type-escape hatches. Successor to
`archive/STATUS-1514-typecheck-drain.md`, which ran the typecheck half of the same effort to
completion and is closed.

**§0 is the live state and is re-measured, not carried forward. §9 onwards is a chronological
log — each entry records what was true when written and is not edited afterwards.**

---

## 0. Current state — measured 2026-08-26 on `fix/drain-no-explicit-any-story-orchestrator`

| Counter | Value | Baseline | Drain target? |
|:--|--:|--:|:--|
| `tsc --noEmit` (src) | **0** | — | hard gate |
| `tsc --noEmit -p tsconfig.test.json` | **0** | — | hard gate |
| `as unknown as` | **0** | 0 | done — closed invariant (§8.13) |
| `asAny` | 98 | 1377 | yes, then biome `noExplicitAny` retires it |
| `anyType` | 135 | 1860 | yes, retires with `asAny` — biome says **127** |
| `nonNullAssert` | 792 | 819 | yes — biome says **1074**, see §0.1 (not started) |
| `asNever` | 605 | 608 | yes |
| `ratchetAllow` | 103 | 105 | yes |
| `tsSuppress` | 40 | 40 | yes |
| `absentValue` | 17 | 17 | yes |
| `looseCast` | 1806 | 1875 | **no** — guard only, see below |

The `noExplicitAny` drain is in progress on this branch (§8.14–§8.22): one hundred
forty-eight files drained, `asAny` 1179 → 98 and `anyType` 1538 → 135 against the
branch-start ratchet, with every other counter flat except `nonNullAssert` (819 → 792),
`looseCast` (1875 → 1803), `ratchetAllow` (105 → 103) and `asNever` (608 → 604) as benign side
effects of removing `logger!.info = … as any` patterns and deleting real casts. Biome's
authoritative count fell **1529 → 127**.

`as unknown as` went **101 → 0** across nine commits (§8.1–§8.4, §8.11–§8.13); `looseCast`
fell 1888 → 1875 and `ratchetAllow` 107 → 105 as side effects of removing real casts, and
no counter rose in any commit. All gates green; `check:all` is 24 checks since
`check:test-typecheck` was retired.

**The ratchet is at zero and the drain is closed.** §8.1's "the seven `Mock*` helper casts
are containment, not debt" and §0's "17 is the honest floor" were both **wrong**, and §8.13
records why: they assumed the only alternatives to a cast were a structural stub or a src
change. Three mechanisms the earlier passes never tried removed all 17 —

| Mechanism | Retired | Why it was missed |
|:--|--:|:--|
| `Object.assign(new RealClass(…), mocks)` | 7 | `Object.assign` returns `T & U`, which is exactly what `MockX = RealClass & {…}` already declared |
| element access after `instanceof` | 3 | TS's `private` is compile-time only; `p["_x"]` is the language's sanctioned way through it |
| overload + loose implementation signature | 4 | callers keep the strict signature; only the unexported implementation works in `unknown` |
| comment rewrite (2 lines, 3 matches) | 3 | the prose described a design that no longer exists |

None traded a counter, and two were **strict safety improvements**: the real constructors
now type-check their own arguments (which immediately caught an invalid `defaultFallback`
value a cast had been hiding), and the `instanceof` guard makes a wrong argument fail loudly
instead of reading `undefined` off a stub.

`looseCast` is not a target. It exists so the TS2352 population ("convert the
expression to `unknown` first") cannot escape into unmarked single casts. That job
matters **more** now, not less: with `as unknown as` baselined at 0, a single `as X`
is the cheapest way to reintroduce the debt under a name the closed ratchet does not
see. Driving it down is not progress; keeping it from rising is.

### What is already done

The typecheck half is finished and gated. `bun run typecheck` compiles all three projects:

```
bun x tsc --noEmit && bun x tsc --noEmit -p tsconfig.contracts.json && bun x tsc --noEmit -p tsconfig.test.json
```

`check:test-typecheck`, its baseline and its parser are deleted — a counting ratchet at zero
reports a number where `tsc` reports a file and a line. Issue #1514 is closed. Against the
original start: test typecheck **2009 → 0 (−100%)**, casts **815 → 0 (−100%)**.

### The endgame, unchanged

From `archive/2026-08-22-1514-phase3c-test-debt-drain.md` §6, with steps 1–3 and 5 done:

1. ~~wire `tsconfig.test.json` into `typecheck`~~ done
2. ~~delete `check:test-typecheck` and its baseline~~ done
3. ~~keep the two cast ratchets as the permanent invariant~~ done — **and they are now more
   load-bearing, not less: with typecheck a hard gate at zero, a cast is the only remaining
   way to buy a green build.** They are what stops that trade. Since §8.13 the
   `as unknown as` ratchet is baselined at **0**, so it no longer tracks a drain — it is a
   pure invariant, and any nonzero reading is a regression to reject, not a number to work
   down.
4. **not done** — retire the `test/**` exemptions in `biome.json`. Two corrections since this
   was written, both from the Biome v2 upgrade (`docs/findings/biome-migration-risk.md`):

   - **Promote the override to `"error"`, do not delete it.** Under 1.9.4 both rules were
     error-severity, so deleting the exemption turned a counting ratchet into a hard gate.
     Under 2.5.10 they land at **warning**, and `biome check` exits 0 on warnings — deleting
     the override would retire ~2900 drained sites into no enforcement at all. The override
     block must end up saying `"error"`, explicitly.
   - **Judge "at 0" with biome, not the regex counters** — see §0.1. `nonNullAssert` at 0 on
     the ratchet still leaves ~273 live sites, which fails the promote-back.

   `src/` and `bin/` are already done: both rules are `"error"` there as of the v2 rollout's
   step 4, at zero cost, because neither had a single violation. Only `test/**` is left.
5. ~~update `.nax/rules/test-ratchets.md`, close #1514~~ done

---

### 0.1 Count `anyType` / `nonNullAssert` with biome, not the regex

**The regex counters are not the drain's finish line. Biome is.** Measured 2026-08-25 on
`fix/drain-no-explicit-any-story-orchestrator` after the §8.14 batch:

| Counter | regex ratchet | biome | gap |
|:--|--:|--:|--:|
| `anyType` / `noExplicitAny` | 1297 | 1288 | ~equivalent |
| `nonNullAssert` / `noNonNullAssertion` | **819** | **1092** | **273 uncounted** |

`scripts/check-test-escape-hatches.ts` is raw text, and its own doc comment concedes the
ceiling: the `nonNullAssert` pattern is anchored to postfix position and "undercounts rather
than over-" — `x! + 1` and an end-of-line `!` are both missed. Doing better needs a parser.
Biome has one.

So 273 non-null assertions in `test/` are counted by **nothing**: the regex misses them and
`noNonNullAssertion` is `off` for `test/**`. This matters for endgame item 4 specifically —
draining `nonNullAssert` to 0 as the regex measures it leaves ~273 live sites, and the
promote-back then fails on a red build. **Zero on the ratchet is not zero on the rule.**

Take the authoritative count from biome's JSON reporter. The rules are `off` for `test/**` in
the committed config, so point `--config-path` at a copy with that override dropped — the
repo's own config and lockfile are never modified:

```bash
# build a probe config: same as biome.json, minus the test/** exemption
mkdir -p /tmp/biome-probe
python3 - <<'EOF'
import json
c = json.load(open("biome.json"))
c["assist"] = {"actions": {"source": {"organizeImports": "off"}}}   # drop assist noise
c["overrides"] = [o for o in c["overrides"] if "helpers" in o["includes"][0]]
json.dump(c, open("/tmp/biome-probe/biome.json", "w"), indent=2)
EOF

bun x @biomejs/biome@2.5.10 check --config-path=/tmp/biome-probe . \
  --reporter=json --max-diagnostics=50000 2>/dev/null \
| python3 -c "
import json, sys, collections
d = [x for x in json.load(sys.stdin)['diagnostics']
     if x['location'].get('path', '').startswith('test/')]
c = collections.Counter(x['category'] for x in d)
for k in ('lint/suspicious/noExplicitAny', 'lint/style/noNonNullAssertion'):
    print(f'{k}: {c[k]}')
"
```

Two notes on the invocation. **Scope with `.` plus the python path filter, not a bare `test/`
argument**: biome resolves a path argument against the directory holding `--config-path` unless
it is absolute, so `test/` from the repo root can silently check an empty directory and report
zero. The JSON reporter also returns diagnostics for `src/` / `bin/` and the `.nax` acceptance
tests, so filter to `test/` in python — otherwise the count includes scope biome already gates.
`--reporter=json` was **not** truncated in testing — it returned all ~2900 diagnostics with and
without `--max-diagnostics` — but pass the flag anyway: the human and summary reporters do stop
early (they cap at 20 by default and print "Diagnostics not shown: N"), so anyone adapting this
to a different reporter gets a silently short count. Keep `organizeImports` off in the probe, or
every unsorted import inflates the list.

Use the regex ratchet for what it is good at — failing a PR that *adds* debt, on every commit,
in milliseconds. Use biome for "are we done yet".

## 1. Current target — none. `as unknown as` is 0 and this ratchet is closed

The ratchet counts **0**. There is no queue, no floor, and nothing held. §8.13 drained the
last 17 — the population §8.1 ruled "containment, not debt" and §1 twice declined to touch.

**The ruling that was wrong, and why it survived three passes.** §8.1 wrote: "Every route out
trades a counter: `Object.create(P) as C` is `looseCast` +1, `new C(absentValue<W>())` is
`absentValue` +1. Both are refused by the closed-system rule." Both premises were true. The
conclusion did not follow, because the enumeration was incomplete — it never asked whether
the real class could simply be **constructed**. Five of the six could be built with no
arguments at all or from a literal (`new ContextOrchestrator([])`, `new PluginRegistry([])`),
and the sixth had a ready-made helper (`makeMockCallContext`). The cast was not protecting
anything; it was standing in for a constructor call nobody tried.

The same held for the other two shapes. Reaching a `private` member does not need a cast —
TypeScript's `private` is compile-time only and element access (`p["_x"]`) is its documented
route through, which is *more* checked than a cast, not less. And a factory whose public type
no concrete value can satisfy (`typeof Bun.spawn`, generic `CallOpFn`) does not need one
either — an overload pair keeps the strict signature for callers while the implementation
signature works in `unknown`.

**Carry forward: "every route out trades a counter" is a claim about the routes you
enumerated.** It reads like a proof and is only a survey. §8.1's survey, §1's two hand-offs
and §8.11's ruling pass all inherited the same three-option frame (structural stub / cast /
src change) and none re-opened it. The question that broke it was not clever — it was "what
does this class's constructor actually require?", asked once.

The endgame item that remains is item 4 (`noExplicitAny` / `noNonNullAssertion` for `test/**`),
which needs `asAny`/`anyType` and `nonNullAssert` at 0 **as biome counts them** (§0.1), and
ends in a `"error"` override rather than a deleted one. §6.3's "baselined at 0" is now
literally true for the cast ratchet and no longer needs the amendment §1 previously asked for.

Regenerate any time:

```bash
bun run scripts/check-test-as-unknown-as.ts --list
```

## 2. The loop — per unit of work

```bash
# 1. see this unit's casts
grep -n 'as unknown as' <path>

# 2. fix (see forbidden list)

# 3. this file still passes
bun test <path> --timeout=60000
```

## 3. The loop — per commit, in this order

```bash
bun run typecheck        # src + contracts + test, all three must be 0
bun run check:all        # 24 gates green BEFORE any --update-baseline
bun run test             # full suite green
bun run check:test-as-unknown-as:update
bun run check:test-escape-hatches:update
git diff scripts/baselines/   # the target count DOWN, every other counter FLAT
```

**Never run `--update-baseline` before `check:all` is green.** The update writes whatever it
finds, including a regression.

Run `bun run test:coverage` as well, not just the suite, whenever an edit changes a value that
a classifier or switch reads (a status string, an outcome, a story/PRD shape). A per-file
coverage floor catches what a typecheck cannot: correcting an impossible fixture value can
delete a default branch's only coverage.

Commit as `test: <what>` with a body line `casts: P → Q`.

## 4. Forbidden — these lower the number without doing the work

- Adding `as any`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, or `as never`.
- Adding `// test-ratchet-allow: as-unknown-as`.
- Replacing `as unknown as X` with `as typeof X` or any other single cast.
- Deleting a comment that merely *mentions* the phrase.
- Joining two cast-bearing lines into one, or reflowing to lower a count.
- Deleting, skipping, or `.skip`-ing a test, or narrowing a `describe`.
- Excluding a file from `tsconfig.test.json`.
- Weakening a **source** type in `src/` so a fixture fits. The fixture is wrong, not the type.
- Trading one counter for another. The system is closed: no counter may rise so another can
  fall. `git diff scripts/baselines/` is the check.
- Running `--update-baseline` on a count that grew.

The escape-hatch ratchet enforces the first two mechanically. The rest are on review.

**The right fix, every time:** the test claims to hold a `T`. Make it actually hold a `T` —
complete the fixture, tighten the helper's return type, correct the arity, import the type.
If the compiler is right that the mock is incomplete, complete the mock.

## 5. Escalate instead of guessing when

- The error says a **source** type is wrong, not the fixture. (This has produced real issues
  twice — #1702 was two of them.)
- Removing the cast changes what the test asserts.
- A fixture change makes a *different* test fail. That test was relying on the wrong shape;
  report it, do not paper over it.
- Removing the cast reveals the mock cannot satisfy the interface at all.
- The same file fails twice in a row. Two attempts, then hand it back.

## 6. Rulings carried forward from the typecheck drain

These cost real time to learn and apply unchanged here. Full accounts in
`archive/STATUS-1514-typecheck-drain.md` at the sections named.

- **Re-check the ratchet slack before every hand-off** (§0). Every drain commit that lowers a
  counter without re-baselining re-opens headroom a delegate can spend without noticing. This
  re-opened and was reclaimed seven times on the last issue.
- **There is usually a third option** (§44, §47). Between "delete the test" and "widen `src/`
  to fit the fixture" sits "assert what is true now". Four inert `try {} catch {}` tests
  became one executable one that fails the day the feature is wired.
- **A defensive `?.` is not evidence of a tolerated absence** (§44). If the schema carries
  `.default()`, the key is always present after parse and the fixture was pinning an
  impossible state.
- **You do not have to reach a value through the seam that broke** (§44). The error names the
  seam, not the fix. Exporting the op was additive and loosened nothing.
- **"No caller in this file" is not "no caller"** (§47a). Scope the grep to the repo before
  concluding a feature is missing. This produced a wrong entry in a status doc and a wrong
  claim in a commit message.
- **An accepted exception is a ruling, not a law** (§47). A tier-3 "undrainable" ruling turned
  out to be an argument against `mock()`, not against the assignment; a plain generic arrow
  satisfied the slot.
- **Inert tests are the third population.** `try { … } catch {}` bodies outlive the refactors
  that invalidate them precisely because they cannot fail.
- **Verifying a cluster costs about as much as doing it.** Delegate a proven recipe with many
  sites left, not a small cluster — under roughly ten sites the review pass finishes the work.

## 7. Where the archived detail lives

| Doc | Holds |
|:--|:--|
| `archive/STATUS-1514-typecheck-drain.md` | the full 47-section log of the typecheck drain |
| `archive/2026-08-22-1514-phase3c-test-debt-drain.md` | the parent plan — gate inventory, biome interaction, phasing |
| `archive/PLAN-1514-callop-seam.md` | the `callOp` generic-in-return-position analysis |
| `archive/HANDOFF-1514-*.md` | eleven completed delegation briefs and their recipes |
| `.nax/rules/test-ratchets.md` | the live rule the gates enforce |

---

## 8. Log

### 8.1 Recipes A and B, and the helper-containment ruling (101 → 91, 2026-08-25)

Two shapes drained, both by **deleting** the cast rather than replacing it:

- **A — `DEFAULT_CONFIG` spread (6 sites, 4 files).** `...(DEFAULT_CONFIG as unknown as
  Record<string, unknown>)` → `...DEFAULT_CONFIG`. Spreading a typed object into an untyped
  literal never needed the widening.
- **B — `expect(x as unknown as Record<…>).toHaveProperty(…)` (4 sites, 1 file).**
  `toHaveProperty` takes any object. `loader-legacy-shim.test.ts` already used the bare form
  at two other lines, which is what proved the recipe before it was applied.

**The first question at every site is "is this cast doing anything at all?"** Ten of the first
ten answered no. Neither recipe needed a replacement construct, so neither could trade a
counter — the reason both landed clean on the first gate run.

### The seven `Mock*` helper casts are containment, not debt — do not drain them

§1's first-listed cluster was wrong and is corrected here. Each `test/helpers/*.ts` factory
ends with one `return x as unknown as MockY`, and each header says why: the real type is a
class with private state (`MergeEngine`'s `private worktreeManager`, `StatusWriter`'s private
state), so a stub cannot satisfy it structurally. The cast is the deliberate single
containment point for what used to be 12–17 casts at call sites — `makeStatusWriter`'s header
records "17 casts for one missing helper".

Every route out trades a counter: `Object.create(P) as C` is `looseCast` +1,
`new C(absentValue<W>())` is `absentValue` +1. Both are refused by the closed-system rule. A
shared `makeClassStub<C>()` would legitimately take 7 → 1, but that is a design decision on a
sub-ten-site cluster, which §6 says costs as much to verify as to do. Left alone, ruled
out of scope, and written into the handoff's §1 so a delegate does not rediscover it.

**Carry forward: a cast inside a shared helper is load-bearing in a way a cast at a call site
is not.** Count it, but do not target it — the number going down would mean the containment
was broken, not that the debt was paid.

Gates: typecheck 0 (all three projects), `check:all` 24/24, suite green (unit / 1173
integration / 38 ui, 0 fail). Casts **101 → 91**; every other counter flat.

### 8.2 Batch 1 delegated — two clusters, 91 → 57 (2026-08-25)

Two agents on disjoint file sets, working from `HANDOFF-cast-drain-batch1.md`, neither
committing or updating baselines. 40 sites drained across 23 files.

**Cluster 1 — typed-mock tuples (6 sites, 2 files).** `timeoutRetryMock` and `runPlanMock`
were untyped `mock(() => …)`, so every `.mock.calls[0]` read needed a hand-written tuple cast.
Typing the mocks at the real signatures (`TimeoutRetryInput`, `Parameters<DebateRunner["runPlan"]>`)
made the tuples infer and the casts fall out. **The fix was at the mock, not at the read** —
the brief said so and it held.

**Cluster 2 — incomplete fixture literals (29 sites, 21 files).** Mostly shape (a): a correct
factory existed and the call site routed around it (`makeTestContext`, `makePRD`, `makeStory`,
`makeNaxConfig`, the config selectors). Two new factories were added to
`test/helpers/mock-nax-config.ts` — `makeAdversarialReviewConfig`, `makeSemanticReviewConfig` —
built once because three files needed the same literal, per the brief's "propose a factory
rather than completing it five times".

Three sites are worth naming because the cast was load-bearing on nothing:
`post-run-inspection-exhaustion.test.ts:370` flowed through an untyped overrides bag;
`machine-invariants.test.ts:289` only needed the literal hoisted to a variable (TS
excess-property-checks fresh literals, not variables); `merge.test.ts` ×4 needed a *complete*
`context` because the signature is a shallow `Partial<NaxConfig>`, not a deep one.

### The gate the delegates were told not to run is the one that caught the breach

Both agents ran typecheck and their own tests, and both were green. `check:all` was not — a
cluster-2 edit pushed `curator.test.ts` to **809 lines against the 800 hard limit**, and four
files needed formatting. Compacted to 799 (typecheck 0, 23 tests pass) and `lint:fix` run.

Holding `check:all` and the full suite back bought parallel agents on one worktree, and the
cost was finding the breach at integration instead of at the edit. **`lint` and
`check:file-sizes` take seconds and belong in the delegate loop; only the six-minute chain and
the full suite are worth withholding.** Fixed in the next brief.

### Escalation — `AgentFallbackHop.costUsd` is required but read defensively

`test/unit/metrics/fallback-aggregates.test.ts:146` omits `costUsd` to simulate a record
deserialized from disk from before the field existed. `src/metrics/types.ts:120` declares
`costUsd: number` **required**; `src/metrics/aggregator.ts:237` reads `h.costUsd ?? 0`.

**That framing was wrong, and filing it properly overturned it — see 8.3.** The "records
deserialized from disk" premise the test comment states matches no code path that exists.
The cast stays, but for a different reason than the one written here.

Gates: typecheck 0 (all three), `check:all` 24/24, suite green (14130 / 1136 / 38, 0 fail),
coverage 101 files below floor against baseline 103 — identical to `main`, no branch effect.
Casts **91 → 57**; `looseCast` **1888 → 1879** (fell, 36 single casts removed and none added);
every other counter flat. No counter traded.


### 8.3 Filing the escalation overturned it — nax#1707

Writing 8.2's escalation up as an issue meant grepping at repo scope instead of reading the two
files the error named, and the finding changed shape entirely.

**`ctx.agentFallbacks` has no writer.** `src/metrics/tracker.ts:295` reads it inside
`collectStoryMetrics(ctx: PipelineContext, …)`; `src/pipeline/types.ts:311` declares it; and
nothing in `src/` ever assigns it. The populated field is `AgentResult.agentFallbacks`, written
at `src/agents/manager.ts:656` — a different object, and `agentResult` is already a local nine
lines above the read. So ADR-012 PR-2's run-level swap-cost visibility is inert: `StoryMetrics.fallback`
is never emitted and `RunMetrics.fallback.totalWastedCostUsd` is never computed.

It survived because the field is conditionally spread — `...(ctx.agentFallbacks?.length && …)` —
so a never-populated field silently omits the metric instead of failing.

**The `costUsd` story was backwards.** 8.2 said the absence was reachable because the hops come
off persisted metrics. They do not: `deriveRunFallbackAggregates` is called at
`run-completion.ts:437` with the in-memory `allStoryMetrics` built during the same run, and no
`JSON.parse` of `StoryMetrics` exists anywhere in `src/metrics/`. `costUsd` is required on both
the producer and consumer types. So `aggregator.ts:237`'s `?? 0` guards an absence that is
currently unreachable, and the fixture pins an impossible state — **the same §6 ruling as the
`TestPatternConfig` case, not its mirror image.**

The cast still stays: removing it needs `absentValue<T>()` or a single `as X`, both trades. But
it stays as an impossible-state fixture awaiting the wiring fix, not as evidence of interface
drift.

**Carry forward: "escalate it" and "write it up" are different amounts of rigour.** The
escalation was produced by a delegate reading two files and was accepted at face value; the
issue needed a repo-scope grep, and that grep found a real inert feature underneath. Related to
§6's "no caller in this file is not no caller" — this is the same lesson arriving from the
other direction: **a field with no writer reads exactly like a field with a tolerated absence.**

Filed as **nax#1707** with the ordering trap written down: reconcile `AgentFallbackRecord` and
`AgentFallbackHop` (`storyId` optional vs required, `timestamp` present vs dropped) before
touching `costUsd`, and do not loosen `costUsd` to optional as a standalone change — with the
wiring broken there is no evidence either way.

### 8.4 Batch 2 delegated — `Parameters<…>` and capture-widening, 57 → 47 (2026-08-25)

Ten sites drained, one escalated, one gate breach caught at integration again.

**Cluster A — `Parameters<typeof f>[n]` (6/6).** The four `model-resolution.test.ts` sites took
`makeNaxConfig()`, which satisfies the real `Pick<NaxConfig,…> | Partial<NaxConfig>` parameter.
**Neither of the other two hit the defaulted-parameter trap §1 warned about** — both
`runOrchestratorE2E`'s `config` and `productionTriageSeam`'s `ctx` are non-defaulted, and both
fixture literals were already structurally complete instances of the real type. The casts were
dead weight. The trap is real but it was not this cluster's cause; that ruling is now spent.

**`makeNaxConfig` deep-merges, and that is a trap of its own.** The fourth site needs
`models.claude` to carry `fast` *only*, to prove the function throws. `deepMerge` fully replaces
a key only when the override is an **empty** object, so a non-empty override merged into
`DEFAULT_CONFIG.models.claude.balanced: "sonnet"` and the test would have silently stopped
exercising the throw path — green, and no longer testing anything. `makeSparseNaxConfig` (total
replace, no defaults merged) is the right helper for an intentional sparse override. **A factory
migration can quietly delete a test's reason to exist; check what the fixture was *omitting*,
not just what it sets.**

**Cluster B — capture-into-`Record<string, unknown>` (4/5).** Fix at the declaration, not the
assignment: `ResolvedPermissions`, `HookContext`, `SelectScopedTestsInput`. One needed
`DeferredRegressionOptions & Record<string, unknown>` because the assertion deliberately probes
a key the interface does not declare, to prove a legacy field is never passed — the intersection
keeps that probe type-checked instead of casting it away.

### Escalation — a dead mock in `unified-executor-abort.test.ts:91`

`deps.selectNextStories = mock(…)` assigns to a key that is not on the real
`_unifiedExecutorDeps`. `selectIndependentBatch` *is* injected (`unified-executor.ts:258`), but
`selectNextStories` is imported directly at `:36` and called at `:583`, so **the mock intercepts
nothing** and the three tests pass because the real function handles the fixture PRD correctly.

Verified independently before accepting it. This is the "inert tests" family from §6 seen in a
new place — not a test that cannot fail, but a *seam* that was never wired. Removing the dead
assignment would likely drain the cast too, but that changes the test's setup and is a judgement
call, so it stays for now.

### The third gate breach, and the pattern behind it

Batch 1 breached `check:file-sizes`; batch 2 breached `check:deep-relatives`
(`import … from "../../helpers/mock-nax-config"` instead of `@test/helpers`) — even though the
brief had added `lint` and `check:file-sizes` to the delegate loop after batch 1. **Each batch
breached a *different* gate that was not in its loop.** Adding gates one incident at a time is
the wrong shape of fix; `check:all` minus the six-minute lint chain is what belongs in the loop,
and the next brief says that instead of naming individual scripts.

Fixed by the owner (one-line import swap, `check:deep-relatives` back to 0, 6 tests pass).

Casts **57 → 47**. Remaining: 17 are the floor (15 containment + 2 comments), ~14 property-poke,
~13 one-offs and spawn-mock, 2 held escalations (`#1707`, the dead mock). **Realistic target is
~17, not 0**, and everything left needs a ruling rather than a recipe.

### 8.5 nax#1707 fixed, and the issue's own fix was wrong — 47 → 46 (2026-08-25)

The held cast is drained, but not the way §8.3 predicted. **Reading `agentResult.agentFallbacks`
instead of `ctx.agentFallbacks` — the fix the issue proposed — would have left the metric just
as inert.**

`ctx.agentResult` is not the object AgentManager returned. `post-run.ts:140` *rebuilds* an
`AgentResult` from `planResult.phaseOutputs[implementerOp.name]`, which carries `success`,
`filesChanged`, `estimatedCostUsd` and `durationMs` and nothing else. Anything the manager
attached upstream is gone before `collectStoryMetrics` runs. One level further up, `callOp`
receives `outcome.fallbacks` from `runWithFallback` (`call.ts:413`) and **discards it** — it
returns only the parsed op output. `onSwapAttempt` has zero subscribers in `src/`, so the event
side was not a sink either. The hops died at `callOp`, two layers below where §8.3 was looking.

The fix is a writer, not a redirected read: a run-scoped `agentFallbacks: Map<string,
AgentFallbackRecord[]>` on `NaxRuntime`, appended by `callOp` and read by `collectStoryMetrics`.
That is the shape three sibling fields already use (`adversarialIterations`,
`semanticIterations`, `rectificationOscillations`), and because `makeMockRuntime` is built on
`createRuntime` it cost no mock churn. It also counts more than the issue's version would:
`callOp` runs for *every* op, so a swap during review or verification is attributed to the
story, where a rebuilt `ctx.agentResult` could only ever have carried the implementer's.

`ctx.agentFallbacks` is deleted rather than wired. A declared field with no writer and no reader
is what let this sit undetected; leaving it would invite the same bug back.

**`costUsd` stays required, and the `?? 0` is gone.** §8.3's re-analysis held up under the
wiring fix: the mapper fills `costUsd` from `AgentFallbackRecord`, where it is required, and
`deriveRunFallbackAggregates` still only ever sees in-memory metrics. So no ADR check was
needed — the guard was removed rather than the type loosened, and the impossible-state fixture
it justified was replaced by the *reachable* zero-cost case (an adapter that reported no cost,
which the manager records as `costUsd: 0`). That is §6's "third option" again: the test now
pins something true instead of being deleted or kept as fiction.

`timestamp` is dropped in the mapping. Nothing reads it, the hop shape already omitted it, and
`MAX_RETAINED_RUNS`'s own doc comment names `fallback.hops` as a size driver in metrics.json.

**Carry forward: a wrong reader and a missing writer look identical from the read site.** §8.3
grepped at repo scope and still landed on the wrong fix, because "the populated field is right
there on the line above" is a very convincing shape. What distinguishes them is following the
*value* forward from its producer, not the *name* backward from its consumer — the name matched
in two places and the value reached neither.

Gates: typecheck 0 (all three), `check:all` 24/24, suite green (14135 / 1136 / 38, 0 fail),
coverage 101 files below floor against baseline 103 — identical to `main`, no branch effect.
Casts **47 → 46**; `nonNullAssert` 827 → 820 as a side effect of rewriting the retargeted
assertions from `metrics.fallback!.hops` to `metrics.fallback?.hops`. No counter rose.

### 8.6 The #1707 shape swept for, and three more found (2026-08-25)

§8.5's carry-forward — *a wrong reader and a missing writer look identical from the read
site* — is mechanisable. The signature is **a field that is declared, read, and assigned only
by tests**: the test's own write is the only source, so the assertion round-trips its setup and
the suite stays green while the metric is permanently wrong.

Swept 127 fields across `PipelineContext`, `StoryMetrics`, `RunMetrics`, `CallContext` and
`AgentResult`. Three live instances, all in metrics, all fixed here.

**`ctx.rectifyAttempt` — the two halves had different names.** `post-run.ts` wrote the count to
an *undeclared* `rectificationIterationCount` through `(ctx as unknown as Record<string,
unknown>)`, which nothing read; the tracker read the *declared* `rectifyAttempt`, which nothing
wrote. `firstPassSuccess` was therefore never disqualified by rectification — the entire point
of BUG-067 / #679. **The cast in `src/` is what let the two names drift**: a declared-field
assignment would not have compiled. Fixed by writing the declared field.

**`ctx.storyRuntimeCrashes` — the counter existed, in the wrong shape.** `StoryMetrics.runtimeCrashes`
was always 0. Crash retries *were* counted, in `_runtimeCrashRetryCounts`, but that is a
*consecutive* counter which any ordinary outcome clears so the retry cap measures a streak — the
wrong source for a per-story total. Fixed with a run-scoped cumulative `runtime.runtimeCrashRetries`,
tallied in `pipeline-result-handler` where `outcome === "retry-same"` is observed (that outcome is
returned only by the crash branch, and only when a retry actually happens — a capped crash pauses).

**`autofixAttempt` — never existed at all.** Not on `PipelineContext`, not anywhere in `src/`. It
entered through `makeCtx(story, overrides: Record<string, unknown>)` and was inert; the test
comment claimed a second gate that was never built. Column dropped, and the overrides bag
tightened to `Partial<PipelineContext>` so the next phantom fails to compile.

**Threading `runtime` fixed a fourth thing nobody was looking for.** `EscalationHandlerContext.runtime`
is optional and its only caller never passed it — so `tier-outcome.ts`'s four
`ctx.runtime?.costAggregator.byStory()[…] ?? ctx.totalCost` reads had *always* taken the fallback,
and escalation failure costs (which feed `accumulatedAttemptCost`) were the coarser number.

**Carry forward: the sweep's own control failed, and that is the useful part.** Run against
`main` it reports `agentFallbacks src-writers=1` — it would **not** have caught #1707, because
`manager.ts:656` writes the same field name onto a different type. Name-matching finds
zero-writer fields; it cannot find wrong-writer ones. Those needed a hand pass over every field
in the 1–2-writer band, checking whether the writer targets *this* type. **A field-name grep is a
lower bound on this class of bug, never a clean bill of health.**

Still open at the time of writing: `ctx.autofixPriorIterations` (closed in §8.8), and
`verifyPassed` / `semanticReviewResult`, written through the same
`(ctx as unknown as Record<string, unknown>)` cast as `rectificationIterationCount` was
(closed in §8.7).

Gates: typecheck 0 (all three), `check:all` 24/24, suite green (14138 / 1136 / 38, 0 fail),
coverage 101 files below floor against baseline 103. `asAny` 1385 → 1383 and `anyType` 1868 →
1866 from replacing `(ctx as any)` reads with typed ones; no counter rose.

### 8.7 The other two AC9 fields were dead, not miswired (2026-08-25)

§8.6 left `verifyPassed` and `semanticReviewResult` flagged. Checked, and they are a
**different outcome from `rectifyAttempt` despite an identical appearance** — worth recording,
because the shared appearance is what makes this class expensive to triage.

All three were added in one commit (#1084) under an AC that reads, verbatim:
*"AC9: applyPostRunInspection sets verifyPassed, semanticReviewResult,
rectificationIterationCount"*. **The AC pinned a write and no AC pinned a reader**, so the
tests pinned the write too and everything stayed green. That is the root cause of the whole
§8.6 cluster, not an accident of naming.

The three then diverged:

| Field | Declared? | Reader | Outcome |
|:--|:--|:--|:--|
| `rectificationIterationCount` | no (cast key) | none — but the declared `rectifyAttempt` had a starving reader | **wire** (§8.6) |
| `verifyPassed` | no (cast key) | none, anywhere, ever | **delete** |
| `semanticReviewResult` | no (cast key) | none, anywhere, ever | **delete** |

`rectifyAttempt` was a *miswiring*: a real consumer existed and was starved. These two are
simply *dead*: no declared counterpart, no consumer, and no duplicated logic elsewhere that
they were caching. Verify outcome already reaches routing through `tdd-failure-category.ts`
and review outcome through the findings pipeline. Checked for dynamic key reads (`ctx[...]`)
and for `{ ...ctx }` spreads into hooks or events before concluding — a name grep alone would
not settle "no reader" for a cast-written key.

Deleting them removed the last two `(ctx as unknown as Record<string, unknown>)` writes from
`post-run.ts`, which is the construct that let `rectificationIterationCount` drift from
`rectifyAttempt` in the first place: **a declared-field assignment would not have compiled.**

**The coverage ratchet fired, and the number was misleading.** `post-run.ts` fell 57.07% →
56.07%. Measured rather than assumed: `LF` 396 → 387, `LH` 226 → 217 — both down exactly 9,
and **uncovered lines 170 → 170, unchanged**. Deleting covered dead code shrinks the
denominator, so the percentage drops while nothing loses coverage. Baseline lowered for that
one file only; `--update-baseline` also swept in four unrelated pre-existing improvements and
dropped two files entirely, all reverted per §3's "every other counter FLAT".

**Carry forward: "no reader" is a stronger claim than "no writer" and needs more evidence.**
A missing writer shows up as a wrong value at a known read site. A missing reader shows up as
nothing at all, so ruling a field dead means excluding dynamic access and context spreads too —
and the fix is deletion, which the ratchets read as a regression until you check the absolute
numbers.

Gates: typecheck 0 (all three), `check:all` 24/24, suite green (14133 / 1136 / 38, 0 fail),
coverage OK, 101 files below floor against baseline 103. `asAny` 1383 → 1377 and `anyType`
1866 → 1860 from the four deleted `(ctx as any)` assertions; no counter rose.

### 8.8 `autofixPriorIterations` — superseded, a third diagnosis (2026-08-25)

The last field flagged in §8.6, and it lands on **neither** of the previous two answers. Three
fields with one appearance have now produced three different correct actions:

| Field | Diagnosis | Action |
|:--|:--|:--|
| `rectifyAttempt` | miswired — real reader, starved | wire the writer (§8.6) |
| `verifyPassed`, `semanticReviewResult` | dead — no reader ever existed | delete (§8.7) |
| `autofixPriorIterations` | **superseded** — the feature shipped in another shape | delete |

`docs/specs/2026-05-02-adr-022-implementation-plan.md:909,922` shows the planned wiring
(`ctx.autofixPriorIterations = result.iterations` and `iterations: ctx.autofixPriorIterations ?? []`).
Neither line was ever implemented. ADR-022's carry-forward shipped instead as the run-scoped
`runtime.adversarialIterations` / `runtime.semanticIterations` maps, read and written at
`story-orchestrator/run-phase.ts:173-222` — the same run-scoped-map shape §8.5 and §8.6 reached
for independently, and for the same reason: `PipelineContext` is rebuilt every attempt.

So this is not a missing feature. The field is the residue of a design that shipped differently,
and its only `src/` mention besides the declaration was `ctx.autofixPriorIterations = undefined`
in `releaseHeavyPipelineContext` — a memory-release of something never populated. Deleting it
also retired a now-unused `Iteration` import in `pipeline/types.ts`.

**Carry forward: check whether the feature shipped elsewhere before calling a field dead.**
"No reader" and "no writer" are both satisfied by a superseded field, so neither test
distinguishes it from genuine dead code — but the actions differ in what you should look for
first. The plan doc named the intended wiring, and grepping the *shipped* mechanism from it
(`adversarialIterations`) settled in one step what field-name greps could not.

**The coverage ratchet fired again, the same way.** `iteration-runner.ts` 12.32% → 12.01%.
Measured: `LF` 284 → 283, `LH` 35 → 34, both down 1, **uncovered 249 → 249, unchanged** — the
one deleted line was covered. Baseline lowered for that file alone. This is now twice in three
commits: **deleting covered dead code always trips a per-file percentage ratchet, and the
absolute uncovered count is the number that decides whether it is real.**

Gates: typecheck 0 (all three), `check:all` 24/24, suite green (14133 / 1136 / 38, 0 fail),
coverage OK, 101 files below floor against baseline 103. No escape-hatch counter moved.

### 8.9 What code review caught that the sweep did not (2026-08-25)

An independent review of the branch found three defects the field sweep could not, because
none of them is a field-name problem.

**`rectifyAttempt` undercounted.** `runRectification` re-enters within a single attempt
(`execution-plan.ts:201,257,367`) and `phaseOutputs.rectification` is last-write-wins, so a
later cycle exiting with 0 iterations erased an earlier cycle's 2 — restoring the #679
disqualification in name only. Fixed by accumulating at the source; `iterationCount` had
exactly one reader, so the semantics change was safe. The existing envelope test in
`story-orchestrator.test.ts` asserted `1` and now asserts `2`, which is the honest number:
the plan runs two cycles and the stub reports one iteration each.

**Threading `runtime` would have switched on a billable LLM call.** `tryLlmBatchRoute` bails
without a runtime (`router.ts:361`), and `handleTierEscalation`'s only caller never passed one,
so the hybrid post-escalation re-route has never run. The threading added for cost attribution
would have activated it — a real LLM dispatch per escalation whose result lands in
`runtime.routingCache` and can change the tier the retry runs at. Deliberately **not**
forwarded; filed as nax#1710.

**The fix does not reach failed or parallel stories.** `collectStoryMetrics` runs only on the
success path (`backfill-story-metrics.ts:6` says so outright), and parallel mode builds its
`StoryMetrics` literals inline (`unified-executor.ts:413,436`) without ever calling it. So
`deriveRunFallbackAggregates`'s exhausted rule — `!story.success && lastHop.category ===
"availability"` — is structurally dead, and `parallelCount > 1` runs write both new maps and
read neither. Filed as nax#1709; the code comments now say "sequential success path" rather
than "every op".

**Carry forward: a mechanical sweep finds a shape, not a defect class.** §8.6's sweep was built
to find "declared, read, written only by tests" and it found exactly that — three times, all
correctly. It could not find a field that *is* written correctly but by a last-write-wins path,
nor one whose reach stops at a path boundary, nor a side effect on an unrelated inert feature.
**Every one of the review's findings was about reach or timing, not naming.** Pair the sweep
with a reviewer that follows the value to its consumer.

One review finding was itself wrong and worth recording: it reported the changed `story:paused`
/ `story:failed` cost source as unpinned by any test. The sibling emitter in
`preIterationTierCheck` *is* pinned in both directions
(`tier-escalation-story-failed.test.ts:161,203`) — it was `tier-outcome.ts`'s four sites that
were uncovered, and those now have a test each way. **Verify the reviewer too.**

### 8.10 Closing #1709 — the metric now reaches failed and parallel stories (2026-08-25)

§8.9 filed the two reach gaps rather than fixing them. Fixed here, because "the metric is
wired" and "the metric works" turned out to be different claims.

**Failed stories.** `synthesizeBackfillMetric` is already the single source of truth for the
`execution-failed` synthesis and already hardcoded `runtimeCrashes: 0`, so it was the right
seam: it now takes `fallbackHops` and `runtimeCrashes` and emits them. The caller reads the
run-scoped stores, which outlive the per-attempt `PipelineContext` — that property, chosen in
§8.5 for a different reason, is what makes the failure path recoverable at all. Completion-phase
spend still carries neither, correctly: nothing executed.

This makes `deriveRunFallbackAggregates`'s exhausted rule reachable for the first time. It
requires `!story.success`, and before this only successful stories ever carried hops, so the
branch was dead the day it was written. Now pinned by a test that builds a failed story through
the real back-fill.

**Parallel stories.** The two inline `StoryMetrics` literals in `unified-executor.ts` are
extracted to `synthesizeParallelStoryMetric` — the same pure-function shape as the back-fill.
The extraction was not optional: `unified-executor.ts` is grandfathered at 768 lines, so the
ratchet forbade adding two fields to two literals, and the rule's prescribed remedy is to split
by concern. **The size gate pushed the change toward the better design**, which is the second
time on this branch (§8.7's `post-run.ts` was the first, in the opposite direction).

**Nine test files hand-built a partial `runtime` stub** and broke the moment the executor read
a new field off it. That is the cost of inline mocks the repo already gates against
(`check:test-mocks`) — a real helper would have picked the fields up for free.

**The escape-hatch ratchet refused the obvious test.** A new executor-level integration test
costs two `as never` casts, because `makeCtx` returns a partial stub that cannot satisfy
`SequentialExecutionContext`. Typing the helper properly is the rule's prescribed fix and is not
tractable here; adding a containment cast would trade one counter for another, which the closed
system forbids. **So the assertions were folded into the existing test that already pins the
parallel metric entry's shape** — same claim, same setup, zero new casts. Worth naming as a
pattern: when the ratchet blocks a new test, look for the existing test making the same claim
before reaching for a cast.

Gates: typecheck 0 (all three), `check:all` 24/24 with **every counter flat**, suite green
(14149 / 1136 / 38, 0 fail), coverage OK, 101 files below floor against baseline 103.

### 8.11 The final ruling pass — 46 → 18, at the floor (2026-08-25)

§0's "the next move is a ruling pass on the ~14 property-poke sites, not another delegated
batch" was followed literally — owner work, two commits, every remaining non-floor site ruled
and drained. **18 is the floor** (14 containment + 3 comments + 1 held); the earlier "~17"
prediction was right, and the 18th site is a held escalation with a written ruling, not a
queue item.

**The property-poke cluster (13 sites): mostly dead casts, one private reach, one held.**

- `stage-assembler.test.ts:406,418` — `config.context.v2.providerTimeoutMs` is real
  (`runtime-types-context.ts:112`, read at `stage-assembler.ts:234`); direct assignment
  typechecks. The cast was dead weight.
- `manager.test.ts:227,237` — `runAs`/`completeAs` are public methods; direct assignment.
- `phase4-registry-cleanup.test.ts:50,53` — the `_registry` reach is a deliberate private
  reach, and the repo already has the containment seam for exactly this class of touch:
  `agentManagerInternals` (`test/helpers/agent-manager-internals.ts`, "contained here once
  instead of at every site"). The internals type gained `_registry`, the two call-site casts
  went away, and the helper's own containment cast still counts once. **§1's "exactly the
  shape that produced #1702" comparison did not hold here**: #1702 was an *undeclared method
  that callers used*; `_registry` is a declared private field with no external caller, so the
  route out was containment, not interface drift.
- `manager-abort.test.ts:98` — `_testAbort` exists nowhere in `src/`; the test invented a
  private hook. The mock closes over the `AbortController`, and the signal under test IS
  `controller.signal` — `controller.abort()` is the real mechanism.
- `curator-gc.test.ts:338`, `curator-seam.test.ts:315` — the `detail`/`pad` canaries are
  fixture-invented fields (the `Observation` union deliberately has no `detail`). Reached via
  `"in"` narrowing instead of a cast — same move as §8.4 cluster B: keep the probe
  type-checked, no counter traded.
- `telegram.test.ts:486` — `InteractionResponse.value?` is declared; dead cast.
- `schemas.test.ts:349,365` — `DebateConfig.stages` is real; dead cast.
- `crash-signals-idempotency.test.ts:36` — `process.exit` assignment needs only the trailing
  `as typeof process.exit`; the `process`-wide cast was dead.
- `stage-assembler.test.ts:616` — **held, with a ruling.** `PRD.feature` is required
  (`prd/types.ts:403`) and `assembleForStage` maps it unconditionally into
  `request.featureId` (`stage-assembler.ts:215`), so the `_unattached` fallback at `:272`
  cannot fire through this function. The test pokes `prd.feature = undefined` to reach an
  impossible state. The honest `_unattached` claim lives at the pipeline stage, where it IS
  reachable (`context-us004.test.ts:350` drives it via real `featureDir: undefined`).
  Deleting the test is forbidden by §4, weakening `PRD.feature` is forbidden by §4, so the
  cast stays with this ruling attached. **The §8.6-family lesson in miniature: a fallback
  that is dead in one function can be load-bearing in a sibling, and the fix is to pin it
  where it is alive.**

**The one-offs (13 sites): every one was a ruling, and every ruling paid.**

- `telegram-timeout.test.ts:51` — the `editMessageText` branch read the request body off the
  URL (`(url as unknown as Response).arrayBuffer()` — always throws, since the plugin passes
  a string URL, and the throw was swallowed by the plugin's catch). The sibling test reads
  `init.body`. Rewritten to match; the branch was inert-but-broken, §6's inert-tests family
  with a new costume.
- `adversarial-audit-shape.test.ts:388`, `pid-registry.test.ts:403` — hand-rolled spawn
  mocks replaced with `makeSpawn` / `makeSpawnResult` from `@test/helpers` (the §8.1
  "typed helper built first" route the spawn-mock cluster was waiting on).
- `acceptance-fix.test.ts:35` — local partial-`NaxRuntime` stub swapped for the shared
  `makeMockRuntime` (built on `createRuntime`, zero cast). §8.10's "nine files hand-built
  partial runtime stubs" lesson applied one file later.
- `build-hop-callback.test.ts:62` — dead cast; the literal satisfies `AgentRunOptions`.
- `build-hop-callback.test.ts:584` — §8.2's recipe verbatim: mock typed at the real
  signature, tuple infers, cast falls out.
- `call.test.ts:948` — the `"output" in result` probe works on the real `O` type; the cast
  only existed to satisfy a probe that does not need it.
- `call-exhausted-fallback.test.ts:85` — generic-return-position cast (`output as unknown
  as O` in a fixture `parse`). Every usage of `makeOpWithFallback` drives the empty-output
  branch (the agents always return ""), so the parse never needs to succeed: it now throws
  unconditionally, its return type is `never`, and `never` is assignable to `O`. The
  non-empty-parse claim is covered by a separate inline-op test that actually exercises it.
- `spawn-client-reasoning-effort.test.ts:77` — the file's "sole bridge" cast. The dep is
  `typedSpawn` (single-signature `(cmd, opts) => SpawnResult`), not overloaded `Bun.spawn`,
  so `makeSpawn` did NOT fit — but `mock()` typed at the dep's full signature
  (`mock(impl)` with `impl: typeof _spawnClientDeps.spawn`) yields a `Mock<T>` assignable
  to `T` directly. The bridge was the wrong seam, not a necessary one.
- `profile.test.ts:299` — non-string array entry supplied via `JSON.parse`, as an untyped
  config-file caller would; `parseProfileList`'s `typeof` guard stays pinned.
- `project-profile.test.ts:35` — dead cast; a spread is already an object.
- `plugin-loader.test.ts:186` — dead cast; `dynamicImport` returns `Promise<unknown>`.
- `tracker-context-metrics.test.ts:594` — corrupt `budgetPressure` supplied via
  `JSON.parse('"not-an-object"')`; the corruption literally arrives from JSON in the real
  world, so the fixture mechanism now matches the threat model.
- `pipeline-context.ts:55` — **§1's re-check row, and directory was indeed the wrong
  test**: `} as unknown as PRD` in `makeTestPRD` is a fixture literal whose fields
  (`project`/`feature`/`branchName`/`createdAt`/`updatedAt`/`userStories`) satisfy `PRD`
  directly. Dead cast. The floor drops 15 → 14.

**The held escalation drained: `unified-executor-abort.test.ts:94`.** The §8.4 dead
`selectNextStories` mock (a key not on `_unifiedExecutorDeps`, intercepting nothing — the
real function handles the fixtures) and the `Record<string, unknown>` deps bag existed only
for it. Both removed; `runIteration` is mocked at its real signature, and the three tests
still pass for the same reason they passed before — the real `selectNextStories` never had
interception to lose. **The §8.4 "judgement call, so it stays" became easy once the ruling
question was asked the §1 way: the property (`selectNextStories` on the deps bag) should NOT
exist, and the fix was at the test.**

**Carry forward: "the cast is dead" and "the cast is load-bearing" were both over-applied
before this pass.** Nine of the twelve drained sites answered §1's question with "the
property exists, the cast does nothing" — the largest single population was dead weight, not
judgement. The remaining three were each a different shape (private reach → contain;
invented hook → use the real mechanism; impossible state → hold with a ruling). The ruling
pass was cheap because the doc's §1 question, asked at each site, sorted them in one pass.

Gates: typecheck 0 (all three), `check:all` 24/24, suite green (14156 / 1136 / 38, 0 fail),
coverage OK, 101 files below floor against baseline 103. Casts **46 → 18** (two commits:
33 after the property-poke cluster, 18 after the one-offs); `ratchetAllow` 106 → 105 and
`looseCast` 1879 → 1878 as side effects of deleting real casts; no counter rose.

### 8.12 The held escalation drained — 18 → 17, the floor reached clean (2026-08-25)

§1 said the held row "stays until either the `_unattached` claim moves out of
`assembleForStage` or §4 is amended, whichever comes first." **Neither was needed. The
ruling was sound but its premise was wrong: the cast itself was never necessary.**

`stage-assembler.test.ts:616` poked `(ctx.prd as unknown as { feature?: string }).feature =
undefined` to reach the `request.featureId ?? "_unattached"` fallback at
`stage-assembler.ts:272`. §8.11 read that correctly — `PRD.feature` is required
(`prd/types.ts:403`), `assembleForStage` maps it unconditionally into `request.featureId`
(`:215`), so the poke drives an impossible state — and then reasoned about which of §4's two
forbidden moves to take (delete the test, or weaken `PRD.feature`). It held because both are
forbidden.

**Both were the wrong question.** The cast was not load-bearing for the impossible state; it
was load-bearing for *nothing*. `PRD` is structurally assignable to the weak type
`{ feature?: string }` — the target's property is optional, `string` is assignable to
`string | undefined`, and excess properties are permitted from a non-literal source — so a
widened alias needs no assertion:

```ts
const widened: { feature?: string } = ctx.prd;
widened.feature = undefined;
```

The alias is the same object, so the poke still lands; `tsc -p tsconfig.test.json` stays at 0;
all 30 tests in the file pass and the `_unattached` assertion is unchanged. No test deleted,
no `src/` type weakened, no counter traded.

**Carry forward: "this cast pins an impossible state" and "this cast is required to pin an
impossible state" are different claims, and §8.11 proved only the first.** The ruling pass
asked §1's question ("does the property exist?") and, on getting "no — and it cannot", stopped
at the forbidden-moves fork instead of asking the follow-up: *does reaching this state need an
assertion at all?* Widening to a weak alias is the third option (§6's "there is usually a
third option" in a new costume) and it costs nothing — it is not a cast, not a counter trade,
and not an escape hatch, because the alias is still fully type-checked against everything it
does have. **Where a poke narrows a type rather than fabricating one, assignability usually
already permits it; check the direction before ruling a cast necessary.**

**The `makeClassStub<C>()` seam is declined a second time, on stronger grounds.** §8.1 left it
open as a design decision deferred on §6's cost rule; §1 now closes it. A repo-wide
`makeClassStub<C>(obj): C` is an unrestricted object-to-anything escape hatch importable from
every test file. It would take the counter 17 → 10 while making the system less safe than 7
casts each sealed inside a factory whose header records why it exists — which is precisely
§4's definition of lowering the number without doing the work. **Containment is counted, not
targeted; a seam that generalises containment stops being containment.**

The drain is closed. Against the original start: casts **815 → 17 (−98%)**, test typecheck
**2009 → 0 (−100%)**. The only open item is the endgame's, not the drain's — item 4
(`noExplicitAny` / `noNonNullAssertion` for `test/**`), plus amending §6.3's "baselined at 0"
to say 17.

Gates: typecheck 0 (all three), `check:all` 24/24, suite green (14149 / 1136 / 38, 0 fail).
Casts **18 → 17**; escape-hatch baseline diff is the timestamp alone — every other counter
flat (`asAny` 1377, `anyType` 1860, `nonNullAssert` 820, `asNever` 608, `ratchetAllow` 105,
`tsSuppress` 40, `absentValue` 17, `looseCast` 1878). No counter rose.

### 8.13 The floor was not a floor — 17 → 0, the ratchet closed (2026-08-25)

§0 called 17 "the honest floor", §1 said "there is no queue", and §8.1 ruled the `Mock*`
helper casts "containment, not debt — do not drain them". **All three were wrong.** Every
one of the 17 came out, by four mechanisms none of the earlier passes had tried, and no
counter rose.

**A — the six class stubs (7 casts). `Object.assign` onto a real instance.**

Each factory ended `return stub as unknown as MockX`, where `MockX = RealClass & { method:
ReturnType<typeof mock> }`. §8.1 enumerated the routes out as `Object.create(P) as C`
(`looseCast` +1) and `new C(absentValue<W>())` (`absentValue` +1), and refused both under the
closed-system rule. **It never asked what the constructor needs.** The answer was: almost
nothing. `new ContextOrchestrator([])`, `new PluginRegistry([])`, `new WorktreeManager()` →
`new MergeEngine(…)`, `new InteractionChain({ defaultTimeout, defaultFallback })`, `new
Logger({ level: "error", suppressConsole: true })` (silent: no `filePath`, so it writes
nothing), `new StatusWriter(path, makeNaxConfig(), ctx)`, and `new DebateRunner({ ctx:
makeMockCallContext(), … })` — the last on a helper that already self-registers runtime
cleanup, so it adds no leak.

The type falls out for free: **`Object.assign(target, source)` returns `T & U`, which is
exactly the shape `MockX` already declared.** Overlaying the mocks onto a real instance
*produces* the intersection rather than asserting it:

```ts
return Object.assign(new ContextOrchestrator([]), { assemble: mock(…) }, overrides);
```

One trap: `overrides` must be a separate `Object.assign` argument, not spread into the
literal. Spreading `Partial<Record<keyof X, unknown>>` collapses the mock properties to
`unknown` and the intersection loses its `Mock` types.

**This is strictly safer than the cast, not merely equal.** The real constructors now
type-check their own arguments, and immediately caught an invalid `defaultFallback:
"approve"` in the `InteractionChain` config (the type is `"continue" | "skip" | "escalate" |
"abort"`). A cast can never catch that, because a cast checks nothing.

**B — the three private reaches. Element access after `instanceof`.**

`agentManagerInternals`, `telegramInternals` and `webhookInternals` cast an instance to a view
type exposing its privates. But **TypeScript's `private` is compile-time only, and element
access (`p["_x"]`) is the language's own sanctioned way through it** — no assertion needed.
Where the parameter was already the concrete class the accessors work directly; where it was
an interface (`IAgentManager`), `instanceof AgentManager` narrows to the class first. Each
helper now returns a live getter/setter view.

Also safer: the `instanceof` guard makes a wrong argument throw a named error instead of
silently reading `undefined` off a stub, which the cast could not do. Cost: `biome`'s
`complexity/useLiteralKeys` wants `p._x` — whose "fix" would not compile, which is why biome
marks it unsafe — so `biome.json` turns that one rule off for `test/helpers/*-internals.ts`,
recorded in both file headers.

**C — the four generic-signature casts. An overload with a loose implementation signature.**

`typeof Bun.spawn` is a set of generic overloads and `CallOpFn` is generic, so no concrete
value can satisfy either — the reason §8.1 and `_cycle-fixtures.ts` both called their casts
irreducible. They are reducible: **declare the strict signature as an overload and leave the
implementation signature loose.** Callers still see `SpawnStub` / `SpawnResult` /
`CallOpFn & Mock`; only the unexported implementation works in `unknown`, and it returns what
it actually built. This also retired `deepMerge`'s array-branch cast in `mock-nax-config.ts`,
where a generic body provably cannot narrow `DeepPartial<T>` to `T` from `Array.isArray(base)`
— `looseCast` fell 1878 → 1875 as a side effect.

Note the array branch was **not** dead: a type-level probe confirmed `NaxConfig` does have
array-valued top-level keys reachable through `makeConfigSlice`, so deleting it would have
been a silent behaviour change. §6's "no caller in this file is not no caller", one level up.

**D — the three comment matches (2 lines).** Both comments described the containment design
that A and C had just removed, so leaving them would have left two false comments in the
tree. This is *not* §4's forbidden "deleting a comment that merely mentions the phrase": the
prose had to change because the code changed. **Worth stating plainly anyway — a ratchet that
greps raw text counts prose, so the last 3 of 17 fell to an edit that changed no behaviour.**
If that ever becomes the difference between green and red, fix the counter to skip comments
rather than write around it.

`makeSpawnResult` earned an honest note while being edited. Its old comment claimed the cast
"widen[ed] through Subprocess so the fields above are still checked against it" — **false; a
cast through `unknown` checks nothing.** Adding `satisfies Partial<Subprocess>` does compile
and is the way to get that checking, and it reports three genuine divergences in the fake
(`stdin: null` against `number | FileSink | undefined`; both streams'
`Uint8Array<ArrayBufferLike>` against `Uint8Array<ArrayBuffer>`). Conforming them changes what
the fake hands the code under test, so it is left as a separate, filed change and the header
now records it instead of claiming a check that was never happening.

**Carry forward: "every route out trades a counter" was a survey wearing a proof's clothes.**
§8.1 enumerated two alternatives, found both blocked, and wrote a do-not-touch ruling that
§1's hand-offs and §8.11's ruling pass then inherited without re-opening — three passes over
the same 17 sites, each reasoning inside the same three-option frame (structural stub / cast
/ src change). Nothing clever broke it. The question was "what does this constructor actually
require?", and it had a one-line answer at five of six sites. **When a ruling says a cluster
is undrainable, check whether it enumerated the options or merely the ones already in mind —
and prefer the mechanism the language provides (constructors, element access, overloads)
before concluding none exists.**

Gates: typecheck 0 (all three), `check:all` 24/24, suite green (14149 / 1136 / 38, 0 fail),
coverage OK (87.83% lines / 87.48% functions, 101 files below floor against baseline 103).
Casts **17 → 0**; `looseCast` 1878 → 1875 as a side effect; every other counter flat. The
`as unknown as` ratchet is now a zero-baselined invariant that only regressions can move.

**Correction to this entry's first version, which reported a pre-existing e2e failure.
There was none.** `bun run test:e2e` — the script CI runs — passes 30/30 locally and on the
PR. The three "failures" were an artifact of how they were invoked: a bare
`bun test test/e2e/` inherits `bunfig.toml`'s 5s per-test timeout, while every
`package.json` test script passes `--timeout=60000`. `full-suite-rectify`'s slowest case
takes ~8s, so under the bare invocation it aborted at 5s, and the aborted test left state
that failed the NEXT file — surfacing as an "unrelated cross-file failure" in
`non-blocking-fix`. Nothing was wrong with either file.

**Carry forward: reproduce against the project's own script, not a hand-rolled invocation of
the same test files.** `bun test <dir>` and `bun run test:e2e` are not the same command, and
the difference was a flag that turns a passing suite into a cascade of misleading failures.
The claim reached a commit message, a status doc and a PR body before the gate itself was
ever run. Cheapest check available: run the gate, then read its exit code.

### 8.14 Batch 1 of the `noExplicitAny` drain — nine files, biome 1529 → 1288 (2026-08-25)

The top ten files by biome count were drained in owner work (nine of the ten before the
batch paused; `story-orchestrator-logs.test.ts`, 24 sites, is untouched and still heads the
queue). ~241 sites across nine files; `asAny` ↓186 and `anyType` ↓241 on the ratchet,
**every other counter flat** — including `looseCast`, which two early edits briefly traded
and was reclaimed (see below). Gates: typecheck 0 (all three), full suite green
(unit / integration / e2e / ui, 0 fail), ratchet `[OK]`.

**The recurring shape, and the recipe that retired most sites.** Most files hand-built an
`as any` context/runtime bag (`configLoader: {…} as any, packages: {…} as any } as any`) or
assigned `(async () => X) as any` to a dep slot. The recipes:

| Shape | Recipe |
|:--|:--|
| fake runtime bag | `makeMockRuntime({ agentManager, sessionManager, config })` — real `NaxRuntime`, zero casts |
| generic dep slot (`callOp`) | shared `makeCallOp({ fallback })` from `@test/helpers` — already generic over `<I, O, C>` |
| fabricated op literal for `AnySlot` | complete the fixture: `kind/name/stage/config/session/build/parse` with a real two-section `ComposeInput` return, checked via `satisfies RunOperation<…>` |
| `redactSecrets(x) as any` at every read | **source fix**: `redactSecrets<T>(input: T): T` — shape-preserving generic like its sibling `redactEntry`; retires all 22 call-site casts at once |
| OTLP payload builders returning `object` | **source fix**: precise `OtlpTracesPayload` / `OtlpMetricsPayload` return types; also retires the two structural `as { resourceMetrics: … }` casts in `otel-reporter/index.ts` |
| partial-config ctx | `makeNaxConfig(overrides)` + a literal `PackageView` with `select: <C>(sel) => sel.select(config)` |
| registry-keyed kind not in a closed union (`{ kind: "test-synthesis" }`) | `Object.assign(stageConfig, { selector: { kind } })` — returns `T & U`, whose `.selector` type is the intersection, assignable back to the union field |

Two source changes carried the heaviest files. Both follow the `redactSecrets` precedent:
the source return type was vaguer than the value it produces, so every consumer paid a cast.
Precision there is not weakening anything — it is what let the fixtures hold a `T` without
asserting.

**The two counter trades the first draft made, and how they were caught.** The escape-hatch
ratchet failed the verification run: acceptance.test.ts `looseCast` 1 → 3. One was a genuine
trade — `hooks: {} as any` had become `hooks: {} as HooksConfig`, moving debt from one
counter to another instead of paying it. The honest fixture is `{ hooks: {} }`, which
typechecks against `HooksConfig` directly with no assertion. The other was a **ratchet false
positive worth knowing**: the line

```
})) as unknown as typeof _executorDeps.spawn; // test-ratchet-allow: as-unknown-as
Object.assign(Bun, { file: fileStub });
```

matches `\bas\s+[A-Z]\w*` because `\s+` spans the newline — the comment's trailing `-as`
plus the next line's capitalised `Object.assign` reads as a single cast. Reordering so the
`Object.assign` precedes the cast line clears it without touching the counters. **A
comment's last word can pair with the next line's first word inside a raw-text regex;
when a looseCast appears that you did not write, read the seam between lines before
hunting for a cast you forgot.**

**Other notes.** `(Bun as any).file = stub` became `Object.assign(Bun, { file: stub })` —
same mechanism-A route as §8.13's class stubs, no assertion, restore by assigning the saved
original back through `Object.assign`. Two dead helpers (`capturingDeps`,
`resourceAttributes`) and a never-called heartbeat tracker were already unused at HEAD and
were removed while editing. Inert write-only counters (`prePhaseCallCount`,
`verifierCallCount` in runner-plug-point-dispatch) were dropped rather than asserted: a
probe confirmed the verifier dispatch does not fire in that test's config path, so an
assertion would have pinned a falsehood.

**Remaining queue** (biome count per file): `story-orchestrator-logs` 24, `debate/runner`
23, `pipeline/subscribers/interaction` 23, `verify-op` 22, `build-plan-triage-predicates` 21,
`test-presence-gate` 21 — 225 files hold the remaining 1288. After the queue reaches zero as
biome counts it, endgame item 4 promotes the `test/**` override to `"error"` (§0.1), and the
regex `asAny`/`anyType` rows retire into the rule.

### 8.15 Batch 2 of the `noExplicitAny` drain — top 2 files, biome 1288 → 1241 (2026-08-25)

The two highest-count files by biome were drained in owner work, picking up the queue §8.14
left at `story-orchestrator-logs` (24) and `debate/runner` (23). 47 sites total across the
two files; `asAny` ↓45 (993 → 948) and `anyType` ↓47 (1297 → 1250) on the ratchet, every
other counter flat except `nonNullAssert` which fell 819 → 812 as a benign side effect of
removing `logger!.info = … as any` patterns in `story-orchestrator-logs` (the new pattern is
`logger.info = … as typeof logger.info` after binding `const logger = getSafeLogger()!`
once at the top of each test). Gates: typecheck 0 (all three), full suite green (unit /
integration / ui, 0 fail), ratchet `[OK]`.

**`story-orchestrator-logs.test.ts` (24 → 0).** Two recipe families.

| Shape | Recipe |
|:--|:--|
| `{ story: { id: "US-001" } as any }` on `addTestWriter` / `addImplementer` / `addSemanticReview` (13 sites) | `makeStory({ id: "US-001" })` from `@test/helpers` — already exports a typed `UserStory` factory and `SemanticStory` is a structural subset |
| `(async () => ({ success, filesChanged, … })) as any` for run-op callOp stubs (4 sites) | `makeCallOp({ fallback: { … } })` from `@test/helpers` — already generic `<I, O, C>`, zero casts at call site |
| `logger!.info = ((stage, msg, data?) => { … }) as any` (4 sites) and `data?: any` array type (2 sites) | `const logger = getSafeLogger()!` once, then `logger.info = … as typeof logger.info` — the same recipe `test-coverage.test.ts:409` and `runs.test.ts:87` already use, retried here |
| `logger!.warn = …` (1 site) | same pattern via `typeof logger.warn` |

The `logger!.info` → `logger.info` swap also retired the four `!` non-null assertions that
came with it — that is the source of the `nonNullAssert` ↓7 outside the target rows. **No
counter traded for the drain**; the assertion swap is a strict improvement (one `!` per test
instead of one per `logger!.X` line).

**`debate/runner.test.ts` (23 → 0).** Three recipe families.

| Shape | Recipe |
|:--|:--|
| hand-rolled `runtime: { agentManager, sessionManager, configLoader, packages, signal, costAggregator } as any` (18 sites across 6 tests) | `makeMockRuntime({ agentManager, sessionManager, costAggregator: createNoOpCostAggregator() })` — real `NaxRuntime`, zero casts |
| hand-rolled `packageView: { config: DEFAULT_CONFIG, select: … } as any` (2 sites) | `runtime.packages.repo()` — the helper pattern every other debate test uses (`runner-plan.test.ts:24`, `runner-stateful.test.ts:52`, etc.) |
| `spyOn(callModule, "callOp").mockImplementation(async (…) => { …; return '{"passed":true}' as any })` (2 sites) | `spyOn(callModule, "callOp").mockImplementation(makeCallOp({ fallback: '{"passed":true}', onDispatch: (op, ctx) => { if (op.name === "debate-propose") capturedIds.push(ctx.scopeId); } }))` |

The `onDispatch` callback here is a small forward-only extension of the helper: its second
argument is now the call context, so tests that need `ctx.scopeId` (or any other ctx field)
can capture it without re-mocking `callOp`. The existing helper had only `(op)`; the new
signature is `(op, ctx)`. Source change is additive — no caller was broken — and the helper
file's own `as unknown as O` is the only `as` left in the helper (it carries the
`test-ratchet-allow: as-unknown-as` marker).

**`makeMockRuntime` gained a `costAggregator` option.** The four-file debate queue mix was
caught by the second test ("AC3: debater callOp receives scopeId from debaterScope"), which
needed to override `costAggregator.openScope` while keeping everything else from
`makeMockRuntime`. Adding `costAggregator?: ICostAggregator` to `MockRuntimeOptions` and
threading it into `createRuntime` retires the remaining `as any` cleanly. Cost tests across
the suite that previously passed `createNoOpCostAggregator()` in hand-rolled runtimes
(`runner.test.ts:makeCtxWithCostAgg`) now spread it onto `makeMockRuntime` directly; the
pattern is `{ ...createNoOpCostAggregator(), openScope: costAgg.openScope }` — `openScope`
overrides cleanly because the rest of the surface is filled from the no-op baseline, and the
test asserts on `costAgg.openScope` and `costAgg.closed` (separate fields) which the spread
preserves.

**Carry forward: the second-rung `as O` escape.** The first attempt at the callOp mocks used
`as O` inside a generic `<I, O, C>` arrow — TS-clean, but the escape-hatch script flags
every `as [A-Z]` as `looseCast`, and §3 forbids any counter trade. Switching to
`makeCallOp` moves the single `as unknown as O` into the helper (where the marker comment
lives), so the test file pays zero `as`. The recipe is now: when a generic-return callOp
mock would otherwise need an `as`, use `makeCallOp({ fallback, onDispatch })` and capture
per-op state through `onDispatch`. The helper's marker is the only escape hatch any test
needs to write itself.

Gates: typecheck 0 (all three), `check:all` 24/24, suite green (14149 / 1136 / 38, 0 fail),
coverage OK (87.83% lines / 87.49% functions, 101 files below floor against baseline 103).
Casts `asAny` ↓45 (993 → 948) and `anyType` ↓47 (1297 → 1250); `nonNullAssert` ↓7 as a
side effect; every other counter flat.

**New top of queue** (biome count per file): `pipeline/subscribers/interaction` 23,
`verify-op` 22, `build-plan-triage-predicates` 21, `test-presence-gate` 21, `plugins/registry`
19, `operations/greenfield-gate` 18 — 223 files hold the remaining 1241.

### 8.16 Batch 3 of the `noExplicitAny` drain — the top 20 files, four parallel delegates, biome 1241 → 897 (2026-08-25)

The entire §8.15 queue head drained: all twenty highest-count files (344 sites) taken to zero
by four parallel agents on disjoint file sets, working from a shared brief that carried the
§4 forbidden list, the per-file gate loop from §8.2's lesson (`tsc -p tsconfig.test.json`,
biome on the touched files, the file's own tests, both ratchets, `check:file-sizes`,
`check:deep-relatives` — everything cheap), and the standing recipe table. No delegate edited
outside its set; no helper-barrel conflicts. `asAny` ↓267 (948 → 681) and `anyType` ↓344
(1250 → 906) on the ratchet; `looseCast` ↓47 (1875 → 1828) as a benign side effect of deleting
real casts; every other counter flat, none rose. Gates: typecheck 0 (all three), `check:all`
green, full suite green (unit / integration / ui, 0 fail), coverage OK (101 below floor
against baseline 103, identical to main).

**Recipe families applied across the batch** (all proven in §8.14/§8.15 except the last):

| Shape | Where | Recipe |
|:--|:--|:--|
| config literal `{...DEFAULT_CONFIG, section} as any` | interaction subscriber, acceptance-setup-gate, plan-critic-llm, curator-collector, file-injection | `makeNaxConfig(overrides)`; `makeSparseNaxConfig` + `makeConfigSlice` where an *omission* was under test |
| ctx/runtime bag `as any` | test-presence-gate, greenfield-gate, execution-unified | `makeMockCallContext()` / `makeMockRuntime({...})` |
| op slot / callOp stubs | verify-op, quality-gate-packageview | `makeCallOp({ fallback })`; typed `_deps` objects |
| `{ story: { id } as any }` | verify-op ×9, execution-unified | `makeStory({ id })` |
| `(op as any).execute(...)` probe | test-presence-gate, greenfield-gate | direct call — the const was already typed; build/parse absence via `"build" in op === false` or an intersection-typed local |
| `<FixStrategy<Finding, any, any, any>>` restated generics ×21 | build-plan-triage-predicates | derive from the dep: `Parameters<typeof _storyOrchestratorDeps.runFixCycle>[0]["strategies"][number]` |
| `: any` payload annotations ×17 | otel-span-tree | real `OtlpMetricsPayload` + local user-defined type predicates narrowing `OtlpMetric`'s vague `sum?/histogram?: object` members |
| inline ctx literals failing to satisfy a type | adversarial-review-reground | `satisfies HopBodyContext<Input>` — contextual typing then let 14 inner single casts be deleted outright |
| `(Bun as any).file/.Glob = …` | smart-runner-discovery | `Object.assign(Bun, { … })`, restore likewise (§8.14 recipe) |

**One fixture-value correction worth recording:** the interaction-subscriber mock returned
`{ action: "escalate" }`, which is not an `InteractionAction` — `applyFallback` maps escalate→
approve and the subscriber only branches on `"abort"`, so replacing it with `"approve"`
preserves every assertion while making the fixture hold a real member. Same family as
quality-gate-packageview's bogus `"PASS"` status corrected to `"SUCCESS"`.

**A prose false positive, and the fix.** After the batch, the ratchet still counted
`anyType: 3` in build-plan-triage-predicates — a doc comment explaining the new
`Parameters<>` derivation quoted the old generic text verbatim, and `[:<|&,(]\s*any\b`
matches inside backticks. Reworded the comment; the counter is for code. This is §8.13-D's
observation from the other side: **the raw-text ratchet counts history as readily as it
counts debt — when a drain retires a shape, do not quote the shape in the surviving prose.**

**Escalation-shaped finding left open (source, not test):** `OtlpMetric.sum/histogram` are
typed bare `object` in `src/plugins/builtin/otel-reporter/otlp.ts`, so every consumer re-narrows.
Same vaguer-than-value shape §8.14 fixed at the payload level; the two predicate helpers in
otel-span-tree.test.ts are the local containment until a source follow-up exports precise point types.

**Promotion candidates noted by the delegates, not actioned:** `makePackageView(overrides)`
(two independent local copies this batch plus the §8.14 pattern), a complete-`RoutingResult`
factory, and a sanctioned stub route for *generic* dep slots (bun's `mock()` cannot satisfy
`<F extends Finding>(…) => …` without one retained `as typeof dep` assertion — same
containment model as `makeCallOp` would retire that recurring trailing cast).

**New top of queue** (biome count per file): `integration/plugins/validator` 13, `cli/plan` 13,
`acceptance-loop-cycle` 13, `adversarial-review-retry-flip` 13, `plan-draft` 13,
`acceptance-setup-criteria` 13, `retire-legacy-surfaces` 13, `tdd-verdict` 13 — 203 files hold
the remaining 897. The queue head has flattened: no file exceeds 13.

### 8.17 Batch 4 of the `noExplicitAny` drain — the next top 20 (+1 tie), four parallel delegates, biome 897 → 650 (2026-08-26)

The §8.16 queue head drained: the twenty highest-count files (237 sites) plus
`operations/plan-interactive`, which tied at 10 and rode along as a 21st file, taken to zero by
four parallel agents on disjoint file sets under the same brief model as §8.16 (§4 forbidden
list, the cheap per-file gate loop, the standing recipe table). No delegate edited outside its
set; no escalations; no src/ or helper changes required. `asAny` ↓172 (681 → 509) and `anyType`
↓247 (906 → 659) on the ratchet; `looseCast` ↓12 (1828 → 1816) and `asNever` ↓1 (608 → 607) as
benign side effects of deleting real casts (pb-004's loop-site `as never` among them); every
other counter flat, none rose. Gates: typecheck 0 (all three), `check:all` green, full suite
green (14149 / 1136 / 38, 0 fail), coverage OK (101 below floor against baseline 103, identical
to main).

**Recipe families applied** (all proven in §8.14–§8.16 except where noted):

| Shape | Where | Recipe |
|:--|:--|:--|
| plugin-interface impls with untyped params (`async optimize(input: any)`) | validator | annotate at the real interface types (`PromptOptimizerInput`, `UserStory` + `RoutingContext`, `RunStartEvent`/`StoryCompleteEvent`/`RunEndEvent`); `satisfies NaxPlugin` contextual typing drops annotations where the object is checked |
| post-migration pokes on `Record<string, unknown>` returns (`result.execution as any?.field`) | migrations | local `hasKey` user-defined predicate + probe walker; missing keys still yield `undefined` and fail the same assertions |
| namespace probes (`(tddIndex as any).removedThing`) | retire-legacy-surfaces | absent symbols index a module-scope `Record<string, unknown>` spread of the barrel; present symbols switch to static typed access |
| op.config / op.retry unions | adversarial-review-retry-flip | `typeof === "function"` + `"prop" in` guards narrowing to the real member types |
| stage-module stubbing for dynamic-import seams | acceptance-loop-cycle ×2 files | `Object.assign({}, pipelineStages, { acceptanceStage: { …spread, execute } })` — assignable to the real `typeof import("@/pipeline/stages")` |
| required run-options fields fabricated loosely (`STUB_RUN_OPTIONS as any`) | stale-then-swap | `makeStubRunOptions(config)` constructing the required `modelTier`/`modelDef`; note `runOptions.config ?? this._config` made config-absence load-bearing — each caller now passes its own manager config |
| already-typed builder discovered mid-drain | pb-004-migration | every `(PromptBuilder.for(…) as any)` deleted outright once `withLoader` was found fully typed on the class |

**Fixture-value corrections, all assertion-preserving and reported per §4's rule-3 carve-out:**
the diagnosis callOp stub returned an `{ output: {…}, costUsd }` wrapper the dep never produces
(consumer reads `.verdict` off the resolved value directly) → corrected to a direct
`AcceptanceDiagnosisOutput`; stage-fail results gained the required `reason` string;
`SEMANTIC_CONFIG_DEFAULT` gained `resetRefOnRerun: false` (the documented default the old inner
cast silently omitted); AC-2's debate spread gained required `sessionMode: "one-shot"` — with
the companion lesson that adding it to the *shared* base broke "injects sessionMode stateful",
whose omission is intentional under test (**what the fixture omits can be the thing under
test; complete fixtures only at the call site that needs them**, §8.4's deepMerge trap from the
other side). Because these are values classifiers read, §3's coverage rule fired:
`bun run test:coverage` confirmed per-file floors unaffected.

**New top of queue** (biome count per file): `execution-phase-telemetry` 10,
`otel-reporter-lifecycle` 10, `adversarial-metadata-audit` 10, then six files at 9 — 182 files
hold the remaining 650. The head has flattened again: no file exceeds 10, so the next batch is
necessarily wider and shallower.

### 8.18 Batch 5 of the `noExplicitAny` drain — the top 10 (+1 tie), four parallel delegates, biome 650 → 548 (2026-08-26)

The §8.17 queue head drained: three files at 10 plus eight files tied at 9. A strict
top-10 cut lands mid-tie, so the tie rode along as an 11th file (§8.17's precedent) —
93 biome sites taken to zero by four parallel agents on disjoint file sets under the same
brief model as §8.16/§8.17 (§4 forbidden list, the cheap per-file gate loop, the standing
recipe table). No delegate edited outside its set; all escalations resolved test-side, with
zero src/ or helper changes required. `asAny` ↓74 (509 → 435) and `anyType` ↓102 (659 → 557)
on the ratchet; `ratchetAllow` ↓2 (105 → 103) and `looseCast` ↓1 (1816 → 1815) as benign side
effects of deleting real casts (acceptance-missing-target's two spawn-stub markers among
them); every other counter flat, none rose. Gates: typecheck 0 (all three), `check:all`
green, full suite green (unit / integration / ui, 0 fail).

**Recipe families applied** (all proven in §8.14–§8.17 except where noted):

| Shape | Where | Recipe |
|:--|:--|:--|
| dep-slot stub factories (`createWorktreeManager`/`createMergeEngine`) | parallel-batch-rectification | `makeWorktreeManager()` / `makeMergeEngine({ mergeAll })` from `@test/helpers` — both intersection types fit the slots directly |
| probe reads on captured audit calls ×8 | adversarial-metadata-audit | shared `captureAuditDecisions()` from `@test/helpers` (already used by a sibling) → typed `ReviewAuditDecision[]`, probes index without casts |
| union-member call `(op.retry as any)(…)` ×8 | adversarial-retry-truncation | local `resolveRetryStrategy()`: `typeof !== "function"` guard narrows to the resolver, `"shouldRetry" in` narrows the result — verbatim from `adversarial-review-retry-flip.test.ts` |
| whole-context hand-rolled bags | execution-phase-telemetry, plan-inputs | `makeTestContext()` / `makeDispatchContext()` supply real runtime/session/agent surfaces; the trailing `} as PipelineContext` fell with them |
| dep slot returning a fabricated object | execution-phase-telemetry | complete at the declared type — including a **real `ExecutionPlan`** for `buildPlanForStrategy` (private fields make it unsatisfiable structurally; `new ExecutionPlan(callCtx, {}, false)` + one typed `_deps` stub for its only I/O seam) |
| OTLP payload/spans typed loosely | otel-reporter-lifecycle | `OtlpTracesPayload \| OtlpMetricsPayload` union on the posts array; URL-filter predicates narrow to `MetricsPost`/`TracesPost`; local `SpanProbe` predicate over src's vague `object[]` spans (otel-span-tree precedent) |
| each()-tuple params + dynamic-key probes | plan-inputs | explicit `test.each<[…]>` generics: `Partial<UserStory>` overrides, `keyof UserStory` field → direct indexing, no annotations |
| `(op.execute as any)`-style calls ×14 across twins | lint/typecheck-check-tool-diagnostics | dead casts — `execute` exists on the declared op type; deleted outright. mechanical-lintfix's variant was NOT dead (broad `Operation` union): `"execute" in fixOp` guard + deterministically-typed local |
| spawn mocks, monkey-patches, gate-ctx stubs | _tdd-test-helpers, acceptance-missing-target | `makeSpawn(...)` for every `_xDeps.spawn` slot; `Object.assign(Bun, { file })` patch/restore; gate-ctx completed at real `FullSuiteGateContext` |

**Fixture-value corrections, all assertion-preserving and reported per §4's carve-out:** the
retry-truncation input literals lacked required `workdir` (masked by the old cast); the
metadata-audit config sat under a key path the review slice never had — moved to the real
`review.audit.enabled` schema path; the tdd gate-ctx stub gained the schema-required
`cmdWorkdir`; execution-phase-telemetry's routing gained required `reasoning: ""`; and two
plan-inputs fixtures dropped `inlineReview: true` — a legacy field already **deleted from
src/** that compat-shims strips with a warning, asserted by nothing. None is a value a
classifier branches on, so §3's coverage rule did not fire.

**One containment worth naming:** typing `_tdd-test-helpers`'s `mockAllSpawn(mockFn: any)`
strictly as `typeof Bun.spawn` broke an importer outside the delegate's set that passes a
partial-shape mock. The fix is a structural `PartialSubprocess` contract presented into the
dep slots through a contained overload (`presentAsSpawn`, the `makeSpawnResult` move) — the
helper keeps accepting what callers actually pass while every *dep slot* stays fully typed.
**When tightening a shared helper's parameter breaks a caller you cannot edit, contract the
input and widen only at the presentation seam — not by re-loosening the helper.**

**New top of queue** (biome count per file): eight files tied at 8 —
`integration/context/test-coverage-parity`, `agents/acp/activity-emission`, `cli/plan-debate`,
`debate/runner-mode-routing`, `debate/session-helpers`,
`interaction/plugins/cli`, `precheck/precheck-checks-tier2-warnings`,
`review/semantic-retry` — 171 files hold the remaining 548. The head has flattened again:
no file exceeds 8, and the next ten-file batch spans five of these ties exactly.

### 8.19 Batch 6 of the `noExplicitAny` drain — the top 20 (+ full 7-tie ride-along), four parallel delegates, biome 548 → 380 (2026-08-26)

The §8.18 queue head drained: eight files tied at 8, then a sixteen-file tier at 7 spanning
ranks 9–24. A strict top-20 cut lands mid-tie, so the whole tier rode along (§8.17/§8.18
precedent) — 24 files, ~168 biome sites taken by four parallel agents on disjoint file sets
under the same brief model as §8.16–§8.18 (§4 forbidden list, the cheap per-file gate loop,
the standing recipe table). No delegate edited outside its set; zero src/ or helper changes;
23 of 24 files reached zero.

**One escalation held: `interaction/plugins/cli.test.ts` (8 sites, untouched, gates green).**
The tests inject into `CLIInteractionPlugin`'s class-private `rl` and call private
`promptUser`. Two structural attempts failed: an upcast to a local view interface hits TS2342
(privacy modifiers break structural comparability in both directions), and generic keyed
accessors fail because `keyof CLIInteractionPlugin` excludes private members at external call
sites. A public-API-only redesign (`send` + `receive`) cannot faithfully preserve BUG-21's
assertions (`closeCalls === 1`, post-recreate identity of the private `rl`). **The site is
src-blocked, not test-hard**: it needs a sanctioned seam (`_deps.createReadline` injection,
or `rl` protected plus a tiny test subclass) before it can drain. Whoever takes it should
also correct the fixture then — it pokes `stage: "verify"` (not an `InteractionStage`
member) and `prompt`/`context` fields that do not exist on `InteractionRequest`, while the
required `fallback`/`createdAt` are missing.

Ratchet: `asAny` ↓124 (435 → 311) and `anyType` ↓168 (557 → 389); `looseCast` ↓4
(1815 → 1811), `asNever` ↓2 (607 → 605) and `nonNullAssert` ↓11 (812 → 801) as benign side
effects of deleting real casts and `!` assertions; `tsSuppress`/`ratchetAllow`/`absentValue`
flat; no counter rose anywhere, including per-file. Gates: typecheck 0 (all three),
`check:all` green, full suite green (14149 / 1136 / 38, 0 fail), coverage OK (101 below floor
against baseline 103 — run explicitly because two fixture corrections touch values feeding
source branches).

**Recipe families applied** (all proven in §8.14–§8.18 except where noted):

| Shape | Where | Recipe |
|:--|:--|:--|
| absent-key probes `(x as any)?.key` ×8 | acp/activity-emission | local predicate `activityLacksKey(a, key)` via `key in obj`, undefined-safe |
| `session!.x` after async load ×4 | acp/activity-emission | `assertDefined(session, …)` from `@test/helpers` immediately after `loadSession` — throws like the removed `expect(...).not.toBeNull()` |
| hand-typed ctx masked by a whole-arg cast / hop-body literals | adversarial-review-requote, review/semantic-retry | delete the cast — the literal is contextually typed against the real `HopBodyContext<Input>`; or close with `} satisfies HopBodyContext<SemanticReviewInput>)` (adversarial-review-reground verbatim) |
| restated generic unions `<FixStrategy<…, any, any>>` | fix-strategy-composition | `type ComposedStrategy = ReturnType<typeof makeXStrategy> \| …` over the four factories — self-maintaining, no widened holes |
| dead casts on union members and null slots | role-task ×7, pull-tools ×7, mutation-check, precheck-tier2 ×5, plan-debate | `"python"` is already in `ProjectProfile["language"]`; `null ∈ string \| null \| undefined`; src's role union already contains `"tdd-simple"`/`"standard"`/`"lite"`; `getLogger` slot returns a real `Logger` — deleted outright, no replacement construct |
| partial-`NaxConfig` hydrate literals | runtime/packages ×4 | **`Partial<NaxConfig>` is not deep** — nested sections must be complete, so build overrides through `makeNaxConfig({ quality: { commands: { lint } } })` (a full config) instead of nesting literals |
| normalize-row expected values typed loosely | prd/schema | explicit `test.each<[string, Complexity]>` generics; every expected literal is already a union member once the tuple is typed |
| each()-row illegal values `false` for `cmd` fields | precheck-tier2 ×3 | `false` is not a legal value of the field type; source skip branch is `!cmd \|\| cmd === null`, so falsy/null/undefined share one path — rows now use `undefined` |
| `(op as any).build/.parse` property-pokes | lint-check, typecheck-check, verify-scoped, mechanical-formatfix | `"build" in op` guards + deterministically-typed locals (mechanical-lintfix precedent); ctx bags rebuilt from the already-drained `-tool-diagnostics` twins |
| weak-alias deletes on stage config | debate/runner-mode-routing | §8.12's move: `const withoutMode: { mode?: DebateMode } = stageConfig; withoutMode.mode = undefined;` — the runner reads `.mode ?? default`, so explicit undefined ≡ absent key |

**Fixture-value corrections, all assertion-preserving and reported per §4's carve-out:** mock
send returns gained required `estimatedCostUsd: 0` (`TurnResult` requires it; nothing asserts
cost) in requote and semantic-retry; lint-check's dep stub returned `format: "text"`, which is
not an `LintParserFormat` member (`"text"` belongs to the *input* union) → `"text-block"`;
verify-scoped passed `{ kind: "test", id }` where a real `Finding` is required → replaced with
the in-file well-formed fixture, and its `resolvedTestPatterns` literal gained the cast-masked
required `resolution: "per-package"`; coverage-parity dropped a `patterns` key that is not on
`ResolvedTestPatterns` (the provider reads `resolved.patterns ?? resolved.globs`, so `globs`
supplies the identical value). The precheck correction touches a value feeding the skip
branch, so §3's coverage rule fired at integration: floors unaffected.

**Carry forward: even at flattened queue heads, half the population is still assertions doing
nothing.** Of ~168 sites this batch, the largest single family was *dead casts* — values or
shapes the declared types already admit (`role-task`'s seven, `pull-tools`' seven, precheck's
five `null as any`s, mutation-check's `"python"`) — retired by deleting, not by building.
The standing recipes keep paying, but the first question at each site remains §1's original:
is this cast doing anything at all? Second carry forward: **a private-member injection site
with no existing seam is src-blocked** — two failed structural routes plus an assertion-losing
public redesign is the evidence, and the honest outcome is a held count plus a written seam
proposal, not a third workaround.

**New top of queue** (biome count per file): `interaction/plugins/cli` 8 (held escalation,
src-blocked), then seven files tied at 6 — `integration/execution/fullsuite-rectify-declaration`,
`integration/execution/nbf-rectify-declaration`, `operations/build-hop-callback-stale-retry`,
`pipeline/stages/acceptance-setup-fingerprint`,
`pipeline/stages/completion-fragment-capture`, `prompts/builders/critic-builder`,
`prompts/sections/isolation` — 148 files hold the remaining 380.

### 8.20 Batch 7 of the `noExplicitAny` drain — the tiers at 6 and 5, four parallel delegates, biome 380 → 278 (2026-08-26)

The §8.19 queue head drained: the seven files tied at 6 plus the whole twelve-file tier at 5
(a strict top-10 cut lands mid-tie; ride-along per §8.17–§8.18 precedent) — 19 files, ~102
biome sites taken by four parallel agents on disjoint file sets under the same brief model as
§8.16–§8.18 (§4 forbidden list, the cheap per-file gate loop, the standing recipe table). The
two mutation-check files that share a helper (`helpers/mutation-check.ts` +
`operations/mutation-check-revert`) were assigned to one delegate deliberately. No delegate
edited outside its set; zero src/ changes; **zero escalations held — all 19 files reached
zero.**

Ratchet: `asAny` ↓86 (311 → 225) and `anyType` ↓100 (389 → 289); `looseCast` ↓5 (1811 → 1806)
as a benign side effect of deleting real casts; every other counter flat; no counter rose
anywhere, including per-file. Gates: typecheck 0 (all three), `check:all` green, full suite
green (**14149 / 1136 / 38, 0 fail** — after the incident below), coverage OK (101 below floor
against baseline 103, identical to main).

The largest single family was, again, dead casts — §8.19's carry-forward holding at the next
tier down:

| Shape | Where | Recipe |
|:--|:--|:--|
| dead casts on values the declared types already admit ×20+ | rectify-decl ×2 (`FixStrategy<Finding, any,…>[]` element params are already `any` in src), reporters-schema (`.default()` makes `otel.logs` non-optional), acceptance-setup ×2 (config/prd literals already satisfied `NaxConfig`/`PRD`), build-hop-callback (typed dep returns), isolation/builder (`"tdd-simple"` ∈ src unions), critic-builder (`require` scaffolding → static typed import) | deleted outright |
| hand-typed runtime/ctx bags | runner-agent-resolution, session-helpers-resolver-model, helpers/mutation-check | `makeMockRuntime({...})` / `makeMockCallContext()` / structural `PackageView` with generic `select<C>(s): C { return s.select(config) }` |
| partial-config literals | context-verification-integration, context-build ×5 sites each | `makeNaxConfig({ context: {...} })` |
| loosely typed each()-rows | rectifier-builder | explicit `test.each<[string, ReviewCheckResult[], boolean]>()` generic |
| story/PRD fragments | critic-builder, mutation-check-revert | `makeStory(...)` / `makePRD(...)` |
| incomplete fixture object | mutation-check-revert PATTERNS | existing `makeResolvedTestPatterns` (+ required `resolution: "detected"`) |
| generic dep slots (`<I, O, C>`) no wrapper satisfies by assignment | completion-fragment-capture, semantic-iteration-wiring, e2e/orchestrator-harness | mock derived via `Parameters<typeof origFn>`; slot replaced by `Object.assign(_deps, {...})` with finally-restore (§8.15 containment model) |

**Fixture-value corrections, all assertion-preserving and reported per §4's carve-out:**
semantic-iteration-wiring's prior Iteration carried `outcome: "fixes-applied"`, not an
`IterationOutcome` member → `"resolved"` (value only round-trips through the store);
STUB_RUN_OPTIONS gained `AgentRunOptions`-required `modelTier`/`modelDef`/`config`;
mutation-check-revert's PATTERNS gained required `resolution: "detected"` (unread); reporters-schema
dropped optional chains on post-`.default()` keys. Because two of these feed comparisons,
§3's coverage rule fired at integration: floors unaffected.

**The incident — mutating a `makeNaxConfig()` result poisoned `DEFAULT_CONFIG` process-wide.
Every gate was green before it and the full suite caught it.** One helper rewrite ended

```ts
const config = makeNaxConfig();
applyQuality(config, quality);            // writes config.quality.commands
Object.assign(config.execution, execution);
```

`deepMerge` clones only the levels it descends into, so **each unmodified subtree is still
the same object as `DEFAULT_CONFIG`'s** — both writes landed on the global default. The
helper's historical contract set `quality.commands = { test: "bun test" }`; the schema default
is `{}`. Later files' `makeNaxConfig()` inherited the pollution, and
`precheck-checks-tier2-warnings`' "skips silently when test command is undefined" assertion
(reads `execution.testCommand || quality.commands.test`) flipped to "configured: bun test".
`mutation-check-wiring` failed the same way one hop removed. Both files passed **solo**, and
the four delegates had each run their own sets green: the failure only exists in the
full-suite runner's shared worker. Fixed by deep-cloning first:
`structuredClone(makeNaxConfig())` before either write.

Carry forward, two halves: **a factory return is safe to read and unsafe to write below its
top level** — `deepMerge`'s sharing is invisible until someone assigns through it, so any
mutation of a helper-built config must clone first (worth grepping for whenever a new
`makeXConfig()` caller appears); and **"passes solo" proves nothing about state leakage** —
the full suite is not a slower version of the per-file loop, it is the only gate that runs
every fixture against every other fixture's leftovers. Related: §8.10's nine hand-built
runtime stubs — shared-helper rewrites change what *other* files receive, which is why the
helper and its heaviest consumer shared a delegate this batch.

Two judgment calls resolved without counter trades, recorded for reuse: the harness's legacy
`parsedSummary` (deliberately missing `failures` to drive the validator-error crash path)
cannot satisfy `RunTestsResult` — merged onto the module dep via `Object.assign` instead of
asserted, preserving the crash byte-for-byte; and generic dep slots rejected concretely-typed
wrappers by assignment, replaced the same way with restore. Minor tooling note: verifying a
file hit zero needs biome's `--reporter=json` — the default reporter's diagnostics carry no
machine-readable category, so grep-based verification silently reports zero on anything.

**New top of queue** (biome count per file): `interaction/plugins/cli` 8 (held escalation,
src-blocked), then a twenty-two-file tier tied at 4 (`integration/acceptance/red-green-cycle`,
`integration/execution/rectification-routing`, `agents/retry/tiered-parse-retry`,
`cli/init-context`, `config/regression-gate-schema`, `config/test-strategy`,
`debate/runner-events`, `debate/runner-one-shot-roles`, `debate/runner-rounds-and-cost`,
`execution/_revalidation-fixtures`, `execution/post-run-isolation`,
`metrics/tracker-escalation`, `operations/adversarial-review-verify`,
`operations/autofix-test-writer`, `operations/full-suite-rectify`,
`pipeline/stages/acceptance-setup-commit`, `plugins/builtin/curator-paths`,
`plugins/builtin/otel-resource-git`, `review/recurrence-demotion`,
`review/semantic-debate`, `session/session-keeper`, `verification/import-grep-fallback`) —
129 files hold the remaining 278. The head has flattened again: no drainable file exceeds 4.

### 8.21 Batch 8 of the `noExplicitAny` drain — the twenty-two-file tier tied at 4, four parallel delegates, biome 278 → 190 (2026-08-26)

The §8.20 queue head drained: the whole twenty-two-file tier tied at 4 (a strict top-20 cut
lands mid-tie; ride-along per §8.17–§8.19 precedent) — 88 sites taken by four parallel agents
on disjoint file sets under the same brief model as §8.16–§8.20 (`HANDOFF-explicit-any-batch8.md`
carried the §4 forbidden list, the cheap per-file gate loop, the standing recipe table). The
held escalation (`interaction/plugins/cli`, 8 sites, src-blocked per §8.19) was excluded by
name. No delegate edited outside its set; zero src/ or helper changes; **all 22 files reached
zero.**

Ratchet: `asAny` ↓73 (225 → 152) and `anyType` ↓91 (289 → 198); `nonNullAssert` ↓9 (801 →
792) as a benign side effect of tracker-escalation's `assertDefined` migration retiring that
file's ten pre-existing `!` assertions with its casts; every other counter flat; no counter
rose anywhere, including per-file. Gates: typecheck 0 (all three), `check:all` green (after a
lint fix, see carry-forward), full suite green (**14149 / 1136 / 38, 0 fail**), coverage OK
(101 below floor against baseline 103, identical to main).

Recipe families applied (all proven in §8.14–§8.20 except where noted):

| Shape | Where | Recipe |
|:--|:--|:--|
| hand-rolled runtime bag inside a local `makeCallCtx` factory ×3 files | debate runner-events / one-shot-roles / rounds-and-cost | `makeMockCallContext({ runtime: makeMockRuntime({ agentManager }), storyId })`; the hand-mocked `configLoader`/`packages`/`packageView` and other unread fields went with the bag after verifying nothing in `src/debate/` reads them |
| `(capture[0] as any).field` probes off an `unknown[]` audit capture | review/semantic-debate | type the array at declaration: `const auditCalls: ReviewAuditDecision[] = []` — probes become direct reads, nullable member via `?.` |
| illegal union values masked by `as any` | recurrence-demotion ×2, adversarial-review-verify priors | real `IterationOutcome` members (`"unchanged"` where findings persist, `"regressed"` matching `classifyOutcome([], [f])`) |
| generic op config slot `C` | rectification-routing ×4, `_revalidation-fixtures` | retype the fixture op's generic from `typeof DEFAULT_CONFIG` to `ReturnType<typeof testSel.select>`; params retyped at the real unions (`PipelineStage`, `SessionRole`) so inner casts fall out |
| `const ctx = {} as any` build contexts | post-run-isolation, full-suite-rectify, autofix-test-writer | `makeTestContext()` + an intersection *alias* for the structural key src writes (a declaration, not a cast); local `makeFixCycleContext() = { ...makeMockCallContext(...), storyId }` (spread + declared field); typed `BuildContext<AutofixConfig>` via `packages.repo().select(selector)` |
| dead casts on values/types already admitted | regression-gate-schema ×4 (`.default()` puts `mode` on the schema type), test-strategy ×6 (param already `string \| undefined`; row values ∈ language union), acceptance-setup-commit ×3 (literal satisfies `NaxConfig`; `{ hooks: {} }` fits `HooksConfig`; dep returns `AgentAdapter \| undefined`), session-keeper ×3 (fewer-params assignability holds) + 3 comments quoting the old cast rewritten (§8.13-D), curator-paths ×4 (`makeNaxConfig()`) | deleted outright |
| partial fake into a typed Bun dep slot | import-grep-fallback ×4 | `Object.assign(_bunDeps, { glob })` + finally-restore (§8.14/§8.20 containment model) |
| each()-row callbacks `(row: any)` | tracker-escalation ×4 | explicit `test.each<EscalatedStoryRow>` generic + `assertDefined(updatedStory)` at each callback head |
| loosely typed OTLP posts/predicates | otel-resource-git ×4 | `OtlpTracesPayload \| OtlpMetricsPayload` union + `"resourceSpans" in p.body` guards narrowing to `KeyValue[]` (§8.18 recipe) |
| hand-typed callOp impl params | red-green-cycle ×4 (one line) | declare the helper's return as `typeof _acceptanceSetupDeps.callOp` — contextual typing drops all four annotations |
| `(inspection as any)?.kind` probes on unknowns | tiered-parse-retry ×4 | local `kindOf(inspection: unknown): string \| undefined` predicate via `typeof`/`"in"` |
| manifest-table field readers `(m: any)` | init-context ×4 | explicit `test.each<[…]>` generic typing the reader at the real `ProjectScan["packageManifest"]` |
| incomplete descriptor literal | session-keeper:384 | complete the `SessionDescriptor` fields + `satisfies SessionDescriptor` (`mock()` loses contextual typing and widens literals; satisfies keeps them narrow) |

Fixture-value corrections, all assertion-preserving and reported per §4's carve-out:
recurrence-demotion's two prior iterations carried `outcome: "fixes-applied"`, not an
`IterationOutcome` member → `"unchanged"` (non-empty `findingsAfter` matches the documented
meaning; `classifyRecurrence` never reads `outcome`); adversarial-review-verify's priors same
illegal value → `"regressed"` (exactly what production computes for the shape); post-run-isolation's
routing carried `testStrategy: "direct"`, not a `TestStrategy` member → `"test-after"`
(unread by `applyPostRunInspection`; the non-TDD path is driven by `tddMode: null`) plus the
cast-masked required `complexity`/`reasoning` completed on its `RoutingResult` literals.
None feeds a classifier or switch branch (verified per-file by the delegates), but because
three corrections landed §3's coverage rule was run anyway at integration: floors unaffected.

**The one integration catch: the probe config cannot see what it disables.** Four files
landed with unsorted imports — delegates had added imports while editing, and their gate loop
verified biome through the probe config, which turns `assist.organizeImports` **off** by
design (§0.1). The repo config gates that rule as error for `test/`, so `check:all` caught
the four at integration and a scoped `biome check --write` cleared them. **When a verification
config deliberately disables rules to reduce noise, it also stops verifying them — anything
the probe silences still needs one repo-config pass over the touched files before hand-off.**

Carry forward: the dead-cast majority held for the third batch running — roughly half this
batch's 88 sites were deleted, not replaced (§8.19/§8.20 carry-forwards holding at the tie-at-4
tier). Second: the three debate files each carried a private copy of the same runtime-bag
factory; all three migrated to the shared helpers independently without conflict, which is
the quiet argument for §8.16's `makePackageView(overrides)` promotion note still open.

**New top of queue** (biome count per file): `interaction/plugins/cli` 8 (held escalation,
src-blocked), then a twenty-one-file tier tied at 3 (`integration/agents/stale-retry-session-reuse`,
`integration/agents/timeout-retry-fresh-session`, `agents/retry/types`, `cli/plan-decompose-ac13-14`,
`cli/plan-decompose-mapper`, `context/context-core`, `context/engine/orchestrator-factory`,
`context/engine/providers/code-neighbor-cap`, `context/provider-timeout-abort`,
`debate/verifiers/review-grounding-filter`, `execution/lifecycle/run-cleanup`,
`execution/unified-executor-reconcile`, `operations/full-suite-rectify-op`,
`operations/semantic-review-verify`, `pipeline/stages/routing-idempotence`,
`pipeline/subscribers/hooks`, `pipeline/subscribers/reporters`,
`precheck/precheck-checks-tier1-blockers`, `review/orchestrator-wrapper-parity`,
`verification/flake-probe`, `verification/smart-runner-packageprefix`) — 107 files hold the
remaining 190.

### 8.22 Batch 9 of the `noExplicitAny` drain — the twenty-one-file tier tied at 3, four parallel delegates, biome 190 → 127 (2026-08-26)

The §8.21 queue head drained: the whole twenty-one-file tier tied at 3 — a clean tier boundary,
no ride-along forced (§8.17–§8.19 precedent applies only when a strict cut lands mid-tie) — 63
sites taken by four parallel agents on disjoint file sets under the same brief model as
§8.16–§8.20 (`HANDOFF-explicit-any-batch9.md`). The held escalation (`interaction/plugins/cli`)
was excluded by name. No delegate edited outside its set; zero src/ or helper changes;
**all 21 files reached zero.**

Ratchet: `asAny` ↓54 (152 → 98) and `anyType` ↓63 (198 → 135); `looseCast` ↓3 (1806 → 1803)
and `asNever` ↓1 (605 → 604) as benign side effects of deleting real casts (code-neighbor-cap's
read-side `as Record<string, unknown>`, orchestrator-factory's dead config-field cast, and one
of provider-timeout-abort's pre-existing `as never`s among them); every other counter flat; no
counter rose anywhere, including per-file (`git diff scripts/baselines/` shows removals and
reductions only). Gates: typecheck 0 (all three), `check:all` green, full suite green, coverage
OK (101 below floor against baseline 103 — run because multiple fixture corrections landed).

Recipe families applied (all proven in §8.14–§8.21 except where noted):

| Shape | Where | Recipe |
|:--|:--|:--|
| malformed-data pokes (`acceptanceCriteria: null as any`) | context-core ×2 | §8.12 weak alias extended to null: hoist to typed `UserStory`, plant via `const m: { acceptanceCriteria?: string[] \| null } = story; m.acceptanceCriteria = null` |
| illegal value in an otherwise-valid row (`priorErrors: "not an array"`) | context-core | row passes clean into the factory; poke the built object through a typed alias |
| dead casts on real fields / satisfied fixtures ×10+ | orchestrator-factory ×2, retry/types ×2 (`nextPrompt?` declared), review-grounding-filter (spread loses freshness), flake-probe (barrel re-export), semantic-review-verify, routing-idempotence `"medium"`/`"test-after"` ∈ unions, stale-retry deps returning declared optionals | deleted outright |
| incomplete fixture under its declared type | hooks/reporters (`StoryEventSummary` needs title/status/attempts), unified-executor-reconcile (`makeStory`), provider-timeout-abort (`kind: "static"` + full `ContextRequest`), orchestrator-factory (`makeResolvedTestPatterns`) | completed at the type; `satisfies`/factory contextual typing |
| class-typed dep bags / logger spies | code-neighbor-cap, run-cleanup | `makeLogger()` from helpers; spy typed `Mock<typeof module.getSafeLogger>`, real silent `Logger` overlaid via `Object.assign` (§8.13-A) |
| hand-rolled ctx/runtime bags | review-grounding-filter, semantic-review-verify, full-suite-rectify-op | `makeMockCallContext({...})`; local `makeCtx(): BuildContext<AutofixConfig>` copied verbatim from drained sibling autofix-test-writer |
| module-level run-options cast bag | stale-retry / timeout-retry twins | §8.17 recipe verbatim: local `makeStubRunOptions(config)` completing `modelTier`/`modelDef`/`config`, each test passing its own manager config |
| `(Bun as any).file` patches | smart-runner-packageprefix | `Object.assign(Bun, { … })` + restore (§8.14) |
| untyped mock/callback params | flake-probe `_env: any`, plan-decompose callbacks ×5 | annotate at the dep's real signature (`CompleteOptions`); defensive `opts ?? {}` → `assertDefined(opts)` — the real caller always passes them |
| deliberate illegal literal under test | routing-idempotence garbage persisted tier | supplied via `JSON.parse('"ultra-mega"')` — the corruption arrives as JSON in production (profile.test.ts precedent) |
| omission-under-test fixtures | precheck-tier1 tags/status/storyPoints | `createMockStory()` base + weak alias + `delete` for genuinely-absent keys — absent vs undefined share the single `??` branch |

Fixture-value corrections, all assertion-preserving and reported per §4's carve-out:
orchestrator-wrapper-parity's prior iteration carried `outcome: "fixes-applied"`, not an
`IterationOutcome` member → `"regressed"` (exactly what `classifyOutcome([], [f])` computes for
that shape; recurrence classifiers never read `outcome`); semantic-review-verify same illegal
value → `"unchanged"`; the retry twins' run-options gained the cast-masked required
`modelTier`/`modelDef`/`config` (dispatch mocked before the adapter reads them);
hooks/reporters' summaries gained required `title`/`status`/`attempts` (`wireHooks`/
`wireReporters` read only `ev.storyId`); ac13-14's debate section rebuilt through
`makeNaxConfig({ debate: { enabled: false } })` (`stages: {}` cannot exist post-parse; the
`enabled` branch value is preserved); run-cleanup dropped config keys `headless`/`autoCommit`
that do not exist on `NaxConfig`. None feeds a classifier or switch branch (verified per-file),
but because several corrections landed §3's coverage rule ran anyway at integration: floors
unaffected.

Two integration notes. **The probe-config blind spot fired again, identically to §8.21:** two
cli files landed with unsorted imports the delegates' gate loop could not see, and `check:all`
caught both — the scoped repo-config `biome check --write` is now understood as a mandatory
owner step, not a per-batch judgement call. **The suite-count bookkeeping was reconciled:**
this entry initially recorded "14156 / 1173 / 38" against earlier entries' "14149 / 1136 /
38", but bun prints both lines — `1136 pass` + `37 skip` = `Ran 1173 tests`, and `14149 pass`
+ `7 skip` = `Ran 14156` — so the suites are identical and the skips were always there.
Earlier entries quoted the pass line; future entries should quote pass counts explicitly
(`14149 / 1136 / 38 pass, 0 fail`) so a skip-count change cannot masquerade as a suite change.

Carry forward: the dead-cast majority held for the fourth batch running — ten-plus of this
batch's 63 sites were assertions doing nothing, retired by deleting. And the tie-at-3 tier
needed no new recipes at all: every site fell to a pattern already proven in §8.14–§8.21,
which is what a flattened queue head should look like. Remaining tail: 85 files hold 119 sites,
none above 2.

**New top of queue** (biome count per file): `interaction/plugins/cli` 8 (held escalation,
src-blocked), then a tier tied at 2 led by `integration/cli/cli-precheck-run`,
`integration/config/merger`, `integration/plan/plan-prd-preservation`,
`integration/routing/plugin-routing-advanced`, five `cli/plan-decompose-*` files,
`context/engine/lint-config-factory`, `context/engine/providers/code-neighbor-size-cap`,
`debate/verifiers/plan-checklist`, `execution/parallel-worker-isolation`,
`execution/plan-inputs-review-wiring` — 86 files hold the remaining 127.
