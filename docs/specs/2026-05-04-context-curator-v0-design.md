# Design Note: Context Curator v0 — deterministic post-run proposals

**Date:** 2026-05-04
**Status:** Pre-implementation — settles open questions before PR work begins
**Driver:** [docs/findings/2026-04-30-context-curator-design.md](../findings/2026-04-30-context-curator-design.md) — finding doc that explored the problem space, proposed the v0/v1 split, and settled the unification debate (curator unifies at the projection layer, not the runtime).
**Issue:** [#901](https://github.com/nathapp-io/nax/issues/901)
**Depends on:** [#900](https://github.com/nathapp-io/nax/issues/900) (folder split — optional; curator can ship before #900 lands as long as path expectations match)

---

## 1. Problem statement

After every nax run, the operator must manually decide what should be added to `.nax/features/<id>/context.md` or `.nax/rules/*.md`, and what should be dropped. The signal lives in run artifacts (manifests, run jsonl, audit JSONs, metrics) but no tool harvests it. As context.md and the rules dir grow, drift sets in: stale entries waste budget, missing entries cause repeated rectification cycles.

This spec implements the **v0 deterministic curator** — frequency counts, manifest joins, status flags, no LLM. Per the finding doc Step 3, **6 of 8 Tier 1 sources are usable today** with two small `logger.info` additions.

**Out of scope (v1+):**
- LLM-distilled proposals (transcript summarisation, prompt audit mining)
- Auto-apply / merge into canonical sources (the keep/drop human gate is the whole point)
- Cross-team rollup sharing via S3/git LFS/Slack/Linear (configurable path unblocks all of these)
- eventLog+blobStore unification (deferred indefinitely per finding doc Step 4 §326)

---

## 2. Architectural decisions

### 2.1 Plugin shape

Curator is implemented as a **built-in `IPostRunAction` plugin**, not an external one. Reasoning:

- It needs to ship enabled by default for dogfood projects.
- Plugin contract ([src/plugins/extensions.ts:247](../../src/plugins/extensions.ts#L247)) already provides post-run timing, plus `shouldRun` for opt-out.
- Registering through the existing plugin loader keeps run-orchestration code plugin-agnostic.

Registered in `src/plugins/builtin/curator.ts` and added to the default registry in `src/plugins/registry.ts`. Plugin name: `nax-curator`. Disabled via `config.curator.enabled: false`.

### 2.2 Projection layer, not runtime layer

Per the finding doc Step 4 conclusion, curator unifies at the **projection layer**: it reads each per-domain artifact in its native shape and writes one normalized table (`observations.jsonl`). It does **not** introduce new runtime primitives, eventLog, or blobStore.

### 2.3 Output location

`<projectOutputDir>/runs/<runId>/observations.jsonl` and `<projectOutputDir>/runs/<runId>/curator-proposals.md`.

`<projectOutputDir>` resolves via the path layer:

| If folder split (#900) is shipped | Otherwise (today) |
|:---|:---|
| `~/.nax/<projectKey>/runs/<runId>/...` | `<workdir>/.nax/runs/<runId>/...` |

Curator code uses a single `runtime.outputDir` (or fallback to `join(workdir, ".nax")`) so it works either way.

### 2.4 Cross-run rollup

`<rollupPath>/curator/rollup.jsonl` — append-only, one row per run, retains `runId`. Default location:

| If folder split (#900) is shipped | Otherwise (today) |
|:---|:---|
| `~/.nax/global/curator/rollup.jsonl` | `<workdir>/.nax/curator/rollup.jsonl` |

Configurable via `config.curator.rollupPath`. (Specified in folder split spec §8; mentioned here only as the integration point.)

---

## 3. Data sources — full inventory

### 3.1 Already structured (curator reads as-is)

| Source | Path | Schema |
|:---|:---|:---|
| Per-story metrics | `metrics.json` | structured array; `firstPassSuccess`, `attempts`, `agentUsed`, `runtimeCrashes`, `tokensProduced`, `chunksKept` |
| Review decisions | `review-audit/<feature>/<epochMs>-<sessionName>.json` | per-decision JSON; `parsed`, `passed`, `result.findings[]`, `failOpen`, `blockingThreshold` |
| Context manifest | `features/<id>/stories/<sid>/context-manifest-<stage>.json` | `includedChunks`, `excludedChunks` (with reasons), `providerResults[]` (status), per-chunk `score` |
| Run jsonl | `<feature>/runs/<ts>.jsonl` | per-event records with `stage`, `storyId`, structured payload |

### 3.2 New `logger.info` emits required for v0

Two small additions verified via 2026-05-04 codebase audit:

| Emit | File | Insertion point |
|:---|:---|:---|
| `logger.info("pull-tool", "invoked", { storyId, tool, keyword, resultCount })` | [src/context/engine/pull-tools.ts](../../src/context/engine/pull-tools.ts) | One line at end of each handler — `handleQueryNeighbor` (after the truncation return at line 225) and `handleQueryFeatureContext` |
| `logger.info("acceptance", "verdict", { storyId, passed, failedACs, retries, packageDir })` | [src/pipeline/stages/acceptance.ts](../../src/pipeline/stages/acceptance.ts) | One line per story at the per-story termination point — **consolidates** the existing scattered emits at lines 228, 235, 243 (which stay as progress messages) |

### 3.3 Already implemented (no curator code change needed)

| Domain | Where | What |
|:---|:---|:---|
| Fix-cycle iterations | [src/findings/cycle.ts:381](../../src/findings/cycle.ts#L381) | `findings.cycle` stage — `iteration completed`, `cycle exited (5 reasons)`, `validator retry` |
| Rectification cycles | run jsonl `stage:"rectify"` events | already structured |
| Escalation events | run jsonl `stage:"escalation"` events | already structured |

### 3.4 Configuration prerequisites

Curator depends on `review-audit/*.json` files existing. This is gated by:

```json
"review": { "audit": { "enabled": true } }
```

Default is `false` ([src/runtime/index.ts:140-142](../../src/runtime/index.ts#L140-L142)). Curator's `shouldRun()` checks this and emits a one-line warning if disabled, then proceeds with reduced fidelity. Documentation makes the flag flip explicit for adopters.

---

## 4. Observation schema

Source: finding doc §2 Layer A. Reproduced here for spec completeness — the schema is the contract consumers (proposal generator, rollup, future v1) will see.

```typescript
export type Observation = {
  // identity
  runId: string;
  featureId: string;
  storyId: string;
  stage: string;          // "execution" | "review" | "rectify" | …
  ts: string;             // ISO timestamp

  kind:
    | "chunk-included"
    | "chunk-excluded"
    | "provider-empty"
    | "review-finding"
    | "rectify-cycle"
    | "escalation"
    | "acceptance-verdict"          // renamed from acceptance-fail — reflects unified verdict event
    | "pull-call"
    | "co-change"
    | "verdict"                     // story-level verdict from metrics.json
    | "fix-cycle.iteration"         // from findings.cycle
    | "fix-cycle.exit"              // from findings.cycle
    | "fix-cycle.validator-retry";  // from findings.cycle

  // discriminated payload — only fields relevant to `kind`
  payload: {
    chunkId?: string;          // chunk-* and pull-call
    providerId?: string;       // chunk-* and provider-empty
    reason?: string;           // chunk-excluded reason or fix-cycle.exit reason
    score?: number;            // 0..1 — chunk-*
    checkId?: string;          // review-finding
    severity?: "low" | "med" | "high";
    keyword?: string;          // pull-call (query_feature_context)
    resultCount?: number;      // pull-call
    fromTier?: string;         // escalation
    toTier?: string;           // escalation
    files?: string[];          // co-change
    verdict?: "passed" | "failed" | "aborted";  // verdict + acceptance-verdict
    failedACs?: string[];      // acceptance-verdict
    retries?: number;          // acceptance-verdict
    cycleName?: string;        // fix-cycle.*
    iterationNum?: number;     // fix-cycle.iteration / validator-retry
    outcome?: "resolved" | "partial" | "regressed" | "unchanged" | "regressed-different-source";
    findingsBefore?: number;
    findingsAfter?: number;
    costUsd?: number;
  };
};
```

**Schema versioning:** v0 ships with `schemaVersion: 1` as a top-level field on each row. Tolerant parsers; never reuse field names across versions. (Per finding doc Step 4 R2 mitigation.)

---

## 5. Curator plugin lifecycle

### 5.1 `shouldRun(context: PostRunContext) → boolean`

```typescript
async shouldRun(context) {
  if (config.curator?.enabled === false) return false;       // explicit opt-out
  if (context.storySummary.completed === 0) return false;    // nothing to curate
  return true;
}
```

### 5.2 `execute(context: PostRunContext)`

Three phases, each with its own helper module so each can be unit-tested in isolation:

| Phase | Module | Output |
|:---|:---|:---|
| 1. Collect | `src/plugins/builtin/curator/collect.ts` | `Observation[]` — read each Tier 1 source, project to schema |
| 2. Heuristic | `src/plugins/builtin/curator/heuristics.ts` | `Proposal[]` — group_by + threshold → candidate adds/drops |
| 3. Render | `src/plugins/builtin/curator/render.ts` | Two side-effects: write `observations.jsonl`, write `curator-proposals.md` |

Plus rollup append (§5.3).

### 5.3 Cross-run rollup append

After Phase 3, append every observation to `<rollupPath>/curator/rollup.jsonl` with `runId` retained. Rollup is append-only; never rewritten. `mkdir -p` once on first run.

Concurrency: multiple runs writing to the same rollup file — POSIX append is atomic per-line at sub-PIPE_BUF size; observation rows are well below this threshold. No locking needed.

### 5.4 Failure handling

The plugin runs post-run, so a curator failure must never affect the run's exit code. All disk writes are wrapped in try/catch; on error, log a warning with context and continue. Partial output (e.g., `observations.jsonl` written but proposals failed) is acceptable — the next run regenerates from artifacts, not from the previous proposal file.

---

## 6. Heuristics for v0

Six heuristics, all deterministic group-by queries against `observations.jsonl`. Each yields proposal candidates with severity (`HIGH` / `MED` / `LOW`).

| ID | Heuristic | Source `kind` | Threshold | Proposal type | Severity |
|:---|:---|:---|:---|:---|:---|
| H1 | Repeated review finding | `review-finding` | `count(checkId) ≥ 2` across stories | Add to `.nax/rules/<inferred-domain>.md` | MED if 2-3, HIGH if ≥ 4 |
| H2 | Pull-tool empty result | `pull-call` where `resultCount=0` | same `keyword` ≥ 2× | Add to `.nax/features/<id>/context.md` | MED |
| H3 | Repeated rectification cycle | `rectify-cycle` | `attempts ≥ 2` for same story | Add to `.nax/features/<id>/context.md` (context likely missed something) | HIGH |
| H4 | Escalation chain | `escalation` | `fromTier→toTier ≥ 2` for same story type | Add to `.nax/features/<id>/context.md` | MED |
| H5 | Stale chunk | `chunk-excluded` where `reason="stale"` | story still passed AND chunk excluded ≥ 2 runs back | Drop from `.nax/rules/...` | LOW |
| H6 | Fix-cycle unchanged outcome | `fix-cycle.iteration` where `outcome="unchanged"` | `≥ 2` consecutive | Diagnose prompt may be wrong (advisory; no canonical-source target) | LOW |

Thresholds in v0 are **starting guesses** per finding doc §428–432. Spec ships with calibration as a follow-up: koda dogfood validates real-world thresholds before promoting any rule to a default.

Threshold values live in config:
```json
"curator": {
  "thresholds": {
    "repeatedFinding": 2,
    "emptyKeyword": 2,
    "rectifyAttempts": 2,
    "escalationChain": 2,
    "staleChunkRuns": 2,
    "unchangedOutcome": 2
  }
}
```

---

## 7. Proposal output format

`curator-proposals.md` — one file per run. Markdown with grouped checkbox sections so the operator can review and accept.

```markdown
# Curator proposals — run abc123

Generated: 2026-05-04T10:00:00Z
Heuristics fired: 4
Observations: 47

## Add to .nax/features/auth/context.md
- [ ] [HIGH] (H3) Postgres connection cap — story story-001 ran 3 rectify cycles
- [ ] [MED] (H2) "review batch" pull-tool returned empty 2× across stories story-002, story-003

## Add to .nax/rules/api-data.md
- [ ] [HIGH] (H1) "never N+1 on /v2/reviews" — review finding fired in 4 stories

## Drop from .nax/rules/web.md
- [ ] [LOW] (H5) line 23–28 — never matched in last 30 days of manifests

## Advisory (no auto-target)
- [ ] [LOW] (H6) story-007 fix-cycle "acceptance" stuck on `unchanged` outcome 2× — diagnose prompt may need review
```

Each line carries:
- Severity in brackets
- Heuristic ID for traceability back to the rule
- Concise description with concrete evidence (counts, story IDs, paths)

---

## 8. Apply UX — open question

Two paths, neither decided:

| Option | Pros | Cons |
|:---|:---|:---|
| (a) **Plain editing of proposals.md** + follow-up `nax curator commit` | Zero new UI; user uses their normal editor; standard checkbox UX | Manual; user has to open the file |
| (b) **Interactive CLI** — `nax curator apply <runId>` walks each proposal one-by-one with accept/reject | Guided; faster for many proposals | New TTY UX to design + maintain |

**Recommendation: ship (a) for v0.** Lower cost; uses existing tools; the markdown file is already useful documentation even without "apply." (b) can be added in v0.5 if user feedback says editing is too friction-heavy.

`nax curator commit` (the follow-up command for option (a)):
1. Read `<runId>/curator-proposals.md`
2. Parse checked `[x]` lines
3. For each checked line, apply the proposed change (append to `.nax/features/<id>/context.md`, append to `.nax/rules/<file>.md`, or remove a line range from a rules file)
4. Open the modified canonical files in `$EDITOR` for human review before commit (do not git-commit automatically)
5. Print summary: "applied N proposals, modified M files"

---

## 9. CLI surface

```
nax curator status [--run <runId>]   # show observations + proposals for last (or given) run
nax curator commit <runId>            # apply checked proposals to canonical sources
nax curator dryrun                    # re-run heuristics on existing observations.jsonl
                                      # (useful when calibrating thresholds)
nax curator gc [--keep <N>]           # prune old run dirs from rollup (defaults: keep 50)
```

`nax run` produces curator output automatically (post-run plugin); explicit subcommands are for inspection and apply.

---

## 10. Risk register

| ID | Risk | Severity | Mitigation |
|:---|:---|:---|:---|
| R1 | **`review.audit.enabled: false` by default** — most projects won't have review-audit JSONs to ingest. Curator quality drops. | High | Curator's `shouldRun` checks the flag and emits a clear warning: "review.audit.enabled is off — proposal quality will be reduced. Enable in `.nax/config.json`." Documentation makes the flag prominent. |
| R2 | **Threshold calibration** — `≥2` is a guess; real signal-to-noise unknown. | High | Ship with config-driven thresholds (§6). Document koda dogfood as the calibration source for v0.5 defaults. |
| R3 | **Schema drift** — `Observation` payloads need to evolve (new `kind`s, new fields). Old rollup rows still exist. | Medium | `schemaVersion` field on every row; tolerant parsers; never reuse field names across versions. |
| R4 | **Run jsonl payload drift** — `logger.info("pull-tool", …)` shape can drift as stages evolve. Curator's parser breaks silently. | Medium | Tolerant parsers (default missing fields to undefined, log warning). Schema lives in code (`schemas.ts`) for the curator, regenerated when emit shape changes. Integration test reads sample run jsonl and projects to observations end-to-end. |
| R5 | **Performance on large runs** — 1000-story run could produce millions of observation rows. | Medium | observations.jsonl is per-runId, JSONL append is O(1). Rollup is append-only, periodic GC via `nax curator gc`. No real concern at current koda/nax scale (~10s of stories per run). |
| R6 | **Cross-run rollup as personal data** — when sharing rollup (#900 §8 patterns), rows include workdir paths and story content. May leak. | Low | v0: per-user only. Sharing is opt-in via configurable path; document the leak surface. |
| R7 | **Plugin running on aborted runs** — `IPostRunAction` runs even on failure. Curator may write proposals from a corrupted run. | Low | `shouldRun` checks `context.storySummary.completed > 0`. Aborted-mid-story runs still complete observations for completed stories; partial data is honest data. |
| R8 | **Apply UX collisions** — user accepts H1 "add rule X" and H5 "drop rule X" in the same proposal file. | Low | `nax curator commit` validates: drops apply first, adds second. Conflicts (same line target) abort with a clear message; user resolves manually. |
| R9 | **Rules file ambiguity** — H1 says "add to `.nax/rules/<inferred-domain>.md`" but inferring the domain from a check ID is fuzzy. | Medium | v0: don't infer. Default target is `.nax/rules/curator-suggestions.md` (a single staging file the user reviews and re-files manually). v1 can attempt domain inference. |
| R10 | **Idempotent re-run** — running curator twice on the same run shouldn't double-write. | Low | Output paths are deterministic per-runId; second run overwrites observations.jsonl and proposals.md. Rollup append is the only append-only path; `runId` dedup on read. |

---

## 11. Implementation sequence

Eight PRs **plus a dogfood phase between PR 7 and PR 8**. Steps 1, 2, and 3 are independent of each other and of curator itself (they're emit shape changes); steps 4–7 are the curator proper. Dogfood is real-time on koda after the curator ships, not a PR-scope activity. PR 8 is a small calibration follow-up that commits tuned thresholds.

### PR 1 — Pull-tool logger emits

**Files:** [src/context/engine/pull-tools.ts](../../src/context/engine/pull-tools.ts)

```typescript
// At the end of handleQueryNeighbor (after the truncation return)
getLogger().info("pull-tool", "invoked", {
  storyId: "_pull-tool",  // current handler hardcodes this; pass storyId through if available
  tool: "query_neighbor",
  filePath: input.filePath,
  resultCount: result.chunks.length,
  resultBytes: content.length,
  truncated: content.length > maxChars,
});

// Same shape in handleQueryFeatureContext
getLogger().info("pull-tool", "invoked", {
  storyId: story.id,
  tool: "query_feature_context",
  keyword: input.filter ?? null,
  resultCount: filteredSections,
  resultBytes: content.length,
});
```

Tests: assert emit fires with expected shape; assert `resultCount=0` is emitted when content is empty (the curator H2 heuristic depends on this).

### PR 2 — Acceptance verdict consolidation

**Files:** [src/pipeline/stages/acceptance.ts](../../src/pipeline/stages/acceptance.ts)

Existing emits at lines 228, 235, 243 stay as progress messages. Add one canonical verdict event at per-story termination:

```typescript
// Once per story at acceptance stage exit (whether passed or failed)
logger.info("acceptance", "verdict", {
  storyId: ctx.story.id,
  packageDir: ctx.packageDir,
  passed,
  failedACs,           // [] if passed
  retries,             // hardening pass count
  durationMs,
});
```

Tests: assert verdict fires once per story regardless of pass/fail; assert payload shape stable across pass and fail paths.

### PR 3 — `ReviewDecisionEvent` bus channel (optional, independent)

**Files:** [src/runtime/dispatch-events.ts](../../src/runtime/dispatch-events.ts), [src/runtime/middleware/review-audit.ts](../../src/runtime/middleware/review-audit.ts), [src/review/{semantic,adversarial,semantic-debate}.ts](../../src/review/)

Add typed `ReviewDecisionEvent` channel; route the 4 direct `recordDecision` calls through the bus. ~50 LOC. Closes the asymmetry from finding doc R11. **Independent of curator** — no behavior change for curator if shipped, just cleaner runtime architecture.

This PR can ship before, after, or never relative to curator. Listed here for cross-reference only.

### PR 4 — Curator plugin scaffold + observation projection

**New files:**
- `src/plugins/builtin/curator/index.ts` — `IPostRunAction` registration
- `src/plugins/builtin/curator/collect.ts` — read all Tier 1 sources, project to `Observation[]`
- `src/plugins/builtin/curator/types.ts` — `Observation`, `Proposal` schemas
- `src/plugins/builtin/curator/paths.ts` — resolves `outputDir`, `rollupPath`

**Modified files:**
- `src/plugins/registry.ts` — register `nax-curator` in default builtins
- `src/config/schemas.ts` — add `curator` section
- `src/config/selectors.ts` — add `curatorConfigSelector`

Phase 1 only (collect + write `observations.jsonl`). No heuristics yet. Tests: feed sample run artifacts, assert correct projection to schema.

### PR 5 — Heuristics + proposal generation

**New files:**
- `src/plugins/builtin/curator/heuristics.ts` — 6 heuristics from §6
- `src/plugins/builtin/curator/render.ts` — markdown generator from §7
- `src/plugins/builtin/curator/rollup.ts` — append-only rollup writer

**Modified files:**
- `src/plugins/builtin/curator/index.ts` — wire phase 2 (heuristics) + phase 3 (render)

Tests: each heuristic in isolation with synthetic observation inputs; render with one proposal per category.

### PR 6 — `nax curator` CLI subcommands

**New files:** `src/commands/curator.ts` implementing §9.

`status`, `commit`, `dryrun`, `gc`. `commit` is the apply UX (option (a) per §8); opens modified files in `$EDITOR` after applying.

### PR 7 — Documentation

- `docs/guides/curator.md` — new guide: how curator works, how to enable, how to apply proposals, threshold tuning
- `docs/architecture/subsystems.md` — add §curator
- README — add "Curator" to features list
- Update [docs/findings/2026-04-30-context-curator-design.md](../findings/2026-04-30-context-curator-design.md) status to "Implemented in v0; see this spec"

### Dogfood phase (between PR 7 and PR 8)

PRs 1–7 ship the v0 curator end-to-end. **Dogfood happens after**, in real time, on koda — not inside any single PR. The phase is open-ended; it ends when enough run signal has accumulated to commit calibrated threshold defaults.

**Activities during dogfood:**
- Enable curator on koda (`config.curator.enabled: true`, `config.review.audit.enabled: true`).
- Run nax over koda stories as usual; curator produces proposals automatically post-run.
- Operator reviews `curator-proposals.md` after each run; accepts/rejects via `nax curator commit`.
- Track signal-to-noise per heuristic: how many proposals were accepted vs rejected, and why.
- Optional: backfill observations over koda's existing run artifacts via `nax curator dryrun --backfill <runId>` to bootstrap a rollup faster.

**Exit criteria for the dogfood phase:**
- ≥ 20 koda runs have produced curator proposals.
- For each heuristic (H1–H6): ≥ 1 accept and ≥ 1 reject in the dogfood window (gives signal both directions).
- Operator has a defensible threshold value per heuristic, with a one-line rationale ("at threshold ≥ 2, H1 had 80% accept rate; at ≥ 3, only 40% — keep at 2").

### PR 8 — Calibrated threshold defaults

Small follow-up PR after dogfood. Commits the tuned threshold values from the dogfood phase to `src/config/schemas.ts` defaults. Includes a migration note in `CHANGELOG.md` so existing users see the rationale.

This PR finalizes v0 readiness for general adoption.

---

## 12. Open questions

1. **Apply UX (§8)** — confirm option (a) plain-editing for v0?
2. **Threshold defaults** — ship with `≥2` everywhere, calibrate in PR8?
3. **`shouldRun` behavior on review-audit disabled** — warn-and-continue (current proposal) or warn-and-skip-curator?
4. **Rollup retention policy** — `nax curator gc --keep 50` is the default; should retention be time-based or count-based by default? Lean: count, simpler.
5. **`Observation.payload.runId` retention in rollup** — every row carries `runId`; should the rollup format be one-row-per-run (summary) or one-row-per-observation (detail)? Lean: detail for v0 (can compress to summary later if size is a problem).

---

## 13. Non-goals (restated)

- LLM-distilled proposals → v1
- Auto-apply to canonical sources → never (the keep/drop human gate is the design)
- eventLog+blobStore unification → deferred indefinitely
- Cross-team rollup sync backends (S3, git LFS, Slack, Linear) → separate designs
- Domain inference for rule-file targeting → defer to v0.5; v0 stages all suggestions in `.nax/rules/curator-suggestions.md`
- Auto-staleness detection for curator's own state → not applicable; curator is stateless across runs (rollup excepted)

---

## 14. References

- [docs/findings/2026-04-30-context-curator-design.md](../findings/2026-04-30-context-curator-design.md) — driver finding doc
- [docs/specs/2026-05-04-nax-folder-split-design.md](./2026-05-04-nax-folder-split-design.md) — companion spec for output paths
- [src/plugins/extensions.ts:247](../../src/plugins/extensions.ts#L247) — `IPostRunAction` interface
- [src/findings/cycle.ts:381](../../src/findings/cycle.ts#L381) — fix-cycle logger contract (already implemented)
- [src/pipeline/stages/acceptance.ts:228-243](../../src/pipeline/stages/acceptance.ts#L228-L243) — existing acceptance emits to consolidate
- [src/context/engine/pull-tools.ts:201-265](../../src/context/engine/pull-tools.ts#L201-L265) — pull-tool handlers needing emits
- [src/runtime/dispatch-events.ts](../../src/runtime/dispatch-events.ts) — bus contract (R11 from finding doc)
