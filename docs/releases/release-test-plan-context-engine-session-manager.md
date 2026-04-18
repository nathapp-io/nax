# Release Test Plan — Context Engine v2 + Session Manager

**Target release:** successor to `v0.62.0`
**Scope:** all commits merged via PR #520 on branch `fix/context-engine-review-followups-2026-04-17`
**Specs under test:**

- [SPEC-context-engine-v2.md](../specs/SPEC-context-engine-v2.md)
- [SPEC-context-engine-v2-amendments.md](../specs/SPEC-context-engine-v2-amendments.md)
- [SPEC-context-engine-v2-compilation.md](../specs/SPEC-context-engine-v2-compilation.md)
- [SPEC-context-engine-agent-fallback.md](../specs/SPEC-context-engine-agent-fallback.md)
- [SPEC-context-engine-canonical-rules.md](../specs/SPEC-context-engine-canonical-rules.md)
- [SPEC-session-manager-integration.md](../specs/SPEC-session-manager-integration.md)

## Purpose

Unit and integration tests prove *code correctness*. This plan proves *feature correctness* — that the context engine and session manager behave as a user / operator expects in the paths that unit tests cannot exercise (real agent calls, real ACP sessions, real filesystem layouts, real fallback triggers).

Run this plan against a release candidate build before tagging. Sign off at the end.

## Pre-flight

| # | Check | Expected | Evidence |
|---|-------|----------|----------|
| P1 | `bun run typecheck` | exits 0 | terminal output |
| P2 | `bun run lint` | exits 0 | terminal output |
| P3 | `bun run test:unit` | all pass, no skips beyond baseline | terminal output |
| P4 | `bun run test:integration` | all pass | terminal output |
| P5 | `bun run build` | produces `dist/` artifact | `ls dist/` |
| P6 | No uncommitted changes on the release branch | `git status` clean | terminal |
| P7 | CHANGELOG / release notes reference the merged PR | manual | diff |

If any fails → **STOP**; do not ship.

---

## T1 — Context Engine v2 Smoke (golden path)

**Goal:** v2 engine runs end-to-end on a real story, produces a valid manifest, and the agent accepts the push markdown.

| # | Step | Expected |
|---|------|----------|
| T1.1 | In a test project, set `config.context.v2.enabled: true` in `.nax/config.json` | file saved |
| T1.2 | Run `nax run` on a single-story PRD with `execution.mode: "single-session"` | story completes, exit 0 |
| T1.3 | Verify manifest written at `.nax/features/<feature>/stories/<storyId>/context-manifest-context.json` | file exists, valid JSON |
| T1.4 | Inspect manifest: `nax context inspect --feature <f> --story <s>` | formatted tree, shows push tokens / pulled tokens / provider list |
| T1.5 | Manifest includes `providerResults[]` with at least `static-rules`, `feature-context`, `session-scratch` | manifest JSON inspection |
| T1.6 | `floorItems[]` is non-empty (static + feature chunks always included) | manifest inspection |
| T1.7 | `buildMs` < 1000ms for a cold cache | manifest inspection |

**Rollback trigger:** T1.2 fails with a context-stage error → revert before release.

---

## T2 — Stage-aware bundles

**Goal:** each stage receives a stage-tuned bundle, not the same corpus.

| # | Step | Expected |
|---|------|----------|
| T2.1 | Run a three-session TDD story that reaches test-writer, implementer, and verifier | all three sessions spawn |
| T2.2 | Inspect manifests `context-manifest-tdd-test-writer.json`, `…-tdd-implementer.json`, `…-tdd-verifier.json` | distinct manifests per stage |
| T2.3 | test-writer manifest `providerResults[].id` set ≠ verifier `providerResults[].id` set | role-specific provider filtering observed |
| T2.4 | Each manifest's `totalTokensPacked` ≤ `budgetTokens` for its stage | packer respects budget |
| T2.5 | `excludedChunks[]` entries each carry a reason (`role-mismatch` / `below-min-score` / `dedup` / `budget`) | audit trail present |

---

## T3 — Digest threading (D4)

**Goal:** digest flows between stages and survives crash-resume.

