# SPEC: Retire dead CLI and config surface

## Summary

nax ships user-facing surface that claims capability it does not have. `nax config` documents four configuration keys that gate no behaviour; `src/cli/interact.ts` and `src/interaction/state.ts` implement a disk-based interaction protocol that has no producer; and `nax status` carries a branch that can never execute. This spec removes all of it: the four no-op config keys are deleted behind a warn-and-strip guard, and the orphaned interaction disk-persistence layer plus its CLI front door are deleted outright. The live in-process interaction path is untouched.

## Motivation

Two independent findings from the 2026-08-09 whole-repo gap analysis, re-probed against `main` at v0.79.0.

**Four config keys are declared, typed, defaulted, documented, and never read.**

| Key | Declared | Behavioural reader |
|:---|:---|:---|
| `execution.rectification.escalateOnExhaustion` | `schemas-execution.ts:76` | none |
| `tdd.autoVerifyIsolation` | `schemas-execution.ts:337` | none |
| `tdd.autoApproveVerifier` | `schemas-execution.ts:338` | none |
| `acceptance.generateTests` | `schemas-infra.ts:41` | none |

All four appear in `src/cli/config-descriptions.ts`, the text `nax config` prints. A user reads that `tdd.autoVerifyIsolation` toggles isolation verification, sets it to `false`, gets no error — and isolation verification runs anyway, unconditionally, from `operations/write-test.ts`, `operations/verify.ts` and `operations/implement.ts`. The documentation actively misleads.

They are camouflaged against reference-count auditing: each is a **required** field on the runtime types, so every test fixture must supply it. `autoVerifyIsolation` appears in 10 test files, `generateTests` in 11 — every one a literal in an object satisfying the type checker. The reliable discriminator is a schema test with no behaviour test.

`escalateOnExhaustion` has a distinct history: `docs/specs/SPEC-rectification-escalation.md` US-001 (declare the field) shipped and US-002 (the escalation behaviour) never did. That spec is now stale — it names `src/verification/rectification-loop.ts` and `src/execution/escalation.ts`, neither of which exists; tier escalation was since rebuilt under `src/execution/escalation/`. The field is also the only member of `RectificationConfigSchema` written `.optional().default(true)` while every wired sibling is `.boolean().default(true)`.

**The `nax interact` command surface has no working protocol beneath it.**

The interaction subsystem is live, but entirely **in-process**: `InteractionChain` dispatches to plugins (`cli`, `auto`, `webhook`, `telegram`) and `AcpInteractionBridge.waitForResponse` (`src/agents/acp/interaction-bridge.ts:89`) awaits the answer in memory. Nothing touches disk.

The disk-based protocol beside it is orphaned end to end. `savePendingInteraction` (`src/interaction/state.ts:122`) has **zero call sites repo-wide** — no `src/`, no `test/`, no `scripts/`. Nothing ever writes `<featureDir>/interactions/`. `<featureDir>/responses/` is written only by `interact.ts` and read by nobody. Consequently:

- `nax interact list` could only ever print "No pending interactions".
- `nax interact respond` / `cancel` could only ever throw "Interaction request not found".
- `nax status` has an unreachable "Paused — Waiting for Interaction" block (`src/cli/status-features.ts:298`) — and unlike `interact`, `status` **is** registered, so this dead branch ships in a command users actually run.

With `interact.ts` and that branch removed, all eight exports of `src/interaction/state.ts` become unreferenced — including `serializeRunState` / `deserializeRunState` / `clearRunState` / the `RunState` type, which already have zero callers anywhere. The file has no test file of its own.

The gap analysis called this "backend built, front door missing". The backend is missing too, so the fix is deletion, not registration.

## Design

Three independent changes, one theme: surface that claims capability it does not have is removed, and removal is made audible rather than silent.

### Integration

Verified against `main` at `fdfb7e0e` (v0.79.0).

#### Where the config guard goes

`src/config/config-guards.ts` (193 lines) already owns "reject configuration that no longer means what the user thinks", exporting four guards:

| Guard | Line | Behaviour |
|:---|:---|:---|
| `rejectLegacyAgentKeys` | 27 | throws `NaxError` |
| `rejectLegacyRectificationKeys` | 75 | throws `NaxError` |
| `rejectDeadQualityFlags` | 150 | throws `NaxError` |
| `rejectUnimplementedScopedProfile` | 182 | throws `NaxError` |

The new function joins this file rather than a new module — it is the same concern, and `config-patterns.md` requires one owner per concept.

