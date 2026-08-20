# SPEC: Byte-correct, cancellable `nax logs --follow` tailing

<!-- spec-writing: completed-through-phase-6 -->

## Summary

`followLogs` in `src/commands/logs-formatter.ts` tails a run's JSONL log file. It tracks its read position with a **byte** offset taken from `Bun.file(path).stat().size`, then applies that offset to a **JavaScript string** via `newContent.slice(lastSize)` — a UTF-16 code-unit index. Any non-ASCII character in the log makes the two diverge permanently, so every subsequent poll slices past the true append boundary, the appended entry arrives truncated mid-token, `JSON.parse` throws, and a bare `catch {}` discards it. Log lines are silently lost.

This spec makes the incremental read byte-aligned and gives `followLogs` a cancellation signal and an injectable output/sleep seam, so the behaviour is provable by runtime tests. The seam comes first: `followLogs` is currently a `while (true)` with no exit, which is why all six of its unit tests and its one integration test are `test.skip`ed today, and why the offset defect shipped unnoticed.

## Motivation

Three verified facts:

1. **The defect is real and reproducible.** Writing a first entry whose `message` contains three `✓` characters (55 bytes, 49 UTF-16 units), then appending a second entry, makes `followLogs` read `l":"info","message":"SECOND-LINE-MUST-APPEAR"}` instead of the appended line. It parses as nothing and is dropped. Drift is permanent and grows by 2 per 3-byte glyph.

2. **It affects real data.** Of 60 nax JSONL artifacts under `.nax/features/*/`, five carry byte/UTF-16 drift of 2-6 units (`mutation-signal-correctness`, `finish-pr-body`, `finish-quality-walk-bounding`, `rules-description`, `otlp-logs-exporter`). The run formatter's own status glyphs (`✓` `✗` `⚠` `ℹ`) are 3-byte sequences.

3. **Nothing guards it.** `test/unit/commands/logs.test.ts` skips six `--follow` cases, deferring to `test/integration/cli-logs.test.ts` — **a file that does not exist**. The nearest real file, `test/integration/cli/cli-core-logs.test.ts`, also skips, stating: *"followLogs currently runs indefinitely with no cancellation hook. Exercising it in-process leaks background polling into later tests."* Both layers defer to each other and neither runs. `test/` contains eight statically skipped tests in total; **seven of them are this one feature** (the eighth is an unrelated flaky acceptance-loop case in `test/integration/execution/execution.test.ts`).

A secondary cost: each 500 ms poll calls `.text()` on the **entire** file and re-decodes it, so following a long run is O(filesize) per tick.

## Design

This is an extension of existing code. No new modules, no new files.

### Integration

Verified symbols and signatures at `b45129617`:

| Symbol | Location | Current shape |
|:---|:---|:---|
| `followLogs` | `src/commands/logs-formatter.ts:103` | `(filePath: string, options: { json?, story?, level? }) => Promise<void>` |
| `logsCommand` | `src/commands/logs.ts:45` | `(options: LogsOptions) => Promise<void>`; calls `followLogs` at lines 53 and 92, both gated on `options.follow`, each followed by a bare `return` |
| `LogEntry` | `src/logger/types.ts:9` | `{ timestamp, level, stage, storyId?, ... }` |
| `cancellableDelay` | `src/utils/bun-deps.ts:71` | `(ms: number, signal?: AbortSignal) => Promise<void>` — **rejects** on abort |
| `_logsReaderDeps` | `src/commands/logs-reader.ts:15` | existing `_deps` object in this module family |

**Pattern to mirror — `waitForSchedule` in `src/schedule/wait.ts`.** Read it before implementing; it is the repository's existing precedent for exactly this shape, a polling loop that must be cancellable and hermetic under test. Nothing in that file is created, modified, or re-declared by this spec — it is reference material only. Described in prose deliberately, so it is not mistaken for an interface to author: it declares a `WaitDeps` interface alongside a module-level `DEFAULT_DEPS` constant whose `delay` member is `cancellableDelay`; `waitForSchedule` takes an options object carrying a required `signal` and an optional `_deps: Partial<WaitDeps>`, merges them as `{ ...DEFAULT_DEPS, ...opts._deps }`, checks `opts.signal.aborted` at the top of each loop iteration and returns early, and wraps its `deps.delay(...)` call in a `try/catch` that converts the abort-rejection into the same early return.

`followLogs` adopts those same three elements: a `Partial<Deps>` override merged over a module-level default, a top-of-loop `signal.aborted` check, and a `try/catch` around the delay that converts an abort-rejection into a normal return.

**Target signature.** The shape US-001 and US-002 must arrive at — the third parameter and both dependency members are what every acceptance criterion below exercises:

