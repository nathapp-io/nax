# Phase 2 — Test Helper Consolidation Sweep Plan

> **Audience:** an autonomous agent (cheap model, background process) that will replace inline mock objects in test files with calls to shared helpers in `test/helpers/`.
>
> **Goal:** drive `bun scripts/check-inline-test-mocks.ts` violation count from **364 → 0** without breaking any tests.
>
> **Branch strategy:** one branch per pattern group, one PR per pattern group, independent of other work.
>
> **Branch off:** latest `main` after `chore/test-helpers-consolidation` merges.

---

## Ground rules (read first)

1. **One pattern group per PR.** Do not mix groups. Groups are listed in §4.
2. **One commit per file.** Use `git commit -m "test: migrate <relpath> to shared helpers"`. Makes revert trivial.
3. **Verify after every file.** Run `timeout 60 bun test <path> --timeout=10000`. If it fails, revert the commit (`git reset --hard HEAD~1`) and add the file to `SKIPPED.md` with a one-line reason. Do not attempt to fix failing tests — skipping is fine.
4. **If unsure, skip.** Append to `SKIPPED.md` and move on. Do not guess.
5. **Never change test assertions.** Only replace the mock construction. If the test was asserting on a specific mock return value, preserve it via `overrides`.
6. **No new imports beyond the helpers barrel.** Always import from `../../helpers` (adjust relative depth based on file location).
7. **Keep `bun run typecheck` and `bun run lint` clean after every file.** If they break, revert.

---

## 1. Helpers available (the SSOT)

All exported from `test/helpers/index.ts`. Import like:

```ts
import { makeMockAgentManager, makeAgentAdapter, makeNaxConfig, makeStory, makePRD, makeLogger, makeSessionManager } from "../../helpers";
```

| Helper | Signature | Replaces |
|:---|:---|:---|
| `makeMockAgentManager` | `(overrides?: Partial<IAgentManager>) => IAgentManager` | Inline `{ getDefault, run, complete, ... }` objects |
| `makeAgentAdapter` | `(overrides?: Partial<AgentAdapter>) => AgentAdapter` | Inline `{ capabilities: { supportedTiers, ... }, run, complete, ... }` |
| `makeNaxConfig` | `(overrides?: DeepPartial<NaxConfig>) => NaxConfig` | Local `makeConfig()` / `makeTestConfig()` functions |
| `makeStory` | `(overrides?: Partial<UserStory>) => UserStory` | Local `makeStory()` / `makeUserStory()` functions |
| `makePRD` | `(overrides?: Partial<PRD>) => PRD` | Local `makePRD()` functions |
| `makeLogger` | `() => MockLogger` (calls captured in `.calls[]`) | Ad-hoc logger mocks |
| `makeSessionManager` | `(overrides?: Partial<ISessionManager>) => ISessionManager` | Inline `{ create, get, transition, ... }` |

**Rule for overrides:** pass only the methods/fields the test actually asserts on. Do not pass defaults that match the helper.

---

## 2. Workflow per pattern group

For each group:

1. Create a branch: `git checkout -b chore/sweep-<group-name>`
2. Run `bun scripts/check-inline-test-mocks.ts` — copy the file list for this group.
3. For each file:
   - Read the file.
   - Identify the inline mock matching the group's recognition pattern (see §4).
   - Apply the transformation (see §4).
   - Run `timeout 60 bun test <file> --timeout=10000`.
   - If pass → `git add <file> && git commit -m "test: migrate <relpath> to <helper-name>"`
   - If fail → `git reset --hard HEAD` (discard edit) and append to `SKIPPED.md`.
4. After the group: run `bun scripts/check-inline-test-mocks.ts` — count should have dropped by the group size (minus skipped).
5. Run full suite: `bun run test:bail` — must be green.
6. Run `bun run typecheck && bun run lint` — both must be green.
7. Open PR: `gh pr create --base main --title "test: migrate <group-name> to shared helpers" --body "<summary>"`.

---

## 3. Recognition & transformation cheatsheet

### Pattern A — Inline `makeConfig()` function (87 violations)

**Recognize:**
```ts
function makeConfig(/* ... */): NaxConfig {
  return { ...DEFAULT_CONFIG, /* some overrides */ } as NaxConfig;
  // OR
  return { ...DEFAULT_CONFIG, routing: { ... } };
}
```

Detection regex: `^\s*function\s+makeConfig\s*\(`

**Transform:**
- Remove the `function makeConfig(...)` definition entirely.
- Each call site `makeConfig(arg)` becomes `makeNaxConfig({ /* what arg was used for */ })`.
- If the local `makeConfig` took no args and just returned `DEFAULT_CONFIG`, replace calls with `makeNaxConfig()`.
- Keep the original call-site overrides exactly.

**Example:**
```ts
// Before
function makeConfig(costLimit = 5.0): NaxConfig {
  return { ...DEFAULT_CONFIG, execution: { ...DEFAULT_CONFIG.execution, costLimitUsd: costLimit } };
}
const cfg = makeConfig(10);

// After
import { makeNaxConfig } from "../../helpers";
const cfg = makeNaxConfig({ execution: { costLimitUsd: 10 } });
```

**Skip if:** the local `makeConfig` does complex transformation beyond object-merge (e.g. reads from disk, calls other functions). Flag in `SKIPPED.md`.

---

### Pattern B — Inline `makeStory()` function (95 violations)

**Recognize:**
```ts
function makeStory(/* ... */): UserStory {
  return { id: "...", title: "...", /* default fields */, ...overrides };
}
```

Detection regex: `^\s*function\s+makeStory\s*\(`

