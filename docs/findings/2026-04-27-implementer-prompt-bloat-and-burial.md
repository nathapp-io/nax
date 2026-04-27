# Gap 3: Implementer prompt buries the story under rules bloat

**Date:** 2026-04-27
**Project under test:** [koda](https://github.com/nathapp-io/koda) — feature branch `feat/memory-phase4-graph-code-intelligence`
**Run date:** 2026-04-26 13:48:36 UTC
**Affected stories:** US-000, US-001, US-006 (likely all stories — pattern is structural)
**Source spec:** [SPEC-004 (koda repo)](https://github.com/nathapp-io/koda/blob/feat/memory-phase4-graph-code-intelligence/docs/specs/SPEC-004-memory-phase4-graph-code-intelligence.md) — also linked at section level below
**Status:** Planned — Framing A locked; B follow-up gated on A telemetry; C deferred
**Related:** [2026-04-27-implementer-review-rectification-gaps.md](./2026-04-27-implementer-review-rectification-gaps.md) (Gaps 1+2 — post-implementation rectification flow). Gap 3 is independent: it affects the **implementer prompt at story start**, not rectification.

> **Evidence sources:** Findings cite (a) locally-captured nax audit logs (`logs/prompt-audit/`, gitignored — load-bearing excerpts inlined as code blocks) and (b) the public [koda repo](https://github.com/nathapp-io/koda) on the `feat/memory-phase4-graph-code-intelligence` branch. All koda links resolve on GitHub.

---

## Symptom

The implementer prompt at story start is dominated by generic rules/conventions, with the actual story description buried in the middle. Three concrete prompts confirm the pattern:

| Prompt (timestamp, story, strategy) | Total lines | Rules + constitution | Story context | Ratio |
|:---|:---|:---|:---|:---|
| 13:54 — US-000 implementer-run-t01 (`tdd-simple`) | ~330 | ~270 | ~20 | 93% / 6% |
| 13:59 — US-006 implementer-run-t01 (`tdd-simple`) | ~343 | ~280 | ~20 | **93% / 6%** |
| 15:04 — US-001 implementer-run-t01 (`three-session-tdd-lite`) | ~415 | ~330 | ~25 | **89% / 6%** |

In all three, the story description and acceptance criteria — the actual goal — are ~6% of the prompt and sit at position 5 of 8 sections, after ~300 lines of generic guidance.

**US-001 prompt structure** (verbatim section ordering captured from the local prompt audit):

```
Position  Section                                          Lines
1         CONSTITUTION (nax + Koda — wrapped in            64
            <!-- USER-SUPPLIED DATA --> tags)
2         Role: Implementer (Lite)                         14
3         Project Context — api.md + common.md +           250
            project-conventions.md (full content with
            ### file headers + ## section headers)
4         Prior Stage Summary + Session History            15
5         Story Context (title + description + 11 ACs,     25
            wrapped in <!-- USER-SUPPLIED DATA --> tags)
6         Isolation Rules                                  5
7         Hermetic Test Requirement                        3
8         Conventions + Security                           12
                                                          ───
                                                          ~415
```

---

## Five sub-issues, all interrelated

### (a) `contextFiles` in prd.json is dead data

The schema default for `config.context.fileInjection` is `"disabled"` ([schemas.ts:638](../../src/config/schemas.ts#L638)). The injection logic in [builder.ts:213-215](../../src/context/builder.ts#L213-L215) bails when the value isn't `"keyword"`. The koda project's [.nax/config.json](https://github.com/nathapp-io/koda/blob/feat/memory-phase4-graph-code-intelligence/.nax/config.json) confirms `fileInjection: "disabled"`.

**Result:** explicit `contextFiles` in prd.json — author intent telling the agent "these are the existing files you'll modify" — never appear in the prompt.

Concrete examples from [memory-phase4 prd.json](https://github.com/nathapp-io/koda/blob/feat/memory-phase4-graph-code-intelligence/.nax/features/memory-phase4-graph-code-intelligence/prd.json):

| Story | `contextFiles` in prd.json | Appears in prompt? |
|:---|:---|:---|
| US-000 | `apps/api/prisma/schema.prisma` | ❌ No |
| US-001 | `apps/api/src/rag/rag.controller.ts`, `rag.service.ts`, `import-graphify.dto.ts`, `schema.prisma`, `outbox-fan-out-registry.ts` | ❌ No |
| US-002 | (5 files) | ❌ No |
| US-006 | **(none — field absent)** | n/a |

US-001 specifies 5 highly relevant files; the agent gets none of them and has to grep-discover the existing rag controller from scratch. US-006 has no `contextFiles` at all, compounding the problem.

### (b) Story is in the worst attention position

Current section order (US-001 implementer-run):

| Position | Section | Lines (approx) |
|:---|:---|:---|
| 1 | Constitution (nax + Koda) | 64 |
| 2 | Role description | 14 |
| 3 | Project rules dump (api.md + common.md + project-conventions.md) | 250 |
| 4 | Prior stage summary + session history | 15 |
| **5** | **Story context (title, description, ACs)** | **25** |
| 6 | Isolation rules | 5 |
| 7 | Hermetic test requirement | 3 |
| 8 | Conventions + security | 12 |

Primacy/recency research is unambiguous: information at the start and end of long context is better attended to than information in the middle. The story is in the **worst possible position** — buried under the largest section, ~330 lines from the top, ~80 lines from the bottom.

### (c) Rule bloat is generic, not story-relevant

Current behavior: the entire `.nax/rules/<app>.md` for the story's app gets injected verbatim. For US-001 (Incremental Graph Diff — Prisma + role enforcement + RAG):

| Rule section | Lines | Relevance to US-001 |
|:---|:---|:---|
| Auth / role enforcement | ~10 | ✅ Relevant (AC 10) |
| Prisma patterns | ~15 | ✅ Relevant (Prisma reads/writes) |
| Soft-delete | ~5 | ✅ Relevant (Project model) |
| Pagination anti-patterns | **28** | ❌ Irrelevant (no pagination in this story) |
| i18n separation | ~15 | ❌ Irrelevant (no UI strings) |
| OpenAPI generation flow | ~10 | ❌ Irrelevant (no contract change) |
| Testing anti-patterns (Jest DI cleanup) | **16** | ⚠️ Only relevant when writing Jest tests |
| Web app context files | ~5 | ❌ Irrelevant (api-only story) |

About **50% of the api.md content is generic anti-pattern guidance** that has nothing to do with this specific story but is injected anyway. Other rule files (`.nax/rules/`) total 353 lines across 5 files; even after per-app filtering, only sections matching the story tags are useful.

### (d) Rendering bug: tdd-simple loses section headers

Comparison of how api.md content appears across roles:

| Role | api.md rendering |
|:---|:---|
| Implementer (Lite) (three-session-tdd-lite, US-001) | Full content with `### api.md` header and `## Section` subheadings preserved |
| TDD-Simple (US-006) | Bullet content appears (lines 93-152) **without** the `### api.md` header or parent `## Section` headings |

The bullets are recognizable as `## Implementation Anti-Patterns`, `## Pagination Anti-Patterns`, `## Testing Anti-Patterns` from api.md, but the headers are missing. The agent sees a flat bullet list with no hierarchical context. This is orthogonal to the design issues but worth fixing in whatever PR touches the rendering path.

### (e) Planner drops spec design content; ACs alone are insufficient

This is the largest single contributor to "story context vague" — sharper than the earlier "description quality" framing. The spec author writes a rich design subsection per story (interfaces, algorithms, motivation); the planner collapses each into a one-sentence summary.

#### Spec vs PRD comparison

The source spec is [SPEC-004 in the koda repo](https://github.com/nathapp-io/koda/blob/feat/memory-phase4-graph-code-intelligence/docs/specs/SPEC-004-memory-phase4-graph-code-intelligence.md). Its §1 (Incremental Graph Diff) ships:

```typescript
// Verbatim excerpt from SPEC-004 §1
class IncrementalGraphDiffService {
  constructor(
    private graphStore: GraphStoreService,
    private rag: RagService,
  ) {}

  async diffAndApply(
    projectId: string,
    newNodes: GraphifyNodeDto[],
    newLinks: GraphifyLinkDto[],
  ): Promise<DiffResult>

  async getStoredGraph(projectId: string): Promise<StoredGraph>
}

interface StoredGraph {
  nodeMap: Map<string, GraphifyNodeDto>;
  linkMap: Map<string, GraphifyLinkDto[]>;
}

interface DiffResult {
  added: number;
  updated: number;
  removed: number;
  indexed: number;
  durationMs: number;
}
```

Plus a problem statement (`importGraphify()` does `deleteAllBySourceType('code')` then re-indexes all — O(n) memory load), a 5-step diff algorithm, and a content-regeneration policy ("only regenerate adjacency text when label/type/source_file/links changed").

What landed in [prd.json US-001](https://github.com/nathapp-io/koda/blob/feat/memory-phase4-graph-code-intelligence/.nax/features/memory-phase4-graph-code-intelligence/prd.json):

```json
{
  "id": "US-001",
  "title": "Incremental Graph Diff — Replace Full Re-Import",
  "description": "Replace full graphify re-import with incremental diff-and-apply against durable graph tables, while preserving existing import API behavior and project isolation.",
  "acceptanceCriteria": [ ... 11 ACs ... ]
}
```

One-sentence description. Class signature, interfaces, algorithm, motivation — all dropped. US-006 has the same pattern: SPEC-004 §6 ships full `CanonicalStateService` interface + `CanonicalSnapshotQuery` + `CanonicalSnapshot` schema; PRD description is one sentence.

#### Why the planner drops design content

Two contributing causes, both fixable in the same PR:

**1. Initial planner prompt has zero description guidance.**

In [plan-builder.ts:153](../../src/prompts/builders/plan-builder.ts#L153):

```typescript
"description": "string — detailed description of the story",
```

Compare with the ~30 lines of `AC_QUALITY_RULES` + bad/good examples + format templates ([test-strategy.ts:93-128](../../src/config/test-strategy.ts#L93-L128)). LLMs default to summarization when given no other guidance — and that's exactly what they do for descriptions.

**2. Debate synthesis prompt anchors ACs but not descriptions.**

When debate is enabled, the synthesis resolver merges debater outputs using rules in [runner-plan.ts:224-225](../../src/debate/runner-plan.ts#L224-L225):

```
## Synthesis Rules — Acceptance Criteria
The spec above is the authoritative source for acceptance criteria.
- Each story's acceptanceCriteria array MUST contain only criteria
  explicitly stated or directly implied by the spec.
- Preserve the spec's AC wording. ...
```

**Spec-anchor for ACs only.** Descriptions and design content have no anchor → resolver picks the lowest-common-denominator restatement from the debaters' proposals. Debate doesn't *cause* the gap (single-agent path has it too), but it slightly amplifies it via the convergence dynamic.

This explains the asymmetry observed in PRD output:
- ACs: 10 in spec → 11 in PRD (preserved + 1 inferred). Spec-anchor working.
- Design sections: 30+ lines in spec → 1 sentence in PRD. No anchor → collapsed.

#### Are ACs doing the heavy lifting?

**For "what to test", yes. For "what to implement", partially.**

US-001's 11 ACs comprehensively cover behavior:

- Class methods (#1, #6 — `diffAndApply`, `importGraphify`)
- Data sources (#2 — Prisma not LanceDB)
- Input/output behavior (#3, #4, #5 — exact counts, deletion semantics, skip-unchanged)
- Performance bounds (#8 — under 2s for 510 nodes)
- Return shape (#7, #9 — `indexed`, `durationMs`)
- Authorization (#10), project scoping (#11)

What ACs DON'T carry that the spec design provides:

| Spec content | In ACs? | Implementer impact if missing |
|:---|:---|:---|
| Class signature: `IncrementalGraphDiffService(graphStore, rag)` | ❌ Implied | Implementer invents constructor — may pick wrong dependencies |
| Interface shapes: `StoredGraph`, `DiffResult` | ⚠️ Partial | Implementer reverse-engineers full type from ACs |
| 5-step diff algorithm | ❌ Behaviorally implied | Implementer re-derives; may pick less efficient ordering |
| Equality semantics ("changed when label/type/source_file/links changed") | ⚠️ AC #5 says "skip unchanged" but doesn't define "changed" | Implementer picks own equality; may diverge from spec author intent |
| Motivation ("full re-import unscalable, O(n) memory load") | ❌ Absent | No "why" → judgment calls during implementation lack anchor |

US-006 is starker: the spec ships the full `CanonicalSnapshot` interface (tickets/recentEvents/activeDecisions arrays with their own fields). The 6 ACs verify pieces (`retrievedAt`, filtered `tickets[]`) but never declare the overall return shape. The implementer must assemble the type from 6 separate ACs.

**Conclusion:** ACs are necessary but not sufficient. The spec's design sections carry implementation-level structure (signatures, interfaces, algorithms) and motivation. Today both are dropped.

---

## Three possible framings

### Framing A — Minimal: fix what's broken

Four small changes:

1. **Honor `contextFiles` always, path-only.** Treat explicit `contextFiles` in prd.json as separate from auto-detection — always inject the listed paths regardless of `fileInjection` mode. Standardize on path-only output (drop the current `<10KB inline / >10KB path-only` policy from [builder.ts:210-292](../../src/context/builder.ts#L210-L292)). The agent uses Read on demand; eager inlining is just pre-fetching that wastes tokens, becomes stale once the agent edits the file, and bloats prompts replayed every turn. Keyword auto-detection remains gated by `fileInjection: "keyword"`.

2. **Reorder the prompt.** Move `Story Context` to position 1 (right after a 1-line role description). Rules and constitution follow. Restate goal at the bottom (sandwich pattern — ~25 extra lines for both primacy and recency benefit).

3. **Fix the rendering bug.** Ensure `### api.md` and parent section headers are preserved in tdd-simple's prompt rendering, matching three-session-tdd-lite's output.

4. **Description quality rules — two-place fix.** Carry spec design content into PRD descriptions:

   - **Initial planner prompt** ([plan-builder.ts](../../src/prompts/builders/plan-builder.ts)): add `DESCRIPTION_QUALITY_RULES` constant similar to existing `AC_QUALITY_RULES`. Format guidance + one strong bad/good example showing verbatim spec-section embedding.
   - **Synthesis prompt** ([runner-plan.ts:224-225](../../src/debate/runner-plan.ts#L224-L225)): extend the existing spec-anchor block to cover descriptions (parallel to the existing AC anchor). Without this, debate synthesis still drops design content even after the initial-prompt fix lands.

   Rule wording (draft):

   ```
   When the spec contains a design subsection corresponding to this story
   (e.g. `### N. <Topic>` under `## Design`), the description MUST include
   that subsection's interface declarations, algorithms, and design notes
   verbatim. Do not paraphrase. Format:

   **Goal** — 1 sentence: what this story changes
   **Motivation** — 1 sentence from spec's Motivation section: why this matters
   **Approach** — verbatim from spec's design subsection
   **Scope** — In: ... Out: ...
   **Interface** — verbatim TypeScript signatures from the spec
   ```

**Scope:** ~265 LOC total across:
- `src/context/builder.ts` (path-only contextFiles, ~80 LOC removed/changed)
- Prompt assembly path (reorder + rendering bug fix, ~80 LOC)
- `src/config/test-strategy.ts` (`DESCRIPTION_QUALITY_RULES` constant + example, ~50 LOC)
- `src/prompts/builders/plan-builder.ts` (inject the new rules, ~10 LOC)
- `src/debate/runner-plan.ts` (extend synthesis spec-anchor, ~20 LOC)
- Tests + snapshots (~50 LOC)

**Risk:** Low — fixes are localized; description quality may need a follow-up if the LLM still paraphrases despite strong examples (escalation path: mechanical spec-section extractor as PR (b), ~150 extra LOC).

**Doesn't address:** rule bloat (still 250+ lines of generic guidance per prompt). That's deferred to Framing B.

### Framing B — Medium: A + per-section relevance filtering, plus vocabulary plumbing

Everything in A, plus three coupled changes — **all required for B to actually work**:

1. **Section-level tagging in rules files.** Each `## Section` in `.nax/rules/*.md` gets an optional HTML comment after the heading: `<!-- nax-tags: [auth, security] -->`. Untagged sections inject by default (backward-compatible).

2. **Vocabulary extraction at plan time.** A new `extractRuleTagVocabulary(naxDir)` step scans `.nax/rules/*.md`, collects the union of `nax-tags`, returns the canonical set. **Rule-derived, not pre-declared** — the vocabulary is whatever the rule authors put in their files.

3. **Vocabulary surfaced to planner.** When `nax plan` or `nax run --plan` invokes the planner LLM, the prompt includes the vocabulary as the controlled tag list:

   ```
   ## Allowed Story Tags

   Tag each story with one or more of these concerns:
     auth, security, prisma, pagination, i18n, openapi, testing, ...

   Pick tags describing what coding concerns the story raises.
   Feature-area tags (e.g. "memory", "graph") may also appear in tags[]
   but rule matching uses the controlled list above.
   ```

   `prd.json` schema treats unknown tags as a warning (not error) for backward compatibility — existing prd.json files don't break.

**Why this is required:** today's prd.json story tags are feature-area descriptors (`["feature", "api", "graph", "rag"]`); rule sections would be tagged with concern descriptors (`auth`, `prisma`, `pagination`). The intersection is empty without a unified vocabulary. Shipping B without closing this gap means rule matching falls back to inject-everything (no benefit) or matches nothing (worse).

**Monorepo handling:** existing infrastructure already filters rules by package via file-level `paths:` frontmatter ([static-rules.ts:188-213](../../src/context/engine/providers/static-rules.ts#L188-L213)) and overlays per-package rules from `.nax/mono/<pkg>/`. Section-level filtering layers on top without modification — sections inherit their parent file's `paths:` scope automatically. Vocabulary stays **global** (single union across all rule files); per-package vocabularies would force planner context-switching per story without measurable benefit.

**Scope:** ~325 LOC + content migration (~5 rule files tagged with section frontmatter):

| Sub-task | LOC |
|:---|:---|
| Section frontmatter parser (HTML comment after `##` headings) | ~60 |
| Vocabulary extractor | ~30 |
| Planner prompt vocabulary injection | ~20 |
| prd.json schema unknown-tag warning | ~15 |
| Rule-section filter on injection | ~50 |
| Tests + snapshots | ~150 |

**Effect on US-001:** rules drop from ~250 lines to ~80 lines per prompt.

**Risk:** Medium — introduces a tagging convention; needs documented format. Tagging discipline becomes a maintenance concern (someone has to keep rule tags accurate as rules evolve).

### Framing C — Structural: on-demand rules via tools

Eagerly inject only:
- 1-line role description
- Story context + acceptance criteria + `contextFiles` paths
- Always-on safety rules (5–10 lines: no remote push, no exfiltration, etc.)
- **Rule index** (the same vocabulary extracted in B, rendered as "for `auth` concerns, see api.md#Auth; for `prisma`, see api.md#Prisma; …")

Everything else (`.nax/rules/`, constitution, conventions) becomes a tool the agent can grep/read on demand.

**Scope:** ~800 LOC, UX shift across all agent roles (not just implementer). **Builds on B's vocabulary work** — the rule index is the same tag→section mapping B uses for filtering, just rendered differently.

**Risk:** High — agents may not consult rules without explicit prompting; rule violations may go up before they go down. The "agent fetches rules on demand" failure mode is real and unmeasured.

**Pays off when:** rule library grows past 500+ lines per app, or when stories vary widely in rule relevance.

#### B vs C — why B first

| Concern | B (eager filtered) | C (on-demand index) |
|:---|:---|:---|
| Prompt size after fix | ~80 lines of rules | ~10 lines (index only) |
| Agent might skip consulting rules | Won't happen — rules are visible | Real risk, hard to detect in audit logs |
| Validation in audit logs | Easy — see exactly which sections shipped | Hard — see only that the agent had the option |
| Reusability of vocabulary work | High — same tags drive C later | High — built on B's foundation |
| Risk if model behavior is wrong | Easy rollback (flip filter to inject-all) | Hard rollback (re-train/re-prompt the agent) |

**B is a stepping stone to C, not a competitor.** The vocabulary plumbing in B is 80% of C's work. Doing B first lets us measure whether eager-filtered rules are sufficient before committing to the larger UX shift. If they are, C is unnecessary. If they aren't, C is one config flip away (`rules.injectMode: "filter" | "index"`).

---

## Recommendation

**Land Framing A first** as a single coherent PR (or 2-3 small PRs). Measure on the next real feature run, then decide on B based on data.

A's success criteria (measurable in audit logs):
- `contextFiles` count actually appearing in the prompt > 0 for stories that declare them
- Story Context appears in position 1, not position 5
- PRD descriptions for SPEC-004-style stories include verbatim interface declarations from the spec
- US-001's implementer reads fewer files via Read tool (because they're listed up front)

If after A:
- Rules are still the dominant prompt bloat (likely yes, ~70% rules-to-story even after A) → land **B**
- Rule volume grows past ~500 lines per app or stories vary widely in rule relevance → flip B to **C** using the same vocabulary

---

## Resolved design decisions

1. **`contextFiles` honoring policy.** ✅ Honor always, separate from `fileInjection` mode. Author intent (explicit list in prd.json) is a stronger signal than keyword scanning. `fileInjection: "keyword"` continues to gate only auto-detection.

2. **Inline vs path-only.** ✅ Standardize on **path-only** with optional author-supplied annotations (e.g. `contextFilesAnnotations: { "path": "purpose" }` in prd.json). Drop the current `<10KB inline / >10KB path-only` policy entirely. Rationale: same disease as Gap 3 itself (prompt bloat); inlined files become stale on first edit; agent has Read for on-demand fetch.

3. **Story-first reordering — sandwich, not full reorder.** ✅ Story (top) → rules/constitution → Story restated (bottom). ~25 extra lines per prompt; doubles the agent's "what's the goal" signal via primacy AND recency. Worth the cost.

4. **`contextFiles` size budget.** ✅ Path-only output makes this moot — paths are ~50 bytes each, no content cap needed. Keep the existing `MAX_FILES = 5` cap as a sanity guard against runaway prd.json content.

5. **Rendering bug fix scope.** Pending root-cause investigation in implementation. Suspect: tdd-simple's role template path drops a header rendering call. Easy to confirm by diffing the rendered output of both roles against the same input. ~30 LOC fix once root-caused.

6. **Should US-006's prd.json get `contextFiles`?** ✅ Yes, but that's a content fix in the user's project — not nax's responsibility. Flag as a usage hint in `nax plan` output: "Story US-006 has no contextFiles. Consider adding 2-5 to anchor the implementer faster."

7. **Description quality fix path.** ✅ Path (a) — prompt-only rules in **both** the initial planner prompt and the synthesis prompt. Strong concrete bad/good example carries most of the weight. Path (b) — mechanical spec-section extractor — held as a follow-up if (a) doesn't stick.

8. **Tag vocabulary scope (for Framing B).** ✅ Single global tag list (rule-derived). Per-package vocabulary would force planner context-switching per story without measurable benefit. Existing path-frontmatter on rule files already handles "this rule only applies in apps/api".

9. **Vocabulary source of truth (for Framing B).** ✅ Rule-derived (extracted from `.nax/rules/*.md` section frontmatter at plan-time). Pre-declared `tag-vocabulary.yaml` rejected — rules are the consumer, so deriving from them keeps the system self-consistent.

---

## Files to investigate before implementation

| File | Why |
|:---|:---|
| [`src/context/builder.ts`](../../src/context/builder.ts) | Owns the `fileInjection` gate (lines 213-215) and the `<10KB inline` policy (lines 210, 280-292). Needs split between explicit-contextFiles (always honor, path-only) and auto-detection (`fileInjection: "keyword"`). |
| Prompt assembly for implementer role | Owns section ordering. Identify it across `tdd-simple` / `three-session-tdd` / `three-session-tdd-lite` paths — root-cause the rendering-bug delta in (d) here. |
| [`src/prompts/sections/role-task.ts`](../../src/prompts/sections/role-task.ts) | Role description rendering — possibly where the missing-header bug originates. |
| [`src/prompts/builders/plan-builder.ts:153`](../../src/prompts/builders/plan-builder.ts#L153) | Description field guidance lives here — needs `DESCRIPTION_QUALITY_RULES` injection. |
| [`src/debate/runner-plan.ts:224-225`](../../src/debate/runner-plan.ts#L224-L225) | Synthesis spec-anchor block — extend to cover descriptions in addition to ACs. |
| [`src/config/test-strategy.ts`](../../src/config/test-strategy.ts) | Where `AC_QUALITY_RULES` lives. Add `DESCRIPTION_QUALITY_RULES` here for symmetry. |
| `.nax/rules/*.md` parser | If we go to B, need section-tag parser. Today's [canonical-loader.ts](../../src/context/rules/canonical-loader.ts) parses file-level frontmatter only. |

---

## Execution status

- [x] Spec finalized
- [x] Framing chosen (A first, B follow-up gated on A telemetry, C deferred)
- [x] Open questions resolved (9/9)
- [ ] PR(s) drafted

### PR sequencing

| PR | Scope | LOC | Standalone? |
|:---|:---|:---|:---|
| 1 | Honor `contextFiles` always, path-only, with annotations support | ~80 | Yes |
| 2 | Sandwich-pattern prompt reorder | ~50 | Yes |
| 3 | Fix tdd-simple header rendering bug | ~30 | Yes (after root-cause) |
| 4 | Description quality rules — planner prompt + synthesis prompt | ~115 | Yes (orthogonal to 1-3) |
| **A total** | | **~275 LOC** | |
| 5 (gated on A telemetry) | Section-tag vocabulary + planner prompt + filtering (Framing B) | ~325 + content migration | After A measurement |
| 6 (gated on B telemetry) | On-demand rule index (Framing C) | ~800 | After B measurement |

PRs 1-4 can land in parallel — they touch independent files. PR 4 specifically depends on `AC_QUALITY_RULES`'s style as a pattern but has no code dependency on the others.

Execution deferred until PR drafting begins.
