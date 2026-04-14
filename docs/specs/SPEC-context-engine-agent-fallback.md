# SPEC: Agent Availability Fallback

> **Status:** Draft. Independent of the context engine — does not depend on v1 validation. Shippable on its own.

## Summary

When an agent session fails due to **availability** (vendor quota exhausted, rate-limited, service outage, auth error), nax today fails the story or loops unproductively. This spec adds a **same-tier cross-agent fallback** path: the runner classifies the failure, switches to a configured fallback agent at the same tier, and re-runs the failing session with the portable substrate preserved (scratch, diffs, story state).

Explicitly distinct from tier escalation (quality-driven, same agent, higher tier). Escalation and fallback are orthogonal axes and never interleave.

## Motivation

Operators running nax against Claude hit quota limits in the middle of long feature runs. Current behavior — fail the story or retry the same unavailable vendor — wastes operator attention. Configuring a second vendor (Codex, Gemini, local) as a fallback removes this class of stall without requiring human intervention.

This is not an escalation problem. A story that Claude could have completed at `balanced` tier does not suddenly need `powerful` just because Claude is rate-limited — the *vendor* is down, not the *approach*. Climbing tiers on an unavailable vendor is wasted cost. Switching vendors at the same tier is the right move.

## Non-goals

- Not a quality-driven fallback. Quality failures (review/verify rejected output) go through tier escalation as today. Opt-in only via `fallback.onQualityFailure: true`; disabled by default.
- Not a load-balancer. We don't split traffic across vendors for cost/performance. We only switch on hard availability failures.
- Not a rules-translation system. (Handled by the separate canonical-rules spec, which is a prerequisite only if operators want cross-vendor work to share project rules faithfully. This spec works without it — rules simply remain whatever the new agent reads on its own.)
- Not a context-preservation system beyond what nax already persists. If the context engine (v1/v2) later lands, it piggybacks on this fallback mechanism, but fallback itself ships without it.

## Design

### Failure classification

The adapter layer (`src/agents/acp/` and `src/agents/claude/`) returns a structured failure on unrecoverable errors:

```typescript
export interface AdapterFailure {
  category: "availability" | "quality" | "other";
  outcome:
    | "fail-quota"          // HTTP 429 with quota/billing indicators, provider-specific
    | "fail-rate-limit"     // HTTP 429 with retry-after header, transient
    | "fail-service-down"   // HTTP 5xx, connection refused, DNS
    | "fail-auth"           // HTTP 401/403, credential issue
    | "fail-timeout"        // wall-clock exceeded
    | "fail-adapter-error"  // spawn / protocol / crash
    | "fail-quality"        // review / verify rejected
    | "fail-unknown";
  message: string;          // human-readable
  retriable: boolean;       // true for rate-limit with retry-after; usually false otherwise
  retryAfterMs?: number;    // present for rate-limit
  vendor?: string;          // "anthropic", "openai", etc.
}
```

**Classification rules** live in per-adapter code; each adapter maps its native error model to `AdapterFailure`:

- Anthropic quota: HTTP 429 with `error.type === "rate_limit_error"` and billing-related body → `fail-quota`.
- Anthropic transient rate limit: HTTP 429 with `Retry-After` header and no billing indicators → `fail-rate-limit` with `retriable: true`.
- OpenAI / Codex: similar mapping per OpenAI error codes.
- Connection refused / DNS / 5xx → `fail-service-down`.
- 401/403 → `fail-auth`.
- ACP session spawn failure → `fail-adapter-error`.
- Anything else → `fail-unknown`.

**Availability** covers `fail-quota`, `fail-rate-limit` (after retries exhausted), `fail-service-down`, `fail-auth`, and `fail-timeout`. `fail-adapter-error` is treated as availability by default but configurable.

### Fallback map

Config addition:

```typescript
const FallbackMapSchema = z.object({
  enabled: z.boolean().default(false),
  onQualityFailure: z.boolean().default(false),
  maxHopsPerStory: z.number().int().min(1).max(5).default(2),
  retryRateLimitMs: z.number().int().min(1000).default(30_000),
  retryRateLimitAttempts: z.number().int().min(0).default(2),
  map: z.record(z.array(z.string())).default({}),  // agent-id → ordered list of fallback agent-ids
});
```

Example:

```json
{
  "fallback": {
    "enabled": true,
    "maxHopsPerStory": 2,
    "map": {
      "claude": ["codex", "gemini"],
      "codex":  ["claude"],
      "gemini": ["claude"]
    }
  }
}
```

