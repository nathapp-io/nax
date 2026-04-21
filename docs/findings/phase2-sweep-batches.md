# Phase 2 Test-Helper Sweep — Batch Execution Plan

> **Audience:** autonomous agent on a remote machine using a cheap model (Haiku-class). Self-contained. No prior conversation context required.
>
> **Goal:** migrate ~120 files from `SKIP_FILES` in `scripts/check-inline-test-mocks.ts` to the shared helpers in `test/helpers/`, then prune `SKIP_FILES` to ~15 permanent entries.
>
> **Branch strategy:** one branch + one PR per batch. Branch off latest `main`.
>
> **Revert rule (hard):** if any step fails verification, revert that single-file commit and move on. Never try to fix failing tests — skip and continue.

---


## 1. Helpers reference (SSOT)

Import from `../../helpers` (adjust relative depth):

```ts
import {
  makeNaxConfig,        // DeepPartial<NaxConfig> → NaxConfig (deep-merged over DEFAULT_CONFIG)
  makeSparseNaxConfig,  // Partial<NaxConfig> → NaxConfig (NO merge — literal cast) — added in Batch 4
  makeStory,            // Partial<UserStory> → UserStory
  makePRD,              // Partial<PRD> → PRD
  makeMockAgentManager, // MockAgentManagerOptions → IAgentManager
  makeAgentAdapter,     // Partial<AgentAdapter> → AgentAdapter
  makeLogger,           // () → MockLogger
  makeSessionManager,   // Partial<ISessionManager> → ISessionManager
} from "../../helpers";
```

**`makeMockAgentManager` option keys you'll need most:**

| Option | Replaces local field |
|:---|:---|
| `getDefaultAgent` | `getDefault: () => "..."` |
| `getAgentFn` | `getAgent: (n) => ...` |
| `runFn` | `run: async () => ...` |
| `runAsFn` | `runAs: async (name, req) => ...` |
| `completeFn` | `complete: async () => ...` |
| `completeAsFn` | `completeAs: async (name, prompt) => ...` |
| `runWithFallbackFn` | `runWithFallback: async (req) => ({ result, fallbacks })` |
| `completeWithFallbackFn` | `completeWithFallback: async (prompt) => ({ result, fallbacks })` |
| `planFn` / `planAsFn` / `decomposeFn` / `decomposeAsFn` | planning/decompose stubs |
| `unavailableAgents` | replaces `isUnavailable` bespoke logic |

Full signature: `test/helpers/mock-agent-manager.ts`.

---

## 2. Per-file workflow (applies to every batch)

For each file in a batch:

```bash
# 1. Transform the file (edit-in-place — see pattern rules below).
# 2. Remove the file path from SKIP_FILES in scripts/check-inline-test-mocks.ts.
# 3. Verify targeted test:
timeout 60 bun test <file> --timeout=10000

# 4a. If exit 0 (pass):
git add <file> scripts/check-inline-test-mocks.ts
git commit -m "test: migrate <relpath> to shared helpers"

# 4b. If non-zero exit (fail, timeout 124, SIGABRT 134, SIGILL 132):
git reset --hard HEAD                 # discard edit + SKIP_FILES change
echo "<relpath> | Batch <N> | reason: <one-line>" >> docs/findings/phase2-skipped.md
# Move to next file.
```

**Rules:**
- **One commit per file.** Never batch multiple files into one commit.
- **Never modify test assertions.** Only replace mock construction.
- **Never import from helper internal paths** (`../../helpers/mock-story`). Always from the barrel (`../../helpers`).
- **Preserve overrides.** If the original inline mock returned `{ success: false, exitCode: 1 }`, the migrated helper call must pass those same values via overrides.
- **Three consecutive failures in one batch → STOP.** Commit what you have, push, open the PR, flag for human review.

---

## 3. Batch 1 — Pattern D (`IAgentManager`) — ~31 files

**Branch:** `chore/sweep-pattern-d-agent-manager`

**File list:** entries in `SKIP_FILES` under the comments:
- `// Pattern D (AgentManager) - previously migrated`
- `// Pattern D (AgentManager) - complex with completeWithFallback and custom getAgent`

