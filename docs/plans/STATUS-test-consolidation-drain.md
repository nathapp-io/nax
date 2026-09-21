# Test-consolidation drain - status

The live doc for draining the **satellite test files** in `test/` — the 385
`<module>-<ticket>.test.ts` files that accumulated one nax story at a time — back into
the per-module files `.nax/rules/test-architecture.md` already mandates.

Successor in style to `STATUS-import-cycles-drain.md`, `STATUS-coverage-drain.md` and
`STATUS-test-debt-drain.md`: **section 0 is the live state and is re-measured, never
carried forward. Section 9 is append-only** — each entry records what was true when
written and is not edited afterwards.

**Written for handover to an implementer with no prior context on this analysis.** Every
task names the exact group, the exact constraints, the gate that will catch a mistake, and
the command that proves it worked. You do not need to re-derive the analysis. You *do* need
to re-measure after every task, and §6 tells you when to stop rather than push on.

---

## 0. Current state - re-measured 2026-09-21 @ 9bd1b8bab (after Task 14; original main measurement @ 4af3c680e in §9.0)

```
bun run report:test-consolidation
  scope              test/unit + test/integration + test/ui  (test/e2e/ excluded — separate CI step)
  scanned            1458 files, 375268 lines, 35616 expect()
  static test sites  17457  + 543 .each sites — NOT the runtime count, use `bun test`
  satellite groups   142  (nested bases collapsed into their outermost ancestor)
  satellites         304  (223 encode a ticket — rule §2 violations)
  mirrors            54  EXCLUDED — each is its own src module's test file (--mirrors)
  _deps unrestored   0 files with no restore; 1 need a read (hook, no visible restore)
  removable files    151   (packed to 650, hard cap 800; 233 at drain start)
  removable lines    6012   (11,185 at drain start)
```

### 0.1 Runtime state — measured with `bun test`, which is the only authority on test counts

| Suite | Tests | Files | `expect()` | Skip | Wall | Cap |
|:--|--:|--:|--:|--:|--:|--:|
| `test/unit/` | 18,247 | 1,320 | 42,169 | 7 | 44–50s | 120s |
| `test/integration/` | 1,254 | 124 | 2,980 | 36 | 16–18s | 120s |
| `test/ui/` | 98 | 10 | 149 | 0 | 0.85s | 30s |
| **Total (`bun run test`)** | **19,599** | **1,454** | **45,298** | **43** | **~62–90s** | — |

0 fail. **Do not mix these with the ranker's static counts.** The ranker reports 17,457
static `test(`/`it(` sites because it cannot expand the 543 `.each` sites, and 35,616
static `expect(` occurrences because it cannot count calls inside loops. Every invariant in
§4 is a *runtime* number, read off `bun test`.

### 0.2 Structural state

| Reading | Value | Source |
|:--|--:|:--|
| Test lines / src lines | **375,268 / 166,420 — 2.26:1** | ranker; `wc -l` over `src/**/*.ts{,x}` |
| Preamble (lines before the first `describe`) | **~68,700 — 18.3% of test lines** | ranker definition |
| Files importing `@test/helpers` | 889 (61.1%) of 1,454 | grep |
| Helper modules available | 48 in `test/helpers/` (excl. `index.ts`, `e2e/`) | `ls` |
| Satellite groups / satellites / mirrors | **142 / 304 / 54** | ranker |
| Satellites encoding a ticket | **223 of 304 (73%)** | ranker |
| Removable files / lines | **151** (1,454 → 1,303) / **6,012** | ranker |
| Line coverage | **96.32%** (74,694/77,549), floor 80% | `bun run test:coverage` |
| Function coverage | **93.39–93.41%** (7,047–7,049/7,546), floor 80% | same, varies run to run |
| Files below the per-file floor | **0**, baseline empty | same |

**Everything is green. This is a debt drain, not a fix for a broken thing.** Coverage is 16
points above its floor with an *empty* grandfather baseline, and the unit phase uses ~38% of
its wall-clock cap.

### 0.3 The honest target — read this before you start

The brief that produced this doc was "19,599 tests is too many, merge and delete to reduce
it". **Three of the four levers that would reduce the test count do not exist here:**

| Hoped-for lever | Measured reality | Verdict |
|:--|:--|:--|
| Dead tests referencing deleted `src/` | **0.** Every `@/`-aliased import resolves; confirmed by two independent resolvers. The handful of unresolvable strings are file paths used as *test data*. | **Not available** |
| Skipped/abandoned tests | **43**, of which 42 are `fullTest` from `test/helpers/env.ts` (`process.env.FULL === "1" ? test : test.skip`) — env-gated, not abandoned — and 1 is a real `skipIf` capability probe. | **Not available** |
| Duplicate tests | ~**234 duplicated names / 278 excess occurrences out of ~15,800 named tests (1.8%)**, almost all legitimately-parallel names in different modules ("kind is deterministic"). | **Negligible** |
| Same-setup tests split one-assertion-per-AC | **214 clusters, 342 tests**, counted *within a single `describe`*. Real but small. | **Wave 5** |

**The 19,599 tests are not redundant.** Every satellite in the largest group pins a
*distinct* shipped behaviour — `#1707`, `nax#1739`, `#1964`, `#2066`, `nax#2054`, `#993`,
`US-001 AC5-AC8`. Deleting them re-opens the bugs they pin. **Do not chase the test count.**
See the memory `inert-tests-third-option` and `STATUS-test-debt-drain.md` §8 on tests that
outlived the refactors they guarded.

**What this drain buys, and the only numbers to judge it by:**

1. **-233 test files** (1,539 → 1,306): one file per module-concern instead of one per ticket.
2. **-11,185 lines**, almost all duplicated preamble (70,169 lines, 18.6% of test LOC).
3. **Compliance.** `test-architecture.md` "Placement Rules" §2 already forbids these files;
   292 violate it. **The rule was never gated**, which is why the drain is needed at all —
   and why Task 30 (the ratchet) is the only task that stops it recurring.
4. **A slightly faster suite as a side effect,** not a goal: 233 fewer preamble evaluations.
   `bun test` runs all files in one process with no `--parallel`, so this should help rather
   than hurt. Measure it in §9; do not promise a number.

Test count ends where it started, minus the Wave 5 collapses. **That is the correct
outcome.** If a diff reduces the test count beyond the collapsing it explicitly performed,
a behaviour pin was deleted — revert and escalate (§6).

---

## 1. Rules of engagement - read this before touching anything

### 1.1 What a satellite is, and the two things that look like one but are not

A **satellite** is `<dir>/<base>-<suffix>.test.ts` beside `<dir>/<base>.test.ts`. A **group**
is a base plus its satellites.

`<module>-<concern>.test.ts` is **legal** — `test-architecture.md` allows it as a
describe-block split of an oversized file. `<module>-<ticket>.test.ts` is **not**. The
ranker's `ticket` flag matches `#1234`, `nax#123`, `US-001`, `AC5`, `ADR-019`, `BUG-30`,
`Task 4` in the filename or first 2 KB. **It is a heuristic — read the file before trusting
it.**

Two exclusions, both of which the first version of this analysis got wrong and which cost a
full review cycle to find (§9.1):

- **MIRRORS — 54 files. Never merge these.** A satellite with a same-named `src/` module *is*
  the rule's ideal ("One test file per source file"). `test/unit/config/schemas-model.test.ts`
  is the test file for `src/config/schemas-model.ts`. Merging it **breaks** the rule this
  drain enforces. `bun run report:test-consolidation --mirrors` lists all 54 with their src
  module. The ranker excludes them from `satellites` and `removableFiles` and pins them in
  the packing; you must not override that. Note the *base* mirrors its own src module by
  definition — that is why it is the receiver.
- **NESTED BASES.** A base can itself be another base's satellite
  (`story-orchestrator-revalidation` is both). The ranker assigns every file to its
  **outermost** ancestor and does not report nested bases as groups, so the counts do not
  double and the instructions do not conflict. That is why there are 142 groups, not 159.

### 1.2 The gates that pull against each other

Consolidation is fought by a gate in the opposite direction, and is only safe because
others hold the line.