An agent id in `map` keys = the primary. Values = ordered fallback candidates.

### Runner behavior on failure

Pseudo-flow in `src/execution/runner-execution.ts`:

```
run_story(story):
  attempts = []
  agent = config.autoMode.defaultAgent          # e.g. "claude"
  tier  = routing.resolve(story)                # e.g. "balanced"

  while true:
    failure = run_session(agent, tier, story, attempts)
    if failure is None:
      return PASSED

    attempts.push({ agent, tier, failure })

    if failure.category == "quality":
      if config.fallback.onQualityFailure and can_fallback(agent, attempts):
        agent = next_fallback(agent, attempts)
        continue                                 # same tier, different agent
      else:
        if can_escalate(tier):
          tier = next_tier(tier)
          continue                               # same agent, next tier
        else:
          return FAILED(quality-exhausted)

    if failure.category == "availability":
      if failure.outcome == "fail-rate-limit" and failure.retriable:
        # Retry same agent after delay, up to retryRateLimitAttempts
        if retries_for(agent, attempts) < config.fallback.retryRateLimitAttempts:
          sleep(failure.retryAfterMs or config.fallback.retryRateLimitMs)
          continue
      if can_fallback(agent, attempts):
        agent = next_fallback(agent, attempts)
        continue                                 # same tier, different agent
      else:
        return FAILED(all-agents-unavailable)

    return FAILED(other)
```

Key invariants:

- **Availability failures do not climb tiers.** Wasting a higher-tier call on an unavailable vendor solves nothing.
- **Quality failures climb tiers first, fall back only if opted in.** Matches current escalation semantics exactly.
- **Rate-limit with retry-after** is retried in place before falling back. Transient rate limits are cheaper to wait out than to swap agents.
- **Hop counter is per story.** `attempts.length` tracks total attempts; agent-switch count is bounded by `maxHopsPerStory`.
- **Exhaustion is explicit.** When every fallback candidate has been tried, the story fails with `all-agents-unavailable` and the full attempt chain is surfaced in the run summary.

### Session handoff

When fallback switches agents:

1. **Cancel the failing session cleanly.** The ACP adapter already handles this (recent fix 2c0adbb2 — in-flight sidecar status).
2. **Create a fresh session against the fallback agent** using the same story input.
3. **Preserve these portable artifacts**, which already exist in nax today:
   - Story state in `ctx.story`
   - Partial diff on the work tree (not discarded)
   - Session logs (for post-hoc analysis)
   - Metrics so far (extended with the new attempt)
4. **Inject a short "prior attempt" note** into the new agent's prompt. This is a **deterministic string**, not an LLM call:

   ```
   ## Prior agent unavailable

   The prior session was running agent `claude` at tier `powerful` and became
   unavailable. Reason: quota exhausted (vendor: anthropic, retriable: false).

   Partial work completed before the session ended:
   - Touched files: src/review/semantic.ts, src/review/types.ts
   - Last commit on the work branch: <sha>
   - Diff size: +42 / -15 lines

   Continue the story. The partial work is on disk; inspect it before
   deciding whether to keep, revise, or redo.
   ```

   Built from `attempts` + `git status` + `git diff --stat` at handoff time. No LLM, <50ms.

5. **Start the new session.** No context-engine rebuild is required for this spec (context engine is separate); if an engine exists later, it hooks in here.

### Where the note goes in the prompt

Options:
- Prepend to the story description — simplest, always works.
- Separate prompt section via builder — cleaner, requires builder awareness.

**Choose prepend** for Phase 1. Promoting it to a builder concern waits for the context engine, which has a better-factored injection mechanism.

### Observability

Every fallback emits a structured event on `ctx.metrics`:

```typescript
metrics.events.push({
  type: "agent.fallback.triggered",
  storyId, hop,
  priorAgent, priorTier,
  newAgent, newTier,                 // tier same as prior
  category, outcome,                 // from AdapterFailure
  at: new Date().toISOString(),
});
```

Run summary surfaces:

- Count of stories where fallback fired.
- Per-agent availability-failure counts (so operators see that Claude hit quota 14 times today).
- Any stories that exhausted all candidates.

### No orchestrator, no context engine dependency

The entire fallback mechanism lives in the runner + adapters. No new subsystem. The context engine, if/when it arrives, plugs in at the "inject prior-attempt note" step by providing a richer bundle — until then, the deterministic string is enough.

## File surface

### New

