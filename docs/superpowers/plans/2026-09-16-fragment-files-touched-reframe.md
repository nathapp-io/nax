# Fragment `## Files touched` Reframe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a dependency story's context fragment from handing a package-contained agent file paths it cannot resolve, by re-spelling the reachable entries and marking the unreachable ones at read time.

**Architecture:** A completed story's fragment records **repo-rooted** paths (`packages/lib/src/util.ts`). A dependent story's file tools are contained at that story's **package** dir. The writer stays repo-rooted — it is the only spelling that identifies a cross-package file unambiguously, and the writer cannot know who will read it. The **reader** is the only layer that knows both roots, so one pure function transforms the fragment body at read time: entries inside the consuming story's package are re-spelled package-relative (directly readable), entries outside it keep their repo-rooted spelling and gain a marker that tells the model not to try.

**Tech Stack:** TypeScript, Bun, `bun:test`.

**Spec:** GitHub issue [nathapp-io/nax#2072](https://github.com/nathapp-io/nax/issues/2072). The ruling this plan implements ("rewrite + mark", issue Option 2 extended with in-package re-spelling) was made on 2026-09-16 and is restated in full under *Ruling and Rationale* below. Read that section before Task 1 — the issue text lists four options and does **not** name the winner.

## Global Constraints

- **Never run bare `bun test`, and never `bun run nax`.** Both give confident false signals. Use `bun run test` for the full suite; for a fast single-file loop use the same invocation shape `test:unit` uses: `bun test ./path/to/file.test.ts --timeout=60000` (a path argument is always present).
- **`bun run test:coverage` is NOT part of `check:all`.** This plan adds a file under `src/`, so it must be run before the final commit.
- **File-size gate: 600 lines per `src/` file, 800 per `test/` file.** Current sizes: `src/context/engine/providers/feature-context.ts` 416, `src/context/fragments/store.ts` 202, `test/unit/context/engine/providers/feature-context-fragments.test.ts` 482 (+~55 from Task 2 = ~537). No file in this plan approaches a cap.
- **No mutation.** Build new arrays/objects; never mutate a parameter or an array in place (`~/.claude/rules/coding-style.md`).
- **No emojis** in code, comments, or docs.
- **Conventional commits**: `fix:`, `test:`, `refactor:`. Attribution lines are disabled globally — do not add them.
- **ASCII only in the marker string.** Do not use an em dash or any non-ASCII punctuation in `UNREADABLE_MARKER`; it is rendered into agent prompts and compared byte-for-byte in tests.
- Branch off `main` (currently `f81fb5658`). Do not commit directly to `main`.

---

## Ruling and Rationale

Read this before writing code. It is the part a fresh session cannot reconstruct from the issue.

### The decision

For each `- <path>` entry under `## Files touched` in a dependency fragment, at read time, given the consuming story's package:

| Entry | Action | Result |
|---|---|---|
| inside the consumer's package | re-spell package-relative | directly readable, zero wasted round trips |
| outside it (or consumer is repo-root) | keep repo-rooted, append marker | identified, and the model knows not to Read it |

**Rejected: `--relative` on the writer** (issue's own argument, confirmed empirically). From `packages/lib`, `git diff --name-only --relative` returns `.nax/cache/x.json`, `src/util.ts` — it both re-spells *and* **restricts** to cwd. So it would silently misresolve (`packages/app/src/util.ts` exists and is the wrong file) and delete the cross-package entries the fragment exists to carry. The current bug is a loud ENOENT; this would make it a silent misread.

**Rejected: filtering cross-package entries out** (issue Option 3). That discards exactly the signal the fragment exists for — `store.ts:186-191` states the file list "tells a dependent story where its dependency landed".

**Rejected: a framing header alone** (issue Option 1). Leaves both broken shapes reachable and relies entirely on the model doing the subtraction on every read.

### Why in-package re-spelling is required, not polish

The filed reproduction has US-001 in `packages/lib` and US-002 in `packages/app` — every observed fragment-caused failure is cross-package, so a marker alone would appear to fix it. It does not fix the **same-package** shape, which is at least as common: if US-002 `dependsOn` US-001 and both live in `packages/app`, the fragment says `packages/app/src/index.ts`, the consumer's containment root **is** `packages/app`, and the Read resolves to `packages/app/packages/app/src/index.ts` — the identical ENOENT. Both halves are real defects.

### The trap that will otherwise sink this

**Derive the consumer's package prefix from `story.workdir`. Never from `relative(request.repoRoot, request.packageDir)`.**

`iteration-runner.ts:180-181` sets `projectDir: ctx.workdir` (the **main checkout**) and `workdir: join(effectiveWorkdir, story.workdir)` where `effectiveWorkdir` is the **worktree** root (`iteration-runner.ts:164-172`). Under worktree isolation that makes `ContextRequest.packageDir` = `<main>/.nax-wt/US-002/packages/app` while `repoRoot` = `<main>`, so `relative()` between them yields `.nax-wt/US-002/packages/app`. That prefix matches nothing, every entry mis-classifies as cross-package, the re-spelling silently no-ops, and the bug looks fixed in every single-package test. This is the same path-identity-vs-lookup-key trap as #2069.

`story.workdir` is sound in **every** workdir-resolution branch — all three are `join(<someRoot>, story.workdir)`:
- `iteration-runner.ts:168` (worktree isolation)
- `iteration-runner.ts:171` (shared isolation)
- `worktree/dependencies.ts:39` `resolveDependencyCwd` (the `dependencyContext.cwd` branch)
- `execution/parallel-worker.ts:72` (parallel isolation)

It is also schema-guaranteed relative and traversal-free (`prd/schema.ts:302-314`).

### Facts verified against `main` @ `f81fb5658` — do not re-derive

- **Single seam.** `collectFragmentChunks` emits `content: body` at `feature-context.ts:384`. That is the only place a fragment body becomes a chunk.
- **Consumer story is bound.** Both construction sites pass the requesting story: `orchestrator-factory.ts:59` and `handlers/query-feature-context.ts:68`. `this.story` inside the provider is the consumer, never the dependency.
- **Coverage is complete.** Fragment chunks carry `role: ["implementer", "reviewer", "tdd"]`. The three sessions with observed failures map to `tdd-test-writer` (role `tdd`), `tdd-verifier` (role `tdd`) and `tdd-implementer` (role `implementer`) per `stage-config.ts:154-172`. All three receive fragments.
- **Nothing downstream parses `## Files touched`.** The only producer is `store.ts:201`; the only other repo hit is `debate/verifiers/checks.ts:48`, which refers to a *story description* section of the same name — a different artifact. Do not "unify" them.
- **No chunk cache.** Chunk id is `feature-fragment:${storyId}` with no content hash, and the orchestrator holds no cross-stage chunk cache, so a read-time transform cannot go stale.
- **The renderer passes bodies through verbatim** under `## Feature Context`, joined by `\n\n---\n\n` (`context/engine/render.ts:23-30`). Whatever the transform emits is what the model sees.

### Explicitly out of scope

Do not do these in this change. Each is its own issue/PR:

1. **`getDiffFilePaths` applies no exclusions** (`completion.ts:351`), so `packages/lib/.nax/cache/test-patterns.json` lands in fragments. The fix is **not** copying `ALWAYS_EXCLUDED` — verified from `cwd=packages/lib`, `':!.nax/'` still leaves `packages/app/.nax/cache/y.json` in the output, because pathspecs resolve relative to cwd. Only the `':(top,exclude).nax'` + `':(top,glob,exclude)**/.nax/**'` form is clean for a repo-rooted frame.
2. **Six tool descriptions claim "relative to the repository root"** (`read.ts:37,43`, `glob.ts:29,32`, `grep.ts:71,80`, `edit.ts:32`, `write.ts:19`, `delete.ts:72`, `git-commit.ts:46`) while the containment root is `codingToolRoot` = the package workdir (`agents/types.ts:186`, set at `operations/call.ts:254`). That mis-description — not the fragment — is what produced the *implementer* failures in the issue's table.
3. **`packageDirRelative(projectDir, workdir)`** (`utils/paths.ts:21`) is the naive `relative()` described in the trap above, called with worktree-poisoned arguments at `stages/context.ts:144` and `stages/routing.ts:143`. Its comment reasons about segment-doubling but never about the `.nax-wt` prefix.
4. **`CodeNeighborProvider` compares and emits sibling-package paths in the wrong frame** — filed as **#2074**. Its reverse-dependency loop puts a sibling-rooted `srcFile` and the consumer-rooted `filePath` on either side of `===` (`code-neighbor.ts:257`, `:262-264`), producing false reverse-deps, and then renders the sibling-frame path unqualified. That is the silent-misread class, strictly worse than #2072. **#2074's own fix direction depends on the ruling this plan implements** — it should re-spell in-package neighbours and mark cross-package ones with the same marker string defined in `src/context/fragments/reframe.ts`. Do not change `code-neighbor.ts` here, but do keep `UNREADABLE_MARKER` exported-able for that later reuse.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/context/fragments/reframe.ts` **(create, ~60 lines)** | The pure transform. Read-side counterpart to `renderFragmentBody` in `store.ts`, hence the sibling location. No I/O, no config, no logging. |
| `src/context/fragments/index.ts` **(modify)** | Add one export line. |
| `src/context/engine/providers/feature-context.ts` **(modify, ~6 lines)** | Call the transform at the single `content: body` seam, before token measurement. |
| `test/unit/context/fragments/reframe.test.ts` **(create)** | Unit tests for the pure function. |
| `test/unit/context/engine/providers/feature-context-fragments.test.ts` **(modify)** | Two integration tests: content is reframed, and `tokens` reflects the reframed body. |

---

### Task 1: The pure reframe function

**Files:**
- Create: `src/context/fragments/reframe.ts`
- Modify: `src/context/fragments/index.ts`
- Test: `test/unit/context/fragments/reframe.test.ts`

**Interfaces:**
- Consumes: nothing. This task has no dependencies.
- Produces: `reframeFilesTouched(body: string, consumerWorkdir: string | undefined): string`, exported from `@/context/fragments`. Task 2 calls exactly this.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/context/fragments/reframe.test.ts`:

```ts
/**
 * nax#2072 (ruling C) — read-time reframing of a fragment's `## Files touched`.
 *
 * A fragment records repo-rooted paths. The story consuming it has its file
 * tools contained at its own package dir, so an entry is either re-spelled
 * package-relative (readable) or marked as lying outside that root.
 *
 * Pure function, no I/O — no deps injection needed.
 */

import { describe, expect, test } from "bun:test";
import { reframeFilesTouched } from "@/context/fragments";

/** Mirrors `renderFragmentBody` (src/context/fragments/store.ts:201). */
function body(files: readonly string[]): string {
  const filesLines = files.map((f) => `- ${f}`).join("\n");
  return `# US-001 — Add isBlank\n\n## Files touched\n${filesLines}\n\n## Acceptance criteria\n- isBlank("") is true\n`;
}

describe("reframeFilesTouched (nax#2072)", () => {
  test("returns the body byte-identically when the consumer has no workdir", () => {
    const input = body(["packages/lib/src/util.ts"]);

    expect(reframeFilesTouched(input, undefined)).toBe(input);
    expect(reframeFilesTouched(input, "")).toBe(input);
    expect(reframeFilesTouched(input, ".")).toBe(input);
  });

  test("re-spells an in-package entry relative to the consumer's package", () => {
    const out = reframeFilesTouched(body(["packages/app/src/index.ts"]), "packages/app");

    expect(out).toContain("- src/index.ts");
    expect(out).not.toContain("packages/app/src/index.ts");
  });

  test("keeps a cross-package entry repo-rooted and marks it unreadable", () => {
    const out = reframeFilesTouched(body(["packages/lib/src/util.ts"]), "packages/app");

    expect(out).toContain("- packages/lib/src/util.ts (other package - not readable from this story's workdir)");
  });

  test("handles a mixed list, one entry per line", () => {
    const out = reframeFilesTouched(
      body(["packages/lib/src/util.ts", "packages/app/src/index.ts"]),
      "packages/app",
    );

    expect(out).toContain("- packages/lib/src/util.ts (other package - not readable from this story's workdir)");
    expect(out).toContain("- src/index.ts");
  });

  test("marks a sibling package whose name merely prefixes the consumer's", () => {
    // `packages/application` must NOT be treated as inside `packages/app`.
    // A raw startsWith would emit the corrupt path "lication/src/x.ts".
    const out = reframeFilesTouched(body(["packages/application/src/x.ts"]), "packages/app");

    expect(out).toContain("- packages/application/src/x.ts (other package - not readable from this story's workdir)");
    expect(out).not.toContain("lication/src/x.ts (other");
  });

  test("leaves the acceptance-criteria section untouched", () => {
    const out = reframeFilesTouched(body(["packages/lib/src/util.ts"]), "packages/app");

    expect(out).toContain('- isBlank("") is true');
    expect(out).not.toContain('isBlank("") is true (other package');
  });

  test("returns the body unchanged when there is no Files touched section", () => {
    const input = "# US-001 — Add isBlank\n\n## Acceptance criteria\n- packages/lib/src/util.ts is covered\n";

    expect(reframeFilesTouched(input, "packages/app")).toBe(input);
  });

  test("tolerates a body truncated mid-section", () => {
    const input = "# US-001 — Add isBlank\n\n## Files touched\n- packages/lib/src/util.ts";

    expect(reframeFilesTouched(input, "packages/app")).toBe(
      "# US-001 — Add isBlank\n\n## Files touched\n- packages/lib/src/util.ts (other package - not readable from this story's workdir)",
    );
  });

  test("normalises a backslash-spelled consumer workdir", () => {
    const out = reframeFilesTouched(body(["packages/app/src/index.ts"]), "packages\\app");

    expect(out).toContain("- src/index.ts");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
bun test ./test/unit/context/fragments/reframe.test.ts --timeout=60000
```

Expected: FAIL — `reframeFilesTouched` is not exported from `@/context/fragments`.

- [ ] **Step 3: Write the implementation**

Create `src/context/fragments/reframe.ts`:

```ts
/**
 * Read-side reframing of a fragment's `## Files touched` list (nax#2072).
 *
 * `renderFragmentBody` (./store.ts) records repo-rooted paths, because a
 * fragment is a cross-story, cross-package artifact and repo-rooted is the
 * only spelling that identifies a file in another package unambiguously.
 * But the story that later CONSUMES the fragment has its file tools
 * contained at its own package dir (`codingToolRoot`, see
 * src/agents/types.ts:186), so `packages/lib/src/util.ts` resolves to
 * `<pkg>/packages/lib/src/util.ts` and fails to read.
 *
 * The reader is the only layer that knows both roots, so the re-spelling
 * happens here rather than at capture. Two outcomes per entry:
 *
 *   - inside the consumer's package -> re-spelled package-relative, readable
 *   - outside it                    -> kept repo-rooted, marked unreadable
 *
 * Adding `--relative` to the capture-side git call instead would be worse,
 * not better: it re-spells AND restricts to cwd, so cross-package entries
 * would vanish and `packages/app/src/util.ts` -- a real, different file --
 * would be read in place of `packages/lib/src/util.ts`. A loud ENOENT
 * traded for a silent misread.
 */

/** Heading emitted by `renderFragmentBody`; the section this module rewrites. */
const FILES_TOUCHED_HEADING = "## Files touched";

/**
 * Appended to an entry outside the consumer's package.
 *
 * ASCII only and no em dash: this string is rendered into agent prompts and
 * asserted byte-for-byte in tests.
 */
const UNREADABLE_MARKER = " (other package - not readable from this story's workdir)";

/** Posix-normalised, trailing separators removed. */
function toPosix(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * The consumer's package path, or undefined when there is nothing to reframe.
 *
 * Undefined covers three real cases, all of which must degrade to a
 * byte-identical body: a single-package repo, a root-package story, and a
 * story whose PRD left `workdir` null (nax#2067).
 */
function normalisePrefix(consumerWorkdir: string | undefined): string | undefined {
  if (!consumerWorkdir) return undefined;
  const prefix = toPosix(consumerWorkdir.trim());
  return !prefix || prefix === "." ? undefined : prefix;
}

/**
 * Reframe one list line. Non-list lines pass through untouched so blank
 * lines and any future prose in the section survive.
 *
 * The prefix test is `${prefix}/` rather than `prefix`, on a segment
 * boundary: consumer `packages/app` against entry `packages/application/...`
 * must be marked, not sliced into the corrupt path `lication/...`.
 */
function reframeEntry(line: string, prefix: string): string {
  if (!line.startsWith("- ")) return line;
  const path = toPosix(line.slice(2).trim());
  if (!path || path === prefix) return line;
  if (path.startsWith(`${prefix}/`)) return `- ${path.slice(prefix.length + 1)}`;
  return `- ${path}${UNREADABLE_MARKER}`;
}

/**
 * Rewrite the `## Files touched` entries of `body` for a consuming story
 * rooted at `consumerWorkdir`.
 *
 * `consumerWorkdir` MUST be the PRD-declared `story.workdir` (repo-relative,
 * schema-guaranteed traversal-free). It must NOT be derived as
 * `relative(repoRoot, packageDir)`: under worktree isolation `packageDir` is
 * `<root>/.nax-wt/<storyId>/<pkg>` while `repoRoot` is the main checkout, so
 * that derivation yields `.nax-wt/<storyId>/<pkg>`, matches nothing, and
 * silently marks every entry cross-package. Same trap as nax#2069.
 *
 * A body with no `## Files touched` heading is returned unchanged, which
 * also future-proofs this against the LLM-backed extractor deferred at
 * ./store.ts:186.
 */
export function reframeFilesTouched(body: string, consumerWorkdir: string | undefined): string {
  const prefix = normalisePrefix(consumerWorkdir);
  if (!prefix) return body;

  const lines = body.split("\n");
  const headingIndex = lines.findIndex((line) => line.trim() === FILES_TOUCHED_HEADING);
  if (headingIndex === -1) return body;

  const nextHeading = lines.findIndex((line, index) => index > headingIndex && line.startsWith("## "));
  const sectionEnd = nextHeading === -1 ? lines.length : nextHeading;

  return [
    ...lines.slice(0, headingIndex + 1),
    ...lines.slice(headingIndex + 1, sectionEnd).map((line) => reframeEntry(line, prefix)),
    ...lines.slice(sectionEnd),
  ].join("\n");
}
```

Add the export to `src/context/fragments/index.ts` (keep the existing alphabetical block intact, then append a second export statement):

```ts
export { reframeFilesTouched } from "./reframe";
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
bun test ./test/unit/context/fragments/reframe.test.ts --timeout=60000
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Lint and typecheck**

```bash
bun run lint && bun run typecheck
```

Expected: clean. If biome reorders the exports in `index.ts`, accept its ordering.

- [ ] **Step 6: Commit**

```bash
git add src/context/fragments/reframe.ts src/context/fragments/index.ts test/unit/context/fragments/reframe.test.ts
git commit -m "fix(context): reframe fragment file paths for the consuming story's package (#2072)"
```

---

### Task 2: Wire the transform into the fragment read path

**Files:**
- Modify: `src/context/engine/providers/feature-context.ts` (import block near `:22-25`; `collectFragmentChunks` body at `:370-388`)
- Test: `test/unit/context/engine/providers/feature-context-fragments.test.ts` (append a new `describe` block at the end)

**Interfaces:**
- Consumes: `reframeFilesTouched(body: string, consumerWorkdir: string | undefined): string` from `@/context/fragments` (Task 1).
- Produces: no new exported symbol. Behaviour change only: `RawChunk.content` for `feature-fragment:*` chunks is reframed, and `RawChunk.tokens` measures the reframed body.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/context/engine/providers/feature-context-fragments.test.ts`. The file's existing `beforeEach`/`afterEach` already save and restore `_featureContextV2Deps`, and the helpers `mockV1Empty`, `mockLoadPRD`, `mockListFragmentStoryIds`, `mockReadFragment`, `prdWith`, `storyWith`, `makeFragmentsConfig`, `makeRequest` and `fragmentChunks` are defined at the top of the file — reuse them, do not redefine them.

```ts
// ─────────────────────────────────────────────────────────────────────────────
// nax#2072: fragment paths are reframed for the consuming story's package
// ─────────────────────────────────────────────────────────────────────────────

describe("FeatureContextProviderV2 — fragment path reframing (nax#2072)", () => {
  const dependencyFragment =
    "# US-001 — Add isBlank\n\n" +
    "## Files touched\n" +
    "- packages/lib/src/util.ts\n" +
    "- packages/app/src/index.ts\n\n" +
    "## Acceptance criteria\n" +
    "- isBlank works\n";

  /** US-002 (in packages/app) depends on US-001 (in packages/lib). */
  async function fetchForConsumer(consumerWorkdir: string | undefined): Promise<RawChunk[]> {
    mockV1Empty();
    mockLoadPRD(prdWith([storyWith("US-001"), storyWith("US-002", ["US-001"])]));
    mockListFragmentStoryIds(["US-001"]);
    mockReadFragment({ "US-001": dependencyFragment });

    const consumer = makeStory({ id: "US-002", dependencies: ["US-001"], workdir: consumerWorkdir });
    const provider = new FeatureContextProviderV2(consumer, makeFragmentsConfig());
    const result = await provider.fetch(makeRequest({ storyId: "US-002" }));
    return fragmentChunks(result.chunks);
  }

  test("marks the cross-package entry and re-spells the in-package one", async () => {
    const chunks = await fetchForConsumer("packages/app");
    const chunk = assertDefined(chunks[0]);

    expect(chunk.content).toContain(
      "- packages/lib/src/util.ts (other package - not readable from this story's workdir)",
    );
    expect(chunk.content).toContain("- src/index.ts");
    expect(chunk.content).not.toContain("- packages/app/src/index.ts");
  });

  test("leaves the fragment untouched for a root-package consumer", async () => {
    const chunks = await fetchForConsumer(undefined);
    const chunk = assertDefined(chunks[0]);

    expect(chunk.content).toBe(dependencyFragment);
  });

  test("tokens measure the reframed body, not the raw one", async () => {
    const chunks = await fetchForConsumer("packages/app");
    const chunk = assertDefined(chunks[0]);

    // The marker makes the body longer than what was read from disk; a
    // measurement taken before the transform would under-count the budget.
    expect(chunk.tokens).toBe(Math.ceil(chunk.content.length / 4));
    expect(chunk.tokens).toBeGreaterThan(Math.ceil(dependencyFragment.length / 4));
  });
});
```

No import changes are needed. The file's line 21 already reads `import { assertDefined, makeNaxConfig, makePRD, makeStory } from "@test/helpers";` and line 24 already imports `RawChunk`. Verified against `main` @ `f81fb5658`.

`makeStory` spreads its overrides last and declares no `workdir` default (`test/helpers/mock-story.ts:3-17`), so `workdir: undefined` reaches the provider as undefined rather than being backfilled.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
bun test ./test/unit/context/engine/providers/feature-context-fragments.test.ts --timeout=60000
```

Expected: all three new tests FAIL.

- Tests 1 and 2 fail on the missing marker and the un-respelled path.
- Test 3 fails on its **second** assertion only. Its first assertion (`tokens === ceil(content.length / 4)`) passes vacuously today, because with no transform `content` is still the raw body. The second assertion (`tokens > ceil(dependencyFragment.length / 4)`) is strictly false until the marker lengthens the body, and it is the one pinning the measurement ordering. If test 3 ever passes before Step 3, the assertion has been weakened — do not proceed.

- [ ] **Step 3: Write the implementation**

In `src/context/engine/providers/feature-context.ts`, extend the existing `@/context/fragments` import (currently `listFragmentStoryIds as listFragmentStoryIdsImpl, readFragment as readFragmentImpl`):

```ts
import {
  listFragmentStoryIds as listFragmentStoryIdsImpl,
  readFragment as readFragmentImpl,
  reframeFilesTouched,
} from "@/context/fragments";
```

Then, inside `collectFragmentChunks`, replace:

```ts
      const body = await _featureContextV2Deps.readFragment(projectDir, featureId, storyId);
      if (body === null) continue;

      const bodyTokens = estimateTokens(body);
```

with:

```ts
      const rawBody = await _featureContextV2Deps.readFragment(projectDir, featureId, storyId);
      if (rawBody === null) continue;

      // nax#2072: the fragment records repo-rooted paths, but THIS story's
      // file tools are contained at its package dir, so a dependency's
      // `packages/lib/src/util.ts` resolves to `<pkg>/packages/lib/...` and
      // ENOENTs. Re-spell what is reachable, mark what is not.
      //
      // Before the budget check, not after: the marker lengthens the body,
      // and measuring the raw one under-counts `fragmentBudget`.
      //
      // The prefix is `story.workdir` (PRD-declared, repo-relative) and must
      // stay so. `relative(request.repoRoot, request.packageDir)` is NOT
      // equivalent: under worktree isolation `packageDir` is
      // `<root>/.nax-wt/<storyId>/<pkg>` while `repoRoot` is the main
      // checkout, so it yields `.nax-wt/<storyId>/<pkg>` and mis-classifies
      // every entry. Same trap as nax#2069.
      const body = reframeFilesTouched(rawBody, this.story.workdir);

      const bodyTokens = estimateTokens(body);
```

Leave the rest of the loop — the `usedTokens + bodyTokens > fragmentBudget` check, `content: body`, `tokens: bodyTokens` — exactly as it is.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
bun test ./test/unit/context/engine/providers/feature-context-fragments.test.ts --timeout=60000
bun test ./test/unit/context/fragments/ --timeout=60000
```

Expected: PASS, including every pre-existing US-003 test in the file.

No pre-existing fragment test sets a story `workdir` — verified across `feature-context-fragments.test.ts`, `feature-context-fragments-realfs.test.ts`, `test/unit/context/engine/query-feature-context-fragments.test.ts`, `test/unit/cli/context-fragments.test.ts` and `test/unit/context/fragments/`. Every one of them therefore takes the undefined-prefix path and must stay byte-identically green. **Any** pre-existing failure means the transform is firing when it should not — fix `normalisePrefix`, do not adjust the old test.

- [ ] **Step 5: Run the full gate**

```bash
bun run lint && bun run typecheck && bun run test && bun run test:coverage
```

Expected: all clean. `test:coverage` is required because this change added a `src/` file and it is not part of `check:all`.

- [ ] **Step 6: Commit**

```bash
git add src/context/engine/providers/feature-context.ts test/unit/context/engine/providers/feature-context-fragments.test.ts
git commit -m "fix(context): apply fragment path reframing at the read seam (#2072)"
```

---

### Task 3: End-to-end verification against the dogfood fixture

This task produces evidence for the PR body, not code. Do not skip it — the whole class of defect (#765, #768, #770) is *declared mechanisms that cannot execute*, and only a real assembly catches it.

**Files:**
- Read only: `../nax-context-dogfood/fixtures/monorepo-tiny/` (relative to the nax repo; adjust if your checkout differs)

**Interfaces:**
- Consumes: the wired provider from Task 2.
- Produces: a before/after prompt excerpt for the PR body.

- [ ] **Step 1: Confirm the fixture still reproduces the shape**

```bash
python3 -c "
import json
d=json.load(open('../nax-context-dogfood/fixtures/monorepo-tiny/.nax/features/monorepo-tiny/prd.json'))
for s in d['userStories']:
    print(s['id'], repr(s.get('workdir')), s.get('dependencies'))
"
```

Expected: `US-001 'packages/lib' []` and `US-002 'packages/app' ['US-001']`.

- [ ] **Step 2: Note the config gap before running anything**

The fixture's committed `.nax/config.json` sets `context.v2.enabled` but does **not** enable `context.v2.fragments`. A run will capture no fragments unless fragments are enabled via a profile or a local config edit. Record which you used.

- [ ] **Step 3: Capture the evidence**

Run the feature far enough for US-001 to complete and US-002 to assemble, then read US-002's `tdd-test-writer` prompt from the run's `prompt-audit` tree and copy the `## Feature Context` block.

Expected after the fix, for US-002 rooted at `packages/app`:

```
## Files touched
- packages/lib/src/util.ts (other package - not readable from this story's workdir)
- packages/lib/src/util.test.ts (other package - not readable from this story's workdir)
```

Confirm zero failed `Read` calls against a `packages/app/packages/lib/...` path in the run's tool-audit sink for that session. Note: the `.nax/cache/test-patterns.json` entry will still be present — that is out-of-scope item 1, not a regression.

- [ ] **Step 4: Open the PR**

Body must state: the ruling and why `--relative` was rejected; the `story.workdir` trap; the before/after prompt excerpt from Step 3; and the four out-of-scope items listed above, so none of them reads as an oversight. Close #2072.

---

## Self-Review

**Spec coverage.** The ruling has two halves — re-spell in-package, mark cross-package — both covered by Task 1 Steps 1/3 and pinned again at the integration level in Task 2. The `story.workdir` constraint is enforced by Task 2's implementation and documented at both the function and the call site. Degradation for absent `workdir` is covered by Task 1 test 1 and Task 2 test 2. The budget-ordering requirement is covered by Task 2 test 3. The four out-of-scope items are stated in Global Constraints scope and repeated in Task 3 Step 4 so they reach the PR body.

**Placeholder scan.** No TBD/TODO. Every code step carries the literal code. Every run step carries the literal command and its expected result.

**Type consistency.** `reframeFilesTouched(body: string, consumerWorkdir: string | undefined): string` is spelled identically in Task 1's Interfaces block, its implementation, its test import, and Task 2's call site. `UNREADABLE_MARKER`'s exact text — `" (other package - not readable from this story's workdir)"` — is byte-identical in the implementation and in all five tests that assert on it.

**One known soft spot.** Task 2 Step 2 expects the third test to pass before the wiring exists. That is called out in the step itself rather than pretended away; its value is as a regression pin on the measurement ordering, not as a red-to-green signal.
