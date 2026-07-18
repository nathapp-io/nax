# Test-Output Parser Parity (Rust + Mocha) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add structured `TestSummary` parsers for Rust (`cargo test`) and Mocha (also covering Cypress) so rectification gets per-failure `{file, testName, error, stackTrace}` instead of counts-only.

**Architecture:** Two new pure-function modules (`parse-rust.ts`, `parse-mocha.ts`), each `parse*Output(output): TestSummary`. `detector.ts` gains `"rust"`/`"mocha"` in the `Framework` union and two content signatures in `detectFramework` (mocha ordered before the bun `✓/✗` catch). `parser.ts` gains two dispatch cases. Cypress needs no parser — its Mocha-reporter output detects as `mocha`.

**Tech Stack:** Bun 1.3.7+, TypeScript strict, `bun:test`, Biome.

## Global Constraints

- **Pure functions** — no I/O, no throws; unmatched output → zero counts / empty `failures[]`.
- **600-line source hard limit** — parser.ts is 583 lines, so new parser bodies go in their own files (not inlined).
- **Detection is from output content only** — `detectFramework(output)` gets no framework hint.
- **`TestFailure` shape:** `{ file: string; testName: string; error: string; stackTrace: string[] }`. `TestSummary`: `{ passed: number; failed: number; failures: TestFailure[] }`. Both from `./types` (leaf import — established pattern).
- **stackTrace cap:** 5 lines (`MAX_STACK_LINES = 5`).
- **Bun test wrapper** — never bare `bun test`; always `timeout 30 bun test <path> --timeout=5000`.
- **Test path alias:** `@/` → `src/`; tests import `@/test-runners/...`.
- **No `console.log`** in `src/`. **Conventional commits.**

---

### Task 1: Rust `cargo test` parser

**Files:**
- Create: `src/test-runners/parse-rust.ts`
- Test: `test/unit/test-runners/parse-rust.test.ts`

**Interfaces:**
- Consumes: `TestFailure`, `TestSummary` from `./types`.
- Produces: `parseRustTestOutput(output: string): TestSummary`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/test-runners/parse-rust.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { parseRustTestOutput } from "@/test-runners/parse-rust";

describe("parseRustTestOutput", () => {
  test("extracts count + panic file:line from a single-binary failure", () => {
    const output = `
running 3 tests
test tests::test_ok ... ok
test tests::test_add ... FAILED

failures:

---- tests::test_add stdout ----
thread 'tests::test_add' panicked at src/lib.rs:15:9:
assertion \`left == right\` failed
  left: 3
  right: 4

failures:
    tests::test_add

test result: FAILED. 2 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
`.trim();
    const summary = parseRustTestOutput(output);
    expect(summary.passed).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0].testName).toBe("tests::test_add");
    expect(summary.failures[0].file).toBe("src/lib.rs");
    expect(summary.failures[0].error).toContain("assertion");
    expect(summary.failures[0].stackTrace).toContain("src/lib.rs:15");
  });

  test("sums counts across multiple test binaries", () => {
    const output = `
test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
test result: FAILED. 3 passed; 2 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.02s
`.trim();
    const summary = parseRustTestOutput(output);
    expect(summary.passed).toBe(8);
    expect(summary.failed).toBe(2);
  });

  test("passing-only run yields no failures", () => {
    const output = `test result: ok. 10 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s`;
    const summary = parseRustTestOutput(output);
    expect(summary.passed).toBe(10);
    expect(summary.failed).toBe(0);
    expect(summary.failures).toEqual([]);
  });

  test("degrades to test-line names when no stdout blocks present", () => {
    const output = `
test tests::broken ... FAILED

test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
`.trim();
    const summary = parseRustTestOutput(output);
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0].testName).toBe("tests::broken");
    expect(summary.failures[0].file).toBe("unknown");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 30 bun test test/unit/test-runners/parse-rust.test.ts --timeout=5000`
Expected: FAIL — cannot resolve module `@/test-runners/parse-rust`.

- [ ] **Step 3: Write minimal implementation**

Create `src/test-runners/parse-rust.ts`:

```ts
/**
 * Rust `cargo test` (libtest) output parser.
 *
 * Pure function — no I/O, no throws. Unmatched output yields zero counts and an
 * empty failures array. Counts are SUMMED across all `test result:` lines because
 * cargo emits one per test binary (multi-crate runs would otherwise undercount).
 */
import type { TestFailure, TestSummary } from "./types";

const RESULT_LINE_RE = /^test result:\s+(?:ok|FAILED)\.\s+(\d+)\s+passed;\s+(\d+)\s+failed;/gm;
const FAILED_TEST_LINE_RE = /^test (\S+) \.\.\. FAILED$/gm;
const MAX_STACK_LINES = 5;

