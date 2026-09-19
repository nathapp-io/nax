# SPEC: Native-agent scratchpad tools

## Summary

Give nax agents a `/tmp` substitute: a fixed `.nax/scratchpad/` directory, wiped at
the start of every run, reachable through three dedicated coding tools
(`ScratchpadWrite`, `ScratchpadRead`, `ScratchpadList`) whose paths are confined to
that directory by the policy and cannot be pointed at the repository by any grant.

## Motivation

A nax agent has nowhere to put throwaway work.

Every path-bearing coding tool is contained to the permitted root, so there is no
writing to `/tmp`. The only writable surface is the repository itself, so an agent
that wants to keep a note, park a list of files to revisit, or stash a chunk of
command output writes it into the working tree — where it lands in the diff, the
commit, and the review.

Two groups feel this most sharply:

- **Long implementation turns**, which re-derive facts because there is nowhere to
  record them and re-reading is cheaper than remembering.
- **The read-only review ops.** `adversarialReviewOp` and `semanticReviewOp` declare
  `tools: ["Read", "Glob", "Grep", "Git"]` — no write surface at all. These are the
  longest analytical turns in the pipeline, and the fix cannot be "grant them
  `Write`": that hands a reviewer the ability to edit the code it is judging.

### What this is not

nax already has a subsystem with "scratch" in the name, and this is not it.
`src/session/scratch-writer.ts` appends **structured, nax-authored** entries
(`verify-result`, `tdd-session`) to a per-session `scratch.jsonl`, which the agent
reads back only through the `query_scratch` pull tool. That is nax writing *to* the
agent. This is the agent writing *for itself*, free-form, with no schema and no
promise that anything reads it. The two stay lexically distinct: `scratch` is the
existing session log, `scratchpad` is the new area.

## Design

### Approach

Containment is the load-bearing decision, and there were three candidates:

1. **The tools resolve and contain their own paths.** Rejected: `src/tools/read.ts`
   states the invariant — "The tool never resolves a path itself: it uses
   `ctx.resolvedPaths`, which the policy produced. That is what keeps containment in
   one seam." This would create a second containment implementation and hide the path
   from the policy entirely, so deny/ask rules and the audit ledger would never see it.
2. **Ordinary `pathFields` plus a `ScratchpadWrite(.nax/scratchpad/**)` grant.**
   Rejected: containment becomes *config*. A mis-set grant repoints the tools at the
   repository, which destroys the two properties the rest of this design rests on —
   that the read-only review ops and the `safe` profile can hold these tools safely.
3. **A tool-declared confinement on `ToolScope` (chosen).** The tool declares
   `confineTo`, and the policy resolves against `<root>/<confineTo>` instead of
   `<root>`. Containment stays in the one seam, the declaration is structural rather
   than configurable, and it mirrors how `allowedVerbs` already works — per
   `src/tools/registry.ts`, "a verb-gated tool must declare the verbs it permits so
   the policy can never be granted a subcommand the tool itself disallows."

### Integration

`confineTo` is a novel shape — no existing `ToolScope` field narrows the containment
root — so a worked skeleton is given below per the implementation-approach rule.

**Symbols this feature only reads** (verified signatures):

- `resolveWithin(root: string, candidate: string): string | null` — `src/tools/policy.ts:85`.
  Returns the symlink-resolved absolute path when `candidate` is inside `root`, else
  `null`. Already refuses `.git` metadata and `.nax/config.json`.
- `isInside(root: string, filePath: string): boolean` — `src/utils/realpath.ts:49`.
  Realpaths **both** sides, so a symlink inside the confined directory whose target
  resolves outside is already refused.
- `CodingTool { name, description, inputSchema, scope, routineErrors?, run(input, ctx) }` — `src/tools/registry.ts`.
- `ToolRunContext { root, resolvedPaths, maxBytes, maxFileBytes, denyPaths? }` — `src/tools/registry.ts`.
- `ToolResult { content, isError?, audit?, resultBytesPreTruncation? }` — `src/tools/registry.ts`.
- `CodingToolRuntime { advertised(declared), callTool(name, input) }` — `src/tools/runtime.ts:57`.
  `callTool` is the outermost production entry point for a tool call.
- `DEFAULT_TOOL_MAX_BYTES = 40_000`, `DEFAULT_TOOL_MAX_FILE_BYTES = 2_000_000` — `src/tools/runtime.ts:30,47`.
- `TddPromptBuilder.build(): Promise<string>` — `src/prompts/builders/tdd-builder.ts:180`.
- `buildSemanticReviewPrompt(...)` — `src/prompts/builders/review-builder.ts:140`.
- `buildAdversarialReviewPrompt(...)` — `src/prompts/builders/adversarial-review-builder.ts:361`.

