# Context Curator — Post-Run Context Maintenance

The **context curator** is a deterministic post-run plugin that analyzes nax run artifacts and proposes additions or deletions to your project's canonical context sources (`.nax/features/<id>/context.md` and `.nax/rules/`).

## Overview

After every nax run, curator automatically:

1. **Collects observations** from run artifacts (context manifests, review findings, rectification cycles, escalations)
2. **Applies heuristics** to detect patterns (repeated failures, empty tool results, stale chunks)
3. **Generates proposals** into a review file you can edit and accept

The curator **never makes automatic changes**. All proposals are:
- Human-reviewed before acceptance
- Applied explicitly via `nax curator commit`
- Reversible (edits remain in your working directory until committed)

## What Curator Reads

Curator analyzes run artifacts produced during feature execution:

| Source | What it tells us | Where it comes from |
|:---|:---|:---|
| **Context manifests** | Which chunks were included/excluded (and why: too low score, over budget, stale, etc.), provider health | `.nax/features/<id>/stories/<sid>/context-manifest-*.json` |
| **Review audit** | Repeated findings across stories → anti-pattern rule candidates | `.nax/review-audit/<feature>/*.json` (requires `review.audit.enabled: true`) |
| **Run log** | Rectification cycles, escalations, acceptance verdicts, pull-tool results | `.nax/features/<id>/runs/<ts>.jsonl` |
| **Story metrics** | First-pass success rate, attempt counts, token production, final tier | `.nax/metrics.json` |
| **Fix-cycle events** | Iteration outcomes, strategy successes/failures | Run log `stage:"findings.cycle"` events |

## Configuration

### Enable the Curator

The curator is **enabled by default** in nax 0.38.0+. To disable it project-wide:

```json
{
  "curator": {
    "enabled": false
  }
}
```

### Enable Review Audit (Recommended)

The curator's quality improves dramatically when review audit is enabled. This captures semantic and adversarial review findings that curator uses to propose rules:

```json
{
  "review": {
    "audit": {
      "enabled": true
    }
  }
}
```

Without this flag, curator still works but produces fewer (lower-fidelity) proposals — primarily from context manifest observations and rectification cycles.

### Configure Thresholds

Curator applies six heuristics to detect patterns. Each has a configurable threshold (minimum number of occurrences before proposing):

```json
{
  "curator": {
    "thresholds": {
      "repeatedFinding": 2,      // Review finding appears N+ times across stories
      "emptyKeyword": 2,         // Pull tool returns empty for same keyword N+ times
      "rectifyAttempts": 2,      // Same story has N+ rectification cycles
      "escalationChain": 2,      // Escalation from tier X to Y happens N+ times
      "staleChunkRuns": 2,       // Chunk marked stale hasn't matched in N+ runs
      "unchangedOutcome": 2      // Fix-cycle outcome is "unchanged" N+ times in a row
    }
  }
}
```

**Default starting values** (v0.38.0) are conservative guesses. Calibrate these based on your observed signal-to-noise ratio after several runs (see Threshold Tuning below).

## CLI Commands

### nax curator status

Show observations and proposals from the latest (or specified) run:

```bash
nax curator status                    # Latest run
nax curator status --run <runId>      # Specific run
```

Prints:
- Observation counts by kind
- Proposal summary by category
- Path to the proposal file for review

### nax curator commit

Apply checked proposals to your canonical sources:

```bash
nax curator commit <runId>
```

Process:
1. Reads `<runId>/curator-proposals.md`
2. Parses checked `[x]` lines
3. For each checked proposal:
   - Appends to `.nax/features/<id>/context.md` (for "Add to context" proposals)
   - Appends to `.nax/rules/<file>.md` (for "Add to rules" proposals)
   - Removes lines from rules files (for "Drop from rules" proposals)
4. Opens the modified files in `$EDITOR` for human review
5. Prints summary (e.g., "applied 3 proposals, modified 2 files")

**Does not commit to git** — changes remain in your working directory for review before `git add` / `git commit`.

### nax curator dryrun

Re-run heuristics against existing observations without re-collecting:

```bash
nax curator dryrun --run <runId>
```

Useful for threshold calibration: adjust thresholds in config, re-run heuristics on the same observations, and see how proposal counts change.

### nax curator gc

Prune old run directories from the cross-run rollup:

