# Design — Built-in `auto-pr` Post-Run Action Plugin

**Date:** 2026-07-05
**Status:** design (pre-spec)
**Source:** `nax-feature-suggestions-2026-07-04.md` §3 (cheap wins — bundled auto-PR post-run action) + README claim (`README.md:181`) that ships no plugin.
**Branch:** `feat/auto-pr-plugin`

---

## 1. Purpose & Boundary

A **built-in** `IPostRunAction` plugin that, after an **unattended** `nax run` completes
successfully, opens a **draft** PR (GitHub) or MR (GitLab) for the feature branch, so the
work is tracked and visible without a human present.

**Explicit non-goal:** it is *not* a substitute for the `nax-finish` skill. It performs **no**
review, triage, or quality-gating. The two **compose**:

- `auto-pr` (this plugin) — unattended: opens a tracked *draft* with an unfilled template.
- `nax-finish` (existing skill) — supervised: runs post-impl-review + quality gates, fills
  the template checklist, and flips the draft to ready.

This keeps `nax-finish` the assurance gate and makes `auto-pr` purely a "surface the branch"
convenience for headless/scheduled runs.

---

## 2. Architecture

Mirrors the one existing built-in plugin, `src/plugins/builtin/curator/`, which already
implements `IPostRunAction` (`src/plugins/builtin/curator/index.ts:70`).

```
src/plugins/builtin/auto-pr/
  index.ts    — NaxPlugin wrapper + IPostRunAction (name, description, shouldRun, execute)
  forge.ts    — detectForge(remoteUrl) -> "github" | "gitlab" | null;
                openDraft(...) + hasOpenPr(...) via injected command runner (_deps)
  template.ts — findPrTemplate(workdir, forge) -> string | null  (pure fs read)
  pr-body.ts  — buildTitle(ctx) + buildBody(ctx, template) (pure string builders)
  types.ts    — AutoPrConfig, ForgeKind, AutoPrDeps
src/plugins/loader.ts        — register autoPrPlugin like curatorPlugin (skip when disabled)
src/config/schemas.ts (+ execution schema) — AutoPrConfigSchema with defaults; wire into root
src/config/merge.ts          — deep-merge the autoPr section (mirrors flakeDetection/mutationCheck)
```

Every file stays well under the 600-line limit and has one concern. `pr-body.ts` and
`template.ts` are pure; `forge.ts` shells out only through an injected runner so it is unit
testable without touching git.

### 2.1 Interfaces consumed (all verified real)

- `IPostRunAction` / `PostRunContext` / `PostRunActionResult` / `PluginLogger` / `NaxPlugin`
  — `src/plugins/types.ts` (barrel), shapes in `src/plugins/extensions.ts`.
- `PostRunContext` fields used: `branch`, `feature`, `workdir`, `prdPath`, `totalCost`,
  `totalDurationMs`, `storySummary {completed, failed, skipped, paused}`, `stories`
  (`UserStory[]`), `config` (`unknown`), `logger` (`PluginLogger`, write-only).
- Registration site: `src/plugins/loader.ts` (curator is registered at :114-123).
- Invocation: already wired — `run-cleanup.ts:146` calls `getPostRunActions()` →
  `shouldRun` → `execute`, wrapping every action in try/catch as a non-blocking warning.

---

## 3. Dependency Injection (`_deps`)

Per `forbidden-patterns.md`, all external calls go through an injected `_deps` object so
tests never spawn git or read the real filesystem.

```ts
interface AutoPrDeps {
  // Bun.spawn wrapper: returns { exitCode, stdout, stderr }
  run(cmd: string[], opts: { cwd: string }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  // Bun.file() wrapper: returns file text or null if absent
  readText(path: string): Promise<string | null>;
}
```

Default `_deps` uses `Bun.spawn` and `Bun.file()` (Bun-native only — no Node `child_process`
or `fs`). Tests pass a fake runner asserting argv and returning canned output.

---

## 4. Behaviour

### 4.1 `shouldRun(ctx)` — the safety gate

Returns `true` only when **all** hold; otherwise returns `false` (logs the reason at debug/warn):

1. `config.autoPr.enabled === true` (default `false` — opt-in).
2. `storySummary.failed === 0 && storySummary.paused === 0 && storySummary.completed > 0`
   — every story genuinely passed. Never open on a partial or failed run.
3. `detectForge(remoteUrl) !== null` — `git remote get-url origin` maps to github/gitlab.
   Unknown host (e.g. self-hosted) → warn + skip (documented limitation; extensible later).
4. **Idempotency:** no existing open PR/MR for `ctx.branch`
   (`gh pr list --head <branch> --state open` / `glab mr list --source-branch <branch>`).
   If one exists, skip and log its URL.

Config is read loosely off `ctx.config` (typed `unknown`) via a small `getAutoPrConfig(ctx)`
helper, exactly as curator reads `ctx.config.curator` (`curator/index.ts:32-39`).

### 4.2 `execute(ctx)`

