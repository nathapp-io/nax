# Phase A plan C — unify `{ agent, model }` tier-or-model resolution

Date: 2026-09-02
Status: design, awaiting review
Depends on: ADR-027, `2026-09-02-native-credentials-probe-and-fallback-tiers-design.md`
(plan 3, merged as #1792 — §5 is this plan's charter), nax#1739, nax#1722, #1522, #1575
Blocks: Phase A plan 4 (op cutover)

## 1. What this plan is

Plan 3 §5 moved one item out to its own plan: the same string is treated as a
tier in one place and a literal model name in another, the two disagree, and
the disagreement reaches `prd.json`. This plan delivers that item.

The rule, as ruled by the user: **`{ agent, model }` means a tier when the
string names a tier for that agent, and a literal model name otherwise** —
consistently, everywhere the shape appears.

Nothing is broken today: all nine routing profiles under `~/.nax/profiles/`
use only `fast`, `balanced` and `powerful`. Every defect below bites the moment
a native profile is written, because ADR-027 settled native models as
`provider/model` strings grouped under **custom tier names**
(`native: { cheap: "opencode-go/deepseek-v4-flash" }`). That makes this a
prerequisite for plan 4's op cutover, not for anything in flight.

Plan 3 §5 listed four defects. Re-investigation against the current tree
revises the count and the shape of the fix:

| | Item | Disposition |
|---|---|---|
| A | `resolveConfiguredModel` object form never asks the tier question | fixed by the shared membership resolver (§3) |
| — | `resolvePlanModelSelection` try/catch rescues only one spelling | **collapses into A** — the catch stays untouched; the plan path gains one explicit unknown-literal guard (§3) |
| B | `agent-profile-resolver` records a literal pin as a tier | fixed by the tier/pin split (§4) |
| C | `TIER_RANK` hardcoded; custom tiers unrankable | rank derived from `tierOrder` rungs (§5) |
| D | initial placement: `complexityRouting` cannot name a cross-agent rung | rung-qualified complexity routing (§6) |

Plus two contracts that already exist as behaviour but not as promises,
written down and pinned by tests (§7), and validation that keeps the open tier
keyspace safe (§8).

The through-line of the whole plan: **`tierOrder` is already the only ordering
mechanism the escalation engine uses** (`escalateTier` walks the array by
index, matching rungs by `(tier, agent)` tuple —
`src/execution/escalation/escalation.ts:36-46`), and **the models map is
already an open tier keyspace**
(`Record<agentName, Record<tierName, ModelEntry>>`,
`src/config/schemas-model.ts:34`). Every defect is a place that consults a
hardcoded builtin-name list instead of one of those two sources of truth. The
fix is derivation, not new vocabulary: **no new builtin tier names, no
expanded `TIER_RANK`, no second ranking system.**

## 2. The contract

Stated once, implemented everywhere the `{ agent, model }` shape or a bare
model string appears:

**Resolution order** for a string `S` under agent `A`:

1. **Shorthand alias.** `MODEL_SHORTHAND_TIERS` (haiku/sonnet/opus →
   fast/balanced/powerful, `src/config/schema-types.ts:66`) maps `S` to a tier
   name first, exactly as today. Alias check stays ahead of membership.
2. **Tier membership.** `S` is a tier for `A` iff `models[A][S]` exists, else
   iff `models[defaultAgent][S]` exists. Membership is **fallback-inclusive**,
   mirroring `resolveModelForAgent`'s own two-step lookup — the string form
   already resolves through that fallback, and the ruling is that the two
   spellings agree, so membership must see the same keyspace resolution sees.
   When membership is satisfied only via the defaultAgent fallback **and** the
   two agents sit on different protocols (native vs acp), resolution warns:
   the resolved model string may name a provider the dispatching agent cannot
   serve.
3. **Literal model.** Otherwise `S` resolves via `resolveModel(S)` as a raw
   model id.
4. **Warn on unrecognizable literals.** A literal whose provider inference
   fails (`resolveModel` guesses `"unknown"`) **and** that carries no `/`
   (not a native `provider/model` string) is accepted — but resolution warns,
   naming the agent's available tiers. It cannot throw: an acp agent may
   legitimately advertise a model id no static heuristic recognizes
   (`{ agent: "opencode", model: "minimax-m3" }` is a legal pin), so
   garbage-vs-legit is undecidable here. The uniformity the ruling demands is
   that **the tier question is asked identically in both spellings** — the
   string form stays tier-only (throws on non-tiers) by definition; the
   object form is tier-or-literal by the ruling, and its failure mode goes
   from silent to loud. The plan path additionally self-rescues (§3).

**Tier-first precedence** is the deliberate consequence: a string that names a
tier is a tier, even if it also happens to look like a model id. A user who
wants a literal model whose name collides with a tier name renames the tier;
the collision case is pathological and the precedence rule makes it
deterministic.

**Ordering** comes from `autoMode.escalation.tierOrder` alone. A rung's rank
is its index in the ladder. There is no other rank.

## 3. Item A — shared membership resolver

### The problem

`resolveConfiguredModel`'s object form (`src/config/schema-types.ts:98-119`)
checks the alias map, then `isBuiltinModelTier` (a hardcoded
fast/balanced/powerful list, `schema-types.ts:72`), then falls through to
literal `resolveModel(selection.model)`. A custom tier name defined in
`models.native` is invisible to it. Measured (plan 3 §5): the string form
`"turbo"` throws `MODEL_NOT_FOUND`; `{ agent: "native", model: "turbo" }`
silently returns `{ provider: "unknown", model: "turbo" }`. Same user error,
two spellings, opposite behaviour.

### The design

One exported predicate in `src/config/schema-types.ts`:

```ts
/** Is `name` a tier for `agent`? Fallback-inclusive: mirrors resolveModelForAgent. */
export function resolveTierMembership(
  models: ModelsConfig,
  agent: string,
  name: string,
  defaultAgent: string,
): { isTier: boolean; viaDefaultAgentFallback: boolean };
```

`resolveConfiguredModel`'s object form becomes: alias → `resolveTierMembership`
→ literal (warn when unrecognizable, §2 step 4). The `isBuiltinModelTier` call
site in the object form is replaced by the membership call. When the string is
a tier, the return carries `modelTier` exactly as the string form does; when
it is a literal, `modelTier` stays absent (unchanged, load-bearing — see §9).

`resolvePlanModelSelection` (`src/cli/plan-runtime.ts:33-43`) keeps its catch
untouched, and gains one explicit guard for the plan path: a resolved plan
model with `modelTier` absent, provider `"unknown"` and no `/` in the model id
is a config typo, not a deliberate pin — log a warning and use the same
default-balanced fallback the catch produces. This restores the "plan proceeds
with a garbage model" fix without making the shared resolver throw on literals
that acp agents may legitimately advertise.

`isBuiltinModelTier` itself stays exported for now — other call sites are out
of scope (§10) — but the object form of `resolveConfiguredModel` no longer
uses it.

### Tests

- Custom tier: `models.native.turbo` defined ⇒ `{ agent: "native", model:
  "turbo" }` resolves to native's turbo entry with `modelTier: "turbo"`; the
  string form `"turbo"` under `preferredAgent: "native"` resolves identically.
- Unrecognizable literal: `{ agent: "native", model: "turbo" }` with no
  `turbo` tier anywhere resolves as a literal with `modelTier` absent **and
  logs a warning** naming the agent's available tiers (the silent
  `{ provider: "unknown" }` case becomes loud).