```typescript
export interface FollowLogsDeps {
  /** Emits one formatted line. Defaults to today's console output. */
  emit: (line: string) => void;
  /** Waits between polls. Defaults to cancellableDelay; rejects on abort. */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Reads the file from a byte offset to EOF. Added by US-002. */
  readRange: (filePath: string, start: number) => Promise<string>;
}

export async function followLogs(
  filePath: string,
  options: { json?: boolean; story?: string; level?: LogLevel },
  opts?: { signal?: AbortSignal; _deps?: Partial<FollowLogsDeps> },
): Promise<"cancelled">;

// LogsOptions gains an optional `signal`; the return type is unchanged.
export async function logsCommand(options: LogsOptions): Promise<void>;
```

US-001 introduces `FollowLogsDeps` with `emit` and `sleep`; US-002 adds `readRange`. The third parameter is optional throughout, so both existing `followLogs` call sites in `src/commands/logs.ts` keep compiling unchanged.

Two behaviours change in the loop body:

- The incremental read becomes **byte-aligned**: the offset and the read live in the same domain, so the appended range is obtained by byte position rather than by slicing a decoded string. `BunFile` exposes a byte-ranged read that satisfies this. This also removes the whole-file re-read and re-decode on every tick.
- The offset is **resynchronised when the file shrinks**. Today the loop only acts when `currentSize > lastSize`, so an in-place truncation leaves `lastSize` stale forever and the tail goes permanently silent.

Output currently goes through direct `console.log` calls. Those move behind an injectable `emit` dependency so a test can capture emitted lines; the default `emit` preserves today's behaviour. Bun-native APIs only, per `project-conventions.md`.

`logsCommand` gains an optional signal that it forwards to `followLogs`. Its two existing call sites stay gated on `options.follow`; passing nothing preserves today's run-until-Ctrl-C behaviour.

**`logsCommand` must keep resolving to `undefined`.** It consumes `followLogs`' outcome internally and does not propagate it — each call site keeps its bare `return`. This is load-bearing: `test/unit/commands/logs.test.ts` carries eight live `resolves.toBeUndefined()` assertions over `logsCommand`, none of them inside a skipped block. Returning the outcome from `logsCommand` would break all eight, and this spec does not authorise weakening them. Pinned by US-001 AC-6.

### Failure Handling

| Condition | Behaviour | Covered by |
|:---|:---|:---|
| Signal already aborted when `followLogs` is entered | Return `"cancelled"` before any read or sleep | US-001 AC-1 |
| Signal aborted while waiting between polls | The delay rejects; convert to a normal `"cancelled"` return, never a thrown rejection | US-001 AC-2 |
| Appended line is not valid JSON | Skip that line, continue the tail, still emit the following valid entry | US-002 AC-4 |
| Followed file truncated in place (size shrinks) | Resynchronise the offset to the new size and resume emitting subsequent appends | US-002 AC-5 |
| Followed file deleted or rotated to a different path | Out of scope — see below | — |

## Out of Scope

- Following a log file across rotation to a **different path or inode** is not addressed; only in-place truncation of the same path is handled.
- Making the 500 ms poll interval configurable, or replacing polling with filesystem watch notifications, is not addressed.
- Replacing the console-based output in `src/commands/logs-formatter.ts` with the project logger is not addressed; this spec only routes the existing output through an injectable dependency.
- Following more than one run or more than one log file in a single invocation is not addressed.
- Changing the JSONL log format, the `LogEntry` shape, or the filtering semantics of `--story`, `--level`, and `--json` is not addressed.
- The remaining findings of the 2026-08-20 gap analysis — the CI bundle-build step, the per-file coverage floor, the `.gitignore` run-artifact entries, the deprecation-shim inventory, and the rule-based optimizer decision — are not addressed by this spec.

## Stories

**US-001 — Cancellation and output seam for `followLogs`** *(no dependencies)*

Give `followLogs` an `AbortSignal` and a `Partial<Deps>` override merged over a module-level default, mirroring `waitForSchedule` in `src/schedule/wait.ts`. The function returns `"cancelled"` when the signal fires — at the top of the loop, or via the delay's abort-rejection. Output moves behind an injectable `emit`; the inter-poll wait moves behind an injectable `sleep` defaulting to `cancellableDelay`. `logsCommand` accepts an optional signal and forwards it to both of its `followLogs` call sites. The read logic is **unchanged** in this story.

- Context Files: `src/commands/logs-formatter.ts`, `src/commands/logs.ts`, `src/schedule/wait.ts`, `src/utils/bun-deps.ts`, `test/unit/commands/logs.test.ts`
- Fixtures for this story use **ASCII-only** log content, so its criteria pass independently of the byte-offset defect that US-002 fixes.

**US-002 — Byte-correct incremental tailing** *(depends on US-001)*

