# Native Catalog Overrides (`agent.native.catalogOverrides`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator declare a native model that exists at the provider but is newer than the bundled pi-ai catalog snapshot, via `agent.native.catalogOverrides`, threaded into nax-ai's already-supported `providerOverrides` at client-build time.

**Architecture:** A new strict Zod schema under `agent.native.catalogOverrides` mirrors nax-ai's `ProviderOverride`/`ResolvedModel` declaration record (provider-scoped, complete values, no patches). `AgentManagerConfig` already carries `agent` (the selector picks it), so `createAgentRegistry` reads the config and hands the overrides to `NativeAgentAdapter`, which passes them to `getNativeClient()`. The client builder maps them to nax-ai `ProviderOverride[]` and passes them to `createClient` once per process; a cache-key guard makes a second, different override set a loud error instead of a silent mismatch. The override sits **below** every pin route (tier entries, literal `{agent, model}` pins, fallback rungs), so all of them resolve the id without further plumbing.

**Tech Stack:** Bun 1.4.0, TypeScript strict, Zod 4, `bun:test`, Biome, `@nathapp/nax-ai@0.1.10` (the installed version already supports adding unknown model ids; no dependency bump).

**Spec:** GitHub issue **#1982** — "No escape hatch for a model newer than the pinned pi-ai catalog snapshot — nax-ai supports providerOverrides, nax never passes it" (https://github.com/nathapp-io/nax/issues/1982), including the analysis comments. Related open bug **#1984** (literal `{agent, model}` pins drop `ModelDef.pricing` / `contextWindow`) is explicitly **out of scope** — shipping this plan gives native users a catalog-level way to declare those values, but the literal-pin resolution seam is its own fix.

**Verification evidence this plan rests on (reproduced against the checked-out tree):**
- `buildNativeClient` (`src/agents/native/client.ts:41-57`) passes no `providerOverrides`; `rg providerOverrides src/` has zero hits.
- Installed `@nathapp/nax-ai` is **0.1.10**: `createClient` forwards `providerOverrides` to `normaliseCatalog`; `normaliseCatalog` applies override models **last** through a `setModel` that lazily creates the provider bucket; `ProviderOverride.models` is `readonly ResolvedModel[]` (complete records).
- Bare catalog: `opencode-go` has **25** models and no `deepseek-flash`. Live models.dev: **36**, `deepseek-flash` present. pi-ai **0.85.1** still has zero occurrences of `deepseek-flash`, so upgrading does not fix it.
- End-to-end: `client.model("opencode-go", "deepseek-flash")` throws `Unknown model "deepseek-flash" for provider "opencode-go".`; with a `ProviderOverride` the same call resolves, count 25 → 26, and sibling `deepseek-v4-flash` keeps input `0.22` / window `1_000_000`.

## Global Constraints

