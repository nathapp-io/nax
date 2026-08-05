# SPEC: Rules lint warnings for inert `paths:` and comment-displaced frontmatter

## Summary

`nax rules lint` gains two advisory warnings for canonical rule stores left in a
silently-degraded state by pre-#1441 `nax rules migrate` runs: a `paths:` block that
cannot filter anything in a single-package repo, and a frontmatter block pushed out of
parse position by a leading HTML comment (the "review notice" the old migrator emitted).
Both failures currently look correct — the operator sees scoped-looking rules and a
passing lint, with no signal that the scoping never applied or that the declared priority
is being ignored. Both new signals are **warnings only**: the parse result, the lint exit
code, and every existing behaviour stay exactly as they are.

## Motivation

Before #1441, `migrate` copied a legacy `paths:` key verbatim. `paths:` is a **file** glob
in a per-agent rules directory but **package** scope in nax, and `ruleMatchesPackage`
(`src/context/engine/providers/static-rules.ts:183`) short-circuits on
`packageDir === repoRoot`. In any single-package repo every migrated `paths:` block is
therefore inert. Six landed in this repo and were caught only by reading the resolver.

The same era of `migrate` emitted its review notice *before* the frontmatter. Frontmatter
is recognised only at byte 0, so the whole block — priority included — is dropped.
Verified against the current parser:

| Input | `priority` | `paths` | `warnings` |
|:---|:---|:---|:---|
| `<!-- reviewed -->` then `---` block declaring `priority: 90` | **100** (default) | **undefined** | **`[]`** |
| blank line then `---` block declaring `priority: 90` | 90 | — | 1 warning |
| `---` block at byte 0 declaring `priority: 90` | 90 | `["src/**"]` | `[]` |

