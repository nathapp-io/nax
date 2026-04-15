# Context Engine v1 — Phase 0 Runbook: Graphify KB

> Step-by-step instructions for running the validation experiment.
> Read [context-v1-graphify-kb-plan.md](./context-v1-graphify-kb-plan.md) first for the why.

---

## Overview

The experiment runs in two halves:

```
HALF 1 — Baseline
  [env check] → [run US-001] → [PAUSE] → [record metrics] → [author context.md]

HALF 2 — Injection
  [update prd.json] → [run US-002–004] → [record metrics per story] → [decide]
```

---

## Part 1 — Environment preparation

### 1.1 Verify nax is up to date

```bash
nax --version
# Expected: 0.62.0-canary.6 or newer
```

If the binary is stale, rebuild from source:

```bash
cd /home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent
bun run build
# nax binary is at dist/nax.js, symlinked to PATH via ~/.nvm/.../bin/nax
```

### 1.2 Verify koda dependencies are installed

```bash
cd /home/williamkhoo/Desktop/projects/nathapp/koda
bun install
```

### 1.3 Verify the koda API workspace builds and tests pass (clean baseline)

```bash
cd /home/williamkhoo/Desktop/projects/nathapp/koda/apps/api
bun run type-check   # must pass
bun run lint         # must pass
bun run test         # must pass — record the pass count as your baseline
```

If tests fail before the experiment starts, fix them first. A pre-existing failure will contaminate the metrics.

### 1.4 Verify the prd.json is in the expected state

```bash
cd /home/williamkhoo/Desktop/projects/nathapp/koda
jq '[.userStories[] | {id, title, status}]' .nax/features/graphify-kb/prd.json
```

Expected output — all 5 stories at `pending`:

```json
[
  { "id": "US-001", "title": "Schema, DTO & i18n Extensions",       "status": "pending" },
  { "id": "US-002", "title": "RagService Methods: ...",              "status": "pending" },
  { "id": "US-003", "title": "Import Endpoint: ...",                 "status": "pending" },
  { "id": "US-004", "title": "Toggle Enforcement & Cleanup ...",     "status": "pending" },
  { "id": "US-005", "title": "CLI Command: koda kb import ...",      "status": "pending" }
]
```

If any story is not `pending`, reset it:

```bash
# Reset a single story to pending (replace US-00X as needed)
jq '(.userStories[] | select(.id == "US-001")).status = "pending"' \
  .nax/features/graphify-kb/prd.json > /tmp/prd.tmp && \
  mv /tmp/prd.tmp .nax/features/graphify-kb/prd.json
```

### 1.5 Verify Claude credentials are available

```bash
echo $ANTHROPIC_API_KEY | head -c 10   # should print sk-ant-...
```

If missing, set it before running:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

### 1.6 Note the git SHA for reproducibility

```bash
cd /home/williamkhoo/Desktop/projects/nathapp/koda
git rev-parse HEAD
# Record this in the validation log
```

### 1.7 Confirm no stale `.queue.txt` exists

```bash
ls /home/williamkhoo/Desktop/projects/nathapp/koda/.queue.txt 2>/dev/null \
  && echo "WARNING: stale queue file — remove it" \
  || echo "OK: no queue file"
```

Remove if present:

```bash
rm -f /home/williamkhoo/Desktop/projects/nathapp/koda/.queue.txt
```

---

## Part 2 — Run US-001 (baseline, no injection)

### 2.1 Open two terminal windows

You need two terminals side by side:

- **Terminal A** — runs nax
- **Terminal B** — ready to send the PAUSE signal

### 2.2 Terminal A — start the run

```bash
cd /home/williamkhoo/Desktop/projects/nathapp/koda
nax run --feature graphify-kb
```

The TUI will appear. US-001 will start immediately.

### 2.3 Terminal B — send PAUSE while US-001 is running

Wait until you see US-001 is actively executing (agent session started, not just queued). Then write the PAUSE signal:

```bash
echo "PAUSE" > /home/williamkhoo/Desktop/projects/nathapp/koda/.queue.txt
```

> **Timing:** do this any time while US-001 is executing — before it finishes. The PAUSE is consumed before US-002 starts, not mid-story. US-001 will complete naturally regardless.

