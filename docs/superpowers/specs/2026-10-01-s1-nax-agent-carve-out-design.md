# S1 — Carve out `nax-agent` (design)

- **Arc:** nax-agent. This is sub-project S1 of 7 (S0-S6).
- **Arc SSOT:** the nax-agent master plan, kept in the maintainer's workspace (not in this repo). It holds the arc decisions and all status. This spec holds S1's design only.
- **Date:** 2026-10-01 (revised the same day after a spec review against the codebase).
- **Base:** `main` @ `fff826752` (S0 complete).
- **Inputs:** the boundary inventory was measured on the base commit by scanning every non-test `.ts` import in `packages/nax/src`.

## 1. Goal

Create `packages/nax-agent` (`@nathapp/nax-agent`) holding nax's native coding agent: the session contract, the native loop, tools, permissions, sandbox and command-safety. nax consumes it inside the workspace and bundles it into `dist/nax.js`.

**Done means:**
- nax-agent imports only `@nathapp/nax-ai`, `node:*`, its own declared dependencies and itself. nax-ai imports neither other package.
- `nax run` behaves exactly as before. Every PR is behaviour-neutral and leaves `main` green and releasable, including `npm i -g @nathapp/nax`.

**Out of scope:** Node compatibility, the `tsc` build and publishing nax-agent (S2); the conversational session API (S3); the ACP client, catalog lookup, rate-card policy and `CATALOG_VERSION` (S4); any new behaviour or public API.

## 2. Rulings (from the S1 brainstorm, 2026-10-01)

| # | Ruling |
|---|---|
| R1 | **nax-agent owns the session contract.** `session-types.ts`, the session subset of `AgentAdapter`, and the `InteractionHandler` types move in; the native session adapter moves with them. nax-specific fields become generic (role, tier and protocol ids are opaque). nax keeps `AgentRunOptions`, `complete()` and the agent manager. Reason: S4 moves the ACP adapter, which implements the same contract, into nax-agent too. |
| R2 | **Errors move down; the logger is a slot.** `NaxError` and `errorMessage` move into nax-agent and nax's `src/errors.ts` re-exports the same class, so the 27 `instanceof NaxError` checks in nax keep matching. nax-agent declares a minimal `AgentLogger` (`error/warn/info/debug(stage, msg, data?)`) and one module-level slot (`setAgentLogger`); nax fills it from `initLogger`. |
| R3 | **One usage and pricing vocabulary: nax-ai's.** `TokenUsage`, `Pricing`, `PricingRates` and `PricingTier` from nax-ai are the only in-memory usage and rate types in the repo. nax's `TokenUsage`, `TokenPricing`, `TokenPricingTier` and `ResolvedRates` are deleted. Mapping happens only at edges whose shape is fixed externally (§5.1). |
| R4 | **The pricing math lives in nax-agent**, written over the R3 types. Reasons: it changed in 10 commits since 2026-07-01 against 1 for nax-ai's usage and pricing types, and nax pins nax-ai exactly, so math in nax-ai would put a nax-ai release in front of most nax releases; nax-ai documents that it computes no cost. |
| R5 | **Shared helpers move down; mixed files split first.** A generic helper used by both nax and the candidate set moves into nax-agent and has one implementation. nax reaches it through the subpath export `@nathapp/nax-agent/internal`, documented as not covered by semver. A file mixing generic and nax-specific code is split in place before the move. nax-specific knowledge never moves; it is injected (§4.2, port 6). |

## 3. Boundary inventory (base commit)

**Candidate set:** `src/agents/native`, `src/tools`, `src/permissions`, `src/sandbox`, `src/command-safety`, `src/agents/coding-tool-{bash,extras,sandbox,support}.ts`, `src/agents/universal-coding-tools.ts`: about 140 files and 22.7k lines, with 188 test files. `src/agents/tool-preamble.ts` was listed in earlier inventories; it is prompt glue (`prompts/sections`, `acp/adapter-output`) and **stays in nax**.

