# Test-Failure Message Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `Error:` text nax hands a rectifying agent be that test's own failure message, for every supported framework.

**Architecture:** The Bun sub-parser scans *forward* from the `(fail)` line for a failure's message, but Bun prints the message *before* that line. Every failure therefore receives the next failure's code frame, and the last failure in a run receives `"Unknown error"`. Fix the direction for Bun, add a cross-framework regression guard so the same class cannot recur in the other five sub-parsers, and stop discarding the stack frames the parsers already collect. No change to counts, to gate verdicts, or to the agent's own in-loop test runs.

**Tech Stack:** TypeScript, Bun (`bun:test`), no new dependencies.

**Spec:** No separate spec file — the evidence, the verified reproduction, and the scope boundary are inline in "Background" below. Source analysis: `projects/nax/nax-implementer-test-writer-prompt-enhancement-2026-09-19.md` (outside this repo; §F-2 of rev 2).

## Global Constraints

- Repo root for all paths: the worktree root (this file is at `docs/superpowers/plans/`). Branch: `feat/test-failure-message-extraction`, based on `origin/main` @ `e0659eb7f`.
- **Never run bare `bun test`.** Use the repo's declared commands only: `bun run test` (full suite), `CI=1 AGENT=1 bun test --timeout=60000 <files>` (scoped — this is the repo's declared `quality.commands.testScoped`). A bare `bun test` gives a confident false signal in this repo.
- Static gates, all must pass before the final commit: `bun x tsc --noEmit`, `bun x tsc --noEmit -p tsconfig.test.json`, `AGENT=1 bun run lint:biome`, `AGENT=1 bun run check:all-without-biome`.
- **File-size ratchet (`scripts/check-file-sizes.ts`, part of `check:all-without-biome`):** 600 lines for `src/**/*.ts`, 800 for `test/**/*.test.ts`. `src/test-runners/parser.ts` is at **599 of 600** — it has one line of headroom. This is why Task 1 exists and why it must land first.
- `src/test-runners/` is the parsing SSOT (ADR-009). Do not inline framework-detection or output-parsing logic anywhere else.
- Conventional commits: `fix:`, `refactor:`, `test:`. Commit at the end of each task.
- Do not edit `.claude/rules/` — it is generated from `.nax/rules/` by `nax rules export` and enforced by a pre-commit hook.

---

## Background — the defect, verified

### What was observed

A real rectification prompt (`~/.nax/nax/prompt-audit/native-agent-scratchpad/…-us-003-implementer-rectification-t02.txt`) listed 46 failing tests. The `Error:` field of every one was unusable:

```
- test/unit/runtime/session-run-hop.test.ts
  Test: createSessionRunHop > preserves handle protocolIds and internalRoundTrips
  Error: 84 |       closeSession: mock(async () => {}),

- test/unit/runtime/session-run-hop.test.ts
  Test: createSessionRunHop > records a handoff when the descriptor names a different agent
  Error: 110 |

- test/unit/runtime/session-run-hop.test.ts
  Test: AC10 (boundary): native without declaredTools falls back to the shell body
  Error: Unknown error
```

That session then ran for 94 model calls / 763 seconds, followed by 74 more on the next turn.

A separate session was dispatched to fix one test whose reported error was `(node:79387) Warning: [finish-pr] Failed to write PR title/body` — an interleaved stderr warning from an unrelated tool. The agent re-ran the test three times, found it green, and emitted UNRESOLVED.

### Why — reproduced

Run a file with two failing tests (`bun test v1.4.0`):

```
 3  g.test.ts:
 4  1 | import { test, expect } from "bun:test";
 5  2 | test("first failure", () => { expect(1 + 2).toBe(4); });
 6                                                  ^
 7  error: expect(received).toBe(expected)
 8
 9  Expected: 4
10  Received: 3
11
12        at <anonymous> (/abs/path/g.test.ts:2:45)
13  (fail) first failure [0.12ms]
14  1 | import { test, expect } from "bun:test";
15  2 | test("first failure", () => { expect(1 + 2).toBe(4); });
16  3 | test("second failure", () => { expect("a").toBe("b"); });
17                                               ^
18  error: expect(received).toBe(expected)
19
20  Expected: "b"
21  Received: "a"
22
23        at <anonymous> (/abs/path/g.test.ts:3:44)
24  (fail) second failure [1.17ms]
25
26   0 pass
27   2 fail
```

**Bun prints the code frame, the `error:` line, the `Expected:`/`Received:` pair and the stack BEFORE its `(fail)` line.** The `(fail)` line, which carries the test's name, comes last.

`parseBunOutput` (`src/test-runners/parser.ts:119-152`) matches the `(fail)` line, then steps *past* it (`i++`) and takes the first non-blank line *below* as the error. So:

- `first failure` (line 13) takes line 14 — `1 | import { test, expect } from "bun:test";` — which belongs to the *second* failure's code frame.
- `second failure` (line 24) hits blank line 25, the loop breaks on `!nextLine.trim()`, `error` stays `""`, and it falls back to `"Unknown error"`.

It is an off-by-one across the whole list. This matches the artifact exactly: the 46-test list contained exactly three `Unknown error` entries, each the last failure of its file group.

The docstring above the function (`parser.ts:66-78`) documents the *opposite* layout — `(fail)` first, then `Error:`. That invented example is the false premise the forward scan was written against. Correct it in Task 2.

### Why it survived

`test/unit/test-runners/parser.test.ts` has a Bun block ("file attribution and (fail) name parsing", lines 374-418) that asserts only `file` and `testName`. Every `failures[0].error` assertion in that file targets the **Go** or **pytest** formats, where the message genuinely does follow the marker, so forward scanning is correct there. **The Bun `error` field has no test at all.**

### Per-framework layout — which sub-parsers are affected

| Framework | Failure marker | Message position | Forward scan correct? |
|---|---|---|---|
| **bun** | `(fail) <name> [Nms]` | **before** the marker | **NO — the defect** |
| jest / vitest | `  ● <name>` | after | yes |
| pytest | `FAILED <path>::<test> - <reason>` | same line | n/a (self-contained) |
| go | `--- FAIL: <Name> (0.00s)` | after (indented) | yes |
| rust | `---- <name> stdout ----` | after | yes |
| mocha | `<N>) <name>` | after | yes |

