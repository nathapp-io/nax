# ADR-025 Escalation Completeness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close four gaps left by ADR-025's cross-agent escalation: (1) structured `priorFailures` is computed but never rendered into the agent prompt; (2) escalation records and `StructuredFailure` don't capture which agent/profile produced/received the failure; (3) the pre-iteration escalation path captures no prior-failure context at all; (4) resetting a failed story to pending leaves it stuck at the last rung with exhausted attempts, so re-runs re-fail instantly.

**Architecture:** All four fixes are agent-agnostic — they fire for single-agent (tier-only) ladders and cross-agent ladders alike. Phase 1 unsticks the prompt-injection drop (highest impact, lowest risk). Phase 2 enriches the persisted records with agent/profile provenance. Phase 3 makes reset deterministic via a new `autoMode.escalation.resetMode: "initial" | "last"` flag (default `"initial"`) plus a persisted `initialModelTier` origin field. Phase 4 syncs the ADR and runs the full gate.

**Tech Stack:** Bun 1.3.7+, TypeScript strict, `bun:test`, Zod schemas, Biome. nax is Bun-native — no Node APIs. Tests use the `_deps` injection pattern, never `mock.module()`.

---

## Background context for the implementer (read this first)

You have **zero assumed context** on nax. Here is everything you need:

### The escalation flow has TWO paths

1. **`handleTierEscalation`** (`src/execution/escalation/tier-escalation.ts:317-486`) — fires when the pipeline emits a `escalate` action (a quality failure: tests failing, review findings, etc.). This path **does** populate `priorErrors` and `priorFailures` today (lines 451-454).
2. **`preIterationTierCheck`** (`src/execution/escalation/tier-escalation.ts:117-252`) — fires when a story has burned its per-rung attempt budget *before* an iteration even spawns. This path writes an `escalations` record (lines 177-184) but **does NOT** populate `priorErrors`/`priorFailures` at all. This is gap #3.

### The prompt-injection drop (gap #1)

`buildContext()` (`src/context/builder.ts:104-170`) builds an array of typed `ContextElement`s. It pushes a `prior-failures` element (line 121) and `error` elements (line 127). The elements are converted to the markdown that reaches the agent by `formatContextAsMarkdown()` (`src/context/formatter.ts:15-37`). That formatter renders `progress`, `error`, `test-coverage`, `story`, `dependency`, `file` — but has **no case for `prior-failures`** (nor `planning-analysis`, a second silent drop). So `priorFailures` is computed, budgeted, stored on `BuiltContext.elements`, and then thrown away before the prompt. `priorErrors` survives because it uses the `error` element type, which *is* rendered (`formatter.ts:99-106`).

### The reset bug (gap #4) is agent-agnostic

On re-run, `resetFailedStoriesToPending()` (`src/prd/index.ts:248-264`) only flips `status` failed→pending. It does NOT reset `attempts`, `routing.modelTier`, or `routing.agent`. Meanwhile the routing stage deliberately preserves an escalated tier (BUG-032, `src/pipeline/stages/routing.ts:66-69`) keyed on **tier rank + escalation-record presence**, not agent. So a single-agent `fast→balanced→powerful` story comes back stuck at `powerful` with `attempts` maxed; `preIterationTierCheck` (`tier-escalation.ts:147`) then sees `attempts >= budget`, escalates, finds no next rung, and re-fails immediately. The reset fix must therefore **always** reset `attempts` + restore `modelTier`, and **conditionally** restore `agent` (only when `initialAgent` is set).

There is no persisted "initial tier" today (`StoryRouting` has `initialComplexity` but not `initialModelTier`, and profile-seeded starts can differ from complexity-derived), so `"initial"` reset needs a new persisted field.

### Conventions you MUST follow (enforced by hooks/CI)

- **Never run bare `bun test`** — a PreToolUse hook blocks it. Use `timeout 30 bun test <path> --timeout=5000` for scoped runs and `bun run test` / `bun run test:bail` for the full suite. (`.claude/rules/testing-commands.md`)
- **Logger only** — never `console.log`. `logger.<level>("<stage>", "<msg>", { storyId: ..., ... })` with `storyId` as the FIRST key. (`.claude/rules/project-conventions.md`)
- **NaxError** for thrown errors, not `Error`. (`.claude/rules/error-handling.md`)
- **`_deps` injection** for testability — the modules you touch already export `_tierEscalationDeps` / `_routingDeps`. Don't use `mock.module()`.
- **Barrel imports** — import from `src/prd`, `src/config`, not deep leaf paths (except type-only imports). Type-only config slices import from `src/config/selectors`.
- **600-line file limit**, functions ≤30 lines / ≤3 positional params (use an options object beyond that).
- Conventional commits: `feat:`, `fix:`, `test:`, `docs:`.

### File map (what each task touches)

| File | Responsibility | Tasks |
|:--|:--|:--|
| `src/context/formatter.ts` | element → markdown for the agent prompt | 1.1 |
| `src/context/elements.ts` | element factories (`formatPriorFailures`) | 2.2 (render new fields) |
| `src/execution/escalation/tier-escalation.ts` | both escalation paths; record/failure builders | 1.2, 2.1, 2.2, 2.3 |
| `src/prd/types.ts` | `EscalationAttempt`, `StructuredFailure`, `StoryRouting` | 2.1, 2.2, 3.1 |
| `src/pipeline/stages/routing.ts` | first-route origin capture | 3.1 |
| `src/plan/strategies/finalize-routing.ts` | plan-time origin stamping | 3.1 (consistency) |
| `src/config/schemas-execution.ts` | `autoMode.escalation` Zod schema | 3.2 |
| `src/config/runtime-types.ts` | `escalation` runtime type | 3.2 |
| `src/prd/index.ts` | `resetFailedStoriesToPending` | 3.3 |
| `src/execution/lifecycle/run-initialization.ts` | reset call site | 3.4 |
| `docs/adr/ADR-025-*.md` | ADR consequences/open questions | 4.1 |

---

## Phase 1 — Fix the prompt-injection drop + pre-iteration capture (highest impact)