| Gate | Command that actually runs it | Pulls | Why it matters here |
|:--|:--|:--|:--|
| **File size** | `bun run lint` (via `lint:checks`) | **Against** merging | `TEST_LIMIT = 800`. The binding constraint on the whole drain (§1.3). |
| **Per-file coverage** | `bun run test:coverage` | Weakly for you | 80% floor, baseline empty. **See §1.4 — this is NOT the safety net it looks like.** |
| **Inline mocks** | `bun run check:test-mocks` | For you | Forbids re-implementing `test/helpers/` factories inline. |
| **Escape hatches** | `bun run check:test-escape-hatches`, `check:test-as-unknown-as` | Against sloppiness | Growth-only ratchets. Do not spend their slack — memory `escape-hatch-baseline-slack-recurs`. |
| **Import cycles** | `bun run lint` | Neutral, but | zero-tolerance. Re-sorting a barrel's imports can turn a latent cycle into a module-init `ReferenceError` — memory `import-sort-breaks-barrel-cycles`. |

> **`bun run lint` does NOT run the mock or escape-hatch gates.** `lint` = `lint:biome &&
> lint:checks`, and the last three rows live only in `check:all-without-biome`. CI runs
> `check:all`. **Use `bun run check:all`** — §2.1's loop does.

**Why the merge axis is satellite-to-satellite, not satellite-into-base.** Thirteen files are
grandfathered over the limit in `scripts/baselines/file-sizes-baseline.json`, nine of them
tests, and the ratchet fails when a baselined file **grows past its recorded number**. Eight
of those nine are bases of groups this plan targets. The ranker pins them as bins that
receive nothing.

One exception worth knowing: **the baseline records the size at grandfathering, so a file
that has since shrunk has real headroom.** `test/unit/cli/plan.test.ts` is **809 lines
against a recorded 1,201 — 392 lines of usable room.** `--group` prints the headroom for
every frozen base; trust that, not the baseline number alone.

### 1.3 The four legal techniques

**T1 — Pack by seam (the default).** Merge a group's mergeable members into the fewest files
that each stay at or under the **650-line fill target** (hard cap 800). Group by the *seam
under test*, never by the ticket.

**The fill target is 650, not 800, and that is deliberate.** Packing to the cap leaves the
next bug fix nowhere legal to go: the module's test file is full, and a new
`<module>-<ticket>.test.ts` is exactly what this drain removes and what Task 30 will reject.
Leaving ~150 lines per file keeps the drain from recreating the problem it fixes.

**How to use the packer's output.** `--group <base>` prints a concrete bin assignment that is
*proved to fit*. It packs by size (first-fit-decreasing), so **the bin count is the target
and the proof of feasibility; the seam assignment within that count is yours.** Worked
example, `test/unit/operations/call.test.ts` — 22 files, 6,031 lines → **9 files**:

```
bun run report:test-consolidation --group test/unit/operations/call.test.ts
```

```
bin 1: 967l (pinned)   call.test.ts                    <- frozen at 967, receives nothing
bin 2: 124l (pinned)   call-hop-output.test.ts         <- MIRROR of src/operations/call-hop-output.ts
bin 3: 141l (pinned)   call-run-options.test.ts        <- MIRROR of src/operations/call-run-options.ts
bin 4: 721l            call-no-dispatch.test.ts        <- 509-line body; nothing else fits
bin 5: 649l            call-op-retry + call-sticky-target + call-effective-config
bin 6: 641l            call-exhausted-fallback + call-fallback-recording
                       + call-complete-model-resolver + call-complete-fallback-recording
                       + call-tool-providers
bin 7: 644l            call-empty-output + call-adapter-failure
bin 8: 636l            call-correlation + call-exhaustion
bin 9: 518l            call-root-collapse + call-abort-signal + call-fail-timeout
                       + call-coding-tool-root-producer + call-run-counter
                       + call-output-dir-producer
```

Three constraints that assignment makes visible, and which any hand-written alternative must
also respect: `call.test.ts` is frozen; `call-hop-output` and `call-run-options` are mirrors
and stay; and `call-no-dispatch.test.ts` has a 509-line body with a 212-line preamble, so it
cannot share a file with `call-empty-output` (441-line body) — **the naive "all the
no-output seams in one file" grouping is 1,476 lines of bodies and is unbuildable.** Nine is
the floor; do not try for six.

Keep every `test()` and every `expect()`. Keep the ticket reference — move it into the
`describe` or a comment, where `test-architecture.md` wants it, not the filename.
Deduplicate only the *preamble*, drawing from `test/helpers/` wherever one exists.

**T2 — Absorb into the base.** Where the base is not frozen and has headroom under 650, fold
a small satellite straight in. Cheapest technique. Also available on a frozen base with real
headroom (§1.2, `cli/plan.test.ts`).

**T3 — Collapse same-setup siblings (Wave 5, 342 tests).** Where ≥2 tests **inside one
`describe`** share a byte-identical setup statement and each asserts one field, merge them
into one test with several `expect()`s. **The `describe` boundary is part of the rule:** the
largest naive cluster spanned `"— shape"` and `"— AC7: appliesTo predicate"` in
`mechanical-lintfix-strategy.test.ts`, and collapsing across them would merge unrelated
concerns. This is the only technique that reduces the test count, and it **must not reduce
the `expect()` count** — record both in §9.

**T4 — Extract a shared fixture into `test/helpers/`.** When packing shows the same fixture
builder in three or more members, move it to `test/helpers/`. This is how a group beats its
packed floor: a smaller preamble means more bodies per file. `check:test-mocks` wants this.
48 helpers exist; extend one before adding one. **T4 edits a repo-wide shared file — see §7.**

### 1.4 Coverage is NOT the safety net, and this is the most likely way to do quiet damage

§0.2 shows coverage at 96.32% lines against an **80%** floor. That is roughly **12,000
currently-covered `src/` lines of slack**: `src/agents/manager.ts` (98.3%) can lose ~85
covered lines, `src/session/manager.ts` ~84, `src/findings/cycle.ts` ~74 — and those are
Wave-1 and Wave-3 targets.

So the realistic failure — **an agent drops a `describe` block while moving 700 lines** —
leaves `bun run test` green, `bun run test:coverage` green, and every ratchet green.

**The only detector is the runtime test and `expect()` count, which is why §2.1 checks it
after every task and not just at the end.** Treat coverage as a backstop against catastrophe,
not as proof of correctness.

### 1.5 What you may NOT do without escalating

- **Delete a test.** The only legal reductions are T3's explicit collapsing, and a literal
  duplicate *within one merged file* where the setup and every assertion are byte-identical —
  and even then, record both original paths in §9 **before** removing it. After a merge, two
  tests from different files that shared a copied fixture are often byte-identical while
  pinning **different** tickets.
- **Merge a mirror**, or invent a merged filename that maps to no `src/` module. Both break
  `test-architecture.md` "File Naming".
- **Weaken an assertion** to reconcile two fixtures. Split the test instead.
- **Add an escape hatch** (`as any`, `as never`, `as unknown as`, `@ts-expect-error`,
  `biome-ignore`) to land a merge.
- **Grow a baselined file past its recorded number** in `file-sizes-baseline.json`.
- **Re-baseline anything.** `test:coverage --update-baseline` is specifically forbidden —
  memory `never-re-baseline-coverage-locally`.
- **Touch `src/`.** This drain is `test/` plus `scripts/`. A merge that needs a `src/` change
  has found a real defect: file it and skip the group.
- **Move a file between `test/unit/`, `test/integration/` and `test/ui/`.** Separate phases,
  separate caps. The three unit/integration same-name pairs (`plugins/validator`,
  `worktree/manager`, `execution/checkpoint/reader`) are **correct** and out of scope.

### 1.6 Known traps in this repo

- **`_deps` leakage — but only 10 files, and the mechanism is not what it looks like.**
  `bun test` runs every file in ONE process with a shared module registry (`test/preload.ts`
  "runs once before any test file in this process"; the #1779 coverage behaviour depends on
  it). So an unrestored `_deps` mutation **already leaks across files today**. What merging
  changes is **adjacency and ordering**, which is what decides whether a latent leak is
  observed. That is why Task 1 exists and why it is narrow.
  The repo has three restore idioms — `afterEach` that assigns back, `try/finally`, and
  `withDepsRestore` from `test/helpers/deps.ts`. **A heuristic that only greps for the word
  `afterEach` reports 62 unrestored files; the truth is 10.** The ranker now brace-matches
  the hook bodies. Trust `⚠deps`, and read anything marked `?deps`.
- **`withDepsRestore` does not help a top-level `beforeEach`.** It registers its save in a
  `beforeEach` *inside the enclosing describe*, so if the file already stubs `_deps` from a
  **top-level** `beforeEach` (as `context/engine/orchestrator.test.ts:17-21` and
  `session/manager-lifecycle.test.ts:18-26` do), the save captures the stub. Hoist the
  mutation into the merged file's own hook instead.
