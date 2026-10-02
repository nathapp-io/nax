# S1-4 Tool-Side Ports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land PR S1-4. The move set stops importing nax's config, quality runner, trust store, nax-owned path lists and runtime barrel, and the two global interceptor slots are deleted. The PR is behaviour-neutral, and the boundary ratchet falls from 20 edges to **0**, which is what S1-5 (the scripted move) requires.

**Architecture:** Every change happens in place under `packages/nax/src`. Pure config leaf types move into the move set (two new leaf files under `src/config/`). `resolveCodingToolSupport` moves to the nax side (`coding-tool-support-resolve.ts`), and it becomes the single place nax supplies the three run-scoped ports to the coding tools: a **declared-command runner** (`runQualityCommand`), the **command interceptor** and a **protected-paths policy**. The interceptor and the protected paths travel to the tools in `ToolRunContext`, which the tool runtime builds per call; the runner travels in the RunCommand tool's options. Finally, nax re-narrows `stage` at the one point where agent stream events enter its bus.

**Tech Stack:** TypeScript (ESM), Bun 1.4.0, `bun:test`, Biome. Package commands run from `packages/nax`.

**Spec:** `docs/superpowers/specs/2026-10-01-s1-nax-agent-carve-out-design.md`: section 4.2 (ports 1, 4, 5, 6, 7), section 6 (S1-4 row, the ratchet) and section 8 (tests). Read it first. The S1-2 PR (#2320) carried one item into this PR: re-narrowing `stage`. **Two spec corrections and one deferral** are taken here (Decisions 6, 7 and 8 below).

**Base:** `main` @ `e6d42e890` (S1-3 #2321 merged). Branch: `feat/s1-4-tool-side-ports`. Line numbers below refer to that commit.

## Global Constraints

- Behaviour-neutral: no change to `nax run` output, log lines, cost rows, `metrics.json`, `nax config` output, stream events, tool-audit ledgers, Git/GitCommit/Bash/RunCommand results, sandbox policies or any CLI text.
- Run package commands from `packages/nax`. Never run bare `bun test` (no path); single files run as `bun test <path> --timeout=60000`. Never `bun run nax`.
- Full verification: `bun run test`, `bun run typecheck` (it also typechecks `test/` through `tsconfig.test.json`), `bun run lint`, and `bun run check:all` from the repo root.
- No test is edited to pass unless its subject moved or its port was cut. In this PR the cut ports are: the config leaf types (Task 1), `resolveCodingToolSupport`'s home (Task 2), the declared-command runner (Task 3), the interceptor slots (Task 4), the protected paths (Task 5) and the stream bus's `stage` type (Task 6). Every test edit in this PR must be traceable to one of them.
- Source files stay at or under 600 lines and test files at or under 800 (`check:file-sizes`). **`test/unit/tools/run-command.test.ts` and `test/unit/agents/coding-tool-support.test.ts` are both at exactly 800 lines**: neither may grow by a single line (Tasks 2 and 3 say how to handle them). `src/agents/coding-tool-support-resolve.ts` (419) grows to about 510 in Task 2; `src/agents/types.ts` (553) and `src/runtime/index.ts` (552) grow by a few lines. Re-check with `wc -l` after editing any of them.
- **Complexity ratchet** (`check:complexity`, strict limit 20; baselined functions may not grow). Touched functions at or near their ceiling: `run-command.ts` `run` 56, `coding-tool-support.ts` `buildCodingToolSupport` 38, `coding-tool-extras.ts` `buildDeclaredCommandTools` 24, `runtime/index.ts` `createRuntime` 28, `tools/runtime.ts` `runTool` 24, `tools/git-commit.ts` `run` 22, `tools/git.ts` `buildGitArgv` 47. **Add no `if`, ternary, `??`, `||` or `&&` inside any of them.** The code below passes new values unconditionally (`interceptor: args.interceptor`) or moves the conditional into a small new helper. Run `bun run check:complexity` after every task.
- Code blocks show content, not final formatting. Before every commit, run `bun x biome check --write <files you touched>`, then `bun run lint`.
- **Import rules** (`check:alias-internals`). In `src/`, a **value** import of `@/<dir>/<internal>` is forbidden when `src/<dir>/index.ts` exists; an exact nested barrel (`@/config/native-agent`, `@/quality/command-spec`, `@/config/paths`) is legal. A **type-only** import may target a leaf (`@/config/catalog-overrides`). Relative imports may climb one level (`../x`); `../../` is banned by biome `noRestrictedImports`.
- **Test ratchets** (`check:all` from the root): new tests must not add `as unknown as` casts or any `as <Capital>` (the loose-cast counter matches import aliases such as `import { X as Y }` too). `// test-ratchet-allow` does not help. The snippets below stay at zero; keep them that way. New test files are named by concern, never by ticket (`check:test-satellites`).
- `check:import-cycles` must stay green. Type-only imports are excluded from it.
- The ratchet (`check:agent-boundary`) may only fall. Every task that lowers it ends with `bun run check:agent-boundary:update`, and the baseline is committed. Expected counts after each task: **20 -> 11 -> 8 -> 4 -> 4 -> 0 -> 0**.
- Commit locally as the steps say. **Push and open the PR only after the user approves.** No billed `nax run` / `nax plan`.
- nax is a public repo: commit messages and PR text never name private projects.
- Commits use conventional prefixes (`refactor:`, `test:`, `chore:`, `docs:`), no emojis.

## Decisions this plan takes (flag in review if you disagree)

1. **One PR, six tasks plus a closing task.** The spec lists S1-4 as one PR. Tasks are ordered so that every port that nax supplies is wired through `resolveCodingToolSupport` *after* Task 2 has moved it to the nax side. Otherwise wiring the runner or the protected paths would add a new edge from the move set.
2. **Config leaf types (port 4) move as two new leaves, not a re-shaped schema.** `ThinkingLevel`, `CatalogPricing`, `OpenRouterRouting`, `CatalogModelOverride` and `ProviderCatalogOverride` (pure TS types, `schema-types.ts:117-209`) move to `src/config/catalog-overrides.ts`; `schema-types.ts` re-exports them, so its seven importers do not change. `NATIVE_AGENT_NAME` moves to a nested barrel `src/config/native-agent/index.ts` (a value, so it needs an exact-barrel specifier); `agent-defaults.ts` re-exports it relatively and stays free of `@/` imports, as its header requires. Both join the manifest under `config/`.
3. **`PipelineStage` becomes `string` inside the move set** (spec port 4): `tools/provider-types.ts`, `tools/provider-advertise.ts` and `native/session/turn-events.ts`. `tier-providers.ts` declares the two config fields it reads (`NativeTierConfig`) instead of `Pick<PrecheckConfig, ...>`.
4. **`QualityCommandSpec` joins the move set by moving its whole module.** `src/quality/command-spec/index.ts` imports nothing and holds only pure helpers over the type, so the manifest gains `src/quality/command-spec/` -> `internal/command-spec/`. nax keeps importing it from `@/quality` (the barrel re-exports it), and S1-5 rewrites those imports to `/internal`.
5. **The declared-command runner (port 7) is an optional RunCommand option, `runDeclaredCommand`.** nax supplies `runQualityCommand` from one place, `_codingToolSupportDeps.runDeclaredCommand`. When the option is absent, the tool answers `exit 1` with an explanation instead of throwing, and nothing is spawned. Production always supplies it; the absent case is reachable only from tests that build the tool directly. A *required* option was rejected: about 20 test files build support without RunCommand and would have to pass a runner they never use.
6. **Spec correction (port 7): the interceptor reaches the hops through `AgentRunOptions`, not through a new field on the hops.** The spec says the two `resolveCodingToolSupport` callers copy it from the runtime. Neither caller holds the runtime; both receive `AgentRunOptions`, and `buildRunDispatchOptions` (`operations/call-run-options.ts`) is the only producer of options that carry a `codingToolRoot` (grep: `codingToolRoot:` has one producer). So `setupRun` passes the interceptor to `createRuntime`, `NaxRuntime.commandInterceptor` holds it, and `buildRunDispatchOptions` copies it into `AgentRunOptions.commandInterceptor`, next to `providers`, which already travels this way for the same reason. `resolveCodingToolSupport` passes it to `buildCodingToolSupport`, which puts it on every `ToolRunContext`. Both `_gitToolDeps` (deleted entirely; it held only the interceptor) and `_bashToolDeps.interceptor` are gone.
7. **Spec correction (port 6): `ProtectedPathsPolicy` carries data, not predicates.** The spec sketches `{ isProtected(path), reason(path), extraDenyRoots, gitExcludePathspecs, gitIgnorePatterns }`. The import edges that exist need exactly five values, so that is the shape: `gitExcludePathspecs` (Git tool default view), `gitIgnorePatterns` (GitCommit filter), `projectStateDir` (`.nax`, whose top-level entries the sandbox lists), `credentialDir` (the global config dir, whose `credentials*` files the sandbox denies) and `trustStoreFile`. nax builds it per dispatch in `naxProtectedPaths()` (`src/agents/nax-protected-paths.ts`, stays in nax). In the tools, an absent policy means no exclusions; in the sandbox, it is required, so there is no silent default there.
8. **Deferral (port 6, ruled by the maintainer 2026-10-01: deferred to S3): `tools/nax-owned-writes.ts` keeps its `.nax` knowledge.** It hardcodes the `.nax/` entries the write policy refuses (`config.json`, `mono`, `features`, `rules`, `hooks.json`, ...). It has **no import edge**: its only import is `@/utils/realpath`, already in the move set. So the ratchet cannot see it and S1-5 does not need it. Moving that knowledge out would rework a 293-line, security-sensitive policy consulted by `tools/policy.ts` and the sandbox policy builder, inside a PR that claims behaviour neutrality. Ruled: carried to S3 as an embedder-contract item (an embedder like koda has no `.nax/`, so the policy becomes injectable there). The PR body records it under "Not in this PR".
9. **Evaluation timing of the trust store path.** Today `trustStorePath()` is evaluated inside `policyFor`, so on every policy build (once per command). After Task 5 it is evaluated once per dispatch, in `naxProtectedPaths()`, together with the credential dir, which today is already read once per session. The two differ only if `NAX_GLOBAL_CONFIG_DIR` changes between commands of one session, which happens only in tests that set it between their own calls. The sandbox's `resolveDispatchLauncher` reads `_codingToolSupportDeps.protectedPaths()` itself rather than taking it as a fourth parameter, so its two existing direct test callers keep their signature.
10. **`stage` re-narrowing (carried from S1-2) happens inside the bus.** `runtime/agent-stream-events.ts` gains `NaxAgentStreamEvent` (`AgentStreamEvent & { stage?: PipelineStage }`). Listeners are typed on it. `emitAgentStream` keeps accepting the contract's `AgentStreamEvent` and calls `narrowStreamStage()` before it notifies listeners. (Final review: typing `emitAgentStream` itself on the narrowed type broke 207 test call sites across 10 files that emit plain contract events; narrowing inside the bus gives listeners the same guarantee with no test churn.) A known stage passes through untouched (same object), and so does an absent one. An unknown label is dropped and logged at debug. No producer emits one today: native sets no stage, and ACP's `SpawnAcpClientSession.stage` is already typed `PipelineStage`. So this is behaviour-neutral, and a future mistyped producer now fails typecheck or loses the label visibly rather than leaking it.

## Review Focus

1. **A fallback swap or the second dispatch hop.** `runWithFallback` re-dispatches through `session-run-hop.ts` or `build-hop-callback-hop.ts` with options spread from the same `AgentRunOptions`. Expected: both hops still intercept Git and Bash, because the interceptor is a field of the options both hops resolve support from, never a module global. Pinned by Task 4, step 1 (`buildRunDispatchOptions carries the runtime's interceptor`) together with the resolve-level wiring test (`one interceptor reaches both the Git and the Bash tool contexts`).
2. **An entry point that never runs `setupRun`** (`nax plan`, `nax prompts`, `nax setup`). Expected: no interception, exactly as today, because those runtimes are created without an interceptor. Pinned by Task 4, step 1 (`a runtime without an interceptor adds no commandInterceptor key`).
3. **An unscoped Git call in a monorepo** (`git status` with no paths, where `packages/app/.nax/...` is git-tracked mid-run). Expected: both the root and the nested `.nax` excludes still reach the spawned argv (nax#2007). Pinned by Task 5, step 1 (`the Git tool's default view still excludes .nax through the production entry`).
4. **`NAX_GLOBAL_CONFIG_DIR` changes between two dispatches in one process.** Expected: the credential dir and the trust store path follow the new directory. Pinned by Task 5, step 1 (`naxProtectedPaths follows NAX_GLOBAL_CONFIG_DIR live`).
5. **A RunCommand built without a runner.** This happens only to a tool built outside `resolveCodingToolSupport`, which no production path does. Expected: an `exit 1` result naming the missing runner, never a crash and never a spawned shell. Pinned by Task 3, step 1 (`answers exit 1 without spawning when no runner was configured`).

---

## File Structure

| File | Task | Responsibility |
|---|---|---|
| `src/config/catalog-overrides.ts` | 1 | catalog-override and thinking-level types (moved from `schema-types.ts`) |
| `src/config/native-agent/index.ts` | 1 | `NATIVE_AGENT_NAME` (moved from `agent-defaults.ts`) |
| `src/config/schema-types.ts`, `src/config/agent-defaults.ts` | 1 | re-export the moved names |
| `src/agents/native/{client,model-resolver,models,tier-providers}.ts`, `src/agents/native/session/{session,turn-events}.ts`, `src/tools/provider-{types,advertise}.ts` | 1 | retarget or widen |
| `src/agents/coding-tool-support-resolve.ts` | 2-5 | `resolveCodingToolSupport`, `_codingToolSupportDeps` (moved in); nax supplies every port here |
| `src/agents/coding-tool-support.ts` | 2-5 | `buildCodingToolSupport` takes resolved arguments only |
| `src/tools/run-command.ts` | 3 | `DeclaredCommandRunner` port |
| `src/agents/coding-tool-extras.ts` | 3, 4 | forwards the runner |
| `src/tools/registry.ts`, `src/tools/runtime.ts` | 4, 5 | `ToolRunContext.interceptor` / `.protectedPaths`; `contextPorts` helper |
| `src/tools/bash.ts`, `src/tools/git.ts`, `src/tools/index.ts` | 4, 5 | read the context instead of the deleted slots / nax constants |
| `src/agents/types.ts`, `src/runtime/index.ts`, `src/operations/call-run-options.ts`, `src/execution/lifecycle/run-setup.ts` | 4 | the interceptor travels runtime -> options |
| `src/tools/protected-paths.ts` | 5 | `ProtectedPathsPolicy`, `gitExcludePathspecsOf`, `gitIgnorePatternsOf` |
| `src/agents/nax-protected-paths.ts` | 5 | `naxProtectedPaths()` — nax's knowledge, stays in nax |
| `src/tools/git-commit.ts`, `src/tdd/red-commit.ts`, `src/sandbox/policy-inputs.ts`, `src/agents/coding-tool-sandbox.ts`, `scripts/analyze-rtk-savings.ts` | 5 | take the paths as data |
| `src/config/permissions.ts`, `src/runtime/agent-stream-events.ts` | 6 | `isPipelineStage`, `NaxAgentStreamEvent`, `narrowStreamStage` (called inside the bus) |
| `test/unit/agents/coding-tool-support-ports.test.ts` | 3-5 | production-wiring tests for the three ports |
| `scripts/s1-move-manifest.json`, `scripts/baselines/agent-boundary-baseline.json` | 1, 2, 3, 5 | manifest entries; ratchet baseline |

---

### Task 1: Config leaf types and stage labels (port 4, port 5's runtime import)

Nine of the 20 edges are type or constant imports from nax config and the runtime barrel.

**Files:**
- Create: `src/config/catalog-overrides.ts`, `src/config/native-agent/index.ts`, `test/unit/config/native-agent.test.ts`
- Modify: `src/config/schema-types.ts:117-209`, `src/config/agent-defaults.ts:18-19`
- Modify (retarget/widen): `src/agents/native/client.ts:14`, `src/agents/native/model-resolver.ts:22`, `src/agents/native/models.ts:11,15-18`, `src/agents/native/tier-providers.ts:1-4`, `src/agents/native/session/session.ts:59`, `src/agents/native/session/turn-events.ts:52`, `src/tools/provider-types.ts:16,32,53`, `src/tools/provider-advertise.ts:8,37`
- Test: `test/unit/agents/native/tier-providers.test.ts` (append one test)
- Modify: `scripts/s1-move-manifest.json`, `scripts/baselines/agent-boundary-baseline.json`

**Interfaces:**
- Produces: `@/config/native-agent` exports `NATIVE_AGENT_NAME` (the same string `"native"`; `@/config` and `@/agents/native`'s `NATIVE_AGENT` keep exporting it). `@/config/catalog-overrides` exports `type { CatalogModelOverride, CatalogPricing, OpenRouterRouting, ProviderCatalogOverride, ThinkingLevel }`; `@/config/schema-types` re-exports all five. `NativeTierConfig` becomes a structural interface that every `PrecheckConfig` satisfies.

- [ ] **Step 1: Write the failing tests**

`test/unit/config/native-agent.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { NATIVE_AGENT } from "@/agents/native";
import { NATIVE_AGENT_NAME as fromConfigBarrel } from "@/config";
import { NATIVE_AGENT_NAME } from "@/config/native-agent";

describe("@/config/native-agent", () => {
  test("is the one definition the config barrel and the native barrel re-export", () => {
    expect(NATIVE_AGENT_NAME).toBe("native");
    expect(fromConfigBarrel).toBe(NATIVE_AGENT_NAME);
    expect(NATIVE_AGENT).toBe(NATIVE_AGENT_NAME);
  });
});
```

The `as fromConfigBarrel` alias is lower-case on purpose (the loose-cast counter matches `as <Capital>` only).

Append to `test/unit/agents/native/tier-providers.test.ts`, inside its top-level `describe`:

```ts
  test("reads a plain object carrying only the two fields it declares (no NaxConfig)", () => {
    const byProvider = nativeTierProviders({
      agent: { native: { catalogOverrides: [{ provider: "proxy" }] } },
      models: { native: { fast: "anthropic/claude-haiku-4-5", balanced: { model: "proxy/x" } } },
    });
    expect([...byProvider.entries()]).toEqual([["anthropic", ["fast"]]]);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/unit/config/native-agent.test.ts test/unit/agents/native/tier-providers.test.ts --timeout=60000`
Expected: FAIL. `@/config/native-agent` cannot be resolved. `bun run typecheck` would also reject the tier-providers literal (it is not a `Pick<PrecheckConfig, ...>`), but bun's test run does not typecheck, so the new tier test may pass at runtime; that is fine, Step 6's typecheck is its real gate.

- [ ] **Step 3: Create the two leaves**

`src/config/native-agent/index.ts`:

```ts
/**
 * The agent name that routes to the in-process native adapter.
 *
 * Its own nested barrel so the nax-agent move set can import the value
 * (`@/config/native-agent`) without loading the config barrel (S1 spec
 * section 4.2, port 4). `agent-defaults.ts` re-exports it for config.
 */
export const NATIVE_AGENT_NAME = "native";
```

In `src/config/agent-defaults.ts`, replace lines 18-19 (the doc comment and `export const NATIVE_AGENT_NAME = "native";`) with:

```ts
/** The agent name that routes to the in-process native adapter (defined in the move set). */
export { NATIVE_AGENT_NAME } from "./native-agent";
```

The import is relative, so `agent-defaults.ts` stays free of `@/` imports as its header requires. If anything inside `agent-defaults.ts` itself uses `NATIVE_AGENT_NAME` (at `e6d42e890` nothing does; confirm with `grep -n NATIVE_AGENT_NAME src/config/agent-defaults.ts`), also add `import { NATIVE_AGENT_NAME } from "./native-agent";`.

Create `src/config/catalog-overrides.ts`. **Cut** (not copy) from `src/config/schema-types.ts` the block that starts at the doc comment above `export type ThinkingLevel` (line 118; line 117 is blank) and ends with the closing brace of `export interface ProviderCatalogOverride` (line 209), verbatim with every doc comment. Give the new file this header and nothing else above the moved block:

```ts
/**
 * Catalog-override and thinking-level types: the config shapes the native
 * agent reads (S1 spec section 4.2, port 4). Pure types with no imports, so
 * they move into nax-agent unchanged; `schema-types.ts` re-exports them for
 * nax's config schema.
 */
```

In `schema-types.ts`, at the spot where the block was, add:

```ts
export type {
  CatalogModelOverride,
  CatalogPricing,
  OpenRouterRouting,
  ProviderCatalogOverride,
  ThinkingLevel,
} from "./catalog-overrides";
```

If `schema-types.ts` still refers to any of the five names in its own declarations, also add `import type { ... } from "./catalog-overrides";` for exactly those names (`bun run typecheck` names them).

- [ ] **Step 4: Retarget and widen the move-set importers**

- `src/agents/native/client.ts:14`, `src/agents/native/model-resolver.ts:22`, `src/agents/native/models.ts:11`: `import type { ProviderCatalogOverride } from "@/config/catalog-overrides";`
- `src/agents/native/models.ts:18`: `export { NATIVE_AGENT_NAME as NATIVE_AGENT } from "@/config/native-agent";` and update the comment above it (lines 15-17) to say the value lives in the `@/config/native-agent` leaf.
- `src/agents/native/tier-providers.ts`: delete the `PrecheckConfig` import and replace `export type NativeTierConfig = Pick<PrecheckConfig, "agent" | "models">;` with:

```ts
/**
 * The two config fields this reads, declared here so the move set needs no nax
 * config type (S1 spec section 4.2, port 4). nax's `PrecheckConfig` satisfies it.
 */
export interface NativeTierConfig {
  readonly agent?: {
    readonly native?: { readonly catalogOverrides?: readonly { readonly provider: string }[] };
  };
  readonly models?: Readonly<
    Record<string, Readonly<Record<string, string | { readonly model: string } | undefined>> | undefined>
  >;
}
```

- `src/agents/native/session/session.ts`: add `import type { AgentStreamEvent } from "@/agents/agent-stream-event-types";` at the top (as `turn-events.ts` already does), and line 59 becomes `onStreamActivity?: (event: AgentStreamEvent) => void;`. Do not use an inline `import("@/agents/agent-stream-event-types")`: `check:alias-internals` counts the inline form as a value import of an internal and fails.
- `src/agents/native/session/turn-events.ts:52`: `readonly stage?: string;`, with the comment `/** Pipeline stage label; the contract does not know nax's stage union (S1 spec port 4). */`.
- `src/tools/provider-types.ts`: delete the `PipelineStage` import; line 32 becomes `readonly stages: readonly string[];` with the doc comment `/** Stage names this provider attaches to, or "*" for every stage. */`; line 53's parameter becomes `stage: string`.
- `src/tools/provider-advertise.ts`: delete the `PipelineStage` import; line 37's parameter becomes `stage: string`.

- [ ] **Step 5: Add the manifest entries**

In `scripts/s1-move-manifest.json`, after the `src/config/schemas-sandbox.ts` entry, add:

```json
    { "from": "src/config/catalog-overrides.ts", "to": "config/catalog-overrides.ts" },
    { "from": "src/config/native-agent/", "to": "config/native-agent/" },
```

- [ ] **Step 6: Verify**

Run: `bun test test/unit/config/native-agent.test.ts test/unit/agents/native/ test/unit/tools/ --timeout=60000`
Expected: PASS.

Run: `bun run typecheck && bun run check:alias-internals && bun run check:import-cycles && bun run check:complexity`
Expected: all green. A typecheck failure at a caller of `nativeTierProviders` (`cli/config-requirements.ts`, `precheck/checks-native-credentials.ts`) means `NativeTierConfig` does not match `PrecheckConfig`. Fix the interface, never the caller.

Run: `bun scripts/check-agent-boundary.ts --list`
Expected: **11** edges. These nine are gone: `native/client.ts`, `native/model-resolver.ts`, `native/models.ts` (x2), `native/session/session.ts`, `native/session/turn-events.ts`, `native/tier-providers.ts`, `tools/provider-advertise.ts`, `tools/provider-types.ts`.

- [ ] **Step 7: Lower the baseline and commit**

```bash
bun run check:agent-boundary:update
bun x biome check --write src/config/catalog-overrides.ts src/config/native-agent/index.ts src/config/schema-types.ts src/config/agent-defaults.ts src/agents/native src/tools/provider-types.ts src/tools/provider-advertise.ts test/unit/config/native-agent.test.ts test/unit/agents/native/tier-providers.test.ts
bun run lint
git add -A src/config src/agents/native src/tools/provider-types.ts src/tools/provider-advertise.ts test/unit/config/native-agent.test.ts test/unit/agents/native/tier-providers.test.ts scripts/s1-move-manifest.json scripts/baselines/agent-boundary-baseline.json
git commit -m "refactor: move native config leaf types into the nax-agent move set"
```

---

### Task 2: `resolveCodingToolSupport` moves to the nax side (port 1)

`coding-tool-support.ts` is in the move set; its async resolver reads nax config (`loadConfigForPackage`, `resolvePermissions`) and the resolve helpers. The resolver moves into `coding-tool-support-resolve.ts`, which stays in nax. `buildCodingToolSupport` keeps only resolved arguments.

**Files:**
- Modify: `src/agents/coding-tool-support.ts:12-54,288-397`, `src/agents/coding-tool-support-resolve.ts` (header, imports, append)
- Modify (callers): `src/runtime/session-run-hop.ts:2`, `src/operations/build-hop-callback-hop.ts:25`
- Modify (test imports whose subject moved): the 10 test files that import `resolveCodingToolSupport` or `_codingToolSupportDeps` from `@/agents/coding-tool-support` (list: `grep -rln "resolveCodingToolSupport\|_codingToolSupportDeps" test`)
- Test: `test/unit/agents/coding-tool-support-resolve.test.ts` (append a describe)
- Modify: `scripts/baselines/agent-boundary-baseline.json`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `@/agents/coding-tool-support-resolve` exports `resolveCodingToolSupport(options: ResolveCodingToolSupportOptions): Promise<CodingToolSupport | undefined>` (unchanged signature) and `_codingToolSupportDeps = { loadConfigForPackage }` (Tasks 3 and 5 add fields). `@/agents/coding-tool-support` keeps `buildCodingToolSupport`, `buildLedgerSessionName` and `type CodingToolSupport`.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/agents/coding-tool-support-resolve.test.ts` (it is 106 lines). Add the imports at the top of the file, merging into the existing `@/agents/coding-tool-support-resolve` import line:

```ts
import * as moveSetSupport from "@/agents/coding-tool-support";
import { _codingToolSupportDeps, resolveCodingToolSupport, resolveDispatchLauncher } from "@/agents/coding-tool-support-resolve";
import { loadConfigForPackage } from "@/config";
```

and the describe at the end:

```ts
describe("resolveCodingToolSupport — nax-side entry (S1 spec port 1)", () => {
  test("lives here, with nax's real config loader as its default dep", () => {
    expect(typeof resolveCodingToolSupport).toBe("function");
    expect(_codingToolSupportDeps.loadConfigForPackage).toBe(loadConfigForPackage);
  });

  test("is no longer exported by the move-set module, which keeps only resolved-argument assembly", () => {
    expect(Object.keys(moveSetSupport)).not.toContain("resolveCodingToolSupport");
    expect(Object.keys(moveSetSupport)).not.toContain("_codingToolSupportDeps");
    expect(typeof moveSetSupport.buildCodingToolSupport).toBe("function");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/unit/agents/coding-tool-support-resolve.test.ts --timeout=60000`
Expected: FAIL. `_codingToolSupportDeps` and `resolveCodingToolSupport` are not exported by `coding-tool-support-resolve`.

- [ ] **Step 3: Move the resolver**

From `src/agents/coding-tool-support.ts`, **cut** verbatim:
- the doc comment at lines 288-299 (`Resolve coding-tool support for one dispatch, from the run options alone. ...`). It is stranded above `buildLedgerSessionName`'s comment today; it belongs to `resolveCodingToolSupport`.
- `_codingToolSupportDeps` with its comment (lines 313-316),
- `resolveCodingToolSupport` (lines 318-397).

Paste them at the end of `src/agents/coding-tool-support-resolve.ts`, the doc comment directly above `resolveCodingToolSupport`.

Then fix the imports.

In `coding-tool-support.ts`, delete:
- the `loadConfigForPackage`, `resolvePermissions` imports (lines 33-34),
- the whole `./coding-tool-support-resolve` import (lines 39-54),
- `expandMcpRuleGrants` from the `@/tools` import (used only by the resolver; confirm with `grep -n expandMcpRuleGrants src/agents/coding-tool-support.ts`).

Update the file header: the sentences at lines 7-9 ("This is the seam that makes coding tools reachable at all. Callers reach it through resolveCodingToolSupport() below, ...", wrapped across lines, so edit by hand rather than find-and-replace) become: "Callers reach it through `resolveCodingToolSupport` (`coding-tool-support-resolve.ts`, nax side), the single entry point both dispatch hops use."

In `coding-tool-support-resolve.ts`:
- change `import type { loadConfigForPackage, NaxConfig } from "../config";` to `import { loadConfigForPackage, type NaxConfig } from "../config";`
- change `import type { ResolvedPermissions } from "../config/permissions";` to `import { type ResolvedPermissions, resolvePermissions } from "../config/permissions";`
- replace `import type { buildCodingToolSupport } from "./coding-tool-support";` with `import { buildCodingToolSupport, buildLedgerSessionName, type CodingToolSupport } from "./coding-tool-support";`
- add `expandMcpRuleGrants` to the existing `@/tools` import.

Replace the header's "Import direction" paragraph (lines 8-13 at `e6d42e890`; it starts with `Import direction:`) with:

```ts
 * Import direction: this file is nax's side of the coding-tool seam (S1 spec
 * section 4.2, port 1). It owns `resolveCodingToolSupport`, which reads nax
 * config and supplies every nax-owned port, and calls the move set's
 * `buildCodingToolSupport` with resolved arguments only. The move set never
 * imports this file.
```

and the paragraph above it ("coding-tool-support.ts sat at the 600-line source cap ... `resolveCodingToolSupport` itself stays in coding-tool-support.ts as the sequencer ...") with: "`resolveCodingToolSupport` is the sequencer, defined last in this file: guard clauses first, then the support-args assembly."

Run: `wc -l src/agents/coding-tool-support.ts src/agents/coding-tool-support-resolve.ts`
Expected: about 280 and about 513.

- [ ] **Step 4: Retarget the callers and the tests whose subject moved**

- `src/runtime/session-run-hop.ts:2` and `src/operations/build-hop-callback-hop.ts:25`: `import { resolveCodingToolSupport } from "../agents/coding-tool-support-resolve";`
- Every test file from `grep -rln "resolveCodingToolSupport\|_codingToolSupportDeps" test`: import `resolveCodingToolSupport` and `_codingToolSupportDeps` from `@/agents/coding-tool-support-resolve`, and keep importing `buildCodingToolSupport`, `buildLedgerSessionName` and `type CodingToolSupport` from `@/agents/coding-tool-support`. Change import lines only; no test body changes. (Two more files mention the names only in comments; leave them.)

**`test/unit/agents/coding-tool-support.test.ts` is at exactly 800 lines**, and splitting its import adds a line (Task 3 adds one more). Make room by deleting blank lines: the one between `afterEach(() => _resetSandboxRegistryForTests());` and `let root: string;`, the one between `let root: string;` and `beforeAll(`, and one more blank line between two top-level `describe` blocks. Biome keeps all three deletions. Run `wc -l` on it after this task and again after Task 3; it must read 800 or less.

- [ ] **Step 5: Verify**

Run: `bun test test/unit/agents/ test/unit/runtime/session-run-hop.test.ts test/unit/operations/ test/unit/mcp/ test/integration/permissions/ --timeout=60000`
Expected: PASS.

Run: `bun run typecheck && bun run check:import-cycles && bun run check:complexity && bun run check:file-sizes`
Expected: green.

Run: `bun scripts/check-agent-boundary.ts --list`
Expected: **8** edges. Gone: `coding-tool-support.ts -> coding-tool-support-resolve.ts`, `-> config/index.ts`, `-> config/permissions.ts`. `coding-tool-support.ts -> quality/index.ts` remains (Task 3).

- [ ] **Step 6: Lower the baseline and commit**

```bash
bun run check:agent-boundary:update
bun x biome check --write src/agents/coding-tool-support.ts src/agents/coding-tool-support-resolve.ts src/runtime/session-run-hop.ts src/operations/build-hop-callback-hop.ts test
bun run lint
git add -A src/agents/coding-tool-support.ts src/agents/coding-tool-support-resolve.ts src/runtime/session-run-hop.ts src/operations/build-hop-callback-hop.ts test scripts/baselines/agent-boundary-baseline.json
git commit -m "refactor: move resolveCodingToolSupport to the nax side of the tool seam"
```

---

### Task 3: `QualityCommandSpec` joins the move set; the declared-command runner becomes a port (port 7, part 1)

**Files:**
- Modify: `scripts/s1-move-manifest.json` (add `src/quality/command-spec/`)
- Modify: `src/agents/coding-tool-extras.ts:12,14-33,39-41`, `src/agents/coding-tool-support.ts:35` (type import) and its `buildCodingToolSupport` args/body
- Modify: `src/tools/run-command.ts:17-18,58-79,269-...,442`
- Modify: `src/agents/coding-tool-support-resolve.ts` (`_codingToolSupportDeps`, the `buildCodingToolSupport` call)
- Create: `test/unit/tools/run-command-runner.test.ts`, `test/unit/agents/coding-tool-support-ports.test.ts`
- Modify (port cut): tests that build RunCommand outside `resolveCodingToolSupport` and execute a declared command (see Step 6)
- Modify: `scripts/baselines/agent-boundary-baseline.json`

**Interfaces:**
- Produces (in `src/tools/run-command.ts`, exported from `@/tools`):

```ts
export interface DeclaredCommandRequest {
  readonly commandName: string;
  readonly command: QualityCommandSpec;
  readonly workdir: string;
  readonly stripEnvVars: string[];
  readonly origin: "agent-tool";
}
export interface DeclaredCommandResult {
  readonly success: boolean;
  readonly exitCode: number;
  readonly output: string;
}
export type DeclaredCommandRunner = (request: DeclaredCommandRequest) => Promise<DeclaredCommandResult>;
```

  `RunCommandToolOptions.runDeclaredCommand?: DeclaredCommandRunner`; `DeclaredCommandToolsArgs.runDeclaredCommand?` and `buildCodingToolSupport`'s `args.runDeclaredCommand?` with the same type. `_codingToolSupportDeps.runDeclaredCommand` defaults to `runQualityCommand` (`@/quality`), which satisfies `DeclaredCommandRunner` structurally.

- [ ] **Step 1: Write the failing tests**

`test/unit/tools/run-command-runner.test.ts` (new file: `run-command.test.ts` is at its 800-line cap):

```ts
/**
 * RunCommand's declared-command runner port (S1 spec section 4.2, port 7): the
 * tool never imports nax's quality runner; the caller supplies one.
 */
import { describe, expect, test } from "bun:test";
import { withTempDir } from "@test/helpers";
import { createRunCommandTool, type DeclaredCommandRequest } from "@/tools/run-command";

const ctx = (root: string) => ({ root, resolvedPaths: [], maxBytes: 4096, maxFileBytes: 1024 });

describe("RunCommand — declared-command runner port", () => {
  test("hands the declared command, cwd, stripped env and origin to the supplied runner", async () => {
    await withTempDir(async (root) => {
      const seen: DeclaredCommandRequest[] = [];
      const tool = createRunCommandTool(new Map([["lint", "bun lint"]]), {
        commandCwd: root,
        stripEnvVars: ["SECRET"],
        runDeclaredCommand: async (request) => {
          seen.push(request);
          return { success: true, exitCode: 0, output: "clean" };
        },
      });
      const result = await tool.run({ command: "lint" }, ctx(root));
      expect(seen).toEqual([
        { commandName: "lint", command: "bun lint", workdir: root, stripEnvVars: ["SECRET"], origin: "agent-tool" },
      ]);
      expect(result).toEqual({ content: "exit 0\nclean", isError: false });
    });
  });

  test("answers exit 1 without spawning when no runner was configured", async () => {
    await withTempDir(async (root) => {
      const tool = createRunCommandTool(new Map([["lint", "bun lint"]]), { commandCwd: root });
      const result = await tool.run({ command: "lint" }, ctx(root));
      expect(result.isError).toBe(true);
      expect(result.content).toBe("exit 1\nno declared-command runner is configured for this session");
    });
  });
});
```

`test/unit/agents/coding-tool-support-ports.test.ts` (new; Tasks 4 and 5 append to it):

```ts
/**
 * Production wiring of the ports nax supplies to the coding tools (S1 spec
 * section 8: "a test that nax's production wiring supplies it"). Each port is
 * driven through `resolveCodingToolSupport`, the entry both dispatch hops use,
 * so a port that is declared but never threaded fails here.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanupTempDir, makeNaxConfig, makeTempDir, withDepsRestore } from "@test/helpers";
import { _codingToolSupportDeps, resolveCodingToolSupport } from "@/agents/coding-tool-support-resolve";
import { runQualityCommand } from "@/quality";
import type { DeclaredCommandRequest } from "@/tools";

let root: string;
beforeEach(() => {
  root = makeTempDir("nax-cts-ports-");
});
afterEach(() => cleanupTempDir(root));

describe("port 7: declared-command runner", () => {
  withDepsRestore(_codingToolSupportDeps, ["runDeclaredCommand"]);

  test("defaults to nax's quality runner", () => {
    expect(_codingToolSupportDeps.runDeclaredCommand).toBe(runQualityCommand);
  });

  test("reaches the RunCommand tool through the production entry", async () => {
    const seen: DeclaredCommandRequest[] = [];
    _codingToolSupportDeps.runDeclaredCommand = async (request) => {
      seen.push(request);
      return { success: true, exitCode: 0, output: "" };
    };
    const support = await resolveCodingToolSupport({
      declaredTools: ["RunCommand"],
      codingToolRoot: root,
      pipelineStage: "run",
      config: makeNaxConfig({ quality: { commands: { lint: "bun lint" } } }),
    });
    await support?.runtime.callTool("RunCommand", { command: "lint" });
    expect(seen.map((request) => request.commandName)).toEqual(["lint"]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/unit/tools/run-command-runner.test.ts test/unit/agents/coding-tool-support-ports.test.ts --timeout=60000`
Expected: FAIL. `DeclaredCommandRequest` is not exported, the runner is ignored (the first test spawns `bun lint` for real), and `_codingToolSupportDeps.runDeclaredCommand` is undefined.

- [ ] **Step 3: Move `QualityCommandSpec` into the move set**

Confirm `src/quality/command-spec/index.ts` has no imports (`grep -n "^import" src/quality/command-spec/index.ts` prints nothing). In `scripts/s1-move-manifest.json`, after the `src/verification/shell-quote.ts` entry, add:

```json
    { "from": "src/quality/command-spec/", "to": "internal/command-spec/" },
```

Retarget the two move-set type imports to the nested barrel:
- `src/agents/coding-tool-extras.ts:12`: `import type { QualityCommandSpec } from "@/quality/command-spec";`
- `src/agents/coding-tool-support.ts:35`: `import type { QualityCommandSpec } from "@/quality/command-spec";`

`src/tools/run-command.ts:17` (`../quality/command-spec`) stays; it is now an edge inside the manifest.

- [ ] **Step 4: Cut the runner port in `run-command.ts`**

Delete `import { runQualityCommand } from "../quality/runner";` (line 18). After `RunCommandExecOptions`, add the three exported types from **Interfaces** above, each with a one-line doc comment ("What RunCommand hands the runner for one declared command." / "What RunCommand reads back." / "Runs one declared command; nax supplies `runQualityCommand` (S1 spec port 7).").

Add to `RunCommandToolOptions`:

```ts
  /**
   * Runs a DECLARED (non-Exec) command (S1 spec section 4.2, port 7). nax
   * supplies `runQualityCommand` through `resolveCodingToolSupport`; absent,
   * the tool answers `exit 1` and spawns nothing.
   */
  readonly runDeclaredCommand?: DeclaredCommandRunner;
```

Above `createRunCommandTool`, add:

```ts
const MISSING_RUNNER_OUTPUT = "no declared-command runner is configured for this session";

/** The runner a tool built without one uses: refuses, spawns nothing. */
async function refuseWithoutRunner(): Promise<DeclaredCommandResult> {
  return { success: false, exitCode: 1, output: MISSING_RUNNER_OUTPUT };
}

/** Kept out of `run`, which sits at its complexity baseline. */
function declaredCommandRunner(opts: RunCommandToolOptions): DeclaredCommandRunner {
  return opts.runDeclaredCommand ?? refuseWithoutRunner;
}
```

At the top of `createRunCommandTool`'s body (before `return {`), add `const runDeclared = declaredCommandRunner(opts);`. If `opts` is optional there (`opts: RunCommandToolOptions = {}` or `opts?:`), keep its existing default; pass the defaulted value. At line 442, replace `await runQualityCommand({` with `await runDeclared({`. The object literal is unchanged.

Update the file header's first paragraph: "src/quality/runner.ts executes every configured command through one" becomes "nax's quality runner (`src/quality/runner.ts`, supplied as `runDeclaredCommand`) executes every configured command through one".

Export the three types from `src/tools/index.ts` next to `createRunCommandTool`.

- [ ] **Step 5: Thread the runner from nax**

`src/agents/coding-tool-extras.ts`: add to `DeclaredCommandToolsArgs`:

```ts
  /** Port 7: runs declared commands; nax supplies `runQualityCommand`. */
  readonly runDeclaredCommand?: DeclaredCommandRunner;
```

(import `type DeclaredCommandRunner` from `@/tools`), and inside the `createRunCommandTool(args.declaredCommands, { ... })` literal add `runDeclaredCommand: args.runDeclaredCommand,` directly after `commandCwd`. It is unconditional: no new branch in `buildDeclaredCommandTools` (complexity 24).

`src/agents/coding-tool-support.ts`: add to `buildCodingToolSupport`'s args type, after `declaredCommands`:

```ts
  /** Port 7, forwarded to RunCommand. Supplied by `resolveCodingToolSupport`. */
  runDeclaredCommand?: DeclaredCommandRunner;
```

and in the `buildDeclaredCommandTools({ ... })` call, add `runDeclaredCommand: args.runDeclaredCommand,` after `declaredCommands,`. It is unconditional: no new branch in `buildCodingToolSupport` (complexity 38).

`src/agents/coding-tool-support-resolve.ts`:
- add `import { runQualityCommand } from "../quality";` (merge with the existing `../quality` type import) and `type DeclaredCommandRunner` to the `@/tools` import,
- `_codingToolSupportDeps` becomes, **with an explicit type** (inferred from `runQualityCommand`, the property would be typed `(opts: QualityCommandOptions) => ...`, and the port test's stub would fail typecheck with TS2322):

```ts
/** Injectable deps for testability — mirrors the _agentManagerDeps pattern. Each nax-owned port has its default here. */
export const _codingToolSupportDeps: {
  loadConfigForPackage: typeof loadConfigForPackage;
  /** Port 7: the declared-command runner RunCommand calls. */
  runDeclaredCommand: DeclaredCommandRunner;
} = {
  loadConfigForPackage,
  runDeclaredCommand: runQualityCommand,
};
```

- in `resolveCodingToolSupport`'s `buildCodingToolSupport({ ... })` call, add `runDeclaredCommand: _codingToolSupportDeps.runDeclaredCommand,` after `declaredCommands,`.

If `bun run typecheck` reports that `runQualityCommand` is not assignable to `DeclaredCommandRunner`, the request type has drifted from `QualityCommandOptions`. Fix `DeclaredCommandRequest`, never with a cast.

- [ ] **Step 6: Update the tests whose RunCommand lost its built-in runner**

Run the phases separately: `bun run test` stops after the unit phase fails, which hides integration failures.

```bash
bun run test:unit 2>&1 | grep -B5 "no declared-command runner"
bun run test:integration 2>&1 | grep -B5 "no declared-command runner"
```

Every failure is a test that builds RunCommand **outside** `resolveCodingToolSupport` (directly via `createRunCommandTool`, or via `buildCodingToolSupport` with `declaredCommands`) and then executes a declared command. The final review found exactly four files at `e6d42e890`. Pass the real runner in each, which is what production wires:

- `test/unit/tools/run-command.test.ts` (18 failures). It is at **800 lines** and may not grow. First move its `substituteCommand` describe (the pure-substitution tests at lines 11-100, which never build a tool) **verbatim** into `test/unit/tools/run-command-substitute.test.ts`, with the imports they use. That is a split by concern (`.nax/rules/test-architecture.md`), and it leaves about 709 lines. Then, rather than editing about 40 call sites, import the factory under a lower-case alias and shadow it with a local wrapper that supplies the production runner to **every** call, including calls that do not fail today:

  ```ts
  import { createRunCommandTool as createBareRunCommandTool, substituteCommand } from "@/tools/run-command";
  import { runQualityCommand } from "@/quality";

  /** Production wires nax's quality runner (S1 spec port 7); every tool here gets it. */
  const createRunCommandTool = (...[declared, opts]: Parameters<typeof createBareRunCommandTool>) =>
    createBareRunCommandTool(declared, { runDeclaredCommand: runQualityCommand, ...opts });
  ```

  (`as createBareRunCommandTool` starts lower-case, so the loose-cast counter does not match it.) Supplying it everywhere matters: "strips configured secrets from agent-invoked commands" still passes without a runner, because its `not.toContain` is satisfied by the refusal text, but then it no longer tests env stripping.
- `test/unit/tools/run-command-exec.test.ts` (1 failure: "declared branch still works"): add `runDeclaredCommand: runQualityCommand` to its options.
- `test/unit/agents/coding-tool-support.test.ts` (1 failure: "commandCwd reaches RunCommand"): add `runDeclaredCommand: _codingToolSupportDeps.runDeclaredCommand,` to its `buildCodingToolSupport` args. The file already imports `_codingToolSupportDeps` after Task 2, so this needs no new import line; the file is at its 800-line cap (Task 2, Step 4).
- `test/integration/permissions/sandbox-wiring.test.ts` (1 failure, D14): add `runDeclaredCommand: runQualityCommand`.

Run `wc -l` on every edited test file afterwards.

- [ ] **Step 7: Verify**

Run: `bun test test/unit/tools/run-command-runner.test.ts test/unit/agents/coding-tool-support-ports.test.ts --timeout=60000`
Expected: PASS.

Run: `bun run test`
Expected: PASS.

Run: `bun run typecheck && bun run check:complexity && bun run check:file-sizes && bun run check:import-cycles`
Expected: green.

Run: `bun scripts/check-agent-boundary.ts --list`
Expected: **4** edges, all of them Task 5's: `coding-tool-sandbox.ts -> trust`, `policy-inputs.ts -> config/paths`, `git-commit.ts -> utils/gitignore`, `git.ts -> utils/nax-owned-paths`.

- [ ] **Step 8: Lower the baseline and commit**

```bash
bun run check:agent-boundary:update
bun x biome check --write src/tools/run-command.ts src/tools/index.ts src/agents/coding-tool-extras.ts src/agents/coding-tool-support.ts src/agents/coding-tool-support-resolve.ts test
bun run lint
git add -A src/tools/run-command.ts src/tools/index.ts src/agents test scripts/s1-move-manifest.json scripts/baselines/agent-boundary-baseline.json
git commit -m "refactor: make the declared-command runner a port nax supplies"
```

---

### Task 4: The interceptor travels as data; both global slots are deleted (port 7, part 2)

No ratchet edge (nax wrote *into* the move set), but the spec requires deleting the slots. Today `setupRun` assigns `_gitToolDeps.interceptor` and `_bashToolDeps.interceptor` (`run-setup.ts:218-219`), a process-global that outlives its run.

**Files:**
- Modify: `src/tools/registry.ts:61-91` (`ToolRunContext`), `src/tools/runtime.ts:126-200,395-420`, `src/tools/bash.ts:81-92,265,298`, `src/tools/git.ts:18-32,374-415`, `src/tools/index.ts:1-11`
- Modify: `src/agents/coding-tool-support.ts` (args + `createCodingToolRuntime` call), `src/agents/coding-tool-support-resolve.ts:45-66` and the `buildCodingToolSupport` call
- Modify: `src/agents/types.ts:~171` (`AgentRunOptions`), `src/runtime/index.ts` (`NaxRuntime`, `CreateRuntimeOptions`, `createRuntime` literal), `src/operations/call-run-options.ts:75`, `src/execution/lifecycle/run-setup.ts:43,197-219,247-256`
- Modify (port cut): `test/unit/tools/git-interception.test.ts`, `test/unit/tools/bash-intercept.test.ts`, `test/unit/execution/lifecycle/run-setup-command-interceptor.test.ts`, plus any other file `grep -rln "\.interceptor" test` finds
- Test: `test/unit/agents/coding-tool-support-ports.test.ts` (append), `test/unit/operations/call-run-options.test.ts` (append)

**Interfaces:**
- Produces: `ToolRunContext.interceptor?: CommandInterceptor`; `createCodingToolRuntime` option `interceptor?`; `buildCodingToolSupport` arg `interceptor?`; `AgentRunOptions.commandInterceptor?`; `ResolveCodingToolSupportOptions` picks `"commandInterceptor"`; `NaxRuntime.commandInterceptor?` and `CreateRuntimeOptions.commandInterceptor?`. **Deleted:** `_gitToolDeps` (whole object) and `_bashToolDeps.interceptor`. `_bashToolDeps.runArgv` stays.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/agents/coding-tool-support-ports.test.ts`. Imports to add at the top:

```ts
import { makeSpawn } from "@test/helpers";
import type { CommandInterceptor } from "@/execution/command-interceptor";
import { _launcherDeps } from "@/sandbox";
import { _gitDeps } from "@/utils/git";
```

(merge `makeSpawn` into the existing `@test/helpers` import), and:

```ts
/** Records which site consulted it, and declines, so the original command runs. */
function recordingInterceptor(sites: string[]): CommandInterceptor {
  return {
    provider: "probe",
    intercept: async (request) => {
      sites.push(request.site);
      return { kind: "declined", reason: "probe" };
    },
    interceptShell: async (request) => {
      sites.push(request.site);
      return { kind: "declined", reason: "probe" };
    },
  };
}

describe("port 7: command interceptor", () => {
  withDepsRestore(_gitDeps, ["spawn"]);
  withDepsRestore(_launcherDeps, ["runArgv"]);

  test("one interceptor reaches both the Git and the Bash tool contexts", async () => {
    _gitDeps.spawn = makeSpawn(() => "out").spawn;
    _launcherDeps.runArgv = async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false });
    const sites: string[] = [];
    // `permissions.run.allow` is in the zod schema but not the narrow runtime
    // alias, so the block is widened here, as coding-tool-support-bash-approval.test.ts does.
    const execution: Record<string, unknown> = {
      permissions: { run: { allow: ["Bash(echo *)"] } },
      sandbox: { enabled: false },
    };
    const support = await resolveCodingToolSupport({
      declaredTools: ["Git", "Bash"],
      codingToolRoot: root,
      pipelineStage: "run",
      config: makeNaxConfig({ execution }),
      commandInterceptor: recordingInterceptor(sites),
    });
    await support?.runtime.callTool("Git", { subcommand: "log" });
    await support?.runtime.callTool("Bash", { command: "echo hi" });
    expect(sites).toEqual(["git", "bash"]);
  });

  test("no interceptor in the options means neither site is intercepted", async () => {
    _gitDeps.spawn = makeSpawn(() => "out").spawn;
    const support = await resolveCodingToolSupport({
      declaredTools: ["Git"],
      codingToolRoot: root,
      pipelineStage: "run",
      config: makeNaxConfig({ execution: { sandbox: { enabled: false } } }),
    });
    const outcome = await support?.runtime.callTool("Git", { subcommand: "log" });
    expect(outcome?.kind).toBe("ok");
  });
});
```

Append to `test/unit/operations/call-run-options.test.ts` (217 lines). Reuse that file's `ctx` construction exactly as its existing tests build it (`makeTestRuntime({ config, workdir: "/repo" })`, `runtime.packages.resolve("packages/api")`, the `CallContext` literal and the `buildRunDispatchOptions` params). `makeTestRuntime` forwards `CreateRuntimeOptions`, so it accepts `commandInterceptor`:

```ts
describe("buildRunDispatchOptions — the run's command interceptor (S1 spec port 7)", () => {
  const interceptor: CommandInterceptor = { provider: "probe", intercept: async () => ({ kind: "unchanged" }) };

  test("buildRunDispatchOptions carries the runtime's interceptor", () => {
    const config = makeNaxConfig();
    const runtime = makeTestRuntime({ config, workdir: "/repo", commandInterceptor: interceptor });
    createdRuntimes.push(runtime);
    const ctx: CallContext = {
      runtime,
      packageView: runtime.packages.resolve("packages/api"),
      packageDir: "packages/api",
      config,
      agentName: "claude",
    };
    const result = buildRunDispatchOptions(ctx, {
      prompt: "hi",
      effectiveTier: "balanced",
      dispatchModelDef: { provider: "claude", model: "sonnet" },
      config,
      callId: "call-1",
      pipelineStage: "run",
      declaredTools: ["Read"],
      keepOpen: false,
    });
    expect(result.commandInterceptor).toBe(interceptor);
  });

  test("a runtime without an interceptor adds no commandInterceptor key", () => {
    const config = makeNaxConfig();
    const runtime = makeTestRuntime({ config, workdir: "/repo" });
    createdRuntimes.push(runtime);
    const ctx: CallContext = {
      runtime,
      packageView: runtime.packages.resolve("packages/api"),
      packageDir: "packages/api",
      config,
      agentName: "claude",
    };
    const result = buildRunDispatchOptions(ctx, {
      prompt: "hi",
      effectiveTier: "balanced",
      dispatchModelDef: { provider: "claude", model: "sonnet" },
      config,
      callId: "call-1",
      pipelineStage: "run",
      declaredTools: ["Read"],
      keepOpen: false,
    });
    expect(Object.keys(result)).not.toContain("commandInterceptor");
  });
});
```

(add `import type { CommandInterceptor } from "@/execution/command-interceptor";` at the top.)

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/unit/agents/coding-tool-support-ports.test.ts test/unit/operations/call-run-options.test.ts --timeout=60000`
Expected: FAIL. `sites` stays `[]` (the options field is ignored), and `result.commandInterceptor` is undefined.

- [ ] **Step 3: The tool context carries the interceptor**

`src/tools/registry.ts`: add `import type { CommandInterceptor } from "@/execution/command-interceptor";` and, at the end of `ToolRunContext`:

```ts
  /**
   * The run's command interceptor (US-003; S1 spec section 4.2, port 7). The
   * same object for every tool of a run, so the Git and Bash sites share one
   * binary probe and one mode. Absent when the run installed none: interception
   * then does not apply, the fail-safe both sites state.
   */
  readonly interceptor?: CommandInterceptor;
```

`src/tools/runtime.ts`: add `interceptor?: CommandInterceptor;` to `createCodingToolRuntime`'s options, with the comment `/** Port 7: placed on every ToolRunContext this runtime builds. */`. Add below `_resetBuiltinsForTest`:

```ts
/**
 * The run-scoped ports every ToolRunContext carries, present-field only.
 * Built once per runtime and kept out of `runTool`, which sits at its
 * complexity baseline.
 */
function contextPorts(opts: { readonly interceptor?: CommandInterceptor }): Pick<ToolRunContext, "interceptor"> {
  return opts.interceptor !== undefined ? { interceptor: opts.interceptor } : {};
}
```

In `createCodingToolRuntime`, next to `const sink = ...`, add `const ports = contextPorts(opts);`. In `runTool`'s `target.run(callInput, { ... })` literal, add `...ports,` after the `denyPaths` spread. That is a spread with no conditional, so `runTool` stays at 24. Import `type CommandInterceptor` from `@/execution/command-interceptor` and `type ToolRunContext` from `./registry` if not already imported.

- [ ] **Step 4: Bash and Git read the context; delete both slots**

`src/tools/bash.ts`: delete `interceptor` from `_bashToolDeps` and rewrite its doc comment to "Injectable spawn seam, mirroring `_argvExecDeps`." In `launchIntercepted`, replace the read-once comment and `const interceptor = _bashToolDeps.interceptor;` with:

```ts
  // The run's interceptor arrives on the context (S1 spec port 7), immutable
  // for this call, so the launch below and `postProcess` see the same object.
  const interceptor = ctx.interceptor;
```

Drop the now-unused `CommandInterceptor` type import if nothing else uses it.

`src/tools/git.ts`: delete `_gitToolDeps` and its doc comment (lines 25-32) and the `CommandInterceptor` type import. At the top of `run`, after the `buildGitArgv` guard, add `const interceptor = ctx.interceptor;`. Line 380 passes `interceptor` instead of `_gitToolDeps.interceptor`, and line 414 uses `interceptor?.postProcess?.(stdout, req)?.output ?? stdout`. That expression already contains those operators, so no new complexity is added.

`src/tools/index.ts`: remove `_gitToolDeps` from the `./git` export list.

- [ ] **Step 5: nax supplies it: runtime -> options -> support**

`src/agents/types.ts`, in `AgentRunOptions` next to `providers?` (line ~171):

```ts
  /**
   * The run's command interceptor (S1 spec port 7), copied from the runtime by
   * `buildRunDispatchOptions` so both dispatch hops resolve the same one.
   */
  commandInterceptor?: import("@/execution/command-interceptor").CommandInterceptor;
```

`src/agents/coding-tool-support-resolve.ts`: add `| "commandInterceptor"` to the `ResolveCodingToolSupportOptions` Pick. In `resolveCodingToolSupport`'s `buildCodingToolSupport({ ... })` call, add `interceptor: options.commandInterceptor,`.

`src/agents/coding-tool-support.ts`: add to `buildCodingToolSupport`'s args `interceptor?: CommandInterceptor;` (doc: `/** Port 7: the run's interceptor, placed on every tool context. */`; `import type { CommandInterceptor } from "@/execution/command-interceptor";`) and **pass `interceptor: args.interceptor,` in the `createCodingToolRuntime({ ... })` literal**. That is two edits, the arg type and the pass-through; the final review missed the second on a first pass and only the wiring test caught it (no type error; `sites` stayed `[]`). It is unconditional, so `buildCodingToolSupport` stays at 38.

`src/runtime/index.ts`: add to `NaxRuntime` (next to `toolProviders`):

```ts
  /**
   * The run's command interceptor (US-003; S1 spec port 7). Installed by
   * `setupRun`; absent for entry points that never run it (plan, prompts,
   * setup), where interception does not apply.
   */
  readonly commandInterceptor?: import("@/execution/command-interceptor").CommandInterceptor;
```

add `commandInterceptor?: import("@/execution/command-interceptor").CommandInterceptor;` to `CreateRuntimeOptions` (doc: `/** See NaxRuntime.commandInterceptor. */`), and `commandInterceptor: opts?.commandInterceptor,` to the returned literal next to `toolProviders`. Optional chaining adds no cognitive complexity to `createRuntime`.

`src/operations/call-run-options.ts`: add above `buildRunDispatchOptions`:

```ts
/**
 * The run-scoped objects every dispatch takes from the runtime: MCP providers
 * and the command interceptor. Both hops resolve tool support from these
 * options, so injecting once here cannot leave the two paths with different
 * tools or a different interceptor.
 */
function runtimeDispatchFields(runtime: CallContext["runtime"]) {
  return {
    ...(runtime.toolProviders.length > 0 ? { providers: runtime.toolProviders } : {}),
    ...(runtime.commandInterceptor !== undefined ? { commandInterceptor: runtime.commandInterceptor } : {}),
  };
}
```

and replace line 75 (`...(ctx.runtime.toolProviders.length > 0 ? { providers: ctx.runtime.toolProviders } : {}),`) with `...runtimeDispatchFields(ctx.runtime),`. Move the comment that sat above line 75 into the helper's doc (done above). Moving the existing ternary out keeps `buildRunDispatchOptions` from growing.

`src/execution/lifecycle/run-setup.ts`: delete `import { _bashToolDeps, _gitToolDeps } from "@/tools";` and the two assignments (lines 218-219). Pass the interceptor into the runtime: add `commandInterceptor: interceptor,` to the `_runSetupDeps.createRuntime(config, workdir, { ... })` options (line 247). Rewrite the section comment's last sentence ("Entry points that skip setupRun leave the seam undefined ...") to: "It travels on the runtime (`NaxRuntime.commandInterceptor`) into every dispatch's options; entry points that skip setupRun create runtimes without one, and interception simply does not apply — fail-safe."

- [ ] **Step 6: Update the tests whose slot was cut**

- `test/unit/tools/git-interception.test.ts`: remove the `_gitToolDeps` import and `withDepsRestore(_gitToolDeps, ["interceptor"])`; every `_gitToolDeps.interceptor = X; ... gitTool.run(input, ctx())` becomes `gitTool.run(input, { ...ctx(), interceptor: X })`, and the "no interceptor installed" test passes `ctx()` unchanged.
- `test/unit/tools/bash-intercept.test.ts`: the same transformation for `_bashToolDeps.interceptor`. Where the test drives a runtime (`createCodingToolRuntime({ ... })`), pass `interceptor: X` in the runtime options instead. Update the header comment that names `_bashToolDeps.interceptor`.
- `test/unit/execution/lifecycle/run-setup-command-interceptor.test.ts`: capture the options `setupRun` hands the runtime factory: `_runSetupDeps.createRuntime = (cfg, wd, opts) => { captured = opts?.commandInterceptor; ... }`, and assert on `captured` where the old tests read `_gitToolDeps.interceptor` / `_bashToolDeps.interceptor`. `installFromConfig` never called `setupRun` (it re-did the slot install by hand); turn it into a function that **returns** the interceptor it builds, and pass that in the tool context. A test that then ran `gitTool.run` passes `{ ...ctx(), interceptor: captured }`. The test asserting "one interceptor on Git and Bash" (AC16) loses its subject with the slots; rewrite it to assert that the captured interceptor exposes both `intercept` and `interceptShell`. Delete the two `withDepsRestore` lines for the deleted slots.
- Either call-site form is fine for the two tool tests. A module-level `let interceptor: CommandInterceptor | undefined`, reset in `beforeEach` and merged into `ctx()` / the runtime-builder helper, is less churn than rewriting each call site.
- `grep -rn "_gitToolDeps\|_bashToolDeps.interceptor" test` must then print nothing. (Do not grep bare `.interceptor`; fields such as `stub.interceptor` legitimately match.)

- [ ] **Step 7: Verify**

Run: `bun test test/unit/agents/coding-tool-support-ports.test.ts test/unit/operations/call-run-options.test.ts test/unit/tools/ test/unit/execution/lifecycle/ --timeout=60000`
Expected: PASS.

Run: `grep -rn "_gitToolDeps\|_bashToolDeps.interceptor" src test scripts`
Expected: no output.

Run: `bun run test && bun run typecheck && bun run check:complexity && bun run check:import-cycles && bun run check:file-sizes`
Expected: green. `bun run check:agent-boundary` still reads **4**.

- [ ] **Step 8: Commit**

```bash
bun x biome check --write src/tools src/agents/coding-tool-support.ts src/agents/coding-tool-support-resolve.ts src/agents/types.ts src/runtime/index.ts src/operations/call-run-options.ts src/execution/lifecycle/run-setup.ts test
bun run lint
git add -A src test
git commit -m "refactor: carry the command interceptor in the tool context, delete the global slots"
```

---

### Task 5: Protected paths become a policy nax supplies (port 6)

The last four edges: `tools/git.ts -> utils/nax-owned-paths`, `tools/git-commit.ts -> utils/gitignore`, `sandbox/policy-inputs.ts -> config/paths`, `coding-tool-sandbox.ts -> trust`.

**Files:**
- Create: `src/tools/protected-paths.ts`, `src/agents/nax-protected-paths.ts`, `test/unit/agents/nax-protected-paths.test.ts`
- Modify: `src/tools/registry.ts` (`ToolRunContext`), `src/tools/runtime.ts` (`contextPorts`, options), `src/tools/index.ts`
- Modify: `src/tools/git.ts:21,199,315,375`, `src/tools/git-commit.ts:18,86-95,160`, `src/tdd/red-commit.ts:20,47,77`, `scripts/analyze-rtk-savings.ts:14,54,61`
- Modify: `src/sandbox/policy-inputs.ts:9,49-67`, `src/agents/coding-tool-sandbox.ts:30,33-50,96-165`
- Modify: `src/agents/coding-tool-support.ts` (args + runtime call), `src/agents/coding-tool-support-resolve.ts` (`_codingToolSupportDeps`, `resolveDispatchLauncher`, the support call)
- Modify (port cut): `test/unit/tools/git.test.ts`, `test/unit/tools/git-commit.test.ts`, `test/unit/sandbox/policy-inputs.test.ts`, `test/unit/agents/coding-tool-sandbox.test.ts`, `test/helpers/session-sandbox-deps.ts`, `test/integration/sandbox/sandbox-live.test.ts`, `scripts/probe-c2-story-loop.ts` (Step 7 lists each)
- Test: `test/unit/agents/coding-tool-support-ports.test.ts` (append), `test/unit/agents/coding-tool-support-resolve.test.ts` (append)
- Modify: `scripts/baselines/agent-boundary-baseline.json`

**Interfaces:**
- Produces (`src/tools/protected-paths.ts`, exported from `@/tools`):

```ts
export interface ProtectedPathsPolicy {
  readonly gitExcludePathspecs: readonly string[];
  readonly gitIgnorePatterns: readonly string[];
  readonly projectStateDir: string;
  readonly credentialDir: string;
  readonly trustStoreFile: string;
}
export function gitExcludePathspecsOf(ctx: { readonly protectedPaths?: ProtectedPathsPolicy }): readonly string[];
export function gitIgnorePatternsOf(ctx: { readonly protectedPaths?: ProtectedPathsPolicy }): readonly string[];
```

- `ToolRunContext.protectedPaths?`; `createCodingToolRuntime` option `protectedPaths?`; `buildCodingToolSupport` arg `protectedPaths?`.
- `buildGitArgv(input, defaultExcludes: readonly string[] = [])`; `partitionNaxOwnedPaths(root, paths, ignorePatterns: readonly string[])`; `listNaxEntries(root, stateDir)`; `listCredentialFiles(dir)`; `_sessionSandboxDeps.naxEntries(root, stateDir)` / `.credentialFiles(dir)`; `resolveSessionSandbox` arg `protectedPaths: ProtectedPathsPolicy` (**required**).
- `naxProtectedPaths(): ProtectedPathsPolicy` in `src/agents/nax-protected-paths.ts`; `_codingToolSupportDeps.protectedPaths` defaults to it.

- [ ] **Step 1: Write the failing tests**

`test/unit/agents/nax-protected-paths.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { _codingToolSupportDeps } from "@/agents/coding-tool-support-resolve";
import { naxProtectedPaths } from "@/agents/nax-protected-paths";
import { globalConfigDir, PROJECT_NAX_DIR } from "@/config";
import { trustStorePath } from "@/trust";
import { NAX_GITIGNORE_ENTRIES } from "@/utils/gitignore";
import { NAX_OWNED_GIT_EXCLUDE_PATHSPECS } from "@/utils/nax-owned-paths";

const ENV = "NAX_GLOBAL_CONFIG_DIR";
const previous = process.env[ENV];
afterEach(() => {
  if (previous === undefined) delete process.env[ENV];
  else process.env[ENV] = previous;
});

describe("naxProtectedPaths — nax's knowledge, supplied to the tools and the sandbox", () => {
  test("is built from nax's own path definitions", () => {
    const policy = naxProtectedPaths();
    expect(policy.gitExcludePathspecs).toBe(NAX_OWNED_GIT_EXCLUDE_PATHSPECS);
    expect(policy.gitIgnorePatterns).toBe(NAX_GITIGNORE_ENTRIES);
    expect(policy.projectStateDir).toBe(PROJECT_NAX_DIR);
    expect(policy.credentialDir).toBe(globalConfigDir());
    expect(policy.trustStoreFile).toBe(trustStorePath());
  });

  test("naxProtectedPaths follows NAX_GLOBAL_CONFIG_DIR live", () => {
    process.env[ENV] = "/tmp/nax-protected-a";
    const first = naxProtectedPaths();
    process.env[ENV] = "/tmp/nax-protected-b";
    const second = naxProtectedPaths();
    expect(first.credentialDir).toBe("/tmp/nax-protected-a");
    expect(second.credentialDir).toBe("/tmp/nax-protected-b");
    expect(second.trustStoreFile.startsWith(join("/tmp/nax-protected-b"))).toBe(true);
  });

  test("is the default the dispatch resolver supplies", () => {
    expect(_codingToolSupportDeps.protectedPaths).toBe(naxProtectedPaths);
  });
});
```

`globalConfigDir()` returns `NAX_GLOBAL_CONFIG_DIR` verbatim when set (`config/paths/index.ts:63-67`), and `trustStorePath()` is `<globalConfigDir()>/trust.json` (`trust/store.ts:57`).

Append to `test/unit/agents/coding-tool-support-ports.test.ts`:

```ts
describe("port 6: protected paths", () => {
  withDepsRestore(_gitDeps, ["spawn"]);

  test("the Git tool's default view still excludes .nax through the production entry", async () => {
    const spawned: string[][] = [];
    _gitDeps.spawn = makeSpawn(({ cmd }) => {
      spawned.push([...cmd]);
      return "out";
    }).spawn;
    const support = await resolveCodingToolSupport({
      declaredTools: ["Git"],
      codingToolRoot: root,
      pipelineStage: "run",
      config: makeNaxConfig({ execution: { sandbox: { enabled: false } } }),
    });
    await support?.runtime.callTool("Git", { subcommand: "status" });
    expect(spawned[0]).toContain(":(exclude).nax");
    expect(spawned[0]).toContain(":(glob,exclude)**/.nax/**");
  });

  test("a tool context without a policy excludes and filters nothing extra", () => {
    expect(gitExcludePathspecsOf({})).toEqual([]);
    expect(gitIgnorePatternsOf({})).toEqual([]);
  });
});
```

(import `gitExcludePathspecsOf` and `gitIgnorePatternsOf` from `@/tools`.)

Append to `test/unit/agents/coding-tool-support-resolve.test.ts`, **inside** the existing `describe("resolveDispatchLauncher — US-002 ...")` block, so it reuses `runDispatched()` and its stubs. Also add `withDepsRestore(_codingToolSupportDeps, ["protectedPaths"]);` next to the block's other `withDepsRestore` lines, and import `join` from `node:path`:

```ts
  test("port 6: the sandbox denies writes to the trust store the protected-paths policy names", async () => {
    const trustStoreFile = join(root, "trust.json");
    _codingToolSupportDeps.protectedPaths = () => ({
      gitExcludePathspecs: [],
      gitIgnorePatterns: [],
      projectStateDir: ".nax",
      credentialDir: root,
      trustStoreFile,
    });
    const { policy } = await runDispatched();

    expect(policy.denyWrite).toContain(realOrRaw(trustStoreFile));
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/unit/agents/nax-protected-paths.test.ts test/unit/agents/coding-tool-support-ports.test.ts test/unit/agents/coding-tool-support-resolve.test.ts --timeout=60000`
Expected: FAIL. `@/agents/nax-protected-paths` cannot be resolved, and `_codingToolSupportDeps.protectedPaths` is undefined. The `.nax` exclude test passes today and must stay passing after Step 6; it is the regression guard for nax#2007.

- [ ] **Step 3: The policy type and its readers (move set)**

`src/tools/protected-paths.ts`:

```ts
/**
 * Paths the HOST owns, which the coding tools and the sandbox must keep the
 * agent away from (S1 spec section 4.2, port 6). Data only: nax builds it
 * from its own path definitions (`naxProtectedPaths`) once per dispatch; an
 * embedder supplies its own.
 */
export interface ProtectedPathsPolicy {
  /** Long-form pathspecs the Git tool appends to its default (no-path) view (nax#2007). */
  readonly gitExcludePathspecs: readonly string[];
  /** Gitignore patterns GitCommit refuses to stage. */
  readonly gitIgnorePatterns: readonly string[];
  /** Project-relative directory whose top-level entries the sandbox policy lists. */
  readonly projectStateDir: string;
  /** Directory whose `credentials*` files the sandbox denies. */
  readonly credentialDir: string;
  /** File the sandbox denies writes to: the trust store deciding whether repository code runs. */
  readonly trustStoreFile: string;
}

/** The Git tool's default excludes; none when the session carries no policy. */
export function gitExcludePathspecsOf(ctx: { readonly protectedPaths?: ProtectedPathsPolicy }): readonly string[] {
  return ctx.protectedPaths?.gitExcludePathspecs ?? [];
}

/** GitCommit's ignore patterns; none when the session carries no policy. */
export function gitIgnorePatternsOf(ctx: { readonly protectedPaths?: ProtectedPathsPolicy }): readonly string[] {
  return ctx.protectedPaths?.gitIgnorePatterns ?? [];
}
```

The two readers keep the `??` out of `gitCommitTool.run` (complexity 22) and `gitTool.run`. Export the type and both functions from `src/tools/index.ts`.

`src/tools/registry.ts`: add to `ToolRunContext`:

```ts
  /** Host-owned paths (S1 spec port 6). Absent: the Git tools exclude and skip nothing extra. */
  readonly protectedPaths?: ProtectedPathsPolicy;
```

`src/tools/runtime.ts`: add `protectedPaths?: ProtectedPathsPolicy;` to `createCodingToolRuntime`'s options and widen `contextPorts`:

```ts
function contextPorts(opts: {
  readonly interceptor?: CommandInterceptor;
  readonly protectedPaths?: ProtectedPathsPolicy;
}): Pick<ToolRunContext, "interceptor" | "protectedPaths"> {
  return {
    ...(opts.interceptor !== undefined ? { interceptor: opts.interceptor } : {}),
    ...(opts.protectedPaths !== undefined ? { protectedPaths: opts.protectedPaths } : {}),
  };
}
```

- [ ] **Step 4: The Git tools take the paths as data**

`src/tools/git.ts`: delete the `NAX_OWNED_GIT_EXCLUDE_PATHSPECS` import. The signature becomes `export function buildGitArgv(input: Record<string, unknown>, defaultExcludes: readonly string[] = []): string[] | { error: string }`, documented as "`defaultExcludes`: pathspecs appended to an unscoped call (the host's own state, nax#2007); none by default". Line 315 becomes `if (subcommand !== "blame") argv.push(...defaultExcludes);`. Keep the comment above it, but say "the host's own run state" where it says "nax's own run state". In `run`, `const built = buildGitArgv(input, gitExcludePathspecsOf(ctx));` (import from `./protected-paths`).

`src/tools/git-commit.ts`: delete the `NAX_GITIGNORE_ENTRIES` import. The signature becomes `partitionNaxOwnedPaths(root: string, paths: string[], ignorePatterns: readonly string[])`. Line 95 writes `` `${ignorePatterns.join("\n")}\n` ``. Update the doc comment (lines 48-62) to say the patterns are supplied (nax passes `NAX_GITIGNORE_ENTRIES`, the same SSOT `nax init` and `WorktreeManager` use). Line 160: `await partitionNaxOwnedPaths(ctx.root, rawPaths as string[], gitIgnorePatternsOf(ctx))`. The existing `as string[]` stays as it is.

`src/tdd/red-commit.ts`: add `import { NAX_GITIGNORE_ENTRIES } from "../utils/gitignore";`, and line 77 calls `deps.partitionNaxOwnedPaths(gitRoot, files, NAX_GITIGNORE_ENTRIES)`. If `deps` is typed `typeof partitionNaxOwnedPaths`, the new parameter flows through; update any test stub of `deps.partitionNaxOwnedPaths` only if typecheck requires it.

`scripts/analyze-rtk-savings.ts`: import `NAX_OWNED_GIT_EXCLUDE_PATHSPECS` from `../src/utils/nax-owned-paths` and pass it as the second argument at lines 54 and 61, so the synthesised argv is byte-identical to today's.

- [ ] **Step 5: The sandbox takes the paths as data**

`src/sandbox/policy-inputs.ts`: delete the `../config/paths` import, and change the two listers:

```ts
export async function listNaxEntries(root: string, stateDir: string): Promise<string[]> {
  try {
    const names = await _policyInputDeps.readdir(join(root, stateDir));
    return names.filter((name) => !SANDBOX_GLOB_CHARS.test(name));
  } catch {
    return [];
  }
}

/** Every `credentials*` file in `dir` (the host's credential dir), expanded to literals (F1: no globs). */
export async function listCredentialFiles(dir: string): Promise<string[]> {
  try {
    const entries = await _policyInputDeps.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.name.startsWith("credentials")).map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}
```

Update `listNaxEntries`' doc comment: "Top-level entry names under `<root>/<stateDir>` right now (nax#2260; `stateDir` is `.nax` for nax)."

`src/agents/coding-tool-sandbox.ts`: delete the `@/trust` import; add `import type { ProtectedPathsPolicy } from "@/tools";`. In `resolveSessionSandbox`'s args add:

```ts
  /** Host-owned paths the policy denies (S1 spec port 6); nax passes `naxProtectedPaths()`. */
  readonly protectedPaths: ProtectedPathsPolicy;
```

Then:
- line 124 becomes `const credentialFiles = await _sessionSandboxDeps.credentialFiles(args.protectedPaths.credentialDir);`
- line 139 becomes `naxEntries: await _sessionSandboxDeps.naxEntries(root, args.protectedPaths.projectStateDir),`
- line 144 becomes `trustStoreFile: args.protectedPaths.trustStoreFile,`. Keep the US-006 comment above it.

`_sessionSandboxDeps.naxEntries` and `.credentialFiles` keep pointing at `listNaxEntries` / `listCredentialFiles`; their types follow.

- [ ] **Step 6: nax supplies the policy**

`src/agents/nax-protected-paths.ts`:

```ts
/**
 * nax's protected-paths policy (S1 spec section 4.2, port 6): the knowledge
 * of which paths nax itself owns stays in nax and reaches the coding tools and
 * the sandbox as data. Built per dispatch so `NAX_GLOBAL_CONFIG_DIR` is read
 * live, as `globalConfigDir()` and `trustStorePath()` always were.
 */
import { globalConfigDir, PROJECT_NAX_DIR } from "@/config";
import type { ProtectedPathsPolicy } from "@/tools";
import { trustStorePath } from "@/trust";
import { NAX_GITIGNORE_ENTRIES } from "@/utils/gitignore";
import { NAX_OWNED_GIT_EXCLUDE_PATHSPECS } from "@/utils/nax-owned-paths";

export function naxProtectedPaths(): ProtectedPathsPolicy {
  return {
    gitExcludePathspecs: NAX_OWNED_GIT_EXCLUDE_PATHSPECS,
    gitIgnorePatterns: NAX_GITIGNORE_ENTRIES,
    projectStateDir: PROJECT_NAX_DIR,
    credentialDir: globalConfigDir(),
    trustStoreFile: trustStorePath(),
  };
}
```

`src/agents/coding-tool-support-resolve.ts`:
- import `naxProtectedPaths` from `./nax-protected-paths`,
- add `protectedPaths: naxProtectedPaths,` to `_codingToolSupportDeps`'s value, and `/** Port 6: the host-owned paths the tools and the sandbox protect. */ protectedPaths: () => ProtectedPathsPolicy;` to its explicit type (Task 3, Step 5). Import `type ProtectedPathsPolicy` from `@/tools`.
- in `resolveDispatchLauncher`'s `resolveSessionSandbox({ ... })` call, add `protectedPaths: _codingToolSupportDeps.protectedPaths(),` (Decision 9: the resolver reads the dep itself; its signature is unchanged),
- in `resolveCodingToolSupport`'s `buildCodingToolSupport({ ... })` call, add `protectedPaths: _codingToolSupportDeps.protectedPaths(),`.

`src/agents/coding-tool-support.ts`: add `protectedPaths?: ProtectedPathsPolicy;` to `buildCodingToolSupport`'s args (doc: `/** Port 6: host-owned paths, placed on every tool context. */`) and pass `protectedPaths: args.protectedPaths,` in the `createCodingToolRuntime({ ... })` literal. It is unconditional; `buildCodingToolSupport` stays at 38.

- [ ] **Step 7: Update the tests whose port was cut**

Run `bun run typecheck`, `bun run test:unit` and `bun run test:integration` (separately, so a unit failure does not hide integration ones), then fix exactly these classes of failure. The final review found every one of these:
- `test/unit/tools/git.test.ts`: change its shared `argvOf()` helper to call `buildGitArgv(input, NAX_OWNED_GIT_EXCLUDE_PATHSPECS)`. The `blame` and explicit-path tests stay meaningful, because skipping the excludes there is the builder's own rule. Its "default view hides nested and root .nax" describe (2 tests, 6 `createCodingToolRuntime({ policy })` calls) passes `protectedPaths: naxProtectedPaths()` in each runtime's options.
- `test/unit/tools/git-commit.test.ts`: add `protectedPaths: naxProtectedPaths()` to its `toolContext()` helper.
- `test/unit/sandbox/policy-inputs.test.ts`: `listNaxEntries(base)` becomes `listNaxEntries(base, ".nax")`, and `listCredentialFiles()` becomes `listCredentialFiles(globalConfigDir())`, read at the same moment the test reads it today.
- `test/helpers/session-sandbox-deps.ts`: the deps interface's `naxEntries(root: string)` becomes `naxEntries(root: string, stateDir: string)`, and `credentialFiles()` becomes `credentialFiles(dir: string)`. The stub bodies ignore the new parameters.
- `test/unit/agents/coding-tool-sandbox.test.ts`: about 30 `resolveSessionSandbox` calls, most built through its `confinedArgs()` and `sharedArgs()` helpers. Put `protectedPaths: naxProtectedPaths()` inside both helpers and in the remaining inline literals. A call site written `{ protectedPaths, ...confinedArgs() }` then trips TS2783 (property specified twice); drop the duplicate. The existing trust-store assertion (`denyWrite` contains `realOrRaw(trustStorePath())`) stays and still passes.
- `test/integration/sandbox/sandbox-live.test.ts` (2 `resolveSessionSandbox` calls): pass `protectedPaths: naxProtectedPaths()`.
- `test/integration/execution/lifecycle/run-tmp-wipe.test.ts`: typechecks again once the `session-sandbox-deps.ts` helper type above is updated; no edit of its own.
- `scripts/probe-c2-story-loop.ts` (a dev probe, not production): it builds `createCodingToolRuntime` with `Git` granted, so pass `protectedPaths: naxProtectedPaths()` to keep its default Git view unchanged.

- [ ] **Step 8: Verify**

Run: `bun test test/unit/agents/ test/unit/tools/ test/unit/sandbox/ test/unit/tdd/ test/unit/scripts/analyze-rtk-savings.test.ts --timeout=60000`
Expected: PASS.

Run: `bun run test && bun run typecheck && bun run check:complexity && bun run check:import-cycles && bun run check:sandbox-imports && bun run check:git-spawn-env`
Expected: green.

Run: `bun scripts/check-agent-boundary.ts --list`
Expected: **0 boundary edge(s)**.

- [ ] **Step 9: Lower the baseline and commit**

```bash
bun run check:agent-boundary:update
bun x biome check --write src/tools src/sandbox/policy-inputs.ts src/agents src/tdd/red-commit.ts scripts/analyze-rtk-savings.ts test
bun run lint
git add -A src scripts/analyze-rtk-savings.ts test scripts/baselines/agent-boundary-baseline.json
git commit -m "refactor: supply nax's protected paths to the tools and sandbox as a policy"
```

---

### Task 6: Re-narrow `stage` inside the stream bus (carried from S1-2)

**Files:**
- Modify: `src/config/permissions.ts:23-32` (add the guard after the union), `src/config/index.ts`, `src/runtime/agent-stream-events.ts`, `src/runtime/index.ts` (barrel re-exports only)
- Modify (port cut): `test/ui/useAgentStreamEvents.test.tsx:37,150`
- Test: `test/unit/runtime/agent-stream-events.test.ts` (append)

**Interfaces:**
- Produces: `isPipelineStage(value: string): value is PipelineStage` (exported through `@/config` next to `PipelineStage`); `type NaxAgentStreamEvent = AgentStreamEvent & { readonly stage?: PipelineStage }`; `narrowStreamStage(event: AgentStreamEvent): NaxAgentStreamEvent`. `AgentStreamListener` takes `NaxAgentStreamEvent`. **`emitAgentStream` keeps its `AgentStreamEvent` parameter** in both `IAgentStreamEventBus` and `AgentStreamEventBus` (Decision 10).

- [ ] **Step 1: Write the failing test**

Append to `test/unit/runtime/agent-stream-events.test.ts` (import `narrowStreamStage` from `@/runtime/agent-stream-events`, and `type AgentStreamEvent` if not already imported):

```ts
describe("narrowStreamStage — nax re-narrows the contract's plain-string stage (S1-2 carried item)", () => {
  const base: AgentStreamEvent = {
    kind: "agent.call_started",
    callId: "c1",
    runId: "r1",
    agentName: "native",
    sessionName: "s1",
    timestamp: 1,
    model: "anthropic/claude-haiku-4-5",
    timeoutSeconds: 60,
  };

  test("an event without a stage passes through as the same object", () => {
    expect<AgentStreamEvent>(narrowStreamStage(base)).toBe(base);
  });

  test("a known pipeline stage passes through as the same object", () => {
    const event: AgentStreamEvent = { ...base, stage: "run" };
    expect<AgentStreamEvent>(narrowStreamStage(event)).toBe(event);
  });

  test("an unknown stage label is dropped, never passed on", () => {
    const narrowed = narrowStreamStage({ ...base, stage: "native-session" });
    expect(narrowed.stage).toBeUndefined();
    expect(narrowed.callId).toBe("c1");
  });

  test("the bus hands listeners the narrowed event", () => {
    const bus = new AgentStreamEventBus();
    const seen: (string | undefined)[] = [];
    bus.onAgentStream((event) => seen.push(event.stage));
    bus.emitAgentStream({ ...base, stage: "native-session" });
    bus.emitAgentStream({ ...base, stage: "review" });
    expect(seen).toEqual([undefined, "review"]);
  });
});
```

`base` is an `AgentCallStartedEvent` (discriminant `kind`; `model` and `timeoutSeconds` are its required fields at `e6d42e890`, `agent-stream-event-types.ts:36-40`). The explicit `expect<AgentStreamEvent>(...)` is required: bun types `toBe`'s argument as the received type, and a plain `expect(narrowStreamStage(base)).toBe(base)` fails typecheck (TS2769). Import `AgentStreamEventBus` from `@/runtime/agent-stream-events` if the file does not already.

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/unit/runtime/agent-stream-events.test.ts --timeout=60000`
Expected: FAIL. `narrowStreamStage` is not exported.

- [ ] **Step 3: The guard**

`src/config/permissions.ts`, directly after the `PipelineStage` union:

```ts
/** Every PipelineStage, as an exhaustive record so a new stage cannot be forgotten here. */
const PIPELINE_STAGES: Record<PipelineStage, true> = {
  plan: true,
  run: true,
  setup: true,
  verify: true,
  review: true,
  rectification: true,
  regression: true,
  acceptance: true,
  complete: true,
};

export function isPipelineStage(value: string): value is PipelineStage {
  return Object.hasOwn(PIPELINE_STAGES, value);
}
```

Export `isPipelineStage` from `src/config/index.ts` next to the existing permissions exports.

- [ ] **Step 4: The narrowed listener type and the narrowing inside the bus**

`src/runtime/agent-stream-events.ts`: add `import { isPipelineStage, type PipelineStage } from "@/config";` (if that closes an import cycle, use `../config/permissions` for both; `check:import-cycles` decides). Then:

```ts
/**
 * A stream event as nax's listeners receive it: the session contract types
 * `stage` as a plain string (S1 spec port 4); the bus re-narrows it to nax's
 * own union before any listener sees it.
 */
export type NaxAgentStreamEvent = AgentStreamEvent & { readonly stage?: PipelineStage };

export type AgentStreamListener = (event: NaxAgentStreamEvent) => void;

function hasNaxStage(event: AgentStreamEvent): event is NaxAgentStreamEvent {
  return event.stage === undefined || isPipelineStage(event.stage);
}

/**
 * Re-narrows `stage`. A known or absent stage passes through as the same
 * object; an unknown label (no producer emits one today) is dropped and logged
 * rather than handed to listeners typed on nax's union.
 */
export function narrowStreamStage(event: AgentStreamEvent): NaxAgentStreamEvent {
  if (hasNaxStage(event)) return event;
  getSafeLogger()?.debug("agent-stream-bus", "dropped an unknown stage label", {
    storyId: event.storyId,
    stage: event.stage,
  });
  return { ...event, stage: undefined };
}
```

`IAgentStreamEventBus.emitAgentStream(event: AgentStreamEvent)` is **unchanged**. In `AgentStreamEventBus.emitAgentStream`, add `const narrowed = narrowStreamStage(event);` before the loop and call `listener(narrowed)` instead of `listener(event)`. The final review confirmed `{ ...event, stage: undefined }` typechecks for the union.

`src/runtime/index.ts`: add `NaxAgentStreamEvent` (type) and `narrowStreamStage` to its re-exports from `./agent-stream-events`. The `onStreamActivity` emit site is **not** changed; the bus narrows on entry.

- [ ] **Step 5: Fix the one fixture with an invented stage**

`test/ui/useAgentStreamEvents.test.tsx` emits `stage: "execution"`, which is not a `PipelineStage`. The fixture is typed as `AgentStreamEvent`, so it compiles, but the bus now drops the label at runtime (`Expected "stage:execution", Received "stage:none"`). Change the fixture (line 37) to `stage: "run"` and the matching assertion (line 150) to `"stage:run"`. The label was invented, and no producer emits `"execution"` on the stream bus. Name the change in the PR body.

- [ ] **Step 6: Verify**

Run: `bun test test/unit/runtime/ test/unit/tui/ test/ui/ --timeout=60000`
Expected: PASS.

Run: `bun run typecheck && bun run check:complexity && bun run check:import-cycles`
Expected: green. Test call sites that emit plain `AgentStreamEvent`s keep compiling, because `emitAgentStream` still accepts the contract type.

- [ ] **Step 7: Commit**

```bash
bun x biome check --write src/config/permissions.ts src/config/index.ts src/runtime/agent-stream-events.ts src/runtime/index.ts test/unit/runtime/agent-stream-events.test.ts test/ui/useAgentStreamEvents.test.tsx
bun run lint
git add -A src/config/permissions.ts src/config/index.ts src/runtime test/unit/runtime/agent-stream-events.test.ts test/ui/useAgentStreamEvents.test.tsx
git commit -m "refactor: re-narrow stream event stage inside nax's bus"
```

---

### Task 7: Close-out — ratchet at zero, full verification, PR text

**Files:**
- No source changes expected.

- [ ] **Step 1: The ratchet reads zero**

Run: `bun scripts/check-agent-boundary.ts --list`
Expected: `0 boundary edge(s)`, and `scripts/baselines/agent-boundary-baseline.json` records 0. If any edge remains, stop and report it. Per the spec it becomes an S1-4b PR and never part of the move.

- [ ] **Step 2: Full verification**

```bash
cd packages/nax
bun run test
bun run typecheck
bun run lint
bun run test:coverage
cd ../..
bun run check:all
```

Expected: all green. `test:coverage` is the per-file floor CI runs. The new source files carry tests (`nax-protected-paths.ts`, `config/native-agent`); `catalog-overrides.ts` and `tools/protected-paths.ts`' interface are type-only.

- [ ] **Step 3: Behaviour-neutrality spot checks**

```bash
grep -rn "_gitToolDeps\|_bashToolDeps.interceptor" src test scripts   # no output
grep -rn "import.*runQualityCommand" src/tools src/agents/coding-tool-*.ts    # only coding-tool-support-resolve.ts
grep -rn "@/trust\|utils/gitignore\|utils/nax-owned-paths\|config/paths" src/tools src/sandbox src/agents/coding-tool-sandbox.ts   # no output
```

- [ ] **Step 4: Draft the PR body (do not push)**

Put the PR body in the final report (not in the repo), following #2321's shape:
- **Summary**: ports 1, 4, 5 (activity mapping), 6 and 7 cut in place, the carried `stage` item, ratchet 20 -> 0.
- **Spec corrections**: Decisions 6 and 7, each with its reason.
- **Not in this PR**: Decision 8 (`nax-owned-writes.ts` `.nax` knowledge), deferred to S3 by the maintainer's ruling.
- **Tests re-pointed because their subject moved or port was cut**: list each file from Tasks 2-6 with one line on why.
- **Behaviour notes**: Decision 9 (trust-store path evaluated per dispatch; `resolveDispatchLauncher` now computes `naxProtectedPaths()` even when the sandbox is disabled and returns early, which is pure path computation with no output change), Decision 10 (unknown stage labels dropped inside the bus; none produced today; the one invented fixture label `"execution"` in `test/ui/useAgentStreamEvents.test.tsx` changed to `"run"`), and the old process-global interceptor surviving across runtimes in one process, which no longer happens.
- **Next**: S1-5 (the scripted move) may start; the ratchet reads 0.

- [ ] **Step 5: Stop**

Report to the user: the commits, the final ratchet count, the verification output and the PR body. **Push and open the PR only after the user approves.**
