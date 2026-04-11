# Prompt Builder — Phase 4: AcceptancePromptBuilder

**Parent:** [prompt-builder-overview.md](./prompt-builder-overview.md)
**Depends on:** [Phase 1](./prompt-builder-phase1.md)
**Risk:** Medium
**Scope:** Extract acceptance generator, diagnoser, and fix-executor prompts into a dedicated builder.

## Goal

1. Extract inline prompts from `src/acceptance/generator.ts`, `src/acceptance/fix-diagnosis.ts`, `src/acceptance/fix-executor.ts` into `AcceptancePromptBuilder`.
2. Reuse `priorFailuresSection` (introduced here, also used by Phase 5 rectifier).
3. Reuse existing `acceptanceSection` from `src/prompts/sections/acceptance.ts`.
4. Update acceptance callsites to import from `src/prompts`.

## Files created

```
src/prompts/
├── builders/
│   └── acceptance-builder.ts             # NEW
└── core/sections/
    └── prior-failures.ts                 # NEW (also used by Phase 5)
```

## Files modified

- `src/acceptance/generator.ts` — replace inline prompts (lines 234, 541) with builder calls.
- `src/acceptance/fix-diagnosis.ts` — replace inline prompt (line 154) with builder call.
- `src/acceptance/fix-executor.ts` — replace inline prompts (lines 88, 178) with builder calls.
- `src/prompts/index.ts` — export `AcceptancePromptBuilder`, `AcceptanceRole`.

## Detailed design

### `core/sections/prior-failures.ts`

```typescript
import type { PromptSection } from "../types";

export interface FailureRecord {
  test?: string;
  file?: string;
  message: string;
  output?: string;
}

export function priorFailuresSection(failures: FailureRecord[]): PromptSection | null {
  if (failures.length === 0) return null;
  const body = failures
    .map((f, i) => {
      const head = `## Failure ${i + 1}${f.test ? ` — ${f.test}` : ""}`;
      const loc = f.file ? `File: ${f.file}` : "";
      const msg = `Message: ${f.message}`;
      const out = f.output ? `\n\nOutput:\n\`\`\`\n${f.output}\n\`\`\`` : "";
      return [head, loc, msg].filter(Boolean).join("\n") + out;
    })
    .join("\n\n");
  return {
    id: "prior-failures",
    overridable: false,
    content: `# PRIOR FAILURES\n\n${body}`,
  };
}
```

### `builders/acceptance-builder.ts`

Acceptance has three distinct prompt shapes:

1. **`generator`** — generate acceptance tests from a story + ACs.
2. **`diagnoser`** — diagnose why acceptance tests failed.
3. **`fix-executor`** — instruct the agent to fix failing tests.

```typescript
import type { UserStory } from "../../prd";
import { SectionAccumulator } from "../core/section-accumulator";
import { universalSections } from "../core/universal-sections";
import {
  priorFailuresSection,
  type FailureRecord,
} from "../core/sections/prior-failures";
import type { PromptSection } from "../core/types";
import {
  buildStorySection,
  buildAcceptanceSection,
  type AcceptanceEntry,
} from "../sections";

export type AcceptanceRole = "generator" | "diagnoser" | "fix-executor";

export class AcceptancePromptBuilder {
  private acc = new SectionAccumulator();
  private role: AcceptanceRole;

  private constructor(role: AcceptanceRole) {
    this.role = role;
  }

