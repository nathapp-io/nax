# S1 — Carve out `nax-agent` (design)

- **Arc:** nax-agent. This is sub-project S1 of 7 (S0-S6).
- **Arc SSOT:** the nax-agent master plan, kept in the maintainer's workspace (not in this repo). It holds the arc decisions and all status. This spec holds S1's design only.
- **Date:** 2026-10-01.
- **Base:** `main` @ `fff826752` (S0 complete).
- **Inputs:** the boundary inventory below was measured on the base commit by scanning every non-test `.ts` import in `packages/nax/src`.

## 1. Goal

Create `packages/nax-agent` (`@nathapp/nax-agent`) holding nax's native coding agent: the session contract, the native loop, tools, permissions, sandbox and command-safety. nax consumes it through `workspace:*`.

**Done means:**
- nax-agent imports only `@nathapp/nax-ai`, `node:*`, its own declared dependencies and itself. nax-ai imports neither other package.
- `nax run` behaves exactly as before. Every PR is behaviour-neutral and leaves `main` green and releasable.

**Out of scope:** Node compatibility, the `tsc` build and publishing (S2); the conversational session API (S3); the ACP client, catalog lookup, rate-card policy and `CATALOG_VERSION` (S4); any new behaviour or public API.

## 2. Rulings (from the S1 brainstorm, 2026-10-01)

| # | Ruling |
|---|---|
| R1 | **nax-agent owns the session contract.** `session-types.ts`, the session subset of `AgentAdapter`, and the `InteractionHandler` types move in; `NativeAgentAdapter` moves with them. nax-specific fields become generic (role and protocol ids are opaque). nax keeps `AgentRunOptions`, `complete()` and the agent manager. Reason: S4 moves the ACP adapter, which implements the same contract, into nax-agent too. |
| R2 | **Errors move down; the logger is a slot.** `NaxError` and `errorMessage` move into nax-agent and nax's `src/errors.ts` re-exports the same class, so the 27 `instanceof NaxError` checks in nax keep matching. nax-agent declares a minimal `AgentLogger` (`error/warn/info/debug(stage, msg, data?)`) and one module-level slot (`setAgentLogger`); its `getSafeLogger()` returns `null` when unset, as today. nax fills the slot from `initLogger`. |
| R3 | **One usage and pricing vocabulary: nax-ai's.** `TokenUsage`, `Pricing`, `PricingRates` and `PricingTier` from nax-ai are the only usage and rate types in the repo. nax's `TokenUsage`, `TokenPricing`, `TokenPricingTier` and `ResolvedRates` are deleted. Mapping happens only at edges whose shape is fixed externally (§5.1). |
| R4 | **The pricing math lives in nax-agent**, written over the R3 types. Reasons: it changed in 10 commits since 2026-07-01 against 1 for nax-ai's usage and pricing types, and nax pins nax-ai exactly, so math in nax-ai would put a nax-ai release in front of most nax releases; nax-ai documents that it computes no cost. |
| R5 | **Shared helpers move down; mixed files split first.** A generic helper used by both nax and the candidate set moves into nax-agent and has one implementation. nax reaches it through the subpath export `@nathapp/nax-agent/internal`, documented as not covered by semver. A file mixing generic and nax-specific code is split in place before the move. nax-specific knowledge never moves; it is injected (§4, port 6). |

## 3. Boundary inventory (base commit)

**Candidate set:** `src/agents/native`, `src/tools`, `src/permissions`, `src/sandbox`, `src/command-safety`, `src/agents/coding-tool-{bash,extras,sandbox,support}.ts`, `src/agents/universal-coding-tools.ts`: about 142 files and 21.9k lines, with 188 test files. `src/agents/tool-preamble.ts` was listed in earlier inventories; it is prompt glue (`prompts/sections`, `acp/adapter-output`) and **stays in nax**.

**Outbound edges** (candidate file → non-candidate module; the number is importing candidate files):