Plus any file matching detection regex in `scripts/check-inline-test-mocks.ts` line 288 (`getDefault\s*:\s*\(\)\s*=>`). Get the list by temporarily removing all Pattern D entries from `SKIP_FILES`, running `bun scripts/check-inline-test-mocks.ts`, copying the `inline-agent-manager` section, then restoring `SKIP_FILES` before migrating file-by-file.

### Recognition

```ts
const mgr = {
  getDefault: () => "claude",
  getAgent: (_n) => adapter,
  run: async () => ({ success: false, exitCode: 1, output: "", ... }),
  complete: async () => ({ output: "", costUsd: 0 }),
  completeWithFallback: async () => ({ result: {...}, fallbacks: [] }),
  // ... 5–12 stubbed methods
} as IAgentManager;   // or `as any`
```

### Transform

```ts
import { makeMockAgentManager } from "../../helpers";

const mgr = makeMockAgentManager({
  getDefaultAgent: "claude",                // only if non-default
  getAgentFn: (_n) => adapter,              // only if test uses it
  runFn: async (_agent, _opts) => ({ success: false, exitCode: 1, output: "", rateLimited: false, durationMs: 10, estimatedCost: 0, agentFallbacks: [] }),
  completeFn: async () => ({ output: "stubbed", costUsd: 0, source: "primary" }),
  completeWithFallbackFn: async () => ({ result: { output: "x", costUsd: 0, source: "primary" }, fallbacks: [] }),
});
```

**Pass only the fields the test actually uses.** Drop defaults that match the helper. Drop the `as IAgentManager` / `as any` cast.

### Skip → `phase2-skipped.md` if

- Test uses `new AgentManager(config, registry)` — the test exercises the real class, not a mock.
- Test captures fine-grained method-call metrics (`.mock.calls`) on properties `makeMockAgentManager` doesn't expose as bun `mock()` (e.g., `isUnavailable`, `markUnavailable` — these return plain functions).

### Gate (end of batch)

```bash
bun scripts/check-inline-test-mocks.ts   # still 0 violations
bun run typecheck                          # green
bun run lint                               # green
bun run test:bail                          # green
```

Open PR:
```bash
gh pr create --base main --title "test: migrate Pattern D (AgentManager) skips to shared helpers" \
  --body "$(cat <<'EOF'
## Summary
Phase 2 sweep Batch 1 — migrate Pattern D inline `IAgentManager` mocks to `makeMockAgentManager`.

- Files migrated: <N>
- Files skipped: <M> (see docs/findings/phase2-skipped.md)
- SKIP_FILES shrunk by: <N>

## Test plan
- [x] `bun run typecheck` green
- [x] `bun run lint` green
- [x] `bun run test:bail` green
- [x] `bun scripts/check-inline-test-mocks.ts` reports 0 violations
EOF
)"
```

---

## 4. Batch 2 — Pattern B (`makeStory`) — ~70 files

**Branch:** `chore/sweep-pattern-b-story`

**File list:** entries in `SKIP_FILES` under the comment `// Pattern B (makeStory) - local factory functions`.

### Recognition

```ts
function makeStory(overrides?: Partial<UserStory>): UserStory {
  return {
    id: "US-001",
    title: "Test Story",
    description: "...",
    acceptanceCriteria: [],
    tags: [],
    dependencies: [],
    status: "passed",          // often different from shared default "pending"
    passes: true,
    escalations: [],
    attempts: 1,
    ...overrides,
  };
}
```

### Transform

1. Delete the local `function makeStory(...)` definition.
2. Add import: `import { makeStory } from "../../helpers";`
3. At each call site, if the file's `makeStory` had non-default values, push them into the call:

```ts
// Before (local default status was "passed")
const story = makeStory({ id: "US-002" });

// After
const story = makeStory({ id: "US-002", status: "passed", passes: true, attempts: 1 });
```

Check the shared defaults in `test/helpers/mock-story.ts`:
```
status: "pending", passes: false, attempts: 0, escalations: [], acceptanceCriteria: [], tags: [], dependencies: []
```

Any field the local factory defaulted to something else must be passed as an override at every call site.

### Skip → `phase2-skipped.md` if

- Local `makeStory` returns a type-cast `Record<string, unknown>` with fields not on `UserStory` (e.g., `test/unit/prd/schema.test.ts` uses `complexity`, `testStrategy` for schema fuzzing — intentionally invalid).
- Local factory takes positional args in a signature that differs (`makeStory(id, title)`) and there are too many call sites to rewrite safely.

