# SIGINT cleanup, rectification false-positives, and adversarial loop oscillation

**Date:** 2026-04-29
**Last updated:** 2026-04-29 (status recap after PR #798 + ADR-008 fix)
**Scope:** three separate dogfood failures observed on koda's `memory-phase4-graph-code-intelligence` run (2026-04-28T13-01-41)

---

## Status snapshot (read this first)

| Bug | Track | Status | Reference |
|:---|:---|:---|:---|
| 1 — SIGINT orphans | partial fix #793 (complete() PIDs); pgid cleanup still open | ⏳ open (pgid + queue owner) | PR #793 |
| 2 — false contradiction escalation | (2-B2a) ADR-008 implementer session continuity restored | ✅ shipped | PR #795 (ADR-008) |
| 2-B2b | semantic reviewer hallucination — verifyBy enforcement | partial — `validate semantic evidence against files` | ✅ shipped | PR #797 |
| 3-PR A | uncap JSON-retry / severity-aware truncation | ✅ shipped | PR #798 |
| 3-PR B = #736 PR 3.1 | carry forward prior adversarial findings (in-memory) | ✅ shipped | commit `308be206` |
| 3.2 (#736) | `priorVerdict[]` response + implementer feedback loop | ⏳ optional, gated on telemetry | issue #736 |
| 3.3 (#736) | convergence-stall escalation heuristic | ⏳ gated on 3.2 results | issue #736 |

**The originally-confusing question — "should PR B persist to `.nax/review-verdicts/`?" — is settled: PR B (= #736 PR 3.1) shipped in-memory only.** Persistence remains an unstarted, optional follow-up — not blocked, just deferred until telemetry shows it's needed.

---

## TL;DR (original framing, kept for context)

Three independent bugs surfaced in the same run:

1. **SIGINT abandons grandchild processes** — nax registers the immediate `acpx` PID but the `npm exec → sh -c → node → native binary` shim breaks process-group propagation, so `codex-acp` / `opencode` server binaries survive ctrl+C as orphans.
2. **A "no source fix" / contradiction escalation that wasn't really one** — caused by (a) attempt 1 wasted on `SESSION_TERMINAL_STATE` plus (b) an underlying false-positive semantic review hallucinating a `new Set(...)` defect that is not in the code.
3. **Adversarial reviewer keeps "introducing new errors"** — three compounding causes: the silent 3-finding cap on JSON-retry hides remaining defects, fresh sessions have no memory of prior rounds (#736), and some round-N findings are legitimate consequences of round-(N-1) fixes.

---

## Bug 1 — SIGINT abandons child processes

### Symptom
`Received SIGINT, shutting down...` fires, but `ps` after exit shows orphaned acpx and agent server processes:

```
391108 nax /…/dist/cli.js __queue-owner
391120  └─ npm exec opencode-ai acp
391198      └─ sh -c opencode acp
391199          └─ node /…/opencode acp
391206              └─ /…/node_modules/opencode-ai/bin/.opencode acp
…
353770 node /…/codex-acp
353777  └─ /…/codex-acp-linux-x64/bin/codex-acp
```

### Code paths
- `src/execution/crash-signals.ts:64-109` — signal handler runs `onShutdown` then `pidRegistry.killAll()` with a 10 s hard deadline (`setTimeout` line 77).
- `src/agents/acp/spawn-client.ts:160` — each `prompt()` call runs `_spawnClientDeps.spawn(cmd)` and exposes `onPidSpawned?.(pid)` (line 170).
- `src/agents/acp/adapter-lifecycle.ts:37` — registers `onPidSpawned` with PidRegistry.

Only the immediate `acpx` PID is registered. The chain `acpx → npm exec → sh -c → node → native binary` does **not** stay in nax's process group: `npm exec` shells out, `sh -c` re-execs, and the native server binary is left without a tracked parent on the nax side.

Compounding: the 10 s hard deadline in `crash-signals.ts:77` fires before `onShutdown` finishes graceful session-close on heavy runs, so `pidRegistry.killAll()` never even runs.

A separate concern: `__queue-owner` is a long-lived acpx instance owned by the queue subsystem, not the per-prompt spawn pool. It needs to be on PidRegistry too, or the queue owner has to drain on its own SIGINT path.

### Proposed fix (Track 1)
1. In `spawn-client.ts:160`, spawn `acpx` with `detached: true` so each invocation gets its own pgid; record the pgid alongside the pid.
2. On shutdown, after the existing per-pid SIGTERM, send `process.kill(-pgid, "SIGTERM")` for each tracked pgid; schedule a `SIGKILL` upgrade after ~3 s.
3. Bump the hard deadline in `crash-signals.ts:77` from 10 s to a config-driven value (default 20 s) — it currently can race the graceful path on slow runs.
4. Audit the queue subsystem: ensure `__queue-owner` registers with PidRegistry, or expose its own SIGINT drain.

### Open questions
- Should the queue owner share PidRegistry, or own its lifecycle?
- Detached process groups change TTY signal forwarding for interactive runs — is anyone today relying on `Ctrl+C` reaching acpx via the TTY rather than nax's handler?

---

## Bug 2 — Implementer fix "not detected" → spurious contradiction escalation

### Symptom
Run log lines 231–274 (`memory-phase4-graph-code-intelligence/runs/2026-04-28T13-01-41.jsonl`):

| Attempt | Outcome |
|:---|:---|
| 1 | `Agent call failed` `durationMs:0` `error: Session "…" is in terminal state COMPLETED — call openSession first to resume` → autofix marks no-op, consumes attempt |
| 2 | Implementer runs 24 s, replies "Fixed the broken link comparison" — no file change → autofix marks no-op (limit reached) |
| 3 | Implementer runs 22 s, replies `UNRESOLVED: code already correct as written` → escalation |

### Two layered causes

#### B2a — Wasted attempt on terminal session
`src/pipeline/stages/autofix-agent.ts:343` calls `runWithFallback`. On the first attempt the implementer session is already in `COMPLETED` state (closed by the prior tdd / review stage). `SessionManager.sendPrompt` throws `SESSION_TERMINAL_STATE` in 0 ms (`src/session/manager.ts:476`).

Autofix's broader catch (autofix-agent.ts:356-358) treats this as a generic failure: `captureGitRef` shows no diff → `noOp = true` → consume the attempt and reprompt with the directive **"Your previous turn produced no file changes"**. That directive is misleading: the previous turn never executed — the prompt never reached the agent.

Attempt 2 *does* call `openSession` (the autofix loop's reopen path), so the resume works — but a slot has already been wasted, the implementer thinks it failed once, and the false framing colours the whole rectification round.

#### B2b — Root cause is a false-positive semantic review
Audit files:
- `1777383875252-…-reviewer-semantic-review-t01.txt` — the reviewer flags `apps/api/src/graph/incremental-graph-diff.service.ts:254` with high confidence:

  > `new Set(array.sort().join('|'))` passes a STRING to the Set constructor, which iterates over individual characters…

- `1777383906839-…-implementer-rectification-t01.txt` — implementer attempt 1 prompt; never executed (terminal-state error).
- `1777383935682-…-implementer-rectification-t01.txt` — attempt 2 implementer reads the file, observes:

  > Looking at the code, I can see that lines 254-256 already have the fix applied — the code compares `storedLinkStr` and `freshLinkStr` directly as strings without using `new Set()`. The review finding appears to be stale or based on an older version of the code.
  >
  > UNRESOLVED: …code is already correct as written.

The reviewer hallucinated a defect that is not in the code. The semantic-review prompt explicitly instructs:

> Before reporting any finding as "error", you MUST verify it using your tools. If you cannot verify a claim even after checking, use "unverifiable" severity instead of "error". Every "error" finding must include verifiedBy evidence from the current codebase.

Compliance with that paragraph is voluntary today. The reviewer included a `verifiedBy` block but the `observed` text described code that doesn't exist in the file — a fabricated quote.

The escalation on attempt 3 is *correct* behaviour for the `UNRESOLVED:` signal. The bug is that we got there at all.

### Proposed fix (Track 2)

**B2a (mechanical, ~30 LOC).** In `autofix-agent.ts` around line 322, catch `NaxError code=SESSION_TERMINAL_STATE` specifically. Call `sessionManager.openSession` to resume, retry the dispatch once **without consuming an attempt**. Log `Resumed terminal session before attempt N`.

**B2b (prompt-quality enforcement, ~50 LOC).** Two non-exclusive options:

- **(i) Programmatic verifyBy enforcement.** In `src/review/semantic.ts`, after the LLM response, for every finding with `severity: "error"`:
  1. Require `verifiedBy.observed` to be a non-empty string.
  2. Read the file at `verifiedBy.file` (or `finding.file`).
  3. Require `verifiedBy.observed` (or a normalised substring) to appear in the file. If not present, downgrade to `unverifiable` and emit `logger.warn("review", "Downgraded fabricated error finding", { storyId, file, line, observed })`.

  Deterministic, cheap, kills the class of "model hallucinated a defect" findings.

- **(ii) Verify-pass second hop.** Add a small LLM hop after the main semantic-review pass: feed each `error` finding back with the cited file content and ask "is this still true? respond yes/no with one-line evidence." Reject `no` and downgraded responses.

  Recommend (i) first. (ii) is a fallback if (i) is too restrictive (some genuine bugs phrase the defect rather than quote it).

### Open questions
- Should B2a *retry* the dispatch silently, or reopen the session and use the existing attempt slot? (Recommend retry-without-consume — the slot was clearly never used.)
- For B2b option (i), how strict should the `observed` substring match be? Exact substring is too rigid (whitespace, identifiers); normalised (collapse whitespace, drop comments) is better. Don't require regex matching of code — too easy to engineer around.

---

## Bug 3 — Adversarial loop introduces new errors / oscillates

Related: GitHub issue [#736](https://github.com/nathapp-io/nax/issues/736).

### Symptom — moving goalposts
Three adversarial review rounds across the same story (audit files in chronological order):

| Round | Audit file timestamp | Findings (errors only) |
|:---|:---|:---|
| 1 | `1777388204055` | (a) missing Prisma migration; (b) `diffAndApply` outside transaction; (c) RAG indexing **after** Prisma writes — no rollback |
| 2 | `1777389008855` | identical (a)/(b)/(c) — but migration.sql is now in the changed files header (the reviewer flagged its absence anyway) |
| 3 | `1777389768863` | RAG indexing **before** Prisma writes — opposite direction; `imported` field semantics; `@Optional()` on required deps |

Round 3 flags the *opposite* of what round 1 flagged. The implementer reordered RAG vs. Prisma in response to round 1, and round 3 has no memory that the previous order was the one round 1 demanded.

### Three compounding causes

#### B3a — Fresh session, no memory (#736)
`src/review/adversarial.ts` opens a fresh ACP session each round and rebuilds the prompt from scratch. Already tracked in #736 with a phased plan (3.1 / 3.2 / 3.3).

#### B3b — The silent 3-finding cap on JSON retry
`src/prompts/builders/review-builder.ts:148-151`:

```ts
static jsonRetryCondensed(maxFindings = 3): string {
  return `Your previous response was truncated and could not be parsed as valid JSON.
Respond with a condensed summary: at most ${maxFindings} findings, highest severity first.
…`;
}
```

When the first JSON parse fails (large/truncated response), the retry prompt silently caps to **3** findings. If the original review actually produced 8 findings, only 3 reach the implementer. The implementer fixes those 3. Round 2 (no memory) re-runs against the new diff, finds 3 *different* findings — five from the original eight plus any introduced by the round-1 fixes. Looks like new errors are being injected; really, the original set was being revealed three at a time.

The cap also doesn't tell the implementer it was truncated, so the rectifier prompt cannot acknowledge "you may be seeing only the worst three of N defects."

#### B3c — Implementer fixes legitimately create new defects
Some round-N findings are real consequences of round-(N-1) fixes (B3 round-3 RAG-order finding is exactly this). Without verdict carry-forward (#736 PR 3.2), the reviewer cannot see "you yourself demanded the opposite ordering last round" and break the loop.

### Proposed fix (Track 3) — both PRs shipped

**PR A — kill / instrument the silent cap (~20 LOC). ✅ shipped in #798.**

Final implementation differed from the original proposal — instead of a flat "raise the cap to 8," PR A landed a **severity-aware** retry prompt tied to `blockingThreshold`:

- Findings at or above `blockingThreshold` (default `error`) are forwarded uncapped — blocking findings are never dropped.
- Below-threshold findings are bounded by `advisoryCap` (default 3).
- `logger.warn("review", "JSON parse retry — original response truncated", { storyId, originalByteSize, blockingThreshold })` fires on every truncated retry — telemetry input for the 3.2 question (see below).

The `truncated: true` response flag was deferred — the severity-aware fix removes the *information loss*, which was the load-bearing concern.

**PR B = #736 PR 3.1 — carry forward prior adversarial findings. ✅ already shipped (commit `308be206`).**

Discovered during the recap that 3.1 had merged earlier (`feat(review): carry forward adversarial prior findings across rounds (#757)`):

- Producer at [orchestrator.ts:551](../../src/review/orchestrator.ts) writes `AdversarialFindingsCache` after each adversarial round.
- Receiver in [adversarial-review.ts](../../src/operations/adversarial-review.ts) reads it on the next call.
- Renderer in [adversarial-review-builder.ts:241](../../src/prompts/builders/adversarial-review-builder.ts) emits a "## Prior adversarial findings — round N-1" block.

3.1 shipped **in-memory only**, settling Q2 (see below). No further work on PR B is needed.

### Open questions — resolved

- **PR A — does the cap apply to the rectifier prompt itself?** Moot. The severity-aware fix means there's no information-loss for blocking findings, so the rectifier sees full data without needing its own cap.
- **PR B — in-memory or persisted to `.nax/review-verdicts/`?** ✅ **Settled: in-memory.** 3.1 shipped without persistence. The existing `.nax/review-verdicts/<feature>/<storyId>.json` (written by [verdict-writer.ts](../../src/review/verdict-writer.ts)) is a *post-story summary* (per-reviewer counts + passed flags) for CI/dashboards — it has a **different lifecycle and shape** from what 3.1 needs:

   | Existing verdict file | What 3.1 needed |
   |:---|:---|
   | Once at story end | Every round, in-flight |
   | Counts + pass/fail | Full per-finding objects |
   | Disk | Memory |
   | CI / dashboards | Next round's reviewer prompt |

   They are **adjacent in destination**, not the same in purpose. 3.1 chose in-memory; persistence is reversibly addable later if telemetry shows runs resuming after crashes and losing context.

### Follow-up: #736 PR 3.2 (open, optional)

3.2 (`priorVerdict[]` response field + implementer feedback loop) is the **next** layer — separate from PR B above:

- **Goal:** the adversarial reviewer outputs a per-finding verdict on prior round's findings (`addressed` / `still-open` / `disputed`); the rectifier prompt surfaces those verdicts to the implementer so both parties have shared state.
- **Status:** unstarted. Gated on telemetry from 3.1 + #798's warn-log — if goalpost-moving is already mostly resolved by carry-forward alone, 3.2 may not be needed.
- **Persistence question (revived for 3.2):** same trade-off as PR B. Recommendation: ship 3.2 **in-memory only first** (mirror 3.1's pattern, ~80 LOC), revisit persistence if and only if run-resume telemetry justifies it. Joining persistence with 3.2 in one PR is technically possible (~205 LOC, additive `rounds[]` field on the existing verdict file) but only pays off if resume scenarios are demonstrably common.

---

## Recommended sequencing — final state

| Order | Track | Status | Reference |
|:---|:---|:---|:---|
| 1 | **2-B2a** — implementer session continuity (ADR-008) | ✅ shipped | PR #795 |
| 2 | **3-PR A** — severity-aware JSON-retry cap | ✅ shipped | PR #798 |
| 3 | **2-B2b** — semantic evidence file validation | ✅ shipped | PR #797 |
| 4 | **3-PR B = #736 PR 3.1** — adversarial prior-findings carry-forward | ✅ already shipped earlier | commit `308be206` |
| 5 | **1** — SIGINT process-group cleanup (queue owner + pgid) | ⏳ open | partial in #793 |
| 6 | **#736 PR 3.2** — `priorVerdict[]` + implementer feedback (optional) | ⏳ unstarted, gated on telemetry | issue #736 |
| 7 | **#736 PR 3.3** — convergence-stall escalation heuristic | ⏳ gated on 3.2 | issue #736 |

What remains: SIGINT pgid cleanup (Track 1) and the optional #736 follow-ups (3.2, 3.3). Both are gated — Track 1 on a queue-owner design call, the #736 follow-ups on whether warn-log telemetry from #798 + 3.1 carry-forward shows residual goalpost-moving.

---

## Evidence index

### Bug 2
- Run log: `/home/williamkhoo/Desktop/projects/nathapp/koda/.nax/features/memory-phase4-graph-code-intelligence/runs/2026-04-28T13-01-41.jsonl` lines 231–274
- Reviewer prompt + response: `/home/williamkhoo/Desktop/projects/nathapp/koda/.nax/prompt-audit/memory-phase4-graph-code-intelligence/1777383875252-…-reviewer-semantic-review-t01.txt`
- Implementer attempt 1 (never ran): `…/1777383906839-…-implementer-rectification-t01.txt`
- Implementer attempt 2 (UNRESOLVED): `…/1777383935682-…-implementer-rectification-t01.txt`

### Bug 3
- Round 1: `…/1777388204055-…-reviewer-adversarial-review-t01.txt`
- Round 2 (with migration): `…/1777389008855-…-reviewer-adversarial-review-t01.txt`
- Round 3 (opposite ordering): `…/1777389768863-…-reviewer-adversarial-review-t01.txt`
- Plus `…/1777388220309`, `…/1777388613388`, `…/1777389027247`, `…/1777389460431`, `…/1777389786045`, `…/1777390052248` (interleaved implementer rectifications + reviewer rounds)

### Bug 1
- Process snapshot from user's terminal session (orphan acpx + codex-acp + opencode-ai survivors)
- `src/execution/crash-signals.ts`, `src/agents/acp/spawn-client.ts`, `src/agents/acp/adapter-lifecycle.ts`

---

## Code references

| File | Line | Relevance |
|:---|:---|:---|
| `src/execution/crash-signals.ts` | 64–109 | Signal handler with 10 s hard deadline |
| `src/execution/crash-signals.ts` | 77 | Hard deadline `setTimeout` |
| `src/agents/acp/spawn-client.ts` | 160 | Per-prompt spawn site |
| `src/agents/acp/spawn-client.ts` | 170 | `onPidSpawned` callback |
| `src/agents/acp/adapter-lifecycle.ts` | 37 | `onPidSpawned` → PidRegistry wiring |
| `src/session/manager.ts` | 474–481 | `SESSION_TERMINAL_STATE` throw |
| `src/pipeline/stages/autofix-agent.ts` | 322–358 | Dispatch + broad catch |
| `src/pipeline/stages/autofix-agent.ts` | 412–470 | No-op detection / reprompt logic |
| `src/prompts/builders/review-builder.ts` | 148–155 | `jsonRetryCondensed(maxFindings = 3)` |
| `src/review/adversarial.ts` | (full file) | Fresh-session-per-round logic (#736) |
| `src/review/semantic.ts` | (full file) | Where verifyBy enforcement would land |

---

## Bug 2 — Architectural follow-up (ADR-008 audit, 2026-04-29)

When discussing Bug 2 with the user, they pointed at `docs/adr/ADR-008-session-lifecycle.md`: the concept (implementer session must stay open across execution → rectification) is correct, but the code has drifted. This section captures the audit and supersedes the B2a fix proposal above with a structural fix.

### ADR-008 invariant for the implementer role

> The session stays open from the main execution run through TDD rectification, autofix, and verification rectification. `sweepFeatureSessions()` at story completion is the single cleanup point. Tier escalation starts a fresh session.

The session name is deterministic — `nax-<hash8>-<feature>-<storyId>-implementer` — and ADR-008 §6 expects the **same protocol session** (same conversation history) to span all four stages within one tier.

### Drift map

| Site | File:line | Runtime path (production) | Legacy `keepOpen` path | ADR-008 expected |
|:---|:---|:---|:---|:---|
| Execution (single-shot) | `src/pipeline/stages/execution.ts:158, 182` | sets `keepOpen` ✓ but dispatched via `manager.run()` → `executeHop` → `buildHopCallback` which **always closes** | n/a — direct path | Session must remain open at the end of the call |
| Autofix (rectify loop) | `src/pipeline/stages/autofix-agent.ts:322-355` | comment: *"Each attempt opens a fresh session… No cross-attempt session continuity"* | `keepOpen: !isLastAttempt` ✓ | Same protocol session as execution; `!isLastAttempt` between attempts |
| Verification rectification | `src/verification/rectification-loop.ts:306-329` | comment: *"Each attempt opens a fresh session; keepOpen is not used in the runtime path"* | `keepOpen: !isLastAttempt` ✓ | Same protocol session as execution + autofix |
| TDD rectification gate | `src/tdd/rectification-gate.ts:323-353` | same comment, same pattern | `keepOpen: !isLastAttempt` ✓ | Same protocol session as TDD implementer |

All three rectification sites carry **legacy** `keepOpen: !isLastAttempt` code that matches ADR-008 — but it is dead code in production because the runtime branch is always taken.

### Root cause is `buildHopCallback`, not the call sites

`src/operations/build-hop-callback.ts:147-214`:

```ts
const handle = await sessionManager.openSession(sessionName, { … });
try {
  const send = (turnPrompt: string) => agentManager.runAsSession(agentName, handle, turnPrompt, …);
  const turnResult = hopBody ? await hopBody(prompt, { send, input: hopBodyInput }) : await send(prompt);
  return { result: …, bundle: workingBundle, prompt };
} catch (err) { … }
finally {
  await sessionManager.closeSession(handle);   // ← always closes
}
```

`buildHopCallback` does not read `keepOpen` at all. Every executeHop invocation:

1. Opens a fresh protocol session under the implementer name
2. Runs one turn (or a `hopBody` chain)
3. **Closes the session in `finally`** — no escape hatch

This was introduced by the ADR-019 Pattern A migration to give every dispatch a uniform middleware envelope, but it never reconciled with ADR-008's continuity rule. Every `keepOpen: true` flag in the codebase that flows through `buildHopCallback` is currently dead.

The `sweepFeatureSessions()` cleanup point ADR-008 designs around is now never the closer — `buildHopCallback`'s `finally` already closed it.

### How this maps to the dogfood symptoms

- **B2a (attempt 1 wasted in 0ms with `SESSION_TERMINAL_STATE`).** `autofix-agent.ts:200, 253` gates the lean `firstAttemptDelta` prompt on `consumed === 0 && sessionConfirmedOpen`. The flag is set from `consumed === 0` alone — it does *not* check whether a warm session actually exists. With `buildHopCallback` closing execution.ts's session before autofix re-enters, attempt 1 sends a delta-prompt to a fresh session that has zero conversation history. The agent receives a context-free "fix these review failures" message and either no-ops or terminates immediately. The "0ms SESSION_TERMINAL_STATE" failure is the protocol session being closed by the `finally` while a concurrent send was already in flight (or a stale handle reference from the previous round being touched after close). Either way, the structural fix is the same: stop closing the implementer session between hops.

- **B2b (semantic reviewer hallucinating `new Set(...)` defect).** Independent of session lifecycle. Same fix as proposed under "Track 2 → B2b" above (programmatic `verifyBy` enforcement).

### Updated fix plan (Track 2 — supersedes B2a retry-on-terminal proposal)

The retry-on-`SESSION_TERMINAL_STATE` workaround proposed earlier (line 103) is no longer the right approach — it would mask the structural break rather than fix it, and would still leave conversation history lost between hops. Instead:

**Track 2 (revised) — Restore ADR-008 keep-open semantics in `buildHopCallback`.**

1. **`buildHopCallback`:** read `resolvedRunOptions.keepOpen` (fall back to caller-supplied default). When `true`, skip the `finally → closeSession` and return the handle so the next call can reuse it. When `false`, keep current always-close behaviour.
2. **Persist the open handle on the descriptor.** `sessionManager` already keys descriptors by `sessionId`; a new `getOpenHandle(sessionId)` call lets the next hop's `openSession` short-circuit to the existing handle when one is present. (Current `openSession` always opens fresh — needs an "if already open under this descriptor, return the existing handle" branch.)
3. **Caller policy preserved:**
   - `execution.ts` already sets `keepOpen` based on `review.enabled || rectification.enabled` — leave as-is, it just starts working.
   - `autofix-agent.ts`, `rectification-loop.ts`, `rectification-gate.ts`: drop the dead-code legacy branch; pass `keepOpen: !isLastAttempt` through `runOptions` on the runtime path.
4. **Single closer at story completion.** `sweepFeatureSessions()` (already wired) closes the implementer descriptor at story end. Add an explicit close-on-tier-escalation call where escalation paths already exist (each rectification site has one).
5. **`sessionConfirmedOpen` heuristic in `autofix-agent.ts:200, 253` becomes a real check** — read it from the descriptor (`sessionManager.isOpen(sessionId)`) instead of inferring from `consumed === 0`. With (1)+(2) in place this just reflects reality.

LOC budget: ~80 in `buildHopCallback` + sessionManager, ~30 to delete legacy `keepOpen` branches across the three rectification sites, ~10 to swap the `consumed === 0` heuristic.

### Cross-references

- ADR-008 §6 — implementer rules carried forward from ADR-007
- ADR-008 §"Decision" — the "iterating on own state vs scoring someone else's work" rule
- ADR-019 — the Pattern A migration that introduced `buildHopCallback`
- `src/operations/build-hop-callback.ts:212-214` — the unconditional `finally → closeSession`

### Out of scope for this audit

- Bug 2b (semantic reviewer hallucination) — separate fix track, unaffected by session lifecycle.
- Reviewer roles (semantic, adversarial) — ADR-008 says they should NOT keep session open; current behaviour matches that. No change needed.
- Dialogue and stateful debate — already correctly stateful.