export function parseRustTestOutput(output: string): TestSummary {
  let passed = 0;
  let failed = 0;
  for (const m of output.matchAll(RESULT_LINE_RE)) {
    passed += Number.parseInt(m[1], 10);
    failed += Number.parseInt(m[2], 10);
  }
  return { passed, failed, failures: extractRustFailures(output) };
}

function extractRustFailures(output: string): TestFailure[] {
  const lines = output.split("\n");
  const failures: TestFailure[] = [];

  for (let i = 0; i < lines.length; i++) {
    const header = lines[i].match(/^---- (\S+) stdout ----$/);
    if (!header) continue;
    const testName = header[1];

    let file = "unknown";
    let error = "";
    const stackTrace: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (/^---- \S+ stdout ----$/.test(line) || /^test result:/.test(line)) break;
      const panic = line.match(/panicked at ([^:\n]+):(\d+):(?:\d+):/);
      if (panic) {
        file = panic[1];
        if (stackTrace.length < MAX_STACK_LINES) stackTrace.push(`${panic[1]}:${panic[2]}`);
        continue;
      }
      if (!error && line.trim() && !line.startsWith("note:")) error = line.trim();
    }
    failures.push({ file, testName, error: error || "Unknown error", stackTrace });
  }

  if (failures.length > 0) return failures;

  // Degrade: no detail blocks, but "test <name> ... FAILED" lines present.
  for (const m of output.matchAll(FAILED_TEST_LINE_RE)) {
    failures.push({ file: "unknown", testName: m[1], error: "Unknown error", stackTrace: [] });
  }
  return failures;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `timeout 30 bun test test/unit/test-runners/parse-rust.test.ts --timeout=5000`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/test-runners/parse-rust.ts test/unit/test-runners/parse-rust.test.ts
git commit -m "feat(test-runners): structured parser for cargo test output"
```

---

### Task 2: Mocha spec-reporter parser (covers Cypress)

**Files:**
- Create: `src/test-runners/parse-mocha.ts`
- Test: `test/unit/test-runners/parse-mocha.test.ts`

**Interfaces:**
- Consumes: `TestFailure`, `TestSummary` from `./types`.
- Produces: `parseMochaOutput(output: string): TestSummary`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/test-runners/parse-mocha.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { parseMochaOutput } from "@/test-runners/parse-mocha";

describe("parseMochaOutput", () => {
  test("extracts counts and structured failure from spec reporter", () => {
    const output = `
  MySuite
    ✓ passes
    1) fails

  1 passing (12ms)
  1 failing

  1) MySuite fails:
     AssertionError: expected 1 to equal 2
      at Context.<anonymous> (test/foo.test.js:8:20)
`.trimEnd();
    const summary = parseMochaOutput(output);
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0].testName).toBe("MySuite fails");
    expect(summary.failures[0].error).toContain("AssertionError");
    expect(summary.failures[0].file).toBe("test/foo.test.js");
    expect(summary.failures[0].stackTrace).toContain("test/foo.test.js:8");
  });

  test("does not double-count the inline tree failure marker", () => {
    const output = `
  MySuite
    1) fails

  0 passing (5ms)
  1 failing

  1) MySuite fails:
     Error: boom
      at Context.<anonymous> (test/bar.test.js:3:5)
`.trimEnd();
    const summary = parseMochaOutput(output);
    expect(summary.failures).toHaveLength(1);
  });

  test("counts-only run (no failing section) yields no failures", () => {
    const output = `  4 passing (20ms)`;
    const summary = parseMochaOutput(output);
    expect(summary.passed).toBe(4);
    expect(summary.failed).toBe(0);
    expect(summary.failures).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 30 bun test test/unit/test-runners/parse-mocha.test.ts --timeout=5000`
Expected: FAIL — cannot resolve module `@/test-runners/parse-mocha`.

- [ ] **Step 3: Write minimal implementation**

Create `src/test-runners/parse-mocha.ts`:

```ts
/**
 * Mocha spec-reporter output parser (also covers Cypress, which uses Mocha's
 * reporter). Pure function — no I/O, no throws.
 *
 * Failure detail blocks are parsed only from the region after the "N failing"
 * summary line, so the inline tree's "N) name" markers are not double-counted.
 */
import type { TestFailure, TestSummary } from "./types";

const MAX_STACK_LINES = 5;

export function parseMochaOutput(output: string): TestSummary {
  return {
    passed: matchCount(output, /(\d+)\s+passing\b/),
    failed: matchCount(output, /(\d+)\s+failing\b/),
    failures: extractMochaFailures(output),
  };
}

function matchCount(output: string, re: RegExp): number {
  const m = output.match(re);
  return m ? Number.parseInt(m[1], 10) : 0;
}

function extractMochaFailures(output: string): TestFailure[] {
  const failingIdx = output.search(/^\s*\d+\s+failing\b/m);
  if (failingIdx === -1) return [];
  const lines = output.slice(failingIdx).split("\n");
  const failures: TestFailure[] = [];

  for (let i = 1; i < lines.length; i++) {
    const header = lines[i].match(/^\s*(\d+)\)\s+(.+)$/);
    if (!header) continue;
    const testName = header[2].replace(/:\s*$/, "").trim();

    let file = "unknown";
    let error = "";
    const stackTrace: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (/^\s*\d+\)\s+/.test(line)) break; // next failure block
      const at = line.match(/at\s+.*\(([^)]+):(\d+):(\d+)\)/);
      if (at) {
        if (file === "unknown") file = at[1];
        if (stackTrace.length < MAX_STACK_LINES) stackTrace.push(`${at[1]}:${at[2]}`);
        continue;
      }
      if (!error && line.trim()) error = line.trim();
    }
    failures.push({ file, testName, error: error || "Unknown error", stackTrace });
  }
  return failures;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `timeout 30 bun test test/unit/test-runners/parse-mocha.test.ts --timeout=5000`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/test-runners/parse-mocha.ts test/unit/test-runners/parse-mocha.test.ts
git commit -m "feat(test-runners): structured parser for mocha/cypress output"
```

---

### Task 3: Wire detection + dispatch

**Files:**
- Modify: `src/test-runners/detector.ts` (the `Framework` union + `detectFramework`)
- Modify: `src/test-runners/parser.ts` (imports + `parseTestOutput` switch)
- Test: `test/unit/test-runners/detector.test.ts` (extend), `test/unit/test-runners/parser.test.ts` (extend)

**Interfaces:**
- Consumes: `parseRustTestOutput` (Task 1), `parseMochaOutput` (Task 2), `detectFramework`/`Framework` (detector.ts), `parseTestOutput` (parser.ts).
- Produces: `Framework` union now includes `"rust"` and `"mocha"`; `parseTestOutput` dispatches cargo→rust and mocha/cypress→mocha.

- [ ] **Step 1: Write the failing tests**

In `test/unit/test-runners/detector.test.ts`, add `detectFramework` to the existing detector import line so it reads:

```ts
import { buildTestFrameworkHint, detectFramework } from "../../../src/test-runners/detector";
```

Then append:

```ts
describe("detectFramework — rust & mocha", () => {
  test("detects cargo test result line as rust", () => {
    const output = `test result: FAILED. 2 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s`;
    expect(detectFramework(output)).toBe("rust");
  });

  test("detects a rust panic line as rust", () => {
    expect(detectFramework("thread 'x' panicked at src/lib.rs:1:1:")).toBe("rust");
  });

  test("detects mocha output as mocha, not bun (despite the check glyph)", () => {
    const output = `
  MySuite
    ✓ passes

  1 passing (12ms)
  1 failing
`.trim();
    expect(detectFramework(output)).toBe("mocha");
  });

  test("cypress-style mocha output detects as mocha", () => {
    const output = `
  2 passing (1s)
  1 failing

  1) login flow works:
     AssertionError: expected true to be false
      at Context.eval (cypress/e2e/login.cy.js:12:10)
`.trim();
    expect(detectFramework(output)).toBe("mocha");
  });
});
```

In `test/unit/test-runners/parser.test.ts`, append (the file already imports `parseTestOutput` from `@/test-runners`):

```ts
describe("parseTestOutput — rust & mocha dispatch", () => {
  test("routes cargo output through the rust parser", () => {
    const output = `
---- tests::t stdout ----
thread 'tests::t' panicked at src/x.rs:2:3:
boom

test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.0s
`.trim();
    const s = parseTestOutput(output);
    expect(s.failed).toBe(1);
    expect(s.failures[0].file).toBe("src/x.rs");
  });

  test("routes mocha output through the mocha parser", () => {
    const output = `
  1 passing (1ms)
  1 failing

  1) suite t:
     Error: nope
      at Context.<anonymous> (test/a.test.js:1:1)
