# Polyglot Mutation Operators (Python/Go/Rust) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the mutation spot-check real operators for Python/Go/Rust (currently empty stubs / absent) so it stops being a silent no-op on non-TS packages.

**Architecture:** In `src/verification/mutation/operators.ts`, DRY-refactor the TS primitives (a `makeBooleanFlip(trueLit,falseLit)` factory, a shared `ARITHMETIC_PAIRS`, a `UNIVERSAL_COMPARISON_PAIRS` without JS-only `===`/`!==`), then build Python/Go/Rust tables via a `makeOperators(prefix,trueLit,falseLit)` factory and register them (incl. new `rust`). In `src/verification/mutation/mutator.ts`, make the comment-skip language-aware so Python `#` lines aren't mutated. Operators stay pure line-level regex transforms — TS parity, no new families.

**Tech Stack:** Bun 1.3.7+, TypeScript strict, `bun:test`, Biome.

## Global Constraints

- **Pure functions** — operators are deterministic `{ id, apply(snippet): string|string[] }`; no I/O, no throws.
- **TS parity only** — 4 families (cmp-flip, cmp-bracket-flip, bool-flip, arith-flip). No `and`/`or`/`&&`/`||`. No `===`/`!==` for non-JS. Python booleans are `True`/`False`.
- **`TestFailure`-free** — this is the mutation subsystem, unrelated to test-output parsing.
- **`MutationOperator`** imported from `./types`; `Mutant` shape = `{ file, line, before, after, operatorId }`.
- **Operator id convention:** `<prefix>:<family>`, e.g. `py:bool-flip`, `go:cmp-bracket-flip`, `rust:cmp-flip`.
- **Bun test wrapper** — never bare `bun test`; always `timeout 30 bun test <path> --timeout=5000`.
- **600-line source limit** (operators.ts ends ~165 lines — fine). **No `console.log`.** **Conventional commits.**
- **Encapsulation:** do NOT export `getOperatorsForLanguage` through a barrel just to test it — test operator behavior via `generateMutants` (already exported from `@/verification`) asserting the `operatorId` field.

---

### Task 1: Polyglot operator tables (Python/Go/Rust) + DRY refactor

**Files:**
- Modify: `src/verification/mutation/operators.ts` (full replacement — see Step 3)
- Test: `test/unit/verification/mutation/mutator.test.ts` (add language coverage; update the unsupported-languages block)

**Interfaces:**
- Consumes: `MutationOperator` from `./types`; `generateMutants` from `@/verification` (existing).
- Produces: `SUPPORTED_LANGUAGES` now maps `python`→`PYTHON_OPERATORS`, `go`→`GO_OPERATORS`, `rust`→`RUST_OPERATORS`, each a 4-operator table with ids `py:*`/`go:*`/`rust:*`. `getOperatorsForLanguage` signature unchanged.

- [ ] **Step 1: Write the failing tests**

In `test/unit/verification/mutation/mutator.test.ts`, append these three describes:

```ts
describe("generateMutants — Python operator coverage", () => {
  test("bool-flip: True -> False", () => {
    const mutants = generateMutants({ source: "flag = True\n", language: "python", file: "f.py" });
    expect(mutants.some((m) => m.after === "flag = False" && m.operatorId === "py:bool-flip")).toBe(true);
  });

  test("cmp-flip: == -> !=", () => {
    const mutants = generateMutants({ source: "x = a == b\n", language: "python", file: "f.py" });
    expect(mutants.some((m) => m.after === "x = a != b" && m.operatorId === "py:cmp-flip")).toBe(true);
  });

  test("arith-flip: + -> -", () => {
    const mutants = generateMutants({ source: "y = a + b\n", language: "python", file: "f.py" });
    expect(mutants.some((m) => m.after === "y = a - b" && m.operatorId === "py:arith-flip")).toBe(true);
  });
});

describe("generateMutants — Go operator coverage", () => {
  test("bool-flip: true -> false", () => {
    const mutants = generateMutants({ source: "ok := true\n", language: "go", file: "f.go" });
    expect(mutants.some((m) => m.after === "ok := false" && m.operatorId === "go:bool-flip")).toBe(true);
  });

  test("bracket-flip: > -> <", () => {
    const mutants = generateMutants({ source: "if a > b {\n", language: "go", file: "f.go" });
    expect(mutants.some((m) => m.after === "if a < b {" && m.operatorId === "go:cmp-bracket-flip")).toBe(true);
  });
});

describe("generateMutants — Rust operator coverage", () => {
  test("bool-flip: true -> false", () => {
    const mutants = generateMutants({ source: "let ok = true;\n", language: "rust", file: "f.rs" });
    expect(mutants.some((m) => m.after === "let ok = false;" && m.operatorId === "rust:bool-flip")).toBe(true);
  });

  test("cmp-flip: == -> !=", () => {
    const mutants = generateMutants({ source: "let e = a == b;\n", language: "rust", file: "f.rs" });
    expect(mutants.some((m) => m.after === "let e = a != b;" && m.operatorId === "rust:cmp-flip")).toBe(true);
  });
});
```

