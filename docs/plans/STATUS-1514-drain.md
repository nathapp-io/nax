# #1514 test-debt drain — status

Written 2026-08-23 to resume later. Supersedes nothing; it points at the docs that hold detail.

---

## ⚠️ Read this first — the branch has UNVERIFIED work on it

A subagent was dispatched to execute `HANDOFF-1514-dead-fixture-keys.md` and **was stopped
mid-task**. What it left, established by inspection:

**Three commits landed** (on top of `a2547c3aa`):

- `d174bdc4f` — drop dead `skipGeneratedVerificationTests` / `minTestCoverage` (+ maxCostUSD)
- `1d997a92f` — drop dead `dangerouslySkipPermissions` / `getAll`
- `38da84486` — drop dead `estimatedComplexity` / `onWatchdogRegister`

**One file left modified and uncommitted:**
`test/integration/interaction/interaction-chain-pipeline.test.ts` — the `timeoutRetryCountMap`
key (Category A, 2 errors). The partial edit looks *correct in approach*: it deletes the dead
key and then supplies the required fields the deletion unmasked (`agentManager`,
`sessionManager`, `abortSignal`), hoisting `makeMockRuntime()` into a local so the three
can be drawn from one runtime. That is exactly the §1 behaviour the handoff describes, handled
the right way — but it was interrupted before verification.

**None of this has been verified by a full gate run.** Before continuing:

```bash
bun x tsc --noEmit                 # must be 0
bun x tsc --project tsconfig.test.json --noEmit 2>&1 | grep -c 'error TS'
bun run check:all
bun run test
# and the per-file gate, against the baseline as of a2547c3aa
```

If those are green, finish the uncommitted file and carry on from Category A's remaining keys.
If they are red — or the typecheck count reads as a single digit, meaning broken syntax — revert
the uncommitted file only (`git checkout -- <path>`) and re-verify before touching the commits.

**Do not re-do the three committed keys.** Re-derive what is left with:

```bash
bun x tsc --project tsconfig.test.json --noEmit 2>&1 \
  | grep -cE 'error TS(2353|2561):'
```

## 1. Where the work stands

| Phase | State | PR |
|:--|:--|:--|
| casts sweep (681 → 102) | ✅ merged | #1683 |
| escape-hatch guard, `DeterministicOperation<D>`, type imports | ✅ merged | #1683 |
| `config-slices` (`makeConfigSlice`) | ✅ merged | #1684 |
| `callop-seam` (monomorphic dep bags) | ✅ merged | #1684 |
| **`dead-fixture-keys`** | **in progress** | — |
| implicit-any params (~103) | not started | — |
| `makeObservation` / remaining seams (~90) | not started | — |

**Branch:** `chore/1514-dead-fixture-keys`, off `main` @ `df9bb89b1`. **Local only — never
pushed.**

## 2. Last numbers I verified personally (at `a2547c3aa`)

| | value |
|:--|--:|
| `tsc --noEmit` (src) | **0** |
| test typecheck | **1633** |
| `as unknown as` casts | **102** |
| `asAny` | 1394 |
| `tsSuppress` | 54 |
| `ratchetAllow` | 107 |
| `absentValue` | 17 |
| `anyType` | 1886 |
| `looseCast` | 2008 |

Against the original #1514 start: casts **815 → 102 (−87%)**, typecheck **2009 → 1633**.

## 3. The commits I verified myself

The branch now holds **six** commits: these three, plus the subagent's three listed in the
warning block above, which I have *not* gate-verified.

- `59674c69b` — dropped the dead `turnId` fixture key, supplied `internalRoundTrips`
  (1645 → 1633). The worked example for the handoff.
- `38de504e8` — the dead-fixture-keys handoff (initial, 49 errors).
- `a2547c3aa` — **corrected** that handoff to 38 errors after review found three bad verdicts.

## 4. Next actions, in order

1. **Reconcile the subagent's partial work** (see the warning block above).
2. Finish `HANDOFF-1514-dead-fixture-keys.md` — 38 errors, 10 keys, 19 files, expected
   ~1633 → ~1595. Category A deletes, Category B renames, both cast-free.
3. Open a PR for the branch. It is test-only so far, so it should review quickly.
4. Then the two remaining phases (implicit-any, `makeObservation`) — both need planning
   the same way: measure, prototype, then decide what is genuinely delegable.

## 5. Traps this branch has already hit — do not relearn them

- **Deleting a dead key unmasks a second bug.** TypeScript reports an unknown property
  *instead of* a missing required one, so the typecheck total often does not drop by the
  number of keys removed. That is expected. The real gates are `src` tsc 0, per-file
  `worse: 0`, suite green.
- **Never regex over a nested object literal.** A non-greedy pattern matches the inner
  `JSON.stringify({…})` brace and shreds the file. Tell: the typecheck count collapses to a
  single digit, because tsc aborts at the first parse error.
- **`check:file-sizes` rejects line-adding fixes to grandfathered files.**
  `story-orchestrator.test.ts` is capped at 2006 lines; fixes there must be line-neutral.
- **A grep-based negative is not proof.** This misled me three times in one session:
  a `\b` word boundary silently fails on a quoted key (`"on-story-complete"`), a plain
  substring search over-matches (`getAll` "hits" `getAllAgents`), and "no fixture supplies a
  non-empty X" does not mean X is untested when a sibling file builds X from real inputs.
  Check the *consumers*, and use two independent greps.
- **No change may trade one counter against another.** A typecheck drop paired with an
  `anyType` or `looseCast` rise is a failed step. The `looseCast` counter has already
  rejected one of my own commits, correctly.

## 6. Doc map

| Doc | Holds |
|:--|:--|
| `PROPOSAL-1514-phase2-typecheck-drain.md` | the root-cause analysis and per-phase status |
| `HANDOFF-1514-dead-fixture-keys.md` | **the active task** — 38 errors, per-key verdicts, evidence |
| `HANDOFF-1514-config-slices.md` | done — `makeConfigSlice` |
| `HANDOFF-1514-callop-seam.md` | done — monomorphic dep bags |
| `PLAN-1514-callop-seam.md` | the three-tier analysis behind it |
| `HANDOFF-1514-cast-sweep.md` | the original cast sweep, kept as the worked record |

Commit tags for un-started work are **descriptive** (`#1514 dead-fixture-keys`), never
`phase N` — the original #1514 plan already used "phase 3a"/"phase 3c" for unrelated work.
