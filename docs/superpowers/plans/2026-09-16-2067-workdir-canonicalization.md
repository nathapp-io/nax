# Workdir Canonicalization Implementation Plan (#2067)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `nax plan` assign every story a `workdir` whenever its declared files resolve to exactly one workspace package, canonicalize declared paths to the repo frame in the same pass, record which of the three ways the workdir was decided, and warn when a story lands `defaulted` in a repo that has per-package overlays.

**Architecture:** One new pure module, `src/prd/workdir-canonical.ts`, owns the probe-driven derivation and path re-spelling. It is wired into `finalizeAndWritePrd` (`src/plan/strategies/persist-prd.ts`) — the single seam every `nax plan` write already passes through — so no strategy can drift on whether it ran. A new optional story field `workdirSource` records `stated | derived | defaulted`, and a new plan-checklist verifier turns a `defaulted` story in a `.nax/mono/` repo into a visible warning.

**Tech Stack:** Bun 1.4.0, TypeScript strict, `bun:test`, Biome.

**Spec:** `docs/superpowers/specs/2026-09-16-path-frame-convention-design.md`, section **`#2067 — workdir null`**.

**Scope:** PR 4 of the 5-PR path-frame arc. PRs 1, 2 and 3 are merged. PR 5 (#2074) is a separate plan and must not be started here.

## Global Constraints

- **Branch:** create `fix/2067-workdir-canonicalization` from `main` @ `0e4113d23`. Do not commit to `main`.
- **Never run bare `bun test`, and never `bun run nax`.** Both give confident false signals. Use `bun run test` for the full suite; for a fast single-file loop use `bun test ./path/to/file.test.ts --timeout=60000` (a path argument is always present).
- **`bun run test:coverage` is NOT part of `check:all`.** This plan adds files under `src/`, so it must be run before the final commit.
- **File-size gate: 600 lines per `src/` file, 800 per `test/` file** (`scripts/check-file-sizes.ts`), with a baseline that recorded files may not exceed. See *Size budget* below — two files in this plan are close to a cap.
- **The story-workdir gate is absolute.** `scripts/check-story-workdir-access.ts` fails CI on any raw `.workdir` read on a story outside `ALLOWED` (`src/prd/types.ts`, `src/utils/path-frame.ts`, `src/prd/schema-story.ts`). Read through `storyWorkdir` / `storyPackageDir` / `storyAbsWorkdir`. **`EXEMPT` is empty and must stay empty.**
- **No mutation.** Build new arrays/objects; never mutate a parameter or an array in place.
- **No emojis** in code, comments, or docs. ASCII only in anything rendered into an agent prompt.
- **Conventional commits** (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`). Attribution lines are disabled globally — do not add them.
- **Dependency injection:** external calls (fs, spawn, fetch) go through the `_deps` pattern.

---

## State at handover

`main` is at `0e4113d23` with the path-frame foundation and #2071 merged. Nothing for #2067 has been written — no branch, no code.

What already exists and must be reused, not rebuilt:

| Thing | Where | Note |
|---|---|---|
| `toRepoFrame(path, workdir)` | `src/utils/path-frame.ts:73` | Prepends `workdir/` unless already prefixed on a segment boundary. |
| `storyWorkdir(story)` | `src/utils/path-frame.ts:115` | Always a string; `"."` means repo root. |
| `storyPackageDir(story)` | `src/utils/path-frame.ts:126` | `undefined` at root. Use for "the package, if any" APIs. |
| `finalizeAndWritePrd(args)` | `src/plan/strategies/persist-prd.ts:43` | **The single plan-write seam.** |
| `persistPrd(ctx, prd)` | `src/plan/strategies/persist-prd.ts:57` | Thin wrapper used by the four strategies. |
| `discoverWorkspacePackages(repoRoot)` | `src/context/generator/index.ts:201` | Returns relative package dirs, sorted. |
| `checkFilesExist(prd, workdir, deps?)` | `src/debate/verifiers/checks.ts:26` | Joins `contextFiles` against `workdir`. |
| `getContextFiles` / `getExpectedFiles` | `src/prd/types.ts:274` / `:288` | Normalize to plain strings. |

## Orientation: read this before Task 1

Facts verified against `main` @ `0e4113d23`. Do not re-derive them.

**`savePRD` is the wrong seam.** It has ~20 callers across `pipeline/stages/`, `execution/`, `acceptance/` and `cli/accept.ts`, most of them mid-run status updates. Filesystem probing only has ground truth at plan time. Canonicalize in `finalizeAndWritePrd` and nowhere else; the `path-frame.ts` accessors already normalize defensively at read time, so PRDs written before this change keep working.

**Every `nax plan` write reaches `finalizeAndWritePrd`.** Two entry points, both verified: `src/cli/plan-command.ts:254` (the pipeline path) and `persistPrd` (`persist-prd.ts:57`), which the four strategies call from `plan/strategies/{pipeline,single,write-prd}.ts`. `plan-decompose.ts:222` writes directly via `_planDeps.writeFile` — **it is out of scope**, see *What this plan does NOT do*.

**`contextFiles` entries are `string | ContextFileEntry`** (`src/prd/types.ts:201`, entry interface at `:11`). The canonicalizer rewrites paths and **must preserve the object form and its `factId`**, or `checkFilesExist`'s blocker/major distinction (`checks.ts:31-38`) silently degrades to `major` for every cited entry.

**`PlanModeContext` already carries what the probe needs:** `workdir` at `src/plan/strategies/types.ts:35` and `deps: PlanDeps` at `:54`. `plan-command.ts` has `workdir` in scope at its `finalizeAndWritePrd` call site.

**The four-way probe outcome is from the spec and is not negotiable:**

```
exists(repoRoot/P)     -> P              (already repo-rooted)
exists(repoRoot/W/P)   -> W + "/" + P    (re-spell)
neither                -> P unchanged    (a file the story creates)
both                   -> W + "/" + P    (story-local wins) and log the collision
```

Note that `toRepoFrame` already returns `P` unchanged when `P` starts with `W/` on a segment boundary, so the "already repo-rooted" row needs no special case in the re-spell call — but it **does** need the `exists(repoRoot/P)` probe to decide *which* row applies.

**Derivation runs before canonicalization**, because canonicalization needs `W`. For a story with no stated workdir, the union of per-path owning packages decides: exactly one owner means `derived`; zero or more than one means `defaulted` to `"."`.

## Size budget

| File | Lines now | Cap | Headroom after this plan |
|---|---|---|---|
| `src/prompts/builders/plan-builder.ts` | 561 | 600 | ~33 after Task 6's ~6 lines. Tight — do not add anything else there. |
| `src/prd/schema-story.ts` | 494 | 600 | ample |
| `src/debate/verifiers/checks.ts` | 142 | 600 | ample |
| `src/plan/strategies/persist-prd.ts` | 70 | 600 | ample |
| `src/prd/types.ts` | 445 | 600 | ample |
| **`test/unit/prd/schema.test.ts`** | **791** | **800** | **9 lines. Do NOT add cases here** — Task 1 uses a new file. |
| `test/unit/debate/verifiers/checks.test.ts` | 284 | 800 | ample |

## File Structure

| File | Responsibility |
|---|---|
| `src/prd/workdir-canonical.ts` **(create, ~150 lines)** | Pure derivation + re-spelling. Takes an `exists` probe as a parameter; performs no I/O of its own. |
| `test/unit/prd/workdir-canonical.test.ts` **(create)** | Exhaustive unit tests over a fake probe. |
| `src/prd/types.ts` **(modify)** | Adds the optional `workdirSource` field to `UserStory`. |
| `src/prd/schema-story.ts` **(modify)** | Validates and passes through `workdirSource`. |
| `test/unit/prd/schema-workdir-source.test.ts` **(create)** | Schema cases. Separate file because `schema.test.ts` is 9 lines from its cap. |
| `src/plan/strategies/persist-prd.ts` **(modify)** | Runs the pass before `applyPlanFidelity`; gains `repoRoot` and a `_persistPrdDeps` probe. |
| `src/cli/plan-command.ts` **(modify, 1 line)** | Passes `repoRoot`. |
| `src/debate/verifiers/checks.ts` **(modify)** | New `checkWorkdirDefaulted`. |
| `src/debate/verifiers/plan-checklist.ts`, `src/plan/critic.ts` **(modify, 1 line each)** | Wire the new check in. |
| `src/prompts/builders/plan-builder.ts` **(modify)** | Both `workdirField` sites state the frame. |

---

### Task 1: The `workdirSource` field

**Files:**
- Modify: `src/prd/types.ts:242` (after the `workdir` field)
- Modify: `src/prd/schema-story.ts:299-324` and `:485`
- Test: `test/unit/prd/schema-workdir-source.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `WorkdirSource = "stated" | "derived" | "defaulted"`, exported from `src/prd/types.ts`. `UserStory.workdirSource?: WorkdirSource`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/prd/schema-workdir-source.test.ts`:

```typescript
/**
 * Schema validation for UserStory.workdirSource (nax#2067).
 *
 * Separate from schema.test.ts, which is 791 lines against the 800-line cap.
 */

import { describe, expect, test } from "bun:test";
import { validateStory } from "@/prd/schema-story";

function baseStory(overrides: Record<string, unknown> = {}) {
  return {
    id: "US-001",
    title: "A story",
    description: "Does a thing",
    acceptanceCriteria: ["When x, then y"],
    ...overrides,
  };
}

describe("validateStory — workdirSource (nax#2067)", () => {
  test("passes through each of the three legal values", () => {
    for (const source of ["stated", "derived", "defaulted"] as const) {
      const story = validateStory(baseStory({ workdir: "packages/app", workdirSource: source }), 0);
      expect(story.workdirSource).toBe(source);
    }
  });

  test("omits the field entirely when absent", () => {
    const story = validateStory(baseStory(), 0);
    expect(story.workdirSource).toBeUndefined();
    expect("workdirSource" in story).toBe(false);
  });

  test("rejects a value outside the three", () => {
    expect(() => validateStory(baseStory({ workdirSource: "guessed" }), 0)).toThrow(/workdirSource/);
  });

  test("rejects a non-string value", () => {
    expect(() => validateStory(baseStory({ workdirSource: 3 }), 0)).toThrow(/workdirSource/);
  });

  test("a defaulted story may carry no workdir", () => {
    const story = validateStory(baseStory({ workdirSource: "defaulted" }), 0);
    expect(story.workdirSource).toBe("defaulted");
    expect(story.workdir).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./test/unit/prd/schema-workdir-source.test.ts --timeout=60000`
Expected: FAIL — `workdirSource` is not on the returned story and the invalid cases do not throw.

- [ ] **Step 3: Add the type**

In `src/prd/types.ts`, immediately after the `workdir?: string;` field (currently line 242), add:

```typescript
  /**
   * How `workdir` above was decided, stamped by `nax plan` (nax#2067).
   *
   * - `stated`    — the planner named it.
   * - `derived`   — every declared path resolved under exactly one workspace package.
   * - `defaulted` — paths spanned packages, resolved nowhere, or there were none.
   *
   * `defaulted` is the case worth warning about: it means whole-corpus rule
   * selection and root `quality.commands`, which is silent at every stage.
   * Absent on PRDs written before nax#2067.
   */
  workdirSource?: WorkdirSource;
```

And near the other exported unions at the top of the file, add:

```typescript
/** How a story's `workdir` was decided (nax#2067). */
export type WorkdirSource = "stated" | "derived" | "defaulted";
```

- [ ] **Step 4: Validate it in the schema**

In `src/prd/schema-story.ts`, immediately after the `workdir` block (which ends `workdir = rawWorkdir;` then `}` at line 324), add:

```typescript
  // workdirSource — optional provenance for the workdir above (nax#2067)
  const rawWorkdirSource = s.workdirSource;
  let workdirSource: WorkdirSource | undefined;
  if (rawWorkdirSource !== undefined && rawWorkdirSource !== null) {
    if (typeof rawWorkdirSource !== "string" || !WORKDIR_SOURCES.includes(rawWorkdirSource as WorkdirSource)) {
      throw new NaxError(
        `[schema] story[${index}].workdirSource must be one of ${WORKDIR_SOURCES.join(" | ")}: ${JSON.stringify(rawWorkdirSource)}`,
        "SCHEMA_VALIDATION_FAILED",
        { stage: "schema", index },
      );
    }
    workdirSource = rawWorkdirSource as WorkdirSource;
  }
```

Add near the top of the same file, beside the other module constants:

```typescript
const WORKDIR_SOURCES: readonly WorkdirSource[] = ["stated", "derived", "defaulted"];
```

Import the type alongside the existing `src/prd/types` import in that file:

```typescript
import type { WorkdirSource } from "./types";
```

And in the returned story object, immediately after the existing `...(workdir !== undefined ? { workdir } : {}),` line (currently 485), add:

```typescript
    ...(workdirSource !== undefined ? { workdirSource } : {}),
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test ./test/unit/prd/schema-workdir-source.test.ts --timeout=60000`
Expected: PASS, 5 tests.

- [ ] **Step 6: Run the neighbours that assert on story shape**

Run: `bun test ./test/unit/prd/ --timeout=60000`
Expected: PASS. If `schema.test.ts` fails on an exact-object assertion, the new key is being emitted when it should be omitted — re-check the conditional spread.

- [ ] **Step 7: Commit**

```bash
git add src/prd/types.ts src/prd/schema-story.ts test/unit/prd/schema-workdir-source.test.ts
git commit -m "feat(prd): record how a story's workdir was decided (#2067)"
```

---

### Task 2: Pure derivation and re-spelling helpers

**Files:**
- Create: `src/prd/workdir-canonical.ts`
- Test: `test/unit/prd/workdir-canonical.test.ts` (create)

**Interfaces:**
- Consumes: `toRepoFrame` from `@/utils/path-frame`; `WorkdirSource` from `./types`.
- Produces:
  - `type ExistsProbe = (absPath: string) => boolean`
  - `resolvePathOwners(path: string, repoRoot: string, packages: readonly string[], exists: ExistsProbe): string[]`
  - `deriveWorkdir(declaredPaths: readonly string[], repoRoot: string, packages: readonly string[], exists: ExistsProbe): { workdir: string; source: "derived" | "defaulted" }`
  - `canonicalizeDeclaredPath(path: string, workdir: string, repoRoot: string, exists: ExistsProbe): { path: string; collided: boolean }`

- [ ] **Step 1: Write the failing test**

Create `test/unit/prd/workdir-canonical.test.ts`:

```typescript
/**
 * Pure derivation and re-spelling for nax#2067.
 *
 * The probe is a plain Set of absolute paths — no filesystem, no mocks.
 */

import { describe, expect, test } from "bun:test";
import { canonicalizeDeclaredPath, deriveWorkdir, resolvePathOwners } from "@/prd/workdir-canonical";

const REPO = "/repo";
const PACKAGES = ["packages/app", "packages/lib"];

/** Build a probe from a list of repo-relative paths that "exist". */
function probeOf(...relPaths: string[]) {
  const set = new Set(relPaths.map((p) => `${REPO}/${p}`));
  return (abs: string) => set.has(abs);
}

describe("resolvePathOwners", () => {
  test("finds the package a package-relative path lives under", () => {
    const exists = probeOf("packages/app/src/a.ts");
    expect(resolvePathOwners("src/a.ts", REPO, PACKAGES, exists)).toEqual(["packages/app"]);
  });

  test("finds the package a repo-rooted path already names", () => {
    const exists = probeOf("packages/lib/src/b.ts");
    expect(resolvePathOwners("packages/lib/src/b.ts", REPO, PACKAGES, exists)).toEqual(["packages/lib"]);
  });

  test("returns both when the same relative path exists in two packages", () => {
    const exists = probeOf("packages/app/src/a.ts", "packages/lib/src/a.ts");
    expect(resolvePathOwners("src/a.ts", REPO, PACKAGES, exists)).toEqual(["packages/app", "packages/lib"]);
  });

  test("returns none for a path that exists nowhere", () => {
    expect(resolvePathOwners("src/new.ts", REPO, PACKAGES, probeOf())).toEqual([]);
  });

  test("does not slice a package whose name extends another", () => {
    const exists = probeOf("packages/application/src/c.ts");
    expect(resolvePathOwners("packages/application/src/c.ts", REPO, ["packages/app"], exists)).toEqual([]);
  });
});

describe("deriveWorkdir", () => {
  test("derives the single owning package", () => {
    const exists = probeOf("packages/app/src/a.ts", "packages/app/src/b.ts");
    expect(deriveWorkdir(["src/a.ts", "src/b.ts"], REPO, PACKAGES, exists)).toEqual({
      workdir: "packages/app",
      source: "derived",
    });
  });

  test("defaults to root when paths span packages", () => {
    const exists = probeOf("packages/app/src/a.ts", "packages/lib/src/b.ts");
    expect(deriveWorkdir(["src/a.ts", "src/b.ts"], REPO, PACKAGES, exists)).toEqual({
      workdir: ".",
      source: "defaulted",
    });
  });

  test("defaults to root when nothing resolves", () => {
    expect(deriveWorkdir(["src/new.ts"], REPO, PACKAGES, probeOf())).toEqual({
      workdir: ".",
      source: "defaulted",
    });
  });

  test("defaults to root when there are no declared paths", () => {
    expect(deriveWorkdir([], REPO, PACKAGES, probeOf())).toEqual({ workdir: ".", source: "defaulted" });
  });

  test("ignores paths that resolve nowhere when others agree", () => {
    // A story that reads one existing file and creates another.
    const exists = probeOf("packages/app/src/a.ts");
    expect(deriveWorkdir(["src/a.ts", "src/brand-new.ts"], REPO, PACKAGES, exists)).toEqual({
      workdir: "packages/app",
      source: "derived",
    });
  });
});

describe("canonicalizeDeclaredPath", () => {
  test("re-spells a package-relative path", () => {
    const exists = probeOf("packages/app/src/a.ts");
    expect(canonicalizeDeclaredPath("src/a.ts", "packages/app", REPO, exists)).toEqual({
      path: "packages/app/src/a.ts",
      collided: false,
    });
  });

  test("leaves an already repo-rooted path alone", () => {
    const exists = probeOf("packages/app/src/a.ts");
    expect(canonicalizeDeclaredPath("packages/app/src/a.ts", "packages/app", REPO, exists)).toEqual({
      path: "packages/app/src/a.ts",
      collided: false,
    });
  });

  test("leaves a path that exists nowhere unchanged — the story creates it", () => {
    expect(canonicalizeDeclaredPath("src/new.ts", "packages/app", REPO, probeOf())).toEqual({
      path: "src/new.ts",
      collided: false,
    });
  });

  test("story-local wins when both spellings exist, and reports the collision", () => {
    const exists = probeOf("src/a.ts", "packages/app/src/a.ts");
    expect(canonicalizeDeclaredPath("src/a.ts", "packages/app", REPO, exists)).toEqual({
      path: "packages/app/src/a.ts",
      collided: true,
    });
  });

  test("is a no-op at the repo root", () => {
    const exists = probeOf("src/a.ts");
    expect(canonicalizeDeclaredPath("src/a.ts", ".", REPO, exists)).toEqual({
      path: "src/a.ts",
      collided: false,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./test/unit/prd/workdir-canonical.test.ts --timeout=60000`
Expected: FAIL — module `@/prd/workdir-canonical` does not exist.

- [ ] **Step 3: Write the implementation**

Create `src/prd/workdir-canonical.ts`:

```typescript
/**
 * Workdir derivation and declared-path canonicalization for `nax plan` (nax#2067).
 *
 * A story with no `workdir` is not inert: rule selection falls back to the whole
 * corpus and `quality.commands` falls back to the root config, both silently.
 * This module decides a workdir from the filesystem at plan time — the one
 * moment the repo is in the state the planner described — and re-spells the
 * story's declared paths into the canonical repo frame while it is there.
 *
 * Pure by construction: every function takes an `ExistsProbe` rather than
 * touching the filesystem, so the whole decision table is unit-testable without
 * fixtures. The caller supplies the real probe.
 */

import { join } from "node:path";
import { toRepoFrame } from "@/utils/path-frame";

/** Synchronous existence probe over ABSOLUTE paths. */
export type ExistsProbe = (absPath: string) => boolean;

/**
 * Every workspace package a declared path could belong to.
 *
 * Two ways a path can belong to package W:
 * - it is package-relative and `repoRoot/W/P` exists, or
 * - it already names W on a segment boundary and `repoRoot/P` exists.
 *
 * The segment boundary matters: "packages/app" must not claim
 * "packages/application/...".
 */
export function resolvePathOwners(
  path: string,
  repoRoot: string,
  packages: readonly string[],
  exists: ExistsProbe,
): string[] {
  const owners: string[] = [];
  for (const pkg of packages) {
    if (exists(join(repoRoot, pkg, path))) {
      owners.push(pkg);
      continue;
    }
    const namesPackage = path === pkg || path.startsWith(`${pkg}/`);
    if (namesPackage && exists(join(repoRoot, path))) owners.push(pkg);
  }
  return owners;
}

/**
 * Decide a workdir for a story the planner left unstated.
 *
 * Paths that resolve nowhere are ignored rather than forcing a default: a story
 * that reads one existing file and creates another is the common case, and the
 * file it creates carries no information about which package it belongs to.
 */
export function deriveWorkdir(
  declaredPaths: readonly string[],
  repoRoot: string,
  packages: readonly string[],
  exists: ExistsProbe,
): { workdir: string; source: "derived" | "defaulted" } {
  const owners = new Set<string>();
  for (const path of declaredPaths) {
    for (const owner of resolvePathOwners(path, repoRoot, packages, exists)) owners.add(owner);
  }
  if (owners.size !== 1) return { workdir: ".", source: "defaulted" };
  const [only] = [...owners];
  // biome-ignore lint/style/noNonNullAssertion: size is exactly 1
  return { workdir: only!, source: "derived" };
}

/**
 * Re-spell one declared path into the repo frame, per the spec's four outcomes:
 *
 *   exists(repoRoot/P)   -> P             (already repo-rooted)
 *   exists(repoRoot/W/P) -> W + "/" + P   (re-spell)
 *   neither              -> P unchanged   (a file the story creates)
 *   both                 -> W + "/" + P   (story-local wins), collision reported
 *
 * `collided` is returned rather than logged so this stays pure; the caller logs.
 */
export function canonicalizeDeclaredPath(
  path: string,
  workdir: string,
  repoRoot: string,
  exists: ExistsProbe,
): { path: string; collided: boolean } {
  if (workdir === ".") return { path, collided: false };
  const atPackage = exists(join(repoRoot, workdir, path));
  const atRoot = exists(join(repoRoot, path));
  if (atPackage) return { path: toRepoFrame(path, workdir), collided: atRoot };
  return { path, collided: false };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test ./test/unit/prd/workdir-canonical.test.ts --timeout=60000`
Expected: PASS, 15 tests.

- [ ] **Step 5: Commit**

```bash
git add src/prd/workdir-canonical.ts test/unit/prd/workdir-canonical.test.ts
git commit -m "feat(prd): pure workdir derivation and declared-path canonicalization (#2067)"
```

---

### Task 3: The PRD-level pass

**Files:**
- Modify: `src/prd/workdir-canonical.ts` (append)
- Test: `test/unit/prd/workdir-canonical.test.ts` (append)

**Interfaces:**
- Consumes: Task 2's three functions; `UserStory`, `PRD`, `WorkdirSource` from `./types`; `getContextFiles`/`getExpectedFiles` are **not** used here — the raw arrays must be rewritten in place-preserving form.
- Produces: `canonicalizePrdWorkdirs(prd: PRD, repoRoot: string, packages: readonly string[], exists: ExistsProbe): { prd: PRD; collisions: string[] }`

- [ ] **Step 1: Write the failing test**

Append to `test/unit/prd/workdir-canonical.test.ts`:

```typescript
describe("canonicalizePrdWorkdirs", () => {
  function prdOf(stories: Array<Record<string, unknown>>) {
    return {
      project: "p",
      feature: "f",
      branchName: "b",
      userStories: stories,
    } as unknown as import("@/prd/types").PRD;
  }

  test("derives a workdir and re-spells the story's declared paths", () => {
    const exists = probeOf("packages/app/src/a.ts");
    const { prd } = canonicalizePrdWorkdirs(
      prdOf([{ id: "US-001", contextFiles: ["src/a.ts"], expectedFiles: ["src/b.ts"] }]),
      REPO,
      PACKAGES,
      exists,
    );
    const story = prd.userStories[0];
    expect(story?.workdir).toBe("packages/app");
    expect(story?.workdirSource).toBe("derived");
    expect(story?.contextFiles).toEqual(["packages/app/src/a.ts"]);
    // expectedFiles does not exist yet, so it stays as authored.
    expect(story?.expectedFiles).toEqual(["src/b.ts"]);
  });

  test("keeps a stated workdir and stamps it stated", () => {
    const exists = probeOf("packages/lib/src/a.ts");
    const { prd } = canonicalizePrdWorkdirs(
      prdOf([{ id: "US-001", workdir: "packages/lib", contextFiles: ["src/a.ts"] }]),
      REPO,
      PACKAGES,
      exists,
    );
    expect(prd.userStories[0]?.workdir).toBe("packages/lib");
    expect(prd.userStories[0]?.workdirSource).toBe("stated");
    expect(prd.userStories[0]?.contextFiles).toEqual(["packages/lib/src/a.ts"]);
  });

  test("defaults to root and omits workdir entirely", () => {
    const exists = probeOf("packages/app/src/a.ts", "packages/lib/src/b.ts");
    const { prd } = canonicalizePrdWorkdirs(
      prdOf([{ id: "US-001", contextFiles: ["src/a.ts", "src/b.ts"] }]),
      REPO,
      PACKAGES,
      exists,
    );
    expect(prd.userStories[0]?.workdir).toBeUndefined();
    expect(prd.userStories[0]?.workdirSource).toBe("defaulted");
  });

  test("preserves ContextFileEntry objects and their factId", () => {
    const exists = probeOf("packages/app/src/a.ts");
    const { prd } = canonicalizePrdWorkdirs(
      prdOf([{ id: "US-001", contextFiles: [{ path: "src/a.ts", factId: "F-1" }] }]),
      REPO,
      PACKAGES,
      exists,
    );
    expect(prd.userStories[0]?.contextFiles).toEqual([{ path: "packages/app/src/a.ts", factId: "F-1" }]);
  });

  test("reports a collision without failing", () => {
    const exists = probeOf("src/a.ts", "packages/app/src/a.ts");
    const { prd, collisions } = canonicalizePrdWorkdirs(
      prdOf([{ id: "US-001", workdir: "packages/app", contextFiles: ["src/a.ts"] }]),
      REPO,
      PACKAGES,
      exists,
    );
    expect(prd.userStories[0]?.contextFiles).toEqual(["packages/app/src/a.ts"]);
    expect(collisions).toEqual(["US-001:src/a.ts"]);
  });

  test("is a no-op for a single-package repo (no workspace packages)", () => {
    const exists = probeOf("src/a.ts");
    const { prd } = canonicalizePrdWorkdirs(
      prdOf([{ id: "US-001", contextFiles: ["src/a.ts"] }]),
      REPO,
      [],
      exists,
    );
    expect(prd.userStories[0]?.workdir).toBeUndefined();
    expect(prd.userStories[0]?.workdirSource).toBe("defaulted");
    expect(prd.userStories[0]?.contextFiles).toEqual(["src/a.ts"]);
  });

  test("does not mutate the input PRD", () => {
    const input = prdOf([{ id: "US-001", contextFiles: ["src/a.ts"] }]);
    const snapshot = JSON.stringify(input);
    canonicalizePrdWorkdirs(input, REPO, PACKAGES, probeOf("packages/app/src/a.ts"));
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
```

Add the import at the top of the file:

```typescript
import { canonicalizeDeclaredPath, canonicalizePrdWorkdirs, deriveWorkdir, resolvePathOwners } from "@/prd/workdir-canonical";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./test/unit/prd/workdir-canonical.test.ts --timeout=60000`
Expected: FAIL — `canonicalizePrdWorkdirs` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/prd/workdir-canonical.ts`:

```typescript
/**
 * Canonicalize every story in a PRD: decide the workdir, stamp its provenance,
 * and re-spell declared paths into the repo frame.
 *
 * `workdir` is OMITTED rather than written as "." for a root story: "." is the
 * accessors' internal spelling, and writing it into the PRD would change the
 * on-disk shape for every single-package repo. `workdirSource` carries the
 * information instead.
 *
 * Collisions are returned as "storyId:path" strings for the caller to log.
 */
export function canonicalizePrdWorkdirs(
  prd: PRD,
  repoRoot: string,
  packages: readonly string[],
  exists: ExistsProbe,
): { prd: PRD; collisions: string[] } {
  const collisions: string[] = [];

  const userStories = prd.userStories.map((story) => {
    const declared = [
      ...(story.contextFiles ?? []).map((f) => (typeof f === "string" ? f : f.path)),
      ...(story.expectedFiles ?? []),
    ];

    const stated = typeof story.workdir === "string" && story.workdir.trim().length > 0;
    const { workdir, source }: { workdir: string; source: WorkdirSource } = stated
      ? { workdir: story.workdir as string, source: "stated" }
      : deriveWorkdir(declared, repoRoot, packages, exists);

    const reframe = (path: string): string => {
      const result = canonicalizeDeclaredPath(path, workdir, repoRoot, exists);
      if (result.collided) collisions.push(`${story.id}:${path}`);
      return result.path;
    };

    const contextFiles = story.contextFiles?.map((entry) =>
      typeof entry === "string" ? reframe(entry) : { ...entry, path: reframe(entry.path) },
    );
    const expectedFiles = story.expectedFiles?.map(reframe);

    return {
      ...story,
      ...(workdir === "." ? {} : { workdir }),
      workdirSource: source,
      ...(contextFiles !== undefined ? { contextFiles } : {}),
      ...(expectedFiles !== undefined ? { expectedFiles } : {}),
    };
  });

  return { prd: { ...prd, userStories }, collisions };
}
```

Extend the imports at the top of the file:

```typescript
import type { PRD, WorkdirSource } from "./types";
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test ./test/unit/prd/workdir-canonical.test.ts --timeout=60000`
Expected: PASS, 22 tests.

- [ ] **Step 5: Verify the workdir gate still passes**

Run: `bun run scripts/check-story-workdir-access.ts`
Expected: `check-story-workdir-access: clean (0 exemption(s) still pending)`.

If it fails naming `workdir-canonical.ts`, the raw `story.workdir` read in `canonicalizePrdWorkdirs` tripped it. That read is legitimate — this module is the writer. **Do not add an EXEMPT entry.** Add `join("src", "prd", "workdir-canonical.ts")` to `ALLOWED` in `scripts/check-story-workdir-access.ts`, alongside the existing `schema-story.ts` entry, with a comment saying it is the plan-time writer.

- [ ] **Step 6: Commit**

```bash
git add src/prd/workdir-canonical.ts test/unit/prd/workdir-canonical.test.ts scripts/check-story-workdir-access.ts
git commit -m "feat(prd): canonicalize story workdirs and declared paths across a PRD (#2067)"
```

---

### Task 4: Wire it into the single plan-write seam

**Files:**
- Modify: `src/plan/strategies/persist-prd.ts:25-70`
- Modify: `src/cli/plan-command.ts:254-265`
- Test: `test/unit/plan/strategies/persist-prd-workdir.test.ts` (create)

**Interfaces:**
- Consumes: `canonicalizePrdWorkdirs` from Task 3.
- Produces: `PersistPrdArgs` gains `readonly repoRoot: string`. `_persistPrdDeps` gains `existsSync` and `discoverWorkspacePackages`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/plan/strategies/persist-prd-workdir.test.ts`:

```typescript
/**
 * nax#2067: every PRD nax plan writes is workdir-canonicalized.
 *
 * Asserts on the JSON handed to writeFile, which is the artifact the rest of
 * the system reads.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _persistPrdDeps, finalizeAndWritePrd } from "@/plan/strategies";
import type { PRD } from "@/prd/types";

let origExistsSync: typeof _persistPrdDeps.existsSync;
let origDiscover: typeof _persistPrdDeps.discoverWorkspacePackages;

beforeEach(() => {
  origExistsSync = _persistPrdDeps.existsSync;
  origDiscover = _persistPrdDeps.discoverWorkspacePackages;
});

afterEach(() => {
  _persistPrdDeps.existsSync = origExistsSync;
  _persistPrdDeps.discoverWorkspacePackages = origDiscover;
});

function makePrd(): PRD {
  return {
    project: "p",
    feature: "f",
    branchName: "feat/f",
    userStories: [
      {
        id: "US-001",
        title: "t",
        description: "d",
        acceptanceCriteria: ["When x, then y"],
        contextFiles: ["src/a.ts"],
        status: "pending",
        passes: false,
      },
    ],
  } as unknown as PRD;
}

describe("finalizeAndWritePrd — workdir canonicalization (nax#2067)", () => {
  test("writes a derived workdir and repo-framed contextFiles", async () => {
    _persistPrdDeps.discoverWorkspacePackages = async () => ["packages/app"];
    _persistPrdDeps.existsSync = (p: string) => p === "/repo/packages/app/src/a.ts";

    let written = "";
    await finalizeAndWritePrd({
      prd: makePrd(),
      specContent: "",
      featureName: "f",
      projectName: "p",
      agentRouting: undefined,
      profileName: undefined,
      models: {} as never,
      defaultAgent: "claude",
      outputPath: "/repo/.nax/features/f/prd.json",
      repoRoot: "/repo",
      writeFile: async (_path, content) => {
        written = content;
      },
    });

    const parsed = JSON.parse(written) as PRD;
    expect(parsed.userStories[0]?.workdir).toBe("packages/app");
    expect(parsed.userStories[0]?.workdirSource).toBe("derived");
    expect(parsed.userStories[0]?.contextFiles).toEqual(["packages/app/src/a.ts"]);
  });

  test("a single-package repo is unaffected apart from the provenance stamp", async () => {
    _persistPrdDeps.discoverWorkspacePackages = async () => [];
    _persistPrdDeps.existsSync = (p: string) => p === "/repo/src/a.ts";

    let written = "";
    await finalizeAndWritePrd({
      prd: makePrd(),
      specContent: "",
      featureName: "f",
      projectName: "p",
      agentRouting: undefined,
      profileName: undefined,
      models: {} as never,
      defaultAgent: "claude",
      outputPath: "/repo/.nax/features/f/prd.json",
      repoRoot: "/repo",
      writeFile: async (_path, content) => {
        written = content;
      },
    });

    const parsed = JSON.parse(written) as PRD;
    expect(parsed.userStories[0]?.workdir).toBeUndefined();
    expect(parsed.userStories[0]?.workdirSource).toBe("defaulted");
    expect(parsed.userStories[0]?.contextFiles).toEqual(["src/a.ts"]);
  });

  test("a failing package discovery degrades to no canonicalization, not a throw", async () => {
    _persistPrdDeps.discoverWorkspacePackages = async () => {
      throw new Error("glob blew up");
    };
    _persistPrdDeps.existsSync = () => true;

    let written = "";
    await expect(
      finalizeAndWritePrd({
        prd: makePrd(),
        specContent: "",
        featureName: "f",
        projectName: "p",
        agentRouting: undefined,
        profileName: undefined,
        models: {} as never,
        defaultAgent: "claude",
        outputPath: "/repo/.nax/features/f/prd.json",
        repoRoot: "/repo",
        writeFile: async (_path, content) => {
          written = content;
        },
      }),
    ).resolves.toBeDefined();

    const parsed = JSON.parse(written) as PRD;
    expect(parsed.userStories[0]?.contextFiles).toEqual(["src/a.ts"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./test/unit/plan/strategies/persist-prd-workdir.test.ts --timeout=60000`
Expected: FAIL — `_persistPrdDeps` is not exported and `repoRoot` is not an accepted argument.

- [ ] **Step 3: Implement in `persist-prd.ts`**

Add to the imports:

```typescript
import { existsSync as defaultExistsSync } from "node:fs";
import { discoverWorkspacePackages as defaultDiscoverWorkspacePackages } from "@/context/generator";
import { getLogger } from "@/logger";
import { canonicalizePrdWorkdirs } from "@/prd/workdir-canonical";
```

Add the dep object below the imports:

```typescript
/**
 * Plan-time filesystem probes. Injected so the canonicalization decision table
 * is testable without a fixture tree.
 */
export const _persistPrdDeps = {
  existsSync: (path: string): boolean => defaultExistsSync(path),
  discoverWorkspacePackages: (repoRoot: string): Promise<string[]> => defaultDiscoverWorkspacePackages(repoRoot),
};
```

Add `repoRoot` to `PersistPrdArgs`, after `outputPath`:

```typescript
  /** Repo root, for the plan-time workdir probes (nax#2067). */
  readonly repoRoot: string;
```

Replace the body of `finalizeAndWritePrd` so canonicalization runs **first**, before `applyPlanFidelity`:

```typescript
export async function finalizeAndWritePrd(args: PersistPrdArgs): Promise<string> {
  // nax#2067: decide each story's workdir and re-spell its declared paths into
  // the repo frame, while the repo is still in the state the planner described.
  // Degrades to the raw PRD rather than failing the plan: a PRD with an
  // underived workdir is the status quo, a lost plan is not.
  let canonical = args.prd;
  try {
    const packages = await _persistPrdDeps.discoverWorkspacePackages(args.repoRoot);
    const result = canonicalizePrdWorkdirs(args.prd, args.repoRoot, packages, _persistPrdDeps.existsSync);
    canonical = result.prd;
    if (result.collisions.length > 0) {
      getLogger().warn("plan", "declared path exists at both the repo root and the story package; took story-local", {
        collisions: result.collisions,
      });
    }
  } catch (err) {
    getLogger().warn("plan", "workdir canonicalization skipped", { error: errorMessage(err) });
  }

  const repaired = applyPlanFidelity(canonical, args.specContent, args.featureName);
  const finalized = finalizePrdRouting(
    { ...repaired, project: args.projectName },
    args.agentRouting,
    args.profileName,
    args.models,
    args.defaultAgent,
  );
  await args.writeFile(args.outputPath, JSON.stringify(finalized, null, 2));
  return args.outputPath;
}
```

Add `import { errorMessage } from "@/utils/errors";` to the imports.

In `persistPrd`, pass the root through:

```typescript
    outputPath: ctx.outputPath,
    repoRoot: ctx.workdir,
    writeFile: ctx.deps.writeFile,
```

- [ ] **Step 4: Export the dep object**

In `src/plan/strategies/index.ts`, extend the existing re-export line:

```typescript
export { _persistPrdDeps, finalizeAndWritePrd, persistPrd } from "./persist-prd";
```

- [ ] **Step 5: Pass `repoRoot` at the other call site**

In `src/cli/plan-command.ts`, in the `finalizeAndWritePrd({ ... })` object (currently ending `outputPath,` then `writeFile: _planDeps.writeFile,` at line 264), add:

```typescript
        repoRoot: workdir,
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `bun test ./test/unit/plan/strategies/persist-prd-workdir.test.ts --timeout=60000`
Expected: PASS, 3 tests.

- [ ] **Step 7: Run the whole plan and strategy suites**

Run: `bun test ./test/unit/plan/ ./test/unit/cli/ --timeout=60000`
Expected: PASS. A type error at a `finalizeAndWritePrd` or `persistPrd` call site means a caller is missing `repoRoot` — add it rather than making the field optional. **An optional `repoRoot` would silently skip canonicalization for whichever caller forgot it, which is exactly the class of bug #2067 is.**

- [ ] **Step 8: Check for import cycles**

Run: `bun run check:import-cycles`
Expected: `[OK] 0 modules in runtime import cycles (baseline: 0).`

If it reports a cycle, `@/context/generator` is reaching back into `@/plan`. Break it by moving the `discoverWorkspacePackages` default into the caller: drop the dep's default, make `discoverWorkspacePackages` a required field of `PersistPrdArgs`, and have `plan-command.ts` and `persistPrd` supply it from `_planDeps`.

- [ ] **Step 9: Commit**

```bash
git add src/plan/strategies/persist-prd.ts src/plan/strategies/index.ts src/cli/plan-command.ts test/unit/plan/strategies/persist-prd-workdir.test.ts
git commit -m "feat(plan): canonicalize story workdirs at the single PRD write seam (#2067)"
```

---

### Task 5: Warn when a story lands `defaulted` in a monorepo

**Files:**
- Modify: `src/debate/verifiers/checks.ts` (append a function)
- Modify: `src/debate/verifiers/plan-checklist.ts:94`
- Modify: `src/plan/critic.ts:64`
- Test: `test/unit/debate/verifiers/checks.test.ts` (append)

**Also closes spec seam 3.** `checkFilesExist` (`checks.ts:26`) joins `contextFiles`
against the repo root, so before this arc every monorepo story collected a spurious
`major` for every declared path. Task 4's canonicalization fixes that upstream;
this task pins it.

**Interfaces:**
- Consumes: `WorkdirSource` from `@/prd/types`; the existing `CheckDeps` shape in `checks.ts:22`.
- Produces: `checkWorkdirDefaulted(prd: PRD, workdir: string, deps?: CheckDeps): VerifierFinding[]`

- [ ] **Step 1: Write the failing test**

Append to `test/unit/debate/verifiers/checks.test.ts`:

```typescript
// nax#2067: a defaulted workdir in a repo with per-package overlays means
// whole-corpus rules and root quality.commands, both silent today.
describe("checkWorkdirDefaulted (nax#2067)", () => {
  const monoRepo = { existsSync: (p: string) => p.endsWith("/.nax/mono") };

  test("warns for a defaulted story when .nax/mono exists", () => {
    const prd = makePrd([makeStory({ id: "US-001", workdirSource: "defaulted" })]);
    const findings = checkWorkdirDefaulted(prd, "/workdir", monoRepo);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("minor");
    expect(findings[0]?.storyId).toBe("US-001");
    expect(findings[0]?.message).toMatch(/whole-corpus/);
    expect(findings[0]?.message).toMatch(/quality\.commands/);
  });

  test("is silent when the repo has no per-package overlays", () => {
    const prd = makePrd([makeStory({ id: "US-001", workdirSource: "defaulted" })]);
    expect(checkWorkdirDefaulted(prd, "/workdir", { existsSync: () => false })).toHaveLength(0);
  });

  test("is silent for derived and stated stories", () => {
    const prd = makePrd([
      makeStory({ id: "US-001", workdirSource: "derived", workdir: "packages/app" }),
      makeStory({ id: "US-002", workdirSource: "stated", workdir: "packages/lib" }),
    ]);
    expect(checkWorkdirDefaulted(prd, "/workdir", monoRepo)).toHaveLength(0);
  });

  test("is silent on a pre-nax#2067 PRD that has no provenance at all", () => {
    const prd = makePrd([makeStory({ id: "US-001" })]);
    expect(checkWorkdirDefaulted(prd, "/workdir", monoRepo)).toHaveLength(0);
  });
});
```

Also append the seam-3 regression the spec calls out — canonicalization is what
stops `checkFilesExist` emitting a spurious `major` for every monorepo story,
because it joins `contextFiles` against the repo root:

```typescript
// nax#2067 seam 3: before canonicalization, a monorepo story's contextFiles were
// package-relative and checkFilesExist joined them against the REPO ROOT, so every
// entry missed and every monorepo story collected a spurious `major`.
describe("checkFilesExist — repo-framed contextFiles (nax#2067 seam 3)", () => {
  const onDisk = (...rel: string[]) => {
    const set = new Set(rel.map((r) => `/workdir/${r}`));
    return { existsSync: (p: string) => set.has(p) };
  };

  test("a repo-framed contextFile resolves and produces no finding", () => {
    const prd = makePrd([makeStory({ workdir: "packages/app", contextFiles: ["packages/app/src/a.ts"] })]);
    expect(checkFilesExist(prd, "/workdir", onDisk("packages/app/src/a.ts"))).toHaveLength(0);
  });

  test("the pre-nax#2067 package-relative spelling is what used to miss", () => {
    const prd = makePrd([makeStory({ workdir: "packages/app", contextFiles: ["src/a.ts"] })]);
    const findings = checkFilesExist(prd, "/workdir", onDisk("packages/app/src/a.ts"));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("major");
  });
});
```

The second test pins the OLD behaviour deliberately: `checkFilesExist` is unchanged
by this plan, and the point is that canonicalization upstream is what stops that
input from ever reaching it. Do not "fix" `checkFilesExist` to probe both frames —
that would re-introduce two-frame tolerance at a consumer, which is what the whole
arc exists to remove.

Add `checkWorkdirDefaulted` to the existing `@/debate` import at the top of that file.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./test/unit/debate/verifiers/checks.test.ts --timeout=60000`
Expected: FAIL — `checkWorkdirDefaulted` is not exported.

- [ ] **Step 3: Implement the check**

Append to `src/debate/verifiers/checks.ts`:

```typescript
/**
 * Warn when a story's workdir was DEFAULTED in a repo that carries per-package
 * overlays (nax#2067).
 *
 * A defaulted workdir is not inert: rule selection falls back to the whole
 * corpus and `quality.commands` falls back to the root config. Both are
 * invisible in the plan output, the run log and the run's artifacts, which is
 * why this is surfaced at plan time.
 *
 * `minor`, deliberately: a genuinely root-spanning story is legitimate and must
 * not be blocked. Provenance is what makes the warning precise enough to be
 * non-annoying — a story with no `workdirSource` at all predates nax#2067 and
 * says nothing, so it is skipped rather than assumed.
 */
export function checkWorkdirDefaulted(prd: PRD, workdir: string, deps?: CheckDeps): VerifierFinding[] {
  const existsSync = deps?.existsSync ?? defaultExistsSync;
  if (!existsSync(join(workdir, ".nax", "mono"))) return [];

  return prd.userStories
    .filter((story) => story.workdirSource === "defaulted")
    .map((story) => ({
      checklistItem: "workdir-defaulted",
      severity: "minor" as const,
      message: `Story has no resolved workdir in a monorepo: it will receive the whole rule corpus and the ROOT quality.commands, not its package's. Set "workdir" if this story is package-scoped.`,
      storyId: story.id,
    }));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test ./test/unit/debate/verifiers/checks.test.ts --timeout=60000`
Expected: PASS.

- [ ] **Step 5: Wire it into both consumers**

In `src/debate/verifiers/plan-checklist.ts`, after the `checkFilesExist(...)` spread at line 94:

```typescript
    ...checkWorkdirDefaulted(prd, ctx.workdir, { existsSync: _planChecklistDeps.existsSync }),
```

In `src/plan/critic.ts`, after the `checkFilesExist(prd, workdir)` spread at line 64:

```typescript
    ...checkWorkdirDefaulted(prd, workdir),
```

Extend the `checkX` import list at the top of each file, and add `checkWorkdirDefaulted` to the barrel re-exports in `src/debate/verifiers/index.ts:5` and `src/debate/index.ts:66`.

- [ ] **Step 6: Run the debate and plan suites**

Run: `bun test ./test/unit/debate/ ./test/unit/plan/ --timeout=60000`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/debate/ src/plan/critic.ts test/unit/debate/verifiers/checks.test.ts
git commit -m "feat(plan): warn when a story's workdir defaults in a monorepo (#2067)"
```

---

### Task 6: The planner prompt states the frame

**Files:**
- Modify: `src/prompts/builders/plan-builder.ts:325-327` and `:460-462`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing importable. Prompt text only.

**Why this is not optional:** canonicalizing at write without fixing the instruction means every future PRD arrives wrong and is silently repaired. The fix would work while concealing that it was needed.

- [ ] **Step 1: Render the current prompt and read it**

Run:

```bash
bun test ./test/unit/prompts/ --timeout=60000
```

Then find the two `workdirField` declarations:

```bash
grep -n "const workdirField" src/prompts/builders/plan-builder.ts
```

Expected: two hits, at roughly lines 325 and 460. **Both must change identically** — one serves `build()`, the other `buildDraft()`, and the two prompts drifting is the failure mode `CONTEXT_VS_EXPECTED_FILES_RULE` was extracted to prevent.

- [ ] **Step 2: Replace both declarations**

Each currently reads:

```typescript
    const workdirField = isMonorepo
      ? `\n      "workdir": "string — optional, relative path to package (e.g. \\"packages/api\\"). Omit for root-level stories.",`
      : "";
```

Replace both with:

```typescript
    const workdirField = isMonorepo
      ? `\n      "workdir": "string — the package this story is scoped to, relative to the REPO ROOT (e.g. \\"packages/api\\"). Set it whenever every file the story touches lives in one package; omit ONLY for a story that genuinely spans packages. Omitting it gives the story the whole repo's rules and the root build commands. Paths in contextFiles and expectedFiles are relative to THIS workdir.",`
      : "";
```

- [ ] **Step 3: State the frame in the shared files rule**

The spec names a third site: `CONTEXT_VS_EXPECTED_FILES_RULE` (`plan-builder.ts:56`),
the shared `contextFiles` vs `expectedFiles` text. It tells the planner to list
"relative paths" without ever saying relative to WHAT, which is the ambiguity the
whole issue rests on.

In that template literal, append one sentence to the end of the `expectedFiles`
paragraph (keep it on the existing line — the file has ~33 lines of headroom):

```
 Every path in both fields is relative to this story's \`workdir\` when it has one, and to the repo root otherwise.
```

- [ ] **Step 4: Verify the prompt renders, by rendering it**

Do not review this by reading the template. Render both branches and read the output:

```bash
bun test ./test/unit/prompts/ --timeout=60000
```

Then confirm the monorepo branch text appears exactly once per prompt and the non-monorepo branch is still empty:

```bash
grep -c "relative to the REPO ROOT" src/prompts/builders/plan-builder.ts
```

Expected: `2`.

- [ ] **Step 5: Check the size gate**

Run: `bun run check:file-sizes`
Expected: OK. `plan-builder.ts` was 561/600 before this task; if it now exceeds, the replacement was pasted rather than substituted — each site must remain three lines.

- [ ] **Step 6: Commit**

```bash
git add src/prompts/builders/plan-builder.ts
git commit -m "feat(prompts): state the workdir frame and its consequence in the planner prompt (#2067)"
```

---

### Task 7: Full verification and documentation

**Files:**
- Modify: `docs/superpowers/specs/2026-09-16-path-frame-convention-design.md` (sequencing table only)
- Test: no new tests

- [ ] **Step 1: Run the full suite**

Run: `bun run test`
Expected: `[run-tests] all phases passed`.

- [ ] **Step 2: Run every gate**

Run: `bun run check:all`
Expected: all green, including `check-story-workdir-access: clean (0 exemption(s) still pending)`.

- [ ] **Step 3: Run coverage**

This plan adds files under `src/`, and `test:coverage` is not part of `check:all`.

Run: `bun run test:coverage`
Expected: at or above floor, `0 files below floor (baseline 0)`.

- [ ] **Step 4: Prove the regression against `main`**

The new tests must fail without the change, or they are not regression tests:

```bash
git stash
bun test ./test/unit/prd/workdir-canonical.test.ts --timeout=60000   # expect: module not found
git stash pop
```

For the wiring, temporarily restore main's `persist-prd.ts` and confirm `persist-prd-workdir.test.ts` fails:

```bash
cp src/plan/strategies/persist-prd.ts /tmp/pp-fixed.ts
git show origin/main:src/plan/strategies/persist-prd.ts > src/plan/strategies/persist-prd.ts
bun test ./test/unit/plan/strategies/persist-prd-workdir.test.ts --timeout=60000   # expect: FAIL
cp /tmp/pp-fixed.ts src/plan/strategies/persist-prd.ts
```

- [ ] **Step 5: Update the arc's sequencing table**

In `docs/superpowers/specs/2026-09-16-path-frame-convention-design.md`, mark PR 4 done in the *Sequencing* table, leaving PR 5 (#2074) as the only open row.

- [ ] **Step 6: Commit and open the PR**

```bash
git add docs/superpowers/specs/2026-09-16-path-frame-convention-design.md
git commit -m "docs: mark PR 4 of the path-frame arc complete (#2067)"
git push -u origin fix/2067-workdir-canonicalization
```

**Before opening the PR, run a code review on the full diff.** Code review comes before push/PR, never after, and a subagent's "all green" is not evidence — re-run the reproduction yourself.

PR body must record:
- That `workdir: "."` is deliberately omitted from the PRD rather than written, with `workdirSource` carrying the information.
- That canonicalization is fail-open: a probe or discovery failure degrades to the raw PRD, because a PRD with an underived workdir is the status quo and a lost plan is not.
- That `plan-decompose.ts:222` writes directly and is **not** covered — see below.
- The residual from #2071: a declared path naming a sibling package is still prefixed by `toRepoFrame`. This plan narrows it (a repo-rooted sibling path that exists now canonicalizes to itself and is then passed through), but does not close it.

---

## Done criteria

- `bun run test`, `bun run check:all` and `bun run test:coverage` all pass.
- A monorepo PRD written by `nax plan` has `workdir` set on every story whose declared files resolve to one package, and `workdirSource` on every story.
- Declared paths in a written PRD are repo-rooted.
- A `defaulted` story in a repo with `.nax/mono/` produces a `minor` plan-checklist finding naming both consequences.
- Both planner prompts state the frame, and the shared files rule says what paths are relative to — verified by rendering, not by reading the template.
- Spec seam 3 is closed: `checkFilesExist` no longer fires spuriously on a monorepo story.
- `scripts/check-story-workdir-access.ts` reports 0 exemptions pending.

## What this plan does NOT do

- **PR 5 (#2074)** — sibling-frame neighbours, `crossPackageDepth` retirement, ADR-010. Separate plan.
- **`plan-decompose.ts:222`.** `planDecomposeCommand` writes the PRD directly via `_planDeps.writeFile`, bypassing `finalizeAndWritePrd`. Sub-stories inherit the parent's package via `storyPackageDir(targetStory)` (`plan-decompose.ts:199`), so they are not *wrong* — they simply do not get `workdirSource` stamped, and their declared paths are not re-probed. Routing decompose through the same seam means making `finalizeAndWritePrd` idempotent over an already-canonical PRD and re-running fidelity repairs on a partially-executed PRD, which is a different blast radius. **File it as a follow-up issue citing this plan; do not fix it here.**
- **Retiring #2071's sibling-package residual.** Canonicalization narrows it but cannot close it: a path that exists at neither location is returned unchanged by design, because that is how a file the story creates is represented.
- **Migrating existing PRDs.** The `path-frame.ts` accessors normalize defensively at read time; PRDs written before this change keep working and simply carry no `workdirSource`.
- **Seams 5 through 10** in the design spec's table. Each is filed as its own issue.