**Bun is the only inverted layout.** "Language-agnostic" here does not mean applying a backward scan everywhere — it means (a) fixing the one framework that is wrong, and (b) adding a guard that holds *all six* to the same contract so the next framework added cannot reintroduce the class. Task 3 is that guard.

### Scope boundary — things that look adjacent but are already handled

Do **not** implement these; they exist:

- **Unknown/unsupported frameworks producing zero structured failures.** Already covered. `src/operations/full-suite-gate.ts:306-336` emits `executionFailureToFinding(...)` (command + exit code + last 40 lines of raw output) whenever `testSummaryToFindings` returns empty, and `src/execution/lifecycle/run-regression.ts:49-62` does the same with a 2000-char raw-output slice. A non-listed language whose runner exits non-zero already reaches the agent with real output.
- **Failure counts.** `passed`/`failed` are computed from the `(fail)`/glyph lines plus an authoritative summary-line backstop, and are correct. This plan must not change them.
- **The agent's own test runs.** `RunCommand` returns `exit <code>\n<stdout>\n<stderr>` raw (`src/tools/run-command-exec.ts:88`); nothing in `src/tools/` or `src/agents/` calls a parser. The agent already sees correct output. No change.

### Affected consumers (why this matters beyond one prompt)

```
parseTestOutput → TestFailure.error
  → testFailureToFinding (src/findings/adapters/test-failure.ts:4-13)   message: failure.error
    → formatFailingTestsList (src/prompts/builders/rectifier-builder-helpers.ts:389-400)   `Error: ${f.message}`
```

Sites that render the string: `src/operations/full-suite-gate.ts:306`, `src/execution/lifecycle/run-regression.ts:318,440,464`, `src/prompts/builders/acceptance-builder-helpers.ts:17` (via `formatFailureSummary`). `src/verification/flake-probe.ts:199` uses counts only and is unaffected.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/test-runners/parse-bun.ts` | **create** | Bun sub-parser: counts + backward failure-detail extraction. Mirrors the existing `parse-mocha.ts` / `parse-rust.ts` one-file-per-framework pattern. |
| `src/test-runners/parser.ts` | modify | Dispatcher + jest/pytest/go/common sub-parsers. Loses the Bun body (599 → ~520 lines, restoring headroom under the 600 ratchet). |
| `src/test-runners/index.ts` | modify | Re-export `parseBunOutput` alongside `parseMochaOutput` / `parseRustTestOutput`. |
| `src/findings/adapters/test-failure.ts` | modify | Fold the collected stack frames into `Finding.message` so they survive into the rectifier prompt. |
| `test/unit/test-runners/parse-bun.test.ts` | **create** | Bun extraction regression tests (Task 2). |
| `test/unit/test-runners/parser-failure-message-contract.test.ts` | **create** | Cross-framework guard: every failure carries its own message (Task 3). |
| `test/unit/findings/test-failure-adapter.test.ts` | **create** | Stack frames reach `Finding.message` (Task 4). |

Task 1 is a pure move with no behaviour change, so it can be reviewed and rejected independently of the fix. Tasks 2-4 each change one observable behaviour.

---

### Task 1: Extract the Bun sub-parser into its own file

Pure refactor. No behaviour change. It lands first because `src/test-runners/parser.ts` is at 599 of the ratchet's 600 lines, so Task 2's helper cannot be added until the Bun body moves out.

**Files:**
- Create: `src/test-runners/parse-bun.ts`
- Modify: `src/test-runners/parser.ts` (delete lines 62-180 — the `parseBunOutput` docstring and function; change the `case "bun":` arm to call the import)
- Modify: `src/test-runners/index.ts` (add the re-export)
- Test: no new test — `test/unit/test-runners/parser.test.ts` must stay green unchanged, which is the proof the move was behaviour-preserving.

**Interfaces:**
- Consumes: `TestFailure`, `TestSummary` from `./types`.
- Produces: `export function parseBunOutput(output: string): TestSummary` — imported by `parser.ts` and re-exported from `index.ts`. Tasks 2 and 3 both import it.

- [ ] **Step 1: Record the current line count and the current green baseline**

```bash
wc -l src/test-runners/parser.ts
CI=1 AGENT=1 bun test --timeout=60000 test/unit/test-runners/parser.test.ts
```

Expected: `599 src/test-runners/parser.ts`, and the test file passes. Write both numbers down — Step 5 compares against them.

- [ ] **Step 2: Create `src/test-runners/parse-bun.ts` with the body moved verbatim**

Move the function exactly as it is today. Do not fix anything yet — a refactor that also changes behaviour cannot be reviewed as a refactor. The `while` loop below is the buggy forward scan; it is reproduced here on purpose and replaced in Task 2.

```ts
/**
 * Bun `bun test` output parser.
 *
 * Pure function — no I/O, no throws. Split out of parser.ts so the Bun
 * layout's extraction logic has room to live beside its own regexes, and to
 * match the one-file-per-framework shape of parse-mocha.ts / parse-rust.ts.
 */
import type { TestFailure, TestSummary } from "./types";

