# SPEC: Directory-Grouped Glob Output

## Summary

The `Glob` coding tool returns one root-relative path per line. Because most results
share a parent directory, that repeats the same prefix hundreds of times in a single
result. This spec changes `Glob` to emit one line per parent directory — the directory
prefix followed by space-separated basenames — and extends the tool's advertised
description so an agent knows the shape it will get back and knows that a pattern
naming an exact path answers whether that path exists. The transformation is lossless
and purely local to `src/tools/glob.ts`: the `MAX_MATCHES` cap, the `resolveWithin`
containment re-check, and both no-match messages are preserved.

## Motivation

`Glob` accounts for 1,168 calls and 1.76 MB of tool output in the local `tool-audit`
sink — 3.7% of all tool bytes. Measured on this repository at the tool's own
`MAX_MATCHES = 500` cap, with pattern `src/**/*.ts`:

| format | bytes | lines |
|:---|---:|---:|
| flat, one path per line (today) | 16,181 | 500 |
| inline per directory | **8,974** | 54 |
| directory header + indented basenames | 9,974 | 554 |

Grouping cuts the payload by ~45% and the line count by ~9x, and it does so without
discarding a single path — the directory prefix is shared rather than dropped.

A second, smaller problem: `src/tools/denial-redirect.ts` already routes a denied `ls`
or `find` to `Glob` (`HEAD_INTENTS` maps both to the `GLOB` intent), and a pattern
naming one exact path is the tool's existence probe. Neither fact appears in the
description the agent actually reads, which currently says only "List repository files
matching a glob pattern". An agent that does not know `Glob` answers existence probes
instead for a `Read` that fails.

## Design

`Glob` collects matches exactly as it does today — `Bun.Glob().scan()` from `ctx.root`
with `absolute: false`, each hit re-checked through `resolveWithin`, stopping at
`MAX_MATCHES`. Only the final rendering changes: instead of sorting the paths and
joining them with newlines, the paths are bucketed by parent directory and each bucket
is rendered as one line.

### Output format

One line per parent directory. The line is the directory prefix, always ending in `/`,
then a single space, then the basenames separated by single spaces:

```
./ notes.md
src/ _pkg.ts errors.ts
src/acceptance/ content-loader.ts generator.ts types.ts
src/tools/ bash.ts delete.ts edit.ts glob.ts read.ts
```

- A match directly at the repository root is grouped under the prefix `./`, so every
  line has a prefix and there is no second shape to recognise.
- Group lines are ordered by directory prefix, ascending. Basenames within a line are
  ordered ascending. The rendering is therefore deterministic for a given match set.
- A basename containing whitespace is wrapped in double quotes (`docs/ intro.md
  "release notes.md"`), so the line stays unambiguously splittable and the round-trip
  stays lossless.
- A single match uses the same shape as any other result (`src/tools/ read.ts`). There
  is no special case, so an existence probe and a wide listing read identically.

The result is lossless: concatenating a line's directory prefix with each of its
basenames reconstructs exactly the set of root-relative paths that matched.

No machine consumer parses `Glob` output — the only reader is the model, and the only
in-repo assertions on the format live in `test/unit/tools/read-glob.test.ts`. That is
what makes changing the format safe.

### Integration

`src/tools/glob.ts` is the only source file this story changes. Verified symbols:

- `globTool: CodingTool` — exported from `src/tools/glob.ts`, re-exported by
  `src/tools/index.ts`, registered by `src/tools/runtime.ts`. Read-only here except
  for the two members named below.
- `resolveWithin(root: string, candidate: string, execTouchedPaths?: readonly string[]): string | null`
  — `src/tools/policy.ts:95`. Read-only; the scan loop must keep discarding any hit for
  which it returns `null`.
- `MAX_MATCHES = 500` — module constant in `src/tools/glob.ts`. Read-only; the cap is
  unchanged and is counted in matches, not in rendered lines.
- `climbsOut(pattern: string): boolean` — module-private in `src/tools/glob.ts`.
  Read-only; a pattern with a `..` segment is still answered without scanning.

One new symbol is introduced, following the sibling tool's precedent:

- `_globDeps` — a new `@internal` test-only injectable exported from `src/tools/glob.ts`
  and re-exported from `src/tools/index.ts`, mirroring `_grepDeps` (`src/tools/grep.ts:33`,
  re-exported at `src/tools/index.ts:19`). It holds the single member the scan needs, so a
  test can substitute a scanner that throws. `globTool.run` calls the scan through
  `_globDeps` rather than constructing `Bun.Glob` inline.

  It exists because the scan-error path is otherwise unreachable: no malformed pattern
  makes `Bun.Glob().scan()` throw, so the only way to reach the `catch` is an
  environment-dependent filesystem error. `.nax/rules/test-writing.md` names `_deps`
  injection as this repo's mechanism for exactly this case, and
  `scripts/check-alias-internals.ts:22` cites it as the remedy rather than mutating a
  global.

Two members of `globTool` are changed:

- `globTool.run`
  - Baseline (exists only to locate the code; not the interface to implement): returns
    `{ content: matches.sort(...).join("\n") }` — one root-relative path per line.
  - Target: returns `{ content: <group lines joined by "\n"> }` in the format above.
    The signature `run(input: Record<string, unknown>, ctx: ToolRunContext): Promise<ToolResult>`
    is unchanged, as are both no-match returns and the `isError` path.
- `globTool.description`
  - Baseline: `"List repository files matching a glob pattern (e.g. 'src/**/*.ts'). Results are paths relative to the repository root."`
  - Target: text that additionally documents the grouped output shape by carrying the
    sample group line `path/to/ a.ts b.ts`, and documents the existence probe by
    carrying the phrase `whether a path exists`.

`globTool.description` is runtime data, not source text: it is the `description` field
of the tool schema advertised to the provider, so asserting on it is an assertion about
a value the harness constructs and hands to a model, not a grep over a file.

### Failure Handling

| Condition | Behaviour |
|:---|:---|
| `input.pattern` is not a string | Returns `{ content: "pattern must be a string", isError: true }` — unchanged. |
| Pattern contains a `..` segment | Returns `{ content: "no matches" }` without scanning — unchanged. |
| Pattern matches nothing | Returns `{ content: 'no matches for "<pattern>"' }` with `isError` falsy — unchanged. |
| The underlying scan throws | Returns `{ content: <the thrown error's message>, isError: true }` — unchanged. |
| More than `MAX_MATCHES` files match | Collection stops at 500 matches; the 500 are rendered as group lines. The cap counts matches, not lines. |

## Out of Scope

- rtk command interception for the `Read` tool: measured on this repository, rtk's
  default `--level none` saves 0%, and `--level aggressive` replaces function bodies
  with `// ... implementation`, which destroys the exact text the `Edit` tool needs to
  match.
- rtk command interception for the `Glob` tool; the grouping win is a formatting change
  and does not require a third-party binary or a subprocess.
- Adding any new member to the `Site` union in `src/execution/command-interceptor/index.ts`.
- Adding a dedicated `LS`, `Exists`, or directory-listing coding tool.
- Raising, lowering, or making configurable the `MAX_MATCHES` cap of 500 in `src/tools/glob.ts`.
- Reporting how many matches were discarded when the 500-match cap binds, whether via
  `resultBytesPreTruncation` or any other channel.
- Changing the `ls` and `find` redirect text in the `GLOB` intent of `src/tools/denial-redirect.ts`.
- Changing the output format of the `Grep` tool in `src/tools/grep.ts`.
- Changing the `Read` tool in `src/tools/read.ts` in any way.

## Stories

1. **US-001: Directory-grouped Glob output and existence-probe description** — no
   dependencies. Replaces `globTool.run`'s flat path rendering with the grouped format
   defined in Design, preserving the `MAX_MATCHES` cap, the `resolveWithin` re-check,
   both no-match messages and the scan-error path, routes the scan through a new
   `_globDeps` injectable so that error path is reachable from a test, and extends
   `globTool.description` to document the grouped shape and the existence probe.

Single story by the guide's merge rule: both changes live in one module
(`src/tools/glob.ts`), the description change is meaningless without the format change
it describes, and the combined story breaches no split rule (13 ACs against the
project's `maxAcCount` of 24, 4 context files against a limit of 5, purely additive with
no removal, rename or consolidation intent).

### Context Files / Creates

**US-001**
- Context Files:
  - `src/tools/glob.ts` — the tool being changed; `MAX_MATCHES`, `climbsOut` and the scan loop to preserve
  - `src/tools/policy.ts` — `resolveWithin` containment helper the scan loop must keep calling on every hit
  - `src/tools/grep.ts` — sibling tool; mirror its no-match message convention and its `ToolResult` usage
  - `src/tools/registry.ts` — `CodingTool`, `ToolResult` and `ToolRunContext` definitions
  - `src/tools/index.ts` — the barrel that re-exports `_grepDeps`; `_globDeps` is added beside it

