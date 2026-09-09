# SPEC: Prompt-Affordance SSOT (protocol regions generalised)

<!-- spec-writing: completed-through-phase-6 -->

Issue: nathapp-io/nax#1906

## Summary

A prompt section cannot know which transport will receive it, nor which coding tools that
transport was actually handed, yet several sections name a *way to do something* — a shell
command, or a `RunCommand` tool call. Today each section resolves that alone: two sites hedge
("if that tool is available to you, otherwise `<shell>`"), three name only a shell string, and
one — diff access — solved it properly with a nonce-guarded delimited region substituted at
dispatch. This feature generalises the diff-access region into a single affordance registry
that every such section renders through, gated on the **coding tools actually advertised for
the dispatch**, not on the protocol alone.

## Motivation

`src/prompts/sections/diff-access.ts` already carries the whole mechanism: a per-process
nonce, an `OPEN`/`CLOSE` delimited region whose body IS the ACP text, and `applyDiffAccess`
swapping in a native rendering at dispatch. Only two things in it are diff-access-specific —
the literal `nax:diff-access` in the marker constants, and the `renderNative` callback.

Everything else that names an affordance is hand-written, and the failure it produces is
observed, not hypothetical. On the native fixture run for #1905 the self-verification gate
rendered ``- typecheck: run `bun x tsc --noEmit` ``; the model called
`RunCommand {"command":"typecheck"}`, hit a real error, then reached for the *second route to
the same check* the prompt had supplied — `Exec {"argv":["bun","x","tsc","--noEmit"]}` — which
the argv allowlist correctly denied (`BUILT_IN_EXEC_PATTERNS`, `src/config/permissions.ts:112-128`,
admits install forms only). It abandoned the fix and committed a story whose typecheck still failed.

Three further facts, each verified in the tree, shape the design:

1. **Protocol is not a sufficient key.** `native` does not imply `RunCommand` or `GitCommit`
   exist. `buildCodingToolSupport` (`src/agents/coding-tool-support.ts:56-127`) returns
   `undefined` when grants are empty, and constructs `RunCommand` only when
   `declaredCommands.size > 0 || allowExec`. `GitCommit` is declared by `implement`, `rectify`,
   `write-test` and the `autofix-*` ops, but **not** by `finish-fix.ts:38`,
   `full-suite-rectify-op.ts:39` or `acceptance-fix.ts:34`. Any permission profile other than
   `unrestricted` grants only `DEFAULT_CODING_TOOLS = ["Read","Glob","Grep"]`
   (`src/config/permissions.ts:97,180`). Rendering a tool call keyed on protocol alone would
   instruct a model toward a tool it was never advertised — the mirror-image of the bug being fixed.
2. **The hedge is spreading.** `src/prompts/builders/acceptance-builder.ts:136-166` landed the
   same "name both" wording in #1939, explicitly citing `self-verification.ts:33` as "the
   register". Two hand-written registers is a convention; a helper is an SSOT.
3. **Substitution happens once, on the initial prompt only.** `build-hop-callback.ts:296` and
   `session-run-hop.ts:24` are the two substitution sites, but follow-up turns inside a
   `hopBody` — and the parse-retry loop at `src/operations/call.ts:352` — dispatch through the
   bound `send` closure (`build-hop-callback.ts:419-450`), which substitutes nothing. The
   "no marker survives dispatch" property cannot hold on those turns unless the seam moves
   into `send`.

## Design

A single module owns marker syntax, the nonce, the substitution pass, and one registry entry
per affordance. Sections call `wrapAffordance(kind, spec, acpBody)`; dispatch calls
`applyProtocolRegions(prompt, { protocol, advertisedTools })`; anything that persists a prompt
to disk calls `unwrapProtocolRegions(text)`.

Registry shape (one entry per affordance kind):

| kind | `requires` | native rendering |
|:---|:---|:---|
| `diff-access` | `Git`, `Read` | today's `renderNative` from `diff-access.ts` |
| `run-check` | `RunCommand` | `RunCommand {"command": "<label>"}` for a declared check key |
| `run-test` | `RunCommand` | `RunCommand {"command": "<scopedKey>", "values": {"files": "<path>"}}` |
| `commit` | `GitCommit` | `GitCommit {"message": "<msg>"}` |

