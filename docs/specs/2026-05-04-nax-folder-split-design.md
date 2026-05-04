# Design Note: Project / Global `.nax/` Folder Split

**Date:** 2026-05-04
**Status:** Pre-implementation — settles open questions before PR work begins
**Scope:** Separates VCS'd inputs (project-level `.nax/`) from per-machine generated outputs (global `~/.nax/<projectKey>/`) and cross-project state (`~/.nax/global/`).
**Driver:** [docs/findings/2026-04-30-context-curator-design.md](../findings/2026-04-30-context-curator-design.md) — curator surfaces the existing `.nax/` folder bloat. As `prompt-audit/`, `review-audit/`, `cost/`, `runs/`, and (proposed) `observations.jsonl` accumulate, the project tree becomes noisy and gitignore lists keep growing.

---

## 1. Problem statement

`<workdir>/.nax/` today conflates two distinct categories of content:

- **VCS'd inputs** — human-curated, project-defining: `config.json`, `mono/<pkg>/config.json`, `features/<id>/context.md`, `features/<id>/stories/<sid>/story.md`, `rules/*.md`. These belong to the project repo and should be checked in.
- **Generated outputs** — produced by every run, ephemeral, per-machine: `runs/`, `prompt-audit/`, `review-audit/`, `cost/`, `metrics.json`, `features/<id>/stories/<sid>/context-manifest-*.json`, `features/<id>/runs/<ts>.jsonl`. These are user-local and should not be in VCS.

Mixing them creates four observable problems:

1. **Gitignore sprawl.** Every new audit/observation domain adds a new ignore pattern.
2. **Repo noise.** `git status` after a run shows generated artifacts; humans learn to skim past them and miss real changes.
3. **No cross-run aggregation.** Curator's cross-run rollup naturally lives outside any single project.
4. **No cross-project pattern detection.** Patterns like "this review finding fires across 3 projects" are impossible when each project's audit is siloed under its own workdir.

This design splits the folder into three tiers, each with one clear responsibility.

---

## 2. Proposed layout

```
<project>/.nax/                          ← VCS'd, project-scoped, human-curated
  ├─ config.json
  ├─ mono/<pkg>/config.json
  ├─ features/<id>/context.md
  ├─ features/<id>/stories/<sid>/story.md
  ├─ features/<id>/acceptance/*
  └─ rules/*.md

~/.nax/<projectKey>/                     ← per-user-per-machine, generated
  ├─ .identity                           (collision-detection marker)
  ├─ runs/<runId>/
  │   ├─ <ts>.jsonl
  │   └─ observations.jsonl              (curator projection — added by curator v0)
  ├─ features/<id>/
  │   ├─ stories/<sid>/context-manifest-*.json
  │   └─ runs/<ts>.jsonl
  ├─ prompt-audit/<feature>/<runId>.jsonl + .txt sidecars
  ├─ review-audit/<feature>/<epochMs>-<sessionName>.json
  ├─ cost/<runId>.jsonl
  ├─ metrics.json
  └─ cycle-shadow/<storyId>/             (autofix shadow workspaces)

~/.nax/global/                           ← per-user, cross-project
  └─ curator/rollup.jsonl                (configurable path — see §8)

~/.nax/_archive/                         ← reclaimed projects (see §6)
  └─ <name>-<ts>/...
```

**Reserved names** under `~/.nax/`: `global`, `_archive`. Project names matching these are rejected at validation.

---

## 3. Project identity

### 3.1 `projectKey` format

```
<projectKey> = <config.name>      // no hash suffix
```

Human-readable. Path-debuggable. Trades collision-by-construction for collision-by-detection.

### 3.2 `.identity` marker

Each `~/.nax/<name>/` carries an identity file written on first run:

```json
{
  "name": "koda",
  "workdir": "/abs/path/to/first/seen/workdir",
  "remoteUrl": "git@github.com:nathapp/koda.git",
  "createdAt": "2026-05-04T10:00:00Z",
  "lastSeen": "2026-05-04T10:30:00Z"
}
```

`remoteUrl` is the **primary identity** (when the project is a git repo with an `origin` remote). `workdir` is the fallback identity for non-git projects.

### 3.3 Collision detection

On every `nax run` (and `nax init`):

1. Read `<workdir>/.nax/config.json` → extract `name`.
2. Compute current project's identity: `currentRemote` if available, else `currentWorkdir`.
3. Look up `~/.nax/<name>/.identity`.