| # | Step | Expected |
|---|------|----------|
| T3.1 | Run a multi-stage story; capture digest from context stage | digest ≤250 tokens, deterministic string |
| T3.2 | Re-run the same story cold; compare captured digests | byte-identical |
| T3.3 | Implementer stage manifest shows a chunk with `kind: "digest"` containing the context-stage digest | chunk present |
| T3.4 | Kill the run mid-story (Ctrl-C during implementer), resume via `nax run --resume` | stage picks up with the same digest |

---

## T4 — Amendment A: Pollution prevention

**Goal:** min-score floor + staleness flag + pollution metrics fire.

| # | Step | Expected |
|---|------|----------|
| T4.1 | Set `context.v2.minScore: 0.5` (aggressive) | config loaded |
| T4.2 | Run a story; inspect manifest | `droppedBelowMinScore[]` is non-empty |
| T4.3 | Check `StoryMetrics.context.pollution` in the run report | fields present: `droppedBelowMinScore`, `staleChunksInjected`, `pollutionRatio` |
| T4.4 | Artificially age a feature context chunk (edit `context.md` timestamp metadata), re-run | staleness flag appears on chunk; scoreMultiplier applied |
| T4.5 | If `pollutionRatio > 0.3`, `nax status` warns | terminal output |

---

## T5 — Amendment B: Plan digest boost (AC-51)

**Goal:** single-session / batch modes give plan digest a scoring boost.

| # | Step | Expected |
|---|------|----------|
| T5.1 | Run a story with `execution.mode: "single-session"` | plan stage runs, digest generated |
| T5.2 | Inspect implementer manifest → find digest chunk | `rawScore` higher than unboosted chunk baseline (≈1.5×) |
| T5.3 | Run the same story with `execution.mode: "three-session-tdd"` | boost not applied (not in opt-in set) |

---

## T6 — Amendment C: Monorepo dual-workdir

**Goal:** `repoRoot` + `packageDir` resolution is correct for monorepo and non-monorepo.

### T6a — Non-monorepo

| # | Step | Expected |
|---|------|----------|
| T6a.1 | Run on a single-package repo (no `packages/`) | `packageDir === repoRoot` in manifest |
| T6a.2 | Git history provider returns repo-wide diffs | `gitHistory` provider result non-empty when files changed anywhere |
| T6a.3 | Code neighbor provider scope behavior unchanged vs. baseline | parity with prior behaviour |

### T6b — Monorepo

| # | Step | Expected |
|---|------|----------|
| T6b.1 | In a workspace with `packages/api/` and `packages/web/`, run a story whose `touchedFiles` lie under `packages/api/` | manifest records `repoRoot` = workspace root, `packageDir` ends with `/packages/api` |
| T6b.2 | `GitHistoryProvider` with `historyScope: "package"` (default) returns only commits touching `packages/api/` | provider result scoped |
| T6b.3 | Override `historyScope: "repo"` in config — re-run | provider returns full-repo commits |
| T6b.4 | `CodeNeighborProvider` with `crossPackageDepth: 1` resolves imports into `packages/shared/` | shared-package neighbors appear in manifest |
| T6b.5 | Place `<packageDir>/.nax/rules/package-local.md` same-name as a repo-level rule — re-run | package file wins (AC-57); manifest shows package path, not repo path |

---

## T7 — Canonical rules loader

**Goal:** `.nax/rules/` is the source of truth; legacy fallback works under flag.

| # | Step | Expected |
|---|------|----------|
| T7.1 | In a project with `.nax/rules/core.md` + `.nax/rules/testing/unit.md` (one-level nested), run `nax run` | both files loaded into static-rules chunk |
| T7.2 | Add `.nax/rules/bad/deeper/evil.md` (depth 2) | warning logged; file ignored |
| T7.3 | Add a rule with banned marker `<system-reminder>`, no allow comment | loader throws `NEUTRALITY_VIOLATION`; run aborts with clear error |
| T7.4 | Add `<!-- nax-rules-allow: system-reminder-example -->` on the same line as the banned marker | loader accepts; warning logged |
| T7.5 | Rule with malformed YAML frontmatter | throws `RULES_FRONTMATTER_INVALID` |
| T7.6 | Rule with `appliesTo: ["src/api/**"]` + story `touchedFiles: ["src/web/page.tsx"]` | rule filtered out (not injected) |
| T7.7 | Delete `.nax/rules/`, set `allowLegacyClaudeMd: true`, add `CLAUDE.md` + `.claude/rules/foo.md` | legacy path loads; deprecation warning logged |
| T7.8 | Same as T7.7 but `allowLegacyClaudeMd: false` | static-rules chunk empty; pipeline continues |

