# ADR-016: Prompt Composition (Immutable Sections) and PackageView

**Status:** Proposed
**Date:** 2026-04-23
**Author:** William Khoo, Claude
**Extends:** ADR-015 (Operation Contract); ADR-014 (RunScope & Middleware); ADR-010 (Context Engine)
**Depends-on:** ADR-014 and ADR-015 must land first.

---

## Context

With `RunScope` + middleware (ADR-014) and the `Operation<I, O, C>` contract + `scope.invoke()` (ADR-015) in place, two remaining structural problems block the next class of improvements:

### Problem 1 — Prompt composition is ad-hoc

`src/prompts/builders/` is the designated home for LLM prompt text (Prompt Builder Convention in `forbidden-patterns.md`), but how builders assemble context is inconsistent:

- Some builders receive a `ContextBundle` as a parameter; some reach for a per-stage singleton.
- Constitution injection is hand-wired in ~5 builders, missing in others.
- `.claude/rules/*.md` static-rule content is spliced into prompts inconsistently.
- Progressive / incremental prompt composition — the core need for rectification retries, debate follow-ups, and acceptance diagnosis — has no primitive. Every retry loop hand-stitches its "previous attempt" section.

Today, prompts are opaque strings. The stable prefix (role, constitution, context) cannot be separated from per-call tail (task, inputs). There is no seam for the Context Engine (ADR-010) to inject into, no seam for progressive prompts to extend.

### Problem 2 — Monorepo awareness is convention, not structure

