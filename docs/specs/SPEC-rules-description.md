# SPEC: Canonical rule `description:`

<!-- spec-writing: completed-through-phase-6 -->

## Summary

Add an optional single-line `description:` key to canonical rule frontmatter (`.nax/rules/*.md`). The value is parsed and validated by the canonical loader, carried on `CanonicalRule`, emitted into the generated Claude rules frontmatter by `nax rules export --agent=claude`, and included in the export warning that names a rule. A rule can finally state what it is for, and the existing `nax rules migrate` path stops producing a store the loader rejects.

## Motivation

Canonical frontmatter recognises exactly four keys:

```ts
export const KNOWN_FRONTMATTER_KEYS = new Set(["priority", "paths", "appliesTo", "stages"]);
```

An unrecognised key is a **hard error**, not a warning, and `CanonicalRule` has no field to carry one. So a rule cannot describe its own purpose.

This is not only a missing feature. `nax rules migrate` translates `paths:` → `appliesTo:` and copies every other key through verbatim, so a legacy Claude rule carrying `description:` migrates cleanly and then breaks every subsequent load. Reproduced end to end against a temp repo:

```
$ nax rules migrate --dir <tmp>
Migration complete: 1 file(s) written, 0 skipped.

$ nax rules lint --dir <tmp>
Error: Canonical rule frontmatter declares unknown key(s): description.
Only priority, paths, appliesTo, and stages are recognised.
```

`migrate` writes a store nax itself refuses to read. Making that sequence succeed is the floor for this work.

## Design

Optional field, no behaviour change for rules that omit it. Single-line values only, trimmed. Serialized on export with `JSON.stringify`, matching how globs are already emitted, so a value containing `:`, `#`, a quote, or a backslash cannot produce a generated file Claude fails to parse.

### Integration

Verified symbols and their real locations:

| Symbol | Location | Change |
|:--|:--|:--|
| `KNOWN_FRONTMATTER_KEYS` | `src/context/rules/rules-frontmatter.ts:17` | add `"description"` |
| `ParsedFrontmatter` | `src/context/rules/rules-frontmatter.ts:77` | add `description?: string` |
| `CanonicalRule` | `src/context/rules/rules-frontmatter.ts:64` | add `description?: string` |
| `parseFrontmatter` final return | `src/context/rules/rules-frontmatter.ts:248` | conditional-spread `description` |
| unknown-key error text | `src/context/rules/rules-frontmatter.ts:185` | list `description` among recognised keys |
| rule object construction | `src/context/rules/canonical-loader.ts:~435` | conditional-spread `description` |
| `claudeFrontmatter` | `src/cli/rules.ts:174` | emit `description`, generalise the empty-block guard |
| both-scopes warning | `src/cli/rules.ts:~183` | add `description` to the warn data |

`CanonicalRule` is **defined** in `rules-frontmatter.ts` and only *re-exported* from `canonical-loader.ts:33` — the type edit belongs in the former.

Patterns to mirror: `paths` and `appliesTo` parsing already establish the validate-then-trim-then-conditional-spread shape and the `RulesFrontmatterError(message, filePath)` error form. `claudeFrontmatter` already uses `JSON.stringify` for glob values with a comment explaining why.

`translateLegacyFrontmatter` needs **no change** — it already copies `description` through; that path was broken only because the loader rejected the result.

### File Format

Canonical rule frontmatter, all supported keys:

```yaml
---
description: "Use when editing OAuth controllers"
priority: 55
appliesTo:
  - "src/**/*.ts"
paths:
  - "packages/nestjs-oauth/*"
stages:
  - "execution"
---
```

Generated Claude rule frontmatter — `description` first, then `paths`:

```yaml
---
description: "Use when editing OAuth controllers"
paths:
  - "src/**/*.ts"
---
```

### Failure Handling

| Condition | Behaviour |
|:--|:--|
| `description` is not a string | `RulesFrontmatterError` — `frontmatter.description must be a string` |
| `description` is empty or whitespace-only | `RulesFrontmatterError` — `frontmatter.description cannot be empty` |
| `description` contains a newline | `RulesFrontmatterError` — `frontmatter.description must be a single line` |
| `description` absent | Field omitted from `CanonicalRule` and from the generated frontmatter; no warning |
| Rule has neither description nor scope | No frontmatter block emitted at all (existing behaviour, preserved) |

### Sizing constraint

`src/cli/rules.ts` is at **572 of the 600-line hard limit**. If the export changes exceed that headroom, extract the frontmatter builder into its own module under `src/cli/` rather than breaching the limit. New export tests belong in `test/unit/cli/rules-export-scope.test.ts` (129 lines), **not** `test/unit/cli/rules.test.ts` (753 of 800).

### No `### Modifies` block

Checked before drafting: no existing test asserts the full unknown-key sentence. `rules-frontmatter.test.ts:71` asserts key *presence* rather than a total, and `:116`/`:259` match only on `"unknown key(s)"` and the offending key name. The two "unscoped rule emits no block" tests pass a rule with neither description nor scope, so they stay valid. No existing closed-world assertion is broken by this spec, so no modification authority is required.

## Out of Scope

- Making `description` required on a canonical rule is out of scope; it stays optional and a rule without one loads exactly as it does today.
- Emitting a `nax rules lint` warning for rules that lack a `description` is out of scope; absence is silent.
- Printing rule descriptions in `nax rules lint` output is out of scope.
- Giving the curator awareness of canonical rules, so its proposals can name and describe the rule they concern, is out of scope; the curator currently loads no rules and every proposal targets the fixed path `.nax/rules/curator-suggestions.md`.
- Injecting a rule's description into the agent context alongside the rule body is out of scope; it would consume token budget on every run.
- Carrying `description` on the shim agents (`codex`, `gemini`, `cursor`) is out of scope; those agents receive one concatenated file with no per-rule frontmatter to hold it.
- Multi-line or paragraph descriptions are out of scope; a newline in the value is a parse error and prose belongs in the rule body.
- Carrying `description` through `rule-sections.ts` budget chunking is out of scope.