---

## T8 — `nax rules` CLI

| # | Step | Expected |
|---|------|----------|
| T8.1 | `nax rules export --agent=claude` | writes `CLAUDE.md` with AUTO-GENERATED header |
| T8.2 | Manually edit the exported file, re-run export | manual edits lost; content regenerated from `.nax/rules/` |
| T8.3 | `nax rules export --agent=codex` | writes `AGENTS.md` |
| T8.4 | `nax rules migrate --dry-run` on a project with only `.claude/rules/` | prints planned output, no files written |
| T8.5 | `nax rules migrate` (no dry-run) | writes `.nax/rules/` draft; linter run; violations reported |
| T8.6 | Re-run migrate on already-neutral `.nax/rules/` | no-op / zero diff |

---

## T9 — Session manager lifecycle (ADR-011)

**Goal:** state machine transitions correctly across happy + failure paths.

| # | Step | Expected |
|---|------|----------|
| T9.1 | Run a story to success; inspect `SessionDescriptor` snapshots across stages (via debug log `session` topic) | `CREATED → RUNNING → COMPLETED` |
| T9.2 | Force a deterministic agent failure (e.g. agent command `exit 1`) | session transitions to `FAILED` (not `COMPLETED`) |
| T9.3 | In the same failing run, verify `closePhysicalSession` invoked with `{ force: true }` (log: `adapter` topic) | AC-83 fires end-to-end |
| T9.4 | Verify `index.json` written at `.nax/sessions/index.json` with session record | file exists, structured |
| T9.5 | Run two parallel stories; confirm both share one `SessionManager` instance via log correlation | `SessionManager created` logged once per run |
| T9.6 | Leave a non-terminal session behind (kill run mid-stage), wait > `orphanTtlMs`, start a new run | orphan sweep logs orphan detection; session entry cleared |

---

## T10 — Agent fallback (SPEC-context-engine-agent-fallback)

**Goal:** availability failures trigger fallback; quality failures do not (unless opt-in); multi-hop + exhaustion behaviour.

Requires a configurable "force failure" mode on the primary agent — use a mock model endpoint or a deliberately misconfigured API key.

| # | Step | Expected |
|---|------|----------|
| T10.1 | Set `context.v2.fallback.map: { claude: ["codex"] }`, force primary to return rate-limit error | adapter error classified as `availability`, fallback triggers |
| T10.2 | Inspect logs → `Agent-swap triggered` entry with `fromAgent: claude, toAgent: codex, hop: 1` | log present |
| T10.3 | `ctx.agentFallbacks[]` surfaced as `StoryMetrics.fallback.hops[]` | run report shows hop record |
| T10.4 | Rebuild manifest written at `.nax/features/<f>/stories/<s>/rebuild-<requestId>.json` | file present |
| T10.5 | New agent's prompt includes the failure-note chunk (grep push markdown capture for `prior agent failed`) | note present |
| T10.6 | Set `map: { claude: ["codex", "gemini"] }`, force both primary + codex to fail | second swap triggers; hop: 2 |
| T10.7 | Force all three to fail; pipeline returns `action: "escalate"` | escalation path taken |
| T10.8 | Force a quality failure (valid exit code, failing review) with default `onQualityFailure: false` | no swap; escalation instead |
| T10.9 | Enable `onQualityFailure: true`; repeat T10.8 | swap triggers on same-tier |
| T10.10 | Exceed `maxHopsPerStory` bound | bound respected; no further swaps |

---

## T11 — Handoff preserves session identity

| # | Step | Expected |
|---|------|----------|
| T11.1 | On a fallback swap, compare pre- and post-swap `sessionId` | identical |
| T11.2 | `scratchDir` unchanged | pointer to same path |
| T11.3 | New agent reads scratch entries written by prior agent, with `writtenByAgent` field visible for neutralization logic | scratch provider delivers neutralized view |
| T11.4 | `handoff()` logs `from → to` agent, updates `SessionDescriptor.agent` | log + descriptor updated |

---

## T12 — Scratch retention (AC-20) + neutralization (AC-42)

