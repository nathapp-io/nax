# Context Curator — Design Notes

**Date:** 2026-04-30
**Status:** Design exploration — no code yet
**Driver:** Koda dogfood; manual maintenance of `context.md` + `.nax/rules/` doesn't scale across runs.

---

## Problem

After every nax run, the user (or operator) has to decide:

- Did anything happen this run that should be added to `.nax/features/<id>/context.md`?
- Did any review finding repeat enough times to warrant a new rule in `.nax/rules/*.md`?
- Are any existing rules / `context.md` entries unused and should be dropped?

Today this is fully manual. The signal is in the run artifacts (manifests, run logs, sessions) but no tool harvests it. As `context.md` and the rules directory grow, drift sets in: stale entries waste budget, missing entries cause repeated rectification cycles.

## Proposal

A **post-run curator** that:

1. Walks the artifacts produced by a finished run.
2. Distills them into a normalized observation log.
3. Generates **proposals** (candidate adds / drops) into a review file.
4. Never writes to `context.md` or `.nax/rules/` directly — the human reviews and accepts.

Implemented as an `IPostRunAction` plugin (existing extension point in nax).

### Why a review queue, not auto-apply

Auto-merging into the canonical sources would corrupt them within a few runs. The keep/drop gate is the whole point — the tool's job is to surface candidates, not to decide.

### v0 vs v1

- **v0 — deterministic.** Frequency counts, manifest joins, status flags. Cheap, reproducible, no LLM cost. ~80% of the value lives here.
- **v1 — LLM-distilled.** Summarises transcripts and prompt audits to extract higher-leverage rules. Defer until v0 ships and the keep/drop UX is validated.

---

## Step 1 — Metadata inventory

Score every artifact on two axes: **signal about whether the agent's context was right** and **cheap to extract deterministically**.

### Tier 1 — high signal, deterministic (use first)

| Source | Path / event | Signal |
|:---|:---|:---|
| Context manifest | `<feature>/stories/<sid>/context-manifest-<stage>.json` | `includedChunks` / `excludedChunks` (with reason: `below-min-score` / `budget` / `stale` / `role-filter` / `dedupe`), `providerResults[].status` (`ok` / `empty` / `failed`), per-chunk `score` |
| Review findings | `run.jsonl` event `review.finding` | Repeated check IDs across stories = candidate rule. Severity + origin (built-in / semantic / adversarial) |
| Rectification cycles | `run.jsonl` event `rectify.attempt` | Cycle count, exit verdict, failing checks each cycle. >1 cycle = context likely missed something |
| Escalation events | `run.jsonl` event `escalation` | `fast → balanced` or `balanced → powerful` triggers — model couldn't solve at tier, often a context problem |
| Acceptance failures | `run.jsonl` event `acceptance.failed` | Failing AC IDs, retry count |
| Pull tool calls | `run.jsonl` event `pull.tool` | `query_feature_context(keyword)` returning empty = missing `context.md` entry; `query_neighbor` repeats on same file = missing static link |
| Story verdict | story status | `passed` / `failed` / `aborted`, plus terminal stage |
| Stage timings | per-stage events | Repeated slow stages on same story type = candidate budget tune |

### Tier 2 — medium signal, deterministic

| Source | Signal |
|:---|:---|
| Session token counts | At budget ceiling and verdict failed → raise budget. At 30% and succeeded → lower budget. |
| Co-changed file pairs | From git diff per story — paired but `code-neighbor` missed the link → candidate static rule. |
| Chunk citation absence | Rule chunk loaded for 30 days with zero downstream session output mentioning its keywords → candidate drop. |

### Tier 3 — high signal, requires LLM (defer to v1)

| Source | Signal | Why deferred |
|:---|:---|:---|
| Prompt audit (full prompt text) | What the agent was actually told | Needs extraction + summarisation |
| Agent transcripts | What the agent reasoned about | Same |
| Commit messages from the run | What the agent thought it did | Cheap to read but ambiguous to interpret |