Gating rule: the native rendering is emitted only when **every** name in `requires` is present
in `advertisedTools`. Otherwise the ACP body is kept. Degradation is therefore monotone —
every failure path (unknown kind, unparseable spec, foreign nonce, missing tool, unterminated
region) yields the text that shipped before this feature existed.

### Integration

Read-only, verified:

- `src/agents/coding-tool-support.ts:159` — `resolveCodingToolSupport(options)` returns
  `{ runtime, tools, auditSink } | undefined`; `tools` is `readonly CodingTool[]`, each with a
  `name`. It depends only on `options`, so it can be resolved before the prompt is substituted
  in both hops.
- `src/tools/registry.ts:69-81` — `RESERVED_TOOL_NAMES` is the closed set of built-in names the
  registry entries' `requires` values are drawn from.
- `src/prompts/builders/acceptance-builder.ts:136-166` — `buildTestRerunLine`, the second
  hand-written register, and the correct `values.files` shape for a scoped test call.
- `src/prompts/loader.ts:38` + `src/prompts/builders/tdd-builder.ts:365-372` — an override file
  named by `prompts.overrides.<role>` replaces the role-task section wholesale, so persisted
  template text is loaded in a **later process** than the one that wrote it.
- `src/operations/verify.ts:203` — `verify` declares `["Read","Glob","Grep","Git","RunCommand"]`
  and no `Exec`: the concrete op where a shell-only test instruction is unusable on native today.

Changed symbols — target shapes (the baseline exists only to locate the code; implement the target):

- `src/prompts/sections/diff-access.ts`
  - Baseline: `applyDiffAccess(prompt: string, protocol: PromptProtocol): string`
  - Target: `applyDiffAccess(prompt: string, protocol: PromptProtocol, advertisedTools?: readonly string[]): string`,
    delegating to `applyProtocolRegions`. `undefined` means "tool set unknown — do not gate",
    preserving today's behaviour for callers that cannot know it.
  - `wrapDiffAccess(spec, shellBody)` keeps its signature and delegates to `wrapAffordance("diff-access", …)`.
    `DiffAccessSpec` and `PromptProtocol` keep their shapes; `DIFF_ACCESS_MARKER_PREFIX` remains exported.
- `src/agents/tool-preamble.ts`
  - Baseline: `applyDiffAccessForAgentProtocol(agentName: string, prompt: string): string`
  - Target: `applyDiffAccessForAgentProtocol(agentName: string, prompt: string, advertisedTools: readonly string[]): string`
    — third parameter **required**, so a future third dispatch site cannot silently ungate.
- `src/operations/build-hop-callback.ts` — `resolveCodingToolSupport` resolves **before** the
  substitution call (today `:301` then `:296`), and the bound `send` closure substitutes each
  turn prompt it is handed. The hop's returned `prompt` stays the substituted initial prompt.
- `src/runtime/session-run-hop.ts` — `resolveCodingToolSupport(options)` hoisted above the
  substitution at `:24`; it reads only `options` and no session handle.
- `src/cli/prompts-init.ts:84` — the body written to `.nax/templates/*.md` passes through
  `unwrapProtocolRegions`.

### Approach

Delimited regions with a per-process nonce, not placeholder tokens, and not a builder-time
protocol branch. The rationale is unchanged from `diff-access.ts`'s header and is inherited
wholesale: the builder cannot know the protocol (resolved after the prompt string exists, and
a fallback swap can change it again); a placeholder degrades to a prompt with *no* instructions,
while a region degrades to the pre-change text; and a prompt is not all trusted text — findings
from earlier iterations and embedded diffs are spliced into the same string, so a marker that
content could forge would let it capture the genuine region.

One nonce and one marker grammar for all kinds, with `kind` inside the marker. A single
`PROTOCOL_REGION_MARKER_PREFIX` then makes "no marker survives dispatch" checkable in one place.

### Failure Handling