export function parseBunOutput(output: string): TestSummary {
  const lines = output.split("\n");
  const failures: TestFailure[] = [];
  let passed = 0;
  let failed = 0;
  let currentFile = "";
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Extract file path from headers like "test/example.test.ts:" — also matches
    // .test.tsx/.spec.ts/.test.mts/.test.cts, not just .test.ts/.test.js.
    if (/\.(?:test|spec)\.[cm]?[jt]sx?:$/.test(line.trim())) {
      currentFile = line.trim().replace(/:$/, "");
      i++;
      continue;
    }

    // Count passed tests (✓ or ✔)
    if (line.includes("✓") || line.includes("✔")) {
      passed++;
      i++;
      continue;
    }

    // Count failed tests (✗ or ✘)
    if (line.includes("✗") || line.includes("✘")) {
      failed++;
      i++;
      continue;
    }

    // Parse failure line: "(fail) TestName > nested > name [duration]"
    // Do not increment failed here. In verbose mode, the ✗ glyph line above already
    // counted this failure. In batch mode, no ✗ lines are emitted — the summary-line
    // backstop below (Math.max) corrects the count from the authoritative summary.
    // Anchored to end-of-line with a greedy capture, so a name containing its own
    // "[Nms]"-shaped substring captures up to the LAST duration marker.
    const failMatch = line.match(/^\(fail\)\s+(.+)\s+\[[\d.]+m?s\]\s*$/);
    if (failMatch) {
      const testName = failMatch[1].trim();
      i++;

      let error = "";
      const stackTrace: string[] = [];
      let stackLineCount = 0;

      while (i < lines.length && stackLineCount < 5) {
        const nextLine = lines[i];
        if (!nextLine.trim() || nextLine.includes("(fail)") || nextLine.includes("✓") || nextLine.includes("✗")) {
          break;
        }
        if (!error && nextLine.trim()) {
          error = nextLine.trim();
          i++;
          continue;
        }
        if (nextLine.trim().startsWith("at ")) {
          stackTrace.push(nextLine.trim());
          stackLineCount++;
        }
        i++;
      }

      failures.push({
        file: currentFile || "unknown",
        testName,
        error: error || "Unknown error",
        stackTrace,
      });
      continue;
    }

    i++;
  }

  // Backstop: bun summary lines are authoritative — they are the canonical source of truth.
  // The summary is more reliable than per-line counts because it's the global total.
  // Bun summary can appear in multiple formats:
  //   "X pass, Y fail [duration]"  (batch output)
  //   "X passed, Y failed [duration]"  (verbose output)
  //   "X tests passed [duration]"  (all-pass output)
  // Match the last occurrence of each to handle multi-file runs.
  const summaryPassMatches = Array.from(output.matchAll(/^\s*(\d+)\s+(?:tests?\s+)?(?:pass|passed)\b.*$/gm));
  const summaryFailMatches = Array.from(output.matchAll(/^\s*(\d+)\s+(?:fail|failed)\b.*$/gm));
  if (summaryPassMatches.length > 0) {
    passed = Math.max(passed, Number.parseInt(summaryPassMatches[summaryPassMatches.length - 1][1], 10));
  }
  if (summaryFailMatches.length > 0) {
    failed = Math.max(failed, Number.parseInt(summaryFailMatches[summaryFailMatches.length - 1][1], 10));
  }

  // BUG-060: If we have no summary fail count but have failures from (fail) lines,
  // use the failure count as the backstop. This handles truncated output (e.g. OOM kill,
  // crash mid-run) where bun never emitted the summary line.
  if (summaryFailMatches.length === 0 && failures.length > failed) {
    failed = failures.length;
  }

  return { passed, failed, failures };
}
```

- [ ] **Step 3: Delete the old body from `parser.ts` and wire the import**

In `src/test-runners/parser.ts`:

1. Delete lines 62-180 inclusive (the `/** Parse Bun test output. … */` docstring block through the closing `}` of `parseBunOutput`, ending just before the `/**` of the Jest parser).
2. Add the import beside the two existing sibling imports (keep them alphabetical — biome enforces import order):

```ts
import { parseBunOutput } from "./parse-bun";
import { parseMochaOutput } from "./parse-mocha";
import { parseRustTestOutput } from "./parse-rust";
```

3. Leave the `case "bun": return parseBunOutput(clean);` arm exactly as it is — the call site is unchanged; only the definition moved.

- [ ] **Step 4: Re-export from the barrel**

In `src/test-runners/index.ts`, add the export next to the existing sibling exports:

```ts
export { parseBunOutput } from "./parse-bun";
export { parseMochaOutput } from "./parse-mocha";
export { parseRustTestOutput } from "./parse-rust";
```

- [ ] **Step 5: Verify the move changed nothing and freed the headroom**

```bash
wc -l src/test-runners/parser.ts src/test-runners/parse-bun.ts
CI=1 AGENT=1 bun test --timeout=60000 test/unit/test-runners/parser.test.ts
bun x tsc --noEmit
bun scripts/check-file-sizes.ts
```

Expected: `parser.ts` now ~520 lines (well under 600); `parser.test.ts` passes with the **same** pass count as Step 1; typecheck clean; file-size gate exits 0.

If the test count differs from Step 1, the move was not verbatim — diff the moved function against `git show HEAD:src/test-runners/parser.ts | sed -n '62,180p'` and fix before continuing.

- [ ] **Step 6: Commit**

```bash
git add src/test-runners/parse-bun.ts src/test-runners/parser.ts src/test-runners/index.ts
git commit -m "refactor(test-runners): extract Bun sub-parser into parse-bun.ts

parser.ts sat at 599/600 under the file-size ratchet, leaving no room for
the Bun extraction fix. Moves the body verbatim (no behaviour change) and
matches the one-file-per-framework shape of parse-mocha.ts / parse-rust.ts."
```

---

### Task 2: Extract the Bun failure message by scanning backward

The fix. Bun's message block sits *above* its `(fail)` line, bounded by the previous `(fail)` line, a pass/fail glyph line, or the file header.

**Files:**
- Modify: `src/test-runners/parse-bun.ts` (replace the forward `while` scan with a helper; correct the docstring)
- Test: `test/unit/test-runners/parse-bun.test.ts` (create)

**Interfaces:**
- Consumes: `parseBunOutput(output: string): TestSummary` from Task 1.
- Produces: no new exported symbol. `extractBunFailureDetail` and `isBunBlockBoundary` stay module-private — Task 3 tests them only through `parseBunOutput`.
- Behaviour contract later tasks rely on: when no message can be found, `TestFailure.error` is the exact literal `"no assertion message captured"` (never `"Unknown error"`, never a borrowed line).

- [ ] **Step 1: Write the failing tests**

Create `test/unit/test-runners/parse-bun.test.ts`. The first test is the off-by-one guard: it asserts each failure carries *its own* message, which is precisely what the forward scan cannot do.

```ts
/**
 * parseBunOutput — failure-message extraction.
 *
 * Bun prints the code frame, the `error:` line, the Expected/Received pair and
 * the stack BEFORE the `(fail)` line that names the test. Fixtures below are
 * verbatim `bun test v1.4.0` output, so they pin the real layout rather than a
 * reconstruction of it.
 */
import { describe, expect, test } from "bun:test";
import { parseBunOutput } from "@/test-runners/parse-bun";