### Tier 0 — drop (looks useful, isn't)

- Wall-clock duration alone — noisy, depends on cold caches and network.
- Token cost per run — cost ≠ context quality.
- Raw error stack traces — high churn, low pattern signal.

---

## Step 2 — Structured collection schema

nax already writes the artifacts, but as **per-stage** files. The curator needs a **per-run** flat event table to do frequency counts and cross-story joins. Two layers, plus an optional cross-run rollup.

### Layer A — `observations.jsonl` (normalized event, one record per signal)

```
.nax/runs/<runId>/observations.jsonl
```

```typescript
type Observation = {
  // identity
  runId: string;
  featureId: string;
  storyId: string;
  stage: string;          // "execution" | "review" | "rectify" | ...
  ts: string;             // ISO timestamp

  kind:
    | "chunk-included"
    | "chunk-excluded"
    | "provider-empty"
    | "review-finding"
    | "rectify-cycle"
    | "escalation"
    | "acceptance-fail"
    | "pull-call"
    | "co-change"
    | "verdict";

  // discriminated payload — only fields relevant to `kind`
  payload: {
    chunkId?: string;          // chunk-* and pull-call
    providerId?: string;       // chunk-* and provider-empty
    reason?: string;           // chunk-excluded: below-min-score | budget | stale | ...
    score?: number;            // 0..1 — chunk-*
    checkId?: string;          // review-finding
    severity?: "low" | "med" | "high";
    keyword?: string;          // pull-call (query_feature_context)
    resultCount?: number;      // pull-call
    fromTier?: string;         // escalation
    toTier?: string;           // escalation
    files?: string[];          // co-change
    verdict?: "passed" | "failed" | "aborted";
  };
};
```

This shape is the contract. Every observation is one row. Heuristics become trivial group-bys:

```bash
# "Same review finding across N stories" → anti-pattern rule candidate
jq -s 'map(select(.kind=="review-finding"))
       | group_by(.payload.checkId)
       | map({checkId: .[0].payload.checkId, count: length, stories: [.[].storyId]})
       | map(select(.count >= 2))' observations.jsonl

# "Pull tool returned empty for same keyword twice" → context.md candidate
jq -s 'map(select(.kind=="pull-call" and .payload.resultCount==0))
       | group_by(.payload.keyword)
       | map(select(length >= 2))' observations.jsonl

# "Chunk excluded as stale but story still passed" → drop candidate
jq -s 'map(select(.kind=="chunk-excluded" and .payload.reason=="stale"))
       | group_by(.payload.chunkId) ...' observations.jsonl
```

### Layer B — `run-summary.json` (per-run aggregate, optional)

```
.nax/runs/<runId>/run-summary.json
```

```typescript
type RunSummary = {
  runId: string;
  featureId: string;
  startedAt: string;
  finishedAt: string;
  storiesTotal: number;
  storiesPassed: number;
  storiesFailed: number;
  totalRectifyCycles: number;
  totalEscalations: number;
  pullToolCalls: { tool: string; count: number; emptyCount: number }[];
  providerHealth: { providerId: string; okCount: number; emptyCount: number; failedCount: number }[];
};
```

Pre-aggregation of Layer A. Useful for dashboards / `nax curator status`, but always recomputable. Optimization, not source of truth.

### Layer C — cross-run rollup (only when N runs accumulate)

```
.nax/curator/rollup.jsonl
```

Same `Observation` schema, append-one-per-run, `runId` retained. Lets the curator ask: "this review finding fired in 8 of the last 12 runs across 3 features" — that's the threshold for promoting a candidate to a rule proposal.

---

## Proposal output (what the curator writes)

A single review file per run:

```
.nax/runs/<runId>/curator-proposals.md
```

Example:

```markdown
## Add to .nax/features/<id>/context.md
- [ ] [HIGH] Postgres connection cap — seen in 3 stories, 1 rectify cycle
- [ ] [MED] /v2/reviews batch endpoint — pull-tool query "review batch" returned empty 2×

## Add to .nax/rules/api-data.md
- [ ] [MED] "never N+1 on /v2/reviews" — review finding 4× this run

## Drop from .nax/rules/web.md
- [ ] [LOW] line 23–28 — never matched in 30 days of manifests
```

