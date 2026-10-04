# Deep Code Review: S3-4 agent session facade (`@nathapp/nax-agent`)

**Date:** 2026-10-04
**Reviewer:** Subrina (AI)
**Branch:** `feat/s3-4-facade` (14 commits on top of `76e135064`)
**Spec/Plan:** `docs/superpowers/specs/2026-10-03-s3-conversational-session-api-design.md`, `docs/superpowers/plans/2026-10-04-s3-4-agent-session-facade.md`
**Stack:** TypeScript 7.0.2 strict, Bun 1.4, Node 22+ built-ins only, zod, vitest. Node-general + universal checklist.
**Scope:** 34 files changed, +8517 lines (lib: ~1154 LOC across 11 new + 6 modified `src/` files; test: ~2099 LOC across 8 new test files + helpers; plan + spec amendments).

---

## Overall Grade: A− (88/100)

The S3-4 facade is a clean, well-tested addition of a substantial new public API. The
single-flight slot, event channel with delta coalescing, pending-ask table with
deadlines, embedder-tool routing, profile → declared-tools → grants pipeline, and
system-prompt threading all hang together as documented. Every plan Review Focus is
covered by an end-to-end test; complexity does not grow beyond the baselined hot
spots (`sendTurn` 21, `runToolBatch` 59, `openNativeSession` unchanged). The
3268-test suite passes with **97.84% line** and **95.79% function** coverage;
every gate (`check:api`, `check:complexity`, `check:no-bun-apis`, `check-nax-error`,
`check-file-sizes`, `check-import-cycles`, `check-test-as-unknown-as`,
`check-test-escape-hatches`, `check:test-satellites`, `check:no-control-bytes`,
`check:no-real-global-nax`, `check:permission-mode-ssot`, `check:feature-dir-ssot`,
`check:package-frame-derivation`, `check:git-spawn-env`, `check:sandbox-imports`,
`check:nax-ai-imports`) is clean.

The findings below are medium at worst and entirely about hardening, not blocking.
The branch is mergeable; ship the perf bound in #4 first because it is the same
class of bug the S3-3 final review already paid to fix in
`native/session/turn-event-emitter.ts:cappedInput`.

---

## Summary

| Dimension | Weight | Score | Notes |
|:--|:--:|:--:|:--|
| Security | 20 | 18 | All public entry points zod-validated, including path-traversal-safe `sessionId`. Approval `command` masked through `maskForPrompt`; unshowable is denied without prompt. `#4` is a missed redaction-bound. |
| Reliability | 20 | 18 | Single-flight and async-iterator semantics match the plan's Review Focus #4 and #5; pending-ask table keeps request ids for the session's lifetime; `close()` is idempotent. `#3` is a non-issue at the current seam-typing. |
| API Design | 20 | 18 | Public surface added only on `.` (15 new names: 14 types + `AgentSessionError` + `createAgentSession`); `_agentSessionDeps` seam on `./internal`. Hand-edited `api/nax-agent.api.txt` matches. `AgentSessionError` is the only public class on `.`; codes are `AGENT_SESSION_*` namespaced. |
| Code Quality | 20 | 18 | Each module has one job; JSDoc is dense; explicit deviation comments cite spec sections. `#7` is a stylistic preference (`@design` annotations). |
| Best Practices | 20 | 16 | Bun/test seams replaced via `withDepsRestore`; manual timers; no `as any` in production; escape-hatch ratchet met (`looseCast: 9`). One regression-style omission (`#4`). |

**Total: 88 / 100 → A−**

---

## Findings

### 🟡 MEDIUM

#### PERF-1 / SEC: Approval summary redaction walks unbounded input
**Severity:** MEDIUM | **Category:** Performance + Security (regression of S3-3 final-review fix)
**Location:** `packages/nax-agent/src/session/session-interaction.ts:50-58`

`defaultSummary` calls `redactSecrets` over the full `input` before `JSON.stringify`,
with **no** per-string byte bound. The same issue was fixed in
`native/session/turn-event-emitter.ts:cappedInput` (Task 2, this branch) by adding
`capStrings` before `redactSecrets`. The facade's approval summary was not
audited for the same shape and ships with the same risk.

