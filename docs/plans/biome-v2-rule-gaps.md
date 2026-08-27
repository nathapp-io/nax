# Biome v2 rule gaps — what the repo could enable, measured

Audit of `biome.json` (Biome **2.5.10**, `recommended: true` + four explicit promotions +
two GritQL plugins) against the v2 catalog's off-by-default rules. Every count below was
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
| `suspicious/noUnnecessaryConditions` (`types` domain) | 237 src / 256 test | Fires on defensive checks the repo keeps deliberately (e.g. guards over `.default()`-filled config where the schema, not the type, guarantees presence). Too many judgment calls per hit. |
| `style/useNamingConvention`, `style/noDefaultExport` | not probed | Convention-heavy; the repo's conventions live in `.nax/rules/` and reviews, and the expected churn dwarfs the payoff. |
| `performance/noBarrelFile` / `noReExportAll` | not probed | The repo's import convention is barrels, on purpose (`.claude/rules/project-conventions.md`). Directly contradicts it. |

## Enabling the type-aware rules (`types` domain)

The three nursery rules in Tiers 1–2 need both the domain and the explicit rule entry:

```jsonc
{
  "linter": {
    "domains": { "types": "all" },
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

Costs to accept, on the record:

- **Nursery means unstable**: not covered by semver, may change or be renamed in a minor.
  Pin biome (already pinned at 2.5.10) and re-check on upgrades.
- **Type inference costs lint time.** Measured on this repo: the full type-aware probe over
  `src` + `test` + `bin` + `scripts` completed in well under the existing lint budget, but
  re-measure once wired into `bun run lint` before treating it as free.
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

If Tier 1 is adopted, wire the new severities into
`test/unit/scripts/biome-test-severity.test.ts` (assert diagnostic **and exit code**) and
record the change in `.nax/rules/test-ratchets.md`'s *What biome gates instead* table —
that test is the backstop that keeps a future config edit from silently landing a rule at
`warn`.
