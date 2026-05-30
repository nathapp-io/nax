# Prompt-Audit Analysis — nax & rs-stock (post 2026-05-15)

**Date:** 2026-05-30
**Scope:** `~/.nax/{nax,rs-stock}/prompt-audit/**`, entries with `ts > 2026-05-15`
**Volume:** 493 nax + 974 rs-stock audit entries across stages `review / run / rectification / acceptance / verify`; agents `claude`, `codex`, `opencode`.
**Method:** Each finding re-verified against the raw JSONL twice — once over the full window (after 2026-05-15) and once over the **last-2-days window** (after 2026-05-28) to separate *still-live* defects from *already-resolved* ones. Recent runs confirmed present (nax 2026-05-29: 30 entries; rs-stock 2026-05-28→29: 74 entries), so an empty last-2-days result is a real "fixed" signal, not "no data."

## How prompts are assembled (context)

Prompts are **composed from section builders**, not templated. `src/prompts/compose.ts` concatenates `src/prompts/sections/*` (constitution → role/task → story → isolation → hermetic → behavioral-guardrails → self-verification → context.md → conventions/security → story reminder). Stage-specific prompts come from class builders in `src/prompts/builders/` (`AdversarialReviewBuilder`, `ReviewPromptBuilder`, `RectifierPromptBuilder`, `AcceptancePromptBuilder`, …). Story text is injected **verbatim** by `sections/story.ts`; the constitution is layered global + project by `constitution/loader.ts`.

---

## Status summary

| # | Finding | Origin | Full window | Last 2 days | Action |
|---|---------|--------|:-----------:|:-----------:|--------|
| 1 | Literal `\n` leaks into story descriptions | Upstream (PRD/spec authoring) + unguarded render seam | nax 6, rs-stock 61 | **0** | Defensive render-time normalization (latent risk) |
| 2 | Adversarial review downgrades fake/placeholder tests to non-blocking | Prompt builder | Live | Live | **Fix prompt** |
| 3 | `opencode` rubber-stamps reviews / no-ops acceptance | Prompt builder + agent capability | nax 14/103, rs-stock 69/298 | rs-stock **8** | **Fix prompt** |
| 4 | Contradictory full-suite test instruction across stages | Prompt builder | nax 52 vs 129, rs-stock 17 vs 202 | Live | **Fix prompt** |
| 5 | Run-prompt bloat (2× constitution, 2× ACs) | Prompt builder | nax 95, rs-stock 5 | nax 7, rs-stock 5 | Trim (low priority) |
| 6 | `grep \| wc -l` ACs are environment-fragile | **PRD/spec authoring** — *out of scope for prompt builder* | nax 46, rs-stock 21 | **0** | Already resolved upstream; no prompt change |

> **#6 is excluded** from prompt-builder remediation — confirmed a PRD-writing / spec-writing concern. It does not appear in any run from the last two days. No action in the prompt layer.

---

## Findings

### 🔴 2. Adversarial review downgrades genuinely-fake tests to non-blocking — *still live*

The AC-grounding rules in `src/prompts/builders/adversarial-review-builder.ts` are tuned so hard against false positives (the *"AC names the file but not the symbol"* trap → emit `info`/`warning`) that real blockers slip through as advisory and the story passes.

**Canonical evidence** — nax `US-005.S1` (`story-orchestrator-consolidation`), adversarial reviewer:
- Found a 460-line test file where **every body is `expect(true).toBe(true)`** covering AC1 and AC2.
- Quoted the proof: `expect(true).toBe(true); // Placeholder - will fail when implementation missing`.
- Returned **`"passed": true`** with the finding as `"warning"` — because no AC bullet named the exact symbol.

A green suite that is green only because the assertions are placeholders is precisely what adversarial review exists to catch. Corroborating: multiple `review` responses that mention `placeholder` / `expect(true)` / `no-op` still return `passed:true` (nax `US-004`, `US-005.S2/S3`, `US-002`; rs-stock `US-001` backtester-phase-2, `US-002` universe-multi-source).

**Recommendation:** add a carve-out in the adversarial builder — tautological/placeholder/empty test bodies (`expect(true)`, `expect(x).toBe(x)`, empty body, `it.skip` covering an AC) that cover an acceptance criterion are **always `"error"`**, exempt from the symbol-naming requirement. The AC's behavior is provably unverified, so it must block regardless of which symbol the AC names.

### 🟠 3. `opencode` rubber-stamps reviews and no-ops acceptance — *still live in rs-stock*

Weaker agents don't engage with the long review/acceptance prompts; they emit an empty pass or nothing at all.

