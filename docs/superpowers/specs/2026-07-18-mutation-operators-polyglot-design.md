# Design — Polyglot Mutation Operators (Python / Go / Rust)

> Date: 2026-07-18
> Origin: Gap Analysis 2026-07-18 §3.2 / §6 item #10 (sub-area C).
> Scope: `src/verification/mutation/operators.ts` + `src/verification/mutation/mutator.ts`.

## Problem

The mutation spot-check (`src/operations/mutation-check.ts`) injects deterministic
bugs into just-implemented code so the story's own tests get a chance to notice
weak coverage. It resolves `language = detectLanguage(packageDir)` and calls
`generateMutants({ source, language, file })`, which applies
`getOperatorsForLanguage(language)` operators line-by-line.

Only TypeScript/JavaScript have operators. `PYTHON_OPERATORS` and `GO_OPERATORS`
are empty stubs (`[]`); Rust is absent from the `SUPPORTED_LANGUAGES` map. So for
Python/Go/Rust packages the mutator generates **zero mutants** — the spot-check is
a silent no-op, contradicting nax's first-class polyglot posture (Rust is
first-class in discovery, analyze, and — as of sub-area B — test-output parsing).

## Scope decision

**TS parity — the same 4 operator families TS has, no more.** No logical-operator
flips (`and`/`or`, `&&`/`||`) because TS itself has none (keeping true parity, not
making the new languages richer than TS). Python's boolean literals are the one
required language delta.

## Contract (unchanged)

Operators are pure, deterministic, line-level regex transforms:
`{ id: string; apply(snippet): string | string[] }`. No I/O, no throws.
Unsupported/undetected language → `getOperatorsForLanguage` returns `[]` →
`generateMutants` returns `[]`.

## Components

### 1. `src/verification/mutation/operators.ts`

Populate `PYTHON_OPERATORS`/`GO_OPERATORS`, add `RUST_OPERATORS`, wire all into
`SUPPORTED_LANGUAGES`. Small DRY refactor of the existing TS code so all four
languages share primitives:

- `applyBooleanFlip` (hardcoded `true`/`false`) → factory
  `makeBooleanFlip(trueLit, falseLit): (snippet) => string[]`. TS/Go/Rust use
  `("true","false")`; **Python uses `("True","False")`**.
- `TS_ARITHMETIC_PAIRS` → shared `ARITHMETIC_PAIRS` (identical content: `+↔-`,
  `*↔/`), used by all four.
- New `UNIVERSAL_COMPARISON_PAIRS` = `[==↔!=, >=↔<=]` — the TS subset **minus**
  JS-only `===`/`!==`. TS keeps its richer `TS_COMPARISON_PAIRS`.
- `applyComparisonBracketFlip` (whitespace-guarded `>↔<`) is already
  language-neutral — reused verbatim.

A factory removes per-language duplication:

```ts
function makeOperators(prefix: string, trueLit: string, falseLit: string): MutationOperator[] {
  return [
    { id: `${prefix}:cmp-flip`,         apply: (s) => flipWithPairs(UNIVERSAL_COMPARISON_PAIRS, s) },
    { id: `${prefix}:cmp-bracket-flip`, apply: applyComparisonBracketFlip },
    { id: `${prefix}:bool-flip`,        apply: makeBooleanFlip(trueLit, falseLit) },
    { id: `${prefix}:arith-flip`,       apply: (s) => flipWithPairs(ARITHMETIC_PAIRS, s) },
  ];
}
const PYTHON_OPERATORS = makeOperators("py",   "True",  "False");
const GO_OPERATORS     = makeOperators("go",   "true",  "false");
const RUST_OPERATORS   = makeOperators("rust", "true",  "false");
```

TS keeps its own explicit `TYPESCRIPT_OPERATORS` table (it has the extra
`===`/`!==` pairs). Its boolean apply switches from `applyBooleanFlip` to
`makeBooleanFlip("true","false")` — behavior and the `ts:bool-flip` id unchanged.

`SUPPORTED_LANGUAGES` gains `["rust", RUST_OPERATORS]` and the python/go entries
now point at populated tables.

### 2. `src/verification/mutation/mutator.ts`

Make the comment-skip language-aware so Python `#` comment lines aren't mutated
(a mutated comment changes no behavior → the mutant "survives" → a false
weak-tests alarm):

```ts
const commentPrefixes = language === "python" ? ["#"] : ["//", "/*", "*"];
if (commentPrefixes.some((p) => trimmed.startsWith(p))) continue;
```

`language` is already a field of `GenerateMutantsInput`. Rust `#[derive(...)]`
attributes and TS `#private` fields correctly stay mutable (`#` is Python-only).

## Known limitation (documented, not fixed — matches existing TS behavior)

Line-level regex has no string/inline-comment awareness. A trailing inline
comment carrying an operator (`x = 1  # y == z`) can still be mutated → a
survived comment-only mutant. The existing TS operators have the identical
limitation; a tokenizer fix is out of scope (YAGNI). The full-comment-line skip
handles the common case.

## Error handling

Pure functions, no I/O, no throws. `mutator.ts` change is a one-line prefix swap.

## Testing

- **`test/unit/verification/mutation/operators.test.ts`** (new) —
  `getOperatorsForLanguage("python"|"go"|"rust")` returns the 4 expected ids
  (`py:cmp-flip`, `py:cmp-bracket-flip`, `py:bool-flip`, `py:arith-flip`, etc.);
  `undefined` and an unknown language → `[]`.
- **`test/unit/verification/mutation/mutator.test.ts`** (extend) — per-language
  `generateMutants` coverage: Python `True`→`False`, Go/Rust `true`→`false`, a
  comparison (`==`→`!=`) and an arithmetic (`+`→`-`) case each; a Python
  `#`-comment line yields no mutant. **Update the existing "unsupported
  languages" assertions** at `mutator.test.ts:60,64` (`python→[]`, `go→[]`) —
  those languages are now supported and yield mutants; the `undefined→[]` case
  stays.

## Non-goals (YAGNI)

- No logical-operator flips (`and`/`or`, `&&`/`||`) — TS has none either.
- No `===`/`!==` for non-JS languages.
- No string-literal / inline-comment tokenization.
- No changes to `classify.ts`, `apply.ts`, or `mutation-check.ts` — already
  language-agnostic.

## Completes item #10

Sub-areas A (fix-diagnosis polyglot, PR #1345) and B (test-output parser parity,
PR #1346) are shipped. This is the final sub-area of gap item #10.
