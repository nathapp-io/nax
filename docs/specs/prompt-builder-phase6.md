# Prompt Builder — Phase 6: OneShotPromptBuilder + invariants doc

**Parent:** [prompt-builder-overview.md](./prompt-builder-overview.md)
**Depends on:** [Phase 1](./prompt-builder-phase1.md), [Phase 3](./prompt-builder-phase3.md) (for `jsonSchemaSection`)
**Risk:** Low–Medium
**Scope:** Move router, decomposer, and auto-approver prompts into `OneShotPromptBuilder`. Add `src/prompts/README.md` documenting the post-migration invariants.

## Goal

1. Move `src/routing/strategies/llm-prompts.ts` (router prompt) into `OneShotPromptBuilder`.
2. Move `src/agents/shared/decompose.ts` (decomposer prompt) into `OneShotPromptBuilder`.
3. Move inline `buildPrompt()` from `src/interaction/plugins/auto.ts:177` (auto-approver) into `OneShotPromptBuilder`.
4. Add `instructionsSection` and `routingCandidatesSection`. Reuse `jsonSchemaSection` from Phase 3.
5. Delete the original prompt source files.
6. Add `src/prompts/README.md` documenting invariants.

## Why one builder for three prompts

Router, decomposer, and auto-approver are all **structurally trivial**: a short instruction + (sometimes) input data + (sometimes) JSON schema. They share no domain. Forcing each into its own builder class would be ceremony for ~30 lines of prompt logic apiece. A single `OneShotPromptBuilder` with a few generic methods (`instructions`, `inputData`, `jsonSchema`, `candidates`) handles all three cleanly.

This is the **escape hatch** for genuinely simple prompts that don't justify a domain-specific builder.

## Files created

```
src/prompts/
├── builders/
│   └── one-shot-builder.ts               # NEW
├── core/sections/
│   ├── instructions.ts                   # NEW
│   └── routing-candidates.ts             # NEW
└── README.md                             # NEW (invariants doc)
```

## Files removed

```
src/routing/strategies/llm-prompts.ts     # DELETED
src/agents/shared/decompose.ts            # DELETED (or only the prompt-building portion if other utilities live here)
```

## Files modified

- `src/routing/strategies/llm.ts:102` — import builder from `src/prompts`.
- `src/agents/acp/adapter.ts:1192`, `src/agents/claude/adapter.ts:176`, `src/agents/opencode/adapter.ts:58`, `src/cli/plan.ts:823` — import builder from `src/prompts` for decompose.
- `src/interaction/plugins/auto.ts:160, 177` — replace inline `buildPrompt()` with builder call.
- `src/prompts/index.ts` — export `OneShotPromptBuilder`.

## Detailed design

### `core/sections/instructions.ts`

Generic instruction block for one-shot prompts.

```typescript
import type { PromptSection } from "../types";

export function instructionsSection(text: string): PromptSection {
  return {
    id: "instructions",
    overridable: false,
    content: `# INSTRUCTIONS\n\n${text}`,
  };
}
```

### `core/sections/routing-candidates.ts`

```typescript
import type { PromptSection } from "../types";

export interface RoutingCandidate {
  tier: string;
  description: string;
  costPerMillion?: number;
}

export function routingCandidatesSection(candidates: RoutingCandidate[]): PromptSection {
  const body = candidates
    .map((c) => {
      const cost = c.costPerMillion ? ` ($${c.costPerMillion}/M tokens)` : "";
      return `- **${c.tier}**${cost}: ${c.description}`;
    })
    .join("\n");
  return {
    id: "candidates",
    overridable: false,
    content: `# AVAILABLE TIERS\n\n${body}`,
  };
}
```

### `builders/one-shot-builder.ts`

```typescript
import { SectionAccumulator } from "../core/section-accumulator";
import { universalSections } from "../core/universal-sections";
import { instructionsSection } from "../core/sections/instructions";
import {
  routingCandidatesSection,
  type RoutingCandidate,
} from "../core/sections/routing-candidates";
import {
  jsonSchemaSection,
  type SchemaDescriptor,
} from "../core/sections/json-schema";

export type OneShotRole = "router" | "decomposer" | "auto-approver";

export class OneShotPromptBuilder {
  private acc = new SectionAccumulator();
  private role: OneShotRole;

  private constructor(role: OneShotRole) {
    this.role = role;
  }

  static for(role: OneShotRole): OneShotPromptBuilder {
    return new OneShotPromptBuilder(role);
  }

  // Universal (auto-approver and decomposer benefit from constitution; router does not)
  constitution(c: string | undefined): this {
    this.acc.add(universalSections.constitution(c));
    return this;
  }

  // One-shot specific
  instructions(text: string): this {
    this.acc.add(instructionsSection(text));
    return this;
  }

