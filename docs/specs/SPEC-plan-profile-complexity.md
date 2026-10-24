# SPEC: Plan's agent-profile rubric keeps the cheapest profile in play for simple and medium stories

Closes: #2606

## Summary

When `routing.agents.profiles` is set, `nax plan` (and `nax plan --decompose`) asks the plan model to assign each story an `agentProfileId` by following a fixed rubric, `OneShotPromptBuilder.agentProfileInstruction()`. The rubric never looks at story complexity, so a low-cost profile only survives when its affinity happens to list the story's task type and domain. This spec adds one rubric step: for a story whose `routing.complexity` is `simple` or `medium`, profiles that no weakness rules out and that are cheaper than everything the affinity step kept stay in the running even when their affinity does not match, and the existing "choose the lowest cost" step then picks among them. It also adds one plan-time `info` log line that counts how many stories went to each profile, so a skewed distribution shows without opening `prd.json`. Nothing at run time changes.

## Motivation

The rubric today:

1. Eliminate any profile whose weaknesses conflict with the story.
2. Keep profiles whose strengths or affinity cover the story's main job (task type + primary domain).
3. If more than one remains, choose the LOWEST cost profile.
4. If none clearly fit, omit `agentProfileId` entirely.

Low-cost profiles are usually described with mechanical task types and narrow domains, while most spec-driven stories are a feat or fix in a backend, api, logic or web domain. Step 2 therefore usually leaves only the medium-cost profile, and step 3 never gets to compare costs.

Evidence from deduplicated PRDs across several repos with a five-rung cross-agent profile ladder (two low-cost, one medium, two high):

- Before the profile wording was widened as a workaround: 767 profiled stories, 5% to low-cost profiles; of 466 `medium`-complexity stories, 10 (2%) went low-cost.
- After widening the low-cost profiles' affinity and adding an "overkill for a single small unit" weakness to the medium profile: 146 stories, 12% low-cost; `medium`-complexity stories went low-cost 21% of the time. Rewording what the plan model reads moves its picks.
- Low-cost picks hold up: 55 of 57 passed on their first rung. In a separate shadow comparison of 123 stories, every plan pick passed first rung, including all 19 low-cost picks.
- About 80% of `medium`-complexity stories still go to the medium-cost profile.

The workaround depends on every user writing their profile tables a particular way. Putting complexity into the rubric makes the behaviour the default. The plan model already writes `routing.complexity` for every story (`plan-builder.ts` requires it), so the input exists; only the rubric ignores it.

Profile assignment is also invisible today: seeing the distribution means reading `prd.json`. One log line at plan time fixes that.

## Design

### Approach

Two small changes, both in `packages/nax`, no new modules and no new exports.

**1. Rubric step.** `OneShotPromptBuilder.agentProfileInstruction()` returns five steps instead of four. Steps 1, 2 and the old steps 3 and 4 keep their wording; a new step 3 is inserted after the affinity step:

```text
When agent profiles are listed above, pick exactly ONE profile id per story and set it on the `agentProfileId` field. Apply these steps in order:
1. Eliminate any profile whose weaknesses conflict with the story.
2. Keep profiles whose strengths or affinity cover the story's main job (task type + primary domain).
3. If the story's complexity is `simple` or `medium`, also keep every profile step 1 did not eliminate whose Cost is lower than the Cost of every profile step 2 kept (low < medium < high), even when its affinity does not list the story's task type or domain. If step 2 kept none, keep the lowest-Cost profiles step 1 did not eliminate. Profiles whose Cost is — are ignored by this step, both as candidates and in the comparison.
4. If more than one remains, choose the LOWEST cost profile.
5. If none clearly fit, omit `agentProfileId` entirely — never invent a profile id.
```

The new step never re-admits a profile step 1 eliminated: weaknesses still rule a story out. It only adds profiles strictly cheaper than what step 2 kept, so when every profile shares one cost tier it adds nothing and the affinity filter still decides. It ignores profiles with no `costTier` (rendered `—`): they are never added by this step and play no part in the comparison. For a `simple` or `medium` story, step 5 (omit) is therefore reached only when step 1 eliminated every profile, or when every remaining profile's Cost is `—` and none matched in step 2. For `complex` and `expert` stories the rubric behaves exactly as before. "Cost" refers to the `Cost` column of the capability card table `agentCapabilityCards` already renders from `costTier`, whose values are `low`, `medium` and `high`.

Because both callers append the same static text, the change reaches `nax plan` (`PlanPromptBuilder.build`, via its `agentProfilesSection`) and `nax plan --decompose` (`buildDecomposePromptSync`, via `OneShotPromptBuilder.agentProfiles`). The step says "the story's complexity" rather than naming a field because the two output schemas differ: `nax plan` writes `routing.complexity` (`plan-builder.ts`), while decompose writes a top-level `complexity` (`decompose-builder.ts`) that is later stored as `routing.complexity`. Both models produce the value in the same response, so the step applies to both unchanged.