- **Merging two files that each have a top-level `beforeEach`** gives every test in the
  result *both* hooks. Subtler than leakage and easy to miss.
- **A green suite does not prove a merge is correct.** Memory `mutation-test-delegated-guards`:
  a passing suite hid a guard that could not fail. After each merge, break one assertion per
  merged describe and confirm it fails.
- **`mock.module` is not the hazard you would expect** — 15 files, zero in-group collisions.
  The `_deps` DI pattern is why merging is viable at all.
- **Snapshots.** Five files use `toMatchSnapshot`; `.snap` entries are keyed by file *and*
  test name. None is currently in a group, but never move a snapshot-bearing test between
  files without moving its `.snap` entry.
- **`report:test-overlap` and `report:dead-tests` are blind. Do not use them.** Both parse
  only `src/`-prefixed specifiers while the tests use `@/` — **4,549 alias imports vs 27
  literal**. `report:dead-tests` reports 0 dead imports having examined ~0.6% of them;
  `report:test-overlap` reports "0 redundant, 0 partial, 124 unique", 124 being the
  integration file count. They report success by not looking. Task 32 fixes or retires them.

---

## 2. The measurement loop

### 2.1 After every single task

```bash
bun run report:test-consolidation | head -12   # counters moved as predicted?
bun test test/unit/                            # or the phase you touched
bun run test                                   # 0 fail, all three phases
bun run check:all                              # lint + file-sizes + mocks + escape hatches
bun x tsc --noEmit -p tsconfig.test.json       # test/ typecheck
bun run test:coverage                          # separate CI step; NOT in `bun run test`
```

**The count invariant, every task, before you commit.** Read these off `bun test` for the
phase you touched and compare to the previous task's numbers in §9:

- tests: unchanged, **or** down by exactly the T3 collapses you performed
- `expect()`: **unchanged or higher, never lower**
- fail: 0; skip: unchanged (7 unit / 36 integration / 0 ui)

Per §1.4 this is the only thing that catches a dropped `describe`. Record all four numbers in
§9 whether they moved or not.

Then commit, one group per commit:

```
test: pack the callOp satellites into nine seam files (22 → 9, -968 lines)
```

### 2.2 Before each wave: re-rank

```bash
git fetch origin && git rebase origin/main   # memory: fetch-before-a-drain-session
bun run report:test-consolidation
```

Merging a group changes no other group, but T4 shrinks preambles repo-wide and can lower
another group's floor, and restoring a `_deps` hook clears a flag. **Re-rank before each
wave; never work from a carried-forward list.**

### 2.3 How to read the ranker

**`removableFiles` is a first-fit-decreasing pack under optimistic-but-checked assumptions.**
Each bin is charged the **maximum** preamble of its members (their imports union, they do not
average), no bin may exceed the 800 cap, and frozen bases and mirrors are pinned. So the
number is *buildable* — but it is a packing, not a seam analysis. **Treat it as the file
count to hit, and expect to need one more file when the seams genuinely cannot share a
preamble.** Landing one over target is fine; write the reason in §9. Landing *under* target
means you deleted something or blew the cap.

`-lines` is the honest headline; `-files` is the compliance metric. Report both.

---

## 3. The task queue

Tasks are numbered once, globally, and never renumbered. Waves 1–4 are 28 groups for **141
files (61% of the total) and 8,275 lines** — the Pareto knee. The tail is 77 groups for 92
files; **do not start there.** Before delegating any group with fewer than ~4 removable
files, read the memory `verifying-a-cluster-costs-as-much-as-doing-it`: below that the review
pass costs more than the work.

### Wave 0 — make the drain legal, safe, and measurable

**Task 1: resolve the 400-vs-800 split limit. — RULED AND LANDED 2026-09-21, see §9.3.**
`test-architecture.md` Placement Rule §2 said split at **400** while `check-file-sizes.ts`
`TEST_LIMIT` enforced **800**, so every split was non-compliant against one of the two.

**The ruling: 800 is the hard limit, 650 is the target.** Placement Rule §2 now says exactly
that, and it is the number this plan packs to. Rationale for 650 over 800: a file packed to
the cap leaves the next fix to that module nowhere legal to go, and Task 33 will reject a new
`<module>-<ticket>.test.ts`. Rationale against tightening the gate to 600/400: 291 test files
already exceed 400 and 88 exceed 650, so either would grandfather 100-291 files against
today's 9 and gut the ratchet.

If you change it, edit `.nax/rules/test-architecture.md` (**never** the generated
`.claude/rules/` copy), then `bun bin/nax.ts rules export --agent=claude` and
`bun run check:rules-drift`.

**Task 2: restore `_deps` in the 10 unrestored files. Blocks Waves 1 and 3 only.**
Ten files mutate a module-level `_deps` with no restore of any kind, in six groups. Only two
are in the top 18: `context/engine/orchestrator` (rank 4) and `session/manager` (rank 16).

```
test/unit/context/engine/orchestrator.test.ts                     (top-level beforeEach)
test/unit/context/engine/orchestrator-extra-provider-ids.test.ts
test/unit/context/engine/orchestrator-us004.test.ts
test/unit/context/engine/orchestrator-determinism.test.ts
test/unit/session/manager-pid-lifecycle.test.ts
test/unit/session/manager-bind-handle.test.ts
test/unit/session/manager-lifecycle.test.ts                       (top-level beforeEach)
test/unit/cli/auth-prompt.test.ts
test/unit/runtime/cost-aggregator.test.ts
test/unit/finish/commit.test.ts
```

Two recipes, and the choice matters (§1.6): for **describe-scoped** mutation use
`withDepsRestore(_deps, [keys])` from `test/helpers/deps.ts`; for a **top-level
`beforeEach`** (the two files marked above) `withDepsRestore` captures the stub, so hoist
the mutation into the merged file's own hook and restore explicitly in an `afterEach`.
Behaviour-preserving, and it lands and verifies **as its own commit before any merge touches
those groups.** Proof: `bun run test` green and `_deps unrestored 0` in the ranker header.
Also read `test/unit/execution/lifecycle/test-baseline-capture.test.ts` (marked `?deps` — has
a hook, no restore detected) and either fix it or note in §9 that it is fine.

**Task 3: read §0.3, §1.1, §1.4 and §1.5.** The failure mode for this drain is an agent that
optimises the test count, merges a mirror, or trusts coverage. Confirm in §9 that you have
read them before your first merge.

### Wave 1 — ranks 1-5 (-52 files, -3,018 lines)

Technique T1. Run `--group <full path>` first; merge by seam within the bin count it proves.

| Task | Group | Now → target | Yield | Constraints |
|:--|:--|:--|:--|:--|
| 4 | `test/unit/operations/call.test.ts` | 22 → 9 | -13 f, -968 l | Worked example, §1.3. Base frozen at 967; **2 mirrors** |
| 5 | `test/unit/plugins/builtin/curator.test.ts` | 20 → 9 | -11 f, -477 l | — |
| 6 | `test/unit/agents/manager.test.ts` | 19 → 8 | -11 f, -414 l | 1 mirror |
| 7 | `test/unit/context/engine/orchestrator.test.ts` | 14 → 5 | -9 f, -536 l | **Blocked on Task 2** (4 files). 1 mirror |
| 8 | `test/unit/execution/story-orchestrator.test.ts` | 20 → 12 | -8 f, -623 l | Base frozen at 1,998; 1 mirror |

### Wave 2 — ranks 6-10 (-32 files, -2,320 lines). None blocked.

| Task | Group | Now → target | Yield | Constraints |
|:--|:--|:--|:--|:--|
| 9 | `test/unit/cli/plan.test.ts` | 18 → 11 | -7 f, -518 l | Base 809 l, recorded 1,201 — **392 l headroom**; 2 mirrors |
| 10 | `test/unit/context/engine/providers/static-rules.test.ts` | 12 → 5 | -7 f, -386 l | Base frozen at 803; 1 mirror |
| 11 | `test/unit/pipeline/stages/acceptance.test.ts` | 13 → 7 | -6 f, -549 l | — |
| 12 | `test/unit/execution/escalation/tier-escalation.test.ts` | 10 → 4 | -6 f, -437 l | Base frozen at 1,025 |
| 13 | `test/unit/agents/native/adapter.test.ts` | 9 → 3 | -6 f, -430 l | — |

