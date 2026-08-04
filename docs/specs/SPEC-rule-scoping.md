# SPEC: Rule Scoping — effective `appliesTo` and a new `stages:` axis

<!-- spec-writing: completed-through-phase-6 -->

## Summary

Canonical rules in `.nax/rules/` carry two scoping axes today — `paths:` (package scope) and
`appliesTo:` (touched files) — and a third the codebase never had (`stages:`). Of these, only
`paths:` works. `appliesTo:` is structurally inert because its only input, `ContextRequest.touchedFiles`,
is populated solely from story-declared `contextFiles`, and the filter fails open whenever that list is
empty. This spec makes `appliesTo:` effective by feeding it a complete file set drawn from declared
files plus the story's git diff, adds a `stages:` axis so a rule can decline stages it has no business
in, and records both decisions on the context manifest so a scoping declaration can never again look
like it works while doing nothing.

## Motivation

Three concrete defects, all verified against `main` @ `ced4bc46`:

1. **`appliesTo:` is inert for most stories.** `ruleMatchesTouchedFiles` (`static-rules.ts:150-152`)
   returns `true` when `touchedFiles` is empty, and `stages/context.ts:159` omits the key entirely
   when the story declares no `contextFiles`. Only 5 of the repo's 11 rules declare `appliesTo:` at
   all, and for any story without declared context files those 5 declarations do nothing.

2. **The declaration lies about its own input.** `CanonicalRule.appliesTo`'s docstring
   (`canonical-loader.ts:269`) says the globs are matched against *"changed files in the story's git
   diff."* No git diff reaches that filter. The advertised contract and the implemented one differ.

3. **Every rule is broadcast to all 20 stages.** `ContextRequest` already carries `stage`
   (`types.ts:213`), but the canonical loader reads it nowhere. Test-authoring rules load on `plan`,
   `acceptance`, and `route`, where they have no purpose. There is no axis that can express this —
   `appliesTo:` filters on files, and the stage is not a file.

The cost is now measurable rather than theoretical. PR #1462 made the canonical-rules budget soft by
default, so the provider no longer discards rules to fit a threshold — it emits `budgetPressure`
instead. That fixed silent under-delivery, but it means the full corpus now enters every stage as
`static` chunks, and `static` is a floor kind (`packing.ts:36`) that `packChunks` never drops.
Scoping is the only mechanism that can reduce that payload, because filtering happens *before* the
budget (`static-rules.ts:280`). Reducing tokens is a side effect here; the goal is that rules land
where they belong and that no scoping declaration is ever silently inert.

## Design

### Approach

Filtering is **declarative frontmatter evaluated in the provider**, not a scoring adjustment and not
an LLM decision. Two new filter passes join the two that exist, in this order:

```
loadCanonicalRules(repoRoot)
  -> filter by paths:      (package scope — unchanged)
  -> overlay package rules (monorepo — unchanged)
  -> sort by priority      (unchanged)
  -> filter by stages:     NEW — keyed on request.stage
  -> filter by appliesTo:  unchanged code, now fed request.scopeFiles
  -> applyCanonicalRulesBudget (unchanged)
  -> chunks + scopingReport   NEW
```

**Fail-open is preserved deliberately.** Neither axis drops a rule when its input is absent: a rule
with no `stages:` applies to every stage, and a rule with `appliesTo:` still loads when the scope set
is empty. Making absence destructive would gut the rulebook on exactly the stories that forgot to
declare files. The credibility gap is closed by *reporting* inert declarations, not by enforcing them.

### Integration

**Existing types to extend:**

- `CanonicalRule` (`src/context/rules/canonical-loader.ts:254`) — add `stages?: string[]`, mirroring
  the existing `paths?: string[]` / `appliesTo?: string[]` fields.
- `KNOWN_FRONTMATTER_KEYS` (`canonical-loader.ts:160`) — currently `new Set(["priority", "paths",
  "appliesTo"])`. `parseFrontmatter` **throws `RulesFrontmatterError` on any key not in this set**
  (`canonical-loader.ts:305-311`), so `"stages"` must be added or every rule declaring it fails to
  load. The error message at `:308` names the recognised keys and must be updated with it.
