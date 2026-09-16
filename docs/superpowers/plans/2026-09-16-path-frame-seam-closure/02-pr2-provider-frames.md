# PR 2 — Provider frames and effectiveness attribution (#2088, #2091)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the context engine speak one frame — repo-rooted internally, package-relative only where a path is rendered into an agent's prompt — so git history is not silently empty and effectiveness attribution stops crediting the wrong package.

**Architecture:** Move `ContextRequest.touchedFiles` to the canonical repo frame, have each provider re-spell at its own output boundary, and canonicalize `RawChunk.scopePaths` at chunk assembly so attribution compares two repo-framed strings.

**Spec:** `docs/superpowers/specs/2026-09-16-path-frame-convention-design.md` (seams 8 and 10). **Overview:** [`00-overview.md`](./00-overview.md) — read its Global Constraints first.

**Base:** `main` @ `71071a035`.

**Depends on PR 1.** `partitionPackageFrame` must exist. Do not start until PR 1 has landed.

---

## Global Constraints

See [`00-overview.md`](./00-overview.md#global-constraints). The ones that bite here:

- **`src/context/engine/providers/static-rules.ts` is at exactly 600/600 lines and CANNOT GROW.** Not by one line. Plan every change to avoid it; it needs none.
- Bun-native only. `bun run typecheck && bun run lint && bun run test` green before every commit, plus `bun run test:coverage`.
- Never read `story.workdir` raw — use `storyWorkdir(story)`.

---

## Orientation: why these two ship together

Both are the same root cause seen at two points in one pipeline. `touchedFiles` is declared package-framed; `scopePaths` is derived from `touchedFiles` in one provider and from author-written repo-framed globs in another; the diff they are compared against is repo-framed. Fixing either alone leaves the pipeline speaking two frames.

`ContextRequest.touchedFiles` has **no docblock of its own stating its frame** — the contract lives in the neighbouring `scopeFiles` docblock at `src/context/engine/types.ts:329-334`. Part of this PR is giving it one.

**Consumers of `touchedFiles` (all of them):**

| Site | Use |
|---|---|
| `providers/git-history.ts:103,109` | git pathspec after `--` |
| `providers/code-neighbor.ts:381,390` | glob / neighbour resolution |
| `handlers/query-neighbor.ts:78` | builds `touchedFiles: [input.filePath]` |

Two of the three turn these strings into **shell arguments**. That is why PR 1 deliberately did not touch the two build sites — classification must not be encoded into a string that becomes a pathspec.

---

## Part A — #2088: GitHistoryProvider

### The defect

```ts
// src/context/engine/providers/git-history.ts:104
const workdir = this.historyScope === "package" ? request.packageDir : request.repoRoot;
```

with the command at `:72-75`:

```ts
["log", "--oneline", "--follow", "-n", String(MAX_COMMITS), "--", filePath], workdir
```

Under `historyScope: "repo"` the cwd becomes the repo root while the paths stay package-framed. **A git pathspec after `--` resolves relative to cwd, and a pathspec matching nothing is not an error.** Exit 0, empty stdout → `fetchFileHistory` returns null (`:77-79`) → the file is filtered at `:125` → `:127-129` returns `{ chunks: [], pullTools: [] }`.

**The file imports no logger at all.** The silence is total: no warning, no non-zero exit, no degraded marker. The provider simply contributes nothing.

**The sharper variant:** if a root-level file shares the package-relative path, the command returns **that unrelated file's history** under the story's label, and `scopePaths` at `:166` claims scope over it. Silent corruption of context and of attribution, not just a miss.

### Reachability

Requires Context Engine v2 (`enabled` defaults `false`, `src/config/schemas-context.ts:163`) **and** `historyScope: "repo"`, which defaults to `"package"` in four places: `schemas-context.ts:232`, `:253`, `orchestrator-factory.ts:91`, and the constructor at `git-history.ts:99`. Latent by config.

The **sibling** case — a root file like `tsconfig.json` passing through repo-rooted and then being run against `packageDir` — was reachable in default `"package"` mode and is fixed by PR 1's partition at the builder. It is *not* fixed at the two `touchedFiles` build sites, which is Part A's job.

The arc never touched this file: `git log --oneline -15 -- src/context/engine/providers/git-history.ts` shows its most recent commit is `22de72bc6`, a path-alias migration.

### Direction

**Always run git in `repoRoot` against repo-rooted paths, and treat `historyScope` purely as a filter.** This removes the frame branch rather than adding a second one to it, and it matches the convention: canonical internally, re-spell at the boundary.

- [ ] **A1: Move the two build sites to the repo frame**

`src/pipeline/stages/context.ts:131` and `src/context/engine/stage-assembler.ts:236` currently call `toPackageFrameFiles(...)`. Stop reframing: pass the PRD's paths through in the canonical repo frame.

Replace the comment above each (`context.ts:126-130`, `stage-assembler.ts:234-235`) — both currently say providers resolve against `packageDir`, which this PR makes false.

Add a real docblock to `ContextRequest.touchedFiles` in `src/context/engine/types.ts` stating: **repo-rooted; providers re-spell at their own output boundary.**

- [ ] **A2: Write the failing provider test**

In **`test/unit/context/engine/providers/git-history.test.ts`** (exists) — read the existing mocking style first; the spawn dep is injected.

Two cases:
1. `historyScope: "repo"`, `touchedFiles: ["packages/api/src/client.ts"]`, `packageDir: "packages/api"` → assert the argv pathspec is `packages/api/src/client.ts` and cwd is `repoRoot`.
2. `historyScope: "package"`, same input → assert cwd is **still** `repoRoot` and the pathspec is **still** repo-rooted, and that a file outside `packages/api` is filtered out rather than queried.

Add a third, guarding the sharper variant: a root-level `src/client.ts` exists and must **not** be returned under a `packages/api` story's label.

- [ ] **A3: Run, confirm failure**

Run: `bun test test/unit/context/engine/providers/git-history.test.ts`

- [ ] **A4: Implement**

In `git-history.ts`: drop the ternary at `:104`, run every invocation with `cwd: request.repoRoot`, and apply `historyScope === "package"` as a **post-filter** on the repo-framed path (keep entries under `request.packageDir`).

Note `:109` filters through `isRelativeAndSafe` — confirm repo-rooted paths still satisfy it, and extend the test if the predicate needs adjusting.

The file is at 181 lines; ample room.

- [ ] **A5: Add the missing signal**

The file has no logger. A file whose history came back empty must say so once — path, resolved pathspec, and cwd. The defect was undiagnosable because nothing was ever logged; fixing the frame without fixing the silence leaves the next frame bug equally invisible.

Check `check:logger-storyid` passes — the logger call needs a story id if the linter requires one on this surface.

- [ ] **A6: Check the other two consumers did not break**

`providers/code-neighbor.ts:381,390` and `handlers/query-neighbor.ts:78` now receive repo-framed `touchedFiles`. `code-neighbor.ts:237`'s docblock explicitly says it resolves them against `request.packageDir` — that comment is now wrong and the code with it.

Re-spell at the point of resolution using `partitionPackageFrame(files, packageDir, { canonical: true })` from PR 1, or resolve against `repoRoot` directly. Whichever you choose, **run the full code-neighbor suite** and read every failure.

`query-neighbor.ts:78` builds `touchedFiles: [input.filePath]` from a single caller-supplied path — verify which frame that caller speaks before changing anything.

- [ ] **A7: Run, confirm pass. Commit Part A.**

```bash
bun run typecheck && bun run lint && bun run test
git commit -m "fix(context): run git history in the repo frame and scope historyScope as a filter (#2088)"
```

---

## Part B — #2091: scopePaths attribution

### The defect

```ts
// src/context/engine/effectiveness.ts:370-374
function pathMatchesScope(scopePaths: string[], filePath: string): boolean {
  const normalized = normalizePath(filePath);
  const patterns = scopePaths.map((pattern) => globToRegex(normalizePath(pattern)));
  return patterns.some((pattern) => pattern.test(normalized));
}
```

fed from the persisted manifest at `:454`, consumed by `classifyScoped` at `:387-400`.

The two sides are in different frames. The diff side is repo-framed **and repo-wide**: `src/pipeline/stages/completion.ts:302` runs `git diff <base>..HEAD` with no `--relative` and no pathspec.

And `globToRegex` is **suffix-anchored** — `` new RegExp(`(?:^|/)${regex}$`) `` at `src/context/engine/providers/static-rules.ts:158`.

**So the consequence is over-attribution, not a miss.** A package-relative `src/client.ts` compiles to `(?:^|/)src\/client\.ts$`, which matches `packages/api/src/client.ts` **and** `packages/web/src/client.ts`. A chunk scoped to one package collects credit from a same-named file in another.

### Why it is not cosmetic

`classifyScoped` returns `followed`/`ignored`/`unknown` → `annotateManifestEffectiveness` (`effectiveness.ts:424`) persists it → `deriveProviderWeights` (`provider-weights.ts:75`) aggregates the ignored ratio per provider across the feature:

```ts
// provider-weights.ts:109-110
const ignoredRatio = ignored / observations;
computed[providerId] = clampWeight(1 - K * ignoredRatio);   // MIN_WEIGHT = 0.2
```

→ `provider-weights-cache.ts:40` → `stage-assembler.ts:281-286` → `orchestrator.ts:378` → `scoring.ts:113`. **A wrong verdict changes how much that provider is trusted for the rest of the feature.**

### Three producers, three frames

| Producer | Emits | Frame |
|---|---|---|
| `providers/static-rules.ts:440,449` | author-written `appliesTo` globs | repo-framed, already correct |
| `providers/git-history.ts:166` | `touchedFiles` entries | package-framed (repo-framed after Part A) |
| `providers/code-neighbor-chunk.ts:169-186` | analysed file + neighbour paths | **both frames in one array** after #2082 |

`code-neighbor-chunk.ts:145-150` already strips `UNREADABLE_MARKER` from the key and names the hazard — *"a scopePaths key carrying it would split one file into two identities"* — but it strips the marker, **not the frame**.

A second effect sits one level up: the chunk id is `code-neighbor:${contentHash8(content)}` (`:179`) over the *rendered* content, so the same neighbour set rendered from two consumer roots yields two chunk ids and two independent observation counts.

### No migration needed

`chunkScopePaths` / `chunkEffectiveness` live in `.nax/features/<id>/stories/<id>/context-manifest-*.json` (`manifest-store.ts:5`), gitignored (`.gitignore:58`), never read across features, and `hydrateManifestPaths` (`manifest-store.ts:102-108`) rewrites only `repoRoot`/`packageDir` — these fields pass through untouched. Forward-only is sufficient; stale verdicts age out with the feature directory, and only an in-flight feature keeps old values.

- [ ] **B1: Write the failing test**

Reproduce the issue's worked example in **`test/unit/context/engine/effectiveness.test.ts`** (exists):

Chunk scoped `["src/client.ts"]` produced by a `packages/api` story. Diff contains `packages/web/src/client.ts` but **not** `packages/api/src/client.ts`. Assert the verdict is `ignored`.

Add a positive control: diff contains `packages/api/src/client.ts` → verdict `followed`. A fix that makes everything `ignored` must fail this.

Add a glob case: a `static-rules` chunk scoped `["packages/**/*.ts"]` must still match `packages/api/src/client.ts`. Glob semantics must survive.

- [ ] **B2: Run, confirm failure**

Expected: the first case currently returns `followed` with `evidence: "packages/web/src/client.ts"`.

- [ ] **B3: Canonicalize scopePaths at chunk assembly**

Repo-frame the emissions at `git-history.ts:166` and `code-neighbor-chunk.ts:175`.

**Do not touch `static-rules.ts`.** It is at exactly 600/600, and its `appliesTo` globs are already repo-framed and correct.

- [ ] **B4: Anchor literal matches exactly**

With both sides repo-rooted, a repo-rooted **literal** must match exactly, not by suffix — otherwise the mismatch stays masked. Author-written **globs** must keep glob semantics.

Distinguish the two rather than loosening both: treat a path with no glob metacharacter (`*`, `?`, `[`, `{`) as a literal and compare it with `===` after `normalizePath`; send anything else through `globToRegex` unchanged.

Put this in `effectiveness.ts` (475 lines, room). **Not** in `static-rules.ts`.

Leave `getDiffText` repo-framed — it is already canonical.

- [ ] **B5: Run, confirm pass**

Run: `bun test test/unit/context/engine/`
Expected: PASS, including `provider-weights` and `scoring` suites.

- [ ] **B6: Full gate, then commit**

```bash
bun run typecheck && bun run lint && bun run test
git commit -m "fix(context): canonicalize scopePaths and anchor literal matches so attribution stops crossing packages (#2091)"
```

---

## PR body

Include these lines so both issues close on merge:

```
Closes #2088
Closes #2091
```

Also record in the body:

- **`src/context/engine/providers/static-rules.ts` is byte-identical.** It sits at exactly 600/600 lines. Paste `git diff --stat` showing it absent.
- **`ContextRequest.touchedFiles` gained its own docblock.** Its frame contract previously survived only in the neighbouring `scopeFiles` docblock — see the correction appended to #2088.
- **No migration was needed** for `chunkScopePaths` / `chunkEffectiveness`: gitignored local run state, never read across features, not rehydrated. Stale verdicts age out with the feature directory; only an in-flight feature keeps old values.
- **GitHistoryProvider gained a logger.** Previously the file imported none, which is why the defect was undiagnosable.

---

## Done when

- `git log` runs in `repoRoot` against repo-rooted pathspecs regardless of `historyScope`, and an empty result is logged.
- `ContextRequest.touchedFiles` has its own docblock naming its frame, and no build site reframes it.
- A chunk scoped to one package no longer collects `followed` credit from a same-named file in another.
- `static-rules.ts` is byte-identical — verify with `git diff --stat`.
