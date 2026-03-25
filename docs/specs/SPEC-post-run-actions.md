# SPEC: Post-Run Actions Extension Point

**Status:** Draft
**Date:** 2026-03-25
**Author:** Nax Dev
**Workitem:** PLUGIN-001

---

## Summary

Add `IPostRunAction` as the 7th plugin extension point in nax. Post-run actions execute after a run completes and produce results — unlike `IReporter` which is fire-and-forget observability.

## Motivation

nax's plugin system has 6 extension points: optimizer, router, agent, reviewer, context-provider, reporter. All are either mid-pipeline (optimizer, router, context-provider, reviewer) or observability (reporter).

There's no extension point for **actions that should happen after a run completes** — creating a PR, updating a Jira ticket, triggering a downstream CI pipeline, sending a Slack summary with actionable links. These need:

- Pre-flight checks (`shouldRun`) — e.g., is `gh` CLI installed? Did all stories pass?
- Return values — PR URL, ticket ID, success/failure
- Conditional skip — PR already exists, branch not pushed yet

`IReporter.onRunEnd()` is wrong for this because it's fire-and-forget with no return value, and failures are silently swallowed.

## Interface

```typescript
// src/plugins/extensions.ts

/**
 * Post-run action — executes after a successful run completes.
 *
 * Unlike IReporter (fire-and-forget observability), post-run actions
 * produce results and can be conditionally skipped. They run sequentially
 * after all reporters have fired.
 *
 * Use cases: create PR/MR, update issue tracker, trigger CI, send summary.
 */
export interface IPostRunAction {
  /** Action name (e.g., "github-pr", "gitlab-mr", "jira-update") */
  name: string;

  /** Human-readable description */
  description: string;

  /**
   * Pre-flight check — should this action run?
   * Called before execute(). Return false to skip gracefully.
   *
   * Examples: all stories passed, CLI tool installed, no existing PR.
   */
  shouldRun(context: PostRunContext): Promise<boolean>;

  /**
   * Execute the post-run action.
   * Only called if shouldRun() returned true.
   */
  execute(context: PostRunContext): Promise<PostRunActionResult>;
}

/**
 * Context passed to post-run actions.
 */
export interface PostRunContext {
  /** Run ID */
  runId: string;
  /** Feature name */
  feature: string;
  /** Project working directory */
  workdir: string;
  /** Path to prd.json */
  prdPath: string;
  /** Current git branch */
  branch: string;
  /** Run duration in ms */
  totalDurationMs: number;
  /** Total cost in USD */
  totalCost: number;
  /** Story completion summary */
  storySummary: {
    completed: number;
    failed: number;
    skipped: number;
    paused: number;
  };
  /** All story results with IDs, titles, and statuses */
  stories: Array<{
    id: string;
    title: string;
    status: string;
    cost: number;
  }>;
  /** nax version */
  version: string;
  /** Plugin-specific config from nax config.json */
  pluginConfig: Record<string, unknown>;
  /** Logger instance */
  logger: PluginLogger;
}

/**
 * Result from a post-run action.
 */
export interface PostRunActionResult {
  /** Whether the action succeeded */
  success: boolean;
  /** Human-readable result message (e.g., "PR #42 created") */
  message: string;
  /** URL of created resource (PR, MR, ticket) */
  url?: string;
  /** True if action chose to skip (e.g., PR already exists) */
  skipped?: boolean;
  /** Reason for skip or failure */
  reason?: string;
}
```

## Changes Required

### 1. `src/plugins/extensions.ts`
- Add `IPostRunAction`, `PostRunContext`, `PostRunActionResult` interfaces
- Export from barrel

### 2. `src/plugins/types.ts`
- Add `"post-run-action"` to `PluginType` union
- Add `postRunAction?: IPostRunAction` to `PluginExtensions`
- Re-export new types

### 3. `src/plugins/registry.ts`
- Add `getPostRunActions(): IPostRunAction[]` method
- Collect post-run actions during plugin registration

### 4. `src/plugins/validator.ts`
- Add validation for `post-run-action` extension (must have `name`, `shouldRun`, `execute`)

### 5. `src/execution/runner.ts`
- Build `PostRunContext` from run result after all stories complete
- Loop through post-run actions after reporters fire, before teardown
- Error-tolerant: catch and log failures, never block run completion

### Runner Integration

```typescript
// After reporters.onRunEnd(), before teardown
for (const action of registry.getPostRunActions()) {
  try {
    const ctx = buildPostRunContext(runResult, feature, workdir);
    if (await action.shouldRun(ctx)) {
      const result = await action.execute(ctx);
      if (result.success && result.url) {
        logger.info(`[post-run] ${action.name}: ${result.message}`, { url: result.url });
      } else if (result.skipped) {
        logger.info(`[post-run] ${action.name}: skipped — ${result.reason}`);
      } else {
        logger.warn(`[post-run] ${action.name}: failed — ${result.message}`);
      }
    } else {
      logger.debug(`[post-run] ${action.name}: shouldRun=false, skipping`);
    }
  } catch (err) {
    logger.warn(`[post-run] ${action.name}: error — ${errorMessage(err)}`);
  }
}
```

## Stories

| ID | Title | Complexity |
|:---|:------|:-----------|
| PLUGIN-001-A | `IPostRunAction` types + `PluginType` registration | Simple |
| PLUGIN-001-B | Registry support — `getPostRunActions()` + validator | Simple |
| PLUGIN-001-C | Runner integration — `buildPostRunContext()` + action loop | Medium |
| PLUGIN-001-D | Unit + integration tests | Medium |

## Testing Strategy

- **Unit:** Verify registry collects and returns post-run actions
- **Unit:** Verify validator rejects invalid post-run action plugins
- **Integration:** Mock plugin with `shouldRun → true`, verify `execute` called with correct context
- **Integration:** Mock plugin with `shouldRun → false`, verify `execute` NOT called
- **Integration:** Mock plugin that throws in `execute`, verify run still completes
- **Integration:** Multiple post-run actions run sequentially in registration order

## Acceptance Criteria

- [ ] `IPostRunAction` interface defined and exported from plugin types
- [ ] Plugins declaring `provides: ["post-run-action"]` are loaded and registered
- [ ] `shouldRun()` is called before `execute()` — skip if false
- [ ] `execute()` result is logged (success, skipped, or failed)
- [ ] Errors in post-run actions never block run completion
- [ ] `PostRunContext` includes feature, workdir, prdPath, branch, stories, cost
- [ ] Multiple post-run actions run sequentially
- [ ] Existing plugins (reporter, reviewer, etc.) are unaffected

---

*Spec by Nax Dev, 2026-03-25*