User triages with `nax curator apply <runId>` (interactive accept/reject), or just edits the file and runs a follow-up command that diffs accepted items into the canonical files. The curator never writes to `context.md` / `.nax/rules/` directly.

---

## Step 3 — Tier 1 feasibility audit (2026-04-30)

Verified each Tier 1 source by greppping the nax source tree and inspecting koda's actual run artifacts at `~/Desktop/projects/nathapp/koda/.nax/`.

### Sources that already exist (no nax change needed)

| Source | Where it lives | Verified by |
|:---|:---|:---|
| Context manifest | `<projectDir>/.nax/features/<id>/stories/<sid>/context-manifest-<stage>.json` | `src/context/engine/manifest-store.ts`; koda has `context-manifest-{context,tdd-test-writer,tdd-implementer}.json` for US-001 |
| Rectification cycles | `<feature>/runs/<ts>.jsonl` with `stage:"rectify"` or `stage:"autofix"` | `src/pipeline/stages/rectify.ts:49,106,112`, `src/pipeline/stages/autofix-agent.ts:104+` |
| Escalation events | `<feature>/runs/<ts>.jsonl` with `stage:"escalation"`; also persisted on `UserStory.escalations[]` | `src/execution/escalation/tier-escalation.ts:133` `logger.warn("escalation", "Story exceeded tier budget, escalating", …)` |
| Story verdict | `.nax/metrics.json` per-story (`failed`, `firstPassSuccess`, `attempts`, `finalTier`) — cross-run | `src/metrics/tracker.ts:254` saves to `<workdir>/.nax/metrics.json` |
| Stage timings | `<feature>/runs/<ts>.jsonl` — every event carries `timestamp` + `stage` | Confirmed in koda jsonl: 30+ distinct stage tags including `pipeline`, `tdd-*`, `routing`, `static-rules`, `context-v2` |

### Sources gated behind a flag (already exist — just enable)

| Source | Status | How to enable |
|:---|:---|:---|
| **Review findings** | ✅ **`ReviewAuditor` already exists.** Originally flagged as a logger gap — that was wrong. `src/review/review-audit.ts` writes structured JSON per reviewer call to `.nax/review-audit/<featureName>/<epochMs>-<sessionName>.json`. Schema covers everything the curator needs: `reviewer` (semantic/adversarial), `storyId`, `parsed`, `result.passed`, `result.findings[]`, `advisoryFindings[]`, `blockingThreshold`, `failOpen`, plus session correlation IDs. Gated by `config.review.audit.enabled` (default `false`). Wired in `src/runtime/index.ts:140-142` — when disabled, falls back to `createNoOpReviewAuditor()`. Subscriber attached at `src/runtime/index.ts:179` via `attachReviewAuditSubscriber`. Confirmed working: koda has audit files for `memory-guardrails` from 2026-04-22. | Add to `.nax/config.json`: `"review": { "audit": { "enabled": true } }` |

### Sources still missing (need nax logger gap fixed)

| Source | Why missing | What needs to change |
|:---|:---|:---|
| **Pull tool calls** | `src/context/engine/pull-tools.ts` and `tool-runtime.ts` emit **zero log events** in `handleQueryNeighbor` / `handleQueryFeatureContext`. No flag-gated audit exists. | Either add `logger.info("pull-tool", "invoked", { storyId, tool, keyword, resultCount })` inside each handler, or build a `PullToolAuditor` mirroring `ReviewAuditor` (same shape, same flag pattern). |
| **Acceptance verdict** | `src/acceptance/*.ts` logs progress but no structured pass/fail event. Stage tag is `"acceptance"` but determining outcome requires string-parsing messages. | Add `logger.info("acceptance", "verdict", { storyId, passed, failedACs, retries })` once per story at acceptance completion. |

