# SPEC: Read continuation steering — a Read guideline and a next-offset footer

## Summary

Two changes to the native `Read` tool (`src/tools/read.ts`), both text the model sees. First,
`readTool.description` gains a guideline to examine files with `Read` rather than
`cat`/`sed`/`head`/`tail`/`awk` in Bash, and says how to continue a partial read. Second, every
`Read` result that stops before the end of the file ends with a footer line naming the concrete
next `offset`. A ranged read whose `limit` stops early gets `[R more lines in file. Use offset=X
to continue.]`. A read that exceeds the model-facing caps is cut by `Read` itself at a whole-line
boundary and ends with `[Showing lines a-b of T. Use offset=X to continue.]`, instead of reaching
the generic after_tool truncation, which writes a spill copy and points the model at that copy
rather than at the file.

## Motivation

Verified on `main` @ `3e4ec0266`, and against tool-audit ledgers of four native-agent features
run on 2026-09-24 (approvals-cli, turn-cancellation, honest-gates-and-labels, audit-row-fidelity):

- **Agents read files through Bash.** Of 1,188 Bash calls, 244 start with `grep`, 93 with `cat`,
  67 with `awk` (65 of them `awk 'NR==N'` line picks), 26 with `sed` (25 of them `sed -n a,bp`
  ranges) and 30 with `wc`. `awk 'NR==N'`, `sed -n a,bp` and `cat f | head` are ranged reads
  the `Read` tool already supports through `offset`/`limit`. Each one bypasses Read's
  line-count header and the tool audit's Read accounting.