```bash
nax curator gc --keep 50   # Keep the 50 most recent runs (default)
nax curator gc --keep 100  # Keep 100 runs
```

Cleans up per-run proposal and observation files from older runs. Does not delete run log / metrics themselves — only curator artifacts.

## Proposal Review Flow

Each run produces a proposal file at `.nax/runs/<runId>/curator-proposals.md`:

```markdown
# Curator proposals — run abc123

Generated: 2026-05-04T10:00:00Z
Heuristics fired: 4
Observations: 47

## Add to .nax/features/auth/context.md
- [ ] [HIGH] (H3) Postgres connection pool sizing — story story-001 ran 3 rectify cycles
- [ ] [MED] (H2) "review batch" pull-tool returned empty 2× across stories story-002, story-003

## Add to .nax/rules/api-data.md
- [ ] [HIGH] (H1) "never N+1 on /v2/reviews" — review finding fired in 4 stories

## Drop from .nax/rules/web.md
- [ ] [LOW] (H5) line 23–28 — never matched in last 30 days

## Advisory (no auto-target)
- [ ] [LOW] (H6) story-007 fix-cycle "acceptance" stuck on `unchanged` outcome 2× — diagnose prompt may need review
```

### How to Accept Proposals

1. **Edit the markdown** — replace `[ ]` with `[x]` for proposals you want to accept
2. **Leave unchecked** proposals you want to discard
3. **Run `nax curator commit <runId>`** — applies checked proposals to canonical sources
4. **Review the opened files** in your editor
5. **Commit to git** when satisfied

### Proposal Categories

| Category | Meaning | Action |
|:---|:---|:---|
| **Add to .nax/features/<id>/context.md** | Missing context that cost rectification cycles or empty tool results | Append to the feature's context file |
| **Add to .nax/rules/<file>.md** | Repeated review findings — likely anti-patterns | Create a new rule or append to an existing rules file |
| **Drop from .nax/rules/<file>.md** | Stale rules that haven't matched recent runs | Remove specified lines |
| **Advisory** | Interesting signals but no canonical-source target (e.g., prompt diagnosis) | Read but usually don't act on |

## Heuristics Reference

The curator uses six deterministic heuristics. Each has a traceability ID (H1–H6) in proposals:

| ID | Heuristic | Threshold | Meaning | Action |
|:---|:---|:---|:---|:---|
| **H1** | Repeated review finding | `≥ N occurrences across stories` | Same lint/test finding fired repeatedly — anti-pattern | Add to rules |
| **H2** | Pull-tool empty result | `≥ N empty results for same keyword` | Context query returned nothing multiple times — missing docs | Add to context |
| **H3** | Repeated rectification cycle | `≥ N cycles for same story` | Story needed multiple fix attempts — context likely incomplete | Add to context |
| **H4** | Escalation chain | `≥ N escalations for same story type` | Repeated model-tier escalation — context may be insufficient | Add to context |
| **H5** | Stale chunk | `chunk excluded as stale, but story still passed` | Old context no longer needed — can be dropped | Drop from rules |
| **H6** | Fix-cycle unchanged | `≥ N consecutive "unchanged" outcomes` | Diagnosis didn't resolve the issue — prompt may need review | Advisory |

### Severity Levels

Proposals are tagged with severity to help prioritize:

- **HIGH** — Strong signal, high confidence (≥ 3–4 occurrences, or high-impact finding)
- **MED** — Moderate signal (2–3 occurrences)
- **LOW** — Weak signal or advisory (single confirmed case, optional action)

## Threshold Tuning

v0.38.0 ships with conservative starting thresholds (mostly `≥ 2`). As you run curator on real workloads:

### Observation Workflow

1. **Run nax as usual** — curator fires automatically post-run
2. **Review proposals** — edit `curator-proposals.md`, check what you want
3. **Run `nax curator commit`** — apply checked proposals
4. **Track acceptance rate** — how many proposals did you actually accept vs. reject?

### Tuning Decision

If you notice a heuristic is **too noisy** (many rejected proposals):
- Increase the threshold in `.nax/config.json` (e.g., `"repeatedFinding": 3`)
- Run `nax curator dryrun --run <latest>` to see how proposal count changes
- Re-run curator on future runs to validate

