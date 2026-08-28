# `check:*` Gate Retirement Sweep — What Stays, and Why

Date: 2026-08-28
Measured against: `cf59a1c24` (branch `chore/retire-redundant-gates`), Biome `2.5.10`, Bun `1.4.0`.

## Why this document exists

After the #1514 typecheck drain (test/ typecheck became a hard 0-error gate) and the
Biome v2 Tier 1-3 adoptions (#1749/#1750/#1751), every hand-rolled `check:*` gate was
re-examined for redundancy. Five were retired. **This document records the ones that were
NOT retired, and the specific measurement behind each ruling**, so a future sweep can
re-check the ruling instead of re-deriving it — or overturn it when the measurement moves.

A "not removable" ruling here is a statement about a *measurement on a specific date*,
not a permanent property. `.nax/rules/test-ratchets.md` states the governing principle:
prefer a parser over a text counter, and never keep a counter for a shape Biome already
parses. Everything below is a case where that principle does not yet apply — usually
because Biome's rule is not equivalent, or because adopting it is a drain with no lever
to land it.

Related, read first: `docs/findings/biome-migration-risk.md` (the v1→v2 migration
assessment, which already ruled on `check:process-cwd` and `check:test-mocks`) and
`docs/plans/biome-v2-rule-gaps.md` (the tiered rule-adoption plan, including the Tier 4
`noImportCycles` entry this sweep added).

## READ THIS BEFORE RE-MEASURING — the trap that produced a wrong answer

`biome check` **truncates displayed diagnostics at 20 by default**, and this repo already
emits ~237 warnings from `src/`. A bare `biome check ... | grep -c '<rule>'` therefore
counts a truncated stream and **silently under-reports**.

During this sweep that produced a confidently-stated "0 findings repo-wide" for
`noRestrictedImports` when the true count was 6. The error was caught only because a
reviewer re-ran it. The output does say `Diagnostics not shown: 236`, but it says it
*after* the diagnostics, where a `grep -c` never looks.

Always measure with **both** of:

```bash
./node_modules/.bin/biome check <paths> --reporter=json --max-diagnostics=5000
```

and count from the JSON `diagnostics[].category`, not from grep on human output.

## Rulings

### `check:import-cycles` — KEEP. Biome is not a superset, and adopting is a 399-finding drain.

Biome ships `lint/suspicious/noImportCycles` (since 2.0.0, `project` domain, default `warn`).

| Measurement | Value on 2026-08-28 |
|:--|:--|
| Biome `noImportCycles` diagnostics, `src/` | **399** |
| Distinct `src/` files flagged | **151** |
| `check:import-cycles` ratchet reading | **135 modules** (baseline 135) |
| Ratchet modules also flagged by Biome | 134 / 135 |

Two independent blockers:

1. **No baseline mechanism.** Biome has no ratchet. Adopting at `error` (the only severity
   this repo accepts — `biome check` exits 0 on warnings) means draining 399 findings in
   one go. The hand-rolled gate exists precisely because that backlog is real and is being
   held flat rather than fixed.
2. **Not a strict superset.** Biome *exempts self-imports* by design ("allows encapsulation
   of functions/variables into a namespace"). `src/review/semantic.ts` self-loops, and the
   repo's Tarjan pass counts a self-loop as a cycle. Verify with:
   `bun run scripts/check-import-cycles.ts --list | grep semantic.ts`
   → `src/review/semantic.ts -> src/review/semantic.ts`. Adopting Biome would silently stop
   counting that module.

**Where they agree:** both exclude type-only imports. Verified with a two-file pure
`import type` cycle — zero Biome diagnostics; the same fixture rewritten with value imports
fires immediately. Neither tool excludes mixed named-type imports (`import { type Foo, bar }`).

**Re-check when:** Biome gains a baseline/suppression-budget mechanism, OR the 399 count
drops near zero through unrelated refactoring, OR the self-import exemption becomes
configurable.

### `check:test-escape-hatches` — KEEP. `noTsIgnore` covers one of its three directives.

The counter tracks three shapes; only one has a parser behind it.

| Counter | Reading | Biome coverage |
|:--|:--|:--|
| `tsSuppress` (`@ts-expect-error`, `@ts-ignore`, `@ts-nocheck`) | 0 | **Partial only** |
| `ratchetAllow` (`test-ratchet-allow:` markers) | 25 | None — comment shape |
| `looseCast` (single `as T`) | 1623 | None |

`bun x biome explain noTsIgnore` is explicit: it prevents `@ts-ignore` **only**, and
actively *promotes* `@ts-expect-error` as the recommended alternative. So `tsSuppress`
remains the sole gate for `@ts-expect-error` and `@ts-nocheck` — the two directives a
0-error typecheck gate makes most attractive.

`ratchetAllow` and `tsSuppress` are comment shapes, and comments are **trivia** in Biome's
CST: `comment()` / `js_comment()` do not compile as GritQL patterns, so no plugin can
replace them. This is a structural limit, not a missing feature.

`looseCast` at 1623 is **not a drain target** and its size is not evidence of neglect.
`TS2352` tells you to "convert the expression to `unknown` first", so a hard typecheck gate
pushes debt toward single casts; this counter is what makes that visible. Per
`.nax/rules/test-ratchets.md`, it is the last remaining trade against the typecheck gate,
which makes it *more* necessary now, not less.

**Re-check when:** GritQL gains comment matching, or Biome ships a rule covering
`@ts-expect-error` / `@ts-nocheck`.

### `check:alias-internals` — KEEP. Not expressible as static globs.

The gate asks "did this import reach past a barrel into a directory's internals?" The
answer depends on which directories have an `index.ts` — 83 barrels at time of writing,
discovered at runtime. `style/noRestrictedImports` matches static glob groups and cannot
express a predicate over the repo's own directory structure.

Contrast with `check:deep-relatives`, which **was** retired in this sweep: "2+ `../`
segments" is a fixed shape, so `group: ["../../*", "../../**"]` expresses it exactly.

**Re-check when:** Biome gains a barrel/package-boundary rule, or a GritQL plugin can
take a generated list of barrel paths as input.

### `check:process-cwd` — KEEP for now, but it is the best GritQL pilot available.

The script's own header says it is "a temporary grep-based lint guard" to be migrated
"once Biome supports custom lint rules via its plugin system". **That prerequisite is now
met** — Biome 2.5.10 has GritQL plugins and this repo already ships three
(`no-as-never`, `no-absent-value`, `no-empty-catch`).

`docs/findings/biome-migration-risk.md` §"`check:process-cwd` — Fair GritQL Pilot" already
reached the same conclusion and adds the mitigation: the plugin needs precise path scoping
(`src/cli/**`, `src/commands/**`, `src/config/loader.ts` are legitimately allowed to call
`process.cwd()`), validated against negative fixtures, with the script kept as a wrapper
until parity is proven. Nothing in this sweep changes that; it only removes the "Biome
can't do plugins yet" excuse.

**Status:** unblocked, not done. Genuinely actionable work, not a ruling to re-check.

### `check:test-mocks` — KEEP. Already ruled on; no change.

`docs/findings/biome-migration-risk.md` §"`check:test-mocks` — Still Not A Replacement
Candidate": it carries a large skip list (167 entries when last quantified), reasons about
structure inside helper calls, and emits grouped project-specific hints. GritQL reproduces
none of that. Biome's `test` domain does not cover it either — that domain is about test
*hygiene* rules (duplicate hooks, skipped tests), not about whether a mock should have been
a shared factory.

### `check:test-as-unknown-as` — KEEP as-is; conversion is possible but not free.

Baselined at **0**, which by the repo's own principle argues for a parser: `as unknown as`
is an AST shape, and `biome-plugins/no-as-never.grit` proves the pattern works.

The blocker is the escape hatch. The ratchet honours `// test-ratchet-allow: as-unknown-as`
(25 live sites, each a deliberately-illegal value for a function whose job is surviving
contract violations — the cast *is* the test). A plugin would express those as
`biome-ignore`, but `check:test-escape-hatches`'s `ratchetAllow` counter counts the marker
text. So the two gates have to move together, and `ratchetAllow` cannot move at all (see
above — comment trivia). Converting one while the other still counts markers would either
double-count or silently stop counting.

**Re-check when:** `check:test-escape-hatches` can retire, which needs GritQL comment
matching.

### The domain-invariant gates — KEEP. Neither premise touches them.

`check:no-real-global-nax`, `check:feature-dir-ssot`, `check:nax-error`,
`check:logger-storyid`, `check:log-format-layering`, `check:file-sizes`,
`check:no-control-bytes`, `check:review-prompts`, `check:rules-drift`,
`check:gate-reachability`, `check:naxconfig-cast`, `check:adapter-no-config-import`,
`check:runtime-cleanup`, `check:dispatch-context`.

These encode project-specific invariants (path SSOTs, error-type discipline, log layering,
generated-file freshness, adapter boundaries). No Biome rule expresses any of them, and
neither the typecheck drain nor the v2 upgrade bears on them. They were reviewed and
dismissed as candidates, not overlooked.

Two carry a note:

- **`check:dispatch-context`** lost its redundant `tsc --project` half in this sweep
  (`tsconfig.dispatch-context.json` compiled a strict subset of `tsconfig.test.json`).
  What remains is the grep guard for an optional `agentManager` in `src/`, which is real.
- **`check:gate-reachability`** is the meta-gate: it fails if any `scripts/check-*` file is
  unreachable from CI. It is what makes deleting a gate safe — an orphan cannot hide.

## What was retired in this sweep, for contrast

| Gate / file | Replaced by | Commit |
|:--|:--|:--|
| `tsconfig.contracts.json`, `tsconfig.scripts.json`, `tsconfig.dispatch-context.json` | strict subsets of `tsconfig.test.json` | `12596dda1` |
| `check:scripts` + `scripts/check-scripts.sh` | `bun run typecheck` (already compiles `scripts/**`) | `12596dda1` |
| `scripts/report-cast-buckets.ts`, `scripts/test-trim-progress.ts` | nothing — dead drain residue | `8db8c26e7` |
| `check:deep-relatives` (+ baseline, + test) | Biome `style/noRestrictedImports` | `2a97ada07` |
| `check:no-adapter-wrap` | a strengthened `test/integration/agents/no-adapter-wrap.test.ts` | `cf59a1c24` |

The `check:deep-relatives` retirement is the one worth remembering: the Biome rule turned
out **stricter** than the script it replaced. `computeStringLiteralSpans()` deliberately
skipped string-literal spans to avoid matching fixture text, which blinded it to
deep-relative paths inside dynamic `import(...)` calls. Six genuine pre-existing violations
had been invisible to it. That is the strongest available argument for the parser over the
regex, and it is the pattern to look for when re-checking anything above.

## How to re-check

```bash
# Current readings — any drift means a ruling above needs revisiting.
bun run check:import-cycles          # expect: 135 modules (baseline 135)
bun run check:test-escape-hatches    # expect: tsSuppress=0, ratchetAllow=25, looseCast=1623
bun run check:test-as-unknown-as     # expect: 0 (baseline 0)
bun run check:alias-internals        # expect: 83 barrels checked

# Does a Biome rule now cover a gate? Use the JSON reporter, never grep on human output.
bun x biome explain <ruleName>
./node_modules/.bin/biome check src/ --reporter=json --max-diagnostics=5000

# Is the gate still reachable from CI at all?
bun run check:gate-reachability      # expect: all 21 check scripts reachable
```

When a ruling is overturned, edit it here with the new measurement and the date — do not
delete the old reasoning. Two of the Tier 3 justifications in
`docs/plans/biome-v2-rule-gaps.md` were wrong about what their hits actually were, and the
record of *how* they were wrong is what made the next sweep cheap.
