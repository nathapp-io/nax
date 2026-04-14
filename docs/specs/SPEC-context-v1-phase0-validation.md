# SPEC: Context Engine v1 — Phase 0 Validation Plan

> **Status:** Executable validation plan. No code changes. Decision gate for whether to build `SPEC-feature-context-engine.md` (v1) and — by extension — any of `SPEC-context-engine-v2.md`'s context-dependent sections.

## Purpose

Before writing a single line of context-engine code, establish empirical evidence that **manually injecting feature-scoped context** into a nax story's agent session measurably improves outcomes relative to the current baseline (CLAUDE.md + rules + adversarial review).

If injection helps, v1 is justified. If it doesn't, neither v1 nor v2's stage-aware / progressive / provider architecture is worth building. The whole premise collapses.

This plan is the test.

## Hypothesis

> *Injecting a concise, hand-curated Markdown summary of a feature's prior-phase decisions, constraints, and gotchas into a new story's agent prompt will reduce one or more of: escalation rate, review finding count, rectification iterations, human intervention.*

## Non-goals

- No automated extractor. No summarizer. No fragment merger. No orchestrator. Nothing from v1 or v2 is built here.
- No decision about architecture. We're measuring whether the *effect* exists, not evaluating a design.
- No attempt to measure generalization across many features — one feature is enough to answer "does the effect exist."
- No statistical significance claims. Sample size (3–5 stories) is too small. We're looking for *obvious* signal, not marginal effects.

## Method

### Step 1 — Pick the candidate feature

Select **one** in-flight multi-phase feature with these properties:

- ≥ 3 stories remaining (provides enough sample points).
- At least 2 stories already completed (provides material for the context file).
- Non-trivial scope (touches multiple files, involves real decisions, not a pure rename).
- You are confident you understand the feature well enough to author a good context file. Authoring ability, not the engine, is the variable under test here.

Current candidates (from `.nax/features/`): `debate-session-mode`, `per-agent-model-map`, `multi-agent-debate`. Pick whichever has the most remaining stories and whose PR history shows rediscovered constraints (good signal that context injection would help).

Record the choice and rationale in the validation log.

### Step 2 — Establish a baseline

Before any injection, for the selected feature:

- **Retrospectively score the last 2 completed stories** using the metrics in Step 5 below (read their run logs, metrics, commits). This is the "no injection" baseline.
- **Prospectively run 1 story with no injection** (current behavior). This confirms the baseline is stable and not a historical artifact.

Three baseline data points minimum. If the two retrospective stories behave very differently from the prospective one, investigate — something changed in the environment, and the experiment isn't clean.

### Step 3 — Hand-author `context.md`

Create `.nax/features/<feature-id>/context.md` **by hand**. Do not use any LLM to generate it. This is a human writing down what they know to be true about the feature.

Follow v1's format but simplified:

```markdown
# Feature Context — <feature-id>

_Hand-authored for Phase 0 validation on <date>. Covers phases/stories: <list>._

## Decisions

- **<short title>**
  <2-3 sentences of rationale. Cite the phase/commit.>

## Constraints

- **<short title>**
  <2-3 sentences of what the constraint is and how it was discovered.>

## Patterns Established

- **<short title>**
  <2-3 sentences.>

## Gotchas

- **<short title>**
  <2-3 sentences — specifically things the next story could trip over.>
```

**Content rules:**

- ≤ 1500 tokens total. Longer means you're re-deriving from raw material; be more selective.
- Cite evidence for every entry (PR, commit, review finding, file:line).
- Only things a fresh agent would **not** already know from `CLAUDE.md`, the PRD, or the diff it sees.
- Skip audience tags for Phase 0 (one blob injected for every role — filtering is a v1 concern).

Commit the file on a branch so you can revert; or keep it local, up to you. Git presence is not part of the experiment.

### Step 4 — Run 3 stories with injection

Pick the next 3 stories queued on the feature. For each, inject the context file into the agent's context:

- **Fastest path:** add `context.md`'s path to the story's `contextFiles` array in `prd.json` (if that field exists and is already wired into the prompt builder). Check in `src/prd/` and `src/context/injector.ts` for the existing mechanism.
- **If `contextFiles` doesn't exist or doesn't feed into the agent prompt:** manually concatenate `context.md` into the story's `description` field, clearly fenced:

  ```markdown
  ## Prior-phase context

  <contents of context.md>

  ---

  ## Story

  <original story description>
  ```

- **Do not edit code to make injection work.** If the simplest manual mechanism doesn't deliver the content to the agent, stop and rethink — either the injection mechanism is itself the bottleneck (interesting signal), or we're building scaffolding before testing the hypothesis.

Update `context.md` **only between stories**, not mid-story. If story 1 reveals a new decision worth capturing, add it before story 2. This is the "growing context" assumption v1 bakes in; Phase 0 exercises it at 1/feature-authored scale.

### Step 5 — Metrics to record per story

For every story in baseline and injection groups:

| Metric | How to measure | Why |
|:-------|:---------------|:----|
| **Tier escalations** | Count of tier climbs in `src/execution/escalation/` logs (`story.escalations.length`) | Direct signal of "the agent couldn't do it at first try." |
| **Review findings (semantic)** | Count in `ctx.reviewFindings` of kind `semantic` | Did the agent produce code the reviewer flagged? |
| **Review findings (adversarial)** | Count of kind `adversarial` | Same, for the harsher reviewer. |
| **Rectification iterations** | Count of rectification loop runs | How many cycles before passing. |
| **Autofix iterations** | Count of autofix runs | Cheap automated retries. |
| **Human interventions** | Count of manual operator actions (pauses, aborts, edits) | Subjective but recordable. |
| **Wall clock** | Story start → complete, from metrics | Cost proxy. |
| **Rediscovery incidents** | Manual review of the agent's diff for *specific known prior-phase facts being re-derived from scratch* | **The key qualitative metric.** |
| **Context relevance (subjective)** | After story completes, does the diff show the agent actually used info from `context.md`? (yes / partial / no / can't tell) | Sanity check that injection was read, not just present. |

The first six are already tracked in `StoryMetrics`. The last three require manual review and a short written note per story.

### Step 6 — Qualitative review (most important)

Numbers are suggestive. The decisive question is qualitative:

After each injection-run story, read the diff and the agent's session log and answer, in writing:

1. **Did the agent behave differently** than a baseline story on this feature would have? If yes, describe how.
2. **Are there specific moments** where you can point to a line in the diff or a decision in the agent's work and say "that's because the context file told them so"? List them.
3. **Are there specific moments** where the agent seems to have *ignored* the context? (E.g., re-derived something that was explicit in `context.md`.) List those too.
4. **Would the same story have been easier or harder** for the reviewer if the context had not been injected?

A story where you cannot honestly answer "yes, I saw the context make a difference here" is a null result for that story, regardless of what the metrics say. Two consecutive null results should halt the experiment early.

## Decision gate

After 3 injection stories (minimum) or 5 (preferred), decide one of three outcomes:

### Outcome A — Clear benefit

Criteria — at least two of the following, across the injection group, compared to the baseline group:

- **≥30% fewer tier escalations** on average.
- **≥30% fewer review findings** on average.
- **≥2 qualitative rediscovery incidents prevented** that are directly attributable to a context entry.
- **Subjective context-relevance = "yes"** for at least 2/3 stories.

**Action:** Proceed to build v1 Phase 1 (read-path only, minimal surface). File a follow-up issue to run Phase 0 on a second feature as a sanity check before expanding.

### Outcome B — No clear benefit

Criteria — none of the above met, or injection-group metrics within baseline noise.

**Action:** **Stop.** Do not build v1. Do not build v2's context-dependent sections. Write up a short note in `docs/adr/` documenting what was tried and why the hypothesis didn't hold. Redirect attention to the two context-independent v2 sections (`SPEC-agent-fallback.md`, `SPEC-canonical-rules.md`) or elsewhere.

### Outcome C — Mixed / ambiguous

Criteria — one metric improves, others don't; or qualitative review is mixed.

**Action:** Run 2 more stories. If still ambiguous, treat as Outcome B — the effect is too small to justify v1's code surface. Ambiguous results often mean the real pain is elsewhere; interrogate what's actually bottlenecking feature delivery and write that up instead.

## What this plan does NOT commit to

- Does not build `FeatureContextProvider`, `resolveFeatureId`, or any v1 code.
- Does not require code changes unless the manual injection mechanism fails (in which case the *lack* of a mechanism is itself the bottleneck worth fixing, but separately).
- Does not answer questions about stage-aware injection, multi-provider orchestration, session scratch, agent fallback, or canonical rules. Those are out of scope.

## Time and cost envelope

- **Authoring `context.md`**: 30–60 minutes per feature, one-time.
- **Per-story measurement overhead**: ~15 minutes of manual qualitative review (reading diff + session log + writing notes).
- **Elapsed time to complete the experiment**: 1–2 weeks, bounded by the feature's natural story cadence. Do not rush stories to hit the experiment window.
- **LLM cost**: zero incremental (stories would have run anyway; injection just changes the prompt content).

## Validation log template

Keep a single file at `docs/validation/context-v1-phase0-log.md` (gitignored or committed, up to you):

```markdown
# Context Engine v1 — Phase 0 Validation Log

## Feature: <id>
Selected: <date>
Rationale: <why this feature>

## Baseline (no injection)

### Story <id> (retrospective)
- Escalations: N
- Review findings: semantic=N, adversarial=N
- Rectifications: N
- Notes: <qualitative>

### Story <id> (retrospective)
...

### Story <id> (prospective, no injection)
...

## context.md authored: <date>
Tokens: N
Entries: decisions=N, constraints=N, patterns=N, gotchas=N

## Injection group

### Story <id>
Injection method: <contextFiles | description-fence>
- Metrics: ...
- Qualitative answers to the 4 questions: ...

### Story <id>
...

## Decision: A / B / C
Rationale: <one paragraph>
Next action: <build v1 / stop / run more>
```

That log *is* the deliverable of this spec.

## Risks to the experiment itself

- **Authoring quality confounder.** A great `context.md` makes injection look better than a typical auto-extracted one would. This is acknowledged; Phase 0 establishes *upper bound* on the benefit. Auto-extracted context in later phases will be weaker.
- **Feature selection bias.** Picking a feature you already know well biases toward success. Mitigated by writing down the rationale before running; readers can judge.
- **Story variance.** 3–5 stories is small. Ambiguous results route to Outcome C, which adds samples. Strong signal is the goal, not statistical rigor.
- **Hawthorne effect.** You know which stories have injection. The qualitative review is subject to confirmation bias. The numeric metrics are not — prefer them when qualitative and quantitative disagree.

## Exit

This spec closes when the validation log records a decision (A, B, or C). At that point:

- **A** → `SPEC-feature-context-engine.md` Phase 1 begins.
- **B** → v1 and context-dependent v2 are shelved. Document why.
- **C** → more samples, re-decide.
