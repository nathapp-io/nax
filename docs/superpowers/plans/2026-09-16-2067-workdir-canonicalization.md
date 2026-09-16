# Workdir Canonicalization Implementation Plan (#2067)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `nax plan` assign every story a `workdir` whenever its declared files resolve to exactly one workspace package, canonicalize declared paths to the repo frame in the same pass, record which of the three ways the workdir was decided, and warn when a story lands `defaulted` in a repo that has per-package overlays.

**Architecture:** One new pure module, `src/prd/workdir-canonical.ts`, owns the probe-driven derivation and path re-spelling. It is wired into `finalizeAndWritePrd` (`src/plan/strategies/persist-prd.ts`) — the single seam every `nax plan` write already passes through — so no strategy can drift on whether it ran. A new optional story field `workdirSource` records `stated | derived | defaulted`, and the same seam logs a warning when a story lands `defaulted` in a repo carrying `.nax/mono/` overlays. That warning deliberately is NOT a plan-checklist verifier — see the RULING in Orientation, which explains why a verifier there can never fire.

**Tech Stack:** Bun 1.4.0, TypeScript strict, `bun:test`, Biome.

**Spec:** `docs/superpowers/specs/2026-09-16-path-frame-convention-design.md`, section **`#2067 — workdir null`**.