- `ContextRequest` (`src/context/engine/types.ts:190`) — add `scopeFiles?: string[]`.
  `touchedFiles?: string[]` (`:266`) keeps its current meaning and its current consumers.
- `ContextProviderResult` (`types.ts:380`) — add `scopingReport?: ProviderScopingReport`, sibling to
  the existing `budgetPressure?: ProviderBudgetPressure` (`:394`).
- `ContextManifest.providerResults[]` (`src/context/engine/manifest-types.ts:132-159`) — add the same
  optional field alongside `budgetPressure` (`:157`).
- `StageAssembleOptions` (`src/context/engine/stage-assembler.ts:49`) — add `scopeFiles?: string[]`,
  alongside the existing `touchedFiles?: string[]`.
- `ParsedFrontmatter` (`canonical-loader.ts:273`, module-private) — add `warnings: string[]`, so
  non-fatal frontmatter diagnostics have a return channel (see "Warning mechanism" below).
- `CanonicalRule` — add `warnings?: string[]`, carrying the parser's diagnostics for the rule so
  `rulesLintCommand` can attribute them to a file without re-parsing.

**There is no `src/context/rules/index.ts` barrel.** Every importer reaches the loader by leaf path
(`../rules/canonical-loader` from `engine/`, `../context/rules/canonical-loader` from `cli/`), and
`src/context/index.ts:41` re-exports only `NeutralityLintError`. US-001 must therefore preserve the
existing leaf-path import surface by re-exporting the moved symbols from `canonical-loader.ts`, and
must **not** introduce a new barrel — that would be unrequested scope and a new value-import surface.

### Warning mechanism

`parseFrontmatter` is a pure synchronous function that takes no logger and signals failure only by
throwing `RulesFrontmatterError`. The two new diagnostics — unrecognised stage name, displaced
frontmatter — are **non-fatal**, so they cannot use that channel, and adding a logger call inside the
parser would make them untestable without global capture. Instead:

1. `parseFrontmatter` **returns** them on `ParsedFrontmatter.warnings`.
2. `loadCanonicalRules` logs each one via the already-injectable `_canonicalLoaderDeps.getLogger()`
   (`canonical-loader.ts:70`, `:469`), giving runtime visibility on every run.
3. The warnings ride on `CanonicalRule.warnings`, so `rulesLintCommand` reports them per file
   without duplicating the detection.

One detection, three surfaces, and each is assertable — the parser by return value, the loader and
the lint command through their existing injectable loggers.

**Integration points:**

- `StaticRulesProvider.fetch` (`static-rules.ts:228`) — applies both filters and returns the report.
- `contextStage` (`src/pipeline/stages/context.ts:362`) — first request producer; sets `scopeFiles`
  on the request it builds at `:145-159`.
- `promptStage` (`src/pipeline/stages/prompt.ts:62`) — second request producer, via its single call to
  `assembleForStage(ctx, execStage)` at `prompt.ts:79`, which currently passes no options at all.
- The orchestrator's provider-result mapping (`src/context/engine/orchestrator.ts:298`) — where
  `budgetPressure` is already spread onto the manifest entry; `scopingReport` joins it there.

**Existing patterns to follow:**

- `ruleMatchesPackage` / `ruleMatchesTouchedFiles` (`static-rules.ts:150`, `:160`) — the shape every
  new filter predicate mirrors: absent declaration returns `true`, comparison is pure.
- `ProviderBudgetPressure` (`manifest-types.ts:31`) — the shape `ProviderScopingReport` mirrors: a
  flat record of counts plus stable ids, declared in `manifest-types.ts`, referenced from `types.ts`.
- `applyCanonicalRulesBudget`'s soft branch (`canonical-loader.ts:388`) — reports rather than
  discards; the same posture both new filters take when their input is missing.

