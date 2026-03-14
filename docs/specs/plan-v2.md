# Plan v2 — Spec-to-PRD Pipeline

**Status:** Draft
**Branch:** `feat/acp-agent-adapter`
**Date:** 2026-03-14

---

## Problem

Current nax has a 3-step pipeline: `plan` → `analyze` → `run`. In practice, `plan` and `analyze` are unused — William writes PRD JSON manually. With ACP integration, we can make `plan` genuinely useful: read a spec, scan the codebase, decompose into stories, and output a ready-to-run `prd.json`.

## Commands

### 1. `nax plan` — Plan Only

Generate `prd.json` from a spec. Review before running.

```bash
# Interactive (default) — ACP session with Q&A
nax plan -f my-feature --from spec.md

# One-shot (no interaction)
nax plan -f my-feature --from spec.md --auto
```

**Flow:**
1. Read spec from `--from` path
2. Scan codebase (file tree, deps, test patterns)
3. Start ACP session (interactive) or single LLM call (auto)
4. Interactive: agent asks clarifying questions → human answers via interaction bridge
5. Agent decomposes spec into stories with complexity, acceptance criteria, test strategy
6. Write `nax/features/<feature>/prd.json`

### 2. `nax run --plan` — Plan + Execute

Plan and execute in one flow. Always interactive via ACP — the agent asks questions during planning, you confirm the story breakdown, then execution begins.

```bash
nax run -f my-feature --plan --from spec.md
```

**Flow:**
1. **Plan phase:** Same as `nax plan` interactive mode
2. **Confirmation gate:** Display story breakdown, wait for approval

```
📋 Plan generated (3 stories):
  ST-001: Add slugify function [simple]
  ST-002: Add truncate function [simple]
  ST-003: Add formatDate function [medium, depends: ST-001]

Proceed? [Y/n]
```

3. **Run phase:** Execute stories from generated `prd.json` (normal `nax run` flow)

In `--headless` mode, skip confirmation and execute immediately.

## Output Format

Plan outputs a valid `prd.json` that `nax run` can execute directly:

```json
{
  "project": "<detected-from-package.json-or-git>",
  "branchName": "feat/<feature>",
  "feature": "<feature>",
  "userStories": [
    {
      "id": "ST-001",
      "title": "...",
      "description": "...",
      "acceptanceCriteria": ["AC-1: ...", "AC-2: ..."],
      "complexity": "simple|medium|complex|expert",
      "status": "pending",
      "dependencies": [],
      "contextFiles": ["src/relevant-file.ts"],
      "testStrategy": "test-after|tdd-lite|three-session-tdd"
    }
  ]
}
```

### Field Sources

| Field | Source |
|:------|:-------|
| `project` | `package.json` name or git remote |
| `branchName` | `feat/<feature>` (auto-generated, overridable with `-b`) |
| `feature` | From `-f` flag |
| `userStories[].id` | Auto-assigned: `ST-001`, `ST-002`, ... |
| `userStories[].complexity` | LLM classification based on codebase context |
| `userStories[].status` | Always `"pending"` |
| `userStories[].dependencies` | LLM-detected ordering constraints |
| `userStories[].contextFiles` | LLM-identified relevant source files |
| `userStories[].testStrategy` | LLM recommendation based on complexity + codebase patterns |

## Prompt Design

The planning prompt includes:

1. **Codebase context** — file tree, dependencies, test patterns (from `scanCodebase()`)
2. **Spec content** — the human-written spec (from `--from`)
3. **Output schema** — exact JSON structure expected (with examples)
4. **Classification guide** — complexity definitions + routing implications:
   - `simple`: single-file change, clear pattern to follow → fast tier
   - `medium`: multi-file, some design decisions → balanced tier
   - `complex`: cross-cutting, architectural changes → quality tier
   - `expert`: novel patterns, security-critical → expert tier
5. **Test strategy guide** — when to recommend each strategy:
   - `test-after`: simple stories, clear implementation path
   - `tdd-lite`: medium stories, test-writer + implementer + verifier
   - `three-session-tdd`: complex stories, full TDD cycle

## CLI Specification

### `nax plan`

```
nax plan -f <feature> --from <spec-path> [--auto] [-b <branch>] [-d <dir>]
```

| Flag | Required | Default | Description |
|:-----|:---------|:--------|:------------|
| `-f, --feature` | Yes | — | Feature name |
| `--from` | Yes | — | Path to spec file |
| `--auto` | No | `false` | One-shot mode (no interaction) |
| `-b, --branch` | No | `feat/<feature>` | Branch name |
| `-d, --dir` | No | `cwd` | Project directory |

### `nax run --plan`

```
nax run -f <feature> --plan --from <spec-path> [--headless] [-d <dir>]
```

| Flag | Required | Default | Description |
|:-----|:---------|:--------|:------------|
| `-f, --feature` | Yes | — | Feature name |
| `--plan` | Yes | — | Enable plan phase before execution |
| `--from` | Yes (with `--plan`) | — | Path to spec file |
| `--headless` | No | `false` | Skip confirmation, execute immediately |

## Config Changes

```typescript
export interface PlanConfig {
  /** Model tier for planning (default: balanced) */
  model: ModelTier;
  /** Output directory pattern (relative to nax/) */
  outputPath: string;  // default: "features/{feature}/prd.json"
}
```

`outputPath` changes from spec.md to `features/{feature}/prd.json`. The `{feature}` placeholder is resolved at runtime.

## Implementation Plan

### Phase 1: Auto mode (`nax plan --auto`)
1. Update `PlanConfig.outputPath` default
2. Rewrite `planCommand()` — accept spec input, output PRD JSON
3. Build structured prompt with output schema + classification guide
4. Parse LLM JSON output → validate against PRD schema → write file
5. Tests: prompt construction, JSON parsing, schema validation

### Phase 2: Interactive mode (`nax plan` default)
1. Wire ACP interaction bridge (already in PlanOptions, untested)
2. Test interaction flow: question detection → human response → continuation
3. Agent builds PRD incrementally through conversation
4. Final output: same `prd.json` format

### Phase 3: `nax run --plan`
1. Add `--plan` and `--from` flags to run command
2. Run plan phase → confirmation gate → run phase
3. In `--headless`, skip confirmation
4. Tests: plan-to-run handoff, confirmation gate behavior

### Phase 4: Cleanup
1. Deprecate `nax analyze` (keep as hidden alias for backward compat)
2. Remove old `plan` → `spec.md` output path
3. Update `nax init` scaffolding messages

## Backward Compatibility

- `nax analyze` remains functional but deprecated — prints warning pointing to `nax plan`
- `nax plan <description>` (old positional arg form) → error with migration message
- Existing `prd.json` files are unaffected — `nax run` doesn't care how they were generated

## Dependencies

- ACP adapter (done — `feat/acp-agent-adapter`)
- Interaction bridge (wired but untested)
- `scanCodebase()` (exists)
- PRD schema validation (exists in precheck)

## Out of Scope

- Plan does NOT split/rewrite existing stories
- Plan does NOT assign per-role tier routing (deterministic routing handles this)
- Plan does NOT execute stories — `nax run` does that (unless `--plan` flag)
- Plan does NOT support resuming a partial interactive session
- Per-role tier routing (test-writer cheaper than implementer) — not needed
