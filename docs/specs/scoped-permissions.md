# Scoped Agent Permissions

**Status:** Phase 1 — Planned
**Author:** Nax Dev + William Khoo
**Created:** 2026-03-16
**Spec ID:** PERM-001

---

## Problem

`dangerouslySkipPermissions` is a single boolean that controls agent tool access across all pipeline stages. This creates three issues:

1. **Inconsistent defaults** — CLI adapter defaults `true` (`claude-execution.ts:52 ?? true`), ACP adapter defaults `false` → `approve-reads`. Schema defaults `true`. Local fallbacks shadow the config value.
2. **All-or-nothing** — either the agent can do everything (`approve-all`) or it's restricted (`approve-reads`). No middle ground for "write only to `src/` and `test/`" or "only run test commands".
3. **No stage awareness** — the plan stage (which only needs to write `prd.json`) uses the same permission level as the run stage (which needs full filesystem access). Verification should be read-only + test execution.

---

## Phase 1 — Permission Resolver (Cleanup + Foundation)

**Goal:** Single source of truth for permissions. Remove all local fallbacks. Introduce `permissionProfile` config field. No functional change for existing users.

### 1.1 New file: `src/config/permissions.ts`

The **only** place that resolves permission mode for any code path.

```typescript
import type { NaxConfig } from "./schema";

export type PermissionProfile = "unrestricted" | "safe" | "scoped";

export type PipelineStage =
  | "plan"
  | "run"
  | "verify"
  | "review"
  | "rectification"
  | "regression"
  | "acceptance"
  | "complete";

export interface ResolvedPermissions {
  /** ACP permission mode string */
  mode: "approve-all" | "approve-reads" | "default";
  /** CLI adapter: whether to pass --dangerously-skip-permissions */
  skipPermissions: boolean;
  /** Future: scoped tool allowlist (Phase 2) */
  allowedTools?: string[];
}

/**
 * Resolve permissions for a given pipeline stage.
 * Single source of truth — all adapters call this.
 */
export function resolvePermissions(
  config: NaxConfig | undefined,
  stage: PipelineStage,
): ResolvedPermissions {
  // Phase 1: read permissionProfile first, fall back to legacy boolean
  const profile: PermissionProfile =
    config?.execution?.permissionProfile ??
    (config?.execution?.dangerouslySkipPermissions ? "unrestricted" : "safe");

  switch (profile) {
    case "unrestricted":
      return { mode: "approve-all", skipPermissions: true };
    case "safe":
      return { mode: "approve-reads", skipPermissions: false };
    case "scoped":
      // Phase 2: per-stage resolution from config.execution.permissions
      return resolveScopedPermissions(config, stage);
    default:
      return { mode: "approve-reads", skipPermissions: false };
  }
}

/**
 * Phase 2 stub — resolves per-stage permissions from config block.
 * Returns "safe" defaults until Phase 2 is implemented.
 */
function resolveScopedPermissions(
  _config: NaxConfig | undefined,
  _stage: PipelineStage,
): ResolvedPermissions {
  // Phase 2 implementation goes here
  return { mode: "approve-reads", skipPermissions: false };
}
```

### 1.2 Schema changes (`src/config/schemas.ts`)

```typescript
const ExecutionConfigSchema = z.object({
  // ... existing fields ...

  // DEPRECATED — use permissionProfile instead. Kept for backward compat.
  dangerouslySkipPermissions: z.boolean().default(true),

  // NEW — takes precedence over dangerouslySkipPermissions
  permissionProfile: z.enum(["unrestricted", "safe", "scoped"]).optional(),

  // Phase 2: per-stage permission overrides (only read when profile = "scoped")
  permissions: z.record(z.object({
    mode: z.enum(["approve-all", "approve-reads", "scoped"]),
    allowedTools: z.array(z.string()).optional(),
    inherit: z.string().optional(),
  })).optional(),
});
```

### 1.3 Remove all local fallbacks