### Newly discovered sources (not in original design)

| Source | Path | Use |
|:---|:---|:---|
| **Per-story metrics** | `.nax/metrics.json` — structured array, cross-run already | Strongest single source for Layer A. Has `firstPassSuccess`, `attempts`, `agentUsed`, `runtimeCrashes`, `tokensProduced`, `chunksKept` per story. |
| **Prompt audit jsonl** | `.nax/prompt-audit/<feature>/<sessionId>.jsonl` | Tier 3 (LLM-distill) source: full prompts per session. Confirmed in koda. Out of scope for v0. |
| **Cost jsonl** | `.nax/cost/<runId>.jsonl` | Per-call cost. Not directly useful for curator (Tier 0). |

### Net feasibility for v0

**6 of 8 Tier 1 sources are feasible today with zero changes to nax.** Five exist as-is; the sixth (review findings, the highest-leverage one for "anti-pattern rule" proposals) just needs a one-line config flip:

```json
"review": { "audit": { "enabled": true } }
```

Output lands at `.nax/review-audit/<featureName>/*.json`, structured per reviewer (semantic + adversarial) and ready to ingest as `Observation` records.

The remaining 2 gaps:

- **Pull tool calls** — `src/context/engine/pull-tools.ts` handlers emit nothing. Either add a `logger.info(...)` line per handler, or mirror the `ReviewAuditor` pattern with a `PullToolAuditor` (same flag-gated structure).
- **Structured acceptance verdict** — `src/acceptance/*.ts` needs one structured `logger.info("acceptance", "verdict", { storyId, passed, failedACs })` event per story.

Each of the 2 remaining gaps is a self-contained, no-behavior-change PR.

### Implication for the design

- **v0 can ship today** with 6 sources by enabling `review.audit.enabled` in koda's config + walking the existing artifacts. That covers 80–90% of the heuristics.
- **The pull-tool gap matters less than originally claimed**, because pull tools are off by default in koda anyway. Adding the audit only becomes urgent once `context.v2.pull.enabled: true`.
- **The acceptance gap matters most for failure-recovery proposals.** Worth fixing in v0 if it's a one-line change; defer otherwise.
- **`metrics.json` + `review-audit/*.json` together are Layer A's primary inputs**, not the run jsonl. Both are already structured, normalized, and cross-run. The run jsonl supplements with timing and escalation events.

## Step 4 — Auditor proliferation: unified design considered

While auditing the gaps in Step 3, the question came up: **do we keep adding domain-specific auditors (`PullToolAuditor`, `AcceptanceAuditor`, `EscalationAuditor`, …) every time a new domain needs persisted observations, or unify them?**

**Update (2026-05-04) — premise revised.** Step 3's actual recommendation for the two v0 gaps is `logger.info` (pull-tool, acceptance), and Step 5 confirms ADR-022 §13 already specifies `logger.info` for fix-cycle. **No new auditor classes are required for curator v0.** The "auditor proliferation" trigger that motivated this section never materialises under Step 3's chosen path. The unified design is recorded below as the eventual-shape reach, but the deferral case is now strictly stronger — see the updated recommendation and the new "curator IS the unification" subsection at the end of this section.

Current shape (from `src/runtime/index.ts`):

```
runtime
  ├─ dispatchEvents          ← single in-process event bus
  ├─ promptAuditor           ┐
  ├─ reviewAuditor           ├─ each = class + subscriber + writer + config flag
  ├─ costAggregator          ┘
  └─ logger
```

Every auditor does the same three things: subscribe to the bus, transform events to a domain schema, write JSONL/JSON to a domain-specific path. The only thing that varies is schema and destination.

### The proposed unified shape (sketch only, not committed)

Two new runtime primitives, replacing the per-domain auditors:

```
runtime
  ├─ dispatchEvents
  ├─ eventLog                ← .nax/runs/<runId>/events.jsonl   (small, one line per event)
  └─ blobStore               ← .nax/runs/<runId>/blobs/<ref>.txt (large, content-addressed)
```