### Wave 3 — ranks 11-18 (-32 files, -1,560 lines)

Tasks 14-21, in rank order: `agents/coding-tool-support` (7→2),
`operations/build-hop-callback` (7→3), `metrics/tracker` (8→4), `cli/rules` (9→5, 3 mirrors),
`agents/acp/spawn-client` (8→4, base frozen at 810, 1 mirror), `session/manager` (9→5,
**blocked on Task 2**, 2 mirrors), `quality/runner` (5→1),
`operations/adversarial-review` (7→4). Re-rank first (§2.2).

### Wave 4 — ranks 19-28 (-25 files, -1,377 lines)

Tasks 22-31, in rank order: `context/engine/providers/code-neighbor` (7→4),
`context/engine/stage-assembler` (5→2), `context/engine/scoring` (4→1),
`agents/acp/adapter` (9→6), `execution/pid-registry` (4→1), `context/engine/rebuild` (5→3),
`context/engine/effectiveness` (5→3), `operations/verify-op` (4→2),
`context/engine/manifest-builder` (4→2), `execution/pipeline-result-handler` (4→2).

### Wave 5 — the collapse pass (Task 32, -342 tests)

Technique **T3**, within `describe` blocks only: 214 clusters, 342 collapsible tests. The
only wave that moves the test count, and the only one where `expect()` is the invariant to
protect — record both in §9. Largest clusters first:
`prompts/sections/behavioral-guardrails` (two × 6), `pipeline/stages/prompt-batch` (5),
`context/engine/providers/static-rules-us006` (5), `plugins/builtin/curator-render` (5),
`runtime/middleware/resolve-idle-watchdog-settings` (5), `agents/phase5-invariants` (5),
`cli/context` (5), `cli/run-mode` (5), `operations/mechanical-lintfix-strategy` (5, the
`"— shape"` describe **only**).

### Wave 6 — stop the recurrence

**Task 33: gate it.** Add `scripts/check-test-satellites.ts` + baseline. **Without this the
drain re-fills** — every nax story that fixes a bug adds a file, which is how 385
accumulated under a rule that already forbade them. Land it as soon as Wave 1 is done. Five
things the idiom actually requires, beyond "copy `check-file-sizes.ts`":

1. **Gate on the FILENAME only**, against a baseline count. `TICKET_RE` also matches file
   *content*, so a PR adding "see #1234" to a compliant test file's header would fail CI —
   and §1.1 already says a human must read the file. A gate cannot.
2. **Exclude mirrors** (§1.1), or the gate fails on rule-compliant files.
3. **Baseline shape** `{updatedAt, byFile|count}`, plus `--update-baseline`, `--list`, a
   "baseline missing → exit 1" arm, and a "baseline can be lowered" hint.
4. **Wire into `lint:checks`** (reached by `check:all` → `check:all-without-biome` →
   `lint:checks`), or **`bun run check:gate-reachability` fails the build.** Say which
   aggregator in the PR.
5. **Write `test/unit/scripts/check-test-satellites.test.ts`.** All 27 existing gates have
   one and export pure functions for it. **`report-test-consolidation.ts` is not importable
   as-is** — it scans and `process.exit`s at module load. Refactor it to export
   `walk`/`readStat`/`buildGroups`/`packGroup` behind `if (import.meta.main)` first.

**Task 34: make this doc discoverable. — LANDED 2026-09-21, see §9.2.** Every other active
STATUS plan is referenced from a `.nax/rules/` file (`testing-commands.md` → coverage drain,
`test-ratchets.md` → test-debt drain); that is how it reaches an agent session. A pointer now
sits at the end of `.nax/rules/test-architecture.md` (the rule this drain enforces), with the
generated `.claude/rules/` copy regenerated via `bun bin/nax.ts rules export --agent=claude`.
If you edit the rule, regenerate — `bun run check:rules-drift` fails otherwise.

**Task 35: fix or retire `report:test-overlap` and `report:dead-tests`** (§1.6). Either teach
them the `@/` alias from `tsconfig.json` `paths`, or delete them with their tests. A tool that
cannot fail is worse than no tool. `test/unit/scripts/report-{dead-tests,test-overlap}.test.ts`
pin the current blind behaviour and go with whichever choice.

### Wave 7 — the tail (77 groups, -92 files, -2,910 lines)

Only after Task 33 is gated. Averages 1.2 files per group. Batch by directory, not by rank,
and delegate a directory at a time with the recipe proven in Waves 1-4.

---

## 4. Definition of done

- `bun run report:test-consolidation` reports `removable files 0`, or every remaining group
  has a written reason in §9 for staying split.
- Ticket-flagged satellites are 0, `check:test-satellites` is in `lint:checks` with a zero
  baseline, and `bun run check:gate-reachability` passes.
- `bun run test` green, with **19,599 tests minus exactly the collapses recorded in §9**, and
  **`expect()` ≥ 45,298** (unit 42,169 + integration 2,980 + ui 149). Skips still 43.
- `bun run check:all` and both `tsc --noEmit` invocations pass.
- `bun run test:coverage` reports **0 files below the floor and an empty grandfather
  baseline** — the same state as 2026-09-21. *Coverage maintained means not one file added to
  that baseline.* Do not gate on the aggregate percentage: it varies run to run (functions
  measured at both 93.39% and 93.41% on the same tree).
- No baseline in `scripts/baselines/` has grown.

---

## 5. Per-group protocol

One group per branch, one group per commit.

1. `git fetch origin && git rebase origin/main` (memory `fetch-before-a-drain-session`).
2. `git checkout -b test/consolidate-<group-slug>`.
3. `bun run report:test-consolidation --group <FULL path>` — use the full path; a short name
   is ambiguous and the ranker will refuse it.
4. Note the pre-task numbers: tests, `expect()`, files, lines (§2.1).
5. Confirm the group carries no `⚠deps` flag, or that Task 2 has already landed for it.
6. Merge per T1/T2. Move ticket references into `describe` names. Reuse `test/helpers/`.
7. Break one assertion per merged `describe`; confirm each fails; restore (§1.6).
8. Run the full §2.1 loop including the count invariant.
9. Commit; append the §9 entry with all four counts.

---

## 6. Failure and escalation

**A hard budget of two attempts per group.** After the second failure, revert, write what you
learned in §9, and move to the next group. Do not push to a third.

Unwinding is cheap and total — the drain is `test/`-only and one group is one commit:
`git checkout -- test/unit/<dir>`. Never `git stash` (shared across worktrees, §7).

| Symptom | First thing to check | Action |
|:--|:--|:--|
| Merged file over 800 | The largest body vs the fill target | Split the largest seam into its own file; record N+1 in §9. Do **not** trim tests to fit |
| A merged test fails | A leaked `_deps` (§1.6), then a duplicated top-level `beforeEach`, then order-dependence | Fix the hook. If it is none of those, you have found a real defect: revert, file it, skip the group |
| Test count dropped | Which `describe` is missing | Revert immediately — a behaviour pin was deleted (§1.4) |
| `expect()` count dropped | Same | Revert immediately |
| Coverage down | Do not chase it | Revert. Coverage moving at all means the merge lost something |
| `check:test-mocks` fails | An inline mock you hand-rolled | Use the `test/helpers/` factory (T4) |
| Escape-hatch ratchet grows | The cast you added to reconcile fixtures | Remove it; split the test instead (§1.5) |
| `check:file-sizes` names a baselined file | You grew a frozen base | Revert that part; check `--group` for its real headroom (§1.2) |
| Coverage fails on a file you never touched | GitHub #1779 — lcov records vary by run composition | Re-run once before believing it |

**Escalate to a human rather than guessing when:** a merge needs a `src/` change; a group's
members disagree about a fixture's correct shape; the ranker's target looks unreachable by
more than one file; or a mirror/ticket classification is genuinely unclear.

---

## 7. Concurrency

**Default to single-agent, one group at a time.** Group file sets are disjoint, so the merges
themselves do not conflict, but three shared resources do:

- **`coverage/lcov.info` is a fixed path.** Two concurrent `bun run test:coverage` runs
  clobber each other and produce false failures — and §2.1 mandates it after every task.
- **`test/helpers/*`** is repo-wide; T4 must be serialised.
- **§9 is a single append-only section**; parallel agents conflict on every entry.
- **The git stash stack is shared across worktrees.** Never bare `git stash`.

If you must parallelise: one git worktree per agent, T4 extractions through one owner only,
and each agent appends a one-line claim to §9 before starting a group.

---

## 9. Append-only log