  static for(role: AcceptanceRole): AcceptancePromptBuilder {
    return new AcceptancePromptBuilder(role);
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

  // Acceptance-specific
  acceptanceCriteria(entries: AcceptanceEntry[]): this {
    this.acc.add(buildAcceptanceSection(entries));
    return this;
  }

  priorFailures(failures: FailureRecord[]): this {
    this.acc.add(priorFailuresSection(failures));
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

  task(): this {
    this.acc.add(acceptanceTaskFor(this.role));
    return this;
  }

  async build(): Promise<string> {
    return this.acc.join();
  }
}

function acceptanceTaskFor(role: AcceptanceRole): PromptSection {
  switch (role) {
    case "generator": return { id: "task", overridable: false, content: GENERATOR_TASK };
    case "diagnoser": return { id: "task", overridable: false, content: DIAGNOSER_TASK };
    case "fix-executor": return { id: "task", overridable: false, content: FIX_EXECUTOR_TASK };
  }
}

const GENERATOR_TASK = `# YOUR TASK\n\nGenerate acceptance tests...`;     // copied verbatim from generator.ts
const DIAGNOSER_TASK = `# YOUR TASK\n\nDiagnose the test failures...`;    // copied verbatim from fix-diagnosis.ts
const FIX_EXECUTOR_TASK = `# YOUR TASK\n\nFix the failing tests...`;      // copied verbatim from fix-executor.ts
```

**Constraint:** ≤200 lines including the three task constants.

### Callsite updates

**`src/acceptance/generator.ts:234, 541`**:

```typescript
// Before
const prompt = `You are an acceptance test generator...\n\n${storyBlock}\n\n${acBlock}...`;
const result = await adapter.complete(prompt, { ... });

// After
const prompt = await AcceptancePromptBuilder.for("generator")
  .constitution(config.constitution)
  .story(story)
  .acceptanceCriteria(acEntries)
  .testCommand(config.testCommand)
  .task()
  .build();
const result = await adapter.complete(prompt, { ... });
```

**`src/acceptance/fix-diagnosis.ts:154`**:

```typescript
const prompt = await AcceptancePromptBuilder.for("diagnoser")
  .constitution(config.constitution)
  .story(story)
  .acceptanceCriteria(acEntries)
  .priorFailures(failures)
  .task()
  .build();
```

**`src/acceptance/fix-executor.ts:88, 178`**:

```typescript
const prompt = await AcceptancePromptBuilder.for("fix-executor")
  .constitution(config.constitution)
  .story(story)
  .acceptanceCriteria(acEntries)
  .priorFailures(failures)
  .testCommand(config.testCommand)
  .task()
  .build();
```

## Tests

### Snapshot tests

`test/unit/prompts/acceptance-builder.snapshot.test.ts`:

- `generator` with story + ACs + test command
- `diagnoser` with prior failures
- `fix-executor` with failures + test command

### Parity tests

For each migrated callsite, parity-check against the original inline output. Delete after Phase 4 lands.

### Existing acceptance tests

Tests asserting on acceptance *behaviour* should pass unchanged. Tests asserting on prompt strings need updating.

## Migration steps

1. Add `core/sections/prior-failures.ts`.
2. Update `core/sections/index.ts`.
3. Add `builders/acceptance-builder.ts`.
4. Copy task body constants verbatim from the three acceptance source files.
5. Replace inline prompts in `generator.ts`, `fix-diagnosis.ts`, `fix-executor.ts` (one at a time, snapshot-checked).
6. Update `src/prompts/index.ts`.
7. Run typecheck/lint/test.

## Success criteria

1. `src/acceptance/generator.ts`, `fix-diagnosis.ts`, `fix-executor.ts` contain zero template literals longer than 5 lines.
2. `AcceptancePromptBuilder` ≤200 lines.
3. Snapshot + parity tests green.
4. `bun test` green.

## Risks

| Risk | Mitigation |
|---|---|
| Constitution now injected in acceptance prompts (was not before) | Deliberate. Document in PR. Snapshot-test the new output. |
| `acceptanceSection` already exists in TDD path; risk of double-injection | The TDD path uses `acceptanceContext()` on `TddPromptBuilder`. The acceptance path uses `acceptanceCriteria()` on `AcceptancePromptBuilder`. They are separate calls in separate builders; no risk of overlap. |
| Fix-executor uses long output blocks (test stdout) — token bloat | Out of scope. Budget management is a follow-up spec. Snapshot tests just verify structure. |
| `FailureRecord` type may differ from existing failure type in `src/verification/` | Define `FailureRecord` as a minimal interface in `core/sections/prior-failures.ts`. Add a small adapter at the callsite to map the verification failure type into `FailureRecord`. Don't import from `src/verification/` (would couple `core/sections` to it). |

## Definition of done

- [ ] All three acceptance source files use `AcceptancePromptBuilder` exclusively
- [ ] No inline prompt strings >5 lines remain in `src/acceptance/`
- [ ] Snapshot + parity tests green
- [ ] `bun test` green
- [ ] PR description notes the constitution-injection behaviour change
