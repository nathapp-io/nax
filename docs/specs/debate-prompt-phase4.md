# Phase 4: Absorb `dialogue-prompts.ts` into `DebatePromptBuilder`

**Status:** Draft
**Parent:** [debate-prompt-builder.md](debate-prompt-builder.md)
**Depends on:** [Phase 3](debate-prompt-phase3.md) (builder class exists)
**Fixes:** G5, full prompt SSOT unification

---

## Problem

### G5 — Review round-2 format contradiction

In review debate round 2, each debater receives a prompt structured as:

```
[IMPORTANT: Your entire response must be a single JSON object or array.]
[... review task prompt with diff, ACs, etc. ...]
YOUR RESPONSE MUST START WITH { OR [

## Other Agents' Proposals
### Proposal 1
{"passed": true, "findings": []}
...

Please critique these proposals and provide your refined analysis,
identifying strengths, weaknesses, and your own updated position.
```

The top says "your response must be JSON" and the bottom says "critique and provide refined analysis" (prose). This is the same class of contradiction as G3 (plan phase), but in the review path.

**Observed impact:** `ReviewerSession.resolveDebate()` failed with `"Failed to parse reviewer JSON response"` on **every single review across all 3 benchmark runs** (bench-03, bench-04, bench-05). The system fell back to the stateless resolver every time. The entire review debate subsystem was 0% functional — the stateless fallback was the only thing providing review verdicts.

### Two parallel prompt universes

After Phase 3, plan/generic debate prompts go through `DebatePromptBuilder`. But review debate prompts remain in `src/review/dialogue-prompts.ts` — a completely separate set of 8 functions:

| Function | Purpose |
|----------|---------|
| `buildReviewPrompt()` | Initial review (story + ACs + diff) |
| `buildReReviewPrompt()` | Re-review after autofix |
| `buildDebateResolverPrompt()` | Debate resolver (vote tally + tool-use) |
| `buildDebateReReviewPrompt()` | Debate re-review |
| `buildProposalsSection()` | Format proposals with debater labels |
| `buildCritiquesSection()` | Format critiques |
| `buildResolverFraming()` | Resolver-type-specific framing text |
| `buildVoteTallyLine()` | Format vote counts |

These have their own `buildProposalsSection()` that labels proposals differently from the builder's version. Persona injection, debater labeling, and format separation must be maintained in two places. Any fix to one universe must be manually replicated in the other.

---

## Solution

Absorb all 8 functions from `dialogue-prompts.ts` into `DebatePromptBuilder`. The review path becomes another consumer of the same builder, with review-specific features handled via `ResolverPromptOptions`.

### Function Mapping

| `dialogue-prompts.ts` function | Builder method | How it maps |
|-------------------------------|----------------|-------------|
| `buildReviewPrompt()` | `buildProposalPrompt()` | Review-specific `StageContext` (taskContext = story + ACs + diff, outputFormat = JSON review schema). The builder's proposal prompt works for any stage. |
| `buildReReviewPrompt()` | `buildReReviewPrompt()` | **New method.** Accepts `previousFindings` + `updatedContext` via `ResolverPromptOptions`. |
| `buildDebateResolverPrompt()` | `buildSynthesisPrompt()` or `buildMajorityResolverPrompt()` | Dispatches by resolver type. Vote tally + tool-use instructions via `ResolverPromptOptions`. |
| `buildDebateReReviewPrompt()` | `buildReReviewPrompt()` | Same method, resolver options control the framing. |
| `buildProposalsSection()` | `private buildProposalsSection()` | Already in builder from Phase 3 — with persona labels. |
| `buildCritiquesSection()` | `private buildCritiquesSection()` | Already in builder from Phase 3. |
| `buildResolverFraming()` | `private buildResolverFraming()` | Moved into builder, driven by `resolverOptions.resolverType`. |
| `buildVoteTallyLine()` | `private buildVoteTallyLine()` | Moved into builder, driven by `resolverOptions.voteTally`. |

### New Builder Additions