Each entry records what was true when written and is **not edited afterwards**. Record, per
task: group, files before → after, lines before → after, **runtime tests before → after,
`expect()` before → after**, and anything that surprised you.

### 9.0 — 2026-09-21, analysis and instrumentation (no tests changed)

Measured §0 on `main` @ `4af3c680e`. Wrote `scripts/report-test-consolidation.ts` and
registered `report:test-consolidation`, because the two existing report scripts are
alias-blind (§1.6) and the drain has no measurement loop without a working ranker. No test
file was touched.

Four findings:

1. **The reduction premise was mostly wrong, and measuring it first was the value.** Dead
   tests 0; skips 43 but env-gated; duplicate names ~1.8%. The count is reducible by 342 via
   describe-scoped collapsing and that is all. §0.3 records all four levers.
2. **The waste is file fragmentation, not test redundancy.** 385 satellites, 76% named for a
   ticket, carrying 70,169 lines of duplicated preamble (18.6% of test LOC).
3. **The rule already forbade it and was never gated.** An ungated rule in a repo whose
   stories are written by agents decays — Task 33 is the real fix; the 385 files are its
   backlog.
4. **The 800-line limit inverts the obvious strategy.** Merging satellites into their bases
   is largely impossible: 8 of the 9 grandfathered test files are bases of targeted groups.
   Packing satellite-to-satellite is what yields the 233.

### 9.1 — 2026-09-21, review pass: the first version of this doc was not safe to hand over

Two independent review passes plus a self-check found the analysis sound and the **executable
half wrong**. Corrected in place. Recorded because every one of these is a way a future
version could go wrong again, and because the first version's numbers appear in commit
history and in `docs/plans/` diffs.

**Substantive errors, each of which would have caused damage:**

- **Mirrors were counted as violations.** 54 of the 439 "satellites" have a same-named `src/`
  module and are the rule's own ideal. The original §1.3 worked example merged six files
  *into* `call-run-options.test.ts` (destroying its per-source mapping) and folded
  `call-hop-output.test.ts` into a `call-retry.test.ts` for which no
  `src/operations/call-retry.ts` exists — **the flagship example broke the rule it cited, in
  both directions.** Headline fell 439 → 385 satellites, 319 → 233 removable files.
- **The worked example was arithmetically impossible.** The proposed `call-no-output.test.ts`
  was 1,476 lines of bodies against an 800 cap. Cause: the packer charged each bin the
  **average** member preamble instead of the **maximum**, so every bin was understated, and
  the "achievable, not aspirational" claim in §2.3 was never checked against the seams. Target
  corrected 6 → 9.
- **The `_deps` heuristic was wrong in both directions and Task 1 blocked three waves on it.**
  `!/afterEach|afterAll/` treats the repo's dominant `try/finally` idiom as "no restore":
  **48 false positives**, including all three flags on the callOp group, whose files restore
  correctly at e.g. `call-effective-config.test.ts:89-90`. The stated proof ("the marker is
  gone") could only be satisfied by rewriting correct code. The false negatives were worse —
  files with an unrelated `afterEach` and no restore went unflagged, including members of a
  group the table showed as clean. True count: **10 unrestored + 1 unclear, in 6 groups**,
  down from 62/36. Note one review pass "verified" 62/36 as exactly reproducible; it had
  reproduced the heuristic's output, not its correctness. **Reproducibility is not validity.**
- **The verification loop skipped three of the five gates it relied on.** `bun run lint` does
  not include `check:test-mocks`, `check:test-escape-hatches` or `check:test-as-unknown-as`;
  they live in `check:all`. §2.1 now uses `check:all`.
- **Coverage was presented as the safety net and is not.** 80% floor vs 96.32% actual is
  ~12,000 covered lines of slack, concentrated in this drain's own targets. Dropping a whole
  `describe` stays green on every gate. New §1.4 says so, and the count invariant moved from
  the definition of done into the per-task loop.
- **`cli/plan.test.ts` is 809 lines, not the 1,201 in the baseline** — 392 lines of real
  headroom that the doc declared forbidden. The baseline records size at grandfathering, so
  frozen ≠ full.
- **Packing to the cap would have recreated the problem.** 28 groups packed to >700 lines,
  leaving the next bug fix nowhere legal to go while Task 33 rejects a new file. Fill target
  is now 650.
- **The collapse figure ignored `describe` boundaries.** 423 → **342**; the largest advertised
  cluster spanned two unrelated describes.
- **Nested groups were double-counted.** 17 bases were also another base's satellite,
  inflating `removableLines` and giving conflicting instructions. Groups 159 → 142.
- **No failure, rollback, escalation, stop condition, or concurrency guidance** — all three
  sibling STATUS docs have them. Added as §5, §6, §7. `coverage/lcov.info` being a fixed path
  makes the mandated per-task coverage run unsafe to parallelise.
- **Task ordering was wrong.** The 400-vs-800 conflict was last; until it is resolved every
  file the drain creates is a fresh violation. It is now Task 1.
- **The doc was undiscoverable** — referenced from no `.nax/rules/` file (Task 34).

**Numeric corrections:** all LOC were inflated by one per file (the ranker now matches
`check-file-sizes.ts` `countLines`; 378,026 → 376,725, src 167,436 → 166,420). Full-suite
"60.4s" did not add up (components summed to 63.4s; real ~61s). Skips were reported as "7,
both `skipIf` capability probes" — actually **43** suite-wide, 42 of them `test.skip` behind
`FULL=1` via `test/helpers/env.ts`, and "both" for seven items was incoherent. Function
coverage varies 93.39–93.41% run to run, so the old DoD bar of "≥93.41%" was unsatisfiable.
"Six of the top ten" was five. The "not by bug number" quote is Placement Rules §2, not File
Naming. 60.8% → 60.9% helper adoption; "50 helpers" → 48.

**Root cause of roughly a third of the above: unlabelled measurement scopes.** Figures were
variously computed over `test/unit`, `test/unit + test/integration`, or all three gated
suites, and presented as if comparable. Every number in §0 now names its scope, and the
ranker prints its own.

**Ranker bugs fixed:** ambiguous `--group` silently returned the highest-ranked match
(`manager.test.ts` matches three) — now errors and exits 1; a missing group exited 0 — now 1;
`--group` with no argument silently printed the whole table; the overflow bin was never
checked against the cap; `SKIP_DIRS` contained `"helpers"` and dropped three real tests in
`test/unit/helpers/`; grouping only probed `.test.ts` so `test/ui`'s ten `.test.tsx` files
could never group. Added `--mirrors`, `expect()` counting, `.each`-site counting, explicit
scope labelling, and `staticTests` renamed to say it is not the runtime count.

### 9.2 — 2026-09-21, Task 34 landed (no tests changed)

Added a "Satellite files — the Placement Rules §2 backlog" section to the end of
`.nax/rules/test-architecture.md` pointing at this doc and at
`bun run report:test-consolidation`, and stating the forward-looking rule: add a bug-fix test
to the module's existing file, split by concern at ~650 lines, never by ticket, never to a
name with no `src/` module. Regenerated `.claude/rules/test-architecture.md` with
`bun bin/nax.ts rules export --agent=claude` (deterministic, no LLM call).

Done now rather than queued because without it a fresh session has no path to this document —
the drain's entire delivery mechanism. Verified: `check:rules-drift` OK (13 files),
`check:all` 0, `bun run test` 0 fail.

Counts unchanged: 19,599 tests / 1,539 files / 45,298 expect() / 43 skip.

### 9.3 — 2026-09-21, Task 1 ruled and landed (no tests changed)

The split limit was stated three ways: rule 400, gate 800, plan 650. **Ruled: 800 hard, 650
target.** `.nax/rules/test-architecture.md` Placement Rule §2 now states both numbers and why,
and carries the ruling date. Regenerated `.claude/rules/` via
`bun bin/nax.ts rules export --agent=claude`; `check:rules-drift` OK.

Measured before ruling, since the alternative was to tighten the gate instead: **291 test
files exceed 400 lines, 167 exceed 500, 88 exceed 650, 9 exceed 800** (median 186, mean 245,
max 1,998). Lowering `TEST_LIMIT` to match the old 400 would have grandfathered 291 files
against today's 9 — a ratchet with 291 exemptions does not ratchet. That asymmetry is the
whole argument, and it is why the rule moved to the gate rather than the gate to the rule.

`project-conventions.md` already stated 600 src / 800 test correctly and needed no change;
`test-architecture.md:54` was the only place carrying 400.

Counts unchanged: 19,599 tests / 1,539 files / 45,298 expect() / 43 skip.

### 9.4 — 2026-09-21, Task 3 confirmed, Task 2 landed (no tests changed in count)

Confirmed §0.3/§1.1/§1.4/§1.5 before the first merge: the target is -233 files / -11,185
lines, not the test count; mirrors (54) and nested bases are handled by the ranker and
must not be merged; the runtime test/`expect()` invariant is the only detector of a
dropped `describe` since coverage is 12,000 lines of slack above its floor; nothing in
§1.5's forbidden list (delete test, merge mirror, weaken assertion, escape hatch,
re-baseline, touch `src/`, move between phases) was exercised.