**The v2 path is opt-in and both producers sit behind it.** `context.v2.enabled` defaults to `false`
(`src/config/schemas-context.ts:115`); this repository turns it on in `.nax/config.json`. When it is
off, `contextStage` takes `runV1Path` (`stages/context.ts:370`) and no provider is reached at all,
so every test exercising a request producer must enable it in its own fixture. Nothing in this spec
changes that default.

**Where the scope-file resolver may live — a hard constraint, not a preference.**
`src/review/adversarial.ts:18` and `src/review/semantic.ts:12` **value-import** `filterContextByRole`
from `../context`. A module under `src/context/` that value-imported `@/review` to reach
`collectDiffFileList` would therefore close a genuine circular import. The resolver is placed in
`src/pipeline/` instead, which may import `review` freely (`src/review/` imports nothing from
`src/pipeline/`). Both request producers already live in `src/pipeline/stages/`, and
`assembleForStage` receives the resolved list through `StageAssembleOptions` rather than resolving it
itself — so `src/context/engine/` gains no dependency on `src/review/`.

### New module — `src/pipeline/context-scope.ts`

```typescript
/**
 * Resolves the complete evidence set of files a story touches, for SCOPING
 * decisions only. Never used to fetch content — see ContextRequest.touchedFiles
 * for the curated, capped list the content-fetching providers consume.
 */
export async function resolveScopeFiles(ctx: PipelineContext): Promise<string[]>;
```

Composition, reusing exported helpers rather than re-implementing git access:

- `getContextFiles(story)` — `src/prd/types.ts:214`
- `getExpectedFiles(story)` — `src/prd/types.ts:225`, currently consumed nowhere in the context path
- `resolveEffectiveRef(workdir, story.storyGitRef, story.id)` — `src/review/diff-utils.ts:135`;
  prefers the story's persisted `storyGitRef` (`src/prd/types.ts:202`) and falls back to merge-base
- `collectDiffFileList(workdir, ref)` — `src/review/diff-utils.ts:258`; returns
  `Promise<string[] | undefined>` and already applies `.naxignore` exclusions

The union is deduped and sorted so manifests stay byte-stable across runs.

### New type — `ProviderScopingReport`

Declared in `src/context/engine/manifest-types.ts`:

```typescript
export interface ProviderScopingReport {
  /** Stable ids of rules dropped because request.stage was not in their `stages:` list. */
  stageFilteredIds: string[];
  /** Stable ids of rules dropped because no scope file matched their `appliesTo:` globs. */
  appliesToFilteredIds: string[];
  /**
   * Rules that declared `appliesTo:` but were admitted unconditionally because the
   * scope set was empty. Non-zero means the declaration had no effect for this request.
   */
  appliesToInertCount: number;
  /** Size of the scope set the filters ran against. The list itself is not persisted. */
  scopeFileCount: number;
}
```

The full file list is deliberately **not** persisted — a several-hundred-entry array in every
`context-manifest-<stage>.json` would bloat the artifacts.

`scopingReport` and `budgetPressure` stay separate fields because they answer different questions:
budget pressure means the corpus exceeded a threshold; scoping means those rules did not belong here.
Merging them would restore the ambiguity that made the pre-#1462 truncation unreadable.

### File Format — `stages:` frontmatter

`stages:` is a list of pipeline stage names. Absent or empty means the rule applies to every stage.

```yaml
---
priority: 100
paths: ["apps/api"]
appliesTo:
  - "test/**/*.test.ts"
stages:
  - "execution"
  - "tdd-test-writer"
  - "tdd-implementer"
  - "rectify"
  - "review"
---
```

Value validation mirrors `appliesTo:` (`canonical-loader.ts:336-344`): a list of non-empty strings,
anything else throws `RulesFrontmatterError`.

**Stage-name recognition is advisory, not authoritative.** `STAGE_CONTEXT_MAP`
(`src/context/engine/stage-config.ts:109`) is *not* a closed list of real stage strings —
`getStageContextConfig` (`:270`) falls back to `DEFAULT_STAGE_CONFIG` for unmapped stages, and
`acceptance-setup` and `queue-check` are real stage values absent from the map. Filtering is a plain
string comparison, so a rule naming a real-but-unmapped stage still behaves correctly; only the
warning would be wrong. An unrecognised name therefore warns and the rule is still filtered normally.

