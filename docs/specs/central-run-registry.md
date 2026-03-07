# Central Run Registry — Spec

**Version:** v0.23.0
**Status:** Planned

---

## Problem

nax stores run logs per-project at `<workdir>/nax/<feature>/runs/<timestamp>.jsonl`. There is no global index — you must `cd` into each project to see its run history. There is no way to answer "what has nax run across all my projects recently?"

## Goal

A global `~/.nax/runs/` registry that tracks every nax run across all projects — queryable from any directory via `nax runs`.

---

## Directory Structure

```
~/.nax/runs/
  <project>-<feature>-<runId>/
    status.json          ← run metadata (written on start, updated on end)
    events.jsonl -> <workdir>/nax/<feature>/runs/<timestamp>.jsonl  ← symlink
```

**runId:** `<timestamp-ms>` — unique, sortable, no UUID dependency.

**project:** derived from `workdir` basename or `nax/config.json` project name.

---

## status.json Schema

```json
{
  "runId": "1741325400000",
  "project": "my-app",
  "feature": "auth-system",
  "workdir": "/Users/william/projects/my-app",
  "startedAt": "2026-03-07T05:30:00.000Z",
  "completedAt": "2026-03-07T06:15:00.000Z",
  "status": "passed",
  "storiesTotal": 5,
  "storiesPassed": 5,
  "storiesFailed": 0,
  "durationMs": 2700000
}
```

**status values:** `running` | `passed` | `failed` | `interrupted`

Written twice:
1. On run **start** — `status: "running"`, no `completedAt`/duration
2. On run **end** — full fields populated

---

## Stories

### CRR-001: Registry Writer

- On `runner.ts` run start: create `~/.nax/runs/<project>-<feature>-<runId>/` + write `status.json` (status: running) + symlink to events.jsonl
- On run end (success/fail/SIGTERM): update `status.json` with final status + completedAt + durationMs
- New module: `src/execution/run-registry.ts` — `registerRunStart()`, `updateRunStatus()`
- Wire into `runner.ts` (two calls only — keep runner thin)

### CRR-002: `nax runs` CLI Command

```
nax runs                         # All runs, newest first (default: last 20)
nax runs --project my-app        # Filter by project name
nax runs --last 50               # Show last N runs
nax runs --status failed         # Filter by status
```

Output table: RUN ID | PROJECT | FEATURE | STATUS | STORIES | DURATION | DATE

- Reads all `~/.nax/runs/*/status.json`, sorts by runId desc
- New command: `src/commands/runs.ts`

### CRR-003: `nax logs` Enhancement

- `nax logs --run <runId>` — resolve run from global registry, no need to be in project dir
- Falls back to current behaviour (local feature context) when `--run` not specified

---

## Implementation Notes

- `~/.nax/runs/` created on first `registerRunStart()` call — no separate init step
- Symlink target may not exist if project was deleted — show `[log missing]` gracefully
- Registry writes are **best-effort** — never throw/block the main run on registry failure (try/catch + warn)
- No database — plain JSON files, sortable by directory name

---

## Out of Scope

- Run search/query by story ID (future)
- Run cleanup/prune command (future)
- Remote sync (future)