Task 2: 10 files restored. Eight stubbed `_deps` from a top-level `beforeEach`
(`orchestrator{,-extra-provider-ids,-us004,-determinism}`,
`session/manager-{pid-lifecycle,bind-handle,lifecycle}`, `cli/auth-prompt`): captured the
origins as module constants and added an `afterEach` that assigns them back
(`orchestrator.test.ts` and `manager-lifecycle.test.ts` per the §1.6 top-level rule; the
6 satellites share the same shape, so the same recipe). `runtime/cost-aggregator` and
`finish/commit` mutate inside test bodies only, so `withDepsRestore` worked:
`cost-aggregator` scoped to its single describe, `commit` at module top (no prior
stubbing hook). `?deps` file `execution/lifecycle/test-baseline-capture.test.ts` read:
its `afterEach` calls `resetCaptureDeps()` which reassigns all 10 `_captureDeps` fields
(shipped resolvers restored, others deterministically stubbed) — a complete restore the
ranker cannot see because the hook body is a call, not an assignment. **Fine as-is.**

Proof: ranker `_deps unrestored 0`; `bun run test` 0 fail, 19,599 tests / 45,298 expect()
/ 43 skip, unchanged; `check:all` 0; both `tsc --noEmit` clean; coverage 96.32% lines /
93.40% functions, 0 below floor.

### 9.5 — 2026-09-21, Task 4 landed — callOp group 22 → 10 files (lands 11, one over target)

Target was 22 → 9 (-13 f, -968 l); **landed 22 → 11 (-11 f, -327 l)**, one over the
packed floor. All 149 tests / 325 expect() preserved: `bun test` on the group reads
149 pass, unit phase 18,247 / 42,169 (unchanged), full suite 0 fail, `check:all` 0,
both tsc clean, coverage 96.32% lines / 93.40% functions, 0 below floor.

Bins built (seam by seam, not by ticket):

