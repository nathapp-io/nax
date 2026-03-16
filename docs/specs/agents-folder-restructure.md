# Spec: `src/agents/` Folder Restructure

**Status:** Planned  
**Branch:** `refactor/agents-folder-structure`  
**Scope:** Pure file-move + import-path refactor — zero logic changes  
**Tests:** Must pass full suite (4143 tests) before commit

---

## Motivation

Current `src/agents/` is inconsistent:
- `claude/` and `acp/` are multi-file subfolders
- `aider`, `codex`, `gemini`, `opencode` are flat inside `adapters/`
- Cross-adapter utilities (`decompose`, `validation`, `version-detection`, etc.) float at the root level
- `claude-decompose.ts` is consumed by **both** `claude.ts` and `acp/adapter.ts` — it is not Claude-specific

---

## Target Structure

```
src/agents/
├── index.ts                    # barrel — re-exports (update source paths, same public API)
├── types.ts                    # core interfaces: AgentAdapter, AgentResult, AgentRunOptions, etc.
├── registry.ts                 # agent registry + discovery (update adapter imports)
│
├── claude/                     # Claude Code adapter
│   ├── index.ts                # re-exports ClaudeCodeAdapter + _runOnceDeps, _completeDeps
│   ├── adapter.ts              # ClaudeCodeAdapter class      [was: agents/claude.ts]
│   ├── execution.ts            # executeOnce, buildCommand    [was: agents/claude-execution.ts]
│   ├── complete.ts             # executeComplete              [was: agents/claude-complete.ts]
│   ├── interactive.ts          # runInteractiveMode           [was: agents/claude-interactive.ts]
│   ├── plan.ts                 # runPlan                      [was: agents/claude-plan.ts]
│   └── cost.ts                 # tier-based cost estimation   [was: agents/cost.ts]
│
├── acp/                        # ACP protocol adapter (unchanged internals)
│   ├── index.ts
│   ├── adapter.ts
│   ├── spawn-client.ts
│   ├── parser.ts
│   ├── cost.ts
│   ├── interaction-bridge.ts
│   └── types.ts
│
├── aider/                      # [was: agents/adapters/aider.ts]
│   └── adapter.ts
│
├── codex/                      # [was: agents/adapters/codex.ts]
│   └── adapter.ts
│
├── gemini/                     # [was: agents/adapters/gemini.ts]
│   └── adapter.ts
│
├── opencode/                   # [was: agents/adapters/opencode.ts]
│   └── adapter.ts
│
└── shared/                     # Cross-adapter utilities
    ├── decompose.ts            # ★ EXTRACTED: used by claude/ AND acp/  [was: agents/claude-decompose.ts]
    ├── model-resolution.ts     # [was: agents/model-resolution.ts]
    ├── validation.ts           # [was: agents/validation.ts]
    ├── version-detection.ts    # [was: agents/version-detection.ts]
    └── types-extended.ts       # plan/decompose/interactive types        [was: agents/types-extended.ts]
```

---

## File Moves (exact mapping)

| Old path | New path |
|:---------|:---------|
| `src/agents/claude.ts` | `src/agents/claude/adapter.ts` |
| `src/agents/claude-execution.ts` | `src/agents/claude/execution.ts` |
| `src/agents/claude-complete.ts` | `src/agents/claude/complete.ts` |
| `src/agents/claude-interactive.ts` | `src/agents/claude/interactive.ts` |
| `src/agents/claude-plan.ts` | `src/agents/claude/plan.ts` |
| `src/agents/claude-decompose.ts` | `src/agents/shared/decompose.ts` |
| `src/agents/cost.ts` | `src/agents/claude/cost.ts` |
| `src/agents/model-resolution.ts` | `src/agents/shared/model-resolution.ts` |
| `src/agents/validation.ts` | `src/agents/shared/validation.ts` |
| `src/agents/version-detection.ts` | `src/agents/shared/version-detection.ts` |
| `src/agents/types-extended.ts` | `src/agents/shared/types-extended.ts` |
| `src/agents/adapters/aider.ts` | `src/agents/aider/adapter.ts` |
| `src/agents/adapters/codex.ts` | `src/agents/codex/adapter.ts` |
| `src/agents/adapters/gemini.ts` | `src/agents/gemini/adapter.ts` |
| `src/agents/adapters/opencode.ts` | `src/agents/opencode/adapter.ts` |

Files that **do not move**: `index.ts`, `types.ts`, `registry.ts`, all of `acp/`

---

## Import Path Changes

### Within `src/agents/`

#### `claude/adapter.ts` (was `claude.ts`)
```
./claude-complete        →  ./complete
./claude-decompose       →  ../shared/decompose
./claude-execution       →  ./execution
./claude-interactive     →  ./interactive
./claude-plan            →  ./plan
./model-resolution       →  (not used — lazy import in adapter.ts, update to ../shared/model-resolution)
```

#### `claude/execution.ts` (was `claude-execution.ts`)
```
./cost                   →  ./cost   (unchanged — stays in claude/)
```

#### `claude/interactive.ts` (was `claude-interactive.ts`)
```
./claude-execution       →  ./execution
```

#### `claude/plan.ts` (was `claude-plan.ts`)
```
./model-resolution       →  ../shared/model-resolution
./types-extended         →  ../shared/types-extended
```

#### `claude/complete.ts` (was `claude-complete.ts`)
```
./types                  →  ../types
```

