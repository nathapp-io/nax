# Path-Frame Seam Closure — Overview

Bundled fix plan for the ten open defects filed as **#2083-#2091 and #2093**: the six unfixed path-frame seams, the arc's three bookkeeping follow-ups, and one unrelated worktree escape.

**Spec:** `docs/superpowers/specs/2026-09-16-path-frame-convention-design.md`
**Base:** `main` @ `71071a035`. Every line number in these plans was re-verified against that commit, not against the commits the issues were filed at (`a8bc38ef8` / `d9614909c`).

Each PR is a separate file in this directory and is **self-contained** — an executor reads one file, not all six.

| PR | File | Issues | Live? |
|---|---|---|---|
| 1 | [`01-pr1-frame-ssot.md`](./01-pr1-frame-ssot.md) | #2089 | **LIVE** |
| 2 | [`02-pr2-provider-frames.md`](./02-pr2-provider-frames.md) | #2088, #2091 | #2091 **LIVE** |
| 3 | [`03-pr3-plan-write-seam.md`](./03-pr3-plan-write-seam.md) | #2086, #2085 | **LIVE** |
| 4 | [`04-pr4-review-builder-frames.md`](./04-pr4-review-builder-frames.md) | #2090 | **LIVE** |
| 5 | [`05-pr5-latent-tail-and-gate.md`](./05-pr5-latent-tail-and-gate.md) | #2083, #2087, #2084 | Latent |
| 6 | [`06-pr6-worktree-exec-root.md`](./06-pr6-worktree-exec-root.md) | #2093 | **LIVE, damaging** |

## Start here (handover)

You are picking this up cold. Do these four things before touching code.

1. **Read this file end to end**, then read only the one PR file you are executing. They are self-contained by design; reading all six wastes context.
2. **Branch.** `main` is the default branch and must not be committed to directly:
   ```bash
   git switch -c fix/path-frame-seams
   ```
   If you want isolation per PR, use `superpowers:using-git-worktrees` instead.
3. **Confirm your base.** These plans were written against `main` @ `71071a035`:
   ```bash
   git log --oneline -1          # expect 71071a035, or newer — see the drift warning below
   ```
4. **Re-verify before trusting any line number.** See the next section. This is not optional.

Then follow the PR file's steps in order with `superpowers:subagent-driven-development` or `superpowers:executing-plans`.

## ⚠️ Line numbers drift — verify, do not trust

Every `file.ts:NNN` in these plans was verified against `71071a035` on 2026-09-16. **Two things invalidate them:**

- **Commits landing on `main` after that.** Check with `git log --oneline 71071a035..HEAD`.
- **Earlier PRs in this bundle.** PR 1 changes `src/utils/path-frame.ts` and `src/context/builder.ts`; PR 2 changes the context engine; PR 4 changes three prompt builders. An executor starting PR 5 will find shifted lines in files PRs 1-4 touched.

**Treat every line number as a hint, and the surrounding quoted code as the real anchor.** Each plan quotes the code it refers to — grep for the snippet, not the line. If a quoted snippet no longer exists, stop and re-verify the claim before implementing; a seam may already have been closed by another PR in this bundle.

The issue bodies on GitHub carry line numbers from `a8bc38ef8` / `d9614909c` and are **already stale**. Prefer these plans over the issue text where they disagree; the four known disagreements are listed under Corrections below.

## Sequencing

**PR 1 → PR 2 is the only hard dependency.** PR 1 introduces `partitionPackageFrame`, which PR 2 consumes; and PR 2's decision about `touchedFiles`' frame depends on PR 1 having settled the canonical-vs-legacy rule.

**PR 1 → PR 3 is a soft dependency.** PR 3 Part B uses `partitionPackageFrame` if it exists and falls back to `toPackageFrame` per entry if not. PR 3 can therefore ship before PR 1, but is slightly cleaner after it.

PRs 4, 5 and 6 are fully independent and may be parallelised.

PR 6 is unrelated to path frames and can ship at any time — it is last by ruling, not by dependency.

## Standing rulings (settled — do not re-litigate)

1. **#2090 — the ACP parity premise is RETIRED.** Only a justification paragraph in one test file's header comment is removed. ACP itself, the test file, and all four of its assertions stay. See PR 4 for the evidence.
2. **#2087 — narrow, do not fix. `runAutofixLint` is DELETED** (zero production callers). See PR 5.
3. **#2093 — deferred to the last PR.** Most damaging item here, but unrelated to path frames, so it ships independently.
4. **#2085 — reframe at the prompt boundary, not the write seam.** `persist-prd.ts:61` took a deliberate deviation to run fidelity before canonicalization; do not disturb it.

## Global constraints (apply to every PR)

