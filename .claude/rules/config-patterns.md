# Config Patterns

> Project-specific configuration patterns for nax. This is the SSOT for config conventions — no equivalent section in `docs/architecture/`.

## Zod Schema Validation

Use Zod `safeParse()` for runtime config validation of layered or user-provided config:

```typescript
import { NaxConfigSchema } from "./schema";

const result = NaxConfigSchema.safeParse(rawConfig);
if (!result.success) {
  const errors = result.error.issues.map((err) => {
    const path = String(err.path.join("."));
    return path ? `${path}: ${err.message}` : err.message;
  });
  throw new Error(`Invalid configuration:\n${errors.join("\n")}`);
}
config = result.data;
```

`parse()` is allowed only for schema-owned invariants where fail-fast is intentional. The main example is config SSOT derivation:

```typescript
import { NaxConfigSchema } from "./schemas";
import type { NaxConfig } from "./types";

export const DEFAULT_CONFIG = NaxConfigSchema.parse({}) as NaxConfig;
```

Rule of thumb:

- `safeParse()` for runtime/user input
- `parse({})` for deriving `DEFAULT_CONFIG` from schema defaults
- do not use `parse()` on layered config unless you explicitly want a throwing boundary

## Config SSOT

Config defaults are schema-driven.

- Zod `.default()` values in `src/config/schemas.ts` are the single source of truth
- `src/config/defaults.ts` must stay a thin derived export of `NaxConfigSchema.parse({})`
- do not reintroduce a hand-maintained `DEFAULT_CONFIG` object literal
- if a new config field needs a default, add it in the schema first

This is the expected shape:

```typescript
import { NaxConfigSchema } from "./schemas";
import type { NaxConfig } from "./types";

export const DEFAULT_CONFIG = NaxConfigSchema.parse({}) as NaxConfig;
```

## Config Schema Structure

Define defaults in the Zod schema itself using `.default()`:

```typescript
const NaxConfigSchema = z.object({
  timeout: z.number().min(1000).default(30000),
  retries: z.number().int().min(0).max(5).default(3),
  agents: z.record(z.object({
    protocol: z.enum(["acp", "cli"]).default("acp"),
  })).default({}),
});
```

## Config Layering Order

Config loads in priority order (later overrides earlier):

1. **Defaults** — `DEFAULT_CONFIG`, derived from Zod schema defaults
2. **Global** — `~/.nax/config.json`
3. **Project** — `<workdir>/.nax/config.json`
4. **CLI overrides** — command-line arguments

```typescript
let rawConfig = structuredClone(DEFAULT_CONFIG as unknown as Record<string, unknown>);
rawConfig = deepMergeConfig(rawConfig, globalConfig);
rawConfig = deepMergeConfig(rawConfig, projectConfig);
rawConfig = deepMergeConfig(rawConfig, cliOverrides);

const result = NaxConfigSchema.safeParse(rawConfig);
```

## Agent Config Shape (ADR-012)

The canonical agent-selection shape lives under `config.agent`:

```typescript
{
  "agent": {
    "protocol": "acp",
    "default": "claude",           // primary agent — resolveDefaultAgent() reads this
    "fallback": {
      "enabled": true,
      "map": { "codex": ["claude"], "claude": ["codex"] },
      "maxHopsPerStory": 2,
      "onQualityFailure": false,
      "rebuildContext": true
    }
  }
}
```

- `agent.default` — string name of the primary agent. Accessed via `resolveDefaultAgent(config)` from `src/agents`.
- `agent.fallback.map` — per-agent chain. `{ primary: [next, ...] }`.
- Old `autoMode.defaultAgent` and `autoMode.fallbackOrder` were **removed in ADR-012 Phase 6**. Loading a config with those keys throws `NaxError CONFIG_LEGACY_AGENT_KEYS` — silently stripping would mask the migration (see `rejectLegacyAgentKeys` in `src/config/loader.ts`).

See `docs/adr/ADR-012-agent-manager-ownership.md` for the full migration.

## Compatibility Shim Pattern

For benign renames of deprecated config keys (no semantic change, no observable user impact), use a migration shim:

```typescript
function applyRemovedStrategyCompat(conf: Record<string, unknown>): Record<string, unknown> {
  const migrated = { ...conf };

  if ("removedStrategy" in conf) {
    logger.warn("config", "removedStrategy is deprecated, use strategies.active instead");
    migrated.strategies = { ...(migrated.strategies as object || {}) };
    (migrated.strategies as Record<string, unknown>)["active"] = conf.removedStrategy;
    delete migrated.removedStrategy;
  }

  return migrated;
}
```

For **behaviour-changing removals** (e.g. fields whose semantic would silently drop if ignored), reject the key at parse time instead of stripping it. Zod's default `.strip()` mode would hide the migration — use a pre-parse guard that throws a `NaxError` with per-key migration hints:

```typescript
// src/config/loader.ts — ADR-012 Phase 6 legacy key guard
function rejectLegacyAgentKeys(conf: Record<string, unknown>): void {
  const legacyKeys: string[] = [];
  const hints: string[] = [];
  const autoMode = conf.autoMode as Record<string, unknown> | undefined;
  if (autoMode && "defaultAgent" in autoMode) {
    legacyKeys.push("autoMode.defaultAgent");
    hints.push("- Move `autoMode.defaultAgent` → `agent.default`");
  }
  // ... additional keys
  if (legacyKeys.length === 0) return;
  throw new NaxError(
    [`Invalid configuration — legacy keys: ${legacyKeys.join(", ")}.`, ...hints].join("\n"),
    "CONFIG_LEGACY_AGENT_KEYS",
    { stage: "config", legacyKeys },
  );
}
```

## Type-Only Imports for Config

Use `import type` for config types. Prefer leaf-module imports inside `src/config/*` to avoid barrel cycles:

```typescript
import type { NaxConfig } from "./types";
// Avoid barrel imports inside config internals when a leaf module is available.
```

## Accessing Config Values

Always access through the parsed config object, never reach into raw JSON:

```typescript
// ✅ Correct
const timeout = config.execution?.timeout ?? DEFAULT_TIMEOUT;

// ❌ Wrong — reaching into raw
const timeout = rawConfig.execution?.timeout ?? DEFAULT_TIMEOUT;
```

## Environment Variable Access

For environment variables, validate and coerce at config boundaries:

```typescript
const envTimeout = process.env.NAX_TIMEOUT;
if (envTimeout !== undefined) {
  const parsed = parseInt(envTimeout, 10);
  if (isNaN(parsed) || parsed < 1000) {
    throw new Error("NAX_TIMEOUT must be a positive integer >= 1000");
  }
  config.timeout = parsed;
}
```