### Gate & PR

Same as Batch 1. PR title: `test: migrate Pattern B (makeStory) skips to shared helpers`.

---

## 5. Batch 3 — Pattern A (`makeConfig`, DEFAULT_CONFIG spreaders) — ~50 files

**Branch:** `chore/sweep-pattern-a-config-spread`

**File list:** entries in `SKIP_FILES` under comment `// Pattern A (makeConfig) - complex full configs not spreading DEFAULT_CONFIG`.

**Important:** only migrate files whose local `makeConfig` **spreads `DEFAULT_CONFIG`** OR uses `structuredClone(DEFAULT_CONFIG)` / `NaxConfigSchema.parse({})`. Files that return a bespoke sparse object cast to `NaxConfig` go to **Batch 4** — leave them in `SKIP_FILES` for now.

### Recognition (MIGRATABLE subset)

```ts
function makeConfig(): NaxConfig {
  return { ...DEFAULT_CONFIG, execution: { ...DEFAULT_CONFIG.execution, costLimit: 10 } };
}
// OR
function makeConfig(): NaxConfig {
  return structuredClone(DEFAULT_CONFIG);
}
// OR
function makeConfig(): NaxConfig {
  return NaxConfigSchema.parse({});
}
```

### Recognition (DEFER to Batch 4 — leave in SKIP_FILES)

```ts
function makeConfig(): NaxConfig {
  return {
    agent: { default: "x" },
    models: {...},
    execution: {...},
  } as unknown as NaxConfig;    // NO DEFAULT_CONFIG spread
}
```

### Transform (MIGRATABLE only)

```ts
// Before
function makeConfig(): NaxConfig {
  return { ...DEFAULT_CONFIG, execution: { ...DEFAULT_CONFIG.execution, costLimit: 10 } };
}
const cfg = makeConfig();

// After
import { makeNaxConfig } from "../../helpers";
const cfg = makeNaxConfig({ execution: { costLimit: 10 } });
```

Delete `import { DEFAULT_CONFIG } from "..."` if no longer used.

### Skip → `phase2-skipped.md` if

- Config uses `autoMode.defaultAgent` or `autoMode.fallbackOrder` (legacy keys — `CONFIG_LEGACY_AGENT_KEYS` error under current schema).
- `makeConfig` performs non-merge transformations (reads files, runs async code).

### Gate & PR

Same structure. PR title: `test: migrate Pattern A (makeConfig DEFAULT_CONFIG spreaders) to shared helpers`.

---

## 6. Batch 4 — add `makeSparseNaxConfig` + migrate sparse-cast Pattern A (~10 files)

**Branch:** `chore/sweep-pattern-a-sparse-helper`

### Step 1 — add the helper

Edit `test/helpers/mock-nax-config.ts`:

```ts
// Append:
/**
 * Returns the given partial as NaxConfig WITHOUT merging DEFAULT_CONFIG.
 * Use only when tests intentionally assert on the presence/absence of specific config fields.
 * Prefer makeNaxConfig() for the common case.
 */
export function makeSparseNaxConfig(partial: Partial<NaxConfig>): NaxConfig {
  return partial as NaxConfig;
}
```

Export from `test/helpers/index.ts`:

```ts
export { makeNaxConfig, makeSparseNaxConfig } from "./mock-nax-config";
```

Commit: `test: add makeSparseNaxConfig helper for intentionally-sparse configs`.

Verify: `bun run typecheck && bun run lint`.

### Step 2 — migrate sparse-cast Pattern A files

For each Pattern A file NOT migrated in Batch 3 (those with `as unknown as NaxConfig` sparse casts):

```ts
// Before
function makeConfig(): NaxConfig {
  return {
    agent: { default: "test-agent" },
    models: { ... },
    execution: { ... },
  } as unknown as NaxConfig;
}
const cfg = makeConfig();

// After
import { makeSparseNaxConfig } from "../../helpers";
const cfg = makeSparseNaxConfig({
  agent: { default: "test-agent" },
  models: { ... },
  execution: { ... },
});
```

### Gate & PR

Same structure. PR title: `test: add makeSparseNaxConfig + migrate sparse Pattern A skips`.

---

## 7. Batch 5 — Pattern C (AgentAdapter object literals) + finalize SKIP_FILES (~10 files + cleanup)

