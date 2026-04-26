# src/prompts/

Single home for all prompt construction in nax. Every prompt sent through the
agent/session surfaces is built here.

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
