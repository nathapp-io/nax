# Deep-Relative Migration Runbook

**Status:** Active — in progress
**Branch:** `chore/deep-relatives-migration`
**Date:** 2026-08-20
**Follows:** PR #1649 (issue #1647), PR #1650 (issue #1648)

---

Steps 3 and 4 of the plan behind #1647: convert the remaining relative imports
to path aliases, then retire the ratchet. 97% is scripted.

Follow this in order and do not improvise. Every escalation in Phases C and D
is a genuine engineering decision, not a blocked script.

## 0. Where things stand

Start from `chore/deep-relatives-migration`, not `main`. The branch already
carries the codemod and one finished batch.

| Class | Count | How |
|:---|---:|:---|
| `test` | 2,344 | scripted — Phase A |
| `src-specifier` | 112 | scripted — Phase B |
| `barrel-routing` | 54 | manual — Phase C, escalate |
| `unresolved` | 18 | manual — Phase D, escalate |
| **Total** | **2,528** | |

Re-read these counts at any time:

```bash
bun scripts/migrate-deep-relatives.ts --dry-run
```

## 1. Rules that override everything

- **Never run Biome over `test/` files.** `bun run lint` formats `src/` and
  `bin/` only — `test/` is deliberately unformatted. Reformatting it re-wraps
  unrelated casts and detaches their `// test-ratchet-allow` markers, which
  breaks `check:test-as-unknown-as`.
- **Never run `--update-baseline` on any ratchet.** Every baseline must hold
  exactly. A moved number means the batch broke something.
- **Never hand-edit a `barrel-routing` or `unresolved` import.** Those load a
  different module; changing them can create an import cycle.
- **Never lower the deep-relatives baseline** to match progress. It stays at
  2,845 until the file is deleted in Phase E.

## 2. The verification block

Run after *every* batch, before committing.

```bash
bun run lint
bun run typecheck
bun run check:test-typecheck
bun run check:test-as-unknown-as
bun run test
```

| Check | Must read |
|:---|---:|
| `check:alias-internals` | OK, 77 barrels |
| `check:import-cycles` | 42 |
| `check:test-typecheck` | 2,001 |
| `check:test-as-unknown-as` | 815 |
| `bun run test` | 0 fail |

`check:deep-relatives` is the only number that should move, and only downward.

If anything else changes, run `git checkout -- .` to drop the batch, then
escalate with the failing output. Do not try to fix it.

The pre-commit hook re-runs all of this, so a commit that succeeds is proof.

## 3. Phase A — test/ imports (2,344)

One directory per batch, one commit per batch. Largest first, so failures
surface early.

```bash
bun scripts/migrate-deep-relatives.ts --scope test --dir test/unit/execution
# ...verification block...
git add -A && git commit -m "refactor(test): migrate test/unit/execution imports to aliases"
```

| Batch | Imports | Batch | Imports |
|:---|---:|:---|---:|
| `test/unit/execution` | 342 | `test/unit/config` | 87 |
| `test/unit/context` | 163 | `test/unit/prompts` | 80 |
| `test/unit/review` | 137 | `test/unit/plugins` | 64 |
| `test/unit/pipeline` | 135 | `test/unit/runtime` | 63 |
| `test/unit/agents` | 117 | `test/unit/session` | 50 |
| `test/unit/debate` | 103 | `test/unit/metrics` | 50 |
| `test/unit/operations` | 102 | `test/unit/routing` | 40 |
| `test/unit/cli` | 88 | `test/integration` | 441 |

Finish with `--scope test` and no `--dir` to catch the tail (`test/ui`,
`test/helpers`, smaller directories).

## 4. Phase B — src/ imports (112)

These touch production code, so keep batches small. Unlike `test/`, **do** run
Biome here — `src/` is formatted by CI.

```bash
bun scripts/migrate-deep-relatives.ts --scope src --dir src/pipeline
bun x biome check --fix $(git diff --name-only)
# ...verification block...
```

Batches: `src/pipeline` (45), `src/execution` (45), `src/context` (24),
`src/agents` (16), `src/prompts` (12), then `--scope src` with no `--dir`.

## 5. Phase C — barrel routing (54) — escalate

Imports that would have to load a *different* module to satisfy the barrel
rule. Do not attempt mechanically. Procedure for a human or stronger model:

1. Add the missing symbol to the target directory's `index.ts`.
2. Repoint the importer at the barrel.
3. Run `bun scripts/check-import-cycles.ts`. **If the count rises above 42,
   revert both edits** and leave the import as a deep relative — a deep
   relative is strictly better than a cycle.
4. Record why anything was left behind.

Precedent: two imports in `src/pipeline/stages/context.ts` and
`src/pipeline/subscribers/hooks.ts` are permanently exempt for this reason.
Routing them through `@/execution` closes a 12-hop `pipeline -> execution` loop.

## 6. Phase D — no alias exists (18) — escalate

Two groups, each needing a decision rather than an edit:

- **14 in `test/unit/scripts/`** importing `../../../scripts/*`. No `@scripts/*`
  alias exists. Either add one to `tsconfig.json` and `tsconfig.test.json`, or
  accept them as the permanent tail.
- **4 JSDoc code-fence examples** in
  `test/helpers/{index,deps,warn-spy,pipeline-context}.ts`. Not real imports —
  the checker regexes raw lines. Rewriting them to `@test/helpers` is correct
  anyway, since docs should show the form we want copied.

The baseline cannot reach 0 until both groups are settled.

## 7. Phase E — retire the ratchet

Only once `check:deep-relatives` reports **0**:

- Delete `scripts/check-deep-relatives.ts`,
  `scripts/migrate-deep-relatives.ts`,
  `scripts/baselines/deep-relatives-baseline.json`, and
  `test/unit/scripts/check-deep-relatives.test.ts`.
- Remove `check:deep-relatives` and `check:deep-relatives:update` from
  `package.json`, including from the `lint` chain.
- Drop the "Migration ratchet" paragraph from
  `.claude/rules/project-conventions.md`. Keep the cycle ratchet and the barrel
  rules — those are permanent.
- Confirm `bun run check:gate-reachability` still passes.

If the count cannot reach 0 because Phase D is unresolved, stop and report the
residual rather than deleting anything.

## 8. Why the rules exist

Both non-obvious rules come from failures hit while building this, not caution.

- **`@test/<dir>/<internal>` is not exempt from the barrel rule.** A first pass
  treated everything under `test/` as safe and failed `check:alias-internals`
  on 8 `test/helpers` imports. The codemod now verifies per import that the
  barrel already exports every name, and refuses otherwise.
- **Biome on `test/` broke a ratchet.** Shortened import lines changed Biome's
  wrapping, splitting one cast across lines and joining another. That moved
  their line-scoped `// test-ratchet-allow` markers and shifted
  `check:test-as-unknown-as` from 815 to 816. The codemod's own edits were
  innocent.