- **Review rubber-stamp** (`passed:true`, empty findings, <120-char response, zero tool calls):
  - nax: **14 / 103** opencode reviews (full window); **0** in last 2 days.
  - rs-stock: **69 / 298** opencode reviews (~23%); **8 still in the last 2 days**.
- **Acceptance no-op** (len-0 response): rs-stock `acceptance|opencode` **13** (full window); the JSON-only one-shot refinement frequently returns nothing.
- **Empty responses generally** (len-0, no error): rs-stock `acceptance|opencode` 13, `review|opencode` 3, `run|opencode` 1, `verify|opencode` 1; nax `rectification|claude` 4. Last-2-days: only rs-stock `verify|opencode` 1 remains.

Compare `claude`/`codex`, which read files and grep before verdicting (see the semantic-review transcript that inspects `_portfolio.py` line-by-line).

**Recommendation:**
1. **Review prompt** — require an evidence trail before `passed:true` is accepted: at least one `verifiedBy.observed` quote **or** an explicit "files inspected" list. Reject a verdict that claims `passed:true` with no investigation (treat as parse-retry, not a pass).
2. **Acceptance prompt** — route len-0 / non-JSON responses through `op.retry` / `sendWithParseRetry` (the consolidated parse-retry framework) instead of silently accepting an empty refinement.

### 🟠 4. Contradictory full-suite test instruction across stages — *live at scale*

The same agent, across one story lifecycle, receives opposite instructions about running the full suite:

- **Rectification prompt** (`RectifierPromptBuilder`): *"run the FULL repo test suite — the EXACT command below: `bun run test`"* — nax **52**, rs-stock **17** prompts.
- **Run / verify prompt** (`sections/isolation.ts`): *"NEVER run the full test suite without a filter — full suite output will flood your context window and cause failures."* — nax **129**, rs-stock **202** prompts.

This whiplash correlates with stalled rectification: the deferred-regression rectification transcript (nax `US-002`, `rectification-runtime-required`) returned a **len-0 response** — the agent produced nothing. nax `rectification|claude` had **4** empty responses overall.

**Recommendation:** reconcile the two. In the rectification prompt, point at the time-boxed wrapper from `.claude/rules/testing-commands.md` (`bun run test` already process-group-boxed) and **explicitly state the context-flood guardrail is intentionally lifted for this gate** — so the rectifier and the run/verify isolation rules stop contradicting each other.

### 🟡 1. Literal `\n` leaks into story descriptions — *dormant, latent risk*

`sections/story.ts` (`buildStorySection` / `buildBatchStorySection` / `buildStoryReminderSection`) and the review/acceptance builders inject `story.description` **verbatim**. Specs authored with escaped newlines render Python code blocks and paragraph breaks as literal `\n` on one logical line.

- Full window: nax 6 (rectification 5, acceptance 1), rs-stock 61 (review 22, acceptance 19, run 14, rectification 6).
- **Last 2 days: 0** — consistent with the root cause being **upstream PRD/spec authoring** (same family as #6), which appears to have been corrected.
- Evidence: rs-stock `backtester-phase-1` review prompt — `...validation.\n\n**Approach** — verbatim from spec:\n\nNew module...\n\nclass BacktestEngineError(Exception):` all on one line.

**Recommendation (optional, defensive):** normalize `description.replace(/\\n/g, "\n")` (plus `\\t`, `\\"`) at the single PRD-load boundary so every downstream builder is protected even if a future spec reintroduces escaped newlines. Not urgent — currently dormant.

### 🟡 5. Run-prompt bloat — *low priority*

- **2× constitution:** nax 95/128 run prompts carry both the global `# nax Constitution` and the project `# nax Project Constitution` (heavy overlap: both restate Bun-native, testing, error-handling). This is intentional layering in `constitution/loader.ts:87`, not a bug — but for projects that ship a complete constitution, `skipGlobal` removes the redundant generic copy.
- **2× acceptance criteria:** ACs print verbatim in the story section and again in the end-of-prompt "reminder" recency anchor (`buildStoryReminderSection`). The reminder repeat is by design; harmless but worth trimming for smaller-context agents.

---

## Suggested priority order (prompt-builder scope)

1. **#2** — placeholder-test carve-out in `adversarial-review-builder.ts`. Closes a real quality-gate hole; still live.
2. **#3** — evidence-required review verdict + acceptance parse-retry. Stops silent rubber-stamps/no-ops; still live in rs-stock.
3. **#4** — reconcile the full-suite test instruction between rectification and run/verify. Live at scale; correlated with stalled cycles.
4. **#1** — defensive `\n` normalization at the PRD-load seam. Dormant; do opportunistically.
5. **#5** — trim constitution/AC duplication. Cosmetic.

*#6 intentionally omitted — PRD/spec-writing origin, already absent from recent runs.*