| Group | Targets |
|---|---|
| Infra | `logger` (31), `errors` (19), `utils/errors` (12) |
| Contract | `agents/session-types` (10), `agents/types` (2), `agents/turn-deadline` (2), `agents/index` (1), `context/engine` types (4: `ToolDescriptor`, `JSONSchema`, `AdapterFailure`), `runtime/agent-stream-events` (1), `runtime/index` (1) |
| Cost | `agents/cost` (7: `TokenUsage`, `ResolvedRates`, `priceCall`, `inputClassTokens`), `agents/model-spec` (1) |
| Config | `config/bash-approval` (6), `config/schemas-sandbox` (6), `config/index` (6: `globalConfigDir`, `readGlobalAuthConfig`, `AuthConfig`, `loadConfigForPackage`, `NATIVE_AGENT_NAME`), `config/schema-types` (4), `config/permissions` (3), `config/selectors` (1), `config/paths` (1) |
| Runtime | `runtime/spin-breaker` (5) |
| Orchestrator | `execution/command-interceptor` (2), `quality/runner` + `quality/command-spec` + `quality/index` (4), `verification/shell-quote` (1), `trust` (1), `agents/coding-tool-support-resolve` (1) |
| nax-owned paths | `utils/nax-owned-paths` (1), `utils/gitignore` (1) |
| Generic utils | `realpath` (8), `argv-exec` (5), `git` (4), `bounded-io`, `agent-output-env`, `exec-framing`, `describe-value-type`, `sort`, `path-file-lock` (2 each), `bun-deps`, `git-add`, `thenable` (1 each) |

**Inbound edges** go almost entirely through barrels: `tools/index.ts` (16 importers), `permissions/index.ts` (10), `agents/native/index.ts` (9), `command-safety/index.ts` (4), `sandbox/index.ts` (4), plus `loop-events`, `compaction`, `turn-retry`, `coding-tool-support`.

**Files at the 600-line source limit:** `agents/types.ts` (600) and `agents/native/adapter.ts` (599). No PR may grow either; S1-1 and S1-2 shrink them.

## 4. Package shape and ports

### 4.1 Layout

```
packages/nax-agent/
  package.json        "@nathapp/nax-agent"; exports "." and "./internal"; deps: @nathapp/nax-ai (exact pin), @anthropic-ai/sandbox-runtime
  tsconfig.json       Bun types for now (S2 moves to a tsc Node build)
  biome.json          {"root": false}
  src/
    session/          contract (R1): SessionHandle, OpenSessionOpts, SendTurnOpts, TurnResult,
                      InteractionExchange, InvalidToolCallDetail, SessionTurnError, AuthStamp,
                      AgentSessionAdapter (session subset of AgentAdapter), InteractionHandler types,
                      ToolDescriptor, JSONSchema, AdapterFailure, ProtocolIds, SessionModel, turn-deadline
    native/           today's src/agents/native
    tools/ permissions/ sandbox/ command-safety/
    coding-tools/     coding-tool-{bash,extras,sandbox,support}.ts, universal-coding-tools.ts
    command-interceptor/
    cost/             pricing math (R4) + parseModelSpec
    config/           zod leaf schemas: BashApprovalMode, SandboxConfig, SANDBOX_GLOB_CHARS, ProviderCatalogOverride
    infra/            NaxError, errorMessage, AgentLogger slot, spin-breaker
    internal/         generic helpers moved down (R5)
    index.ts          public entry
    internal.ts       "@nathapp/nax-agent/internal" (not semver-covered)
  test/               moved tests + test/helpers
```

`package.json` sets `"private": false` but nothing publishes it before S2. nax declares `"@nathapp/nax-agent": "workspace:*"`; nothing reads a version from that spec, so the S0 exact-pin trap does not apply. nax-agent pins nax-ai exactly, like nax. `dist/nax.js` **bundles** nax-agent (it is not added to `--external`), so the global-install layout and `GIT_COMMIT` stamping are unchanged.

`.nax/mono/packages/nax-agent/` gets its own config following the S0 pattern. Rules that apply to moved code gain `packages/nax-agent/` paths.

### 4.2 Ports and cuts

Each is cut in place before the move (§6). The default reproduces today's behaviour exactly, nax supplies every port in production from one place, and nax-agent's unit tests use stubs.