Alternatively, if you are watching the TUI, press **`p`** to pause.

### 2.4 Wait for US-001 to complete and the run to stop

You will see output like:

```
[queue] Paused by user
Run paused after US-001.
```

The process exits cleanly. US-001 is now `passed` (or `failed` — see below).

**If US-001 failed:** this is itself a data point. Record the failure reason in the validation log. Do not re-run yet — first understand why it failed and whether it's a nax/environment issue vs. a genuine agent quality issue.

### 2.5 Record US-001 metrics immediately

Open the metrics or logs before doing anything else:

```bash
cd /home/williamkhoo/Desktop/projects/nathapp/koda
# Check story status and attempt count
jq '.userStories[] | select(.id == "US-001") | {status, attempts, escalations}' \
  .nax/features/graphify-kb/prd.json

# Check run metrics (adjust path to your metrics file location)
cat .nax/metrics.json 2>/dev/null | jq '.' | tail -100
```

Fill in the **US-001 section** of [context-v1-graphify-kb-plan.md](./context-v1-graphify-kb-plan.md) now, while fresh.

### 2.6 Read the US-001 diff

```bash
cd /home/williamkhoo/Desktop/projects/nathapp/koda
git diff HEAD~1 HEAD --stat   # files changed
git diff HEAD~1 HEAD          # full diff
```

Answer the qualitative questions in the log:
- What did the agent discover that was non-obvious from the spec?
- Were there rectification cycles? What caused them?
- Did any review findings reveal a codebase constraint that future stories will also hit?

---

## Part 3 — Author `context.md`

### 3.1 Start from the existing analysis (shortcut)

The prd.json already contains a rich `analysis` field from the pre-run debate. Use it as your first draft:

```bash
cd /home/williamkhoo/Desktop/projects/nathapp/koda
jq -r '.analysis' .nax/features/graphify-kb/prd.json
```

Copy the relevant constraints into `context.md`. Focus on things that:
- A fresh agent would not find in the spec itself
- US-001's run either confirmed or refined
- Will directly affect US-002, US-003, or US-004

### 3.2 Create the file

```bash
cat > /home/williamkhoo/Desktop/projects/nathapp/koda/.nax/features/graphify-kb/context.md << 'EOF'
# Feature Context — graphify-kb

_Hand-authored after US-001. Date: YYYY-MM-DD. Source: prd.json analysis + US-001 diff + review findings._

## Decisions

<!-- Chosen approaches confirmed by US-001. Only non-obvious ones. -->

## Constraints

<!-- External rules a fresh agent would not know.
     Seed from analysis: DI cycle risk, source-of-truth discipline, build order. -->

## Patterns Established

<!-- Structural conventions set in US-001 that US-002+ must follow.
     E.g. how the source union is typed, how from() maps nullable fields. -->

## Gotchas

<!-- Traps US-001 hit or nearly hit. -->
EOF
```

### 3.3 Fill in the content

Key items to confirm from US-001 diff and add to each section:

| Item | Section | Evidence to look for |
|:-----|:--------|:---------------------|
| `source` is a string literal union, not an enum | Constraints | `add-document.dto.ts` — how `IsIn` array is typed |
| `RagModule` must export `RagService` for ProjectsModule DI | Constraints | `rag.module.ts` — is `RagService` in `exports[]`? |
| `from()` in `ProjectResponseDto` maps nullables as `null` not `undefined` | Patterns | `project-response.dto.ts` diff |
| i18n keys must exist in BOTH `en/` and `zh/` or app throws at startup | Constraints | `i18n/*.json` files touched in US-001 |
| Content generation formula for nodes | Decisions | Confirmed from spec + prd analysis |
| DI direction: projects → rag only, never reverse | Constraints | prd analysis |
| Build order: US-001 → US-002 → (US-003 ∥ US-004) → regenerate → US-005 | Decisions | prd analysis |
| `graphifyLastImportedAt` is updated in the **controller**, not the service | Constraints | Spec US-003 AC: "controller updates...after successful import" |

**Target total: ≤ 1500 tokens.** Be selective — if it's in the spec verbatim, skip it. Only add what a fresh agent reading the spec would not know.

### 3.4 Verify the file looks reasonable

