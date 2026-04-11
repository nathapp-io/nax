# Prompt Builder — Phase 5: RectifierPromptBuilder

**Parent:** [prompt-builder-overview.md](./prompt-builder-overview.md)
**Depends on:** [Phase 1](./prompt-builder-phase1.md), [Phase 4](./prompt-builder-phase4.md) (for `priorFailuresSection`)
**Risk:** Medium
**Scope:** Extract rectification prompts from `src/tdd/prompts.ts` and any verification rectification helpers into a dedicated builder. Delete `src/tdd/prompts.ts`.

## Goal

1. Extract `buildRectificationPrompt`, `buildImplementerRectificationPrompt`, and any related helpers from `src/tdd/prompts.ts` into `RectifierPromptBuilder`.
2. Extract any rectification prompt construction from `src/verification/rectification-loop.ts` (if it builds prompts inline) into the same builder.
3. Reuse `priorFailuresSection` (added in Phase 4) and `findingsSection` (added in Phase 3) — rectifier needs both.
4. Update callsites in `src/tdd/`, `src/verification/`, and `src/pipeline/stages/autofix.ts`.
5. Delete `src/tdd/prompts.ts`.

## Why a dedicated builder

Rectification is genuinely cross-domain: it needs TDD context (story, isolation, role task) AND review context (prior failures, findings). It is not a TDD prompt and not a review prompt — it is its own thing. A dedicated builder is cleaner than forcing it into either of the two adjacent builders.

## Files created

```
src/prompts/
└── builders/
    └── rectifier-builder.ts              # NEW
```

## Files removed

```
src/tdd/prompts.ts                        # DELETED
```

## Files modified

- `src/tdd/session-runner.ts` — replace rectification prompt calls with builder.
- `src/tdd/rectification-gate.ts` — same.
- `src/verification/rectification-loop.ts` — same.
- `src/pipeline/stages/autofix.ts` — if it constructs rectification prompts directly.
- `src/prompts/index.ts` — export `RectifierPromptBuilder`, `RectifierTrigger`.

## Detailed design

### `builders/rectifier-builder.ts`

```typescript
import type { UserStory } from "../../prd";
import { SectionAccumulator } from "../core/section-accumulator";
import { universalSections } from "../core/universal-sections";
import {
  priorFailuresSection,
  type FailureRecord,
} from "../core/sections/prior-failures";
import {
  findingsSection,
  type ReviewFinding,
} from "../core/sections/findings";
import type { PromptSection } from "../core/types";
import {
  buildStorySection,
  buildIsolationSection,
  buildConventionsSection,
} from "../sections";

export type RectifierTrigger =
  | "tdd-test-failure"     // tests written by test-writer fail; implementer rectifies
  | "tdd-suite-failure"    // full suite fails after implementation
  | "verify-failure"       // post-verify rectification (autofix loop)
  | "review-findings";     // review surfaced critical findings; rectifier addresses them

export class RectifierPromptBuilder {
  private acc = new SectionAccumulator();
  private trigger: RectifierTrigger;

  private constructor(trigger: RectifierTrigger) {
    this.trigger = trigger;
  }

  static for(trigger: RectifierTrigger): RectifierPromptBuilder {
    return new RectifierPromptBuilder(trigger);
  }

  // Universal
  constitution(c: string | undefined): this {
    this.acc.add(universalSections.constitution(c));
    return this;
  }

  context(md: string | undefined): this {
    this.acc.add(universalSections.context(md));
    return this;
  }

  story(s: UserStory): this {
    this.acc.add(buildStorySection(s));
    return this;
  }

  // Rectifier-specific
  priorFailures(failures: FailureRecord[]): this {
    this.acc.add(priorFailuresSection(failures));
    return this;
  }

  findings(fs: ReviewFinding[]): this {
    this.acc.add(findingsSection(fs));
    return this;
  }

  testCommand(cmd: string | undefined): this {
    if (!cmd) return this;
    this.acc.add({
      id: "test-command",
      overridable: false,
      content: `# TEST COMMAND\n\n\`${cmd}\``,
    });
    return this;
  }

  isolation(mode?: "strict" | "lite"): this {
    this.acc.add(buildIsolationSection("implementer", mode, undefined));
    return this;
  }

  conventions(): this {
    this.acc.add(buildConventionsSection());
    return this;
  }

  task(): this {
    this.acc.add(rectifierTaskFor(this.trigger));
    return this;
  }

  async build(): Promise<string> {
    return this.acc.join();
  }
}

function rectifierTaskFor(trigger: RectifierTrigger): PromptSection {
  switch (trigger) {
    case "tdd-test-failure": return { id: "task", overridable: false, content: TDD_TEST_FAILURE_TASK };
    case "tdd-suite-failure": return { id: "task", overridable: false, content: TDD_SUITE_FAILURE_TASK };
    case "verify-failure": return { id: "task", overridable: false, content: VERIFY_FAILURE_TASK };
    case "review-findings": return { id: "task", overridable: false, content: REVIEW_FINDINGS_TASK };
  }
}