**This one warns and strips where its four siblings throw. That divergence is deliberate and must be documented in the function's doc comment**, because the nearest precedent went the other way. `rejectDeadQualityFlags` removed three `quality.require*` flags that were, in its own words, "declared in the schema, carried through runtime-types and the per-package merge, and documented in the CLI — but read at no gate site" — an identical shape to these four — and chose to throw, reasoning that a silent strip "would leave the user believing the override still applies".

The rationale for diverging: a warning also cures that false belief, while a throw hard-fails every existing config that sets a key which was already inert. These four gate nothing, so no behaviour is dropped either way; the gentler mechanism is preferred where the only harm is a stale key. The doc comment must state this so the next reader does not read the inconsistency as an oversight.

```typescript
// src/config/config-guards.ts

/** Removed key's dotted path → hint appended to its warning. */
const REMOVED_NO_OP_KEYS: Readonly<Record<string, string>> = {
  "execution.rectification.escalateOnExhaustion": "…",
  "tdd.autoVerifyIsolation": "…",
  "tdd.autoApproveVerifier": "…",
  "acceptance.generateTests": "use `acceptance.enabled` instead",
};

/**
 * Strip config keys that were declared but never read, warning once per key.
 *
 * Unlike its `reject*` siblings this warns rather than throws — see spec.
 * Returns a new object; does not mutate `conf`.
 */
export function stripRemovedNoOpKeys(
  conf: Record<string, unknown>,
  warn?: (msg: string) => void,
): Record<string, unknown>;
```

#### Where it is called

The `reject*` guards run **post-merge and pre-`safeParse`**, at two sites:

- `loader.ts:353-361` — root chain, operating on `rawConfig`
- `loader.ts:486-489` — per-package overlay chain, operating on `rawMerged`

`stripRemovedNoOpKeys` joins **both**, reassigning the object (`rawConfig = stripRemovedNoOpKeys(rawConfig)`) since it returns a new value rather than throwing. Wiring only the root site is the obvious half-fix and is pinned by AC-10.

Post-merge placement is deliberate and differs from the pre-merge, per-layer shim chain at `loader.ts:277` / `:296` (`_applyRemovedRoutingKeysShim`, `_applyLegacyReviewExecutionShim`, `applyBatchModeCompat`). Those shims run once per config layer; a key set in both the global and the project layer would warn twice. Running post-merge yields one warning per resolved config regardless of which layer supplied the key.

`defaultConfigWarn` (`loader.ts:52-59`, wrapping `getLogger().warn("config", msg)`) is the default sink, matching the shim family. The injectable `warn` parameter exists for testing, following `_applyRemovedRoutingKeysShim`.

#### Key declaration sites to remove

| File | Lines |
|:---|:---|
| `src/config/schemas-execution.ts` | `76` (`escalateOnExhaustion`), `337` (`autoVerifyIsolation`), `338` (`autoApproveVerifier`) |
| `src/config/schemas-infra.ts` | `41` (`generateTests`) |
| `src/config/runtime-types.ts` | `70`, `232`, `236`, `305` |
| `src/cli/config-descriptions.ts` | `83`, `123`, `125`, `181` |
| `src/config/schemas.ts` | `130`, `218`, `219`, `291` (default literals) |

`src/config/merge.ts` needs **no code change** — its acceptance, tdd and rectification merging is spread-based (`merge.ts:97-99`, `152-158`), not per-field. Only its stale doc comment at `merge.ts:22`, which lists `generateTests` among the deep-merged acceptance fields, is corrected.

Both `runtime-types.ts` (596 lines) and `schemas.ts` (597 lines) sit within 4 lines of the 600-line hard limit; this change shrinks both. `config-guards.ts` at 193 lines has ample headroom.

`loadConfig` caches its resolved root config; `_clearRootConfigCache` (`loader.ts:385`) exists for tests and must be called between `loadConfig`-altitude cases, as `legacy-rectification-keys.test.ts` does.

#### Interaction deletion targets

| Target | Current state |
|:---|:---|
| `src/cli/interact.ts` | 301 lines; exports `interactListCommand`, `interactRespondCommand`, `interactCancelCommand`; never registered — no `.command(` literal in `bin/` or `src/` names it |
| `src/cli/constitution.ts` | 17 lines; exports only `ConstitutionGenerateOptions`, zero references repo-wide |
| `src/cli/index.ts:49-51` | barrel re-exports of the three interact handlers |
| `src/cli/status-features.ts:298-320` | unreachable "Paused — Waiting for Interaction" block |
| `src/interaction/state.ts` | all 8 exports (`validateInteractionId`, `serializeRunState`, `deserializeRunState`, `clearRunState`, `savePendingInteraction`, `loadPendingInteraction`, `deletePendingInteraction`, `listPendingInteractions`) plus the `RunState` type |
| `src/interaction/index.ts:25-36` | barrel re-exports of the above |