`.trim();
    const s = parseTestOutput(output);
    expect(s.failed).toBe(1);
    expect(s.failures[0].file).toBe("test/a.test.js");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `timeout 30 bun test test/unit/test-runners/detector.test.ts test/unit/test-runners/parser.test.ts --timeout=5000`
Expected: FAIL — rust/mocha detected as `unknown`/`bun`; `parseTestOutput` returns empty `failures` for these inputs.

- [ ] **Step 3: Extend the `Framework` union and `detectFramework`**

In `src/test-runners/detector.ts`, change the `Framework` type:

```ts
export type Framework = "bun" | "jest" | "vitest" | "pytest" | "go" | "rust" | "mocha" | "unknown";
```

In the same file, in `detectFramework`, insert the rust and mocha checks **between the `go` check and the `bun` check** so the block reads:

```ts
  // go test: "--- FAIL:" or "ok  \t" or "FAIL\t"
  if (/^--- (?:FAIL|PASS):/m.test(output) || /^(?:ok|FAIL)\s+\t/m.test(output)) return "go";
  // Rust cargo test: "test result:" summary or a panic line — unique anchors.
  if (/^test result:\s+(?:ok|FAILED)\./m.test(output) || /panicked at /.test(output)) return "rust";
  // Mocha (and Cypress) spec reporter: "N passing". MUST precede the bun check —
  // mocha's spec reporter also prints the ✓/✗ glyphs the bun branch matches.
  if (/^\s*\d+\s+passing\b/m.test(output)) return "mocha";
  // Bun: "(fail)" marker, bun test header, or bun's Unicode checkmarks (✓ ✔ ✗ ✘)
  if (/^\(fail\)\s/m.test(output) || /^bun test/m.test(output) || /[✓✔✗✘]/m.test(output)) return "bun";
  return "unknown";
```

- [ ] **Step 4: Add the dispatch cases in `parser.ts`**

In `src/test-runners/parser.ts`, add these two imports after the existing `import { detectFramework } from "./detector";` line:

```ts
import { parseMochaOutput } from "./parse-mocha";
import { parseRustTestOutput } from "./parse-rust";
```

In the same file, in `parseTestOutput`, add two cases immediately before `default:`:

```ts
    case "rust":
      return parseRustTestOutput(output);
    case "mocha":
      return parseMochaOutput(output);
    default:
      return parseCommonOutput(output);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `timeout 30 bun test test/unit/test-runners/detector.test.ts test/unit/test-runners/parser.test.ts test/unit/test-runners/parse-rust.test.ts test/unit/test-runners/parse-mocha.test.ts --timeout=5000`
Expected: PASS — all detector, dispatch, and parser tests green.

- [ ] **Step 6: Typecheck + lint (confirms 600-line limit + Biome)**

Run: `bun run typecheck && bun run lint`
Expected: no errors (file-size check passes — parser.ts stays under 600).

- [ ] **Step 7: Run the full test-runners unit suite for regressions**

Run: `timeout 60 bun test test/unit/test-runners/ --timeout=10000`
Expected: PASS — no regressions in existing bun/jest/vitest/pytest/go detection or parsing.

- [ ] **Step 8: Commit**

```bash
git add src/test-runners/detector.ts src/test-runners/parser.ts test/unit/test-runners/detector.test.ts test/unit/test-runners/parser.test.ts
git commit -m "feat(test-runners): detect + dispatch rust and mocha/cypress output"
```

---

## Self-Review

**1. Spec coverage** (design doc §Components):
- `parse-rust.ts` with count-summing + panic file:line + degrade → Task 1. ✓
- `parse-mocha.ts` with counts + failure blocks + inline-tree exclusion (Cypress covered) → Task 2. ✓
- `detector.ts` `Framework` union + rust/mocha signatures with mocha-before-bun ordering → Task 3 Step 3. ✓
- `parser.ts` two dispatch cases → Task 3 Step 4. ✓
- Detection-from-output-only → all tests pass raw output, no hints. ✓
- Pure functions, no throws, degrade to empty → Tasks 1/2 impl + passing-only/counts-only tests. ✓
- 600-line limit honored (new files) → Task 3 Step 6 lint gate. ✓
- Testing: new parse-rust/parse-mocha suites + extended detector/parser suites → all tasks. ✓
- Non-goals (no Jasmine/Playwright/Cypress-enum/reporter-config/ac-parser change) → not touched. ✓

**2. Placeholder scan:** No TBD/TODO; every code step is complete; every command has expected output. ✓

**3. Type consistency:** `parseRustTestOutput`, `parseMochaOutput`, `Framework`, `TestSummary`, `TestFailure`, `MAX_STACK_LINES` named identically at definition and use. Task 3 imports match Task 1/2 exports (`./parse-rust`, `./parse-mocha`). Dispatch `case "rust"`/`case "mocha"` match the `Framework` union values added in Step 3. The `default: return parseCommonOutput(output);` line is shown verbatim from the existing file so the two new cases are inserted above it without dropping it. ✓