The **move set** (§6, the manifest) is the candidate set plus the modules that move down with it: `execution/command-interceptor`, `runtime/spin-breaker`, `agents/session-types.ts`, `agents/interaction-handler.ts`, `agents/turn-deadline.ts`, `agents/model-spec.ts`, the cost core (§5.2), the config leaf schemas (port 4), and the helpers of §4.3.

**Outbound edges** (candidate file → non-candidate module; the number is importing candidate files):

| Group | Targets |
|---|---|
| Infra | `logger` (31, incl. `redactSecrets`, `SECRET_VALUE_PATTERNS` from `logger/redact.ts` and the throwing `getLogger()` in `native/session/transcript-store.ts`), `errors` (19), `utils/errors` (12) |
| Contract | `agents/session-types` (10), `agents/types` (2), `agents/turn-deadline` (2), `agents/index` (1), `context/engine` types (4: `ToolDescriptor`, `JSONSchema`, `AdapterFailure`), `runtime/agent-stream-events` (1), `runtime/index` (1) |
| Cost | `agents/cost` (7: `TokenUsage`, `ResolvedRates`, `priceCall`, `inputClassTokens`), `agents/model-spec` (1) |
| Config | `config/bash-approval` (6), `config/schemas-sandbox` (6), `config/index` (6: `globalConfigDir`, `readGlobalAuthConfig`, `AuthConfig`, `loadConfigForPackage`, `NATIVE_AGENT_NAME`), `config/schema-types` (4), `config/permissions` (3), `config/selectors` (1), `config/paths` (1) |
| Runtime | `runtime/spin-breaker` (5) |
| Orchestrator | `execution/command-interceptor` (2), `quality/runner` + `quality/command-spec` + `quality/index` (4), `verification/shell-quote` (1), `trust` (1), `agents/coding-tool-support-resolve` (1) |
| nax-owned paths | `utils/nax-owned-paths` (1), `utils/gitignore` (1) |
| Generic utils | `realpath` (8), `argv-exec` (5), `git` (4), `bounded-io`, `agent-output-env`, `exec-framing`, `describe-value-type`, `sort`, `path-file-lock` (2 each), `bun-deps`, `git-add`, `thenable` (1 each) |

The contract files that move also reach out: `session-types.ts` imports `config/permissions`, `config/schema` (`ModelDef`, `ModelTier`), `context/engine`, `runtime/protocol-types`, `runtime/session-role`, `agents/cost`, and types `onStreamActivity` with `AgentStreamEvent` (`session-types.ts:113`, mirrored at `types.ts:423`); `interaction-handler.ts` imports `runtime/no-op-interaction-handler`.

**Inbound edges** go mostly through barrels: `tools/index.ts` (16 importers), `permissions/index.ts` (10), `agents/native/index.ts` (10), `command-safety/index.ts` (4), `sandbox/index.ts` (4). nax also reaches deeper modules: `native/models` (`tool-preamble`, `manager-dispatch`), `native/session/loop-events/types` (5 files), `tools/tool-audit`, and candidate global state (`resetSandboxBackend` from `run-cleanup.ts:29,64`, `flushOpenToolAuditSinks` from `runtime/index.ts:533`). 73 non-moving nax test files import candidate modules, including `_*Deps` test seams (`_clientDeps` 12, `_adapterDeps` 6).

**Global slots nax writes into candidate modules:** `_gitToolDeps.interceptor` and `_bashToolDeps.interceptor`, both assigned at `execution/lifecycle/run-setup.ts:218-219`.

**Files at the 600-line source limit:** `agents/types.ts` (600) and `agents/native/adapter.ts` (599). No PR may grow either; S1-2 shrinks both.

## 4. Package shape and ports

### 4.1 Package

