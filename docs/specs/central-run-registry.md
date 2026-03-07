# Central Run Registry — Spec

**Version:** v0.24.0
**Status:** Planned

---

## Problem

nax stores run state per-project at `<workdir>/nax/features/<feature>/status.json`. There is no global index — you must `cd` into each project to see its run history. There is no way to answer "what has nax run across all my projects recently?"

## Existing Layout (per-project)

```
<workdir>/nax/
  config.json
  features/
    <feature>/
      prd.json
      status.json       ← live run state (NaxStatusFile, written continuously)
      runs/
        <timestamp>.jsonl ← event log
```

`status.json` already contains: runId, feature, status (running/completed/failed/crashed), progress counts, cost, current story, startedAt, etc. — everything needed for a global view.

## Goal

A global `~/.nax/runs/` registry that indexes every nax run via path references — no data duplication, no symlinks.

---

## Directory Structure

```
~/.nax/runs/
  <project>-<feature>-<runId>/
    meta.json    ← pointer record only (paths + minimal identifiers)
```

### meta.json Schema

```json
{
  "runId": "run-2026-03-07T05-30-00-000Z",
  "project": "my-app",
  "feature": "auth-system",
  "workdir": "/Users/william/projects/my-app",
  "statusPath": "/Users/william/projects/my-app/nax/features/auth-system/status.json",
  "eventsDir": "/Users/william/projects/my-app/nax/features/auth-system/runs",
  "registeredAt": "2026-03-07T05:30:00.000Z"
}
```

- Written **once** on run start — never updated (source of truth stays in `statusPath`)
- `nax runs` reads `meta.json` to locate `statusPath`, then reads live `status.json` for current state
- If `statusPath` doesn't exist (project deleted/moved) → show `[unavailable]` gracefully

---

## Implementation

### CRR-000: Events File Writer (new subscriber)

- New module: `src/pipeline/subscribers/events-writer.ts` — `wireEventsWriter()`
- Writes to `~/.nax/events/<project>/events.jsonl` — one JSON line per lifecycle event
- Listens to event bus: `run:started`, `story:started`, `story:completed`, `story:failed`, `run:completed`
- Each line: `{"ts", "event", "runId", "feature", "project", "storyId?"}`
- `run:completed` emits an `on-complete` event — used by external tooling (watchdog) to distinguish clean exit from crash
- Best-effort: never throw/block the main run on write failure
- Directory created on first write

**Motivation:** External tools (nax-watchdog, CI integrations) need a reliable signal that nax exited gracefully. Currently nax writes no machine-readable completion event, causing false crash reports. This also provides the foundation for CRR — `meta.json` can reference the events file path.

### CRR-001: Registry Writer (new subscriber)

- New module: `src/execution/run-registry.ts` — `registerRun(meta)`, `getRunsDir()`
- On run start: create `~/.nax/runs/<project>-<feature>-<runId>/meta.json`
- Wire as **event bus subscriber** (`wireRegistry()` in `src/pipeline/subscribers/registry.ts`) — listens to `run:started`
- Best-effort: never throw/block the main run on registry failure (try/catch + warn log)
- `~/.nax/runs/` created on first call — no separate init step

### CRR-002: `nax runs` CLI Command

```
nax runs                         # All runs, newest first (default: last 20)
nax runs --project my-app        # Filter by project name
nax runs --last 50               # Show last N runs
nax runs --status failed         # Filter by status (running/completed/failed/crashed)
```

**Output table:**
```
RUN ID                        PROJECT    FEATURE        STATUS      STORIES   DURATION   DATE
run-2026-03-07T05-30-00-000Z  my-app     auth-system    completed   5/5       45m        2026-03-07 13:30
run-2026-03-07T04-00-00-000Z  nax        re-arch        failed      3/5       1h 2m      2026-03-07 12:00
```

- Reads all `~/.nax/runs/*/meta.json`, resolves live `status.json` from `statusPath`
- Sorts by `registeredAt` desc
- If `statusPath` missing → status shows `[unavailable]`
- New command: `src/commands/runs.ts`

### CRR-003: `nax logs` Enhancement

- `nax logs --run <runId>` — resolve run from global registry, locate `eventsDir`, stream logs
- No need to be in the project directory
- Falls back to current behaviour (local feature context) when `--run` not specified

---

## Out of Scope

- Registry cleanup/prune command (future)
- Remote sync (future)
- Search by story ID (future)
