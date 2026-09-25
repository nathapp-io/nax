---
title: Context Engine
description: Seed, configure, extend, and debug the Context Engine v2
---

## Context Engine

The Context Engine assembles everything your coding agent "knows" at each pipeline stage — canonical rules, feature notes, prior session observations, recent git changes, co-changed files, and any custom RAG / graph / KB sources you plug in. It replaces the old "one big `context.md` dump" model with stage-aware, session-aware, budgeted assembly.

This guide covers **how to use it**. For the design rationale, see [ADR-010](../adr/ADR-010-context-engine.md) and [Architecture §24](../architecture/subsystems.md).

---

### When to use it

Turn the engine on when any of the following are true:

- You're running multi-story pipelines and want prior-story observations to carry forward.
- Your project has rules / conventions that Claude-specific files (`CLAUDE.md`, `.claude/rules/`) can't express portably across agents (Codex, OpenCode, Gemini, etc.).
- You want to plug in a RAG index, symbol graph, or internal KB as a context source.
- You want to audit exactly what went into each agent prompt after the fact.

You can skip it if you're running single-story, single-agent, small-repo flows — the legacy v1 path (`context.md` inlined at prompt build) still works.

---

### 1. Enable it

The engine is **off by default**. Opt in per-project:

```json
// .nax/config.json
{
  "context": {
    "v2": {
      "enabled": true
    }
  }
}
```

That's the minimum. With just `enabled: true`, you get the built-in providers — `static-rules`, `feature-context`, `session-scratch`, `git-history`, `code-neighbor`, `test-coverage`, `tool-diagnostics`, `prior-run-failure`, `lint-config` — each active on the stages whose default provider set lists it (see `STAGE_CONTEXT_MAP` in `src/context/engine/stage-config.ts`; e.g. `prior-run-failure` and `lint-config` run only on `rectify`).

Verify it's on:

```bash
nax run -f my-feature
# Look for "v2 context bundle assembled" lines in the log
# Or inspect the manifest (§7 below)
```

---

### 2. Seed feature context (`context.md`)

The single highest-leverage file. Read by `FeatureContextProvider` on every stage.

**Path:** `<repoRoot>/.nax/features/<featureId>/context.md`

**Format:** plain Markdown. Append entries as you go — order matters (newer entries outrank older ones once the staleness detector kicks in).