The `RunState` interface at `src/plugins/builtin/otel-reporter/index.ts:55` is an unrelated local declaration and must not be touched.

**Explicitly unchanged:** `src/interaction/chain.ts`, `triggers.ts`, `bridge-builder.ts`, `init.ts`, `types.ts`, all four plugins under `src/interaction/plugins/`, `src/agents/acp/interaction-bridge.ts`, and `src/pipeline/subscribers/interaction.ts`.

### CLI Behavior

`nax config` no longer lists the four removed keys among its descriptions. No exit-code change.

`nax status -f <feature>` no longer emits the "Paused — Waiting for Interaction" section under any input, including a feature directory that contains an `interactions/` subdirectory. All other status output is unchanged. No exit-code change.

`nax run` / `nax plan` emit one `[WARN]` line per removed key present in the resolved config, via the project logger, and proceed normally. A removed key never fails a run.

### Failure Handling

| Condition | Behaviour |
|:---|:---|
| Removed key present with an unexpected value type (e.g. `tdd.autoVerifyIsolation: "yes"`) | Stripped and warned identically — the guard keys on path presence, never on value type |
| Parent object present but not an object (e.g. `tdd: 42`) | No warn, no throw; value passes through untouched for Zod to reject downstream |
| Parent object absent entirely (e.g. no `tdd` key) | No warn, no throw; config returned unchanged |
| Same removed key set in both the global and the project layer | Stripped once with a single warning — the guard runs post-merge, after the layers have been combined |

## Out of Scope

- Building a disk-backed producer for pending interactions. The in-process `InteractionChain` path remains the only interaction mechanism in nax.
- Registering `nax interact` as a CLI command, in this or any follow-up implied by this spec.
- Implementing tier escalation on rectification exhaustion, i.e. US-002 and US-003 of `docs/specs/SPEC-rectification-escalation.md`. That spec is retired as won't-do by this work.
- Converting `stripRemovedNoOpKeys` into a throwing guard, or converting any of the four existing `reject*` guards into warn-and-strip. The divergence is deliberate and documented.
- Consolidating the four existing `reject*` guards or the three pre-merge shims into a shared table-driven mechanism.
- Adding replacement configuration keys for any of the four removed keys.
- Making isolation verification, verifier auto-approval, or acceptance test generation conditionally disableable. Each currently runs unconditionally and continues to.
- Modifying `src/interaction/chain.ts`, `triggers.ts`, `bridge-builder.ts`, or any plugin under `src/interaction/plugins/`.
- Adding test coverage for existing `AutoInteractionPlugin` decision behaviour, including its refusal to auto-approve requests whose metadata trigger is `security-review`. That guard already exists at `src/interaction/plugins/auto.ts:128`, is unchanged by this work, and a test for it could not fail first.
- Changing the behaviour of `acceptance.enabled`, which remains the single switch governing acceptance test generation.

## Stories

**US-001 — Remove four no-op config keys behind a warn-and-strip guard**
Complexity: moderate. Dependencies: none.
Adds `stripRemovedNoOpKeys` to `src/config/config-guards.ts`, calls it at both guard sites in `loader.ts`, and deletes the four keys from the schemas, runtime types, default literals and `nax config` descriptions. Removal of the declarations is verified by the build/static gate; the guard's behaviour is verified by the ACs below.
Verification note: declaration removal verified by `bun run typecheck` followed by `bun run lint`.

Context Files:
- `src/config/config-guards.ts`
- `src/config/loader.ts`
- `src/config/schemas-execution.ts`
- `src/config/runtime-types.ts`
- `src/cli/config-descriptions.ts`

Creates:
- `test/unit/config/removed-no-op-keys.test.ts`

**US-002 — Delete the `nax interact` CLI surface and the unreachable status branch**
Complexity: simple. Dependencies: none.
Deletes `src/cli/interact.ts`, `src/cli/constitution.ts`, their `src/cli/index.ts` barrel re-exports, and the unreachable pending-interactions block in `src/cli/status-features.ts`.
Verification note: deletion verified by `bun run typecheck` followed by `bun run lint`.

Context Files:
- `src/cli/index.ts`
- `src/cli/status-features.ts`
- `src/cli/interact.ts`
- `src/cli/constitution.ts`

**US-003 — Delete the orphaned interaction state layer**
Complexity: simple. Dependencies: US-002.
Terminal cleanup. Deletes `src/interaction/state.ts` in full and its re-exports from `src/interaction/index.ts`. Every consumer is removed by US-002, so this story adds no code. Carries one regression guard proving the in-process interaction path is unaffected.
Verification note: deletion verified by `bun run typecheck` followed by `bun run lint`; both reject any dangling reference to the removed symbols.