| # | Coupling | Cut |
|---|---|---|
| 1 | `coding-tool-support.ts` still calls `loadConfigForPackage` and `resolvePermissions` | Both calls move to `coding-tool-support-resolve.ts` (stays in nax). `buildCodingToolSupport` takes resolved arguments only. |
| 2 | Contract depends on nax config, context engine and runtime types | R1. `SessionHandle.role` becomes `string` (nax keeps `CanonicalSessionRole`). `ModelDef` is narrowed to a package-owned `SessionModel` (`model`, `pricing?: Pricing`, `contextWindow?`, and the other fields the native adapter reads) to which nax's `ModelDef` is assignable. `ResolvedPermissions` becomes a package-owned type in `permissions/`; nax's config resolver produces it. `ToolDescriptor`, `JSONSchema`, `AdapterFailure` and `ProtocolIds` move next to the contract; the context engine and runtime import them. |
| 3 | Tool dispatch goes through `onInteraction` | The `InteractionHandler` and request types move with the contract. The composer (`agents/run-interaction-handler.ts`) stays in nax. No runtime change. |
| 4 | Config leaf types | `config/bash-approval.ts` and `config/schemas-sandbox.ts` (zod-only) and `ProviderCatalogOverride` move into `nax-agent/config`; nax's schemas import them. `PipelineStage` uses in the candidate set become `string`. `tier-providers` declares a local type instead of `Pick<PrecheckConfig, ...>`. `NATIVE_AGENT_NAME` moves into `native/` and nax's config imports it. |
| 5 | Infra and runtime | R2 for errors and the logger. `runtime/spin-breaker` (depends only on the logger, `sort`, `strip-control-chars`) moves into `infra/`. `turn-events` emits the package's own `NativeTurnActivity`; the mapping to `AgentStreamEvent` moves into the `onActivity` hook nax supplies, and stays in nax. The `runtime/index` import in `session.ts` is resolved the same way. |
| 6 | nax-owned paths | A `ProtectedPathsPolicy { isProtected(path): boolean; reason(path): string; extraDenyRoots: readonly string[] }` is passed through the coding-tool support options and the sandbox policy inputs. nax builds it from `nax-owned-paths`, `gitignore` (`NAX_GITIGNORE_ENTRIES`), the scratchpad dir, `.nax/`, feature PRDs, credential files, `globalConfigDir`, `PROJECT_NAX_DIR` and `trustStorePath`. |
| 7 | Orchestrator services | `execution/command-interceptor` (273 lines) depends only on `tools/git-flags` and `permissions`, so it **moves in whole**. The **global `_gitToolDeps.interceptor` slot is deleted**: `git` receives the interceptor through its tool context as `bash` already does, and `execution/lifecycle/run-setup.ts:218` passes it there instead of overwriting the global. `tools/run-command.ts` gets a `runDeclaredCommand` port; nax supplies `runQualityCommand` (`quality/runner.ts`, which stays). `QualityCommandSpec` becomes a package-owned type nax's spec satisfies. `verification/shell-quote.ts` (4 lines) moves to `internal/`. |
| 8 | Credentials | `native/credentials` reads `~/.nax` via `globalConfigDir` and `readGlobalAuthConfig`. A `configureCredentials({ dir, authConfig })` slot follows R2's pattern: set once per process, then memoised as today. nax calls it at startup. If unset, the first credential read throws `NaxError` with code `CREDENTIALS_NOT_CONFIGURED`; there is no silent `~/.nax` default inside the library. The `nax auth` CLI uses the same configured store. |

### 4.3 Shared helpers (R5)

| Helper | Disposition |
|---|---|
| `bounded-io`, `exec-framing`, `describe-value-type` | Used only by the candidate set: move. |
| `realpath`, `sort`, `path-file-lock` (+ its `file-lock`), `strip-control-chars`, `git-add`, `thenable`, `agent-output-env`, `argv-exec` (+ `process-kill`), `bun-deps`, `shell-quote`, `errors` | Move to `internal/`; nax imports from `@nathapp/nax-agent/internal`. |
| `utils/git.ts` (567 lines, 33 nax importers) | **Split in place first:** generic exec (`gitWithTimeout`, `GIT_TIMEOUT_MS`, `getGitRoot`, `_gitDeps`) into `utils/git-exec.ts`, which moves; story logic (`autoCommitIfDirty`, `hasCommitsForStory`, porcelain and nax-path restore) stays. |
| `nax-owned-paths`, `gitignore` | Stay in nax; reach the candidate set only through port 6. |

The move script computes the closure: any further helper a moved helper imports either moves too or the script fails and names it.

## 5. One usage and pricing vocabulary (R3, R4)

### 5.1 Before and after

| Concept | Today | After S1 |
|---|---|---|
| Usage | nax-ai `TokenUsage {inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens?}`; nax `TokenUsage {…, cacheReadInputTokens?, cacheCreationInputTokens?}` | nax-ai's only |
| Rates | nax-ai `Pricing`/`PricingRates`/`PricingTier` (`input, output, cacheRead, cacheWrite`, per 1M); nax `TokenPricing`/`TokenPricingTier` (`inputPer1M, outputPer1M, cacheReadPer1M?, cacheCreationPer1M?`); nax `ResolvedRates` (same four fields as `PricingRates`, other names) | nax-ai's only |
| Mappers | `toNaxTokenUsage` (`native/models.ts`), the field copy in `buildRateCard` (`native/models.ts`), `toTokenPricing` (`agents/catalog`) | deleted |