- Runtime is **Bun 1.4.0**; tests are `bun:test` (`describe`/`test`/`expect`). No Node.js-only APIs.
- TypeScript **strict**; no `any` without explicit justification. Biome formatting/lint must pass (`bun run lint`).
- **nax-ai may only be imported from `src/agents/native/**` and `src/agents/catalog/**`** (`bun run check:nax-ai-imports`). Config files must not import nax-ai; the `ThinkingLevel` union is hand-mirrored.
- **Zod v4 does not re-parse `.default()` values.** Verified this session: `z.object({ native: z.object({ a: z.string().default("A"), b: z.array(z.number()).default([]) }).default({ a: "OVERRIDE" }) }).parse({})` returns `{"native":{"a":"OVERRIDE"}}` — `b` is absent. Therefore every literal `.default(...)` object that can contain `catalogOverrides` must be updated alongside the inner field default.
- New config objects use `.strict()`: a typo'd key must be a load error, never silently stripped (the failure mode documented for `pricing.tiers` #1847 and `contextWindow` #1848 at `src/config/schemas-model.ts:26-29,36-40`).
- **Pricing vocabulary:** the catalog override uses nax-ai's catalog names — `input`, `output`, `cacheRead`, `cacheWrite`, per 1M tokens. The existing `ModelDef.pricing` (`inputPer1M`, …) stays the cost-math override. Do not mix them.
- **Scope:** `models` only. No `baseUrl`, no `headers` (credential-redirection risk from project-level config, and not needed for #1982), no `pricing.tiers`. `.strict()` rejects all three loudly; add them later as separate, deliberate work if ever needed.
- The nax-ai client is **built once per process**; the first override set wins. A second, different set must throw `NaxError` (never silently reuse the first).
- Conventional commits, one task per commit. Run commands from the worktree root: `/Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax/.worktrees/feat-1982-catalog-overrides`.

## File Structure

| File | Responsibility | Change |
|:--|:--|:--|
| `src/config/schema-types.ts` | Hand-written config interfaces | Add `ThinkingLevel`, `CatalogPricing`, `CatalogModelOverride`, `ProviderCatalogOverride` |
| `src/config/schemas-model.ts` | Zod schemas for model/tier primitives | Add `ThinkingLevelSchema`, `CatalogPricingSchema`, `CatalogModelOverrideSchema`, `ProviderCatalogOverrideSchema` |
| `src/config/schemas-infra.ts` | Agent schemas | Wire `catalogOverrides` into `AgentNativeConfigSchema` + update its default literal |
| `src/config/schemas.ts` | Root `NaxConfigSchema` + `DEFAULT_CONFIG` default blob | Update the `agent` default literal |
| `src/config/runtime-types-agent.ts` | Public `AgentConfig` / `AgentNativeConfig` interfaces | Add field + type import |
| `src/config/index.ts` | Config barrel | Export the new schemas |
| `src/agents/native/models.ts` | Native model parsing/usage/cost + nax-ai boundary | Add `toProviderOverrides`; export `THINKING_LEVELS` |
| `src/agents/native/client.ts` | nax-ai client build + process memo | Accept overrides; pass `providerOverrides`; cache-key guard |
| `src/agents/native/adapter.ts` | Native adapter | Hold overrides from constructor; pass to `getNativeClient` |
| `src/agents/registry.ts` | Adapter construction from config | Pass `config.agent?.native?.catalogOverrides` to `NativeAgentAdapter` |
| `test/unit/config/catalog-overrides-schema.test.ts` | Schema tests | Create |
| `test/unit/agents/native/models.test.ts` | Mapping + union-mirror tests | Modify |
| `test/unit/agents/native/client.test.ts` | Builder/memo tests | Modify |
| `test/unit/agents/native/adapter.test.ts` | Adapter→client plumbing test | Modify |
| `test/unit/agents/registry-native.test.ts` | Config→registry→client wiring test | Modify |
| `docs/architecture/nax-ai-surface.md` | nax↔nax-ai seam docs | Rewrite the "override seam is unwired" paragraph |
| `docs/guides/configuration.md` | Config reference table | Add `agent.native.catalogOverrides` row + example |

No new source file is introduced: the override schema lives with its sibling schemas, and the mapping lives beside the other nax-ai↔nax translators in `models.ts`.

---

### Task 1: Config schema and public type for `agent.native.catalogOverrides`

**Files:**
- Modify: `src/config/schema-types.ts` (add types after the `ModelDef` interface, before `export type ModelEntry`)
- Modify: `src/config/schemas-model.ts` (add schemas immediately after `TokenPricingSchema`, which ends at line 30)
- Modify: `src/config/schemas-infra.ts:8` (import), `:296-298` (schema field), `:335` (default literal)
- Modify: `src/config/schemas.ts:324` (default literal)
- Modify: `src/config/runtime-types-agent.ts` (import + `AgentNativeConfig` field)
- Modify: `src/config/index.ts:93` (barrel export)
- Test: `test/unit/config/catalog-overrides-schema.test.ts` (create)

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `ProviderCatalogOverrideSchema`, `ThinkingLevelSchema` (Zod, exported from `@/config`); `ProviderCatalogOverride`, `CatalogModelOverride`, `CatalogPricing`, `ThinkingLevel` (types from `@/config/schema-types`); config path `config.agent.native.catalogOverrides: ProviderCatalogOverride[]` (default `[]`).

- [ ] **Step 1: Write the failing test**

Create `test/unit/config/catalog-overrides-schema.test.ts`:

```typescript
/**
 * nax#1982: agent.native.catalogOverrides — explicit catalog entries for
 * native model ids the bundled pi-ai snapshot does not know.
 *
 * Strict on purpose: an unknown key (baseUrl, tiers, a typo) must fail the
 * load, because Zod would otherwise strip it silently — the exact trap
 * documented for pricing.tiers (#1847) and contextWindow (#1848).
 */

import { describe, expect, test } from "bun:test";
import { NaxConfigSchema } from "@/config";
import type { ProviderCatalogOverride } from "@/config/schema-types";

const VALID_OVERRIDE: ProviderCatalogOverride = {
  provider: "opencode-go",
  models: [
    {
      id: "deepseek-flash",
      protocol: "openai-completions",
      contextWindow: 1_000_000,
      supportsTools: true,
      thinkingLevels: ["off", "low", "medium", "high"],
      pricing: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
    },
  ],
};

function parseNative(native: unknown) {
  return NaxConfigSchema.parse({ agent: { native } });
}

describe("agent.native.catalogOverrides", () => {
  test("defaults to an empty array when agent.native is omitted", () => {
    const config = NaxConfigSchema.parse({});
    expect(config.agent?.native?.catalogOverrides).toEqual([]);
  });

  test("round-trips a valid override and stays assignable to the hand-written type", () => {
    const config = NaxConfigSchema.parse({
      agent: { native: { catalogOverrides: [VALID_OVERRIDE] } },
    });
    // Both lines must compile: the Zod output is assignable to the interface
    // that the rest of src/ consumes.
    const parsed: ProviderCatalogOverride | undefined = config.agent?.native?.catalogOverrides?.[0];
    expect(parsed).toEqual(VALID_OVERRIDE);
  });

  test("rejects an unknown key instead of stripping it", () => {
    const withUnknown = { ...VALID_OVERRIDE, baseUrl: "https://example.test" };
    expect(() => parseNative({ catalogOverrides: [withUnknown] })).toThrow();
  });

  test("rejects an unknown thinking level", () => {
    const model = { ...VALID_OVERRIDE.models[0], thinkingLevels: ["turbo"] };
    expect(() => parseNative({ catalogOverrides: [{ provider: "opencode-go", models: [model] }] })).toThrow();
  });

  test("rejects pricing missing a required rate", () => {
    const model = { ...VALID_OVERRIDE.models[0], pricing: { input: 0.15, output: 0.6, cacheRead: 0.003 } };
    expect(() => parseNative({ catalogOverrides: [{ provider: "opencode-go", models: [model] }] })).toThrow();
  });

  test("rejects a negative rate", () => {
    const model = { ...VALID_OVERRIDE.models[0], pricing: { input: -1, output: 0.6, cacheRead: 0.003, cacheWrite: 0 } };
    expect(() => parseNative({ catalogOverrides: [{ provider: "opencode-go", models: [model] }] })).toThrow();
  });

  test("rejects an empty models list", () => {
    expect(() => parseNative({ catalogOverrides: [{ provider: "opencode-go", models: [] }] })).toThrow();
  });

  test("rejects the retracted singular catalogOverride key (the parent block is strict)", () => {
    // The issue's first proposal spelled this `catalogOverride` on the model
    // entry; a user carrying that spelling over must not get it stripped.
    expect(() => parseNative({ catalogOverride: VALID_OVERRIDE })).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/unit/config/catalog-overrides-schema.test.ts --timeout=30000`
Expected: FAIL — `catalogOverrides` is `undefined` for the default test, and the valid-override test throws because Zod strips the unknown `catalogOverrides` key.

- [ ] **Step 3: Add the hand-written types**

In `src/config/schema-types.ts`, immediately after the `ModelDef` interface, before `export type ModelEntry`, add:

```typescript
/**
 * Reasoning levels the catalog may declare, mirrored from nax-ai's
 * `ThinkingLevel` union (nax#1982). nax-ai cannot be imported here
 * (`scripts/check-nax-ai-imports.ts`), so the union is hand-mirrored;
 * `test/unit/agents/native/models.test.ts` pins it against
 * `THINKING_LEVELS` in `src/agents/native/models.ts`, which is itself a
 * compile-time-exhaustive `Record<ThinkingLevel, true>` over the nax-ai
 * union.
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Rates for a catalog override, in the CATALOG's vocabulary (`input`,
 * `output`, `cacheRead`, `cacheWrite`, per 1M tokens) — not `TokenPricing`'s
 * `*Per1M` names. This block describes the simulated catalog entry, so it
 * speaks the catalog's language; `ModelDef.pricing` remains the cost-math
 * override in nax's own vocabulary.
 */
export interface CatalogPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * One complete catalog entry for a model the bundled pi-ai snapshot does not
 * know. Complete, not a patch: nax-ai's `normaliseCatalog` replaces any
 * same-id entry wholesale and lazily creates the provider bucket, so nothing
 * here may be left to the bundled value.
 */
export interface CatalogModelOverride {
  id: string;
  /** nax-ai protocol id, e.g. "openai-completions" or "anthropic-messages". */
  protocol: string;
  contextWindow: number;
  supportsTools: boolean;
  thinkingLevels: ThinkingLevel[];
  pricing: CatalogPricing;
}

/** Provider-scoped catalog overrides — maps 1:1 onto nax-ai's `ProviderOverride[]`. */
export interface ProviderCatalogOverride {
  provider: string;
  models: CatalogModelOverride[];
}
```

- [ ] **Step 4: Add the Zod schemas**

In `src/config/schemas-model.ts`, immediately after `TokenPricingSchema` (line 30), add:

```typescript
/**
 * nax#1982: mirror of nax-ai's `ThinkingLevel` union. See the hand-written
 * `ThinkingLevel` in schema-types.ts for why this is hand-mirrored.
 */
export const ThinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/**
 * Catalog-override rates use nax-ai's `Pricing` vocabulary (per 1M tokens).
 * All four are required: an omitted rate would otherwise have to be guessed,
 * and a guessed cache rate silently mis-bills. `.strict()` so a typo is a
 * load error, not a stripped key.
 */
export const CatalogPricingSchema = z
  .object({
    input: z.number().min(0),
    output: z.number().min(0),
    cacheRead: z.number().min(0),
    cacheWrite: z.number().min(0),
  })
  .strict();

export const CatalogModelOverrideSchema = z
  .object({
    id: z.string().min(1, "id must be non-empty"),
    protocol: z.string().min(1, "protocol must be non-empty"),
    contextWindow: z.number().int().positive(),
    supportsTools: z.boolean(),
    thinkingLevels: z.array(ThinkingLevelSchema),
    pricing: CatalogPricingSchema,
  })
  .strict();

/**
 * Provider-scoped and config-global: keyed on (provider, model id), applied
 * below the config surface in the nax-ai catalog, so every pin route (tier
 * entry, literal {agent, model}, fallback rung) sees it. Deliberately no
 * baseUrl/headers/tiers — see the plan's Global Constraints.
 */
export const ProviderCatalogOverrideSchema = z
  .object({
    provider: z.string().min(1, "provider must be non-empty"),
    models: z.array(CatalogModelOverrideSchema).min(1, "models must not be empty"),
  })
  .strict();
```

- [ ] **Step 5: Wire the field into the agent-native config schema**

In `src/config/schemas-infra.ts`:

1. Extend the import at line 8:

```typescript
import { ConfiguredModelSchema, ModelTierSchema, ProviderCatalogOverrideSchema } from "./schemas-model";
```

2. Replace `AgentNativeConfigSchema` (lines 296-298) with:

```typescript
const AgentNativeConfigSchema = z
  .object({
    transportRetry: AgentNativeTransportRetryConfigSchema.default({ maxAttempts: 3, baseDelayMs: 2000 }),
    /** nax#1982: explicit catalog entries for ids the bundled pi-ai snapshot does not know. */
    catalogOverrides: z.array(ProviderCatalogOverrideSchema).default([]),
  })
  // Strict: the issue's retracted singular `catalogOverride` is the typo a
  // user is most likely to carry over, and a silently stripped key would
  // reproduce the original "Unknown model" failure.
  .strict();
```

3. Update the default literal at line 335 (Zod v4 does not re-parse defaults — Global Constraints). Biome reflows this to multi-line, over the 120-char line width, matching the sibling `acp` default above:

```typescript
  native: AgentNativeConfigSchema.default({
    transportRetry: { maxAttempts: 3, baseDelayMs: 2000 },
    catalogOverrides: [],
  }),
```

- [ ] **Step 6: Update the root default literal**

In `src/config/schemas.ts` line 324, change:

```typescript
      native: { transportRetry: { maxAttempts: 3, baseDelayMs: 2000 } },
```

to:

```typescript
      native: { transportRetry: { maxAttempts: 3, baseDelayMs: 2000 }, catalogOverrides: [] },
```

- [ ] **Step 7: Add the field to the public interface**

In `src/config/runtime-types-agent.ts`:

1. Add at the top of the file:

```typescript
import type { ProviderCatalogOverride } from "./schema-types";
```

2. Add to the `AgentNativeConfig` interface (after the `transportRetry` field):

```typescript
  /**
   * nax#1982: explicit catalog entries for native model ids the bundled
   * pi-ai snapshot does not know. Applied at client-build time, below every
   * config pin route. One list per process — the client is memoised.
   */
  catalogOverrides?: ProviderCatalogOverride[];
```

- [ ] **Step 8: Export the schemas from the config barrel**

In `src/config/index.ts` line 93, change:

```typescript
export { ConfiguredModelSchema, ModelTierSchema, TierConfigSchema } from "./schemas-model";
```

to:

```typescript
export {
  ConfiguredModelSchema,
  ModelTierSchema,
  ProviderCatalogOverrideSchema,
  ThinkingLevelSchema,
  TierConfigSchema,
} from "./schemas-model";
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `bun test test/unit/config/catalog-overrides-schema.test.ts --timeout=30000`
Expected: PASS (8 tests).

- [ ] **Step 10: Run the config schema suite and the type checker**

Run: `bun test test/unit/config/ --timeout=30000 && bun run typecheck`
Expected: all PASS; tsc clean. The existing `test/unit/config/defaults-schema-derive.test.ts` and `agent-schema.test.ts` must stay green — they pin the `DEFAULT_CONFIG`/schema-default relationship the two literal updates above preserve.

- [ ] **Step 11: Commit**

```bash
git add src/config/schema-types.ts src/config/schemas-model.ts src/config/schemas-infra.ts src/config/schemas.ts src/config/runtime-types-agent.ts src/config/index.ts test/unit/config/catalog-overrides-schema.test.ts
git commit -m "feat(config): accept agent.native.catalogOverrides for unknown native models (#1982)"
```

---

### Task 2: Map config overrides onto nax-ai `ProviderOverride[]`

**Files:**
- Modify: `src/agents/native/models.ts` (export `THINKING_LEVELS` at line 78; add `toProviderOverrides` after `toNaxTokenUsage`, which ends at line 127)
- Test: `test/unit/agents/native/models.test.ts` (add a `describe` block; extend the imports at lines 10-16 and the type import at line 17)

**Interfaces:**
- Consumes: `ProviderCatalogOverride`, `ThinkingLevel` from Task 1 (`@/config/schema-types`).
- Produces: `toProviderOverrides(overrides: readonly ProviderCatalogOverride[]): ProviderOverride[]` and exported `THINKING_LEVELS`.

- [ ] **Step 1: Write the failing tests**

In `test/unit/agents/native/models.test.ts`:

1. Extend the `@/agents/native/models` import list (currently lines 10-16) to include `THINKING_LEVELS` and `toProviderOverrides`, and extend the `@/config/schema-types` type import (line 17):

```typescript
import {
  buildRateCard,
  parseNativeModel,
  resolveContextWindow,
  THINKING_LEVELS,
  toNaxTokenUsage,
  toProviderOverrides,
  toThinkingLevel,
} from "@/agents/native/models";
import type { ProviderCatalogOverride, TokenPricing } from "@/config/schema-types";
```

2. Add a new import for `ThinkingLevelSchema` from the config barrel, exactly in the Biome `organizeImports` slot — after the `@/agents/native/models` import and **before** the `@/config/schema-types` type import (a later slot fails `bun run lint`):

```typescript
import { ThinkingLevelSchema } from "@/config";
```

3. Append this `describe` block at the end of the file:

```typescript
describe("toProviderOverrides", () => {
  const override: ProviderCatalogOverride = {
    provider: "opencode-go",
    models: [
      {
        id: "deepseek-flash",
        protocol: "openai-completions",
        contextWindow: 1_000_000,
        supportsTools: true,
        thinkingLevels: ["off", "low", "medium", "high"],
        pricing: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
      },
    ],
  };

  test("stamps the outer provider on every model and carries every declaration field", () => {
    expect(toProviderOverrides([override])).toEqual([
      {
        provider: "opencode-go",
        models: [
          {
            id: "deepseek-flash",
            provider: "opencode-go",
            protocol: "openai-completions",
            contextWindow: 1_000_000,
            supportsTools: true,
            thinkingLevels: ["off", "low", "medium", "high"],
            pricing: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
          },
        ],
      },
    ]);
  });

  test("returns an empty array when there is nothing to override", () => {
    expect(toProviderOverrides([])).toEqual([]);
  });

  test("the config thinking levels mirror the nax-ai union exactly", () => {
    // THINKING_LEVELS is a Record<ThinkingLevel, true> over nax-ai's union, so
    // it fails to compile if nax-ai adds a level. This pins the config enum to
    // the same set so a level can never be accept-here/reject-there.
    expect(ThinkingLevelSchema.options).toEqual(Object.keys(THINKING_LEVELS));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/unit/agents/native/models.test.ts --timeout=30000`
Expected: FAIL — `toProviderOverrides` is not exported (`SyntaxError`/undefined), and `THINKING_LEVELS` is not exported.

- [ ] **Step 3: Implement the mapping and export the union**

In `src/agents/native/models.ts`:

1. Change the const declaration at line 78 from `const THINKING_LEVELS: Record<ThinkingLevel, true> = {` to `export const THINKING_LEVELS: Record<ThinkingLevel, true> = {`.

2. Extend the nax-ai type import at line 9:

```typescript
import type { Pricing, ProviderOverride, ThinkingLevel } from "@nathapp/nax-ai";
```

3. Extend the `@/config/schema-types` type import at line 11:

```typescript
import type { ProviderCatalogOverride, TokenPricing } from "@/config/schema-types";
```

4. Immediately after `toNaxTokenUsage` (ends line 127), add:

```typescript
/**
 * Translate nax's config-side catalog overrides (agent.native.catalogOverrides,
 * nax#1982) into nax-ai's declaration-data `ProviderOverride` records.
 *
 * The override is a COMPLETE entry, not a patch: nax-ai's `normaliseCatalog`
 * applies it last through `setModel`, which replaces any same-id entry and
 * lazily creates the provider bucket — that is what makes an id absent from
 * the bundled pi-ai snapshot resolvable (verified against nax-ai 0.1.10).
 * `provider` is stamped from the outer record because nax-ai's `ResolvedModel`
 * carries it per model.
 */
export function toProviderOverrides(overrides: readonly ProviderCatalogOverride[]): ProviderOverride[] {
  return overrides.map((override) => ({
    provider: override.provider,
    models: override.models.map((model) => ({
      id: model.id,
      provider: override.provider,
      protocol: model.protocol,
      pricing: model.pricing,
      contextWindow: model.contextWindow,
      supportsTools: model.supportsTools,
      thinkingLevels: model.thinkingLevels,
    })),
  }));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/unit/agents/native/models.test.ts --timeout=30000`
Expected: PASS (existing tests + 3 new).

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: clean. This is the compile-time proof that the config `ThinkingLevel[]`/`CatalogPricing` are assignable to nax-ai's `readonly ThinkingLevel[]`/`Pricing`.

- [ ] **Step 6: Commit**

```bash
git add src/agents/native/models.ts test/unit/agents/native/models.test.ts
git commit -m "feat(native): map config catalog overrides to nax-ai ProviderOverride (#1982)"
```

---

### Task 3: Thread overrides through the client build and process memo

**Files:**
- Modify: `src/agents/native/client.ts` (imports; `buildNativeClient` at lines 41-57; `getNativeClient`/`_resetNativeClient` at lines 70-86)
- Test: `test/unit/agents/native/client.test.ts` (add tests; add the `assertNaxError` import)

**Interfaces:**
- Consumes: `toProviderOverrides` from Task 2; `ProviderCatalogOverride` from Task 1.
- Produces: `buildNativeClient(catalogOverrides?: readonly ProviderCatalogOverride[]): Promise<Client>`; `getNativeClient(catalogOverrides?: readonly ProviderCatalogOverride[]): Promise<Client>`; `NaxError` code `NATIVE_CLIENT_OVERRIDES_MISMATCH`.

- [ ] **Step 1: Write the failing tests**

In `test/unit/agents/native/client.test.ts`:

1. Leave the existing `@nathapp/nax-ai` import untouched — it still supplies `createClient` (used at line 18 for `FAKE_CLIENT`) — and add the `@test/helpers` import plus one type import. No `Client` type is needed: `FAKE_CLIENT` is inferred.

```typescript
import { assertNaxError } from "@test/helpers";
import { _clientDeps, _resetNativeClient, buildNativeClient, getNativeClient } from "@/agents/native/client";
import { naxCredentialStore } from "@/agents/native/credentials";
import type { ProviderCatalogOverride } from "@/config/schema-types";
```

(`@test/helpers` sorts before the `@/` imports in Biome's order — see the existing `registry-native.test.ts`. If `organizeImports` still reorders, run `bun run lint:fix`.)

2. Append this `describe` block at the end of the file:

```typescript
describe("catalog overrides", () => {
  function override(id: string): ProviderCatalogOverride {
    return {
      provider: "opencode-go",
      models: [
        {
          id,
          protocol: "openai-completions",
          contextWindow: 1_000_000,
          supportsTools: true,
          thinkingLevels: ["off"],
          pricing: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
        },
      ],
    };
  }

  test("an override makes an id the bundled catalog does not know resolvable", async () => {
    // buildNativeClient is reached directly, not through _clientDeps.build
    // (test/preload.ts sentinels that). The real bundled catalog loads here,
    // as in the existing "constructs a real client" test.
    const client = await buildNativeClient([
      {
        provider: "anthropic",
        models: [
          {
            id: "nax-1982-override-probe",
            protocol: "anthropic-messages",
            contextWindow: 123_456,
            supportsTools: true,
            thinkingLevels: ["off", "high"],
            pricing: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
          },
        ],
      },
    ]);

    const resolved = await client.model("anthropic", "nax-1982-override-probe");
    expect(resolved.provider).toBe("anthropic");
    expect(resolved.contextWindow).toBe(123_456);
    expect(resolved.pricing.input).toBe(1);
  });

  test("passes the override set to the builder and reuses one build for the same set", async () => {
    const set = [override("deepseek-flash")];
    let seen: readonly ProviderCatalogOverride[] | undefined;
    let built = 0;
    _clientDeps.build = async (received) => {
      seen = received;
      built += 1;
      return FAKE_CLIENT;
    };

    const a = await getNativeClient(set);
    const b = await getNativeClient(set);

    expect(seen).toEqual(set);
    expect(built).toBe(1);
    expect(a).toBe(b);
  });

  test("throws when called again with a different override set", async () => {
    _clientDeps.build = async () => FAKE_CLIENT;

    await getNativeClient([override("deepseek-flash")]);
    const err = await getNativeClient([override("mimo-v2-pro")]).catch((e: unknown) => e);
    assertNaxError(err, "native client override mismatch");
    expect(err.code).toBe("NATIVE_CLIENT_OVERRIDES_MISMATCH");
  });

  test("a failed build frees the override key, so a later different set can build", async () => {
    let attempt = 0;
    _clientDeps.build = async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("catalog unavailable");
      return FAKE_CLIENT;
    };

    await expect(getNativeClient([override("deepseek-flash")])).rejects.toThrow("catalog unavailable");
    await expect(getNativeClient([override("mimo-v2-pro")])).resolves.toBe(FAKE_CLIENT);
    expect(attempt).toBe(2);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/unit/agents/native/client.test.ts --timeout=30000`
Expected: FAIL — `getNativeClient` ignores its argument (the "passes the override set" test gets `undefined`), and the real-build override test throws `Unknown model "nax-1982-override-probe" for provider "anthropic".`

- [ ] **Step 3: Implement the client changes**

In `src/agents/native/client.ts`:

1. Replace the imports (lines 12-14) with:

```typescript
import { type Client, createClient, defaultProtocols, defaultProviders } from "@nathapp/nax-ai";

import type { ProviderCatalogOverride } from "@/config/schema-types";
import { NaxError } from "@/errors";
import { naxCredentialStore } from "./credentials";
import { toProviderOverrides } from "./models";
```

2. Replace `buildNativeClient` (lines 41-57) with:

```typescript
export async function buildNativeClient(catalogOverrides: readonly ProviderCatalogOverride[] = []): Promise<Client> {
  return createClient({
    providers: await defaultProviders(),
    protocols: _clientDeps.defaultProtocols({
      // The credential seam: pi resolves the store first, then ambient sources
      // (env vars, AWS profiles, ADC), so a stored credential owns its provider
      // and CI with only an environment variable keeps working. Passing it here
      // is what makes `nax auth login` reach a run. This is the only inlet:
      // ClientOptions once carried a `credentials` field that createClient
      // never read, and nax-ai 0.1.4 removed it for exactly that reason.
      credentials: naxCredentialStore(),
      // Construction-time, like `credentials`: the identity is a constant of
      // the process, so nax-ai takes it here rather than on every request.
      clientApp: NAX_CLIENT_APP,
    }),
    // nax-ai applies these last (`normaliseCatalog`), replacing any bundled
    // entry with the same id and lazily creating the provider bucket when the
    // id is unknown to pi-ai — that is what makes a model newer than the
    // snapshot resolvable (#1982). Omitted entirely when empty so the
    // no-override path stays byte-identical to before.
    ...(catalogOverrides.length > 0 ? { providerOverrides: toProviderOverrides(catalogOverrides) } : {}),
  });
}
```

3. Replace `getNativeClient`/`_resetNativeClient` (lines 70-86) with:

```typescript
let cached: Promise<Client> | undefined;
/** Serialised override set the cached build was created for. */
let cachedOverridesKey: string | undefined;

export async function getNativeClient(catalogOverrides: readonly ProviderCatalogOverride[] = []): Promise<Client> {
  const overridesKey = JSON.stringify(catalogOverrides);
  if (cached !== undefined && overridesKey !== cachedOverridesKey) {
    // The client is a constant of the process (catalog load is ~50ms / ~650KB),
    // so overrides must be collected into ONE set before the first build. A
    // silent second build would swap the client under in-flight sessions.
    throw new NaxError(
      "The native client was already built for a different catalog-override set. " +
        "Collect every override into one agent.native.catalogOverrides list instead of varying them per call.",
      "NATIVE_CLIENT_OVERRIDES_MISMATCH",
      { builtFor: cachedOverridesKey, requested: overridesKey },
    );
  }
  if (cached === undefined) {
    cachedOverridesKey = overridesKey;
    // Cache the promise, not the value, so concurrent callers share one build.
    // Drop it on rejection: a failed catalog load should not be permanent.
    cached = _clientDeps.build(catalogOverrides).catch((err: unknown) => {
      cached = undefined;
      cachedOverridesKey = undefined;
      throw err;
    });
  }
  return cached;
}

/** Clears the memo. Tests only. */
export function _resetNativeClient(): void {
  cached = undefined;
  cachedOverridesKey = undefined;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/unit/agents/native/client.test.ts --timeout=30000`
Expected: PASS (existing 5 tests + 4 new).

- [ ] **Step 5: Typecheck and lint the touched files**

Run: `bun run typecheck && bun x biome check src/agents/native/client.ts test/unit/agents/native/client.test.ts`
Expected: clean. (`bun run check:nax-ai-imports` is part of `bun run lint`; `client.ts` is in an allowed directory.)

- [ ] **Step 6: Commit**

```bash
git add src/agents/native/client.ts test/unit/agents/native/client.test.ts
git commit -m "feat(native): thread catalog overrides into the nax-ai client build (#1982)"
```

---

### Task 4: Wire config → registry → adapter, and document the surface

**Files:**
- Modify: `src/agents/native/adapter.ts` (imports; constructor at lines 106-114; call sites at lines 171 and 232)
- Modify: `src/agents/registry.ts:120` (adapter construction)
- Modify: `test/unit/agents/native/adapter.test.ts` (add one test; extend imports at lines 14-19)
- Modify: `test/unit/agents/registry-native.test.ts` (add wiring test; extend imports)
- Modify: `docs/architecture/nax-ai-surface.md:62-71` (rewrite the override-seam paragraph)
- Modify: `docs/guides/configuration.md` (add a table row after the `agent.native.transportRetry` rows + example)

**Interfaces:**
- Consumes: `ProviderCatalogOverride` (Task 1), `getNativeClient(overrides)` (Task 3).
- Produces: `new NativeAgentAdapter(supportedTiers?, catalogOverrides?)`; `createAgentRegistry` threads `config.agent?.native?.catalogOverrides`.

- [ ] **Step 1: Write the failing adapter test**

In `test/unit/agents/native/adapter.test.ts`:

1. Extend the type import at line 14 (`import type { Client, ClientRequest, ResolvedModel } from "@nathapp/nax-ai";`) — keep it; add below the existing `@/agents/native/client` import:

```typescript
import type { ProviderCatalogOverride } from "@/config/schema-types";
```

2. Append inside the existing `describe("NativeAgentAdapter.complete", …)` block (or immediately after it) this test:

```typescript
  test("passes its catalog overrides to the client build", async () => {
    const overrides: ProviderCatalogOverride[] = [
      {
        provider: "opencode-go",
        models: [
          {
            id: "deepseek-flash",
            protocol: "openai-completions",
            contextWindow: 1_000_000,
            supportsTools: true,
            thinkingLevels: ["off", "high"],
            pricing: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
          },
        ],
      },
    ];
    let seen: readonly ProviderCatalogOverride[] | undefined;
    _clientDeps.build = async (received) => {
      seen = received;
      return fakeClient();
    };

    await new NativeAgentAdapter(undefined, overrides).complete("hi", options());

    expect(seen).toEqual(overrides);
  });
```

- [ ] **Step 2: Write the failing registry wiring test**

In `test/unit/agents/registry-native.test.ts`, extend the imports and add the test:

```typescript
import { afterEach, describe, expect, test } from "bun:test";
import type { Client } from "@nathapp/nax-ai";
import { makeNaxConfig } from "@test/helpers";
import { AcpAgentAdapter } from "@/agents/acp/adapter";
import { NativeAgentAdapter } from "@/agents/native";
import { _clientDeps, _resetNativeClient } from "@/agents/native/client";
import { createAgentRegistry, getAllAgents, KNOWN_AGENT_NAMES } from "@/agents/registry";
import type { ProviderCatalogOverride } from "@/config/schema-types";

const REAL_BUILD = _clientDeps.build;

afterEach(() => {
  _clientDeps.build = REAL_BUILD;
  _resetNativeClient();
});

function fakeNativeClient(): Client {
  const model = {
    id: "deepseek-flash",
    provider: "opencode-go",
    protocol: "openai-completions",
    pricing: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
    contextWindow: 1_000_000,
    supportsTools: true,
    thinkingLevels: [],
  } as const;
  return {
    model: async () => model,
    listModels: async () => [model],
    pricing: () => model.pricing,
    stream: async function* stream() {},
    complete: async () => ({ text: "ok", usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "stop" }),
    validate: () => {},
  };
}
```

Then append, after the existing `describe` block:

```typescript
describe("registry catalog-override wiring", () => {
  test("threads agent.native.catalogOverrides from config into the client build", async () => {
    const overrides: ProviderCatalogOverride[] = [
      {
        provider: "opencode-go",
        models: [
          {
            id: "deepseek-flash",
            protocol: "openai-completions",
            contextWindow: 1_000_000,
            supportsTools: true,
            thinkingLevels: ["off"],
            pricing: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
          },
        ],
      },
    ];
    const config = makeNaxConfig({
      agent: { protocol: "hybrid", default: "native", native: { catalogOverrides: overrides } },
    });
    const registry = createAgentRegistry(config);
    let seen: readonly ProviderCatalogOverride[] | undefined;
    _clientDeps.build = async (received) => {
      seen = received;
      return fakeNativeClient();
    };

    await registry.getAgent("native")?.complete("hi", {
      modelDef: { provider: "opencode-go", model: "opencode-go/deepseek-flash" },
      workdir: process.cwd(),
      resolvedPermissions: { mode: "approve-all" },
    });

    expect(seen).toEqual(overrides);
  });
});
```

- [ ] **Step 3: Run both tests to verify they fail**

Run: `bun test test/unit/agents/native/adapter.test.ts test/unit/agents/registry-native.test.ts --timeout=30000`
Expected: FAIL — `new NativeAgentAdapter(undefined, overrides)` ignores the second argument (`seen` is `undefined`), and the registry test likewise observes `undefined` because the registry never passes config overrides.

- [ ] **Step 4: Implement the adapter changes**

In `src/agents/native/adapter.ts`:

1. Add to the type imports (near the top):

```typescript
import type { ProviderCatalogOverride } from "@/config/schema-types";
```

2. Replace the constructor signature (lines 106-114) with:

```typescript
  constructor(
    supportedTiers: readonly string[] = DEFAULT_TIERS,
    private readonly catalogOverrides: readonly ProviderCatalogOverride[] = [],
  ) {
    this.capabilities = {
      supportedTiers: supportedTiers.length > 0 ? supportedTiers : DEFAULT_TIERS,
      maxContextTokens: CONSERVATIVE_CONTEXT_TOKENS,
      // Explicitly typed, like AcpAgentAdapter does, rather than relying on
      // inference from a literal array.
      features: new Set<"tdd" | "review" | "refactor" | "batch">(["review"]),
    };
  }
```

3. Change both `const client = await getNativeClient();` call sites (lines 171 and 232) to:

```typescript
    const client = await getNativeClient(this.catalogOverrides);
```

- [ ] **Step 5: Implement the registry change**

In `src/agents/registry.ts`, replace line 120:

```typescript
      adapter = name === NATIVE_AGENT ? new NativeAgentAdapter() : new AcpAgentAdapter(name);
```

with:

```typescript
      adapter =
        name === NATIVE_AGENT
          ? // `agent` is already picked by agentManagerConfigSelector, so this
            // needs no ADR-019 selector change: it is declaration data for the
            // native client, not model resolution at the callOp seam.
            new NativeAgentAdapter(undefined, config.agent?.native?.catalogOverrides ?? [])
          : new AcpAgentAdapter(name);
```

- [ ] **Step 6: Run both tests to verify they pass**

Run: `bun test test/unit/agents/native/adapter.test.ts test/unit/agents/registry-native.test.ts --timeout=30000`
Expected: PASS.

- [ ] **Step 7: Update the architecture doc**

In `docs/architecture/nax-ai-surface.md`, replace the paragraph that begins **The override seam exists but is unwired.** with:

```markdown
**The override seam is wired, via `agent.native.catalogOverrides`** (nax#1982).
`ClientOptions.providerOverrides?: readonly ProviderOverride[]` accepts
declaration-data overrides, and `buildNativeClient` now maps the configured list
through `toProviderOverrides` (`src/agents/native/models.ts`) into `createClient`.
nax-ai applies override models last in `normaliseCatalog`, replacing any same-id
entry and lazily creating the provider bucket, so an id absent from the bundled
pi-ai snapshot resolves after the override — the whole point of the field.

```json
"agent": {
  "native": {
    "catalogOverrides": [{
      "provider": "opencode-go",
      "models": [{
        "id": "deepseek-flash",
        "protocol": "openai-completions",
        "contextWindow": 1000000,
        "supportsTools": true,
        "thinkingLevels": ["off", "low", "medium", "high"],
        "pricing": { "input": 0.15, "output": 0.6, "cacheRead": 0.003, "cacheWrite": 0 }
      }]
    }]
  }
}
```

The client is built once per process, so every override in effect must be
collected into this one list; a second, different set throws
`NATIVE_CLIENT_OVERRIDES_MISMATCH` rather than silently reusing the first build.
```

Also fix the pre-existing stale pin note at the top of that file (line 3 says nax-ai is "pinned at **0.1.7**"; `package.json:71` pins `"@nathapp/nax-ai": "0.1.10"`). Update the version to 0.1.10 while the file is open.

- [ ] **Step 8: Update the configuration guide**

In `docs/guides/configuration.md`, after the `agent.native.transportRetry.baseDelayMs` table row, add:

```markdown
| `agent.native.catalogOverrides` | `[]` | Native only. Explicit catalog entries for model ids newer than the bundled pi-ai snapshot. Provider-scoped; each entry is a **complete** record — `id`, `protocol`, `contextWindow`, `supportsTools`, `thinkingLevels`, and `pricing` in nax-ai's `input`/`output`/`cacheRead`/`cacheWrite` per-1M vocabulary. Applied below every pin route (tier entries, literal `{agent, model}` pins, fallback rungs). The client is built once per process, so keep one list. See [nax-ai surface](../architecture/nax-ai-surface.md#context-window). |
```

Then, immediately after the **Scope — what this controls.** paragraph, add:

```markdown
**Declaring a model newer than the catalog (nax#1982).** When the provider's model
exists on models.dev but not in nax's pinned `@earendil-works/pi-ai` snapshot, name
it explicitly rather than waiting on a dependency bump:

```json
"agent": {
  "native": {
    "catalogOverrides": [{
      "provider": "opencode-go",
      "models": [{
        "id": "deepseek-flash",
        "protocol": "openai-completions",
        "contextWindow": 1000000,
        "supportsTools": true,
        "thinkingLevels": ["off", "low", "medium", "high"],
        "pricing": { "input": 0.15, "output": 0.6, "cacheRead": 0.003, "cacheWrite": 0 }
      }]
    }]
  }
}
```

Every value is operator-declared and complete: a wrong `contextWindow` or rate is
your declaration, visible in config, rather than an id that cannot be named at all.
```

- [ ] **Step 9: Commit**

```bash
git add src/agents/native/adapter.ts src/agents/registry.ts test/unit/agents/native/adapter.test.ts test/unit/agents/registry-native.test.ts docs/architecture/nax-ai-surface.md docs/guides/configuration.md
git commit -m "feat(native): wire agent.native.catalogOverrides through the agent registry (#1982)"
```

---

### Task 5: Full verification

**Files:**
- No source changes expected. If (and only if) the per-file coverage gate reports a genuine regression on a touched file, update `scripts/baselines/coverage-per-file-baseline.json` and commit it.

- [ ] **Step 1: Run the lint gate**

Run: `bun run lint`
Expected: PASS. This includes `check:nax-ai-imports` (the new mapping lives in `src/agents/native/models.ts`), `check:import-cycles`, `check:file-sizes`, and `check:nax-error`.

- [ ] **Step 2: Run the type checker**

Run: `bun run typecheck`
Expected: clean for both `tsconfig.json` and `tsconfig.test.json`.

- [ ] **Step 3: Run the affected suites**

Run: `bun test test/unit/config/ test/unit/agents/native/ test/unit/agents/registry-native.test.ts --timeout=30000`
Expected: PASS.

- [ ] **Step 4: Run the full suite**

Run: `bun run test`
Expected: PASS. If a failure appears outside the touched areas, do not paper over it — compare against the baseline recorded in this plan's worktree (targeted baseline at plan time: 1250 pass / 0 fail for `test/unit/agents/native/` + `test/unit/config/`).

- [ ] **Step 5: Run the coverage gate**

Run: `bun run test:coverage`
Expected: PASS. If it flags a file touched by this plan, read `bun run test:coverage:report` before deciding; only run `bun run test:coverage:update` when the gap is legitimate and the tests cannot reasonably cover it, then:

```bash
git add scripts/baselines/coverage-per-file-baseline.json
git commit -m "chore(coverage): record baseline for catalog overrides (#1982)"
```

- [ ] **Step 6: Report**

Summarize: commits made, test counts, the exact config path shipped (`agent.native.catalogOverrides`), and note that #1984 (literal-pin `pricing`/`contextWindow` drop) remains open and untouched.

---

## Self-Review

**Spec coverage** — every #1982 deliverable maps to a task:
- config surface for a provider-scoped override → Task 1 (shape), Task 4 (docs);
- threading into `createClient` at `src/agents/native/client.ts:43` → Task 3;
- "adding an unknown model id works because nax-ai applies overrides last" → Task 2 mapping + Task 3 real-build test;
- "overrides are config-scoped and must be collected into the single process build" → Task 3 cache-key guard;
- "wrong contextWindow/price is the operator's declared error" → strict schema (Task 1) + docs (Task 4).
Out-of-scope items are stated in Global Constraints and the header: #1984, `baseUrl`/`headers`, `pricing.tiers`.

**Placeholder scan** — no `TBD`/`TODO`/"add error handling"/"similar to Task N"; every code and command step is literal.

**Type consistency** — `ProviderCatalogOverride`/`CatalogModelOverride`/`CatalogPricing`/`ThinkingLevel` are defined once (Task 1) and consumed by name in Tasks 2-4; `toProviderOverrides` (Task 2) is the only mapping name; `getNativeClient(overrides)` (Task 3) is called with `this.catalogOverrides` in Task 4; `THINKING_LEVELS` export (Task 2) is what the union-mirror test imports; `NATIVE_CLIENT_OVERRIDES_MISMATCH` appears in Task 3's implementation and is asserted by code in its test via `assertNaxError` (`@test/helpers`).

**Review fixes applied after the two-reviewer pass** — (1) Task 3's import block previously dropped `createClient`, which would have broken the file outright (`TS2304` + Biome `noUnusedImports` for `Client`); it now keeps the existing nax-ai import untouched. (2) `AgentNativeConfigSchema` is now `.strict()` with a test rejecting the issue's retracted singular `catalogOverride` key, closing the silent-strip trap at the parent level. (3) The mismatch test pins the `NaxError` code, not a message regex. (4) Line-width/`organizeImports` formatting was corrected for Biome 120-col and import-sort rules. (5) Stale line anchors were dropped in favour of symbol anchors; the `nax-ai-surface.md` 0.1.7 pin note is corrected to 0.1.10 in Task 4.
