# nax-finish as an acpx Flow + Post-Run Plugin — Design

**Date:** 2026-07-24
**Status:** Design (pre-implementation)
**Author:** brainstormed with William Khoo

## Problem

`nax-finish` today is a Claude Code **skill** — imperative prose that a human drives interactively after a `nax run`. It resolves the feature spec, runs the acceptance gate, drives a two-phase `post-impl-review` (spec, then quality) with **user approval before every fix**, runs the repo-root quality gates, and opens/promotes a PR **only on explicit approval**.

We want the same pipeline to run **automatically after a `nax run`, without a human in the terminal**, re-expressed as an **acpx flow** and triggered by a **nax post-run plugin**. This turns a manual review-and-ship ritual into an autonomous finish step that leaves a branch review-ready — or clearly flagged when it can't.

## Decisions (locked during brainstorming)

1. **Autonomous + escalate** (the `pr-triage` model). The flow runs to completion without inline terminal prompts. It auto-fixes what it can and, on anything needing human judgment, **stops and escalates** by commenting on the PR/MR rather than asking.
2. **Auto-fix boundary — fix all *recommended* fixes; escalate only on judgment.**
   - **Auto-fix (loop until green):** every review finding that carries a *recommended* fix (CRITICAL / HIGH / clear low-risk MEDIUM, per `post-impl-review`'s own model), plus mechanical lint/format/typecheck fixes and acceptance-test defects.
   - **Escalate (stop, comment, do not proceed):** spec conflicts, contradictions, design concerns — anything requiring human judgment — **and** anything else the flow cannot cleanly get to green.
3. **Review = two isolated acpx `acp` calls, each agent/model-pinned.** `review_spec` and `review_quality` are **separate isolated `acp` nodes** (own session each), each pinning its own agent + model tier (the way nax pins plan / adversarial roles). This recovers `post-impl-review`'s isolated-subagent property and lets each lens run with its own reviewer.
4. **Quality gates = deterministic `action` + LLM only in loop-fix.** The gate runs the repo's own `quality.commands` mechanically in an `action` (no model). Only a **red** gate spawns an `acp` fix node; then the `action` re-runs and loops — the `pr-triage` CI-lane shape.

### Safe defaults (chosen, changeable)

- **Draft-only, never auto-merge.** The flow opens (or reuses nax autoPR's) **draft** PR. "All green, nothing escalated" → promote draft → **ready**. "Escalated" → leave draft + comment naming what needs judgment, then exit. The flow never lands code; a human still merges. This softens the departure from the standing "never auto-open/merge" discipline — the branch is made review-ready, not shipped.
- **Opt-in, off by default.** A new config flag gates the trigger, so the flow never fires unless enabled per-repo. Reconciles with nax's existing autoPR (reuse its draft rather than double-open).

## Architecture

Two artifacts, **both in the nax repo**. No acpx-fork code changes — the flow is authored against the existing `acpx/flows` API.

### 1. `nax-finish.flow.ts` — the pipeline as a flow graph

```
load_ctx (compute)         ← PostRunContext: feature, workdir, prdPath, branch
  → resolve_spec (action)   ← nax features resolve <feature> --json
  → preflight (compute)     ← commits-ahead of base > 0? else terminate "already merged"
  → acceptance (action)     ← run per-group acceptance tests
      └─ defect → fix_acceptance (acp loop) → re-run acceptance
  → review_spec (acp · isolated · agent+model pinned)
      ├─ spec conflict / contradiction / design concern → escalate
      └─ recommended fixes → fix_spec (acp loop) → re-run acceptance
  → review_quality (acp · isolated · own agent+model)
      ├─ judgment findings → escalate
      └─ recommended fixes → fix_quality (acp loop)
  → quality_gates (action: quality.commands, mechanical)
      ├─ red → fix_gate (acp loop) → re-run quality_gates
      └─ can't get green → escalate
  → open_or_promote_pr (action)   ← draft; promote → ready only if nothing escalated
  → escalate (acp+action)         ← compose + post PR/MR comment, exit
```

- **Node-type mapping** mirrors `pr-triage.flow.ts`:
  - `compute` — pure local shaping (`load_ctx`, `preflight`).
  - `action` — runtime-owned shell/CLI, no model (`resolve_spec`, `acceptance`, `quality_gates`, PR/MR git+`gh`/`glab`).
  - `acp` — a model turn returning strict JSON (`{ route, findings[], ... }`); `switch` edges route `escalate` vs `proceed`, exactly like pr-triage's judgment nodes.
- **Ordering rationale carried over from the skill:** cheap deterministic acceptance gate **before** expensive review; review **phased** (spec → fix → quality on the stabilized diff); repo-root quality gate **last**, once.
- **Escalation target:** the draft PR/MR for the branch (reuse nax autoPR's if present, else open a draft to hold the comment). The comment names what needs judgment — the same escalation contract as pr-triage's handoff comments.

### 2. `nax-finish` post-run plugin — the trigger

An `IPostRunAction` (`src/plugins/extensions.ts:280`), loaded by the Runner in `runCompletionPhase`:

- `shouldRun(ctx)` → true only when: the run **succeeded**, HEAD is a **feature branch** (not `main`/`master`), and the **opt-in config flag** is set.
- `execute(ctx)` → shells `acpx flow run nax-finish.flow.ts` with the `PostRunContext` (`runId`, `feature`, `workdir`, `prdPath`, `branch`, `storySummary`) as `--input-json`; returns `{ success, message, url }` (the PR/MR URL when opened/promoted).

`IPostRunAction` is preferred over the script-based `on-complete` hook because it passes the flow **structured context** and has a real `shouldRun` gate. The `on-complete` shell hook is the lighter fallback if a one-liner is preferred over a compiled plugin.

## What changes vs. the skill (drift to accept deliberately)

- **No inline approval.** The skill's per-fix approval gates are replaced by the auto-fix boundary + escalation. This is the whole point of autonomous mode; it is a sanctioned departure from the standing approval discipline, bounded by draft-only / opt-in / escalate-on-judgment.
- **`post-impl-review` dispatch is re-expressed, not called.** A flow `acp` node cannot invoke a Claude Code skill. The two review phases become two isolated `acp` nodes prompted to perform the review against the diff and return structured findings — like pr-triage's `review_loop` over `codex review`. Isolation is preserved (each `acp` node is its own session) and improved (per-phase agent/model), but the exact two-phase subagent fan-out inside `post-impl-review` is not reused verbatim. **This is the primary behavioral-drift risk** and the bulk of the authoring work.
- **Acceptance / quality-gate reproduction fidelity.** The flow's `action` nodes must reproduce nax's per-package cwd + absolute-`{{FILE}}` acceptance execution and the root `quality.commands` exactly as the skill documents, or green-from-wrong-cwd bugs reappear.

## Dependency prerequisite

Flows currently live in the **acpx-fork**, not released acpx. For nax's `execute()` to shell `acpx flow run`, the acpx that nax depends on must include the `flow` command. This work is **gated on acpx flows shipping** (or nax pointing its acpx dependency at the fork).

## Non-goals

- Auto-merging or landing code (draft-only by design).
- Replacing the interactive `nax-finish` skill — the skill stays for manual, approval-gated finishes; this flow is the autonomous, opt-in path.
- Any change to the acpx flows runtime/API (fork stays as-is).

## Open questions for the plan

- Config shape/name for the opt-in flag and per-phase reviewer agent/model pins (fit into the existing `NaxConfig` Zod schema).
- Exact escalate-vs-proceed classification prompt for the `review_*` acp nodes (how "recommended fix" vs "judgment call" is decided in-prompt).
- Where the flow file physically lives and how it's resolved/pathed from the plugin's `execute()`.
- Test strategy for a flow + plugin under nax's 80% coverage floor and `_deps`/no-`mock.module` rules.
