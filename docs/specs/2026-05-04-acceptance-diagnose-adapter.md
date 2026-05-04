# Acceptance-Diagnose Adapter Extraction

**Date:** 2026-05-04
**Author:** William Khoo, Claude
**Related:** ADR-021 (Finding Type SSOT) — phase 8 follow-up
**Scope:** Refactor only. No behaviour change.
**Risk:** Low.

---

## Context

ADR-021 phase 8 migrated the `acceptanceDiagnoseOp` LLM schema to emit `findings: Finding[]` instead of `testIssues: string[]` / `sourceIssues: string[]`. The schema migration shipped, but the raw-record-to-`Finding` conversion was implemented **inline in the op's `parse()` callback** at [src/operations/acceptance-diagnose.ts:62-77](../../src/operations/acceptance-diagnose.ts#L62) rather than in a named adapter under [src/findings/adapters/](../../src/findings/adapters/).

Every other producer follows the "one adapter file per producer" pattern:

| Producer | Adapter file |
|:---|:---|
| Lint (Biome) | [src/findings/adapters/lint.ts](../../src/findings/adapters/lint.ts) — `lintDiagnosticToFinding` |
| Typecheck (tsc) | [src/findings/adapters/typecheck.ts](../../src/findings/adapters/typecheck.ts) — `tscDiagnosticToFinding` |
| Plugin reviewers | [src/findings/adapters/plugin.ts](../../src/findings/adapters/plugin.ts) — `pluginToFinding` |
| Semantic review | [src/findings/adapters/semantic-review.ts](../../src/findings/adapters/semantic-review.ts) — `reviewFindingToFinding` |
| Test runner (AC failure / sentinel) | [src/findings/adapters/test-runner.ts](../../src/findings/adapters/test-runner.ts) — `acFailureToFinding`, `acSentinelToFinding` |
| **Acceptance diagnose** | **inline in `parse()` — inconsistent** |

The inline mapping is functionally correct but:
- Cannot be unit-tested in isolation (must mock the full op)
- Cannot be reused if another diagnose-style op (e.g. a future `tddVerifierToFindings`) wants the same record-validation logic
- Is the only adapter whose tests live in `test/unit/operations/` rather than `test/unit/findings/adapters/`

## Goals

1. Extract the raw-record-to-`Finding` mapping into `src/findings/adapters/acceptance-diagnose.ts`.
2. Re-export from the `src/findings/adapters/index.ts` barrel and `src/findings/index.ts` top-level barrel.
3. Replace the inline block in `acceptanceDiagnoseOp.parse()` with a single adapter call.
4. Move existing tests of the inline mapping (if any) to `test/unit/findings/adapters/acceptance-diagnose.test.ts`. Add coverage for malformed records, missing `category`, missing `message`, and the empty-array case.

## Non-goals

- No prompt schema changes.
- No changes to the `AcceptanceDiagnoseOutput` shape.
- No changes to fallback semantics (`FALLBACK` constant stays in the op).
- No changes to acceptance fix routing or `runFixCycle` integration.

## Design

### Adapter signature

```typescript
// src/findings/adapters/acceptance-diagnose.ts

import type { Finding, FindingSeverity, FixTarget } from "../types";

/**
 * Convert a single raw record from the LLM-emitted `findings[]` array into
 * a Finding. Returns null when the record is malformed (missing required
 * fields). Callers filter nulls.
 *
 * Required fields on the raw record:
 *   - message: string
 *   - category: string
 *
 * Optional fields (preserved when present and well-typed):
 *   severity, fixTarget, file, line, suggestion
 */
export function acceptanceDiagnoseRawToFinding(
  raw: Record<string, unknown>,
): Finding | null {
  if (typeof raw.message !== "string" || typeof raw.category !== "string") {
    return null;
  }
  return {
    source: "acceptance-diagnose",
    severity: (typeof raw.severity === "string" ? raw.severity : "error") as FindingSeverity,
    category: String(raw.category),
    message: String(raw.message),
    fixTarget: (raw.fixTarget as FixTarget | undefined) ?? undefined,
    file: typeof raw.file === "string" ? raw.file : undefined,
    line: typeof raw.line === "number" ? raw.line : undefined,
    suggestion: typeof raw.suggestion === "string" ? raw.suggestion : undefined,
  };
}

/**
 * Bulk variant — converts an array of raw records, dropping malformed entries.
 * Returns [] when input is not an array or all entries are malformed.
 */
export function acceptanceDiagnoseRawArrayToFindings(
  raw: unknown,
): Finding[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is Record<string, unknown> => r !== null && typeof r === "object")
    .map(acceptanceDiagnoseRawToFinding)
    .filter((f): f is Finding => f !== null);
}
```

The bulk variant carries the array-shape guard so the op's `parse()` becomes a one-liner.

### Op-side change

