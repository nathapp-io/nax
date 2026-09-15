# Per-package config in the agent loop — design

**Date:** 2026-09-15
**Issues:** [#2066](https://github.com/nathapp-io/nax/issues/2066), [#2069](https://github.com/nathapp-io/nax/issues/2069)
**Version analysed:** `v0.82.0-canary.14` (`63c4c3363`)

## Problem

In a monorepo, a story whose `workdir` resolves to a package gets file tools rooted at that package,
but its `RunCommand` declared-command map comes from the **root** `.nax/config.json`. The agent calls
`testScoped` and gets the root's toolchain against the package's test paths, every time.

Two independent defects produce this, and they compose.

### Defect A — `callOp` reaches past the pipeline for its config (#2066)

`src/operations/call.ts:83`:

```ts
const config = ctx.runtime.configLoader.current();   // the ROOT config, always
```

That value becomes `runOptions.config` (`call.ts:242`) and `hopCtx.config` (`call.ts:274`).
`resolveCodingToolSupport` builds the declared-command map straight off it
(`src/agents/coding-tool-support.ts:286`). Both dispatch hops — `runtime/session-run-hop.ts:63` and
`operations/build-hop-callback.ts:321` — take their options from that one object, so there is exactly
one fix point.

Two lines below, `call.ts:254` does `codingToolRoot: packageWorkdir(ctx.packageView)` — package-correct.
That asymmetry is the reported symptom.

The package-resolved config **already exists and is already on the context**. `PipelineContext` carries
both (`execution/iteration-runner.ts:174-176`, `execution/parallel-batch.ts:210/217`):

```ts
config: effectiveConfig,   // loadConfigForWorkdir(root, story.workdir, profileOverride)
rootConfig: ctx.config,
```

`CallContext` (`pipeline/stages/execution.ts:102`) carries `runtime`, `packageView`, `packageDir` — but
**no config field**, so `callOp` falls back to the loader. It is a missing field, not a broken resolver.

Corroboration that the live map was root and not merged: `mergePackageConfig` merges `quality.commands`
as a shallow union (`config/merge.ts`), so a correctly merged map for a package would carry **both** its
own keys and the root's. The observed map carried root-only keys and lacked the package's own.

### Defect B — the registry misses every override under worktrees (#2069)

`hydrate()` stores **relative** package keys (`apps/web-ui`), from `discoverWorkspacePackages`
(`context/generator/index.ts:201-226`). `resolve()` derives its key with `relative(repoRoot, packageDir)`
(`runtime/packages.ts:93-101`), where `repoRoot` is the project dir the registry was constructed with
(`runtime/index.ts:425`).

Under worktree isolation the workdir is `<repoRoot>/.nax-wt/<storyId>/<pkg>` (`worktree/manager.ts:122`,
`parallel-worker.ts:72`, `iteration-runner.ts:166-172`), so:

```
hydrate stored:  "apps/web-ui"
resolve derives: ".nax-wt/<storyId>/apps/web-ui"   -> MISS
                 -> hasOverride: false, config: ROOT
```

It fails silently: the registry's "returning root config" warning is guarded on `!hydrated`, and
hydration has run.

**Parallel execution is not opt-in to this.** `runParallelBatch` creates a worktree for every story with
no `storyIsolation` check (`parallel-batch.ts:144,163`), while `storyIsolation` itself defaults to
`"shared"` (`schemas-execution.ts:272`).

Consequence beyond the root-config fallback: the gates' cwd rule keys off `hasOverride`
(`operations/lint-check.ts:117-122`, same shape in `typecheck-check`, `verify-scoped`, `full-suite-gate`),
so a forced `false` sends them to `packageView.repoRoot` — the **main checkout**, not the worktree.

## Why B must be fixed first

The idiomatic fix for A is `ctx.packageView.config`, consistent with every deterministic op and with the
convention pinned at `test/unit/operations/quality-gate-packageview.test.ts:128`. Under B that returns the
root config silently, so an A-fix routed through `packageView` would be inert in exactly the isolation
modes where it matters most. Fix B, then A can use either source; this design uses `ctx.config` because it
is keyed off `story.workdir` and is correct in all modes regardless of B.

## Scope decision — permission movement (ruled 2026-09-15)

`mergePackageConfig` spreads `execution` wholesale, and `resolvePermissions` reads
`execution.permissionProfile` (`config/permissions.ts:227`) and `execution.permissions.<stage>`
(`stageRules`, `config/permissions.ts:201-209`). So threading the effective config **moves permission
resolution** for any repo with those keys in an overlay.

This is intended, not incidental. `agents/manager.ts:466` already carries:

```ts
// SEC-3: per-package permissionProfile (monorepo). Per plan §3.3 Note: needs full NaxConfig.
const resolvedPermissions = resolvePermissions(opts.config ?? this._config, stage);
```

Per-package permission scoping was deliberately wired and is inert today for exactly the reason this
design exists. **Ruling: thread the full config** (`CallContext.config` → `runOptions.config`), completing
SEC-3, and ship a release note. Moving with it: `execution.denyPaths`, `models` at dispatch
(`call.ts:88`), and `agent.native.transportRetry` / `execution.compaction`
(`session/turn-config-selection.ts:39-46`).

## Explicitly out of scope

**Working-directory provenance.** `run-command.ts` runs every declared command at `ctx.root` (the package
workdir), while the gates use a `hasOverride` rule. After this change an inherited root command still runs
in the package dir. That is **unchanged from today**, so it is not a regression; it also changes the
`RunCommand` cwd == containment-root invariant and needs per-key provenance that `merge.ts`'s shallow
spread destroys. Separate decision, separate change.

**Language-aware command inheritance.** A TypeScript package still inherits a root Python `formatFix`
unless it overrides the key. Follow-up question, not this change.

## In scope

1. `#2069` — worktree-aware key derivation in the registry, plus a loud warning when `resolve()` returns
   root config for an unknown non-empty key.
2. `#2066` — `CallContext.config`, populated from `PipelineContext.config`, consumed at `call.ts:83`.
3. `target` rejected on `RunCommand`'s declared-command branch (48/136 calls in the audited run carried a
   `target` that `run-command.ts` never reads; silently ignoring it teaches the model nothing).
4. One dispatch log line naming the resolved permission profile and declared-command keys, so this class
   of defect is visible in run artifacts instead of requiring a transcript audit.

## Constraints

- `src/operations/call.ts` is at **597/600 lines** (`scripts/check-file-sizes.ts`, `SRC_LIMIT = 600`).
  The `call.ts` change must be a net-zero substitution.
- Every `logger.{info,warn,error,debug}` call in scoped dirs must pass a data object whose **first key is
  `storyId`** (`scripts/check-logger-storyid.ts`, ratchet).
- `bun run test` / `bun run lint` / `bun run typecheck` — never bare `bun test`.