| Condition | Behaviour |
|:---|:---|
| Region's spec JSON does not parse | keep the ACP body |
| Marker names an affordance kind with no registry entry | keep the ACP body |
| Marker carries a nonce from another process (persisted template, echoed content) | leave the text untouched |
| `protocol` is native but a `requires` tool is absent from `advertisedTools` | keep the ACP body |
| `advertisedTools` is `undefined` (unknown) | do not gate; render by protocol alone |
| Region opened but never closed | leave the text untouched (never truncate the prompt) |

## Out of Scope

- Deleting or renaming `wrapDiffAccess`, `applyDiffAccess`, `DiffAccessSpec` or
  `DIFF_ACCESS_MARKER_PREFIX`: the diff-access API is retained as a thin adapter over the new
  helper so its existing suites remain the regression evidence for this change.
- Changing any ACP-arm prompt text. Every ACP rendering must stay byte-for-byte what ships
  today; the ACP byte-parity suite is the gate.
- Native renderings for prompt text that names no affordance (framework hints, install-command
  prose such as `rectifier-builder.ts:460`, review checklists).
- User-authored override templates under `.nax/templates/`: a template a user has edited is
  literal text and receives no native rendering. Only the templates nax itself writes are
  covered, and only to the extent that they must contain no markers.
- Widening `BUILT_IN_EXEC_PATTERNS`, or any change to what the `Exec` argv branch admits.
- Adding new coding tools, or changing which ops declare which tools in `src/operations/*.ts`.
- Scoped tool grants (`#374`) and the pathspec interaction noted in `diff-access.ts`'s
  `renderNative` warning.
- The third hand-written register, `src/operations/lint-check.ts:156` and
  `src/operations/typecheck-check.ts:170`, which carry the same hedge inside a `Finding.message`.
  Findings are persisted to the review-audit artifacts and re-read by a later process, where a
  per-process nonce cannot match, so a region there would never render natively. Covering them
  needs a marker whose lifetime outlives the process, which this spec does not design.
- Their existing gate stays as-is: those two sites already withhold the `RunCommand` key when the
  command was auto-detected rather than declared (`typecheck-check.ts:161-170`).
- The dead `src/session/session-keeper.ts` dispatch path (no production constructor found); it
  is not wired into the substitution seam by this spec.

## Stories

**US-001 — Protocol-region helper module** *(no dependencies)*

Create the affordance SSOT: marker grammar, per-process nonce, registry with `requires` gating,
and the three entry points. Ships with the `diff-access` registry entry only; later stories add
entries.

- Creates: `src/prompts/sections/protocol-region.ts`, `test/unit/prompts/protocol-region.test.ts`

**US-002 — Diff access on the helper, gated on advertised tools** *(depends on US-001)*

Re-express diff access through the helper, thread the advertised tool names into both dispatch
hops, and move substitution into the bound `send` closure so follow-up turns are covered.

**US-003 — Static-check affordance** *(depends on US-002)*

Move the two hand-written registers onto the `run-check` and `run-test` entries so neither
carries the "if that tool is available to you" hedge.

**US-004 — Scoped-test affordance** *(depends on US-002)*

Move the test-command instructions onto the `run-test` entry: the isolation section's example
and the rectifier's per-file and full-suite command blocks.

**US-005 — Commit affordance and template persistence** *(depends on US-002)*

Move the six `git commit -m` instructions onto the `commit` entry, and unwrap regions when
`nax prompts init` persists a section to disk — a marker written in one process carries a
nonce no later process can match.

### Context Files

**US-001**

- `src/prompts/sections/diff-access.ts` — the region mechanism being generalised; its markers, nonce and `renderNative` move behind the registry.
- `src/tools/registry.ts` — `RESERVED_TOOL_NAMES`, the closed set each registry entry's `requires` names are drawn from.
- `src/prompts/sections/index.ts` — the sections barrel the new module is exported from.

**US-002**

- `src/agents/coding-tool-support.ts` — `resolveCodingToolSupport` returns the advertised `tools`; it reads only `options`, so it can resolve before substitution.
- `src/operations/call.ts` — the parse-retry loop that dispatches follow-up prompts through the bound `send` closure.

**US-003**

- `src/prompts/sections/self-verification.ts` — the first hand-written register.
- `src/prompts/builders/acceptance-builder.ts` — `buildTestRerunLine`, the second register and the correct scoped `values.files` shape.
- `src/quality/self-verification.ts` — `SelfVerificationPromptInput`, the source of the configured lint/typecheck command strings.

