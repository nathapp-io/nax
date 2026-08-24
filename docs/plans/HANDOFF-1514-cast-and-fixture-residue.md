# Handoff: the #1514 long tail

Written 2026-08-24, **rewritten after review**, against `chore/1514-builder-slot-overloads`
at `99329ad71`, where test typecheck is **759 across 249 files** and `looseCast` is **1932**.

Read `HANDOFF-1514-delegable-clusters.md` §G1–G6 first. Those bind you unchanged, including
**G5 as amended**: you may not edit `src/` or `test/helpers/`. Escalate instead.

## Evidence status of everything below — read this before trusting a number

The previous draft of this doc claimed "every recipe below was prototyped". **That was false**
and the review caught it. Precise status now:

| Claim | Status |
|:--|:--|
| §3 recipes R1–R5 | **Proven** — each landed a commit on this branch; STATUS §17–§23 has the evidence |
| §4 blanket-`deepMergeConfig` recipe is wrong | **Proven** — prototyped, backfired, reverted |
| §2 file table: counts and error codes | **Measured** on `99329ad71` |
| §2 file table: *cause* column | **One error read per file**, not prototyped. Treat as a hypothesis to check, not a fact |
| Everything not in the table | **Uninspected** |

When the cause column is wrong, that is expected — say so in `STATUS-1514-drain.md` and move
on. Do not force a file to match a hypothesis in this document.

---

## 1. The residue is a long tail, not a cluster. Work per file.

759 errors / 249 files = **3.0 per file**. 184 files hold ≤3 errors each (319 total); only 19
files hold ≥8 (207 total). The big single-cause clusters are gone — the previous four commits
took the last of them.

So the unit of work is now **one file per commit**, not one cluster per commit. Pick a file
from §2, identify its cause, apply a recipe from §3 if one fits, and run the loop.

### The loop, every commit, no exceptions

```
bun x tsc --noEmit                                  # src — must print NOTHING
bun x tsc --project tsconfig.test.json --noEmit     # count before/after
bun run check:all                                   # 25 gates
bun test <the files you touched> --timeout=30000    # must pass
bun run test                                        # full suite
bun run check:test-typecheck:update                 # baseline LAST, only if all green
```

`check:test-typecheck` prints `worse: <n>` per file. **`worse` must be 0.** If a file you did
not touch got worse, you changed a shared type — stop and revert.

**Never** run `check:test-escape-hatches:update`. If a counter rises, your fix is wrong.

---

## 2. Ranked file list

✅ take these · 🟡 needs a judgement call · 🔴 owner only, do not take

| File | n | codes | likely cause (**hypothesis**) | |
|:--|--:|:--|:--|:--|
| `unit/commands/curator` | 13 | TS2322×13 | sync `mock(() => X)` in an **async** dep slot → R1 | ✅ |
| `unit/execution/lifecycle/run-regression-flake-triage` | 10 | TS2322×10 | single code, single file | ✅ |
| `unit/review/scoped-lint` | 9 | TS2322×9 | single code, single file | ✅ |
| `unit/metrics/tracker-context-metrics` | 10 | TS2322×9 | `budgetPressure: Record<string, unknown>` where `ProviderBudgetPressure` is wanted → R4 | ✅ |
| `unit/cli/plan-decompose-regression` | 7 | TS2322×7 | single code, single file | ✅ |
| `unit/debate/session-helpers` | 10 | TS2554×9 | arity — mock declared with fewer params than the slot → R2 | ✅ |
| `unit/cli/status-cost` | 12 | TS2493×6 TS2352×4 | `mock(() => X)` is zero-arg so `calls[0]` is `[]` → R2 | 🟡 two causes |
| `unit/execution/session-manager-runtime` | 15 | TS2345×15 | partial `AgentAdapter` stub (`{ closePhysicalSession }` only) → R3 | 🟡 needs a factory; keep it file-local |
| `unit/bakeoff/run-action` | 8 | TS2352×5 TS2493×3 | dynamic dep-bag save/restore; the helper costs one cast at `Object.keys` | 🟡 measure first |
| `unit/execution/story-orchestrator-run-phase-events` | 15 | TS2345×15 | `Operation<…>` vs `AnySlot` — `Operation` includes `CompleteOperation`, `AnySlot` excludes it | 🔴 |
| `integration/config/merger` | 19 | TS2769×12 TS2339×6 | per-call-site `deepMergeConfig` type args + 6 dead-key verdicts | 🔴 see §4 |
| `unit/config/merge` | 17 | TS2322×7 … | ≥4 codes, uninspected | 🔴 |