**Edges that keep their shape**, each mapped in exactly one place:

| Edge | Shape kept | Mapping |
|---|---|---|
| User config `models.*.pricing` (`TokenPricingSchema`) | `inputPer1M`, `outputPer1M`, `cacheReadPer1M?`, `cacheCreationPer1M?`, `tiers?` | The config loader converts to `Pricing`, filling an absent cache rate with the input rate. That yields the same numbers as today's `?? inputPer1M` fallback in `estimate.ts`. |
| `metrics.json` story tokens (`metrics/types.ts`, `metrics/tracker.ts`) | `cacheReadInputTokens`, `cacheCreationInputTokens` | The metrics serializer maps from the standard type. Field names on disk do not change, so `nax status` and readers of older runs keep working. |
| Cost rows and usage-audit (`runtime/middleware/cost.ts`, `usage-audit.ts`) | `tokens {input, output, cacheRead, cacheWrite}` | Mapping becomes a direct field read. `COST_ROW_SCHEMA_VERSION` is unchanged. |
| ACP wire usage | ACP's own shape | `ITokenUsageMapper` keeps mapping, now to the standard type. |

Zero versus absent is preserved: `toNaxTokenUsage` omits only `undefined`, and nax-ai's mapping keeps zeroes, so the serialized output is identical. nax-ai's types are `readonly`; any in-place mutation of a usage object becomes a copy.

### 5.2 Pricing math

`priceCall`, `estimateCostUsd`, `addTokenUsage` and `inputClassTokens` are rewritten over `TokenUsage` and `Pricing`/`PricingRates` and moved to `nax-agent/cost`. `priceCall` returns `{ costUsd, resolvedRates: PricingRates }`. `parseModelSpec` moves alongside.

**Stays in nax until S4:** `agents/catalog` (`lookupPricing`, `CATALOG_VERSION`) and `agents/cost/rate-card.ts` (alias file, provider inference, fallback card) — both used only by the ACP adapter and `version.ts`. **Stays in nax permanently:** reporting helpers (`formatCostWithConfidence`, `CostEstimate`, `TokenUsageWithConfidence`, `ModelCostRates`, `resolvePricingSource`).

### 5.3 Gate

A check fails if any file outside `packages/nax-ai` declares an interface or type alias named `TokenUsage`, `NativeUsage`, `TokenPricing`, `TokenPricingTier`, `ResolvedRates`, `Pricing`, `PricingRates` or `PricingTier`. The §5.1 edge shapes are not types with those names (the metrics DTO keeps its own name), so the check needs no allow-list.

## 6. Delivery

Small PRs to `main`, each behaviour-neutral, rebased on the latest `main`, merged on green (arc D6). The ratchet from S1-0 must read **0** before S1-5 starts; anything left becomes an extra S1-4b PR, never part of the move.

| PR | Content |
|---|---|
| **S1-0** Boundary ratchet | `scripts/check-agent-boundary.ts` counts candidate-set outbound edges (§3) against `scripts/baselines/agent-boundary-baseline.json`; it fails if the count rises. This spec and the plan land with it. |
| **S1-1** Usage and pricing standard | §5. Shrinks `native/adapter.ts`. Adds the §5.3 gate. |
| **S1-2** Contract decoupling | Ports 2 and 3. The session subset of `AgentAdapter` splits out of `agents/types.ts`, which shrinks. |
| **S1-3** Infra slots and splits | R2 slots (logger, credentials = port 8), the `utils/git` split, spin-breaker dependency clean-up. The candidate set reaches each infra concern through one staging module. |
| **S1-4** Tool-side ports | Ports 1, 4, 5 (activity mapping), 6, 7. |
| **S1-5** Scripted move | `scripts/s1-move.ts`, reviewed with a trial run, then regenerated against the latest `main` and merged the same day. It creates `packages/nax-agent` (§4.1), `git mv`s code and tests, rewrites imports in both packages, rewrites `scripts/check-*` paths, rules `appliesTo`/`paths` and `.nax/mono` config, adds the `workspace:*` dependency, and replaces the ratchet with `check-package-boundaries` (§7). |