// Verbatim `bun test g.test.ts` output for a file with two failing tests.
const TWO_FAILURES = [
  "bun test v1.4.0 (34cbb9a40)",
  "",
  "g.test.ts:",
  '1 | import { test, expect } from "bun:test";',
  '2 | test("first failure", () => { expect(1 + 2).toBe(4); });',
  "                                                ^",
  "error: expect(received).toBe(expected)",
  "",
  "Expected: 4",
  "Received: 3",
  "",
  "      at <anonymous> (/abs/path/g.test.ts:2:45)",
  "(fail) first failure [0.12ms]",
  '1 | import { test, expect } from "bun:test";',
  '2 | test("first failure", () => { expect(1 + 2).toBe(4); });',
  '3 | test("second failure", () => { expect("a").toBe("b"); });',
  "                                               ^",
  "error: expect(received).toBe(expected)",
  "",
  'Expected: "b"',
  'Received: "a"',
  "",
  "      at <anonymous> (/abs/path/g.test.ts:3:44)",
  "(fail) second failure [1.17ms]",
  "",
  " 0 pass",
  " 2 fail",
  " 2 expect() calls",
  "Ran 2 tests across 1 file. [3.00ms]",
].join("\n");

describe("parseBunOutput — each failure carries its OWN message", () => {
  test("the first failure gets its own Expected/Received, not the next failure's code frame", () => {
    const r = parseBunOutput(TWO_FAILURES);

    const first = r.failures.find((f) => f.testName === "first failure");
    expect(first?.error).toContain("expect(received).toBe(expected)");
    expect(first?.error).toContain("Expected: 4");
    expect(first?.error).toContain("Received: 3");
    // The regression: it used to receive the SECOND failure's code frame.
    expect(first?.error).not.toContain("import { test, expect }");
    expect(first?.error).not.toContain('Expected: "b"');
  });

  test("the LAST failure gets a real message rather than the Unknown error fallback", () => {
    const r = parseBunOutput(TWO_FAILURES);

    const last = r.failures.find((f) => f.testName === "second failure");
    expect(last?.error).toContain('Expected: "b"');
    expect(last?.error).toContain('Received: "a"');
    expect(last?.error).not.toBe("Unknown error");
  });

  test("the stack frame above each (fail) line is attributed to that failure", () => {
    const r = parseBunOutput(TWO_FAILURES);

    expect(r.failures.find((f) => f.testName === "first failure")?.stackTrace).toEqual([
      "at <anonymous> (/abs/path/g.test.ts:2:45)",
    ]);
    expect(r.failures.find((f) => f.testName === "second failure")?.stackTrace).toEqual([
      "at <anonymous> (/abs/path/g.test.ts:3:44)",
    ]);
  });

  test("counts and names are unchanged by the extraction rewrite", () => {
    const r = parseBunOutput(TWO_FAILURES);

    expect(r.passed).toBe(0);
    expect(r.failed).toBe(2);
    expect(r.failures.map((f) => f.testName)).toEqual(["first failure", "second failure"]);
    expect(r.failures.every((f) => f.file === "g.test.ts")).toBe(true);
  });
});

describe("parseBunOutput — interleaved stderr is not a failure message", () => {
  test("a (node:NNN) warning between blocks is never adopted as a test's error", () => {
    const output = [
      "test/unit/config/scoped-permissions.test.ts:",
      "error: expect(received).toEqual(expected)",
      "",
      "Expected: 3",
      "Received: 4",
      "",
      "(fail) resolvePermissions > safe > grants read tools only [2.0ms]",
      "(node:79387) Warning: [finish-pr] Failed to write PR title/body",
      "",
      " 0 pass",
      " 1 fail",
    ].join("\n");

    const r = parseBunOutput(output);

    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].error).toContain("expect(received).toEqual(expected)");
    expect(r.failures[0].error).not.toContain("finish-pr");
    expect(r.failures[0].error).not.toContain("node:79387");
  });
});

