# Config Patterns

> Project-specific configuration patterns for nax. SSOT for config conventions — no equivalent section in `docs/architecture/`.

## Defaults & Validation

Defaults live in the Zod schema (`src/config/schemas.ts`) via `.default()`. `DEFAULT_CONFIG` in `src/config/defaults.ts` is a thin derived export — never a hand-maintained literal.

- `NaxConfigSchema.safeParse(rawConfig)` — for layered/user-provided config. Surface issues as a readable error, never throw silently.
- `NaxConfigSchema.parse({})` — only for SSOT default derivation.

```typescript
export const DEFAULT_CONFIG = NaxConfigSchema.parse({}) as NaxConfig;
```

New default? Add it in the schema first.

## Layering Order

Later overrides earlier:

1. `DEFAULT_CONFIG` (schema-derived)
2. Global — `~/.nax/config.json`
3. Project — `<workdir>/.nax/config.json`
4. CLI overrides

Merge via `deepMergeConfig`, then `safeParse` once at the end.

## Agent Config Shape (ADR-012)

Agent selection lives under `config.agent` — `agent.default` is the primary, `agent.fallback.map` is the per-agent chain. Read `agent.default` only via `resolveDefaultAgent(config)`.

Legacy `autoMode.defaultAgent` / `autoMode.fallbackOrder` are **rejected at parse time** by `rejectLegacyAgentKeys` in `src/config/loader.ts` — silently stripping would mask the migration. See `docs/adr/ADR-012-agent-manager-ownership.md`.

## Migrating Deprecated Keys

| Change | Pattern |
|:---|:---|
| Benign rename, no semantic change | Migration shim — log warning, copy to new key, delete old |
| Removal that would silently drop behaviour | Pre-parse guard — throw `NaxError` with per-key migration hints |

Zod's default `.strip()` mode would silently swallow removed keys, so behaviour-changing removals must be guarded explicitly. Reference: `rejectLegacyAgentKeys` in `src/config/loader.ts`.

## Config Selectors & Slice Types

Each subsystem declares its config dependency through a named selector in [src/config/selectors.ts](../../src/config/selectors.ts) — and that file owns both the selector and its derived type alias.

```typescript
// src/config/selectors.ts
export const planConfigSelector = pickSelector("plan", "plan", "debate");
export type PlanConfig = ReturnType<typeof planConfigSelector.select>;
```

Consumers split value (runtime) and type (compile-time) imports:

```typescript
// ✅ Correct
import { planConfigSelector } from "../config";
import type { PlanConfig } from "../config/selectors";

// ❌ Wrong — re-derived per file (drifts; obscures naming bugs)
type PlanConfig = ReturnType<typeof planConfigSelector.select>;
```

Slice types are imported from the **leaf path** (`../config/selectors`), not the barrel — names like `DebateConfig` / `TddConfig` / `QualityConfig` collide with full-schema types of the same name. Type-only imports are erased at compile time and don't fragment singletons.

## Imports & Access

- `import type` for config types. Inside `src/config/*`, prefer leaf paths (`./types`, `./selectors`) to avoid barrel cycles.
- Outside `src/config/*`, import selector **values** from the barrel (`../config`) and selector **types** from the leaf (`../config/selectors`).
- Read parsed config (`config.execution?.timeout`), never raw JSON.
- Validate and coerce env vars at the config boundary — never deep inside subsystems.