```ts
export function defaultSummary(input: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(redactSecrets(input)) ?? "null";
  } catch {
    return "[input not serializable]";
  }
  return cutToByteCap(json, EMBEDDER_SUMMARY_BYTES);
}
```

**Risk:** an embedder tool whose `input` carries a multi-MB string (e.g. a `Bash`
tool call whose `command` is large) walks the whole string through the
`SECRET_VALUE_PATTERNS` regex set during approval — both a CPU stall and a
secret-leak window if a pattern misses mid-string but the full byte walk is
emitted as the pre-redaction JSON.

**Fix:** export `capStrings` from `turn-event-emitter.ts` (or move it to
`#src/internal/redact.ts`) and apply it before `redactSecrets`. The test
`session-interaction.test.ts` "the default summary is redacted, byte-capped JSON"
already pins the small-input behaviour; add a parallel test that pushes a
2 MB string and asserts (a) redaction completes in bounded time and (b) the
returned summary does not contain the secret value.

#### PERF-2: Event channel enqueue is O(n) per delta merge
**Severity:** MEDIUM | **Category:** Performance (latent)
**Location:** `packages/nax-agent/src/session/session-event-channel.ts:60-73`

`enqueue` mutates `buffer` via `[...buffer.slice(0, -1), combined]` whenever
adjacent deltas of the same type and round merge. This is O(n) per merge; for a
high-rate text stream with the consumer lagging, the total cost is O(n²). In
practice chat-class deltas coalesce within one or two pushes and the buffer
stays short, so this is theoretical rather than observed. It would surface if a
provider emits many tiny deltas per round (e.g. a verbose stream-reset path) and
the consumer pauses.

**Risk:** under sustained delta flooding the channel becomes the bottleneck,
the control-event cap fires sooner than it should, and the consumer turns are
cancelled as "stalled" (`AGENT_SESSION_CONSUMER_STALLED`) for the wrong reason.

**Fix:** keep two slots — `headDelta` (latest) and a tail list of non-mergeable
events. Merging into `headDelta` is O(1); the tail only grows on appends.
Acceptable to defer until a profiled case surfaces; mark with `@design` so it
is not lost.

#### SEC-1 / type: `_agentSessionDeps.setTimeout` return-type is `unknown`
**Severity:** LOW (would be MEDIUM if `setTimeout` ever throve) | **Category:** Type safety
**Location:** `packages/nax-agent/src/session/agent-session-deps.ts:14-28`

```ts
export const _agentSessionDeps = {
  setTimeout: (fn: () => void, ms: number): unknown => setTimeout(fn, ms),
  clearTimeout: (handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>),
  ...
};
```

