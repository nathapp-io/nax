# SPEC: Edit changed region — a literal replacement and a post-edit view

## Summary

Two changes to the native `Edit` tool (`src/tools/edit.ts`). First, the replacement becomes
byte-literal: today `source.replace(oldString, newString)` expands the `String.prototype.replace`
substitution patterns `$$`, `$&`, `` $` `` and `$'` inside `new_string`, so an edit that writes
code containing them silently writes something else. Second, a successful `Edit` result shows the
edited region: the first line stays `edited <path>`, followed by a `[lines a-b of N]` header in
`Read`'s own framing and the file's lines around the replacement, with the middle of a long
replacement elided. The model can confirm the edit and knows the line numbers for a ranged `Read`,
without re-reading the file.

## Motivation

Verified on `main` @ `0364da880`, and against 1,134 native tool-audit session ledgers under
`~/.nax/*/tool-audit/` (15,744 successful `Read` calls, 4,095 `Edit` calls):

- **`Edit` corrupts `new_string` containing `$` patterns.** `edit.ts:88` calls
  `source.replace(oldString, newString)` with a string `newString`, which is a replacement
  template: `"a".replace("a", "x$$y$&z")` returns `x$yaz`. `$$` collapses to `$`, `$&` inserts the
  matched text, `` $` `` inserts everything in the file before the match, and `$'` inserts
  everything after it. These are common in code: shell `$$`, regex-escape `"\\$&"`, and a regex
  ending in `$` followed by a markdown backtick. The ledgers hold 10 successful `Edit` calls whose
  `new_string` contained one. Each was followed by a failed test, a re-read, a whole-file `Write`
  to recover, or (one approvals CLI session) `git checkout` of the file, which discarded the
  agent's own work.
- **`Edit` returns only `edited <path>`** (`edit.ts:89`). The model does not see the result of its
  edit or where it landed.
- **Agents re-read files after their own edits.** 1,297 successful `Read` calls re-read a file the
  same session had just edited or written (8% of Reads, 5.8 MB of 99.4 MB Read result bytes). 426
  of them came immediately after the edit, with no call in between (1.6 MB). 577 followed a failed
  test or command, and 335 followed other calls.
- The re-read-after-edit share is lower than the 09-25 tuning notes assumed. For the implementer
  role, 830 re-reads follow an own edit and 1,498 re-read an unchanged file. This change targets
  the first group only.

