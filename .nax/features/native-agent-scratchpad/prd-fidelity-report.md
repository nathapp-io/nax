# PRD Fidelity Report — native-agent-scratchpad

**Spec:** `docs/specs/SPEC-native-agent-scratchpad.md`
**PRD:** `.nax/features/native-agent-scratchpad/prd.json`
**Planner:** `nax plan --profile native`, local build, `openai-codex/gpt-5.6-terra[high]`, mode `refine`, 166s
**Date:** 2026-09-19
**Phase:** 9 of 9 (spec-review)
**Verdict:** ⚠️ 2 blockers found and fixed — PRD patched in place, spec corrected

## Result

| Check | Result |
|:------|:-------|
| 1. Spec AC → PRD AC mapping | ✅ 34 spec ACs → 39 PRD ACs; every spec AC maps to ≥1 |
| 2. Behavioural fidelity | ✅ no AC degraded into file-content/grep; no signature contradictions |
| 3. Orphan PRD ACs | ❌ **blocker** — see B-2 (scope bleed via `description`) |
| 4. File-role delta | ✅ no self-`Creates` in `contextFiles`; one drop, resolved (M-1) |
| 5b. Correction survival | ✅ all spec-review corrections reached `acceptanceCriteria` |
| 5c. PRD-AC satisfiability | ❌ **blocker** — see B-1 |
| 6. Out-of-scope preservation | ✅ 12/12 verbatim; none inverted into an AC; no unprefixed story-scoped hoists |
| 7. Terminal-cleanup story | n/a — feature is purely additive |
| 8. `Modifies` → `modifiedFiles` | ✅ 2 spec paths → 2 entries, each with `path` + `reason`, no leading-comma tell |

## B-1 (blocker, check 5c) — unsatisfiable AC: US-003 #6

**PRD as generated:** *"Given that review declaration, when Write is called with a repository path, then it returns a refused outcome."*

**Codebase reality.** `callTool` (`src/tools/runtime.ts:241`) resolves the tool from the
registry and evaluates `opts.policy.check(...)`. It never consults the op's `tools`
declaration. `advertisedNames` exists but is referenced only by the denial-redirect
helpers (lines 343–347) — it is messaging, not a gate. Under `unrestricted`,
`unconditionalGrants` includes `Write` with `["*"]`, so `callTool("Write", …)` returns
`{kind:"ok"}`. The AC asserts a refusal that cannot occur.

**Origin.** The spec's US-003 AC-5 was **compound**: "calling `ScratchpadWrite` …
returns a non-error outcome, **while calling `Write` with a repository path returns a
refused outcome**." Phase 8 evaluated it as one unit and verified only the first
clause. `nax plan` atomically split it, and the split exposed the false half. This is
precisely the gap check 5c exists to close — Phase 8 never saw the second clause as an
AC in its own right.

**Cost if shipped.** It becomes an acceptance test named `AC-6: …` that can never go
green. nax's acceptance diagnosis returns only `source_bug` / `test_bug` / `both` — it
has no verdict meaning "the criterion is wrong" — so it would blame correct code and
burn `rectification.maxAttemptsTotal` (12) plus tier escalation before blocking.

**Fix applied.** Spec AC-5 split into AC-5 (scratchpad write succeeds) and AC-6 (the
advertised list contains the scratchpad tools and none of `Write`/`Edit`/`Delete`),
with a paragraph recording why the declaration is not a call-time gate. PRD AC #6
patched to match.

## B-2 (blocker, check 3) — orphan scope in US-003 `description`

The planner did not merely split the bad clause; it generalised it into the story's
scope, where `description` **is** rendered into the implementer prompt:

- Goal: *"…while preserving operation declarations as the repository-tool ceiling."*
- Scope/In: *"…and ensure direct calls to undeclared repository tools are refused so the review-op ceiling is effective."*

That mandates a declaration-gate inside `callTool` — material scope that appears
nowhere in the spec and would change the tool runtime's contract for every tool.

**Fix applied.** Both rewritten to state the real mechanism: the declaration is the
ceiling on what is **advertised**; `callTool` consults the policy alone. The Scope
line now carries an explicit *"do not add a declaration gate to `callTool`"*.

## M-1 (major, check 4b) — dropped `Context Files` entry, resolved

The planner dropped `src/prompts/sections/index.ts` from US-005 and substituted
`src/prompts/builders/rectifier-builder-helpers.ts` (it logged the drop itself).

Cause was the spec, not the planner: US-005's prose names **four** builders, but its
`Context Files` listed three plus the barrel, and the five-read cap forced a
substitution. The planner's list is the better one — the barrel export is forced by
AC-4/AC-5 regardless, whereas an unlisted composition site is one the agent will not
find by pattern. Spec aligned to the PRD in `2ee790e37`; no PRD change.

## Non-findings, recorded so they are not re-raised

- **AC-11b survived the split.** US-002 #13 still asserts `resultBytesPreTruncation`
  on `scratchpadReadTool.run` rather than through `callTool`, and #12 keeps truncation
  on the `callTool` path. This was the most degradable item in the spec; the qualifier
  is intact.
- **`storyPoints: 1` on every story** is the inert auto-default, not evidence of
  anything.
- **Empty `story.outOfScope` arrays** are expected — `savePRD` strips the mirrored
  copies and the root field is the on-disk SSOT.
- **No `analysis`-only corrections.** No story carries an `analysis` key.

## PRD patch provenance

`prd.json` was edited in place rather than re-planned, to avoid a second billed run.
Only US-003's `acceptanceCriteria[5]` and `description` changed; a structural diff
confirmed every other field byte-identical. No `status` field was touched, so the
"already passed" no-op trap does not apply. Regenerate with
`nax plan -f native-agent-scratchpad --from docs/specs/SPEC-native-agent-scratchpad.md --profile native`
if planner-authored provenance is preferred — the corrected spec now yields this
content directly.
