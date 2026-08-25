# Biome v2 Migration Risk Findings

Original: 2026-04-28
Revised: 2026-08-22 — re-measured against `main` at `6b58f8e22` with Biome `2.5.10`.
Revised: 2026-08-25 — re-measured against `main` at `7549b8a1d`. **The 2026-08-22 revision
described a lint scope and config that no longer exist**, which inverted one of its own
conclusions; and it missed the finding that now ranks second in this document (the severity
demotion, below). See "Revision Notes" at the end.

## Scope

Assessment of migrating `@biomejs/biome` from `^1.9.4` to `2.5.10` (current latest),
including whether the custom checks `check:test-mocks` and `check:process-cwd` can move
into Biome rules.

Current wiring at `main` (`7549b8a1d`):

- `package.json` `lint` runs `bun x biome check src/ bin/ test/` plus eleven `check:*` script
  gates. **`test/` is in scope** — it was added after the 2026-08-22 revision was written.
- `check:all` is the single aggregator: `lint` plus twelve further gates (24 checks), closed
  by `check:gate-reachability`.
- `.github/workflows/ci.yml` runs one `test` job whose static stage is a single
  `bun run check:all` step, then unit / integration / ui / **e2e** / coverage steps.
- `.githooks/pre-commit` runs `typecheck` then `check:all`.
- `biome.json` is on the `1.9.4` schema, `organizeImports.enabled: true`,
  `linter.rules.recommended: true`, and **has two `overrides` blocks**:
  `test/**` turns off `noExplicitAny`, `noNonNullAssertion` and `noDelete`;
  `test/helpers/*-internals.ts` turns off `useLiteralKeys`.

Those overrides are load-bearing, not cosmetic. Deleting the `test/**` block alone and
re-running `lint` under 1.9.4 produces **2555 errors**.

## Method

2026-08-25 figures come from running `bun x @biomejs/biome@2.5.10` against the working tree
with `--config-path` pointing at a migrated copy of `biome.json` held outside the repo, so
the repo's own config and lockfile were never modified. All counts use
`--reporter=json --max-diagnostics=20000`; the 1.9.4 comparisons are the repo's own
`bun x biome check`.

Baseline: **Biome 1.9.4 on `src/ bin/ test/` — the real lint scope — exits 0.** Every number
below is therefore regression introduced by the upgrade, not pre-existing debt.

The 2026-08-22 figures were taken on `src/ bin/` only, so its headline "284 diagnostics"
understated some categories and overstated others. All 2026-08-25 figures below are on the
full scope with the overrides migrated.

## Summary

Upgrading the dependency is feasible and **the error-severity blast radius is small**: with
the config migrated and the import assist deferred (rollout step 1), the full scope reports
**37 errors** — 22 `noUnsafeOptionalChaining`, 12 `format`, 2 `useIterableCallbackReturn`,
1 `noNonNullAssertedOptionalChain`. The 1125 `organizeImports` errors are a separate
mechanical commit by design. Migrating the custom checks is still uneven, and that conclusion
is unchanged: `check:process-cwd` is a fair GritQL pilot; `check:test-mocks` is not (skip list
now 167 entries).

Two findings outrank everything else, and neither is a formatting concern:

1. **The official migration command silently disables the entire linter.**
2. **v2 demotes the `test/` rules from error to warning, which silently voids the payoff of
   the test-debt drain's endgame.** This one is new as of 2026-08-25 and it constrains
   sequencing: it must be decided *before* the drain, not after.

Both are below.

## High Risks

### `biome migrate --write` Turns The Linter Off

`biome migrate --write` rewrites

```json
"linter": { "rules": { "recommended": true } }
```

into

```json
"linter": { "rules": { "preset": "none" } }
```

With `preset: "none"` no lint rule is enabled. `biome check` then reports zero lint
diagnostics — not because the tree is clean, but because nothing is running. Neither CI
nor the pre-commit hook can distinguish that from success: the gate is green in both cases.

Risk: the repo ships with lint permanently disabled and nobody notices.

Mitigation:

- After running `migrate --write`, hand-restore `linter.rules.recommended: true` and diff
  the generated config line by line.
- Gate the migration PR on a **diagnostic count**, not on a green `check:all`. Capture
  `biome check src/ bin/ --reporter=json` before and after and compare category counts.
- Consider asserting a non-zero enabled-rule count in a gate if the linter is ever
  reconfigured again.

### v2 Demotes The `test/` Rules To Warnings, Voiding The Drain's Endgame

Measured on the full scope, dropping the `test/**` override:

| Biome | `noExplicitAny` | `noNonNullAssertion` | effect on `lint` |
|:--|--:|--:|:--|
| 1.9.4 | error | error | 2555 errors — **hard failure** |
| 2.5.10 | 1851 **warnings** | 1093 **warnings** | `biome check` **exits 0** |

`docs/plans/STATUS-test-debt-drain.md`'s endgame item 4 is: drain `asAny` / `anyType` (1377 /
1860) and `nonNullAssert` (820) to zero, then **drop the `test/**` override so the rules gate
properly** and the counters retire into a real Biome rule rather than a ratchet.

Under 1.9.4 that works — the rules are error-severity, so removing the override converts a
counting ratchet into a hard gate. **Under 2.5.10 it buys nothing.** The rules land at warning
severity, `biome check` exits 0 on warnings, and roughly 2900 drained sites would retire into
no enforcement at all.

Risk: the drain is completed against a contract the upgrade has already changed, and the
result is ~2900 sites of work that gate nothing. Note this is invisible at the end — a green
`check:all` looks identical either way.

Mitigation:

- **Sequence the upgrade before the drain**, and make the severity call as part of it.
- If the drain's endgame is wanted, the upgrade PR must explicitly promote
  `suspicious/noExplicitAny` and `style/noNonNullAssertion` to `"error"` in the `test/**`
  override's eventual replacement. Accepting v2 defaults is a decision to abandon item 4.
- The same demotion applies to the `correctness` family on `src/` (see "Severity Semantics",
  below) — one policy decision covers both.

### Import Churn: 1125 Files

Biome v2 replaces `organizeImports` with the assist action
`assist.actions.source.organizeImports`, and its ordering differs — type imports and named
specifiers both move. Against `main`:

- `assist/source/organizeImports`: **1125 errors** across `src/ bin/ test/`
- `format`: **12 errors**

(2026-08-22 reported 280 and 4 on the narrower `src/ bin/` scope. The growth is scope, not
drift — `test/` is roughly four fifths of it.)

A single `bun run lint:fix` rewrites ~1137 files. That is one mechanical commit's worth of
diff, but it lands on every open branch as a rebase conflict and it obscures `git blame`.
**This is the risk that decides scheduling** — see "Recommended Rollout".

Mitigation:

- Land the dependency/config change with the assist action **off**, then re-enable it in a
  separate commit that contains nothing else.
- Add that commit to `.git-blame-ignore-revs`.
- Do it on a quiet tree. This is the risk that scales with how much work is in flight, and
  it is the reason to schedule the upgrade rather than take it opportunistically.

## Medium Risks

### 25 Real Lint Errors Appear — Mostly Genuine-Bug-Shaped, Mostly In `test/`

With `recommended: true` restored and the import assist off, v2 finds 25 error-severity lint
violations on `src/ bin/ test/` (plus 12 `format`):

| Rule | N | Where |
|:--|--:|:--|
| `correctness/noUnsafeOptionalChaining` | 22 | 16 files, all `test/` (6 in `test/unit/operations/call.test.ts`) |
| `suspicious/useIterableCallbackReturn` | 2 | `bin/nax.ts`, `test/unit/context/engine/staleness.test.ts` |
| `suspicious/noNonNullAssertedOptionalChain` | 1 | `test/unit/context/engine/providers/code-neighbor.test.ts` |

None are style. `noUnsafeOptionalChaining` catches `a?.b.c` shapes that throw when `a` is
nullish — **arguably the single most valuable thing this upgrade buys**, and it is invisible
today because `test/` was only recently brought into lint scope and 1.9.4 lacks the rule.

All are fixable under 1.9.4 first *except* the rules 1.9.4 does not have, so step 0 empties
only part of this. Budget the rest into step 2.

### Severity Semantics Get Looser, Not Stricter

The 2026-04-28 note left this open ("CI may become stricter or looser"). Measured: it gets
looser, and on the full scope it gets looser by a lot. `biome check` **exits 0 on warnings**,
so every number in this table is unenforced by any gate:

| Warning | N |
|:--|--:|
| `correctness/noUnusedImports` | 272 |
| `correctness/noUnusedVariables` | 132 |
| `correctness/noUnusedFunctionParameters` | 72 |
| `suspicious/noTemplateCurlyInString` | 27 |
| `suspicious/noTsIgnore` | 15 |
| `suspicious/noPrototypeBuiltins` | 9 |
| `complexity/useOptionalChain` | 8 |
| `suppressions/unused` | 8 |
| others | 3 |
| **total** | **546** (+ 12 info) |

Risk: the upgrade quietly adds 546 findings that no gate enforces, and they accumulate. This
is the same mechanism as the drain finding above — it is one policy question, not two.

Two are worth calling out:

- `noTsIgnore` (15) overlaps the existing `tsSuppress` ratchet (baseline 40, which also counts
  `@ts-expect-error` / `@ts-nocheck`). Promoting it to `error` is a candidate route to
  retiring part of that ratchet into a real rule — the same move endgame item 4 wants for
  `noExplicitAny`.
- The `noUnused*` family (476 combined) is the bulk of the noise and is mechanically fixable
  by `lint:fix`, so promoting it to `error` is cheap if done in the churn commit.

Mitigation: make one explicit severity call covering this family and the `test/` rules above,
and record it in `biome.json` with a comment. Accepting v2 defaults silently is the failure
mode.

### Eight Dead Suppressions

The tree carries **58** `biome-ignore` comments (2026-08-22's "208" did not survive
re-counting). Under v2 with `recommended: true`, eight no longer suppress anything and emit
`suppressions/unused`: `src/execution/runner-execution.ts`,
`test/integration/review/adversarial-reprompt-telemetry.test.ts`, and six in
`test/unit/agents/acp/adapter.test.ts`.

(Under the mis-migrated `preset: "none"` config this reads as 42 unused suppressions — a
useful secondary tell that the linter has been switched off.)

### Widening Lint Scope To `test/` — Already Done, And Now The Baseline

**This section's premise is obsolete and its advice was followed by accident.** `lint` was
widened to `src/ bin/ test/` after 2026-08-22, in a different PR from any version upgrade,
which is exactly what this section asked for. The override block shipped with it.

The consequence is that the "order of magnitude" scenario is now the *live* configuration,
held green by the `test/**` override. Measured under v2 with that override removed: **4664
diagnostics** (1851 `noExplicitAny` + 1093 `noNonNullAssertion` warnings, 1125
`organizeImports` errors, the rest). With the override in place: 1720.

The glob-syntax trap remains real but is **not** triggered by the documented path: `biome
migrate --write` correctly rewrites `"include": ["test/**"]` → `"includes": ["**/test/**"]`
and `"test/helpers/*-internals.ts"` → `"**/test/helpers/**/*-internals.ts"` (verified
2026-08-25). The trap only bites an override **hand-written** in v1 syntax under a v2 schema,
which matches nothing and silently drops the exemption.

Mitigation: run `migrate --write` rather than hand-editing `overrides`, and diff the two
override blocks specifically. If either stops matching, `useLiteralKeys` fails loudly (it is
error-severity) but `noExplicitAny` / `noNonNullAssertion` do not — see the first high risk.

## Custom Checks: Conclusion Unchanged

### `check:process-cwd` — Fair GritQL Pilot

The script is a 26-line grep over `src/` excluding `src/cli/`, `src/commands/`, and
`src/config/loader.ts`. `bin/nax.ts` has many intentional `process.cwd()` calls and is not
scanned at all.

Risk: a plugin without precise path scoping fails `lint` on valid CLI entry-point usage.

Mitigation: scope the plugin with `files.includes` / `linter.includes`, validate against
negative fixtures, and keep `check:process-cwd` as a wrapper until parity is proven.

### `check:test-mocks` — Still Not A Replacement Candidate

The script maintains a **167-entry** skip list (up from the "large allowlist" noted in
April), detects four patterns (inline agent-manager mocks, inline agent-adapter mocks, local
`makeConfig()`, local `makeStory()`), carries a false-positive guard for `supportedTiers`
inside helper calls, and emits grouped project-specific hints. GritQL plugins reproduce none
of the ledger or reporting behaviour.

Mitigation: leave it as a TypeScript script. Revisit only if the skip list shrinks
substantially.

### Gate Reachability

`check:gate-reachability` is what keeps a gate from silently disappearing from `check:all`.
If a script gate is ever replaced by a Biome plugin, the gate's own disappearance is the
thing to watch — the reachability check tracks `check-*` scripts, not Biome rule coverage.

## Low / Operational Risks

### Lockfile

`package.json` and `bun.lock` both pin `1.9.4`. CI runs `bun install --frozen-lockfile`, so
both must move in one commit.

### Editor Compatibility

v2 requires a compatible editor extension / LSP. Local diagnostics will differ from CI until
developers update. Note the requirement in the migration PR and treat CI as the source of
truth during rollout.

## Recommended Rollout

**Do this before resuming the test-debt drain, not after.** Two independent reasons:

- **Correctness of sequencing.** The drain's endgame item 4 is defined against a severity
  contract this upgrade changes (first high risk). Deciding it afterwards means ~2900 sites
  were drained toward a gate that does not exist.