Rationale: the current auditors conflate two concerns — **structured records** (small, queryable) and **opaque payloads** (large, retrieve-by-ref). `PromptAuditor` writes both `<runId>.jsonl` and per-session `.txt` files, paired by `ts`. Separating these into independent primitives matches the actual data shapes:

| Domain | Today | After split |
|:---|:---|:---|
| Prompt audit | One class, writes `.jsonl` + `.txt` paired by `ts` | `prompt.complete` event with `payload.promptRef` → blob |
| Review audit | Per-reviewer JSON, no blob | `review.decision` event with inlined small payload |
| Pull tool | (none) | `pull.tool.invoked` event, inlined payload |
| Acceptance verdict | (none) | `acceptance.verdict` event, blob if large |
| Rectify / escalation | Logger only | Typed events, no blob |

Adding a new domain becomes "dispatch a typed event," not "build a new auditor class."

### Risk register for the unified design

Before committing, evaluated against this codebase:

| ID | Risk | Severity | Mitigation |
|:---|:---|:---|:---|
| **R1** | **YAGNI / premature unification.** Trigger was "we'd be adding a third auditor," but curator v0 only needs the second (`reviewAuditor`), which already exists. Pull-tool audit doesn't bind until `context.v2.pull.enabled: true`. Acceptance is one `logger.info` line. | **Highest** | Defer. Ship curator v0 against existing auditors. Revisit once a 3rd or 4th domain actually pushes against the seam. |
| R2 | **Schema versioning blast radius.** Today each auditor's schema is local — breaking changes affect only that domain's consumers. After unification, schema changes touch every consumer of `events.jsonl`. | Major | Mandatory `schemaVersion` on every event; tolerant parsers; never reuse field names across versions. |
| R3 | **Atomicity of blob + event pair.** Implicit ordering is `blobStore.put → eventLog.record({ ref })`. Process death between the two leaves orphan blobs or dangling refs. Same problem prompt-auditor.ts:6-8 already documents (2026-04-29 incident: `.txt` succeeded, `.jsonl` dropped) — unification doesn't fix or worsen it. | Major | GC sweep at runtime startup (delete unreferenced blobs older than X). |
| R4 | **Single-stream ergonomic regression.** `ls .nax/review-audit/<feature>/` becomes `jq 'select(.kind=="review.decision")' events.jsonl`. Workflow regresses without a CLI shim. | Major | Ship `nax events --kind=...` view command; or keep per-domain folders as secondary projections during transition. |
| R5 | **`dispatchEvents` contract verified (2026-05-04) — bus is call-shaped.** Read of `src/runtime/dispatch-events.ts` confirms 3 strictly-typed channels (`onDispatch`, `onOperationCompleted`, `onDispatchError`), synchronous emit with per-listener `try/catch` (one bad subscriber can't break others), no tolerance for unknown kinds. Cross-cutting fields live on `DispatchEventBase` — adding e.g. `traceId` is a one-line, compile-checked change. **Finding:** the bus is a solid foundation, but every event represents a **call boundary** (prompt-in/response-out + timing/cost/permissions). Decision-shaped events (parsed review outcome, acceptance verdict, fix-cycle iteration) don't fit — see R11. | **Resolved** | Verified. |
| R6 | **Subscriber failure visibility.** `Promise.allSettled` (`runtime/index.ts:211`) means audit failures are silent today. Acceptable per-domain; after unification, a silent EventLog failure breaks every downstream consumer. | Medium | Explicit health check at run-end: "recorded N events, expected ≥M". Fail loudly below threshold. |
| R7 | **Plugin / external consumer drift.** `IReporter` and `IPostRunAction` plugins might read audit folders directly. Even if none does today, the contract is implicit. | Medium | Dual-write during transition. |
| R8 | **Test debt.** `PromptAuditor` and `ReviewAuditor` each have tests. Migration needs regression coverage proving behavior preserved. | Minor | ~200–500 LOC of test code, on top of new-primitive tests. |
| R9 | **Aborted-run blob cleanup.** Ctrl+C mid-run leaves orphan blobs. Same problem as today's prompt-audit `.txt` orphans. No regression. | Minor | Reuse existing cleanup story (none today; defer). |
| R10 | **Performance under parallel stories.** Single `events.jsonl` per run, multiple stories appending. JSONL append is atomic per-line on POSIX; per-runId scoping bounds contention. | Minor | Not a real concern at current scale. |
| **R11** | **Bus is call-shaped; decisions don't fit.** Discovered via the R5 verification pass (2026-05-04). `ReviewAuditor.recordDecision` is called directly from `src/review/{semantic,adversarial,semantic-debate}.ts` bypassing the bus — parsed-review semantics (`passed`, `findings[]`, `failOpen`, `blockingThreshold`, `advisoryFindings[]`) don't belong on a universal call event. Future verdict events (acceptance, fix-cycle) hit the same wall. Unification has to either widen the bus with non-call channels (`onReviewDecision`, `onAcceptanceVerdict`, …) or accept hybrid ingress (some events via bus, some via direct call), which leaks the abstraction. | Major | Closing the review-decision gap with a typed `ReviewDecisionEvent` channel is a smaller, justified change today — independent of unification. ~50 LOC. |
| **R12** | **The three persistence shapes are not symmetric.** Prompt = per-call append + paired TXT sidecar (sync-append carve-out for reliability — see `prompt-auditor.ts:6-23`). Cost = in-memory aggregate + single batch on `drain()` **plus a live query surface** (`snapshot/byAgent/byStage/byStory` read **during** the run by metrics/reporters). Review = per-decision atomic JSON file with two-step dispatch+decision join keyed by `reviewer:storyId`. eventLog+blobStore is append-shaped: fits prompt natively, awkwardly fits review (loses one-decision-one-file artifact), pessimises cost (forces eager writes for data that doesn't need them). Cost's query surface means an aggregator layer survives **above** any eventLog — net runtime code increases, not decreases. | Major | None — confirms the unification primitive is mis-shaped for existing data, not just premature. |

### Recommendation — defer indefinitely (revised 2026-05-04)

After the R5 verification and the R11 / R12 additions, the deferral case is stronger than originally stated:

- **R1 (YAGNI) holds harder than first written.** Curator v0 needs zero new auditor classes — Step 3's `logger.info` path covers pull-tool and acceptance, ADR-022 §13 covers fix-cycle. The "third auditor" that triggered this section is hypothetical against the doc's own recommendations.
- **R5 is closed.** The bus is solid but call-shaped. Unification can't paper over the call/decision split — see R11.
- **R11 + R12 say the primitive is mis-shaped, not just premature.** eventLog+blobStore as sketched fits one of the three existing auditors (prompt) and pessimises the other two. The 3 existing auditors are correctly differentiated, not accidentally fragmented.

**Trigger condition for revisiting:** a future domain genuinely needs **blobs** OR a **live query surface during the run** OR **atomic per-decision file artifacts**. None of curator v0's new domains hit any of these. Until at least one does, the unification is solving a problem nax doesn't have.

**The actual unification already exists in the design — at the curator layer.** See "The curator IS the unification" subsection below.

**Smaller adjacent change worth doing now (independent of unification):** add a typed `ReviewDecisionEvent` channel to `DispatchEventBus` and route the 4 direct `ReviewAuditor.recordDecision` callsites through it. Closes the asymmetry called out in R11. ~50 LOC. No `CreateRuntimeOptions` change.

Captured here so a future operator hitting the same fork can see the analysis without re-deriving it.

### The curator IS the unification (added 2026-05-04)

The unification debate above treats "single canonical event stream" as a runtime-primitive question. The cleaner mental model is that this stream **already exists in the design** — just at a different layer:

| Layer | Today | Curator role |
|:---|:---|:---|
| In-process events | `DispatchEventBus` (typed, sync) + `logger.info` (run jsonl) | — |
| Per-domain artifacts | `prompt-audit/`, `review-audit/`, `cost/`, `metrics.json`, `context-manifest-*.json` | **primary input** (Step 3) |
| Cross-domain projection | `.nax/runs/<runId>/observations.jsonl` (Step 2 schema) | **built by curator at end-of-run** |

eventLog+blobStore would have unified at the **emission layer** — forcing every domain into one shape at the time of write. The curator unifies at the **projection layer** — reading each domain in its native shape and writing one normalized table.

Why projection-layer wins:

- Doesn't require widening the bus to carry decision-shaped events (R11).
- Doesn't force prompt's blob/sidecar shape, cost's query surface, or review's per-decision atomic file into one mould (R12).
- Lets new domains pick the lightest emission they need (`logger.info` for pull-tool, acceptance, fix-cycle).
- Keeps schema versioning local to each domain — a domain change ripples to the curator's parser for that domain only, not to every consumer of `events.jsonl` (R2).
- Keeps the per-domain folder UX intact for human operators (`ls .nax/review-audit/<feature>/` still works) — R4 doesn't fire.

This retires the eventLog+blobStore conversation cleanly: the primitive curator wanted is `observations.jsonl`, and the curator builds it itself from artifacts the runtime already produces.

---

## Step 5 — ADR-022 fix-cycle iteration audit (cross-reference)

ADR-022 ("Fix Strategy and Cycle Orchestration", 2026-05-02) introduces a `runFixCycle<F>` that drives diagnose-fix-validate iterations across acceptance, autofix, semantic, and adversarial subsystems. Its "Audit logging" section deliberately **defers cycle-history persistence to this curator redesign** — iteration history is ephemeral by default (in-memory in `PipelineContext`), used only for prompt carry-forward via `buildPriorIterationsBlock`.

When this curator redesign lands, cycle iterations should map onto the same `observations.jsonl` schema. Concrete sketch:

### Mapping `Iteration<F>` → observations

The schema's existing `kind: "rectify-cycle"` (Layer A, line 106) is the right slot — but it predates ADR-022 and was intended to capture only autofix's `runRetryLoop` attempts. Generalise it to cover all cycle iterations:

```typescript
// Replace existing "rectify-cycle" kind with three more specific events:
kind:
  | "fix-cycle.iteration"     // one Iteration<F> completed (cycle iteration boundary)
  | "fix-cycle.exit"          // cycle terminated (resolved or bailed)
  | "fix-cycle.validator-retry" // validator threw, cycle retried
  // … existing kinds preserved
```

Per-event payloads, mapped from `Iteration<F>` and `FixCycleResult<F>`:

```typescript
// fix-cycle.iteration
payload: {
  cycleName: string;             // "acceptance" | "autofix" | "semantic" | …
  iterationNum: number;
  strategiesRan: string[];       // FixApplied[].strategyName
  outcome: "resolved" | "partial" | "regressed" | "unchanged" | "regressed-different-source";
  findingsBefore: number;
  findingsAfter: number;
  costUsd: number;
  // optional: top-N finding categories for cross-iteration trend analysis
  beforeCategories?: string[];
  afterCategories?: string[];
}

// fix-cycle.exit
payload: {
  cycleName: string;
  resolved: boolean;
  reason?: "no-strategy-matches" | "max-attempts-per-strategy" | "max-attempts-total" | "bailed-by-strategy" | "validator-error";
  bailDetail?: string;
  exhaustedStrategy?: string;
  totalIterations: number;
  totalCostUsd: number;
}

// fix-cycle.validator-retry
payload: {
  cycleName: string;
  iterationNum: number;
  attempt: number;               // 0 = first try, 1 = retry
  errorClass: string;            // err.constructor.name
  errorMessage: string;
}
```

### Why this matters for the curator

Cycle iterations expose patterns the curator wants to surface:

| Curator heuristic | jq query against observations.jsonl |
|:---|:---|
| "Story always falsifies its hypothesis (unchanged outcome ≥2 in a row)" → diagnose prompt is wrong | `select(.kind=="fix-cycle.iteration" and .payload.outcome=="unchanged") \| group_by(.storyId)` |
| "Same strategy hits its per-strategy cap repeatedly" → strategy logic is broken | `select(.kind=="fix-cycle.exit" and .payload.reason=="max-attempts-per-strategy") \| group_by(.payload.exhaustedStrategy)` |
| "Validator retries cluster on same error class" → validator infra is flaky | `select(.kind=="fix-cycle.validator-retry") \| group_by(.payload.errorClass)` |
| "Cycle resolves quickly for some stories, never for others" → cross-story baseline anomaly | `select(.kind=="fix-cycle.exit") \| {storyId, resolved, totalIterations}` |

### Telemetry symmetry

ADR-022 §13 already mandates a logger contract for cycle iterations:

```typescript
logger.info("findings.cycle", "iteration completed", { storyId, packageDir, cycleName, iterationNum, strategiesRan, outcome, findingsBefore, findingsAfter, costUsd });
```

The `observations.jsonl` shape above is a strict superset — once unified-auditor work (Step 4 in this design) lands, the logger emit and the audit emit can share one dispatch path. Until then, a thin auditor reads logger entries and writes observations rows; same pattern as today's `PromptAuditor`.

### Implementation timing

This is **not a curator-v0 dependency**. ADR-022 phase 4 (acceptance migration) ships first and only requires the in-memory `Iteration<F>[]` carry-forward. Cycle-history audit persistence can wait until:

1. ADR-022 phases 4–7 have shipped — real cycle data exists to mine
2. Curator v0 is validated against existing auditors — proves the heuristics-from-observations workflow works
3. The curator's projection layer (Step 4 "curator IS the unification") proves out — at which point fix-cycle events are just another `kind` in `observations.jsonl`, parsed from the existing `logger.info("findings.cycle", …)` emits. No new auditor class needed.

Document this here so a future operator landing the audit work sees the cycle-history requirement without re-deriving it from ADR-022.

## Open questions / next steps

1. **Decide the v0 cut.** Ship the 2 remaining logger emits (pull-tool, acceptance) now, or ship a partial curator first?
2. **Confirm `metrics.json` shape covers what we need.** Walk the file end-to-end against the `Observation` schema.
3. **Calibrate thresholds.** "≥2 stories", "30 days", etc. are guesses. Calibrate against real run data once enough metrics rows accumulate.
4. **Storage location.** `.nax/runs/<runId>/` is current; cross-run rollup at `.nax/curator/rollup.jsonl` is new — confirm convention.
5. **Plugin entry point.** `IPostRunAction` is the documented hook. Confirm it gets enough context (run artifacts path, config, logger) to do the walk.
6. **Apply UX.** Interactive CLI (`nax curator apply`) vs. plain editing the proposals file — pick one before building.
7. ~~**Verify `dispatchEvents` contract** (R5 from Step 4)~~ — **Closed 2026-05-04.** Bus is typed, narrow, sync, call-shaped. See updated R5 in the risk register. Unification deferred indefinitely; see "The curator IS the unification" subsection.
8. **Cycle-history audit timing** (Step 5). Ride along with curator v0, defer to v1, or wait for cycle data accumulation? Tied to ADR-022 phase 4+ shipping. Note: ADR-022 §13 already specifies `logger.info("findings.cycle", …)`, so cycle data flows into `observations.jsonl` via the projection layer with no new auditor class.
9. **Close the review-decision bus gap** (added 2026-05-04). Add typed `ReviewDecisionEvent` channel to `DispatchEventBus`; route 4 direct `ReviewAuditor.recordDecision` callsites through it. ~50 LOC. Independent of curator, but cleans up the asymmetry that R11 surfaced.

## References

- [Context Engine guide](../guides/context-engine.md) — feature context, rules, manifests, pull tools
- ADR-010 — Context Engine
- `IPostRunAction` plugin extension point — see plugin loader in `src/plugins/`
- Run log format — `src/logger/`
- Manifest writer — `src/context/engine/`
