# PR 4 — `--relative` and pathspecs in the three review builders (#2090)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the git commands embedded in review prompts print paths the reviewing agent can actually open, and scope the two that diff the whole repo.

**Architecture:** Add `--relative` to every `diff`/`log`/`show` in the three builders' ACP shell bodies and `-- .` to the two unscoped full-diff commands, and replace the obsolete "frozen control arm" justification in the parity test with the invariants that test actually protects.

**Spec:** `docs/superpowers/specs/2026-09-16-path-frame-convention-design.md` (seam 9). **Overview:** [`00-overview.md`](./00-overview.md) — read its Global Constraints first.

**Base:** `main` @ `71071a035`.

**Independent** — no dependency on other PRs in this bundle.

---

## Global Constraints

See [`00-overview.md`](./00-overview.md#global-constraints). The ones that bite here:

- `bun run typecheck && bun run lint && bun run test` green before every commit, plus `bun run test:coverage` (separate per-file floor; this PR adds tests).
- `bun run lint` includes `check:review-prompts`, which guards `src/finish/review/prompts.gen.ts` against its `references/*.md` sources. **That is a different subsystem** from `src/prompts/builders/` and should not be affected — but if it fires, run `bun run gen:review-prompts` rather than hand-editing the generated file.

---

## The defect

**Live today** on every ACP-protocol review role in a monorepo.

The reviewing session is contained at the package — `src/operations/call.ts:234` `workdir: ctx.packageDir`, `:254` `codingToolRoot: packageWorkdir(ctx.packageView)`. Git prints repo-top-level paths absent `--relative`, so the reviewer is shown `packages/api/src/client.ts` while its `Read` resolves that under `<repo>/packages/api` → `packages/api/packages/api/src/client.ts` → not found.

The Git **tool** injects `--relative` unconditionally for `diff`/`log`/`show` (`src/tools/git.ts:57` `GIT_RELATIVE_VERBS`, injected at `:200`) precisely because it runs with cwd = the package dir. Two producers of the same verb, opposite frames, one of them internal and unflagged.

**The `-- .` pathspec is already correct where present** — it scopes the listing to the cwd subtree. Only the *spelling* is wrong.

### Sites (all verified on `71071a035`)

| File | Lines | Commands |
|---|---|---|
| `src/prompts/builders/adversarial-review-builder.ts` | `:282`, `:285`, `:288`, `:295`, `:299` | full diff, log, added-files list (twice), production diff |
| `src/prompts/builders/review-builder.ts` | `:341-343` | `productionDiffCmd`, `fullDiffCmd`, `logCmd` — rendered at `:350-352` |
| `src/prompts/builders/debate-builder.ts` | `:452-454` | full diff, production diff, commit history |

### Second defect — no pathspec at all

`review-builder.ts:342` (`fullDiffCmd`) and `debate-builder.ts:452` (`- Full diff:`) both end at `..HEAD` with **no `-- .` and no exclude args**. In a monorepo the reviewer is handed the whole repo's diff, and the `:!.nax/` exclusions are absent there too — not just `--relative`.

### Not the native arm

`src/prompts/sections/protocol-region.ts:171-175` swaps the region for a Git-tool rendering (`renderNative` at `:54`), dispatched via `src/agents/tool-preamble.ts:76`. Native gets `--relative` for free. `protocol-region.ts:323` returns the raw body for ACP. So this fires only on ACP, and only when `packageDir !== repoRoot`.

### Worked example

Monorepo story `US-003`, `workdir: packages/api`. The adversarial reviewer runs step 1 of the test audit (`adversarial-review-builder.ts:295`), is told `packages/api/src/client.test.ts` exists, tries to `Read` it, fails — then either abandons the test audit or files a bogus `test-gap` finding for a test file it was just shown.

---

## The parity premise, and why it is retired

`test/unit/prompts/diff-access-acp-parity.test.ts:1-13` opens:

> The ACP arm must be byte-for-byte what shipped before the diff-access region existed. That is not a nicety: it is the premise the whole scope decision rests on — native's Git error rate can only be measured before/after if the ACP arm did not move underneath it.

That is an **A/B setup**: the native path changed, and the ACP arm was held still as a control so any improvement could be attributed. The comment functions as a standing prohibition — anyone who reads it will refuse to touch these strings.

**Retiring it removes that one paragraph. Nothing else.** ACP the protocol, the test file, and all four of its assertions stay.

### The evidence: the control already moved

`#2095` — commit `71071a035`, the current HEAD — added `buildAgentScopeSection` and prepends it at the dispatch seam, `src/agents/tool-preamble.ts:33-37`:

```ts
export function promptWithToolPreamble(agentName: string, options: AgentRunOptions): string {
  const base = agentName === NATIVE_AGENT ? options.prompt : buildContextToolPreamble(options);
  const scope = buildAgentScopeSection(options.codingToolRoot, options.codingToolRepoRoot);
  return scope === undefined ? base : `${scope}\n\n${base}`;
}
```

Its docblock: *"The scope block is prepended on BOTH arms."*

**The parity test pins builder output, not the prompt the agent receives.** So the delivered ACP arm moved and the test stayed green. A control arm that silently moves is not a control arm, and the freeze is being enforced on the wrong layer — blocking honest fixes while missing real changes.

### #2095 is itself a prose mitigation of this bug

`agent-scope.ts`'s docblock names the identical failure — *"a reviewer shown a file it cannot open reports the file as missing"* — and instructs the agent:

> `If a path you were given already starts with \`<label>/\`, strip that prefix before using it.`

That is #2090, patched by asking a model to do string arithmetic on every path it is handed. Since the ACP arm is a real claude/codex/opencode with a shell, it will often recover — by grepping, by re-running git itself — but recovery costs round trips and sometimes lands as a bogus finding instead. **`--relative` is deterministic; prose compliance is probabilistic.** Fix the command and let the scope block be belt-and-braces.

### What replaces the premise

The test's *second* paragraph describes a real defect it caught — `wrapJsonPrompt`'s `prompt.trim()` stopping at the non-whitespace closing marker and leaving a stray blank line. That guard is valuable and **stays**.

The four existing assertions and their fate:

| Assertion | Lines | Fate |
|---|---|---|
| no `DIFF_ACCESS_MARKER_PREFIX` survives ACP rendering | `:64-68` | **keeps**, unaffected |
| shell commands still contain `git diff --unified=3 ${REF}..HEAD` / `git log --oneline ${REF}..HEAD` | `:71-77` | **keeps and still passes** — `toContain` on the prefix |
| diff section joins JSON framing with exactly two newlines | `:84-86` | **keeps**, unaffected |
| region adds no trailing blank lines | `:88-90` | **keeps**, unaffected |

All four survive **if `--relative` is appended after `..HEAD`**. The only mechanically hard-blocking assertion is the snapshot at `test/unit/prompts/__snapshots__/review-builder.test.ts.snap`.

---

- [ ] **Step 1: Rewrite the parity test's header first**

Before touching any builder. Replace the frozen-arm paragraph with the invariants the file actually protects — no leaked markers, exactly two newlines at the JSON join, no trailing blank lines — and state plainly that the byte-freeze premise is retired because the delivered ACP prompt moved in #2095 at `tool-preamble.ts:33-37` while this file, which asserts on builder output, stayed green.

Keep the second paragraph (the `wrapJsonPrompt` trim story) verbatim. It is why the file exists.

Record the same in the PR body.

- [ ] **Step 2: Write the failing tests**

One per builder — `test/unit/prompts/adversarial-review-builder.test.ts`, `test/unit/prompts/review-builder.test.ts`, `test/unit/debate/prompt-builder.test.ts`.

For each: every emitted `diff` / `log` command contains `--relative`, and every `diff` command contains a `-- .` pathspec.

- [ ] **Step 3: Run, confirm failure**

Run: `bun test test/unit/prompts/ test/unit/debate/`

- [ ] **Step 4: Implement**

Add `--relative` to every `diff`/`log`/`show` in the three builders' ACP `shellBody` strings, and `-- .` plus the exclude args to `review-builder.ts:342` and `debate-builder.ts:452`.

**Append `--relative` after `..HEAD`, not before.** `diff-access-acp-parity.test.ts:71-77` and `test/unit/prompts/adversarial-review-builder.test.ts:55` assert on the `git diff --unified=3 ${REF}..HEAD` prefix via `toContain`; inserting the flag earlier breaks all three for no benefit.

- [ ] **Step 5: Update the snapshot deliberately**

`test/unit/prompts/__snapshots__/review-builder.test.ts.snap`.

**Read the diff before accepting it.** Confirm every changed line is one of the command strings you intended and nothing else moved. An unread `-u` is exactly how a premise dies quietly — which is what happened in #2095.

- [ ] **Step 6: Run the full prompt and debate suites**

Run: `bun test test/unit/prompts/ test/unit/debate/`
Expected: PASS, including `diff-access-acp-parity`, `diff-access-gating`, `protocol-region`, and `personas`.

- [ ] **Step 7: Full gate, then commit**

```bash
bun run typecheck && bun run lint && bun run test
git commit -m "fix(prompts): frame prompt-embedded git output for package-contained ACP reviewers (#2090)"
```

---

## PR body

Include this line so the issue closes on merge:

```
Closes #2090
```

And this one, which must **not** be a `Closes`:

```
Refs #2096
```

This PR performs part 1 of #2096's direction — retiring the byte-freeze premise and rewriting the header to pin the invariants the file genuinely protects. Part 2 (assert at the dispatch seam, if a frozen-arm guarantee is wanted at all) stays open. Do not close #2096 here.

Also record in the body:

- **The ACP arm moved in #2095, not in this PR.** `buildAgentScopeSection` is prepended to both arms at `src/agents/tool-preamble.ts:33-37`, and `diff-access-acp-parity.test.ts` stayed green because it asserts on builder output. This PR makes that movement explicit and deliberate rather than introducing it.
- **The snapshot diff was read line by line before acceptance** — say which lines changed and confirm they are all intended command strings. An unread `-u` is precisely how the premise died quietly the first time.
- **`--relative` is appended after `..HEAD`** so the three `toContain` prefix assertions keep passing; the flag position is deliberate, not incidental.

---

## Done when

- Every `diff`/`log` in the three builders carries `--relative`, and every diff carries a pathspec.
- The parity test's header states its real invariants; its four assertions still pass.
- The snapshot diff was read line by line before acceptance.
- The PR body records that the arm moved in #2095, not here — this PR makes that movement explicit and deliberate.

## Follow-up to file

The parity test asserts on **builder** output while the prompt the agent receives is assembled at **dispatch**. Any future frozen control arm must assert on dispatch output, or it will miss changes like #2095's. That is a testing-strategy defect independent of #2090 and deserves its own issue.