```typescript
// src/operations/acceptance-diagnose.ts — parse() body

const raw = tryParseLLMJson<Record<string, unknown>>(output);
if (
  raw &&
  typeof raw.verdict === "string" &&
  typeof raw.reasoning === "string" &&
  typeof raw.confidence === "number"
) {
  const base = {
    verdict: raw.verdict as AcceptanceDiagnoseOutput["verdict"],
    reasoning: raw.reasoning,
    confidence: raw.confidence,
  };
  const findings = acceptanceDiagnoseRawArrayToFindings(raw.findings);
  if (findings.length > 0) return { ...base, findings };
  return base;
}
return FALLBACK;
```

Net delta: ~16 lines removed from the op, ~40 lines added in the adapter (most are doc comments and the bulk variant).

### Barrel exports

```typescript
// src/findings/adapters/index.ts
export {
  acceptanceDiagnoseRawToFinding,
  acceptanceDiagnoseRawArrayToFindings,
} from "./acceptance-diagnose";

// src/findings/index.ts
export {
  acceptanceDiagnoseRawArrayToFindings,
  acceptanceDiagnoseRawToFinding,
  // …existing exports
} from "./adapters";
```

## Test plan

New file: `test/unit/findings/adapters/acceptance-diagnose.test.ts`.

| Case | Input | Expected |
|:---|:---|:---|
| Well-formed minimal record | `{ message: "x", category: "stdout-capture" }` | `Finding{ source: "acceptance-diagnose", severity: "error", category: "stdout-capture", message: "x" }` |
| All optional fields present | `{ message, category, severity: "warning", fixTarget: "test", file, line: 12, suggestion }` | All fields preserved |
| Missing `message` | `{ category: "x" }` | `null` (single) / `[]` (bulk) |
| Missing `category` | `{ message: "x" }` | `null` (single) / `[]` (bulk) |
| Wrong types | `{ message: 1, category: 2 }` | `null` |
| Mixed array — one valid, one malformed | `[{ message, category }, { message }]` | length 1, valid record only |
| Non-array bulk input | `"not an array"`, `null`, `undefined`, `{}` | `[]` |
| Empty array | `[]` | `[]` |
| Severity coercion | `{ message, category, severity: 42 }` | `severity: "error"` (default) |
| `fixTarget` coercion | `{ message, category, fixTarget: "weird" }` | Passes through (no enum check at this layer — runtime trusts ADR-021 schema; future tightening tracked separately) |

Additionally — port any existing inline-mapping coverage from `test/unit/operations/acceptance-diagnose.test.ts` into the new file; thin the op's tests down to verdict/reasoning/confidence parsing and the FALLBACK path.

## Migration steps

1. Create `src/findings/adapters/acceptance-diagnose.ts` with both functions.
2. Re-export from `src/findings/adapters/index.ts` and `src/findings/index.ts`.
3. Replace the inline mapping block in `src/operations/acceptance-diagnose.ts` with the bulk-adapter call. Import from the `src/findings` barrel (not the leaf path) per `forbidden-patterns.md`.
4. Add `test/unit/findings/adapters/acceptance-diagnose.test.ts` with the table above.
5. Trim `test/unit/operations/acceptance-diagnose.test.ts` if it duplicates the new coverage.
6. Run:
   - `timeout 30 bun test test/unit/findings/adapters/ --timeout=5000`
   - `timeout 30 bun test test/unit/operations/acceptance-diagnose.test.ts --timeout=5000`
   - `timeout 60 bun test test/unit/execution/lifecycle/acceptance-loop.test.ts --timeout=5000`
   - `bun run lint`
   - `bun run typecheck`

## Acceptance criteria

- `src/operations/acceptance-diagnose.ts` no longer constructs `Finding` objects directly — it imports the adapter and delegates.
- All existing acceptance-loop / acceptance-fix tests pass without modification.
- New adapter test file covers the 10 cases in the test plan above.
- `grep -rn "source: \"acceptance-diagnose\"" src/` returns hits **only** in `src/findings/adapters/acceptance-diagnose.ts` and `src/findings/types.ts` (doc-comment) — no inline construction elsewhere.
- Biome and tsc both pass clean.

## Out of scope

- Tightening the runtime severity / fixTarget / category enum checks. The current behaviour preserves whatever the LLM emits (matching pre-migration behaviour); a stricter validator is a separate change.
- Promoting the inline construction in [src/operations/acceptance-diagnose.ts:62-77](../../src/operations/acceptance-diagnose.ts#L62) into a Zod schema. Tracked under the broader LLM-schema-validation work — out of scope here.
- Sharing the record-shape with a future TDD verifier adapter (see ADR-021 status banner — not consumed today).

## References

- ADR-021 §6 — Acceptance diagnose prompt schema change (the source of the original migration)
- [src/operations/acceptance-diagnose.ts:62-77](../../src/operations/acceptance-diagnose.ts#L62) — current inline construction
- [src/findings/adapters/](../../src/findings/adapters/) — sibling adapters for reference
- `.claude/rules/forbidden-patterns.md` — barrel-import discipline