Then REPLACE the existing `describe("generateMutants — unsupported languages", ...)` block (its `python`/`go` cases are now false) with:

```ts
describe("generateMutants — unsupported languages", () => {
  test("undefined language returns empty array", () => {
    expect(generateMutants({ source: "a > b\n", language: undefined, file: "x.ts" })).toEqual([]);
  });

  test("unknown language returns empty array", () => {
    expect(generateMutants({ source: "a > b\n", language: "ruby", file: "x.rb" })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `timeout 30 bun test test/unit/verification/mutation/mutator.test.ts --timeout=5000`
Expected: FAIL — the Python/Go/Rust coverage tests fail (no operators yet, `generateMutants` returns `[]` for them).

- [ ] **Step 3: Replace `operators.ts` with the polyglot version**

Replace the ENTIRE contents of `src/verification/mutation/operators.ts` with:

```ts
/**
 * Mutation generation core — per-language operator tables.
 *
 * Operators are deterministic: a given input snippet maps to a fixed set of
 * replacements. Each operator carries a stable id used by the result
 * classifier to identify which transformation produced a given mutant.
 */

import type { MutationOperator } from "./types";

type PatternReplacement = readonly [RegExp, string];

/**
 * TypeScript/JavaScript comparison flips — includes the JS-only strict-equality
 * operators (`===` / `!==`).
 */
const TS_COMPARISON_PAIRS: ReadonlyArray<PatternReplacement> = [
  [/==/g, "!="],
  [/!=/g, "=="],
  [/===/g, "!=="],
  [/!==/g, "==="],
  [/>=/g, "<="],
  [/<=/g, ">="],
];

/**
 * Comparison flips shared by all languages — the TS subset minus the JS-only
 * strict-equality operators (`===` / `!==`), which Python/Go/Rust do not have.
 */
const UNIVERSAL_COMPARISON_PAIRS: ReadonlyArray<PatternReplacement> = [
  [/==/g, "!="],
  [/!=/g, "=="],
  [/>=/g, "<="],
  [/<=/g, ">="],
];

// Bare >/< flips require whitespace on both sides — the shape a real
// comparison takes (`a > b`), but neither an arrow function (`x => x`, no
// space before `>`) nor a generic (`Array<string>`, no space before `<` and
// none before the closing `>` either) takes. Scoping this way avoids
// producing mutants that fail to compile — always "killed" regardless of
// test quality.
const COMPARISON_GT = /(?<=\s)>(?!=)(?=\s|$)/g;
const COMPARISON_LT = /(?<=\s)<(?!=)(?=\s)/g;

function applyComparisonBracketFlip(snippet: string): string[] {
  const seen = new Set<string>();
  const results: string[] = [];
  if (COMPARISON_GT.test(snippet)) {
    COMPARISON_GT.lastIndex = 0;
    const produced = snippet.replace(COMPARISON_GT, "<");
    if (produced !== snippet) {
      seen.add(produced);
      results.push(produced);
    }
  }
  if (COMPARISON_LT.test(snippet)) {
    COMPARISON_LT.lastIndex = 0;
    const produced = snippet.replace(COMPARISON_LT, ">");
    if (produced !== snippet && !seen.has(produced)) {
      results.push(produced);
    }
  }
  return results;
}

function flipWithPairs(pairs: ReadonlyArray<PatternReplacement>, snippet: string): string[] {
  const seen = new Set<string>();
  const results: string[] = [];
  for (const [pattern, replacement] of pairs) {
    if (pattern.test(snippet)) {
      pattern.lastIndex = 0;
      const produced = snippet.replace(pattern, replacement);
      if (!seen.has(produced)) {
        seen.add(produced);
        results.push(produced);
      }
    }
  }
  return results;
}

