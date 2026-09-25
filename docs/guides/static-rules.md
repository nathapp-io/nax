# Static Rules Guide

> Authoring and tuning canonical rules for the Context Engine. For the design rationale see [SPEC-context-engine-canonical-rules.md](../specs/SPEC-context-engine-canonical-rules.md). For how rules fit into the broader assembly pipeline see [context-engine.md](./context-engine.md).

## What static rules are

Static rules are short, project-specific guidance that the Context Engine prepends to every agent prompt — coding standards, forbidden patterns, error-handling conventions, testing rules. They are agent-agnostic by design (no `CLAUDE.md`, no `<system-reminder>`, no "the X tool" phrasing) so a fallback agent reads the same guidance as the primary.

The provider that loads them is `StaticRulesProvider` ([src/context/engine/providers/static-rules.ts](../../src/context/engine/providers/static-rules.ts)). Every chunk it emits is a budget-floor chunk — included regardless of stage budget pressure (subject only to the rules-specific budget). Each rule is split into its `## ` (H2) sections, and each section becomes its own chunk.

## Where rules live

```
<repoRoot>/.nax/rules/<name>.md            ← repo-level rules
<packageDir>/.nax/rules/<name>.md          ← per-package overlay (monorepo only, e.g. apps/api/.nax/rules/)
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
| `paths` | string \| string[] | none | Globs against the story's package-relative workdir (`request.storyWorkdir`). Rule loads only when the **package** matches. Always-true in single-package repos. |
| `appliesTo` | string[] | none | Globs against `request.scopeFiles` (see below). Rule loads only when the story touches a matching file. Must be a list. |
| `stages` | string[] | none | Pipeline stages the rule applies to (e.g. `single-session`, `tdd-test-writer`, `review-semantic`). Rule loads only when `request.stage` is listed. Unknown stage names warn but do not reject the rule. |
| `description` | string | none | Free-text label; not used for filtering. |

Any other key rejects the file (`RULES_FRONTMATTER_INVALID`, logged as `Invalid rule frontmatter — skipping file`). Frontmatter preceded by a BOM, a blank line, or an HTML comment is warned about as *displaced*; an HTML-comment-displaced block is not honored. `nax rules lint` checks a store without running a story.

Body must pass the neutrality linter — see below.

## How filtering actually works

Three filter axes apply in order, all inside `StaticRulesProvider.fetch`:

1. **`paths:` (package-scope)** — drops the rule if the story's package-relative workdir doesn't match (`ruleMatchesPackage` in [scope-path-match.ts](../../src/context/engine/scope-path-match.ts)).
2. **`stages:`** — drops the rule if the current stage isn't listed.
3. **`appliesTo:` (scope files)** — drops the rule if no entry of `request.scopeFiles` matches (`ruleMatchesScopeFiles`).

Then a section-level token budget pass (see [Priority and budget truncation](#priority-and-budget-truncation)).

### The empty-list short-circuit

```typescript
export function ruleMatchesScopeFiles(appliesTo, scopeFiles): boolean {
  if (!appliesTo || appliesTo.length === 0) return true;
  if (!scopeFiles || scopeFiles.length === 0) return true;  // ← key
  // ... literal = exact match, glob = regex match
}
```

If a story's scope-file set is empty, `appliesTo:` filtering is bypassed — every `appliesTo:`-tagged rule loads anyway. This is conservative-by-default: don't drop a potentially-needed rule when there is no evidence of what the story touches. It is not silent: the provider logs `appliesTo rules admitted unconditionally — scope-file set is empty` and records `appliesToInertCount` in the manifest's scoping report.

`paths:` has no equivalent short-circuit — package always resolves.

## Where `request.scopeFiles` comes from

`scopeFiles` is resolved by `resolveScopeFiles(ctx)` ([src/pipeline/scope-files.ts](../../src/pipeline/scope-files.ts)) as the deduped union of:

- the PRD's `contextFiles` (legacy `relevantFiles`) — `getContextFiles(story)`
- the PRD's `expectedFiles` — `getExpectedFiles(story)`
- the story's git diff against its base ref (`collectDiffFileList`), when the ref resolves

Declared files are re-spelled repo-rooted (ADR-032); diff files already are. If the ref cannot be resolved or the diff fails, the declared sources alone are used. So `appliesTo:` matches **planner intent plus what the story has already changed** — for a brand-new story with no declared files and no diff yet, the set is empty and the short-circuit above applies.

`scopeFiles` is used only for scoping decisions. Content-fetching providers (`code-neighbor`, `git-history`, `test-coverage`) read the separate `request.touchedFiles`, which is the PRD's `contextFiles`.

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

### `appliesTo:` literals in a monorepo are framed automatically

Write an `appliesTo:` literal (no glob metacharacters) package-relative, the same
way you'd write it inside that package's own tree — e.g.
`appliesTo: ["src/session/session-keeper.ts"]` for a rule that targets exactly
`apps/api/src/session/session-keeper.ts`. The Context Engine re-spells it into
the repo-rooted frame (`apps/api/src/session/session-keeper.ts`) before matching
against `scopeFiles`/the diff, using the story's declared workdir. This applies
to **both** package-level rules (`apps/api/.nax/rules/foo.md`) and repo-level
rules scoped with `paths:` to one package (nax#2113) — a repo-level rule with a
bare package-relative literal is not silently dropped in a monorepo.

Framing only re-spells literals; an authored glob (anything containing `*`,
`?`, `[`, or `{`) is left untouched, so `appliesTo: ["src/agents/**"]` already
matches any package's `src/agents/` directory without needing a repo-rooted
spelling. Framing a literal is exact-match (`===`) after re-spelling, so it can
match at most one file in one package — it cannot reach a same-named file in a
sibling package (the failure mode nax#2091 fixed stays fixed).

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

`appliesTo:` filters against files the story already touches, not artifacts the agent will **produce**. At the test-writer stage the spec doesn't exist yet, so a concrete scope file can't match `**/*.spec.ts`.

Stages that author tests (`tdd-test-writer`, `single-session`, `tdd-simple`, `batch`) have a narrow exception (nax#2060): a rule is also admitted when its `appliesTo:` pattern itself denotes a test location — a test-file-shaped glob such as `**/*.test.ts`, or one rooted at a well-known test directory such as `test/**`. When the `appliesTo:` filter drops every rule that named the current stage in `stages:`, the provider warns `appliesTo filter dropped every rule that named this stage explicitly`.

Outside those stages the pitfall stands — e.g. rectification rules never load when the agent is about to fix a file that hasn't been edited yet.

Fix: **for rules about producing X, don't filter on X**. Either drop `appliesTo:` (always load when `paths:` matches) or filter on the *inputs* the agent reads to produce X — e.g. for a "how to write tests" rule, scope by the source files being tested, not the test files themselves. Drop-`appliesTo:` is usually the right call because the rule is small and the always-on behaviour is what the test-writer/implementer/rectifier all need.

### When file-level isn't enough

Some files legitimately stay monolithic — flat lookup tables (`forbidden-patterns.md`), single-concern files where every line applies. For those, file-level filtering is the right granularity; budget-truncation by `priority:` handles overflow.

If a single rule file has many in-file concerns AND every concern fires on the same file pattern (so `appliesTo:` can't separate them), that's the case for section-level filtering — the open question in [#738 Framing B](https://github.com/nathapp-io/nax/issues/738). Until measurement shows residual bloat after file-level filtering, the cheaper instrument is enough.

## Priority and budget truncation

The rules budget is per stage: `min(rulesShare × stage budgetTokens, rules.budgetTokens)`, from `context.v2.rules`:

| Key | Default | Effect |
|:---|:---|:---|
| `budgetTokens` | `8192` (min 512) | Absolute ceiling on rule tokens |
| `rulesShare` | `0.4` | Share of the stage's `budgetTokens` reserved for rules |
| `enforceBudget` | `true` | When `false`, every rule is kept and the overage is only reported (`budgetPressure`) |

Budgeting works on H2 sections, sorted by `priority` ascending, then by rule, then by section order within the rule. Each rule contributes its longest leading run of sections that fits; the first section that doesn't fit closes that rule, and the walk continues with the next rule. Lower priority number survives. When sections are dropped, a standalone notice chunk lists what was cut. ([rule-budget/index.ts](../../src/context/rules/rule-budget/index.ts))

Use priority to defend critical rules:

```markdown
---
priority: 30
---

# Forbidden Patterns

These patterns are banned and must not be reintroduced.
```

A `priority: 30` rule survives until the budget is so tight that nothing fits.

The provider emits a warning at 75% of budget (`Canonical rules are approaching/exceeding static rules budget`) and another when truncation drops sections (`Rule sections truncated by static rules budget`). Both surface in the JSONL log under stage `static-rules`.

## Neutrality linter

The loader rejects files containing agent-specific markers ([canonical-loader/index.ts](../../src/context/rules/canonical-loader/index.ts)):

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

The marker tokens match the `id` column in the banned-pattern list (`agent-directory`, `claude-reference`, `codex-reference`, `gemini-reference`, `tool-phrasing`, `important-shouting`, `emoji`, `xml-tag`).

## Migration from legacy rules

If your project still uses `CLAUDE.md`, `.cursorrules`, `AGENTS.md`, or `.claude/rules/`, the engine reads them only when no canonical rules exist and:

```json
{ "context": { "v2": { "rules": { "allowLegacyClaudeMd": true } } } }
```

Legacy mode has **no filtering** — every byte loads for every story, no `paths:`, no `appliesTo:`, no `priority:`. The migration unlocks all three filter axes.

Without the flag and without canonical rules, zero rules load (logged as a warning).

Steps:

1. Run `nax rules migrate` (`--dry-run` to preview, `--force` to overwrite) to draft `.nax/rules/` from `.claude/rules/*.md` with basic neutralization applied — root `CLAUDE.md` is not a migration source, then `nax rules lint` to check what remains. Manually:
   ```bash
   grep -nE 'CLAUDE\.md|\.claude/|AGENTS\.md|the [A-Z][A-Za-z]* tool|IMPORTANT:' .claude/rules/*.md
   ```
2. Scrub or allow-mark any remaining matches.
3. Add frontmatter (`paths:` if monorepo, `appliesTo:` for file-pattern scoping, `priority:` for must-have rules).
4. Verify with one story manifest (see Debugging).
5. Set `allowLegacyClaudeMd: false` and delete `.claude/rules/`.

## Debugging

Inspect what actually shipped to a story:

```
<projectDir>/.nax/features/<featureId>/stories/<storyId>/context-manifest-<stage>.json
```

The `manifest` lists every chunk; rule chunks have `kind: "static"` and `id: "static-rules:<ruleId>:<sectionSlug>:<hash>"`.

Check the JSONL log for the loader warnings:

```bash
grep -E '"provider":"static-rules"' <runLog>.jsonl | jq .
```

Useful events:

| Event message | Meaning |
|:---|:---|
| `Loaded canonical rules` (debug) | Lists `files: [...]` actually included |
| `Package-scope filter applied to repo-level rules` (debug) | `paths:` filter dropped some — `total: N matched: M` |
| `Canonical rules found but none apply to this package context` | `paths:` eliminated everything — empty rules in this story |
| `Every canonical rule was filtered out by stage/appliesTo scoping` | `stages:` / `appliesTo:` eliminated everything |
| `appliesTo rules admitted unconditionally — scope-file set is empty` | Empty-list short-circuit fired |
| `Canonical rules are approaching/exceeding static rules budget` | At 75% of the effective rules budget |
| `Rule sections truncated by static rules budget` | Sections dropped — `droppedCount: N` |

## Reference

- Provider: [src/context/engine/providers/static-rules.ts](../../src/context/engine/providers/static-rules.ts)
- Loader: [src/context/rules/canonical-loader/index.ts](../../src/context/rules/canonical-loader/index.ts)
- Frontmatter parser: [src/context/rules/rules-frontmatter.ts](../../src/context/rules/rules-frontmatter.ts)
- Spec: [docs/specs/SPEC-context-engine-canonical-rules.md](../specs/SPEC-context-engine-canonical-rules.md)
- Engine guide: [docs/guides/context-engine.md](./context-engine.md)