| File | Current | Change |
|:-----|:--------|:-------|
| `src/agents/claude-execution.ts:52` | `options.dangerouslySkipPermissions ?? true` | Use `resolvePermissions(config, "run").skipPermissions` |
| `src/cli/plan.ts:138` | `config?.execution?.dangerouslySkipPermissions ?? false` | Use `resolvePermissions(config, "plan").skipPermissions` |
| `src/agents/acp/adapter.ts:455` | `options.dangerouslySkipPermissions ? "approve-all" : "approve-reads"` | Use `resolvePermissions(config, stage).mode` |
| `src/agents/acp/adapter.ts:565` | `_options?.dangerouslySkipPermissions ? "approve-all" : "default"` | Use `resolvePermissions(config, "complete").mode` |
| `src/pipeline/stages/execution.ts:220` | `ctx.config.execution.dangerouslySkipPermissions` | Pass through (consumed by adapter via resolvePermissions) |
| `src/tdd/session-runner.ts:142` | `config.execution.dangerouslySkipPermissions` | Pass through |
| `src/tdd/rectification-gate.ts:161` | `config.execution.dangerouslySkipPermissions` | Pass through |
| `src/verification/rectification-loop.ts:76` | `config.execution.dangerouslySkipPermissions` | Pass through |

### 1.4 Thread `stage` through `AgentRunOptions`

Add `pipelineStage?: PipelineStage` to `AgentRunOptions` (optional, defaults to `"run"`). Each call site sets the appropriate stage:

| Call Site | Stage |
|:----------|:------|
| `plan.ts` | `"plan"` |
| `execution.ts` (story run) | `"run"` |
| `session-runner.ts` (TDD sessions) | `"run"` |
| `rectification-gate.ts` | `"rectification"` |
| `rectification-loop.ts` | `"rectification"` |
| `adapter.ts complete()` | `"complete"` |
| `acceptance/` stages | `"acceptance"` |

### 1.5 Config migration guide

```jsonc
// Before (still works — backward compatible)
{
  "execution": {
    "dangerouslySkipPermissions": true
  }
}

// After (recommended)
{
  "execution": {
    "permissionProfile": "unrestricted"
  }
}

// Safe mode
{
  "execution": {
    "permissionProfile": "safe"
  }
}
```

### 1.6 Tests

- Unit test `resolvePermissions()` for all 3 profiles × all stages
- Test backward compat: `dangerouslySkipPermissions: true` → same as `permissionProfile: "unrestricted"`
- Test precedence: `permissionProfile` overrides `dangerouslySkipPermissions`
- Test `"scoped"` returns safe defaults (Phase 2 stub)
- Verify no remaining `?? true` or `?? false` fallbacks in grep

### 1.7 Success criteria

- `grep -rn "dangerouslySkipPermissions" src/` shows only:
  - Schema definition (1 line)
  - `resolvePermissions()` reader (1 line)
  - Type definitions (kept for backward compat)
  - Pass-through in pipeline call sites (config → options)
- No local `??` fallbacks for permission values
- All tests pass
- Existing configs work without changes

---

## Phase 2 — Scoped Tool Allowlists (Future)

**Goal:** Per-stage tool restrictions. Agent can only use tools explicitly allowed for its pipeline stage.

### 2.1 Permission blocks per stage

```jsonc
{
  "execution": {
    "permissionProfile": "scoped",
    "permissions": {
      // Base permissions — applied when no stage-specific block exists
      "default": {
        "mode": "approve-reads",
        "allowedTools": ["Read", "Glob", "Grep"]
      },

      // Plan: write only to nax/features/, read-only shell
      "plan": {
        "mode": "scoped",
        "allowedTools": [
          "Read",
          "Write(nax/features/**)",
          "Bash(ls,cat,find,tree,wc)"
        ]
      },

      // Run: full write to src/ and test/, full shell
      "run": {
        "mode": "scoped",
        "allowedTools": [
          "Read",
          "Write(src/**,test/**,package.json)",
          "Bash(*)"
        ]
      },

      // Verify: read + test commands only
      "verify": {
        "mode": "scoped",
        "allowedTools": [
          "Read",
          "Bash(bun test*,npm test*,npx jest*)"
        ]
      },

      // Review: read-only
      "review": {
        "mode": "approve-reads"
      },

      // Rectification: same as run
      "rectification": {
        "inherit": "run"
      },

      // Regression: same as verify
      "regression": {
        "inherit": "verify"
      },

      // Acceptance: write to test file, run tests
      "acceptance": {
        "mode": "scoped",
        "allowedTools": [
          "Read",
          "Write(test/acceptance/**,acceptance.test.ts)",
          "Bash(bun test*,npm test*)"
        ]
      }
    }
  }
}
```

