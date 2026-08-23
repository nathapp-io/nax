# #1514 test-debt drain — status

Written 2026-08-23 to resume later. Supersedes nothing; it points at the docs that hold detail.

---

## ✅ The dead-fixture-keys handoff is COMPLETE

`HANDOFF-1514-dead-fixture-keys.md` finished on 2026-08-23: all 10 keys, 38 errors, fully
gate-verified. Every commit below was run through the full six-step loop (src tsc, test
typecheck, per-file gate `worse: 0`, `check:all`, full suite, baseline update).

## ✅ The mechanical-fixture-fields handoff is COMPLETE

`HANDOFF-1514-mechanical-fixture-fields.md` finished on 2026-08-23 on
`chore/1514-implicit-any-params` (head `b5fb516`): all 3 clusters, **91 errors**
(1351 → 1260), fully gate-verified. Same six-step loop per commit. Details in §2b/§3b.

## 1. Where the work stands

| Phase | State | PR |
|:--|:--|:--|
| casts sweep (681 → 102) | ✅ merged | #1683 |
| escape-hatch guard, `DeterministicOperation<D>`, type imports | ✅ merged | #1683 |
| `config-slices` (`makeConfigSlice`) | ✅ merged | #1684 |
| `callop-seam` (monomorphic dep bags) | ✅ merged | #1684 |
| **`dead-fixture-keys`** | ✅ **done — ready for PR** | — |
| **implicit-any params (~103)** | **in progress** — mechanical slice done (91 errors, §2b); the rest is design work (§7 of the handoff) | — |
| `makeObservation` / remaining seams (~90) | not started | — |

**Branches (both local only, never pushed):**
- `chore/1514-dead-fixture-keys`, off `main` @ `df9bb89b1`
- `chore/1514-implicit-any-params`, off `main` (head `b5fb516`)

## 2. Last numbers I verified personally (at `d38bbb87`, branch head)

| | value |
|:--|--:|
| `tsc --noEmit` (src) | **0** |
| test typecheck | **1594** |
| `as unknown as` casts | **102** |
| `asAny` | 1394 |
| `tsSuppress` | 54 |
| `ratchetAllow` | 107 |
| `absentValue` | 17 |
| `anyType` | 1886 |
| `looseCast` | 2008 |

Against the original #1514 start: casts **815 → 102 (−87%)**, typecheck **2009 → 1594**.

## 2b. Numbers measured on `chore/1514-implicit-any-params` (branch head `b5fb516`)

| | before (at `666b9e0a7`) | after (at `b5fb516`) |
|:--|--:|--:|
| `tsc --noEmit` (src) | **0** | **0** |
| test typecheck | **1351** | **1260** |
| `as unknown as` casts | 102 | **102** |
| `asAny` | 1393 | **1388** |
| `tsSuppress` | 54 | 54 |
| `ratchetAllow` | 106 | 106 |
| `absentValue` | 17 | 17 |
| `anyType` | 1885 | **1880** |
| `looseCast` | 2008 | **2007** |

**−91 errors, exactly the handoff's estimate.** Every counter flat or lower — no trade.

## 3. The commits on the branch

**Handoff groundwork (verified by me):**

- `59674c69b` — dropped the dead `turnId` fixture key, supplied `internalRoundTrips`
  (1645 → 1633). The worked example for the handoff.
- `38de504e8` — the dead-fixture-keys handoff (initial, 49 errors).
- `a2547c3aa` — **corrected** that handoff to 38 errors after review found three bad verdicts.

**Dead-fixture-keys execution (all gate-verified end-to-end):**

- `d174bdc4f` — drop dead `skipGeneratedVerificationTests` / `minTestCoverage` (+ maxCostUSD)
- `1d997a92f` — drop dead `dangerouslySkipPermissions` / `getAll`
- `38da84486` — drop dead `estimatedComplexity` / `onWatchdogRegister`
- `fbaaa8a57` — drop dead `timeoutRetryCountMap` (1612 → 1610); deletion unmasked required
  `agentManager`/`sessionManager`/`abortSignal` on `PipelineHandlerContext`, supplied from
  `makeMockRuntime()` per §1 of the handoff
- `7400726e` — rename `ruleId` → `rule` on `Finding` fixtures, add `makeFinding`
  (`test/helpers/finding.ts`, same shape as `makeTurnResult`) (1610 → 1598); the rename
  unmasked required `source`/`category` on 10 literals in 4 files — **escalated per §7,
  user approved the factory** (59674c69b precedent)
- `d38bbb87` — rename `cacheCreationTokens`/`cacheReadTokens` → `*InputTokens` (1598 → 1594)

**Mechanical-fixtures execution (all gate-verified end-to-end, tag `#1514 mechanical-fixtures`):**

- `d7fd5b1` — cluster A: supply `maxScanFiles: 200` on `SmartTestRunnerConfig` fixtures
  (1351 → 1339, −12; schema default at `src/config/schemas-execution.ts:114`)
- `d6a39d4` — cluster B: supply `workdir: "/tmp/test"` on `AdversarialReviewInput` /
  `SemanticReviewInput` fixtures (1339 → 1329, −10; required at `src/review/adversarial.ts:77`)
- `e68d4dd` — cluster C: migrate 17 files' hand-rolled spawn fakes to the existing
  `makeSpawn` helper (1329 → 1273, −56); mock call-count assertions moved to `stub.calls`