The middle row is the shipped AC10/AC11 displacement detection from rule-scoping (#1463);
it covers a UTF-8 BOM and leading blank lines only. The HTML-comment case — the one the
old migrator actually produced — falls through both checks: the entire frontmatter is
silently discarded **and no warning is emitted at all**. A dropped `priority` also changes
which rules survive budget truncation, so this is not cosmetic.

## Design

### Approach

Both checks are **deterministic string and list inspections** — no LLM call, no AST parse.
The displacement check is a leading-HTML-comment test in the existing parser; the inert
check is an emptiness test on the resolved workspace package list. Neither reads file
content beyond what the loader already parses.

**The displacement check must mirror the existing BOM/blank-line precedent exactly: strip
one or more leading HTML comments (and surrounding whitespace) from the front, then require
the *remaining* content to start with `---`.** It must **not** scan for a `---` occurring
anywhere later in the file. Markdown horizontal rules are common in rule bodies — 6 of the
11 files in this repo's own `.nax/rules/` store contain one — so an "is there a `---`
somewhere after the comment" test would fire a false warning on every comment-led rule file
that happens to use one. A false "your frontmatter is broken" warning is the one outcome
this feature must not produce.

### Integration

Verified symbols and signatures (read at authoring time):

| Symbol | Location | Role |
|:---|:---|:---|
| `parseFrontmatter(raw: string, filePath: string): ParsedFrontmatter` | `src/context/rules/rules-frontmatter.ts:90` | Extended by US-001 |
| `displacedReason` / `warnings` locals | same, lines 92-108 | BOM (`:96`) and blank-line (`:102`) displacement precedent to mirror |
| `FRONTMATTER_PRIORITY_DEFAULT = 100` | same, `:18` | The default a displaced file falls back to |
| `ParsedFrontmatter.warnings: string[]` | same, `:83` | Carries the new warning |
| `loadCanonicalRules` | `src/context/rules/canonical-loader.ts:420,440` | Propagates `parsed.warnings` onto the loaded rule |
| `rulesLintCommand(options, deps)` | `src/cli/rules-lint.ts:107` | Extended by US-002 |
| re-emit loop over `rule.warnings` | same, `:121` | **Already exists** — US-001's warning reaches lint through it with no new wiring |
| `_rulesLintDeps` | same, `:28` | DI seam; the new resolver dep is registered here |
| `discoverWorkspacePackages(workdir): Promise<string[]>` | `src/test-runners/detect/workspace.ts:205`, barrel-exported at `src/test-runners/index.ts:38` | Repo-shape SSOT for the inert check |
| `ruleMatchesPackage(paths, repoRoot, packageDir)` | `src/context/engine/providers/static-rules.ts:183` | The short-circuit that makes `paths:` inert |

**Repo-shape detection must go through `discoverWorkspacePackages`.**
`.nax/rules/monorepo-awareness.md` §5 makes it the single resolver for "what packages does
this repo have?" — a hand-rolled `package.json`/`pnpm-workspace.yaml` marker check would
violate that rule and duplicate detector logic. Confirmed empirically: it returns `[]` for
this repo. The inert predicate is therefore **`(await discoverWorkspacePackages(root)).length === 0`**.

Register it on `_rulesLintDeps` so tests stub repo shape rather than building fixture
workspaces — this is what makes US-002's monorepo and rejection ACs testable.

### CLI Behavior

- **Exit 0** in all warning cases. `rulesLintCommand` never sets `process.exitCode`; this
  feature does not change that. Warnings must not become errors.
- **Warnings** are emitted via `logger.warn("rules-lint", …)` with structured fields, matching
  the two existing warning sites. Do not add new `console.log` calls (banned in `src/` by
  `project-conventions.md`).
- **stdout** keeps its single existing summary line, with the new warnings folded into the count:
  `[WARN] Canonical rules lint completed with N warning(s) (M file(s) across <scope>)`, or
  `[OK] Canonical rules lint passed (M file(s) across <scope>)` when the count is zero.

### Failure Handling

| Condition | Behaviour |
|:---|:---|
| `discoverWorkspacePackages` rejects | **Fail-open** — skip the inert-`paths:` check entirely, emit no warning for it, and let lint complete with its summary line. A false "your scoping is broken" warning is worse than a missing one. |
| Rule file has an HTML comment but no `---` block anywhere | No warning — this is an ordinary un-frontmattered rule file, not a displacement. |
| Rule file throws `RulesFrontmatterError` (missing closing `---`) | Unchanged from today; out of scope. |

### File size budget

All four files are well inside the limits (`project-conventions.md`: 600 source / 800 test),
measured before sizing:

| File | Lines | Limit |
|:---|:---|:---|
| `src/context/rules/rules-frontmatter.ts` | 212 | 600 |
| `src/cli/rules-lint.ts` | 148 | 600 |
| `test/unit/context/rules/rules-frontmatter.test.ts` | 547 | 800 |
| `test/unit/cli/rules-lint.test.ts` | 344 | 800 |

Lint tests belong in `test/unit/cli/rules-lint.test.ts` (344). Do **not** add them to
`test/unit/cli/rules.test.ts`, which is at 747 of its 800-line limit.

## Out of Scope

- `nax rules migrate --repair`, or any in-place rewriting of inert `paths:` blocks or displaced frontmatter.
- Changing the parse result for comment-displaced frontmatter — the declared `priority`, `paths`, and `appliesTo` remain unhonored, and the file continues to resolve to `FRONTMATTER_PRIORITY_DEFAULT`.
- Turning either new signal into a lint error, or changing any `nax rules lint` exit code.
- Detecting frontmatter displaced by leading content other than an HTML comment, a UTF-8 BOM, or blank lines.
- Deprecating, removing, or migrating the `paths:` frontmatter key itself.
- Warning about `paths:` in a workspace monorepo, where `paths:` filters correctly.
- Warning about inert `appliesTo:` globs, which `rules-lint.ts:129` already covers.
- Changing how a rule file with a malformed frontmatter block (missing its closing `---`) is handled; `RulesFrontmatterError` keeps its current behaviour.

## Stories

1. **US-001: Parser detects comment-displaced frontmatter** — no dependencies
2. **US-002: Lint warns on inert `paths:` and surfaces displacement** — depends on US-001

### Context Files

**US-001**
- `src/context/rules/rules-frontmatter.ts` — the parser being extended; mirror the BOM/blank-line displacement pattern at lines 96-108
- `test/unit/context/rules/rules-frontmatter.test.ts` — existing parser test patterns
- `src/context/rules/canonical-loader.ts` — propagates `parsed.warnings` onto the loaded rule (`:440`)
- `test/unit/context/rules/canonical-loader.test.ts` — `[AC13]` at `:412` is the real-disk loader test to mirror for the comment case

**US-002**
- `src/cli/rules-lint.ts` — the lint command and its `_rulesLintDeps` DI seam
- `src/test-runners/detect/workspace.ts` — `discoverWorkspacePackages`, the repo-shape SSOT
- `src/context/rules/canonical-loader.ts` — how `warnings` and `paths` reach the lint command
- `test/unit/cli/rules-lint.test.ts` — existing lint test patterns and dep-stubbing style

### Creates

None — both stories extend existing files.

### Seams

- **US-001 → US-002 (displacement warning).** US-001 pushes a new entry into
  `ParsedFrontmatter.warnings`; `rulesLintCommand` already re-emits every `rule.warnings`
  entry at `src/cli/rules-lint.ts:121`, and `loadCanonicalRules` already propagates them
  (`canonical-loader.ts:440`). The path was verified to exist end-to-end at authoring time,
  so US-002 wires nothing new — US-002 AC1 is the seam test that proves the warning
  actually surfaces through the `rulesLintCommand` entry point rather than only inside the
  parser.

## Acceptance Criteria

### US-001: Parser detects comment-displaced frontmatter

- [unit] `parseFrontmatter` given content whose first line is an HTML comment immediately followed by a `---` frontmatter block returns a `warnings` array containing an entry stating the frontmatter is displaced and quoting the `filePath` argument.
- [unit] For that same input, the returned `priority` equals `FRONTMATTER_PRIORITY_DEFAULT` — the block's declared `priority: 90` is still not honored.
- [unit] For that same input, the returned `paths` is undefined.
- [unit] For that same input, the returned `appliesTo` is undefined.
- [unit] `parseFrontmatter` given content beginning with an HTML comment that spans several lines, followed by a `---` block, returns a `warnings` entry stating the frontmatter is displaced.
- [unit] `parseFrontmatter` given content beginning with an HTML comment and containing no `---` block anywhere returns an empty `warnings` array.
- [unit] `parseFrontmatter` given content beginning with an HTML comment followed by ordinary prose and then a `---` markdown horizontal rule later in the body returns an empty `warnings` array.
- [unit] `parseFrontmatter` given content beginning with a blank line, then an HTML comment, then a `---` block returns exactly one `warnings` entry.
- [unit] `parseFrontmatter` given a `---` frontmatter block starting at byte 0 returns an empty `warnings` array.
- [integration] `loadCanonicalRules` reading a rule store containing a file whose frontmatter is preceded by an HTML comment returns a rule whose `warnings` include the displaced-frontmatter entry.

### US-002: Lint warns on inert `paths:` and surfaces displacement

- [cli] `rulesLintCommand` run over a rule store containing a file whose frontmatter is preceded by an HTML comment emits a `rules-lint` warning whose message includes the parser's displaced-frontmatter text.
- [cli] `rulesLintCommand` run with `discoverWorkspacePackages` resolving to an empty list, over a store containing a rule that declares `paths:`, emits a warning naming that rule's file path.
- [cli] That inert-`paths:` warning message names `appliesTo` as the alternative to use for file globs.
- [cli] `rulesLintCommand` run with `discoverWorkspacePackages` resolving to a non-empty package list emits no inert-`paths:` warning for a rule that declares `paths:`.
- [cli] `rulesLintCommand` run with `discoverWorkspacePackages` resolving to an empty list emits no inert-`paths:` warning for a rule that declares no `paths:` key.
- [cli] After emitting only warnings, `rulesLintCommand` resolves without setting a non-zero process exit code.
- [cli] An inert-`paths:` warning is included in the count reported by the final `[WARN] Canonical rules lint completed with N warning(s)` summary line.
- [cli] When `discoverWorkspacePackages` rejects with an error, `rulesLintCommand` emits no inert-`paths:` warning.
- [cli] When `discoverWorkspacePackages` rejects with an error, `rulesLintCommand` still emits its final summary line.

<!-- spec-writing: completed-through-phase-6 -->
