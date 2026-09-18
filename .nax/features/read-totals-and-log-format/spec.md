# SPEC: Tool results carry the answer they were asked for

## Summary

Two agent-facing tools return output in which the thing the caller asked for is absent or
buried. `Read` on an unranged call returns a byte-bounded prefix with no indication of how
long the file is, so an agent editing next to the repository's 600-line file-size ratchet
cannot see its own margin. `Git` on `log` renders every commit in git's default `medium`
format, bodies included, so a `--name-only` call spends its entire byte budget on commit
prose and the file list is truncated away. This feature makes `Read` report the file's line
count on every read, and gives `log` a compact default commit format with an opt-in for full
bodies.

## Motivation

**`Read` (nax#2010).** `scripts/check-file-sizes.ts` enforces a hard line-count ratchet —
600 lines for `src/`, 800 for `test/`, with oversized files grandfathered at their recorded
size — and no tool available to an agent counts lines. Observed twice in run `4549de79`
(`advisory-and-budget-truth` US-002), `RunCommand` denied `wc -l` with an accurate
explanation: Read returns file contents truncated past a size ceiling, and nothing reports a
total. The agent then read the gate script and its baseline, which teaches the limit but not
its position, because a ratchet is relative to a per-file baseline rather than to a
threshold. The file it was editing stood at 596 lines against a 600-line limit and was not in
the baseline at all. It proceeded blind, four lines from a gate it is instructed to respect.
The direct cost was four wasted calls; the exposure is a breach that is unforeseeable from
inside the session and costs a rectification cycle when it fires.

The machinery already exists and is used on one branch only. `readTool.run`'s
offset/limit path reads the file, counts lines, tracks whether the read hit its ceiling, and
emits `[lines 10-14 of 50]`. The unranged path at `src/tools/read.ts:67-71` skips all of it
and returns a bare prefix.

**`Git log` (nax#2011, as corrected).** The issue was filed on the theory that
`--name-only` lists every file in each selected commit rather than the pathspec that selected
it, and offered three remedies on that basis. Measurement on this repository at
`48a25ed02` (git 2.50.1) shows the theory is wrong:

```
git log --name-only -- test/e2e/non-blocking-fix.e2e.test.ts
  total lines                        1811
  lines indented four spaces          1763   (97.4%)
  blank                                 20
  file-list lines                        7
git log --format= --name-only -- <same path>
  7 lines, every one the pathspec
```

`--name-only` is pathspec-restricted, exactly as `-p` is. The 1804 non-signal lines are the
bodies of seven squash-merge commits. The real defect is that `buildGitArgv` never passes
`--format`, so every `log` renders in git's default `medium` format:

| pathspec | today | with a compact format | reduction |
|:---|---:|---:|---:|
| `test/e2e/non-blocking-fix.e2e.test.ts` | 94,551 B | 965 B | 99.0% |
| `src/agents/acp/adapter.ts` | 200,529 B | 2,498 B | 98.8% |
| `src/execution` | 161,437 B | 4,635 B | 97.1% |

Two of those exceed `DEFAULT_TOOL_MAX_BYTES` (40,000), and because `--name-only` prints each
commit's file list *after* that commit's message, truncation removes precisely what was
asked for. The first 40 KB of the `adapter.ts` call — all the model ever sees — contains 2 of
the 20 selected commits, 722 lines of message prose, and **one** file-list line. Routing the
same call through `rtk` changes nothing: `rtk git log` without a format flag returns the same
200,529 bytes.

This compounds nax#1991 and nax#2056: a result's cost is its byte count multiplied by the
round trips remaining in the session, so a 40 KB result that arrives early is among the most
expensive events in a run, and this one carries almost no signal.

## Design

### Integration

The feature modifies two tools. Symbols it only reads are listed once; symbols it changes
carry a `Baseline:` / `Target:` pair. The baseline exists to locate the code and is never the
interface to implement.

**Read — `src/tools/read.ts`**

Read-only, verified present:

- `readPrefix(path: string, maxBytes: number): Promise<string>` (`src/utils/bounded-io.ts:18`)
  — reads at most `maxBytes + 1` bytes. The extra byte is how a caller learns the file
  continues past the ceiling; the ranged path already uses it this way at `read.ts:93`.
- `truncate(body: string, maxBytes: number): string` (`read.ts:22`) — appends
  `\n... [truncated at N bytes]` when the body exceeds the ceiling.
- `ToolRunContext.maxBytes` / `.maxFileBytes` (`src/tools/registry.ts:53,58`), defaulting to
  `DEFAULT_TOOL_MAX_BYTES = 40_000` and `DEFAULT_TOOL_MAX_FILE_BYTES = 2_000_000`
  (`src/tools/runtime.ts:30,47`).

Changed:

- `readTool.run(input, ctx)`, the branch at `read.ts:67-71` taken when neither `offset` nor
  `limit` is supplied.
  - **Baseline:** returns `{ content: truncate(await readPrefix(target, ctx.maxBytes), ctx.maxBytes) }`
    — a prefix with no header and no line count.
  - **Target:** same signature and same bytes read. It counts the lines of the prefix it
    already has, builds a leading `[N lines]` header, and returns
    `{ content: truncate(`${header}${body}`, ctx.maxBytes) }`. When the prefix overran the
    ceiling the count is a floor and the header reads `[N+ lines]`.

  Two details this branch must not inherit from the ranged branch. First, the overrun test
  compares against **`ctx.maxBytes`**, because that is the ceiling this branch reads with;
  `read.ts:93` compares against `ctx.maxFileBytes` only because the ranged branch reads with
  `maxFileBytes` at `read.ts:88`. Copying that line unchanged would make the floor marker
  never fire. Second, a prefix that overran its ceiling almost always ends mid-line, so the
  final element of the split is a partial line. Counting it is correct: the partial belongs to
  a real line, so the count remains a true floor, which is all `[N+ lines]` claims.

The count is deliberately derived from the `maxBytes` prefix rather than from a second,
larger read. Across this repository's 2,650 TypeScript files only 3 exceed 40,000 bytes, and
**none** of the 157 files in the 550-800 line band that the ratchet actually threatens do. A
`maxFileBytes` read would buy an exact total for 0.1% of files at the cost of loading up to
2 MB on every unranged read — which is the precise regression
`test/unit/tools/buffering-ceilings.test.ts` was written to prevent ("Ceilings bound the
WORK, not just the answer").

The header leads and `truncate()` wraps the whole body, following `src/tools/grep.ts:172-177`:
appended after truncation a caveat both overruns `maxBytes` and is the first thing lost on
exactly the results that need it most.

**Git — `src/tools/git.ts`**

Read-only, verified present:

- `flagFromBoolean(input, field, subcommand, verbs, flag)` (`git.ts:206` call site) — returns
  the flag string, `null` when the field is absent, or an error object. It refuses a
  non-boolean rather than coercing it, and gates the field to a verb list.
- `GIT_ONELINE_VERBS = ["log", "show"]` (`git.ts:88`), `GIT_NAME_ONLY_VERBS`,
  `GIT_MAX_COUNT_VERBS = ["log"]` (`git.ts:96`).
- `DEFAULT_LOG_MAX_COUNT = 20` (`git.ts:118`) — the exported-constant-plus-test precedent this
  feature follows for its own default.
- `GIT_ESCAPE_FLAGS = ["-C", "--git-dir", "--work-tree", "--exec-path", "-c"]`
  (`src/tools/git-flags/index.ts:10`) — `--format` and `--date` are not among them.
- `interceptArgv` / `_gitToolDeps.interceptor` (`git.ts:331`) — the rtk rewrite is an
  argv-array prepend (`src/execution/interceptors/rtk/index.ts:108`), never a shell join, so
  an argv element containing spaces survives it intact. Verified against `rtk 0.49.0`.

Changed:

- `buildGitArgv(input: Record<string, unknown>): string[] | { error: string }` (`git.ts:190`).
  - **Baseline:** for `log`, emits `["log", "--relative", ...flags, "--max-count=20", "--", ...]`
    with no `--format`, so git applies its `medium` default.
  - **Target:** same signature. For `log` with neither `oneline` nor `fullMessage` set, the
    flags block additionally emits `--format=format:%h %ad %s` and `--date=short`. `oneline`
    and `fullMessage` each suppress it. The two are mutually exclusive and a request for both
    is an error. No other verb is affected.
- `gitTool.inputSchema.properties` (`git.ts:291`).
  - **Baseline:** advertises `subcommand`, `refs`, `paths`, `nameOnly`, `diffFilter`,
    `oneline`, `maxCount`. `nameOnly`'s description asserts that on `log` "every file in each
    of those commits is then listed — not just the pathspec", and directs the reader to
    `maxCount` to narrow it.
  - **Target:** additionally advertises a `fullMessage` boolean. `nameOnly`'s description
    states what was measured: the file list is restricted to the pathspec, `log` renders a
    compact commit line by default, and `fullMessage` restores full bodies. The
    `maxCount`-narrows-the-per-commit-output claim is replaced by what was measured:
    `maxCount` bounds how many commits are selected, and was byte-neutral for this case when
    nax#2011 was filed.

New module-level constant, consumed within the same module by `buildGitArgv`:

```ts
/**
 * Compact commit rendering for `log`.
 *
 * `format:` rather than `tformat:` or the bare form: it places the separator
 * BETWEEN commits, so each --name-only file list stays grouped with the commit
 * that produced it instead of being orphaned after a blank line.
 */
export const DEFAULT_LOG_FORMAT = "format:%h %ad %s";
```

### Approach

The format flag is emitted from the existing flags block, before the refs, for the reason
already recorded at `git.ts:203-205`: a flag placed after a revision list reads as a pathspec
to anyone — model or human — scanning the tool-audit ledger.

`--oneline` and `--format` are last-wins on the same argv, so they are composed by exclusion
rather than by ordering. `oneline` continues to win where it is set, because it is a caller's
explicit request; `fullMessage` suppresses the default because its whole purpose is to
restore git's. Asking for both is a contradiction and is refused by name rather than resolved
silently, matching how `flagFromBoolean` treats a non-boolean and how `policy.ts` treats a
denied argv.

### Failure Handling

| Condition | Behaviour |
|:---|:---|
| `fullMessage` is not a boolean | `buildGitArgv` returns `{ error }` naming the field; the tool surfaces it as an error result, not a denial. |
| `fullMessage` on a verb other than `log` | `buildGitArgv` returns `{ error }` naming the field and the verbs it applies to. |
| `fullMessage` and `oneline` both true | `buildGitArgv` returns `{ error }` naming both fields. No argv is built. |
| Unranged read of an empty file | Returns the header `[0 lines]` and no body. Not an error. |
| Unranged read whose prefix hit the byte ceiling | Header reports a floor, `[N+ lines]`, never a total. A false total is the defect class nax#1923 was fixed to avoid, and `read.ts:89-92` records the rule. |
| `maxBytes` too small to hold the header | `truncate()` applies to header-plus-body, so the result stays within the ceiling and carries the truncation marker. The header is not exempt from the budget. |
| Unreadable file | Unchanged: a tool error the model can react to, never a denial (`read.ts:112-115`). |

## Out of Scope

- Applying the compact commit format to `git show`: `show` renders a single commit and its
  message is usually the reason for the call, so its default rendering is unchanged by this
  feature.
- Changing the byte ceilings themselves: `DEFAULT_TOOL_MAX_BYTES` (40,000) and
  `DEFAULT_TOOL_MAX_FILE_BYTES` (2,000,000) keep their current values and meanings.
- Reporting an exact line total for a file whose bytes exceed `maxBytes`: such a file reports
  a floor (`N+`), and this feature does not add a second, larger disk read to resolve it.
- Adding `wc` or any other shell utility to the `RunCommand` allowlist: nax#2010 explicitly
  rejects this, and that list stays limited to semantic build verbs.
- Post-filtering `git log --name-only` output against the pathspec: this was nax#2011's first
  proposed remedy and is retracted, because git already restricts the file list to the
  pathspec.
- Refusing the `nameOnly` plus `paths` combination on `log`: this was nax#2011's recommended
  remedy and is retracted for the same reason; the combination is correct today and is made
  useful by this feature.
- Changing the order in which `gitWithTimeout` bounds stdout relative to `postProcess`: the
  truncation limitation documented at `src/tools/git.ts:366-370` is untouched.
- Emitting a marker when `--max-count` drops commits: the asymmetry noted in
  `DEFAULT_LOG_MAX_COUNT`'s doc comment, where a byte truncation is marked but a commit cap is
  not, is left as it stands.

## Stories

**US-001 — `Read` reports how long the file is** (no dependencies)

Give the unranged branch of `readTool.run` the line count the ranged branch already computes,
so an agent can see its position against the file-size ratchet without a shell. Bytes read are
unchanged; the result gains a leading header and nothing else.

**US-002 — `log` renders a compact commit line by default** (no dependencies)

Emit a compact `--format` for `log`, add a `fullMessage` opt-in that restores git's default
rendering, make `fullMessage` and `oneline` mutually exclusive, and correct the `nameOnly`
schema description that nax#2009 added on the now-retracted diagnosis.

The two stories touch disjoint modules and disjoint test files and have no seam between them.
They are kept separate rather than merged under the cost tiebreaker because each is
independently meaningful, each closes its own issue, and a merged story could not be named
after a single capability.

### Context Files

**US-001**
- `src/tools/read.ts` — the tool under change; the ranged branch at lines 73-111 is the
  pattern the unranged branch adopts.
- `src/utils/bounded-io.ts` — `readPrefix`'s `maxBytes + 1` contract, which is how the floor
  case is detected.
- `src/tools/grep.ts` — the leading-caveat-inside-truncate precedent at lines 172-177.
- `test/unit/tools/buffering-ceilings.test.ts` — the invariant that ceilings bound the work,
  which constrains this story to the prefix it already reads.

**US-002**
- `src/tools/git.ts` — the tool under change; `flagFromBoolean` and the verb-gating lists are
  the pattern the new field follows.
- `src/tools/git-flags/index.ts` — `GIT_ESCAPE_FLAGS`, which the new flags must not collide
  with.
- `test/unit/tools/git-output-bounds.test.ts` — how `DEFAULT_LOG_MAX_COUNT` is asserted; the
  pattern for asserting the new default.

### Creates

**US-001**
- None. The change is confined to an existing branch of an existing file; its tests extend
  `test/unit/tools/read-glob.test.ts`.

**US-002**
- None. The change is confined to `src/tools/git.ts`; its tests extend
  `test/unit/tools/git-output-bounds.test.ts`.

### Modifies

**US-001**
- `test/unit/tools/read-glob.test.ts` — the test named "no range supplied is byte-identical to
  today's whole-prefix read" asserts `expect(withRange.content).not.toContain("[lines")` and
  compares two unranged reads for equality. Both assertions still hold after this story, since
  the new header reads `[50 lines]` rather than `[lines …]` and both sides of the comparison
  gain it equally — but the invariant the test is named for, that an unranged read returns the
  prefix unadorned, is exactly what this story ends. Rename it and replace the guard with an
  assertion that the unranged read now carries the `[N lines]` header, so the file stops
  documenting an invariant that no longer holds.

US-002 modifies no existing file. Every existing assertion over a `log` argv is open-world —
`toContain`, an `indexOf` ordering comparison, or a slice of the trailing exclusions — so an
added flag in the flags block breaks none of them. `test/unit/tools/git.test.ts:157` asserts
the argv's tail is `GIT_EXCLUDES` preceded by `"."`, which the flags block does not disturb.

### Seams

- `DEFAULT_LOG_FORMAT` is exported for its test to reference without duplicating the literal,
  following `DEFAULT_LOG_MAX_COUNT`. Its only consumer is `buildGitArgv`, in the same module,
  and US-002 AC1 asserts a built `log` argv actually carries it — so the constant is anchored
  as used, not merely present. There is no cross-story consumer and therefore no stub-and-
  trigger seam.
- The two stories share no symbol. US-001 touches no file US-002 touches.

## Acceptance Criteria

### US-001 — `Read` reports how long the file is

1. `[unit]` Reading a 50-line file with neither `offset` nor `limit` supplied returns content
   whose first line is `[50 lines]`.
2. `[unit]` Reading that same 50-line file with neither `offset` nor `limit` returns content
   that still contains both the first and the last line of the file, so the header is additive
   rather than a replacement for the body.
3. `[unit]` Reading a file of three lines with no trailing newline and no `offset` or `limit`
   reports `[3 lines]`, not `[4 lines]`.
4. `[unit]` Reading an empty file with no `offset` or `limit` reports `[0 lines]` and returns
   no body, and the result is not an error.
5. `[unit]` Reading a file whose size exceeds the context's `maxBytes` with no `offset` or
   `limit` returns a header matching `[<digits>+ lines]`, where the trailing `+` marks the
   count as a floor rather than a total.
6. `[unit]` Reading a file whose size exceeds the context's `maxBytes` with no `offset` or
   `limit` returns content that also contains the word `truncated`, so the floor header and the
   truncation marker coexist.
7. `[unit]` Reading with a `maxBytes` of 5 returns content no longer than 60 characters, so the
   header is inside the byte budget rather than added on top of it.
8. `[unit]` Reading with `offset` 10 and `limit` 5 still returns a header of `[lines 10-14 of 50]`,
   so the ranged branch's existing header is unchanged by this story.
9. `[unit]` Reading with an `offset` past the end of a 50-line file still returns a non-error
   result naming the line count 50, unchanged by this story.

### US-002 — `log` renders a compact commit line by default

1. `[unit]` `buildGitArgv` called with subcommand `log` and no other fields returns an argv
   containing the element `--format=format:%h %ad %s` and the element `--date=short`.
2. `[unit]` `buildGitArgv` called with subcommand `log` and refs `["abc123..HEAD"]` returns an
   argv in which the `--format=` element appears at a lower index than the element
   `abc123..HEAD`, so the flag precedes the revision list.
3. `[unit]` `buildGitArgv` called with subcommand `log` and `fullMessage` true returns an argv
   containing no element beginning `--format=`.
4. `[unit]` `buildGitArgv` called with subcommand `log` and `oneline` true returns an argv
   containing `--oneline` and no element beginning `--format=`.
5. `[unit]` `buildGitArgv` called with subcommand `log`, `oneline` true and `fullMessage` true
   returns an error result whose message names both the `oneline` and the `fullMessage` field,
   and returns no argv.
6. `[unit]` `buildGitArgv` called with subcommand `diff` and `fullMessage` true returns an error
   result whose message names the `fullMessage` field.
7. `[unit]` `buildGitArgv` called with subcommand `log` and `fullMessage` set to the string
   `"yes"` returns an error result rather than treating the value as true.
8. `[unit]` `buildGitArgv` called with subcommand `diff` and no other fields returns an argv
   containing no element beginning `--format=`, so no verb other than `log` gains the default.
9. `[unit]` `buildGitArgv` called with subcommand `log`, `nameOnly` true and paths
   `["src/a.ts"]` returns an argv that contains `--format=format:%h %ad %s`, contains
   `--name-only`, and contains none of the elements of `GIT_ESCAPE_FLAGS`.
10. `[unit]` The `Git` tool's advertised input schema exposes a `fullMessage` property of type
    boolean, so a model can reach the field at all.
11. `[unit]` `buildGitArgv` called with subcommand `log` and `maxCount` 3 returns an argv
    containing both `--max-count=3` and `--format=format:%h %ad %s`, so the commit bound and
    the commit format compose.
12. `[unit]` `DEFAULT_LOG_FORMAT` is importable from the tools module and equals
    `format:%h %ad %s`, and an argv built for subcommand `log` with no other fields contains
    the element `--format=` concatenated with `DEFAULT_LOG_FORMAT` — so the constant is the
    value the builder actually emits rather than a second copy of the literal.

<!-- spec-writing: completed-through-phase-5 -->