### 2.2 Tool pattern syntax

```
ToolName                    # Allow tool unconditionally
ToolName(glob1,glob2)       # Allow tool only for paths matching globs
Bash(pattern1,pattern2)     # Allow Bash only for commands matching patterns
```

Patterns use minimatch-style glob matching:
- `Write(src/**)` — write anywhere under `src/`
- `Bash(bun test*)` — only shell commands starting with `bun test`
- `Read` — read any file (no restriction)
- `*` — wildcard (allow everything for that tool)

### 2.3 Backend mapping

| Profile | CLI Adapter (Claude Code) | ACP Adapter (acpx) |
|:--------|:--------------------------|:--------------------|
| `unrestricted` | `--dangerously-skip-permissions` | `--approve-all` |
| `safe` | *(no flag — default prompt mode)* | *(no flag)* |
| `scoped` | `--allowedTools "Read,Write(src/**)"` | `--allowed-tools "..."` *(when supported)* |

**Note:** Claude Code's `--allowedTools` flag supports this pattern natively. acpx would need an update to support `--allowed-tools` pass-through to the underlying agent.

### 2.4 Resolver implementation

```typescript
function resolveScopedPermissions(
  config: NaxConfig | undefined,
  stage: PipelineStage,
): ResolvedPermissions {
  const perms = config?.execution?.permissions;
  if (!perms) return { mode: "approve-reads", skipPermissions: false };

  // Lookup: stage-specific → inherit target → default → safe fallback
  let block = perms[stage];
  if (block?.inherit) {
    block = perms[block.inherit] ?? perms.default;
  }
  block ??= perms.default;
  if (!block) return { mode: "approve-reads", skipPermissions: false };

  return {
    mode: block.mode,
    skipPermissions: block.mode === "approve-all",
    allowedTools: block.allowedTools,
  };
}
```

### 2.5 Stories (Phase 2)

| ID | Title | Complexity |
|:---|:------|:-----------|
| PERM-P2-001 | Implement `resolveScopedPermissions()` with inherit + default fallback | Simple |
| PERM-P2-002 | Map `allowedTools` to CLI `--allowedTools` flag in `claude-execution.ts` | Simple |
| PERM-P2-003 | Map `allowedTools` to ACP `--allowed-tools` in `spawn-client.ts` (or skip if acpx unsupported) | Medium |
| PERM-P2-004 | Zod validation for permission blocks (glob syntax, stage names, circular inherit detection) | Medium |
| PERM-P2-005 | `nax init` — generate default `permissions` block based on detected stack | Simple |
| PERM-P2-006 | Integration tests — scoped permissions block file writes outside allowed paths | Medium |
| PERM-P2-007 | Documentation — permission configuration guide | Simple |

### 2.6 Success criteria (Phase 2)

- `permissionProfile: "scoped"` routes through per-stage resolver
- Plan session can write `nax/features/**` but not `src/**`
- Verify session can run `bun test` but not write files
- `inherit` chain resolves correctly (max depth: 3, no cycles)
- Backward compat: `"unrestricted"` and `"safe"` still work unchanged

---

## Appendix: Current Permission Flow (Before)

```
config.execution.dangerouslySkipPermissions (bool, default: true)
    │
    ├── plan.ts:138 ──────── ?? false (WRONG — contradicts schema)
    │
    ├── adapter.ts:455 ───── ? "approve-all" : "approve-reads"
    │
    ├── adapter.ts:565 ───── ? "approve-all" : "default" (INCONSISTENT)
    │
    └── claude-execution.ts:52 ── ?? true (REDUNDANT)
```

## Appendix: Permission Flow (After Phase 1)

```
config.execution.permissionProfile ?? (dangerouslySkipPermissions → profile)
    │
    └── resolvePermissions(config, stage) ─── SINGLE FUNCTION
         │
         ├── "unrestricted" → { mode: "approve-all", skipPermissions: true }
         ├── "safe"         → { mode: "approve-reads", skipPermissions: false }
         └── "scoped"       → Phase 2 resolver
```