describe("parseBunOutput — no message available", () => {
  test("a (fail) line with no preceding message block reports the explicit placeholder", () => {
    const output = ["test/foo.test.ts:", "(fail) bare failure [1ms]", "", " 0 pass", " 1 fail"].join("\n");

    const r = parseBunOutput(output);

    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].error).toBe("no assertion message captured");
  });

  test("a message block is never borrowed across a file header", () => {
    const output = [
      "test/a.test.ts:",
      "error: this belongs to a.test.ts",
      "(fail) failure in a [1ms]",
      "test/b.test.ts:",
      "(fail) failure in b [1ms]",
      "",
      " 0 pass",
      " 2 fail",
    ].join("\n");

    const r = parseBunOutput(output);

    expect(r.failures.find((f) => f.testName === "failure in a")?.error).toBe("this belongs to a.test.ts");
    expect(r.failures.find((f) => f.testName === "failure in b")?.error).toBe("no assertion message captured");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
CI=1 AGENT=1 bun test --timeout=60000 test/unit/test-runners/parse-bun.test.ts
```

Expected: FAIL. Specifically — "the first failure gets its own Expected/Received" fails because `error` is `1 | import { test, expect } from "bun:test";`, and "the LAST failure gets a real message" fails because `error` is `"Unknown error"`. If either of those two passes right now, stop: the fixture does not reproduce the defect and the rest of the task is unverified.

- [ ] **Step 3: Replace the forward scan with a backward one**

In `src/test-runners/parse-bun.ts`:

**(a)** Add the constants and helpers above `parseBunOutput`:

```ts
/** Emitted when a `(fail)` line has no recoverable message block above it.
 *  An explicit admission beats a borrowed line: a stray line sends the agent
 *  chasing an unrelated file, which is the failure mode this parser caused. */
const NO_MESSAGE = "no assertion message captured";

const MAX_STACK_LINES = 5;
/** A Bun code-frame line: "  12 | const x = 1;" */
const CODE_FRAME_RE = /^\s*\d+\s*\|/;
/** The caret line Bun prints under the failing expression. */
const CARET_RE = /^\^+$/;
/** Node stderr that can interleave anywhere, e.g. "(node:79387) Warning: …" */
const NODE_STDERR_RE = /^\(node:\d+\)/;
/** The "Expected:" / "Received:" pair Bun prints under the `error:` line. */
const EXPECTATION_RE = /^(?:Expected|Received):/;
/** A test-file header line, e.g. "test/foo.test.ts:" */
const FILE_HEADER_RE = /\.(?:test|spec)\.[cm]?[jt]sx?:$/;

/**
 * True when `trimmed` ends the message block belonging to the failure below it.
 *
 * A block is bounded above by the previous failure's `(fail)` line, by a
 * per-test pass/fail glyph (verbose mode), or by the file header. Stopping at
 * these is what keeps one failure from borrowing another's message.
 */
function isBlockBoundary(trimmed: string): boolean {
  if (/^\(fail\)\s/.test(trimmed)) return true;
  if (/[✓✔✗✘]/.test(trimmed)) return true;
  if (FILE_HEADER_RE.test(trimmed)) return true;
  return false;
}

/**
 * Collect the failure detail printed ABOVE `failIndex`.
 *
 * Bun's layout is: code frame, caret, `error: <message>`, blank,
 * `Expected:` / `Received:`, blank, `at …` frames, then `(fail) <name>`.
 * Scanning forward from `(fail)` — as this parser did until 2026-09-19 —
 * lands in the NEXT failure's code frame, and on the last failure lands in
 * the summary. Hence the backward walk.
 */
function extractBunFailureDetail(lines: string[], failIndex: number): { error: string; stackTrace: string[] } {
  const block: string[] = [];
  for (let j = failIndex - 1; j >= 0; j--) {
    if (isBlockBoundary(lines[j].trim())) break;
    block.unshift(lines[j]);
  }

  let errorLine = "";
  const expectation: string[] = [];
  const stackTrace: string[] = [];

  for (const raw of block) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (CODE_FRAME_RE.test(raw)) continue;
    if (CARET_RE.test(trimmed)) continue;
    if (NODE_STDERR_RE.test(trimmed)) continue;
    if (trimmed.startsWith("at ")) {
      if (stackTrace.length < MAX_STACK_LINES) stackTrace.push(trimmed);
      continue;
    }
    if (EXPECTATION_RE.test(trimmed)) {
      expectation.push(trimmed);
      continue;
    }
    if (!errorLine) errorLine = trimmed.replace(/^error:\s*/i, "");
  }

  const parts = [errorLine, ...expectation].filter(Boolean);
  return { error: parts.length > 0 ? parts.join(" ") : NO_MESSAGE, stackTrace };
}
```

**(b)** Replace the whole `if (failMatch) { … }` body (the `i++`, the `let error`, the inner `while`, and the `failures.push`) with:

```ts
    const failMatch = line.match(/^\(fail\)\s+(.+)\s+\[[\d.]+m?s\]\s*$/);
    if (failMatch) {
      const testName = failMatch[1].trim();
      const detail = extractBunFailureDetail(lines, i);
      failures.push({
        file: currentFile || "unknown",
        testName,
        error: detail.error,
        stackTrace: detail.stackTrace,
      });
      i++;
      continue;
    }
```

The outer loop now walks every line exactly once. Lines the old inner scan used to consume (code frames, `at …`, `Expected:`) fall through to the final `i++` and match nothing — they are not file headers and carry no glyphs, so the counters are untouched.

**(c)** Replace the file's docstring example with the real layout. The current one inverts it and is what the forward scan was written against:

```ts
/**
 * Bun `bun test` output parser.
 *
 * Pure function — no I/O, no throws.
 *
 * Real `bun test v1.4.0` layout — note the message precedes the `(fail)` line:
 * ```
 * test/example.test.ts:
 * 1 | import { test, expect } from "bun:test";
 * 2 | test("adds", () => { expect(1 + 2).toBe(4); });
 *                                        ^
 * error: expect(received).toBe(expected)
 *
 * Expected: 4
 * Received: 3
 *
 *       at <anonymous> (/abs/path/example.test.ts:2:40)
 * (fail) adds [0.12ms]
 *
 *  0 pass
 *  1 fail
 * ```
 */
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
CI=1 AGENT=1 bun test --timeout=60000 test/unit/test-runners/parse-bun.test.ts test/unit/test-runners/parser.test.ts
```

Expected: PASS, both files. `parser.test.ts` must be unchanged and still green — its Bun block asserts `file` and `testName`, which this task does not touch.

- [ ] **Step 5: Prove it against real Bun output, not just the fixture**

The fixture was transcribed from a real run, but confirm the live runner still matches — a Bun upgrade could move the layout again.

```bash
mkdir -p /tmp/bun-layout-check && cat > /tmp/bun-layout-check/g.test.ts <<'EOF'
import { test, expect } from "bun:test";
test("first failure", () => { expect(1 + 2).toBe(4); });
test("second failure", () => { expect("a").toBe("b"); });
EOF
cd /tmp/bun-layout-check && bun test g.test.ts 2>&1 | tee /tmp/bun-layout-check/out.txt
```

Confirm by eye that each `error:` line appears ABOVE its `(fail)` line. Then check the parser reads it:

```bash
cd -
bun -e 'import {parseBunOutput} from "./src/test-runners/parse-bun"; const o=require("node:fs").readFileSync("/tmp/bun-layout-check/out.txt","utf8"); console.log(JSON.stringify(parseBunOutput(o).failures,null,2))'
```

Expected: two failures; `first failure` carries `Expected: 4` / `Received: 3`, `second failure` carries `Expected: "b"` / `Received: "a"`. Neither says `Unknown error`, neither contains `import { test, expect }`.

- [ ] **Step 6: Commit**

```bash
git add src/test-runners/parse-bun.ts test/unit/test-runners/parse-bun.test.ts
git commit -m "fix(test-runners): read Bun failure messages from above the (fail) line

Bun prints the code frame, the error: line, Expected/Received and the stack
BEFORE the (fail) line that names the test. The parser scanned forward from
(fail), so every failure received the NEXT failure's code frame and the last
failure in a run received \"Unknown error\" — an off-by-one across the whole
list, reaching every rectification, regression and acceptance prompt.

Scans backward to the nearest block boundary (previous (fail), a pass/fail
glyph, or the file header) so a message can never be borrowed across
failures, skips code frames, carets and interleaved (node:NNN) stderr, and
reports an explicit \"no assertion message captured\" rather than a stray line."
```

---

### Task 3: Hold every framework to the same contract

Task 2 fixed Bun. This guard states the contract the other five already satisfy, so the class cannot return when a framework is added or a sub-parser is edited. It is the test that, had it existed, would have caught the original defect.

**Files:**
- Test: `test/unit/test-runners/parser-failure-message-contract.test.ts` (create)
- No source changes. If a case fails, that is a real defect in that sub-parser — report it; do not weaken the test.

**Interfaces:**
- Consumes: `parseTestOutput(output: string): TestSummary` from `@/test-runners` (the auto-detecting SSOT entry point — deliberately not the per-framework functions, so framework *detection* is exercised too).
- Produces: nothing importable.

- [ ] **Step 1: Write the contract test**

```ts
/**
 * Cross-framework contract: when a runner reports two distinguishable
 * failures, each parsed failure carries ITS OWN message.
 *
 * Bun's layout prints a failure's message BEFORE the line naming the test;
 * every other supported runner prints it after. A parser written against the
 * wrong direction still produces the right COUNT and the right NAMES — only
 * the message is wrong, and it is wrong by one. That is invisible to any
 * assertion on `file`/`testName`, which is why the Bun defect survived: its
 * describe block asserted exactly those two fields and never `error`.
 *
 * Each fixture below therefore contains two failures whose messages are
 * mutually exclusive, so a borrowed message is a hard failure rather than a
 * near-miss. Adding a framework to parseTestOutput means adding a row here.
 */
import { describe, expect, test } from "bun:test";
import { parseTestOutput } from "@/test-runners";

interface Case {
  framework: string;
  output: string;
  /** testName -> a substring that appears ONLY in that failure's own message. */
  expected: Record<string, string>;
}

const CASES: Case[] = [
  {
    framework: "bun",
    output: [
      "g.test.ts:",
      "error: expect(received).toBe(expected)",
      "",
      "Expected: 4",
      "Received: 3",
      "      at <anonymous> (/abs/g.test.ts:2:45)",
      "(fail) alpha [0.12ms]",
      "error: expect(received).toBe(expected)",
      "",
      'Expected: "b"',
      'Received: "a"',
      "      at <anonymous> (/abs/g.test.ts:3:44)",
      "(fail) beta [1.17ms]",
      "",
      " 0 pass",
      " 2 fail",
    ].join("\n"),
    expected: { alpha: "Expected: 4", beta: 'Expected: "b"' },
  },
  {
    framework: "jest",
    output: [
      "FAIL src/alpha.spec.ts",
      "  ● alpha",
      "",
      "    expected 4 received 3",
      "",
      "  ● beta",
      "",
      '    expected "b" received "a"',
      "",
      "Tests:       2 failed, 0 passed, 2 total",
    ].join("\n"),
    expected: { alpha: "expected 4 received 3", beta: 'expected "b" received "a"' },
  },
  {
    framework: "pytest",
    output: [
      "FAILED tests/test_calc.py::test_alpha - AssertionError: assert 3 == 4",
      'FAILED tests/test_calc.py::test_beta - AssertionError: assert "a" == "b"',
      "=================== 2 failed, 0 passed in 0.42s ===================",
    ].join("\n"),
    expected: { test_alpha: "assert 3 == 4", test_beta: 'assert "a" == "b"' },
  },
  {
    framework: "go",
    output: [
      "--- FAIL: TestAlpha (0.00s)",
      "    calc_test.go:12: expected 4 got 3",
      "--- FAIL: TestBeta (0.00s)",
      '    calc_test.go:20: expected "b" got "a"',
      "FAIL\texample.com/calc\t0.002s",
      "FAIL",
    ].join("\n"),
    expected: { TestAlpha: "expected 4 got 3", TestBeta: 'expected "b" got "a"' },
  },
  {
    framework: "rust",
    output: [
      "---- alpha stdout ----",
      "assertion failed: expected 4 got 3",
      "thread 'alpha' panicked at src/lib.rs:12:5:",
      "---- beta stdout ----",
      'assertion failed: expected "b" got "a"',
      "thread 'beta' panicked at src/lib.rs:20:5:",
      "",
      "test result: FAILED. 0 passed; 2 failed;",
    ].join("\n"),
    expected: { alpha: "expected 4 got 3", beta: 'expected "b" got "a"' },
  },
  {
    framework: "mocha",
    output: [
      "  2 failing",
      "",
      "  1) alpha:",
      "     AssertionError: expected 4 got 3",
      "      at Context.<anonymous> (test/calc.spec.js:5:12)",
      "",
      "  2) beta:",
      '     AssertionError: expected "b" got "a"',
      "      at Context.<anonymous> (test/calc.spec.js:9:12)",
      "",
      "  0 passing",
    ].join("\n"),
    expected: { alpha: "expected 4 got 3", beta: 'expected "b" got "a"' },
  },
];

describe("parseTestOutput — every failure carries its own message", () => {
  for (const c of CASES) {
    test(`${c.framework}: both failures parse with distinct, self-owned messages`, () => {
      const r = parseTestOutput(c.output);
      const names = Object.keys(c.expected);

      expect(r.failures.length).toBeGreaterThanOrEqual(names.length);

      for (const [name, ownToken] of Object.entries(c.expected)) {
        const hit = r.failures.find((f) => f.testName.includes(name));
        expect(hit, `${c.framework}: no failure named ${name}`).toBeDefined();
        expect(hit?.error, `${c.framework}/${name} lost its own message`).toContain(ownToken);
      }

      // The off-by-one signature: two failures sharing one message.
      const messages = names.map((n) => r.failures.find((f) => f.testName.includes(n))?.error);
      expect(new Set(messages).size, `${c.framework}: failures share a message`).toBe(names.length);
    });

    test(`${c.framework}: no failure falls back to a placeholder message`, () => {
      const r = parseTestOutput(c.output);
      for (const f of r.failures) {
        expect(f.error, `${c.framework}/${f.testName}`).not.toBe("Unknown error");
        expect(f.error, `${c.framework}/${f.testName}`).not.toBe("no assertion message captured");
      }
    });
  }
});
```

- [ ] **Step 2: Run it**

```bash
CI=1 AGENT=1 bun test --timeout=60000 test/unit/test-runners/parser-failure-message-contract.test.ts
```

Expected: all 12 cases PASS. Bun passes because of Task 2; the other five should already pass.

**If a non-Bun framework fails**, you have found a second live defect. Do not relax the assertion and do not reshape the fixture to match the parser's behaviour. Record which framework, which assertion, and what the parser returned, then fix that sub-parser in this task with its own commit. If the fixture itself is wrong — that runner does not print that layout — replace it with output you have verified against the real runner, and say in the commit body how you verified it.

- [ ] **Step 3: Confirm the guard actually guards**

A test that passes against both the fixed and the broken code is worthless. Prove it bites:

**Do not use `git stash` for this.** This branch lives in a git worktree whose stash stack is shared with the main checkout and every other worktree, and a concurrent session can pop your entry. Restore from a plain copy instead:

```bash
cp src/test-runners/parse-bun.ts /tmp/parse-bun.fixed.ts
git show HEAD~1:src/test-runners/parse-bun.ts > src/test-runners/parse-bun.ts   # the Task 1 (pre-fix) version
CI=1 AGENT=1 bun test --timeout=60000 test/unit/test-runners/parser-failure-message-contract.test.ts
cp /tmp/parse-bun.fixed.ts src/test-runners/parse-bun.ts
rm /tmp/parse-bun.fixed.ts
git status --short src/test-runners/parse-bun.ts
```

`HEAD~1` is Task 1's verbatim-move commit, i.e. the forward-scanning version. The final `git status` must report the file as clean — if it does not, the restore failed and you are about to commit the broken parser.

Expected: against the pre-fix version the two `bun` cases FAIL; after the restore, re-running the suite passes again. If the `bun` cases pass against the pre-fix version, the fixture does not exercise the direction bug — fix the fixture before committing.

- [ ] **Step 4: Commit**

```bash
git add test/unit/test-runners/parser-failure-message-contract.test.ts
git commit -m "test(test-runners): pin each failure to its own message across frameworks

The Bun direction bug produced correct counts and correct test names, so it
was invisible to the existing Bun assertions on file/testName. This holds all
six sub-parsers to the property those assertions missed: given two failures
with mutually exclusive messages, neither may borrow the other's and neither
may fall back to a placeholder."
```

---

### Task 4: Stop discarding the stack frames

Every sub-parser populates `TestFailure.stackTrace`, and the `Finding` adapter drops it — so the rectifier prompt names a test and a message but never a line. `Finding` is the ADR-021 wire type shared across lint, typecheck and review; adding a field to it is out of scope here, so fold the frames into the message the adapter already builds.

**Files:**
- Modify: `src/findings/adapters/test-failure.ts`
- Test: `test/unit/findings/test-failure-adapter.test.ts` (create)

**Interfaces:**
- Consumes: `TestFailure` from `@/test-runners`, `Finding` from `../types`.
- Produces: `testFailureToFinding(failure: TestFailure): Finding` — signature unchanged; `message` now carries up to 2 stack frames appended after a blank line. `testSummaryToFindings` is unchanged and keeps delegating.

- [ ] **Step 1: Write the failing test**

```ts
/**
 * testFailureToFinding — the seam where a parsed TestFailure becomes the
 * Finding whose `message` is rendered as `Error: …` in the rectifier prompt
 * (src/prompts/builders/rectifier-builder-helpers.ts formatFailingTestsList).
 *
 * Every sub-parser collects stackTrace; this adapter used to drop it, so the
 * rectifying agent got a message with no location.
 */
import { describe, expect, test } from "bun:test";
import { testFailureToFinding, testSummaryToFindings } from "@/findings";
import type { TestFailure } from "@/test-runners";

const BASE: TestFailure = {
  file: "test/unit/tools/policy.test.ts",
  testName: "policy > confines a path",
  error: "expect(received).toEqual(expected) Expected: 4 Received: 3",
  stackTrace: [
    "at <anonymous> (test/unit/tools/policy.test.ts:84:20)",
    "at run (bun:test:1:1)",
    "at third (bun:test:2:2)",
  ],
};

describe("testFailureToFinding", () => {
  test("keeps the parsed message as the leading line", () => {
    const f = testFailureToFinding(BASE);
    expect(f.message.split("\n")[0]).toBe(BASE.error);
  });

  test("appends the first two stack frames so the agent gets a location", () => {
    const f = testFailureToFinding(BASE);
    expect(f.message).toContain("at <anonymous> (test/unit/tools/policy.test.ts:84:20)");
    expect(f.message).toContain("at run (bun:test:1:1)");
  });

  test("caps the appended frames at two", () => {
    const f = testFailureToFinding(BASE);
    expect(f.message).not.toContain("at third (bun:test:2:2)");
  });

  test("a failure with no stack frames yields the message alone, with no trailing blank", () => {
    const f = testFailureToFinding({ ...BASE, stackTrace: [] });
    expect(f.message).toBe(BASE.error);
  });

  test("file, rule, source, severity and category are unchanged", () => {
    const f = testFailureToFinding(BASE);
    expect(f.file).toBe(BASE.file);
    expect(f.rule).toBe(BASE.testName);
    expect(f.source).toBe("test-runner");
    expect(f.severity).toBe("error");
    expect(f.category).toBe("failed-test");
  });

  test("testSummaryToFindings maps every failure through the same adapter", () => {
    const findings = testSummaryToFindings({ passed: 0, failed: 2, failures: [BASE, { ...BASE, testName: "other" }] });
    expect(findings).toHaveLength(2);
    expect(findings[1].rule).toBe("other");
    expect(findings[1].message).toContain("at <anonymous>");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
CI=1 AGENT=1 bun test --timeout=60000 test/unit/findings/test-failure-adapter.test.ts
```

Expected: FAIL on "appends the first two stack frames" — `message` is currently exactly `failure.error`. The "no stack frames" and "fields unchanged" cases should already pass; that is fine, they are the regression half.

- [ ] **Step 3: Implement**

Replace the body of `src/findings/adapters/test-failure.ts`:

```ts
import type { TestFailure, TestSummary } from "@/test-runners";
import type { Finding } from "../types";

/**
 * How many stack frames to fold into the message.
 *
 * `Finding` is the ADR-021 wire format shared by lint, typecheck and review;
 * it carries no stack field and gaining one is a wider change than this seam
 * needs. Two frames is enough to name the assertion and its caller without
 * turning a 46-failure list into a wall of frames.
 */
const MAX_FRAMES_IN_MESSAGE = 2;

export function testFailureToFinding(failure: TestFailure): Finding {
  const frames = failure.stackTrace.slice(0, MAX_FRAMES_IN_MESSAGE);
  const message = frames.length > 0 ? `${failure.error}\n${frames.join("\n")}` : failure.error;

  return {
    source: "test-runner",
    severity: "error",
    category: "failed-test",
    rule: failure.testName,
    file: failure.file,
    message,
  };
}

export function testSummaryToFindings(summary: TestSummary): Finding[] {
  return summary.failures.map(testFailureToFinding);
}
```

- [ ] **Step 4: Run it to verify it passes**

```bash
CI=1 AGENT=1 bun test --timeout=60000 test/unit/findings/test-failure-adapter.test.ts
```

Expected: PASS, all six.

- [ ] **Step 5: Check no downstream assertion pinned the old single-line message**

The adapter feeds the full-suite gate, the regression gate and the rectifier prompt builder. A snapshot or equality assertion elsewhere may have pinned `message === error`.

```bash
CI=1 AGENT=1 bun test --timeout=60000 test/unit/findings test/unit/operations test/unit/prompts test/unit/execution
```

Expected: PASS. If a test fails because it asserted exact equality on a message that now carries frames, update that assertion to `toContain` the message text — the frames are the intended new content. Do not revert the adapter.

- [ ] **Step 6: Commit**

```bash
git add src/findings/adapters/test-failure.ts test/unit/findings/test-failure-adapter.test.ts
git commit -m "fix(findings): carry test stack frames into the rectifier prompt

Every sub-parser collects TestFailure.stackTrace and the Finding adapter
dropped it, so a rectifying agent received a test name and a message with no
location. Folds the first two frames into Finding.message — Finding is the
ADR-021 wire type shared with lint/typecheck/review, so a new field is a
wider change than this seam warrants."
```

---

### Task 5: Full verification and handoff

**Files:** none modified — this task only runs gates.

- [ ] **Step 1: Run the whole suite**

```bash
bun run test
```

Expected: PASS. Record the pass/fail counts.

- [ ] **Step 2: Run every static gate**

```bash
bun x tsc --noEmit
bun x tsc --noEmit -p tsconfig.test.json
AGENT=1 bun run lint:biome
AGENT=1 bun run check:all-without-biome
```

Expected: all exit 0. `check:all-without-biome` includes the file-size ratchet — `src/test-runners/parser.ts` must be comfortably under 600 after Task 1, and `parse-bun.ts` well under it.

**Note:** `bun run typecheck` is NOT part of `check:all` in this repo. Run both `tsc` invocations explicitly, as above.

- [ ] **Step 3: End-to-end check against the real artifact shape**

Confirm the whole chain — parser → Finding → prompt — now renders a real message.

```bash
bun -e '
import {parseTestOutput} from "./src/test-runners";
import {testSummaryToFindings} from "./src/findings";
import {formatFailingTestsList} from "./src/prompts/builders/rectifier-builder-helpers";
const out = [
  "g.test.ts:",
  "error: expect(received).toBe(expected)","","Expected: 4","Received: 3",
  "      at <anonymous> (/abs/g.test.ts:2:45)","(fail) alpha [0.1ms]",
  "error: expect(received).toBe(expected)","",`Expected: "b"`,`Received: "a"`,
  "      at <anonymous> (/abs/g.test.ts:3:44)","(fail) beta [0.1ms]",
  ""," 0 pass"," 2 fail",
].join("\n");
console.log(formatFailingTestsList(testSummaryToFindings(parseTestOutput(out))));
'
```

**Note:** this throwaway script imports `formatFailingTestsList` from its defining file because the
`src/prompts` barrel does not re-export it (only `repoScopedRectification` is). That deep import is fine
for a one-off check but violates the prompts README's invariant 5 for real source — do not copy the
pattern into `src/`.

Expected: two entries, `alpha` carrying `Expected: 4` and `beta` carrying `Expected: "b"`, each with an `at …` frame. Neither says `Unknown error`, neither carries the other's numbers. This is the output shape that was 46-for-46 wrong before this branch.

- [ ] **Step 4: Review the full diff before opening a PR**

```bash
git diff origin/main...HEAD --stat
git diff origin/main...HEAD
```

Read it. Confirm: Task 1 is a pure move (the only semantic change in `parse-bun.ts` belongs to Task 2's commit), no counting logic changed, and no file under `.claude/rules/` was touched.

- [ ] **Step 5: Push and open the PR**

```bash
git push -u origin feat/test-failure-message-extraction
```

PR body should state: the reproduction from Background, the three affected consumer sites, and that counts, gate verdicts and the agent's in-loop runs are unchanged.

---

## Self-Review

**Spec coverage.** The Background section's four claims each map to a task: Bun direction → Task 2; class-recurrence across frameworks → Task 3; dropped stack frames → Task 4; the 600-line ratchet blocking the fix → Task 1. The unknown-framework path is explicitly out of scope with the two existing implementations cited, so a zero-context engineer does not re-add it.

**Placeholder scan.** Every code step carries the actual code. No "add error handling", no "similar to Task N". The one judgement call left to the implementer is Task 3 Step 2's branch for a non-Bun failure, which is bounded by explicit instructions on what not to do.

**Type consistency.** `parseBunOutput` is named identically in Tasks 1, 2 and 3. `extractBunFailureDetail` returns `{ error, stackTrace }`, matching the two fields Task 2 Step 3(b) destructures. `testFailureToFinding` keeps its `(failure: TestFailure): Finding` signature across Task 4's test and implementation. `MAX_STACK_LINES` (parser-side, 5) and `MAX_FRAMES_IN_MESSAGE` (adapter-side, 2) are deliberately distinct constants in different files.

**Known risk.** Task 2's fixtures were transcribed from `bun test v1.4.0`. Task 2 Step 5 re-verifies against the locally installed Bun so a version drift is caught during implementation rather than in production.
