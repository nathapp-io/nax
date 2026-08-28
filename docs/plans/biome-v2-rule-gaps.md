# Biome v2 rule gaps — what the repo could enable, measured

Audit of `biome.json` (Biome **2.5.10**, `recommended: true` + four explicit promotions +
two GritQL plugins) against the v2 catalog's off-by-default rules.
**Tier 1 was re-verified and then ADOPTED on 2026-08-28** — all seven rules are wired at
`error` in `biome.json`, all 17 sites are cleared, and the severities are pinned in
`test/unit/scripts/biome-test-severity.test.ts`. **Tier 2 was ADOPTED the same day** — all
three rules at `error`, all 60 sites cleared, pinned in the same test. **Tier 3 was
RESOLVED the same day** — one rule adopted with an override list, one adopted as a ratchet,
one **rejected on measurement** and replaced by a GritQL plugin. See *Adoption log — Tier 3*.
Every count below was
**measured against this repo on 2026-08-27**, not estimated: a probe config with
`recommended: false` and only the candidate rules at `error`, run over `src/`, `bin/`,
`scripts/` and `test/` with the JSON reporter (`.nax/`, `examples/`, `dist/` excluded from
the counts). Method and traps at the bottom.

Severity note that applies to every recommendation: **enable at `"error"`, never `"warn"`**
— `biome check` exits 0 on warnings, the exact failure mode `noTsIgnore` shipped with
(STATUS-test-debt-drain §8.17) and the reason the drain's severity test asserts exit codes.

---

## Tier 1 — enable now: near-zero cost, direct alignment with existing repo rules

| Rule | Hits (src / test) | Why it belongs here |
|:--|:--|:--|
| `suspicious/noFloatingPromises` (nursery, `types` domain) | 2 / 1 | Un-awaited promises with no rejection handler — **candidate real bugs**: `src/execution/pid-registry.ts`, `src/pipeline/event-bus.ts`, `test/unit/execution/post-run-inspection.test.ts`. In crash-handling and event-dispatch code an ignored rejection is an invisible failure. |
| `suspicious/noMisusedPromises` (nursery, `types` domain) | 6 / 1 | Promises used where a plain value is expected (conditions, void callbacks): `src/agents/acp/adapter-lifecycle.ts`, `spawn-client-process.ts`, `src/interaction/plugins/telegram.ts`, `webhook.ts`, `src/runtime/middleware/idle-watchdog.ts`, `scripts/run-tests.ts`, `test/unit/helpers/fake-clock.test.ts`. A promise in a boolean position is always truthy — same defect class. |
| `suspicious/noSkippedTests` | 0 / 1 | STATUS §4 already forbids `.skip` for the drain; this makes it a parser-backed gate repo-wide. The one existing hit is `test/integration/execution/execution.test.ts:269` (`test.skip("completes when all stories are done")`) — triage it (fix or delete, with its own evidence) before enabling. |
| `suspicious/noEvolvingTypes` | 1 / 2 | `let` with no annotation whose type "evolves" — the implicit-`any` cousin `noExplicitAny` cannot see. Three sites total. |
| `style/useThrowOnlyError` | 0 / 2 | Throwing non-`Error` values breaks the NaxError cause-chaining discipline (`.claude/rules/error-handling.md`) and the new `assertNaxError`-family helpers, which describe what was actually caught. Two sites. |
| `suspicious/useErrorMessage` | 0 / 1 | `new Error()` with no message. One site. |
| `suspicious/noDuplicateTestHooks` | 0 / 0 | Free — pure regression guard for duplicated `beforeEach`/`afterEach`. |

The two promise rules are **nursery** and need the `types` domain (see *Enabling the
type-aware rules* below) — the trade-off is theirs alone; the other five are stable and
one-line enables.

## Tier 2 — worth enabling, small drain first — **ADOPTED 2026-08-28**