**Branch:** `chore/sweep-pattern-c-and-finalize`

### Step 1 — Pattern C object-literal adapters

**File list:** entries in `SKIP_FILES` under `// Pattern C (AgentAdapter) - integration files with class-based or plugin-extension adapters`. Only migrate **object-literal** adapters — leave class-based ones as permanent skips.

### Recognition (MIGRATABLE)

```ts
const adapter = {
  name: "mock",
  displayName: "Mock",
  binary: "mock",
  capabilities: { supportedTiers: ["fast"], maxContextTokens: 200_000, features: new Set([...]) },
  isInstalled: mock(() => Promise.resolve(true)),
  run: mock(() => Promise.resolve({ success: false, exitCode: 1, ... })),
  // ... many more
} as AgentAdapter;
```

### Recognition (PERMANENT SKIP)

```ts
class MockAgentAdapter implements AgentAdapter {
  readonly name = "mock";
  readonly capabilities: AgentCapabilities = { ... };
  async run(opts: AgentRunOptions): Promise<AgentResult> { ... }
  // uses this.binary, this.xxx
}
```

### Transform (object-literal only)

```ts
import { makeAgentAdapter } from "../../helpers";

const adapter = makeAgentAdapter({
  name: "mock",
  run: mock(() => Promise.resolve({ success: false, exitCode: 1, output: "", durationMs: 10, estimatedCost: 0 })),
});
```

### Step 2 — finalize `SKIP_FILES`

After Batches 1–5 run:

1. Run the check: `bun scripts/check-inline-test-mocks.ts`. It should still report 0 violations.
2. For each entry REMAINING in `SKIP_FILES`, read the file and add an inline comment immediately above the entry in `scripts/check-inline-test-mocks.ts` explaining why it is permanent, e.g.:

```ts
const SKIP_FILES = new Set([
  // PERMANENT: class-based MockAgentAdapter implementing interface with per-test state
  "test/integration/pipeline/reporter-lifecycle-basic.test.ts",
  // PERMANENT: exercises `new AgentManager(config, registry)` directly
  "test/unit/agents/manager-iface-run.test.ts",
  // PERMANENT: schema-fuzz test intentionally constructs invalid UserStory shape
  "test/unit/prd/schema.test.ts",
  // ...
]);
```

3. Sort the entries alphabetically within the Set for readability.

### Gate & PR

PR title: `test: migrate Pattern C object literals + finalize permanent SKIP_FILES`.

Include in PR body: final skip count per reason category (e.g., "3 class-based adapters, 5 constructor tests, 1 schema fuzz").

---

## 8. `phase2-skipped.md` format (create if missing)

File: `docs/findings/phase2-skipped.md`. One line per skipped file:

```
test/unit/foo/bar.test.ts | Batch 1 | reason: uses completeWithFallback.mock.calls assertion on bun mock instance
test/unit/baz/qux.test.ts | Batch 2 | reason: makeStory has positional args, 18 call sites, too risky
```

Commit this file at the end of each batch as the final commit on the branch.

---

## 9. Stop conditions (hard)

Stop immediately and flag for human review if:

- `bun run typecheck` fails and reverting the last commit does not restore green.
- `bun run test:bail` fails on a previously-green test file unrelated to the migration.
- Three files in a row fail verification in the same batch.
- `bun scripts/check-inline-test-mocks.ts` reports NEW violations (not in SKIP_FILES).

When stopping: commit `phase2-skipped.md` with the reason, push the branch, open a PR with `[WIP]` in the title, and write a short note to `docs/findings/phase2-stopped.md` describing what failed.

---

## 10. Summary checklist

- [ ] Batch 1 — Pattern D, ~31 files, one branch + one PR
- [ ] Batch 2 — Pattern B, ~70 files, one branch + one PR
- [ ] Batch 3 — Pattern A (DEFAULT_CONFIG spreaders), ~50 files, one branch + one PR
- [ ] Batch 4 — `makeSparseNaxConfig` helper + ~10 files, one branch + one PR
- [ ] Batch 5 — Pattern C object literals + finalize SKIP_FILES, one branch + one PR

After all five PRs merge: `SKIP_FILES` should contain ~15 permanent entries, each annotated with a `// PERMANENT: <reason>` comment, and the check script still reports 0 violations.
