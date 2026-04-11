# Prompt Builder — Phase 3: ReviewPromptBuilder

**Parent:** [prompt-builder-overview.md](./prompt-builder-overview.md)
**Depends on:** [Phase 1](./prompt-builder-phase1.md), [Phase 2](./prompt-builder-phase2.md)
**Risk:** Medium (persistent session)
**Scope:** Extract review-dialogue and semantic-review prompts into a dedicated builder.

## Goal

1. Extract the 5 inline prompts from `src/review/dialogue.ts` into `ReviewPromptBuilder`.
2. Extract the inline `buildPrompt()` from `src/review/semantic.ts` into the same builder.
3. Add `findingsSection` for prior review findings.
4. Update review callsites to import from `src/prompts`.
5. Persistent-session prompts: split into a **system prompt** (sent once at session start) and **turn prompts** (sent on each subsequent turn). Both are produced by `ReviewPromptBuilder` via different methods.

## Files created

```
src/prompts/
├── builders/
│   └── review-builder.ts                 # NEW
└── core/sections/
    └── findings.ts                       # NEW
```

## Files modified

- `src/review/dialogue.ts` — replace inline prompts with `ReviewPromptBuilder` calls.
- `src/review/semantic.ts` — replace `buildPrompt()` with `ReviewPromptBuilder` call.
- `src/prompts/index.ts` — export `ReviewPromptBuilder`, `ReviewRole`.
- `src/prompts/core/sections/index.ts` — export `findingsSection`.

## Detailed design

### `core/sections/findings.ts`

```typescript
import type { PromptSection } from "../types";

export interface ReviewFinding {
  id: string;
  severity: "critical" | "high" | "medium" | "low";
  category: string;
  message: string;
  file?: string;
  line?: number;
}

export function findingsSection(findings: ReviewFinding[]): PromptSection | null {
  if (findings.length === 0) return null;
  const body = findings
    .map((f) => {
      const loc = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : "";
      return `- [${f.severity.toUpperCase()}] ${f.category}: ${f.message}${loc}`;
    })
    .join("\n");
  return {
    id: "findings",
    overridable: false,
    content: `# PRIOR REVIEW FINDINGS\n\n${body}`,
  };
}
```

### `builders/review-builder.ts`

Review has two distinct prompt types:

1. **System prompt** — set once at session start (`keepSessionOpen: true` in dialogue).
2. **Turn prompt** — sent on each round to push new context (current diff, prior findings, fix request).

Both produced by the same builder, different `build*()` methods.

```typescript
import type { UserStory } from "../../prd";
import { SectionAccumulator } from "../core/section-accumulator";
import { universalSections } from "../core/universal-sections";
import { findingsSection, type ReviewFinding } from "../core/sections/findings";
import { jsonSchemaSection, type SchemaDescriptor } from "../core/sections/json-schema";
import type { PromptSection } from "../core/types";
import { buildStorySection } from "../sections";

export type ReviewRole = "dialogue" | "semantic";

export class ReviewPromptBuilder {
  private acc = new SectionAccumulator();
  private role: ReviewRole;

  private constructor(role: ReviewRole) {
    this.role = role;
  }