```bash
cat /home/williamkhoo/Desktop/projects/nathapp/koda/.nax/features/graphify-kb/context.md
wc -w /home/williamkhoo/Desktop/projects/nathapp/koda/.nax/features/graphify-kb/context.md
# rough estimate: words × 1.3 ≈ tokens. Target < 1150 words.
```

---

## Part 4 — Update prd.json for injection

### 4.1 Add `context.md` to `contextFiles` for US-002 through US-005

Edit `.nax/features/graphify-kb/prd.json`. For each of US-002, US-003, US-004, US-005, add `context.md` as the **first entry** in `contextFiles`:

```bash
# Preview current contextFiles for US-002
jq '.userStories[] | select(.id == "US-002") | .contextFiles' \
  /home/williamkhoo/Desktop/projects/nathapp/koda/.nax/features/graphify-kb/prd.json
```

Then open the file in your editor and add the path. The `context.md` path should be relative to the story's `workdir`. US-002–004 have `workdir: "apps/api"`, so the path relative to the koda root is:

```
../../.nax/features/graphify-kb/context.md
```

Result for US-002 (example):

```json
"contextFiles": [
  "../../.nax/features/graphify-kb/context.md",
  "apps/api/src/rag/rag.service.ts",
  "apps/api/src/rag/rag.service.spec.ts"
]
```

For US-005 (`workdir: "apps/cli"`), the relative path is the same:

```
../../.nax/features/graphify-kb/context.md
```

### 4.2 Verify the path resolves

```bash
# From the api workdir, check the relative path resolves correctly
ls /home/williamkhoo/Desktop/projects/nathapp/koda/apps/api/../../.nax/features/graphify-kb/context.md
# Should print the file path without error
```

### 4.3 Confirm prd.json is valid JSON

```bash
jq '.' /home/williamkhoo/Desktop/projects/nathapp/koda/.nax/features/graphify-kb/prd.json > /dev/null \
  && echo "valid JSON" || echo "INVALID — fix before running"
```

---

## Part 5 — Run US-002 through US-004 (injection group)

### 5.1 Terminal A — resume the run

```bash
cd /home/williamkhoo/Desktop/projects/nathapp/koda
nax run --feature graphify-kb
```

nax will see US-001 is already `passed` and start from US-002. Context.md will be injected via `contextFiles` automatically.

### 5.2 Let it run — no PAUSE needed

For the injection group, let US-002, US-003, and US-004 run to completion. US-005 requires a manual step between US-003 and US-005 (OpenAPI client regeneration — see below), so watch for US-004 to complete.

> **Note on parallelism:** US-003 and US-004 can theoretically run in parallel (both depend only on US-002, not each other). If nax runs them in parallel, you will have two concurrent injection data points — good for the experiment.

### 5.3 Record metrics immediately after each story

You can read current story status mid-run without stopping nax:

```bash
# In Terminal B, check story status as they complete
watch -n5 'jq "[.userStories[] | {id, status, attempts}]" \
  /home/williamkhoo/Desktop/projects/nathapp/koda/.nax/features/graphify-kb/prd.json'
```

Fill in the log for each story as it completes. Do not batch — memory of what you observed fades quickly.

### 5.4 After US-003 completes — regenerate the OpenAPI client (required for US-005)

The spec requires this before US-005 can run. If nax hasn't paused automatically, send a PAUSE before US-005 starts:

```bash
echo "PAUSE" > /home/williamkhoo/Desktop/projects/nathapp/koda/.queue.txt
```

Then run the regeneration:

```bash
cd /home/williamkhoo/Desktop/projects/nathapp/koda
bun run api:export-spec   # regenerates openapi.json at repo root
bun run generate          # regenerates apps/cli/src/generated/
```

Then resume:

```bash
nax run --feature graphify-kb
# picks up at US-005
```

### 5.5 Update `context.md` between stories (optional but recommended)

After each story completes, spend 5 minutes reviewing its diff and adding any new learnings to `context.md` before the next story starts. This tests the "growing context" aspect of v1.

---

## Part 6 — Record and decide

### 6.1 Fill in the summary table

Open [context-v1-graphify-kb-plan.md](./context-v1-graphify-kb-plan.md) and fill the summary comparison table from the metrics you recorded per story.