| # | Step | Expected |
|---|------|----------|
| T12.1 | Set `sessionManager.retentionDays: 1`; age old scratch directory (touch with old mtime) | `purgeStaleScratch` removes it at run completion |
| T12.2 | Verify log: `Purged stale scratch` with path + age | log present |
| T12.3 | Write a scratch entry mentioning a Claude-specific tool (`the Grep tool`) | on fallback to codex, scratch provider rewrites the entry so Claude-specific references are dropped |

---

## T13 — Observability + determinism

| # | Step | Expected |
|---|------|----------|
| T13.1 | Run the same story twice with `request.deterministic: true` | manifests byte-identical for deterministic providers |
| T13.2 | Non-deterministic providers absent from deterministic runs | provider missing from `providerResults[]` |
| T13.3 | `StoryMetrics.context.providers[*].costUsd` populated for cost-reporting providers | run report |
| T13.4 | `nax status` surfaces context metrics summary | terminal output |

---

## T14 — Regression sweep

| # | Step | Expected |
|---|------|----------|
| T14.1 | Run a story with `context.v2.enabled: false` (v1 path) | story completes; no manifest produced; legacy behaviour |
| T14.2 | Run three stories in parallel (`parallel: true`) | all complete; session manager dedupes story IDs; per-story manifests isolated |
| T14.3 | Run a no-test story (`execution.mode: "no-test"`) | story completes; rectify only fires on review findings |
| T14.4 | Run an interactive flow that hits `merge-conflict` trigger | session transitions to `FAILED`; force-close fires |
| T14.5 | Run a run that hits `sessionTimeoutSeconds` | adapter returns timeout; session transitions to `FAILED` |

---

## T15 — Documentation + CLI help

| # | Step | Expected |
|---|------|----------|
| T15.1 | `nax --help` lists `context` + `rules` sub-commands | correct |
| T15.2 | `nax context --help`, `nax rules --help` list subcommands with flags | correct |
| T15.3 | ADR-008 / ADR-010 / ADR-011 render correctly on GitHub (link check) | links resolve |

---

## T16 — Dogfood (advisory, not release-gating)

**Goal:** validate the canary against real agent calls / real filesystem / real timing that the deterministic tests cannot model. Closes SPEC-context-engine-canonical-rules AC-19 (rules-dogfood) as a side effect.

**Target build:** `npm i -g @nathapp/nax@0.63.0-canary.1` (or whichever canary is under test). Confirm with `nax --version`.

**Fallback binary:** keep `@nathapp/nax@0.62.0` installed at a pinned path (`npx nax@0.62.0`) as a known-good reference for A/B comparison if a result looks suspicious.

**Repo:** `~/Desktop/projects/nathapp/nax-dogfood/` — four scoped fixtures seeded alongside this PR (see [nax-dogfood/README.md](../../../nax-dogfood/README.md)).

### Phase 1 — Smoke (four fixtures, ~20 min total, ~$1–2)

| # | Command | What it exercises | Expected |
|---|---------|-------------------|----------|
| T16.1 | `cd nax-dogfood/fixtures/hello-lint && nax run` | v2 engine on simplest path: single-session, no-test, tiny push markdown | story passes, manifest at `.nax/features/hello-lint/stories/US-001/context-manifest-context.json`, `buildMs < 500` |
| T16.2 | `cd nax-dogfood/fixtures/tdd-calc && nax run` | three-session-tdd: test-writer → implementer → verifier handoff, digest threading | all three sessions spawn, three stage manifests written, test suite passes at verify stage |
| T16.3 | Unset `ANTHROPIC_API_KEY`, `cd nax-dogfood/fixtures/fallback-probe && nax run` | availability fallback: primary fails auth, swap to codex, rebuild manifest + failure-note chunk | `Agent-swap triggered` in logs, `ctx.agentFallbacks[]` in run report, `rebuild-*.json` manifest present |
| T16.4 | `cd nax-dogfood/fixtures/monorepo-tiny && nax run` | Amendment C: dual-workdir scoping; story touches only `packages/lib` | manifest records `packageDir` ending in `/packages/lib`, `repoRoot` at workspace root, provider scopes package-level |

**Gate between phases:** Phase 1 must pass before proceeding to Phase 2. If T16.1 fails, STOP — something is broken at the smoke level; rerun synthetic T1 to confirm.

### Phase 2 — Rules dogfood on nax itself (~5 min)

Closes SPEC-context-engine-canonical-rules AC-19.