```markdown
## Design decision — 2026-04-18

Chose Postgres over Dynamo for multi-tenant isolation. Partition key must
include `tenant_id` in every new table.

## Known constraint

RDS hard-caps at 1000 concurrent connections. Avoid N+1 in reviews — use
the batch endpoint `/v2/reviews/batch`.

## Deprecated

`/v1/*` endpoints deprecated 2026-01-15. All new routes land under `/v2/`.
```

**Staleness.** Entries past `staleness.maxStoryAge` completed stories (default 10) get their score multiplied by `staleness.scoreMultiplier` (default 0.4) so fresh context beats old context for the same budget slot. Entries are never auto-deleted — you edit the file to remove them.

**Pull tool.** Reviewers and rectifiers can call `query_feature_context` mid-session to re-query this file with an optional keyword filter. See §5.

---

### 3. Replace `CLAUDE.md` / `.claude/rules/` with canonical rules

Agent-specific files (`CLAUDE.md`, `.claude/rules/`, `.cursorrules`) are not portable. When availability fallback swaps Claude → Codex, the new agent never reads them.

The engine reads from a canonical, agent-agnostic store instead:

**Path:** `<repoRoot>/.nax/rules/*.md`

Any `.md` file in that directory is picked up by `StaticRulesProvider` on every stage. Structure by concern:

```
.nax/rules/
  project-conventions.md
  error-handling.md
  testing-commands.md
  forbidden-patterns.md
```

**Legacy fallback.** While you migrate, keep reading the old files:

```json
{
  "context": {
    "v2": {
      "rules": {
        "allowLegacyClaudeMd": true,
        "budgetTokens": 8192
      }
    }
  }
}
```

With `allowLegacyClaudeMd: true`, `StaticRulesProvider` falls back to the legacy files (`CLAUDE.md`, `.cursorrules`, `AGENTS.md`, `.claude/rules/`) when no canonical rules exist. Default is `false` — once you've migrated, drop the flag to avoid drift.

For authoring conventions — `paths:`, `appliesTo:`, `priority:`, the neutrality linter, and how to split monolithic rule files — see the [Static Rules Guide](./static-rules.md).

---

### 4. Configure per-stage budgets

Every pipeline stage has a default token budget and a default provider list (see `src/context/engine/stage-config.ts`). Override per-stage in your config:

```json
{
  "context": {
    "v2": {
      "stages": {
        "tdd-simple":       { "budgetTokens": 15000 },
        "tdd-test-writer":  { "budgetTokens": 10000 },
        "review":           { "budgetTokens": 6000 }
      }
    }
  }
}
```

Bigger budget = more context, higher token cost. Smaller = tighter prompts, cheaper but more prone to pull-tool fetches (§5).

Single-session execution assembles under the stage named after the story's strategy (`single-session`, `tdd-simple`, `no-test`, `batch`); there is no `execution` stage key. Each stage entry also accepts `providerTimeoutMs` (min 1000) to override the engine-wide `providerTimeoutMs` (default 5000), and `extraProviderIds` (§6).

Common starting points:

| Stage | Default | Raise when |
|:------|:--------|:-----------|
| `single-session` / `tdd-simple` / `batch` | 12,000 | Stories touch ≥3 files or cross-package boundaries |
| `no-test` | 10,000 | Same as above, for no-test stories |
| `tdd-test-writer` | 8,000 | Tests need broad domain context (acceptance specs, invariants) |
| `review` | 6,000 | Diffs are typically large; reviewers miss cross-cutting concerns |
| `rectify` | 8,000 | Rectification fails with "didn't know about X" verdicts |

---

### 5. Enable pull tools (on-demand context)

Pull tools let the agent fetch context *mid-session* instead of everything being pre-injected. Three built-ins:

- **`query_neighbor(filePath)`** — fetch import-graph neighbours for a file. Offered on `tdd-test-writer`, `tdd-implementer`, `rectify`, `single-session`, `tdd-simple`, `batch`.
- **`query_scratch(kind?, limit?)`** — fetch session-scratch records of what broke (verify results, tool diagnostics), most recent first. Offered on `rectify`, `single-session`, `tdd-simple`, `batch`.
- **`query_feature_context(keyword?)`** — fetch feature context with optional keyword filter. Offered on `review-semantic`, `review-adversarial`.

Pull tools are off by default. Enable them:

```json
{
  "context": {
    "v2": {
      "pull": {
        "enabled": true,
        "allowedTools": [],
        "maxCallsPerSession": 5,
        "maxCallsPerRun": 50
      }
    }
  }
}
```

| Key | Default | Notes |
|:----|:--------|:------|
| `pull.enabled` | `false` | Master switch |
| `pull.allowedTools` | `[]` | Empty = allow all stage-configured tools; set `["query_neighbor"]` to restrict |
| `pull.maxCallsPerSession` | `5` | Per agent session ceiling |
| `pull.maxCallsPerRun` | `50` | Per-run ceiling (shared across all sessions) |

Exhausted budgets throw `PULL_TOOL_BUDGET_EXHAUSTED`; the agent recovers gracefully and finishes with whatever it already has.

The prompt preamble advertises each tool's `inputSchema` — argument name, type,
whether it is required, and the per-argument description — plus a worked call
example built from the first advertised tool's own schema. A descriptor is
therefore the single source for both what the agent is told and what is
enforced: `validatePullToolInput` (`pull-tools.ts`) checks every call against
that same schema before dispatch, throwing `PULL_TOOL_INVALID_INPUT` when a
required argument is missing or a declared argument has the wrong type. That
check runs before `budget.consume()`, so a rejected call costs no budget, and
the error is returned to the agent as a `<nax_tool_result status="error">`
block it can retry from. Unknown extra properties are accepted and ignored.

Which stages get which tools is defined in `stage-config.ts` (`pullToolNames` per stage). You can't currently add a pull tool to an arbitrary stage from config alone — that's a code change.

---

### 6. Add a plugin provider (RAG / graph / KB)

This is the extension point for operator-specific context: an embeddings index, a symbol graph, your internal wiki, a domain-model summariser.

**Register in config:**

```json
{
  "context": {
    "v2": {
      "pluginProviders": [
        {
          "module": "@mycompany/nax-rag",
          "config": { "indexUrl": "https://rag.internal", "topK": 5 },
          "enabled": true
        },
        {
          "module": "./plugins/my-symbol-graph.ts",
          "enabled": true
        }
      ]
    }
  }
}
```

`module` accepts npm package names or project-relative paths (`./` / `../`). Absolute paths are rejected. Relative paths that try to escape the project root are rejected.

**Minimum viable provider:**

```typescript
// plugins/my-symbol-graph.ts
// Types mirror src/context/engine/types.ts — nax does not publish a types entry
// point, so copy the shapes you need or leave the object untyped.
import type { IContextProvider, ContextRequest, ContextProviderResult } from "./nax-context-types";

export const provider: IContextProvider = {
  id: "my-symbol-graph",
  kind: "graph",
  fetch: async (request: ContextRequest): Promise<ContextProviderResult> => {
    const files = request.touchedFiles ?? [];
    const related = await querySymbolGraph(files);

    return {
      chunks: related.map((r, i) => ({
        id: `my-symbol-graph:${r.symbol}`,
        kind: "graph",
        scope: "retrieved",
        role: ["all"],             // or ["implementer"], ["reviewer"], etc.
        content: `### ${r.symbol}\n${r.summary}\n`,
        tokens: estimateTokens(r.summary),
        rawScore: r.relevance,     // 0..1
      })),
      pullTools: [],               // advanced — usually empty
    };
  },
};
```

**Optional lifecycle hooks:**

```typescript
export const provider = {
  id: "my-symbol-graph",
  kind: "graph",
  async init(config: Record<string, unknown>) { /* open DB, warm cache */ },
  async fetch(request) { /* ... */ },
  async dispose() { /* close DB */ },
};
```

The loader validates the shape structurally (duck-typed — `id`, `kind`, `fetch`; no import from nax internals required) and accepts `export const provider`, a default export, or the module object itself. `init(config)` is called only when the entry has a `config`. Providers that fail to load or init log a warning and are skipped — the pipeline never blocks on a broken plugin.

**Determinism.** If your provider is non-deterministic (network call, LLM summary), set `deterministic: false` on it. Users who set `context.v2.deterministic: true` in their config will have it excluded — this is how you opt out of reproducibility-sensitive runs.

#### Scoping a provider to specific stages

A common question is "how do I run my provider only on `tdd-test-writer`?" or "only on `review-semantic`?" A plugin provider runs only on stages that list its ID in `stages.<name>.extraProviderIds` ([below](#wire-the-plugin-to-specific-stages)); the built-in stage-to-provider mapping stays hardcoded in `STAGE_CONTEXT_MAP` ([src/context/engine/stage-config.ts](../../src/context/engine/stage-config.ts)).

Within the stages a provider runs on, three patterns narrow what it emits:

**Pattern A — chunk `role` tags (audience filter).** Every pipeline stage has a fixed *role* and the orchestrator drops chunks whose `role` doesn't match. This is the right tool when you want a provider to serve one audience (e.g. reviewers).

| Role | Stages that consume it |
|:-----|:-----------------------|
| `implementer` | `context`, `tdd-implementer`, `verify`, `rectify`, `autofix`, `acceptance`, `plan`, `single-session`, `tdd-simple`, `no-test`, `batch`, `route` |
| `tdd` | `tdd-test-writer`, `tdd-verifier` |
| `reviewer` | `review`, `review-semantic`, `review-adversarial` |
| `all` | matches every stage |

```typescript
// Appears only in reviewer-role stages:
{ id: "my:design-decisions", role: ["reviewer"], content: "...", /* ... */ }

