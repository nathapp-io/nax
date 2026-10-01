# Code Review Report

**Repository:** `@nathapp/nax`  
**Reviewed revision:** `main` at `ca202ba0`  
**Review scope:** Current repository snapshot, with focused inspection of recent checkpoint/resume and queue-injection changes.  
**Working tree:** Clean at review time.

## Findings

### P1 — Multi-story resume drops checkpoints for later stories

**Locations:**

- `src/execution/checkpoint/reader.ts:96-104`
- `src/execution/story-orchestrator/execution-plan.ts:53-72`

`loadCheckpoints()` retains records only for the lexically newest `runId`. On a resumed run, the first story loads checkpoints from the previous run and re-records its skipped phases with the current run ID. When the next story starts, it reloads the same checkpoint file, now selects the current run ID as newest, and discards the previous-run checkpoints that apply to that next story.

**Impact:** A resume involving multiple incomplete stories can resume only the first story correctly; later stories rerun phases that were already green.

**Recommendation:** Preserve checkpoint state per story across runs, or load one checkpoint snapshot at run start and retain it for the duration of the run. Add an integration test that resumes two stories with checkpoints from a prior run.

### P2 — INJECT can read paths outside the workspace

**Location:** `src/pipeline/stages/queue-check.ts:99-102`

The `INJECT` command accepts absolute paths and joins relative paths without validating realpath containment. A queue-file writer can therefore cause the process to parse JSON from any readable path, including a path reached through traversal or a symlink outside `ctx.workdir`.

**Impact:** If an external file has compatible JSON fields, its content can become an injected story and later enter agent prompts. This violates the project’s path-containment conventions.

**Recommendation:** Reject absolute paths and use a realpath-based containment check before reading the file. Add tests for absolute paths, `..` traversal, and symlink escapes.

### P2 — Checkpoint writing performs quadratic I/O and transient allocations

**Location:** `src/execution/checkpoint/writer.ts:42-47`

For every checkpoint record, the writer reads the complete JSONL file into memory, concatenates the new record, writes the complete content to a temporary file, then renames it. The per-writer queue prevents concurrent lost updates, but does not avoid repeatedly copying the full history.

**Impact:** Long runs incur O(records²) total disk I/O and repeatedly allocate increasingly large strings. This is the primary confirmed memory/performance risk found in the reviewed paths.

**Recommendation:** Use a durable append primitive where available, or store a bounded checkpoint snapshot and periodically compact it. Add a benchmark or regression test for a large number of checkpoint records.

## Memory-Leak Review

No confirmed timer, event-listener, or subprocess-lifecycle memory leak was found in the reviewed execution paths. The checkpoint rewrite behavior above causes transient memory growth and increasing I/O cost, rather than an unbounded retained-object leak.

## Verification

- `bun run typecheck` — passed
- Focused tests — passed: 44 tests across checkpoint reader, runner resume dependencies, INJECT validation, and queue-check behavior.
