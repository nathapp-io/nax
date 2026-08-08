# `nax rules export --agent=claude` → `.claude/rules/` (design)

**Date:** 2026-08-03 · **Repo state:** `main` @ `56ffe6f6` · **Origin:** finding 8 of `nax-context-engine-v2-gap-analysis-2026-08-02.md` / issue [#1442](https://github.com/nathapp-io/nax/issues/1442).

## Problem

`rules export --agent=claude` writes `CLAUDE.md` (`src/cli/rules.ts`, `AGENT_SHIM_FILES`), and `nax generate` writes the same file from `.nax/context.md` (`src/context/generator.ts:305`). Both do a whole-file overwrite and neither detects the other's `AUTO-GENERATED` header, so last writer wins.

The collision is a symptom. The cause is that **`CLAUDE.md` is the wrong target for rules**. Claude Code reads `.claude/rules/*.md` natively; `CLAUDE.md` is the *context* file. nax's own model separates context (architecture) from rules (conventions), and the one-shim-file-per-agent mapping collapses that distinction.

Consequence today: the export step was skipped during the #1441 migration, leaving two hand-maintained rule stores with two different consumers —

| Store | Consumer | When |
|:--|:--|:--|
| `.nax/rules/` | nax's context engine (`StaticRulesProvider`) | during `nax run` |
| `.claude/rules/` | Claude Code itself, natively | interactive sessions |

They have **already drifted**. Issue #1442 records them as "byte-identical (verified)"; that is now stale — all 11 files differ, and `test-writing.md`, `test-architecture.md` and `adapter-wiring.md` lost their `paths:` scoping in migration, with `.claude/rules/` holding the only surviving copy.

## Evidence: Claude Code honours `paths:` and loads scoped rules dynamically

Observed directly in a working session on this repo (2026-08-03):

| Rule | Scope in `.claude/rules/` | Loaded? |
|:--|:--|:--|
| `config-patterns`, `error-handling`, `forbidden-patterns`, `monorepo-awareness`, `project-conventions`, `testing-commands` | global | all six, **upfront** |
| `adapter-wiring` | `src/agents/**`, `src/operations/**` | yes — appeared **mid-session**, on editing `src/operations/build-hop-callback.ts` |
| `test-writing`, `test-architecture`, `test-helpers` | `test/**/*.test.ts` | never loaded (no test file was edited) |

So path scoping is a live, working capability, and any design must preserve it. This is also what makes the duplication tolerable: only the ~6 global rules load unconditionally.

## Approach

`rules export --agent=claude` regenerates `.claude/rules/*.md` — one file per canonical rule — from `.nax/rules/`, carrying frontmatter through, and stops writing `CLAUDE.md` entirely. `nax generate` keeps `CLAUDE.md`. The collision disappears because the two commands no longer share a target.

### Regenerate, not reference — and why

The considered alternative was a thin shim: keep `paths:` frontmatter in `.claude/rules/<name>.md` and make the body `@../../.nax/rules/<name>.md`, giving zero duplication with scoping intact. Rejected:

- **It does not remove the generator.** The shim's `paths:` must mirror the canonical `appliesTo:`, so something still has to generate and maintain the shims. The only saving is bytes.
- **Its failure mode is silent absence.** If `@` does not resolve inside a `.claude/rules/` file, or the relative path stops escaping `.claude/` upward, the file is effectively empty: Claude gets no rules and nothing errors. Regeneration's failure mode is staleness, which is *detectable by diffing*.
- **It depends on undocumented behaviour** — `@` resolution inside a rules file, with an upward relative path, holding across Claude Code updates.
- The scoping we care about **already provably works with plain copies** (evidence above). Reference swaps a working mechanism for an unverified one.

That the silent-absence failure mode mirrors the original migration loss — content quietly disappearing, undetected for weeks — is the deciding argument.

A probe repo exists at `scratchpad/hybrid-probe/` to settle whether the hybrid works at all. It is informational; this design does not depend on the outcome.

### File naming and nested rules

`loadCanonicalRules` globs `**/*.md`, so the canonical store may nest (`.nax/rules/sub/foo.md`). Mapping every rule to `.claude/rules/<basename>.md` would let `sub/foo.md` and `other/foo.md` silently overwrite each other — a collision the existing exporter already has.

Mirror the relative path instead: `.nax/rules/<rel>.md` → `.claude/rules/<rel>.md`, preserving subdirectories. Collisions then become impossible rather than merely unlikely, and the mapping stays obvious to a reader of either directory. If two canonical rules would still map to one target (they cannot, given identical relative paths, but the guard is cheap), fail closed naming both.

### The drift check is load-bearing

Duplication is only safe if divergence cannot go unnoticed. `rules export --agent=claude --check` regenerates into memory and exits non-zero if the result differs from what is on disk, printing the differing files. Without it, this design is the status quo with extra steps.

### Frontmatter translation (the trap that caused the original loss)

The key means different things in each store:

| Key | In `.nax/rules/` | In `.claude/rules/` |
|:--|:--|:--|
| `paths:` | **package** scope, matched against the story's package dir | **file** glob |
| `appliesTo:` | **file** glob, matched against `touchedFiles` | (not used) |
| `priority:` | load ordering / budget truncation order | (not used) |

`nax rules migrate` already translates legacy Claude `paths:` → nax `appliesTo:` (`src/cli/rules.ts:202`, `translateLegacyFrontmatter`), with a docstring explaining exactly why copying the key across verbatim silently produces inert config. **Export must run that translation in reverse:** canonical `appliesTo:` → Claude `paths:`. Canonical `paths:` (package scope) has no Claude equivalent and is dropped, with a warning naming the rule.

Getting this wrong reproduces the original bug in the opposite direction, which is why it is called out here rather than left to the implementer.

> **Superseded by #1503.** Dropping canonical `paths:` was itself the bug: a rule
> using `paths:` with no `appliesTo:` produced no globs, so the frontmatter block
> was omitted entirely and Claude loaded the rule *globally* — the widest possible
> reading of a rule that asked to be narrow. Package scope is now translated to
> the equivalent file glob (`packages/api/*` → `packages/api/**`) rather than
> dropped. The warning survives only for a rule that sets **both** scopes, which
> Claude's single disjunctive `paths:` list cannot express as an intersection.

## Sequencing constraint (hard)

**This must not ship before US-004 of `context-budget-truth` lands.** That story restores `appliesTo:` on the three files that lost scoping. Today `.nax/rules/` has no scoping for them and `.claude/rules/` holds the only copy — so exporting now would overwrite the survivors with unscoped versions and destroy the scoping in both stores at once, silently unscoping rules Claude Code currently honours.

Order: US-004 merges → verify `.nax/rules/` carries `appliesTo:` → then export.

## Out of Scope

- `--agent=codex` / `--agent=gemini` (`AGENTS.md` / `GEMINI.md`) marker-delimited co-ownership is deferred: those agents are not used here, so the marker mechanism would be unvalidated work. The collision for them remains, unfixed and documented.
- `--agent=cursor` retargeting to `.cursor/rules/*.mdc` is deferred for the same reason, and additionally needs an `.mdc` format translator nobody here can exercise.
- Changing `nax generate` at all. It keeps `CLAUDE.md` and is untouched by this design.
- Deleting `.claude/rules/` or making it gitignored. It stays tracked, so the drift check has something to compare against and a fresh clone works without running export first.
- Any drift detection *between* `nax generate` and `rules export`. With targets separated, they no longer contend.
- Wiring `rules export --check` into CI. This design adds the flag; adopting it in a pipeline is a repo decision.

## Failure Handling

| Condition | Behaviour |
|:--|:--|
| Canonical store empty | Fail closed — existing `RULES_EXPORT_NO_CANONICAL_RULES` behaviour, unchanged |
| A canonical rule declares `paths:` (package scope) | Fail open — drop the key, warn naming the rule file, since Claude has no package-scope concept |
| `.claude/rules/` contains a file with no canonical counterpart | Fail open — leave it untouched and warn. Export owns the files it generates, not the directory; deleting hand-written rules would be destructive |
| `--check` finds a difference | Exit non-zero, listing each differing file |
| `--dry-run` | Report every path that would be written, write nothing (existing behaviour) |

## Risks

- **Duplication is real.** ~66KB mirrored in git. Accepted, bounded by the drift check.
- **Someone edits the generated copy.** Mitigated by the `AUTO-GENERATED` header naming the source, and caught by `--check`.
- **The reverse translation is another chance to lose scoping.** Mitigated by an explicit round-trip test: migrate a Claude rule to canonical, export it back, assert the file glob survives both hops.
- **`.claude/rules/` files this design does not generate are left in place**, so a stale hand-written rule could linger. Warned, not deleted — deletion is the more dangerous default.
