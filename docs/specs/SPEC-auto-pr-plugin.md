# SPEC: Built-in `auto-pr` Post-Run Action Plugin

## Summary

A built-in `IPostRunAction` plugin that, after an **unattended** `nax run` completes with
every story passing, opens a **draft** pull request (GitHub) or merge request (GitLab) for the
feature branch. It surfaces completed work without a human present and is deliberately *not* a
substitute for the `nax-finish` skill: it performs no review, triage, or quality-gating. The
two compose — this plugin drops a tracked draft with the repo's PR/MR template left unfilled;
`nax-finish` later reviews, gates, fills the checklist, and flips the draft to ready.

## Motivation

nax's `README.md:181` advertises "auto-PR creation" as the example `IPostRunAction`, and the
extension seam is fully wired (`run-cleanup.ts:146` already drives `getPostRunActions()` →
`shouldRun` → `execute` on every run), but **no plugin ships**. Unattended / headless /
scheduled runs — the default posture of this workspace — have no way to surface a completed
feature; the operator only learns of success by inspecting logs. `nax-finish` covers the
supervised path but requires a human. This plugin fills the documented gap for the unattended
path while preserving `nax-finish` as the assurance gate.

## Design

### Integration (extending existing code)

Verified integration points (signatures confirmed against the current tree):

- **`IPostRunAction`** — `src/plugins/extensions.ts` (re-exported from `src/plugins/types.ts`):
  `{ name: string; description: string; shouldRun(ctx): Promise<boolean>; execute(ctx): Promise<PostRunActionResult> }`.
- **`PostRunContext`** — fields consumed: `branch`, `feature`, `workdir`, `prdPath`,
  `totalCost`, `totalDurationMs`, `storySummary { completed, failed, skipped, paused }`,
  `stories` (`UserStory[]`), `config` (typed `unknown` — read loosely), `logger`
  (`PluginLogger`, write-only).
- **`PostRunActionResult`** — `{ success: boolean; message: string; url?: string; skipped?: boolean; reason?: string }`.
- **`NaxPlugin`** — `{ name, version, provides: ["post-run-action"], setup, teardown, extensions: { postRunAction } }`.
- **Precedent to mirror:** `src/plugins/builtin/curator/index.ts` — the one existing built-in
  plugin implementing `IPostRunAction` (`curatorAction` at :70, `curatorPlugin` at :128). It
  reads its config loosely off `ctx.config.curator` (`:32-39`) and returns a failure result
  (never throws) on error (`:115-121`). This plugin follows the same shape.
- **Registration:** `src/plugins/loader.ts` registers `curatorPlugin` at :114-123 (skips when
  disabled). The new `autoPrPlugin` is registered the same way.
- **Config:** top-level plugin config keys live beside `curator: CuratorConfigSchema.optional()`
  at `src/config/schemas.ts:413`. `autoPr` is added as a sibling top-level key. It is **not**
  wired into `mergePackageConfig` (`src/config/merge.ts:34`) — that function merges only
  per-package `execution.*` fields (`flakeDetection`, `mutationCheck`), and PR creation is a
  repo-level, once-per-run action with no per-package variation.

### Approach

Deterministic and dependency-injected. The plugin shells out to the `gh` / `glab` CLIs
through an injected runner (`_deps` per `forbidden-patterns.md`) — no LLM calls, no network
library. Pure string/fs logic (title, body, template discovery) lives in separate modules with
no I/O so they unit-test without spawning anything.

Module layout under `src/plugins/builtin/auto-pr/`:

| File | Concern | I/O |
|:-----|:--------|:----|
| `types.ts` | `AutoPrConfig`, `ForgeKind`, `AutoPrDeps` | none |
| `pr-body.ts` | `buildTitle(ctx)`, `buildBody(ctx, template)` | none (pure) |
| `template.ts` | `findPrTemplate(workdir, forge, deps)` | fs via injected `deps.readText` |
| `forge.ts` | `detectForge(remoteUrl)`, `hasOpenPr(...)`, `openDraft(...)` | subprocess via injected `deps.run` |
| `index.ts` | `autoPrPlugin` + `shouldRun` / `execute` wiring the above | orchestration only |

```ts
interface AutoPrDeps {
  run(cmd: string[], opts: { cwd: string }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  readText(path: string): Promise<string | null>;
}
```

Default `AutoPrDeps` uses `Bun.spawn` and `Bun.file()` (Bun-native only). Tests inject fakes.

### PR/MR body (generated markdown example)

`buildBody(ctx, template)` produces, for a run with template present:

```
> Auto-opened by nax — review pending. Run nax-finish before merge.

## Run summary
- Feature: auto-pr-plugin
- Stories: 4 passed / 0 failed / 0 skipped
- Cost: $0.42 · Duration: 3m 12s
- PRD: .nax/features/auto-pr-plugin/prd.json

| Story | Title | ACs |
|-------|-------|-----|
| US-001 | Config foundation | 4 |
| ...    | ...               | .. |

---
## Checklist
- [ ] Tests pass
- [ ] ...
```

When `template` is `null`, the body is the banner + run summary only (no `---` separator, no
template block).

### Template discovery (`findPrTemplate`)

Preserve-not-fill. Returns the first match or `null`:

- **GitHub:** `.github/PULL_REQUEST_TEMPLATE.md`, `.github/pull_request_template.md`,
  `PULL_REQUEST_TEMPLATE.md`, `docs/PULL_REQUEST_TEMPLATE.md` (first found, in that order).
- **GitLab:** `.gitlab/merge_request_templates/Default.md`, else the first `*.md` under
  `.gitlab/merge_request_templates/`.
- **Multi-template dirs** (`.github/PULL_REQUEST_TEMPLATE/`): skipped (too ambiguous
  unattended) → `null`.

Rationale: passing `--body` / `--description` to `gh` / `glab` suppresses the repo's default
template, so the plugin must read and re-embed it verbatim or the checklist silently vanishes.

### Failure Handling

Fail-open — a failed PR open never fails the run (the run already succeeded before the
post-run action fires; `run-cleanup.ts` wraps every action in try/catch as a non-blocking
warning).

- Missing `gh` / `glab` binary or non-zero forge exit → `execute` returns
  `{ success: false, message }` (recoverable; logged as a warning). No throw.
- Unknown forge host or an already-open PR → `shouldRun` returns `false` (clean skip).
- Logs use `ctx.logger` (write-only `PluginLogger`); no `console.*`, no emojis in log strings.

## Stories

Single-package repo (no workspaces) → no `Workdir`. 4 stories.

- **US-001 — Config foundation.** Add the top-level `autoPr` config with defaults.
  *Depends on:* nothing. *Creates:* none (modifies `src/config/schemas.ts`).
- **US-002 — Pure builders.** `pr-body.ts` (`buildTitle` / `buildBody`) + `template.ts`
  (`findPrTemplate`) + `types.ts`. *Depends on:* nothing. *Creates:*
  `src/plugins/builtin/auto-pr/{types,pr-body,template}.ts`.
- **US-003 — Forge adapter.** `forge.ts` — `detectForge` / `hasOpenPr` / `openDraft` via
  injected runner. *Depends on:* US-002 (`types.ts`). *Creates:*
  `src/plugins/builtin/auto-pr/forge.ts`.
- **US-004 — Plugin assembly + registration.** `index.ts` (`autoPrPlugin`, `shouldRun`,
  `execute`) wiring config + builders + forge, registered in `loader.ts`. *Depends on:*
  US-001, US-002, US-003. *Creates:* `src/plugins/builtin/auto-pr/index.ts`.

### Seams

- **US-002 → US-004:** `buildTitle` / `buildBody` / `findPrTemplate` are consumed by
  `execute`. US-004 AC-8 stubs `openDraft` and asserts `execute` passes it the `buildTitle`
  title and `buildBody` body — proving the builders and the forge call are wired, not just
  present. `findPrTemplate` is exercised on the same happy path (its result feeds `buildBody`),
  so AC-8 also proves the template lookup runs in the production caller.
- **US-003 → US-004:** `openDraft` / `hasOpenPr` / `detectForge` are consumed by
  `execute` / `shouldRun`. US-004 AC-5/AC-6/AC-8/AC-9 stub these and assert the production
  path invokes them with the expected arguments.
- **US-004 → loader:** `autoPrPlugin` becomes discoverable via
  `pluginRegistry.getPostRunActions()` after `loadPlugins`. US-004 AC-10 asserts this.

## Acceptance Criteria

### US-001 — Config foundation

1. `[unit]` `NaxConfigSchema.parse({})` yields `config.autoPr.enabled === false` (opt-in default).
2. `[unit]` `NaxConfigSchema.parse({})` yields `config.autoPr.draft === true` (draft-by-default).
3. `[unit]` `NaxConfigSchema.parse({ autoPr: { enabled: true } })` yields `autoPr.enabled === true` and `autoPr.draft === true` (an unspecified `draft` resolves to its default).
4. `[unit]` `NaxConfigSchema.safeParse({ autoPr: { enabled: "yes" } }).success === false` (a non-boolean `enabled` is rejected at parse time).