| Rule | Hits (src / test) | The drain |
|:--|:--|:--|
| `nursery/useExhaustiveSwitchCases` (`types` domain) | 1 / 0 | One non-exhaustive switch in `src/execution/pipeline-result-handler.ts`. Complements the repo's `never`-based exhaustiveness idiom where nobody wrote the `default: satisfies never` check. |
| `nursery/useAwaitThenable` (`types` domain) | 3 / 48 | `await` on a non-promise — usually a signature that stopped being async and callers never noticed. The 48 test hits are mostly harmless `await` on sync helpers; a mechanical sweep. |
| `suspicious/useArraySortCompare` | 10 / 50 | `.sort()` without a comparator sorts **lexicographically** — a real-bug class when the array holds numbers. Site-by-site read needed: string sorts are fine and get an explicit comparator only for the rule's sake. |

## Tier 3 — high alignment, but a real drain or a policy decision first — **RESOLVED 2026-08-28**

> **Read the Tier 3 adoption log before trusting this table.** Two of its three
> "what blocks it" claims did not survive measurement: `noConsole` has **zero** real
> violations in the repo, and `noEmptyBlockStatements` reaches the inert-catch population
> it names in **10 of 1087** sites.

| Rule | Hits | What blocks it |
|:--|:--|:--|
| `suspicious/noEmptyBlockStatements` | 83 src / **1000** test | Directly targets the inert-test population STATUS §6 names ("`try {} catch {}` bodies outlive the refactors that invalidate them — precisely because they cannot fail"). But 1083 sites is a full drain of its own, and many are legitimate `.catch(() => {})` teardown — each needs the §8.13-style read, not a mechanical fix. If a drain is ever opened, this is the highest-value one left. |
| `suspicious/noConsole` | 753 src / 80 test | The structured-logging rule has no gate today. But the hits cluster in `src/cli` (209) and `src/commands` (78) — a CLI's user-facing output *is* console. Needs a policy decision first: either an override turning it off for the CLI/commands layers (gating the other ~470 src sites), or routing CLI output through one sanctioned writer. Do not enable repo-wide as-is. |
| `complexity/noExcessiveCognitiveComplexity` | 292 src / 21 test | Aligns with the ≤30-line function rule, but at the default threshold (15) it lands 313 findings. Enabling means either a long refactor drain or tuning `maxAllowedComplexity` upward until the count is a handful, then ratcheting the option down over time. |

## Tier 4 — evaluated, not adopted: overlaps an existing hand-rolled ratchet

This document never evaluated `suspicious/noImportCycles`. It should have: the repo already
runs `scripts/check-import-cycles.ts` as a `check:import-cycles` ratchet over the same
shape (import cycles in `src/`), so a Biome rule covering the same ground is exactly the
kind of gap this doc exists to catch. It was probed and is **not recommended for
adoption**, for reasons measured below, not assumed.

| Rule | Hits | What blocks it |
|:--|:--|:--|
| `suspicious/noImportCycles` (`project` domain, shipped since 2.0.0, default `warn`) | 399 diagnostics / **151** distinct `src/` files | Biome has **no baseline or ratchet mechanism** for any rule — a rule is `error` or it is not — so enabling this at `error` is a same-day 399-finding drain, not a config change, with no way to land it today and lower the count over time the way `check:import-cycles`'s baseline file does. |

Confirmed with `bun x biome explain noImportCycles`: default severity `warn`, `project`
domain, available since 2.0.0. Measured against this repo with a probe `biome.json`
(`domains.project: "all"`, `suspicious.noImportCycles: "error"`, otherwise the repo's real
config) run as `./node_modules/.bin/biome check src/ --reporter=json --max-diagnostics=5000`
— **399 diagnostics across 151 distinct files**, reproducing the number this entry was
opened with exactly. The probe edit was reverted immediately after and `git status`
confirmed clean before anything else ran.

### Does it subsume `check:import-cycles`? No — verified, not assumed