`monorepo-awareness.md` documents the contract: use `packageDir`, not `workdir`; route through `resolveTestFilePatterns()`, not inline regex; never `process.cwd()` outside CLI. Enforcement is by vigilance. Four active violations are tracked (#533, #534, #535, #536) and new code regresses against the rule regularly. The failure mode is silent: polyglot monorepos break with no error, falling back to TS-centric defaults.

---

## Decision

Two pieces:

1. **`IPromptBuilder` sections + immutable prompt middleware** — builders produce `readonly PromptSection[]` instead of strings. Context, constitution, and static-rules injection move into prompt middleware that transforms sections functionally (input array → output array, no mutation). Context Engine (ADR-010) is the source of context sections; builders never import `ContextBundle` again.
2. **`PackageView` and `PackageRegistry`** — operation context gains pre-resolved per-package config, test patterns, language, and framework. `ctx.packageDir` becomes required. The four monorepo violations close as type errors or resolver calls.

---

### 1. `IPromptBuilder` and immutable composition

#### 1.1 Builder contract

```typescript
// src/prompts/types.ts
export interface IPromptBuilder<I> {
  readonly name: string;
  readonly stage: PipelineStage;
  sections(input: I, ctx: PromptBuildContext): readonly PromptSection[];
}

export interface PromptSection {
  readonly id: SectionId;                  // "role" | "task" | "context" | "examples" | "output-format" | "previous-attempts" | ...
  readonly order: number;                  // canonical gaps of 1000 — role=0, context=1000, task=2000, examples=3000, output=4000
  readonly content: string;
  readonly owner: MiddlewareName | BuilderName; // who produced this section — see §1.4
}

export type SectionId = string & { readonly __brand: "SectionId" };
export type MiddlewareName = string & { readonly __brand: "MiddlewareName" };
export type BuilderName = string & { readonly __brand: "BuilderName" };
```

#### 1.2 Build context

```typescript
export interface PromptBuildContext {
  readonly story?: UserStory;
  readonly packageDir: string;
  readonly language: DetectedLanguage;
  readonly stage: PipelineStage;
  readonly storyId?: string;
  readonly previousAttempts?: readonly PromptSection[];  // progressive composition input
}
```

Builders receive **only** what they need to produce their operation-specific sections (role framing for this op, task, examples, output format). They do **not** receive `ContextBundle`, constitution, or static-rules — those are injected by middleware. The Context Engine (ADR-010) is the single source of context; builders never read from it directly.

#### 1.3 Prompt middleware — functional transformers

```typescript
// src/runtime/prompt-middleware.ts
export interface PromptMiddleware {
  readonly name: MiddlewareName;
  readonly phase: "pre-build" | "post-build" | "finalize";
  apply(
    sections: readonly PromptSection[],
    ctx: PromptMiddlewareContext,
  ): Promise<readonly PromptSection[]>;
}

export interface PromptMiddlewareContext {
  readonly buildCtx: PromptBuildContext;
  readonly operation?: string;
  readonly stage: PipelineStage;
  readonly scope: RunScope;
}
```

**Each middleware takes `readonly PromptSection[]` and returns a new `readonly PromptSection[]`.** No shared mutable array. The composer folds: `sections = await mw.apply(sections, ctx)` per middleware, in phase order, within each phase in registration order.

**Ownership rule — deterministic composition:**

- Each `SectionId` has exactly one owner.
- A middleware appending a section with an existing `id` owned by another middleware is a `NaxError PROMPT_SECTION_CONFLICT`.
- A middleware declared as the owner of an id can replace it (e.g. `constitution-inject` owns `role` and replaces the builder's default `role` section if one is present).

This gives deterministic composition without a mutation API. "Who produces what" is documented, not implicit.

**Canonical middleware — owner registry:**

| Middleware | Phase | Owns section id | Role |
|:---|:---|:---|:---|
| `context-inject` | pre-build | `context` | Calls `scope.contextEngine.bundle(buildCtx)`, materializes into one section |
| `constitution-inject` | post-build | `role` | Prepends agent-type-specific constitution (replaces builder's default `role` if any) |
| `static-rules-inject` | post-build | `static-rules` | Appends relevant `.claude/rules/*.md` content for the stage |
| `monorepo-hints` | post-build | `monorepo-hints` | Adds `packageDir`, language, test framework as a section |
| `previous-attempts-inject` | post-build | `previous-attempts` | Renders `buildCtx.previousAttempts` into a section (progressive composition) |
| `budget-truncate` | finalize | (no id — may modify any section's content) | Truncates to configured token budget, logs drops; only permitted finalize-phase content modifier |

**Builders own** operation-specific section ids: `task`, `examples`, `output-format`, plus any op-specific ids (`diff`, `failure`, etc.).

#### 1.4 IPromptComposer

```typescript
// src/prompts/types.ts
export interface IPromptComposer {
  compose<I>(
    builder: IPromptBuilder<I>,
    input: I,
    buildCtx: PromptBuildContext,
  ): Promise<ComposedPrompt>;
}

export interface ComposedPrompt {
  readonly text: string;                   // final concatenated prompt
  readonly sections: readonly PromptSection[];  // for debugging / audit
}
```

`scope.promptComposer` is a scope-level service constructed with the registered prompt middleware chain. Frozen at scope construction, same as agent middleware (ADR-014).

The composer:

1. Creates seed sections via `builder.sections(input, buildCtx)`.
2. Runs pre-build middleware in registration order.
3. Runs post-build middleware in registration order.
4. Runs finalize middleware in registration order.
5. Sorts by `order`, concatenates `content` with `\n\n` separators.
6. Emits `ComposedPrompt`.

#### 1.5 Progressive / incremental composition (rectification)

Rectification retries need to append attempt history without forcing `rectifierBuilder` to know about retry mechanics. `RectifyInput.previousAttempts` from ADR-015 is rendered by `previous-attempts-inject` middleware:

```typescript
// src/runtime/prompt-middleware/previous-attempts.ts
export const previousAttemptsInject: PromptMiddleware = {
  name: "previous-attempts-inject",
  phase: "post-build",
  async apply(sections, ctx) {
    const attempts = ctx.buildCtx.previousAttempts;
    if (!attempts || attempts.length === 0) return sections;
    const rendered: PromptSection = {
      id: "previous-attempts" as SectionId,
      order: 2500,   // between task (2000) and examples (3000)
      content: renderPreviousAttempts(attempts),
      owner: "previous-attempts-inject" as MiddlewareName,
    };
    return [...sections, rendered];
  },
};
```

On iteration N, the rectification loop (ADR-015 §3.1) passes `attempts` through `RectifyInput`. The builder is unaware of retry; the middleware renders history into a section. This is the progressive composition primitive the old draft called out but never specified.

#### 1.6 What changes for existing builders

Every builder in `src/prompts/builders/` converts from `build(input): string` to `sections(input, ctx): readonly PromptSection[]`.

**Net effect per builder:**

- **Removed**: imports of `ContextBundle`, constitution loaders, static-rules loaders. Any code that spliced those into the output string.
- **Kept**: operation-specific prompt text (role framing for this op, task, examples, output format).
- **Added**: section objects with explicit `id` and `order`.

Builders get smaller, not larger. The `forbidden-patterns.md` "Prompt Builder Convention" tightens: builders **must** produce sections; they **may not** import the symbols listed below.

**CI-enforced forbidden imports inside `src/prompts/builders/**`:**

| Forbidden symbol | Module | Why |
|:---|:---|:---|
| `ContextBundle`, `ContextRequest`, `IContextEngine` | `src/context/types`, `src/context/engine` | Context flows via `context-inject` middleware only |
| `loadConstitution`, `Constitution`, `resolveConstitutionForAgent` | `src/constitution` | Constitution flows via `constitution-inject` middleware only |
| `loadStaticRules`, any reader of `.claude/rules/*.md` | `src/rules` (or wherever hosted) | Static rules flow via `static-rules-inject` middleware only |
| `detectLanguage`, `detectTestFramework`, `resolveTestFilePatterns` | `src/project/detector`, `src/test-runners/*` | Monorepo data reaches builders only through `PromptBuildContext.{packageDir, language}` |
| `process.cwd`, `Bun.cwd` | global | Builders are package-agnostic; `ctx.packageDir` is the only path source |

The lint rule is a simple deny-list of module specifiers + global identifiers. Violations are CI errors, not warnings. A builder that genuinely needs a piece of context it cannot get from `PromptBuildContext` should add a field to `PromptBuildContext` (a contract change) rather than reach for the forbidden import.

---

### 2. `PackageView` and `PackageRegistry`

#### 2.1 Per-package resolved view

```typescript
// src/runtime/packages.ts
export interface PackageRegistry {
  all(): readonly PackageView[];                       // from discoverWorkspacePackages()
  findForFile(absPath: string): PackageView | null;    // wraps findPackageDir()
  get(packageDir: string): PackageView;                // cached by packageDir key, constructed on demand
}

export interface PackageView {
  readonly packageDir: string;                         // absolute
  readonly relativeFromRoot: string;                   // e.g. "packages/api"
  readonly config: NaxConfig;                          // merged with .nax/mono/<pkg>/config.json
  readonly testPatterns: ResolvedTestPatterns;         // from resolveTestFilePatterns()
  readonly language: DetectedLanguage;                 // from detectLanguage()
  readonly framework: TestFramework | null;            // from detectTestFramework()
}
```

`PackageRegistry` lives on `RunScope` as a scope-level service (constructed in `IRunScopeFactory.forRun()` from ADR-014). Cache is keyed on `packageDir` and valid for the scope's lifetime — config is frozen at scope construction (ADR-014 §1), so views never go stale.

**No hot reload.** Configuration changes require a new scope. This was established in ADR-014 and is a hard precondition for PackageView caching.

#### 2.2 `OperationContext` gains required `packageDir`

The `OperationContext<C>` from ADR-015 is amended:

```typescript
export interface OperationContext<C> {
  // ... ADR-015 fields ...
  readonly packageDir: string;                         // REQUIRED — no fallback to workdir
  readonly package: PackageView;                       // NEW — pre-resolved view
  readonly packages?: readonly PackageView[];          // present for cross-package ops
}
```

- `ctx.package.testPatterns` replaces every inline test-pattern regex.
- `ctx.package.language` replaces `cmd.startsWith("bun test")`-style detection.
- `ctx.package.config` replaces direct `scope.config` access in operations. `ConfigSelector<C>` (ADR-015) is applied to `ctx.package.config`, not the raw root config — per-package overrides flow through automatically.

Cross-package operations declare `requires.scope: "cross-package"` and receive `ctx.packages: readonly PackageView[]` instead of a single `packageDir` / `package`. `scope.invoke()` refuses to invoke a package-scoped op without a `packageDir` and vice versa — same type-level guard as `requires.session` (ADR-015).

#### 2.3 Close the four monorepo violations

| Violation tracked in `monorepo-awareness.md` | Fix after this ADR |
|:---|:---|
| [#533](https://github.com/nathapp-io/nax/issues/533) — `COMMON_TEST_DIRS` in `test-scanner.ts` | Reads `ctx.package.testPatterns.testDirs` |
| [#534](https://github.com/nathapp-io/nax/issues/534) — hardcoded `test/unit/` in `smart-runner.ts` | Reads `ctx.package.testPatterns.globs` |
| [#535](https://github.com/nathapp-io/nax/issues/535) — `workdir \|\| process.cwd()` in `builder.ts` | Reads `ctx.packageDir` (required field — no fallback path exists) |
| [#536](https://github.com/nathapp-io/nax/issues/536) — `cmd.startsWith("bun test")` in `role-task.ts` | Reads `ctx.package.language` (typed enum) |

Each is a one-to-three-line edit after the operation migration. The lint rule in `.claude/rules/monorepo-awareness.md` §1–§6 stops being aspirational and becomes enforced by types: operations cannot reach `process.cwd()` because `ctx` carries the absolute path; cannot write inline test regex because `ctx.package.testPatterns.regex` is the only typed source.

---

### 3. Architecture After ADR-016

```
RunScope (ADR-014, amended)
  ├─ agentManager, sessionManager               // unchanged
  ├─ services: costAggregator, promptAuditor, permissionResolver, logger
  ├─ contextEngine: IContextEngine              // ADR-010 — produces ContextBundle for context-inject middleware
  ├─ promptComposer: IPromptComposer            // NEW — scope-level, middleware chain frozen at construction
  ├─ packages: PackageRegistry                  // NEW — scope-level, cached
  ├─ getAgent(name) → IAgent                    // ADR-014
  └─ invoke<I,O,C>(op, input, opts) → O         // ADR-015, amended to populate ctx.package

Prompt composition
  ├─ builder.sections(input, buildCtx) → readonly PromptSection[]
  │   — builders own ids: task, examples, output-format, op-specific
  ├─ pre-build middleware:  context-inject (owns "context")
  ├─ post-build middleware: constitution-inject (owns "role"),
  │                         static-rules-inject (owns "static-rules"),
  │                         monorepo-hints (owns "monorepo-hints"),
  │                         previous-attempts-inject (owns "previous-attempts")
  ├─ finalize middleware:   budget-truncate
  └─ IPromptComposer.compose() → ComposedPrompt

OperationContext (ADR-015, amended)
  └─ packageDir: string  (required)
     package: PackageView  (NEW — resolved config, testPatterns, language, framework)
     packages?: readonly PackageView[]  (NEW — cross-package ops)
```

---

## Consequences

### Positive

| Win | Mechanism |
|:---|:---|
| **Builders are smaller and uniform** | Context, constitution, static-rules, monorepo hints, previous attempts all inject via middleware. Builders author only op-specific sections. No more "did I remember to include the constitution?" drift. |
| **Progressive composition is native** | Rectification retries append a `previous-attempts` section via middleware. No hand-stitched retry prompt code. Debate follow-ups, acceptance diagnosis follow the same pattern. |
| **Monorepo becomes structural** | `process.cwd()`, inline test regex, and hardcoded `bun test` stop being convention violations and become type errors or missing `ctx.package.*` fields. #533–#536 collapse to one-line fixes. |
| **Context Engine has exactly one seam** | `context-inject` middleware is the only caller of `scope.contextEngine.bundle(...)`. Builders cannot forget or reimplement context loading. |
| **Deterministic composition** | Section ownership rules catch duplicate ids at runtime with actionable errors. No silent overwrites. Audit trail (`ComposedPrompt.sections`) shows exactly who produced each piece. |
| **Testable in isolation** | Builders tested with fixed `PromptBuildContext` and no middleware. Middleware tested with fixed section input. Full composition tested end-to-end. No monolithic prompt-string fixtures. |
| **Enforceable via lint** | `.claude/rules/forbidden-patterns.md` Prompt Builder Convention becomes type-enforced: builders cannot import `ContextBundle` / constitution / static-rules readers because nothing exposes those to them. |

### Negative / Tradeoffs

| Cost | Mitigation |
|:---|:---|
| Every builder converts from `build(): string` to `sections(): readonly PromptSection[]` | Mechanical. Op-specific sections stay unchanged; context/constitution/rules injection is removed. Net smaller builders. Migrate one builder per PR. |
| Middleware chain is a new concept for prompt authors | Canonical middleware + owner registry documented here. Frozen at scope construction; cannot be reordered per-call. Debugging aid: `ComposedPrompt.sections` shows per-section `owner`. |
| `OperationContext.packageDir` becomes required | Operations that today default to `workdir` must declare their scope. Cross-package ops use `"cross-package"` and receive `packages: readonly PackageView[]`. Type system enforces. |
| `PackageRegistry` cache is lifetime-bound to scope | Config reload requires new scope. This is the same rule as ADR-014 — not a new constraint. |
| Builders in the legacy-string form during migration | During migration, `IPromptComposer` supports a legacy `build(): string` path that wraps the string as a single unnamed section. Used only for un-migrated builders. Removed after Phase 3. |

---

## Migration Plan

Three phases. Phase 1 is behavior-neutral; Phase 2 converts builders; Phase 3 removes the legacy path.

### Phase 1 — `IPromptComposer` + middleware chain + legacy pass-through

- Introduce `src/prompts/types.ts` with `IPromptBuilder`, `PromptSection`, `PromptBuildContext`, `IPromptComposer`, `ComposedPrompt`.
- Introduce `src/runtime/prompt-middleware.ts` with `PromptMiddleware` and the canonical middleware set.
- `IPromptComposer` lives on `RunScope` (constructed in `IRunScopeFactory.forRun()`).
- Legacy support: `composer.composeLegacy(buildFn, input, buildCtx)` accepts a `(input) => string` function and wraps it. Used by un-migrated ops.
- **Exit criteria:** Composer exists on scope. One operation (`rectify` is a good proof — progressive composition is its main benefit) uses the section-based path.
- **Risk:** Low. Additive. Existing builders untouched.

### Phase 2 — Convert builders to sections

- One builder per PR, in this order (impact-first):
  1. `rectifierBuilder` — unlocks progressive composition
  2. `reviewBuilder` (semantic + adversarial)
  3. `tddBuilder` (test-writer, implementer, verifier)
  4. `acceptanceBuilder` (generate, refine, diagnose, fix)
  5. `debateBuilder` (proposer, resolver)
  6. `planBuilder`, `decomposeBuilder` (these already moved to operations in ADR-015 Phase 4)
  7. `oneShotBuilder` (routing classifier, auto-approver)
- Each PR: convert `build(): string` → `sections(): readonly PromptSection[]`, remove `ContextBundle` / constitution / static-rules imports, rely on middleware.
- Tighten `forbidden-patterns.md` → Prompt Builder Convention: builders **must** produce sections; imports of `ContextBundle`, `loadConstitution`, or `.claude/rules/` readers inside `src/prompts/builders/` are CI errors.
- **Exit criteria:** All builders produce sections. No builder imports `ContextBundle` / constitution / static-rules.
- **Risk:** Medium. Broad touch but each builder is independent.

### Phase 3 — `PackageView` enforcement + monorepo violation fixes

- Introduce `src/runtime/packages.ts` with `PackageRegistry` + `PackageView`.
- Amend `OperationContext` in `src/operations/types.ts` to require `packageDir: string` and include `package: PackageView` + optional `packages: readonly PackageView[]`.
- Close the four tracked violations:
  - [#533](https://github.com/nathapp-io/nax/issues/533) — `test-scanner.ts` reads `ctx.package.testPatterns.testDirs`
  - [#534](https://github.com/nathapp-io/nax/issues/534) — `smart-runner.ts` reads `ctx.package.testPatterns.globs`
  - [#535](https://github.com/nathapp-io/nax/issues/535) — `context/builder.ts` reads `ctx.packageDir` (no fallback)
  - [#536](https://github.com/nathapp-io/nax/issues/536) — `prompts/sections/role-task.ts` reads `ctx.package.language`
- Remove the legacy `composer.composeLegacy(...)` pass-through from Phase 1.
- Delete `ContextBundle` parameter from any remaining builder signatures.
- **Exit criteria:** No `process.cwd()` outside CLI entry points (already a lint rule — now enforced by missing-parameter errors). No inline test-pattern regex outside `src/test-runners/`. All four tracked issues close.
- **Risk:** Medium-high. `packageDir` becoming required is the breaking change; each call site must supply it.

**Rollback plan:** Phase 1 is additive. Phase 2 is per-builder, revertible individually. Phase 3 is the hardening pass; if a migration site is blocked, `packageDir` can remain optional with a deprecation warning until the site is unblocked.

---

## Rejected Alternatives

### A. Mutable section arrays passed through middleware

**Rejected.** The initial ADR draft had `PromptMiddlewareContext.sections: PromptSection[]` — mutable. In a codebase whose [coding-style.md](../common/coding-style.md) says *"ALWAYS create new objects, NEVER mutate existing ones"*, handing middleware a mutable array to splice into is off-tone. Functional transformers (`readonly[]` in, `readonly[]` out) eliminate "who owns what" ambiguity and make middleware composable in any order compatible with their phase.

### B. Prompt caching (Anthropic `cache_control`) as motivation

**Rejected (for now).** The initial ADR draft justified section-based composition partly by Anthropic prompt caching. In practice, most nax agent calls are isolated sessions — the cache hit rate is low, and `cache_control` complicates the model abstraction for marginal benefit. The real win from sections is **progressive / incremental composition** (rectification, retries, follow-up prompts). Drop the caching motivation; keep the section design for progressive composition. `cache_control` markers can be added later as a finalize-phase middleware if measured ROI justifies.

### C. Context Engine injects directly into prompts

**Rejected.** Loses the "all prompt text lives in `src/prompts/builders/`" invariant. `context-inject` middleware is the correct seam: Context Engine produces a `ContextBundle`; the middleware materializes it into a `PromptSection` with `owner: "context-inject"`. Builders never see the bundle directly. One seam, one owner.

### D. Per-operation middleware opt-out

**Rejected.** An operation declaring `skipMiddleware: ["constitution-inject"]` reintroduces the drift this ADR removes — some prompts get the constitution, some don't, and the op author decides. If a real case exists (e.g. decompose doesn't need the full constitution), the op's builder can produce a `role` section explicitly and `constitution-inject` will step aside (ownership rule: if the builder declares `role`, `constitution-inject` replaces it; the opt-out becomes a positive declaration). Middleware chain stays frozen.

### E. `PackageView.config` writable for dynamic overrides

**Rejected.** Config is frozen at scope construction (ADR-014). A per-call override mechanism would undermine the cache invariants (when does the PackageView refresh? what about concurrent ops?). If dynamic overrides are genuinely needed, they happen at scope construction — before `RunScope` exists — not mid-run.

---

## Open Questions

1. **Token counting for `budget-truncate`.** Counting tokens requires model-specific tokenizers. Use a conservative approximation (e.g. char count / 3) until the `token-budget` middleware (ADR-015 open question §3) lands with per-model tokenizer support.

2. **Section dedup across middleware.** If two middleware legitimately produce similar content (e.g. `monorepo-hints` and `context-inject` both mention the package language), dedup is the middleware authors' responsibility. No framework-level dedup. Revisit if the audit log shows frequent duplication.

3. **Plugin-contributed prompt middleware.** Plugins may want to contribute middleware (e.g. a company-specific "security-warning" post-build middleware). Deferred to ADR-017 (plugin API v2).

4. **ComposedPrompt inspection UX.** Adding a `nax debug prompt <op>` command that shows the full section breakdown for a given operation is useful for debugging composition issues. Nice-to-have, not in scope.

---

## References

- ADR-010 — Context Engine (provides `ContextBundle` consumed by `context-inject` middleware)
- ADR-014 — RunScope & Middleware (`IPromptComposer` lives on scope, chain frozen at construction)
- ADR-015 — Operation Contract (`OperationContext.package` is amended here; `scope.promptComposer` usage in `rectify`/`plan`/`decompose` operations becomes real here)
- `.claude/rules/forbidden-patterns.md` — Prompt Builder Convention (tightened by this ADR)
- `.claude/rules/monorepo-awareness.md` — rules this ADR makes structural
- `docs/architecture/ARCHITECTURE.md` — subsystem index
