# Config Patterns

Project-specific configuration patterns for nax.

## Zod Schema Validation

Use Zod `safeParse()` for all runtime config validation:

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

**Never** use `parse()` without catching — it throws on validation failure. Use `safeParse()`.

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

1. **Defaults** — Zod schema defaults
2. **Global** — `~/.nax/config.json`
3. **Project** — `<workdir>/.nax/config.json`
4. **CLI overrides** — command-line arguments

```typescript
const layered = {
  ...schemaDefaults,
  ...globalConfig,
  ...projectConfig,
  ...cliOverrides,
};
```

## Compatibility Shim Pattern

For backward compatibility with deprecated config keys, use a migration shim:

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

## Type-Only Imports for Config

Use `import type` for schema types to avoid runtime overhead:

```typescript
import type { NaxConfig } from "./schema";
// Not: import { NaxConfig } from "./schema"
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