### Failure Handling

| Condition | Behaviour |
|:---|:---|
| Git ref unresolvable, or `collectDiffFileList` returns `undefined` / throws | Fail-open — `resolveScopeFiles` returns the declared sources (`contextFiles` ∪ `expectedFiles`) and does not throw |
| Scope set is empty and a rule declares `appliesTo:` | Fail-open — the rule loads, and it is counted in `appliesToInertCount` |
| `stages:` names a value recognised by neither `STAGE_CONTEXT_MAP` nor the known stage literals | Warn; the rule is still filtered by string comparison |
| Rule file's opening `---` is preceded by a BOM or blank line | Warn that the frontmatter block will be ignored; the rule still loads with its declarations lost and default priority (current silent behaviour, now visible) |

## Out of Scope

- Strict `appliesTo:` enforcement — a rule declaring `appliesTo:` still loads when the scope set is empty, and this spec adds no configuration to change that.
- A `roles:` frontmatter axis, and any change to chunk `role` assignment or to `src/context/engine/scoring.ts`.
- Any hard ceiling, cap, or eviction applied to `static` floor-kind chunks during packing; `packChunks` floor behaviour is unchanged.
- Changing `ContextRequest.touchedFiles`, its population from `getContextFiles`, or the `MAX_FILES = 10` caps in `git-history.ts` and `code-neighbor.ts`.
- Relocating context manifests out of `<projectDir>/.nax/features/` into the global `~/.nax/` artifact store.
- Auto-repairing displaced frontmatter — a BOM or leading blank line is reported, never silently corrected.
- Persisting the resolved scope-file list itself into `context-manifest-<stage>.json`; only counts and dropped ids are recorded.
- Parsing story descriptions or acceptance-criteria prose to infer additional scope files.

## Stories

1. **US-001: Split `canonical-loader.ts` and `cli/rules.ts`** — no dependencies
2. **US-002: `stages:` frontmatter parsing and displaced-frontmatter detection** — depends on US-001
3. **US-003: Resolve `scopeFiles` and thread it through both request producers** — no dependencies
4. **US-004: Provider applies both scoping axes and reports the outcome** — depends on US-002, US-003
5. **US-005: `nax rules lint` surfaces the new scoping warnings** — depends on US-001, US-002
6. **US-006: Declare `stages:` across the canonical rule store** — depends on US-004

US-001 and US-003 are independent and may run in parallel.

**Dependency note — the 600-line lint gate.** `src/context/rules/canonical-loader.ts` is at 576 lines
and `src/cli/rules.ts` at 597, against the `SRC_LIMIT = 600` enforced by
`scripts/check-file-sizes.ts` inside `bun run lint`. Any story writing to either file **must** depend
on US-001, or parallel execution can run it before the split and breach the gate with a correct
implementation. `src/context/engine/orchestrator.ts` is at 584 lines: US-004's change there is the
two-line spread of `scopingReport` at `:298` and must not grow beyond it.

**The same gate applies to test files at `TEST_LIMIT = 800`, and two of the natural homes are
already close to it.** `bun run check:file-sizes` scans `test/**/*.test.ts`; a file under the limit
today is not grandfathered and may not cross it. Current sizes and the consequence per story:

| Test file | Lines | Headroom | Rule |
|:---|---:|---:|:---|
| `test/unit/context/engine/providers/static-rules.test.ts` | 783 | 17 | US-004 must **not** append here — add `static-rules-scoping.test.ts` beside it, mirroring the existing `static-rules-paths.test.ts` split |
| `test/unit/cli/rules.test.ts` | 747 | 53 | US-005 must **not** append here — add `test/unit/cli/rules-lint.test.ts`, mirroring the `rules-lint.ts` source split |
| `test/unit/context/rules/canonical-loader.test.ts` | 579 | 221 | US-002 puts its frontmatter tests in a new `test/unit/context/rules/rules-frontmatter.test.ts`, matching the source module it covers |