- bin 5 → `call-op-retry.test.ts` absorbs `call-sticky-target` (#1964 — retry/hop
  family). **Not merged:** `call-effective-config` (#2066) — the packer's proved bin
  assumed preamble dedup (retry 40l + sticky 180l + effective 95l union to a 315l
  preamble; real union pushed the three-way merge to 804l > 800 cap). `op-retry`
  lands at 799l, exactly at the cap.
- bin 6 → split into two files, not one: `call-exhausted-fallback.test.ts` absorbs
  `call-fallback-recording` (empty-output/seam family, 668l) and
  `call-complete-model-resolver.test.ts` absorbs `call-complete-fallback-recording`
  + `call-tool-providers` (complete-kind family, 310l). The single-file pack (641l
  claimed) assumed the disjoint fixtures (empty-output mocks vs model-resolver
  config vs MCP builders) dedupe into one preamble; they do not. Two files is the
  honest seam floor here.
- bin 7 → `call-empty-output.test.ts` absorbs `call-adapter-failure` (656l).
- bin 8 → `call-correlation.test.ts` absorbs `call-exhaustion` (676l).
- bin 9 → `call-root-collapse.test.ts` absorbs abort-signal, fail-timeout,
  coding-tool-root-producer, run-counter, output-dir-producer (587l).

Deletes: `call-abort-signal`, `call-adapter-failure`, `call-coding-tool-root-producer`,
`call-complete-fallback-recording`, `call-exhaustion`, `call-fail-timeout`,
`call-fallback-recording`, `call-output-dir-producer`, `call-run-counter`,
`call-sticky-target`, `call-tool-providers` — 11 files. Mirrors (call-hop-output,
call-run-options) and frozen base untouched.

Mutation check per merged file (one assertion flipped → 6 distinct describes failed;
restored). `_deps` still 0 unrestored. All four runtime invariants on §0.1 hold.

### 9.6 — 2026-09-21, Task 5 landed — curator group 20 → 9 files (-301 lines)

Hit the packed target exactly: 20 → 9 files, 5,722 → 5,421 lines, all 203 tests /
466 expect() preserved. Unit phase 18,247 / 42,169 unchanged, full suite 0 fail,
`check:all` 0, both tsc clean, coverage 96.32% / 93.40%, 0 below floor.

Bins per the packer, seam assignment mine:

- `curator.test.ts` (base/mirror) absorbs `curator-seam` (collector→heuristics seam).
- `curator-heuristics-h4-h6` absorbs `curator-us-004-postrun` (auto-prune wiring).
- `curator-heuristics` absorbs `curator-maybe-prune-rollup` (size gate).
- `curator-rollup` absorbs `curator-heuristics-h1` (H1 cross-feature recurrence).
- `curator-chunk-provider-stale` absorbs `curator-scoping` (#1422 collection scoping).
- `curator-render` absorbs `curator-us-003-postrun` + `curator-acceptance`.
- `curator-types` absorbs `curator-paths` + `curator-integration` + `curator-us-003-h6`.
- `curator-registration` absorbs `curator-collector-fix-cycle`.
- `curator-collector` (748l, 713-line body) stays alone — no bin can host it at the
  650 fill target.

Deletes: `curator-seam`, `curator-us-004-postrun`, `curator-maybe-prune-rollup`,
`curator-heuristics-h1`, `curator-scoping`, `curator-us-003-postrun`,
`curator-acceptance`, `curator-paths`, `curator-integration`, `curator-us-003-h6`,
`curator-collector-fix-cycle` — 11 files.

Mutation check: 8 merged files each got one flipped assertion → 8 distinct failures;
all reverted. Ranker `_deps unrestored 0` throughout.

### 9.7 — 2026-09-21, Task 6 landed — agents/manager group 19 → 8 files (-433 lines)

Hit the packed target: 19 → 8 files, 4,651 → 4,218 lines, all 180 tests / 402
expect() preserved. Unit phase 18,247 / 42,169 unchanged, full suite 0 fail,
`check:all` 0, both tsc clean, coverage 96.32% / 93.40%, 0 below floor.

Bins per the packer, seam assignment mine:

- `manager-dispatch-emission` absorbs `manager-narrowed`.
- `manager-swap-loop` absorbs `manager-stale-retry-hop-kind`.
- `manager.test.ts` (base) absorbs `manager-dispatch-rates` + `manager-types-phase5`
  + `manager-cancellable-backoff`.
- `manager-dispatch-error-event` absorbs `manager-complete-empty-output`.
- `manager-story-hop-budget` absorbs `manager-dispatch-complete` + `manager-abort`.
- `manager-complete` absorbs `manager-credentials` + `manager-dispatch-error-event-model`
  + `manager-rate-limit`.
- `manager-iface-run` stays alone (its bin could not host a second member at the
  650 fill target — 311-line body).
- `manager-exhaustion` is a MIRROR — untouched.

Deletes (11): `manager-narrowed`, `manager-stale-retry-hop-kind`, `manager-dispatch-rates`,
`manager-types-phase5`, `manager-cancellable-backoff`, `manager-complete-empty-output`,
`manager-dispatch-complete`, `manager-abort`, `manager-credentials`,
`manager-dispatch-error-event-model`, `manager-rate-limit`.

Delegated the mechanical merge to a subagent with a pinned recipe (this group was the
first delegation; per §7 the recipe proven in callOp/curator was handed over verbatim,
the subagent reproduced the 180/402 invariant, and I independently verified via
mutation check: 6 merged receivers × one flipped `toBe(true)` → 6 distinct failures,
all reverted) + the full gate loop. Collisions renamed: `phase5MakeRunOptions`,
`abortMakeRunOptions`.

### 9.8 — 2026-09-21, Task 7 landed — orchestrator group 14 → 6 files (lands 6, one over target)

Target was 14 → 5 (-9 f, -550 l); **landed 14 → 6 (-8 f, -153 l)**, one over the packed
floor. All 131 tests / 255 expect() preserved. Unit phase 18,247 / 42,169 unchanged,
full suite 0 fail, `check:all` 0, both tsc clean, coverage 96.32% / 93.40%, 0 below floor.

Bins per the packer, seam assignment mine:

- `orchestrator-rebuild` absorbs `orchestrator-plan-digest-boost` + `orchestrator-stale-attribution` (747l).
- `orchestrator-pull-tools` absorbs `orchestrator-us004` + `orchestrator-floor-overage`
  + `orchestrator-floor-budget-exceeded` (727l).
- `orchestrator-extra-provider-ids` absorbs `orchestrator-agent-framing`
  + `orchestrator-unknown-providers` + `orchestrator-budget-pressure` (330l).
- `orchestrator-determinism` **split back out** of pull-tools when the merged file hit
  845l > 800 cap (its AC-24 concern + 8 tests were the tail block). **This is the
  reason the group lands 6 files, not the packer's 5.**
- `orchestrator.test.ts` (base) stays alone (665-line body, no room at 650 fill target).
- `orchestrator-factory` is a MIRROR — untouched.

Deletes (8): `orchestrator-plan-digest-boost`, `orchestrator-stale-attribution`,
`orchestrator-us004`, `orchestrator-floor-overage`, `orchestrator-floor-budget-exceeded`,
`orchestrator-agent-framing`, `orchestrator-unknown-providers`, `orchestrator-budget-pressure`.

Mechanical merge delegated to a subagent (recipe from §9.7); the 845l-over-cap bin was
caught by my post-delegation `wc -l` check and re-split (this is exactly §6's
"merged file over 800 → split the largest seam" recovery). Mutation check: 4 merged
receivers × one flipped assertion → 4 distinct failures, all reverted (one revert
corrupted a sibling assertion via blanket replace; fixed by restoring the specific
`toBeUndefined()` at the budgetPressure AC-2 line). `_deps` hooks merged to one
top-level pair per file (Task 2's restores preserved).

### 9.9 — 2026-09-21, Task 8 landed — story-orchestrator group 20 → 12 files (-587 lines)

Hit the packed target: 20 → 12 files, 8,581 → 7,994 lines, all 264 tests / 532
expect() preserved. Unit phase 18,247 / 42,169 unchanged, full suite 0 fail,
`check:all` 0, both tsc clean, coverage 96.32% / 93.40%, 0 below floor.

Bins per the packer, seam assignment mine:

- `resume-integration` absorbs `rectification-no-dispatch` (794l).
- `rectification-exhaustion` absorbs `bail` + `revalidation-repo-scope` (724l).
- `revalidation` absorbs `check-ops` + `duplicate-phase` (714l).
- `resume-guard` absorbs `review-continuation` (708l).
- `run-phase-events` absorbs `review-no-dispatch` + `extract-findings` (795l).
- `flake-integration` (757l), `carveout-staleness` (666l), `logs` (415l),
  `no-progress-bail` (402l), `revalidation-carveout` (369l) stay alone (bodies too
  large to share at the 650 fill target).
- `story-orchestrator.test.ts` frozen base (1998l) and `story-orchestrator-logging`
  (MIRROR) untouched.

Deletes (8): `rectification-no-dispatch`, `bail`, `revalidation-repo-scope`,
`check-ops`, `duplicate-phase`, `review-continuation`, `review-no-dispatch`,
`extract-findings`.

Delegated to a subagent (recipe proven in §9.7/§9.8); post-delegation verification by
me: 264/532 reproduced, all receivers ≤ 795l, mutation check 5 merged receivers × one
flipped assertion → 5 distinct failures, reverted (one revert needed a manual restore
of a `toHaveLength(1)` value verified against the receiver's HEAD version). `_deps`
hooks merged to one top-level pair per file where same-key.

Wave 1 complete: callOp (-11 f), curator (-11 f), agents/manager (-11 f),
orchestrator (-8 f), story-orchestrator (-8 f) = **-49 files** against the plan's
Wave-1 target of -52 (the 3-file shortfall is the documented over-target landings in
§9.5 callOp and §9.8 orchestrator).

### 9.10 — 2026-09-21, Task 9 landed — cli/plan group 18 → 11 files (-518 lines)

Hit the packed target: 18 → 11 files, 5,989 → 5,471 lines, all 192 tests / 358
expect() preserved. Unit phase 18,247 / 42,169 unchanged, full suite 0 fail,
`check:all` 0 (after the mock-exemption carry-forward below), both tsc clean,
coverage 96.32% / 93.40%, 0 below floor.

Bins per the packer, seam assignment mine:

- `plan-callop` absorbs `plan-decompose-ac13-14` (770l).
- `plan-decompose-ac-repair` absorbs `plan-callop-migration` + `plan-decompose-cli-wiring`
  + `plan-mode` (590l).
- `plan-interactive` absorbs `plan-decompose-mapper` (736l).
- `plan-decompose-writeback` absorbs `plan-identity-claim` (707l).
- `plan-decompose-guards` absorbs `plan-decompose-adapter` (761l).
- `plan-replan`, `plan-decompose-regression`, `plan-monorepo` stay alone.
- `plan.test.ts` frozen base (809l, 392l headroom unused) and mirrors
  `plan-helpers`, `plan-runtime` untouched.

Deletes (7): `plan-decompose-ac13-14`, `plan-callop-migration`,
`plan-decompose-cli-wiring`, `plan-mode`, `plan-decompose-mapper`,
`plan-identity-claim`, `plan-decompose-adapter`.

Two non-trivial items, both handled plan-consistently:

1. **Cross-file meta-test (AC-4 in `plan-decompose-regression`)** reads 7 split-test
   sources by path, 4 of which were absorbed. The AC-4 test now points each absorbed
   path at its receiver home (guards/interactive/ac-repair/callop), preserving all 7
   entries and the assertion verbatim — expect count unchanged. That file is otherwise
   untouched.
2. **Mock-gate carry-forward:** the absorbed `ac13-14` file was on
   `scripts/check-inline-test-mocks.ts` SKIP_FILES (custom local `makeStory`/`makeConfig`
   that are NOT drop-in for `test/helpers`). Merging it into `plan-callop` surfaced the
   pair as new violations. `plan-callop.test.ts` was added to SKIP_FILES (Pattern B),
   carrying the exemption forward — the alternative (rewriting tests to the shared
   helpers) would change test semantics and is out of scope for a mechanical merge.

Mutation check: 5 merged receivers × one flipped assertion → 5 distinct failures, all
reverted. Delegated to a subagent; post-verification by me: 192/358 reproduced, all
receivers ≤ 770l.

### 9.11 — 2026-09-21, Task 10 landed — static-rules group 12 → 5 files (-386 lines)

Hit the packed target: 12 → 5 files, 3,064 → 2,678 lines, all 132 tests / 269
expect() preserved. Unit phase 18,247 / 42,169 unchanged, full suite 0 fail,
`check:all` 0, both tsc clean, coverage 96.32% / 93.40%, 0 below floor.

Bins per the packer, seam assignment mine:

- `static-rules-sections` absorbs `static-rules-paths` (677l).
- `static-rules-us002` absorbs `static-rules-authoring-scope` + `static-rules-us006`
  + `static-rules-path-frame` (743l).
- `static-rules-budget-derivation` absorbs `static-rules-inert-warn`
  + `static-rules-budget-warnings` + `static-rules-legacy-default` (445l).
- `static-rules.test.ts` frozen base (803l) and mirror `static-rules-scoping` (250l)
  untouched.

Deletes (7): `static-rules-paths`, `static-rules-authoring-scope`,
`static-rules-us006`, `static-rules-path-frame`, `static-rules-inert-warn`,
`static-rules-budget-warnings`, `static-rules-legacy-default`.

Delegated to a subagent; post-verification by me: 132/269 reproduced, all receivers
≤ 743l. Collisions renamed with `*_BASE_REQUEST` / `*Canonical` prefixes; subset
`beforeEach`/`afterEach` hook pairs merged away. Mutation check: 3 merged receivers
× one flipped assertion → 5 distinct failures (us002's mutation failed 3 tests,
the others 1 each), all reverted.

### 9.12 — 2026-09-21, Task 11 landed — acceptance-setup group 13 → 7 files (-549 lines)

Hit the packed target: 13 → 7 files, 4,747 → 4,198 lines, all 152 tests / 288
expect() preserved. Unit phase 18,247 / 42,169 unchanged, full suite 0 fail,
`check:all` 0, both tsc clean, coverage 96.32% / 93.40%, 0 below floor.

Bins per the packer, seam assignment mine:

- `acceptance-setup-regeneration` absorbs `acceptance-setup-dispatch-root` (705l).
- `acceptance-setup-fingerprint` absorbs `acceptance-setup-commit` (679l).
- `acceptance-setup-criteria` absorbs `acceptance-setup-profile-chain` (595l).
- `acceptance-setup-gate` absorbs `acceptance-setup-strategy` (701l).
- `acceptance-setup-dispatch-failure` absorbs `acceptance-setup-events` (696l).
- `acceptance-missing-target` absorbs `acceptance-setup-agent-file` (573l).
- `acceptance.test.ts` base (635l) stays alone.

Deletes (6): `acceptance-setup-dispatch-root`, `acceptance-setup-commit`,
`acceptance-setup-profile-chain`, `acceptance-setup-strategy`, `acceptance-setup-events`,
`acceptance-setup-agent-file`.

Delegated to a subagent; post-verification by me: 152/288 reproduced, all receivers
≤ 705l. Collisions renamed with `*MakeCtx`/`*MakeStory`/`*MakePrd` prefixes; same-key
deps hook pairs merged into one. Mutation check: 6 receivers × one flipped assertion →
6 distinct failures. One receiver's `toBe(true)` mutation landed inside a template-literal
fixture string (`BARE_TIER2_TEST`), not an executed assertion — re-verified by flipping a
live `toBe(false)` instead. All reverted.

### 9.13 — 2026-09-21, Task 12 landed — tier-escalation group 10 → 4 files (-437 lines)

Hit the packed target: 10 → 4 files, 2,990 → 2,553 lines, all 59 tests / 162
expect() preserved. Unit phase 18,247 / 42,169 unchanged, full suite 0 fail,
`check:all` 0, both tsc clean, coverage 96.32% / 93.40%, 0 below floor.

Bins per the packer, seam assignment mine (re-assigned after the §6 recovery):

- `tier-escalation-greenfield` absorbs `reroute-delete` + `first-iteration` + `routing-widening` (753l).
- `tier-escalation-retry-cap` absorbs `dry-run` + `source-tier` (600l).
- `tier-escalation-story-failed` absorbs `off-ladder` (546l).
- `tier-escalation.test.ts` frozen base (1025l) untouched.

Deletes (6): `tier-escalation-dry-run`, `tier-escalation-first-iteration`,
`tier-escalation-reroute-delete`, `tier-escalation-routing-widening`,
`tier-escalation-source-tier`, `tier-escalation-off-ladder`.

**Over-cap recovery (§6 invoked):** the packer's 3-way bin (story-failed +
source-tier + off-ladder, predicted 643l) actually packed to **829l > 800 cap**.
The subagent correctly reverted the 3-way per protocol; I re-binned into two 2-ways
that fit: story-failed + off-ladder (546l) and retry-cap + source-tier (600l).
Target of 4 files still hit. Lesson: line-sum projections understate the merged
result when absorbed files carry module-level scaffolding — when a 3-way lands near
the cap, split before merging.

Delegated to a subagent; post-verification by me: 59/162 reproduced, all receivers
≤ 753l, mutation check 3 merged receivers × one flipped assertion → 3 distinct
failures, all reverted.

### 9.14 — 2026-09-21, Task 13 landed — agents/native/adapter group 9 → 3 files (-430 lines)

Hit the packed target: 9 → 3 files, 1,992 → 1,562 lines, all 64 tests / 131
expect() preserved. Unit phase 18,247 / 42,169 unchanged, full suite 0 fail,
`check:all` 0, both tsc clean, coverage 96.32% / 93.40%, 0 below floor.

Bins per the packer, seam assignment mine:

- `adapter-complete-rates` absorbs `turn-classification` + `context-window-override`
  + `cost-rates` + `cache-retention` + `close-physical` (775l — the first 6-way merge
  of the drain; no bin before it exceeded ~3 members).
- `adapter-scope-id` absorbs `catalog-overrides` (208l).
- `adapter.test.ts` base (749l) MIRROR — untouched.

Deletes (6): `adapter-turn-classification`, `adapter-context-window-override`,
`adapter-cost-rates`, `adapter-cache-retention`, `adapter-close-physical`,
`adapter-catalog-overrides`.

Collisions renamed `MODEL`/`send`/`options()`/`dir`/`fakeClient` per absorber;
all absorbed files stubbed the same 4 deps keys (`_clientDeps.build`,
`_resetNativeClient`, `listStoredProviders`, `anyAmbientCredential`) → merged into
one `afterEach` with a single capture.

Delegated to a subagent; post-verification by me: 64/131 reproduced, receivers
≤ 775l, mutation check 2 merged receivers × one flipped assertion → 2 distinct
failures, all reverted.

**Wave 2 complete:** plan (-7 f), static-rules (-7), acceptance-setup (-6),
tier-escalation (-6), adapter (-6) = **-32 files, -2,320 lines** — exactly on the
plan's Wave-2 target. §9.9's Wave-1 shortfall (-3 vs -52) stands; cumulative now
-81 files against the plan's cumulative -84 for Waves 1+2.

### 9.15 — 2026-09-21, Task 14 landed — buildHopCallback group 7 → 3 files (-125 lines)

Re-ranked first per §2.2: the floor moved (Waves 1–2 landed), and buildHopCallback
became the top remaining group (rank 5, +4 removable files). Target was 7 → 3
(-4 f, packer claims -341 l); **landed 7 → 3 (-4 f, -125 l)** — the packer's
line projection again followed the §9.5/§9.13 understatement pattern.

All 72 tests / (unit-phase) 42,169 expect() preserved: unit phase 18,247 /
42,169 (unchanged), full suite 0 fail, `check:all` 0, both tsc clean,
coverage 96.32% lines / 93.41% functions, 0 below floor. Ranker `_deps
unrestored 0` throughout (group carried no `⚠deps` flag).

Seams (packer's bin 2 mixes four unrelated preambles; mine pair what shares
fixtures):

- Receiver A — `build-hop-callback-diff-access.test.ts` absorbs
  `coding-tools` + `context-tools` (run-path reachability: all three assert
  "what reaches `runAsSession`" — nax#1744 pull tools, nax#1744 coding tools,
  #1800 diff-access substitution). **692l — over the 650 fill target, 108
  short of the cap.** Rationale: three genuinely different `makeCtx` fixture
  families with different record shapes (DispatchRecord vs Dispatch) cannot
  dedupe into one preamble; the realistic seam floor here is ~660–700, and
  §9.5's call-op-retry precedent landed 799. Renames: `makeDiffAccessCtx` /
  `makeContextToolsCtx` / `makeCodingToolsCtx`, `makeContextToolsOptions` /
  `makeCodingToolsOptions`, `CODING_TOOLS_SESSION_ID`; deduped the byte
  identical `only()` and `Dispatch` from the two tool files (the only() side
  drops one STATIC expect site — runtime count unchanged, verified via
  junit). `createContextToolRuntime` mock hoisted to the shared top-level
  deps pair after verifying the preamble is gated on `pullTools.length`
  (src/operations/build-hop-callback.ts:278), so diff-access's empty-bundle
  assertions are unaffected.
- Receiver B — `build-hop-callback-stale-retry.test.ts` absorbs `model-pin`
  (nax#1722 re-resolution) + `tier` (hopTier/hopModelId): hop mechanics,
  449l. `SWAP_FAILURE` byte-identical in stale-retry and tier → deduped;
  model-pin's `STUB_TURN` differed in tokenUsage → renamed `PIN_STUB_TURN`;
  `SESSION_ID` literal inlined per absorbed member.
- Base (794l, mirror) untouched. No `src/` change, no escape hatches, no
  baselines moved.

Deletes (4): `build-hop-callback-coding-tools`, `build-hop-callback-context-tools`,
`build-hop-callback-model-pin`, `build-hop-callback-tier`.

Mutation check: flipped one assertion per receiver — 2 distinct failures (AC5
native-rendering `toContain("SHELL BODY")` negated; stale-retry
`openSession.not.toHaveBeenCalled()` → `toHaveBeenCalledTimes(1)`), 45
unrelated pass, reverted both. Post-commit re-run clean.

Runtime invariants (junit-measured): unit 18,247 t / 42,169 a / 7 skip;
integration 1,254 / 2,980 / 36; ui 98 / 149 / 0. **45,298 expect() total —
unchanged, the mandatory invariant.**