```
packages/nax-agent/
  package.json      "@nathapp/nax-agent", "private": true (until S2), "type": "module"
                    exports: "." → ./src/index.ts, "./internal" → ./src/internal.ts
                    imports: "#src/*" → ./src/*.ts
                    dependencies: @nathapp/nax-ai (exact pin), @anthropic-ai/sandbox-runtime, zod
                    scripts: typecheck, lint (biome + lint:checks), test, check:all
  tsconfig.json     Bun types for now (S2 moves to a tsc Node build); no "paths"
  bunfig.toml       test preload, mirroring packages/nax
  src/
    session/          contract (R1): SessionHandle, OpenSessionOpts, SendTurnOpts, TurnResult,
                      InteractionExchange, InvalidToolCallDetail, SessionTurnError, AuthStamp,
                      AgentSessionAdapter (session subset of AgentAdapter), InteractionHandler types +
                      no-op handler, ToolDescriptor, JSONSchema, AdapterFailure, ProtocolIds,
                      AgentStreamEvent, SessionModel, turn-deadline
    native/           today's src/agents/native, minus the AgentAdapter shell (port 2)
    tools/ permissions/ sandbox/ command-safety/
    coding-tools/     coding-tool-{bash,extras,sandbox,support}.ts (without resolveCodingToolSupport), universal-coding-tools.ts
    command-interceptor/
    cost/             pricing math (R4) + parseModelSpec
    config/           zod leaf schemas: BashApprovalMode, SandboxConfig, SANDBOX_GLOB_CHARS, ProviderCatalogOverride; NATIVE_AGENT_NAME
    infra/            NaxError, errorMessage, AgentLogger slot, credentials slot, spin-breaker
    internal/         generic helpers moved down (R5), incl. logger/redact.ts
    index.ts          public entry
    internal.ts       "@nathapp/nax-agent/internal" (not semver-covered; also carries NaxError and the _*Deps test seams)
  test/               moved tests + test/helpers
```

**Imports inside nax-agent** use the package-scoped subpath alias `#src/*`, never `@/`. The move script rewrites `@/x` to `#src/x` in moved files. Checked on the base toolchain (TypeScript 7.0.2, Bun 1.4.0) with a two-package reproduction: nax's `tsc` resolves `#src/*` inside nax-agent source relative to nax-agent's own `package.json` while nax's own `@/*` paths keep working; `bun run` and `bun build` resolve and bundle it. `@/` would not work: nax's `tsc` resolves `@/` in nax-agent files through nax's `paths` (`TS2307`), and relative `../../` imports are banned by `noRestrictedImports`.

**Dependency and publishing.**
- nax lists `"@nathapp/nax-agent": "workspace:*"` under **`devDependencies`**. npm does not rewrite `workspace:*`, and nax-agent is not published in S1, so it must not appear in nax's published `dependencies`.
- nax-agent is bundled into `dist/nax.js` (not added to `--external`). Its own externals stay external and stay in nax's `dependencies`: `@nathapp/nax-ai` (exact pin, unchanged) and `@anthropic-ai/sandbox-runtime`. `zod` stays in nax's `dependencies` too.
- `check-bundle-externals` is extended to assert this layout: no `workspace:` spec in nax's `dependencies`, and every external import of nax-agent is either bundled or declared in nax's `dependencies`.
- `check-nax-ai-pin` is extended to nax-agent's exact pin.
- The global-install layout and `GIT_COMMIT` stamping are unchanged.

**Lint.** The rules common to both packages (`noConsole`, `noRestrictedImports`, the grit plugins, the complexity cap) are hoisted into the root `biome.json`, so nax-agent's `{"root": false}` config gets the same rule set as nax. Package configs keep only package-specific settings.

**CI and nax config.** nax-agent gets a CI job mirroring nax's (`typecheck`, `lint`, `test`, coverage gate) and `.nax/mono/packages/nax-agent/` config following the S0 pattern. Root `check:all` reaches it because nax-agent defines `check:all`. Rules that apply to moved code gain `packages/nax-agent/` paths.

### 4.2 Ports and cuts

Each is cut in place before the move (§6). The default reproduces today's behaviour exactly, nax supplies every port in production from one place, and nax-agent's unit tests use stubs.