Per `test-architecture.md`, a test file mirrors its source file name, so each new module created by
US-001 gets its own test file rather than growing the file it was split out of.

### US-001: Split `canonical-loader.ts` and `cli/rules.ts`

Two pure moves, no behaviour change. Move the frontmatter block —
`KNOWN_FRONTMATTER_KEYS`, `FRONTMATTER_PRIORITY_DEFAULT`, `RulesFrontmatterError`, `CanonicalRule`,
`ParsedFrontmatter`, `parseFrontmatter` — from `canonical-loader.ts` into a new
`src/context/rules/rules-frontmatter.ts`, re-exported from `canonical-loader.ts` so existing importers
are unaffected. Move `collectCanonicalRuleRoots`, `rulesLintCommand` and the dead-glob constants from
`cli/rules.ts` into a new `src/cli/rules-lint.ts`, re-exported from `cli/rules.ts`.

**Verification note:** the split itself is verified by the build/static gate —
`bun run typecheck && bun run lint` — which fails on any unresolved import and on any file over
`SRC_LIMIT`. After the split, lower the size baseline with `bun run check:file-sizes:update`.

#### Context Files
- `src/context/rules/canonical-loader.ts` — split source; frontmatter block at lines 160-353
- `src/cli/rules.ts` — split source; lint block at lines 36-46 and 553-597
- `src/context/index.ts` — re-exports `NeutralityLintError` from the loader at line 41; must keep resolving
- `src/context/engine/providers/static-rules.ts` — imports `CanonicalRule` by leaf path at lines 24-25

#### Creates
- `src/context/rules/rules-frontmatter.ts` — frontmatter parsing, types, and error
- `src/cli/rules-lint.ts` — `rulesLintCommand` and its helpers

### US-002: `stages:` frontmatter parsing and displaced-frontmatter detection

Add the `stages` key to `KNOWN_FRONTMATTER_KEYS` and to the unknown-key error message, parse and
validate it, and detect frontmatter whose opening `---` is displaced by a BOM or leading blank line.

#### Context Files
- `src/context/rules/rules-frontmatter.ts` — created by US-001, extended here
- `src/context/engine/stage-config.ts` — `STAGE_CONTEXT_MAP` and `getStageContextConfig` for name recognition
- `src/context/rules/canonical-loader.ts` — `loadCanonicalRules`, which must surface the new field on `CanonicalRule`

### US-003: Resolve `scopeFiles` and thread it through both request producers

Add `resolveScopeFiles` and wire it into both producers: `contextStage`, which builds a
`ContextRequest` directly, and `promptStage`, which builds one indirectly through
`assembleForStage`. `assembleForStage` threads `options.scopeFiles` onto the request without
resolving anything itself, keeping `src/context/engine/` free of any dependency on `src/review/`.

#### Context Files
- `src/pipeline/stages/context.ts` — first producer; request built at lines 145-159
- `src/pipeline/stages/prompt.ts` — second producer; `assembleForStage` call at line 79
- `src/context/engine/stage-assembler.ts` — `StageAssembleOptions` and request construction at line 193
- `src/review/diff-utils.ts` — `resolveEffectiveRef` and `collectDiffFileList` to reuse
- `src/prd/types.ts` — `getContextFiles`, `getExpectedFiles`, `storyGitRef`

#### Creates
- `src/pipeline/context-scope.ts` — `resolveScopeFiles`

### US-004: Provider applies both scoping axes and reports the outcome

`StaticRulesProvider.fetch` filters by `stages:` before `appliesTo:`, feeds `appliesTo:` from
`request.scopeFiles`, and returns a `ProviderScopingReport`. The orchestrator spreads it onto the
manifest provider entry beside `budgetPressure`.