### Task 1.1: Render `prior-failures` and `planning-analysis` in the markdown formatter

**Files:**
- Modify: `src/context/formatter.ts:29-34`
- Test: `test/unit/context/context-format.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `test/unit/context/context-format.test.ts` (match the existing import/describe style already in that file):

```typescript
import { describe, expect, test } from "bun:test";
import { formatContextAsMarkdown } from "@/context/formatter";
import type { BuiltContext } from "@/context/types";

describe("formatContextAsMarkdown — prior-failures rendering (ADR-025 gap #1)", () => {
  test("renders prior-failures element content into the markdown", () => {
    const built: BuiltContext = {
      summary: "Context: prior-failures (10 tokens)",
      totalTokens: 10,
      truncated: false,
      elements: [
        {
          type: "prior-failures",
          content: "## Prior Failures (Structured Context)\n### Attempt 1 — fast\n**Summary:** Tier fast [tests-failing]: 2 tests red",
          priority: 95,
          tokens: 10,
        },
      ],
    };

    const md = formatContextAsMarkdown(built);

    expect(md).toContain("Prior Failures (Structured Context)");
    expect(md).toContain("Tier fast [tests-failing]: 2 tests red");
  });

  test("renders planning-analysis element content into the markdown", () => {
    const built: BuiltContext = {
      summary: "Context: planning-analysis (5 tokens)",
      totalTokens: 5,
      truncated: false,
      elements: [
        { type: "planning-analysis", content: "ANALYSIS: use the existing resolver", priority: 88, tokens: 5 },
      ],
    };

    const md = formatContextAsMarkdown(built);

    expect(md).toContain("ANALYSIS: use the existing resolver");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 30 bun test test/unit/context/context-format.test.ts --timeout=5000`
Expected: FAIL — the two new assertions fail because the formatter drops both element types.

- [ ] **Step 3: Write minimal implementation**

In `src/context/formatter.ts`, add two `renderSection` calls. Place them after the `dependency` line and before the `file` line (so failure context appears above source files, matching the priority order 95 > 88 > 80):

```typescript
  renderSection(sections, byType, "progress", "## Progress\n", renderSimple);
  renderErrorSection(sections, byType);
  renderSection(sections, byType, "prior-failures", "", renderSimple);
  renderSection(sections, byType, "planning-analysis", "## Planning Analysis\n", renderSimple);
  renderSection(sections, byType, "test-coverage", "", renderSimple);
  renderSection(sections, byType, "story", "## Current Story\n", renderSimple);
  renderSection(sections, byType, "dependency", "## Dependency Stories\n", renderSimple);
  renderSection(sections, byType, "file", "## Relevant Source Files\n", renderSimple);
```

Note: `prior-failures` uses an empty header (`""`) because `formatPriorFailures` already emits its own `## Prior Failures (Structured Context)` heading (`src/context/elements.ts:83`). `planning-analysis` content is raw prose, so it gets a heading here.

Also update the function doc comment at `formatter.ts:9-14` to mention prior-failures and planning-analysis.

- [ ] **Step 4: Run test to verify it passes**

Run: `timeout 30 bun test test/unit/context/context-format.test.ts --timeout=5000`
Expected: PASS.

- [ ] **Step 5: Run the broader context suite to confirm no regression**

Run: `timeout 60 bun test test/unit/context/ --timeout=5000`
Expected: PASS (existing tests unaffected; ordering change is additive).

- [ ] **Step 6: Commit**

```bash
git add src/context/formatter.ts test/unit/context/context-format.test.ts
git commit -m "fix(context): render prior-failures and planning-analysis into agent prompt

Both element types were computed by buildContext and dropped by
formatContextAsMarkdown (no render case). Escalated iterations were
flying blind to structured failure context. ADR-025 gap #1."
```

---

### Task 1.2: Capture `priorErrors` + `priorFailures` in the pre-iteration escalation path

**Files:**
- Modify: `src/execution/escalation/tier-escalation.ts:170-199` (inside `preIterationTierCheck`)
- Test: `test/unit/execution/escalation/tier-escalation.test.ts`

Context: `preIterationTierCheck` already imports `StructuredFailure`/`UserStory` types and uses `buildEscalationRecord`. You will reuse the existing `buildEscalationFailure` helper (defined at `tier-escalation.ts:27-57`). The pre-iteration path has no pipeline reason or review findings (the iteration never ran), so the failure summary is budget-based.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/execution/escalation/tier-escalation.test.ts` (reuse the existing test setup helpers in that file — it already constructs `UserStory`/`PRD`/`NaxConfig` fixtures and stubs `_tierEscalationDeps.savePRD`). Model the new test on the existing pre-iteration tests near `describe`/the `preIterationTierCheck` block:

```typescript
test("preIterationTierCheck records priorErrors and priorFailures when escalating (gap #3)", async () => {
  // Story has exhausted the 'fast' rung budget (2 attempts).
  const story = makeStory({
    id: "US-001",
    attempts: 2,
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "x" },
  });
  const prd = makePRD([story]);
  const config = makeConfig({
    autoMode: {
      escalation: {
        enabled: true,
        tierOrder: [
          { tier: "fast", attempts: 2 },
          { tier: "balanced", attempts: 2 },
        ],
      },
    },
  });

  let savedPrd: PRD | undefined;
  _tierEscalationDeps.savePRD = async (p: PRD) => {
    savedPrd = p;
  };

  const result = await preIterationTierCheck(
    story,
    { modelTier: "fast" },
    config,
    prd,
    "/tmp/prd.json",
    undefined,
    {} as never,
    "test-feature",
    0,
    "/tmp/work",
  );

  expect(result.shouldSkipIteration).toBe(true);
  const escalated = savedPrd?.userStories.find((s) => s.id === "US-001");
  expect(escalated?.routing?.modelTier).toBe("balanced");
  // Gap #3: prior context must now be captured.
  expect(escalated?.priorErrors?.length).toBeGreaterThan(0);
  expect(escalated?.priorErrors?.[0]).toContain("fast");
  expect(escalated?.priorFailures?.length).toBe(1);
  expect(escalated?.priorFailures?.[0]?.modelTier).toBe("fast");
  expect(escalated?.priorFailures?.[0]?.summary).toContain("budget");
});
```

> If the test file lacks `makeStory`/`makePRD`/`makeConfig` helpers, check the top of `tier-escalation.test.ts` for the actual fixture builders it uses and adapt the names. Do NOT invent new global helpers — reuse what the file already has.

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 30 bun test test/unit/execution/escalation/tier-escalation.test.ts --timeout=5000`
Expected: FAIL — `priorErrors`/`priorFailures` are `undefined` on the escalated story.

- [ ] **Step 3: Write minimal implementation**

In `src/execution/escalation/tier-escalation.ts`, inside `preIterationTierCheck`, locate the `updatedPrd` construction (lines 170-199). Build a budget-based failure summary and add `priorErrors`/`priorFailures` to the mapped story.

First, just above the `const updatedPrd = {` line (around line 170), add:

```typescript
    const budgetReason = `Exceeded tier budget for ${currentTier} (${story.attempts}/${tierCfg.attempts})`;
    const preIterationFailure = buildEscalationFailure(
      story,
      currentTier,
      undefined, // no review findings — iteration never ran
      undefined, // no attempt cost — iteration never ran
      budgetReason,
      undefined, // no TDD failure category — pre-iteration
    );
    const preIterationError = `Attempt ${story.attempts} exhausted budget on tier: ${currentTier}`;
```

Then, inside the `prd.userStories.map(...)` callback for the matching story (the object returned at lines 174-196), add these two fields alongside the existing `attempts`, `escalations`, `routing`:

```typescript
              priorErrors: [...(s.priorErrors || []), preIterationError],
              priorFailures: [...(s.priorFailures || []), preIterationFailure].slice(-3),
```

The `.slice(-3)` mirrors the cap used in `handleTierEscalation` (line 454, issue #253).

- [ ] **Step 4: Run test to verify it passes**

Run: `timeout 30 bun test test/unit/execution/escalation/tier-escalation.test.ts --timeout=5000`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/execution/escalation/tier-escalation.ts test/unit/execution/escalation/tier-escalation.test.ts
git commit -m "fix(escalation): capture prior context in pre-iteration escalation path

preIterationTierCheck escalated tiers without recording priorErrors or
priorFailures, so budget-exhausted escalations carried zero context into
the next rung. ADR-025 gap #3."
```

---

## Phase 2 — Add agent/profile provenance to records

### Task 2.1: Add `fromAgent`/`toAgent` to `EscalationAttempt` and `buildEscalationRecord`

**Files:**
- Modify: `src/prd/types.ts:98-104` (`EscalationAttempt`)
- Modify: `src/execution/escalation/tier-escalation.ts:59-70` (`buildEscalationRecord`) and its two call sites
- Test: `test/unit/execution/escalation/tier-escalation.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `test/unit/execution/escalation/tier-escalation.test.ts`. Reuse the existing cross-agent escalation fixture style (the file already has cross-agent tests around the `tierOrder: [{tier,agent,attempts}, ...]` shape):

```typescript
test("handleTierEscalation records fromAgent/toAgent on cross-agent escalation (gap #2)", async () => {
  const story = makeStory({
    id: "US-001",
    attempts: 1,
    routing: {
      complexity: "medium",
      modelTier: "balanced",
      testStrategy: "test-after",
      reasoning: "x",
      agent: "claude",
      agentProfileId: "fast-claude",
    },
  });
  const prd = makePRD([story]);
  const config = makeConfig({
    models: { claude: {}, codex: {} } as never,
    autoMode: {
      escalation: {
        enabled: true,
        tierOrder: [
          { tier: "fast", agent: "claude", attempts: 2 },
          { tier: "balanced", agent: "claude", attempts: 2 },
          { tier: "fast", agent: "codex", attempts: 2 },
        ],
      },
    },
  });

  let savedPrd: PRD | undefined;
  _tierEscalationDeps.savePRD = async (p: PRD) => {
    savedPrd = p;
  };

  await handleTierEscalation({
    story,
    storiesToExecute: [story],
    isBatchExecution: false,
    routing: { modelTier: "balanced", testStrategy: "test-after" },
    pipelineResult: { reason: "tests failing", context: {} },
    config,
    prd,
    prdPath: "/tmp/prd.json",
    hooks: {} as never,
    feature: "f",
    totalCost: 0,
    workdir: "/tmp/work",
    agentManager: {} as never,
  });

  const escalated = savedPrd?.userStories.find((s) => s.id === "US-001");
  const record = escalated?.escalations.at(-1);
  expect(record?.fromTier).toBe("balanced");
  expect(record?.toTier).toBe("fast");
  expect(record?.fromAgent).toBe("claude");
  expect(record?.toAgent).toBe("codex");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 30 bun test test/unit/execution/escalation/tier-escalation.test.ts --timeout=5000`
Expected: FAIL — `record.fromAgent`/`record.toAgent` are `undefined` (fields don't exist).

- [ ] **Step 3: Add the type fields**

In `src/prd/types.ts`, extend `EscalationAttempt`:

```typescript
/** Escalation attempt tracking */
export interface EscalationAttempt {
  fromTier: ModelTier;
  toTier: ModelTier;
  /** Agent active before this escalation (cross-agent ladders) — undefined for single-agent ladders */
  fromAgent?: string;
  /** Agent the story escalated to (cross-agent ladders) — undefined for single-agent ladders */
  toAgent?: string;
  reason: string;
  timestamp: string;
}
```

- [ ] **Step 4: Update `buildEscalationRecord` to accept agents**

In `src/execution/escalation/tier-escalation.ts`, change the signature (lines 59-70):

```typescript
function buildEscalationRecord(
  currentTier: string,
  nextTier: string,
  reason: string,
  agents?: { fromAgent?: string; toAgent?: string },
): UserStory["escalations"][number] {
  return {
    fromTier: currentTier,
    toTier: nextTier,
    ...(agents?.fromAgent !== undefined ? { fromAgent: agents.fromAgent } : {}),
    ...(agents?.toAgent !== undefined ? { toAgent: agents.toAgent } : {}),
    reason,
    timestamp: new Date().toISOString(),
  };
}
```

- [ ] **Step 5: Pass agents at both call sites**

Call site A — `handleTierEscalation`, the `escalationRecord` build (lines 423-430). `nextAgent` is already in scope (line 338); the current agent is `s.routing?.agent`:

```typescript
      const escalationRecord =
        isChangingTier || shouldSwitchToTestAfter
          ? buildEscalationRecord(
              currentStoryTier,
              shouldSwitchToTestAfter ? currentStoryTier : escalatedTier,
              ctx.pipelineResult.reason ?? "Escalated to next retry path",
              { fromAgent: s.routing?.agent, toAgent: nextAgent ?? s.routing?.agent },
            )
          : undefined;
```

Call site B — `preIterationTierCheck`, the record build (lines 179-183). `nextAgent` is already in scope (line 155); the current agent is `story.routing?.agent`:

```typescript
                buildEscalationRecord(
                  currentTier,
                  escalatedTier,
                  `Exceeded tier budget for ${currentTier} (${story.attempts}/${tierCfg.attempts})`,
                  { fromAgent: story.routing?.agent, toAgent: nextAgent ?? story.routing?.agent },
                ),
```

- [ ] **Step 6: Run test to verify it passes**

Run: `timeout 30 bun test test/unit/execution/escalation/tier-escalation.test.ts --timeout=5000`
Expected: PASS.

- [ ] **Step 7: Run typecheck (new optional fields ripple through PRD reads)**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/prd/types.ts src/execution/escalation/tier-escalation.ts test/unit/execution/escalation/tier-escalation.test.ts
git commit -m "feat(escalation): record fromAgent/toAgent on escalation history

EscalationAttempt was tier-only, so a cross-agent jump was
indistinguishable from a same-agent tier bump in the audit trail.
ADR-025 gap #2."
```

---

### Task 2.2: Add `agent`/`agentProfileId` to `StructuredFailure` and render them

**Files:**
- Modify: `src/prd/types.ts:44-62` (`StructuredFailure`)
- Modify: `src/execution/escalation/tier-escalation.ts:27-57` (`buildEscalationFailure`) and call sites
- Modify: `src/context/elements.ts:77-119` (`formatPriorFailures`)
- Test: `test/unit/context/prior-failures.test.ts`, `test/unit/execution/escalation/tier-escalation.test.ts`

- [ ] **Step 1: Write the failing test (formatting)**

Add to `test/unit/context/prior-failures.test.ts` (it already imports `formatPriorFailures` and builds `StructuredFailure` fixtures):

```typescript
test("formatPriorFailures renders agent and profileId when present (gap #2)", () => {
  const md = formatPriorFailures([
    {
      attempt: 1,
      modelTier: "fast",
      agent: "claude",
      agentProfileId: "fast-claude",
      stage: "escalation",
      summary: "Tier fast: tests failing",
      timestamp: "2026-06-14T00:00:00.000Z",
    },
  ]);

  expect(md).toContain("claude");
  expect(md).toContain("fast-claude");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 30 bun test test/unit/context/prior-failures.test.ts --timeout=5000`
Expected: FAIL — agent/profile not in output (and `agent`/`agentProfileId` aren't valid `StructuredFailure` fields yet, so this also won't typecheck until Step 3).

- [ ] **Step 3: Add the type fields**

In `src/prd/types.ts`, extend `StructuredFailure` (add after `modelTier`):

```typescript
/** Structured failure context for escalated tiers */
export interface StructuredFailure {
  /** Attempt number when failure occurred */
  attempt: number;
  /** Model tier that was running */
  modelTier: string;
  /** Agent that produced this failure — undefined for single-agent ladders */
  agent?: string;
  /** Profile id active when this failure occurred — undefined when no profile assigned */
  agentProfileId?: string;
  /** Stage where failure occurred */
  stage: VerificationStage;
  /** Summary of what failed */
  summary: string;
  /** Parsed test failures (if applicable) */
  testFailures?: TestFailureContext[];
  /** Structured review findings from nax review producers. */
  reviewFindings?: import("../findings").Finding[];
  /** Estimated cost of this attempt (BUG-067: accumulated across escalations) */
  cost?: number;
  /** ISO timestamp when failure was recorded */
  timestamp: string;
}
```

- [ ] **Step 4: Populate the fields in `buildEscalationFailure`**

In `src/execution/escalation/tier-escalation.ts`, the `buildEscalationFailure` return (lines 48-56) — add agent/profileId from the story argument:

```typescript
  return {
    attempt: (story.attempts ?? 0) + 1,
    modelTier: currentTier,
    ...(story.routing?.agent !== undefined ? { agent: story.routing.agent } : {}),
    ...(story.routing?.agentProfileId !== undefined ? { agentProfileId: story.routing.agentProfileId } : {}),
    stage,
    summary,
    reviewFindings: reviewFindings && reviewFindings.length > 0 ? reviewFindings : undefined,
    cost: cost ?? 0,
    timestamp: new Date().toISOString(),
  };
```

No call-site changes needed — both callers already pass the `story`/`s` object as the first arg.

- [ ] **Step 5: Render the fields in `formatPriorFailures`**

In `src/context/elements.ts`, in the per-failure loop (after line 86, the `### Attempt ...` push), add an agent line when present:

```typescript
    parts.push(`### Attempt ${failure.attempt} — ${failure.modelTier}`);
    if (failure.agent) {
      const profilePart = failure.agentProfileId ? ` (profile: ${failure.agentProfileId})` : "";
      parts.push(`**Agent:** ${failure.agent}${profilePart}`);
    }
    parts.push(`**Stage:** ${failure.stage}`);
```

- [ ] **Step 6: Run both tests to verify they pass**

Run: `timeout 30 bun test test/unit/context/prior-failures.test.ts test/unit/execution/escalation/tier-escalation.test.ts --timeout=5000`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/prd/types.ts src/execution/escalation/tier-escalation.ts src/context/elements.ts test/unit/context/prior-failures.test.ts
git commit -m "feat(escalation): attach agent/profileId to StructuredFailure

priorFailures recorded modelTier but never which agent produced the
failure, so cross-agent escalation context was ambiguous. ADR-025 gap #2."
```

---

## Phase 3 — Deterministic reset semantics

### Task 3.1: Persist `initialModelTier` (write-once origin field)

**Files:**
- Modify: `src/prd/types.ts:64-96` (`StoryRouting`)
- Modify: `src/pipeline/stages/routing.ts:80-96`
- Modify: `src/plan/strategies/finalize-routing.ts:22-29` (consistency — stamp it from `profileModelTier` at plan time when known)
- Test: `test/unit/pipeline/stages/routing.test.ts` (or the routing-stage test file — locate it; see Step 1)

- [ ] **Step 1: Locate the routing-stage test file**

Run: `ls test/unit/pipeline/stages/ | grep -i rout`
Expected: a `routing*.test.ts` file. Use it. If none exists, create `test/unit/pipeline/stages/routing-origin.test.ts` mirroring the source path.

- [ ] **Step 2: Write the failing test**

Add a test that drives `routingStage.execute` with a fresh story and asserts `initialModelTier` is captured once and preserved across an escalation. Use the existing routing-stage test's `_routingDeps` stubbing pattern (the stage exports `_routingDeps` with `resolveRouting`/`savePRD` for injection). Skeleton:

```typescript
import { describe, expect, test } from "bun:test";
import { routingStage, _routingDeps } from "@/pipeline/stages/routing";
// ...reuse the test file's existing PipelineContext fixture builder...

describe("routing stage — initialModelTier origin (ADR-025 gap #4)", () => {
  test("captures initialModelTier on first route and preserves it after escalation", async () => {
    _routingDeps.resolveRouting = async () => ({
      complexity: "simple",
      modelTier: "fast",
      testStrategy: "test-after",
      reasoning: "x",
    }) as never;
    _routingDeps.savePRD = async () => {};

    const ctx = makeRoutingCtx({ story: { id: "US-001", routing: undefined } });
    await routingStage.execute(ctx);
    expect(ctx.story.routing?.initialModelTier).toBe("fast");

    // Simulate escalation: tier bumped + an escalation record present.
    ctx.story.routing = { ...ctx.story.routing!, modelTier: "powerful" };
    ctx.story.escalations = [{ fromTier: "fast", toTier: "powerful", reason: "x", timestamp: "t" }];
    await routingStage.execute(ctx);
    // Origin must NOT be overwritten by the escalated tier.
    expect(ctx.story.routing?.initialModelTier).toBe("fast");
  });
});
```

> Reuse the routing test file's real context builder (`makeRoutingCtx` is illustrative — use whatever the file actually provides). If it has none, build a minimal `PipelineContext` with `story`, `config`, `plugins: []`, `stories: [story]`, `workdir`, `prdPath: undefined`.

- [ ] **Step 3: Run test to verify it fails**

Run: `timeout 30 bun test test/unit/pipeline/stages/routing-origin.test.ts --timeout=5000` (adjust path to the file you used)
Expected: FAIL — `initialModelTier` is `undefined` (field doesn't exist / not written).

- [ ] **Step 4: Add the type field**

In `src/prd/types.ts`, add to `StoryRouting` (after `initialComplexity`, line 68):

```typescript
  /** Model tier at first route — written once, never overwritten by escalation. Used by reset (ADR-025). */
  initialModelTier?: ModelTier;
```

- [ ] **Step 5: Capture it in the routing stage**

In `src/pipeline/stages/routing.ts`, where `initialAgent`/`initialProfileId` are computed (lines 80-83), add `initialModelTier` using the same write-once idiom. Note: capture the *candidate* (pre-escalation) tier, which is what `routing.modelTier` equals on a never-escalated story:

```typescript
    const neverEscalated = !hasEscalationRecords;
    const initialAgent = ctx.story.routing?.initialAgent ?? (neverEscalated ? routing.agent : undefined);
    const initialProfileId =
      ctx.story.routing?.initialProfileId ?? (neverEscalated ? ctx.story.routing?.agentProfileId : undefined);
    const initialModelTier =
      ctx.story.routing?.initialModelTier ?? (neverEscalated ? routing.modelTier : undefined);
```

Then add it to the `ctx.story.routing = {...}` object (after the `initialProfileId` spread, line 95):

```typescript
      ...(initialModelTier !== undefined && { initialModelTier }),
```

- [ ] **Step 6: Stamp it at plan time for consistency**

In `src/plan/strategies/finalize-routing.ts`, the `routing` object (lines 22-29) already stamps `initialAgent`/`initialProfileId`. Add `initialModelTier` from the profile's resolved tier when available:

```typescript
    const routing = {
      ...story.routing,
      agent: assignment.agent,
      agentProfileId: assignment.agentProfileId,
      profileModelTier: assignment.profileModelTier,
      initialAgent: story.routing?.initialAgent ?? assignment.agent,
      initialProfileId: story.routing?.initialProfileId ?? assignment.agentProfileId,
      initialModelTier: story.routing?.initialModelTier ?? assignment.profileModelTier,
    } as StoryRouting;
```

- [ ] **Step 7: Run test + typecheck**

Run: `timeout 30 bun test test/unit/pipeline/stages/routing-origin.test.ts --timeout=5000 && bun run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 8: Commit**

```bash
git add src/prd/types.ts src/pipeline/stages/routing.ts src/plan/strategies/finalize-routing.ts test/unit/pipeline/stages/
git commit -m "feat(routing): persist initialModelTier origin field

Reset-to-initial needs a deterministic starting tier; initialComplexity
alone is insufficient because profile-seeded starts can override the
complexity-derived tier. ADR-025 gap #4 prerequisite."
```

---

### Task 3.2: Add `autoMode.escalation.resetMode` to schema + runtime type

**Files:**
- Modify: `src/config/schemas-execution.ts:17-21` (escalation Zod schema)
- Modify: `src/config/runtime-types.ts:34-39` (escalation runtime type)
- Test: `test/unit/config/` (locate the schema test — see Step 1)

- [ ] **Step 1: Locate the config-schema test file**

Run: `ls test/unit/config/ | grep -iE "schema|default"`
Expected: a schema/defaults test file. Use it (e.g. `schemas.test.ts` or `config-defaults.test.ts`).

- [ ] **Step 2: Write the failing test**

```typescript
import { describe, expect, test } from "bun:test";
import { NaxConfigSchema } from "@/config";

describe("autoMode.escalation.resetMode (ADR-025 gap #4)", () => {
  test("defaults to 'initial' when omitted", () => {
    const parsed = NaxConfigSchema.parse({});
    expect(parsed.autoMode.escalation.resetMode).toBe("initial");
  });

  test("accepts 'last'", () => {
    const parsed = NaxConfigSchema.parse({
      autoMode: {
        enabled: true,
        complexityRouting: { simple: "fast", medium: "balanced", complex: "powerful", expert: "powerful" },
        escalation: { enabled: true, tierOrder: [{ tier: "fast", attempts: 2 }], resetMode: "last" },
      },
    } as never);
    expect(parsed.autoMode.escalation.resetMode).toBe("last");
  });

  test("rejects an unknown mode", () => {
    const result = NaxConfigSchema.safeParse({
      autoMode: {
        enabled: true,
        complexityRouting: { simple: "fast", medium: "balanced", complex: "powerful", expert: "powerful" },
        escalation: { enabled: true, tierOrder: [{ tier: "fast", attempts: 2 }], resetMode: "bogus" },
      },
    } as never);
    expect(result.success).toBe(false);
  });
});
```

> Confirm the import path for `NaxConfigSchema` matches how the existing config tests import it (barrel `@/config` vs `@/config/schemas`). Match the file's existing style.

- [ ] **Step 3: Run test to verify it fails**

Run: `timeout 30 bun test test/unit/config/schemas.test.ts --timeout=5000` (adjust path)
Expected: FAIL — `resetMode` is `undefined` (stripped by Zod) and the unknown-mode case passes parse.

- [ ] **Step 4: Add to the Zod schema**

In `src/config/schemas-execution.ts`, extend the escalation object (lines 17-21):

```typescript
  escalation: z.object({
    enabled: z.boolean(),
    tierOrder: z.array(TierConfigSchema).min(1, { message: "tierOrder must have at least one tier" }),
    escalateEntireBatch: z.boolean().optional(),
    /** On re-run reset of a failed story: "initial" restarts from the origin rung
     * (clears escalations, restores initialModelTier/initialAgent, resets attempts);
     * "last" keeps the final rung but resets attempts so it gets fresh budget. ADR-025. */
    resetMode: z.enum(["initial", "last"]).default("initial"),
  }),
```

- [ ] **Step 5: Add to the runtime type**

In `src/config/runtime-types.ts`, extend the `escalation` shape (lines 34-39):

```typescript
  escalation: {
    enabled: boolean;
    /** Ordered tier escalation with per-tier attempt budgets */
    tierOrder: Array<{ tier: string; attempts: number; agent?: string }>;
    escalateEntireBatch?: boolean;
    /** Reset behaviour for failed stories on re-run (ADR-025). */
    resetMode: "initial" | "last";
  };
```

> If `runtime-types.ts` is generated from the schema (check the file header), regenerate instead of hand-editing. Otherwise hand-edit to match.

- [ ] **Step 6: Run test + typecheck**

Run: `timeout 30 bun test test/unit/config/schemas.test.ts --timeout=5000 && bun run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/config/schemas-execution.ts src/config/runtime-types.ts test/unit/config/
git commit -m "feat(config): add autoMode.escalation.resetMode (initial|last)

Controls where a re-run resumes after escalation exhaustion. Defaults to
'initial' (fresh climb). ADR-025 gap #4."
```

---

### Task 3.3: Rewrite `resetFailedStoriesToPending` to reset attempts/tier/agent per mode

**Files:**
- Modify: `src/prd/index.ts:248-264`
- Test: `test/unit/prd/prd-reset-failed.test.ts`

This changes the function signature to an options object (it already has 3 positional params; adding more violates the ≤3 rule). You will update the single production caller in Task 3.4 and any existing tests here.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/prd/prd-reset-failed.test.ts` (reuse its existing `PRD`/`UserStory` fixtures):

```typescript
test("resetMode 'initial' restores origin tier/agent, clears escalations, resets attempts", () => {
  const prd = makePRD([
    makeStory({
      id: "US-001",
      status: "failed",
      attempts: 5,
      escalations: [{ fromTier: "fast", toTier: "powerful", reason: "x", timestamp: "t" }],
      routing: {
        complexity: "complex",
        modelTier: "powerful",
        testStrategy: "test-after",
        reasoning: "x",
        agent: "codex",
        initialModelTier: "fast",
        initialAgent: "claude",
      },
    }),
  ]);

  const reset = resetFailedStoriesToPending(prd, { resetMode: "initial" });

  expect(reset.length).toBe(1);
  const s = prd.userStories[0];
  expect(s.status).toBe("pending");
  expect(s.attempts).toBe(0);
  expect(s.escalations).toEqual([]);
  expect(s.routing?.modelTier).toBe("fast");
  expect(s.routing?.agent).toBe("claude");
});

test("resetMode 'last' keeps final tier/agent + escalations but resets attempts", () => {
  const prd = makePRD([
    makeStory({
      id: "US-001",
      status: "failed",
      attempts: 5,
      escalations: [{ fromTier: "fast", toTier: "powerful", reason: "x", timestamp: "t" }],
      routing: {
        complexity: "complex",
        modelTier: "powerful",
        testStrategy: "test-after",
        reasoning: "x",
        agent: "codex",
        initialModelTier: "fast",
        initialAgent: "claude",
      },
    }),
  ]);

  resetFailedStoriesToPending(prd, { resetMode: "last" });

  const s = prd.userStories[0];
  expect(s.status).toBe("pending");
  expect(s.attempts).toBe(0);
  expect(s.escalations.length).toBe(1);
  expect(s.routing?.modelTier).toBe("powerful");
  expect(s.routing?.agent).toBe("codex");
});

test("resetMode 'initial' on a single-agent story resets tier + attempts (agent untouched)", () => {
  const prd = makePRD([
    makeStory({
      id: "US-001",
      status: "failed",
      attempts: 4,
      escalations: [{ fromTier: "fast", toTier: "balanced", reason: "x", timestamp: "t" }],
      routing: {
        complexity: "medium",
        modelTier: "balanced",
        testStrategy: "test-after",
        reasoning: "x",
        initialModelTier: "fast",
        // no agent / initialAgent — single-agent ladder
      },
    }),
  ]);

  resetFailedStoriesToPending(prd, { resetMode: "initial" });

  const s = prd.userStories[0];
  expect(s.attempts).toBe(0);
  expect(s.routing?.modelTier).toBe("fast");
  expect(s.routing?.agent).toBeUndefined();
  expect(s.escalations).toEqual([]);
});
```

Also: **update the existing tests in this file** that call `resetFailedStoriesToPending(prd, resetRef, storyIsolation)` positionally — convert them to the new options object form (Step 3 defines it). Run the file first (Step 2) to see which break.

- [ ] **Step 2: Run tests to verify they fail**

Run: `timeout 30 bun test test/unit/prd/prd-reset-failed.test.ts --timeout=5000`
Expected: FAIL — new tests fail (no tier/attempts reset); existing positional-call tests fail to typecheck once Step 3 lands.

- [ ] **Step 3: Rewrite the function**

In `src/prd/index.ts`, replace `resetFailedStoriesToPending` (lines 248-264) and update its doc comment. New signature uses an options object with backward-compatible defaults:

```typescript
export interface ResetFailedOptions {
  /** When true, clears storyGitRef so it is re-captured at next story start. Default: false. */
  resetRef?: boolean;
  /** Worktree mode also clears storyGitRef regardless of resetRef. */
  storyIsolation?: "shared" | "worktree";
  /** "initial" (default) restarts from the origin rung; "last" keeps the final rung. ADR-025. */
  resetMode?: "initial" | "last";
}

export function resetFailedStoriesToPending(prd: PRD, opts: ResetFailedOptions = {}): UserStory[] {
  const { resetRef = false, storyIsolation, resetMode = "initial" } = opts;
  const reset: UserStory[] = [];
  for (const story of prd.userStories) {
    if (story.status !== "failed") continue;

    story.status = "pending";
    // Always give the re-run fresh budget — otherwise the exhausted rung's attempt
    // counter trips preIterationTierCheck and the story re-fails without doing work.
    story.attempts = 0;

    if (resetMode === "initial" && story.routing) {
      // Restore the origin rung so the ladder climbs fresh.
      if (story.routing.initialModelTier !== undefined) {
        story.routing.modelTier = story.routing.initialModelTier;
      }
      // Restore origin agent only when one was recorded (cross-agent ladders).
      if (story.routing.initialAgent !== undefined) {
        story.routing.agent = story.routing.initialAgent;
      }
      // Clear history so routing.ts tier-preservation (BUG-032) and the unrankable
      // custom-tier fallback don't pin the story back to the escalated rung.
      story.escalations = [];
    }
    // resetMode "last": keep modelTier/agent/escalations; only attempts was reset above.

    if (resetRef || storyIsolation === "worktree") {
      story.storyGitRef = undefined;
    }
    reset.push(story);
  }
  return reset;
}
```

Update the JSDoc above it to document the new `opts` object and `resetMode` semantics (replace the existing `@param resetRef` / `@param storyIsolation` block).

- [ ] **Step 4: Run tests to verify they pass**

Run: `timeout 30 bun test test/unit/prd/prd-reset-failed.test.ts --timeout=5000`
Expected: PASS (including the migrated existing tests).

- [ ] **Step 5: Commit**

```bash
git add src/prd/index.ts test/unit/prd/prd-reset-failed.test.ts
git commit -m "fix(prd): reset attempts + restore origin rung on failed-story reset

resetFailedStoriesToPending only flipped status, leaving stories pinned to
the exhausted final rung with maxed attempts so re-runs re-failed instantly.
Now resets attempts and, per resetMode, restores the origin rung. ADR-025 gap #4."
```

---

### Task 3.4: Wire `resetMode` into the reset call site

**Files:**
- Modify: `src/execution/lifecycle/run-initialization.ts:194-196`
- Test: `test/unit/execution/lifecycle/run-initialization.test.ts`

- [ ] **Step 1: Write the failing test**

Add a test asserting that `initializeRun` (or the reset call within it) passes `config.autoMode.escalation.resetMode` through. The simplest robust approach: a test that builds a config with `resetMode: "initial"`, a PRD with a failed escalated story, runs `initializeRun`, and asserts the story's tier was restored to its origin. Reuse the existing `run-initialization.test.ts` fixtures and `_reconcileDeps`/dep stubs.

```typescript
test("initializeRun applies escalation.resetMode when resetting failed stories (gap #4)", async () => {
  const prd = makePRD([
    makeStory({
      id: "US-001",
      status: "failed",
      attempts: 5,
      escalations: [{ fromTier: "fast", toTier: "powerful", reason: "x", timestamp: "t" }],
      routing: {
        complexity: "complex",
        modelTier: "powerful",
        testStrategy: "test-after",
        reasoning: "x",
        initialModelTier: "fast",
      },
    }),
  ]);
  // ...stub loadPRD/reconcileState to return this prd (match the file's existing stubbing)...
  const config = makeConfig({
    autoMode: { escalation: { enabled: true, tierOrder: [{ tier: "fast", attempts: 2 }], resetMode: "initial" } },
  });

  await initializeRun(makeInitCtx({ prd, config }));

  // After reset-initial, the story should be back at the origin tier with fresh budget.
  expect(prd.userStories[0].status).toBe("pending");
  expect(prd.userStories[0].attempts).toBe(0);
  expect(prd.userStories[0].routing?.modelTier).toBe("fast");
});
```

> Use whatever stubbing the file already does for `loadPRD`/`reconcileState`/`savePRD`. If the test harness for `initializeRun` is heavy, an acceptable alternative is a narrower test asserting the call site forwards the option — but prefer the behavioral test above.

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 30 bun test test/unit/execution/lifecycle/run-initialization.test.ts --timeout=5000`
Expected: FAIL — tier stays `powerful` because the old positional call doesn't pass `resetMode` (and won't compile against the new signature).

- [ ] **Step 3: Update the call site**

In `src/execution/lifecycle/run-initialization.ts`, replace the reset call (lines 194-196):

```typescript
  const resetRef = ctx.config.review?.semantic?.resetRefOnRerun ?? false;
  const storyIsolation = ctx.config.execution.storyIsolation;
  const resetMode = ctx.config.autoMode.escalation.resetMode;
  const resetStories = resetFailedStoriesToPending(prd, { resetRef, storyIsolation, resetMode });
```

- [ ] **Step 4: Run test + typecheck**

Run: `timeout 30 bun test test/unit/execution/lifecycle/run-initialization.test.ts --timeout=5000 && bun run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Search for any other callers and migrate them**

Run: `grep -rn "resetFailedStoriesToPending(" src/ test/`
Expected: only `src/prd/index.ts` (definition), `src/execution/lifecycle/run-initialization.ts` (now updated), and test files. Migrate any stragglers still using positional args to the options object.

- [ ] **Step 6: Commit**

```bash
git add src/execution/lifecycle/run-initialization.ts test/unit/execution/lifecycle/run-initialization.test.ts
git commit -m "fix(execution): pass escalation.resetMode through to failed-story reset

Wires the new resetMode flag from config into run initialization so
re-runs honor initial|last semantics. ADR-025 gap #4."
```

---

## Phase 4 — Documentation + full gate

### Task 4.1: Update ADR-025 to record what shipped

**Files:**
- Modify: `docs/adr/ADR-025-agent-routing-and-cross-agent-escalation.md`

- [ ] **Step 1: Update the Negative consequences + Open Questions**

In `docs/adr/ADR-025-...md`:

1. In **Consequences → Negative**, replace the `initialProfileId` bullet's "currently always equals the live value" framing with a note that escalation records now carry `fromAgent`/`toAgent` and `StructuredFailure` carries `agent`/`agentProfileId`, and that `initialModelTier` is now persisted for reset.

2. In **Open Questions**, update item 2 (origin-agent metrics) to note origin fields now include `initialModelTier`, and add a resolved note that reset behaviour is now governed by `autoMode.escalation.resetMode` (`"initial"` default), with the custom-tier caveat: `"initial"` clears `escalations[]` so unrankable custom tier names reset correctly; permanent escalation audit lives in run logs/metrics, not the live PRD array.

3. Add a short subsection under **Implementation** noting the follow-up that closed gaps #1–#4 (formatter render, pre-iteration capture, agent/profile provenance, deterministic reset).

Write actual prose — no "TODO". Keep it to ~10-15 lines total.

- [ ] **Step 2: Commit**

```bash
git add docs/adr/ADR-025-agent-routing-and-cross-agent-escalation.md
git commit -m "docs(adr): record escalation-completeness follow-up in ADR-025"
```

---

### Task 4.2: Full-suite gate

- [ ] **Step 1: Lint**

Run: `bun run lint`
Expected: clean. Fix any Biome findings in the files you touched.

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 3: Full test suite**

Run: `bun run test:bail`
Expected: PASS. If a previously-passing test now fails because it asserted the OLD behavior (e.g. a test asserting reset leaves tier/attempts untouched, or asserting the formatter omits prior-failures), update it to the new expected behavior — that test was encoding the bug. Document each such change in the commit body.

- [ ] **Step 4: Commit any test-fixups from the gate**

```bash
git add -A
git commit -m "test: align tests with ADR-025 escalation-completeness behavior"
```

---

## Self-Review (completed by plan author)

**Spec coverage** — all four user-reported gaps are mapped:
- Gap #1 (priorFailures computed-then-dropped) → Task 1.1.
- Gap #2 (records lack agent/profileId) → Tasks 2.1 (EscalationAttempt), 2.2 (StructuredFailure).
- Gap #3 (priorErrors/priorFailures not captured + pre-iteration path captures nothing) → Tasks 1.2 (pre-iteration), plus the handleTierEscalation path already captures (verified) and is now rendered by 1.1.
- Gap #4 (reset restarts at last rung / instant re-fail; agent-agnostic) → Tasks 3.1 (initialModelTier), 3.2 (resetMode flag), 3.3 (reset logic), 3.4 (call-site wiring). Single-agent coverage asserted in Task 3.3 Step 1 test #3.

**Type consistency** — `resetMode` is `"initial" | "last"` in schema (3.2), runtime type (3.2), `ResetFailedOptions` (3.3), and call site (3.4). `initialModelTier` is `ModelTier` in `StoryRouting` (3.1) and read in reset (3.3). `fromAgent`/`toAgent` added to `EscalationAttempt` (2.1) and written by `buildEscalationRecord` (2.1). `agent`/`agentProfileId` added to `StructuredFailure` (2.2) and written by `buildEscalationFailure` (2.2), rendered by `formatPriorFailures` (2.2).

**Placeholder scan** — every code step shows the code; test fixtures flag where to reuse the file's existing builders rather than invent helpers. No TBD/TODO.

**Known caveat documented** — `"initial"` reset clears `escalations[]` (acceptable: live PRD state, not the permanent audit log; preserves custom-tier reset correctness). Recorded in Task 4.1.

---

## Execution Handoff

Handover target: **Sonnet** (per user). Recommended order is Phase 1 → 2 → 3 → 4 (Phase 1 is independently valuable and lowest-risk; Phase 3 depends on 3.1's `initialModelTier` before 3.3). Phases 1 and 2 are independent of each other and could be parallelized if desired.