| # | Coupling | Cut |
|---|---|---|
| 1 | `coding-tool-support.ts` mixes config with assembly | `resolveCodingToolSupport(options: AgentRunOptions)` (`coding-tool-support.ts:319`, called from `runtime/session-run-hop.ts:66` and `operations/build-hop-callback-hop.ts:285`) and its `loadConfigForPackage` / `resolvePermissions` calls move to `coding-tool-support-resolve.ts`, which stays in nax. `buildCodingToolSupport` takes resolved arguments only. |
| 2 | Contract depends on nax types; `NativeAgentAdapter` implements nax's full `AgentAdapter` | R1. `SessionHandle.role` and `modelTier` become `string` (nax keeps `CanonicalSessionRole` and `ModelTier`). A package-owned `SessionModel` (`model`, `pricing?: Pricing`, `contextWindow?`, and the other fields the native session reads) replaces `ModelDef` in the contract; **nax builds it from `ModelDef` with one mapping function at the point it opens a session**, which is also where config pricing is converted (§5.1). `ResolvedPermissions` becomes a package-owned type in `permissions/`; nax's resolver produces it. `ToolDescriptor`, `JSONSchema`, `AdapterFailure`, `ProtocolIds` and `AgentStreamEvent` move next to the contract; context engine and runtime import them. **The adapter is split:** nax-agent exports a `NativeSessionAdapter` implementing `AgentSessionAdapter` (`openSession`, `sendTurn`, `closeSession`, credential probe) and a `nativeComplete()` function over package-owned options. nax keeps a thin `NativeAgentAdapter` class implementing the full `AgentAdapter` (`name`, `displayName`, `binary`, `capabilities`, `buildCommand`, `isInstalled`, and `complete()` mapping `ResolvedCompleteOptions`/`CompleteResult`) by composing them. This shrinks `native/adapter.ts`. |
| 3 | Tool dispatch goes through `onInteraction` | The `InteractionHandler` and request types and the no-op handler move with the contract. The composer (`agents/run-interaction-handler.ts`) stays in nax. No runtime change. |
| 4 | Config leaf types | `config/bash-approval.ts`, `config/schemas-sandbox.ts` (zod-only) and `ProviderCatalogOverride` move into `nax-agent/config`; nax's schemas import them. `PipelineStage` uses in the candidate set become `string`. `tier-providers` declares a local type instead of `Pick<PrecheckConfig, ...>`. `NATIVE_AGENT_NAME` moves into `nax-agent/config` and nax's config imports it. |
| 5 | Infra and runtime | R2 for errors and the logger. The slot offers both of today's semantics: `getSafeLogger()` returns `null` when unset; `getLogger()` throws when unset, as nax's does, for the `transcript-store.ts` call sites. `logger/redact.ts` (`redactSecrets`, `SECRET_VALUE_PATTERNS`) moves to `internal/`; nax's logger imports it. `runtime/spin-breaker` moves into `infra/`. The candidate set emits package-owned activity events; the mapping to nax's stream bus moves into the `onActivity` hook nax supplies and stays in nax. The `runtime/index` import in `session.ts` is resolved the same way. |
| 6 | nax-owned paths | A `ProtectedPathsPolicy` is passed through the coding-tool support options and the sandbox policy inputs: `{ isProtected(path): boolean; reason(path): string; extraDenyRoots: readonly string[]; gitExcludePathspecs: readonly string[]; gitIgnorePatterns: readonly string[] }`. `tools/git.ts:315` reads `gitExcludePathspecs`; `tools/git-commit.ts:95` reads `gitIgnorePatterns`. nax builds the policy from `utils/nax-owned-paths` (`NAX_OWNED_GIT_EXCLUDE_PATHSPECS`), `utils/gitignore` (`NAX_GITIGNORE_ENTRIES`), the nax file knowledge now hardcoded in `tools/nax-owned-writes.ts` (config, hooks, feature `prd.json`; that knowledge moves to nax and the tool keeps only the check), the scratchpad dir, `.nax/`, feature PRDs, credential files, `globalConfigDir`, `PROJECT_NAX_DIR` and `trustStorePath`. |
| 7 | Orchestrator services and global interceptor slots | `execution/command-interceptor` (273 lines) depends only on `tools/git-flags` and `permissions`, so it **moves in whole**. **Both global slots are deleted**: `_gitToolDeps.interceptor` and `_bashToolDeps.interceptor` (`run-setup.ts:218-219`; read at `tools/git.ts:380`, `tools/bash.ts:89-91,265`). The run-scoped interceptor travels as data: `setupRun` stores it on the run's runtime; the two `resolveCodingToolSupport` callers (port 1) copy it into the resolved arguments; `buildCodingToolSupport` places it in the tool context that `bash` and `git` read. `tools/run-command.ts` gets a `runDeclaredCommand` port; nax supplies `runQualityCommand` (`quality/runner.ts`, which stays). `QualityCommandSpec` becomes a package-owned type nax's spec satisfies. `verification/shell-quote.ts` (4 lines) moves to `internal/`. |
| 8 | Credentials | `native/credentials` reads `~/.nax` via `globalConfigDir` and `readGlobalAuthConfig`. A `configureCredentials({ dir, authConfig })` slot follows R2's pattern: set once per process, then memoised as today. nax calls it **once in the CLI bootstrap (`bin/nax.ts`) before command dispatch**, which covers `run`, `plan`, `auth` and every other subcommand; scripts that read credentials (`scripts/probe-*`) call it explicitly. If unset, the first credential read throws `NaxError` with code `CREDENTIALS_NOT_CONFIGURED`; there is no silent `~/.nax` default inside the library. |

