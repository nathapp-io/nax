# Canonical rule `description:` — design

**Date:** 2026-08-08
**Status:** approved, not implemented
**Touches:** `src/context/rules/rules-frontmatter.ts`, `src/context/rules/canonical-loader.ts`, `src/cli/rules.ts`

## Problem

`.nax/rules/*.md` frontmatter recognises exactly four keys:

```ts
export const KNOWN_FRONTMATTER_KEYS = new Set(["priority", "paths", "appliesTo", "stages"]);
```

An unknown key is a **hard error**, not a warning. So a canonical rule cannot say what it is for, and `CanonicalRule` has no field to carry it.

This is not only a missing feature. `nax rules migrate` translates `paths:` → `appliesTo:` and copies every other key through verbatim, so a legacy Claude rule carrying `description:` migrates cleanly and then breaks every subsequent load. Reproduced end to end:

```
$ nax rules migrate --dir <tmp>
Migration complete: 1 file(s) written, 0 skipped.

$ nax rules lint --dir <tmp>
Error: Canonical rule frontmatter declares unknown key(s): description.
Only priority, paths, appliesTo, and stages are recognised.
```

`migrate` produces a store nax itself refuses to read. Fixing that is the floor for this work.

## Decisions

Settled during brainstorming; recorded so they are not silently revisited.

| Question | Decision |
|:--|:--|
| What does it do? | Round-trips (migrate → canonical → export) **and** surfaces in nax |
| Required? | **Optional.** No lint warning when absent — existing rules across all repos need no edits |
| Where does it surface? | The **rules-export warning** that names a rule |
| Value shape | **Single line.** Trimmed; a newline is a parse error |
| Serialization | `JSON.stringify`, matching how globs are already emitted |
| Curator | **Out of scope** — see below |
| `rules lint` output | **Out of scope** — the "no nagging" decision |
| Injected into agent context | **Out of scope** — costs budget on every run; rules already carry headings |

### Why the curator is out of scope

The curator has no access to canonical rules: no `loadCanonicalRules`, no `CanonicalRule` import anywhere under `src/plugins/builtin/curator/`. Every proposal targets one fixed path, `.nax/rules/curator-suggestions.md`, so it has no notion of *which* rule it is discussing and nothing whose description it could show. `Proposal.description` also already exists and means the proposal's own text, so the name would collide. Giving the curator rule-awareness is a separate piece of work.

## Design

### Parsing — `rules-frontmatter.ts`

Add `"description"` to `KNOWN_FRONTMATTER_KEYS`, and parse it beside `paths`:

- not a string → `frontmatter.description must be a string`
- empty after trim → `frontmatter.description cannot be empty`
- contains `\n` or `\r` → `frontmatter.description must be a single line`

All three are `RulesFrontmatterError`, which carries the file path. Stored trimmed on `ParsedFrontmatter.description?: string`.

The unknown-key error message currently ends *"Only priority, paths, appliesTo, and stages are recognised."* That string is user-facing guidance, so it must gain `description` in the same change — a stale version of it would actively misdirect someone hitting the error.

### Carrying — the type, then the construction site

`CanonicalRule` is **defined in `rules-frontmatter.ts:64`** and only re-exported from `canonical-loader.ts:33`, so the field is added to the former. The rule object is *built* in `canonical-loader.ts` (~line 435), where `description` is threaded through beside `paths` using the same conditional-spread form.

### Export — `claudeFrontmatter` in `cli/rules.ts`

Emit `description` **before** `paths`, quoted:

```yaml
---
description: "Use when editing OAuth controllers"
paths:
  - "packages/nestjs-oauth/**"
---
```

The early return generalises. It is currently:

> no globs ⇒ return `""`

and becomes:

> nothing to emit ⇒ return `""`

A rule with a description and no scope emits a block containing only `description:`. A rule with neither still emits nothing, so the existing test covering the unscoped case stays valid — the condition it guards is being widened, not replaced.

`JSON.stringify` is what makes a value containing `:`, `#`, a quote, or a backslash safe. Emitting it raw would produce a generated file Claude cannot parse — the same failure shape as #1503, surfacing far from its cause.

### Surfacing — export warning

The both-scopes warning (`Dropping package scope — Claude cannot express both scopes`) gains the rule's description in its data, so the message says what is at stake rather than only naming a file.

The orphan-file warning (`Generated rules dir contains a file with no canonical source`) does **not**. It fires precisely because there is no canonical rule behind that file, so no description exists to show.

### Migration — `translateLegacyFrontmatter`

**No code change.** It already copies `description` through; the path was broken only because the loader rejected the result. This design fixes it by making the result loadable, and pins that with a regression test.

## Testing

| Area | Cases |
|:--|:--|
| Parse | accepts a description; trims surrounding whitespace; rejects non-string, empty/whitespace-only, and multi-line |
| Error text | the unknown-key message lists `description` |
| Export | description alone ⇒ block with only `description:`; description + `appliesTo`; description + `paths`; neither ⇒ no block at all |
| Serialization | values containing `:`, `#`, `"`, `\` survive the round trip and re-parse as YAML |
| Warning | the both-scopes warning carries the description |
| Regression | `migrate` → `loadCanonicalRules` succeeds on a legacy rule with `description:` — the exact sequence that fails today |

Each new behaviour gets a negative control: reverting the specific line must fail that test and no other.

## File-size constraints

Measured before sizing, because two files are near their hard limits:

| File | Lines | Limit | Headroom |
|:--|--:|--:|--:|
| `src/cli/rules.ts` | 572 | 600 | **28** |
| `test/unit/cli/rules.test.ts` | 753 | 800 | **47** |
| `test/unit/context/rules/rules-frontmatter.test.ts` | 687 | 800 | 113 |
| `src/context/rules/canonical-loader.ts` | 487 | 600 | 113 |
| `src/context/rules/rules-frontmatter.ts` | 256 | 600 | 344 |

Consequences:

- Export changes in `cli/rules.ts` must stay under ~28 added lines. If the frontmatter builder grows past that, extract it to its own module rather than letting the file breach.
- New export tests go in `test/unit/cli/rules-export-scope.test.ts` (129 lines), **not** `rules.test.ts`.
- Parse tests go in `rules-frontmatter.test.ts`, which has room.

## Out of scope

- Making `description` required, or warning when it is absent
- `rules lint` printing descriptions
- Curator rule-awareness
- Injecting descriptions into agent context
- Descriptions for the non-Claude shim agents (codex/gemini/cursor) — they receive one concatenated file, with no per-rule frontmatter to carry a description
- `rule-sections.ts` — budget chunking does not need the field