**US-004**

- `src/prompts/sections/isolation.ts` — the scoped-test example rendered for every code-touching role.
- `src/prompts/builders/rectifier-builder.ts` — the per-failing-file and full-suite command blocks.
- `src/prompts/builders/rectifier-builder-helpers.ts` — the no-test isolation path that must stay unchanged.

**US-005**

- `src/prompts/sections/role-task.ts` — the six commit instructions.
- `src/cli/prompts-init.ts` — writes section bodies to `.nax/templates/` in one process.
- `src/prompts/loader.ts` — reads those template files back in a later process, where the nonce cannot match.

### Modifies

**US-002**

- `src/prompts/sections/diff-access.ts` — `applyDiffAccess` gains a third `advertisedTools` parameter and delegates to `applyProtocolRegions`; the invariant that replaces the old one is that native rendering additionally requires `Git` and `Read` to be advertised.
- `src/agents/tool-preamble.ts` — `applyDiffAccessForAgentProtocol` takes a required third parameter; every dispatch site passes the advertised names.
- `src/operations/build-hop-callback.ts` — coding-tool support resolves before substitution, and the bound `send` closure substitutes each turn prompt it is handed.
- `src/runtime/session-run-hop.ts` — coding-tool support resolves before the prompt is substituted.
- `test/unit/agents/tool-preamble.test.ts` — its calls pin the two-argument `applyDiffAccessForAgentProtocol`; the invariant that replaces it is that the advertised tool list is a required argument.
- `test/unit/operations/build-hop-callback-diff-access.test.ts` — asserts native rendering from protocol alone; the invariant that replaces it is native rendering only when `Git` and `Read` are advertised.
- `test/unit/runtime/session-run-hop.test.ts` — carries the same protocol-only assumption on the second hop; same replacement invariant.

**US-003**

- `test/unit/prompts/sections/self-verification.test.ts` — asserts the hedge wording in the rendered check lines; the invariant that replaces it is that the section renders one region whose body is the shell string.
- `test/unit/prompts/acceptance-builder.test.ts` — asserts the hedge wording in the test-rerun line at lines 241 and 316; the invariant that replaces it is that the line renders one region whose body is the shell string.

**US-004**

- `test/unit/prompts/__snapshots__/rectifier-builder.test.ts.snap` — a snapshot (closed-world) covering both the `# TEST COMMAND` block and the isolation section's full-suite warning line; the invariant that replaces it is the same prompt text with each command carried inside a region, so the snapshot is re-recorded.
- `test/unit/prompts/rectifier-builder.test.ts` — asserts the `# TEST COMMAND` block as literal text; the invariant that replaces it is that the block is a region whose body is that literal text.

**US-005**

- `test/unit/prompts/sections/role-task.test.ts` — asserts the literal `git commit -m` lines; the invariant that replaces it is that each is a region whose body is that line.
- `test/unit/prompts/builder.test.ts` — asserts a composed prompt carries the literal `git commit -m` instruction; same replacement invariant.
- `test/unit/cli/prompts-init.test.ts` — asserts the content written for each template; the invariant that replaces it is that a written template carries the ACP body and no region marker.

### Seams

- **US-001 → US-002:** `wrapAffordance` and `applyProtocolRegions` are invoked by the
  diff-access adapter on the real dispatch path. Pinned by US-002's AC that dispatching through
  the hop callback renders the native diff section, and by its AC that no marker survives.
- **US-001 → US-005:** `unwrapProtocolRegions` is invoked by `promptsInitCommand`. Pinned by
  US-005's AC that a written template file carries no marker and keeps the shell body.
- **US-002 → US-003/US-004/US-005:** each later story's section emits a region; its rendering is
  proven end-to-end by dispatching that section's prompt through `applyDiffAccessForAgentProtocol`
  with, and without, the required tool advertised.

## Acceptance Criteria

### US-001 — Protocol-region helper module

1. `[unit]` `wrapAffordance` is importable from the prompt-sections module and returns a string
   that contains the supplied ACP body verbatim, unmodified, between its opening and closing markers.