### 4.3 Shared helpers (R5)

| Helper | Disposition |
|---|---|
| `bounded-io`, `exec-framing`, `describe-value-type` | Used only by the candidate set: move. |
| `realpath`, `sort`, `path-file-lock` (+ `file-lock`, `process-alive`), `strip-control-chars`, `git-add`, `thenable`, `agent-output-env`, `argv-exec` (+ `process-kill`), `bun-deps`, `shell-quote`, `git-env`, `logger/redact` | Move to `internal/`; nax imports from `@nathapp/nax-agent/internal`. |
| `errors` (`errorMessage`), `NaxError` | Move to `infra/`, exported through `/internal` (not the `.` barrel, so loading `NaxError` does not load the whole agent). nax's `src/errors.ts` re-exports `NaxError`. |
| `utils/git.ts` (567 lines, 39 nax importers) | **Split in place first:** generic exec (`gitWithTimeout`, `GIT_TIMEOUT_MS`, `getGitRoot`) into `utils/git-exec.ts`, which moves; story logic (`autoCommitIfDirty`, `hasCommitsForStory`, porcelain, nax-path restore) stays. The `_gitDeps` seam object (`git.ts:44-49`) is used by both halves and patched by 35 test files; it is **defined once in `git-exec.ts`** and `utils/git.ts` re-exports the same object, so existing patches keep affecting both halves. |
| `nax-owned-paths`, `gitignore` | Stay in nax; reach the candidate set only through port 6. |

The move script computes the closure: any further helper a moved helper imports either moves too or the script fails and names it.

### 4.4 Public surface

`.` exports the contract (`session/`), the native session adapter and `nativeComplete`, the tool, permission, sandbox and command-safety barrels, the cost core, the slots (`setAgentLogger`, `configureCredentials`) and the lifecycle functions nax calls (`resetSandboxBackend`, `flushOpenToolAuditSinks`). `/internal` exports the §4.3 helpers, `NaxError`, the deep modules nax uses (`native/models`, `loop-events/types`, `tools/tool-audit`) and the `_*Deps` test seams. Because `/internal` re-exports the same module instances, a nax test that patches a seam still patches the object the code reads. The move script computes every symbol nax imports from the move set and fails if one is exported by neither entry.

## 5. One usage and pricing vocabulary (R3, R4)

### 5.1 Before and after

| Concept | Today | After S1 |
|---|---|---|
| Usage | nax-ai `TokenUsage {inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens?}`; nax `TokenUsage {…, cacheReadInputTokens?, cacheCreationInputTokens?}` | nax-ai's only |
| Rates | nax-ai `Pricing`/`PricingRates`/`PricingTier` (`input, output, cacheRead, cacheWrite`, per 1M); nax `TokenPricing`/`TokenPricingTier` (`inputPer1M, outputPer1M, cacheReadPer1M?, cacheCreationPer1M?`); nax `ResolvedRates` (same four fields as `PricingRates`, other names) | nax-ai's only |
| Mappers | `toNaxTokenUsage` (`native/models.ts:123`), the field copy in `buildRateCard` (`native/models.ts:201`), `toTokenPricing` (`agents/catalog`) | deleted |

