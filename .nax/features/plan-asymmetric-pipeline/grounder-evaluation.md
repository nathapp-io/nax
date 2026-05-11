# Grounder Evaluation

Date: 2026-05-11
Branch: `fix/plan-debate-grounder-packageview`

## Summary

The grounder is working mechanically, but it does not yet produce a clearly better PRD than the single-session planner.

## What Worked

- The debate pre-phase now runs without the earlier `ctx.packageView.select` crash.
- The grounder prompt is now much smaller and uses source-root context instead of the older large file-tree dump.
- Grounder retries now support same-session repair and use a stronger repair prompt.
- Retry diagnostics now distinguish:
  - invalid JSON
  - valid JSON but invalid schema
  - near-output-cap schema failures

## Observations From Prompt Audits

- Earlier grounder prompt audit size was about 1030 lines.
- After tightening to source-root context, a later grounder prompt audit dropped to about 611 lines.
- This likely reduced prompt overload, but did not fully solve manifest quality issues.

## Retry Findings

- Several grounder retries were not true JSON-parse failures.
- The model returned valid JSON, but the manifest still failed schema validation.
- The most common issue was using `null` for optional string fields such as:
  - `verification.factId`
  - `verification.evidence`
  - `gaps[].evidence`
- The schema expects these fields to be omitted when absent, not set to `null`.

## PRD Quality Comparison

Compared:

- Grounder + debate: `.nax/features/plan-asymmetric-pipeline/prd.json`
- Single session: `.nax/features/plan-asymmetric-pipeline/prd-single.json`

Result:

- The grounder-assisted PRD is not clearly better overall.
- It did help some architecture and rollout details, especially around `config.plan.pipeline`.
- But it did not reliably correct stale or incorrect assumptions inherited from the spec.
- It also did not consistently improve factual precision enough to make the final PRD decisively better than the single-session version.

## Current Verdict

- Grounder wiring: yes
- Grounder influence on planner output: yes
- Clear PRD quality win over single-session planning: not yet

## Main Follow-Up Areas

- Continue tightening the repair prompt and schema guidance.
- Make absence claims even more conservative.
- Consider improving negative-claim validation before manifest injection into debate.
- Evaluate on a small fixed benchmark set instead of a single feature.
