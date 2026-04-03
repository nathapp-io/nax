# SPEC: Single-Source Config Defaults (Option A — Schema-Driven)

## Summary

Eliminate the dual-source config defaults problem by making Zod schemas the single source of truth (SSOT). `DEFAULT_CONFIG` becomes a derived constant — `NaxConfigSchema.parse({})` — rather than a hand-maintained 267-line object literal. This prevents drift between `defaults.ts` and `schemas.ts` that caused silent behavior differences depending on code path (issue #168).

## Motivation

Config defaults are defined in two places:

1. **`src/config/defaults.ts`** — `DEFAULT_CONFIG` object literal (267 lines, manually maintained)
2. **`src/config/schemas.ts`** — Zod `.default()` values on each field (72 `.default()` calls)

These can drift apart. The normal `loadConfig()` path starts from `DEFAULT_CONFIG` and deep-merges user layers, so Zod defaults never fire (fields are already populated). But any code path that calls `SomeSchema.parse({})` directly gets Zod's defaults, which may differ.

**Real-world example (PR #162):** `defaults.ts` was updated to `maxAcCount: 10, maxDescriptionLength: 3000, maxBulletPoints: 12` but `schemas.ts` kept the old values (`6, 2000, 8`). The drift was invisible until a code path used the schema parse directly.

After this change:
- One place to update defaults (Zod schema `.default()` values)
- `DEFAULT_CONFIG` is always in sync — it's derived, not duplicated
- Drift is structurally impossible

## Design

### Approach: Schema-driven derivation

Replace the hand-maintained `DEFAULT_CONFIG` object literal with:

```typescript
// src/config/defaults.ts
import { NaxConfigSchema } from "./schemas";
import type { NaxConfig } from "./types";

export const DEFAULT_CONFIG: NaxConfig = NaxConfigSchema.parse({}) as NaxConfig;
```

Zod `.default()` values become the authoritative source. The 267-line object literal is deleted.

### Circular dependency prevention

Current dependency: `schemas.ts` imports `DEFAULT_CONFIG` from `defaults.ts` in two places:
1. Line 41: `DEFAULT_CONFIG.autoMode.defaultAgent` — used as Zod `.default()` value for `defaultAgent`
2. Line 534: `DEFAULT_CONFIG.debate` — used as Zod `.default()` factory for debate config

After the change, `defaults.ts` imports from `schemas.ts`, so `schemas.ts` cannot import from `defaults.ts`. These two references must be inlined as literal values in the schema:
- `defaultAgent` default → inline `"claude"` string literal
- `debate` default → inline the debate config object literal directly in the `.default()` call

### `loadConfig()` — no changes needed

`loadConfig()` already does `structuredClone(DEFAULT_CONFIG) → deep-merge layers → NaxConfigSchema.safeParse()`. Since `DEFAULT_CONFIG` is now `NaxConfigSchema.parse({})`, the flow is: Zod defaults → user layers → Zod validation. Functionally identical, but the base is guaranteed in sync.

### `config-get.ts` — no changes needed

Uses `DEFAULT_CONFIG` via import; derived value works identically.

### Failure handling

- If a required Zod `.default()` is accidentally removed, `NaxConfigSchema.parse({})` throws at module load time (fail-fast). This is better than the current behavior where drift is silent.
- The guard test (Story 3) catches any `.default()` removal at CI time.

## Stories

### US-001: Inline DEFAULT_CONFIG references in schemas.ts

**Depends on:** none

Remove the `import { DEFAULT_CONFIG } from "./defaults"` in `schemas.ts`. Inline the two referenced values:
- `DEFAULT_CONFIG.autoMode.defaultAgent` → `"claude"` literal
- `DEFAULT_CONFIG.debate` → debate config object literal in `.default()` factory

**Acceptance Criteria:**
1. `schemas.ts` has zero imports from `defaults.ts` or `defaults`
2. `NaxConfigSchema.parse({})` returns an object where `autoMode.defaultAgent === "claude"`
3. `NaxConfigSchema.parse({})` returns an object where `debate.enabled === false` and `debate.stages.plan.enabled === true`
4. `NaxConfigSchema.parse({}).debate` deep-equals the current `DEFAULT_CONFIG.debate` value (all fields match)

### US-002: Derive DEFAULT_CONFIG from schema parse

**Depends on:** US-001

Replace the hand-maintained object literal in `defaults.ts` with `NaxConfigSchema.parse({})`. Delete all ~250 lines of the object literal.

**Acceptance Criteria:**
1. `defaults.ts` exports `DEFAULT_CONFIG` as `NaxConfigSchema.parse({}) as NaxConfig`
2. `defaults.ts` is fewer than 15 lines (imports + single export + comment)
3. `DEFAULT_CONFIG.execution.sessionTimeoutSeconds === 3600` (spot-check: value matches current schema default)
4. `DEFAULT_CONFIG.execution.rectification.maxRetries === 2` (spot-check: nested value matches)
5. `DEFAULT_CONFIG.quality.requireTypecheck === true` (spot-check: boolean default matches)
6. `loadConfig()` called with no config files returns a config identical to `DEFAULT_CONFIG` (round-trip equivalence)

### US-003: Guard test — schema defaults match DEFAULT_CONFIG

**Depends on:** US-002

Add a CI guard test that prevents future drift by asserting `NaxConfigSchema.parse({})` deep-equals `DEFAULT_CONFIG`. Since `DEFAULT_CONFIG` is now derived from the schema, this test is trivially true today — its value is catching future regressions if someone accidentally re-introduces a separate defaults object or breaks the derivation.

Also: verify that every top-level key in `NaxConfig` has a `.default()` on the corresponding schema field (so `parse({})` produces a complete config).

**Acceptance Criteria:**
1. Test file exists at `test/unit/config/defaults-ssot.test.ts`
2. Test asserts `deepEqual(NaxConfigSchema.parse({}), DEFAULT_CONFIG)` passes
3. Test asserts every top-level key of `DEFAULT_CONFIG` is present in `NaxConfigSchema.parse({})` (no missing defaults)
4. Test asserts `NaxConfigSchema.parse({})` does not throw (schema is self-consistent with all defaults)
5. Existing tests in `test/unit/config/defaults.test.ts` continue to pass without modification

### Context Files (optional)
- `src/config/defaults.ts` — current 267-line object literal to be replaced
- `src/config/schemas.ts` — Zod schemas with 72 `.default()` calls; remove `DEFAULT_CONFIG` import
- `src/config/loader.ts` — `loadConfig()` consumer of `DEFAULT_CONFIG`; no changes expected
- `src/config/schema.ts` — barrel re-export; no changes expected
- `test/unit/config/defaults.test.ts` — existing tests that must keep passing