**In-memory consumers renamed to the standard** (not exhaustive; S1-1 renames every use): `agents/cost/*`, `native/session/{rate-provenance,turn-accumulator,turn-types}.ts`, `agents/{types,session-types}.ts`, `runtime/{cost-aggregator,dispatch-events}.ts`, `agents/manager-dispatch.ts`, `execution/{types,post-run}.ts`, `execution/lifecycle/post-run-scratch-entries.ts`, `pipeline/stages/execution.ts`, `tdd/types.ts`, `session/session-runner.ts`, `plugins/builtin/curator/collect.ts`, `agents/acp/*`, `agents/cost/rate-card.ts` (`FALLBACK_RATES` gains explicit cache rates equal to its input rate, which is what `priceCall` resolves today).

**Edges that keep their shape**, each mapped in exactly one place:

| Edge | Shape kept | Mapping |
|---|---|---|
| User config `models.*.pricing` (`TokenPricingSchema`, `ModelDef.pricing`) | `inputPer1M`, `outputPer1M`, `cacheReadPer1M?`, `cacheCreationPer1M?`, `tiers?` | The config type stays as it is but is renamed `ConfigPricing` (zod-inferred), so `nax config` output is unchanged. One function, `toPricing(configPricing)`, converts it where nax builds `SessionModel` (port 2) and where the ACP path resolves rates. An absent cache rate is filled with the input rate **of the same level**: base rates from the base input rate, each tier from its own input rate. That reproduces today's fallback (`estimate.ts:95-103`). |
| Cost row `tokens` (`runtime/middleware/cost.ts`, `usage-audit.ts`) | `{input, output, cacheRead, cacheWrite}` | Mapping becomes a direct field read. |
| Cost row `rates` (`runtime/middleware/cost.ts:227`, from `event.rates`) | `{inputPer1M, outputPer1M, cacheReadPer1M, cacheCreationPer1M}` | The cost-row serializer maps `PricingRates` back to these keys. `COST_ROW_SCHEMA_VERSION` stays 8. |
| `metrics.json` story tokens (`metrics/types.ts`, `metrics/tracker.ts`) | `cacheReadInputTokens`, `cacheCreationInputTokens`; zero values omitted (`metrics/types.ts:47-52`) | The metrics serializer maps from the standard type and keeps omit-zero. The metrics DTO interface and class, today named `TokenUsage` (`metrics/types.ts:12,25`), are renamed `StoryTokenUsage`. |
| `tdd/types.ts` result tokens | omit-zero (`tdd/types.ts:42`) | Kept. |
| ACP wire usage | ACP's own shape | `ITokenUsageMapper` keeps mapping, now to the standard type. |

**Zero versus absent:** producers keep their semantics. Native (`toNaxTokenUsage`, `models.ts:123-130`) and ACP (`token-mapper.ts:21-35`) omit only `undefined`; the metrics and tdd serializers omit zero. Each serializer keeps its rule. nax-ai's types are `readonly`; any in-place mutation of a usage object becomes a copy.

### 5.2 Pricing math

`priceCall`, `estimateCostUsd`, `addTokenUsage` and `inputClassTokens` are rewritten over `TokenUsage` and `Pricing`/`PricingRates` and moved to `nax-agent/cost`. `priceCall` returns `{ costUsd, resolvedRates: PricingRates }`. `parseModelSpec` moves alongside.

**Stays in nax until S4:** `agents/catalog` (`lookupPricing`, `CATALOG_VERSION`) and `agents/cost/rate-card.ts`, both used only by the ACP adapter and `version.ts`. **Stays in nax permanently:** reporting helpers (`formatCostWithConfidence`, `CostEstimate`, `TokenUsageWithConfidence`, `ModelCostRates`, `resolvePricingSource`).

**Staging in S1-1.** `check-nax-ai-imports` allows nax-ai only under `agents/native` and `agents/catalog` (`check-nax-ai-imports.ts:19`). S1-1 adds one staging module in the move set, `src/agents/cost/standard-types.ts`, which re-exports the R3 types from nax-ai, and adds that one file to the gate's allow-list. All nax code imports the R3 types from it. In S1-5 it becomes nax-agent's re-export and the allow-list entry is removed.