## 7. Gates

**New, root `scripts/check-package-boundaries.ts`** (S1-5), run by root `check:all` and CI:
- `packages/nax-agent` imports only `@nathapp/nax-ai`, `node:*`, its declared dependencies and itself; never `@nathapp/nax`, never a relative path leaving the package.
- `packages/nax-ai` imports neither `@nathapp/nax` nor `@nathapp/nax-agent`.
- `packages/nax` imports nax-agent only as `@nathapp/nax-agent` or `@nathapp/nax-agent/internal`.

**Existing package gates that cover moved code:** `check-adapter-no-config-import`, `check-sandbox-imports`, `check-bash-dispatch-ask`, `check-op-tool-capability`, `check-nax-ai-imports`, `check-nax-error`, `check-logger-storyid`, `check-file-sizes`, `check-complexity`, and `check-git-spawn-env` if its scan reaches moved git call sites (the plan verifies). Each either moves into nax-agent's `lint:checks` or widens its scan to `packages/nax-agent`, whichever preserves what it guards; baselines move with their files. `check-nax-ai-imports` is rewritten for the new layout: in nax, only `agents/catalog` may import nax-ai; nax reaches the R3 types through nax-agent's re-export. Scripts that hardcode candidate paths (`analyze-rtk-savings`, `command-safety-eval*`, `probe-native-tool-round-trip`, `check-nax-artifacts-untracked`, `check-worktree-id-ssot`, `check-no-silent-naxconfig-cast`) get their paths rewritten by the move script.

## 8. Tests

**Test helpers.** All candidate tests import helpers through the `@test/helpers` barrel (106 imports). The move script computes which helpers they use. Helpers used only by moved tests move to `packages/nax-agent/test/helpers`. Helpers used by both live once in nax-agent's `test/helpers`, and nax's `tsconfig.test.json` maps a test-only alias `@agent-test/*` to them. They are never part of the package's exports.

**Every PR S1-0..S1-4:** `bun run test`, `typecheck`, `lint` (all checks) and root `check:all` green; the ratchet count falls (S1-0 sets it). No test is edited to pass unless its subject moved. Each new port gets a stub-driven unit test and a test that nax's production wiring supplies it (guards the declared-but-inert class, e.g. the git interceptor reaching the tool context).

**S1-1 additionally:** a golden test runs a fixed table of usage and rate inputs (flat, tiered, missing cache rates, zero and absent cache counts) through the old and new `priceCall` on the branch and requires identical `costUsd` and resolved rates; the old implementation is deleted after the comparison is captured as fixtures. Cost-row and `metrics.json` serialization snapshots stay byte-identical.

**S1-5 additionally:** test count before equals test count after (the script prints both); `bun run build` succeeds with nax-agent bundled; `dist/nax.js` carries `GIT_COMMIT`; the global-install layout is unchanged; `check-package-boundaries` passes with no exceptions.

## 9. Acceptance

1. `check-package-boundaries` green.
2. nax and nax-agent suites green in CI.
3. **Billed smoke, approved at launch:** one `nax run` with the native agent on a fixture copy, before S1-1 (baseline) and after S1-5. Pass: same story outcome; tool-audit ledger shape-identical (same keys and per-tool record shape; counts may differ); cost rows carry the same schema with `catalogVersion` present; `run.start` stamps `naxCommit`.
4. The arc SSOT records the PRs, merge commits and rulings R1-R5.

## 10. S3 contract sketch (constraints S1 must not foreclose)

S3 adds a conversational session API on top of the S1 contract without changing it.

- **One seam for tools, questions and approvals.** `InteractionHandler` stays the loop's only callback. S3's injected embedder tools and approval hook become a second handler composer inside nax-agent; nax's composer is unaffected.
- **Events.** `NativeTurnActivity` and the P3 loop events are package-owned after S1. S3 maps them to text, tool and approval events for embedders, as nax's `onActivity` maps them to its stream bus.
- **Transcript.** `transcriptDir` and `transcriptOwner` are already caller-supplied; S3 replaces the directory with an injected transcript-store port.
- **Known S3 item, not fixed in S1:** process-global maps keyed by session name (`nativeTranscriptDirs`, transcript owners, client memoisation). An embedder running many sessions per process needs these scoped per session object.
- **Slots.** The logger and credentials slots are process-wide in S1. If an embedder needs per-tenant credentials, S3 adds per-session overrides above the slot.