#### Context Files
- `src/context/engine/providers/static-rules.ts` — filter chain at lines 276-284
- `src/context/engine/types.ts` — `ContextRequest`, `ContextProviderResult`
- `src/context/engine/manifest-types.ts` — `ProviderBudgetPressure` as the shape to mirror
- `src/context/engine/orchestrator.ts` — provider-result mapping at line 298
- `src/context/rules/rules-frontmatter.ts` — created by US-001, supplies `CanonicalRule.stages`

### US-005: `nax rules lint` surfaces the new scoping warnings

`rulesLintCommand` warns on unrecognised `stages:` values and on displaced frontmatter, reusing the
detection from US-002. The existing dead-glob warning (`cli/rules.ts:586`) is unchanged.

#### Context Files
- `src/cli/rules-lint.ts` — created by US-001, extended here
- `src/context/rules/rules-frontmatter.ts` — created by US-001 and US-002, supplies the detections

### US-006: Declare `stages:` across the canonical rule store

Add `stages:` frontmatter to the rules in `.nax/rules/` that are stage-specific. Test-authoring rules
(`test-writing.md`, `test-architecture.md`, `test-helpers.md`, `testing-commands.md`) decline the
stages that never author or run tests — `plan`, `acceptance`, `route`. Rules that genuinely apply
everywhere (`forbidden-patterns.md`, `project-conventions.md`) declare no `stages:` key.

#### Context Files
- `.nax/rules/test-writing.md` — stage-specific rule to scope
- `.nax/rules/test-architecture.md` — stage-specific rule to scope
- `.nax/rules/forbidden-patterns.md` — global rule that must stay unscoped
- `src/context/engine/providers/static-rules.ts` — the filter this authoring must satisfy

### Seams

- **US-003 -> US-004 (`scopeFiles`)**: US-004's provider consumes `request.scopeFiles`, produced by
  US-003. Pinned by US-003's two producer ACs, which assert on the request a stub provider receives
  when each stage is triggered at its own entry point.
- **US-002 -> US-004 (`CanonicalRule.stages`)**: US-004's filter consumes the field US-002 parses.
  Pinned by US-004's filter ACs, which load rules from disk rather than hand-building rule objects.
- **US-004 -> US-006 (`stages:` authoring)**: the parser and filter are inert until rules declare the
  key. Pinned by US-006's manifest AC, which asserts on a real assembly over the real rule store.

## Acceptance Criteria

### US-001: Split `canonical-loader.ts` and `cli/rules.ts`

- [unit] `parseFrontmatter` is importable from `src/context/rules/rules-frontmatter` and returns
  `priority` equal to `100` when the supplied content has no frontmatter block.
- [unit] `loadCanonicalRules` on a directory containing a rule declaring `priority: 35` returns a
  `CanonicalRule` whose `priority` is `35`, proving the loader routes through the moved parser.
- [unit] `loadCanonicalRules` on a directory containing a rule declaring `paths: ["apps/api"]`
  returns a `CanonicalRule` whose `paths` equals `["apps/api"]`.
- [unit] `RulesFrontmatterError` remains importable from `src/context/rules/canonical-loader` by
  re-export, and is thrown by `loadCanonicalRules` when a rule file opens with `---` and has no
  closing `---`.
- [unit] `NeutralityLintError` remains importable from `src/context` after the split.
- [unit] `rulesLintCommand` is importable from `src/cli/rules-lint` and resolves without throwing
  when run against a repository containing no canonical rule files.
- [unit] `rulesLintCommand` remains importable from `src/cli/rules` via re-export.

### US-002: `stages:` frontmatter parsing and displaced-frontmatter detection

- [unit] `parseFrontmatter` returns `stages` equal to `["execution", "review"]` for a rule declaring
  those two values as a YAML list.
- [unit] `parseFrontmatter` returns `stages` as `undefined` when the key is absent.
- [unit] `parseFrontmatter` returns `stages` as `undefined` when the key is declared as an empty list.
- [unit] `parseFrontmatter` throws `RulesFrontmatterError` when `stages` is declared as a list
  containing a non-string entry.
- [unit] `parseFrontmatter` no longer throws the unknown-key `RulesFrontmatterError` for a rule whose
  only frontmatter key is `stages`.