```typescript
// Added to DebatePromptBuilder

interface ResolverPromptOptions {
  resolverType: ResolverType;
  voteTally?: { passed: number; failed: number };
  failMode?: "open" | "closed";
  diff?: string;
  story?: { id: string; title: string; acceptanceCriteria: string[] };
  previousFindings?: string;
  toolUse?: boolean;
}

class DebatePromptBuilder {
  // ... existing methods from Phase 3 ...

  /** Majority resolver prompt — vote tally + tool-use instructions. */
  buildMajorityResolverPrompt(proposals: Proposal[], critiques: Rebuttal[]): string {
    const framing = this.buildResolverFraming();
    const storySection = this.buildStorySection();
    const proposalsSection = this.buildProposalsSection(proposals);
    const critiquesSection = this.buildCritiquesSection(critiques);
    const diffSection = this.buildDiffSection();
    const tallyLine = this.buildVoteTallyLine();
    const toolInstruction = this.options.resolverOptions?.toolUse
      ? "\nVerify disputed findings using tools (READ files, GREP for usage) and give your final verdict."
      : "";

    return `${framing}

${storySection}

## Debater Proposals
${proposalsSection}

${critiquesSection}

${diffSection}

${tallyLine}${toolInstruction}
${this.stageContext.outputFormat}`;
  }

  /** Re-review prompt — previous findings + updated context. */
  buildReReviewPrompt(
    proposals: Proposal[],
    critiques: Rebuttal[],
    updatedContext: string,
  ): string {
    const framing = this.buildResolverFraming();
    const proposalsSection = this.buildProposalsSection(proposals);
    const critiquesSection = this.buildCritiquesSection(critiques);
    const previousFindings = this.options.resolverOptions?.previousFindings ?? "";

    return `${framing}

This is a follow-up re-review. The implementer has made changes in response to previous findings.

## Previous Findings
${previousFindings}

## Updated Context
${updatedContext}

## Debater Proposals
${proposalsSection}

${critiquesSection}

${this.stageContext.outputFormat}`;
  }

  // --- New private helpers ---

  private buildResolverFraming(): string {
    const opts = this.options.resolverOptions;
    if (!opts) return "";
    switch (opts.resolverType) {
      case "synthesis":
        return "You are a synthesis reviewer. Combine the strongest analysis from multiple reviewers.";
      case "majority-fail-closed":
      case "majority-fail-open":
        return "You are the authoritative reviewer resolving a debate between multiple reviewers.";
      case "custom":
        return "You are the judge. Evaluate the reviewers' positions and deliver a final verdict.";
      default:
        return "";
    }
  }

  private buildVoteTallyLine(): string {
    const tally = this.options.resolverOptions?.voteTally;
    if (!tally) return "";
    const failNote = this.options.resolverOptions?.failMode === "open"
      ? " (fail-open: ties pass)"
      : " (fail-closed: ties fail)";
    return `\nPreliminary tally: **${tally.passed} passed, ${tally.failed} failed**${failNote}.`;
  }

  private buildStorySection(): string {
    const story = this.options.resolverOptions?.story;
    if (!story) return "";
    const acs = story.acceptanceCriteria.map((ac, i) => `${i + 1}. ${ac}`).join("\n");
    return `## Story: ${story.title}\n\n### Acceptance Criteria\n${acs}`;
  }

  private buildDiffSection(): string {
    const diff = this.options.resolverOptions?.diff;
    if (!diff) return "";
    return `## Code Changes\n\`\`\`diff\n${diff}\n\`\`\``;
  }
}
```

### `ReviewerSession` Migration

`ReviewerSession` in `src/review/dialogue.ts` currently calls `dialogue-prompts.ts` functions directly. After Phase 4, it receives a `DebatePromptBuilder` instance:

```typescript
// BEFORE
import { buildReviewPrompt, buildDebateResolverPrompt } from "./dialogue-prompts";

class ReviewerSession {
  async review(diff: string, story: SemanticStory) {
    const prompt = buildReviewPrompt(diff, story, this.semanticConfig);
    // ...
  }
}
```

```typescript
// AFTER
class ReviewerSession {
  constructor(
    private readonly builder: DebatePromptBuilder,
    // ... other params
  ) {}

  async review() {
    const prompt = this.builder.buildProposalPrompt(0);
    // ...
  }