**Transform:**
- Replace `function makeStory(overrides)` definition with `import { makeStory } from "../../helpers";`
- Call sites unchanged if signature matches.
- If local `makeStory(id: string)` took positional args, rewrite call sites: `makeStory("US-001")` → `makeStory({ id: "US-001" })`.

**Skip if:** local `makeStory` has bespoke fields not in `UserStory` (type-cast hacks). Flag.

---

### Pattern C — Inline `AgentAdapter` mocks (67 violations)

**Recognize:** object literal containing `capabilities: { supportedTiers: [...] }` and `run`, `complete`, etc.

Detection regex: `supportedTiers\s*:\s*\[`

**Transform:**
- Replace the entire object literal with `makeAgentAdapter({ /* only the methods the test customizes */ })`.
- Preserve any custom `run`/`complete`/`plan` mocks as overrides.

**Example:**
```ts
// Before
const adapter = {
  name: "mock",
  displayName: "Mock",
  binary: "mock",
  capabilities: { supportedTiers: ["fast"], maxContextTokens: 200_000, features: new Set([...]) },
  isInstalled: mock(() => Promise.resolve(true)),
  run: mock(() => Promise.resolve({ success: false, ... })),
  complete: mock(() => Promise.resolve({ output: "{...}", costUsd: 0 })),
  // ... 8 more methods
} as AgentAdapter;

// After
import { makeAgentAdapter } from "../../helpers";
const adapter = makeAgentAdapter({
  name: "mock",  // keep if the test asserts on .name
  run: mock(() => Promise.resolve({ success: false, exitCode: 1, ... })),
  complete: mock(() => Promise.resolve({ output: "{...}", costUsd: 0, source: "primary" })),
});
```

**Skip if:** mock uses `mock.module()` elsewhere in the file (separate issue; do not touch).

---

### Pattern D — Inline `IAgentManager` mocks (115 violations)

**Recognize:** object literal with `getDefault: () => "..."` and `run`, `complete`, etc. Often cast `as any` or `as IAgentManager`.

Detection regex: `getDefault\s*:\s*\(\)\s*=>`

**Transform:**
- Replace with `makeMockAgentManager({ /* only customized methods */ })`.
- Drop the `as any` / `as IAgentManager` cast.

**Example:**
```ts
// Before
const mgr = {
  getDefault: () => "claude",
  getAgent: (_n) => mockAdapter,
  run: async () => ({ success: false, exitCode: 1, output: "", ... }),
  complete: async () => ({ output: "", costUsd: 0 }),
  runAs: async () => ({ success: false, ... }),
  isUnavailable: () => false,
  // ... 8 more stubs
} as any;

// After
import { makeMockAgentManager } from "../../helpers";
const mgr = makeMockAgentManager({
  getAgent: () => mockAdapter,  // keep — test uses this
  run: async () => ({ success: false, exitCode: 1, output: "", rateLimited: false, durationMs: 10, estimatedCost: 0 }),
});
```

**Skip if:** the test uses `runWithFallback` or `completeWithFallback` with non-default return values (these are complex shapes worth verifying manually).

---

## 4. Execution order (recommended)

Do groups in this order — least risky first:

| Order | Group | Count | Why this order |
|:---|:---|:---|:---|
| 1 | **Pattern D — `IAgentManager`** | 115 | Most uniform shape, highest ROI. Helper is mature (ADR-013 migration). |
| 2 | **Pattern C — `AgentAdapter`** | 67 | Same shape everywhere (copy-pasted from `mock-claude-adapter` pattern). |
| 3 | **Pattern A — `makeConfig`** | 87 | Deep-merge helper handles most cases; some local funcs may need manual review. |
| 4 | **Pattern B — `makeStory`** | 95 | Most likely to have bespoke fields. Save for last. |

**Pilot:** do 5 files from Group 1 manually as a pilot. If the pattern holds, unleash the sweep on the remaining 110.

---

## 5. `SKIPPED.md` format

Append one line per skipped file:

```
test/unit/foo/bar.test.ts | Pattern D | reason: uses runWithFallback with 3 stubbed fallbacks
```

At the end of each group, commit `SKIPPED.md` as the last commit in the PR so reviewers can see what was deferred.

---

## 6. Stop conditions

Stop the sweep immediately if:

- `bun run typecheck` fails and you can't fix it by reverting the last commit.
- `bun run test:bail` fails on a previously-green file (regression).
- Three consecutive files in a row fail verification after transformation.

In any of these cases, stop, commit `SKIPPED.md`, open the PR with what's done, and flag the run for human review.

---

## 7. PR template

```
## Summary

Phase 2 test helper sweep — migrate inline mocks to `test/helpers/` factories.

- Pattern: <D/C/A/B>
- Files migrated: <N>
- Files skipped: <M> (see SKIPPED.md)
- Violations before: <before>
- Violations after: <after>

## Test plan

- [x] `bun run typecheck` clean
- [x] `bun run lint` clean
- [x] `bun run test:bail` green
- [x] `bun scripts/check-inline-test-mocks.ts` violation count dropped by <N>

Tracking issue: #615
```

---

## 8. Hand-off checklist for remote agent

- [ ] Clone repo, check out latest `main`.
- [ ] Read this document end-to-end.
- [ ] Read `test/helpers/index.ts` and each helper file.
- [ ] Read `.claude/rules/test-helpers.md`.
- [ ] Pilot Pattern D on 5 files (`test/unit/debate/session-*.test.ts` is a good cluster).
- [ ] After pilot passes, proceed group-by-group per §4.
- [ ] Commit per file, PR per group.
- [ ] Stop on the conditions in §6 and flag for human review.
