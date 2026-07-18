# Design — Test-Output Parser Parity (Rust + Mocha)

> Date: 2026-07-18
> Origin: Gap Analysis 2026-07-18 §3.2 / §6 item #10 (sub-area B).
> Scope: `src/test-runners/{parser.ts,detector.ts}` + new `parse-rust.ts`, `parse-mocha.ts`.

## Problem

`parseTestOutput(output)` dispatches on `detectFramework(output)` and returns a
structured `TestSummary` (`{ passed, failed, failures[] }`). It has dedicated
parsers for Bun/Jest/Vitest/pytest/go only. Rust (`cargo test`), Mocha, Jasmine,
Playwright, and Cypress all fall through to `parseCommonOutput`, which extracts
pass/fail counts but returns an **empty `failures[]`** — no `{ file, testName,
error, stackTrace }`. Those structured failures feed the rectification gates
(`src/operations/verify-scoped.ts:199`, `src/operations/full-suite-gate.ts:179`),
so non-TS/non-supported runs give the fix agent counts but no per-failure context.

This design closes the two highest-value gaps: **Rust** (language parity — nax
treats Rust first-class in discovery/analyze/mutation) and **Mocha** (common JS
runner; its spec reporter is also what **Cypress** emits, so one parser covers
both). Jasmine and Playwright are deferred (fading / reporter-fragile).

## Contract

Parsers are pure functions: input string → `TestSummary`. No I/O, no throws.
Unmatched output yields zero counts / empty `failures[]`; the dispatcher always
returns a valid `TestSummary`. Mirrors the existing go/pytest parser pattern.

Detection is from **output content only** — callers pass raw output, not the
discovered framework id.

## Components

### 1. `src/test-runners/parse-rust.ts` — `parseRustTestOutput(output: string): TestSummary`

`cargo test` uses the libtest reporter:

```
running 3 tests
test tests::test_add ... FAILED

failures:

---- tests::test_add stdout ----
thread 'tests::test_add' panicked at src/lib.rs:15:9:
assertion `left == right` failed
  left: 3
  right: 4

failures:
    tests::test_add

test result: FAILED. 2 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

- **Counts:** sum **all** `test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed;`
  matches. Cargo emits one result line *per test binary*; last-match-wins (what
  the common parser does) undercounts multi-crate runs, so the Rust parser sums.
- **Failures:** for each `---- <name> stdout ----` block → `testName = <name>`.
  From `thread '<name>' panicked at <file>:<line>:<col>:` → `file = <file>`, push
  `<file>:<line>` to `stackTrace`. `error` = first non-empty line after the panic
  line (e.g. `assertion left == right failed`), else the panic line.
- **Degrade:** no detail blocks but `test <name> ... FAILED` lines present →
  synthesize failures with `file: "unknown"`, `error: "Unknown error"`.

### 2. `src/test-runners/parse-mocha.ts` — `parseMochaOutput(output: string): TestSummary`

Mocha spec reporter (also Cypress):

```
  1 passing (12ms)
  1 failing

  1) MySuite nested fails:
     AssertionError: expected 1 to equal 2
      at Context.<anonymous> (test/foo.test.js:8:20)
```

- **Counts:** `(\d+) passing` → passed; `(\d+) failing` → failed. Both optional
  (default 0).
- **Failures:** trailing list blocks anchored by `^\s*(\d+)\)\s+(.+)$` →
  `testName` = captured title with a trailing `:` stripped. `error` = the next
  non-empty line that is not an `at …` stack line. `file` = capture from the
  first `at .*\((<file>:<line>:<col>)\)` line. `stackTrace` = `at …` lines,
  capped at 5.

### 3. `src/test-runners/detector.ts`

- Extend `Framework` union: `… | "rust" | "mocha" | …`.
- Add signatures to `detectFramework`, **in this order**:
  - **Rust** (early — unique anchors): `if (/^test result:\s+(?:ok|FAILED)\./m.test(output) || /panicked at /.test(output)) return "rust";`
  - **Mocha** placed **before** the existing bun `/[✓✔✗✘]/m` catch (mocha's spec
    reporter also prints `✓`/`✗`): `if (/^\s*\d+ passing\b/m.test(output)) return "mocha";`
    — the gerund `passing` distinguishes it from jest/vitest/playwright
    (`passed`). Placed after the jest/vitest/pytest checks.
- Cypress: **no** new `Framework` value — its output is detected as `mocha` and
  parsed by the Mocha parser.

### 4. `src/test-runners/parser.ts`

Two imports + two `switch` cases in `parseTestOutput`:

```ts
    case "rust":
      return parseRustTestOutput(output);
    case "mocha":
      return parseMochaOutput(output);
```

File is 583 lines (600 hard limit); the parser bodies live in the new modules, so
`parser.ts` stays ~587. No existing-parser refactor.

## Error handling

No throws, no I/O. Every regex miss degrades to empty/zero. `parseTestOutput`
always returns a `TestSummary`.

## Testing

- New `test/unit/test-runners/parse-rust.test.ts` — single-binary failure with
  `panicked at` file:line extraction; multi-binary count summing; passing-only →
  `failures: []`; degrade path (FAILED line, no stdout block).
- New `test/unit/test-runners/parse-mocha.test.ts` — nested failure block
  (testName/error/file), cypress-style block, counts-only (no failing section).
- Extend `test/unit/test-runners/detector.test.ts` — rust + mocha detection and
  ordering guards: mocha output not misdetected as `bun`, rust not as `go`.
- Existing `parser.test.ts` / `detector.test.ts` stay green.

## Non-goals (YAGNI)

- No Jasmine parser (fading usage, distinct "Failures:" format).
- No Playwright parser (output varies by reporter: list/line/dot/html — fragile).
- No separate Cypress parser/enum (covered by Mocha).
- No reporter-configuration handling or `--reporter json` support.
- No changes to `parseTestFailures` (the AC-ID extraction path in `ac-parser.ts`
  used by the acceptance loop — a separate concern from `parseTestOutput`).

## Deferred sibling (out of scope)

Gap item #10 sub-area C — mutation-operator parity (`src/verification/mutation/
operators.ts`: implement the empty Python/Go stubs + add Rust) — remains a
separate spec.