  static for(role: ReviewRole): ReviewPromptBuilder {
    return new ReviewPromptBuilder(role);
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

  // Review-specific
  findings(fs: ReviewFinding[]): this {
    this.acc.add(findingsSection(fs));
    return this;
  }

  diff(diffText: string | undefined): this {
    if (!diffText) return this;
    this.acc.add({
      id: "diff",
      overridable: false,
      content: `# CURRENT DIFF\n\n\`\`\`diff\n${diffText}\n\`\`\``,
    });
    return this;
  }

  jsonSchema(schema: SchemaDescriptor): this {
    this.acc.add(jsonSchemaSection(schema));
    return this;
  }

  /** System prompt — sent once at session start. */
  systemTask(): this {
    this.acc.add(reviewSystemTaskFor(this.role));
    return this;
  }

  /** Turn prompt — sent per dialogue round. */
  turnTask(turnKind: "initial" | "fix-request" | "verify-fix"): this {
    this.acc.add(reviewTurnTaskFor(this.role, turnKind));
    return this;
  }

  async build(): Promise<string> {
    return this.acc.join();
  }
}

function reviewSystemTaskFor(role: ReviewRole): PromptSection { /* ... */ }
function reviewTurnTaskFor(role: ReviewRole, turn: string): PromptSection { /* ... */ }
```

**Note on `jsonSchema`:** Phase 3 introduces `jsonSchemaSection` ahead of Phase 6 because semantic review needs it. Add it now in `core/sections/json-schema.ts` with a minimal API; expand in Phase 6 if needed.

```typescript
// core/sections/json-schema.ts
import type { PromptSection } from "../types";

export interface SchemaDescriptor {
  name: string;
  description: string;
  example: unknown;
}

export function jsonSchemaSection(schema: SchemaDescriptor): PromptSection {
  return {
    id: "json-schema",
    overridable: false,
    content: [
      `# OUTPUT FORMAT (JSON)`,
      ``,
      schema.description,
      ``,
      `Schema name: ${schema.name}`,
      ``,
      `Example:`,
      `\`\`\`json`,
      JSON.stringify(schema.example, null, 2),
      `\`\`\``,
    ].join("\n"),
  };
}
```

### Callsite updates

**`src/review/dialogue.ts`** — 5 inline prompts → 5 builder calls. Example:

```typescript
// Before (inline at dialogue.ts:298)
const systemPrompt = `You are a code reviewer...\n\n${storyBlock}\n\n${diffBlock}...`;
await adapter.run(systemPrompt, { keepSessionOpen: true, ... });

// After
const systemPrompt = await ReviewPromptBuilder.for("dialogue")
  .constitution(config.constitution)
  .story(story)
  .systemTask()
  .build();
await adapter.run(systemPrompt, { keepSessionOpen: true, ... });

// Then per turn:
const turnPrompt = await ReviewPromptBuilder.for("dialogue")
  .diff(currentDiff)
  .findings(priorFindings)
  .jsonSchema(reviewSchema)
  .turnTask("initial")
  .build();
await adapter.run(turnPrompt, { sessionId, ... });
```

**`src/review/semantic.ts`** — `buildPrompt()` → `ReviewPromptBuilder.for("semantic")`.

## Tests

### Snapshot tests

`test/unit/prompts/review-builder.snapshot.test.ts`:

- `dialogue.systemTask()` snapshot
- `dialogue.turnTask("initial")` with diff + findings snapshot
- `dialogue.turnTask("fix-request")` snapshot
- `dialogue.turnTask("verify-fix")` snapshot
- `semantic.systemTask()` snapshot

### Parity tests (temporary)

For each migrated callsite, compare old inline output vs new builder output and assert equality (modulo deliberate changes like constitution injection). Delete after Phase 3 lands.

### Existing review tests

Tests asserting on review *findings* / *behaviour* should pass unchanged. Tests asserting on prompt strings need updating.

## Migration steps

1. Add `core/sections/findings.ts`, `json-schema.ts`.
2. Update `core/sections/index.ts`.
3. Add `builders/review-builder.ts`.
4. Copy system + turn task constants from `src/review/dialogue.ts` and `semantic.ts` verbatim.
5. Replace inline prompts in `dialogue.ts` with builder calls (one prompt at a time, snapshot-checked).
6. Replace `buildPrompt()` in `semantic.ts`.
7. Update `src/prompts/index.ts`.
8. Run typecheck/lint/test.

## Success criteria

1. `src/review/dialogue.ts` contains zero template literals longer than 5 lines.
2. `src/review/semantic.ts` contains no `buildPrompt()` function.
3. `ReviewPromptBuilder` ≤200 lines.
4. Snapshot + parity tests green.
5. Persistent session behaviour unchanged (`keepSessionOpen` semantics work end-to-end).
6. `bun test` green.

## Risks

| Risk | Mitigation |
|---|---|
| Persistent session prompts must stay valid across turns (system prompt cannot be re-sent) | Builder has explicit `systemTask()` vs `turnTask()` methods. Callers cannot accidentally mix. Tests cover both paths. |
| Splitting inline prompt into system + turn changes how much context the model sees per turn | Snapshot test catches the diff. Callers explicitly choose which sections appear in turn vs system. |
| Semantic review uses DebateSession indirectly — chain may be longer than expected | Trace `src/review/semantic.ts:392, 536` callers; update only the prompt-construction sites, not the session orchestration. |
| Constitution now injected in review (was not before) | Deliberate. Document in PR. |

## Definition of done

- [ ] `src/review/dialogue.ts` and `semantic.ts` use `ReviewPromptBuilder` exclusively
- [ ] No inline prompt strings >5 lines remain in `src/review/`
- [ ] Snapshot + parity tests green
- [ ] Persistent session integration test passes
- [ ] `bun test` green