`scripts/check-import-cycles.ts`'s header states the check counts **modules inside a
strongly-connected component** (Tarjan's SCC algorithm, run over `src/` only) and
**deliberately excludes type-only imports**, because TypeScript erases them and they cannot
participate in a runtime module-init cycle. Two things had to be checked before treating
Biome's rule as equivalent:

- **Type-only exclusion: matches, verified with a fixture.** Biome's own `ignoreTypes`
  option (enabled by default) makes the same exclusion for the same reason. Built a
  two-file fixture — `a.ts` and `b.ts`, each importing the other with a pure `import type`
  — and ran it through the repo's pinned `./node_modules/.bin/biome` (2.5.10): **zero
  diagnostics**, exit 0. The same two files rewritten as plain value imports (`import { useB
  } from "./b.ts"` etc.) fired the rule immediately, confirming the fixture and the binary
  both work and the type-only case is a genuine exclusion, not a false negative from a
  broken probe. Neither tool excludes *mixed* named-type imports
  (`import { type Foo, bar }`) — the repo's regex only recognizes a whole-statement `import
  type` prelude, and Biome's own docs note the same shape isn't type-only-safe without
  `verbatimModuleSyntax` (which this repo does not set) — so the two tools agree on both the
  excluded and the non-excluded case.
- **Membership overlap is high but not total, and the counting unit is different.**
  Comparing the probe's 151 flagged files against the ratchet baseline's 135: **134 of the
  135 ratchet modules are also flagged by Biome.** The one exception,
  `src/review/semantic.ts`, is a file that imports itself
  (`src/review/semantic.ts -> src/review/semantic.ts` per `check-import-cycles.ts --list`)
  — Biome's own rule doc states self-imports are explicitly allowed and never trigger the
  rule ("this allows for encapsulation of functions/variables into a namespace"), while the
  repo's Tarjan pass counts a self-loop as a one-module cycle. That is a real, documented
  semantic difference, not noise. The other direction — **17 files Biome flags that the
  ratchet does not** — was not fully traced; the likely cause is that Biome resolves
  imports through real TypeScript module resolution while the repo's script resolves
  specifiers with a small hand-rolled function (`@/` prefix and relative paths only), so a
  resolution edge Biome sees and the script's resolver misses would under-count on the
  ratchet's side rather than over-count on Biome's. Not verified further; flagged here so a
  future reader does not assume the 17 are Biome noise. **Separately, the two report in
  different units entirely** — Biome emits one diagnostic per cycle-participating `import`
  statement (399), the ratchet counts distinct modules inside a component (135) — so even
  where the file sets matched exactly, the headline numbers would not.

### Recommendation: do not adopt, keep `check:import-cycles`

Per `.nax/rules/test-ratchets.md`'s *What biome gates instead* principle — prefer the
parser over a text counter, pin severity at `error` because `biome check` exits 0 on
warnings, and treat a rule that has never been seen to fail as not known to be wired — the
abstract case for `noImportCycles` is real: it is a parser-backed check, not a regex, and
this entry mutation-probed it (the plain-import fixture above) so it is known to fire.
But the practical case fails on the two things a gate needs and Biome's rule does not have:

1. **No ratchet.** `check:import-cycles` exists specifically because the repo carries a
   live, non-zero count (currently 135) that is being brought down over time via
   `--update-baseline`. `noImportCycles` at `error` has no equivalent — day one is a
   399-finding hard failure with no lever to land it and improve later, which is the same
   trap Tier 3's `noExcessiveCognitiveComplexity` avoided by ratcheting `maxAllowedComplexity`
   instead of accepting the rule's fixed threshold.
2. **It is not a strict superset.** The self-import exemption means Biome would report a
   *smaller* module set than the ratchet already covers for at least one real repo file,
   so swapping the ratchet out for the Biome rule would be a silent coverage loss, not a
   like-for-like replacement.

Both tools should keep running: `check:import-cycles` as the gate with a working baseline,
and `noImportCycles` left off. If Biome ever ships a baseline/ratchet option for this rule,
or the self-import exemption is made configurable, re-measure — the file-set overlap (134 of
135) is close enough that the gap is a mechanism problem, not a relevance problem.

## Considered and rejected — measured, and the noise verdict stands

| Rule | Hits | Why not |
|:--|:--|:--|
| `suspicious/useAwait` | 126 src / **2084** test | The test population is overwhelmingly `async () => ({...})` mock stubs — async **by contract** to satisfy a promise-returning dep slot, with nothing to await. Flagging them invites `await Promise.resolve()` noise or, worse, de-asyncing stubs out of interface conformance. |
| `performance/useTopLevelRegex` | 291 src / 566 test | Micro-optimization; no measured hot path justifies 850+ edits. |
| `style/noNegationElse` | 167 src / 40 test | Pure style churn. |
| `suspicious/noUnnecessaryConditions` (`types` domain) | 236 src / 253 test | Fires on defensive checks the repo keeps deliberately (e.g. guards over `.default()`-filled config where the schema, not the type, guarantees presence). Too many judgment calls per hit. |
| `style/useNamingConvention`, `style/noDefaultExport` | not probed | Convention-heavy; the repo's conventions live in `.nax/rules/` and reviews, and the expected churn dwarfs the payoff. |
| `performance/noBarrelFile` / `noReExportAll` | not probed | The repo's import convention is barrels, on purpose (`.claude/rules/project-conventions.md`). Directly contradicts it. |

## Enabling the type-aware rules (`types` domain)

The three nursery rules in Tiers 1–2 need both the domain and the explicit rule entry:

Use `"types": "recommended"`, **not** `"all"` — see the domain trap below.

```jsonc
{
  "linter": {
    "domains": { "types": "recommended" },
    "rules": {
      "nursery": {
        "noFloatingPromises": "error",
        "noMisusedPromises": "error",
        "useExhaustiveSwitchCases": "error"
      }
    }
  }
}
```

**The domain trap — `"all"` silently enables the rules this doc rejected.** Three switches
act independently: `rules.recommended` covers the recommended subset of the *non-domain*
rules and does **not** reach into a domain; `domains.<name>` (`none` / `recommended` /
`all`) gates that domain separately; an **explicit rule entry is honoured regardless of
either** — which is why the nursery rules above fire under `"recommended"` even though
nursery is not recommended. So `"types": "all"` does not mean "the listed rules"; it means
every rule in the domain. Applied verbatim on top of this repo's config it lands
**549 unintended findings**:

| Rule | Baseline | With `types: "all"` | |
|:--|--:|--:|:--|
| `nursery/noFloatingPromises` | 0 | 3 | wanted |
| `nursery/noMisusedPromises` | 0 | 7 | wanted |
| `suspicious/noUnnecessaryConditions` | 0 | **489** | *Considered and rejected*, above |
| `suspicious/useArraySortCompare` | 0 | **60** | Tier 2 — drain not done |

`"types": "recommended"` honours every explicitly listed nursery rule and adds **nothing
else** — verified: with all three entries above it reports `noFloatingPromises` 3,
`noMisusedPromises` 7, `useExhaustiveSwitchCases` 1, and with just the two Tier 1 rules the
full category diff against baseline is 304 → 314 findings with no third category. It is also
byte-identical in output to `"types": "all"` with the noisy pair set to `"off"` — same
result, no suppressions to maintain, and it will not silently absorb whatever Biome adds to
the `types` domain in a future 2.x.

Costs to accept, on the record:

- **Nursery means unstable**: not covered by semver, may change or be renamed in a minor.
  Pin biome (already pinned at 2.5.10) and re-check on upgrades.
- **Type inference costs lint time — 3x on the biome step.** Re-measured 2026-08-28 as
  `bun run lint` actually invokes it (`biome check src/ bin/ test/`): **1.08s -> 3.27s wall**
  (9s -> 15s CPU). Small in absolute terms, but it is not free, and it scales with the
  project graph rather than with the number of enabled rules.
- **A trap that produced a false zero during this audit**: with `--config-path` pointing at
  a directory *outside* the project tree, the type-aware rules silently report **nothing**
  (the project scanner does not run) — zero diagnostics with exit 0, indistinguishable from
  a clean repo. The probe recipe in STATUS §0.1 is therefore wrong for `types`-domain rules:
  the config must sit at the project root. Same family as §8.15's empty-stdout plugin-path
  trap. Any severity test pinning these rules must plant a fixture and see it fail
  (STATUS §6: a rule that has never been seen to fail is not known to be wired).

## Method

Probe configs with `recommended: false` and only candidates at `error`; counts from
`--reporter=json --max-diagnostics=50000` filtered to repo directories in python (the
human reporter truncates at 20 — STATUS §0.1). Stable rules probed via `--config-path`
into the scratchpad; type-aware rules required swapping the repo `biome.json` for the
probe and restoring it byte-identically (verified with `git diff`) because of the scanner
trap above. `noFloatingPromises` was mutation-probed against a planted floating promise
before its repo reading was trusted.

Two scope facts the counts depend on:

- **The `src` column bundles `src/` + `bin/` + `scripts/`.** That matters for adoption:
  `bun run lint` checks `src/ bin/ test/` only, so the `scripts/run-tests.ts` hit under
  `noMisusedPromises` is counted here but would **not** be gated by the lint script.
- **None of the seven Tier 1 rules is in the `recommended` set.** Verified by layering each
  on top of the repo's real config (`recommended: true`) rather than only probing with
  `recommended: false`: every rule moves off zero, so the table is a true delta and not a
  re-count of coverage the repo already has.

## Adoption log

**2026-08-28, Biome 2.5.10, clean tree.** Re-ran every Tier 1 probe. Findings:

- **All seven hit counts reproduce exactly**, as do every file named in the Tier 1 table.
- `noDuplicateTestHooks` (0 / 0) was **mutation-probed** with a planted duplicate
  `beforeEach` — it fires and exits 1, so the zero is real coverage, not a false zero of the
  kind the `--config-path` trap produces. (That fixture is also the only way to tell: a
  0-hit rule is invisible to a baseline diff.)
- **Corrected:** the enabling snippet (`types: "all"` -> `"recommended"`, 549 unintended
  findings); the lint-time claim (measured 3x, was "well under budget"); `noUnnecessaryConditions` drifted 493 -> 489 since the
  original audit, so treat all Tier 2/3 counts as approximate to within a few percent.
- **Noted, out of scope for this doc:** `bun run lint` reports 234 warnings and 22 infos and
  **exits 0** — the same severity failure mode the note at the top warns about. The
  `error`-severity findings it does not see live in `scripts/`, outside the lint script's paths.

### What adoption changed, and two claims it corrected

All seven rules are at `error` in `biome.json` with `linter.domains.types: "recommended"`.
`bun run lint`, `bun run typecheck` and `bun run test` (15,475 tests) are green. Clearing the
17 sites showed **two of the Tier 1 justifications above were wrong about what the hits are**:

- **`noMisusedPromises` found no defects.** The table calls these "the same defect class" as a
  promise in a boolean position. All 7 are the *nullable-promise presence* idiom — `if
  (this.poller)`, `abortPromise ? [abortPromise] : []` — where the variable is
  `Promise<T> | null`, so the truthiness test is asking "is one pending?" and is correct.
  Fixed to explicit `!== null` / `!== undefined`: clearer, but a readability change, not a
  bug fix. The rule still earns its place — it would catch the real defect in new code — but
  it should not have been sold as finding live bugs.
- **`useThrowOnlyError`'s two sites are load-bearing fixtures, not violations.** Both are
  deliberate non-`Error` throws in tests that assert the non-`Error` path
  (`contestant.test.ts` is literally *"US-002 AC8 (boundary): non-Error throws are stringified"*).
  "Fixing" either would delete the coverage. They carry a `biome-ignore` with a reason. Cost
  is 2 suppressions, not 2 fixes. A third suppression went to `fake-clock.test.ts`, whose
  async callback in a `() => void` slot is the very thing that test exercises.

Two further things surfaced only by doing it:

- **The skipped test was neither flaky nor caused by what its comment claimed.** The skip
  blamed the acceptance loop, which the test's own config already disables. Un-skipped it
  failed **5/5 deterministically** on one assertion: `iterations` is read straight off the
  unified executor, which runs zero iterations when no story is pending, so a pre-completed
  PRD yields 0, not the 1 the test expected. Assertion corrected to pin real behaviour.
- **Fixing one rule's site revealed another's.** Making the `spawn-client-process.ts` ternary
  explicit sharpened the inferred type enough for `noFloatingPromises` to see a genuine
  floating `raced.then(...)` one line below — invisible while the ternary was truthiness-based.
  Expect a second pass when adopting type-aware rules; the first fix changes what the next
  one can infer.

If Tier 1 is adopted, wire the new severities into
`test/unit/scripts/biome-test-severity.test.ts` (assert diagnostic **and exit code**) and
record the change in `.nax/rules/test-ratchets.md`'s *What biome gates instead* table —
that test is the backstop that keeps a future config edit from silently landing a rule at
`warn`.

---

## Adoption log — Tier 2

**2026-08-28, Biome 2.5.10, immediately after Tier 1.** All three rules are at `error` in
`biome.json` (`useArraySortCompare` under `suspicious`; `useAwaitThenable` and
`useExhaustiveSwitchCases` under `nursery`, both riding the `types` domain Tier 1 already
turned on). `bun run lint`, `bun run typecheck` and `bun run test` (15,506 tests) are green.

**All three hit counts reproduce exactly** — 1/0, 3/48, 10/50.

### What the drain actually found

- **`useExhaustiveSwitchCases` found no bug, but a dead union member.** The one site,
  `handlePipelineFailure` in `src/execution/pipeline-result-handler.ts`, is missing
  `"complete"` and `"decomposed"`. Neither is reachable: the function is entered only when
  `pipelineResult.success` is false (`iteration-runner.ts`), `"complete"` is the sole action
  the pipeline pairs with success — and **no stage anywhere produces `finalAction:
  "decomposed"`**, though the union declares it. Both are now listed as explicit no-op arms
  with that reasoning; retiring the dead member is a separate change.
- **`useAwaitThenable` found 49 real redundant awaits and 2 false positives.** 47 are in
  `test/` — `await` on helpers that are plainly synchronous (`makeTempDir`,
  `cleanupTempDir`, `makeTestRuntime`, `initLogger`, `parseDiagnostics`, one local
  `makeCtx`) — and 2 in `src/`, both `await deriveProviderWeights(...)`, which is a plain
  synchronous function. Each callee's signature was read before the `await` came off; none
  returns a promise.
- **`useArraySortCompare` found zero bugs.** 58 of the 60 sites sort a `string[]`, where the
  default lexicographic order is exactly the intended one. The two that are not strings are
  both in tests and both worked only by coincidence: a `number[]` whose values happened to be
  `0,1,2`, and a `boolean[]` relying on `"false" < "true"`. The rule still earns its place —
  it would catch the real defect in new code — but the table's "real-bug class" framing
  described the risk, not this repo.

### Two things only doing it surfaced

- **Biome 2.5.10 cannot infer through `<function-type alias> | undefined`.** Two of the
  three "src" `useAwaitThenable` hits were false positives on exactly that shape — a
  promise-returning function held in an optional dependency slot, which is the repo's
  standard `_deps` idiom. Reduced to a minimal repro: with
  `type F = (a: string) => Promise<number>`, a `private _a: F | undefined` flags at
  `await this._a(...)`, while the *same property written with an inline function type*
  (`private _b: ((a: string) => Promise<number>) | undefined`) and a *non-optional*
  `private _c: F` both pass. `private _d?: F` fails too — it is the union with the alias,
  not the optionality syntax. Binding to an un-annotated local does not help; binding to a
  local **annotated non-optional after the guard** does. So `src/agents/manager.ts` needed
  no suppression: `SendPromptFn` moved to `manager-types.ts` (beside `SessionRunHopFn`,
  where it belonged) and `runAsSession` binds `const sendPrompt: SendPromptFn =
  this._sendPrompt` after its existing guard. `test/helpers/mock-agent-manager.ts` carries
  the one `biome-ignore`, with the repro in the comment. **Expect more of these** as more
  `_deps` slots are read; the rule's cost here is not the sweep, it is this shape.
- **The severity-test fixture for `useArraySortCompare` is not the obvious one.**
  `[3, 1, 2].sort()` reports **nothing** under the repo config — the rule wants an element
  type it can resolve from an annotation, so the fixture is
  `function f(xs: string[]) { return xs.sort(); }`. A test written the obvious way would
  have failed at authoring time; one written the obvious way *and* asserting only "no crash"
  would have pinned nothing. Same family as the Tier 1 `noDuplicateTestHooks` lesson: a rule
  that has never been seen to fail is not known to be wired.

### Costs, on the record

- **`src/utils/sort.ts` is new** — `byCodePoint` and `byNumber`. 60 sites needed *some*
  comparator, and the code-point idiom was already open-coded in `src/context/engine/digest.ts`
  and `providers/static-rules.ts` under the CTX-5 comment; this is that SSOT. `byCodePoint` is
  byte-identical to what a bare `.sort()` already did on a `string[]`, so no ordering changed.
- **Three grandfathered files could not absorb the import line.** `check:file-sizes` forbids
  any growth in a file already over the limit, and a new `import` is growth.
  `runner-plan.test.ts` and `acceptance-loop-cycle.test.ts` therefore use an inline
  comparator instead of the helper — deliberate inconsistency, not an oversight.
  `src/agents/manager.ts` came out 4 lines *shorter* because the `SendPromptFn` move was
  the fix anyway.
- **Lint time did not move.** 3.27s (Tier 1) -> **3.4s** wall on `biome check src/ bin/ test/`.
  The `types` domain was already paid for; two more type-aware rules are marginal. The 3x
  step cost recorded under Tier 1 stands as the whole price of type-aware linting here.
- **1 suppression** (`mock-agent-manager.ts`), against Tier 1's 3.

### Not done

`scripts/` is outside `bun run lint`'s paths, so its 4 `useArraySortCompare` sites were
fixed for correctness but are **not gated**. Tier 3 is untouched.

---

## Adoption log — Tier 3

**2026-08-28, Biome 2.5.10, immediately after Tier 2.** All three counts reproduce (1087,
753/80, 314 — the table said 1083, 753/80, 313). `bun run lint`, `bun run typecheck` and
`bun run test` (15,515 tests) are green.

The outcome is **not** the one this table predicted. Two of its three blocking claims were
wrong, and measuring them first is what made Tier 3 a day's work instead of a quarter's.

### `noConsole` — ADOPTED at `error`, zero code changes

The table says the hits "cluster in `src/cli` (209) and `src/commands` (78)" and that an
override would leave "the other ~470 src sites" to gate. **Every one of those ~470 was read.
None is a violation of the structured-logging rule.** The `src` column bundles `bin/` (151,
the CLI entry point) and `scripts/` (292, outside `bun run lint`'s paths entirely). What is
left in `src/` proper is 23 sites in exactly three places:

| Site | What it is |
|:--|:--|
| `src/execution/lifecycle/headless-formatter.ts` (12) | the headless run banner and summary — its entire job is terminal output |
| `src/precheck/index.ts` (10) | the precheck report, human and `--json` |
| `src/logger/logger.ts` (1) | the logger's own console sink — the sanctioned writer itself |

The test side is the same story: **74 of the 80** hits are `originalLog = console.log`
spies, which is how the CLI tests capture output. The rule fires on any `console` member
reference, saving it included.

So the rule gates nothing that exists and everything written tomorrow. It is wired at
`error` with an override turning it `off` for the layers whose job *is* output — `bin/**`,
`scripts/**`, `src/cli/**`, `src/commands/**`, and the three files above — plus `test/**`.
**The override list is the whole rule**, so that is what
`biome-test-severity.test.ts` pins: one case proving a `console.log` in an ordinary `src/`
module fails, one proving each listed layer stays silent. A glob that drifts one directory
wide gives the gate up without a single test going red.

The table's second option — "routing CLI output through one sanctioned writer" — is not
needed and would be a large refactor for no measured defect.

### `noExcessiveCognitiveComplexity` — ADOPTED as a ratchet at `maxAllowedComplexity: 176`

314 findings at biome's default of 15; max 176, median 22. The worst are core orchestration:
`unified-executor.ts` (176), `prd/schema.ts` (164), `agents/acp/parser.ts` (145),
`execution/post-run.ts` (113), `bin/nax.ts` (111). Refactoring those is a different project
with a different risk profile, and the table's "tune upward until the count is a handful"
lands on 10 findings at 80 — still ten core-path refactors.

Set instead to **176, the current ceiling**: zero findings today, zero code change, and any
new function worse than today's worst hard-fails. `maxAllowedComplexity` is itself the
ratchet — one number, lowered in later PRs as functions get refactored, with no baseline
file to maintain. Verified to bite: a synthetic 200-complexity function reports
`Excessive complexity of 200 detected (max: 176)` and exits 1.

Findings remaining at each threshold, for whoever lowers it:

| max | 30 | 50 | 80 | 100 | 120 | 150 |
|:--|--:|--:|--:|--:|--:|--:|
| findings | 84 | 31 | 10 | 5 | 3 | 2 |

### `noEmptyBlockStatements` — REJECTED, replaced by `biome-plugins/no-empty-catch.grit`

The table calls this "the highest-value drain left" and says it "directly targets the
inert-test population STATUS §6 names". **It does not.** Of its 1087 sites:

| Shape | Count |
|:--|--:|
| no-op arrow (`markUnavailable: () => {}`) | 1001 |
| empty function body (`async close() {}`) | 74 |
| **empty `catch`** | **10** |
| other | 2 |

The 1075 stubs are the `test/helpers/` mock-factory idiom that
`.claude/rules/test-helpers.md` **mandates**. Adopting the rule would mean a 1087-site drain
fighting the repo's own convention to reach 10 real sites. Rejected.

The 10 were fixed anyway, and one was live coverage loss:
`prompts-export.test.ts` had `expect(true).toBe(false)` *inside* the `try`, so the empty
catch swallowed that assertion's own failure — the "it must throw" half could never fail.
Replaced with `await expect(...).rejects.toThrow(...)` and mutation-probed: the assertion
now fails when broken, which the swallowed version never could. The other nine were a
logger-guard (given a body saying why nothing can be reported), a silently-swallowed
interaction-bridge construction failure in `plan/strategies/context-builder.ts` (now logged),
six test try/catches replaced by `await p.catch(() => {})`, and one temp-dir teardown.

The shape *is* worth gating, so it now has a GritQL plugin — the third, after
`no-as-never.grit` and `no-absent-value.grit`.

**A comment in the body satisfies it, deliberately.** That is what biome's own rule allows,
and 204 of the repo's 214 empty catches already carry a reason
(`catch { // process may have already exited }`). Demanding a statement instead would have
been 204 edits that make the code worse. Since comments are trivia in biome's CST, the
structural pattern alone flags all 214; a regex on the matched node's **source text**
restores the distinction.

**The trap that regex introduces, and why the plugin test guards it.** GritQL reads a regex
capture group as a variable binding. Write `(\([^)]*\))?` instead of `(?:\([^)]*\))?` and
biome reports `p1 errored: regex pattern matched 1 variables, but expected 0` — at **info**
severity, **exit 0**, indistinguishable from a clean run. The plugin sat silently disarmed
until that was spotted. `biome-no-empty-catch-plugin.test.ts` therefore asserts the plugin
emits no `errored` diagnostic on a clean file, alongside the fixtures that must fail. Same
family as §8.15's empty-stdout plugin-path trap and the `--config-path` false zero above.

### The through-line for Tier 3

Every one of the three entries was blocked on a claim about the hit population, and in two
of three the claim was wrong in the direction of "this is a huge drain". Reading the hits
cost about an hour and turned a quarter of work into a day. **Measure the population before
accepting a drain estimate**, including one written in this document.