### 6.2 Answer the qualitative questions for each injection story

For each of US-002, US-003, US-004:
1. **Rediscovery incidents** — did the agent re-derive something from `context.md`?
2. **Context used** — where did `context.md` lead to the right call?
3. **Context ignored** — which entries did the agent seem to miss?

### 6.3 Apply the decision gate

| Outcome | Criteria | Action |
|:--------|:---------|:-------|
| **A — build v1** | ≥ 2 of: tier escalation reduced, review findings reduced (≥30%), ≥2 rediscovery incidents prevented, context used in ≥2/3 stories | Open implementation issue for Phase 1 |
| **B — stop** | None of the above | Write ADR shelving v1; redirect to fallback + canonical-rules |
| **C — ambiguous** | 1 metric improved, others neutral | Run US-005, re-decide |

---

## Quick reference

```bash
# Start run
cd /home/williamkhoo/Desktop/projects/nathapp/koda && nax run --feature graphify-kb

# PAUSE after current story (send from a second terminal while nax is running)
echo "PAUSE" > /home/williamkhoo/Desktop/projects/nathapp/koda/.queue.txt

# Check story statuses
jq '[.userStories[] | {id, status, attempts, escalations}]' \
  /home/williamkhoo/Desktop/projects/nathapp/koda/.nax/features/graphify-kb/prd.json

# Reset a story to pending if you need to re-run it
jq '(.userStories[] | select(.id == "US-00X")).status = "pending" |
    (.userStories[] | select(.id == "US-00X")).attempts = 0 |
    (.userStories[] | select(.id == "US-00X")).passes = false' \
  .nax/features/graphify-kb/prd.json > /tmp/prd.tmp && \
  mv /tmp/prd.tmp .nax/features/graphify-kb/prd.json

# Check if context.md path resolves from api workdir
ls /home/williamkhoo/Desktop/projects/nathapp/koda/apps/api/../../.nax/features/graphify-kb/context.md

# Word count of context.md (× 1.3 ≈ tokens)
wc -w /home/williamkhoo/Desktop/projects/nathapp/koda/.nax/features/graphify-kb/context.md

# Remove stale queue file
rm -f /home/williamkhoo/Desktop/projects/nathapp/koda/.queue.txt

# Regenerate OpenAPI client (required before US-005)
cd /home/williamkhoo/Desktop/projects/nathapp/koda && \
  bun run api:export-spec && bun run generate
```

---

## Troubleshooting

### nax starts US-002 before I can PAUSE

Send the PAUSE immediately after starting the run. The queue-check stage fires at the very beginning of each story — even a few seconds of delay after US-001 completes is usually enough. If US-002 already started, let it finish (it's a quick story), then PAUSE before US-003.

### context.md path not found by the agent

Check the relative path from the story's `workdir`. If `workdir` is `apps/api`, the path `../../.nax/features/graphify-kb/context.md` resolves to the koda root's `.nax/features/graphify-kb/context.md`. Verify with:

```bash
ls /home/williamkhoo/Desktop/projects/nathapp/koda/apps/api/../../.nax/features/graphify-kb/context.md
```

If nax resolves `contextFiles` relative to the project root (not `workdir`), use `.nax/features/graphify-kb/context.md` directly — no `../../` prefix. Check by looking at what path the first story's existing `contextFiles` use.

### US-001 fails

Record the failure reason and escalation count. Do not re-run immediately. If it failed due to a nax/environment issue (quota, crash, infrastructure), fix the issue and reset US-001 to `pending`. If it failed due to agent quality (review rejected, verification failed, escalation exhausted), that is itself a valid baseline data point — record it as-is.

### Metrics are not visible in `.nax/metrics.json`

nax logs structured JSONL to the run log directory. Check:

```bash
ls /home/williamkhoo/Desktop/projects/nathapp/koda/.nax/
# look for logs/ or a run-specific directory
```

The TUI's summary screen at run completion also shows escalation count, cost, and tier used per story — screenshot it if the log files are hard to parse.

### OpenAPI regeneration fails before US-005

US-003 must be fully merged and passing for the spec export to include the new endpoint. If the export fails, check that US-003 actually passed and that the new route is present in `rag.controller.ts`. Do not proceed to US-005 without valid generated types.
