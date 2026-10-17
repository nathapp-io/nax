---
title: Hooks
description: Lifecycle hooks for notifications and CI triggers
---

## Hooks

Integrate notifications, CI triggers, or custom scripts via lifecycle hooks.

**Project hooks** (`.nax/hooks.json`):

```json
{
  "hooks": {
    "on-complete": {
      "command": "openclaw system event --text 'Feature done!'",
      "enabled": true
    },
    "on-pause": {
      "command": "bash hooks/notify.sh",
      "enabled": true
    }
  }
}
```

**Available events:**

| Event | Fires when |
|:------|:-----------|
| `on-start` | Run begins |
| `on-story-start` | A story starts processing |
| `on-story-complete` | A story passes all checks |
| `on-story-fail` | A story exhausts all retry attempts |
| `on-pause` | Run paused (awaiting human input) |
| `on-resume` | Run resumed after pause |
| `on-session-end` | An agent session ends (per-session teardown) |
| `on-all-stories-complete` | All stories passed — regression gate pending *(v0.34.0)* |
| `on-final-regression-fail` | Deferred regression failed after rectification *(v0.34.0)* |
| `on-workflow-start` | The feature workflow begins (workflow mode) |
| `on-workflow-step` | Each feature-workflow step begins, the starting step included |
| `on-workflow-publish` | The feature workflow finished publishing |
| `on-complete` | The run finished: fires after the end phase (finish or the feature workflow), with whole-run cost |
| `on-error` | Unhandled error terminates the run |
| `on-post-run-action` | A post-run plugin action succeeds, fails, skips, or throws |

> **Note (workflow mode):** Workflow mode, the default since 0.88.0, runs inside the same story executor: the story pipeline becomes `queue-check -> routing -> constitution -> context -> workflow -> completion` (`getWorkflowPipeline()` in `src/pipeline/stages/index.ts`). The run and story events come from that shared executor (`run:started` in `src/execution/unified-executor.ts`, `story:started` in `src/execution/unified-executor-dispatch-phases.ts`, `story:completed` in the completion stage, `story:failed` in `src/execution/pipeline-result-handler.ts`, `run:completed` in `src/execution/lifecycle/run-completion-phases.ts`), so the hooks subscribed in `src/pipeline/subscribers/hooks.ts` fire in both modes. The steps inside a workflow story (implement, review, fix rounds) emit no hook events of their own; the feature workflow does — `on-workflow-start`, `on-workflow-step` and `on-workflow-publish` map the `workflow:started`, `workflow:step` and `workflow:published` events emitted in `src/workflow/feature.ts` and `src/workflow/feature-env.ts`.

**Hook lifecycle:**

```
on-start
  └─ on-story-start → on-story-complete (or on-story-fail)   ← per story
       └─ on-all-stories-complete                            ← all stories done
            └─ deferred regression gate (if enabled)
                 └─ on-final-regression-fail                 ← if regression fails
  └─ end phase
       ├─ workflow mode (the default):
       │    on-workflow-start                                ← the feature workflow begins
       │      └─ on-workflow-step                            ← its starting step
       │           └─ on-workflow-step (×N)                  ← every further step
       │                └─ on-workflow-publish               ← publish finished
       └─ pipeline mode:
            finish
  └─ on-complete                                             ← after the end phase, both modes
       └─ on-post-run-action                                 ← once per action during cleanup
```

Each hook receives context via `NAX_*` environment variables and full JSON on stdin.

**Hook definition fields:** `command` (required), `enabled` (default `true`), and `timeout` in ms (default `5000`; on expiry the process group gets SIGTERM, then SIGKILL after a 5 s grace).

**Commands run in argv mode, not through a shell.** The command string is split into argv and spawned directly, so `|`, `;`, `&&`, `>` and `$VAR` are passed as literal arguments (nax logs a warning when it sees them). Wrap anything that needs shell features in a script, as in the `bash hooks/notify.sh` example above. Commands containing `$(...)`, backticks, or a pipe into `bash` are refused outright. The hook's environment is the filtered agent allow-list plus the `NAX_*` variables below, not your full shell environment.

**Environment variables passed to hooks:**

| Variable | Description |
|:---------|:------------|
| `NAX_EVENT` | Event name (e.g., `on-story-complete`) |
| `NAX_FEATURE` | Feature name |
| `NAX_STORY_ID` | Current story ID (if applicable) |
| `NAX_STATUS` | Status (`pass`, `fail`, `paused`, `error`; `complete` or `failed` for `on-complete`) |
| `NAX_REASON` | Reason for pause or error; for `on-complete`, the end-phase reasons joined with `; ` |
| `NAX_COST` | Accumulated cost in USD |
| `NAX_MODEL` | Current model |
| `NAX_AGENT` | Current agent |
| `NAX_ITERATION` | Current iteration number |
| `NAX_PLUGIN_NAME` | Plugin that owns the settled post-run action |
| `NAX_ACTION_NAME` | Settled post-run action name |
| `NAX_RESULT_URL` | URL returned by the action, or the PR the end phase opened (`on-complete`) / the PR the feature workflow published (`on-workflow-publish`), when present |
| `NAX_STEP` | Feature-workflow step the event names (`on-workflow-start`, `on-workflow-step`) |
| `NAX_CI` | CI state the feature workflow finished with (`on-workflow-publish`) |

For `on-post-run-action`, `NAX_STATUS` is one of `succeeded`, `failed`, `skipped`, or `error`. `NAX_REASON`
contains the action message, skip reason, or thrown error. The hook is non-blocking and fires exactly once for every
registered action, including actions whose `shouldRun()` returns `false`.

For `on-complete`, the hook fires once, after the end phase, so `NAX_COST` is the whole-run cost (the finish or feature workflow spend included). `NAX_STATUS` is `complete`, or `failed` when the feature workflow did not pass. On a failed workflow `NAX_REASON` carries the reasons joined with `; `; `NAX_RESULT_URL` carries the PR when one was opened. Neither variable is set when there is nothing to report, nor when an earlier step of the completion phase failed before the end phase closed.

The feature workflow (workflow mode) reports itself through three hooks. `on-workflow-start` fires once when it begins, with `NAX_STATUS` `running` and `NAX_STEP` naming the step it starts at — `repo-gates` on a fresh run, or the step an interrupted record resumes at. `on-workflow-step` then fires as each step begins, the starting step included, with `NAX_STEP` and no `NAX_STATUS`: a step hook says where the workflow is, not how the step went (so a step the cost limit then skips still fires it). `on-workflow-publish` fires once publish finishes, with `NAX_STATUS` set to its outcome (`ready`, `draft`, `pushed` or `local-only`), `NAX_CI` when the run knows the CI state, and `NAX_REASON` / `NAX_RESULT_URL` only when there is something to report — a local-only publish with no forge carries neither. These hooks fire in workflow mode only, and the `on-complete` that follows always postdates them.

**Global vs project hooks:** Global hooks (`~/.nax/hooks.json`) fire alongside project hooks. Set `"skipGlobal": true` in your project `hooks.json` to disable global hooks.