This story creates no new file. The new test cases go into the existing glob test file,
which is listed under Modifies below.

### Modifies

**US-001**
- `test/unit/tools/read-glob.test.ts` — its globTool case "matches files by pattern, relative to the root" asserts the flat one-path-per-line shape as a two-element array of root-relative paths, a closed-world assertion the grouped format necessarily breaks; replace it with the invariant that the result is two group lines, one per parent directory, as defined in the Design section's output format.

### Seams

No cross-story seam: this spec has a single story, so there is no producer/consumer
hand-off between stories to pin. `globTool` itself is not new — it is already exported
from `src/tools/glob.ts`, re-exported by `src/tools/index.ts`, and registered by
`src/tools/runtime.ts`.

The one new externally-visible symbol, `_globDeps`, has its consumer inside the same
story: `globTool.run`. Its seam is pinned by the recording-stub AC in US-001, which
substitutes `_globDeps.scan`, triggers `globTool.run` (the outermost production entry
point for this tool — the runtime dispatches a model's tool call straight to it), and
asserts the substituted scanner was invoked with the pattern and root. The wiring is
unguarded — `run` scans on every call — so no re-trigger AC is required.

## Acceptance Criteria

### US-001: Directory-grouped Glob output and existence-probe description

- `[unit]` Given a root containing `src/a.ts` and `src/deep/b.ts`, calling `globTool.run` with pattern `src/**/*.ts` returns content consisting of exactly the two lines `src/ a.ts` and `src/deep/ b.ts`.
- `[unit]` Given a root containing `notes.md` directly at the root, calling `globTool.run` with pattern `*.md` returns content consisting of the single line `./ notes.md`.
- `[unit]` Given a root whose matches span `src/` and `src/deep/`, the group line beginning `src/ ` appears before the group line beginning `src/deep/ ` in `globTool.run`'s returned content.
- `[unit]` Given a directory containing `c.ts`, `a.ts` and `b.ts`, the group line for that directory lists the basenames in the order `a.ts b.ts c.ts`.
- `[unit]` For any match set, splitting each line of `globTool.run`'s content into its leading directory prefix and its basenames, then joining the prefix to each basename, yields exactly the set of root-relative paths the pattern matched — no path added and none dropped.
- `[unit]` Given a root containing `docs/release notes.md`, the group line for `docs/` emits that basename wrapped in double quotes, as `"release notes.md"`.
- `[unit]` Given a root containing `src/a.ts`, calling `globTool.run` with pattern `src/a.ts` returns the single group line `src/ a.ts`, the same shape a multi-match result uses.
- `[unit]` Calling `globTool.run` with pattern `**/*.py` against a root containing no Python file returns content containing `no matches for "**/*.py"` and a falsy `isError`.
- `[unit]` Calling `globTool.run` with pattern `../**/*` returns content equal to `no matches`, and that content holds no `..` sequence.
- `[unit]` Given a root containing more than 500 files matching the pattern, the number of basenames summed across every line of `globTool.run`'s content equals 500.
- `[unit]` With `_globDeps.scan` substituted by a scanner that throws an error whose message is `scan exploded`, calling `globTool.run` with pattern `src/**/*.ts` resolves with `isError` true and content equal to `scan exploded`.
- `[unit]` With `_globDeps.scan` substituted by a recording stub, calling `globTool.run` with pattern `src/**/*.ts` invokes that stub exactly once, with the pattern `src/**/*.ts` and a cwd equal to the `root` on the supplied `ToolRunContext` — so the production path reaches the scan through `_globDeps` and not through an inline `Bun.Glob`.
- `[unit]` `globTool.description` documents the grouped output shape by carrying the sample group line `path/to/ a.ts b.ts`.
- `[unit]` `globTool.description` documents the existence probe by carrying the phrase `whether a path exists`.
- `[unit]` Calling `globTool.run` with a non-string `pattern` returns content equal to `pattern must be a string` with `isError` true.

**Out of scope:** None.

Every behaviour named in the Design section's format rules and in its Failure Handling
table is pinned by an AC above, so this story defers nothing beyond the feature-level
`## Out of Scope` list.