- **The only steer today is generic.** Every Bash description carries
  `PREFER_STRUCTURED_TOOLS_SENTENCE` ("PREFER the structured tools when they express the task
  ..."), and `readTool.description` never says when to use `Read` or how to continue a partial
  read.
- **A partial read never names the next call.** A ranged read returns `[lines a-b of N]` and
  stops. A read over `MODEL_MAX_LINES` (1,000) or `MODEL_MAX_BYTES` (40,000) is cut by the
  after_tool policy (`applyModelTruncationPolicy`, `src/tools/spill.ts`), which writes the full
  body to `.nax/scratchpad/spill/Read-<callId>.txt` and ends the content with
  `... [truncated: full output at spill/Read-<callId>.txt; showing d of o bytes]`. For `Read`
  that spill is a second copy of a file the model can already page with `offset`, and the
  marker points it at the copy.
- A reference coding agent's read tool, the design point for this change, has both steers: a
  prompt guideline to use its read tool instead of `cat`/`sed`, and a footer naming the next
  offset whenever a read stops before end-of-file.

Measured effect is expected in round trips, not bytes: shell reads are about 520 KB of the
12.8 MB of tool-result bytes in those runs, and whole-file `Read` is 9.2 MB. The A/B that
measures this change is run separately (see Out of Scope).

## Design

### Approach

Deterministic string composition inside the `Read` tool. No LLM, no config, no new tool
arguments. The footer helpers live in a new file-local module `src/tools/read-continuation.ts`
that `read.ts` imports by relative path; it is not exported from the `src/tools` barrel.

The after_tool policy (`applyModelTruncationPolicy`) is unchanged and stays the unconditional
backstop: a `Read` result that already fits every cap passes through it untouched (its
within-cap contract), so no spill file is written for it.

### Integration

Symbols read, unchanged:

- `MODEL_MAX_LINES` (1,000), `MODEL_MAX_BYTES` (40,000), `splitModelLines(body): string[]` —
  `src/tools/truncate.ts`
- `ToolRunContext.maxBytes` (model-facing byte cap), `ToolRunContext.maxFileBytes`,
  `ToolRunContext.readCeiling` — `src/tools/registry.ts`
- `applyModelTruncationPolicy(body, { toolName, callId, root?, maxBytes? })` —
  `src/tools/spill.ts`; async (returns `Promise<string>`), and resolves to the body unchanged when it is within every cap
- `createCodingToolRuntime({ policy, maxBytes, ... })` and `CodingToolRuntime.callTool(name,
  input)` — `src/tools/runtime.ts`; `registerBuiltinCodingTools()` registers `readTool`
- `compileToolPolicy(rules, root)` — `src/tools/policy.ts`

Symbols changed. The baseline exists only to locate the code; it is never the interface to
implement.

- `readTool.description` (`src/tools/read.ts`)
  - Baseline: `"Read a UTF-8 text file from the repository. Paths are relative to the
    repository root. Optionally pass offset (1-based line number to start from) and/or limit
    (maximum number of lines to return) to read a slice instead of the whole file."`
  - Target (after US-001): the baseline text, followed by these three sentences in this order:
    `"Use Read to examine files instead of cat, sed, head, tail or awk in Bash."`,
    `"A read that stops before the end of the file ends with a line naming the offset to continue from."`,
    `"For a large file, read the part you need with offset/limit; when you need the whole file, continue with offset until complete."`
  - Target (after US-002): the US-001 text, followed by
    `` `Output is capped at ${MODEL_MAX_LINES} lines or ${MODEL_MAX_BYTES} bytes.` `` (the
    constants interpolated, so the sentence reads "Output is capped at 1000 lines or 40000
    bytes.").
- `readTool.run` (`src/tools/read.ts`)
  - Baseline: whole-file path returns `[N lines]\n<prefix>` (or `[N+ lines]` when the prefix
    reached `readCeiling`); ranged path returns `[lines a-b of T]\n<selected lines>`; neither
    applies the model caps.
  - Target: both paths compose their result through `read-continuation.ts` per the rules below.

### Footer formats

Both footers are the result's last line, joined to the body by a single `"\n"`, with nothing
after them. `T` and `R` carry a trailing `+` exactly when the line total is a floor (the read
stopped at its I/O bound: `readCeiling` on the whole-file path, `maxFileBytes` on the ranged
path), matching the existing header rule.

| Footer | Text | Used when |
|---|---|---|
| limit-stop | `[R more lines in file. Use offset=X to continue.]` | a ranged read's `limit` ends at line `b` with `b < T` |
| cap | `[Showing lines a-b of T. Use offset=X to continue.]` | the result would exceed a model cap and is cut |

For both, `X = b + 1`. For the limit-stop footer, `R = T - b` (the count of lines after `b`
among those read; `R+` when `T` is a floor).

### Composition rules (ordered)

`H` is the header line the tool already produces, unchanged by a cut: on the ranged path it names the requested range even when the cap footer reports a shorter delivered range. `L` is the list of selected lines (whole-file:
every line of the prefix; ranged: lines `offset..endLine`). `a` is the first selected line
number (1 on the whole-file path). The budgets are `MODEL_MAX_LINES` lines and `ctx.maxBytes`
bytes, both counted over the whole result, header and footer included.

1. **Limit-stop footer (US-001).** Ranged path only: when `limit` was given and
   `endLine < totalLines`, the candidate result is `H`, `L`, then the limit-stop footer.
   Otherwise the candidate is today's result.
2. **Fit check (US-002).** When the candidate is within both budgets, return it.
3. **Cap cut (US-002).** Otherwise keep the largest `k >= 1` such that `H`, the first `k`
   lines of `L`, and the cap footer for `b = a + k - 1` fit both budgets (line count
   `1 + k + 1 <= MODEL_MAX_LINES`, UTF-8 bytes `<= ctx.maxBytes`). Return `H`, those `k` lines
   and the cap footer. The cap footer replaces the limit-stop footer; a result never carries
   both.
4. **No line fits (US-002).** When no `k >= 1` fits, return the result unshaped (today's
   result, plus the limit-stop footer from rule 1 if it applied). The after_tool backstop then
   cuts it as it does today.

A cut result never ends with a trailing newline. An uncut result keeps today's body bytes
exactly.

### Failure Handling

| Case | Behaviour |
|---|---|
| No selected line fits the budgets with header and cap footer | Rule 4: returned unshaped; the after_tool backstop cuts it (today's behaviour) |
| `offset` past the last line | Unchanged: today's non-error message, no footer |
| Ranged read stops at the last line that could be read within `maxFileBytes` | No footer: an `offset` beyond it cannot be read (unchanged message on the next call) |
| Unreadable file | Unchanged: `isError` with the error message, no footer |

## Out of Scope

- The Bash tool descriptions are unchanged, including `PREFER_STRUCTURED_TOOLS_SENTENCE`; pipelines such as `bun test ... | tail` must not be discouraged.
- Shell searches (`grep`, `rg`, `find`, `ls`) are not steered toward the `Grep` or `Glob` tools, and the `Grep` tool gains no new parameters (context lines, glob filter, result limit).
- `ScratchpadRead` is unchanged: it keeps today's output and relies on the after_tool policy for the model caps.
- Lines longer than `MODEL_MAX_LINE_CHARS` are not shortened by `Read`; the after_tool policy still shortens them and appends its generic marker, as today.
- When a spin-breaker nudge rides a `Read` result that is close to the byte cap, the after_tool policy may still cut it further with its generic marker; `Read` reserves no bytes for a nudge.
- No line numbers in `Read` output, no smaller default for whole-file reads, no changed-region output from `Edit`, and no `before_tool` nudge on large reads.
- The ranged path's I/O bound (`maxFileBytes`) and the whole-file path's I/O bound (`readCeiling`) are unchanged, as are the `[N lines]` and `[lines a-b of T]` headers.
- Measuring the effect (the A/B on the `ab-2227` seed) is not part of this feature.

## Stories

1. **US-001: Read guideline and limit-stop footer** — no dependencies.
   Creates `src/tools/read-continuation.ts` with the limit-stop footer composition, calls it from
   the ranged path of `readTool.run`, and extends `readTool.description` with the three US-001
   sentences.
2. **US-002: Read cuts its own result at the model caps** — depends on US-001.
   Adds the fit check, cap cut and no-line-fits fallback (composition rules 2-4) to
   `src/tools/read-continuation.ts`, applies them on both paths of `readTool.run`, and appends the
   cap sentence to `readTool.description`.

### Context Files

**US-001**
- `src/tools/read.ts` — the tool being extended; header and floor (`+`) logic to follow
- `src/tools/truncate.ts` — `splitModelLines` line-counting convention
- `test/unit/tools/read-glob.test.ts` — existing ranged-read tests and the `ctx` helper
- `test/unit/tools/read-line-total.test.ts` — header tests and the `ctx(paths, maxBytes, maxFileBytes, readCeiling)` helper

**US-002**
- `src/tools/read-continuation.ts` — created by US-001, extended here
- `src/tools/spill.ts` — `applyModelTruncationPolicy`, the backstop whose within-cap path must pass Read's result untouched
- `src/tools/runtime.ts` — `createCodingToolRuntime`, `callTool`, `registerBuiltinCodingTools`
- `test/unit/tools/tool-run-context-read-ceiling.test.ts` — driving `callTool("Read", ...)` through a runtime
- `test/unit/tools/us-003-acs.test.ts` — how spill-file presence and absence is asserted

### Creates

**US-001**
- `src/tools/read-continuation.ts` — footer composition for `Read` results
- `test/unit/tools/read-continuation.test.ts` — limit-stop footer and description tests

**US-002**
- `test/unit/tools/read-cap-cut.test.ts` — cap cut, fallback and runtime integration tests

### Modifies

**US-002**
- `test/unit/tools/read-glob.test.ts` — the test "a ranged read is not truncated by the tool (the after_tool policy owns the marker)" and its comment state that `Read` never cuts its own result. Replacing invariant: `Read` still never emits the old `[truncated at N bytes]` marker (the `not.toContain("truncated at")` assertion stays); a result over the model caps is now cut by `Read` at a whole-line boundary with the cap footer, and the after_tool policy remains the backstop. Rename the test and rewrite its comment to say so.

### Seams

- US-001 -> US-002: US-002 extends the composition in `src/tools/read-continuation.ts` created by
  US-001; both are file-local (not exported from the `src/tools` barrel), so the seam is covered
  by US-002's runtime integration ACs driving `callTool("Read", ...)`.
- `Read` -> after_tool backstop: US-002 AC 11 and AC 12 drive a real `Read` through
  `createCodingToolRuntime(...).callTool` and assert the backstop leaves the result untouched and
  writes no spill file.

## Acceptance Criteria

### US-001: Read guideline and limit-stop footer

1. [unit] `readTool.description` includes the sentence "Use Read to examine files instead of cat, sed, head, tail or awk in Bash."
2. [unit] `readTool.description` includes the sentence "A read that stops before the end of the file ends with a line naming the offset to continue from."
3. [unit] `readTool.description` includes the sentence "For a large file, read the part you need with offset/limit; when you need the whole file, continue with offset until complete."
4. [unit] `readTool.description` still begins with "Read a UTF-8 text file from the repository."
5. [unit] `readTool.run` with `offset: 10, limit: 5` on a 50-line file returns content whose last line is exactly `[36 more lines in file. Use offset=15 to continue.]`.
6. [unit] `readTool.run` with `limit: 3` (no `offset`) on a 50-line file returns content whose last line is exactly `[47 more lines in file. Use offset=4 to continue.]`.
7. [unit] `readTool.run` with `offset: 10, limit: 5` on a 50-line file returns content whose first line is `[lines 10-14 of 50]` and whose lines between the header and the footer are exactly the file's lines 10 to 14.
8. [unit] `readTool.run` with `offset: 48, limit: 3` on a 50-line file (the range reaches the last line) returns content with no line beginning `[` other than the `[lines 48-50 of 50]` header.
9. [unit] `readTool.run` with `offset: 48` and no `limit` on a 50-line file returns content with no line beginning `[` other than the `[lines 48-50 of 50]` header.
10. [unit] `readTool.run` with `offset: 2, limit: 3` on a file larger than `ctx.maxFileBytes` (a 400-line file of 100-byte lines with `maxFileBytes` 1,000) returns content whose last line matches `[R+ more lines in file. Use offset=5 to continue.]`, where `R` is the header's floor total minus 4.
11. [unit] `readTool.run` with no `offset` and no `limit` on a 50-line file returns content with no footer line: every line after the `[50 lines]` header is a line of the file.
12. [unit] `readTool.run` with `offset: 999` on a 50-line file returns today's non-error past-the-end message, with no footer line.

### US-002: Read cuts its own result at the model caps

1. [unit] `readTool.description` ends with the sentence "Output is capped at 1000 lines or 40000 bytes.", built from `MODEL_MAX_LINES` and `MODEL_MAX_BYTES`.
2. [unit] `readTool.run` with no `offset`/`limit` on a 1,500-line file of short lines (well under `ctx.maxBytes`) returns content of exactly `MODEL_MAX_LINES` lines: the `[1500 lines]` header, file lines 1 to 998, and the last line `[Showing lines 1-998 of 1500. Use offset=999 to continue.]`.
3. [unit] `readTool.run` with no `offset`/`limit` and `ctx.maxBytes` 40,000 on a 200-line file whose every line is 399 `x` characters (over the byte cap only) returns content whose last line is exactly `[Showing lines 1-99 of 200. Use offset=100 to continue.]`.
4. [unit] In the result of AC 3, the lines between the `[200 lines]` header and the footer are exactly the file's lines 1 to 99, each complete.
5. [unit] The result of AC 3 has a UTF-8 byte length of at most 40,000, and the same composition with 100 file lines would exceed 40,000 bytes (the cut keeps the largest number of whole lines that fits).
6. [unit] `readTool.run` with `offset: 100, limit: 1200` on a 1,500-line file of short lines returns content whose first line is the unchanged header `[lines 100-1299 of 1500]` (the requested range) and whose last line is `[Showing lines 100-1097 of 1500. Use offset=1098 to continue.]` (the delivered range), with no limit-stop footer line.
7. [unit] A cut result from AC 2 does not end with a newline character.
8. [unit] `readTool.run` with no `offset`/`limit`, `ctx.readCeiling` 500 and `ctx.maxBytes` 300 on a 30-line file whose every line is 99 `x` characters returns content whose first line is `[6+ lines]` and whose last line is exactly `[Showing lines 1-2 of 6+. Use offset=3 to continue.]`.
9. [unit] `readTool.run` with no `offset`/`limit` and `ctx.maxBytes` 32 on a one-line file of 256 `r` characters (no line fits with the header and the cap footer) returns exactly `[1 lines]` followed by a newline and the 256 characters, with no cap footer.
10. [unit] `readTool.run` with no `offset`/`limit` on a 50-line file that fits both caps returns the `[50 lines]` header followed by the file's exact bytes, trailing newline included.
11. [integration] Registering the built-in tools with `registerBuiltinCodingTools()`, creating a runtime with `createCodingToolRuntime` (a policy granting `Read` under a temp root, `maxBytes` 40,000) and calling `callTool("Read", { path })` on a 1,500-line file returns content whose last line is `[Showing lines 1-998 of 1500. Use offset=999 to continue.]` and which has no `... [truncated:` line.
12. [integration] After the call in AC 11, no `spill/Read-*.txt` file exists under the temp root's `.nax/scratchpad/` directory.
13. [integration] Passing the content returned by AC 11 through `applyModelTruncationPolicy` with `toolName: "Read"`, `callId: "c1"`, no `root` and `maxBytes: MODEL_MAX_BYTES` returns it byte-identical.