Everything else is ≤8 errors and uninspected. `grep` the file, find the cause, then decide.

**Take the ✅ rows first, in the order listed.** Realistic landing point if all six go:
**759 → ~700**.

---

## 3. The recipe library — all five proven on this branch

**R1 — a sync mock in an async slot.** `mock(() => value)` returns `T`; the slot wants
`Promise<T>`. Make the mock `async`. Do not wrap in `Promise.resolve`, and do not cast.
*(STATUS §18, 4 sites.)*

```ts
resolveProject: mock(async (_opts?: ResolveProjectOptions) => makeResolved()),
```

**R2 — `mock(async () => X)` declares a ZERO-argument mock.** So `calls[0]` types as `[]`,
and every `calls[0][0]` read fails (`TS2493`), as does any arity check (`TS2554`). Type the
mock from the real signature:

```ts
mock(async (..._args: Parameters<DebateRunner["runPlan"]>) => RESULT)
```

*(STATUS §16 — took `plan-debate.test.ts` 15 → 1.)*

**R3 — a partial stub cast into a dep slot.** Write a `makeX()` factory returning the full
shape with `Partial<>` overrides. **Check `test/helpers/` for an existing one first** —
`makeMergeEngine` already existed and had simply never reached the file that needed it
(STATUS §17). If one exists, use it. If not, write yours **file-local**; adding to
`test/helpers/` is G5 and needs an escalation.

**R4 — a fixture field typed `Record<string, unknown>` where a real type is wanted.** Import
the real type and annotate. No cast.

**R5 — delete a local type alias that stands in for a real one.** A hand-written
`type ParseFn = …` next to the real signature is always less precise and suppresses the
checks underneath. Delete it, call the real thing, then delete the casts that existed only to
bridge it. *(STATUS §23 — 15 → 0, and it unmasked 11 more casts that then also went.)*

**R6 — before designing a seam, check whether the cast does anything at all.** In STATUS §22,
36 of 36 were removable outright — the value was already the right type. In §17/§18 they were
not. Ask first; it is the difference between deleting a cast and moving one.

---

## 4. Proven wrong — do not retry this

`deepMergeConfig<T = NaxConfig>(base, override): T`. The tests merge arbitrary objects, so the
default `T = NaxConfig` rejects them (12 `TS2769`). The obvious fix is a type argument at all
29 call sites:

```ts
deepMergeConfig<Record<string, unknown>>(base, override)   // ← prototyped; DO NOT DO THIS
```

19 → 15, **but it introduced six `TS2339` (`'hooks' does not exist on type '{}'`) and six
`TS18046` (`'result.constitution' is of type 'unknown'`)**. Some call sites genuinely merge
real `NaxConfig` and need the typed result back. Needs a per-call-site decision — owner's.

---

## 5. Traps this branch has already paid for

- **Removing a wholesale rejection reveals field-level errors underneath it.** A file can
  legitimately get *worse* for one step. Judge on the final number with `worse: 0`. §19
  targeted 50 and got 48; the 2 survivors were a real defect the overload error had hidden.
- **Print the region you just edited.** A scripted exact-string replacement once dropped a
  function's trailing `return base;`, leaving unreachable code after a `return` — **not a
  TypeScript error, not a Biome finding.** No gate catches it.
- **Never regex over a nested object literal.** Non-greedy patterns match the inner brace and
  shred the file. Tell: the error count collapses to single digits because tsc aborts at the
  parse error.
- **A grep-based negative is not proof.** `\b` fails on a quoted key; a substring over-matches
  (`getAll` hits `getAllAgents`); "no fixture supplies X" does not mean X is untested.
- **`check:file-sizes` blocks line-adding fixes to grandfathered files.**
  `story-orchestrator.test.ts` is pinned at 2006 lines — fixes there must be line-neutral.
- **A count is not a cause.** `config-resolution` was recorded here as "four blocks" from its
  error lines; it was **eight**, because four of them contributed no error until the first
  four were fixed. Count the *constructs*, not the diagnostics.

---

## 6. When to stop

Stop and write it up in `STATUS-1514-drain.md` the moment you find yourself:

- inventing a value to satisfy a required field,
- widening a `src/` type to fit a fixture,
- adding a cast to make an error go away,
- editing `test/helpers/` or `src/`,
- or arguing that a test is wrong.

**Every escalation on this branch turned out to be a real defect worth more than the errors it
was blocking** — a public API narrower than its own runtime (50 errors), a schema erasing
every field of every debate stage and hiding a drifted default (10). Escalating is the
high-value move here, not the fallback.