- Fallback membership: `models.native` lacks `balanced`, `models.claude` has
  it ⇒ `{ agent: "native", model: "balanced" }` resolves via the claude entry,
  `agent` stays `"native"`, and the cross-protocol warning fires (protocol
  differs) / does not fire (same protocol).
- Literal pin: `{ agent: "native", model: "opencode-go/deepseek-v4-flash" }`
  with no such tier resolves as a literal, `modelTier` absent.
- Alias precedence: `{ agent: "native", model: "sonnet" }` maps to tier
  `balanced` before membership runs.
- Plan self-rescue: `plan.model` set to a garbage object form makes
  `resolvePlanModelSelection` return the default balanced resolution (the
  explicit unknown-literal guard fires), not a `{ provider: "unknown" }`
  result; a legitimate `provider/model` or known-prefix pin passes through
  untouched.

## 4. Item B — a pin is not a tier

### The problem

`toAssignment` (`src/agents/shared/agent-profile-resolver.ts:39`) assigns
`profileModelTier: p.target.model` unconditionally. A profile that pins a
literal model is recorded as though it targeted a tier; `finalize-routing.ts`
persists it into `prd.json` (`profileModelTier` and `initialModelTier`,
`src/plan/strategies/finalize-routing.ts:26-29`), and the routing stage feeds
it to `resolveOperatingTier` as `profileTier`
(`src/pipeline/stages/routing.ts:44`), where a literal model name is
meaningless as a rung.

