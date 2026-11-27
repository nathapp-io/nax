# Gate diagnostic evidence implementation plan

> Execute inline with TDD and a final independent review.

**Goal:** Fix #3064 for language-agnostic lint and typecheck output.

**Design:** Preserve the complete diagnostic body in both generic text-block
parsers. Structured parsers remain metadata enrichers; a failed operation always
includes bounded, redacted output and command guidance, even after partial parsing.
Attach this context once to the first finding so the workflow finding cap cannot
discard it. Keep existing file/location metadata and gate verdicts.

**Scope approved in conversation:** both lint and typecheck; multiline messages,
unknown formats/extensions, partial recognition, and evidence in the fixer prompt.
No new tool-specific parser, dependency, config, or release change.

**Alternatives:** a stylish-specific parser only solves one formatter; replacing
all parsing with raw output loses useful locations. Retain structured metadata and
add evidence independently of parser recognition.

## Tasks

- [x] Add failing parser regressions for path headers and meaningful headers with
  multiline bodies across language extensions; strip marked trailing summaries.
- [x] Update both generic parsers to preserve the body and existing locations.
- [x] Add failing operation tests proving parsed findings retain bounded output,
  redaction, command guidance, metadata, and a single copy of the context.
- [x] Share failure-context attachment between lint/typecheck, retaining the
  existing no-findings sentinel and success/skipped behavior.
- [x] Test real parsing through both operations, workflow gates, and fix prompts
  using multiple diagnostics, unfamiliar paths/extensions, and mixed output.
- [x] Run focused tests, package typecheck/check:all, full tests, and coverage
  when allowed by the environment. Review the diff and address material findings.

## Review focus

- Unknown-extension output must survive even alongside recognised diagnostics.
- Output context must survive the workflow's 25-finding cap.
- Redaction precedes truncation; messages copied from multiline bodies are redacted.
- Empty output still supplies rerun guidance; successful gates remain finding-free.
- Existing single-line formats and structured metadata remain usable.

## Progress

- Branch created: `fix/3064-language-agnostic-gate-diagnostics`.
- Baseline: 53 focused existing tests passed during investigation.
- Reproductions: 14 generic-shape checks confirmed loss in lint and typecheck.
- Ruling: work in the current clean checkout on the requested new branch.

- Parser tests: 13 expected failures before implementation; passing afterward.
- Operation/prompt tests: verified missing context and raw evidence before the fix.
- Final review: fixed unbounded diagnostic bodies (2,000-character redacted prefix
  plus the independent bounded output tail); huge-continuation test RED → GREEN.
- Final review: fixed unfamiliar path headers bleeding into the previous file's
  message; attribution test RED → GREEN; raw evidence retains the unfamiliar body.
- Final focused check: 155 passed; source and test typechecks passed.
- Initial full checks hit the outer sandbox's local-server/nested-sandbox restrictions;
  rerunning test and coverage gates outside it with approved escalation.

- Final coverage gate passed: 33,658 tests passed, 43 skipped, zero failures;
  97.38% line coverage, 96.02% function coverage; per-file ratchet passed.
- Final `bun run check:all` and `bun run typecheck` passed after review fixes.
- Final package suite passed: 33,891 tests, zero failures across unit, integration, and UI.
- Independent review completed; both reported regressions were fixed with RED → GREEN tests.

## Pre-PR review

- Independent review of commit b13dff744 found two P2 issues.
- Fixed unfamiliar path headers with explicit line/column locations inheriting
  the preceding file's metadata. Four new parameter cases verified RED → GREEN.
- Fixed list-valued quality commands rendering as comma-separated rerun guidance;
  use the existing renderCommandSpec helper. Four new cases verified RED → GREEN
  across lint/typecheck and parsed/unparsed output.
- Revised focused suite: 163 passed, zero failures.
- Revised typecheck and check:all passed; coverage gate passed with 33,666 tests,
  43 skipped, zero failures, 97.38% lines and 96.02% functions.
- Revised full package suite passed: 33,899 tests, zero failures across all phases.