- `b5fb516` — cluster C residue: close the last 13 spawn seams test-side (1273 → 1260):
  `treeDeps()` plain-arrow wrapper in resume-hydrate (10), `FakeProcSpec` gained
  `killResolvesExited` + `stdoutError` (3)

## 4. Revealed findings worth recording

- **`dangerouslySkipPermissions` documented as live, is not.** `CLAUDE.md` still says it is
  "deprecated — the resolver handles it", but it has **zero** occurrences in `src/`,
  including `src/config/`. **To file separately** — deliberately not touched (handoff §6).
- **The handoff's `ruleId` count (10) undercounted by 2**: `semantic-verdict.test.ts` also
  had two TS2551 property *reads* (`.ruleId`) alongside the three TS2561 literals; renaming
  only the literals would have broken the reads at runtime. All five renamed.
- **The handoff's landing estimate held**: 1633 → ~1595 predicted, landed 1594.
- **The mechanical handoff's cluster-C arithmetic was off by 2/2.** The handoff claimed 69
  errors across 17 files; the live tree had **71 across 19**. Two extra files
  (`test/helpers/fake-agent-manager.ts` `onPidSpawned`, `spawn-client-pid-callback.test.ts`
  `null`→`number`) were different error classes and correctly left out. The 71/17 counts in
  its per-file table otherwise matched.
- **`typeof Bun.spawn` is not assignable to `CaptureTreeStateDeps.spawn`.** The deps type is
  declared `(cmd: string[], opts: unknown) => unknown` (resume-hydrate.ts:5), and the strict
  overload rule rejects `typeof Bun.spawn` against it — even the real `_gitDeps` fails. src
  already wraps the seam at `run-phase.ts:56-58`; the test now wraps the `makeSpawn` stub the
  same way via a cast-free `treeDeps()` helper (single-arg call picks the `(cmd, opts?)`
  overload). Worth remembering: **`makeSpawn(...).spawn` is not universally assignable — check
  the target deps type before assuming the mechanical migration applies.**
- **Two hang tests needed a kill contract `FakeProcSpec` did not model.** `git.test.ts`'s
  SIGKILL test and `worktree/dependencies.test.ts`'s timeout test both require `kill()` to
  *resolve* `exited` (real Bun.spawn behaviour); `hang` only made it never settle. Fixed by
  adding `killResolvesExited` to `FakeProcSpec` (the worktree one already used the sanctioned
  `test-ratchet-allow` cast and was left alone). `otel-resource-git`'s two erroring-stdout
  fakes drove the new `stdoutError` field.

## 5. Next actions, in order

1. **Open a PR for `chore/1514-dead-fixture-keys`.** It is test-only (plus
   `test/helpers/finding.ts`), so it should review quickly. The baseline files move in the
   same commits — expected.
2. **Continue `chore/1514-implicit-any-params`.** The mechanical slice is done (91 of 1351
   errors). The residue at `b5fb516` is **1260 errors**, and per `HANDOFF-1514-mechanical-fixture-fields.md`
   §7 the overwhelming majority is design work, not mechanical: `as unknown as`-shaped
   (190, concentrated in 6 files), `ConfigSelector<Pick<…>>` variance (32), the
   `CompleteOperation` vs `RunOperation` union (15), and ~30 dead config keys
   (`defaultAgent`/`defaultTier`/`timeout` — the dead-fixture-keys method applies, see
   `HANDOFF-1514-dead-fixture-keys.md`). Plan each cluster the same way: measure, prototype,
   then decide what is genuinely delegable.
3. Then `makeObservation` / remaining seams (~90) — same planning discipline.

## 6. Traps this branch has already hit — do not relearn them

- **Deleting a dead key unmasks a second bug.** TypeScript reports an unknown property
  *instead of* a missing required one, so the typecheck total often does not drop by the
  number of keys removed. That is expected. The real gates are `src` tsc 0, per-file
  `worse: 0`, suite green. When the unmask exceeds ~2 sites with no factory, **escalate —
  do not invent values** (the `makeFinding` decision was an approved escalation).
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
- **A split commit needs its baseline regenerated at the intermediate state.** Committing
  the `ruleId` work while `fail-stale-complete.test.ts` still carried its 4 errors would
  have left the baseline claiming 0 for that file — the per-file gate would fail at the
  intermediate commit. Stash the later key's file, update the baseline, commit, pop.
- **No change may trade one counter against another.** A typecheck drop paired with an
  `anyType` or `looseCast` rise is a failed step. The `looseCast` counter has already
  rejected one of my own commits, correctly.

## 7. Doc map

| Doc | Holds |
|:--|:--|
| `PROPOSAL-1514-phase2-typecheck-drain.md` | the root-cause analysis and per-phase status |
| `HANDOFF-1514-dead-fixture-keys.md` | **done** — 38 errors, per-key verdicts, evidence, worked example |
| `HANDOFF-1514-mechanical-fixture-fields.md` | **done** — 91 errors, 3 clusters, traps (§5), escalation bar (§6) |
| `HANDOFF-1514-config-slices.md` | done — `makeConfigSlice` |
| `HANDOFF-1514-callop-seam.md` | done — monomorphic dep bags |
| `PLAN-1514-callop-seam.md` | the three-tier analysis behind it |
| `HANDOFF-1514-cast-sweep.md` | the original cast sweep, kept as the worked record |

Commit tags for un-started work are **descriptive** (`#1514 dead-fixture-keys`,
`#1514 mechanical-fixtures`), never `phase N` — the original #1514 plan already used
"phase 3a"/"phase 3c" for unrelated work.