  async resolveDebate(proposals: Proposal[], critiques: Rebuttal[]) {
    const prompt = this.builder.buildMajorityResolverPrompt(proposals, critiques);
    // ...
  }
}
```

The caller (`semantic.ts`) constructs the builder with a review-specific `StageContext`:

```typescript
const builder = new DebatePromptBuilder(
  {
    taskContext: buildReviewTaskContext(diff, story, semanticConfig),
    outputFormat: buildReviewOutputFormat(),
    stage: "review",
  },
  {
    debaters: resolvedDebaters,
    sessionMode: "stateful",
    resolverOptions: {
      resolverType: stageConfig.resolver.type,
      voteTally,
      diff,
      story: { id: story.id, title: story.title, acceptanceCriteria: story.acs },
      toolUse: true,
    },
  },
);

const session = createReviewerSession(builder, agent, storyId, workdir, featureName, config);
```

### G5 Fix

The review round-2 format contradiction is resolved the same way as G3 in Phase 1: the builder's `buildCritiquePrompt()` and `buildRebuttalPrompt()` methods never include `outputFormat`. When the review debate enters critique/rebuttal rounds, the JSON-only directive is absent. The model receives the review context + other proposals + "provide your critique in prose" — no contradiction.

---

## Files to Change

| File | Change |
|------|--------|
| `src/debate/prompt-builder.ts` | Add `buildMajorityResolverPrompt()`, `buildReReviewPrompt()`, `ResolverPromptOptions`, resolver framing + vote tally + story/diff helpers |
| `src/review/dialogue-prompts.ts` | **Delete** — all functions moved to builder |
| `src/review/dialogue.ts` | `ReviewerSession` receives `DebatePromptBuilder` instead of calling `dialogue-prompts.ts` directly |
| `src/review/semantic.ts` | Construct builder with review `StageContext` + `ResolverPromptOptions`, pass to `ReviewerSession` |
| `src/debate/session-helpers.ts` | `resolveOutcome()` — vote tally construction extracted to builder; `ReviewerSession` calls now go through builder |
| `test/unit/review/dialogue-prompts.test.ts` | Migrate to `test/unit/debate/prompt-builder.test.ts` (review section) |
| `test/unit/review/dialogue.test.ts` | Update to expect builder usage in `ReviewerSession` |

---

## Risk Assessment

**Risk: Medium-High.**

This is the largest phase because:

1. **`ReviewerSession` is stateful with 4 prompt phases** (review → re-review → resolve → re-resolve). Each must be migrated to use the builder, and the session's internal state management must not break.

2. **Vote tally construction is inline in `resolveOutcome()`** (`session-helpers.ts:226–246`). It currently parses each proposal's JSON to count pass/fail votes. This logic must be extracted and passed to the builder via `ResolverPromptOptions.voteTally` — but the extraction changes the flow in `resolveOutcome()`.

3. **`dialogue-prompts.test.ts` has detailed assertions on framing text** — "synthes" (case-insensitive), "judge", vote tally format, debater labels. All must be migrated to the builder test suite.

4. **`ReviewerSession` constructor changes** — adding a `builder` parameter is a breaking change for `createReviewerSession()` in `semantic.ts` and any tests that construct sessions.

### Mitigations

- Phase 3's builder interface is proven before Phase 4 starts — the `buildProposalPrompt`, `buildCritiquePrompt`, `buildRebuttalPrompt`, `buildSynthesisPrompt` methods are already stable
- `dialogue-prompts.ts` functions are pure — can be verified 1:1 against builder output with diff tests
- `ReviewerSession` has existing test coverage — regressions will surface immediately
- The vote tally extraction is a straightforward data-up refactor (compute the tally, pass it to the builder)

---

## Verification

1. Run `bun test` — all tests pass (migrated assertions)
2. `src/review/dialogue-prompts.ts` no longer exists
3. `grep -r "dialogue-prompts" src/` returns zero hits
4. Run debate bench with prompt audit — review debate prompts now go through builder
5. Review round-2 prompts no longer contain JSON-only directive (G5 resolved)
6. `ReviewerSession.resolveDebate()` no longer fails with JSON parse errors (because critique rounds produce prose, not malformed JSON)

---

## Success Criteria

- `src/review/dialogue-prompts.ts` is deleted
- `ReviewerSession` uses `DebatePromptBuilder` exclusively
- Review debate round-2 prompts contain no output format instructions (G5 resolved)
- Review debate resolver prompt includes persona-attributed debater labels
- `ReviewerSession.resolveDebate()` succeeds (no more 100% fallback rate) — verified by benchmark re-run
- Prompt audit shows unified format across plan and review debate prompts