| State | Action |
|:---|:---|
| Marker absent | First run — `mkdir ~/.nax/<name>/` (atomic lock), write marker, proceed |
| Marker present, identity matches (same remote, OR same workdir if no remote) | Re-run — update `lastSeen`, proceed |
| Marker present, identity differs | **BLOCK** — emit collision message (see §3.4) |

The `mkdir` for `~/.nax/<name>/` is the race lock. Two concurrent first-run terminals: whichever loses the race re-reads, finds an identity that matches its own (it's the same project), and proceeds.

### 3.4 Block message

```
✗ Project name collision: "koda"
  This project:    /current/workdir
                   remote: git@github.com:newteam/koda.git
  Already in use:  /first/seen/workdir
                   remote: git@github.com:nathapp/koda.git
                   last run: 2026-04-15 (3 weeks ago)

  Resolve:
    1. Rename this project: edit `name` in <workdir>/.nax/config.json
    2. Reclaim the name:    nax migrate --reclaim koda
                            (archives existing data to ~/.nax/_archive/koda-<ts>/)
    3. Same project moved?  nax migrate --merge koda
                            (rewrites identity to new workdir/remote)
```

### 3.5 Worktree behavior

Two worktrees of the same repo:
- Both have `name: "koda"` (same `<workdir>/.nax/config.json` — VCS'd).
- Both have the same git remote URL.
- First worktree's run creates `~/.nax/koda/.identity` with its workdir + remote.
- Second worktree's run looks up `koda`, sees remote matches → not a collision, shares the dir.
- Concurrent runs from both worktrees write to the same `runs/<runId>/`, `prompt-audit/<feature>/<runId>.jsonl`, etc. — already per-runId-scoped, so no contention.

Worktree sharing falls out cleanly because remote URL is the primary identity, workdir is informational.

### 3.6 Stale identity (project deleted from disk)

A project was deleted but `~/.nax/koda/.identity` remains. New `koda` legitimately wants the name.

**Resolution:** require explicit `nax migrate --reclaim`. Auto-staleness-detection is rejected — mounted volumes and network drives can be transiently absent, and we must not nuke real data.

### 3.7 Project rename (config `name` change)

User changes `config.json` `name` from `koda` → `koda-v2`. On next run:
- `~/.nax/koda-v2/` doesn't exist; naive precheck would treat it as new and orphan `~/.nax/koda/`.
- Before failing the "no identity" path, the precheck scans all `~/.nax/*/.identity` for one with matching workdir + remote. If found, surfaces a rename prompt:

```
Looks like this project was named "koda" previously.
Move data to "koda-v2"? [y/N]
```

Confirming runs `mv ~/.nax/koda ~/.nax/koda-v2` and updates the marker.

---

## 4. Path resolution

### 4.1 Two resolvers

The codebase currently joins paths via `join(workdir, ".nax", ...)`. This becomes:

| Path category | New resolver | Example |
|:---|:---|:---|
| **Project inputs** (config, features, rules) | `projectInputDir(workdir)` → `<workdir>/.nax` | `<workdir>/.nax/config.json` |
| **Project outputs** (runs, audits, manifests) | `projectOutputDir(runtime)` → `~/.nax/<projectKey>` | `~/.nax/koda/runs/<runId>/` |
| **Global outputs** (cross-project rollup, etc.) | `globalOutputDir()` → `~/.nax/global` | `~/.nax/global/curator/rollup.jsonl` |

`runtime.outputDir` is added to `NaxRuntime` and computed once at runtime construction.

### 4.2 Migration map

| Today | After |
|:---|:---|
| `<workdir>/.nax/config.json` | unchanged |
| `<workdir>/.nax/mono/<pkg>/config.json` | unchanged |
| `<workdir>/.nax/features/<id>/context.md` | unchanged |
| `<workdir>/.nax/rules/*.md` | unchanged |
| `<workdir>/.nax/runs/...` | `~/.nax/<projectKey>/runs/...` |
| `<workdir>/.nax/features/<id>/runs/...` | `~/.nax/<projectKey>/features/<id>/runs/...` |
| `<workdir>/.nax/features/<id>/stories/<sid>/context-manifest-*.json` | `~/.nax/<projectKey>/features/<id>/stories/<sid>/context-manifest-*.json` |
| `<workdir>/.nax/prompt-audit/...` | `~/.nax/<projectKey>/prompt-audit/...` |
| `<workdir>/.nax/review-audit/...` | `~/.nax/<projectKey>/review-audit/...` |
| `<workdir>/.nax/cost/...` | `~/.nax/<projectKey>/cost/...` |
| `<workdir>/.nax/metrics.json` | `~/.nax/<projectKey>/metrics.json` |
| `<workdir>/.nax/cycle-shadow/...` | `~/.nax/<projectKey>/cycle-shadow/...` |
| `.nax/runs/<runId>/observations.jsonl` (curator) | `~/.nax/<projectKey>/runs/<runId>/observations.jsonl` |
| `.nax/curator/rollup.jsonl` (curator) | `~/.nax/global/curator/rollup.jsonl` (configurable — see §8) |

### 4.3 Configurable per-project output dir

Some users may want `~/.nax/<projectKey>/` on a different volume (faster SSD, encrypted partition). Support a config override:

```json
// <workdir>/.nax/config.json
{
  "name": "koda",
  "outputDir": "/mnt/fast-ssd/nax/koda"   // optional; default ~/.nax/<name>
}
```

**Accepted path forms:**
- Absolute paths (`/mnt/fast-ssd/nax/koda`)
- Tilde-expanded home paths (`~/custom-nax/koda`) — expanded via `os.homedir()` at runtime

**Rejected path forms:**
- Relative paths (`./local-nax`, `local-nax`) — prevents accidentally scattering output dirs across worktrees of the same project. Validation surfaces a clear error: `outputDir must be absolute or start with ~/`.

When `outputDir` is set, `projectOutputDir(runtime)` returns the resolved path. Identity/collision logic remains under `~/.nax/<name>/.identity` so the in-config reference still resolves to the canonical project key.

---

## 5. `nax init` flow

### 5.1 CLI surface

```
nax init                          # interactive — default name from basename(workdir)
nax init --name <name>            # non-interactive (CI, scripts)
nax init --name <name> --reclaim  # archive existing ~/.nax/<name>/, take the name
nax init --name <name> --merge    # rewrite existing identity to this workdir/remote
```

### 5.2 Default derivation order

```
1. --name <name> flag       (explicit, non-interactive)
2. basename(workdir)        (proposed default in interactive prompt)
3. fail if neither          (no implicit headless creation)
```

Interactive prompt:
```
$ nax init
Project name [koda]:
```

### 5.3 Validation rules for `name`

| Rule | Reason |
|:---|:---|
| Non-empty | Required |
| Lowercase letters, digits, `-`, `_` only | Filesystem-safe across platforms; URL-safe |
| Cannot start with `.` or `_` | Avoid hidden-dir confusion |
| Length 1–64 chars | Path limits + sanity |
| Reject reserved names (`global`, `_archive`) | Conflicts with `~/.nax/global/`, `~/.nax/_archive/` |

Validation runs at init AND at run-precheck (defense in depth).

### 5.4 Init-time collision check

| State | Behavior |
|:---|:---|
| `~/.nax/<name>/.identity` doesn't exist | OK — write `<workdir>/.nax/config.json`; defer marker creation to first run |
| Exists, identity matches (same workdir/remote) | OK — re-init, refresh marker |
| Exists, identity differs | **BLOCK** with same message as run-time precheck |

Block at init is friendlier than block at first run — fail fast, no wasted setup.

### 5.5 What init writes

`nax init` writes only `<workdir>/.nax/config.json`. The `~/.nax/<name>/.identity` marker is created on first `nax run`. Reasons:

- Init may be done speculatively (user abandons the project) — no orphan global state.
- First run is when actual work begins; that's when the global slot deserves to be claimed.
- Init's collision check is a *read* only; the *claim* (mkdir + marker write) happens on first run with proper atomic semantics.

### 5.6 Re-init in an already-initialized workdir

If `<workdir>/.nax/config.json` already exists, `nax init` prompts before any change:

```
$ nax init
config.json already exists with name="koda".
Update? [y/N]
```

| User response | Behavior |
|:---|:---|
| `y` | Continue with the normal init flow — re-prompt for name (default = current value), re-validate, re-run collision check, write back the merged config |
| `N` (default) | Abort; no changes |

For non-interactive contexts:
```
nax init --force --name <name>    # overwrite without prompt
```

`--force` only suppresses the "already initialized" prompt; collision detection (§5.4) still runs and can still block. Without `--force`, a non-interactive context with an existing config exits with status 1.

---

## 6. `nax migrate`

### 6.1 CLI surface

```
nax migrate                         # one-shot per project, idempotent
nax migrate --reclaim <name>        # archive ~/.nax/<name>/ to ~/.nax/_archive/<name>-<ts>/
nax migrate --merge <name>          # rewrite ~/.nax/<name>/.identity to current workdir/remote
nax migrate --dry-run               # report what would move without moving anything
nax migrate --cross-fs              # opt-in copy+delete when source/dest are on different filesystems
```

### 6.2 Standard migration steps

| Step | Behavior |
|:---|:---|
| 1. Detect | Walk `<workdir>/.nax/` for generated subdirs (`runs/`, `prompt-audit/`, `review-audit/`, `cost/`, `metrics.json`, `features/*/runs/`, `features/*/stories/*/context-manifest-*.json`, `cycle-shadow/`, `curator/`) |
| 2. Resolve key | Compute `<projectKey>` from `config.json` `name` field |
| 3. Handle missing name | If `name` is absent, prompt once with default = `basename(workdir)`, write to `config.json` |
| 4. Move | `mv` (atomic rename) each detected subdir to `~/.nax/<projectKey>/<subdir>/` |
| 5. Marker | Write `~/.nax/<projectKey>/.migrated-from` with old path + timestamp |
| 6. Gitignore cleanup | Strip the moved patterns from `<workdir>/.gitignore` (informational; the patterns no longer match anything at project level) |
| 7. Idempotent | Re-running detects already-migrated state and is a no-op |

Safe-by-default: never deletes, only moves. If the same destination file already exists, abort with a conflict message rather than overwrite.

**Cross-filesystem behavior:** atomic `mv` (single `rename(2)` syscall) only works when source and destination are on the same filesystem. When they aren't (e.g. workdir on `/mnt/external-drive`, `~/.nax/` on `/`), migration aborts with:

```
✗ Cross-filesystem migration detected
  Source:      /mnt/external-drive/koda/.nax/runs/
  Destination: /home/me/.nax/koda/runs/

  These are on different filesystems. Atomic rename is not available.
  Re-run with `--cross-fs` to copy+delete (slower, not atomic — partial
  failures may leave data in both locations).

  Alternative: set `outputDir` in <workdir>/.nax/config.json to a path on
  the source filesystem (see spec §4.3).
```

`--cross-fs` opts into copy+delete semantics with a per-file safety pattern: copy → fsync → verify size → unlink source. A failure during this sequence stops the whole migration and reports which files completed; safe to re-run (idempotent).

### 6.3 `--reclaim` flow

```
nax migrate --reclaim koda
  1. Read ~/.nax/koda/.identity
  2. mkdir ~/.nax/_archive/koda-<ts>/
  3. mv ~/.nax/koda/* ~/.nax/_archive/koda-<ts>/
  4. rmdir ~/.nax/koda/
  5. (next nax run for current project will create a fresh ~/.nax/koda/)
```

The user retains access to archived data under `~/.nax/_archive/koda-<ts>/`. No `nax restore-archive` command in v0; manual `mv` works.

### 6.4 `--merge` flow

For "same project, different workdir" cases (project moved to a new path, or git remote URL changed):

```
nax migrate --merge koda
  1. Read ~/.nax/koda/.identity (old identity)
  2. Re-write workdir/remoteUrl fields to current values
  3. Update lastSeen
  4. (no data movement; only identity is rewritten)
```

### 6.5 First-run auto-migration

If `nax run` precheck detects unmigrated generated content under `<workdir>/.nax/`, it surfaces a one-line notice and runs `nax migrate` automatically:

```
$ nax run
[migrate] Found generated content under <workdir>/.nax/. Moving to ~/.nax/koda/...
[migrate] Done. 47 files moved. <workdir>/.gitignore updated.
[run] Starting...
```

Less ceremony than requiring a manual `nax migrate` step. Override with `--no-auto-migrate` for users who want explicit control.

---

## 7. Updated `CreateRuntimeOptions` / `NaxRuntime`

### 7.1 New runtime fields

```typescript
export interface NaxRuntime {
  // ... existing fields
  readonly outputDir: string;           // ~/.nax/<projectKey>  (or config.outputDir override)
  readonly globalDir: string;           // ~/.nax/global
  readonly projectKey: string;          // <config.name>
}
```

### 7.2 No new `CreateRuntimeOptions` fields

`projectKey` and `outputDir` are derived from `config` + `workdir` in `createRuntime()`. No caller-side option required.

### 7.3 Path resolver helpers

Add to `src/runtime/paths.ts`:

```typescript
export function projectInputDir(workdir: string): string;
export function projectOutputDir(runtime: NaxRuntime): string;
export function globalOutputDir(): string;

// Identity I/O
export function readProjectIdentity(name: string): ProjectIdentity | null;
export function writeProjectIdentity(name: string, identity: ProjectIdentity): void;
```

All call-sites currently using `join(workdir, ".nax", ...)` for **output** paths migrate to use these helpers. Input paths (`config.json`, `features/<id>/context.md`, `rules/`) keep `join(workdir, ".nax", ...)`.

---

## 8. Cross-project rollup (curator integration)

### 8.1 Default location

`~/.nax/global/curator/rollup.jsonl` — per-user, cross-project.

### 8.2 Configurable path

`config.json` may override:

```json
{
  "name": "koda",
  "curator": {
    "rollupPath": "/mnt/team-share/nax-rollup.jsonl"
  }
}
```

Path resolution:

```
1. config.curator.rollupPath          (explicit override — supports any of the patterns below)
2. ~/.nax/global/curator/rollup.jsonl (default — per-user, cross-project)
```

This unblocks four sharing models without committing to any:

| Pattern | How |
|:---|:---|
| User-only | Default |
| In-project VCS'd | Set to `<workdir>/.nax/curator/rollup.jsonl` (note: writeable from VCS'd path is allowed; this is the user's choice) |
| Team-mounted shared drive | Set to `/mnt/team-share/...` |
| Future remote backend | Plugin populates the path when its sync runs |

(d) "push to S3 / git LFS" and (e) "Slack/Linear integration" remain real designs worth doing eventually but are out of scope here.

---

## 9. Risk register

| ID | Risk | Severity | Mitigation |
|:---|:---|:---|:---|
| **R1** | **Implicit identity inversion.** A user moves a project to a new path; first run after the move sees workdir mismatch and blocks. | Medium | §3.7 rename detection scans `~/.nax/*/.identity` for matching workdir/remote and prompts. Workdir-only projects (no git remote) hit this case more often; surface clear `--merge` guidance. |
| **R2** | **`~/.nax/` filesystem assumption.** Some platforms have non-standard home dirs (`$HOME` unset, Windows under WSL, sandboxed CI). | Medium | Use Node's `os.homedir()` (Bun-compatible). Allow `NAX_HOME` env override. Document. |
| **R3** | **Permissions / multi-user.** Shared dev machines: user A's `~/.nax/koda/` invisible to user B. | Low | Acceptable — this is a feature, not a bug. Cross-user sharing is via §8.2 configurable path. |
| **R4** | **Volume separation.** User runs nax from `/mnt/external-drive/koda` but `~/.nax/` is on `/`. Performance hit, or `~/` runs out of space. | Medium | §4.3 `outputDir` override. |
| **R5** | **CI cache reuse.** CI persists `~/.nax/` across jobs; one job's data leaks into the next. | Low | Per-runId scoping bounds the problem; data co-location across CI runs of the same project is mostly desirable (cache warmup). |
| **R6** | **Migration data loss.** `nax migrate` move fails partway through. Atomic `mv` (single `rename(2)`) only works on same-filesystem moves; cross-filesystem requires copy+delete which is slower and not atomic. | Medium | Use atomic `mv` (rename) which is single-syscall on POSIX same-filesystem moves. Cross-filesystem moves fall back to copy+delete; surface a warning and require `--cross-fs` flag in that case. |
| **R7** | **Reserved-name escape.** User names project `_archive` to break the archive convention. | Low | §5.3 validation list; reject. |
| **R8** | **Plugin contract drift.** Existing `IPostRunAction` / `IReporter` plugins may read paths under `<workdir>/.nax/`. | Medium | Plugins use `runtime.outputDir` going forward. Audit existing plugin code before merge; update wiring docs. (Search shows no current plugin reads the moved subdirs — see [docs/findings/2026-04-30-context-curator-design.md §Step 4 R7](../findings/2026-04-30-context-curator-design.md#step-4--auditor-proliferation-unified-design-considered).) |
| **R9** | **Discoverability regression.** "Where did my run logs go?" is harder when they're not under `<workdir>/.nax/`. | Low | `nax status` (existing) prints absolute path to `runtime.outputDir`. Add it to README + run startup banner. |
| **R10** | **Concurrent first-run race.** Two terminals start `nax run` simultaneously on a fresh project. | Low | §3.3 `mkdir` lock — atomic on POSIX. Whichever loses re-reads the now-existing identity, finds it matches its own (same project), proceeds. |

---

## 10. Implementation sequence

Each step is a separate PR. Steps are ordered to keep the tree green.

### PR 1 — Path resolver helpers (no behavior change)

- Add `src/runtime/paths.ts` with `projectInputDir`, `projectOutputDir`, `globalOutputDir`, identity I/O.
- Add `outputDir`, `globalDir`, `projectKey` to `NaxRuntime`.
- `createRuntime()` populates the new fields from `config.name` (fallback: `basename(workdir)` with deprecation warning).
- **No callers migrate yet** — purely additive. Tests cover the resolver only.

### PR 2 — `nax init` name validation + collision precheck

- Add `--name` flag and interactive prompt to `nax init`.
- Add validation rules from §5.3.
- Add init-time collision check from §5.4.
- Existing init code paths require a name (deprecation if absent: prompt with default).

### PR 3 — `nax migrate` command + first-run auto-migration

- New `src/commands/migrate.ts` implementing §6.2–§6.4.
- Hook auto-migration into `nax run` precheck (§6.5).
- Tests cover detect → move → marker → idempotent re-run.

### PR 4 — Migrate output paths to `runtime.outputDir`

Migrate call-sites identified by `grep 'join(.*workdir.*"\.nax"' src/`:

| File | Lines |
|:---|:---|
| `src/runtime/index.ts` | 119 (cost), 123 (prompt-audit) |
| `src/metrics/tracker.ts` | 274, 328 (metrics.json) |
| `src/pipeline/subscribers/registry.ts` | 58, 59 (status, eventsDir) |
| `src/pipeline/stages/autofix-cycle.ts` | 178 (cycle-shadow) |
| `src/review/review-audit.ts` | uses `findNaxProjectRoot` — adjust to `runtime.outputDir` |
| `src/context/engine/manifest-store.ts` | manifest write paths |
| Run-jsonl writer (logger) | per-feature run jsonl path |

Each call-site moves from `join(workdir, ".nax", subdir)` to `join(runtime.outputDir, subdir)`. Input paths (`config.json`, `features/<id>/context.md`, `rules/*.md`) are unchanged.

### PR 5 — Curator rollup path resolution

- Add `config.curator.rollupPath` schema field with default `~/.nax/global/curator/rollup.jsonl`.
- Wire into curator plugin (lands with curator v0).

### PR 6 — Documentation update

- README, `docs/architecture/`, `docs/guides/`.
- Update `.claude/rules/monorepo-awareness.md` and `.claude/rules/project-conventions.md` to reflect the path split.
- Migration FAQ in `docs/guides/`.

---

## 11. Non-goals

- **Cross-team rollup sharing via remote backends** (S3, git LFS, Slack/Linear). Configurable path (§8) unblocks all of these without committing to any.
- **Multi-user shared `~/.nax/`.** Each user has their own; that's the design.
- **Auto-staleness detection.** Stale identity requires explicit `--reclaim` (§3.6).
- **`nax restore-archive` command.** v0 archives are recoverable by manual `mv`; if real demand emerges, add later.

---

## 12. Open questions

All four resolved (2026-05-04).

1. ~~Cross-filesystem move during migration~~ — **Resolved:** explicit `--cross-fs` opt-in flag (§6.2). Migration aborts with actionable message when source/dest differ.
2. ~~Existing legacy projects without `name` in config~~ — **Resolved:** `nax migrate` prompts once with default = `basename(workdir)` and writes back to `config.json` (§6.2 step 3).
3. ~~`nax init` in an existing workdir that already has `.nax/config.json`~~ — **Resolved:** prompt with default-no, `--force` for non-interactive overwrite (§5.6).
4. ~~`outputDir` override (§4.3)~~ — **Resolved:** absolute paths or tilde-expanded only; relative paths rejected at validation (§4.3).

---

## 13. References

- [docs/findings/2026-04-30-context-curator-design.md](../findings/2026-04-30-context-curator-design.md) — driver
- [src/runtime/index.ts](../../src/runtime/index.ts) — current `NaxRuntime` shape
- [.claude/rules/monorepo-awareness.md](../../.claude/rules/monorepo-awareness.md) — path-handling rules
- [.claude/rules/project-conventions.md](../../.claude/rules/project-conventions.md) — Bun-native and barrel-import rules
