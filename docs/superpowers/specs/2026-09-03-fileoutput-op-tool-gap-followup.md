# `fileOutput`/disk-write ops still undeclared on native — follow-up to #1811/#1812

## Summary

#1811 and #1812 declared `tools:` on every op whose *session role* is in
`check-op-tool-capability.ts`'s `REQUIRED_TOOLS_BY_ROLE` table (the "commit rectification" class
of op). That gate is role-scoped, and it does not — and by its own design comment cannot,
without widening the table — see a second, distinct class of op: ones that don't have a
write-capable role, but whose **prompt instructs the agent to write its own output file to disk**
(`fileOutput` on the op, or a `verify()` hook that falls back to reading a file the agent was
told to create). `resolveDeclaredTools` still applies here: no `tools:` field ⇒
`DEFAULT_CODING_TOOLS` ⇒ `Read, Glob, Grep` only ⇒ on the native transport the agent is asked to
write a file and has no tool that can do it.

Found by auditing every op with no `tools:` field (`bun -e` walk of the `src/operations` barrel,
cross-referenced against each op's own `build`/`hopBody`/`verify` for a `fileOutput` field or a
disk-consulting `verify`), then reading the actual prompt text sent for each candidate.

## The 4 ops

| Op | Role | Mechanism | File |
| --- | --- | --- | --- |
| `plan-interactive` | `plan` | `fileOutput: (input) => input.outputPath` | `src/operations/plan.ts` |
| `plan-refine` | `plan-refine` | `fileOutput: (input) => input.outputPath` | `src/operations/plan-refine.ts` |
| `debate-plan` | `debate-plan` | `fileOutput: (input) => input.outputPath` | `src/operations/debate-plan.ts` |
| `acceptance-generate` | `acceptance-gen` | no `fileOutput`; `verify()` falls back to `ctx.readFile(input.targetTestFilePath)` when the reply has no inline test code | `src/operations/acceptance-generate.ts` |

None of `plan`, `plan-refine`, `debate-plan`, `acceptance-gen` appear in `REQUIRED_TOOLS_BY_ROLE`
— so `check-op-tool-capability` is structurally blind to all four, not merely grandfathering
them. Widening the table (not just declaring `tools:` on the 4 ops) is needed to make this gate
catch a fifth op in the same class later.

## Per-op prompt evidence

### `plan-interactive` (`plan.ts` → `PlanPromptBuilder.build()`, `plan-builder.ts:304`)

The proposal prompt's `outputDirective`, only emitted when `outputFilePath` is passed (always
true for this op — `plan.ts` always sets `input.outputPath`):

> "Write the PRD JSON directly to this file path: `${outputFilePath}`
> Do NOT output the JSON to the conversation. Write the file, then reply with a brief
> confirmation."

Repair-turn prompts on the same op (`jsonRepair`, `schemaRepair`, `citationRepair`, all in
`plan-builder.ts`) repeat the same "write to disk" instruction. Nothing in the prompt asks the
agent to run a command or commit — `codebaseContext` is handed to the agent as inline text
(`## Codebase Context\n\n${codebaseContext}`), so the prompt doesn't require the agent to Read the
repo itself to succeed, though `Read`/`Glob`/`Grep` are harmless to keep as the baseline.

**Needs: `Write`.** No `Edit`, `RunCommand`, or `GitCommit` evidence in any of this op's prompts.

### `plan-refine` (`plan-refine.ts` → `PlanPromptBuilder.build()` for turn 1,
`buildRefineContinuation()` for turn 2, `buildSpecDriftRepair()`/`buildOutOfScopeRepair()` for the
conditional self-heal turns)

Turn 1 is the same `build()` prompt as `plan-interactive` — same "write to this file path"
instruction. Turn 2 (`buildRefineContinuation`, `plan-builder.ts:193`), the adversarial audit
pass:

> "Write the revised PRD to this file path: `${outputFilePath}`
> Do not output the PRD in chat. After writing the file, reply with a brief text confirmation
> only."

The self-heal repair turns (`buildSpecDriftRepair`, `buildOutOfScopeRepair`) end with the
identical `Write the corrected PRD to this file path: ${outputFilePath}` directive. All four turns
of this op funnel through the same disk-write contract.

**Needs: `Write`.** Same absence of `Edit`/`RunCommand`/`GitCommit` evidence as `plan-interactive`.

### `debate-plan` (`runner-plan-helpers.ts:84-113` → wraps `DebatePromptBuilder`'s
`buildProposalPrompt`/`buildRebuttalPrompt`/patch prompt with `appendFileOutputInstruction`)