**2. Plan-time distribution log.** `finalizeAndWritePrd` (`src/plan/strategies/persist-prd.ts`) logs one `info` line after `finalizePrdRouting` returns and before the PRD is written:

- stage `"plan"`, message `"agent profile assignment"`
- data `{ storyCount, byProfile, unassigned }`, where `storyCount` is the number of stories counted, `byProfile` maps each `routing.agentProfileId` that names a profile in `args.agentRouting.profiles` to its story count, and `unassigned` counts counted stories whose `routing.agentProfileId` is absent or names no configured profile.
- The counted stories are the finalized PRD's stories, restricted to `args.scope` when a scope is given (decompose adds stories to an existing PRD and only those are counted).
- Counts are taken from the finalized PRD, so a story whose unknown profile id fell back to `routing.agents.default` is counted under the default profile's id. With no default, `finalizePrdRouting` leaves the unknown id on the story unchanged; the log counts that story as `unassigned`, never under the unknown id.
- The line is emitted only when `args.agentRouting?.enabled === true` and `args.agentRouting.profiles` is non-empty, the same condition under which `resolveAgentAssignment` assigns anything.

### Integration

Symbols read, unchanged:

- `OneShotPromptBuilder.agentCapabilityCards(profiles: AgentRoutingProfile[]): string` — renders the `Cost` column the new step refers to.
- `PlanPromptBuilder.build(specContent, codebaseContext, outputFilePath?, packages?, packageDetails?, projectProfile?, proposers?, profiles?): PlanningPromptParts` — appends `agentProfileInstruction()` when profiles are given.
- `buildDecomposePromptSync(input: DecomposePromptInput): string` — appends it through `OneShotPromptBuilder.agentProfiles`.
- `finalizePrdRouting(prd, agentRouting, profileName, models, defaultAgent, only?, preserveExistingAgent?): PRD` — produces the finalized `routing.agentProfileId` values the log counts.
- `getLogger()` from `@/logger`; `Logger.info(stage: string, message: string, data?: Record<string, unknown>): void`.

Symbols changed (the baseline exists only to locate the code; it is never the interface to implement):

- `OneShotPromptBuilder.agentProfileInstruction(): string` (`src/prompts/builders/one-shot-builder.ts`)
  - Baseline: returns the header line plus four numbered steps.
  - Target: returns the header line plus the five numbered steps shown under Approach, signature unchanged.
- `finalizeAndWritePrd(args: PersistPrdArgs): Promise<string>` (`src/plan/strategies/persist-prd.ts`)
  - Baseline: finalizes routing and writes the PRD with no routing log.
  - Target: same signature and return value; additionally emits the `"agent profile assignment"` `info` line described under Approach, once per call, when the routing condition holds.

### Failure Handling

| Situation | Behaviour |
|:---|:---|
| `routing.agents` absent, `enabled: false`, or `profiles` empty | No log line; the PRD is written exactly as before. |
| A counted story has no `agentProfileId` after finalization (none chosen, no default profile) | Counted in `unassigned`; not an error. |
| A counted story keeps an `agentProfileId` that names no configured profile (unknown id, no default profile) | Counted in `unassigned`, not under that id; not an error. |
| The plan model ignores the new step | No code-side correction; the pick stands as the model wrote it. |

## Out of Scope

- `resolveOperatingTier` precedence is unchanged: a profile's tier still takes precedence over `autoMode.complexityRouting` at run time.
- No run-time selection change: the story router hook (`routing.router`) and its precedence are untouched.
- nax does not re-pick or correct the plan model's `agentProfileId` in code; the rubric is guidance to the model only.
- No skew threshold, warning or failure on the distribution; the log line is informational only.
- The capability card table (`agentCapabilityCards`) columns and the `AgentRoutingProfile` schema are unchanged; a profile with no `costTier` gets no implied cost.
- The `nax plan` run summary printed to stdout is unchanged; the distribution is in the log only.
- The `agentProfileId` field hints in the plan and decompose JSON schemas ("best-matching profile … omit if none fits") are unchanged; the numbered rubric is the procedure the model follows.

## Stories

### US-001: The profile rubric weighs complexity, and plan logs the profile distribution
No dependencies. Workdir: packages/nax.

Insert the complexity step into `OneShotPromptBuilder.agentProfileInstruction()` as step 3 of five, keeping every other step's wording, and emit the `"agent profile assignment"` `info` line from `finalizeAndWritePrd` after routing finalization when agent routing is enabled with profiles.

### Context Files