Replace the string-sliced incremental read with a byte-aligned one so the offset and the read share a domain, eliminating the drift that silently drops entries. Stop re-reading and re-decoding the whole file on every poll. Resynchronise the offset when the file shrinks.

- Context Files: `src/commands/logs-formatter.ts`, `src/logger/types.ts`, `test/unit/commands/logs.test.ts`
- Fixtures for this story **must contain non-ASCII characters** in at least one entry's `message` (for example the run formatter's `✓` glyph), unlike US-001's ASCII-only fixtures. An ASCII-only fixture cannot distinguish the fixed implementation from the current one.

### Seams

- **US-001 produces the signal parameter that `logsCommand` consumes.** `logsCommand` is the outermost entry point a user reaches (`bin/nax.ts:1196`), and it reaches `followLogs` only when `options.follow` is true — so the consuming criterion must set `follow: true` in its own fixture. Verified present at `src/commands/logs.ts:53` and `:92`. Pinned by US-001 AC-6.
- **US-001 produces the `emit` and `sleep` dependencies that every US-002 criterion consumes.** US-002 has no way to observe emitted lines or to advance the poll loop deterministically without them, which is why US-002 depends on US-001 rather than running beside it.

### Modifies

**US-001**

- `test/unit/commands/logs.test.ts` — the six `test.skip` stubs across the follow-mode, story-filter, level-filter and json describe blocks are empty bodies that assert nothing and defer to an integration file that does not exist; they must become real tests driving the new signal and dependency seam, and the dangling path reference in the block comment must go. This authorisation covers those six skipped stubs only — the eight live `resolves.toBeUndefined()` assertions over `logsCommand` elsewhere in the file state an invariant this spec preserves and must not be weakened or deleted.
- `test/integration/cli/cli-core-logs.test.ts` — the skipped follow-mode test names the missing cancellation hook as its reason for skipping; it must drive `logsCommand` with an abort signal instead.

**US-002**

- `test/unit/commands/logs.test.ts` — the same file gains the byte-offset, truncation and malformed-line criteria; any follow-mode expectation that pins the pre-fix read behaviour must be replaced by the invariant that every appended entry is emitted exactly once regardless of the byte width of preceding characters.

## Acceptance Criteria

### US-001 — Cancellation and output seam for `followLogs`

Fixtures for every criterion below use ASCII-only log content.

1. `[unit]` Calling `followLogs` with a log file containing one valid entry and a signal that is already aborted resolves to the string `"cancelled"`, and the injected `emit` dependency receives no lines.

2. `[unit]` With an injected `sleep` dependency that rejects on its first invocation to simulate an abort during the inter-poll wait, `followLogs` resolves to `"cancelled"` rather than rejecting.

3. `[unit]` Calling `followLogs` on a log file containing two valid entries, with a signal aborted by the injected `sleep` on its first invocation, causes the injected `emit` dependency to receive both pre-existing entries, in file order, before the function resolves.

4. `[unit]` A `story` filter supplied in the options object is honoured through the injected `emit` dependency: given a file with one entry whose `storyId` is `US-001` and one whose `storyId` is `US-002`, following with `story` set to `US-001` emits only the first entry.

5. `[unit]` Calling `followLogs` with an already-aborted signal and **no** dependency override resolves to `"cancelled"`, confirming the default dependency object is complete and that the abort check precedes any dependency use.

6. `[integration]` Calling `logsCommand` with `follow` set to `true`, a resolvable run, and an already-aborted signal resolves to `undefined` instead of running indefinitely — confirming both that the signal reaches `followLogs` through the `options.follow` branch and that `logsCommand` does not propagate the `"cancelled"` outcome to its caller.

### US-002 — Byte-correct incremental tailing

Fixtures for every criterion below contain at least one entry whose `message` includes non-ASCII characters, unlike US-001's ASCII-only fixtures.

1. `[unit]` Given a log file whose first entry's `message` contains three `✓` characters, appending one further valid entry and allowing exactly one poll causes the injected `emit` dependency to receive that appended entry with its `message` field intact.

2. `[unit]` Appending three successive valid entries, each containing at least one `✓` character, across three polls causes the injected `emit` dependency to receive all three appended entries in append order, confirming the read offset does not accumulate drift.

3. `[unit]` Across a call that emits pre-existing entries and then observes two appends, the injected `emit` dependency receives each entry exactly once; no entry emitted before an append is emitted again after it.

4. `[unit]` A line that is not valid JSON, appended between two valid entries containing `✓` characters, is skipped without rejecting, and the valid entry appended after it is still emitted.

5. `[unit]` When the followed file is rewritten to a shorter length than the offset already observed, `followLogs` resynchronises to the new length and emits an entry appended after that truncation.

6. `[unit]` On the poll following an append, the injected `readRange` dependency is invoked with a start offset equal to the byte length of the content already consumed, not `0`, confirming the tail reads only the appended range rather than the whole file.