`new_string` sizes (3,942 successful edits): median 11 lines / 534 bytes, p90 48 lines / 2.1 KB,
p99 152 lines. Echoing the whole replacement back would add about as many bytes as it saves, so the
view elides the middle of any replacement longer than 8 lines. Each view is at most 15 lines. The
expected saving is round trips (each one re-bills the session's context), not result bytes.

## Design

### Approach

Deterministic string composition inside the `Edit` tool. No LLM, no config, no new tool arguments.
Two helpers live in a new file-local module `src/tools/edit-region.ts` that `edit.ts` imports by
relative path. It is not exported from the `src/tools` barrel, the same convention as
`src/tools/read-continuation.ts`.

- `replaceUniqueLiteral(source, oldString, newString, matchIndex): string` returns
  `source.slice(0, matchIndex) + newString + source.slice(matchIndex + oldString.length)`.
- `composeEditRegion({ updated, matchIndex, newStringLength }): string` returns the view: the
  `[lines a-b of N]` header and the selected lines (composition rules below), or the empty-file
  line.

`edit.ts` already establishes that `oldString` occurs exactly once (`countOccurrences`). It takes
`matchIndex = source.indexOf(oldString)`, writes `replaceUniqueLiteral(...)`, and on success returns
`edited ${target}\n${composeEditRegion(...)}`. Every error path and error message is unchanged. The
file on disk is byte-identical to today's output for any `new_string` without `$` patterns.

### Integration

Symbols read, unchanged:

- `splitModelLines(body): string[]` (`src/tools/truncate.ts:65`) — the line-splitting convention
  `Read` uses, so `Edit`'s line numbers agree with `Read`'s `offset`.
- `CodingTool`, `ToolResult`, `ToolRunContext` (`src/tools/registry.ts`).
- `applyModelTruncationPolicy` (after_tool backstop): unchanged. A view is at most 15 file lines,
  and each line is still clamped by `MODEL_MAX_LINE_CHARS` downstream.

Modified: `src/tools/edit.ts` (`editTool.description`, the replacement expression and the success
content). Created: `src/tools/edit-region.ts`.

### View format

```
edited <target>
[lines a-b of N]
<file line a>
...
<file line b>
```

With elision (the replacement spans more than 8 lines):

```
edited <target>
[lines a-b of N]
<context and the first 3 replaced lines>
[... lines x-y not shown ...]
<the last 3 replaced lines and context>
```

When the edited file is empty (`updated === ""`), the view is the single line `[file is now empty]`
in place of the header and lines.

### Composition rules (ordered)

Let `lines = splitModelLines(updated)` and `N = lines.length`.

1. **Start line.** `s` = 1 + the number of `\n` characters in `updated.slice(0, matchIndex)`.
2. **End line.** If `newStringLength > 0`, `e` = 1 + the number of `\n` characters in
   `updated.slice(0, matchIndex + newStringLength - 1)`: the line holding the replacement's last
   character. If `newStringLength === 0` (a deletion), `e = s`. Both are then clamped to `N`, which
   covers a deletion at the very end of a file.
3. **Window.** `a = max(1, s - 3)`, `b = min(N, e + 3)`: `CONTEXT_LINES = 3` on each side.
4. **Elision.** If `e - s + 1 > 8` (`MAX_REGION_LINES_SHOWN = 8`), show lines `a..s+2`, then the
   marker `[... lines ${s+3}-${e-3} not shown ...]`, then lines `e-2..b`. Otherwise show `a..b` in
   full.
5. **Header.** `[lines a-b of N]`, with `a` and `b` from rule 3 whether or not rule 4 elides.
6. **Empty file.** If `N === 0`, the view is `[file is now empty]`; rules 1-5 do not run.
7. The content has no trailing newline.

### Description

`editTool.description` keeps its current text and appends: "On success the result shows the edited
lines with up to 3 lines of context and their line range, so you do not need to Read the file again
to check the edit."

### Failure Handling

Unchanged. Absent or ambiguous `old_string`, the file-size refusal, and read/write errors return
today's `isError` results byte-for-byte. The view is composed only after `writeFile` resolves; a
write error returns the error, never a view. `composeEditRegion` is pure and cannot throw on any
string input.

## Out of Scope

- Line-numbered `Read` output (tuning doc RD-3).
- `Write` returning content.
- Hints on a failed `Edit` (`old_string not found`: 97 calls in the ledgers).
- A role-prompt "don't re-read after editing" line (IM-1). The tool description carries it.
- The A/B that measures this change together with R17. It is billed and run separately.

## Stories

1. **US-001: Edit writes new_string literally** — no dependencies. Replaces the `.replace` call in
   `editTool.run` with `replaceUniqueLiteral` in the new `src/tools/edit-region.ts`.
2. **US-002: Edit returns the changed region** — depends on US-001. Adds `composeEditRegion` to
   `src/tools/edit-region.ts`, returns the view from `editTool.run` on success, and extends
   `editTool.description`.

### Context Files

**US-001**
- `src/tools/edit.ts` — the tool being fixed; `countOccurrences` and the error paths to keep
- `test/unit/tools/write-edit.test.ts` — existing Edit tests and the `ctx` helper

**US-002**
- `src/tools/edit-region.ts` — created by US-001, extended here
- `src/tools/edit.ts` — success path and description
- `src/tools/truncate.ts` — `splitModelLines`
- `src/tools/read-continuation.ts` — the file-local module convention and header framing to match
- `test/unit/tools/read-cap.test.ts` — driving `callTool` through `createCodingToolRuntime` (AC11 pattern)

### Creates

**US-001**
- `src/tools/edit-region.ts` — literal replacement helper
- `test/unit/tools/edit-region.test.ts` — `$`-pattern tests (one test file per source file, `test-architecture.md`)

**US-002**
- `test/unit/tools/edit-region.test.ts` — created by US-001; US-002 adds the view composition, description and runtime tests to it

### Modifies

**US-002**
- `test/unit/tools/write-edit.test.ts` — no assertion there checks the success content, so no test
  changes are expected; listed so a failure there is investigated, not rewritten.

### Seams

- US-001 -> US-002: both helpers live in `src/tools/edit-region.ts`, file-local. The seam is
  covered by US-002 AC 11, which drives a real `Edit` through
  `createCodingToolRuntime(...).callTool` and asserts both the file on disk and the returned view.

## Acceptance Criteria

### US-001: Edit writes new_string literally

1. [unit] On a file `const a = 1;\nconst b = 2;\n`, `editTool.run` with `old_string: "const a = 1;"` and `new_string: "const a = \"x$$y\";"` leaves the file exactly `const a = "x$$y";\nconst b = 2;\n`.
2. [unit] The same edit with `new_string: "s.replace(re, \"\\\\$&\");"` leaves the characters `\\$&` in the file unchanged.
3. [unit] The same edit with `new_string` ending in `` `^[0-9a-f]{8}$` `` (the characters `` $` ``) leaves the file exactly the original with only the matched text replaced by `new_string`; its length is `original.length - old_string.length + new_string.length`.
4. [unit] The same edit with `new_string` containing `$'` leaves the file exactly the original with only the matched text replaced by `new_string`.
5. [unit] `replaceUniqueLiteral("abcdef", "cd", "X$&Y", 2)` returns `abX$&Yef`.
6. [unit] An edit whose `new_string` contains no `$` produces a file identical to `source.replace(oldString, newString)` on the same input.
7. [unit] The existing absent-match, ambiguous-match and file-untouched-on-failure tests in `test/unit/tools/write-edit.test.ts` pass unchanged.

### US-002: Edit returns the changed region

1. [unit] `editTool.description` still begins with "Replace one exact occurrence of old_string with new_string in a repository file." and ends with "On success the result shows the edited lines with up to 3 lines of context and their line range, so you do not need to Read the file again to check the edit."
2. [unit] On a 20-line file whose line `k` is `line k`, replacing `line 10` with `line TEN` returns content whose first line is `edited <target>`, second line is `[lines 7-13 of 20]`, and remaining lines are exactly the file's lines 7 to 13 after the edit (line 10 being `line TEN`).
3. [unit] On the AC 2 fixture, replacing `line 2\n` with `line TWO\n` returns the header `[lines 1-5 of 20]` (the window clamps at line 1). The trailing newline keeps `old_string` unique, since `line 2` alone also occurs inside `line 20`.
4. [unit] On the AC 2 fixture, replacing `line 19\nline 20` with `line END` returns the header `[lines 16-19 of 19]` followed by the file's lines 16 to 19 after the edit.
5. [unit] On the AC 2 fixture, replacing `line 10` with a 3-line `new_string` `A\nB\nC` returns the header `[lines 7-15 of 22]` and the lines `line 7`, `line 8`, `line 9`, `A`, `B`, `C`, `line 11`, `line 12`, `line 13`.
6. [unit] On the AC 2 fixture, replacing `line 10\n` with the empty string (a deletion) returns the header `[lines 7-13 of 19]` and the file's lines 7 to 13 after the edit.
7. [unit] On the AC 2 fixture, replacing `line 10` with a 20-line `new_string` (`n1` to `n20`) returns the header `[lines 7-32 of 39]`, then `line 7`, `line 8`, `line 9`, `n1`, `n2`, `n3`, then exactly `[... lines 13-26 not shown ...]`, then `n18`, `n19`, `n20`, `line 11`, `line 12`, `line 13`: 13 lines after the header.
8. [unit] A `new_string` spanning exactly 8 lines is shown in full, with no `[... lines` marker.
9. [unit] Replacing the entire content of a one-line file with the empty string returns exactly `edited <target>\n[file is now empty]`.
10. [unit] No success content ends with a newline character, and every error result (absent match, ambiguous match, oversized file) is byte-identical to its content before this change.
11. [unit] Through `createCodingToolRuntime({ policy: compileToolPolicy([{ tool: "Edit", patterns: ["*"] }], root), maxBytes: MODEL_MAX_BYTES })` with `Edit` advertised, `callTool("Edit", ...)` on the AC 2 fixture returns an `ok` outcome whose content equals the AC 2 content, contains no `[truncated:` marker, and the file on disk holds `line TEN`.
12. [unit] The line numbers in the header agree with `Read`: for the AC 2 edit, `readTool.run` with `offset: 7, limit: 7` on the edited file returns body lines identical to the view's lines.
