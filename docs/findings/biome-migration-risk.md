# Biome v2 Migration Risk Findings

Original: 2026-04-28
Revised: 2026-08-22 — re-measured against `main` at `6b58f8e22` with Biome `2.5.10`.
The 2026-04-28 numbers and CI description were stale; see "Revision Notes" at the end.

## Scope

Assessment of migrating `@biomejs/biome` from `^1.9.4` to `2.5.10` (current latest),
including whether the custom checks `check:test-mocks` and `check:process-cwd` can move
into Biome rules.

Current wiring at `main`:

- `package.json` `lint` runs `bun x biome check src/ bin/` plus eleven `check:*` script gates.
- `check:all` is the single aggregator: `lint` plus eleven further gates, closed by
  `check:gate-reachability`.
- `.github/workflows/ci.yml` runs one `test` job whose static stage is a single
  `bun run check:all` step. There are no longer separate `lint` / `check:test-mocks` /
  `check:process-cwd` jobs.
- `.githooks/pre-commit` runs `typecheck` then `check:all`.
- `biome.json` is on the `1.9.4` schema, `organizeImports.enabled: true`,
  `linter.rules.recommended: true`, no `overrides` block.

## Method

All figures below come from running both versions against a copy of the `main` tree
outside the repo, with `--reporter=json --max-diagnostics=20000`.

Baseline: **Biome 1.9.4 on `src/ bin/` reports 0 diagnostics.** Every number below is
therefore regression introduced by the upgrade, not pre-existing debt.

## Summary

Upgrading the dependency is feasible and the blast radius is moderate — roughly 284
mechanical diagnostics, one real lint error, and one config trap that must not be missed.
Migrating the custom checks is still uneven, and that conclusion is unchanged:
`check:process-cwd` is a fair GritQL pilot; `check:test-mocks` is not, and has grown less
suitable (its skip list is now 167 entries).

The single most important finding is new and is not a formatting concern: **the official
migration command silently disables the entire linter.** See below.

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

### Import Churn: 280 Files

Biome v2 replaces `organizeImports` with the assist action
`assist.actions.source.organizeImports`, and its ordering differs — type imports and named
specifiers both move. Against `main`:

- `assist/source/organizeImports`: **280 errors** (279 `src/`, 1 `bin/`)
- `format`: **4 errors** (`src/agents/acp/spawn-client.ts`, `src/agents/manager-dispatch.ts`,
  `src/commands/replay.ts`, `src/prompts/builders/review-builder.ts`)

A single `bun run lint:fix` rewrites 284 files. That is one mechanical commit's worth of
diff, but it lands on every open branch as a rebase conflict and it obscures `git blame`.

Mitigation:

- Land the dependency/config change with the assist action **off**, then re-enable it in a
  separate commit that contains nothing else.
- Add that commit to `.git-blame-ignore-revs`.
- Do it on a quiet tree. This is the risk that scales with how much work is in flight, and
  it is the reason to schedule the upgrade rather than take it opportunistically.

## Medium Risks

### One Real Lint Error Appears

With `recommended: true` restored, v2 finds exactly one error-severity lint violation on
`src/ bin/`:

- `lint/suspicious/useIterableCallbackReturn` in `bin/nax.ts`

This is a genuine-bug-shaped rule, not style. It is independent of the upgrade and can be
fixed under 1.9.4 first, which empties this risk entirely.

### Severity Semantics Get Looser, Not Stricter

The 2026-04-28 note left this open ("CI may become stricter or looser"). Measured: it gets
looser. v2 emits ~60 warnings and 7 info diagnostics on `src/ bin/` that 1.9.4 did not, and
`biome check` **exits 0 on warnings** (verified: `biome lint src/` → exit 0 with 26
`noUnusedImports` + 13 `noUnusedVariables` + 8 `useOptionalChain` warnings outstanding).

Top new warnings on `src/ bin/`: `noUnusedImports` 26, `noUnusedVariables` 13,
`useOptionalChain` 8, `noTemplateCurlyInString` 4, `noUnusedFunctionParameters` 4.

Risk: the upgrade quietly adds ~60 findings that no gate enforces, and they accumulate.

Mitigation: make an explicit call — promote the correctness family
(`noUnusedImports`, `noUnusedVariables`, `noUnusedFunctionParameters`) to `error`, or accept
them as advisory and say so in the config with a comment.

### One Dead Suppression

The tree carries 208 `biome-ignore` comments. Under v2 with `recommended: true`, one no
longer suppresses anything and emits `suppressions/unused`:
`src/execution/runner-execution.ts`.

(Under the mis-migrated `preset: "none"` config this reads as 42 unused suppressions — a
useful secondary tell that the linter has been switched off.)

### Widening Lint Scope To `test/` Is A Separate, Much Larger Change

If `lint` is ever widened to `src/ bin/ test/`, the v2 numbers change by an order of
magnitude: **5,510 diagnostics**, of which 1,756 `noExplicitAny` warnings, 1,147
`organizeImports` errors, 1,071 `noNonNullAssertion` warnings, 654 `format` errors, and 22
`noUnsafeOptionalChaining` errors (all in `test/`).

`main`'s `biome.json` has no `overrides` block, so nothing currently relaxes
`noExplicitAny` / `noNonNullAssertion` / `noDelete` for tests. Any scope widening must ship
that override block with it.

Note the glob-syntax trap: v1 `"include": ["test/**"]` becomes v2
`"includes": ["**/test/**"]`. Hand-writing the v1 form under v2 matches nothing and silently
loses the exemption.

Mitigation: keep scope widening and version upgrade in different PRs. Do not let one
justify the other.

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

Sequenced so each step has an independently checkable outcome:

0. Fix `useIterableCallbackReturn` in `bin/nax.ts` under 1.9.4. Optional, but it empties
   step 2.
1. **Dependency + config, zero behaviour change.** Pin `2.5.10` exactly, run
   `migrate --write`, restore `linter.rules.recommended: true`, set the organizeImports
   assist to `"off"`. Accept only if a before/after JSON diagnostic diff shows no new
   error-severity findings.
2. **Error-severity fixes**, if any remain.
3. **Re-enable organizeImports + formatter.** One mechanical commit, ~284 files, added to
   `.git-blame-ignore-revs`.
4. **Warning policy decision** — promote or accept the ~60 new warnings, explicitly.
5. **GritQL pilot** for `process.cwd()`, with `check:process-cwd` retained as a wrapper.
6. Leave `check:test-mocks` alone.

Steps 1-4 are a half-day on a quiet tree. There is no forcing function — Biome is a dev-only
dependency with no runtime or security exposure — so schedule this between feature arcs
rather than taking it opportunistically.

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