### The design

`toAssignment` calls the §3 membership resolver against the profile's target
agent:

- Tier ⇒ `profileModelTier` set, as today.
- Not a tier ⇒ `profileModelTier` **absent**; a new optional field
  `profileModelPin: string` carries the literal model name.

`ResolvedAgentAssignment`, `StoryRouting` and `finalize-routing.ts` gain the
optional `profileModelPin` / `initialModelPin` fields alongside the existing
tier fields; both are persisted to `prd.json`. A pin and a tier are mutually
exclusive on an assignment.

Downstream semantics of a pin follow nax#1739, which is already implemented
and stays untouched: a pinned model is dispatched for its own agent
(`resolved.modelDef`), dies on any agent swap (`pinnedModelAgent`,
`src/operations/build-hop-callback.ts:304-306`), and contributes no
`modelTier`. The only change is that the pin now *survives into the PRD under
its true name* instead of masquerading as a tier and poisoning tier
precedence. `resolveOperatingTier` receives `profileTier: undefined` for a
pinned story and the derived tier seeds the rung as if no profile tier
existed; the pin is applied at model-resolution time, not at rung-selection
time.

### Tests

- Profile targeting `{ agent: "native", model: "cheap" }` with
  `models.native.cheap` defined ⇒ assignment has `profileModelTier: "cheap"`,
  no pin.
- Profile targeting `{ agent: "claude", model: "claude-opus-5" }` (not a tier)
  ⇒ assignment has `profileModelPin: "claude-opus-5"`, `profileModelTier`
  absent; `finalize-routing` persists `profileModelPin` and `initialModelPin`
  onto the story and never writes the literal into `initialModelTier`.
- Routing stage with a pinned story passes `profileTier: undefined` into
  `resolveOperatingTier` and the derived tier wins.

## 5. Item C — rank from the ladder

### The problem

