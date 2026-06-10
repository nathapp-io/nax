# Spec Writing Guide

> **Moved.** The canonical spec-writing guide now lives in the **`spec-writing` skill**, which is the single source of truth for how to author `SPEC-*.md` files for nax.
>
> - Skill repo: <https://github.com/nathapp-io/nax-spec-kit-skills>
> - Install: `/plugin marketplace add nathapp-io/nax-spec-kit-skills` then `/plugin install nax-spec-kit@nax-spec-kit`
> - Guide: `skills/spec-writing/reference/spec-writing-guide.md` in that repo
>
> Invoke it with `/spec-writing <source>` (and audit the result with `/spec-review <path>`).

## Core principle (read this if nothing else)

**Every acceptance criterion is a real runtime test** — one the implementing agent
writes fail-first, then makes pass in the project's test framework (`bun:test`,
`pytest`, `go test`, …). `nax plan` turns each AC in `spec.md` into a `prd.json`
`acceptanceCriteria` entry that drives an agent implementation session, so an AC
that is **not** an executable test is meaningless in that pipeline.

Therefore:

- **Only** these AC tags are valid: `[unit]`, `[integration]`, `[cli]`.
- **No** `grep` / shell / file-content ACs ("file X contains Y", `grep … | wc -l`).
  nax has no shell executor in the test path, and a file-content match passes on a
  pasted string in a comment — it proves nothing.
- **Removals / absence** are not ACs. They are verified by the build/static gate
  (the compiler/linter rejects references to deleted symbols — e.g. `bun run typecheck`),
  recorded as a **verification note** on the story.
- **Seams** (producer/consumer wiring) are behavioural `[unit]`/`[integration]`
  tests that stub the new symbol, trigger the production caller, and assert it was
  invoked — not grep checks that a call site exists.

### Superseded: the `[verbatim]` convention

Earlier revisions of this guide introduced `[verbatim]` ACs (preserving grep /
file-existence / architectural-invariant assertions character-for-character through
`nax plan`) to fix the spec→PRD drift documented in earlier findings.
That approach is **superseded**: behavioural ACs plus the build/static gate solve
the same drift more robustly (a real stub-and-assert seam test cannot be paraphrased
into a no-op, and removals are caught by the compiler). Do not write `[verbatim]`,
`[grep]`, or `[file]` ACs in new specs.

For the full guide — structure, sizing bounds, context files, seams, failure modes,
anti-patterns, and worked examples — see the skill linked above.
