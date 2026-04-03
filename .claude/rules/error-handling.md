# Error Handling Patterns

> Project-specific error handling conventions for nax.
> For the full NaxError class hierarchy (6 derived classes) and security implications, see `docs/architecture/conventions.md` §3 and `docs/architecture/subsystems.md` §33.

## NaxError Base Class

All errors must use `NaxError` (v0.38.0+). Do **not** use plain `Error`.

```typescript
import { NaxError } from "../../src/errors";

throw new NaxError(
  `story[${index}].id is required and must be non-empty`,
  "SCHEMA_VALIDATION_FAILED",
  { stage: "schema", storyId: story.id }
);

throw new NaxError(
  `Agent "${agentName}" not found in registry`,
  "AGENT_NOT_FOUND",
  { agentName, availableAgents, stage: "decompose" }
);
```

`NaxError` fields:
- `message` — human-readable description
- `code` — machine-readable error code (string), e.g. `SCHEMA_VALIDATION_FAILED`, `AGENT_NOT_FOUND`
- `context` — additional structured data for debugging; **always include `stage`**

## Error Cause Chaining

Always chain errors with `cause: err` to preserve the original error chain:

```typescript
// ✅ Correct
throw new NaxError(
  `Failed to parse JSON`,
  "SCHEMA_PARSE_FAILED",
  { stage: "schema", cause: parseErr }
);

// ❌ Wrong — lost cause
throw new NaxError(
  `Failed to parse JSON: ${parseErr.message}`,
  "SCHEMA_PARSE_FAILED",
  {}
);
```

## errorMessage Utility

Use `errorMessage()` from `src/utils/errors` to safely extract messages from unknown errors:

```typescript
import { errorMessage } from "../../src/utils/errors";

const msg = errorMessage(err); // Safe for unknown, Error, string, undefined
```

## Return vs Throw

| Situation | Action |
|:----------|:-------|
| Critical (invalid config, security) | `throw new NaxError()` |
| Expected "not found" | `return null` or `?? null` |
| Validation failures | Return `{ errors: string[] }` |
| Recoverable warnings | `logger.warn()` + continue |

```typescript
// ✅ Not found — return null
const item = items.find((i) => i.storyId === storyId) ?? null;

// ✅ Validation errors — return structured result
return { errors: ["name is required", "email is invalid"] };

// ✅ Critical config error — use NaxError
throw new NaxError(
  "Invalid configuration: missing required field",
  "CONFIG_INVALID",
  { stage: "config", field: "agents" }
);

// ❌ Wrong — throwing for expected condition
if (!item) throw new NaxError("Item not found", "NOT_FOUND", {}); // Don't throw for flow control
```

## Error Recovery in Loops

When iterating and one item fails, log and continue unless it's critical:

```typescript
for (const story of stories) {
  try {
    await processStory(story);
  } catch (err) {
    logger.error("batch", "Story failed", { storyId: story.id, error: errorMessage(err) });
    // Continue processing other stories, or break if this is fatal
  }
}
```