1. `detectForge` → `github` | `gitlab`.
2. `template = findPrTemplate(ctx.workdir, forge)` (see §5).
3. `title = buildTitle(ctx)` → `feat: <feature>`.
4. `body = buildBody(ctx, template)` (see §6).
5. Open draft:
   - GitHub: `gh pr create --draft --title <title> --body-file <tmp> --head <branch>`
     (base omitted → gh defaults to the repo's default branch).
   - GitLab: `glab mr create --draft --title <title> --description <body> --source-branch <branch>`
     (target omitted → glab defaults to the default branch).
   - When `config.autoPr.draft === false`, drop `--draft` (open ready-for-review).
   - Body is passed via a temp file (written with `Bun.write`, cleaned up) to avoid argv
     length limits and shell-escaping of multi-line markdown.
6. Return `PostRunActionResult { success, message, url }` with the created PR/MR URL.

All failures are caught by the existing `run-cleanup.ts` wrapper and surface as a non-blocking
`[post-run] auto-pr: failed — …` warning; a failed PR open never fails the run.

---

## 5. PR/MR Template Handling

The plugin **preserves** the repo's template rather than filling it (filling is the
human+LLM job `nax-finish` does later). `findPrTemplate(workdir, forge)` is a pure fs read
returning the first match or `null`:

- **GitHub:** `.github/PULL_REQUEST_TEMPLATE.md`, `.github/pull_request_template.md`,
  `PULL_REQUEST_TEMPLATE.md`, `docs/PULL_REQUEST_TEMPLATE.md` (first found).
- **GitLab:** `.gitlab/merge_request_templates/Default.md`, else the first `*.md` in
  `.gitlab/merge_request_templates/`.
- **Multi-template dirs** (`.github/PULL_REQUEST_TEMPLATE/`): **skip + log** — too ambiguous
  to auto-pick unattended.
- **None found:** `null` → body is just the auto-summary section (graceful degradation).

Rationale: passing `--body`/`--description` to `gh`/`glab` *suppresses* the repo's default
template, so if we did not read and re-embed it the checklist would silently vanish. Embedding
it verbatim keeps the checklist intact for `nax-finish` to fill during review.

---

## 6. PR Body Composition (`pr-body.ts`, pure)

`buildBody(ctx, template)` produces:

```
> 🤖 Auto-opened by nax — review pending. Run `nax-finish` before merge.

## Run summary
- Feature: <feature>
- Stories: <completed> passed / <failed> failed / <skipped> skipped
- Cost: $<totalCost> · Duration: <totalDurationMs → m/s>
- PRD: <prdPath>

| Story | Title | ACs |
|-------|-------|-----|
| US-001 | … | 6 |
...

---
<repo template verbatim, unfilled — or omitted when template is null>
```

No emojis appear in *source*; the banner glyph lives only in generated PR markdown, which is
outward-facing content, not code (consistent with existing generated markdown like
`curator/render.ts`). Story rows are derived from `ctx.stories` (id, title, AC count).

---

## 7. Config

Added to the Zod schema as the SSOT (`config-patterns.md`), defaulting so it is opt-in and
never stripped:

```jsonc
// top-level, mirroring the curator plugin's config sibling
"autoPr": {
  "enabled": false,   // opt-in
  "draft": true       // draft by default; false = ready-for-review
}
```

`AutoPrConfigSchema` is defined in the execution/config schema and wired into
`NaxConfigSchema`; `src/config/merge.ts` deep-merges the `autoPr` section (same one-line
addition made for `flakeDetection` and `mutationCheck`). Placed **top-level** (not under
`execution`) to sit beside the existing plugin config key `curator`.

Per-package layering is **not** applicable — PR creation is a repo-level, once-per-run action,
so a single root-level config is correct (documented per the language-neutrality checklist).

---

## 8. Error Handling

- Missing `gh`/`glab` binary, or a non-zero exit from the forge command → return
  `{ success: false, message }` (recoverable; the run already succeeded). No throw.
- Unknown forge / existing PR → `shouldRun` returns false (clean skip, not an error).
- Only genuinely invalid internal state uses `NaxError` with a `stage: "post-run"` context;
  none is expected on the happy path.
- All logs use the write-only `ctx.logger` (PluginLogger) — no `console.*`, no emojis in log
  strings (`[OK]`/`[WARN]`/`->`).

---

## 9. Testing

- `pr-body.ts` — pure unit tests: body/title from a fixture `PostRunContext`, with and
  without a template; verifies banner, summary stats, story table, template embedding.
- `template.ts` — fake `readText`: each GitHub/GitLab path precedence, multi-template-dir
  skip, none-found → null.
- `forge.ts` — fake command runner: `detectForge` for github/gitlab/unknown remotes; correct
  `gh`/`glab` argv for draft vs ready; `hasOpenPr` true/false parsing.
- `index.ts` `shouldRun` — `test.each` over story-summary permutations (pass/fail/paused),
  disabled config, unknown forge, existing-PR idempotency skip.
- Registration + config-merge integration test mirroring the curator and mutation-check
  wiring (plugin loads when enabled, config deep-merges).
- Coverage stays ≥ 80% (enforced floor).

---

## 10. Scope Boundaries (YAGNI)

Explicitly **out** of this arc:

- Filling the template checklist (that is `nax-finish`).
- Flipping draft → ready (that is `nax-finish`).
- Self-hosted / enterprise forge host detection beyond github.com / gitlab.com host match.
- Base/target branch override config (rely on gh/glab default-branch behaviour).
- Auto-assigning reviewers, labels, or milestones.
- Example-plugin packaging (built-in only for this cut).

Each is a clean fast-follow if needed, and none blocks the core "open a tracked draft" value.
