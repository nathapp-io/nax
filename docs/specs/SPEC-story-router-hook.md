# SPEC: Story router hook

## Summary

Add an opt-in hook that lets a plugin router choose each story's starting agent profile at run time,
including stories that `nax plan` already routed. A new `routing.router` config block sets the mode
(`off`, `shadow`, `apply`), the precedence between the router and plan (`router` or `plan`), and a
timeout. The router is consulted once per story, before the story's first attempt. In `shadow` mode its pick is
recorded and logged but not used. In `apply` mode its pick replaces plan's starting profile
(default precedence `router`), or only fills stories plan left without a profile (precedence
`plan`). Plan's own pick is always kept on the story for audit. With the block absent or
`mode: "off"`, routing behaves exactly as today.

## Motivation

nax can already load plugin routers (`PluginExtensions.router`), but they never run for a planned
story. `resolveRouting()` in `src/routing/router.ts` returns early at step 0 ("PRD wins") whenever
`story.routing.complexity` and `story.routing.testStrategy` are set, and `nax plan` always sets
both. The routing stage then seeds the starting rung from plan's `profileModelTier` through
`resolveOperatingTier()`, so plan's profile choice is final for the first attempt.

Plan's choice is made once, by the plan model, with the whole feature in view. A per-story
decision made by a dedicated router (a small classifier, a rules engine, or a learned model) has no
way in. On real cross-agent ladders this matters: across about 290 planned stories, the plan model
put about 79% on the mid-cost profile and about 3.5% on the low-cost profiles (see nax#2606).
That issue fixes plan's selection procedure. This feature is the separate, complementary hook that lets a
project plug in its own router and compare it against plan in shadow mode before trusting it.

## Design

### Config: `routing.router`

```json
{
  "routing": {
    "router": {
      "mode": "shadow",
      "precedence": "router",
      "timeoutMs": 5000
    }
  }
}
```

| Key | Values | Default | Meaning |
|:---|:---|:---|:---|
| `mode` | `"off"` \| `"shadow"` \| `"apply"` | `"off"` | `off`: never consult. `shadow`: consult, record, log, never apply. `apply`: consult and apply per `precedence`. |
| `precedence` | `"router"` \| `"plan"` | `"router"` | Only read in `apply` mode. `router`: the router's pick replaces plan's. `plan`: the router's pick is applied only when plan set no `agentProfileId`. |
| `timeoutMs` | integer > 0 | `5000` | Upper bound on one router call. |

The block is optional; omitting it is the same as `mode: "off"`. The schema lives in a new file
`src/config/schemas-router.ts` (`StoryRouterConfigSchema`), because `src/config/schemas-infra.ts`
is 594 lines against the 600-line source limit. `RoutingConfigSchema` gains one field,
`router: StoryRouterConfigSchema.prefault({})` (Zod 4: `.default({})` would skip the inner field
defaults, as noted in `src/config/schemas-advisor.ts`). The router picks among the profiles in
`routing.agents.profiles`; it adds no profile list of its own.

### Approach

The router is the existing plugin extension point, `PluginExtensions.router` (a `RoutingStrategy`).
No new plugin interface. The router's returned `RoutingDecision.agentProfileId` is the only field
the hook applies, plus the new optional `RoutingDecision.confidence`. The router's `complexity`,
`modelTier` and `testStrategy` are not applied to a planned story. Only the FIRST router in
`PluginRegistry.getRouters()` order is consulted.

Consultation is deterministic code in nax (no LLM call of its own). The decision a router makes is
entirely the plugin's business.

### Integration

This feature changes the symbols below. Each baseline is stated only to locate the code and is never
the interface to implement.

**`RoutingConfigSchema`**, `src/config/schemas-infra.ts` (US-001)
- Baseline: `z.object({ strategy, llm, agents })`
- Target: the same, plus `router: StoryRouterConfigSchema.prefault({})`, imported from `./schemas-router`.

**Root `routing` default**, `src/config/schemas.ts:143` (US-001)
- Baseline: `routing: RoutingConfigSchema.default({ strategy: "keyword", llm: {...}, agents: {...} })`
- Target: the same literal, plus `router: { mode: "off", precedence: "router", timeoutMs: 5000 }`.
  Zod 4 returns a `.default(literal)` value without parsing it, so without this entry
  `DEFAULT_CONFIG.routing.router` would be undefined despite the child's `.prefault({})`.

**`RoutingConfig` interface**, `src/config/runtime-types.ts:467` (US-001)
- Baseline: `{ strategy; llm?; agents? }`
- Target: the same, plus `router?: StoryRouterConfig` (type imported from `./schemas-router`).
  `NaxConfig.routing` is this hand-written interface, so code reads `config.routing.router?.mode`
  and `config.routing.agents?.enabled` (both optional at the type level).

**`RoutingDecision`**, `src/routing/decision.ts` (US-001)
- Baseline: `{ complexity, modelTier, testStrategy, reasoning, agent?, agentProfileId? }`
- Target: the same, plus `confidence?: number` (a router's confidence in `agentProfileId`, 0..1).

**`StoryRouting`**, `src/prd/types.ts` (US-001)
- Target: the existing interface, plus `routerDecision?: StoryRouterDecision`.

**`resolveRouting`**, `src/routing/router.ts` (US-002)
- Baseline: `resolveRouting(story, config, plugins, dispatchContext): Promise<RoutingDecision>`
- Target: `resolveRouting(story, config, plugins, dispatchContext, options?: { skipPluginRouters?: boolean }): Promise<RoutingDecision>`.
  With `skipPluginRouters: true`, step 1 (plugin routers) is skipped; every other step is unchanged.

**`routingStage.execute`**, `src/pipeline/stages/routing.ts` (US-003, US-004, US-005)
- Target: before calling `resolveRouting`, run the consult guards and consult (US-003), then pass
  `{ skipPluginRouters: <router is usable> }` to `resolveRouting`, then record and log the decision
  (US-004) and apply the pick (US-005) before `resolveOperatingTier` runs. `_routingDeps` gains
  `consultStoryRouter`.

New types and functions (created by this feature):

```typescript
// src/config/schemas-router.ts (US-001)
export const StoryRouterConfigSchema = z.object({
  mode: z.enum(["off", "shadow", "apply"]).default("off"),
  precedence: z.enum(["router", "plan"]).default("router"),
  timeoutMs: z.number().int().positive().default(5000),
});
export type StoryRouterConfig = z.infer<typeof StoryRouterConfigSchema>;

// src/prd/types.ts (US-001)
export interface StoryRouterDecision {
  mode: "shadow" | "apply";
  /** RoutingStrategy.name of the router consulted */
  router: string;
  outcome: "picked" | "declined" | "unknown-profile";
  /** The router's pick; present for "picked" and "unknown-profile" */
  profileId?: string;
  /** Present only for "picked", and only when the router returned a finite number in [0, 1] */
  confidence?: number;
  /** story.routing.agentProfileId as it was before the router ran; absent when plan set none */
  plannedProfileId?: string;
  /** true when the apply step wrote the router's pick as the starting profile (even if it equals plannedProfileId) */
  applied: boolean;
  /** ISO-8601 timestamp */
  decidedAt: string;
}

// src/routing/story-router.ts (US-002), exported from the src/routing barrel
export type StoryRouterOutcome =
  | { kind: "no-router" }
  | { kind: "picked"; router: string; profileId: string; confidence?: number; reasoning: string; latencyMs: number }
  | { kind: "declined"; router: string; latencyMs: number }
  | { kind: "unknown-profile"; router: string; profileId: string; latencyMs: number }
  | { kind: "error"; router: string; message: string; latencyMs: number }
  | { kind: "timeout"; router: string; latencyMs: number };

export async function consultStoryRouter(
  story: UserStory,
  config: NaxConfig,
  plugins: PluginRegistry | undefined,
  context: DispatchContext,
): Promise<StoryRouterOutcome>;
```

Symbols this feature reads but does not change:

- `PluginRegistry.getRouters(): RoutingStrategy[]`: `src/plugins/registry.ts:199`
- `RoutingStrategy.route(story, context: RoutingContext)`: `src/routing/router.ts:54`
- `resolveAgentAssignment(selectedProfileId, agentRouting, storyId, models, defaultAgent)`:
  `src/agents/shared/agent-profile-resolver.ts`. Note that it falls back to `routing.agents.default`
  for an unknown id. The router path must not reach that fallback (see US-002 and US-004).
- `resolveOperatingTier(input)`: `src/routing/operating-tier.ts:78`. It treats a persisted
  `story.routing.modelTier` that ranks above the candidate as an escalation and keeps it.
- `finalizePrdRouting(...)`: `src/plan/strategies/finalize-routing.ts`, the existing pattern for
  writing `agent`, `agentProfileId`, `profileModelTier`/`profileModelPin` and the `initial*` fields.

Patterns to follow: `src/config/schemas-mcp.ts` and `src/config/schemas-model.ts` for a schema in
its own file; `_routingDeps` in `src/pipeline/stages/routing.ts` for injectable dependencies;
`logger.warnOnce` (as in `agent-profile-resolver.ts`) for a once-per-run warning.

### `consultStoryRouter` pipeline (US-002)

Checked in this order. The first step that produces an outcome ends the call:

1. `plugins` is undefined, or `plugins.getRouters()` is empty: return `{ kind: "no-router" }`.
2. Call `route(story, { ...context, config })` on the first router only, racing it against
   `config.routing.router.timeoutMs`. The timer wins: return `timeout`. The call throws or rejects:
   return `error` with the error's message.
3. The router returns `null`, or a decision with no non-empty `agentProfileId`: return `declined`.
4. `agentProfileId` is not the `id` of any entry in `config.routing.agents.profiles`: return
   `unknown-profile`. This does not fall back to `routing.agents.default`.
5. Otherwise return `picked`. `confidence` is copied only when it is a finite number in [0, 1];
   otherwise it is omitted. `reasoning` is the decision's `reasoning`.

`latencyMs` is measured from just before `route` is called until the outcome is known.

### Consult guards and the plugin-router flag (US-003)

`routingStage.execute` reads the block with optional chaining (`config.routing.router?.mode`); an
absent block behaves as `mode: "off"`. The router is **usable** when `mode` is not `"off"`,
`config.routing.agents?.enabled` is true, and `config.routing.agents?.profiles` is non-empty. When
`mode` is not `"off"` but the router is not usable, the stage warns once per run through
`logger.warnOnce("routing", "Story router enabled but routing.agents is disabled or has no profiles", { storyId,
... })` and does not consult.

The stage consults only when ALL of these hold, checked in this order:

1. The router is usable.
2. `story.escalations` is empty.
3. `story.routing?.routerDecision` is undefined.

The stage passes `{ skipPluginRouters: <router is usable> }` to `resolveRouting`. While the router
is usable, plugin routers act only as story routers. They no longer feed `resolveRouting` step 1
for unplanned stories, because that would apply a shadow-mode pick. When the router is off or not
usable, step 1 runs exactly as today.

### Record and log step (US-004)

After `consultStoryRouter` returns:

| Outcome | `routerDecision` persisted? | Log |
|:---|:---|:---|
| `no-router` | no | none |
| `error` | no; consulted again on the next routing pass | `warn`, message `routing.router.failed`, data `outcome: "error"` and the message |
| `timeout` | no; consulted again on the next routing pass | `warn`, message `routing.router.failed`, data `outcome: "timeout"` |
| `declined` | yes, `outcome: "declined"`, `applied: false` | `info`, message `routing.router.decision` |
| `unknown-profile` | yes, `outcome: "unknown-profile"`, `profileId` recorded, `applied: false` | `info`, message `routing.router.decision` |
| `picked` | yes; `applied: false` in `shadow`, per the precedence table in `apply` (US-005) | `info`, message `routing.router.decision` |

Every persisted decision records `mode`, `router`, `plannedProfileId` (the story's
`agentProfileId` before the router ran), and `decidedAt`. The decision is attached to
`ctx.story.routing` in the stage's existing write-back, so `routing` always carries `complexity`,
`testStrategy` and `reasoning` (an unplanned story gets them from `resolveRouting` first). It is
saved by the stage's existing `savePRD` call, under the existing `skipPrdPersistence` gate. The
`routing.router.decision` data is `{ storyId, mode, router, outcome, plannedProfileId,
routerProfileId, confidence, applied, latencyMs }`, with `storyId` first.

### Apply step (US-005)

Only for a `picked` outcome in `apply` mode:

| `precedence` | plan set `agentProfileId`? | Applied? |
|:---|:---|:---|
| `router` | yes (including the same id the router picked) | yes |
| `router` | no | yes |
| `plan` | yes | no (recorded, `applied: false`) |
| `plan` | no | yes |

`applied` means the apply step wrote the router's pick as the story's starting profile, even when
the pick equals `plannedProfileId`.

Applying resolves the picked id with `resolveAgentAssignment(pickedId, config.routing.agents,
story.id, config.models, resolveDefaultAgent(config))`. Step 4 of the consult pipeline guarantees
that the id exists, so the default-profile fallback is never reached. It then updates
`ctx.story.routing`:

1. Removes `modelTier`, `profileModelTier`, `profileModelPin`, `initialModelTier` and
   `initialModelPin`.
2. Writes `agent`, `agentProfileId` and `initialAgent`, `initialProfileId` from the assignment.
3. Writes `profileModelTier` and `initialModelTier` when the assignment carries a tier, or
   `profileModelPin` and `initialModelPin` when it carries a literal model.

Step 1 matters because `resolveOperatingTier` treats a persisted `modelTier` that ranks above the
candidate on `tierOrder` as an escalation and keeps it (`operating-tier.ts:88-91`). The step also
stops a plan-time pin or tier from outliving a router pick of the other kind. `complexity`,
`initialComplexity`, `testStrategy` and `reasoning` are never changed by the apply step. For an unplanned
story the apply step runs after `resolveRouting` has produced those fields; it may build a
partial `routing` object that the stage's existing write-back then completes with `complexity`,
`testStrategy` and `reasoning`.

### Failure Handling

| Condition | Behaviour |
|:---|:---|
| No router plugin registered | Fail open: no decision, no log line, routing as today |
| Router throws or rejects | Fail open: plan routing used; `warn` `routing.router.failed`; not persisted, so retried on the next routing pass |
| Router exceeds `timeoutMs` | Fail open: plan routing used; `warn` `routing.router.failed`; not persisted, so retried on the next routing pass |
| Router declines (null, or no `agentProfileId`) | Plan routing used; decision persisted as `declined` |
| Router picks an id not in `routing.agents.profiles` | Plan routing used; never `routing.agents.default`; persisted as `unknown-profile` |
| Router returns `confidence` outside [0, 1], or not a finite number | Confidence omitted from the outcome and the persisted decision |
| `mode` not `off` but `routing.agents` disabled or without profiles | Router not consulted; warn once per run; plugin routers keep feeding `resolveRouting` step 1 |

The router never blocks or fails a run. The timeout race uses a cancellable timer that does not
outlive the call (see the `setTimeout` exception in `.nax/rules/forbidden-patterns-source.md`).

## Out of Scope

- This feature ships no router implementation; it adds only the hook that consults a plugin router registered through `PluginExtensions.router`.
- Changing the plan-time agent-profile selection procedure in `OneShotPromptBuilder.agentProfileInstruction()` is tracked in nax#2606 and is not part of this feature.
- A per-run summary of the starting-profile distribution is tracked in nax#2606 and is not part of this feature.
- Only the first router returned by `PluginRegistry.getRouters()` is consulted; chaining or voting across several router plugins is not supported.
- The router is never consulted again for a story once `story.routing.routerDecision` is persisted or once the story has any escalation record.
- The story router never changes a story's `complexity`, `initialComplexity`, `testStrategy` or `reasoning`; it changes only the starting agent profile.
- The run-time agent classifier selected by `routing.agents.strategy: "llm"` is unchanged by this feature.
- The `story.start` preview built by `buildPreviewRouting` in `src/execution/executor-types.ts` is not changed: for a story the router has not consulted yet, the first `story.start` line can announce plan's rung while the routing stage runs the router's rung.
- The parallel pre-dispatch routing callers in `src/execution/unified-executor-parallel-dispatch.ts` keep calling `resolveRouting` without options and do not consult the story router; only the routing stage does.
- Existing PRDs need no migration; a story without `routerDecision` is consulted on its next routing pass when the router is enabled.
- User documentation under `docs/guides/` for `routing.router` is a manual follow-up after merge; no story edits `docs/`.

## Stories

1. **US-001: Router config and types**, `Workdir: packages/nax`. No dependencies.
   Add `StoryRouterConfigSchema` in `src/config/schemas-router.ts`, wire it into
   `RoutingConfigSchema` as `routing.router` with `.prefault({})`, add `router` to the root `routing`
   default literal in `src/config/schemas.ts` and to the `RoutingConfig` interface in
   `src/config/runtime-types.ts`, add `RoutingDecision.confidence` (`src/routing/decision.ts`),
   add the `StoryRouterDecision` type and `StoryRouting.routerDecision`, and document the three keys
   in `FIELD_DESCRIPTIONS`.
2. **US-002: `consultStoryRouter`**, `Workdir: packages/nax`. Depends on US-001.
   Create `src/routing/story-router.ts` implementing the consult pipeline (first router only,
   timeout, error capture, declined, unknown-profile, confidence filtering), export it from the
   `src/routing` barrel, and add the `skipPluginRouters` option to `resolveRouting`.
3. **US-003: Consult guards in the routing stage**, `Workdir: packages/nax`. Depends on US-002.
   Wire `consultStoryRouter` into `routingStage.execute` behind the usable-router check and the
   two per-story guards, warn once when enabled but not usable, and pass `skipPluginRouters` to
   `resolveRouting`. The helper logic lives in a new `src/pipeline/stages/routing-story-router.ts`.
4. **US-004: Record and log the router's decision**, `Workdir: packages/nax`. Depends on US-003.
   Persist `routerDecision` per the outcome table in the stage's write-back, and log
   `routing.router.decision` or `routing.router.failed`. Shadow mode is complete after this story.
5. **US-005: Apply the router's pick**, `Workdir: packages/nax`. Depends on US-004.
   In `apply` mode, apply a `picked` outcome per the precedence table, clearing and rewriting the
   starting-rung fields.

### Context Files

**US-001**

- `packages/nax/src/config/schemas-infra.ts`
- `packages/nax/src/config/schemas.ts`
- `packages/nax/src/config/runtime-types.ts`
- `packages/nax/src/prd/types.ts`
- `packages/nax/src/cli/config-descriptions.ts`

**US-002**

- `packages/nax/src/routing/router.ts`
- `packages/nax/src/routing/index.ts`
- `packages/nax/src/plugins/registry.ts`
- `packages/nax/src/agents/shared/agent-profile-resolver.ts`
- `packages/nax/test/unit/routing/routing-strategies.test.ts`

**US-003**

- `packages/nax/src/pipeline/stages/routing.ts`
- `packages/nax/src/routing/story-router.ts` (created by US-002, consumed here)
- `packages/nax/src/logger/logger.ts`
- `packages/nax/test/unit/pipeline/stages/routing-profile-tier.test.ts`

**US-004**

- `packages/nax/src/pipeline/stages/routing-story-router.ts` (created by US-003, extended here)
- `packages/nax/src/pipeline/stages/routing.ts`
- `packages/nax/src/prd/types.ts`
- `packages/nax/test/unit/pipeline/stages/routing-persistence.test.ts`

**US-005**

- `packages/nax/src/pipeline/stages/routing-story-router.ts` (created by US-003, extended here)
- `packages/nax/src/routing/operating-tier.ts`
- `packages/nax/src/agents/shared/agent-profile-resolver.ts`
- `packages/nax/src/plan/strategies/finalize-routing.ts`
- `packages/nax/test/unit/pipeline/stages/routing-initial-model-tier.test.ts`

### Creates

**US-001**

- `packages/nax/src/config/schemas-router.ts`: `StoryRouterConfigSchema` and `StoryRouterConfig`

**US-002**

- `packages/nax/src/routing/story-router.ts`: `consultStoryRouter` and `StoryRouterOutcome`

**US-003**

- `packages/nax/src/pipeline/stages/routing-story-router.ts`: the usable-router check, consult guards and helpers used by `routingStage.execute`

### Modifies

None. No existing test pins a closed-world shape this feature changes: `routing.router` is a new
optional block whose default is `mode: "off"`, under which `routingStage.execute` passes
`{ skipPluginRouters: false }` and `resolveRouting` behaves as today. No existing routing-stage
test asserts the arguments `resolveRouting` receives. `RoutingDecision.confidence`, the
`resolveRouting` options parameter and `StoryRouting.routerDecision` are optional additions. The
config-descriptions coherence test (`test/unit/cli/config-descriptions.test.ts`) asserts only
that documented `routing.*` keys exist in `RoutingConfigSchema`, which the new `routing.router.*`
entries satisfy.

### Seams

- US-002 produces `consultStoryRouter`; US-003 consumes it. Seam ACs in US-003 (consulted once
  with the story in shadow and in apply mode; consulted again after an `error`): stub
  `_routingDeps.consultStoryRouter` and trigger `routingStage.execute`. The guarded re-trigger
  (not consulted again after a persisted pick) is in US-004, which owns persistence.
- US-002 produces the `skipPluginRouters` option; US-003 consumes it. Seam ACs in US-003 (the
  three `skipPluginRouters` ACs): stub `_routingDeps.resolveRouting`, trigger
  `routingStage.execute`, and assert the options argument.
- US-001 produces `StoryRouting.routerDecision`; US-004 writes it and US-005 sets `applied`.

## Acceptance Criteria

### US-001: Router config and types

1. [unit] `RoutingConfigSchema.parse({ strategy: "keyword" }).router.mode` equals `"off"`.
2. [unit] `RoutingConfigSchema.parse({ strategy: "keyword" }).router.precedence` equals `"router"`.
3. [unit] `RoutingConfigSchema.parse({ strategy: "keyword" }).router.timeoutMs` equals `5000`.
4. [unit] `DEFAULT_CONFIG.routing.router.mode` equals `"off"`.
5. [unit] `RoutingConfigSchema.safeParse({ strategy: "keyword", router: { mode: "auto" } }).success` is `false`.
6. [unit] `RoutingConfigSchema.safeParse({ strategy: "keyword", router: { precedence: "first" } }).success` is `false`.
7. [unit] `RoutingConfigSchema.safeParse({ strategy: "keyword", router: { timeoutMs: 0 } }).success` is `false`.
8. [unit] `RoutingConfigSchema.parse({ strategy: "keyword", router: { mode: "apply", precedence: "plan", timeoutMs: 1500 } }).router` equals `{ mode: "apply", precedence: "plan", timeoutMs: 1500 }`.
9. [unit] `RoutingConfigSchema.parse({ strategy: "keyword", router: { mode: "shadow" } }).router` equals `{ mode: "shadow", precedence: "router", timeoutMs: 5000 }`.
10. [unit] `StoryRouterConfigSchema` imported from `src/config/schemas-router.ts` parses `{}` to `{ mode: "off", precedence: "router", timeoutMs: 5000 }`.
11. [unit] `FIELD_DESCRIPTIONS["routing.router.mode"]` is a non-empty string that names `off`, `shadow` and `apply`.
12. [unit] `FIELD_DESCRIPTIONS["routing.router.precedence"]` is a non-empty string that names `router` and `plan`.
13. [unit] `FIELD_DESCRIPTIONS["routing.router.timeoutMs"]` is a non-empty string.

**Verification note:** `RoutingDecision.confidence`, `StoryRouterDecision`,
`StoryRouting.routerDecision` and `RoutingConfig.router` are type-only additions, verified by
`bun run typecheck`.

### US-002: `consultStoryRouter`

1. [unit] `consultStoryRouter` returns `{ kind: "no-router" }` when `plugins` is `undefined`.
2. [unit] `consultStoryRouter` returns `{ kind: "no-router" }` when `plugins.getRouters()` returns an empty array.
3. [unit] When the first router's `route` returns a decision with `agentProfileId: "native-luna"` and `routing.agents.profiles` contains a profile with id `"native-luna"`, `consultStoryRouter` returns an outcome with `kind: "picked"` and `profileId: "native-luna"`.
4. [unit] The `picked` outcome's `router` equals the consulted `RoutingStrategy.name`.
5. [unit] When the decision carries `confidence: 0.82`, the `picked` outcome's `confidence` equals `0.82`.
6. [unit] When the decision carries `confidence: 1.5`, the `picked` outcome has no `confidence` property.
7. [unit] When the decision carries `confidence: Number.NaN`, the `picked` outcome has no `confidence` property.
8. [unit] When `route` returns `null`, `consultStoryRouter` returns an outcome with `kind: "declined"`.
9. [unit] When `route` returns a decision without `agentProfileId`, `consultStoryRouter` returns an outcome with `kind: "declined"`.
10. [unit] When `route` returns `agentProfileId: "no-such-profile"` and `routing.agents.default` names an existing profile, `consultStoryRouter` returns `{ kind: "unknown-profile", profileId: "no-such-profile" }` (plus `router` and `latencyMs`), not the default profile.
11. [unit] When `route` throws `new Error("router down")`, `consultStoryRouter` resolves to an outcome with `kind: "error"` and `message: "router down"`.
12. [unit] When `route` returns a promise that never settles and `routing.router.timeoutMs` is `50`, `consultStoryRouter` resolves to an outcome with `kind: "timeout"`.
13. [unit] When two routers are registered, only the first router's `route` is called.
14. [unit] `route` is called with the story passed to `consultStoryRouter` and a context whose `config` is the config passed to `consultStoryRouter`.
15. [unit] `consultStoryRouter` is importable from the `src/routing` barrel (`@/routing`) and is callable as an async function.
16. [unit] `resolveRouting(story, config, plugins, ctx, { skipPluginRouters: true })` for a story without `routing.complexity` does not call the registered router's `route`.
17. [unit] `resolveRouting(story, config, plugins, ctx)` with no options argument for a story without `routing.complexity` still calls the registered router's `route` once.

### US-003: Consult guards in the routing stage

All ACs use `routing.agents` with `enabled: true` and profiles `native-deepseek` (native, balanced),
`native-luna` (native, fast) and `claude-haiku` (claude, fast), a stubbed
`_routingDeps.consultStoryRouter`, and a story with no `escalations` whose plan routing has
`agentProfileId: "native-deepseek"`, unless the AC says otherwise.

1. [unit] With `routing.router.mode: "off"`, `routingStage.execute` does not call `_routingDeps.consultStoryRouter`.
2. [unit] With a config whose `routing` has no `router` key, `routingStage.execute` completes with `action: "continue"` and does not call `_routingDeps.consultStoryRouter`.
3. [unit] With `routing.router.mode: "shadow"` and a story with no `routing.routerDecision`, `routingStage.execute` calls `_routingDeps.consultStoryRouter` once with `ctx.story`.
4. [unit] With `routing.router.mode: "apply"` and a story with no `routing.routerDecision`, `routingStage.execute` calls `_routingDeps.consultStoryRouter` once with `ctx.story`.
5. [unit] With `routing.router.mode: "shadow"` and the stub returning `error` on the first call, a second `routingStage.execute` on the same story calls `_routingDeps.consultStoryRouter` again.
6. [unit] With `routing.router.mode: "shadow"` and a story whose `escalations` has one entry, `routingStage.execute` does not call `_routingDeps.consultStoryRouter`.
7. [unit] With `routing.router.mode: "apply"` and a story whose `escalations` has one entry, `routingStage.execute` does not call `_routingDeps.consultStoryRouter`.
8. [unit] With `routing.router.mode: "shadow"` and `routing.agents.profiles` empty, `routingStage.execute` does not call `_routingDeps.consultStoryRouter`.
9. [unit] With `routing.router.mode: "shadow"` and `routing.agents.enabled: false`, `routingStage.execute` does not call `_routingDeps.consultStoryRouter`.
10. [unit] With `routing.router.mode: "shadow"` and `routing.agents.profiles` empty, `routingStage.execute` logs a warning with message `Story router enabled but routing.agents is disabled or has no profiles`.
11. [unit] With `routing.router.mode: "shadow"` and `routing.agents.profiles` empty, the `Story router enabled but routing.agents is disabled or has no profiles` warning has `storyId` as the first key of its data.
12. [unit] With `routing.router.mode: "shadow"` and `routing.agents.profiles` empty, running `routingStage.execute` for two different stories in one run logs the `Story router enabled but routing.agents is disabled or has no profiles` warning once.
13. [unit] With `routing.router.mode: "shadow"`, `routingStage.execute` calls `_routingDeps.resolveRouting` with a fifth argument equal to `{ skipPluginRouters: true }`.
14. [unit] With `routing.router.mode: "off"`, `routingStage.execute` calls `_routingDeps.resolveRouting` with a fifth argument equal to `{ skipPluginRouters: false }`.
15. [unit] With `routing.router.mode: "shadow"` and `routing.agents.enabled: false`, `routingStage.execute` calls `_routingDeps.resolveRouting` with a fifth argument equal to `{ skipPluginRouters: false }`.

### US-004: Record and log the router's decision

All ACs use the US-003 profiles, `routing.router.mode: "shadow"`, a stubbed
`_routingDeps.consultStoryRouter`, and a story whose plan routing has `agentProfileId:
"native-deepseek"`, unless the AC says otherwise. The **shadow luna pick** setup means the stub
returns `picked` with `profileId: "native-luna"` and `router: "test-router"`.

1. [unit] In the shadow luna pick setup, `ctx.story.routing.agentProfileId` is still `"native-deepseek"` after `routingStage.execute`.
2. [unit] In the shadow luna pick setup, `ctx.story.routing.routerDecision.applied` is `false`.
3. [unit] In the shadow luna pick setup, `ctx.story.routing.routerDecision.mode` is `"shadow"`.
4. [unit] In the shadow luna pick setup, `ctx.story.routing.routerDecision.profileId` is `"native-luna"`.
5. [unit] In the shadow luna pick setup, `ctx.story.routing.routerDecision.plannedProfileId` is `"native-deepseek"`.
6. [unit] In the shadow luna pick setup, `ctx.story.routing.routerDecision.router` is `"test-router"`.
7. [unit] In the shadow luna pick setup, `Date.parse(ctx.story.routing.routerDecision.decidedAt)` is a finite number.
8. [unit] When the stub returns `picked` with `confidence: 0.7`, `ctx.story.routing.routerDecision.confidence` is `0.7`.
9. [unit] When the stub returns `picked` with no `confidence`, `ctx.story.routing.routerDecision` has no `confidence` property.
10. [unit] When the stub returns `declined`, `ctx.story.routing.routerDecision.outcome` is `"declined"`.
11. [unit] When the stub returns `unknown-profile` with `profileId: "no-such-profile"`, `ctx.story.routing.routerDecision.outcome` is `"unknown-profile"`.
12. [unit] When the stub returns `unknown-profile` with `profileId: "no-such-profile"`, `ctx.story.routing.routerDecision.profileId` is `"no-such-profile"`.
13. [unit] When the stub returns `error`, `ctx.story.routing.routerDecision` is `undefined` after `routingStage.execute`.
14. [unit] When the stub returns `timeout`, `ctx.story.routing.routerDecision` is `undefined` after `routingStage.execute`.
15. [unit] When the stub returns `no-router`, `ctx.story.routing.routerDecision` is `undefined` after `routingStage.execute`.
16. [unit] In the shadow luna pick setup, `routingStage.execute` logs at info level a message `routing.router.decision` whose data has `applied: false`.
17. [unit] The `routing.router.decision` log entry from the shadow luna pick setup has `storyId` as the first key of its data.
18. [unit] When the stub returns `error` with `message: "router down"`, `routingStage.execute` logs at warn level a message `routing.router.failed` whose data has `outcome: "error"`.
19. [unit] When the stub returns `timeout`, `routingStage.execute` logs at warn level a message `routing.router.failed` whose data has `outcome: "timeout"`.
20. [unit] When the stub returns `no-router`, `routingStage.execute` logs neither `routing.router.decision` nor `routing.router.failed`.
21. [unit] In the shadow luna pick setup with `ctx.prdPath` set, `_routingDeps.savePRD` is called with a PRD whose story carries `routing.routerDecision.profileId` equal to `"native-luna"`.
22. [unit] In the shadow luna pick setup, a second `routingStage.execute` on the same story does not call `_routingDeps.consultStoryRouter` again.
23. [unit] In the shadow luna pick setup with a story that has no plan routing (no `routing.complexity`), `ctx.story.routing.complexity` after `routingStage.execute` equals the complexity returned by `_routingDeps.resolveRouting`.

### US-005: Apply the router's pick

All ACs use the US-003 profiles, `routing.router.mode: "apply"`, a stubbed
`_routingDeps.consultStoryRouter`, and `autoMode.escalation.tierOrder` set to the agent-rung
ladder `[{tier: "fast", agent: "native"}, {tier: "fast", agent: "claude"}, {tier: "balanced",
agent: "native"}, {tier: "powerful", agent: "native"}, {tier: "balanced", agent: "claude"}]`. The
story's plan routing has `agentProfileId: "native-deepseek"`, `agent: "native"`,
`profileModelTier: "balanced"`, `initialModelTier: "balanced"` and a persisted
`modelTier: "balanced"`, unless the AC says otherwise. Named setups:

- **router haiku pick**: `precedence: "router"`, stub returns `picked` with `profileId: "claude-haiku"`.
- **router pin pick**: `precedence: "router"`, stub picks a profile for which `resolveAgentAssignment` returns a `profileModelPin` (its `target.model` is a literal model id, not a tier name).
- **plan haiku pick**: `precedence: "plan"`, stub returns `picked` with `profileId: "claude-haiku"`.
- **plan unprofiled luna pick**: `precedence: "plan"`, a story whose plan routing has no `agentProfileId`, stub returns `picked` with `profileId: "native-luna"`.
- **router unplanned luna pick**: `precedence: "router"`, a story with no plan routing (no `routing.complexity`), stub returns `picked` with `profileId: "native-luna"`.

1. [unit] In the router haiku pick setup, `ctx.story.routing.agentProfileId` is `"claude-haiku"` after `routingStage.execute`.
2. [unit] In the router haiku pick setup, `ctx.story.routing.agent` is `"claude"`.
3. [unit] In the router haiku pick setup, `ctx.routing.modelTier` is `"fast"`, although plan persisted `modelTier: "balanced"`.
4. [unit] In the router haiku pick setup, `ctx.story.routing.profileModelTier` is `"fast"`.
5. [unit] In the router haiku pick setup, `ctx.story.routing.initialProfileId` is `"claude-haiku"`.
6. [unit] In the router haiku pick setup, `ctx.story.routing.initialAgent` is `"claude"`.
7. [unit] In the router haiku pick setup, `ctx.story.routing.initialModelTier` is `"fast"`.
8. [unit] In the router haiku pick setup, `ctx.story.routing.routerDecision.applied` is `true`.
9. [unit] In the router haiku pick setup, `ctx.story.routing.routerDecision.plannedProfileId` is `"native-deepseek"`.
10. [unit] In the router haiku pick setup, `routingStage.execute` logs at info level a message `routing.router.decision` whose data has `applied: true`.
11. [unit] In the router pin pick setup, `ctx.story.routing.profileModelPin` equals the picked profile's `target.model`.
12. [unit] In the router pin pick setup, `ctx.story.routing.profileModelTier` is `undefined`.
13. [unit] In the router pin pick setup, `ctx.story.routing.initialModelPin` equals the picked profile's `target.model`.
14. [unit] With `precedence: "router"`, a story whose plan routing has `profileModelPin` and `initialModelPin` set and no `profileModelTier`, and the stub returning `picked` with `profileId: "claude-haiku"`, `ctx.story.routing.initialModelPin` is `undefined` after `routingStage.execute`.
15. [unit] In the plan haiku pick setup, `ctx.story.routing.agentProfileId` stays `"native-deepseek"`.
16. [unit] In the plan haiku pick setup, `ctx.story.routing.routerDecision.applied` is `false`.
17. [unit] In the plan unprofiled luna pick setup, `ctx.story.routing.agentProfileId` is `"native-luna"`.
18. [unit] In the plan unprofiled luna pick setup, `ctx.story.routing.routerDecision.applied` is `true`.
19. [unit] With `precedence: "router"` and the stub returning `picked` with `profileId: "native-deepseek"` (the same id plan set), `ctx.story.routing.routerDecision.applied` is `true`.
20. [unit] With `precedence: "router"` and the stub returning `declined`, `ctx.story.routing.agentProfileId` stays `"native-deepseek"`.
21. [unit] With `precedence: "router"`, `routing.agents.default: "native-luna"`, and the stub returning `unknown-profile`, `ctx.story.routing.agentProfileId` stays `"native-deepseek"`.
22. [unit] In the router unplanned luna pick setup, `ctx.story.routing.agentProfileId` is `"native-luna"`.
23. [unit] In the router unplanned luna pick setup, `ctx.story.routing.complexity` equals the complexity returned by `_routingDeps.resolveRouting`.