The seam returns `unknown` and the production `clearTimeout` casts it to
`ReturnType<typeof setTimeout>` (Node's `Timeout`). Tests replace
`setTimeout` with a function returning a numeric id and `clearTimeout` with a
function that `Number(handle)s` — that cast in production would silently turn a
numeric id into a `Timeout`-typed garbage and only ever call `clearTimeout` on
it through `Number(handle)`. **Safe today** because tests replace both halves,
but the seam typing is what makes the seam safe: it is fragile and easy to
break in a future refactor that, for example, moves `clearTimeout` into a
helper that does not itself reach for `Number(handle)`.

**Risk:** silent test-pass / production-fail if the seam is half-rewritten.

**Fix:** declare a `TimeoutHandle` branded type that production assigns and tests
also assign (`number | Timeout`). Or expose `setTimeout`/`clearTimeout` as a
single pair (`arm(ms): TimeoutHandle` + `disarm(handle): void`) so neither side
ever touches a raw `unknown`.

---

### 🟢 LOW

#### MEM-1: `controlEventCap` is a mutable exported primitive
**Severity:** LOW | **Category:** Test isolation (not production)
**Location:** `packages/nax-agent/src/session/agent-session-deps.ts:28`

```ts
controlEventCap: MAX_UNDELIVERED_CONTROL_EVENTS,
```

The stalled-consumer test (`agent-session-asks.test.ts:280-299`) sets
`_agentSessionDeps.controlEventCap = 2`. `withDepsRestore` only restores
function-valued keys (it captures `Object.values` and reassigns them), so a
test that mutates this primitive without `withDepsRestore` leaks to
subsequent suites. The two suites that touch it (`agent-session-asks`,
`agent-session-chat`) both wrap in `withDepsRestore`, so today the leak is
zero — but the seam shape invites a future test bug.

**Fix:** turn the cap into a getter that reads a non-enumerable field, or
`Object.defineProperty` it so `withDepsRestore` can capture and restore the
value rather than only the function reference. Cosmetic — worth doing while
the seam is new.

#### STYLE-1: Inline design remarks could be `@design` annotations
**Severity:** LOW | **Category:** Documentation / future-review-tooling
**Locations:**
- `packages/nax-agent/src/session/session-tool-support.ts:135` — *"Unreachable
  while the scratchpad trio is always declared and granted; kept for the
  type."*
- `packages/nax-agent/src/session/agent-session.ts:131-137` — *the owns-vs-memo
  decision*
- `packages/nax-agent/src/session/agent-session.ts:189` — *empty-instructions-as-no-system-prompt*

These are inline "why" comments. The codebase has no documented convention for
`@design` annotations yet, and these remarks are clear without one. Recording
for the next reviewer.

#### DOC-1: Pre-declared error codes for S3-5 widen the public union early
**Severity:** LOW | **Category:** API surface
**Location:** `packages/nax-agent/src/session/agent-session-errors.ts:13-17`

```ts
| "AGENT_SESSION_NOT_FOUND"
| "AGENT_SESSION_SCHEMA_UNSUPPORTED"
| "AGENT_SESSION_MODEL_MISMATCH"
```

These are declared on `.` now but only thrown in S3-5 by `resumeAgentSession`.
Embedders reading the type today cannot match against them, and the codes are
part of `AgentSessionErrorCode` so they reach the published `.d.ts`. Plan §3
deliberately ships them early to keep the union stable across two releases; the
trade is documented in the plan. Worth a `@design` annotation so a future
release reviewer does not flag it as dead.

#### TEST-1: `redaction bound` test for `tool_call.input` does not observe the bound
**Severity:** LOW | **Category:** Test coverage
**Location:** `packages/nax-agent/test/unit/native/session/turn-event-emitter-input-cap.test.ts`

The Task 2 plan calls this out: the bound itself (no redactor pass over
megabytes) is not observable without a production seam. The current tests
pin behaviour around it (size cap, masking of a secret-named key on both
paths, cycles). The plan acknowledges this is "not a RED test". If
`PERF-1` above is fixed in this branch, add the same parallel test for
`defaultSummary` (a multi-MB string returns a capped, redacted summary and
the secret-named key in the same string is still masked in the preview).

---

### 🟢 Information (worth noting, not findings)

1. **Single-flight semantics** match the plan exactly. `onSettle` runs *before*
   `emit(turn_end)`, so a consumer that re-sends from inside its `for await`
   body on seeing `turn_end` succeeds (Review Focus #4). `agent-session-chat.test.ts:220`
   pins this end-to-end. ✓

2. **Cancelled-during-tool abandon** matches Review Focus #2. The
   `invoke()` helper in `session-interaction.ts:87-103` races the embedder
   tool against `ctx.signal` and ignores a late settlement from an abandoned
   `run`. `agent-session-asks.test.ts:201-218` pins this. ✓

3. **`answer()` status matrix** matches Review Focus #3. `pending-asks.ts:80-98`
   returns `"unknown"` after close, `"cancelled"` for an answer after the
   request was settled by signal, `"expired"` for an answer after timeout or
   second human answer, throws `AGENT_SESSION_INVALID_ANSWER` for never-issued
   ids and kind mismatches. `pending-asks.test.ts` and `agent-session-asks.test.ts`
   cover every cell. ✓

4. **Profile → tools matrix** is correct. `declaredToolsFor` declares
   `ScratchpadWrite/Read/List` for every profile (so `none` profile has the
   trio); `read` adds `Read/Glob/Grep/Git`; `full` adds the write tools and
   `GitCommit` only when `gitIgnorePatterns` is non-empty. `RunCommand` is
   deferred (no `declaredCommands` option) — `session-tool-support.test.ts:118`
   pins its absence. ✓

5. **Sandbox floor** for `full` is correct: `resolveSessionLauncher` probes
   when `profile === "full"` and either returns the launcher, or (with
   `bashApproval: "gated" && allowUnsandboxed`) returns `undefined`; otherwise
   throws `AGENT_SESSION_SANDBOX_UNAVAILABLE` with the probe's reason.
   `raw` and `escalate` still require a usable sandbox (no ask path) — the
   plan documents this as deliberate. ✓

6. **System prompt plumbing** is fully wired: `OpenSessionOpts.systemPrompt`
   flows through `recordSystemPrompt` → `state.systemPrompts` →
   `systemFieldFor` → `sendTurn.complete` closure → request `system`. The
   adapter does **not** send `system` on the compaction summary, as the plan
   specifies. A session without `systemPrompt` sends no `system` key (test
   `session-adapter-system-prompt.test.ts:316`). ✓

7. **Race: cancel-during-shutdown**. `shutdown()` captures `active`,
   calls `active?.cancel("session closed")`, awaits `active?.settled`, then
   closes the adapter. `onSettle` runs *before* `resolveSettled`, so by the
   time the await resolves the slot is empty and a stale `this.active` can
   not be re-cancelled. ✓

8. **Write order**: a successful turn calls `markTurn(running)` →
   `adapter.sendTurn` (which saves via the loop) → `markTurn(ended)`. A
   `markTurn(ended)` failure fails the turn but keeps `output` and `usage`.
   A failing `markTurn(running)` before any model call short-circuits the
   turn. The four call-order branches are covered in `agent-session-chat.test.ts:166-183,287-336`. ✓

9. **`close()` idempotence**: tested in `agent-session-chat.test.ts:232-249`.
   A second `close()` returns the same Promise; the scratch root is removed
   exactly once; subsequent `send()` throws `AGENT_SESSION_CLOSED`. ✓

10. **Complexity ratchet**: `sendTurn` is still 21 (baseline), `openNativeSession`
    gained no branch (the `recordSystemPrompt` helper absorbs it), `runToolBatch`
    unchanged at 59. New modules are all under the ratchet cap of 20
    (`createSessionEventChannel` ~10, `claimTurn` ~12, `session-interaction`
    helper functions ~5–9). ✓

11. **Dependency direction**: `_agentSessionDeps` is the only new seam and
    lives on `./internal`. No new `@nathapp/nax-ai` import outside `src/native/`
    and `src/cost/standard-types.ts`. `check-nax-ai-imports` clean. ✓

12. **Public-API ratchet**: 15 new names on `.` (14 types + 1 class +
    `createAgentSession`). No `_` name on `.`. `api/nax-agent.api.txt`
    diff matches the added exports exactly (no removals, no `_` names).
    `check:api` clean. ✓

13. **Documented limitations**: the plan enumerates seven known limitations
    (first-turn auth failure leaves a doc with only the turn marker;
    scratchpad under `.nax/scratchpad` not cleaned; sandbox state
    process-wide; abandoned claim yields an empty stream with no `turn_end`).
    All four are reflected in the code and called out on
    `CreateAgentSessionOptions.transcriptStore` (file-store prune). ✓

---

## Priority Fix Order

| Priority | ID | Effort | Description |
|:--|:--|:--|:--|
| P0 | PERF-1 | S | Apply `capStrings` (or equivalent) in `defaultSummary` before `redactSecrets`. Add a 2 MB-string test mirroring `turn-event-emitter-input-cap.test.ts`. |
| P1 | PERF-2 | M | Replace the channel's `[...buffer.slice(0,-1), combined]` O(n) merge with an O(1) `headDelta` slot. Defer until a profiled case needs it. |
| P1 | TYPE-1 | S | Tighten `_agentSessionDeps.setTimeout` / `clearTimeout` typing: brand the handle or pair them into `arm`/`disarm`. |
| P2 | MEM-1 | XS | Make `controlEventCap` restoration-safe in `withDepsRestore` (define-property) or expose a setter. |
| P2 | DOC-1 | XS | `@design` the S3-5 pre-declared error codes and the owns-vs-memo decision; future reviewer will not re-flag them. |
| P3 | TEST-1 | S | When PERF-1 is fixed, add the parallel 2 MB-input test for `defaultSummary`. |

---

## Test Inventory (facade-specific)

| Suite | Tests | Focus |
|:--|:--:|:--|
| `agent-session-chat.test.ts` | 14 | end-to-end chat, multi-turn history, system prompt, advertised tools per profile, write order, single-flight + cancel release, `turnEndFromResult` unit cases, store-throws paths |
| `agent-session-asks.test.ts` | 10 | always-approval tool happy-path, denial, timeout; question answered and timed-out; built-in Bash under `full + gated` with command masking; cancellation during tool and during approval; breaking out of the iterator; close during a turn; turn-deadline; stalled-consumer cap |
| `agent-session-errors.test.ts` | 2 | `AgentSessionError` extends `NaxError`, typed code, default context |
| `agent-session-options.test.ts` | 14 | every zod branch, profile rules, bashApproval/allowUnsandboxed coupling, reserved and duplicate tool names, malformed models, malformed protectedPaths, missing store methods, class-based tool `this` preserved |
| `pending-asks.test.ts` | 8 | every cell of the settlement matrix (human, timeout, cancelled) plus repeat/late answers and post-close answers |
| `session-ask-link.test.ts` | 7 | `askPerson` happy path + deadline + signal, link resolution with current-call slot, `maskForPrompt` masking, unshowable denial, default rule reason fallback |
| `session-event-channel.test.ts` | 13 | first-pull side-effect, onFirstPull synchronous push, delta coalescing rules, control-event no-merge, stall cap and `once`-fire, delivered-events subtract, end-after-buffer-drain, return() idempotence, single-pending-next guard |
| `session-interaction.test.ts` | 12 | question happy + timeout-null; context-tool unknown; built-in happy/denied/error with `callId` in slot; embedder tool happy; `isError` and throw both throw; approval-always happy/denial/timeout; abandoned run on signal abort; describe redaction + cap + fallback |
| `session-tool-support.test.ts` | 11 | declared-tools per profile, GitCommit-only-with-ignore-patterns, gated-only ask rule, default protected paths (own credentials vs configured, no-config), `resolveSessionLauncher` floor |
| `turn-event-emitter-input-cap.test.ts` | 4 | multi-MB input cap + masking, small-input structure preserved, large-with-secret masking, cycle guard

| Total new session/agent-session tests: **95** | full unit suite: **3268** pass, 0 fail.

---

## Coverage Report

```
lines:     97.84%  (11459/11712, floor 80.00%)
functions: 95.79%  (1502/1568,  floor 80.00%)
unreported src/ files with code: 0
0 files below floor (baseline 0).
```

The eight new `src/session/` files all report; the per-file floor is met. No
unreported files.

---

## Gates

```
check:api                        clean
check:no-bun-apis                clean
check-nax-error                  clean (0 violations, baseline 0)
check-file-sizes                 clean (0 oversized, baseline 0)
check-complexity                 18 baselined over 20 (no new additions)
check-import-cycles              0 modules in cycles (baseline 0)
check-test-as-unknown-as         0 occurrences (baseline 0)
check-test-escape-hatches        tsSuppress=0, ratchetAllow=4, looseCast=9
check:test-satellites            4 ticket-named test files (baseline 4)
check:no-control-bytes           clean
check:no-real-global-nax         clean
check:permission-mode-ssot       clean
check:feature-dir-ssot           clean
check:package-frame-derivation   clean
check:git-spawn-env              clean
check:sandbox-imports            clean
check:nax-ai-imports             clean
biome lint                       clean
typecheck (tsc --noEmit)         clean
```

---

## Verdict

**Approve with P0 follow-up.** Ship after PERF-1 lands. PERF-2, TYPE-1, MEM-1,
DOC-1, TEST-1 are deferred follow-ups, not blockers.