### 5.3 Gate

A check fails if any file outside `packages/nax-ai` (and the staging re-export above) declares an interface, type alias or class named `TokenUsage`, `NativeUsage`, `TokenPricing`, `TokenPricingTier`, `ResolvedRates`, `Pricing`, `PricingRates` or `PricingTier`. After the `StoryTokenUsage` and `ConfigPricing` renames, no edge type carries one of those names, so the check needs no allow-list beyond the staging file.

## 6. Delivery

Small PRs to `main`, each behaviour-neutral, rebased on the latest `main`, merged on green (arc D6).

**Manifest.** `packages/nax/scripts/s1-move-manifest.json` lists every file in the move set (§3) with its destination under `packages/nax-agent/src`. The ratchet and the move script both read it, so there is one definition of what moves.

**Ratchet.** `packages/nax/scripts/check-agent-boundary.ts` counts import edges from manifest files to files **not** in the manifest, against `scripts/baselines/agent-boundary-baseline.json`; it fails if the count rises. Edges into modules that move do not count, because they are inside the manifest. The count **must be 0 before S1-5 starts**; anything left becomes an extra S1-4b PR, never part of the move.

| PR | Content |
|---|---|
| **S1-0** Manifest and ratchet | The manifest, the ratchet wired into nax's `lint:checks`, and its baseline. This spec and the implementation plan land with it. |
| **S1-1** Usage and pricing standard | §5, including the staging re-export, the `StoryTokenUsage` and `ConfigPricing` renames, and the §5.3 gate. |
| **S1-2** Contract and adapter split | Ports 2 and 3. The session subset of `AgentAdapter` splits out of `agents/types.ts`; the `NativeAgentAdapter` shell and `complete()` mapping stay in nax. Shrinks `agents/types.ts` and `native/adapter.ts`. |
| **S1-3** Infra slots and splits | R2 slots (logger with both semantics, credentials = port 8 including the `bin/nax.ts` bootstrap call), `logger/redact.ts` relocation, the `utils/git` split with the shared `_gitDeps`, spin-breaker clean-up. |
| **S1-4** Tool-side ports | Ports 1, 4, 5 (activity mapping), 6, 7. |
| **S1-5** Scripted move | `packages/nax/scripts/s1-move.ts`, reviewed with a trial run, then regenerated against the latest `main` and merged the same day. It creates `packages/nax-agent` (§4.1), hoists the common biome rules, `git mv`s manifest files and their tests, rewrites `@/` to `#src/` inside nax-agent and imports in nax to `@nathapp/nax-agent` or `/internal`, rewrites `scripts/check-*` paths, rules `appliesTo`/`paths` and `.nax/mono` config, adds the CI job and the `devDependencies` entry, removes the staging allow-list entry, and replaces the ratchet with `check-package-boundaries` (§7). |

## 7. Gates

**New: `packages/nax/scripts/check-package-boundaries.ts`** (S1-5), following `check-nax-ai-pin.ts` (it locates the repo root and scans all packages), wired into nax's `lint:checks` so CI and root `check:all` run it:
- `packages/nax-agent` imports only `@nathapp/nax-ai`, `node:*`, its declared dependencies, `#src/*` and itself; never `@nathapp/nax`, never `@/`, never a relative path leaving the package.
- `packages/nax-ai` imports neither `@nathapp/nax` nor `@nathapp/nax-agent`.
- `packages/nax` imports nax-agent only as `@nathapp/nax-agent` or `@nathapp/nax-agent/internal`.