**Scope:** PR 4 of the 5-PR path-frame arc. PRs 1, 2 and 3 are merged. PR 5 (#2074) is a separate plan and must not be started here.

## Global Constraints

- **Branch:** `fix/2067-workdir-canonicalization` **already exists** at `340da16f2` (this plan doc, committed on top of `main` @ `0e4113d23`). Check it out; do NOT try to create it. Do not commit to `main`.
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

`main` is at `0e4113d23` with the path-frame foundation and #2071 merged.

Branch `fix/2067-workdir-canonicalization` exists and holds **two docs-only commits** — this plan and
a review pass over it:

```
04f433d70  docs: harden the #2067 plan for handover to a fresh session
340da16f2  docs: implementation plan for workdir canonicalization (#2067)
0e4113d23  fix(pipeline): frame declared scope files into the repo frame (#2071) (#2078)
```

**Start from `04f433d70`** — it is the reviewed revision. `340da16f2` contains four defects that were
found and corrected: a `validateStory` call with the wrong arity, two banned cast shapes, and a
warning wired where it could never fire. Do not resurrect anything from it.

**Nothing under `src/` or `test/` has been touched.** `grep -rn workdirSource src/ test/` returns nothing. `bun run test` and `bun run check:all` both pass on this branch as of handover, so any failure you see after Task 1 is yours.

**The issue text**, which this plan repeatedly appeals to, is public:

```bash
gh issue view 2067 -R nathapp-io/nax
```

What already exists and must be reused, not rebuilt:

| Thing | Where | Note |
|---|---|---|
| `toRepoFrame(path, workdir)` | `src/utils/path-frame.ts:73` | Prepends `workdir/` unless already prefixed on a segment boundary. |
| `storyWorkdir(story)` | `src/utils/path-frame.ts:115` | Always a string; `"."` means repo root. |
| `storyPackageDir(story)` | `src/utils/path-frame.ts:126` | `undefined` at root. Use for "the package, if any" APIs. |
| `finalizeAndWritePrd(args)` | `src/plan/strategies/persist-prd.ts:43` | **The single plan-write seam.** |
| `persistPrd(ctx, prd)` | `src/plan/strategies/persist-prd.ts:57` | Thin wrapper used by the four strategies. |
| `discoverWorkspacePackages(repoRoot)` | `src/context/generator/index.ts:201` | Returns relative package dirs, sorted. ⚠ **A second, unrelated `discoverWorkspacePackages` exists** at `src/test-runners/detect/workspace.ts:205`. Import the generator one, via `@/context/generator`. |
| `checkFilesExist(prd, workdir, deps?)` | `src/debate/verifiers/checks.ts:18` | Joins `contextFiles` against `workdir`. Unchanged by this plan. The spec says `:26`; the spec is wrong. |
| `getContextFiles` / `getExpectedFiles` | `src/prd/types.ts:277` / `:288` | Normalize to plain strings. |

## Orientation: read this before Task 1

Facts verified against `main` @ `0e4113d23`. Do not re-derive them.

**`savePRD` is the wrong seam.** It has ~20 callers across `pipeline/stages/`, `execution/`, `acceptance/` and `cli/accept.ts`, most of them mid-run status updates. Filesystem probing only has ground truth at plan time. Canonicalize in `finalizeAndWritePrd` and nowhere else; the `path-frame.ts` accessors already normalize defensively at read time, so PRDs written before this change keep working.

**Every `nax plan` write reaches `finalizeAndWritePrd`.** Two entry points, both verified: `src/cli/plan-command.ts:254` (the pipeline path) and `persistPrd` (`persist-prd.ts:57`), which the four strategies call from `plan/strategies/{pipeline,single,write-prd}.ts`. `src/cli/plan-decompose.ts:222` writes directly via `_planDeps.writeFile` — **it is out of scope**, see *What this plan does NOT do*.

**`contextFiles` entries are `string | ContextFileEntry`** (`src/prd/types.ts:201`, entry interface at `:11`). The canonicalizer rewrites paths and **must preserve the object form and its `factId`**, or `checkFilesExist`'s blocker/major distinction (`checks.ts:23-30`) silently degrades to `major` for every cited entry.

**`PlanModeContext` already carries what the probe needs:** `workdir` at `src/plan/strategies/types.ts:35` and `deps: PlanDeps` at `:54`. `plan-command.ts` has `workdir` in scope at its `finalizeAndWritePrd` call site.

**RULING — where the `defaulted` warning fires, and why not as a verifier.** The obvious design is a
new plan-checklist verifier beside `checkFilesExist`. **It cannot work.** Both verifier call sites run
strictly BEFORE the PRD is written:

- `src/plan/critic.ts:64` runs on the *draft* PRD; `src/cli/plan-command.ts` calls `runPlanCritic` at
  `:238` and only reaches `finalizeAndWritePrd` at `:254`, inside `if (verdict.outcome === "passed")`.
- `src/debate/verifiers/plan-checklist.ts:94` runs on the debate selector's raw agent output.

`workdirSource` is stamped inside `canonicalizePrdWorkdirs`, which runs only at write. So at both
verifier sites every story has `workdirSource === undefined` and the check would return `[]` forever
— green unit tests, feature never fires. That is the declared-but-unreachable class this very arc
keeps hitting, and the repo's `post-impl-review` has a `Wiring` dimension specifically to catch it.

**The warning therefore fires from `finalizeAndWritePrd`, at the canonicalization site**, which has
the stamped PRD, the probe and a logger already in hand. It is a log line, not a `VerifierFinding`.
The issue asks only to "warn at plan time"; a warning that fires beats a finding that cannot.

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
| `src/prompts/builders/plan-builder.ts` | 561 | 600 | 39. Task 6 is a **substitution**, not an insertion: both `workdirField` sites stay 3 lines and the shared rule gains no line. Net change should be 0. |
| `src/prd/schema-story.ts` | 494 | 600 | ample |
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
| `src/prompts/builders/plan-builder.ts` **(modify)** | Both `workdirField` sites state the frame, plus the shared files rule. |
| `test/unit/plan/strategies/persist-prd-workdir.test.ts` **(create)** | Task 4 wiring, then Task 5 appends the warning tests. |
| `test/unit/debate/verifiers/checks.test.ts` **(modify)** | Task 5 appends the seam-3 tests. `checks.ts` itself is NOT modified. |

**No file under `src/debate/` changes.** An earlier revision added a verifier there; it was removed because it could not fire.

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

/**
 * validateStory takes FOUR arguments: (raw, index, allIds, seenIds).
 *
 * `seenIds` is MUTATED — schema-story.ts:103 does `seenIds.add(id)` after a
 * duplicate check at :92. Sharing one Set across calls therefore makes the
 * second call with the same story id throw "duplicate id". Every call below
 * gets its own pair of Sets.
 */
function validate(raw: Record<string, unknown>) {
  return validateStory(raw, 0, new Set<string>(["US-001"]), new Set<string>());
}

describe("validateStory — workdirSource (nax#2067)", () => {
  test("passes through each of the three legal values", () => {
    for (const source of ["stated", "derived", "defaulted"] as const) {
      const story = validate(baseStory({ workdir: "packages/app", workdirSource: source }));
      expect(story.workdirSource).toBe(source);
    }
  });

  test("omits the field entirely when absent", () => {
    const story = validate(baseStory());
    expect(story.workdirSource).toBeUndefined();
    expect("workdirSource" in story).toBe(false);
  });

  test("rejects a value outside the three", () => {
    expect(() => validate(baseStory({ workdirSource: "guessed" }))).toThrow(/workdirSource/);
  });

  test("rejects a non-string value", () => {
    expect(() => validate(baseStory({ workdirSource: 3 }))).toThrow(/workdirSource/);
  });

  test("a defaulted story may carry no workdir", () => {
    const story = validate(baseStory({ workdirSource: "defaulted" }));
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

And add the union beside the other exported story unions — insert it directly **after** the line
`export type VerificationStage =` block ends at `src/prd/types.ts:40`, before the next `export`:

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

Add to the constants block in the same file (the `// Constants` banner at `src/prd/schema-story.ts:15-17`,
where `VALID_COMPLEXITY` sits at `:19`):

```typescript
const WORKDIR_SOURCES: readonly WorkdirSource[] = ["stated", "derived", "defaulted"];
```

Extend the file's existing type import rather than adding a second one. `src/prd/schema-story.ts:12`
currently reads:

```typescript
import type { ContextFileEntry, ModifiedFileEntry, UserStory } from "./types";
```

Change it to:

```typescript
import type { ContextFileEntry, ModifiedFileEntry, UserStory, WorkdirSource } from "./types";
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
- Consumes: `toRepoFrame` from `@/utils/path-frame`. (`WorkdirSource` is NOT used until Task 3 — do not import it here.)
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
- Produces: `canonicalizePrdWorkdirs(prd: PRD, repoRoot: string, packages: readonly string[], exists: ExistsProbe): { prd: PRD; collisions: string[]; defaulted: string[] }`

- [ ] **Step 1: Write the failing test**

Append to `test/unit/prd/workdir-canonical.test.ts`:

```typescript
describe("canonicalizePrdWorkdirs", () => {
  // Use the shared factories: the double-cast escape hatch is ratcheted at ZERO
  // in test/ (scripts/baselines/test-as-unknown-as-baseline.json), and hand-rolled
  // PRD fixtures are what .nax/rules/test-helpers.md forbids anyway.
  const prdOf = (stories: UserStory[]) => makePRD({ userStories: stories });

  test("derives a workdir and re-spells the story's declared paths", () => {
    const exists = probeOf("packages/app/src/a.ts");
    const { prd } = canonicalizePrdWorkdirs(
      prdOf([makeStory({ contextFiles: ["src/a.ts"], expectedFiles: ["src/b.ts"] })]),
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
      prdOf([makeStory({ workdir: "packages/lib", contextFiles: ["src/a.ts"] })]),
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
      prdOf([makeStory({ contextFiles: ["src/a.ts", "src/b.ts"] })]),
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
      prdOf([makeStory({ contextFiles: [{ path: "src/a.ts", factId: "F-1" }] })]),
      REPO,
      PACKAGES,
      exists,
    );
    expect(prd.userStories[0]?.contextFiles).toEqual([{ path: "packages/app/src/a.ts", factId: "F-1" }]);
  });

  test("reports a collision without failing", () => {
    const exists = probeOf("src/a.ts", "packages/app/src/a.ts");
    const { prd, collisions } = canonicalizePrdWorkdirs(
      prdOf([makeStory({ workdir: "packages/app", contextFiles: ["src/a.ts"] })]),
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
      prdOf([makeStory({ contextFiles: ["src/a.ts"] })]),
      REPO,
      [],
      exists,
    );
    expect(prd.userStories[0]?.workdir).toBeUndefined();
    expect(prd.userStories[0]?.workdirSource).toBe("defaulted");
    expect(prd.userStories[0]?.contextFiles).toEqual(["src/a.ts"]);
  });

  test("an explicitly stated \".\" is treated as root, not as a package", () => {
    const exists = probeOf("src/a.ts");
    const { prd } = canonicalizePrdWorkdirs(
      prdOf([makeStory({ workdir: ".", contextFiles: ["src/a.ts"] })]),
      REPO,
      PACKAGES,
      exists,
    );
    expect(prd.userStories[0]?.workdir).toBeUndefined();
    expect(prd.userStories[0]?.workdirSource).toBe("defaulted");
  });

  test("does not mutate the input PRD", () => {
    const input = prdOf([makeStory({ contextFiles: ["src/a.ts"] })]);
    const snapshot = JSON.stringify(input);
    canonicalizePrdWorkdirs(input, REPO, PACKAGES, probeOf("packages/app/src/a.ts"));
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
```

Add the import at the top of the file:

```typescript
import { makePRD, makeStory } from "@test/helpers";
import type { UserStory } from "@/prd/types";
import { canonicalizeDeclaredPath, canonicalizePrdWorkdirs, deriveWorkdir, resolvePathOwners } from "@/prd/workdir-canonical";
```

**This REPLACES Task 2's three-symbol import line, it does not join it** — one `import ... from
"@/prd/workdir-canonical"` statement only, or Biome's organize-imports assist fails the build.

The deep import `@/prd/workdir-canonical` is legal **here** because `check:alias-internals` exempts
`test/`. It is NOT legal from `src/` — see Task 4.

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
 * Collisions are returned as "storyId:path" strings, and `defaulted` lists the ids of stories that
 * fell back to root, both for the caller to log. They are RETURNED rather than logged here so this
 * module stays pure -- and, for `defaulted`, because this is the only point in `nax plan` where that
 * fact is known (see the RULING in the plan's Orientation section).
 */
export function canonicalizePrdWorkdirs(
  prd: PRD,
  repoRoot: string,
  packages: readonly string[],
  exists: ExistsProbe,
): { prd: PRD; collisions: string[] } {
  const collisions: string[] = [];
  const defaulted: string[] = [];

  const userStories = prd.userStories.map((story) => {
    const declared = [
      ...(story.contextFiles ?? []).map((f) => (typeof f === "string" ? f : f.path)),
      ...(story.expectedFiles ?? []),
    ];

    // normalizeWorkdir collapses "", ".", "./" and absent to "." so a planner that
    // literally emits "." is treated as root, not as a stated package. Without this
    // the "." survives the spread below and lands in the written PRD, contradicting
    // the omit-at-root contract.
    const statedWorkdir = normalizeWorkdir(story.workdir);
    const stated = statedWorkdir !== ".";
    const { workdir, source }: { workdir: string; source: WorkdirSource } = stated
      ? { workdir: statedWorkdir, source: "stated" }
      : deriveWorkdir(declared, repoRoot, packages, exists);
    if (source === "defaulted") defaulted.push(story.id);

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

  return { prd: { ...prd, userStories }, collisions, defaulted };
}
```

Extend the imports at the top of the file:

```typescript
import type { PRD, WorkdirSource } from "./types";
```

and extend the existing `@/utils/path-frame` import to bring in the normalizer:

```typescript
import { normalizeWorkdir, toRepoFrame } from "@/utils/path-frame";
```

**Note:** `story.workdir` is read raw here. That is legitimate — this module is the plan-time
*writer* — but it trips `scripts/check-story-workdir-access.ts`. See Step 5.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test ./test/unit/prd/workdir-canonical.test.ts --timeout=60000`
Expected: PASS, 23 tests.

- [ ] **Step 5: Verify the workdir gate still passes**

Run: `bun run scripts/check-story-workdir-access.ts`
Expected: `check-story-workdir-access: clean (0 exemption(s) still pending)`.

**It WILL fail on the first run, and that is expected** — not a conditional. The gate's regex
(`scripts/check-story-workdir-access.ts:46`) matches any receiver ending in `story` followed by
`.workdir`, and `normalizeWorkdir(story.workdir)` in `canonicalizePrdWorkdirs` matches. That read is
legitimate: this module is the plan-time *writer*, the same reason `schema-story.ts` is allowed.

**Do not add an EXEMPT entry** — exemptions are for temporary debt and the list must stay empty. Add
to `ALLOWED` instead:

```typescript
const ALLOWED = [
  join("src", "prd", "types.ts"),
  join("src", "utils", "path-frame.ts"),
  join("src", "prd", "schema-story.ts"),
  // nax#2067: the plan-time writer -- it decides the value the accessors later read.
  join("src", "prd", "workdir-canonical.ts"),
];
```

Then re-run the gate and expect `clean (0 exemption(s) still pending)`.

(For contrast, the `story.workdirSource === "defaulted"` read added in Task 5 does **not** trip the
gate: the regex requires a word boundary after `workdir`, which the following `S` defeats.)

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
import { makeNaxConfig, makePRD, makeStory } from "@test/helpers";
import type { ModelsConfig } from "@/config";
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

// Shared factories, not hand-rolled literals: the double-cast escape hatch is
// ratcheted at ZERO in test/ and would fail check:test-as-unknown-as.
function makePrd(): PRD {
  return makePRD({ userStories: [makeStory({ contextFiles: ["src/a.ts"] })] });
}

/**
 * A real ModelsConfig. Do NOT reach for the bottom-type cast here: that shape is
 * banned repo-wide by biome-plugins/no-as-never.grit, registered at biome.json's
 * ROOT `plugins` key so it covers test/ too. There are zero occurrences in the repo.
 */
const MODELS: ModelsConfig = makeNaxConfig().models;

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
      models: MODELS,
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
      models: MODELS,
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
        models: MODELS,
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
import { join } from "node:path";
import { discoverWorkspacePackages as defaultDiscoverWorkspacePackages } from "@/context/generator";
import { getLogger } from "@/logger";
import { canonicalizePrdWorkdirs } from "@/prd";
```

**Import from the `@/prd` barrel, NOT `@/prd/workdir-canonical`.** `scripts/check-alias-internals.ts`
fails CI on a value-level `@/<dir>/<internal>` import whenever `src/<dir>/index.ts` exists, and
`src/prd/index.ts` does. There are currently **zero** such imports from `src/`, so there is no
precedent to copy — do not create one. (The existing `import type { PRD } from "@/prd/types"` in this
file is legal only because type-only imports are exempt.)

`@/context/generator` **is** legal: `src/context/generator/index.ts` is itself a nested barrel, so
that is an exact barrel match, not an internal path.

**This requires a barrel export first** — see the next step.

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
    // nax#2067: the only point in `nax plan` where "this story will be root-scoped"
    // is known. Both consequences are named because both are silent at every later
    // stage -- plan output, run log, and the completed run's artifacts.
    if (result.defaulted.length > 0 && _persistPrdDeps.existsSync(join(args.repoRoot, ".nax", "mono"))) {
      getLogger().warn(
        "plan",
        "stories have no resolved workdir in a monorepo: they will receive the WHOLE rule corpus and the ROOT quality.commands, not their package's",
        { storyIds: result.defaulted },
      );
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

- [ ] **Step 4: Export the canonicalizer from the prd barrel**

`persist-prd.ts` cannot reach `workdir-canonical.ts` directly (previous step). Add to
`src/prd/index.ts`, beside the other submodule re-exports (the block at `:13-51`, kept alphabetical
by module path):

```typescript
export { canonicalizePrdWorkdirs } from "./workdir-canonical";
```

No cycle risk: `src/prd/index.ts` imports only `node:fs`, `../errors`, `../tdd/types`,
`../utils/json-file` and its own submodules — nothing from `src/plan/`. Verify anyway in Step 8.

- [ ] **Step 5: Export the dep object**

In `src/plan/strategies/index.ts`, extend the existing re-export line:

```typescript
export { _persistPrdDeps, finalizeAndWritePrd, persistPrd } from "./persist-prd";
```

- [ ] **Step 6: Pass `repoRoot` at the other call site**

In `src/cli/plan-command.ts`, in the `finalizeAndWritePrd({ ... })` object (currently ending `outputPath,` then `writeFile: _planDeps.writeFile,` at line 264), add:

```typescript
        repoRoot: workdir,
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `bun test ./test/unit/plan/strategies/persist-prd-workdir.test.ts --timeout=60000`
Expected: PASS, 3 tests.

- [ ] **Step 8: Run the whole plan and strategy suites**

Run: `bun test ./test/unit/plan/ ./test/unit/cli/ ./test/integration/plan/ --timeout=60000`
Expected: PASS.

**The integration suite is not optional here.** This task makes every PRD `nax plan` writes gain a
new field and makes `persistPrd` do real filesystem work. `test/integration/plan/plan-prd-preservation.test.ts`
asserts PRD fields survive a write, and `test/unit/cli/plan.test.ts` is 1201 lines of exact-shape
assertions. Those are the tests most likely to break, and neither is in `test/unit/plan/`. A type error at a `finalizeAndWritePrd` or `persistPrd` call site means a caller is missing `repoRoot` — add it rather than making the field optional. **An optional `repoRoot` would silently skip canonicalization for whichever caller forgot it, which is exactly the class of bug #2067 is.**

- [ ] **Step 9: Check for import cycles**

Run: `bun run check:import-cycles && bun run check:alias-internals`
Expected: `[OK] 0 modules in runtime import cycles (baseline: 0).` and
`[OK] no alias-into-internal imports (N barrels checked)`.

**Both must be run here.** `check:alias-internals` is the gate the barrel export in Step 4 exists to
satisfy; if it is deferred to Task 7 you discover the problem three commits later.

If it reports a cycle, `@/context/generator` is reaching back into `@/plan`. Break it by moving the `discoverWorkspacePackages` default into the caller: drop the dep's default, make `discoverWorkspacePackages` a required field of `PersistPrdArgs`, and have `plan-command.ts` and `persistPrd` supply it from `_planDeps`.

- [ ] **Step 10: Commit**

```bash
git add src/plan/strategies/persist-prd.ts src/plan/strategies/index.ts src/prd/index.ts src/cli/plan-command.ts test/unit/plan/strategies/persist-prd-workdir.test.ts
git commit -m "feat(plan): canonicalize story workdirs at the single PRD write seam (#2067)"
```

---

### Task 5: Pin the warning, and close spec seam 3

**Files:**
- Test: `test/unit/plan/strategies/persist-prd-workdir.test.ts` (append)
- Test: `test/unit/debate/verifiers/checks.test.ts` (append)

**No `src/` changes.** The warning itself was implemented in Task 4 Step 3, at the only site where it
can fire — see the RULING in Orientation. This task proves it fires, and pins the seam-3 improvement
that canonicalization delivers for free.

**Interfaces:**
- Consumes: `_persistPrdDeps` and `finalizeAndWritePrd` from Task 4; the existing `makeStory`/`makePrd`
  fixtures in each test file.
- Produces: nothing importable.

**Why there is no `checkWorkdirDefaulted` verifier.** An earlier revision of this plan added one to
`src/debate/verifiers/checks.ts` and wired it into `plan-checklist.ts:94` and `critic.ts:64`. Both run
on a pre-write PRD, so `workdirSource` is always `undefined` there and the check returns `[]`
unconditionally. Do not re-add it. If you want the warning surfaced as a `VerifierFinding` rather than
a log, that requires moving canonicalization ahead of the critic, which contradicts "canonicalize at
write" and is a spec change, not an implementation choice.

- [ ] **Step 1: Write the failing test for the warning**

Append to `test/unit/plan/strategies/persist-prd-workdir.test.ts`:

```typescript
describe("finalizeAndWritePrd — defaulted-workdir warning (nax#2067)", () => {
  /**
   * Capture what the plan logger was told.
   *
   * Types match Logger.warn exactly (src/logger/types.ts:59) so no cast is
   * needed -- and none is allowed: the bottom-type cast is plugin-banned and
   * the double cast is ratcheted at zero.
   */
  function captureWarnings() {
    const calls: Array<{ message: string; data?: Record<string, unknown> }> = [];
    const logger = getLogger();
    const original = logger.warn.bind(logger);
    logger.warn = (stage: string, message: string, data?: Record<string, unknown>): void => {
      if (stage === "plan") calls.push({ message, data });
      original(stage, message, data);
    };
    return {
      calls,
      restore: () => {
        logger.warn = original;
      },
    };
  }

  async function persist(overrides: Partial<Parameters<typeof finalizeAndWritePrd>[0]> = {}) {
    return finalizeAndWritePrd({
      prd: makePrd(),
      specContent: "",
      featureName: "f",
      projectName: "p",
      agentRouting: undefined,
      profileName: undefined,
      models: MODELS,
      defaultAgent: "claude",
      outputPath: "/repo/.nax/features/f/prd.json",
      repoRoot: "/repo",
      writeFile: async () => {},
      ...overrides,
    });
  }

  test("warns, naming both consequences, when a story defaults in a .nax/mono repo", async () => {
    _persistPrdDeps.discoverWorkspacePackages = async () => ["packages/app", "packages/lib"];
    // Spans two packages -> defaulted. And .nax/mono exists.
    _persistPrdDeps.existsSync = (p: string) =>
      p === "/repo/packages/app/src/a.ts" || p === "/repo/packages/lib/src/b.ts" || p === "/repo/.nax/mono";

    const cap = captureWarnings();
    try {
      await persist({ prd: makePRD({ userStories: [makeStory({ contextFiles: ["src/a.ts", "src/b.ts"] })] }) });
    } finally {
      cap.restore();
    }

    const warning = cap.calls.find((c) => c.message.includes("no resolved workdir"));
    expect(warning).toBeDefined();
    expect(warning?.message).toMatch(/WHOLE rule corpus/);
    expect(warning?.message).toMatch(/ROOT quality\.commands/);
    expect(warning?.data).toMatchObject({ storyIds: ["US-001"] });
  });

  test("is silent in a repo with no per-package overlays", async () => {
    _persistPrdDeps.discoverWorkspacePackages = async () => [];
    _persistPrdDeps.existsSync = (p: string) => p === "/repo/src/a.ts"; // no /repo/.nax/mono

    const cap = captureWarnings();
    try {
      await persist();
    } finally {
      cap.restore();
    }

    expect(cap.calls.find((c) => c.message.includes("no resolved workdir"))).toBeUndefined();
  });

  test("is silent when every story resolved to a package", async () => {
    _persistPrdDeps.discoverWorkspacePackages = async () => ["packages/app"];
    _persistPrdDeps.existsSync = (p: string) => p === "/repo/packages/app/src/a.ts" || p === "/repo/.nax/mono";

    const cap = captureWarnings();
    try {
      await persist();
    } finally {
      cap.restore();
    }

    expect(cap.calls.find((c) => c.message.includes("no resolved workdir"))).toBeUndefined();
  });
});
```

Add `import { getLogger } from "@/logger";` to that file's imports.

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test ./test/unit/plan/strategies/persist-prd-workdir.test.ts --timeout=60000`

Expected: the first test FAILS (`warning` is `undefined`) **only if Task 4 Step 3 was not completed**.
If Task 4 was done correctly these pass immediately — that is fine and expected; they are
characterization for a `src/` change already made, and the RED for this behaviour was Task 4's own
test. Do not "fix" anything to force a failure.

- [ ] **Step 3: Write the seam-3 tests**

Append to `test/unit/debate/verifiers/checks.test.ts`:

```typescript
// nax#2067 seam 3: checkFilesExist joins contextFiles against the REPO ROOT, so
// before this arc every monorepo story collected a spurious `major` for every
// declared path. Canonicalization fixes that upstream; checkFilesExist is unchanged.
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

The second test pins the OLD behaviour deliberately: `checkFilesExist` is unchanged by this plan, and
the point is that canonicalization upstream stops that input ever reaching it. **Do not "fix"
`checkFilesExist` to probe both frames** — two-frame tolerance at a consumer is exactly what this arc
exists to remove.

- [ ] **Step 4: Run both suites**

Run: `bun test ./test/unit/plan/ ./test/unit/debate/ --timeout=60000`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/unit/plan/strategies/persist-prd-workdir.test.ts test/unit/debate/verifiers/checks.test.ts
git commit -m "test(plan): pin the defaulted-workdir warning and seam-3 improvement (#2067)"
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

**Both sites are byte-identical**, so a single-match edit will fail as non-unique:

```bash
grep -c 'optional, relative path to package' src/prompts/builders/plan-builder.ts   # -> 2
```

Use `replace_all: true` (or `sed -i ''` over both). The replacement text is the same for both —
they must not diverge.

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
Expected: OK, and `wc -l src/prompts/builders/plan-builder.ts` should still read **561**. Task 6 is
pure substitution — if the count moved, text was pasted rather than replaced.

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

**`git stash` will NOT work here** — every task ended in a commit, so there is nothing unstaged to
stash and `git stash pop` errors with "No stash entries found". Swap in main's file instead. Use your
session scratchpad, not `/tmp`:

```bash
SCRATCH="${TMPDIR:-/tmp}/2067-verify"; mkdir -p "$SCRATCH"

# The wiring: main's persist-prd.ts has no canonicalization.
cp src/plan/strategies/persist-prd.ts "$SCRATCH/persist-prd.ts"
git show origin/main:src/plan/strategies/persist-prd.ts > src/plan/strategies/persist-prd.ts
bun test ./test/unit/plan/strategies/persist-prd-workdir.test.ts --timeout=60000   # expect: FAIL
cp "$SCRATCH/persist-prd.ts" src/plan/strategies/persist-prd.ts

# The seam-3 regression: main's checks.ts predates nothing, so instead assert the
# canonicalizer is what moves it -- run the seam-3 block against a PRD that was NOT
# canonicalized. It is already written that way (the second test pins the old spelling),
# so simply confirm both tests in that describe block pass and that removing the
# canonicalize call from persist-prd.ts flips the persist test above.
bun test ./test/unit/debate/verifiers/checks.test.ts --timeout=60000   # expect: PASS
```

`src/prd/workdir-canonical.ts` does not exist on `origin/main` at all, so its unit tests are
regression tests by construction — no swap needed to prove that.

- [ ] **Step 5: Update the arc's sequencing table**

Two tables, and they behave differently. Read both before editing.

**1. The *Sequencing* table** (`docs/superpowers/specs/2026-09-16-path-frame-convention-design.md:339`)
is `| PR | Contents | Shape |` — **no status column, no "done" convention.** Do not invent one
per-row. Add a single line immediately above the table:

```markdown
> Status: PRs 1-4 merged. PR 5 (#2074) is the only open row.
```

If a status line is already there from PR 3, edit its numbers rather than adding a second.

**2. The *ten seams* table** (`:30-42`) DOES have a `Status here` column — and it is **written
aspirationally**. Seams 3 and 4 already read `**fixed** (#2067 PR)` and `**fixed** (#2067)` although
nothing was fixed when the spec was authored. (Seam 2 likewise claims `**fixed** (#2074)`, which is
still untrue — PR 5 has not started. **Leave seam 2 alone**; it is not yours to correct, and the
#2074 plan should fix it.)

So for seams 3 and 4 there is nothing to change — this PR simply makes those two rows true. Do not
add a duplicate marker. Do correct seam 3's citation while you are there: it says
`debate/verifiers/checks.ts:26`, and `checkFilesExist` is at `:18`.

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
- That `src/cli/plan-decompose.ts:222` writes directly and is **not** covered — see below.
- The residual from #2071: a declared path naming a sibling package is still prefixed by `toRepoFrame`. This plan narrows it (a repo-rooted sibling path that exists now canonicalizes to itself and is then passed through), but does not close it.
- **That live verification was deferred, in those words.** No `monorepo-tiny` run, no live `nax plan`. State plainly that nothing in the PR demonstrates a reduction in failed reads on a real run, and link the follow-up issue.
- **Why the `defaulted` warning is a log and not a `VerifierFinding`** — both verifier call sites run before the PRD is written, so `workdirSource` is always `undefined` there. Worth stating: a reviewer who knows `checks.ts` will look for it there first.
- **One deliberate deviation from the spec's *Testing* section.** It asks for canonicalization tests "over a fixture monorepo"; this PR uses an injected `Set`-backed `ExistsProbe` instead. That is faster, exhaustive over all four probe outcomes, and cannot drift as a fixture tree would — but it is a divergence, so name it rather than leaving it silent.

---

## Done criteria

- `bun run test`, `bun run check:all` and `bun run test:coverage` all pass.
- Given a monorepo PRD and a probe, `canonicalizePrdWorkdirs` sets `workdir` on every story whose
  declared files resolve to one package and `workdirSource` on every story, and `finalizeAndWritePrd`
  writes that result. Verified by unit test at both levels — **not** by running `nax plan`.
- Live verification (`monorepo-tiny`, and any real `nax plan` run) is **explicitly deferred** — see below. Do not run it, do not tick it, do not claim it in the PR.
- Declared paths **that exist on disk** in a written PRD are repo-rooted. Paths that exist at neither
  location stay as authored — that is the spec's `neither -> P unchanged` row, and it is how a file
  the story creates is represented. Task 3's first test pins exactly this asymmetry.
- A `defaulted` story in a repo with `.nax/mono/` produces a plan-time **log warning** naming both consequences, emitted from `finalizeAndWritePrd`. It is deliberately NOT a `VerifierFinding` — see the RULING in Orientation.
- Both planner prompts state the frame, and the shared files rule says what paths are relative to — verified by rendering, not by reading the template.
- Spec seam 3 is closed: `checkFilesExist` no longer fires spuriously on a monorepo story.
- `scripts/check-story-workdir-access.ts` reports 0 exemptions pending.

## What this plan does NOT do

- **PR 5 (#2074)** — sibling-frame neighbours, `crossPackageDepth` retirement, ADR-010. Separate plan.
- **`src/cli/plan-decompose.ts:222`.** `planDecomposeCommand` writes the PRD directly via `_planDeps.writeFile`, bypassing `finalizeAndWritePrd`. Sub-stories inherit the parent's package via `storyPackageDir(targetStory)` (`src/cli/plan-decompose.ts:199`), so they are not *wrong* — they simply do not get `workdirSource` stamped, and their declared paths are not re-probed. Routing decompose through the same seam means making `finalizeAndWritePrd` idempotent over an already-canonical PRD and re-running fidelity repairs on a partially-executed PRD, which is a different blast radius. **File it as a follow-up issue citing this plan; do not fix it here.**
- **Retiring #2071's sibling-package residual.** Canonicalization narrows it but cannot close it: a path that exists at neither location is returned unchanged by design, because that is how a file the story creates is represented.
- **Any live verification — DEFERRED by explicit decision, not blocking this PR.** Two things sit in
  this bucket:

  1. **The spec's `monorepo-tiny` end-to-end metric.** The spec's *Testing* section asks for "a
     `monorepo-tiny` run asserting zero failed `Read` calls", calling the 6 failures #2072 measured
     "the regression metric". **There is no `monorepo-tiny` fixture in this repo** — `find . -name
     "*monorepo-tiny*"` returns nothing; it is an external scratch repo the arc's author ran against.
  2. **A live `nax plan` run** against a real monorepo, diffing the written `prd.json` against the
     same plan on `main`.

  **Do NOT run either as part of executing this plan.** `nax plan` is a real, billed LLM run and is
  gated on explicit approval at the moment of launch — it is not yours to start. Verification here is
  unit-level and ends at `bun run test` / `check:all` / `test:coverage`.

  This is a real and declared gap: **nothing in this PR proves canonicalization reduces failed reads
  in a live run.** Say exactly that in the PR body. Do not imply the metric was taken, do not
  describe the expected before/after as though it were observed, and do not tick it in Done criteria.
  File a follow-up issue titled "live-verify #2067 workdir canonicalization on a real monorepo",
  citing this plan, and link it from the PR.

- **Migrating existing PRDs.** The `path-frame.ts` accessors normalize defensively at read time; PRDs written before this change keep working and simply carry no `workdirSource`.
- **Seams 5 through 10** in the design spec's table. Each is filed as its own issue.