2. `[unit]` Calling `applyProtocolRegions` on a wrapped body with protocol `acp` returns exactly
   the ACP body: no marker text, and the surrounding prompt characters unchanged.
3. `[unit]` Calling `applyProtocolRegions` on a `diff-access` region with protocol `native` and
   an advertised-tool list containing `Git` and `Read` returns the native rendering, which names
   the baseline ref from the spec and contains no shell command.
4. `[unit]` Calling `applyProtocolRegions` on a `diff-access` region with protocol `native` and
   an advertised-tool list that omits `Git` returns the ACP body unchanged.
5. `[unit]` Calling `applyProtocolRegions` with protocol `native` and an advertised-tool list of
   `undefined` returns the native rendering — an unknown tool set does not gate.
6. `[unit]` A region whose opening marker carries spec text that is not valid JSON returns the
   ACP body when applied with protocol `native`.
7. `[unit]` A region whose opening marker names an affordance kind with no registry entry
   returns the ACP body when applied with protocol `native`.
8. `[unit]` A marker built with a different nonce value than the running process's is left
   byte-for-byte untouched by `applyProtocolRegions` under both protocols.
9. `[unit]` A prompt containing an opening marker with no matching close is returned unchanged
   by `applyProtocolRegions`, with no characters removed.
10. `[unit]` A prompt carrying two regions of different kinds has both substituted in one
    `applyProtocolRegions` call.
11. `[unit]` Given a prompt where untrusted content preceding a genuine region contains a forged
    opening marker with a wrong nonce, applying with protocol `native` renders the genuine
    region's spec (its baseline ref), and the text between the forged marker and the genuine
    marker is still present in the result.
12. `[unit]` `unwrapProtocolRegions(text)` returns a string equal to `text` with each region
    replaced by its exact ACP body, preserving all text outside regions, and containing no
    substring equal to the exported marker prefix.
13. `[unit]` `applyProtocolRegions` applied twice to the same prompt returns the same string as
    applying it once (substitution is idempotent).

### US-002 — Diff access on the helper, gated on advertised tools

1. `[unit]` `wrapDiffAccess` keeps its existing two-argument call shape and its result, applied
   with protocol `acp`, yields the ACP body — the diff-access suite's existing expectations hold
   against the helper-backed implementation.
2. `[unit]` `applyDiffAccess` accepts an advertised-tool list as its third argument and returns
   the ACP body when protocol is `native` and `Git` is absent from that list.
3. `[unit]` `applyDiffAccessForAgentProtocol`, called with the native agent name and an
   advertised-tool list containing `Git` and `Read`, returns the native rendering; called with
   the same prompt and an empty list, it returns the ACP body.
4. `[integration]` Dispatching through the hop callback built by `buildHopCallback` with the
   native agent and a configuration whose resolved grants advertise `Git` and `Read` sends the
   agent a prompt whose diff-access section is the native rendering.
5. `[integration]` Dispatching through the same hop callback with the native agent and a
   permission profile granting only `Read`, `Glob` and `Grep` sends the agent a prompt whose
   diff-access section is the shell body.
6. `[integration]` Dispatching through the hop callback with a non-native agent name sends the
   agent a prompt containing no substring equal to the exported marker prefix.
7. `[integration]` A second turn dispatched through the hop body's bound `send` closure with a
   prompt that carries a region is delivered to the agent with that region substituted and no
   marker prefix present.
8. `[integration]` The prompt value returned by the hop callback is the substituted initial
   prompt and contains no marker prefix.
9. `[integration]` Dispatching through the session run hop with the native agent and grants
   advertising `Git` and `Read` sends the native rendering; with grants advertising none of
   them it sends the shell body.

### US-003 — Static-check affordance

1. `[unit]` The self-verification section built for a role with a configured `typecheck` command
   contains no occurrence of the phrase "if that tool is available to you".
2. `[unit]` The self-verification section, applied with protocol `acp`, renders the configured
   typecheck command string and no `RunCommand` call.
3. `[unit]` The self-verification section, applied with protocol `native` and an advertised-tool
   list containing `RunCommand`, renders a `RunCommand` call whose `command` value is the
   declared key `typecheck`, and renders no shell command string.
