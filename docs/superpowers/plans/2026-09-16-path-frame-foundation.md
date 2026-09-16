# Path-Frame Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish one declared path-frame convention in nax — repo-rooted internally, `story.workdir` always `"."`-or-a-package — and make violating it a build failure.

**Architecture:** A new pure module `src/utils/path-frame.ts` becomes the single source of truth for frame arithmetic and workdir interpretation. Every site that reads a story's `workdir` field directly is converted to one of three accessors, and a new gate script makes a raw read fail CI. `src/prd/schema.ts` is split so a later plan can add a field to it without breaching the size ratchet.

**Tech Stack:** Bun 1.4.0, TypeScript strict, `bun:test`, Biome.

**Spec:** `docs/superpowers/specs/2026-09-16-path-frame-convention-design.md`

**Scope:** This plan implements **PR 1 and PR 2 only** — the foundation. The three issue fixes that sit on top of it (#2071, #2067, #2074 — PRs 3, 4, 5 in the spec) each get their own plan, because each needs its own regression tests and its own review. This plan produces working, testable software on its own: at the end, the convention exists, is documented, and is enforced repo-wide with no exemptions.

## State at handover

Branch `feat/path-frame-convention` holds **three docs-only commits and zero code**:

```
bb4cf96ee  docs: implementation plan for the path-frame foundation (#2067)
7f0a94f33  docs: split iteration-runner.ts into its own PR (path-frame design)
290589115  docs: path-frame convention design (#2067, #2071, #2074)
```

Base is `main` @ `d78730b6d`. Nothing under `src/` has been touched. `bun run typecheck`, `bun run check:all` and `bun run lint:biome` all pass on this branch as of the handover, so any failure you see after Task 1 is yours.

Every line number in this plan was verified against that base, and every "replace this" snippet was confirmed to match its file **exactly once** — except the one case flagged explicitly in Task 7 Step 2, which is not uniquely matchable by design.

## Global Constraints

- **Branch:** `feat/path-frame-convention`, already created, currently at `bb4cf96ee` plus this review commit. Do not commit to `main`.
- **Never run bare `bun test`, and never `bun run nax`.** Both give confident false signals. Use `bun run test` for the full suite; for a fast single-file loop use `bun test ./path/to/file.test.ts --timeout=60000` (a path argument is always present).
- **`bun run test:coverage` is NOT part of `check:all`.** This plan adds files under `src/`, so it must be run before the final commit of Task 9.
- **File-size gate: 600 lines per `src/` file, 800 per `test/` file** (`scripts/check-file-sizes.ts:30`), with a baseline that recorded files may not exceed. `src/context/engine/providers/static-rules.ts` is at **exactly 600** — this plan touches it nowhere. `src/prd/schema.ts` is at **629 and baselined** — Task 4 reduces it.
- **No mutation.** Build new arrays/objects; never mutate a parameter or an array in place.
- **No emojis** in code, comments, or docs.
- **ASCII only in `UNREADABLE_MARKER`.** No em dash, no non-ASCII punctuation — it is rendered into agent prompts and compared byte-for-byte in tests.
- **Conventional commits** (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`). Attribution lines are disabled globally — do not add them.
- **Dependency injection:** external calls (spawn, fs, fetch) go through the `_deps` pattern. `path-frame.ts` performs no I/O at all, so it needs none.

---

## Orientation: read this before Task 1

Facts verified against `main` @ `d78730b6d`. Do not re-derive them.

**The two frames.** A story has an optional `workdir` (repo-relative package path). At runtime `ctx.workdir = join(projectDir, story.workdir)` is the **package** dir; `ctx.projectDir` / `request.repoRoot` is the **repo root**. A path is either repo-rooted (`packages/app/src/index.ts`) or package-relative (`src/index.ts`). The convention: internal path sets are repo-rooted; package-relative appears only at the agent-prompt boundary.

**`"."` is already the codebase's spelling for root.** Twelve sites collapse it today, including `utils/paths.ts:25`, `runtime/packages.ts:79` and `context/fragments/reframe.ts:51`. This plan makes the PRD layer speak it too.

**Why a gate and not three patches.** There are 19 raw reads of a story's `workdir` across 10 files, using three different idioms for "absent" (`?? ""`, `|| undefined`, `? :` truthiness), each of which lands differently on `"."`. Patching the known ones leaves the next author free to repeat it.

**The one behaviour change in this whole plan** is `execution/iteration-runner.ts:124` and it is deferred to Task 10. Everything in Tasks 6-8 is spelling only.

**Two corrections to the spec, already confirmed** — apply these, do not follow the spec's older wording:
1. `src/utils/git.ts:481` needs **no change**. The `.workdir` read is at its caller (`execution/pipeline-result-handler.ts:210`), and `if (scopePrefix)` at `git.ts:495` already omits the pathspec when the value is undefined.
2. `resolveStoryWorkdir` (`pipeline/stages/execution-helpers.ts:45`) takes a `string`, not a story. It has no `.workdir` read and needs no change.

**Import-cycle safety.** `path-frame.ts` must NOT import `UserStory` from `@/prd/types` — that risks closing a cycle caught by `bun run check:import-cycles`. It declares a structural parameter type instead.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/utils/path-frame.ts` **(create, ~90 lines)** | SSOT for frame arithmetic and workdir interpretation. Pure: no I/O, no config, no logging. |
| `test/unit/utils/path-frame.test.ts` **(create)** | Exhaustive unit tests for the pure functions. |
| `src/context/fragments/reframe.ts` **(modify)** | Stops owning `UNREADABLE_MARKER` and the prefix normalisation; imports both. Behaviour byte-identical. |
| `src/prd/schema-story.ts` **(create, ~440 lines)** | `validateStory` extracted verbatim from `schema.ts:69-499`, clearing the 629-line baselined breach. |
| `src/prd/schema.ts` **(modify)** | Retains parsing/entry points, re-exports nothing new. Drops to ~200 lines. |
| `scripts/check-story-workdir-access.ts` **(create, ~90 lines)** | Gate: a raw `.workdir` read on a story outside the allowlist fails CI. Includes the self-expiring exemption. |
| `test/unit/scripts/check-story-workdir-access.test.ts` **(create)** | Gate tests against fixture trees, following `check-nax-ai-imports.test.ts`. |
| 9 conversion files (Tasks 6-8) | Each swaps a raw read for an accessor. |
| `package.json` **(modify)** | Registers `check:story-workdir-access` in `lint:checks`. |
| `src/execution/iteration-runner.ts` **(modify, Task 10)** | The 4 deferred reads. |

---

### Task 1: Pure frame helpers

**Files:**
- Create: `src/utils/path-frame.ts`
- Test: `test/unit/utils/path-frame.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `normalizeWorkdir(workdir: string | null | undefined): string`, `isRootWorkdir(workdir: string | null | undefined): boolean`, `toRepoFrame(path: string, workdir: string | null | undefined): string`, `toPackageFrame(path: string, workdir: string | null | undefined): string | null`, `UNREADABLE_MARKER: string`.

`toPackageFrame`'s first consumer is the #2074 plan, not this one. It is written here because it is half of the convention and belongs with its sibling.

- [ ] **Step 1: Write the failing test**

Create `test/unit/utils/path-frame.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  isRootWorkdir,
  normalizeWorkdir,
  toPackageFrame,
  toRepoFrame,
  UNREADABLE_MARKER,
} from "@/utils/path-frame";

describe("normalizeWorkdir", () => {
  test.each([
    [undefined, "."],
    [null, "."],
    ["", "."],
    ["   ", "."],
    [".", "."],
    ["./", "."],
    ["packages/app", "packages/app"],
    ["packages/app/", "packages/app"],
    ["./packages/app", "packages/app"],
    ["././packages/app", "packages/app"],
    ["packages\\app", "packages/app"],
    ["  packages/app  ", "packages/app"],
  ])("normalizes %p to %p", (input, expected) => {
    expect(normalizeWorkdir(input as string | null | undefined)).toBe(expected);
  });
});

describe("isRootWorkdir", () => {
  test.each([[undefined], [null], [""], ["."], ["./"]])("treats %p as root", (input) => {
    expect(isRootWorkdir(input as string | null | undefined)).toBe(true);
  });

  test("treats a package path as not root", () => {
    expect(isRootWorkdir("packages/app")).toBe(false);
  });
});

describe("toRepoFrame", () => {
  test("is identity at root", () => {
    expect(toRepoFrame("src/index.ts", ".")).toBe("src/index.ts");
    expect(toRepoFrame("src/index.ts", undefined)).toBe("src/index.ts");
  });

  test("prefixes a package-relative path", () => {
    expect(toRepoFrame("src/index.ts", "packages/app")).toBe("packages/app/src/index.ts");
  });

  test("leaves an already repo-rooted path unchanged", () => {
    expect(toRepoFrame("packages/app/src/index.ts", "packages/app")).toBe("packages/app/src/index.ts");
  });

  test("does not treat a sibling package as already-framed", () => {
    // "packages/application" must not be read as "packages/app" + "lication".
    expect(toRepoFrame("packages/application/src/x.ts", "packages/app")).toBe(
      "packages/app/packages/application/src/x.ts",
    );
  });

  test("normalizes a leading ./ on the input path", () => {
    expect(toRepoFrame("./src/index.ts", "packages/app")).toBe("packages/app/src/index.ts");
  });
});

describe("toPackageFrame", () => {
  test("is identity at root", () => {
    expect(toPackageFrame("packages/app/src/index.ts", ".")).toBe("packages/app/src/index.ts");
  });

  test("strips the package prefix", () => {
    expect(toPackageFrame("packages/app/src/index.ts", "packages/app")).toBe("src/index.ts");
  });

  test("returns null for a path outside the package", () => {
    expect(toPackageFrame("packages/lib/src/util.ts", "packages/app")).toBeNull();
  });

  test("returns null on a sibling whose name shares a prefix", () => {
    expect(toPackageFrame("packages/application/src/x.ts", "packages/app")).toBeNull();
  });

  test("returns null for the package directory itself", () => {
    expect(toPackageFrame("packages/app", "packages/app")).toBeNull();
  });
});

describe("UNREADABLE_MARKER", () => {
  test("is the exact string the fragment reframe already ships", () => {
    expect(UNREADABLE_MARKER).toBe(" (other package - not readable from this story's workdir)");
  });

  test("is ASCII only", () => {
    // Rendered into agent prompts and compared byte-for-byte; an em dash here
    // would silently change every marked line.
    expect(/^[\x20-\x7E]*$/.test(UNREADABLE_MARKER)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test ./test/unit/utils/path-frame.test.ts --timeout=60000`
Expected: FAIL — cannot resolve module `@/utils/path-frame`.

- [ ] **Step 3: Write the implementation**

Create `src/utils/path-frame.ts`:

```ts
/**
 * Path-frame SSOT (nax#2067, #2071, #2074).
 *
 * nax holds relative file paths in two frames:
 *   - REPO-ROOTED     "packages/app/src/index.ts"
 *   - PACKAGE-RELATIVE "src/index.ts"
 *
 * The convention: every nax-internal path set is REPO-ROOTED. Package-relative
 * spelling appears only where a path crosses into a package-contained agent's
 * prompt, because agent file tools are rooted at `codingToolRoot` = the package
 * dir (src/agents/types.ts:182-197).
 *
 * `workdir` is always a string here. "." means the repo root. null, undefined
 * and "" are normalised away so no consumer has to invent its own spelling for
 * "absent" — three different spellings are what nax#2067 was.
 *
 * Pure by contract: no I/O, no config, no logging. Ambiguity that needs the
 * filesystem to resolve is handled at PRD write time, not here.
 *
 * See docs/superpowers/specs/2026-09-16-path-frame-convention-design.md.
 */

/**
 * Appended to a path that lies outside the consuming story's workdir.
 *
 * ASCII only and no em dash: rendered into agent prompts and asserted
 * byte-for-byte. Originally defined in src/context/fragments/reframe.ts for
 * nax#2072; moved here so nax#2074 marks cross-package neighbours with the
 * identical string.
 */
export const UNREADABLE_MARKER = " (other package - not readable from this story's workdir)";

/** Posix separators, no leading "./", no trailing "/". */
function toPosix(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/\/+$/, "");
}

/**
 * Collapse every spelling of "absent" or "root" to ".".
 *
 * This is the rule that lets the rest of nax stop branching on truthiness.
 */
export function normalizeWorkdir(workdir: string | null | undefined): string {
  if (!workdir) return ".";
  const normalized = toPosix(workdir);
  return normalized === "" || normalized === "." ? "." : normalized;
}

/** True when the workdir denotes the repo root. */
export function isRootWorkdir(workdir: string | null | undefined): boolean {
  return normalizeWorkdir(workdir) === ".";
}

/**
 * Re-spell a package-relative path into the canonical repo-rooted frame.
 *
 * A path already prefixed by `${workdir}/` on a SEGMENT boundary is treated as
 * already repo-rooted and returned unchanged. The boundary matters: consumer
 * "packages/app" against "packages/application/..." must not be read as
 * already-framed.
 *
 * The one ambiguous input is a package-relative path that itself begins with
 * the package's own name (a real "packages/app/..." directory located INSIDE
 * packages/app). It is pathological, and it cannot arise for a PRD written
 * after nax#2067's plan-time canonicalization. No mechanism is built for it.
 */
export function toRepoFrame(path: string, workdir: string | null | undefined): string {
  const prefix = normalizeWorkdir(workdir);
  const normalized = toPosix(path);
  if (prefix === ".") return normalized;
  if (normalized === prefix || normalized.startsWith(`${prefix}/`)) return normalized;
  return `${prefix}/${normalized}`;
}

/**
 * Re-spell a repo-rooted path for a consumer contained at `workdir`.
 *
 * Returns null when the path is not reachable from that root — callers render
 * those with UNREADABLE_MARKER rather than emitting a path that would resolve
 * to a real but WRONG file under the consumer's root.
 *
 * The package directory itself returns null: it is not a file within itself.
 */
export function toPackageFrame(path: string, workdir: string | null | undefined): string | null {
  const prefix = normalizeWorkdir(workdir);
  const normalized = toPosix(path);
  if (prefix === ".") return normalized;
  if (normalized.startsWith(`${prefix}/`)) return normalized.slice(prefix.length + 1);
  return null;
}
```

No imports: every function here is string arithmetic. Task 2 adds the one `node:path` import this module needs. Do not add it now — `lint:biome` runs with `--error-on-warnings` in the pre-commit hook, and an unused import fails Step 5.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test ./test/unit/utils/path-frame.test.ts --timeout=60000`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add src/utils/path-frame.ts test/unit/utils/path-frame.test.ts
git commit -m "feat(utils): path-frame SSOT for repo/package path spelling"
```

---

### Task 2: Story workdir accessors

**Files:**
- Modify: `src/utils/path-frame.ts`
- Test: `test/unit/utils/path-frame.test.ts`

**Interfaces:**
- Consumes: `normalizeWorkdir`, `isRootWorkdir` from Task 1.
- Produces: `StoryWorkdirLike` (interface `{ readonly workdir?: string }`), `storyWorkdir(story: StoryWorkdirLike): string`, `storyPackageDir(story: StoryWorkdirLike): string | undefined`, `storyAbsWorkdir(root: string, story: StoryWorkdirLike): string`. Tasks 6-8 and 10 consume all three.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/utils/path-frame.test.ts`:

```ts
import { storyAbsWorkdir, storyPackageDir, storyWorkdir } from "@/utils/path-frame";

describe("storyWorkdir", () => {
  test("returns a package path unchanged", () => {
    expect(storyWorkdir({ workdir: "packages/app" })).toBe("packages/app");
  });

  test.each([[{}], [{ workdir: undefined }], [{ workdir: "" }], [{ workdir: "." }]])(
    "returns '.' for %p",
    (story) => {
      expect(storyWorkdir(story)).toBe(".");
    },
  );
});

describe("storyPackageDir", () => {
  test("returns the package for a monorepo story", () => {
    expect(storyPackageDir({ workdir: "packages/app" })).toBe("packages/app");
  });

  test.each([[{}], [{ workdir: "." }], [{ workdir: "" }]])(
    "returns undefined for the root story %p",
    (story) => {
      // This is the contract quality/command-resolver.ts documents at :60 and
      // that "." would otherwise break, because "." is truthy.
      expect(storyPackageDir(story)).toBeUndefined();
    },
  );
});

describe("storyAbsWorkdir", () => {
  test("joins a package onto the root", () => {
    expect(storyAbsWorkdir("/repo", { workdir: "packages/app" })).toBe("/repo/packages/app");
  });

  test.each([[{}], [{ workdir: "." }]])("returns the root unchanged for %p", (story) => {
    expect(storyAbsWorkdir("/repo", story)).toBe("/repo");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test ./test/unit/utils/path-frame.test.ts --timeout=60000`
Expected: FAIL — `storyWorkdir` is not exported from `@/utils/path-frame`.

- [ ] **Step 3: Write the implementation**

Add the one import this module needs, at the top of `src/utils/path-frame.ts`:

```ts
import { join } from "node:path";
```

Then append:

```ts
/**
 * Structural shape of the one field these accessors read.
 *
 * Deliberately NOT `UserStory` from @/prd/types: src/utils/ must not
 * value-import from src/prd/, and check:import-cycles guards that. A
 * structural type keeps this module a leaf.
 */
export interface StoryWorkdirLike {
  readonly workdir?: string;
}

/**
 * The story's workdir, always a string. "." means the repo root.
 *
 * Use this wherever a workdir is needed as a value or a map key. Grouping on
 * the raw field produced "" and "." as distinct keys for the same root.
 */
export function storyWorkdir(story: StoryWorkdirLike): string {
  return normalizeWorkdir(story.workdir);
}

/**
 * The story's package dir, or undefined at the repo root.
 *
 * This is what every API taking "the monorepo package, if any" wants. Passing
 * a raw workdir instead re-introduces nax#2067: "." is truthy, so a root story
 * takes the monorepo branch.
 */
export function storyPackageDir(story: StoryWorkdirLike): string | undefined {
  const workdir = storyWorkdir(story);
  return workdir === "." ? undefined : workdir;
}

/** Absolute working directory for a story beneath `root`. */
export function storyAbsWorkdir(root: string, story: StoryWorkdirLike): string {
  const packageDir = storyPackageDir(story);
  return packageDir ? join(root, packageDir) : root;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test ./test/unit/utils/path-frame.test.ts --timeout=60000`
Expected: PASS.

- [ ] **Step 5: Verify no import cycle was introduced**

Run: `bun run check:import-cycles`
Expected: no new cycles reported.

- [ ] **Step 6: Commit**

```bash
git add src/utils/path-frame.ts test/unit/utils/path-frame.test.ts
git commit -m "feat(utils): story workdir accessors on the path-frame SSOT"
```

---

### Task 3: Point `reframe.ts` at the SSOT

**Files:**
- Modify: `src/context/fragments/reframe.ts`
- Test: `test/unit/context/fragments/reframe.test.ts` (existing, must stay green unchanged)

**Interfaces:**
- Consumes: `UNREADABLE_MARKER`, `normalizeWorkdir` from Task 1.
- Produces: no signature change. `reframeFilesTouched(body, consumerWorkdir)` behaves byte-identically.

**Why this is a move, not a rewrite.** `reframeEntry` (`reframe.ts:62-68`) returns a line **unchanged** when `path === prefix`, whereas `toPackageFrame` returns null there (which a caller would render with the marker). Routing `reframe.ts` through `toPackageFrame` would therefore be a behaviour change in a task whose whole point is that nothing changes. Keep `reframeEntry` exactly as it is; only the marker constant and the prefix normalisation move.

- [ ] **Step 1: Run the existing tests to establish the green baseline**

Run: `bun test ./test/unit/context/fragments/reframe.test.ts --timeout=60000`
Expected: PASS. Note the count — it must be identical at Step 4.

- [ ] **Step 2: Make the edit**

In `src/context/fragments/reframe.ts`:

Delete the local constant at `:34`:

```ts
const UNREADABLE_MARKER = " (other package - not readable from this story's workdir)";
```

Add an import — note this file currently has **no imports at all**, so this creates the import block, placed after the module docstring and before `FILES_TOUCHED_HEADING`:

```ts
import { normalizeWorkdir, UNREADABLE_MARKER } from "@/utils/path-frame";
```

Replace `normalisePrefix` (`:48-52`) with a delegating version:

```ts
/**
 * The consumer's package path, or undefined when there is nothing to reframe.
 *
 * Undefined covers three real cases, all of which must degrade to a
 * byte-identical body: a single-package repo, a root-package story, and a
 * story whose PRD left `workdir` null (nax#2067).
 *
 * Delegates to the path-frame SSOT so "." is collapsed in exactly one place.
 */
function normalisePrefix(consumerWorkdir: string | undefined): string | undefined {
  const prefix = normalizeWorkdir(consumerWorkdir);
  return prefix === "." ? undefined : prefix;
}
```

Leave `toPosix`, `reframeEntry` and `reframeFilesTouched` untouched.

- [ ] **Step 3: Run the existing tests again**

Run: `bun test ./test/unit/context/fragments/reframe.test.ts --timeout=60000`
Expected: PASS, with the identical test count from Step 1. Any change in behaviour is a bug in this task, not a test to update.

- [ ] **Step 4: Run the provider integration tests**

Run: `bun test ./test/unit/context/engine/providers/feature-context-fragments.test.ts --timeout=60000`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/context/fragments/reframe.ts
git commit -m "refactor(context): source UNREADABLE_MARKER from the path-frame SSOT"
```

---

### Task 4: Split `validateStory` out of `schema.ts`

**Files:**
- Create: `src/prd/schema-story.ts`
- Modify: `src/prd/schema.ts`
- Test: `test/unit/prd/schema.test.ts` (existing, 791 lines, must stay green unchanged)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `validateStory(raw: unknown, index: number, allIds: Set<string>, seenIds: Set<string>): UserStory`, exported from `src/prd/schema-story.ts`.

**Why:** `src/prd/schema.ts` is 629 lines against a 600 limit — a baselined breach that may not grow. The #2067 plan adds a `workdirSource` field to story validation and cannot do so until this lands. `validateStory` is `schema.ts:69-499`, 430 of those 629 lines, so extracting it clears the breach outright.

This is a pure move. No logic changes. Do not "improve" anything on the way.

- [ ] **Step 1: Establish the green baseline**

```bash
bun test ./test/unit/prd/schema.test.ts --timeout=60000
bun run check:file-sizes
```
Expected: tests PASS; file-sizes reports `15 grandfathered oversized files (baseline 15)`.

- [ ] **Step 2: Create the new file**

Create `src/prd/schema-story.ts` containing, moved verbatim from `schema.ts`:

- the module docstring, adapted to say it holds per-story validation
- `VALID_COMPLEXITY` (`:22`), `STORY_ID_NO_SEPARATOR` (`:25`), `NO_TEST_JUSTIFICATION_SIGNAL` (`:34`)
- `normalizeStoryId` (`:43`), `normalizeComplexity` (`:57`)
- `validateStory` (`:69-499`), changed only by adding `export`

Carry across exactly the imports those bodies use — do not add or drop any. Head the file with:

```ts
/**
 * Per-story PRD validation.
 *
 * Extracted from ./schema.ts, which was 629 lines against the 600-line gate
 * (scripts/check-file-sizes.ts). A pure move: no logic changed.
 */
```

- [ ] **Step 3: Update `schema.ts`**

Delete the moved declarations. Add:

```ts
import { validateStory } from "./schema-story";
```

If any of `normalizeStoryId`, `normalizeComplexity` or the three constants are still referenced elsewhere in `schema.ts`, export them from `schema-story.ts` and import them too — do not duplicate a definition.

- [ ] **Step 4: Verify the move changed nothing**

```bash
bun run typecheck
bun test ./test/unit/prd/schema.test.ts --timeout=60000
bun test ./test/unit/prd/ --timeout=60000
```
Expected: all PASS, with the same test counts as Step 1.

- [ ] **Step 5: Verify the ratchet improved**

```bash
bun run check:file-sizes
wc -l src/prd/schema.ts src/prd/schema-story.ts
```
Expected: `schema.ts` around 200 lines; `schema-story.ts` under 600. The gate still passes. `schema.ts` leaves the baseline entirely once it is under its limit (`check-file-sizes.ts:14`), so the baseline file may need regenerating — if the gate reports a stale entry, run `bun run check:file-sizes:update` and include the baseline change in this commit.

- [ ] **Step 6: Commit**

```bash
git add src/prd/schema.ts src/prd/schema-story.ts scripts/baselines/
git commit -m "refactor(prd): extract validateStory into schema-story.ts"
```

---

### Task 5: The gate script

**Files:**
- Create: `scripts/check-story-workdir-access.ts`
- Test: `test/unit/scripts/check-story-workdir-access.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a CLI gate. `bun run scripts/check-story-workdir-access.ts [root]` exits 0 when clean, 1 with violations listed on stderr. The optional root argument lets the test point it at a fixture tree — the same shape as `scripts/check-nax-ai-imports.ts:17`.

**Do NOT wire this into `package.json` in this task.** Nine files still hold raw reads; wiring now turns the repo red between tasks. Task 9 wires it, after the conversions.

**Detection rule.** Flag `X.workdir` where the receiver's final identifier segment is `story` (case-insensitive suffix, so `completedStory` and `this.story` both match) or the single letter `s` (the loop variable in `pipeline/stages/acceptance.ts:157`). Skip comment lines. This is a heuristic, and a false positive costs only an accessor call.

**Allowlist:** `src/prd/types.ts` (declares the field), `src/utils/path-frame.ts` (implements the accessors).

**Exemption:** `src/execution/iteration-runner.ts`, removed in Task 10.

**Self-expiry:** if an exempted file contains **zero** raw reads, the gate fails. Without this, a never-landed Task 10 leaves the gate permanently porous on the one file that matters, and the exemption quietly becomes the baseline this design exists to avoid.

- [ ] **Step 1: Write the failing test**

Create `test/unit/scripts/check-story-workdir-access.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { findViolations, isStoryReceiver } from "@scripts/check-story-workdir-access";

describe("isStoryReceiver", () => {
  test.each([["story"], ["this.story"], ["input.story"], ["ctx.story"], ["completedStory"], ["s"]])(
    "flags %p",
    (receiver) => {
      expect(isStoryReceiver(receiver)).toBe(true);
    },
  );

  test.each([["ctx"], ["input"], ["request"], ["gateCtx"], ["existing"], ["data"]])(
    "does not flag %p",
    (receiver) => {
      expect(isStoryReceiver(receiver)).toBe(false);
    },
  );
});

describe("findViolations", () => {
  test("flags a raw read", () => {
    const found = findViolations("a.ts", "const w = story.workdir ?? '';");
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(1);
  });

  test("flags a nested receiver", () => {
    expect(findViolations("a.ts", "reframe(body, this.story.workdir);")).toHaveLength(1);
  });

  test("ignores a non-story receiver", () => {
    expect(findViolations("a.ts", "const w = ctx.workdir;")).toHaveLength(0);
  });

  test("ignores line comments and doc comments", () => {
    expect(findViolations("a.ts", "// story.workdir is repo-relative")).toHaveLength(0);
    expect(findViolations("a.ts", " * When story.workdir is set, ...")).toHaveLength(0);
  });

  test("ignores an accessor call", () => {
    expect(findViolations("a.ts", "const w = storyWorkdir(story);")).toHaveLength(0);
  });

  test("reports every occurrence on separate lines", () => {
    const source = ["const a = story.workdir;", "const b = input.story.workdir;"].join("\n");
    expect(findViolations("a.ts", source)).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test ./test/unit/scripts/check-story-workdir-access.test.ts --timeout=60000`
Expected: FAIL — cannot resolve `scripts/check-story-workdir-access`.

- [ ] **Step 3: Write the implementation**

Create `scripts/check-story-workdir-access.ts`:

```ts
#!/usr/bin/env bun

/**
 * Fails if a story's `workdir` field is read directly.
 *
 * Read it through src/utils/path-frame.ts instead:
 *   storyWorkdir(story)          -> string, "." at the repo root
 *   storyPackageDir(story)       -> string | undefined, undefined at the root
 *   storyAbsWorkdir(root, story) -> absolute working directory
 *
 * Why the rule and not a set of patches (nax#2067): 19 raw reads across 10
 * files used THREE different spellings of "absent" -- `?? ""`, `|| undefined`
 * and `? :` truthiness -- and `workdir` is now always a string where "." means
 * the repo root. "." is truthy and is not "", so every one of those idioms
 * lands differently on it. Patching the known sites leaves the next author
 * free to add a fourth.
 *
 * Takes an optional root so the gate can be tested against a fixture tree.
 */

import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const ROOT = process.argv[2] ?? process.cwd();
const SCAN = join(ROOT, "src");

/** Files permitted to touch the raw field: it is declared and wrapped here. */
const ALLOWED = [join("src", "prd", "types.ts"), join("src", "utils", "path-frame.ts")];

/**
 * Temporary, single-entry, SELF-EXPIRING exemption.
 *
 * This file sits on the per-package-config seam nax#2066/#2069 just fixed, so
 * it converts in its own reviewable PR rather than inside a 9-file sweep. The
 * staleness check below makes the entry impossible to leave behind: once the
 * file is converted, an exemption that matches nothing FAILS the gate. Without
 * that, this list silently becomes the baseline the rule exists to avoid.
 */
const EXEMPT = [join("src", "execution", "iteration-runner.ts")];

const READ = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.workdir\b/g;

/** True when the receiver names a story rather than a context or an options bag. */
export function isStoryReceiver(receiver: string): boolean {
  const last = receiver.split(".").at(-1) ?? receiver;
  return last === "s" || /story$/i.test(last);
}

export interface Violation {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/** Scan one file's source for raw reads. Exported for tests. */
export function findViolations(file: string, source: string): Violation[] {
  const found: Violation[] = [];
  source.split("\n").forEach((text, index) => {
    const stripped = text.trim();
    if (stripped.startsWith("//") || stripped.startsWith("*") || stripped.startsWith("/*")) return;
    for (const match of stripped.matchAll(READ)) {
      const receiver = match[1] ?? "";
      if (isStoryReceiver(receiver)) found.push({ file, line: index + 1, text: stripped });
    }
  });
  return found;
}

async function* walk(dir: string): AsyncGenerator<string> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith(".ts")) yield full;
  }
}

/**
 * Scan the tree. Side effects live behind `import.meta.main` so the test can
 * import `findViolations` without the gate running -- and exiting -- on import.
 * Same guard as scripts/check-gate-reachability.ts:147.
 */
async function main(): Promise<void> {
  const violations: Violation[] = [];
  const exemptionsUsed = new Set<string>();

  for await (const file of walk(SCAN)) {
    const rel = relative(ROOT, file);
    if (ALLOWED.includes(rel)) continue;

    const found = findViolations(rel, await readFile(file, "utf8"));
    if (found.length === 0) continue;

    if (EXEMPT.includes(rel)) {
      exemptionsUsed.add(rel);
      continue;
    }
    violations.push(...found);
  }

  const stale = EXEMPT.filter((entry) => !exemptionsUsed.has(entry));

  if (violations.length > 0) {
    console.error("Read a story's workdir through src/utils/path-frame.ts, not the raw field:");
    console.error("  storyWorkdir(story) | storyPackageDir(story) | storyAbsWorkdir(root, story)");
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.text}`);
  }

  if (stale.length > 0) {
    console.error("Stale exemption in check-story-workdir-access.ts -- the file is clean, so remove it:");
    for (const entry of stale) console.error(`  ${entry}`);
  }

  if (violations.length > 0 || stale.length > 0) process.exit(1);

  console.log(`check-story-workdir-access: clean (${EXEMPT.length} exemption(s) still pending)`);
}

if (import.meta.main) {
  await main();
}
```

Two details that are load-bearing, both copied from existing gates:
- **`import.meta.main` guard.** Without it, the test's `import` runs the scan and can call `process.exit(1)`, killing the test process. `scripts/check-gate-reachability.ts:147` uses the identical guard for the identical reason.
- **Exact-path matching, not prefix matching.** `ALLOWED` and `EXEMPT` hold full relative paths compared with `includes`, so `check-nax-ai-imports.ts`'s `sep`-suffixed prefix trick is not needed here and `sep` is deliberately not imported — an unused import fails `lint:biome --error-on-warnings`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test ./test/unit/scripts/check-story-workdir-access.test.ts --timeout=60000`
Expected: PASS.

- [ ] **Step 5: Confirm the gate currently reports the real violations**

Run: `bun run scripts/check-story-workdir-access.ts`
Expected: exit 1, listing reads in the 9 files Tasks 6-8 convert, and **not** listing `iteration-runner.ts` (exempt). This failure is correct at this point in the plan.

- [ ] **Step 6: Commit**

```bash
git add scripts/check-story-workdir-access.ts test/unit/scripts/check-story-workdir-access.test.ts
git commit -m "feat(scripts): gate direct story.workdir reads"
```

---

### Task 6: Convert the grouping-key sites

**Files:**
- Modify: `src/pipeline/stages/acceptance.ts:157`
- Modify: `src/acceptance/test-path.ts:142`
- Modify: `src/acceptance/hardening.ts:299`

**Interfaces:**
- Consumes: `storyWorkdir`, `storyAbsWorkdir` from Task 2.
- Produces: nothing new.

These three build a `Map` keyed on the workdir. On the raw field a root story keys as `""`; under the convention it keys as `"."`. Grouping is internally consistent either way — what matters is that all three agree, which is why they convert together. `acceptance.ts:153` says its grouping is the *same SSOT* as `test-path.ts`, so a split conversion would break that stated invariant.

- [ ] **Step 1: Establish the green baseline**

```bash
bun test ./test/unit/acceptance/ --timeout=60000
bun test ./test/unit/pipeline/stages/ --timeout=60000
```
Expected: PASS. Note the counts.

- [ ] **Step 2: Convert `src/pipeline/stages/acceptance.ts`**

Replace lines 157-158:

```ts
      const wd = s.workdir ?? "";
      const pkgDir = wd ? path.join(ctx.workdir, wd) : ctx.workdir;
```

with:

```ts
      const pkgDir = storyAbsWorkdir(ctx.workdir, s);
```

Add to the imports:

```ts
import { storyAbsWorkdir } from "@/utils/path-frame";
```

- [ ] **Step 3: Convert `src/acceptance/test-path.ts`**

Replace line 142:

```ts
    const wd = story.workdir ?? "";
```

with:

```ts
    const wd = storyWorkdir(story);
```

Add to the imports:

```ts
import { storyWorkdir } from "@/utils/path-frame";
```

- [ ] **Step 4: Convert `src/acceptance/hardening.ts`**

Replace line 299:

```ts
      const wd = story.workdir ?? "";
```

with:

```ts
      const wd = storyWorkdir(story);
```

Add to the imports — this file imports relatively, so match that:

```ts
import { storyWorkdir } from "../utils/path-frame";
```

- [ ] **Step 5: Run the tests**

```bash
bun run typecheck
bun test ./test/unit/acceptance/ --timeout=60000
bun test ./test/unit/pipeline/stages/ --timeout=60000
```
Expected: PASS with the Step 1 counts. If a test asserts a `""` map key for a root story, that assertion encodes the old spelling — update it to `"."` and say so in the commit body.

- [ ] **Step 6: Commit**

```bash
git add src/pipeline/stages/acceptance.ts src/acceptance/test-path.ts src/acceptance/hardening.ts
git commit -m "refactor(acceptance): group stories by the path-frame accessor"
```

---

### Task 7: Convert the truthiness sites

**Files:**
- Modify: `src/operations/full-suite-gate.ts:135,148,155,255,317,324`
- Modify: `src/context/engine/tool-runtime.ts:99`
- Modify: `src/quality/command-resolver.ts:60` (doc comment only)

**Interfaces:**
- Consumes: `storyPackageDir` from Task 2.
- Produces: nothing new.

This is the task the gate exists for. `full-suite-gate.ts:135` feeds `resolveQualityTestCommands`, which branches on truthiness at `:76` and `:86`. Left raw, a root story with `workdir: "."` would newly resolve `{{package}}` and take the turbo/nx orchestrator promotion — swapping the plain root test command for `turbo run test --filter=<pkg>`. `storyPackageDir` returns `undefined` there, so the documented contract at `command-resolver.ts:60` becomes true by construction.

- [ ] **Step 1: Establish the green baseline**

```bash
bun test ./test/unit/operations/ --timeout=60000
bun test ./test/unit/quality/ --timeout=60000
bun test ./test/unit/context/engine/ --timeout=60000
```
Expected: PASS. Note the counts.

- [ ] **Step 2: Convert `src/operations/full-suite-gate.ts`**

Add to the imports (this file imports relatively — match its existing style):

```ts
import { storyPackageDir } from "../utils/path-frame";
```

**Do this as ONE whole-file replace-all** of the expression, not as six separate line edits:

```
    input.story.workdir   ->   storyPackageDir(input.story)
```

All six occurrences take the identical replacement, and the surrounding syntax stays valid in every case:

| Line | Indent | Before | After |
|---|---|---|---|
| 135 | 6 | `input.story.workdir,` | `storyPackageDir(input.story),` |
| 148 | 6 | `const pkg = input.story.workdir ?? input.workdir;` | `const pkg = storyPackageDir(input.story) ?? input.workdir;` |
| 155 | 10 | `packageDir: input.story.workdir,` | `packageDir: storyPackageDir(input.story),` |
| 255 | 6 | `packageDir: input.story.workdir,` | `packageDir: storyPackageDir(input.story),` |
| 317 | 8 | `packageDir: input.story.workdir,` | `packageDir: storyPackageDir(input.story),` |
| 324 | 8 | `packageDir: input.story.workdir,` | `packageDir: storyPackageDir(input.story),` |

**Why replace-all and not line-by-line:** `packageDir: input.story.workdir,` appears at three different indentations, and lines **317 and 324 are byte-identical**. A line-scoped edit keyed on that text is not uniquely matchable and will either fail or hit the wrong site. Replacing the bare expression is unambiguous — verified as exactly 6 occurrences in this file and 0 in comments.

Line 135 feeds `resolveQualityTestCommands`, which is the behaviour-relevant one. Lines 155, 255, 317 and 324 are log and error context, where `undefined` is already what a single-package repo emits.

- [ ] **Step 2a: Confirm the replace-all landed exactly**

```bash
grep -c "storyPackageDir(input.story)" src/operations/full-suite-gate.ts
grep -c "input.story.workdir" src/operations/full-suite-gate.ts
```
Expected: `6` and `0`.

- [ ] **Step 3: Convert `src/context/engine/tool-runtime.ts`**

This file imports via the `@/` alias — match that style here.

Line 99:

```ts
      resolvedTestPatternsPromise = resolveTestFilePatterns(config, repoRoot, story.workdir || undefined, {
```
becomes
```ts
      resolvedTestPatternsPromise = resolveTestFilePatterns(config, repoRoot, storyPackageDir(story), {
```

Add to the imports:

```ts
import { storyPackageDir } from "@/utils/path-frame";
```

- [ ] **Step 4: Update the `command-resolver.ts` contract comment**

Line 60:

```ts
 * @param storyWorkdir - story.workdir — set for monorepo stories, undefined for single-package
```
becomes
```ts
 * @param storyWorkdir - storyPackageDir(story) — the package for a monorepo story,
 *                       undefined at the repo root. Never pass the raw field: it is
 *                       "." at the root, which is truthy, and the branches below would
 *                       then promote a root story to the monorepo orchestrator path.
```

Change no code in this file.

- [ ] **Step 5: Run the tests**

```bash
bun run typecheck
bun test ./test/unit/operations/ --timeout=60000
bun test ./test/unit/quality/ --timeout=60000
bun test ./test/unit/context/engine/ --timeout=60000
```
Expected: PASS with the Step 1 counts.

- [ ] **Step 6: Commit**

```bash
git add src/operations/full-suite-gate.ts src/context/engine/tool-runtime.ts src/quality/command-resolver.ts
git commit -m "refactor(operations): take the story package dir from the path-frame accessor"
```

---

### Task 8: Convert the remaining raw passes

**Files:**
- Modify: `src/execution/build-plan-for-strategy.ts:228,229`
- Modify: `src/pipeline/stages/acceptance-setup.ts:333`
- Modify: `src/context/engine/providers/feature-context.ts:388`
- Modify: `src/execution/pipeline-result-handler.ts:210`

**Interfaces:**
- Consumes: `storyWorkdir`, `storyPackageDir`, `storyAbsWorkdir` from Task 2.
- Produces: nothing new.

`pipeline-result-handler.ts:210` is the site the spec discusses under `utils/git.ts:481`. `captureOutputFiles` guards with `if (scopePrefix)` at `git.ts:495`, so passing `undefined` at the root already omits the pathspec — the fix belongs at the caller, and `git.ts` itself needs no change.

`feature-context.ts:388` is the consumer of the #2072 fix. It must keep passing the PRD-declared workdir: `relative(request.repoRoot, request.packageDir)` is NOT equivalent, because under worktree isolation `packageDir` is `<root>/.nax-wt/<storyId>/<pkg>` while `repoRoot` is the main checkout, so it yields `.nax-wt/<storyId>/<pkg>` and mis-classifies every entry. `storyWorkdir(this.story)` preserves the correct source and additionally makes the call correct when the PRD left the field unset.

- [ ] **Step 1: Establish the green baseline**

```bash
bun test ./test/unit/execution/ --timeout=60000
bun test ./test/unit/context/engine/providers/feature-context-fragments.test.ts --timeout=60000
bun test ./test/unit/pipeline/stages/ --timeout=60000
```
Expected: PASS. Note the counts.

- [ ] **Step 2: Convert `src/execution/build-plan-for-strategy.ts`**

Lines 228-229:

```ts
  const { repoRoot, packageDir } = resolveStoryPathAnchors(ctx.packageDir, story.workdir);
  const resolvedTestPatterns = await resolveTestFilePatterns(config, repoRoot, story.workdir);
```
become
```ts
  const storyPkg = storyPackageDir(story);
  const { repoRoot, packageDir } = resolveStoryPathAnchors(ctx.packageDir, storyPkg);
  const resolvedTestPatterns = await resolveTestFilePatterns(config, repoRoot, storyPkg);
```

Add to the imports — this file imports relatively, so match that:

```ts
import { storyPackageDir } from "../utils/path-frame";
```

- [ ] **Step 3: Convert `src/pipeline/stages/acceptance-setup.ts`**

Line 333:

```ts
        const packageDir = story.workdir ? path.join(ctx.workdir, story.workdir) : ctx.workdir;
```
becomes
```ts
        const packageDir = storyAbsWorkdir(ctx.workdir, story);
```

Add to the imports:

```ts
import { storyAbsWorkdir } from "@/utils/path-frame";
```

- [ ] **Step 4: Convert `src/context/engine/providers/feature-context.ts`**

Line 388:

```ts
      const body = reframeFilesTouched(rawBody, this.story.workdir);
```
becomes
```ts
      const body = reframeFilesTouched(rawBody, storyWorkdir(this.story));
```

Add to the imports:

```ts
import { storyWorkdir } from "@/utils/path-frame";
```

Leave the explanatory comment block above it (`:378-387`) in place — it documents the worktree trap and is still correct.

- [ ] **Step 5: Convert `src/execution/pipeline-result-handler.ts`**

Line 210:

```ts
        const rawFiles = await captureOutputFiles(ctx.workdir, ctx.storyGitRef, completedStory.workdir);
```
becomes
```ts
        const rawFiles = await captureOutputFiles(ctx.workdir, ctx.storyGitRef, storyPackageDir(completedStory));
```

Add to the imports — this file imports relatively, so match that:

```ts
import { storyPackageDir } from "../utils/path-frame";
```

- [ ] **Step 6: Run the tests**

```bash
bun run typecheck
bun test ./test/unit/execution/ --timeout=60000
bun test ./test/unit/context/ --timeout=60000
bun test ./test/unit/pipeline/ --timeout=60000
```
Expected: PASS with the Step 1 counts.

- [ ] **Step 7: Commit**

```bash
git add src/execution/build-plan-for-strategy.ts src/pipeline/stages/acceptance-setup.ts \
        src/context/engine/providers/feature-context.ts src/execution/pipeline-result-handler.ts
git commit -m "refactor: read story workdir through the path-frame accessors"
```

---

### Task 9: Wire the gate into CI

**Files:**
- Modify: `package.json`

**Interfaces:**
- Consumes: the gate from Task 5; the conversions from Tasks 6-8.
- Produces: `check:story-workdir-access` as a package script reachable from `check:all`.

`check:gate-reachability` fails on any `scripts/check-*` file that no CI entry point reaches, so the gate is not merely unwired until this task — it is actively failing a different gate. This task is what makes the repo green.

- [ ] **Step 1: Confirm the gate now passes against the real tree**

Run: `bun run scripts/check-story-workdir-access.ts`
Expected: exit 0, printing `check-story-workdir-access: clean (1 exemption(s) still pending)`.

If any violation is listed, a Task 6-8 site was missed. Convert it before continuing.

- [ ] **Step 2: Register the script**

In `package.json`, add alongside the other gate entries:

```json
    "check:story-workdir-access": "bun run scripts/check-story-workdir-access.ts",
```

and append it to the `lint:checks` chain, after `check:nax-artifacts-untracked`:

```
&& bun run check:story-workdir-access
```

- [ ] **Step 3: Verify reachability**

```bash
bun run check:story-workdir-access
bun run check:gate-reachability
```
Expected: both pass; reachability reports all **26** check scripts reachable (25 before this plan).

- [ ] **Step 4: Run the full gate suite and the coverage gate**

```bash
bun run typecheck
bun run check:all
bun run test
bun run test:coverage
```
Expected: all pass. `test:coverage` is not part of `check:all` and this plan added files under `src/`, so it must run here.

- [ ] **Step 5: Commit**

```bash
git add package.json
git commit -m "ci: enforce story workdir access through the path-frame accessors"
```

---

### Task 10: Convert `iteration-runner.ts` and retire the exemption

**Files:**
- Modify: `src/execution/iteration-runner.ts:124,139,167-171`
- Modify: `scripts/check-story-workdir-access.ts` (delete the `EXEMPT` entry)

**Interfaces:**
- Consumes: `storyPackageDir`, `storyAbsWorkdir` from Task 2.
- Produces: an empty `EXEMPT` list — the gate becomes absolute.

**This is PR 2.** It is separate because it sits on the per-package-config seam that #2066/#2069 fixed in `46310bdbe`, and because `:124` is the only conversion in the entire plan that changes behaviour.

`:124` on the raw field with `workdir: "."`: `"."` is truthy, so the ternary stops short-circuiting to `ctx.config` and instead looks up `.nax/mono/./config.json`. `config/loader.ts:435` misses, logs `Per-package config not found — falling back to root config`, and returns the root config. Same config, reached via wasted I/O and a misleading log line on every root story. `storyPackageDir` restores the clean early return at `loader.ts:435-438`.

The other three reads are benign, because `join(x, ".")` is `x`.

- [ ] **Step 1: Establish the green baseline**

```bash
bun test ./test/unit/execution/iteration-runner.test.ts --timeout=60000
bun test ./test/unit/execution/iteration-runner-worktree.test.ts --timeout=60000
bun test ./test/unit/execution/ --timeout=60000
bun test ./test/unit/config/ --timeout=60000
```
Expected: PASS. Note the counts. Three iteration-runner suites exist and all three must stay green: `iteration-runner.test.ts`, `iteration-runner-worktree.test.ts` and `iteration-runner-memory.test.ts` — the worktree one is the direct guard on Step 4's change.

- [ ] **Step 2: Convert the config branch at `:124`**

```ts
  const effectiveConfig = story.workdir
    ? await _iterationRunnerDeps.loadConfigForWorkdir(
        join(ctx.workdir, ".nax", "config.json"),
        story.workdir,
        profileOverride,
      )
    : ctx.config;
```
becomes
```ts
  // nax#2067: storyPackageDir, never the raw field. "." is truthy, so the raw
  // field would send a ROOT story into loadConfigForWorkdir, which then misses
  // .nax/mono/./config.json and falls back to the root config anyway -- same
  // result, one wasted read and a misleading log line per story.
  const storyPkg = storyPackageDir(story);
  const effectiveConfig = storyPkg
    ? await _iterationRunnerDeps.loadConfigForWorkdir(
        join(ctx.workdir, ".nax", "config.json"),
        storyPkg,
        profileOverride,
      )
    : ctx.config;
```

Add to the imports — this file imports relatively, so match that:

```ts
import { storyAbsWorkdir, storyPackageDir } from "../utils/path-frame";
```

- [ ] **Step 3: Convert the worktree-dependency call at `:139`**

```ts
        storyWorkdir: story.workdir,
```
becomes
```ts
        storyWorkdir: storyPkg,
```

- [ ] **Step 4: Collapse the `resolvedWorkdir` ternary at `:167-171`**

```ts
  const resolvedWorkdir = dependencyContext?.cwd
    ? dependencyContext.cwd
    : ctx.config.execution.storyIsolation === "worktree"
      ? story.workdir
        ? join(effectiveWorkdir, story.workdir)
        : effectiveWorkdir
      : story.workdir
        ? join(ctx.workdir, story.workdir)
        : ctx.workdir;
```
becomes
```ts
  // EXEC-002: in worktree mode effectiveWorkdir is the worktree root, so a
  // monorepo subpackage resolves beneath it rather than beneath the main
  // checkout. storyAbsWorkdir returns the base unchanged for a root story.
  const isolationRoot =
    ctx.config.execution.storyIsolation === "worktree" ? effectiveWorkdir : ctx.workdir;
  const resolvedWorkdir = dependencyContext?.cwd ?? storyAbsWorkdir(isolationRoot, story);
```

The comment at `:163-166` is superseded by the one above; delete the old block rather than leaving both.

- [ ] **Step 5: Run the tests**

```bash
bun run typecheck
bun test ./test/unit/execution/ --timeout=60000
bun test ./test/unit/config/ --timeout=60000
```
Expected: PASS with the Step 1 counts. These are the #2066/#2069 tests — a failure here means the conversion changed per-package config resolution and must be investigated, not patched around.

- [ ] **Step 6: Verify the exemption is now stale**

Run: `bun run check:story-workdir-access`
Expected: exit 1 with `Stale exemption in check-story-workdir-access.ts -- the file is clean, so remove it:` naming `src/execution/iteration-runner.ts`.

This failure is the self-expiry working. If the gate instead passes, the conversion missed a read or the staleness check is wrong.

- [ ] **Step 7: Delete the exemption**

In `scripts/check-story-workdir-access.ts`, replace the `EXEMPT` constant and its doc comment with:

```ts
/**
 * No exemptions. The single temporary entry (src/execution/iteration-runner.ts,
 * nax#2066/#2069 seam) was retired when that file converted. The staleness
 * check below is retained: it is what keeps a future exemption temporary.
 */
const EXEMPT: string[] = [];
```

Leave the staleness logic in place — it is inert with an empty list and is the mechanism that stops the list growing a permanent entry later.

- [ ] **Step 8: Verify the gate is now absolute**

```bash
bun run check:story-workdir-access
bun test ./test/unit/scripts/check-story-workdir-access.test.ts --timeout=60000
```
Expected: gate exits 0 with `check-story-workdir-access: clean (0 exemption(s) still pending)`; tests PASS.

- [ ] **Step 9: Run everything**

```bash
bun run typecheck
bun run check:all
bun run test
```
Expected: all pass.

- [ ] **Step 10: Commit**

```bash
git add src/execution/iteration-runner.ts scripts/check-story-workdir-access.ts
git commit -m "refactor(execution): iteration-runner reads workdir through path-frame (#2067)"
```

---

## Done criteria

- `bun run check:all` passes, including `check:story-workdir-access` reporting `0 exemption(s) still pending`.
- `bun run test` and `bun run test:coverage` pass.
- `bun run check:file-sizes` passes, with `src/prd/schema.ts` no longer in the baseline.
- No file under `src/` reads a story's `workdir` field directly except `src/prd/types.ts` and `src/utils/path-frame.ts`.

## What this plan does NOT do

Each of these is a separate plan built on this foundation. Do not start them here.

- **#2071** — mapping `scope-files.ts` declared paths through `toRepoFrame`, plus the anti-reversal comment on `collectDiffFileList`.
- **#2067** — plan-time PRD canonicalization, the `workdirSource` field (which needs Task 4's split), the critic warning, and the `plan-builder.ts` frame instruction.
- **#2074** — absolute-path neighbour comparison, sibling-scan removal, `crossPackageDepth` retirement, ADR-010 and guide amendments. This is `toPackageFrame`'s first consumer.
- Seams 5 through 10 in the spec's table, which are filed as issues rather than fixed.