### US-002 — Pure builders

1. `[unit]` `buildTitle` for a context whose `feature` is `"auto-pr-plugin"` returns `"feat: auto-pr-plugin"`.
2. `[unit]` `buildBody(ctx, null)` returns a string that includes a review-pending banner referencing `nax-finish`.
3. `[unit]` `buildBody(ctx, null)` returns markdown whose story table has exactly `ctx.stories.length` rows (one per story).
4. `[unit]` `buildBody(ctx, null)` for a `storySummary` of `{ completed: 3, failed: 0, skipped: 1, paused: 0 }` returns a string that reports `3 passed` and `1 skipped`.
5. `[unit]` `buildBody(ctx, "## Checklist\n- [ ] x")` returns a string ending with the template text verbatim, preceded by a `---` separator.
6. `[unit]` `buildBody(ctx, null)` returns a body with no `---` template separator (banner + run summary only).
7. `[unit]` `findPrTemplate(workdir, "github", deps)` returns the file contents when `deps.readText` resolves `.github/pull_request_template.md`.
8. `[unit]` `findPrTemplate(workdir, "github", deps)` returns the `.github/PULL_REQUEST_TEMPLATE.md` contents when both it and `docs/PULL_REQUEST_TEMPLATE.md` resolve (path precedence).
9. `[unit]` `findPrTemplate(workdir, "gitlab", deps)` returns the `.gitlab/merge_request_templates/Default.md` contents when `deps.readText` resolves it.
10. `[unit]` `findPrTemplate(workdir, "github", deps)` returns `null` when `deps.readText` resolves no template path.

### US-003 — Forge adapter

1. `[unit]` `detectForge("git@github.com:owner/repo.git")` returns `"github"`.
2. `[unit]` `detectForge("https://gitlab.com/owner/repo.git")` returns `"gitlab"`.
3. `[unit]` `detectForge("https://example.com/owner/repo.git")` returns `null` (unknown host).
4. `[unit]` `openDraft` for a `github` forge with `draft: true` invokes the injected runner with an argv beginning `["gh", "pr", "create", "--draft", ...]` and the branch supplied via `--head`.
5. `[unit]` `openDraft` for a `gitlab` forge with `draft: true` invokes the injected runner with an argv beginning `["glab", "mr", "create", "--draft", ...]` and the branch supplied via `--source-branch`.
6. `[unit]` `openDraft` with `draft: false` invokes the runner with an argv that omits `--draft` (ready-for-review).
7. `[unit]` `openDraft` returns a result carrying the PR URL parsed from the runner `stdout` when the runner `exitCode` is `0`.
8. `[unit]` `openDraft` returns a result with `success === false` when the runner `exitCode` is non-zero.
9. `[unit]` `hasOpenPr` returns `true` when the injected list runner returns a non-empty JSON array for the branch.
10. `[unit]` `hasOpenPr` returns `false` when the injected list runner returns an empty JSON array.

### US-004 — Plugin assembly + registration

1. `[unit]` `autoPrPlugin`'s `shouldRun` returns `false` when `ctx.config.autoPr.enabled` is `false`.
2. `[unit]` `shouldRun` returns `false` when `ctx.storySummary.failed` is greater than `0`.
3. `[unit]` `shouldRun` returns `false` when `ctx.storySummary.paused` is greater than `0`.
4. `[unit]` `shouldRun` returns `false` when `ctx.storySummary.completed` is `0`.
5. `[unit]` `shouldRun` returns `false` when the injected runner reports a remote whose host resolves to no forge (`detectForge` → `null`).
6. `[unit]` `shouldRun` returns `false` when `hasOpenPr` reports an existing open PR for the branch (idempotency skip), with the reason logged.
7. `[unit]` `shouldRun` returns `true` when the plugin is enabled, every story passed, a forge is detected, and no open PR exists.
8. `[integration]` `execute` on the happy path invokes the injected `openDraft` with the `buildTitle` title and the `buildBody` body, and returns a `PostRunActionResult` with `success === true` and the created PR `url`.
9. `[integration]` `execute` returns `{ success: false }` (and does not throw) when the injected `openDraft` reports a non-zero forge failure.
10. `[integration]` the `PluginRegistry` returned by `loadPlugins` (with `"nax-auto-pr"` not in the disabled set) yields an action named `"nax-auto-pr"` from `getPostRunActions()`.

<!-- spec-writing: completed-through-phase-6 -->