- `src/execution/fallback/classify.ts` — shared `AdapterFailure` classifier interface and helpers.
- `src/execution/fallback/map.ts` — fallback-map resolution (next candidate, exhaustion check).
- `src/execution/fallback/handoff.ts` — builds the prior-attempt note deterministically from `attempts` + git state.
- `src/config/schemas.ts` — add `FallbackMapSchema` under a new `fallback` top-level key.
- `test/unit/execution/fallback/classify.test.ts`
- `test/unit/execution/fallback/map.test.ts`
- `test/unit/execution/fallback/handoff.test.ts`
- `test/integration/execution/fallback/claude-to-codex.test.ts` — full story run with Claude quota-exhaustion simulation, verify Codex continuation.

### Modified

- `src/agents/acp/*.ts` — surface failures as `AdapterFailure`, with vendor + outcome classification.
- `src/agents/claude/*.ts` — same.
- `src/execution/runner-execution.ts` — implement the runner loop above; currently handles only escalation.
- `src/execution/escalation/*.ts` — ensure escalation still receives only `quality` failures and never sees `availability`.
- `src/metrics/story-metrics.ts` — add `fallbackEvents` bucket.

### Unchanged

- Prompt builders, context providers, review pipeline, verification, TDD stages. None need to know fallback happened; they run against whichever agent the runner hands them.

## Config migration

Additive, optional. No breaking changes. Default `fallback.enabled: false` — operators opt in.

Example enabling the common case:

```json
{
  "fallback": {
    "enabled": true,
    "map": {
      "claude": ["codex"]
    }
  },
  "agents": {
    "codex": {
      "protocol": "acp",
      "apiKey": "$OPENAI_API_KEY"
    }
  }
}
```

At run start, fallback map is validated:

- Every listed candidate must have a configured agent entry.
- Credentials for each candidate must be present (env var or config). A candidate with no credentials is logged as a warning and removed from the runtime map, so it's never tried.

## Rollout

| Phase | Ships | Default | Exit gate |
|:------|:------|:--------|:----------|
| 1 | Failure classification in adapters, no behavior change | inactive (no `fallback.enabled`) | Every adapter error produces correct `AdapterFailure` in tests |
| 2 | Runner fallback loop, deterministic handoff note | `enabled: false` | Integration test: forced quota failure on Claude, Codex continues story |
| 3 | Rate-limit in-place retry | same default | Tests for retry-after honoring |
| 4 | Observability events + run summary surfacing | same | Run summary shows fallback events |
| 5 | Documentation + one operator enabling it on a real run | opt-in | One operator reports fallback rescued at least one story |

No Phase 6 default-on. Fallback stays opt-in; enabling it commits the operator to running additional vendor credentials, which is a non-trivial ops decision.

## Risks

### Quota silently hides operator problems

If Claude keeps hitting quota and fallback keeps rescuing, the operator never notices they should upgrade their plan. **Mitigation:** fallback events are prominent in the run summary and metrics dashboard; repeated availability failures trigger a warning on `nax status`.

### Fallback candidate is also down

Vendor outages can correlate (shared cloud regions, shared dependencies). **Mitigation:** `maxHopsPerStory` bounds cost; story fails with `all-agents-unavailable`; operator decides whether to wait or retry later.

### Partial work confuses the fallback agent

The prior agent left a partial diff. The new agent may misinterpret it. **Mitigation:** the prior-attempt note explicitly says "inspect before deciding"; the note includes touched files and diff size so the agent doesn't blindly accept the partial state. Additionally, for some stories the operator may prefer to discard partial work — add `fallback.discardPartialWork: true` option (default false) that runs `git restore .` on the story's files before the new session starts.

### Mis-classification of quality as availability (or vice versa)

A hallucinated "quota" string in an error message could mis-classify a real quality failure. **Mitigation:** classification is based on HTTP status + structured error fields, not free-text matching. Classifier has unit tests per vendor. Unknown failures default to `fail-unknown` with category `other`, which falls through to plain fail-without-fallback rather than rescue.

### Cost explosion from fallback loops

An agent that keeps being hit by rate limits and falls back to a second one that also rate-limits could produce a ping-pong. **Mitigation:** each agent appears in `attempts` only once per story; hop counter bounds total attempts. The runner cannot revisit a previously-failed (agent, outcome) pair within the same story.

### Different vendors produce subtly different code

Quality consistency across vendors is not guaranteed. A feature half-written by Claude and half by Codex may be stylistically uneven. **Mitigation:** accept this as a cost of availability. For operators who care about consistency, disable fallback and accept the availability failure; it's a conscious tradeoff.

## Open questions