| # | Command | Expected |
|---|---------|----------|
| T16.5 | `cd ai-coder/ngent && nax rules migrate --dry-run` | prints planned `.nax/rules/` layout; no files written; linter findings reported |
| T16.6 | `nax rules migrate` | writes `.nax/rules/` draft; existing `.claude/rules/` preserved for now |
| T16.7 | `nax rules export --agent=claude` | regenerates `CLAUDE.md` from `.nax/rules/`; previous CLAUDE.md content replaced with auto-generated header |
| T16.8 | `git diff CLAUDE.md` | diff is content-equivalent (same rules, possibly reordered); no banned-marker violations introduced |
| T16.9 | Commit result on a branch `chore/rules-dogfood-v0.63.0` | baseline for future release comparisons |

### Phase 3 — Heavy integration: koda memory-guardrails (~30–60 min, real $)

Runs the existing real feature that would otherwise ship regardless. Uses the canary as the runner. This is the final confidence check.

| # | Command | Expected |
|---|---------|----------|
| T16.10 | `cd ~/Desktop/projects/nathapp/koda && nax run --feature memory-guardrails` | all stories progress through their pipelines; parallel stories do not cross-contaminate (storyId in every log line per `.claude/rules/project-conventions.md` logging rules) |
| T16.11 | Any story that ran under three-session-tdd produces three distinct stage manifests + a session-scratch read on the implementer side | manifest files + scratch JSONL inspection |
| T16.12 | Run completes with no orphaned sessions (check `nax status` and `.nax/sessions/index.json` — terminal-state-only) | no stale entries |

### Dogfood report template

After running, append one entry to `nax-dogfood/release-log.md`:

```
## v0.63.0-canary.1 — <date>
- Runtime: T16.1 <s> / T16.2 <s> / T16.3 <s> / T16.4 <s> / T16.10 <s>
- Cost: $<amount>
- Phase 1: PASS / FAIL
- Phase 2: PASS / FAIL  (AC-19 closed: yes / no)
- Phase 3: PASS / FAIL
- Observations: <one paragraph>
- Issues filed: <list or "none">
```

### Gate

Dogfood is **advisory**. Findings surface DX / docs / message issues that should be fixed but don't block the release unless the finding is a P0 regression (data loss, silent corruption, state-machine break). Hard gates for blocking remain T1 / T9.2-3 / T10.1/7 / T14.1.

### Bootstrap mitigation

If the canary is broken badly enough to block its own validation (e.g. `nax run` crashes before writing any manifest), fall back to running the dogfood against the previous release:

```bash
npx @nathapp/nax@0.62.0 run   # known-good reference
```

Then compare behaviour vs. the canary to isolate which subsystem regressed.

---

## Sign-off

| Role | Name | Date | Result |
|------|------|------|--------|
| Release engineer | | | Pass / Fail |
| Reviewer (context-engine) | | | Pass / Fail |
| Reviewer (session-manager) | | | Pass / Fail |

**Pass criteria:** every `Expected` column satisfied OR a waived item has a documented reason linked to an issue.

**Fail criteria (any of):**
- T1 (smoke) fails
- T9.2 or T9.3 fails (session state / force-terminate regression — directly negates H-1)
- T10.1 or T10.7 fails (fallback regression)
- T14.1 fails (v1 path regression — back-compat broken)

---

## Rollback plan

If a P0 / P1 issue is found post-release:

1. Revert PR #520 (single clean revert — all 14 commits live on the same branch head).
2. Tag a hotfix release from the reverted state.
3. File a postmortem issue referencing the failed T-case.

The reverted branch state is known-good (4 prior review passes + full test suite green at `f3bae3f3`).

---

## Follow-ups tracked separately

These do not gate the release but should be revisited in the next iteration:

- **#517** — H-1 (FAILED transition + AC-83 wiring) — **closed by this release**
- **#518** — H-2 fallback credentials validation at run start
- **#519** — M-3 run-level fallback aggregates

## Related

- [ADR-010](../adr/ADR-010-context-engine.md) — context engine decisions
- [ADR-011](../adr/ADR-011-session-manager-ownership.md) — session manager ownership
- [ADR-008](../adr/ADR-008-session-lifecycle.md) — per-role policy (partially superseded)
- [context-engine-v2-deep-review-2026-04-18.md](../reviews/context-engine-v2-deep-review-2026-04-18.md) — AC coverage audit behind this plan