`resolveOperatingTier` (`src/routing/operating-tier.ts`) compares ranks from a
hardcoded `TIER_RANK = { fast: 0, balanced: 1, powerful: 2 }`
(`operating-tier.ts:18`). Its one job: with **no** escalation record, decide
whether a `previousTier` is a genuine pre-record escalation (keep) or a stale
leftover (discard). An escalation record already wins outright, because a
cross-agent ladder escalates sideways or down (#1522). A custom tier ranks
`undefined`, so on a native ladder the heuristic can neither keep nor rank —
every recordless custom-tier `previousTier` degrades to the
`unknownPreviousTier` warn path.

### The design

Rank is the rung's index in `tierOrder`. Two consequences, both taken from
machinery that already exists:

**Rungs, not names.** On a cross-agent ladder the same tier name can appear at
two rungs (`native/balanced` at index 1, `claude/balanced` at index 2), so
ranking by name alone is ambiguous. `resolveOperatingTier` adopts the exact
matching rule `tier-escalation.ts:158-163` already uses: when any rung carries
an `agent`, look up by `(tier, agent)` tuple; otherwise by tier name. The
lookup helper is shared with `getTierConfig` — one matching rule, two callers,
no drift.

**Inputs become rungs.** `OperatingTierInput` gains the agent context each
tier already has in the callers:

```ts
export interface OperatingTierInput {
  previousTier?: string;
  /** Agent persisted alongside previousTier — escalation writes both. */
  previousAgent?: string;
  profileTier?: string;
  /** The profile assignment's agent. */
  profileAgent?: string;
  derivedTier: string;
  hasEscalationRecords: boolean;
  /** The ladder. Absent/empty ⇒ every tier is unrankable (record-wins only). */
  tierOrder?: TierConfig[];
}
```

`previousTier` pairs with `story.routing.agent` — escalation persists agent
alongside tier (`tier-escalation.ts:230-240`), so the data is already on the
story. `profileTier` pairs with the assignment's agent. `derivedTier` carries
no agent unless §6's rung-qualified complexity routing supplies one; an
agentless tier ranks at the **first** ladder index whose tier name matches.

Both callers move in lockstep — this is the #1575 invariant and the reason
the precedence lives in one function: the routing stage
(`src/pipeline/stages/routing.ts:42-47`) and `buildPreviewRouting`
(`src/execution/executor-types.ts:100-105`) each pass the same story-derived
rung inputs. Both already hold `story.routing`; the change is threading two
extra fields, not finding new data.

`TIER_RANK` is deleted. Precedence semantics are unchanged: record wins
outright; recordless higher-ranked previous rung is kept; unrankable previous
rung (off-ladder, or empty ladder) keeps the existing `unknownPreviousTier`
warn-and-ignore path, which is the correct off-ladder behaviour (§7).

### Tests

- Custom-tier ladder `[native/cheap, native/balanced, claude/powerful]`:
  recordless `previousTier: "balanced"` + `previousAgent: "native"` over
  candidate `cheap`/`native` ⇒ kept (rank 1 > 0). Reversed ⇒ discarded.
- Name ambiguity: ladder `[native/balanced, claude/balanced]`, previous rung
  `claude/balanced`, candidate `native/balanced` ⇒ kept (index 1 > 0) — name-
  only ranking would call them equal.
- Escalation record with sideways/down move on a custom ladder ⇒ previous rung
  kept regardless of index (record wins, #1522 preserved).
- Off-ladder previous rung, no record ⇒ discarded, `unknownPreviousTier: true`.
- Empty/absent `tierOrder` ⇒ every recordless previous tier is unrankable;
  record-backed ones still win.
- Preview parity (#1575): for the same story state, `buildPreviewRouting` and
  the routing stage resolve the identical rung on a cross-agent custom ladder.

## 6. Item D — initial placement can name a rung

### The problem

`nax plan` decides where a story *starts*. The profile path already lands on
any rung (`target: { agent, model }` → agent + tier). The derived path cannot:
`complexityRouting` maps complexity to a bare tier name
(`src/routing/router.ts:100-103`), validated against the **default agent's**
tier map only (`src/config/validate.ts:130-138`). On a cross-agent ladder a
bare `"balanced"` implicitly means "defaultAgent's balanced", so every
unprofiled story starts on the default agent — silently defeating the
cost-efficiency ladder the cross-agent `tierOrder` exists to provide
(cheap native rungs first, claude rungs as the escalation ceiling).

### The design

`complexityRouting` values widen from `string` to `string | { tier: string;
agent?: string }`:

```jsonc
"complexityRouting": {
  "simple":  { "tier": "cheap", "agent": "native" },
  "medium":  { "tier": "balanced", "agent": "native" },
  "complex": { "tier": "balanced", "agent": "claude" },
  "expert":  "powerful"                    // string stays legal
}
```

A string value keeps today's semantics (defaultAgent's tier). An object value
names a rung: `complexityToModelTier` grows a rung-returning sibling
(`complexityToRung`), and the routing stage seeds both the derived tier **and**
the derived agent from it when no profile assignment exists. The derived agent
flows into `resolveOperatingTier` as the candidate rung's agent (§5) and into
the story's agent assignment exactly where the default agent is applied today.

Escalating from a native rung to a claude rung crosses the protocol boundary
through ordinary agent selection — `agent.protocol` is the capability gate,
the claude agent stays on acpx, and the subscription restriction is honoured
structurally. No new mechanism.

### Tests

- Object-form routing: complexity `simple` with `{ tier: "cheap", agent:
  "native" }` on an unprofiled story ⇒ story routes to agent `native`, tier
  `cheap`.
- String form unchanged: `"balanced"` ⇒ defaultAgent, tier `balanced`, byte-
  identical routing to today.
- Profile still wins: a story with a profile assignment ignores the
  complexity-derived rung's agent.
- Schema: both forms parse; `{ agent: "nosuch" }` fails validation (§8).

## 7. Contracts written down

Two behaviours that exist today only as accidents-with-comments become
promises with pinning tests.

### Off-ladder start = fixed rung, no escalation

A profile may target a rung not on the ladder at all ("run this story on
exactly claude/powerful, period"). Today that path warns "escalation budget is
unbounded" (`tier-escalation.ts:165-172`) and `escalateTier` returns `null`
(`escalation.ts:45`) — no escalation, ever. This is the right semantics for a
deliberate off-ladder pin and it becomes the documented contract: **on-ladder
start walks the ladder from its rung; off-ladder start stays put, with a
default attempt budget and one warning.** Legal, not a validation error —
§8 warns at config load but does not reject.

Constraint carried forward verbatim: the `attempts === 0` early return and its
`@design` guard (`tier-escalation.ts:145-155`, #1575 — a first attempt has no
rung to judge; pre-classification a stale tier pairs with the profile's agent)
**must survive any refactor this plan performs in that file.** The existing
comment says exactly this; the test below makes it unremovable.

### Pin-swap tier precedence

`call.ts:69` (`effectiveTier = resolved.modelTier ?? "balanced"`) is a fifth
hardcoded-builtin site plan 3 §5 did not list: when a literal model is pinned,
the downstream tier silently defaults to `"balanced"`, and on an agent swap
`call.ts:92` re-resolves via `tier ?? effectiveTier`. On a ladder whose swap
target defines no `"balanced"` tier, the swap throws mid-flight.

The override mechanism already shipped in plan 3: fallback-map candidates are
`string | { agent, tier }` (`src/config/runtime-types-agent.ts:35-37`) — the
tier that survives the swap. The contract: **an explicit fallback-map tier
wins; the bare `"balanced"` remains as the documented last resort** for
tierless swaps with no map entry. No behaviour change on the happy path; the
residual `"balanced"` defaults here, in `complexityToModelTier`'s `??
"balanced"` and in `buildPreviewRouting`'s display fallback
(`executor-types.ts:99`) are accepted degrade-don't-throw defaults and are
annotated as such, not removed.

### Tests

- Off-ladder profile rung: story runs, exhausts attempts, is never escalated,
  and exactly one unbounded-budget warning is logged.
- First-attempt guard: a story at `attempts: 0` with a stale off-ladder
  `previousTier` is neither skipped nor escalated and the PRD is not dirtied.
- Swap with fallback-map `{ agent, tier }`: the named tier resolves on the
  swap target; without a map entry, a tiered resolution reuses its tier and a
  pinned (tierless) resolution falls back to `balanced`.

## 8. Validation

Added to the existing hooks (`validateConfig` in `src/config/validate.ts`,
which already tuple-checks rung agents against models keys at
`validate.ts:117-127`, and the schema superRefine that already gates
`models.native` on `agent.protocol`, `src/config/schemas.ts:546-557`):

- **Every `tierOrder` rung resolves within its own agent's map**:
  `models[rung.agent ?? defaultAgent][rung.tier]` must exist. Today only the
  agent key is checked; a missing tier inside it is silently masked at run
  time by `resolveModelForAgent`'s defaultAgent fallback — a config typo that
  currently ships. Error, not warning.
- **Every profile target that names a tier resolves in its own agent's map**;
  a target satisfiable only via the defaultAgent fallback across a protocol
  boundary warns.
- **Off-ladder profile rungs warn** — at load where profile visibility
  exists, otherwise at first route in the routing stage ("story X's profile targets
  claude/powerful which is not on tierOrder — it will never escalate"), do not
  reject (§7).
- **Object-form `complexityRouting` rungs** (§6): named agent must be a models
  key; named tier must resolve under that agent.

### Tests

- Rung `{ tier: "cheap", agent: "native" }` with `models.native` present but
  lacking `cheap` ⇒ validation error naming the rung.
- Ladder valid under own-agent resolution but relying on defaultAgent fallback
  ⇒ error (rung case) — the fallback is a resolution-time safety net, not a
  licence for rungs.
- Off-ladder profile target ⇒ warning, config accepted.

## 9. What this plan does not touch

- **`pinnedModelAgent` / pin-dies-on-swap** (`build-hop-callback.ts:304-306`,
  nax#1739/#1722): already correct; §4 feeds it better-labelled data, nothing
  more. Do not "fix" the absent `modelTier` on a pin — it is the design.
- **`MODEL_SHORTHAND_TIERS`**: list and precedence (alias before membership)
  unchanged.
- **Escalation walking** (`escalateTier`, budgets, records, batch escalation):
  the ladder mechanics are the SSOT this plan derives *from*; they do not
  change.
- **`agent.protocol` gating and the fallback-map mechanics** shipped in plans
  1–3.
- **No new builtin tier names.** `fast`/`balanced`/`powerful` stay as the
  defaults and the required tiers for the default agent
  (`validate.ts:38-60`); the open keyspace does the rest.

## 10. Out of scope

- Retiring `isBuiltinModelTier`'s remaining call sites outside
  `resolveConfiguredModel`, and the residual `?? "balanced"` last-resort
  defaults (§7) — annotated, not removed.
- Auto-deriving a per-agent starting rung from cost/pricing metadata — the
  ladder is authored, not inferred.
- Any change to which agent the claude subscription dispatches through
  (acpx/Claude Code) — protocol hybrid is a given, not a variable, here.
- prd.json migration for existing PRDs carrying a literal model in
  `profileModelTier` — none exist (no native profile has ever been written;
  all nine real profiles use builtin tiers).

## 11. Sequencing and verification

Three tranches, each independently green:

1. **Identity** (§3 + §4): membership resolver, object-form fix, tier/pin
   split, PRD fields. Pure config/plan-side; no runtime routing behaviour
   changes for builtin-tier configs.
2. **Ordering + placement** (§5 + §6): rung-ranked `resolveOperatingTier` in
   both callers, rung-qualified `complexityRouting`. The #1575 parity test is
   the gate.
3. **Contracts + validation** (§7 + §8): pinning tests for the two contracts,
   the four validation additions.

Byte-compatibility bar for the whole plan: a config using only
`fast`/`balanced`/`powerful` with no custom tiers, no native agent and no
object-form `complexityRouting` routes every story identically to today —
existing routing/escalation suites pass unmodified except where they assert
the `TIER_RANK` constant itself.

Verification: `bun run test` (routing, escalation, config suites),
`bun run typecheck`, `bun run lint`; plus the per-section tests above landing
fail-first in their tranche.