1. **Per-tier fallback maps?** `claude-fast → codex-fast, claude-powerful → local-powerful`? Probably yes, later. Start with single-level map keyed by agent id only.
2. **Retry budget across hops.** If Claude rate-limits, we retry twice, then fall back. Should the fallback candidate also have its own retry budget? Currently: yes, the budget is per-(agent, story), reset on agent switch.
3. **Partial-work discard policy.** `discardPartialWork` as proposed, or always preserve and let the agent decide? Start with preserve; revisit if evidence shows agents get confused.
4. **Escalation + fallback composition.** If quality-fallback is opted in and the fallback agent also produces quality failure, does the runner go back to the prior agent at a higher tier, or try a third agent? Start simple: when `onQualityFailure: true`, the runner exhausts fallback candidates at the current tier before considering tier escalation. Document as experimental.
5. **Sticky fallback?** If Claude was unavailable for story 1 and Codex rescued it, should story 2 default to Codex, or try Claude first again? Start with always-try-primary-first (simpler). Add a sticky option later if operators want it for cost reasons.

## Acceptance criteria

1. **Adapter classification.** Every `src/agents/acp/*` and `src/agents/claude/*` path that can fail returns an `AdapterFailure` with a populated `category`, `outcome`, and `retriable` flag. No raw errors bubble past the adapter boundary.

2. **Category mapping.** `fail-quota`, `fail-service-down`, `fail-auth`, `fail-timeout`, `fail-adapter-error` (default) are category `availability`; `fail-quality` is `quality`; `fail-unknown` is `other`. Verified by unit tests.

3. **Rate-limit retry.** When an adapter returns `fail-rate-limit` with `retriable: true`, the runner waits `retryAfterMs` (or the config default) and retries against the same agent, up to `retryRateLimitAttempts`. Only on exhaustion does fallback kick in.

4. **Availability fallback triggers.** An availability failure on the primary agent causes the runner to call `next_fallback(primary, attempts)` and start a new session at the *same tier* against the next candidate.

5. **Fallback map resolution.** `next_fallback("claude", [])` returns `"codex"` when `map.claude = ["codex", "gemini"]`. After Codex also fails, `next_fallback("claude", [claudeAttempt, codexAttempt])` returns `"gemini"`. After Gemini fails, the runner exits with `all-agents-unavailable`.

6. **Same-tier preservation.** When fallback fires from `claude/powerful`, the next attempt is `codex/powerful`, not `codex/balanced`. Tier only changes via escalation, never fallback.

7. **Quality-failure default.** With `onQualityFailure: false` (default), a quality failure climbs tiers within the same agent; fallback does not trigger.

8. **Quality-failure opt-in.** With `onQualityFailure: true`, a quality failure triggers fallback at the same tier before escalation. Exhausting fallback candidates then falls through to tier escalation on the primary agent.

9. **Hop bound.** `maxHopsPerStory` (default 2) caps agent switches per story. Exceeding it marks the story `all-agents-unavailable`.

10. **Credentials validation at run start.** A fallback candidate configured in the map but missing credentials is logged as a warning and removed from the runtime map. Does not cause a run failure.

11. **Handoff note determinism.** The prior-attempt note is built from `attempts` + `git status` + `git diff --stat` via string template only — no LLM call. Same inputs produce byte-identical output.

12. **Handoff note content.** The note includes prior agent, tier, category, outcome, vendor, touched files, last commit SHA, and diff size. It is prepended to the story description for the fallback session.

13. **Partial-work preservation.** By default, partial work on the work tree is not discarded on fallback. With `fallback.discardPartialWork: true`, `git restore .` runs on touched files before the new session starts.

14. **Observability.** Each fallback emits a `metrics.events.push({ type: "agent.fallback.triggered", ... })`. Run summary surfaces fallback counts per agent and lists stories that exhausted all candidates.

15. **Classification never infers from free text.** Classifier decisions are based on HTTP status codes and structured error fields, not on message substring matching. Verified by tests where a message containing "quota" but a 500 status is classified as `fail-service-down`, not `fail-quota`.

16. **Adapter boundary isolation.** Removing fallback config (`fallback.enabled: false`) returns the runner to current behavior: first availability failure fails the story, no retry. Tested by running the same story suite with the flag off and confirming metric parity with pre-spec behavior.

17. **No interaction with context engine.** This spec introduces no dependency on `src/context/`. Enabling fallback with no context engine present works correctly.

18. **No regression in escalation semantics.** All existing `src/execution/escalation/*` tests continue to pass. Escalation never receives an `availability` failure; fallback never receives a `quality` failure (unless `onQualityFailure: true` is set).
