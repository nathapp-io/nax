# Path-Frame Follow-ups P2/P3 — Overview

Fix plan for follow-ups **6-12** of the post-merge review of the path-frame seam-closure arc.

**Source of findings:** `projects/nax/nax-path-frame-seam-closure-review-2026-09-17.md` (outside this repo). Every finding was reproduced in code on `main` @ `6507cf061`; finding IDs below (C1, H3, M6 …) refer to that document.

**Base:** `origin/main` @ `6507cf061` — the tip of the six merged PRs (#2097, #2099, #2100, #2101, #2102, #2103).

**Not in this bundle:** follow-ups 1-5 (the two P0s and three P1s) are fixed on `fix/path-frame-p0-p1`, which is **complete and gate-verified but not yet merged**:

```
faf770504 fix(prompts): frame batch modifiedFiles against the batch's one agent root
484c28215 fix(context): stop the canonical drop from deleting in-package contextFiles
eb7289161 fix(execution): run acceptance-test regen's git diff at repoRoot, not workdir
041128d26 fix(scripts): rewrite the story-workdir-access gate on the real TS checker
e149de1cd fix(context): thread story workdir onto ContextRequest for worktree-safe framing
```

Only PR 2 here depends on it. See the dependency analysis below.

**Line numbers were verified on 2026-09-17** — against `6507cf061` for PRs 1 and 3-6, and against `faf770504` for PR 2, which bases on the P0/P1 branch. Each PR file states its own base. Treat every number as a hint and grep for the quoted code, which is the real anchor.

| PR | File | Follow-up | Findings | Depends on P0/P1? |
|---|---|---|---|---|
| 1 | [`01-pr1-review-contract-and-coverage.md`](./01-pr1-review-contract-and-coverage.md) | 6 (P2) | H3 | No |
| 2 | [`02-pr2-git-history-prompt-frame.md`](./02-pr2-git-history-prompt-frame.md) | 7, 9 (P2) | H9, M13, M14, M15 | **YES — hard** |
| 3 | [`03-pr3-effectiveness-literal-scope.md`](./03-pr3-effectiveness-literal-scope.md) | 8 (P2) | H8, L5 | No |
| 4 | [`04-pr4-exec-root-and-scope-residue.md`](./04-pr4-exec-root-and-scope-residue.md) | 10 (P3) | M1, M2, L2, L3, L4 | No |
| 5 | [`05-pr5-review-builder-consolidation.md`](./05-pr5-review-builder-consolidation.md) | 11 (P3) | M6, M7, M8, M9, M10, L1 | No |
| 6 | [`06-pr6-bookkeeping.md`](./06-pr6-bookkeeping.md) | 12 (P3) | — | Ordering only |

Each PR file is **self-contained** — an executor reads one file, not all six.

---

## Dependency analysis

**The question this bundle had to answer first: do P2/P3 need the P0/P1 changes?**

**Answer: no, with exactly one exception.** Five of the six PRs here touch files that `fix/path-frame-p0-p1` does not, and can be branched from `origin/main` and merged in any order relative to it.

Verified against the files actually touched on `fix/path-frame-p0-p1`:

```
scripts/check-story-workdir-access.ts          src/context/engine/types.ts
src/context/builder.ts                         src/execution/lifecycle/acceptance-helpers.ts
src/context/engine/providers/code-neighbor.ts  src/pipeline/stages/context.ts
src/context/engine/providers/git-history.ts    src/context/engine/stage-assembler.ts
+ the matching test files, + src/prompts/sections/story.ts (fix 5, pending)
```

| PR | Files it touches | Overlap |
|---|---|---|
| 1 | `src/review/scoped-lint.ts`, `src/review/runner/`, its tests | none |
| 2 | **`src/context/engine/providers/git-history.ts`**, `.nax/rules/`, `docs/specs/` | **collides** |
| 3 | `src/context/engine/effectiveness.ts`, `src/context/engine/providers/static-rules.ts` | none |
| 4 | `src/runtime/packages.ts`, `src/prompts/sections/agent-scope.ts`, `src/agents/{types,coding-tool-support}.ts` | none |
| 5 | `src/prompts/builders/*.ts`, `src/prompts/sections/protocol-region.ts`, `src/utils/nax-owned-paths.ts` | none |
| 6 | `docs/` only | none |

### PR 2 is the exception, and the dependency is real — not just a merge conflict

P0/P1 fix 1 rewrites how `GitHistoryProvider` derives its package frame: it removes the `packageDirRelative(request.repoRoot, request.packageDir)` derivation (finding C1) and threads the PRD-declared story workdir onto `ContextRequest` instead.

PR 2 here has to **package-frame the chunk content** at `git-history.ts:103`. It needs a correct package frame to do that. On `origin/main` the only frame available at that point is the broken derivation, so building PR 2 on `origin/main` would either re-derive the forbidden value or invent a second source of truth for the same thing.

**Therefore PR 2 branches from `fix/path-frame-p0-p1` (or from `main` after it merges), not from `origin/main`.** It also absorbs M14 (the misplaced A5 warn) because fix 1 already moves that warn — attempting it separately would conflict line-for-line.

PR 6 has no code dependency but should land **last**, so the bookkeeping it writes can name every merged PR including the P0/P1 one.

### One file is claimed by two PRs — the split is already decided

`src/prompts/sections/agent-scope.ts` is touched by PR 4 (dead `.nax-wt` branch, stale docblock) and was also a candidate for PR 5 (the misfiring strip-the-prefix instruction at `:55`). **PR 4 owns the file and takes all of it; PR 5 must not edit it.** Both files now say so. If PR 5 needs its "out-of-package changes omitted" notice to live in the scope section rather than beside the stat block, it coordinates with PR 4 or lands after it.

### Recommended order

```
origin/main ──┬─ PR 1  (independent)
              ├─ PR 3  (independent)
              ├─ PR 4  (independent)
              └─ PR 5  (independent)

fix/path-frame-p0-p1 ── PR 2  (hard dependency)

                        PR 6  (last, after everything)
```

PRs 1, 3, 4, 5 may be parallelised freely.

---

## Global constraints (apply to every PR)

- **Branch first.** `main` is the default branch and must not be committed to directly.
- **Prefix every git command with `RTK_DISABLED=1`** in this repo.
- **TDD.** Failing test first, observe RED, implement, observe GREEN. The reviewed arc shipped three tests that could never fail (H2, M2, and the H3 test this bundle's PR 1 replaces) — do not add a fourth. If a test passes before the fix, it is not a test of the fix.
- **Gates before any commit:** `bun run typecheck && bun run lint && bun run test`.
- **Also run `bun run test:coverage`.** It is a separate CI step with a per-file floor and is not part of the nax pipeline, so a fully green suite can still fail it. Every PR here adds or moves tests. If it fails on a file you touched, fix the coverage rather than moving the baseline; if you must move a baseline, say so explicitly in the PR body.
- **Never `bun test` bare and never `bun run nax`** — both give confident false signals. Use `bun run test`, `bun run test:e2e`, `bun run dev`.
- **Bun-native only.** `Bun.file()`, `Bun.write()`, `Bun.spawn()`, `Bun.sleep()` — never Node `fs`/`child_process` in new `src/` code. `process.cwd()` is banned outside CLI entry points.
- **Barrel imports only** in `src/`, `bin/`, `scripts/`. Tests are exempt.
- **Never read `story.workdir` raw** — use `storyWorkdir` / `storyPackageDir` / `storyAbsWorkdir` from `@/utils/path-frame`. Enforced by `bun run check:story-workdir-access` (which P0/P1 fix 2 is currently rewriting — expect it to be stricter once that lands).
- **File-size ratchet:** 600 lines for `src/`, 800 for `test/` (`bun run check:file-sizes`). Grandfathered files may not grow. Current headroom for files in this bundle:

  | File | Lines | Note |
  |---|---|---|
  | `src/context/engine/providers/static-rules.ts` | **600/600** | **cannot grow at all** (PR 3) |
  | `src/prompts/builders/adversarial-review-builder.ts` | 510 | PR 5 |
  | `src/context/engine/effectiveness.ts` | 486 | PR 3 |
  | `src/prompts/builders/debate-builder.ts` | 474 | PR 5 |
  | `src/review/scoped-lint.ts` | 391 | PR 1 |
  | `src/prompts/sections/protocol-region.ts` | 371 | PR 5 |
  | `src/prompts/builders/review-builder.ts` | 368 | PR 5 |
  | `src/runtime/packages.ts` | 217 | PR 4 |
  | `src/prompts/sections/agent-scope.ts` | 58 | PR 4 |

- **Rules live in `.nax/rules/`;** `.claude/rules/` is a generated mirror (`nax rules export --agent=claude`, guarded by `check:rules-drift`). PR 2 edits a rule and **must** regenerate the mirror.
- **Verification discipline:** paste the actual command output. A green you did not read is not a green.

## Standing rulings that still bind

Carried forward from the arc's spec (`docs/superpowers/specs/2026-09-16-path-frame-convention-design.md`) — settled, do not re-litigate.

- **The convention:** every path held in a nax-internal path set is **repo-rooted**. Package-relative spelling is legal in exactly two places, both converting *out of* the canonical frame: the agent prompt / chunk-content boundary, and the PRD at write time.
- **Ruling 8/E — `workdirSource` is provenance, not a frame proof.** A `toPackageFrame` miss is only "out-of-package" on a path set known to carry repo-rooted entries. `contextFiles` qualifies; `expectedFiles` does not.
- **Ruling F —** dropping or marking a `modifiedFiles` entry is forbidden; it revokes a granted authorization.
- **`story.workdir` is always a string; `"."` means repo root.**

## Issue filing

None of these findings has a GitHub issue yet. Either file them first and put real `Closes #NNNN` lines in the PR bodies, or reference the review document by name in the PR body. **Do not close #2088** from PR 2 — it is already closed; PR 2's M13 half is a residual against it, so if you want it tracked, file a fresh issue rather than reopening.

`nathapp-io/nax` is **public**. Never name a private downstream repo in an issue or PR body.
