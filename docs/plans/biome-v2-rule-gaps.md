# Biome v2 rule gaps — what the repo could enable, measured

Audit of `biome.json` (Biome **2.5.10**, `recommended: true` + four explicit promotions +
two GritQL plugins) against the v2 catalog's off-by-default rules.
**Tier 1 was re-verified and then ADOPTED on 2026-08-28** — all seven rules are wired at
`error` in `biome.json`, all 17 sites are cleared, and the severities are pinned in
`test/unit/scripts/biome-test-severity.test.ts`. See *Adoption log*. Tiers 2–3 are untouched. Every count below was
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

## Tier 2 — worth enabling, small drain first

| Rule | Hits (src / test) | The drain |
|:--|:--|:--|
| `nursery/useExhaustiveSwitchCases` (`types` domain) | 1 / 0 | One non-exhaustive switch in `src/execution/pipeline-result-handler.ts`. Complements the repo's `never`-based exhaustiveness idiom where nobody wrote the `default: satisfies never` check. |
| `nursery/useAwaitThenable` (`types` domain) | 3 / 48 | `await` on a non-promise — usually a signature that stopped being async and callers never noticed. The 48 test hits are mostly harmless `await` on sync helpers; a mechanical sweep. |
| `suspicious/useArraySortCompare` | 10 / 50 | `.sort()` without a comparator sorts **lexicographically** — a real-bug class when the array holds numbers. Site-by-site read needed: string sorts are fine and get an explicit comparator only for the rule's sake. |

## Tier 3 — high alignment, but a real drain or a policy decision first

| Rule | Hits | What blocks it |
|:--|:--|:--|
| `suspicious/noEmptyBlockStatements` | 83 src / **1000** test | Directly targets the inert-test population STATUS §6 names ("`try {} catch {}` bodies outlive the refactors that invalidate them — precisely because they cannot fail"). But 1083 sites is a full drain of its own, and many are legitimate `.catch(() => {})` teardown — each needs the §8.13-style read, not a mechanical fix. If a drain is ever opened, this is the highest-value one left. |
| `suspicious/noConsole` | 753 src / 80 test | The structured-logging rule has no gate today. But the hits cluster in `src/cli` (209) and `src/commands` (78) — a CLI's user-facing output *is* console. Needs a policy decision first: either an override turning it off for the CLI/commands layers (gating the other ~470 src sites), or routing CLI output through one sanctioned writer. Do not enable repo-wide as-is. |
| `complexity/noExcessiveCognitiveComplexity` | 292 src / 21 test | Aligns with the ≤30-line function rule, but at the default threshold (15) it lands 313 findings. Enabling means either a long refactor drain or tuning `maxAllowedComplexity` upward until the count is a handful, then ratcheting the option down over time. |

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