- **Conflict cost.** Step 3 rewrites ~1137 files. The next drain touches thousands of `test/`
  files across many sessions. Landing the churn commit first, on a quiet tree, is the only
  cheap ordering. As of `7549b8a1d` the tree *is* quiet — PR #1715 merged, nothing in flight.

Sequenced so each step has an independently checkable outcome:

0. Fix what 1.9.4 can already see under the current config. Optional; it only partly empties
   step 2, since 1.9.4 lacks `noUnsafeOptionalChaining` and `noNonNullAssertedOptionalChain`.
1. **Dependency + config, zero behaviour change.** Pin `2.5.10` exactly, run
   `migrate --write`, **restore `linter.rules.recommended: true`** (the migration writes
   `preset: "none"`), set the organizeImports assist to `"off"`, and diff both `overrides`
   blocks. Accept only on a before/after JSON diagnostic diff — not on a green `check:all`.
2. **Error-severity fixes: 25 lint + 12 format.** The 22 `noUnsafeOptionalChaining` are the
   substance here and are real defects, not style. Expect this to be the longest step.
3. **Re-enable organizeImports + formatter.** One mechanical commit, ~1137 files, nothing
   else in it, added to `.git-blame-ignore-revs`. **Done** — 1127 files. Apply it with
   `biome check --write --linter-enabled=false` so the assist and formatter run but the
   step-4 lint fixes do not. Not fully mechanical in practice; see below.
4. **Severity policy decision — the step that matters most.** Covers both the 546 new
   warnings and the `test/` rules. **Partly done** — the `test/` half is decided and the
   `src/` half has landed; the 546 warnings are still unenforced. See "Step 4 Decision".
5. **GritQL pilot** for `process.cwd()`, with `check:process-cwd` retained as a wrapper.
6. Leave `check:test-mocks` alone.

Steps 1-4 are roughly a day on a quiet tree — more than 2026-08-22's "half-day", because step
2 grew from 1 error to 37 when `test/` entered lint scope. There is no forcing function —
Biome is a dev-only dependency with no runtime or security exposure — so the schedule
pressure is entirely about step 3's conflict surface and the drain sequencing above.

### Step 3 Outcome: The Reorder Is Not Purely Mechanical

Landing step 3 needed three source edits the "one mechanical commit" framing did not predict.
Budget for them; they are found by running the gates, not by reading the diff.

- **A latent import cycle became a crash.** Sorting `./types` to the end of the
  `src/agents/retry` barrel left `ParseValidationError` uninitialized for
  `src/operations/setup-generate.ts`, which extends it at module-evaluation time:
  `ReferenceError: Cannot access 'ParseValidationError' before initialization`. Fixed by
  importing from the `../agents/retry/types` leaf. **This is the real risk of step 3** — a
  barrel re-export order that a cycle silently depended on. `check:import-cycles` reports
  135 cycled modules at baseline, so more of these are possible; any `class X extends Y`
  or other module-evaluation-time use of a barrel import is a candidate. It surfaces as a
  runtime throw in a gate or test, never as a lint or type error.
- **Interleaved statements in an import block get blank lines inserted.** A re-export sitting
  between two imports (`src/prd/schema.ts`) is moved below the block and padded. The padding
  is not optional — removing it re-triggers `organizeImports`.
- **Two grandfathered files grew past their `check:file-sizes` baseline** where merged
  specifiers wrapped past `lineWidth: 120`. Bump those entries individually; do not run
  `--update-baseline`, which would ratchet every grown file at once.

### Step 4 Decision: Promote `src/`, Defer `test/`, Promote It Back After The Drain

Endgame item 4 is **kept, not abandoned**. The decision splits by scope, because the two
halves have very different costs — a distinction the "High Risks" framing above blurs.

Measured 2026-08-25 with both rules forced to `"error"`:

| Scope | `noExplicitAny` | `noNonNullAssertion` | cost of promoting |
|:--|--:|--:|:--|
| `src/` + `bin/` | 0 | 0 | **none** |
| `test/` (override dropped) | 1851 | 1092 | 2943 errors |

- **`src/` + `bin/` are now `"error"`** (top-level `linter.rules` in `biome.json`). This was
  free, and it closed a regression that steps 1-2 introduced without anyone noticing: under
  1.9.4 a new `any` in `src/` **failed** `bun run lint`; under 2.5.10 at v2 defaults it
  emitted a warning and `lint` exited 0. Verified with a deliberate violation before and
  after — same probe, 2 warnings then, 2 errors now.
- **`test/**` stays `"off"`.** Promoting it does not retire a single `any`; it only turns the
  build red until 2943 edits are done. A gate can follow a drain, it cannot precede one.
