# SPEC: model aliases: `@name` references to `agent.modelAliases` in config model positions, kept separate from tiers

Closes: #2977

## Summary

A config can name a model id once, in the existing `agent.modelAliases` map, and refer to it anywhere a model id goes with an explicit `@` prefix: `"@sol"` or `"@sol[high]"`. nax expands every reference once, after the config layers merge and before schema validation, so the runtime, run logs, cost ledger and prompt audit only ever see real ids. A model upgrade becomes one edit to the alias value instead of one edit per profile.

An alias is not a tier. A tier is a per-agent role (`models.<agent>.<tier>`) with default-agent fallback and escalation. An alias is one literal model id. `{ agent, model: "@sol" }` is a pin, exactly as if the literal id were written. A tier entry may hold `"@sol[medium]"` and stays a tier. An `@` reference never falls through to a tier lookup, and a tier name may not start with `@`.

## Motivation

Moving one model family to a new release touched 77 literal ids across `~/.nax/config.json` and 46 profiles (2026-11-18, GPT-6.2), and reverting it took 74 lines across 48 files (2026-11-20). Custom tiers cannot carry this: a tier entry cannot reference another name, tiers are per agent with default-agent fallback, and turning a pin into a tier changes escalation behaviour (#2977).

#2977 proposed a new `models.aliases` key. `models` is parsed as `Record<agentName, Record<tierName, ModelEntry>>` (`PerAgentModelMapSchema`, `src/config/schemas-model.ts`), so `models.aliases.sol` would load as an agent named `aliases` with a tier named `sol`. That mixes the two concepts this feature must keep apart. nax already has a name-to-model-id map, `agent.modelAliases` (`ModelAliasesSchema`, `src/config/schemas-model-alias.ts`), which chat and `nax agents run` read when an agent file names `model: sonnet`. This feature reuses that one map; it adds a second way to reference it (`@name` in config), not a second map.

## Design

### Approach

One pure expansion pass, `expandConfigModelAliases(raw)`, runs on the raw merged config immediately before `NaxConfigSchema.safeParse` at the two sites that validate a merged config: `finalizeAndValidateRootConfig` (`src/config/loader.ts`, the root chain: global, project, profiles, CLI overrides) and `validatePackageConfig` (`src/config/package-layer.ts`, every per-package overlay). Running after the merge means a root-chain profile can repoint one alias for its run and every reference in the config sees the final value. A per-package layer starts from the already-expanded root config, so an alias it sets applies only to the `@` references that package layer writes itself; references inherited from the root keep the root value. `mergePackageConfig` shallow-merges `agent`, so a package layer that sets `agent.modelAliases` replaces the root map for that package's own references.

The pass reads the alias map from `raw.agent.modelAliases` (absent: `{}`), matching each reference against the keys as trimmed, the same way `ModelAliasesSchema` trims them, and rewrites exactly these positions:

1. A string entry `models.<agent>.<tier>`.
2. The `model` field of an object entry `models.<agent>.<tier>` (`ModelDef`).
3. The `model` field of any object, at any depth, that has a string `agent` field and a string `model` field, except inside the excluded subtrees below. This covers every `{ agent, model }` selector (`ConfiguredModelObjectSchema`: `plan.model`, `routing.llm.model`, `review.semantic.model`, `review.adversarial.model`, `review.fixReview.model`, `advisor.model`, `advisor.fallbackModels[]`, `bot.models.*`, `workflow.models.*`, `finish.reviewers.*`) and every `agent.fallback.map` rung of the form `{ agent, model }`, including inside arrays, and a selector added to the schema later gets alias support without a code change.

Excluded subtrees, never walked by rule 3, each matched by its full path from the config root: the top-level `models` (handled by rules 1 and 2; `bot.models` and `workflow.models` are walked), `agent.modelAliases` (the map itself), `routing.agents` (its `profiles[].target` is `{ agent, model: ModelTierSchema }`, a tier field, so an `@` reference there must reach the tier refusal below rather than be expanded), and `chat` (its `chat.workflow.*` model fields are out of scope).

Only a string that starts with `@` is rewritten. No other string in the config is touched, so values such as npm scopes (`@nathapp/...`) elsewhere in the config are safe.

A reference is `@<name>` or `@<name>[<effort>]`, matched against the whole string: `<name>` is one or more characters that are not whitespace, `[` or `]`, and the optional suffix is exactly one trailing `[<effort>]` with a non-empty effort that holds no whitespace or brackets. Any other string that starts with `@` (`@sol[high`, `@sol[]`, `@sol[a][b]`, `@sol[high]x`, `@ sol`) is a malformed reference. Before lookup the pass treats a missing or non-object `agent.modelAliases` as `{}` and a non-string alias value as an invalid alias, so a malformed map produces `MODEL_ALIAS_INVALID`, never a crash. Expansion looks `<name>` up in the alias map with an own-property check. A reference without a suffix yields the alias value unchanged. A reference with a suffix yields the alias value's base id (`parseModelSpec(value).model`) followed by `[<effort>]`, replacing any suffix the value carried, the same rule `withEffort` applies to tier selectors (`src/config/schema-types.ts`).

String-form selectors (`review.semantic.model: "balanced"`, `bot.models.review: "fast"`) are tier names by definition (`resolveConfiguredModel` treats every string selector as a tier). The pass leaves them alone, and `ModelTierSchema` rejects a tier string that starts with `@`, with a message that names the object form. Tier keys under `models.<agent>` are rejected the same way. This is what keeps an alias from ever being read as a tier.

Because every reference is gone before validation, everything downstream is unchanged: `classifyModelSelector` sees a provider-qualified literal and returns `kind: "model"` (a pin), a tier entry that held `@sol` resolves as a tier with the expanded id, `validateNativeModelIds` checks the expanded native ids, and `nax config` prints expanded ids alongside the `agent.modelAliases` map itself.

`--model` flags arrive after load. `nax bot review` / `nax bot fix` (`parseModelOption`, `checkBotModelOverride`, `botModel` in `src/bot/models.ts`) and `nax advisor replay` (`runAdvisorReplay`, `src/cli/advisor-replay.ts`) expand an `agent:@name` override through the same reference helper, `expandModelAliasRef`, reading the loaded config's `agent.modelAliases`. Advisor replay resolves the override once, right after `deps.buildCallContext` and inside the `try` whose `finally` calls `close()`, before the record loop, so a bad alias fails before any worktree is created and `close()` still runs.

```typescript
// src/config/model-alias-expand.ts (new) — worked skeleton, names are the contract
export const MODEL_ALIAS_PREFIX = "@";

/** One `@name[effort]` reference -> the literal id it stands for. Throws MODEL_ALIAS_INVALID. */
export function expandModelAliasRef(
  ref: string,
  aliases: Readonly<Record<string, string>>,
  path: string, // config path or "--model", named in the error
): string;

/** The raw merged config with every model-position reference expanded. Never mutates `raw`. */
export function expandConfigModelAliases(raw: Record<string, unknown>): Record<string, unknown>;
```

### Integration

Read only (verified on `origin/main` `1a883f2ed`):

- `ModelAliasesSchema` (`src/config/schemas-model-alias.ts`): `z.record(z.string().trim().min(1), ModelAliasTargetSchema)`; a value is `provider/model[effort]` (`MODEL_ALIAS_TARGET`) or `acp:<agent>[/<model>][effort]` (`ACP_ALIAS_TARGET`). Mounted at `AgentConfigSchema.modelAliases` with `.default({})` (`src/config/schemas-infra.ts`).
- `resolveConfiguredModel(models, preferredAgent, selection, defaultAgent)` and `classifyModelSelector` (`src/config/schema-types.ts`): string selector -> tier; object selector -> tier when the base names one, else literal model (pin).
- `parseModelSpec` (`@nathapp/nax-agent`): splits a trailing `[effort]`.
- `validateNativeModelIds` (`src/config/schemas-protocol-gate.ts`): runs inside `NaxConfigSchema` refinement, after the expansion pass.
- `resolveSubagentModel` (`src/chat/subagent-model.ts`) and `resolveAgentsRunModel` (`src/cli/agents-run-model.ts`): agent-file `model: <name>` lookups by bare name. Unchanged.
- `runBotReview` -> `reviewCheckout` (`src/bot/review-run.ts`) and `runBotFix` -> `fixCheckout` (`src/bot/fix-run.ts`): both call `checkBotModelOverride(loadedConfig, input.model)` right after `loadBotConfig` and return `{ outcome: "refused", reason }` when it returns a string.

Changed. The baseline exists only to locate the code; it is never the interface to implement.

- `finalizeAndValidateRootConfig(rawConfig)` (`src/config/loader.ts`)
  - Baseline: reject guards -> `stripRemovedConfig` -> warnings -> `NaxConfigSchema.safeParse(stripped)`.
  - Target: same, with `expandConfigModelAliases(stripped)` applied immediately before `safeParse`.
- `validatePackageConfig(rawMerged, packageDir, profileChain, warnDedupe)` (`src/config/package-layer.ts`)
  - Baseline: reject guards -> `stripRemovedConfig` -> `NaxConfigSchema.safeParse(stripped)`.
  - Target: same, with `expandConfigModelAliases(stripped)` applied immediately before `safeParse`.
- `ModelTierSchema` (`src/config/schemas-model.ts`)
  - Baseline: `z.string().min(1, "Tier name must be non-empty")`.
  - Target: also refuses a value starting with `@`, message: `an @alias is a model id, not a tier; where a model pin is accepted, write { "agent": "<agent>", "model": "<value>" }`. `ModelTierSchema` is also used for escalation rungs (`schemas-execution.ts`), which is why the message is conditional.
- `PerAgentModelMapSchema` tier keys (`src/config/schemas-model.ts`)
  - Baseline: `z.record(z.string().min(1), z.record(z.string().min(1), ModelEntrySchema))`.
  - Target: an inner (tier) key starting with `@` is refused with `tier names cannot start with "@" (reserved for model aliases)`.
- `parseModelOption(value)` (`src/bot/models.ts`)
  - Baseline: no `:` -> returns the string as a tier.
  - Target: a value with no `:` that starts with `@` throws `NaxError` `BOT_MODEL_INVALID` naming the `<agent>:@<name>` form; everything else unchanged.
- `checkBotModelOverride(config, model)` (`src/bot/models.ts`)
  - Target: for an object override whose `model` starts with `@`, an unknown or invalid alias returns a refusal string containing the `expandModelAliasRef` error message; a valid one is checked as the expanded literal.
- `botModel(config, role, override)` (`src/bot/models.ts`)
  - Target: an object override whose `model` starts with `@` is returned with `model` expanded from `config.agent.modelAliases`; every other path unchanged.
- `runAdvisorReplay` model input (`src/cli/advisor-replay.ts`)
  - Baseline: `replayOne` passes `parseModel(opts.model)` straight into `deps.callOp`.
  - Target: after `deps.buildCallContext`, the override is parsed once; an object model whose `model` starts with `@` is expanded from `ctx.config.agent.modelAliases`, a bare `@name` (no `agent:`) throws `MODEL_ALIAS_INVALID` naming `<agent>:@name`, and `replayOne` dispatches the resolved value. This resolution sits inside the `try` whose `finally` calls `close()`, so any throw here propagates out of `runAdvisorReplay` after `close()` runs.
- `FIELD_DESCRIPTIONS["agent.modelAliases"]` (`src/cli/config-descriptions.ts`)
  - Target: the existing text, plus that config model positions reference an alias as `@name` or `@name[effort]` and that an alias is a model id, never a tier.

### Failure Handling

All expansion errors are `NaxError` with code `MODEL_ALIAS_INVALID` and context `{ stage: "config", path, alias }`. At config load the pass collects every bad reference and throws once, one `<path>: <message>` line per reference, with `context.paths` listing them, before `safeParse` runs. At the per-package site (`validatePackageConfig`) the same error also carries `packageDir` in its context.

| Input | Behaviour |
|:---|:---|
| `@name` where `agent.modelAliases` has no own key `name` | `unknown model alias "name"`, naming the path |
| alias value starting with `@` | `model alias "name" must be a literal model id, not another alias` |
| alias value that is an `acp:` target, used from a config model position | `model alias "name" is an acp: target, usable only from agent files` |
| alias value that is neither `provider/model[effort]` nor `acp:` | `model alias "name" is not a provider/model id` |
| bare `@` or `@[high]` (empty name) | `empty model alias reference` |
| `@sol[high`, `@sol[]`, `@sol[a][b]`, `@sol[high]x`, `@ sol` | `malformed model alias reference "<ref>"` |
| `agent.modelAliases` missing or not an object | treated as `{}`; every `@` reference is then `unknown model alias` |
| alias value that is not a string | `model alias "name" is not a provider/model id` |
| `"@sol"` as a string-form selector or as a tier key | schema error from `ModelTierSchema` / `PerAgentModelMapSchema` naming the object form |
| `bot --model @sol` (no agent) | `BOT_MODEL_INVALID`, naming `<agent>:@sol` |
| `bot --model native:@nope` | `{ outcome: "refused", reason }` with the unknown-alias message, before any runtime exists |
| `advisor replay --model native:@nope` | `runAdvisorReplay` rejects with `MODEL_ALIAS_INVALID` before the record loop; `callOp` is never called and `close()` runs |
| `advisor replay --model @sol` (no agent) | `runAdvisorReplay` rejects with `MODEL_ALIAS_INVALID` naming `<agent>:@sol` |
| `@sol` in `routing.agents.profiles[].target.model` | not expanded; schema error from `ModelTierSchema` naming the object form |
| alias defined but never referenced, with a bad value | unchanged: `ModelAliasesSchema` rejects it during `safeParse` |

## Out of Scope

- `nax config` printing references as written: config is printed after load, so it shows expanded ids plus the `agent.modelAliases` map.
- `@name` references inside agent files (`model:` frontmatter) and in `nax chat --model` / `nax agents run --model`; those keep the existing bare-name alias lookup (`resolveSubagentModel`).
- Aliases for bare model ids used by ACP agents (for example `"codex-sol": "gpt-6.2-sol"`); an alias value stays `provider/model` or `acp:` as `ModelAliasesSchema` defines it today.
- Alias values that reference another alias, a tier, or a list of ids (one level, literal ids only).
- `agent.native.catalogOverrides` keyed by alias: catalog entries stay keyed by the real model id.
- Changes to tier semantics or the `{ agent, model }` vs `{ agent, tier }` selector split (#2572).
- A new top-level or `models.aliases` key; `agent.modelAliases` is the only alias map.
- Migrating the user's global config and profiles to `@` references: a manual follow-up outside the run, in the operator config repository.
- Expanding `@` strings in config positions other than the three listed in Design § Approach.
- `@` references in `chat.workflow.*` model fields (`specWriter`, `specReviewer`, `botReview`, `botFix`); the `chat` subtree is not walked.
- A per-package layer repointing an alias for references inherited from the root config; inherited references keep the root value.
- `@` entries in the legacy flat `models` shape (pre per-agent map): left unexpanded and unvalidated, and they fail only at dispatch; only the per-agent `models.<agent>.<tier>` shape is walked.
- `agent.fallback.map` rungs written as a bare string (an agent name) or as `{ agent, tier }`: an `@` there is left unexpanded and unvalidated and fails only at dispatch; only `{ agent, model }` rungs are expanded.

## Stories

**US-001: the alias reference helper.** Workdir: `packages/nax`. No dependencies. Adds `src/config/model-alias-expand.ts` with `MODEL_ALIAS_PREFIX` and `expandModelAliasRef`, exported from the `src/config` barrel. A pure function; nothing calls it yet.

**US-002: the config walker.** Workdir: `packages/nax`. Depends on US-001. Adds `expandConfigModelAliases` to `src/config/model-alias-expand.ts`, exported from the barrel: it walks the three positions of Design § Approach, skips the excluded subtrees, collects every bad reference into one `MODEL_ALIAS_INVALID`, and never mutates its input.

**US-003: references expand at config load, and tiers refuse `@`.** Workdir: `packages/nax`. Depends on US-002. `finalizeAndValidateRootConfig` and `validatePackageConfig` run `expandConfigModelAliases` immediately before `NaxConfigSchema.safeParse`. `ModelTierSchema` and the `models.<agent>` tier keys refuse a leading `@`. Pins that an expanded `{ agent, model }` selector is a pin and an expanded tier entry is still a tier.

**US-004: `--model` overrides accept `agent:@name`.** Workdir: `packages/nax`. Depends on US-001. `parseModelOption` refuses a bare `@name`; `checkBotModelOverride` refuses an unknown or `acp:` alias; `botModel` returns the expanded override; `runAdvisorReplay` resolves its override once before the record loop; `FIELD_DESCRIPTIONS["agent.modelAliases"]` documents the `@` form.

**US-005: configuration guide entry.** Workdir: `.`. Depends on US-003, US-004. **No-test:** documentation only. Adds a model-aliases subsection to `docs/guides/configuration.md`.

### Context Files

**US-001**

- `packages/nax/src/config/schemas-model-alias.ts` — `ModelAliasesSchema` and the alias target shapes values are checked against
- `packages/nax/src/config/schema-types.ts` — `withEffort`, the suffix-replacement rule to mirror
- `packages/nax/src/config/index.ts` — the barrel the helper is exported from

**US-002**

- `packages/nax/src/config/model-alias-expand.ts` — created by US-001, extended here
- `packages/nax/src/config/schemas-infra.ts` — `AgentRoutingProfileSchema.target` (excluded tier field), `FallbackTargetSchema`
- `packages/nax/src/config/schemas-model.ts` — `PerAgentModelMapSchema`, `ModelDefSchema`, `ConfiguredModelObjectSchema`

**US-003**

- `packages/nax/src/config/loader.ts` — `finalizeAndValidateRootConfig`, the root call site
- `packages/nax/src/config/package-layer.ts` — `validatePackageConfig`, the per-package call site
- `packages/nax/src/config/schemas-model.ts` — `ModelTierSchema`, `PerAgentModelMapSchema`
- `packages/nax/src/config/schema-types.ts` — `resolveConfiguredModel`, `classifyModelSelector`
- `packages/nax/src/config/model-alias-expand.ts` — created by US-001 and US-002, wired here

**US-004**

- `packages/nax/src/bot/models.ts` — `parseModelOption`, `checkBotModelOverride`, `botModel`
- `packages/nax/src/bot/review-run.ts` — `reviewCheckout` refusal path
- `packages/nax/src/cli/advisor-replay.ts` — `runAdvisorReplay`, `replayOne`, `parseModel`
- `packages/nax/src/cli/config-descriptions.ts` — `FIELD_DESCRIPTIONS["agent.modelAliases"]`
- `packages/nax/src/config/model-alias-expand.ts` — created by US-001, consumed here

**US-005**

- `docs/guides/configuration.md` — the `### Agent Configuration` section and its `agent.*` table
- `packages/nax/src/config/model-alias-expand.ts` — created by US-001 and US-002, the behaviour the docs describe

### Creates

**US-001**

- `packages/nax/src/config/model-alias-expand.ts`
- `packages/nax/test/unit/config/model-alias-expand.test.ts`

**US-002**

- `packages/nax/test/unit/config/model-alias-walk.test.ts`

**US-003**

- `packages/nax/test/unit/config/loader-model-aliases.test.ts`

### Modifies

**US-001**

None. A new module and its test; no existing assertion pins the `src/config` barrel's export list.

**US-002**

None. It extends the module US-001 created and adds its own test file.

**US-003**

None. The tier refusal only rejects values starting with `@`; no existing test, default or fixture uses a tier name, tier key or string selector with a leading `@` (checked across `packages/nax/test` and the schema defaults), and no test asserts the `ModelTierSchema` message text.

**US-004**

- `packages/nax/test/unit/bot/models.test.ts` — the `parseModelOption`, `checkBotModelOverride` and `botModel` describe blocks gain `@` cases; existing assertions stay, and a value with no `:` and no leading `@` still returns the string unchanged.
- `packages/nax/test/integration/bot/model-override.test.ts` — the existing `runBotReview --model refusal` describe block gains a case for an unknown `@` alias; existing cases stay.
- `packages/nax/test/unit/cli/advisor-replay.test.ts` — the file's `harness` gains an optional config parameter passed to `makeMockCallContext({ config })` from the shared call-context test helper (unchanged) so `ctx.config.agent.modelAliases` can define `sol`, records each dispatched `input.model`, and counts `close` calls; alias cases are added on it; existing cases and their assertions stay.
- `packages/nax/test/unit/cli/config-descriptions.test.ts` — the `FIELD_DESCRIPTIONS agent.modelAliases` describe block gains an `@name` case; the existing `acp:` assertion stays.

**US-005**

None. Documentation only.

### Seams

- US-001 -> US-002: `expandConfigModelAliases` calls `expandModelAliasRef` for every reference. Pinned by US-002 AC-1 to AC-6, which assert expanded values the helper produces.
- US-002 -> US-003: `expandConfigModelAliases` is reached from `loadConfig` and `loadConfigForWorkdir`. Pinned by US-003 AC-1 to AC-5, which load real config files from a temp directory.
- US-001 -> US-004: `expandModelAliasRef` is called by `checkBotModelOverride`, `botModel` and `runAdvisorReplay`. Pinned by US-004 AC-4 (refusal through `runBotReview`) and AC-8 (expanded model reaches `callOp` through `runAdvisorReplay`).

## Acceptance Criteria

### US-001

1. [unit] `expandModelAliasRef("@sol", { sol: "openai-codex/gpt-6.1-sol" }, "bot.models.review.model")` returns `"openai-codex/gpt-6.1-sol"`.
2. [unit] `expandModelAliasRef("@sol[high]", { sol: "openai-codex/gpt-6.1-sol" }, "p")` returns `"openai-codex/gpt-6.1-sol[high]"`.
3. [unit] `expandModelAliasRef("@sol[high]", { sol: "openai-codex/gpt-6.1-sol[medium]" }, "p")` returns `"openai-codex/gpt-6.1-sol[high]"`, the reference's suffix replacing the value's.
4. [unit] `expandModelAliasRef("@sol", { sol: "openai-codex/gpt-6.1-sol[medium]" }, "p")` returns `"openai-codex/gpt-6.1-sol[medium]"`.
5. [unit] `expandModelAliasRef("@sol", { " sol ": "a/b" }, "p")` returns `"a/b"`, matching keys as trimmed.
6. [unit] `expandModelAliasRef("@nope", {}, "bot.models.review.model")` throws a `NaxError` with code `MODEL_ALIAS_INVALID`.
7. [unit] The error thrown by `expandModelAliasRef("@nope", {}, "bot.models.review.model")` has the message `bot.models.review.model: unknown model alias "nope"`.
8. [unit] `expandModelAliasRef("@toString", {}, "p")` throws `MODEL_ALIAS_INVALID`, because inherited object keys are not aliases.
9. [unit] `expandModelAliasRef("@a", { a: "@b" }, "p")` throws an error whose message contains `must be a literal model id`.
10. [unit] `expandModelAliasRef("@r", { r: "acp:codex/gpt-6.1-terra" }, "p")` throws an error whose message contains `usable only from agent files`.
11. [unit] `expandModelAliasRef("@x", { x: "no-provider" }, "p")` throws an error whose message contains `not a provider/model id`.
12. [unit] `expandModelAliasRef("@[high]", { sol: "a/b" }, "p")` throws an error whose message contains `empty model alias reference`.
13. [unit] `expandModelAliasRef` throws an error whose message contains `malformed model alias reference` for each of `"@sol[high"`, `"@sol[]"`, `"@sol[a][b]"` and `"@sol[high]x"` with `{ sol: "a/b" }`.
14. [unit] `expandModelAliasRef("@sol", { sol: 42 } as unknown as Record<string, string>, "p")` throws `MODEL_ALIAS_INVALID` with a message containing `not a provider/model id`.

### US-002

1. [unit] `expandConfigModelAliases` on `{ agent: { modelAliases: { sol: "a/b" } }, models: { native: { powerful: "@sol[medium]" } } }` returns `models.native.powerful` equal to `"a/b[medium]"`.
2. [unit] `expandConfigModelAliases` on `{ agent: { modelAliases: { sol: "a/b" } }, models: { native: { fast: { provider: "a", model: "@sol" } } } }` returns `models.native.fast.model` equal to `"a/b"`.
3. [unit] With `sol` set to `"a/b"`, `expandConfigModelAliases` on a config whose `bot.models.review` is `{ agent: "native", model: "@sol" }` returns `bot.models.review.model` equal to `"a/b"`.
4. [unit] With `sol` set to `"a/b"`, `expandConfigModelAliases` on a config whose `advisor.fallbackModels` is `[{ agent: "native", model: "@sol[low]" }]` returns `advisor.fallbackModels[0].model` equal to `"a/b[low]"`.
5. [unit] With `sol` set to `"a/b"`, `expandConfigModelAliases` on a config whose `agent.fallback.map` is `{ native: [{ agent: "native", model: "@sol" }] }` returns `agent.fallback.map.native[0].model` equal to `"a/b"`.
6. [unit] With `sol` set to `"a/b"`, `expandConfigModelAliases` on a config whose `review.semantic.model` is `{ agent: "native", model: "@sol" }` returns `review.semantic.model.model` equal to `"a/b"`.
7. [unit] `expandConfigModelAliases` returns a string-form `bot.models.fix` of `"@sol"` unchanged.
8. [unit] `expandConfigModelAliases` returns `plugins` set to `[{ module: "@nathapp/x" }]` unchanged.
9. [unit] `expandConfigModelAliases` returns `routing.agents.profiles[0].target` set to `{ agent: "native", model: "@sol" }` unchanged.
10. [unit] `expandConfigModelAliases` returns `chat.workflow.specWriter` set to `{ agent: "native", model: "@sol" }` unchanged.
11. [unit] After `expandConfigModelAliases(raw)` returns, `raw` still deep-equals a `structuredClone` of it taken before the call.
12. [unit] `expandConfigModelAliases` on a config with no `agent.modelAliases` and no `@` strings returns a value deep-equal to its input.
13. [unit] `expandConfigModelAliases` on a config whose `agent.modelAliases` is the string `"oops"` and whose `bot.models.review` is `{ agent: "native", model: "@sol" }` throws `MODEL_ALIAS_INVALID` naming `unknown model alias "sol"`, not a `TypeError`.
14. [unit] `expandConfigModelAliases` on a config with unknown references at `bot.models.review.model` and `models.native.fast` throws one `NaxError` with code `MODEL_ALIAS_INVALID` whose `context.paths` holds exactly those two paths.

### US-003

1. [integration] `loadConfig(projectDir)` with a project `.nax/config.json` setting `agent.modelAliases.sol` to `"openai-codex/gpt-6.1-sol"` and `models.native.powerful` to `"@sol[medium]"` returns `models.native.powerful` equal to `"openai-codex/gpt-6.1-sol[medium]"`.
2. [integration] `loadConfig(projectDir)` with the same alias and `bot.models.review` set to `{ agent: "native", model: "@sol[high]" }` returns `bot.models.review.model` equal to `"openai-codex/gpt-6.1-sol[high]"`.
3. [integration] `loadConfig(projectDir, { profile: "upgrade" })`, where the project config defines `sol` as `"openai-codex/gpt-6.1-sol"` and references it from `bot.models.review`, and the project profile file `profiles/upgrade.json` beside that config sets `agent.modelAliases.sol` to `"openai-codex/gpt-6.2-sol"`, returns `bot.models.review.model` equal to `"openai-codex/gpt-6.2-sol"`.
4. [integration] `loadConfigForWorkdir(rootConfigPath, "packages/x")`, where the project's `mono/packages/x/config.json` overlay beside the root config sets `review.semantic.model` to `{ agent: "native", model: "@sol" }`, with `sol` defined only in the root config, returns `review.semantic.model.model` equal to `"openai-codex/gpt-6.1-sol"`.
5. [integration] `loadConfig` with `bot.models.review` set to `{ agent: "native", model: "@nope" }` rejects with a `NaxError` whose code is `MODEL_ALIAS_INVALID` and whose message names `bot.models.review.model`.
6. [integration] `loadConfig` with a string-form `review.semantic.model` of `"@sol"` rejects with code `CONFIG_SCHEMA_INVALID` and a message containing `an @alias is a model id, not a tier`.
7. [integration] `loadConfig` with `routing.agents.profiles[0].target` set to `{ agent: "native", model: "@sol" }` rejects with code `CONFIG_SCHEMA_INVALID` and a message containing `an @alias is a model id, not a tier`.
8. [unit] `NaxConfigSchema.safeParse` of a config whose `models.native` has a tier key `"@sol"` fails with a message containing `tier names cannot start with "@"`.
9. [unit] For a config loaded with `bot.models.review` written as `{ agent: "native", model: "@sol" }`, `resolveConfiguredModel(config.models, "native", config.bot.models.review, "native")` returns a result with no `modelTier`, so the selector is a pin.
10. [integration] `loadConfigForWorkdir(rootConfigPath, "packages/x")` with that overlay setting `review.semantic.model` to `{ agent: "native", model: "@nope" }` rejects with code `MODEL_ALIAS_INVALID` whose `context.packageDir` is `"packages/x"`.
11. [unit] For a config loaded with `models.native.powerful` written as `"@sol[medium]"`, `resolveConfiguredModel(config.models, "native", "powerful", "native")` returns `modelTier` equal to `"powerful"` and `modelDef.model` equal to `"openai-codex/gpt-6.1-sol[medium]"`.

### US-004

1. [unit] `parseModelOption("@sol")` throws a `NaxError` with code `BOT_MODEL_INVALID` whose message contains `<agent>:@sol`.
2. [unit] `parseModelOption("native:@sol[high]")` returns `{ agent: "native", model: "@sol[high]" }`.
3. [unit] `checkBotModelOverride(config, { agent: "native", model: "@sol" })` returns `undefined` when `config.agent.modelAliases.sol` is `"openai-codex/gpt-6.1-sol"`.
4. [integration] `runBotReview` with `input.model` set to `{ agent: "native", model: "@nope" }` and a stubbed `_botReviewDeps.loadBotConfig` whose config defines no `nope` alias returns `outcome` `"refused"` with a `reason` containing `unknown model alias "nope"`, and the stubbed `_botReviewDeps.createRuntime` is never called.
5. [unit] `checkBotModelOverride(config, { agent: "native", model: "@r" })` returns a string containing `usable only from agent files` when `config.agent.modelAliases.r` is `"acp:codex/gpt-6.1-terra"`.
6. [unit] `botModel(config, "review", { agent: "native", model: "@sol[high]" })` returns `{ agent: "native", model: "openai-codex/gpt-6.1-sol[high]" }` when `config.agent.modelAliases.sol` is `"openai-codex/gpt-6.1-sol"`.
7. [unit] `botModel(config, "rulings", { agent: "native", model: "@sol" })` returns `{ agent: "native", model: "openai-codex/gpt-6.1-sol" }` for the same config.
8. [integration] `runAdvisorReplay` with `opts.model` `"native:@sol"`, one audit record, and the test file's `harness` given a config whose `agent.modelAliases.sol` is `"openai-codex/gpt-6.1-sol"`, dispatches `callOp` once with a recorded input `model` equal to `{ agent: "native", model: "openai-codex/gpt-6.1-sol" }`.
9. [integration] `runAdvisorReplay` with `opts.model` `"native:@nope"` and the same harness rejects with a `NaxError` whose code is `MODEL_ALIAS_INVALID`, and the harness records no `callOp` dispatch, no `git` call, and exactly one `close` call.
10. [integration] `runAdvisorReplay` with `opts.model` `"@sol"` and the same harness rejects with a `NaxError` whose message contains `<agent>:@sol`.
11. [unit] `FIELD_DESCRIPTIONS["agent.modelAliases"]` contains `@name`.

### US-005

**No-test:** documentation only.

1. [review] `docs/guides/configuration.md` has a model-aliases subsection under `### Agent Configuration` showing an `agent.modelAliases` map, a `models.native` tier entry written as `"@sol[medium]"`, and a `bot.models.review` pin written as `{ "agent": "native", "model": "@sol[high]" }`.
2. [review] The same subsection has a tier-versus-alias table with one row each for where it lives, how a reference is written, default-agent fallback, escalation, and what a value may hold.
3. [review] The same subsection states that references are expanded at config load, so run logs and the cost ledger record the expanded id and `nax config` prints expanded ids.
4. [review] The same subsection lists each load-time error from the spec's Failure Handling table with its message text.