const TDD_TEST_FAILURE_TASK = `# YOUR TASK\n\nYour previous implementation failed...`;  // copied from tdd/prompts.ts
const TDD_SUITE_FAILURE_TASK = `# YOUR TASK\n\nThe full test suite is failing...`;
const VERIFY_FAILURE_TASK = `# YOUR TASK\n\nThe verification step failed...`;
const REVIEW_FINDINGS_TASK = `# YOUR TASK\n\nThe review surfaced critical findings...`;
```

**Constraint:** ≤200 lines including the four task constants.

### Callsite updates

**`src/tdd/session-runner.ts`** (rectification path):

```typescript
// Before
const prompt = buildImplementerRectificationPrompt({ story, failures, ... });

// After
const prompt = await RectifierPromptBuilder.for("tdd-test-failure")
  .constitution(config.constitution)
  .story(story)
  .priorFailures(failures)
  .testCommand(config.testCommand)
  .isolation(config.isolation)
  .conventions()
  .task()
  .build();
```

**`src/tdd/rectification-gate.ts:210`**:

```typescript
const prompt = await RectifierPromptBuilder.for("tdd-suite-failure")
  .constitution(config.constitution)
  .story(story)
  .priorFailures(suiteFailures)
  .testCommand(config.testCommand)
  .conventions()
  .task()
  .build();
```

**`src/verification/rectification-loop.ts:241, 400`**:

```typescript
const prompt = await RectifierPromptBuilder.for("verify-failure")
  .constitution(config.constitution)
  .story(story)
  .priorFailures(verifyFailures)
  .findings(reviewFindings)
  .testCommand(config.testCommand)
  .conventions()
  .task()
  .build();
```

**`src/pipeline/stages/autofix.ts:313`** (if it constructs prompts directly; otherwise it just passes through `runSharedRectificationLoop` which uses one of the above).

## Tests

### Snapshot tests

`test/unit/prompts/rectifier-builder.snapshot.test.ts`:

- `tdd-test-failure` with story + failures + test command
- `tdd-suite-failure` with suite failures
- `verify-failure` with failures + findings
- `review-findings` with critical findings

### Parity tests

For each migrated callsite, parity-check against the old `tdd/prompts.ts` output. Delete after Phase 5 lands.

### Existing tests

Tests asserting on TDD rectification *behaviour* should pass unchanged. Tests asserting on prompt strings need updating.

## Migration steps

1. Add `builders/rectifier-builder.ts`.
2. Copy task body constants verbatim from `src/tdd/prompts.ts` (and any verification rectification prompt source).
3. Update `src/prompts/index.ts`.
4. Replace callsites one at a time, snapshot-checked:
   - `src/tdd/session-runner.ts`
   - `src/tdd/rectification-gate.ts`
   - `src/verification/rectification-loop.ts`
   - `src/pipeline/stages/autofix.ts` (if applicable)
5. Run `grep -rn 'from "../../tdd/prompts"' src/` and `grep -rn 'from "./prompts"' src/tdd/` — both should be empty.
6. Delete `src/tdd/prompts.ts`.
7. Run typecheck/lint/test.

## Success criteria

1. `src/tdd/prompts.ts` no longer exists.
2. All rectification callsites import from `src/prompts`.
3. `RectifierPromptBuilder` ≤200 lines.
4. Snapshot + parity tests green.
5. `bun test` green.

## Risks

| Risk | Mitigation |
|---|---|
| Multiple `tdd/prompts.ts` helpers have subtly different prompts; consolidating into one builder may erase nuance | Keep four distinct trigger task constants. Each preserves the original prompt verbatim. The builder is just plumbing. |
| `verification/rectification-loop.ts` may construct prompts via a different helper than `tdd/prompts.ts` | Audit before starting. If the helper is in a third location, extract it too. Don't leave any rectification prompt outside `src/prompts/`. |
| Test-coverage for rectification is sparse — silent regressions possible | The parity test compares old vs new output for each trigger, run against multiple fixture inputs. This is the strongest guarantee available without LLM evals. |
| `RectifierPromptBuilder` becomes a god-class as new triggers get added | If triggers exceed ~6, split into `TddRectifierPromptBuilder` and `VerifyRectifierPromptBuilder`. Today's count is 4, well within the limit. |

## Definition of done

- [ ] `src/tdd/prompts.ts` deleted
- [ ] All rectification callsites use `RectifierPromptBuilder`
- [ ] Snapshot + parity tests green for all 4 triggers
- [ ] `bun test` green
- [ ] PR description lists which triggers are now consolidated