**Existing package gates that cover moved code:** `check-adapter-no-config-import`, `check-sandbox-imports`, `check-bash-dispatch-ask`, `check-op-tool-capability`, `check-nax-ai-imports`, `check-nax-error`, `check-logger-storyid`, `check-file-sizes`, `check-complexity`, `check-coverage`, and `check-git-spawn-env` if its scan reaches moved git call sites (the plan verifies). Each either moves into nax-agent's `lint:checks` or widens its scan to `packages/nax-agent`, whichever preserves what it guards; baselines move with their files. `check-nax-ai-imports` is rewritten for the new layout: in nax, only `agents/catalog` may import nax-ai; nax reaches the R3 types through nax-agent's re-export. Scripts that hardcode candidate paths (`analyze-rtk-savings`, `command-safety-eval*`, `probe-native-tool-round-trip`, `check-worktree-id-ssot`, and the gates above) get their paths rewritten by the move script.

## 8. Tests

**Test helpers.** All candidate tests import helpers through the `@test/helpers` barrel (106 imports). The move script computes which helpers they use.
- Helpers used only by moved tests and free of nax imports move to `packages/nax-agent/test/helpers`.
- Helpers used by both packages and free of nax imports live once in nax-agent's `test/helpers`; nax's `tsconfig.test.json` maps a test-only alias `@agent-test/*` to them. They are never part of the package's exports.
- Helpers that depend on nax (`makeNaxConfig` via `mock-nax-config.ts`, `makeAgentAdapter`, nax's `makeLogger`) cannot move. A moved test that needs one is either rewritten in the PR that cut its port (it then builds resolved arguments or a stub `AgentLogger` instead of a `NaxConfig`) or stays in nax as a wiring test. The plan lists each such test and its disposition.

**nax tests that patch candidate seams** (73 files) switch their imports to `@nathapp/nax-agent/internal`, which exports the same seam objects (§4.4).

**Every PR S1-0..S1-4:** `bun run test`, `typecheck`, `lint` (all checks) and root `check:all` green; the ratchet count falls (S1-0 sets it). No test is edited to pass unless its subject moved or its port was cut. Each new port gets a stub-driven unit test and a test that nax's production wiring supplies it. That guards the declared-but-inert class, e.g. the interceptor reaching both the `bash` and `git` tool contexts through the support arguments.

**S1-1 additionally:** a golden test runs a fixed table of usage and rate inputs (flat, tiered, missing cache rates at base and tier level, zero and absent cache counts) through the old and new `priceCall` on the branch and requires identical `costUsd` and resolved rates; the old implementation is deleted after the comparison is captured as fixtures. Cost-row (`tokens` and `rates`) and `metrics.json` serialization snapshots stay byte-identical.

**S1-5 additionally:** test count before equals test count after (the script prints both); `bun run build` succeeds with nax-agent bundled; `dist/nax.js` carries `GIT_COMMIT`; `npm pack --dry-run` in `packages/nax` shows no `workspace:` spec in `dependencies`; the global-install layout is unchanged; `check-package-boundaries` passes with no exceptions.

## 9. Acceptance

1. `check-package-boundaries` green.
2. nax and nax-agent suites green in CI, each in its own job.
3. **Billed smoke, approved at launch:** one `nax run` with the native agent on a fixture copy, before S1-1 (baseline) and after S1-5. Pass: same story outcome; tool-audit ledger shape-identical (same keys and per-tool record shape; counts may differ); cost rows carry the same schema with `catalogVersion` present; `run.start` stamps `naxCommit`.
4. The arc SSOT records the PRs, merge commits and rulings R1-R5.

## 10. S3 contract sketch (constraints S1 must not foreclose)

S3 adds a conversational session API on top of the S1 contract without changing it.

- **One seam for tools, questions and approvals.** `InteractionHandler` stays the loop's only callback. S3's injected embedder tools and approval hook become a second handler composer inside nax-agent; nax's composer is unaffected.
- **Events.** Activity events and the P3 loop events are package-owned after S1. S3 maps them to text, tool and approval events for embedders, as nax's `onActivity` maps them to its stream bus.
- **Transcript.** `transcriptDir` and `transcriptOwner` are already caller-supplied; S3 replaces the directory with an injected transcript-store port.
- **Known S3 item, not fixed in S1:** process-global maps keyed by session name (`nativeTranscriptDirs`, transcript owners, client memoisation). An embedder running many sessions per process needs these scoped per session object.
- **Slots.** The logger and credentials slots are process-wide in S1. If an embedder needs per-tenant credentials, S3 adds per-session overrides above the slot.