4. `[unit]` The self-verification section, applied with protocol `native` and an advertised-tool
   list without `RunCommand`, renders the configured shell command string.
5. `[unit]` The self-verification section for a check whose command is unconfigured renders the
   existing "unconfigured" line and emits no region.
6. `[unit]` The acceptance test-rerun line, applied with protocol `native` and an advertised-tool
   list containing `RunCommand`, renders a `RunCommand` call whose `command` is the resolved
   scoped-command key and whose `values.files` equals the acceptance test path.
7. `[unit]` The acceptance test-rerun line built without a resolved scoped-command key renders
   only the raw command string under both protocols, with no `RunCommand` call.
8. `[unit]` The acceptance test-rerun line contains no occurrence of the phrase "if that tool is
   available to you".

### US-004 — Scoped-test affordance

1. `[unit]` The isolation section built with a configured test command, applied with protocol
   `acp`, renders exactly the shell example that ships today, including the surrounding
   full-suite warning sentence.
2. `[unit]` The isolation section, applied with protocol `native` and an advertised-tool list
   containing `RunCommand` for a project whose scoped test key is declared, renders a
   `RunCommand` call carrying a `values.files` field and renders no shell command.
3. `[unit]` The isolation section built for a project with no configured test command renders
   the existing "scope each run to the files you changed" wording and emits no region.
4. `[unit]` The rectifier's test-command block, applied with protocol `native` and an advertised
   `RunCommand`, renders one `RunCommand` call per failing test file, each carrying that file in
   `values.files`.
5. `[unit]` The rectifier's full-suite test-command block, applied with protocol `native` and an
   advertised `RunCommand`, names the declared `test` key, and applied with protocol `acp` names
   the same command string the verifier replays.
6. `[unit]` The rectifier's blocks, applied with protocol `native` and an advertised-tool list
   without `RunCommand`, render the shell command strings that ship today.

### US-005 — Commit affordance and template persistence

1. `[unit]` The role-task section for the implementer role, applied with protocol `acp`, renders
   the `git commit -m` instruction exactly as it ships today, including the story's commit message.
2. `[unit]` The role-task section for the implementer role, applied with protocol `native` and an
   advertised-tool list containing `GitCommit`, renders a `GitCommit` call carrying that commit
   message and renders no `git commit` shell string.
3. `[unit]` The role-task section, applied with protocol `native` and an advertised-tool list
   without `GitCommit`, renders the `git commit -m` shell string.
4. `[unit]` Every role variant of the role-task section that names a commit renders it through a
   region: applying each with protocol `acp` leaves no substring equal to the marker prefix, and
   applying each with `native` plus an advertised `GitCommit` leaves no `git commit` shell string.
5. `[integration]` Running `promptsInitCommand` against a temporary working directory writes
   template files whose content is returned unchanged by `applyProtocolRegions` under both
   protocols — no region survives persistence to disk.
6. `[integration]` The template file `promptsInitCommand` writes for the implementer role has
   content equal to the template header followed by the ACP rendering of the role-task section
   for that role, so the commit instruction it carries is the same text the ACP transport receives.

**Out of scope (US-005 only):** rendering a native affordance inside a user-supplied override
template — an override is loaded in a later process, whose nonce cannot match, and is treated as
literal text by design.

## Verification notes

- The required third parameter on `applyDiffAccessForAgentProtocol` is a compile-time contract,
  not an acceptance criterion: `bun run typecheck` rejects a two-argument call site. Asserting it
  as a test would need a `@ts-expect-error`, and `scripts/check-test-escape-hatches.ts` holds
  `tsSuppress` as a closed invariant at 0.
- Static gate for every story: `bun run lint` and `bun run typecheck`. `bun run lint` includes
  `check:file-sizes`, `check:alias-internals` and `check:import-cycles`; the new module must stay
  under the 600-line source limit.
- Scoped test runs use `timeout 30 bun test <path> --timeout=5000` per `.nax/rules/testing-commands.md`;
  `bun run test:coverage` after adding `src/prompts/sections/protocol-region.ts`.
- `test/unit/prompts/diff-access-acp-parity.test.ts` is the byte-parity gate for the
  "no ACP text moves" constraint and must pass unmodified in every story.
