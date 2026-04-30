# Static Rules Guide

> Authoring and tuning canonical rules for the Context Engine. For the design rationale see [SPEC-context-engine-canonical-rules.md](../specs/SPEC-context-engine-canonical-rules.md). For how rules fit into the broader assembly pipeline see [context-engine.md](./context-engine.md).

## What static rules are

Static rules are short, project-specific guidance that the Context Engine prepends to every agent prompt — coding standards, forbidden patterns, error-handling conventions, testing rules. They are agent-agnostic by design (no `CLAUDE.md`, no `<system-reminder>`, no "the X tool" phrasing) so a fallback agent reads the same guidance as the primary.

The provider that loads them is `StaticRulesProvider` ([src/context/engine/providers/static-rules.ts](../../src/context/engine/providers/static-rules.ts)). Every chunk it emits is a budget-floor chunk — included regardless of stage budget pressure (subject only to the rules-specific budget).

## Where rules live

```
<repoRoot>/.nax/rules/<name>.md            ← repo-level rules
<repoRoot>/.nax/mono/<package>/.nax/rules/ ← per-package overlay (monorepo only)
```

Subdirectories one level deep are allowed (e.g. `.nax/rules/api/auth.md`); deeper nesting is ignored with a warning.

In a monorepo, package-level rules **overlay** repo-level rules: a file at `apps/api/.nax/rules/foo.md` overrides the repo-level `foo.md` by fileName. Other files merge.

## File format

Each `.md` file may begin with YAML frontmatter, followed by markdown body:

```markdown
---
priority: 50
paths:
  - "apps/api/**"
appliesTo:
  - "**/*.repository.ts"
  - "**/*.service.ts"
---

# API — Prisma Repository Rules

- Inject `PrismaService<PrismaClient>` from `@nathapp/nestjs-prisma`
- ...
```

Frontmatter keys (all optional):

| Key | Type | Default | Effect |
|:---|:---|:---|:---|
| `priority` | int | `100` | Lower = more important. Drives sort order and budget-truncation tail bias. Use `50-80` for must-have rules, `100` for normal, `150+` for nice-to-have. |
| `paths` | string \| string[] | none | Globs against `relative(repoRoot, packageDir)`. Rule loads only when the **package** matches. Always-true in single-package repos. |
| `appliesTo` | string \| string[] | none | Globs against `request.touchedFiles` (PRD `contextFiles`). Rule loads only when the story declares it touches a matching file. |

Body must pass the neutrality linter — see below.

## How filtering actually works

Two filter axes apply in order, both inside `StaticRulesProvider.fetch`:

1. **`paths:` (package-scope)** — drops the rule if the story's `packageDir` doesn't match. ([static-rules.ts:188-190](../../src/context/engine/providers/static-rules.ts#L188-L190))
2. **`appliesTo:` (touched-files)** — drops the rule if the story's `contextFiles` (passed via `request.touchedFiles`) don't match. ([static-rules.ts:234](../../src/context/engine/providers/static-rules.ts#L234))

Then a token-budget pass (`rules.budgetTokens`, default 8192) tail-truncates by priority.

### The empty-list short-circuit

[static-rules.ts:139-141](../../src/context/engine/providers/static-rules.ts#L139-L141):

```typescript
function ruleMatchesTouchedFiles(appliesTo, touchedFiles): boolean {
  if (!appliesTo || appliesTo.length === 0) return true;
  if (!touchedFiles || touchedFiles.length === 0) return true;  // ← key
  // ... glob match
}
```

If a story has no `contextFiles` (greenfield project, exploration story), `appliesTo:` filtering is bypassed — every `appliesTo:`-tagged rule loads anyway. This is conservative-by-default: don't drop a potentially-needed rule when the planner hasn't declared intent.

Practical consequence: **`appliesTo:` is only a filter for stories whose PRD has populated `contextFiles`**. For mature projects where the planner reliably emits `contextFiles`, this is the typical case and the filter does real work. For new projects, expect rules to over-include; that's the right behaviour at that stage.

`paths:` has no equivalent short-circuit — package always resolves.

## Where `request.touchedFiles` comes from

The variable name is misleading. It is **not** a git diff. Source: [src/prd/types.ts:170](../../src/prd/types.ts#L170)

```typescript
export function getContextFiles(story: UserStory): string[] {
  return story.contextFiles ?? story.relevantFiles ?? [];
}
```

Set in [stage-assembler.ts:193](../../src/context/engine/stage-assembler.ts#L193) as `options.touchedFiles ?? getContextFiles(ctx.story)`. So the signal flowing into `appliesTo:` matching is **planner intent** — the file list the PRD declares the story will touch. Same intent signal that drives `code-neighbor`, `git-history`, and `test-coverage` providers.

The pull-tool path also sets `touchedFiles: [filePath]` when the agent uses a Read tool mid-session ([pull-tools.ts:217](../../src/context/engine/pull-tools.ts#L217)) — so `appliesTo:` re-engages on pull, narrowing rules to what the agent just read.

## Authoring patterns

### When to use `paths:` (monorepo)

Use `paths:` when a rule applies to one package only:

```markdown
---
paths:
  - "apps/api/**"
---
```

In a monorepo with `apps/api`, `apps/web`, `apps/cli`, this scopes the rule so a story under `apps/web` doesn't carry API-specific guidance.

Single-package repos: skip `paths:` entirely. It's a no-op.

### When to use `appliesTo:`

Use `appliesTo:` when a rule fires only for certain file types within a scope:

```markdown
---
paths: ["apps/api/**"]
appliesTo:
  - "**/*.repository.ts"
  - "**/*.repository.spec.ts"
---
```

Combine with `paths:` to layer: package-scope first, then file-pattern-scope.

### Splitting vs tagging

The cheapest concern-filtering today is **split monolithic rule files into smaller files with narrower `appliesTo:`**. Example: a 100-line `api.md` covering Auth, Prisma, Swagger, i18n, Pagination, Testing — split into:

| File | `appliesTo:` |
|:---|:---|
| api-auth.md | `["**/*auth*", "**/*guard*", "**/*.strategy.ts"]` |
| api-prisma.md | `["**/*.repository.ts", "**/prisma/**", "**/*.service.ts"]` |
| api-swagger.md | `["**/*.controller.ts"]` |
| api-i18n.md | `["**/i18n/**"]` |
| api-pagination.md | `["**/*pagination*", "**/*.repository.ts"]` |
| api-testing.md | `["**/test/**", "**/*.spec.ts"]` |

A story touching `tickets.repository.ts` now picks up `api-prisma.md` + `api-pagination.md` instead of all 100 lines.

This pattern uses only the file-level filter axis already shipped — no new code, no new convention.

### Pitfall — rules about producing artifacts

`appliesTo:` filters against `request.touchedFiles`, which is the PRD's `contextFiles` — files the story declares as **input context**, not artifacts the agent will **produce**. A rule about how to write tests cannot use `appliesTo: ["**/*.spec.ts"]`: at the test-writer stage, the spec doesn't exist yet, and the contextFiles list source files (the system under test) instead.

Symptoms: testing rules never load on `tdd-test-writer` / `tdd-implementer`; rectification rules never load when the agent is about to fix a file that hasn't been edited yet.

Fix: **for rules about producing X, don't filter on X**. Either drop `appliesTo:` (always load when `paths:` matches) or filter on the *inputs* the agent reads to produce X — e.g. for a "how to write tests" rule, scope by the source files being tested, not the test files themselves. Drop-`appliesTo:` is usually the right call because the rule is small and the always-on behaviour is what the test-writer/implementer/rectifier all need.

### When file-level isn't enough

Some files legitimately stay monolithic — flat lookup tables (`forbidden-patterns.md`), single-concern files where every line applies. For those, file-level filtering is the right granularity; budget-truncation by `priority:` handles overflow.

If a single rule file has many in-file concerns AND every concern fires on the same file pattern (so `appliesTo:` can't separate them), that's the case for section-level filtering — the open question in [#738 Framing B](https://github.com/nathapp-io/nax/issues/738). Until measurement shows residual bloat after file-level filtering, the cheaper instrument is enough.

## Priority and budget truncation

`rules.budgetTokens` (default 8192) caps how many rule tokens reach the prompt. When the total exceeds the budget, rules drop from the **tail** — sorted by `priority` ascending, then `id` alphabetical. Lower priority survives. ([canonical-loader.ts:305-332](../../src/context/rules/canonical-loader.ts#L305-L332))

Use priority to defend critical rules:

```markdown
---
priority: 30
---

# Forbidden Patterns

These patterns are banned and must not be reintroduced.
```

A `priority: 30` rule survives until the budget is so tight that nothing fits.

The loader emits a warning at 75% of budget (`Canonical rules approaching/exceeding budget`) and another when truncation actually drops content. Both surface in the JSONL log under provider `static-rules`.

## Neutrality linter

The loader rejects files containing agent-specific markers ([canonical-loader.ts:83-96](../../src/context/rules/canonical-loader.ts#L83-L96)):

| Pattern | Why banned |
|:---|:---|
| `<system-reminder>`, `<ide_diagnostics>` | agent-specific XML tags |
| `CLAUDE.md`, `AGENTS.md`, `GEMINI.md` | agent-specific file references |
| `.claude/`, `.codex/`, `.gemini/` | agent-specific directories |
| `the <Word> tool` | agent-specific tool-name phrasing (e.g. "the Read tool") |
| `IMPORTANT:` | shouting style |
| emoji | non-portable formatting |

Lint failure throws `NeutralityLintError` and **blocks all rule loading** — fail-fast, no silent skip.

Per-line allow markers exist for legitimate references (e.g. a rule that has to mention `.claude/` because that's its subject):

```markdown
- Migrate from `.claude/rules/` to `.nax/rules/`.  <!-- nax-rules-allow: agent-directory -->
```

The marker tokens match the `id` column in the banned-pattern list (`agent-directory`, `claude-reference`, `tool-phrasing`, `important-shouting`, `emoji`, `xml-tag`).

## Migration from legacy rules

If your project still uses `CLAUDE.md` or `.claude/rules/`, the engine reads them only when:

```json
{ "context": { "v2": { "rules": { "allowLegacyClaudeMd": true } } } }
```

Legacy mode has **no filtering** — every byte loads for every story, no `paths:`, no `appliesTo:`, no `priority:`. The migration unlocks all three filter axes.

Steps:

1. Run a neutrality scan on existing files:
   ```bash
   grep -nE 'CLAUDE\.md|\.claude/|AGENTS\.md|the [A-Z][A-Za-z]* tool|IMPORTANT:' .claude/rules/*.md
   ```
2. Move each `.md` to `.nax/rules/`, scrubbing or allow-marking any matches.
3. Add frontmatter (`paths:` if monorepo, `appliesTo:` for file-pattern scoping, `priority:` for must-have rules).
4. Verify with one story manifest (see Debugging).
5. Set `allowLegacyClaudeMd: false` and delete `.claude/rules/`.

## Debugging

Inspect what actually shipped to a story:

```
<projectDir>/.nax/<feature>/contexts/<storyId>-<stage>.json
```

The `manifest` lists every chunk; rule chunks have `kind: "static"` and `id: "static-rules:<ruleId>:<hash>"`.

Check the JSONL log for the loader warnings:

```bash
grep -E '"provider":"static-rules"' <runLog>.jsonl | jq .
```

Useful events:

| Event message | Meaning |
|:---|:---|
| `Loaded canonical rules` | Lists `files: [...]` actually included |
| `Package-scope filter applied to repo-level rules` | `paths:` filter dropped some — `total: N matched: M` |
| `Canonical rules found but none apply to this package context` | Filter eliminated everything — empty rules in this story |
| `Canonical rules approaching/exceeding budget` | At 75% of `rules.budgetTokens` |
| `Canonical rules truncated by static rules budget` | Tail truncation occurred — `droppedCount: N` |

## Reference

- Provider: [src/context/engine/providers/static-rules.ts](../../src/context/engine/providers/static-rules.ts)
- Loader: [src/context/rules/canonical-loader.ts](../../src/context/rules/canonical-loader.ts)
- Spec: [docs/specs/SPEC-context-engine-canonical-rules.md](../specs/SPEC-context-engine-canonical-rules.md)
- Engine guide: [docs/guides/context-engine.md](./context-engine.md)