Every prompt this op sends — proposal, rebuttal, and the winner's patch turn — is built by
`DebatePromptBuilder` and then has this appended (`runner-plan-helpers.ts:85-86`):

> "Write the complete PRD JSON to this file path and then reply with a short confirmation:
> `${outputPath}`"

`callOp`'s `fileOutput` then reads that path back after every send (`debate-plan.ts:38`), exactly
mirroring `plan-interactive`/`plan-refine`'s mechanism — this is a debater proposing/patching a
PRD via the same file-based contract as the two ops above, just running N-in-parallel as debate
participants.

**Needs: `Write`.** Same shape as the two plan ops — no run/commit instruction anywhere in the
proposal, rebuttal, or patch prompt text.

### `acceptance-generate` (`acceptance-generate.ts` → `AcceptancePromptBuilder.buildGeneratorFromPRDPrompt()`, `acceptance-builder.ts:134`)

> "**File output (REQUIRED)**: Write the acceptance test file DIRECTLY to the path shown below.
> Do NOT output the test code in your response. After writing the file, reply with a brief
> confirmation."
> "**Path anchor (CRITICAL — do NOT deviate)**: Write the test file to this exact path:
> `${targetTestFilePath}`. …"

Step 2 of the same prompt ("Explore the Project") asks the agent to check dependency manifests
and read 1-2 existing test files first — real `Read`/`Glob`/`Grep` use, already covered by the
default. The "Process cwd" bullet about spawning child processes describes how the **generated
test file's own code** should invoke a CLI (design guidance for the test content) — it is not an
instruction for the *authoring* agent to run a command itself, so it is not `RunCommand` evidence
for this op.

The op's own `verify()` doc comment confirms the mechanism independently of the prompt text: "ACP
agents write the test file as a tool-call side effect and return a conversational summary. Check
whether the agent wrote a valid file." — i.e. the op's whole verify-fallback design presumes
`Write` capability exists.

**Needs: `Write`.** `Edit` is defensible too (the self-heal `buildPathCorrection` re-prompt asks
the agent to fix a misplaced file, which could be an edit-in-place on a retry rather than a fresh
write) but nothing in the prompt explicitly asks for in-place editing of an *existing* file — it
reads more like "write it again at the right path." No `RunCommand`/`GitCommit` evidence.

## Proposed tool declarations (not applied yet — recording only, per user request)

| Op | Proposed `tools:` |
| --- | --- |
| `plan-interactive` | `Read, Glob, Grep, Write` |
| `plan-refine` | `Read, Glob, Grep, Write` |
| `debate-plan` | `Read, Glob, Grep, Write` |
| `acceptance-generate` | `Read, Glob, Grep, Write` |

## Also needed: widen `REQUIRED_TOOLS_BY_ROLE`

To make `check-op-tool-capability` actually gate this class going forward, add these 4 roles with
`["Write"]` as their minimum:

```ts
plan: ["Write"],
"plan-refine": ["Write"],
"debate-plan": ["Write"],
"acceptance-gen": ["Write"],
```

Without this, declaring `tools:` on the 4 ops above drains today's violation but leaves the gate
unable to catch a future `fileOutput`-shaped op that forgets the declaration — exactly the
blind spot this document exists to close.

## Ops checked and ruled OUT (confirmed legitimately read-only, no gap)

Every other op with no `tools:` field was checked for a `fileOutput` field or a disk-consulting
`verify()`/`hopBody` reading agent-written content; none had either — each parses its full answer
straight from the reply text:

- `acceptance-diagnose` (`diagnose`) — diagnosis text only.
- `plan-draft` (`plan-draft`) — parses `PRD` JSON directly from the reply (`inspectDraftOutput` →
  `parseLLMJson(output)`), no disk involvement.
- `plan-critic-llm` (`plan-critic`), `finish-narrative` (`finish-narrative`), `ground`
  (`grounder`), `debate-hybrid` (`debate-hybrid`), `debate-stateful` (`debate-stateful`) — text/JSON
  parsed from the reply.
- `finish-review` (`finish-review-spec`) — its `verify()` does read disk (`auditGaps`), but only to
  cross-check the *review report's own claims* against `git diff`, not to recover agent-written
  output; the report itself is parsed entirely from the reply text.
- `setup-generate` (`setup`) — parses a config JSON from the reply; the CLI caller (`nax setup`)
  writes the resulting file to disk itself, not the agent.

## Status

Analysis only, per user request ("record these ops... dig deeper what tools they need... record
into the markdown file"). No code changes made in this pass — `tools:` declarations and the
`REQUIRED_TOOLS_BY_ROLE` widening above are proposed, not applied.