**US-001**
- `packages/nax/src/prompts/builders/one-shot-builder.ts` — `agentProfileInstruction()` and `agentCapabilityCards()`
- `packages/nax/src/prompts/builders/plan-builder.ts` — `PlanPromptBuilder.build` appends the rubric
- `packages/nax/src/prompts/builders/decompose-builder.ts` — `buildDecomposePromptSync` appends the rubric
- `packages/nax/src/plan/strategies/persist-prd.ts` — `finalizeAndWritePrd`, the log site
- `packages/nax/test/unit/plan/strategies/persist-prd-workdir.test.ts` — `finalizeAndWritePrd` fixtures to mirror; its `captureWarnings` helper wraps `logger.warn` only, so the new test needs the same pattern applied to `logger.info` (and keeps the `warn` capture for the never-`warn` AC)

### Creates

**US-001**
- `packages/nax/test/unit/prompts/builders/agent-profile-rubric.test.ts` — tests for the five-step rubric and its presence in the plan and decompose prompts
- `packages/nax/test/unit/plan/strategies/persist-prd-profile-log.test.ts` — tests for the distribution log line

### Modifies

None. New tests go in the two files under `### Creates`. The existing rubric test in `packages/nax/test/unit/prompts/builders/one-shot-builder.test.ts` asserts `1. Eliminate any profile whose weaknesses conflict`, `LOWEST cost`, `omit \`agentProfileId\`` and `never invent`; all four survive unchanged in the five-step text. No existing `finalizeAndWritePrd` test asserts on `info` calls.

### Seams

None. No new exported symbol; both changes sit inside existing functions whose callers are unchanged.

## Acceptance Criteria

### US-001

- [unit] `OneShotPromptBuilder.agentProfileInstruction()` returns text with exactly five numbered steps, `1.` through `5.`, in that order.
- [unit] Step 3 of the returned text conditions on the story's complexity being `simple` or `medium` (naming both values), and says to also keep every profile step 1 did not eliminate whose Cost is lower than the Cost of every profile step 2 kept, even when its affinity does not list the story's task type or domain.
- [unit] Step 3 of the returned text states the cost order `low < medium < high`.
- [unit] Step 3 of the returned text says that when step 2 kept no profile, the lowest-Cost profiles step 1 did not eliminate are kept.
- [unit] Step 3 of the returned text says profiles whose Cost is `—` are ignored by the step, both as candidates and in the comparison.
- [unit] Step 1 of the returned text is `1. Eliminate any profile whose weaknesses conflict with the story.`, unchanged.
- [unit] Step 2 of the returned text is `2. Keep profiles whose strengths or affinity cover the story's main job (task type + primary domain).`, unchanged.
- [unit] Step 4 of the returned text is `4. If more than one remains, choose the LOWEST cost profile.`
- [unit] Step 5 of the returned text tells the model to omit `agentProfileId` when none clearly fit and to never invent a profile id.
- [unit] `PlanPromptBuilder.build` called with one `AgentRoutingProfile` produces prompt text that includes the step 3 complexity instruction.
- [unit] `buildDecomposePromptSync` called with one profile in `input.profiles` produces prompt text that includes the step 3 complexity instruction.
- [unit] `finalizeAndWritePrd` with `agentRouting` `{ enabled: true, profiles: [a, b] }` and a PRD of three stories whose `routing.agentProfileId` values are `a`, `a`, `b` calls `getLogger().info` exactly once with stage `"plan"`, message `"agent profile assignment"` and data `{ storyCount: 3, byProfile: { a: 2, b: 1 }, unassigned: 0 }`.
- [unit] With `agentRouting` `{ enabled: true, profiles: [a] }` and no `default`, a story with no `routing.agentProfileId` is counted in `unassigned` and absent from `byProfile`.
- [unit] With `agentRouting` `{ enabled: true, default: "a", profiles: [a, b] }`, a story whose `routing.agentProfileId` is the unknown id `"zzz"` is counted under `byProfile.a`, and `byProfile` has no `"zzz"` key.
- [unit] With `agentRouting` `{ enabled: true, profiles: [a] }` and no `default`, a story whose `routing.agentProfileId` is the unknown id `"zzz"` is counted in `unassigned`, and `byProfile` has no `"zzz"` key.
- [unit] With `args.scope` set to `{"US-002"}` on a PRD of stories `US-001` (profile `a`) and `US-002` (profile `b`), the logged data is `{ storyCount: 1, byProfile: { b: 1 }, unassigned: 0 }`.
- [unit] With `agentRouting` `undefined`, `finalizeAndWritePrd` makes no `info` call with message `"agent profile assignment"`.
- [unit] With `agentRouting` `{ enabled: false, profiles: [a] }`, `finalizeAndWritePrd` makes no `info` call with message `"agent profile assignment"`.
- [unit] With `agentRouting` `{ enabled: true, profiles: [] }`, `finalizeAndWritePrd` makes no `info` call with message `"agent profile assignment"`.
- [unit] The `"agent profile assignment"` line is logged through `info`, never through `warn`: with the three-story `a`, `a`, `b` fixture, no `warn` call carries that message.