**Symbols this feature changes.** The baseline is given only to locate the code; the
target is the interface to implement.

`ToolScope` — `src/tools/types.ts`

- Baseline: `interface ToolScope { pathFields; arrayPathFields?; listPathFields?; refPathFields?; verbField?; allowedVerbs?; argvField?; commandField? }`
- Target: the same, plus `readonly confineTo?: string` — a root-relative subdirectory
  the tool's `pathFields` are confined to. Tool-declared, never config-declared.

`CodingToolName` — `src/tools/types.ts`

- Baseline: union of `"Read" | "Glob" | "Grep" | "Write" | "Edit" | "Delete" | "Git" | "GitCommit" | "RunCommand" | "RequestCapability" | "Exec" | "Bash"`
- Target: the same union plus `"ScratchpadWrite" | "ScratchpadRead" | "ScratchpadList"`.

`RESERVED_TOOL_NAMES` — `src/tools/registry.ts`

- Baseline: 12 entries, ending `"Exec", "Bash"`.
- Target: 15 entries — the three scratchpad names appended.

`DEFAULT_CODING_TOOLS` — `src/config/permissions.ts:117`

- Baseline: `["Read", "Glob", "Grep"]`
- Target: `["Read", "Glob", "Grep", "ScratchpadWrite", "ScratchpadRead", "ScratchpadList"]`.
  This does not weaken `safe`: the profile promises the agent cannot modify the
  repository, and a tool confined to `.nax/scratchpad/` does not modify it.

`registerBuiltinCodingTools()` — `src/tools/runtime.ts:66`

- Baseline: registers 9 tools.
- Target: registers 12 — the three scratchpad tools added to the same list, under the
  same `getCodingTool(name) === undefined` idempotence guard.

`NAX_GITIGNORE_ENTRIES` — `src/utils/gitignore.ts:51`

