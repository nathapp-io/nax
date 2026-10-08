# Whole-Repo Review Fixes — Master Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each bundle has its own plan file (linked below); read THIS file first, then the bundle file you are executing.

**Goal:** Fix every live finding of the 2026-10-08 whole-repo code review, one bundle per PR, with the maintainer's open rulings already applied.

**Architecture:** All 33 findings were re-verified against main `eab634ebe` (v0.83.6): 32 are still present (#7's code was deleted by S4b-5). 31 are fixed across 11 bundle PRs (A–K); #7 (moot) and #18 (not a defect) are closed without code. Each bundle is self-contained: its own branch off the latest `main`, its own tests, its own gates, its own PR. Bundles touch disjoint files except where noted, so any order works, but the recommended order below puts the highest-severity fixes first.

**Tech Stack:** TypeScript, Bun 1.4 (`bun:test`) for nax / nax-agent / nax-agent-acp / repo-tooling / test-kit, vitest for nax-ai, Zod 4, Biome 2.

**Spec:** `docs/superpowers/reviews/2026-10-08-whole-repo-code-review.md` (the review report; finding numbers `#N` below are its numbers). Executors read the finding's section in the report before starting its task.

---

## Global Constraints

Every task's requirements implicitly include this section.

- **One branch and one PR per bundle**, created from the latest `origin/main`: `git fetch origin && git checkout -b fix/review-<letter>-<slug> origin/main`. Never stack one bundle branch on another (CI does not run on stacked PRs). Never use git worktrees; branch in the existing checkout.
- **TDD, always.** Write the failing test, run it and SEE it fail for the stated reason, then implement, then see it pass. A test that passes before the fix is a broken test — fix the test, not the expectation.
- **Scoped test commands** (run from the package directory):
  - nax / nax-agent / nax-agent-acp / repo-tooling: `timeout 30 bun test <path> --timeout=5000`
  - nax-ai: `bun x vitest --run <path>`
  - NEVER run bare `bun test` with no path. NEVER run `bun run nax`. NEVER run `nax run` or `nax plan` (billed).
- **Gates before push**, from each touched package's directory:
  - nax: `bun run typecheck && bun run check:all && bun run test && bun run test:coverage`
  - nax-agent, nax-agent-acp: `bun run typecheck && bun run check:all && bun run test && bun run test:coverage`
  - nax-ai: `bun run typecheck && bun run check:all && bun run test`
  - repo-tooling: `bun run typecheck && bun run check:all && bun run test`
  - test-kit: `bun run typecheck` (it has no tests of its own; the nax-agent suite exercises it)
- **File-size gate** (`check:file-sizes`, part of `check:all`): `src/` files max **600** lines, test files max **800**. Two files are grandfathered and may NOT grow by even one line: `packages/nax/src/session/manager.ts` (664) and `packages/nax/src/prompts/builders/rectifier-builder.ts` (901). Files at or near the cap are called out in their task with a line budget. Run `wc -l <file>` before and after every edit to a listed file.
- **Test placement** (`check:test-satellites`): add a test to the module's existing test file. If that would push it past 800 lines, create `<module>-<concern>.test.ts` beside it (a concern word, e.g. `-cost`, `-rectify`). NEVER name a test file after a ticket or finding (`us-001`, `bug-12`, `2387`, `review-25` are all forbidden).
- **Test hygiene** (biome + ratchets): no `as unknown as`, no `as any`, no postfix `!`, no `@ts-expect-error` / `@ts-ignore`, no `as never`. Use `assertDefined(value, "label")` from the package's test helpers to narrow. No empty `catch {}` without a comment.
- **Format before every commit:** `check:all` runs `biome check`, which fails on unformatted code. The plans' code blocks are not guaranteed to be biome-formatted (long lines, import order). Before each commit run, from the package directory, `bun x biome check --write <the files you changed>`, then re-run the task's tests. Re-check `wc -l` afterwards: formatting can add lines, which matters for the files with a line budget.
- **Source hygiene:** immutable updates (spread, never mutate inputs); no `console.log`; new errors in nax / nax-agent are `NaxError` with a code (`check:nax-error`); keep the surrounding comment density and naming.
- **Commits:** conventional, scoped, small: `fix(<scope>): <what> (review #N)`. The nax repo is PUBLIC: never mention any private project by name in commits, PRs or code.
- **Review before push:** after the bundle's tasks are green, run one code review of the branch diff (superpowers:requesting-code-review or the code-reviewer agent). At most TWO fix rounds; anything left after round 2 goes into the PR body as a known follow-up.
- **No releases.** Do not bump versions, tag, or publish. Merging is the maintainer's call.
- **nax-ai reaches published nax only through a release.** nax pins `@nathapp/nax-ai` at an exact version; bundle E's fix is live in the workspace immediately but ships to users only after a maintainer cuts a nax-ai release and bumps the pin. Note this in bundle E's PR body.

## Review Focus

The inputs no single task's tests exercise that are most likely to bite a user, most likely first. Each line names the task that carries its test.

1. **A polyglot repo** (TypeScript + Python + Rust in one tree): review must still see every implementation file; only real test files leave the diff. Pinned in Bundle A Task 2 (`globsToPathspec` cases for `test_*.py`, `tests/**/*.py`, `tests/**/*.rs` alongside the TS defaults).
2. **A run killed mid-save** (SIGKILL, OOM, laptop lid): the next run must resume or start cleanly, never die on a half-written file. Pinned in Bundle B Task 1 (a failing write leaves the previous transcript intact) and Task 3 (an unparseable approvals store is not overwritten).
3. **The user presses Ctrl+C during a model stream**: the abort must surface as an abort, not a retryable transport fault. Pinned in Bundle E Task 1.
4. **A multi-package PRD with an override written before the monorepo split** (bare `AC-2`): it must not silently waive another package's AC-2. Pinned in Bundle J Task 1 (ambiguous bare key ignored with a warning).
5. **A config that says `tdd.strategy: "tdd-simple"`** (the spelling users see everywhere else): it must load and route to `tdd-simple`. Pinned in Bundle F Task 1.

---

## Maintainer rulings (2026-10-08) — settled, do not reopen

| Finding | Ruling | Applied in |
|---|---|---|
| #6 `tdd.strategy: "simple"` rejected by schema | Accept `"simple"` in the schema AND accept `"tdd-simple"` as an alias that a compat shim normalises to `"simple"` before parsing. No deprecation warning (both spellings are supported). Docs and `nax config` descriptions list `simple`. | Bundle F Task 1 |
| #10 overrides keyed by bare AC id | Package-scoped override keys `<packageRel>::AC-N` (`packageRel` = package dir relative to the repo root, `.` for the root). A bare `AC-N` still works when it is unambiguous; in a multi-package acceptance run a bare `AC-N` applies only when exactly ONE package defines an AC with that number, otherwise it is ignored with a warning naming the scoped form. `nax accept --override` accepts both forms. | Bundle J |
| #19 elicitation: required select + `_custom` companion declines free text | The code is right: a required select must name a choice (filling only the companion would omit the required key and violate the requester's own schema). Claude's AskUserQuestion forms never mark fields required (claude-agent-acp 0.85.1 `dist/elicitation.js:111-167`), so this only arises from third-party MCP forms. Fix the module doc and the prompt instruction, which currently invites a reply it then declines. | Bundle G Task 2 |

**Refinement of the #10 ruling (planner, 2026-10-08):** the option text said a bare key applies "when exactly one package has that AC failing". The loop processes packages one at a time, so "failing elsewhere" is not known when the first package is filtered; that rule would make the verdict depend on package order. The plan uses "exactly one package DEFINES that AC number" instead, which is known before the loop (from the per-package in-scope AC counts the stage already computes) and gives the same answer whenever the key is unambiguous. Flagged to the maintainer at hand-off.

## Scope additions beyond the report (found while planning)

Same defect class as a reported finding, fixed in the same task. Each is called out in its bundle's PR body.

| Where | What | Bundle / task |
|---|---|---|
| `test-runners/conventions.ts` `globsToPathspec` | The #2 root cause is generic: the suffix after the LAST `*` becomes the exclusion, so pytest's `test_*.py` / `tests/**/*.py` also become `:!*.py` (every Python file leaves review), not only Cargo's `src/**/*.rs`. | A / 2 |
| `test-runners/resolver.ts` `resolveReviewExcludePatterns` | Every literal first glob segment becomes a whole-directory exclusion, so a colocated-test pattern (`src/**/*.test.ts`, e.g. a vitest include) excludes all of `src/` from review. | A / 2 |
| `nax-agent` `internal/command-spec` `replaceInCommandSpec` | The #27 `$`-pattern expansion also hits the shared helper behind scoped-selection, scoped-lint and the mechanical lint/format fixes. | G / 1 |
| `context/rules/canonical-loader/index.ts:525` | The loader's own load sort uses `localeCompare` too (the report named it in passing under #21). | F / 3 |

## Closed without code

| Finding | Disposition | Evidence |
|---|---|---|
| #7 acpx abort → success-shaped empty result | **Moot.** S4b-5 (#2386, `314442a50`) deleted the acpx transport; `packages/nax/src/agents/acp/adapter-send-turn.ts` no longer exists. The SDK transport throws `fail-aborted` (D2-c ruling). | `ls packages/nax/src/agents/acp/adapter-send-turn.ts` → ENOENT |
| #18 argv-exec shared drain grace | **Not a defect.** The module contract (`packages/nax-agent/src/internal/argv-exec.ts:14-16`) is "after `exited`, both readers get `DRAIN_GRACE_MS` to close", i.e. one deadline measured from exit. The sequential races implement exactly that: a stream that already closed wins its race even when awaited second (an already-resolved promise beats the later-derived `gracePromise.then(...)`), and a stream still open at the deadline is an orphan whichever order it is awaited in. | `argv-exec.ts:222-238` |

---

## Bundles

Recommended order (highest severity first). Each row links its plan.

| # | Bundle | Findings | Packages | Plan |
|---|---|---|---|---|
| A | Test-file detection + plan digest | #1 (P1), #2 (P1), #28 | nax | [bundle-a](2026-10-08-review-fixes-bundle-a-detection-context.md) |
| D | Security hardening | #4, #17 | nax-agent, test-kit | [bundle-d](2026-10-08-review-fixes-bundle-d-security.md) |
| B | Durable writes | #3, #15, #16 | nax-agent | [bundle-b](2026-10-08-review-fixes-bundle-b-durable-writes.md) |
| H | Session-manager races | #8, #24 | nax | [bundle-h](2026-10-08-review-fixes-bundle-h-session-manager.md) |
| J | Package-scoped acceptance overrides | #10 | nax | [bundle-j](2026-10-08-review-fixes-bundle-j-acceptance-overrides.md) |
| C | Process and abort hygiene | #11, #14, #22, #29 | nax, nax-agent | [bundle-c](2026-10-08-review-fixes-bundle-c-process-abort.md) |
| I | Cost and telemetry attribution | #9, #13, #23, #25 | nax, nax-agent | [bundle-i](2026-10-08-review-fixes-bundle-i-cost-telemetry.md) |
| E | nax-ai error classification | #5, #20 | nax-ai | [bundle-e](2026-10-08-review-fixes-bundle-e-nax-ai-errors.md) |
| F | Config and parsers | #6, #12, #21, #26, #30 | nax | [bundle-f](2026-10-08-review-fixes-bundle-f-config-parsers.md) |
| G | Command templates and elicitation text | #19, #27 | nax, nax-agent, nax-agent-acp | [bundle-g](2026-10-08-review-fixes-bundle-g-templates-elicitation.md) |
| K | Tooling and CI | #31, #32, #33 | repo root, repo-tooling, nax | [bundle-k](2026-10-08-review-fixes-bundle-k-tooling-ci.md) |

## Per-bundle PR checklist

Run this for every bundle after its last task:

- [ ] All of the bundle's tasks are committed; `git log --oneline origin/main..HEAD` shows one commit per task.
- [ ] The gates in Global Constraints pass for every package the bundle touched. Paste the final lines of each into the PR body.
- [ ] `wc -l` of every file the bundle edited is within its cap (600 src / 800 test / grandfathered unchanged).
- [ ] Code review of `git diff origin/main...HEAD` done; at most two fix rounds; leftovers listed in the PR body.
- [ ] Push with `git push -u origin <branch>` and open the PR: `gh pr create --title "fix(<scope>): review 2026-10-08 bundle <X> — <slug>" --body-file <file>`. The body lists each finding number, one line on the fix, and the test that pins it.
- [ ] Update the status table below in a follow-up docs commit on the SAME branch (`docs: mark review bundle <X> in progress`). Do not merge.

## Status

| Bundle | Branch | PR | Status |
|---|---|---|---|
| A | — | — | not started |
| D | — | — | not started |
| B | — | — | not started |
| H | — | — | not started |
| J | — | — | not started |
| C | — | — | not started |
| I | — | — | not started |
| E | — | — | not started |
| F | — | — | not started |
| G | — | — | not started |
| K | — | — | not started |