- [unit] `parseFrontmatter` still throws `RulesFrontmatterError` naming the offending key for a rule
  declaring a key that is none of `priority`, `paths`, `appliesTo`, `stages`.
- [unit] `loadCanonicalRules` returns a `CanonicalRule` whose `stages` equals `["plan"]` for a rule
  file on disk declaring that value.
- [unit] `parseFrontmatter` returns a `warnings` entry naming the unrecognised stage, and still
  returns `stages` equal to `["not-a-real-stage"]`, when a declared stage name matches neither
  `STAGE_CONTEXT_MAP` nor the known stage literals.
- [unit] `parseFrontmatter` returns an empty `warnings` list for `stages: ["acceptance-setup"]`, a
  real stage absent from `STAGE_CONTEXT_MAP`.
- [unit] `parseFrontmatter` returns a `warnings` entry identifying displaced frontmatter when the
  content begins with a UTF-8 byte order mark followed by `---`.
- [unit] `parseFrontmatter` returns a `warnings` entry identifying displaced frontmatter when the
  content begins with a blank line followed by `---`.
- [unit] `parseFrontmatter` returns `priority` equal to `100` and `paths` as `undefined` for content
  whose `---` block is preceded by a blank line, confirming the declarations are lost.
- [unit] `loadCanonicalRules` returns a `CanonicalRule` whose `warnings` carries the parser's
  displaced-frontmatter entry for a rule file beginning with a blank line followed by `---`.
- [unit] `loadCanonicalRules` emits a warning through `_canonicalLoaderDeps.getLogger()` for a rule
  file whose frontmatter block is displaced.

### US-003: Resolve `scopeFiles` and thread it through both request producers

- [unit] `resolveScopeFiles` returns the union of the story's `contextFiles` and `expectedFiles` when
  the git diff yields no additional files.
- [unit] `resolveScopeFiles` returns a list containing no duplicate entries when a path appears in
  both `contextFiles` and the git diff.
- [unit] `resolveScopeFiles` returns entries in ascending lexicographic order.
- [unit] `resolveScopeFiles` includes a file returned by `collectDiffFileList` that appears in
  neither `contextFiles` nor `expectedFiles`.
- [unit] `resolveScopeFiles` returns only the declared `contextFiles` and `expectedFiles`, without
  throwing, when `resolveEffectiveRef` resolves to `undefined`.
- [unit] `resolveScopeFiles` returns only the declared `contextFiles` and `expectedFiles`, without
  throwing, when `collectDiffFileList` rejects.
- [integration] Triggering `contextStage.execute(ctx)` with `ctx.config.context.v2.enabled` set to
  `true` in the fixture and a stub provider registered causes that provider's `fetch` to receive a
  `ContextRequest` whose `scopeFiles` equals the value `resolveScopeFiles` returned.
- [integration] Triggering `promptStage.execute(ctx)` with `ctx.config.context.v2.enabled` set to
  `true` in the fixture and a stub provider registered causes that provider's `fetch` to receive a
  `ContextRequest` whose `scopeFiles` equals the value `resolveScopeFiles` returned.
- [unit] `assembleForStage` builds a `ContextRequest` whose `scopeFiles` equals the
  `scopeFiles` supplied through `StageAssembleOptions`.
- [unit] `assembleForStage` builds a `ContextRequest` whose `touchedFiles` still equals
  `getContextFiles(story)` when `scopeFiles` is supplied, confirming the two fields are independent.

### US-004: Provider applies both scoping axes and reports the outcome

- [unit] `StaticRulesProvider.fetch` returns no chunk for a rule declaring `stages: ["plan"]` when
  the request's `stage` is `"execution"`.
- [unit] `StaticRulesProvider.fetch` returns a chunk for a rule declaring `stages: ["plan"]` when the
  request's `stage` is `"plan"`.
- [unit] `StaticRulesProvider.fetch` returns a chunk for a rule declaring no `stages` key regardless
  of the request's `stage`.