## Stories

Two stories, deliberately not merged. US-002 is meaningless without US-001, which would normally force a merge — but the combined AC count is 16, exactly the project's resolved `maxAcCount`, and `nax plan` splits compound ACs atomically, so the merged story would plan to roughly 24 and breach the gate. The split is the narrower of the two evils and follows the module boundary (canonical loader vs CLI export) rather than an arbitrary seam.

**US-001 — Canonical rules accept and carry a description**
Parse, validate, and carry `description` from `.nax/rules/*.md` through `loadCanonicalRules`, and make the previously-fatal migrate sequence succeed.
Depends on: nothing.

### Context Files
- `src/context/rules/rules-frontmatter.ts` — parser, `KNOWN_FRONTMATTER_KEYS`, `ParsedFrontmatter`, `CanonicalRule`; mirror the `paths`/`appliesTo` validation shape
- `src/context/rules/canonical-loader.ts` — rule object construction, conditional-spread pattern
- `src/cli/rules.ts` — `translateLegacyFrontmatter` and `rulesMigrateCommand`, for the migrate regression
- `test/unit/context/rules/rules-frontmatter.test.ts` — existing parse test patterns

**US-002 — The Claude export emits and surfaces the description**
Emit `description` into generated `.claude/rules/*.md` frontmatter and include it in the export warning that names a rule.
Depends on: US-001.

### Context Files
- `src/cli/rules.ts` — `claudeFrontmatter`, the both-scopes warning, `JSON.stringify` glob-quoting precedent
- `src/context/rules/rules-frontmatter.ts` — `CanonicalRule.description`, added by US-001
- `test/unit/cli/rules-export-scope.test.ts` — existing export test harness and dep-injection setup

### Seams

- **US-001 → US-002 (data availability).** US-002's ACs read `CanonicalRule.description`. US-001 declares that field and AC8 asserts `loadCanonicalRules` actually populates it, so the datum US-002 renders is one the producer emits.
- **US-001 → US-002 (production path).** US-002 exercises the field through `rulesExportCommand` — the outermost entry point `nax rules export` reaches — not through `claudeFrontmatter` directly, so the assertion covers the wiring rather than the helper in isolation.

## Acceptance Criteria

### US-001 — Canonical rules accept and carry a description

1. `[unit]` Calling `parseFrontmatter` with frontmatter declaring `description: Use when editing controllers` and a body returns a result whose `description` equals `"Use when editing controllers"`.
2. `[unit]` Calling `parseFrontmatter` with `description:` whose value has leading and trailing spaces returns a `description` with that surrounding whitespace removed.
3. `[unit]` Calling `parseFrontmatter` with a numeric `description` value throws `RulesFrontmatterError` whose message states that `frontmatter.description must be a string`.
4. `[unit]` Calling `parseFrontmatter` with a `description` value that is empty or only whitespace throws `RulesFrontmatterError` whose message states that `frontmatter.description cannot be empty`.
5. `[unit]` Calling `parseFrontmatter` with a `description` value containing a newline throws `RulesFrontmatterError` whose message states that `frontmatter.description must be a single line`.
6. `[unit]` Calling `parseFrontmatter` with an unrecognised key such as `scope` still throws `RulesFrontmatterError`, and the message names `description` among the recognised keys.
7. `[unit]` Calling `parseFrontmatter` on frontmatter with no `description` key returns a result whose `description` is absent, and no error is thrown.
8. `[integration]` Loading a canonical rules directory containing a rule that declares `description:` via `loadCanonicalRules` returns a `CanonicalRule` whose `description` equals the declared value.
9. `[integration]` Running the rules migrate command against a project whose `.claude/rules/` holds a rule declaring both `description:` and `paths:`, then loading the resulting `.nax/rules/` with `loadCanonicalRules`, completes without throwing and yields a rule whose `description` equals the original value.

### US-002 — The Claude export emits and surfaces the description

1. `[integration]` Running the rules export command for the `claude` agent on a canonical rule that declares both a `description` and an `appliesTo` glob writes a file whose frontmatter contains a `description` entry with the declared text, positioned before the `paths` entry.
2. `[integration]` Running the rules export command for the `claude` agent on a canonical rule that declares a `description` and no scope of any kind writes a file that begins with a frontmatter block containing the `description` entry and containing no `paths` entry.
3. `[integration]` Running the rules export command for the `claude` agent on a canonical rule that declares a `description` and a canonical package scope writes a file whose frontmatter contains both the `description` entry and the package scope translated to its file glob.
4. `[integration]` Running the rules export command for the `claude` agent on a canonical rule that declares neither a description nor any scope writes a file that does not begin with a frontmatter block.
5. `[integration]` Running the rules export command for the `claude` agent on a canonical rule whose `description` contains a colon, a hash, a double quote, and a backslash writes a file whose frontmatter parses as valid YAML and whose `description` value equals the original text exactly.
6. `[integration]` Running the rules export command for the `claude` agent on a canonical rule that declares an `appliesTo` glob, a canonical package scope, and a `description` emits the package-scope warning, and the warning's structured data includes that description.
7. `[integration]` Running the rules export command for the `claude` agent on a canonical rule that declares an `appliesTo` glob and no description writes a file whose frontmatter contains no `description` entry.