// Appears only in tdd-role stages:
{ id: "my:acceptance-invariants", role: ["tdd"], content: "...", /* ... */ }

// Multi-role — matches if ANY tag aligns with the stage role:
{ id: "my:cross-cutting", role: ["reviewer", "tdd"], content: "...", /* ... */ }
```

**Pattern B — switch on `request.stage` inside `fetch()`.** Use this when you need finer granularity than `role` (e.g. `tdd-test-writer` but not `tdd-verifier`):

```typescript
export const provider: IContextProvider = {
  id: "my-provider",
  kind: "rag",
  fetch: async (request) => {
    if (request.stage === "tdd-test-writer") {
      return {
        chunks: [{
          id: "my:acceptance-fixtures",
          kind: "rag",
          scope: "retrieved",
          role: ["tdd"],
          content: await loadAcceptanceFixtures(request.touchedFiles),
          tokens: 400,
          rawScore: 0.9,
        }],
        pullTools: [],
      };
    }
    if (request.stage === "review-semantic") {
      return {
        chunks: [{
          id: "my:design-rationale",
          kind: "rag",
          scope: "retrieved",
          role: ["reviewer"],
          content: await loadDesignRationale(request.featureId),
          tokens: 300,
          rawScore: 0.85,
        }],
        pullTools: [],
      };
    }
    return { chunks: [], pullTools: [] };  // no-op on other stages
  },
};
```

**Pattern C — combine A + B.** Use chunk `role` for coarse audience scoping and `request.stage` inside `fetch()` for fine per-stage variation (e.g. different framings for `tdd-test-writer` vs. `tdd-implementer`, both `tdd`-role).

#### Wire the plugin to specific stages

Plugin providers register globally, but they only run on stages that opt into their provider ID. Use `stages.<name>.extraProviderIds` for that:

```json
{
  "context": {
    "v2": {
      "stages": {
        "tdd-test-writer": { "extraProviderIds": ["my-symbol-graph"] },
        "review-semantic": { "extraProviderIds": ["my-symbol-graph"] }
      }
    }
  }
}
```

This is additive: built-in `providerIds` from `stage-config.ts` still run, and your plugin gets appended to that stage's allowlist. Unknown IDs in either the built-in list or `extraProviderIds` throw `CONTEXT_UNKNOWN_PROVIDER_IDS` at assembly time, so typos surface immediately.

---

### 7. Debug & audit — the manifest

Every bundle the engine assembles writes a manifest to disk. This is how you answer "why did the agent see X but not Y?"

**Path:**

```
<projectDir>/.nax/features/<featureId>/stories/<storyId>/context-manifest-<stage>.json
```

**What's in it:**

- `includedChunks` — what made it into the prompt, with score and byte-offset
- `excludedChunks` — with reason: `below-min-score` / `budget` / `dedupe` / `role-filter`, plus an orthogonal `stale` flag
- `providerResults` — per `providerId`: status (`ok` / `empty` / `failed` / `timeout`) and `source` (`stage-config` / `extra`)
- `chunkSummaries` — first 300 chars of each chunk (so you can read the manifest without cross-referencing the bundle)
- `rebuildInfo` — when a swap happened, records prior/new agent IDs and which chunks were re-rendered

Typical debugging workflow:

```bash
# Inspect what went into the execution stage for story US-003
cat .nax/features/my-feature/stories/US-003/context-manifest-execution.json | jq '.'

