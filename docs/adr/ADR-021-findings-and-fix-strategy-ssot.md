# ADR-021: Finding Type SSOT

**Status:** Accepted
**Date:** 2026-05-02
**Accepted:** 2026-05-04
**Author:** William Khoo, Claude
**Supersedes:** —
**Related:** ADR-022 (Fix Strategy + Cycle Orchestration — companion ADR built on this type)

> **Implementation status (2026-05-04):** Phases 1–4 and 6–9 shipped. **Phase 5 (TDD verifier producer) is suggestion-only and not on the implementation roadmap** — the TDD subsystem already has its own self-contained fix mechanism (3-session orchestration + tier escalation; see [src/tdd/verdict.ts](../../src/tdd/verdict.ts), [src/pipeline/stages/execution-helpers.ts:56](../../src/pipeline/stages/execution-helpers.ts#L56), [src/execution/escalation/tier-escalation.ts:68](../../src/execution/escalation/tier-escalation.ts#L68)). Verifier failures route through `categorizeVerdict()` → `routeTddFailure()` → tier escalation, never through `runFixCycle`. The `"tdd-verifier"` `FindingSource` enum value is preserved as a reserved slot but has no producer adapter and no consumer; building one today would be unread emission. Revisit only if a per-finding TDD rectification path is introduced (would require its own ADR). The `acceptance.fix.findingsV2` flag was skipped — schema rolled out unconditionally after dogfood validation. Full-suite gate exhaustion before verifier is represented as a TDD failure category (`full-suite-gate-exhausted`) and is not emitted as a `tdd-verifier` finding.

---

## Context

Five subsystems each carry their own "thing that's wrong" type:

| Subsystem | Type | Defined at |
|:---|:---|:---|
| Plugin reviewers | `ReviewFinding` | [src/plugins/extensions.ts:20](../../src/plugins/extensions.ts#L20) |
| LLM reviewers (semantic, adversarial) | `LlmReviewFinding` | [src/operations/types.ts:171](../../src/operations/types.ts#L171) |
| Adversarial review carry-forward | `AdversarialFindingsCache.findings[]` | [src/review/types.ts:171](../../src/review/types.ts#L171) |
| Semantic review verdict | `SemanticVerdict.findings: ReviewFinding[]` | [src/acceptance/types.ts:139](../../src/acceptance/types.ts#L139) |
| Acceptance diagnosis | `DiagnosisResult.{testIssues, sourceIssues}: string[]` | [src/acceptance/types.ts:153](../../src/acceptance/types.ts#L153) |

The shapes are siblings — same fields with different names — and the unstructured `string[]` in acceptance carries no category, no file/line, no fixTarget. This blocks structured prior-attempt history (the falsified-hypothesis pattern that adversarial review already uses) and prevents cross-stage finding aggregation.

ADR-021's scope is **types only**. The orchestration questions (cycle, strategies, validator coupling, verdict fast-paths) are deliberately deferred to ADR-022 because they require design decisions that can be made independently of the wire format.

## Decision

### 1. Single `Finding` type

```typescript
type FindingSource =
  | "lint"
  | "typecheck"
  | "test-runner"
  | "semantic-review"
  | "adversarial-review"
  | "acceptance-diagnose"
  | "tdd-verifier"
  | "plugin";

type FindingSeverity = "critical" | "error" | "warning" | "info" | "low" | "unverifiable";

type FixTarget = "source" | "test";

type DiagnosisCategory =
  | "stdout-capture"
  | "ac-mismatch"
  | "framework-misuse"
  | "missing-impl"
  | "import-path"
  | "hook-failure"          // AC-HOOK sentinel — beforeAll / afterAll timeout
  | "test-runner-error"     // AC-ERROR sentinel — runner crashed before test bodies ran
  | "stub-test"             // detected stub via isStubTestFile heuristic
  | "other";

interface Finding {
  source: FindingSource;
  tool?: string;                       // "biome" | "tsc" | "semgrep" | …
  severity: FindingSeverity;
  category: string;                    // free-form; per-source enum documented at producer
  rule?: string;                       // biome rule id, TS code, AC id, etc.
  file?: string;                       // ALWAYS repoRoot-relative — see §3
  line?: number; column?: number; endLine?: number; endColumn?: number;
  message: string;
  suggestion?: string;
  confidence?: number;                 // LLM producers only
  fixTarget?: "source" | "test";       // optional; consumers derive from file when unset
  meta?: Record<string, unknown>;      // producer-specific extras
}
```

### 2. Severity standardises on `"warning"`

Adversarial review's prompt schema currently emits `"warn"`. Migration is one schema change in [adversarial-review-builder.ts:128](../../src/prompts/builders/adversarial-review-builder.ts#L128). The read path is already covered by `normalizeSeverity()` adapters in [src/review/semantic-helpers.ts:55](../../src/review/semantic-helpers.ts#L55), [src/review/adversarial-helpers.ts](../../src/review/adversarial-helpers.ts), and [src/review/dialogue.ts](../../src/review/dialogue.ts) which already accept `"warn"` and emit `"warning"`. The downgrade-to-unverifiable path in [src/review/semantic-evidence.ts:101](../../src/review/semantic-evidence.ts#L101) is unaffected.

`"unverifiable"` is preserved (adversarial-only today). `"low"` is preserved for plugin compatibility.

### 3. File path SSOT — relative to nax's workdir

Every `Finding.file` is **relative to nax's workdir** — the directory where `.nax/` lives and where nax is invoked. In single-package projects this is the project root; in monorepos with per-package nax invocations this is the package directory (`packageDir`).

Rationale:
- Matches the convention already used across nax for test-file pattern resolution, story workdirs, and review artifact paths (see [.claude/rules/monorepo-awareness.md](../../.claude/rules/monorepo-awareness.md)).
- The autofix routing layer in [splitFindingsByScope](../../src/pipeline/stages/autofix-scope-split.ts#L158) and [isTestFile](../../src/test-runners/) already operates on workdir-relative paths.
- Plugin contract (`ReviewFinding.file: workdir-relative`) uses the same convention — no rebasing needed at the boundary.

Producer adapters are responsible for normalisation:

| Producer | Native format | Adapter rebases to |
|:---|:---|:---|
| Biome JSON output | `cwd`-relative | `path.relative(workdir, resolve(cwd, file))` |
| `tsc` `--pretty=false` | absolute | `path.relative(workdir, file)` |
| `LlmReviewFinding` | LLM-emitted | adapter resolves against the active workdir |
| `ReviewFinding` (plugin) | workdir-relative per contract | direct (no rebasing) |
| Acceptance diagnose | LLM-emitted; new prompt schema instructs workdir-relative | direct |

**Cross-package aggregation** — when a future consumer needs to aggregate findings across multiple monorepo packages (e.g. an "all open findings on this branch" view), it must thread workdir context per finding-batch externally. `Finding.file` alone is ambiguous in that case. This is a consumer concern, deliberately not solved at the type layer.

### 4. Absorption table — existing types map cleanly

| Source field | Target | Adapter rule |
|:---|:---|:---|
| `LlmReviewFinding.issue` | `Finding.message` | rename |
| `LlmReviewFinding.acId` | `Finding.rule` | rename (semantic only) |
| `LlmReviewFinding.verifiedBy` | `Finding.meta.verifiedBy` | demote |
| `LlmReviewFinding.severity: "warn"` | `Finding.severity: "warning"` | rename via `normalizeSeverity` (already exists) |
| `AdversarialFindingsCache.findings[].issue` | `Finding.message` | rename |
| `AdversarialFindingsCache.findings[].severity: "warn"` | `Finding.severity: "warning"` | rename |
| `ReviewFinding.ruleId` | `Finding.rule` | rename |
| `ReviewFinding.source` (tool name) | `Finding.tool` | rename; top-level `source` becomes `"plugin"` |
| `ReviewFinding.url` | `Finding.meta.url` | demote |
| `DiagnosisResult.testIssues: string[]` | `Finding[]` with `fixTarget: "test"` | LLM prompt schema change (see §6) |
| `DiagnosisResult.sourceIssues: string[]` | `Finding[]` with `fixTarget: "source"` | LLM prompt schema change |

### 5. Acceptance sentinels become first-class findings

`AC-HOOK` and `AC-ERROR` sentinels in [acceptance-loop.ts:90](../../src/execution/lifecycle/acceptance-loop.ts#L90) are currently special-cased in `failedACs: string[]`. They become `Finding[]` entries:

```typescript
{ source: "acceptance-diagnose", category: "hook-failure", severity: "error", message: "beforeAll timed out (8000ms)", file: <test-file>, fixTarget: "test" }
{ source: "acceptance-diagnose", category: "test-runner-error", severity: "critical", message: "Bun test runner crashed before test bodies ran", fixTarget: "test" }
```

The orchestration layer (ADR-022) decides how to route these — that's deferred. Phase 2 of this ADR only requires producers to emit them as findings.

### 6. Acceptance diagnose prompt schema change

`acceptanceDiagnoseOp` ([src/operations/acceptance-diagnose.ts](../../src/operations/acceptance-diagnose.ts)) currently asks the LLM for `testIssues: string[]` and `sourceIssues: string[]`. The new schema asks for `findings: Finding[]` with `fixTarget` per item:

```json
{
  "verdict": "source_bug" | "test_bug" | "both",
  "reasoning": "...",
  "confidence": 0.0–1.0,
  "findings": [
    {
      "fixTarget": "source" | "test",
      "category": "stdout-capture" | "ac-mismatch" | …,
      "file": "src/greeting.ts",
      "line": 12,
      "message": "...",
      "suggestion": "..."
    }
  ]
}
```

The legacy `testIssues` / `sourceIssues` fields stay parseable for one release as a fallback (parser checks `findings` first; if absent, wraps each string as `Finding{ category: "legacy", message: <string> }` with `fixTarget` from which array it came from). `verdict` stays in the schema — see ADR-022 for why (fast-paths can produce a verdict without findings).

Schema change ships behind `acceptance.fix.findingsV2` config flag, default off, for one release. Bench against `nax-dogfood/fixtures/hello-lint` audit fixtures with both modes.

## Phased implementation

Each phase after phase 1 is a **fold-per-producer** PR — the producer's adapter migration AND its direct consumers ship together. This avoids the "additive emission of unread `Finding[]`" interval that an earlier draft proposed and ensures every PR is a complete, reviewable unit.

| Phase | Producer | Direct consumer(s) updated in same PR | Notes |
|:---|:---|:---|:---|
| **1. Types** | — | — | This PR. `src/findings/{types,index}.ts`. Zero consumers. |
| **2. Plugin adapter** | `IReviewPlugin` boundary | `failedChecks` aggregator in autofix; review-result audit serialiser | Plugin contract (`ReviewFinding`) unchanged. Internal nax converts to `Finding` at the IReviewPlugin call site. |
| **3. Lint** | Biome JSON parser | `splitFindingsByScope` lint branch; lint output rendering | Replaces raw output parsing. Mechanical, deterministic. |
| **4. Typecheck** | tsc `--pretty=false` parser | `splitFindingsByScope` typecheck branch | Same shape change as lint. |
| **5. TDD verifier** | TDD verifier output parser | Verifier verdict consumer | **Suggestion only — not on roadmap.** TDD has its own fix mechanism (3-session + tier escalation); `categorizeVerdict()` → `routeTddFailure()` never enters `runFixCycle`. The `"tdd-verifier"` enum slot stays reserved but unproduced. Revisit only if a per-finding TDD rectification path is introduced (separate ADR). |
| **6. Adversarial** | `acceptanceDiagnoseOp` and the adversarial review op | `buildPriorFindingsBlock` reads `Finding[]`; `AdversarialFindingsCache.findings[]` becomes `Finding[]` | Severity rename `"warn"` → `"warning"` in OUTPUT_SCHEMA block lands here. Read-path `normalizeSeverity` adapters in `semantic-helpers.ts`/`adversarial-helpers.ts`/`dialogue.ts` already handle the rename. |
| **7. Semantic** | semantic review op | `buildAttemptContextBlock`, `SemanticVerdict.findings`, semantic evidence verifier | `verifiedBy` → `meta.verifiedBy`; AC ID → `rule`. |
| **8. Acceptance diagnose** | `acceptanceDiagnoseOp` prompt schema | `applyFix` consumes `findings: Finding[]` (with `fixTarget` per item) instead of `testIssues`/`sourceIssues`. AC-HOOK / AC-ERROR sentinels emitted as findings (§5). | Behind `acceptance.fix.findingsV2` flag, default off. Bench against `nax-dogfood/fixtures/hello-lint`. Largest behaviour change in the ADR; lands last to benefit from prior phases' patterns. |
| **9. Cleanup** | — | delete `LlmReviewFinding`, `AdversarialFindingsCache`, `DiagnosisResult.{testIssues,sourceIssues}`, scaffolding adapters | Zero risk. |

Phases 2–7 are unblocked by ADR-022. Phase 8 (acceptance) and the ADR-022 cycle can land in either order — they're independent. Phase 9 (cleanup) requires phase 8 done plus all ADR-022 consumer migrations done.

**What ADR-022 owns** (orchestration, not data): cycle types (`Iteration`, `FixApplied`, `FixStrategy`), `runFixCycle`, `classifyOutcome`, the shared `buildPriorIterationsBlock` helper that replaces `buildPriorFindingsBlock` + `buildAttemptContextBlock` + acceptance's `previousFailure` accumulator. ADR-022 operates on `Finding[]` which already exists everywhere by the time it lands.

## Consequences

### Positive

- Producers emit a single shape; cross-stage aggregation becomes trivial.
- Acceptance sentinels (`AC-HOOK`, `AC-ERROR`) become structured — orchestration in ADR-022 can route them like any other finding.
- The severity rename (`"warn"` → `"warning"`) is much smaller than initially estimated thanks to existing `normalizeSeverity` adapters.
- File-path SSOT decision unblocks cross-package finding aggregation (issue-level reporting, dashboards).

### Negative

- Producers each gain a thin adapter at their boundary. ~6 adapters total, ~30 lines each.
- The acceptance diagnose prompt schema change requires a soak period and a feature flag.

### Neutral

- Plugin contract (`ReviewFinding`) is preserved as-is. Internal normalisation happens at the adapter boundary.

## What this ADR explicitly does not decide

- How findings are consumed by fix orchestration (cycle / strategies / validator coupling) — see ADR-022.
- Whether `verdict` stays on `DiagnosisResult` or is derived — see ADR-022.
- How prior attempts are carried forward in prompts (`buildPriorIterationsBlock`) — see ADR-022.
- How `stubRegenCount` and acceptance fast-paths integrate with strategies — see ADR-022.

This split lets the type migration ship and bake while orchestration design iterates.

## References

- [src/plugins/extensions.ts:20](../../src/plugins/extensions.ts#L20) — `ReviewFinding` (plugin contract; preserved as-is)
- [src/operations/types.ts:171](../../src/operations/types.ts#L171) — `LlmReviewFinding` (deprecated by phase 6)
- [src/review/types.ts:171](../../src/review/types.ts#L171) — `AdversarialFindingsCache` (deprecated by phase 6)
- [src/acceptance/types.ts:153](../../src/acceptance/types.ts#L153) — `DiagnosisResult` (legacy fields deprecated by phase 6)
- [src/review/semantic-helpers.ts:55](../../src/review/semantic-helpers.ts#L55) — `normalizeSeverity` (read-path adapter for severity rename)
- ADR-022 — Fix Strategy + Cycle Orchestration (companion ADR)