- **When the drain reaches zero, the override is PROMOTED BACK to `"error"`, not deleted.**
  Deleting it lands the rules at v2's default warning severity and `biome check` exits 0 on
  warnings — the exact trap in "v2 Demotes The `test/` Rules To Warnings". Recorded in the
  header of `scripts/check-test-escape-hatches.ts`, where the next drainer will read it.
  (`biome.json` cannot hold a comment — it is strict JSON, not JSONC.)

Still open in step 4: the 546 unenforced warnings. `biome check --error-on-warnings` exists
in 2.5.10 and would end the accumulation in one flag. Cost to get there, measured: a
`--write --unsafe` pass takes **542 warnings to 54** across 275 files, leaving 27
`noTemplateCurlyInString`, 17 `noUnusedVariables`, 8 dead suppressions and 2 others to fix by
hand.

### The `nonNullAssert` Ratchet Undercounts By 273

Found while deciding the above, and it outlives this document's scope. The claim that the
`test/` debt is "already tracked by the escape-hatch ratchet" is only three-quarters true:

| Counter | ratchet | Biome | gap |
|:--|--:|--:|--:|
| `anyType` / `noExplicitAny` | 1860 | 1851 | ~equivalent |
| `nonNullAssert` / `noNonNullAssertion` | 819 | 1092 | **273 uncounted** |

`scripts/check-test-escape-hatches.ts` is a raw-text regex whose own doc comment concedes it
"undercounts rather than over-" and that "doing better needs a parser". Biome has the parser.
So 273 non-null assertions in `test/` are counted by nothing: the regex misses them and the
rule is off.

The fix does not need the drain finished or the severity flipped: run Biome with the rule
enabled, parse `--reporter=json`, and ratchet on **that** count instead of the regex. The
blind spot closes immediately, and when the drain lands, ratchet and rule are already
measuring the same thing, so the promote-back becomes a one-line severity change.

## Revision Notes (2026-08-25)

Corrections to the 2026-08-22 version, re-measured at `main` `7549b8a1d`:

- **The described wiring no longer existed.** `lint` covers `src/ bin/ test/`, and
  `biome.json` has two `overrides` blocks. 2026-08-22 stated the opposite of both, which made
  its "Widening Lint Scope To `test/`" section a forecast of something that had already
  happened — that section is rewritten and its premise retired.
- **Added the severity-demotion finding**, now the top high risk: v1 treats `noExplicitAny` /
  `noNonNullAssertion` in `test/` as errors (2555 on override removal), v2 as warnings, and
  `biome check` exits 0 on warnings. This voids the payoff of the test-debt drain's endgame
  item 4 unless severity is explicitly promoted, and it is the reason to sequence the upgrade
  before the drain.
- Import churn 280 → **1125** files; `format` 4 → **12** (scope, not drift).
- "One real lint error" → **25**, of which 22 are `noUnsafeOptionalChaining` in `test/` — a
  genuine-bug rule 1.9.4 does not have. Re-framed as a benefit of the upgrade, not just a cost.
- New-warning count ~60 → **546** on the full scope; added the `noTsIgnore` / `tsSuppress`
  ratchet overlap.
- `biome-ignore` comments 208 → **58**; unused suppressions 1 → **8**.
- **Verified the `migrate --write` linter-kill trap still reproduces** on our config
  (`recommended: true` → `preset: "none"`).
- **Narrowed the glob trap:** `migrate --write` converts both override globs correctly. The
  trap applies only to hand-written v1-syntax overrides under a v2 schema.
- Rollout re-sequenced with an explicit "before the drain" rationale and a corrected estimate.

## Revision Notes (2026-08-22)

Corrections to the 2026-04-28 version:

- CI no longer has separate `lint` / `check:test-mocks` / `check:process-cwd` jobs; the
  "CI Contract Changes" high risk was written against that layout and is obsolete. One
  `check:all` step covers all of them.
- The pre-commit hook runs `typecheck` + `check:all`, not the individual gates.
- Target pinned to `2.5.10`; the original predates the 2.4/2.5 rule additions.
- Every risk that was qualitative ("may produce broad mechanical diffs", "may become
  stricter or looser") is now measured.
- Added the `migrate --write` linter-disabling finding, which the original missed and which
  outranks everything else in the document.
- `check:test-mocks`'s skip list quantified at 167 entries.
- Added the `includes` glob-syntax trap and the `test/`-scope figures.

## References

- Biome v2 upgrade guide: https://biomejs.dev/guides/upgrade-to-biome-v2/
- Biome linter plugins: https://biomejs.dev/linter/plugins/
- Biome configuration reference: https://biomejs.dev/reference/configuration/