/**
 * Build a boolean-literal flip for a language's spelling of true/false
 * (`true`/`false` for TS/Go/Rust, `True`/`False` for Python). Fresh regexes
 * per call keep the shared `lastIndex` hazard out.
 */
function makeBooleanFlip(trueLit: string, falseLit: string): (snippet: string) => string[] {
  return (snippet: string) => {
    const seen = new Set<string>();
    const results: string[] = [];
    if (new RegExp(`\\b${trueLit}\\b`).test(snippet)) {
      const produced = snippet.replace(new RegExp(`\\b${trueLit}\\b`, "g"), falseLit);
      seen.add(produced);
      results.push(produced);
    }
    if (new RegExp(`\\b${falseLit}\\b`).test(snippet)) {
      const produced = snippet.replace(new RegExp(`\\b${falseLit}\\b`, "g"), trueLit);
      if (!seen.has(produced)) results.push(produced);
    }
    return results;
  };
}

const ARITHMETIC_PAIRS: ReadonlyArray<PatternReplacement> = [
  [/\+/g, "-"],
  [/-/g, "+"],
  [/\*/g, "/"],
  [/\//g, "*"],
];

const TYPESCRIPT_OPERATORS: ReadonlyArray<MutationOperator> = [
  { id: "ts:cmp-flip", apply: (snippet) => flipWithPairs(TS_COMPARISON_PAIRS, snippet) },
  { id: "ts:cmp-bracket-flip", apply: applyComparisonBracketFlip },
  { id: "ts:bool-flip", apply: makeBooleanFlip("true", "false") },
  { id: "ts:arith-flip", apply: (snippet) => flipWithPairs(ARITHMETIC_PAIRS, snippet) },
];

/**
 * Build the standard four-operator table for a language, scoped by an id
 * prefix and its boolean-literal spelling. Comparison / bracket / arithmetic
 * flips are language-neutral; only the boolean spelling differs.
 */
function makeOperators(prefix: string, trueLit: string, falseLit: string): ReadonlyArray<MutationOperator> {
  return [
    { id: `${prefix}:cmp-flip`, apply: (snippet) => flipWithPairs(UNIVERSAL_COMPARISON_PAIRS, snippet) },
    { id: `${prefix}:cmp-bracket-flip`, apply: applyComparisonBracketFlip },
    { id: `${prefix}:bool-flip`, apply: makeBooleanFlip(trueLit, falseLit) },
    { id: `${prefix}:arith-flip`, apply: (snippet) => flipWithPairs(ARITHMETIC_PAIRS, snippet) },
  ];
}

const PYTHON_OPERATORS = makeOperators("py", "True", "False");
const GO_OPERATORS = makeOperators("go", "true", "false");
const RUST_OPERATORS = makeOperators("rust", "true", "false");

const SUPPORTED_LANGUAGES: ReadonlyMap<string, ReadonlyArray<MutationOperator>> = new Map([
  ["typescript", TYPESCRIPT_OPERATORS],
  ["javascript", TYPESCRIPT_OPERATORS],
  ["python", PYTHON_OPERATORS],
  ["go", GO_OPERATORS],
  ["rust", RUST_OPERATORS],
]);

export function getOperatorsForLanguage(language: string | undefined): ReadonlyArray<MutationOperator> {
  if (!language) return [];
  return SUPPORTED_LANGUAGES.get(language) ?? [];
}
```

- [ ] **Step 4: Run the mutation suite to verify pass**

Run: `timeout 60 bun test test/unit/verification/mutation/ --timeout=10000`
Expected: PASS — new Python/Go/Rust coverage tests green; existing TS tests still green; updated unsupported-languages tests green.

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/verification/mutation/operators.ts test/unit/verification/mutation/mutator.test.ts
git commit -m "feat(mutation): polyglot operators for Python/Go/Rust"
```

---

### Task 2: Language-aware comment skipping in the mutator

**Files:**
- Modify: `src/verification/mutation/mutator.ts:41-42`
- Test: `test/unit/verification/mutation/mutator.test.ts` (add comment-skip describe)

**Interfaces:**
- Consumes: `generateMutants` (its `GenerateMutantsInput.language` field, already present); the `py:*` operator ids from Task 1.
- Produces: no signature change — `generateMutants` now skips `#`-prefixed lines when `language === "python"`, and keeps skipping `//`/`/*`/`*` for every other language.

- [ ] **Step 1: Write the failing tests**

In `test/unit/verification/mutation/mutator.test.ts`, append:

```ts
describe("generateMutants — language-aware comment skipping", () => {
  test("Python '#' comment line is not mutated", () => {
    const mutants = generateMutants({ source: "# a == b\n", language: "python", file: "f.py" });
    expect(mutants).toEqual([]);
  });

  test("non-Python '//' comment line is still skipped", () => {
    const mutants = generateMutants({ source: "// a == b\n", language: "rust", file: "f.rs" });
    expect(mutants).toEqual([]);
  });

  test("Python leading '#' line is skipped but a real code line still mutates", () => {
    const source = "# comment == here\nx = a == b\n";
    const mutants = generateMutants({ source, language: "python", file: "f.py" });
    expect(mutants.every((m) => m.line !== 1)).toBe(true);
    expect(mutants.some((m) => m.operatorId === "py:cmp-flip" && m.line === 2)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `timeout 30 bun test test/unit/verification/mutation/mutator.test.ts --timeout=5000`
Expected: FAIL — the Python `#` comment is currently mutated (`# a != b` mutant), so "Python '#' comment line is not mutated" and the line-1 assertion fail. (The `//`-rust case already passes — it's a regression guard.)

- [ ] **Step 3: Make the comment-skip language-aware**

In `src/verification/mutation/mutator.ts`, replace these two lines (currently ~41-42):

```ts
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) continue;
```

with:

```ts
    const trimmed = line.trim();
    const commentPrefixes = language === "python" ? ["#"] : ["//", "/*", "*"];
    if (commentPrefixes.some((prefix) => trimmed.startsWith(prefix))) continue;
```

(`language` is already destructured from `input` at the top of `generateMutants`.)

- [ ] **Step 4: Run the mutation suite to verify pass**

Run: `timeout 60 bun test test/unit/verification/mutation/ --timeout=10000`
Expected: PASS — comment-skip tests green, all prior tests still green.

- [ ] **Step 5: Typecheck + lint (final gate)**

Run: `bun run typecheck && bun run lint`
Expected: no errors (Biome, file-size, alias-internals all pass).

- [ ] **Step 6: Commit**

```bash
git add src/verification/mutation/mutator.ts test/unit/verification/mutation/mutator.test.ts
git commit -m "feat(mutation): language-aware comment skipping (Python #)"
```

---

## Self-Review

**1. Spec coverage** (design doc §Components):
- `operators.ts`: populate Python/Go/Rust, register incl. `rust` → Task 1 Step 3. ✓
- DRY refactor (`makeBooleanFlip` factory, shared `ARITHMETIC_PAIRS`, `UNIVERSAL_COMPARISON_PAIRS`, `makeOperators`) → Task 1 Step 3. ✓
- Python `True`/`False`; Go/Rust `true`/`false`; TS keeps `===`/`!==` via `TS_COMPARISON_PAIRS` → Task 1 Step 3 + Python bool-flip test. ✓
- `mutator.ts` language-aware comment skip → Task 2 Step 3. ✓
- Update existing `python→[]`/`go→[]` assertions → Task 1 Step 1 (replace block). ✓
- Known limitation (inline comments) — documented in design, no code (YAGNI), matches TS. ✓ (no task needed)
- Non-goals (no logical ops, no classify/apply/mutation-check changes) — nothing in the plan touches them. ✓

**2. Placeholder scan:** No TBD/TODO; complete code in every code step; every command has expected output. ✓

**3. Type consistency:** `MutationOperator` from `./types`; operator ids `py:*`/`go:*`/`rust:*`/`ts:*` consistent between Step 3 tables and the test assertions; `makeBooleanFlip`/`makeOperators`/`flipWithPairs`/`applyComparisonBracketFlip`/`ARITHMETIC_PAIRS`/`UNIVERSAL_COMPARISON_PAIRS`/`TS_COMPARISON_PAIRS` all defined before use within the single-file replacement; `generateMutants` signature unchanged; `Mutant.after`/`.operatorId`/`.line` fields match `types.ts`. ✓

**Deliberate deviation from the design's test plan:** the design listed a separate `operators.test.ts` exercising `getOperatorsForLanguage`. Instead, operator coverage is asserted through `generateMutants` (the public `@/verification` export) via the `operatorId` field — this keeps `getOperatorsForLanguage` internal (no barrel export just for a test, avoiding an alias-into-internal lint violation) while giving equivalent per-language, per-family coverage.