# "Why isn't my .nax/rules/testing.md showing up?"
jq '.excludedChunks[] | select(.id | contains("testing"))' \
  .nax/features/my-feature/stories/US-003/context-manifest-execution.json

# "Did my plugin provider run?"
jq '.providerResults[] | select(.providerId == "my-symbol-graph")' \
  .nax/features/my-feature/stories/US-003/context-manifest-execution.json
```

For verbose logging, filter the run's JSONL log for the `context` and `context-v2` stages (assembly details are logged at `debug`).

Manifests accumulate per story. Set `context.v2.manifest.retentionDays` to delete `context-manifest-*.json` and `rebuild-manifest.json` files older than N days at run completion (unset = never purged).

---

### 8. Monorepo tuning

In a monorepo, context scope matters. By default, per-package providers only scan the story's package — which is usually what you want.

```json
{
  "context": {
    "v2": {
      "providers": {
        "historyScope": "package",
        "neighborScope": "package"
      }
    }
  }
}
```

| Key | Default | Effect |
|:----|:--------|:-------|
| `providers.historyScope` | `"package"` | `git log` always runs in `repoRoot` against repo-rooted paths; `"package"` filters history to files under the story's package (default), `"repo"` keeps all story files. |
| `providers.neighborScope` | `"package"` | Import graph scans only within `packageDir`. Set `"repo"` when packages tightly share imports. |

> Cross-package reverse-dependency scanning is unsupported. `CodeNeighborProvider` parses only relative import specifiers, so a dependent in another package that imports by package name is invisible to it. The `providers.crossPackageDepth` key was removed in nax#2074; a config that still sets it loads with a deprecation warning and the key is ignored. To widen the scan root, set `providers.neighborScope: "repo"`.

`providers.sourceGlob` and `providers.maxGlobFiles` (default 500) tune `CodeNeighborProvider`'s reverse-dependency scan — see [Built-in Providers](./context-providers.md).

Per-package overrides live in `.nax/mono/<packageDir>/config.json` — use them when one package needs a different budget or scope than the repo default.

---

### 9. What happens when it's off

If `context.v2.enabled: false` (default), the pipeline falls back to v1:

- `featureContextMarkdown()` reads `context.md` directly and inlines it.
- No providers, no manifests, no pull tools, no session scratch.
- Agent-specific files (`CLAUDE.md`) are the only rules path.
- Everything goes into every stage's prompt — no budgets, no scoring.

Migration approach:

1. Leave `enabled: false`, author `.nax/rules/*.md` + `.nax/features/<id>/context.md`.
2. Flip `enabled: true` on a throwaway feature branch.
3. Inspect `context-manifest-*.json` after a run; confirm the chunks you expect are included.
4. Flip on in main config.

---

### 10. Full config reference

Every `context.v2.*` key:

| Key | Type | Default | Effect |
|:----|:-----|:--------|:-------|
| `enabled` | bool | `false` | Master switch |
| `minScore` | 0–1 | `0.1` | Drop chunks below this relevance score |
| `providerTimeoutMs` | int ≥1000 | `5000` | Per-provider fetch timeout; a provider that exceeds it is dropped with a warning |
| `deterministic` | bool | `false` | When `true`, exclude providers that declare `deterministic: false` |
| `pull.enabled` | bool | `false` | Allow mid-session pull tool calls |
| `pull.allowedTools` | `string[]` | `[]` | Allowlist (empty = all stage-configured tools) |
| `pull.maxCallsPerSession` | int | `5` | Per agent session |
| `pull.maxCallsPerRun` | int | `50` | Per entire nax run |
| `rules.allowLegacyClaudeMd` | bool | `false` | Fall back to `CLAUDE.md` / `.claude/rules/` when `.nax/rules/` is empty |
| `rules.budgetTokens` | int ≥512 | `8192` | Absolute token ceiling for canonical rules |
| `rules.rulesShare` | 0–1 | `0.4` | Share of the stage budget reserved for rules; effective budget is `min(rulesShare × stage budget, budgetTokens)` |
| `rules.enforceBudget` | bool | `true` | Truncate rule sections over budget; `false` keeps all and only reports pressure |
| `fragments.enabled` | bool | `false` | Feature-scoped fragment capture and read-back |
| `fragments.decay` | 0–1 | `0.6` | Score multiplier applied to fragments |
| `fragments.maxTokens` | int | `400` | Per-fragment token cap |
| `fragments.extractor` | `"deterministic"` | `"deterministic"` | Fragment extractor (only value today) |
| `pluginProviders` | `PluginConfig[]` | `[]` | External providers (RAG / graph / KB) |
| `stages.<name>.budgetTokens` | int | per-stage | Override token budget for a specific stage |
| `stages.<name>.extraProviderIds` | `string[]` | `[]` | Extra provider IDs (e.g. plugin providers) to run on this stage |
| `stages.<name>.providerTimeoutMs` | int ≥1000 | — | Per-stage override of `providerTimeoutMs` |
| `session.retentionDays` | int | `7` | Days to keep completed session scratch before purging |
| `session.archiveOnFeatureArchive` | bool | `true` | Archive instead of delete on feature completion |
| `staleness.enabled` | bool | `true` | Detect and downweight old context.md entries |
| `staleness.maxStoryAge` | int | `10` | Entries older than N completed stories are stale |
| `staleness.scoreMultiplier` | 0–1 | `0.4` | Score multiplier applied to stale chunks |
| `providers.historyScope` | `"package" \| "repo"` | `"package"` | Git log scope |
| `providers.neighborScope` | `"package" \| "repo"` | `"package"` | Neighbor scan scope |
| `providers.sourceGlob` | string | derived from language | Reverse-dep scan glob |
| `providers.maxGlobFiles` | int | `500` | Reverse-dep scan cap per directory |
| `manifest.retentionDays` | int | unset | Purge manifests older than N days at run end |

---

### References

- [ADR-010 — Context Engine](../adr/ADR-010-context-engine.md) — decisions D1–D8
- [Architecture §24 — Context Engine & Constitution](../architecture/subsystems.md) — internals
- `src/config/schemas-context.ts` — canonical config schema (`ContextV2ConfigSchema`)
- `src/context/engine/stage-config.ts` — default providers + budgets per stage
- `src/context/engine/providers/plugin-loader.ts` — plugin validation rules
- [Agents guide](agents.md) — how agent fallback interacts with context rebuild

[Back to README](../../README.md)