- Baseline: an array ending `"**/.nax/cache/"`.
- Target: the same plus `"**/.nax/scratchpad/"`. The `**/` prefix is required, not
  cosmetic — it follows `**/.nax/cache/` (nax#2136/#2137), whose comment records the
  failure a bare entry reproduces: "generated untracked in the main checkout and
  committed inside the story worktree, so the merge back aborts on an untracked
  overwrite and strands the story branch." This one constant is read by `nax init`,
  `WorktreeManager.ensureGitExcludes()` and `scripts/check-nax-artifacts-untracked.ts`.

`buildNaxArtifactsSection(role, _variant?, _isolation?): string` — `src/prompts/sections/nax-artifacts.ts`

- Baseline: returns a section stating files under `.nax/` "must NEVER be moved,
  renamed, or deleted".
- Target: the same signature, returning a section that states the same prohibition
  **and** names `.nax/scratchpad/` as the one exception. Without this the agent holds
  two opposite instructions and the likely resolution is that it obeys the standing
  prohibition and never uses the scratchpad.

### Worked skeleton — `confineTo` in the policy

The only change to `src/tools/policy.ts` is the root passed to `resolveWithin`. The
grant-matching spelling stays repo-root-relative, so existing grant globs, deny rules
and `naxOwnedWriteRefusal` continue to see the canonical path.

```ts
// inside check(), before the pathFields loop
const effectiveRoot =
  scope.confineTo === undefined ? resolvedRoot : realOrRaw(join(resolvedRoot, scope.confineTo));

for (const field of scope.pathFields) {
  const value = pathFieldValue(input, field);
  if (value === undefined) continue;
  if (typeof value !== "string") return deny(`"${field}" must be a string path`);

  const resolved = resolveWithin(effectiveRoot, value);   // <- only this line changes
  if (resolved === null) {
    return deny(`path "${value}" ${outOfRootReason(effectiveRoot, value)}`, true);
  }

  const rel = relativeTo(resolved);   // still relative to resolvedRoot
  // ... rules, grant globs, push — unchanged
}
```

### Worked skeleton — a scratchpad tool

```ts
export const SCRATCHPAD_DIR = ".nax/scratchpad";

export const scratchpadWriteTool: CodingTool = {
  name: "ScratchpadWrite",
  description:
    "Write a throwaway file to your scratchpad at .nax/scratchpad/. Use it for notes " +
    "to yourself, command output you want to re-read, or intermediate lists. It is " +
    "never committed and is wiped at the start of each run. Paths are relative to the " +
    "scratchpad and cannot reach the repository.",
  inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
  scope: { pathFields: ["path"], confineTo: SCRATCHPAD_DIR },
  async run(input, ctx) { /* uses ctx.resolvedPaths[0], never resolves itself */ },
};
```

### Failure Handling

| Condition | Behaviour |
|:---|:---|
| Relative path escaping the scratchpad (`../../src/x.ts`) | Policy denies with `breach: true`; the reason names the path. |
| Absolute path outside the scratchpad | Policy denies with `breach: true`. |
| Symlink inside the scratchpad resolving outside it | Policy denies — `isInside` realpaths both sides. |
| `ScratchpadRead` on a file that does not exist | `isError: true` result naming the path. Never a throw. |
| `ScratchpadList` when the scratchpad does not exist | Success, reporting no entries. Not an error — the run-start wipe means an empty scratchpad is the normal state. |
| `ScratchpadWrite` content larger than `ctx.maxFileBytes` | `isError: true` result stating the limit; nothing is written. |
| `ScratchpadRead` of a file larger than `ctx.maxBytes` | Content truncated to `maxBytes`, `resultBytesPreTruncation` set to the pre-truncation size. |
| Run-start wipe fails (permissions, busy handle) | Logged at warn; `setupRun` continues. A scratch directory must never wedge a run. |

File I/O follows the project's existing Bun-native file-API rule and its documented
`node:fs/promises` exception for directory operations, the same way
`src/session/scratch-writer.ts` already does. This paragraph is descriptive, not a
contract: no specific API is mandated here, and conformance is a lint concern
(`bun run lint`) rather than an acceptance criterion.

## Out of Scope

- A `ScratchpadDelete` tool is not part of this feature; overwriting a file and the run-start wipe cover replacement and cleanup, and an unused tool costs prompt bytes on every hop.
- Widening the `Bash` or `RunCommand` shell gate so a shell redirect can reach `.nax/scratchpad/` is not part of this feature; those tools carry no path fields and are gated by human-authored `Bash(...)` rules and the lexer, which is a different seam.
- Granting the scratchpad tools automatically under the `scoped` permission profile is not part of this feature; `scoped` exists so a human enumerates every stage capability, and a project opts in by writing `ScratchpadWrite(*)` in its own `execution.permissions` block.
- Persisting scratchpad contents across separate `nax run` invocations is not part of this feature; the directory is wiped at the start of every run.
- Feeding scratchpad contents back into agent prompts as context is not part of this feature; `.naxignore` already excludes `.nax/` from context indexing and no provider reads the scratchpad.
- Partitioning the scratchpad per session, per story, or per role is not part of this feature; one flat directory per run is the chosen granularity.
- Locating the scratchpad outside the repository, for example under `~/.nax/<project>/`, is not part of this feature; that would require a second containment domain in the policy.
- Applying the new `confineTo` field to any existing tool is not part of this feature; only the three scratchpad tools declare it.
- Migrating or changing the existing session-scratch subsystem (`src/session/scratch-writer.ts`, `scratch.jsonl`, the `query_scratch` pull tool) is not part of this feature.
- Making scratchpad contents survive a worktree teardown is not part of this feature; a parallel story's worktree is force-removed and its scratchpad goes with it.
- Coordinating concurrent writes to the same scratchpad path is not part of this feature; tool calls within a session are sequential and parallel stories write into separate worktrees, so last-write-wins is the accepted behaviour.
- Bounding the total size or file count of the scratchpad directory is not part of this feature; only the per-file ceiling already carried by the run context's `maxFileBytes` applies, and the run-start wipe bounds accumulation.

## Stories

**US-001 — Tool-declared path confinement (`confineTo`)**
Add an optional `confineTo` to `ToolScope` and make the policy resolve a declaring
tool's `pathFields` against `<root>/<confineTo>`, while keeping grant globs, deny/ask
rules and the audit spelling repo-root-relative. No dependencies.

**US-002 — The scratchpad tools**
Add `src/tools/scratchpad.ts` with `SCRATCHPAD_DIR` and the three tools, register them
as built-ins, reserve their names, and extend the `CodingToolName` union.
Depends on US-001.

**US-003 — Availability to every op**
Append the three tools at the `declaredWithProviders` union in
`src/agents/coding-tool-support.ts` so every op advertises them regardless of its own
`tools` declaration, and add them to `DEFAULT_CODING_TOOLS` so the `safe` profile
grants them. Depends on US-002.

**US-004 — Run-start wipe and ignore coverage**
Wipe `.nax/scratchpad/` in `setupRun`, tolerating both absence and failure, and add
`**/.nax/scratchpad/` to `NAX_GITIGNORE_ENTRIES`. Depends on US-002 (for `SCRATCHPAD_DIR`).

**US-005 — Agent awareness**
Carve `.nax/scratchpad/` out of the `.nax/` immutability section, add a
`buildScratchpadSection()` introducing the scratchpad, and wire it into the TDD,
rectifier, semantic-review and adversarial-review builders — the review builders
included, because they do not compose `buildNaxArtifactsSection` and would otherwise
never learn the scratchpad exists. Depends on US-002.

### Context Files

**US-001**
- `src/tools/types.ts` — `ToolScope` declaration site.
- `src/tools/policy.ts` — `resolveWithin` and the `pathFields` branch of `check()`.
- `src/utils/realpath.ts` — `isInside` / `realOrRaw` semantics.
- `test/unit/tools/policy.test.ts` — existing containment cases to mirror.

**US-002**
- `src/tools/read.ts` — the canonical tool shape (schema, truncation, `ctx.resolvedPaths`).
- `src/tools/write.ts` — the canonical write-tool shape.
- `src/tools/registry.ts` — `CodingTool`, `ToolResult`, `RESERVED_TOOL_NAMES`.
- `src/tools/runtime.ts` — `registerBuiltinCodingTools`, the byte ceilings.
- `src/tools/index.ts` — barrel export conventions.

**US-003**
- `src/agents/coding-tool-support.ts` — the `declaredWithProviders` union.
- `src/config/permissions.ts` — `DEFAULT_CODING_TOOLS`, profile resolution.
- `src/operations/adversarial-review.ts` — the read-only op shape this must serve.

**US-004**
- `src/execution/lifecycle/run-setup.ts` — `setupRun`.
- `src/utils/gitignore.ts` — `NAX_GITIGNORE_ENTRIES` and its three consumers.
- `src/session/scratch-purge.ts` — precedent for directory removal with `_deps`.

**US-005**
- `src/prompts/sections/nax-artifacts.ts` — the prohibition to carve out.
- `src/prompts/builders/tdd-builder.ts` — composition site at `build()`.
- `src/prompts/builders/rectifier-builder-helpers.ts` — the second existing composition site.
- `src/prompts/builders/review-builder.ts` — `buildSemanticReviewPrompt`.
- `src/prompts/builders/adversarial-review-builder.ts` — `buildAdversarialReviewPrompt`.

`src/prompts/sections/index.ts` is deliberately absent from this read list despite
being edited: the builders import sections from that barrel, so exporting the new
section is forced by AC-4 and AC-5 rather than being a separate thing to discover, and
the list is capped at five reads. All four composition sites are listed instead,
because a builder that is never edited is a site the agent will not find by pattern.

### Creates

**US-002**
- `src/tools/scratchpad.ts`
- `test/unit/tools/scratchpad.test.ts`

**US-005**
- `src/prompts/sections/scratchpad.ts`
- `test/unit/prompts/sections/scratchpad.test.ts`

### Modifies

**US-003**
- `test/unit/config/permissions.test.ts` — asserts the `safe` profile's grants are exactly `["Read", "Glob", "Grep"]`. Adding the scratchpad tools to `DEFAULT_CODING_TOOLS` necessarily breaks this closed-world list. Replace it with an invariant that the list contains the three read tools and the three scratchpad tools, and contains no repository-mutating tool (`Write`, `Edit`, `Delete`, `GitCommit`, `RunCommand`, `Exec`) — which is the property `safe` actually guarantees.
- `test/unit/agents/coding-tool-support.test.ts` — asserts an op declaring `tools: ["Read"]` advertises exactly `["Read"]`. Appending the scratchpad tools at the union necessarily breaks this. Replace it with an invariant that the advertised list contains `Read` and the three scratchpad tools, and contains no other repository tool the op did not declare.

**US-001**

None. The story adds an optional field to ToolScope, so no existing scope literal has to change to remain valid, and the policy's existing containment tests pass an undefined confineTo and are unaffected.

**US-002**

None. The story appends new names to open-ended lists. The registry unit test asserts registration and reservation behaviour, never a closed-world count of registered tools.

**US-004**

None, but not because the test ignores the constant — it reads it in six places, including a loop over every member. The new entry satisfies each invariant that suite asserts: it does not begin with a slash, it is unique, it contains neither the substring "mutation-journal" nor "fragments" that two lookup tests search for, and it matches no committed feature spec or PRD path in the git-behaviour test. Re-check these four if the entry's spelling changes.

**US-005**

None. The nax-artifacts prompt test asserts substring presence and determinism — that the same role yields the same text on repeated calls. It does not compare one variant against another, so it constrains an added exception clause only in that the clause must be deterministic. AC-2 of this story pins the stronger cross-variant property separately, which the current implementation already satisfies because it ignores its variant argument entirely.

### Seams

- **US-001 → US-002.** US-002's tools declare `confineTo`; the confinement is enforced by US-001's policy change, not by the tools. Pinned by US-002 AC-7, which drives a containment escape through `callTool` rather than through the policy directly.
- **US-002 → US-003.** US-003 advertises the tools US-002 registered. Pinned by US-003 AC-1 and AC-5, which assert advertisement and a successful call from a read-only op shape.
- **US-002 → US-004.** US-004's wipe targets `SCRATCHPAD_DIR`, exported by US-002. Pinned by US-004 AC-1.
- **US-002 → US-005.** US-005's prompt section names the path US-002 defines. Pinned by US-005 AC-4 and AC-5, which assert the composed prompt from each builder carries it.

## Acceptance Criteria

### US-001 — Tool-declared path confinement

- **AC-1** `[unit]` Given a policy compiled at a root and an unconditional grant for a tool whose scope declares `pathFields: ["path"]` and `confineTo: ".nax/scratchpad"`, checking that tool with `path` set to `"notes.md"` returns an allowed verdict whose single resolved path is the root's `.nax/scratchpad/notes.md`.
- **AC-2** `[unit]` The same check with `path` set to `"../../src/index.ts"` returns a refused verdict whose `breach` flag is true and whose reason text includes the requested path.
- **AC-3** `[unit]` The same check with `path` set to an absolute path outside the confined directory returns a refused verdict whose `breach` flag is true.
- **AC-4** `[unit]` Given a symbolic link created inside the confined directory whose target resolves outside the repository root, checking that link's path returns a refused verdict.
- **AC-5** `[unit]` For a tool whose scope omits `confineTo`, checking a path of `"src/index.ts"` resolves against the policy root and returns an allowed verdict — confinement applies only to declaring tools.
- **AC-6** `[unit]` Given a grant of `[".nax/scratchpad/**"]` rather than `["*"]` for a tool declaring `confineTo: ".nax/scratchpad"`, checking `path` set to `"notes.md"` returns an allowed verdict — grant globs continue to match the repository-root-relative spelling.
- **AC-7** `[unit]` Given a deny rule of `[".nax/scratchpad/secret*"]` for that tool, checking `path` set to `"secret.txt"` returns a refused verdict, while `path` set to `"notes.md"` returns an allowed verdict.

### US-002 — The scratchpad tools

- **AC-1** `[unit]` `SCRATCHPAD_DIR` is importable from the tools barrel and equals `".nax/scratchpad"`.
- **AC-2** `[unit]` Each of `ScratchpadWrite`, `ScratchpadRead` and `ScratchpadList` exposes a scope whose `confineTo` equals `SCRATCHPAD_DIR`; `ScratchpadWrite` and `ScratchpadRead` additionally declare `pathFields` containing `"path"`.
- **AC-3** `[unit]` Calling `ScratchpadWrite` through the coding-tool runtime's `callTool` with `path` `"notes.md"` and `content` `"hello"` returns a non-error outcome, and afterwards the file at `.nax/scratchpad/notes.md` under the root holds exactly `"hello"`.
- **AC-4** `[unit]` Calling `ScratchpadWrite` with `path` `"a/b/notes.md"` returns a non-error outcome and creates the intermediate directories.
- **AC-5** `[unit]` Calling `ScratchpadRead` with the `path` written by a preceding `ScratchpadWrite` returns a non-error outcome whose content equals what was written.
- **AC-6** `[unit]` Calling `ScratchpadRead` with a `path` that does not exist returns an outcome flagged as an error whose message names the requested path, and does not raise.
- **AC-7** `[unit]` Calling `ScratchpadWrite` through `callTool` with `path` `"../../src/index.ts"` returns a refused outcome, and no file is created anywhere under the repository root outside `.nax/scratchpad/`.
- **AC-8** `[unit]` Calling `ScratchpadList` after two `ScratchpadWrite` calls returns a non-error outcome whose content names both written paths.
- **AC-9** `[unit]` Calling `ScratchpadList` when the scratchpad directory does not exist returns a non-error outcome reporting no entries.
- **AC-10** `[unit]` Calling `ScratchpadWrite` with content whose byte length exceeds the run context's `maxFileBytes` returns an outcome flagged as an error whose message states the limit, and writes no file.
- **AC-11** `[unit]` Calling `ScratchpadRead` through `callTool` on a file whose byte length exceeds the run context's `maxBytes` returns a non-error outcome whose content is at most `maxBytes` bytes.
- **AC-11b** `[unit]` Invoking the `ScratchpadRead` tool's own `run` with a run context whose `maxBytes` is smaller than the target file returns a result whose `resultBytesPreTruncation` equals the file's full byte length. The assertion is made on the tool result rather than through `callTool`, because `CodingToolOutcome` carries only `kind` and `content` and drops the field.
- **AC-12** `[unit]` After `registerBuiltinCodingTools()` runs, looking up each of the three scratchpad names in the tool registry returns a tool, and a third-party `registerCodingTool` call using the name `"ScratchpadWrite"` raises an error carrying the code `TOOL_NAME_RESERVED`.

### US-003 — Availability to every op

- **AC-1** `[unit]` Resolving coding-tool support for an operation declaring `tools: ["Read"]` yields an advertised tool list containing `Read`, `ScratchpadWrite`, `ScratchpadRead` and `ScratchpadList`.
- **AC-2** `[unit]` Resolving permissions under the `safe` profile yields tool grants whose tool names include `ScratchpadWrite`, `ScratchpadRead` and `ScratchpadList`, and include none of `Write`, `Edit`, `Delete`, `GitCommit`, `RunCommand` or `Exec`.
- **AC-3** `[unit]` Resolving permissions under the `unrestricted` profile yields tool grants whose tool names include the three scratchpad tools.
- **AC-4** `[unit]` Under the `scoped` profile with no rule naming a scratchpad tool, calling `ScratchpadWrite` through `callTool` returns a refused outcome whose reason names the tool, rather than raising or silently succeeding.
- **AC-5** `[integration]` For an operation declaring the read-only review shape `tools: ["Read", "Glob", "Grep", "Git"]` under the `unrestricted` profile, calling `ScratchpadWrite` through `callTool` with `path` `"findings.md"` returns a non-error outcome.
- **AC-6** `[unit]` For that same declaration, the advertised tool list contains the three scratchpad tools and contains none of `Write`, `Edit` or `Delete`.

The read-only review op is kept away from repository writes by **what it is
advertised**, not by a refusal at call time: `advertised(declared)` intersects the
op's declaration with the policy's grants, while `callTool` consults the policy
alone and never reads the declaration. So under `unrestricted` a direct
`callTool("Write", …)` would succeed — the declaration is not a call-time gate, and
no AC should claim it is. AC-6 asserts the property that actually holds.

### US-004 — Run-start wipe and ignore coverage

- **AC-1** `[unit]` Given a scratchpad directory under the run's workdir containing a file, `setupRun` completes and afterwards that file no longer exists.
- **AC-2** `[unit]` Given no scratchpad directory under the run's workdir, `setupRun` completes without raising.
- **AC-3** `[unit]` Given a directory-removal dependency that rejects, `setupRun` still returns its result and emits a warn-level log record whose stage is `"setup"` and whose message names the scratchpad — the run is not wedged.
- **AC-4** `[unit]` `NAX_GITIGNORE_ENTRIES` contains the exact entry `"**/.nax/scratchpad/"`.

### US-005 — Agent awareness

- **AC-1** `[unit]` `buildNaxArtifactsSection` called with the `implementer` role returns text that names `.nax/scratchpad/` as an exception and still states that files under `.nax/` must never be moved, renamed or deleted.
- **AC-2** `[unit]` `buildNaxArtifactsSection` returns identical text for the `standard` and `lite` variants — the exception is applied uniformly.
- **AC-3** `[unit]` `buildScratchpadSection()` returns text naming `.nax/scratchpad/`, stating that its contents are wiped at the start of each run and are never committed.
- **AC-4** `[unit]` The prompt returned by `TddPromptBuilder.build()` for the `implementer` role contains `.nax/scratchpad/`.
- **AC-5** `[unit]` The prompts returned by `buildSemanticReviewPrompt` and by `buildAdversarialReviewPrompt` each contain `.nax/scratchpad/`.

<!-- spec-writing: completed-through-phase-6 -->