Context Files:
- `src/interaction/index.ts`
- `src/interaction/state.ts`
- `src/interaction/chain.ts`

### Seams

US-001 introduces one new externally-visible symbol, `stripRemovedNoOpKeys`, exported from `src/config/config-guards.ts` and consumed by `src/config/loader.ts` at two call sites.

Warn-**count** assertions are made by calling the function directly with an injected sink (AC-1 through AC-6), following the established pattern in `loader-legacy-shim.test.ts:27` and `deprecation-routing-retry.test.ts:7`. `loadConfig` accepts no warn sink, so warn counting is not asserted at that altitude.

Consumer wiring is pinned by **stripping outcomes** observed at the outermost entry points: AC-7 through AC-9 trigger `loadConfig` (root site, `loader.ts:353-361`) and AC-10 triggers `loadConfigForWorkdir` (per-package overlay site, `loader.ts:486-489`). Both sites are pinned because wiring only the root one is the obvious half-fix and no single-site AC could detect it.

The wiring carries no once-per-transition or dedup logic — the guard runs unconditionally at each site on a distinct config object — so no re-trigger AC is required.

### Modifies

**US-001**

- `test/unit/config/escalate-on-exhaustion.test.ts` — the whole file (106 lines) exists to assert `escalateOnExhaustion` is defined on `RectificationConfig`, defaults to `true`, is overridable to `false`, and has a `FIELD_DESCRIPTIONS` entry. Every assertion pins the removed field. Delete the file; the invariant that replaces it is AC-7 and AC-11 below — the key is stripped on load and is absent from the parsed defaults.
- `test/unit/config/merge.test.ts` — the `test.each` table at line 290 has a `"generateTests"` row asserting per-package override of `acceptance.generateTests`. Delete that row only; the surviving `"enabled"` and `"testPath"` rows preserve the real invariant, that per-package acceptance overrides still apply.
- `test/unit/execution/rectification.test.ts` — two `RectificationConfig` object literals (lines 21 and 93) set `escalateOnExhaustion: true`. Remove the property from both; the surrounding rectification assertions are unaffected and must continue to pass.
- `test/unit/config/debate-schema.test.ts` — its shared `NaxConfig` fixture sets `escalateOnExhaustion` under `execution.rectification` and both `autoVerifyIsolation` and `autoApproveVerifier` under `tdd`. Remove those three properties; every debate-schema assertion is unrelated to them and must continue to pass.
- `test/unit/config/sessiontiers-defaults.test.ts` — calls `TddConfigSchema.parse({...})` with `autoVerifyIsolation` and `autoApproveVerifier` supplied. Remove both from the parse inputs; the session-tier default assertions the file actually makes must continue to pass.
- `test/unit/config/smart-runner-flag.test.ts` — its config fixture supplies `autoVerifyIsolation`, `autoApproveVerifier` and `acceptance.generateTests`. Remove all three; the smart-runner flag assertions are unrelated and must continue to pass.
- `test/unit/verification/smart-runner-config.test.ts` — same three keys in its config fixture. Remove them; the smart-runner config resolution assertions must continue to pass.
- `test/unit/precheck/precheck-story-size-gate.test.ts` — its `NaxConfig` fixture supplies `autoVerifyIsolation`, `autoApproveVerifier` and `acceptance.generateTests`. Remove all three; the story-size-gate threshold assertions must continue to pass.
- `test/unit/precheck/precheck-run-story-size-gate-routing.test.ts` — same three keys in its fixture. Remove them; the gate-routing assertions must continue to pass.
- `test/integration/pipeline/pipeline-acceptance.test.ts` — its config fixture sets `acceptance.generateTests`. Remove it; acceptance-pipeline behaviour is governed by `acceptance.enabled`, which the file's assertions already exercise and which must continue to pass.
- `test/integration/pipeline/pipeline-events.test.ts` — its config fixture supplies `autoVerifyIsolation`, `autoApproveVerifier` and `acceptance.generateTests`. Remove all three; the pipeline event-ordering assertions must continue to pass.
- `test/integration/routing/routing-stage-final-state.test.ts` — same three keys in its fixture. Remove them; the routing final-state assertions must continue to pass.
- `test/integration/routing/routing-stage-greenfield.test.ts` — same three keys in its fixture. Remove them; the greenfield routing assertions must continue to pass.
- `test/integration/prompts/pb-004-migration.test.ts` — same three keys in its fixture. Remove them; the prompt-builder migration assertions must continue to pass.