If a heuristic is **too quiet** (you wish you'd seen more proposals):
- Decrease the threshold (e.g., `"repeatedFinding": 1`)
- Run dryrun to check impact
- Validate on future runs

### Example Calibration Session

```bash
# After a run with 5 proposals, 2 accepted, 3 rejected
# The "repeated finding" heuristic seems noisy

# Try increasing threshold
nax curator dryrun --run <runId>
# (Edit .nax/config.json to increase repeatedFinding to 3)
nax curator dryrun --run <runId>
# Output: 3 proposals (vs. 5 before)
# Better! Now it filters more aggressively

# Check on next run
nax run -f my-feature
# curator fires with revised thresholds
```

## Safety & Guarantees

### What Curator Never Does

- **Never makes automatic changes** — all proposals require explicit `nax curator commit` + human review
- **Never uses LLM** — all heuristics are deterministic (frequency counts, manifest joins, status flags)
- **Never auto-applies to git** — `nax curator commit` opens files in `$EDITOR` for review; you commit manually
- **Never deletes file history** — all changes are appends or line deletions; git remains your undo source

### Atomic Proposals

When you `nax curator commit`, changes are applied in a strict order:
1. All **drops** execute first (removes from rules files)
2. All **adds** execute second (appends to context and rules files)
3. Modified files are opened in `$EDITOR` for human review
4. Only after you save and close the editor are changes persisted

This ordering prevents conflicts where a single proposal file requests both "drop line X" and "add line X" in the same file.

### Cross-Run Rollup (Advanced)

By default, curator writes per-run observations to `.nax/runs/<runId>/observations.jsonl`. For multi-run signal (e.g., "this finding appeared in 8 of the last 12 runs"), curator also maintains a cross-run rollup:

```
.nax/curator/rollup.jsonl
```

This is append-only and can be queried to detect long-term trends. Configurable via:

```json
{
  "curator": {
    "rollupPath": "/custom/path/curator/rollup.jsonl"
  }
}
```

The rollup is primarily for advanced diagnostics and multi-run trend analysis; most users can ignore it.

## Troubleshooting

### No Proposals Generated

**Issue:** `nax curator status` shows "Observations: 0"

**Causes & Fixes:**
- **Run completed with 0 stories** — curator only runs if at least one story completed successfully
- **review.audit.enabled is false** — most heuristics depend on review audit findings
  - **Fix:** Set `"review": { "audit": { "enabled": true } }` in `.nax/config.json`
- **Thresholds are too high** — all heuristics require minimum occurrence counts
  - **Fix:** Lower thresholds temporarily to see what curator detects

### "review.audit.enabled is off" Warning

The curator prints a warning if review audit is disabled:

```
[WARN] curator: review.audit.enabled is off — proposal quality will be reduced
```

**Recommendation:** Enable it in `.nax/config.json`:

```json
{
  "review": {
    "audit": {
      "enabled": true
    }
  }
}
```

This has minimal performance cost and dramatically improves curator signal.

### Proposals Not Applied After `nax curator commit`

**Check:**
- Did you edit the proposal file and save it before running `nax curator commit`?
- Are the checkboxes correctly formatted as `[x]` (with x, not asterisk or other character)?
- Are the proposal lines intact (not edited to break the format)?

Run `nax curator status --run <runId>` to view the raw proposal file and verify format.

### Curator Artifacts Accumulating

Run `nax curator gc` to clean up old per-run curator files (proposals, observations):

```bash
nax curator gc --keep 50   # Keep 50 most recent runs
```

This only deletes curator-specific output; run logs and metrics are untouched.

## Integration with Review Audit

Curator depends on `review.audit.enabled: true` for its highest-fidelity signal. Here's how they work together:

| When | What Happens |
|:---|:---|
| Story completes | Review audit captures semantic + adversarial findings → `review-audit/<feature>/*.json` |
| Run completes | Curator reads audit files and counts repeated findings across stories |
| Same finding ≥ N times | Curator proposes adding a rule to `.nax/rules/` |

**Example:** If the review found "missing null check" in 4 different stories, curator proposes a rule like:

```markdown
- [ ] [HIGH] (H1) "always null-check before dereferencing" — review finding fired in 4 stories
```

You can then accept it, and the next run's agent will see this rule in the codebase context.

## See Also

- [Configuration Guide](configuration.md) — full curator config schema
- [Review Audit Guide](review-audit.md) — how to configure semantic and adversarial review
- [Context Engine Guide](context-engine.md) — how context.md and rules are used in story execution