#### `acp/adapter.ts` (unchanged location)
```
../claude-decompose      →  ../shared/decompose
../types                 →  ../types   (unchanged)
```

#### `registry.ts`
```
./adapters/aider         →  ./aider/adapter
./adapters/codex         →  ./codex/adapter
./adapters/gemini        →  ./gemini/adapter
./adapters/opencode      →  ./opencode/adapter
./claude                 →  ./claude/adapter
```

#### `index.ts`
```
./claude                 →  ./claude/adapter  (or ./claude if index.ts re-exports)
./cost                   →  ./claude/cost
./validation             →  ./shared/validation
./version-detection      →  ./shared/version-detection
./types-extended         →  (remove — already re-exported via ./types)
```

#### `shared/validation.ts` (was `validation.ts`)
```
./types                  →  ../types
```

#### `shared/version-detection.ts` (was `version-detection.ts`)
```
./registry               →  ../registry
./types                  →  ../types
```

#### `shared/types-extended.ts` (was `types-extended.ts`)
```
./types                  →  ../types
```

#### `shared/model-resolution.ts` (was `model-resolution.ts`)
```
(no relative agent imports — only ../config/schema)
```

#### `shared/decompose.ts` (was `claude-decompose.ts`)
```
./types                  →  ../types
```

#### `aider/adapter.ts`, `codex/adapter.ts`, `gemini/adapter.ts`, `opencode/adapter.ts`
```
../types                 →  ../types   (unchanged)
```

### Outside `src/agents/` — External callers

Only 2 files need updating (the rest use barrel or stable paths):

| File | Old import | New import |
|:-----|:-----------|:-----------|
| `src/precheck/checks-agents.ts` | `../agents/version-detection` | `../agents/shared/version-detection` |
| `src/cli/agents.ts` | `../agents/version-detection` | `../agents/shared/version-detection` |

**Imports that do NOT need changing** (resolved via folder `index.ts` or barrel):
- `../agents/claude` → resolves to `claude/index.ts` ✅ (add index.ts to claude/)
- `../agents/registry` → unchanged ✅
- `../agents/types` → unchanged ✅
- `../agents/acp/adapter` → unchanged ✅
- `../agents` (barrel) → unchanged ✅

---

## New Files to Create

### `src/agents/claude/index.ts`
```ts
// Re-export everything external callers need from claude/
export { ClaudeCodeAdapter, _completeDeps } from "./adapter";
export { _runOnceDeps } from "./execution";
```

### `src/agents/aider/index.ts` *(optional but consistent)*
```ts
export { AiderAdapter } from "./adapter";
```
*(Same pattern for codex/, gemini/, opencode/ — only if registry.ts imports via index)*

---

## Files to Delete After Move

```
src/agents/claude.ts
src/agents/claude-execution.ts
src/agents/claude-complete.ts
src/agents/claude-interactive.ts
src/agents/claude-plan.ts
src/agents/claude-decompose.ts
src/agents/cost.ts
src/agents/model-resolution.ts
src/agents/validation.ts
src/agents/version-detection.ts
src/agents/types-extended.ts
src/agents/adapters/aider.ts
src/agents/adapters/codex.ts
src/agents/adapters/gemini.ts
src/agents/adapters/opencode.ts
src/agents/adapters/          (empty dir)
```

---

## Test Files to Update

Test imports that reference old paths must be updated in parallel:

```
test/unit/agents/claude-execution.test.ts   →  update imports from claude-execution → claude/execution
test/unit/agents/claude-plan.test.ts        →  update imports from claude-plan → claude/plan
test/unit/agents/claude.test.ts             →  update imports from claude → claude/adapter
test/unit/agents/cost.test.ts               →  update imports from agents/cost → agents/claude/cost
test/unit/agents/validation.test.ts         →  update imports from agents/validation → agents/shared/validation
test/unit/agents/version-detection.test.ts  →  update imports from agents/version-detection → agents/shared/version-detection
```

Check for any other test files referencing moved paths:
```bash
grep -rn "from.*agents/claude[^/]" test/
grep -rn "from.*agents/cost" test/
grep -rn "from.*agents/validation" test/
grep -rn "from.*agents/version-detection" test/
grep -rn "from.*agents/adapters/" test/
```

---

## Implementation Order

1. Create target directories: `claude/`, `shared/`, `aider/`, `codex/`, `gemini/`, `opencode/`
2. Move + rename files (update imports in each file as you go)
3. Create `claude/index.ts`
4. Update `registry.ts` adapter imports
5. Update `index.ts` barrel
6. Update 2 external callers (`checks-agents.ts`, `cli/agents.ts`)
7. Update all test file imports
8. Delete old files + empty `adapters/` dir
9. `bun run typecheck` — must pass with 0 errors
10. `bun run lint` — must pass
11. `NAX_SKIP_PRECHECK=1 bun test test/ --timeout=60000` — must pass 4143 tests, 0 fail

---

## Constraints

- **Zero logic changes** — copy content exactly, only update import paths
- **400-line file limit** — no file should exceed 400 lines (all current files are within limit)
- **One atomic commit** — `refactor(agents): restructure src/agents/ folder — claude/, acp/, shared/, per-adapter subfolders`
- Do NOT modify `src/agents/types.ts`, `src/agents/registry.ts` content (only registry.ts import paths)
- Do NOT modify `src/agents/acp/` file contents (only `acp/adapter.ts` import for `../shared/decompose`)