- [unit] `StaticRulesProvider.fetch` returns no chunk for a rule declaring
  `appliesTo: ["test/**/*.test.ts"]` when `scopeFiles` contains only `src/foo.ts`.
- [unit] `StaticRulesProvider.fetch` returns a chunk for a rule declaring
  `appliesTo: ["test/**/*.test.ts"]` when `scopeFiles` contains `test/unit/foo.test.ts` and the
  request's `touchedFiles` is empty, proving the filter now reads `scopeFiles`.
- [unit] `StaticRulesProvider.fetch` returns a chunk for a rule declaring `appliesTo:` when
  `scopeFiles` is empty, preserving fail-open.
- [unit] `StaticRulesProvider.fetch` returns a result whose `scopingReport.appliesToInertCount` is
  `1` when one rule declares `appliesTo:` and `scopeFiles` is empty.
- [unit] `StaticRulesProvider.fetch` returns a result whose `scopingReport.appliesToInertCount` is
  `0` when `scopeFiles` is non-empty.
- [unit] `StaticRulesProvider.fetch` returns a result whose `scopingReport.stageFilteredIds` contains
  the id of the rule dropped by the `stages:` filter.
- [unit] `StaticRulesProvider.fetch` returns a result whose `scopingReport.appliesToFilteredIds`
  contains the id of the rule dropped by the `appliesTo:` filter.
- [unit] `StaticRulesProvider.fetch` returns a result whose `scopingReport.scopeFileCount` equals the
  number of entries in the request's `scopeFiles`.
- [unit] `StaticRulesProvider.fetch` returns a result whose `budgetPressure` is unaffected by rules
  removed by either scoping filter, confirming the two reports are independent.
- [integration] Assembling a bundle through the orchestrator with `StaticRulesProvider` registered
  returns a `ContextBundle` whose `manifest.providerResults` entry for `static-rules` carries the
  `scopingReport` the provider produced.

### US-005: `nax rules lint` surfaces the new scoping warnings

- [unit] `rulesLintCommand` emits a warning through `_rulesCLIDeps.getLogger()` naming the rule file
  when that file declares a stage matching neither `STAGE_CONTEXT_MAP` nor the known stage literals.
- [unit] `rulesLintCommand` emits no unrecognised-stage warning through `_rulesCLIDeps.getLogger()`
  when every declared stage is recognised.
- [unit] `rulesLintCommand` emits a warning through `_rulesCLIDeps.getLogger()` naming the rule file
  when that file begins with a blank line followed by `---`.
- [unit] `rulesLintCommand` resolves without throwing when a rule file carries a displaced
  frontmatter block, treating it as a warning rather than a failure.
- [unit] `rulesLintCommand` still reports the existing dead-glob warning for a rule whose `appliesTo`
  glob matches no file in the linted repository.

### US-006: Declare `stages:` across the canonical rule store

- [integration] `loadCanonicalRules` over the repository's `.nax/rules` directory returns a
  `CanonicalRule` for `test-writing.md` whose `stages` excludes the value `"plan"`.
- [integration] `loadCanonicalRules` over the repository's `.nax/rules` directory returns a
  `CanonicalRule` for `forbidden-patterns.md` whose `stages` is `undefined`.
- [integration] `StaticRulesProvider.fetch` against the repository's `.nax/rules` directory with the
  request's `stage` set to `"plan"` returns no chunk whose id derives from `test-writing.md`.
- [integration] `StaticRulesProvider.fetch` against the repository's `.nax/rules` directory with the
  request's `stage` set to `"plan"` returns a chunk whose id derives from `forbidden-patterns.md`.
- [integration] `StaticRulesProvider.fetch` against the repository's `.nax/rules` directory with the
  request's `stage` set to `"tdd-test-writer"` returns a chunk whose id derives from
  `test-writing.md`.
- [unit] `loadCanonicalRules` over the repository's `.nax/rules` directory returns every
  `CanonicalRule` with an empty `warnings` list, confirming every authored stage name is recognised
  and no rule file carries displaced frontmatter.