Each of the eleven fixtures above carries the keys only because the fields are currently **required** on the runtime types. Once the fields leave `runtime-types.ts`, a typed literal becomes an excess-property error and a `Schema.parse({...})` input becomes a silently-stripped key — either way the fixture must be updated, and no assertion in any of these files depends on the removed keys.

## Acceptance Criteria

### US-001 — Remove four no-op config keys behind a warn-and-strip guard

1. `[unit]` Calling `stripRemovedNoOpKeys` with a configuration object setting all four of `execution.rectification.escalateOnExhaustion`, `tdd.autoVerifyIsolation`, `tdd.autoApproveVerifier` and `acceptance.generateTests`, and an injected warn sink, invokes that sink exactly four times, with each key's dotted path appearing in exactly one message.
2. `[unit]` Calling `stripRemovedNoOpKeys` with a configuration object setting `tdd.autoVerifyIsolation` returns a value whose `tdd` section has no `autoVerifyIsolation` property, and the input object it was given still has that property — confirming the function does not mutate its argument.
3. `[unit]` Calling `stripRemovedNoOpKeys` with a configuration setting none of the four removed keys invokes the injected warn sink zero times and returns a value deeply equal to its input.
4. `[unit]` Calling `stripRemovedNoOpKeys` with a configuration setting both `tdd.autoVerifyIsolation` and `tdd.maxRetries` returns a configuration whose `tdd.maxRetries` retains its original value, and likewise preserves `acceptance.enabled` and `execution.rectification.abortOnNoProgress` when their removed siblings are stripped.
5. `[unit]` Calling `stripRemovedNoOpKeys` with a configuration whose `tdd` property is absent invokes the injected warn sink zero times, returns without throwing, and leaves the configuration unchanged; calling it with `tdd` set to the number `42` likewise warns zero times, does not throw, and returns `tdd` still equal to `42`.
6. `[unit]` Calling `stripRemovedNoOpKeys` with `tdd.autoVerifyIsolation` set to the string `"yes"` strips the property and invokes the injected warn sink once with a message containing `tdd.autoVerifyIsolation`, demonstrating the guard keys on path presence rather than value type.
7. `[integration]` Given a project config file at `.nax/config.json` setting `tdd.autoVerifyIsolation` to `false`, `loadConfig` resolves successfully and the returned configuration's `tdd` section has no `autoVerifyIsolation` property.
8. `[integration]` Given a global config file setting `acceptance.generateTests` to `false` and no project config file, `loadConfig` resolves successfully and the returned configuration's `acceptance` section has no `generateTests` property.
9. `[integration]` Given `execution.rectification.escalateOnExhaustion` set in both the global and the project config file, `loadConfig` resolves successfully and the returned configuration's `execution.rectification` section has no `escalateOnExhaustion` property.
10. `[integration]` Given a per-package overlay config setting `tdd.autoApproveVerifier`, `loadConfigForWorkdir` resolves successfully for that package and the returned configuration's `tdd` section has no `autoApproveVerifier` property.
11. `[unit]` Parsing an empty object with `NaxConfigSchema` yields a configuration whose `execution.rectification` has no `escalateOnExhaustion` property, whose `tdd` has neither `autoVerifyIsolation` nor `autoApproveVerifier`, and whose `acceptance` has no `generateTests` property.
12. `[unit]` Looking up each of `execution.rectification.escalateOnExhaustion`, `tdd.autoVerifyIsolation`, `tdd.autoApproveVerifier` and `acceptance.generateTests` in `FIELD_DESCRIPTIONS` returns `undefined` for all four, while a control lookup of `acceptance.enabled` returns a non-empty string.

### US-002 — Delete the `nax interact` CLI surface and the unreachable status branch

1. `[integration]` Given a feature directory containing an `interactions` subdirectory holding one well-formed pending interaction request file, running the `nax status` feature display for that feature produces output containing no occurrence of the text `Waiting for Interaction`.
2. `[integration]` For that same feature directory, the `nax status` feature display still prints the feature name from the PRD and its story listing, confirming the removal did not disturb the surrounding status output.

### US-003 — Delete the orphaned interaction state layer

1. `[integration]` An `InteractionChain` configured with `AutoInteractionPlugin`, calling the primary plugin's `decide()` directly with a `human-review` interaction request (the production path — `AutoInteractionPlugin.receive()` unconditionally throws and is not invoked), returns a response whose `requestId` matches the submitted request, confirming the interaction subsystem still functions after the disk-persistence layer is removed.

<!-- spec-writing: completed-through-phase-6 -->