- **The convention:** every path held in a nax-internal path set is **repo-rooted**. Package-relative spelling is legal in exactly two places, both converting *out of* the canonical frame: the agent prompt/chunk-content boundary, and the PRD at write time.
- **`story.workdir` is always a string. `"."` means repo root.** Never read the raw field — use `storyWorkdir` / `storyPackageDir` / `storyAbsWorkdir` from `@/utils/path-frame`. Enforced by `bun run check:story-workdir-access`.
- **Bun-native only.** `Bun.file()`, `Bun.write()`, `Bun.spawn()`, `Bun.sleep()` — never Node `fs`/`child_process`. `process.cwd()` is banned outside CLI entry points.
- **File-size ratchet:** 600 lines for `src/`, 800 for `test/` (`bun run check:file-sizes`). Grandfathered files may not grow. At the edge in this plan:
  - `src/operations/call.ts` — **597/600** (PR 6)
  - `test/unit/operations/call.test.ts` — grandfathered at **967**, may not grow (PR 6)
  - `src/context/engine/providers/static-rules.ts` — **600/600**, cannot grow at all (PR 2)
- **Barrel imports only** in `src/`, `bin/`, `scripts/`. Tests are exempt.
- **Gates before any commit:** `bun run typecheck && bun run lint && bun run test`. Never `bun test` bare and never `bun run nax` — both give confident false signals.
- **Also run `bun run test:coverage`.** It is a **separate CI step with a per-file floor** and is *not* part of the nax pipeline, so a fully green suite can still fail it. Every PR in this bundle adds or moves tests, which is exactly the case CLAUDE.md says to run it by hand for. If it fails on a file you touched, fix the coverage rather than moving the baseline; if you must move a baseline, say so explicitly in the PR body.
- **Bun 1.4.0** is pinned in CI. Bun-native APIs only.
- **A note on the 600-line limit:** the generated `CLAUDE.md` summary says "400-line limit", but the authoritative sources — `scripts/check-file-sizes.ts` (`SRC_LIMIT = 600`, `TEST_LIMIT = 800`) and `.claude/rules/project-conventions.md` — both say 600/800. Trust the gate, not the summary blurb.
- **Rules live in `.nax/rules/`;** `.claude/rules/` is a generated mirror (`nax generate`, guarded by `check:rules-drift`). No PR here should need to touch either.
- **Verification discipline:** paste the actual command output. A green you did not read is not a green.

## Issue closure

Each PR file carries a **PR body** section with the exact `Closes #NNNN` lines to include:

| PR | Closes |
|---|---|
| 1 | #2089 |
| 2 | #2088, #2091 |
| 3 | #2086, #2085 |
| 4 | #2090 — plus `Refs #2096`, which it must **not** close |
| 5 | #2083, #2087, #2084 |
| 6 | #2093 |

All ten issues in the bundle are accounted for. **#2096 stays open** — PR 4 performs part 1 of its direction (retiring the byte-freeze premise); part 2, asserting at the dispatch seam if a frozen-arm guarantee is wanted at all, is a separate decision.

## Corrections — ALREADY APPLIED upstream (2026-09-16)

Verification found four claims in the filed issues that do not hold on `71071a035`. **These have been appended to the issue bodies on GitHub as marked correction blocks** — you do not need to apply them. They are listed here because the plans argue from the corrected facts, and a reader comparing the plan against the *original* issue prose will otherwise see a contradiction.

- **#2083(e)** — the per-package acceptance fan-out does **not** construct a `PipelineContext` with `workdir: pkg.packageDir`. `acceptance-loop.ts:543` is a `diagnosisOpts` bag; the fan-out otherwise names that value `packageDir` (`:509`, `:521`, `:292`). The substance survives, the cited reachability path does not.
- **#2084(e)** — there are **zero** live `?.workdir` / `["workdir"]` story reads in `src/`. The nearest real bypass is `src/context/builder.ts:282` `const { workdir } = storyContext`, which reads the *context* workdir, not the raw story field.
- **#2088(b)** — the package-framed contract for `touchedFiles` is documented in the **`scopeFiles`** docblock at `src/context/engine/types.ts:329-334`, not the `touchedFiles` docblock at `:312-315`.
- **#2091(f)** — the scoring hop is `src/context/engine/orchestrator.ts:378` + `src/context/engine/scoring.ts:113`. The issue names `context.ts`; that file does not exist.

## Follow-ups

- **#2096 — FILED.** The parity test asserts on *builder* output while the prompt the agent receives is assembled at dispatch (`tool-preamble.ts:33-37`). #2095 changed the delivered ACP arm and the test stayed green. A testing-strategy defect independent of #2090. PR 4 does part 1 of its direction; part 2 stays open.
- **`ContextRequest.touchedFiles` has no declared frame of its own** — its contract survives only in the neighbouring `scopeFiles` docblock. Not separately filed: **PR 2 fixes it** by giving the field its own docblock, and the correction is recorded on #2088.

## Adjacent, deliberately NOT in this bundle

- **#2079** — live verification of #2067. Deferred by standing user ruling; needs a real billed `nax plan` run and explicit approval **at the launch moment**.
- **#2080** — `plan --decompose` bypasses `finalizeAndWritePrd`. Close kin to PR 3 and could fold in, but it requires making `finalizeAndWritePrd` idempotent over an already-canonical PRD — a different blast radius.
