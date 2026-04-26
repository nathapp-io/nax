# ADR-018 Wave 3 Phase B — Task Plan

**Branch:** `feat/adr-018-wave-3-phase-b`
**Date:** 2026-04-26
**Tracking doc:** `docs/superpowers/plans/2026-04-26-adr-018-wave-3.md`

---

## Scope

Create three review ops that map the review subsystem into the `callOp` surface:

| Op | File | Kind | Session role | Stage |
|:---|:---|:---|:---|:---|
| `semanticReviewOp` | `src/operations/semantic-review.ts` | `run` | `reviewer-semantic` | `review` |
| `adversarialReviewOp` | `src/operations/adversarial-review.ts` | `run` | `reviewer-adversarial` | `review` |
| `rectifyOp` | `src/operations/rectify.ts` | `run` | `implementer` | `review` |

**Out of scope for Phase B:** migrating callers in `src/review/semantic.ts`,
`src/review/adversarial.ts`, or `src/pipeline/stages/autofix.ts` to use `callOp`.
The keepOpen/JSON-retry orchestration in those files is too stateful to migrate
safely in one PR (deferred to a future phase after Phase D lands).

---

## Kind correction vs tracking doc

The Wave 3 tracking doc initially listed semantic-review and adversarial-review as
`kind: "complete"`. Both require tool access (ref mode: git commands) and stateful
session history for JSON retry — they must be `kind: "run"`. The tracking doc is
updated in T6 to reflect this.

---

## Type designs

### SemanticReviewInput / SemanticReviewOutput

```typescript
interface LlmReviewFinding {
  severity: string;
  file: string;
  line?: number;
  issue: string;
  suggestion?: string;
}

interface SemanticReviewInput {
  story: SemanticStory;
  semanticConfig: SemanticReviewConfig;
  mode: "embedded" | "ref";
  diff?: string;
  storyGitRef?: string;
  stat?: string;
  priorFailures?: PriorFailure[];
  excludePatterns?: string[];
}

interface SemanticReviewOutput {
  passed: boolean;
  findings: LlmReviewFinding[];
  failOpen?: boolean;
}
```

Fallback: `{ passed: true, findings: [], failOpen: true }` when JSON unparseable.

### AdversarialReviewInput / AdversarialReviewOutput

Same `LlmReviewFinding`, same output shape. Input adds `testInventory?` (used when
`mode: "embedded"` for test gap audit).

### RectifyInput / RectifyOutput

```typescript
interface RectifyInput {
  failedChecks: ReviewCheckResult[];
  story: UserStory;
}

interface RectifyOutput {
  applied: true;
}
```

`parse()` always returns `{ applied: true }` — rectification success is verified
by the caller re-running the checks, not by parsing the agent output.

---

## Config selectors

| Op | Selector | Why |
|:---|:---|:---|
| `semanticReviewOp` | `reviewConfigSelector` | picks `review` + `debate` slices |
| `adversarialReviewOp` | `reviewConfigSelector` | same |
| `rectifyOp` | `rectifyConfigSelector` | picks `rectify` + `execution` slices |

---

## Task sequence

| # | Task | Files touched |
|:--|:-----|:--------------|
| T1 | RED shape tests for all 3 ops | `test/unit/operations/semantic-review.test.ts`, `adversarial-review.test.ts`, `rectify.test.ts` |
| T2 | `src/operations/semantic-review.ts` | new file |
| T3 | `src/operations/adversarial-review.ts` | new file |
| T4 | `src/operations/rectify.ts` | new file |
| T5 | Export all 3 from `src/operations/index.ts` | `index.ts` |
| T6 | Gates + tracking doc + commit | Wave 3 tracking doc |

---

## Anti-patterns to avoid

- **AP-1**: Do not redefine `SemanticStory`, `SemanticReviewConfig`, `AdversarialReviewConfig` — import from `src/review/types`
- **AP-2**: Do not copy-paste builder logic — call builder directly in `build()`
- **AP-3**: Do not hand-roll JSON parsing — `tryParseLLMJson` from `src/utils/llm-json`
- **AP-4**: Do not flatten `LlmReviewFinding` into `ReviewFinding` (plugin type) — the op output is the raw LLM shape; conversion to plugin type stays in callers