  inputData(label: string, body: string): this {
    this.acc.add({
      id: `input-${label.toLowerCase().replace(/\s+/g, "-")}`,
      overridable: false,
      content: `# ${label.toUpperCase()}\n\n${body}`,
    });
    return this;
  }

  candidates(cs: RoutingCandidate[]): this {
    this.acc.add(routingCandidatesSection(cs));
    return this;
  }

  jsonSchema(schema: SchemaDescriptor): this {
    this.acc.add(jsonSchemaSection(schema));
    return this;
  }

  async build(): Promise<string> {
    return this.acc.join();
  }
}
```

**Constraint:** ≤150 lines. This builder is intentionally minimal — it should not grow into a god-class. If a one-shot prompt acquires real domain shape, promote it to its own dedicated builder.

### Callsite updates

**Router** (`src/routing/strategies/llm.ts:102`):

```typescript
// Before
import { buildRoutingPrompt } from "./llm-prompts";
const prompt = buildRoutingPrompt(story, candidates);

// After
import { OneShotPromptBuilder } from "../../prompts";
const prompt = await OneShotPromptBuilder.for("router")
  .instructions("Choose the best tier for the following story.")
  .inputData("Story", storyMd)
  .candidates(candidates)
  .jsonSchema(routingSchema)
  .build();
```

**Decomposer** (`src/agents/shared/decompose.ts` callers):

```typescript
// Before
import { buildDecomposePrompt } from "../shared/decompose";
const prompt = buildDecomposePrompt(prd);

// After
import { OneShotPromptBuilder } from "../../prompts";
const prompt = await OneShotPromptBuilder.for("decomposer")
  .constitution(config.constitution)
  .instructions("Decompose the following PRD into atomic user stories.")
  .inputData("PRD", prdMarkdown)
  .jsonSchema(decomposeSchema)
  .build();
```

**Auto-approver** (`src/interaction/plugins/auto.ts:160, 177`):

```typescript
// Before
const prompt = buildPrompt(toolCall, context);

// After
const prompt = await OneShotPromptBuilder.for("auto-approver")
  .instructions("Decide whether to approve the following tool call.")
  .inputData("Tool Call", JSON.stringify(toolCall, null, 2))
  .inputData("Context", context)
  .jsonSchema(approveSchema)
  .build();
```

### `src/prompts/README.md`

```markdown
# src/prompts/

Single home for all prompt construction in nax. Every prompt sent to an agent
adapter (`adapter.run()`, `adapter.complete()`, `adapter.plan()`, `adapter.decompose()`)
is built here.

## Layout

- `core/section-accumulator.ts` — shared engine. Owns join, separator, override loading.
- `core/sections/` — pure section functions. One file per section type. Returns `PromptSection`.
- `core/universal-sections.ts` — null-guarded constructors for sections every builder uses.
- `core/wrappers.ts` — user-supplied data wrappers, separator constants.
- `builders/` — one builder per domain. Each wraps `SectionAccumulator` via composition.
- `loader.ts` — disk-based prompt override loader (TDD roles only).
- `index.ts` — public barrel. Other subsystems import from here.

## Builders

| Builder | Domains |
|---|---|
| `TddPromptBuilder` | implementer, test-writer, verifier, no-test, single-session, tdd-simple, batch |
| `DebatePromptBuilder` | propose, critique, rebut, synthesize |
| `ReviewPromptBuilder` | dialogue, semantic |
| `AcceptancePromptBuilder` | generator, diagnoser, fix-executor |
| `RectifierPromptBuilder` | tdd-test-failure, tdd-suite-failure, verify-failure, review-findings |
| `OneShotPromptBuilder` | router, decomposer, auto-approver |

## Invariants

These are enforced by code review and convention. Violations should be caught in PR review.

1. **All prompt-producing code lives here.** No template literals defining agent prompts outside `src/prompts/`. Glue strings (≤5 lines) inside builders are OK.
2. **Composition only.** Builders wrap `SectionAccumulator`. No inheritance between builders. No `BasePromptBuilder` parent class.
3. **Section content lives in `core/sections/`.** Builder methods are one-line delegations: `this.acc.add(xSection(arg))`. Logic for *what a section says* lives in section files, not builders.
4. **Builders import only from `core/`.** Never from each other. Cross-builder reuse happens via shared section functions, not via importing another builder's methods.
5. **Other subsystems import from the `src/prompts` barrel.** Never from `src/prompts/core/` or `src/prompts/builders/internal-*` directly. Prevents singleton fragmentation (see `project-conventions.md`).
6. **Call-order = section order.** The fluent method chain in each callsite *is* the prompt recipe. No global section-order constant. Each callsite is responsible for the order of its own sections.
7. **One builder method = one section.** Methods do not bundle multiple sections. Reuse via small helper functions (in `core/`) if a sequence of sections recurs across callsites.
8. **File size limits.** Section files ≤80 lines. Builder files ≤200 lines. `SectionAccumulator` ≤120 lines. `OneShotPromptBuilder` ≤150 lines.

