# PR 3 — Reconcile literal scope matching between attribution and selection

**Follow-up 8 (P2). Findings: H8, L5.**
**Base:** `origin/main` @ `6507cf061`. Independent of `fix/path-frame-p0-p1` — that branch does not touch `effectiveness.ts` or `static-rules.ts`.
**Branch:** `fix/effectiveness-literal-scope`

## The problem

PR #2099 fixed #2091 (suffix-anchored globs over-attributing to a same-named file in another package) by splitting literal patterns from glob patterns at `src/context/engine/effectiveness.ts:376-386`:

```ts
function pathMatchesScope(scopePaths: string[], filePath: string): boolean {
  const normalized = normalizePath(filePath);
  return scopePaths.some((pattern) => {
    const normalizedPattern = normalizePath(pattern);
    // Literal (no glob metacharacter): anchor exactly. The suffix-anchored
    // globToRegex would match a same-named file in another package (#2091).
    if (!SCOPE_GLOB_META.test(pattern)) return normalizedPattern === normalized;
    return globToRegex(normalizedPattern).test(normalized);
  });
}
```

The plan reasoned about **author-written globs** only. It did not account for literal `appliesTo` entries, which exist today. Verified — `.nax/rules/retry-strategy.md` declares:

```yaml
appliesTo:
  - "src/config/schemas-review.ts"
  - "src/session/session-keeper.ts"
```

No metacharacters. And `static-rules.ts:440` threads `section.appliesTo` through verbatim as `scopePaths`.

### Failure scenario

A per-package rule (`static-rules.ts` supports `packageRulesCount` at `:276`) whose `appliesTo` is a package-relative literal. The repo-framed diff path is `packages/api/src/session/session-keeper.ts`. The suffix-anchored `globToRegex` used to match it; `===` cannot. The chunk classifies `ignored`, which flows to `provider-weights.ts:109-110` → `clampWeight(1 - K * ignoredRatio)` → the `static-rules` provider decays toward `MIN_WEIGHT = 0.2` for the rest of the feature.

### The deeper inconsistency

The same `appliesTo` strings are matched by **two different matchers with different semantics**:

| Site | Purpose | Matcher |
|---|---|---|
| `static-rules.ts:174-176` `ruleMatchesScopeFiles` | rule **selection** | suffix-anchored `globToRegex` |
| `effectiveness.ts:376-386` `pathMatchesScope` | **attribution** | exact `===` for literals |

So a package-relative literal **admits the rule for selection and then denies it for attribution**. The rule is injected, the agent follows it, and the provider is penalised for it. PR #2099's "do not touch `static-rules.ts`" constraint (the file sits at exactly 600/600) meant this producer was never reconciled.

## ⚠️ Hard constraint

`src/context/engine/providers/static-rules.ts` is at **600/600**. `bun run check:file-sizes` fails on a single added line. If your fix needs logic there, extract to a new module and import it, or put the shared matcher in a utility both files import. Do not attempt to "just add a few lines".

`src/context/engine/effectiveness.ts` is at 486/600 — headroom.

## Steps

### 1. Reproduce (RED)

Two tests, both failing before the change:

1. **Attribution regression.** A chunk whose `scopePaths` is a package-relative literal (`src/session/session-keeper.ts`), a repo-framed diff path (`packages/api/src/session/session-keeper.ts`), asserting the chunk is attributed rather than `ignored`. Note the effectiveness suite currently has **no literal-`appliesTo` case at all** — every new case added by #2099 uses either a fully repo-rooted literal or a glob.
2. **Selector/attributor agreement.** Feed the same `appliesTo` string and the same repo-framed path to `ruleMatchesScopeFiles` and `pathMatchesScope` and assert they agree. This is the invariant; the first test is one instance of it.

Keep the #2091 positive control: a same-named file in a *different* package must still **not** be attributed. That is the defect the exact-match was introduced to fix and it must not regress. The existing suite has such a control — make sure it still passes.

### 2. Pick the reconciliation

Three shapes, in rough order of preference. Decide, and record the reasoning in the commit message.

- **(a) Frame the pattern, then compare exactly.** Re-spell a package-relative `appliesTo` literal into the repo frame before comparison, using the rule's owning package. This keeps exact anchoring (so #2091 stays fixed) and fixes the monorepo case properly. Needs the rule's package identity to reach the comparison — check what `static-rules.ts` already knows at `:276` and `:440`.
- **(b) One shared matcher.** Extract a single function used by both sites so they cannot drift again, with semantics chosen once. Attractive, but be careful: selection is deliberately permissive (`ruleMatchesScopeFiles` returns `true` when either list is empty) while attribution must be strict. Unifying the *path* comparison without unifying those empty-list policies is the safe subset.
- **(c) Anchored-suffix with a package-boundary guard.** Allow a suffix match only when the remaining prefix is a known package dir. Cheapest, but reintroduces a weaker form of #2091 — only take this if (a) and (b) are genuinely blocked, and say why.

Whichever you choose, the two matchers must not be able to disagree about the same string afterwards. Add a test that pins that.

### 3. Fix L5 while you are here

`effectiveness.ts:382` tests `SCOPE_GLOB_META` against the **raw** `pattern` but compares the **normalized** one:

```ts
if (!SCOPE_GLOB_META.test(pattern)) return normalizedPattern === normalized;
```

Harmless today — `normalizePath` introduces no metacharacters — but it is two different strings deciding one branch. Test the same string you compare. One-line change; no separate test needed, but do not bundle it into a commit message as if it were the main fix.

### 4. Gates

```
bun run typecheck && bun run lint && bun run test
bun run test:coverage
```

`bun run lint` includes `check:file-sizes` — that is your 600/600 guard. Paste all four.

## Done when

- [ ] A package-relative literal `appliesTo` attributes correctly against a repo-framed diff path.
- [ ] A test asserts `ruleMatchesScopeFiles` and `pathMatchesScope` agree on the same string.
- [ ] The #2091 control still holds: a same-named file in another package is still not attributed.
- [ ] `SCOPE_GLOB_META` tests the string it compares.
- [ ] `static-rules.ts` is still ≤ 600 lines (`check:file-sizes` green).
- [ ] All four gates pasted.

## Context worth knowing

- `scopeFiles` reaching `static-rules.ts` is repo-framed — `src/pipeline/scope-files.ts:42` applies `toRepoFrame`. That is the frame both matchers see, and it is correct.
- The `scopeFiles` field on `mechanical-{lint,format}fix-strategy.ts` is an unrelated same-named field. The `types.ts` docblock warns about this; do not conflate them.
- Persisted `chunkScopePaths` / `chunkEffectiveness` are gitignored and not rehydrated by `hydrateManifestPaths`, so no migration is needed for a semantics change here. This was confirmed during the review.

## PR body

```
fix(context): reconcile literal scope matching between selection and attribution

#2099 anchored literal scopePaths exactly to stop #2091's cross-package
over-attribution, but literal appliesTo entries exist today (see
.nax/rules/retry-strategy.md) and static-rules.ts threads them through as
scopePaths verbatim. In a monorepo the diff path is repo-framed and a
package-relative literal no longer matches, so the chunk classifies
ignored and the provider weight decays.

The two matchers also disagreed about the same strings:
ruleMatchesScopeFiles (selection) suffix-matches while pathMatchesScope
(attribution) required an exact match, so a rule could be admitted and
then penalised for being followed. Both now agree, and the #2091 control
-- a same-named file in another package -- still does not attribute.
```
