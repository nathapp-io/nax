# Prompt Builder — Phase 2: DebatePromptBuilder migration

**Parent:** [prompt-builder-overview.md](./prompt-builder-overview.md)
**Depends on:** [Phase 1](./prompt-builder-phase1.md)
**Risk:** Low–Medium
**Scope:** Move debate prompt logic into `src/prompts/`, refactor onto `SectionAccumulator`, delete original.

## Goal

1. Move `src/debate/prompt-builder.ts` (`DebatePromptBuilder`) into `src/prompts/builders/debate-builder.ts`.
2. Refactor it to wrap `SectionAccumulator`, sharing wrapping/joining/separator logic with `TddPromptBuilder`.
3. Add new section providers required by debate: `personaSection`, `proposalsSection`, `historySection`.
4. Update all debate callsites to import from `src/prompts`.
5. Delete `src/debate/prompt-builder.ts`.

## Files created

```
src/prompts/
├── builders/
│   └── debate-builder.ts                 # NEW (refactor of src/debate/prompt-builder.ts)
└── core/
    └── sections/                         # if not already created in Phase 1 cleanup
        ├── persona.ts                    # NEW
        ├── proposals.ts                  # NEW
        └── history.ts                    # NEW
```

## Files removed

```
src/debate/prompt-builder.ts              # DELETED
```

## Files modified

- `src/prompts/index.ts` — export `DebatePromptBuilder`.
- `src/debate/session-stateful.ts` — import from `../prompts` instead of `./prompt-builder`.
- `src/debate/session-plan.ts` — same.
- `src/debate/orchestrator.ts` (and any other debate caller) — same.
- `src/prompts/core/types.ts` — open `PromptRole` from a closed union to a string-or-union, OR add `DebateRole` as a separate type. **Decision:** add `DebateRole` as a separate type (`"propose" | "critique" | "rebut" | "synthesize"`) to keep TDD's closed union intact. `TddPromptBuilder.for()` and `DebatePromptBuilder.for()` take different role types — the compiler enforces correct usage per builder.

## Detailed design

### `core/sections/persona.ts`

```typescript
import type { PromptSection } from "../types";

export interface DebatePersona {
  name: string;
  expertise: string;
  perspective: string;
}

export function personaSection(p: DebatePersona): PromptSection {
  return {
    id: "persona",
    overridable: false,
    content: [
      `# YOUR ROLE`,
      ``,
      `You are ${p.name}, a ${p.expertise}.`,
      ``,
      `Perspective: ${p.perspective}`,
    ].join("\n"),
  };
}
```

### `core/sections/proposals.ts`

```typescript
import type { PromptSection } from "../types";

export interface DebateProposal {
  author: string;
  content: string;
}

export function proposalsSection(proposals: DebateProposal[]): PromptSection {
  if (proposals.length === 0) {
    return { id: "proposals", overridable: false, content: "" };
  }
  const body = proposals
    .map((p, i) => `## Proposal ${i + 1} (by ${p.author})\n\n${p.content}`)
    .join("\n\n");
  return {
    id: "proposals",
    overridable: false,
    content: `# PRIOR PROPOSALS\n\n${body}`,
  };
}
```

### `core/sections/history.ts`

```typescript
import type { PromptSection } from "../types";

export interface DebateTurn {
  phase: "propose" | "critique" | "rebut" | "synthesize";
  author: string;
  content: string;
}

export function historySection(turns: DebateTurn[]): PromptSection | null {
  if (turns.length === 0) return null;
  const body = turns
    .map((t) => `## ${t.phase.toUpperCase()} — ${t.author}\n\n${t.content}`)
    .join("\n\n");
  return {
    id: "history",
    overridable: false,
    content: `# DEBATE HISTORY\n\n${body}`,
  };
}
```

### `builders/debate-builder.ts`

```typescript
import type { UserStory } from "../../prd";
import { SectionAccumulator } from "../core/section-accumulator";
import { universalSections } from "../core/universal-sections";
import {
  personaSection,
  proposalsSection,
  historySection,
  type DebatePersona,
  type DebateProposal,
  type DebateTurn,
} from "../core/sections";
import type { PromptSection } from "../core/types";
import { buildStorySection } from "../sections";

export type DebateRole = "propose" | "critique" | "rebut" | "synthesize";

export class DebatePromptBuilder {
  private acc = new SectionAccumulator();
  private role: DebateRole;

  private constructor(role: DebateRole) {
    this.role = role;
  }

  static for(role: DebateRole): DebatePromptBuilder {
    return new DebatePromptBuilder(role);
  }

  // Universal sections (shared with TddPromptBuilder via universalSections)
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

  // Debate-specific
  persona(p: DebatePersona): this {
    this.acc.add(personaSection(p));
    return this;
  }

  proposals(ps: DebateProposal[]): this {
    this.acc.add(proposalsSection(ps));
    return this;
  }

  history(turns: DebateTurn[]): this {
    this.acc.add(historySection(turns));
    return this;
  }

  /** Append the role-specific task instruction. Each phase has its own template. */
  task(): this {
    this.acc.add(taskSectionFor(this.role));
    return this;
  }

  async build(): Promise<string> {
    return this.acc.join();
  }
}