## When to add a new builder vs. add a method to an existing one

Add a new builder when the prompt's domain has:
- ≥3 unique sections that no other builder uses
- A distinct vocabulary (`persona`, `proposals` belong to debate; `findings` belongs to review)
- Independent evolution (additions to debate must not risk breaking TDD)

Use `OneShotPromptBuilder` when the prompt is:
- A short instruction + minimal input + (optionally) JSON schema
- Genuinely structurally trivial (e.g., a 30-line one-off)

If you find yourself adding domain-specific methods to `OneShotPromptBuilder`, that's the signal to promote the prompt to its own dedicated builder.

## Adding a new section

1. Create `core/sections/<name>.ts` with a pure function returning `PromptSection`.
2. Re-export from `core/sections/index.ts`.
3. Add a one-line method on the relevant builder(s) that delegates to the section function.
4. Add a snapshot test under `test/unit/prompts/<builder>.snapshot.test.ts`.

## Adding a new builder

1. Create `builders/<role>-builder.ts` wrapping `SectionAccumulator`.
2. Add domain-specific methods. Import section functions from `core/sections/`.
3. Re-export the class and its role type from `index.ts`.
4. Add a snapshot test for each role.
5. Update this README's builder table.
```

## Tests

### Snapshot tests

`test/unit/prompts/one-shot-builder.snapshot.test.ts`:

- `router` with candidates + schema
- `decomposer` with PRD + schema
- `auto-approver` with tool call + context + schema

### Parity tests

For each migrated callsite, parity-check against the original output. Delete after Phase 6 lands.

## Migration steps

1. Add `core/sections/instructions.ts`, `routing-candidates.ts`.
2. Update `core/sections/index.ts`.
3. Add `builders/one-shot-builder.ts`.
4. Update `src/prompts/index.ts` to export `OneShotPromptBuilder`, `OneShotRole`, `RoutingCandidate`.
5. Migrate callsites one at a time, snapshot-checked:
   - Router (`src/routing/strategies/llm.ts`)
   - Decomposer (each adapter + `src/cli/plan.ts`)
   - Auto-approver (`src/interaction/plugins/auto.ts`)
6. Delete `src/routing/strategies/llm-prompts.ts`.
7. Delete prompt-building portion of `src/agents/shared/decompose.ts` (or the whole file if it has no other utilities).
8. Add `src/prompts/README.md`.
9. Run final invariant grep:
   ```bash
   grep -rn '"You are' src/ --include='*.ts' | grep -v src/prompts | grep -v test/
   ```
   Should return zero matches.
10. Run typecheck/lint/test.

## Success criteria

1. `src/routing/strategies/llm-prompts.ts` no longer exists.
2. `src/agents/shared/decompose.ts` no longer contains prompt-building code.
3. `src/interaction/plugins/auto.ts` no longer contains a `buildPrompt` function.
4. The invariant grep returns zero results.
5. `OneShotPromptBuilder` ≤150 lines.
6. `src/prompts/README.md` exists and is linked from the architecture index.
7. `bun test` green.
8. PR description includes a final architecture diagram showing the full `src/prompts/` tree.

## Risks

| Risk | Mitigation |
|---|---|
| Decompose is called from 4+ adapters; missing one leaves a stale import | Use `grep -rn 'buildDecomposePrompt' src/` before deleting. |
| Decomposer prompt subtly differs across adapters (claude vs acp vs opencode) | Audit first. If they differ, that's a pre-existing inconsistency — fix or document, then migrate. The builder makes the inconsistency explicit (each callsite calls `for("decomposer")` with its own arguments). |
| `OneShotPromptBuilder` becomes a dumping ground | Enforce ≤150 line limit. Add a comment at the top: "If you add domain-specific methods here, promote to a dedicated builder." |
| Auto-approver runs in a hot path; builder allocation overhead | `SectionAccumulator` is lightweight (one array, a few sections). Builder construction is O(sections). Negligible vs. LLM call latency. |

## Definition of done

- [ ] `src/routing/strategies/llm-prompts.ts` deleted
- [ ] Decompose prompt-building moved to `OneShotPromptBuilder`
- [ ] `src/interaction/plugins/auto.ts` no longer has `buildPrompt`
- [ ] `src/prompts/README.md` exists with full invariants
- [ ] Final invariant grep returns zero matches
- [ ] All snapshot + parity tests green
- [ ] `bun test` green
- [ ] Overview spec marked complete; phases 1–6 all merged
