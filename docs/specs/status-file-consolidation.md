# Status File Consolidation — Spec

**Version:** v0.22.2
**Status:** Planned
**Pre-requisite for:** v0.23.0 (Central Run Registry)

---

## Problem

StatusWriter only writes `status.json` when the `--status-file` CLI flag is explicitly passed. Without it, no status file is written. Additionally, `nax status` and `nax diagnose` read from different (non-existent) paths, creating a three-way disconnect.

### Current State

| Component | Path | Exists? |
|-----------|------|---------|
| StatusWriter (writer) | `--status-file <path>` (opt-in) | Only if flag passed |
| `nax status` (reader) | `nax/features/<feature>/status.json` | ❌ Never written |
| `nax diagnose` (reader) | `<workdir>/.nax-status.json` | ❌ Legacy path |
| Actual file on disk | `nax/status.json` | Only from manual flag usage |

## Goal

Auto-write status files to well-known paths. Zero config, zero flags. Both project-level and feature-level status always available.

### Target State

| File | Written | Purpose |
|------|---------|---------|
| `<workdir>/nax/status.json` | Continuously during run | Live monitoring: "is nax running? which feature? cost?" |
| `<workdir>/nax/features/<feature>/status.json` | Once at run end | Historical: "what was the last run result for this feature?" |

---

## Stories

### SFC-001: Auto-write project-level status

**What:** Remove `--status-file` CLI option. StatusWriter always writes to `<workdir>/nax/status.json` automatically.

**Changes:**
- `bin/nax.ts` — remove `--status-file` option, compute `statusFile = join(workdir, "nax", "status.json")` automatically
- `src/execution/runner.ts` — `statusFile` no longer optional in `RunOptions`, always provided
- `src/execution/status-writer.ts` — remove the `if (!this.statusFile)` guard in `update()` (statusFile is always set)
- `src/execution/lifecycle/run-setup.ts` — statusFile always provided

**Test:** Run nax without `--status-file` flag → verify `nax/status.json` is written with correct schema.

### SFC-002: Write feature-level status on run end

**What:** On run complete/fail/crash, copy the final status snapshot to `<workdir>/nax/features/<feature>/status.json`.

**Changes:**
- `src/execution/status-writer.ts` — add `writeFeatureStatus(featureDir: string)` method that writes current snapshot to `<featureDir>/status.json`
- `src/execution/runner.ts` — call `statusWriter.writeFeatureStatus(featureDir)` in the finally block (after run completes, fails, or crashes)
- `src/execution/crash-recovery.ts` — also write feature status on crash

**Test:** After a completed run, verify `nax/features/<feature>/status.json` exists with `status: "completed"` or `"failed"`.

### SFC-003: Align status readers

**What:** Make `nax status` and `nax diagnose` read from the correct paths.

**Changes:**
- `src/cli/status-features.ts` — `loadStatusFile()` already reads from `<featureDir>/status.json` (correct after SFC-002 writes there). No change needed for feature-level.
- `src/cli/status-features.ts` — add project-level status display: read `nax/status.json` to show "currently running" info at the top of `nax status` output
- `src/cli/diagnose.ts` — change `.nax-status.json` → `nax/status.json`

**Test:** `nax status` shows current run info from project-level status + per-feature historical info. `nax diagnose` correctly detects running/stalled/crashed state.

### SFC-004: Clean up dead code

**What:** Remove deprecated paths and dead options.

**Changes:**
- `bin/nax.ts` — remove `--status-file` option definition and `statusFilePath` resolve logic
- `src/cli/diagnose.ts` — remove `.nax-status.json` path reference
- `src/execution/runner.ts` — remove `statusFile?` optional from `RunOptions` type (now required, auto-computed)

**Test:** Verify no references to `.nax-status.json` or `--status-file` remain in codebase.

---

## Schema (unchanged)

The `NaxStatusFile` interface in `src/execution/status-file.ts` is already correct. No schema changes needed — both project-level and feature-level files use the same `NaxStatusFile` type.

---

## Out of Scope

- Central Run Registry (`~/.nax/runs/`) — v0.23.0
- Status file cleanup/rotation — future