function taskSectionFor(role: DebateRole): PromptSection {
  // Bodies extracted from the existing src/debate/prompt-builder.ts task templates.
  // One small switch — kept inside the file because it's debate-specific glue,
  // not reusable section content.
  switch (role) {
    case "propose": return { id: "task", overridable: false, content: PROPOSE_TASK };
    case "critique": return { id: "task", overridable: false, content: CRITIQUE_TASK };
    case "rebut": return { id: "task", overridable: false, content: REBUT_TASK };
    case "synthesize": return { id: "task", overridable: false, content: SYNTH_TASK };
  }
}

const PROPOSE_TASK = `# YOUR TASK\n\n...`;       // copied verbatim from old builder
const CRITIQUE_TASK = `# YOUR TASK\n\n...`;
const REBUT_TASK = `# YOUR TASK\n\n...`;
const SYNTH_TASK = `# YOUR TASK\n\n...`;
```

**Constraint:** ≤200 lines including the four task constants.

### Callsite updates

For each call:

```typescript
// Before
import { DebatePromptBuilder } from "./prompt-builder";
const prompt = new DebatePromptBuilder()
  .withStory(story)
  .withPersona(p)
  .buildCritiquePrompt(proposals, history);

// After
import { DebatePromptBuilder } from "../prompts";
const prompt = await DebatePromptBuilder.for("critique")
  .constitution(config.constitution)   // NEW: now consistently injected
  .story(story)
  .persona(p)
  .proposals(proposals)
  .history(history)
  .task()
  .build();
```

**Note:** the previous debate builder did NOT inject constitution. Phase 2 starts injecting it. **This is a deliberate behaviour change** — flag it in the PR description and capture a fresh snapshot. If any debate tests assert on prompt content, they need updating.

If preserving exact byte-for-byte debate output is required, gate constitution injection behind a config flag (`config.debate.injectConstitution: false`) for one release, then default to true.

## Tests

### Snapshot tests

Add `test/unit/prompts/debate-builder.snapshot.test.ts`:

```typescript
for (const role of ["propose", "critique", "rebut", "synthesize"] as const) {
  test(`debate role=${role} produces stable output`, async () => {
    const built = await DebatePromptBuilder.for(role)
      .constitution("Test constitution.")
      .story(fixtureStory)
      .persona(fixturePersona)
      .proposals(fixtureProposals)
      .history(fixtureHistory)
      .task()
      .build();
    expect(built).toMatchSnapshot();
  });
}
```

### Behaviour parity tests

Add a temporary parity test that builds the same logical prompt with both the old and new builders and asserts equality (modulo the constitution injection if it's a deliberate change):

```typescript
test("debate builder parity with legacy", async () => {
  const legacy = legacyBuilder.buildCritiquePrompt(/* ... */);
  const next = await DebatePromptBuilder.for("critique")
    .story(fixtureStory)
    .persona(fixturePersona)
    .proposals(fixtureProposals)
    .history(fixtureHistory)
    .task()
    .build();
  expect(stripConstitution(next)).toBe(legacy);
});
```

Delete the parity test once Phase 2 lands.

### Existing debate tests

`test/unit/debate/*` tests that assert on prompt content need updating to use the new builder API. Tests that assert on debate *behaviour* (not prompt strings) should pass unmodified.

## Migration steps (PR checklist)

1. Add `core/sections/persona.ts`, `proposals.ts`, `history.ts`.
2. Add `core/sections/index.ts` re-exporting them.
3. Add `builders/debate-builder.ts`.
4. Copy task body constants verbatim from `src/debate/prompt-builder.ts` into the new file.
5. Update `src/prompts/index.ts` to export `DebatePromptBuilder` and `DebateRole`.
6. Update `src/debate/session-stateful.ts`, `session-plan.ts`, `orchestrator.ts`, and any other caller.
7. Run `grep -rn 'from "./prompt-builder"' src/debate/` — should be empty.
8. Delete `src/debate/prompt-builder.ts`.
9. Capture new snapshots (and parity-check against old output).
10. Run `bun run typecheck && bun run lint && bun test`.

## Success criteria

1. `src/debate/prompt-builder.ts` no longer exists.
2. All debate callsites import from `src/prompts`.
3. New snapshot suite passes.
4. Parity test passes (modulo deliberate constitution injection).
5. `DebatePromptBuilder` ≤200 lines.
6. Each new section file ≤80 lines.
7. `bun test` green.

## Risks

| Risk | Mitigation |
|---|---|
| Constitution injection changes LLM behaviour in debate | Deliberate change. Document in PR. Optionally gate behind config for one release. |
| Task body constants drift during copy | Use a parity test that compares old vs new output (minus constitution). |
| Other subsystems still import `src/debate/prompt-builder` | grep before delete; CI will catch any miss via typecheck. |
| `DebateRole` confused with `PromptRole` | Different type names enforced by `for()` signatures. The compiler prevents `TddPromptBuilder.for("critique")`. |

## Definition of done

- [ ] `src/debate/prompt-builder.ts` deleted
- [ ] All debate callers import from `src/prompts`
- [ ] Snapshot + parity tests green
- [ ] PR description notes the constitution-injection behaviour change
- [ ] `bun test` green
