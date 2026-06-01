# PLAN — Phase 8: Dead-Weight Deletion (scope)

**Author:** William
**Date:** 2026-06-02
**Status:** Scoped — ready to execute
**Predecessor:** `PLAN-test-suite-trim.md` (Phases 0–7 complete, -20.3%)

---

## Why this phase exists

Phases 1–7 chased a *count* via `test.each` folding. The audits correctly rejected
most files because their tests are genuinely distinct — folding them would hide bugs.
The residual count (8,104) reflects mostly-distinct tests, so further folding is the
wrong lever.

Phase 8 changes the lever from **fold** to **delete low-value tests**. This is the
move that actually serves the original goal (maintainability + LLM-context load):
deleting a test that asserts nothing removes lines *and* removes false assurance,
which a `test.each` row never does.

**This phase does NOT chase a number.** Yield is whatever the inspection finds. The
exit criterion is "every candidate triaged", not "N tests removed".

---

## Two workstreams (do A first; B is optional and inspection-gated)

| Workstream | Confidence | Method | Est. removable |
|:---|:---|:---|---:|
| A — No-op placeholder deletion | **High** | Mechanical, body asserts nothing | ~71 |
| B — Over-test consolidation on 100%-covered files | Medium | Per-file inspection, 4-condition redundancy test | unknown (gated) |

---

## Workstream A — No-op placeholder deletion (do this)

### What qualifies

A test whose **entire body** is `expect(true).toBe(true);` (no setup, no other
assertion). It can never fail. Inventory (verified 2026-06-02):

- **71 standalone no-op tests** (body is *only* the tautology).
  - 21 in `test/unit/`
  - 50 in `test/integration/`
- **19** are self-confessed (`test("placeholder — … covered in integration tests", …)`).
- **~50** are the `parallel-batch-*` family: descriptive AC names, empty bodies.

The remaining ~30 `expect(true).toBe(true)` matches are **inside fixture strings**
(e.g. `greenfield.test.ts` embeds it in a generated-code string) or sit alongside
real assertions — **these are NOT candidates; leave them.**

### Three sub-categories — different handling

**A1. Self-confessed redundant placeholders (~19) — DELETE.**
Named `placeholder — … covered in integration tests`. By their own admission the
behavior is tested elsewhere. The marker adds noise and a false +1 to the test count.
Concentrated in:
- `test/unit/execution/story-orchestrator-gates.test.ts` (12)
- scattered singles elsewhere

Action: delete the test. If deleting empties a `describe`, delete the `describe` too.

**A2. AC-labeled empty stubs (~50) — DELETE + LOG AS COVERAGE GAP.**
The `parallel-batch-*` family (`executor` 16, `selector` 13, `rectification` 6,
`results` 5) plus a few others. These have descriptive names promising real behavior
(`"calls runParallelBatch when parallelCount > 0…"`) but empty bodies. **This is a
coverage gap masquerading as coverage** — worse than no test, because the green name
implies the AC is verified.

Action: delete the empty stub **and** record the AC in the results doc under
"Genuine coverage gaps surfaced". Do NOT silently delete — each one is a candidate
for a *real* test later (feed to a `nax` acceptance-fix story or human follow-up).

**A3. Fixture-string / mixed matches (~30) — IGNORE.**
Not real tests. Out of scope.

### Scope decisions (CONFIRMED 2026-06-02)

1. **`test/integration/` IS in-scope for Workstream A.** An empty stub
   (`expect(true).toBe(true)` body) is a no-op regardless of directory. The parent
   plan's integration exclusion applied to *folding* happy-paths, not deleting stubs.
   The `test/ui/` and `test/contracts/` exclusions still hold.
2. **A2 stubs: delete-and-log.** Delete the empty stub now; record each surfaced AC in
   the results-doc gap list for a later `nax` acceptance-fix pass. Do NOT implement
   real tests in this phase — Phase 8 is deletion-only.

### Per-file procedure (A)

1. Open file. For each `expect(true).toBe(true)` confirm the body is *only* that line
   (A1/A2) vs inside a string / beside real asserts (A3 → skip).
2. Delete the qualifying `test()`/`it()` block (and now-empty `describe`).
3. For A2 stubs: append the AC id + name to the running gap list.
4. Verify: `bun run typecheck && timeout 30 bun test <file> --timeout=5000`.
5. Commit per file: `test: remove no-op placeholder tests in <basename>`.
6. If red: `git checkout -- <file>`, log, move on.

### Exit criteria (A)

- All 71 standalone no-ops triaged (deleted or explicitly justified as kept).
- Coverage delta ≤ 0.5pp global (deleting no-op tests should not move coverage at all
  — if it drops, the test was doing something; revert and investigate).
- A2 coverage-gap list written to results doc.

---

## Workstream B — Over-test consolidation (optional, inspection-gated)

Motivated by the observation that many src files sit at 100/100 coverage — a hint of
redundant tests exercising the same lines. **Caveat: 100% *line* coverage says nothing
about branch/edge assertions, so this signal is weak.** The automated test/LOC ratio is
unreliable (it matches barrel `index.ts` files to a shared exports suite). So B is
**inspection-only — no mechanical deletion.**

### Method (B)

1. Candidate set: src files at **100% funcs AND 100% lines** in
   `coverage-after-phase-6.txt` that are **real logic modules** (exclude `*/index.ts`
   barrels, `types.ts`, pure re-exports).
2. For each, open its primary unit test. Apply the **4-condition redundancy
   definition** from `PLAN-test-suite-trim.md` (same target + same setup + same
   assertion shape + body diff < 40 chars). Only an exact redundant pair qualifies.
3. Keep the clearest-named test, delete the true duplicate. Commit per file.
4. **Budget gate:** after 20 inspected files, if < 10 redundant tests found, STOP —
   over-testing is lower than the 100%-coverage hint suggested. Record and close.

### Exit criteria (B)

- Either budget gate triggered, or candidate set exhausted.
- Every deletion satisfies all 4 redundancy conditions (no judgment-call deletes).
- No coverage regression.

---

## Guardrails (inherited from parent plan)

- One file per commit; atomic; bisectable.
- `timeout 30 bun test <file> --timeout=5000` for inner loop — **never bare `bun test`**.
- Full `bun run lint && bun run test` at phase boundary.
- **When in doubt, keep the test.** A2 stubs are the only "delete despite uncertainty"
  case, and only because an empty test provides negative value.
- Do NOT touch `test/ui/`, `test/contracts/`. (`test/integration/` is in-scope for A
  pending the scope confirmation above.)

---

## Deliverable

`PLAN-test-suite-trim.phase-8-results.md`:
- A: count deleted per sub-category; before/after total.
- A2 coverage-gap list (ACs that had empty stubs) — the most valuable output of this phase.
- B: files inspected, duplicates found, or budget-gate note.
- Coverage delta (expect ~0).

---

## Honest expected outcome

~70 tests removed (8,104 → ~8,035) plus a list of real coverage gaps. The count
barely moves — **that's the point.** The win is removing ~50 green-but-empty tests
that were lying about AC coverage, and surfacing the gaps so they can be filled. If B
finds little, that confirms the suite is appropriately sized and the plan should close
at "right-sized", not "fell short".
