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

- **All green → open a ready PR; never auto-merge.** When acceptance + both review phases + quality gates are green and **nothing escalated**, the flow opens (or promotes nax autoPR's existing draft to) a **ready** PR/MR. It never lands/merges code — a human still merges. This is the departure from the standing "never auto-open" discipline, bounded by opt-in + escalate-on-judgment; the flow makes the branch review-ready, not shipped.
- **Escalate via Telegram when configured, else PR/MR comment.** On escalation the flow prefers nax's **Telegram interaction plugin** (`src/interaction/plugins/telegram.ts`, `notify` type) when it is configured, sending the "needs judgment" summary there. When Telegram is not configured, it **falls back to a PR/MR comment** on the branch's existing (autoPR) PR — opening a draft to hold the comment only if none exists. It does **not** open a ready PR when escalating.
- **Opt-in, off by default.** A new config flag gates the trigger, so the flow never fires unless enabled per-repo. Reconciles with nax's existing autoPR (reuse/promote its PR rather than double-open).

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
  → open_or_promote_pr (action)   ← nothing escalated → open/promote to READY PR
  → escalate (acp+action)         ← compose summary; notify Telegram if configured,
                                     else PR/MR comment; exit (no ready PR)
```

- **Node-type mapping** mirrors `pr-triage.flow.ts`:
  - `compute` — pure local shaping (`load_ctx`, `preflight`).
  - `action` — runtime-owned shell/CLI, no model (`resolve_spec`, `acceptance`, `quality_gates`, PR/MR git+`gh`/`glab`).
  - `acp` — a model turn returning strict JSON (`{ route, findings[], ... }`); `switch` edges route `escalate` vs `proceed`, exactly like pr-triage's judgment nodes.
- **Ordering rationale carried over from the skill:** cheap deterministic acceptance gate **before** expensive review; review **phased** (spec → fix → quality on the stabilized diff); repo-root quality gate **last**, once.
- **Escalation target:** Telegram interaction plugin (`notify`) when configured; else a PR/MR comment on the branch's existing autoPR PR (open a draft only if none exists). The message names what needs judgment — the same escalation contract as pr-triage's handoff comments.

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

## Resolved open questions

### 1. Config shape

Add a `finish.autoFlow` block to the `NaxConfig` Zod schema (`src/config/schemas.ts`), defaults via `.default()`, read through a new selector in `src/config/selectors.ts` (never raw JSON). Model tiers use nax's existing vocabulary (`fast` / `balanced` / `powerful`); agent defaults resolve via `resolveDefaultAgent(config)` when unset.

```jsonc
finish: {
  autoFlow: {
    enabled: false,                       // opt-in gate — OFF by default
    flowPath: "flows/nax-finish.flow.ts", // optional override; resolved from nax root
    reviewers: {
      spec:    { agent: null, model: "powerful" },  // adversarial spec lens
      quality: { agent: null, model: "balanced" }
    },
    escalate: { telegram: true }          // prefer Telegram when configured; else PR/MR comment
  }
}
```

Per nax's per-package rule, `finish.autoFlow` is overridable via `.nax/mono/<pkg>/config.json` if it ever needs to differ per package (unlikely, but the layering comes free).

### 2. Review prompts — copied verbatim from `post-impl-review`

The two review `acp` nodes embed the skill's own dimension text, not a paraphrase:

- **`review_spec`** carries `references/spec-review.md` verbatim: the *"map external touchpoints first (read the unchanged collaborators)"* procedure, then **Compliance / Drift / Integration / Convention Compliance**, at the **≥80%** spec-relative confidence threshold.
- **`review_quality`** carries `references/code-quality.md` verbatim: the *"enumerate every changed function"* forcing function, the full defect checklist (test isolation, dead code, leaks, error handling, concurrency, performance, a11y, security, type-safety, design & maintainability), at the **≥60%** confidence threshold.
- Both carry `references/worker-protocol.md`'s **diff acquisition** (`git diff origin/<base>...HEAD`), **noise filter** (lockfiles, generated, `**/.nax/**`, binaries), **severity table** (CRITICAL/HIGH/MEDIUM/LOW), and **finding block format** (`[SEVERITY] title / Problem / Fix`).

Layered on top is the **escalate-vs-proceed classifier** (the only net-new prompt logic): each node returns findings **plus** a route:
- A finding with a clear *recommended fix* (CRITICAL/HIGH, or MEDIUM whose fix is clear and low-risk) → route `proceed` → the `fix_*` node applies it and loops.
- A finding that is a **spec conflict, contradiction, or design/judgment concern** (no safe mechanical fix) → route `escalate`.
- Node returns strict JSON: `{ route: "proceed" | "escalate", findings: [{severity,title,problem,fix}], escalationReason? }`.

**Placement:** the flow lives outside `src/` (see Q3), so nax's src-scoped Prompt-Builder convention doesn't bind it; the copied review text is held in a shared module the flow imports (single source, so it can't drift from the skill by hand-copy). If the flow ever moves under `src/`, the prompt text must move into a `src/prompts/builders/` builder to satisfy `forbidden-patterns.md`.

### 3. Flow-file location & resolution

Top-level **`flows/nax-finish.flow.ts`** (mirrors acpx's own `examples/flows/` convention). Living outside `src/` keeps it clear of nax's src-scoped lint (prompt-builder, file-size ratchet, barrel rules) and gives the plugin a stable path. The plugin's `execute()` resolves it against the nax package root and passes the absolute path to `acpx flow run <abs>`, with `config.finish.autoFlow.flowPath` as the override.

### 4. Test strategy (under the 80% floor, `_deps`, no `mock.module`)

- **Plugin (`IPostRunAction`)** — unit-test `shouldRun` across the branch/success/flag matrix; unit-test `execute` with the spawn boundary injected via `_deps` (fake spawn): assert it builds the correct `acpx flow run` argv from `PostRunContext` and maps the flow result → `{ success, message, url }`. No real `acpx`.
- **Flow** — test the deterministic parts as plain units: `compute` nodes (`load_ctx`, `preflight`, `finalize`) and every `switch`/edge routing function (proceed vs escalate, all-green vs can't-get-green). `action` node bodies take their shell calls via injected deps (fake `nax` / `gh` / `glab` / git). `acp` nodes: snapshot-test the **prompt builder** output (that the copied review text + severity table + classifier instructions are present) rather than invoking a model.
- **Out of the unit floor:** live end-to-end flow execution against a real `acpx flow run` is an e2e concern, gated behind the acpx-flows dependency landing; not counted toward the 80% unit coverage.
- Respect nax rules throughout: `_deps` injection only, no `mock.module()`, no spawning real `nax`/`acpx`/`gh`, temp-dir helpers for any fs, `storyId`-free (this is post-run, not per-story) structured logging.
