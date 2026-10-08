# Review Fixes Bundle J — Package-Scoped Acceptance Overrides

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Read the master plan's **Global Constraints** and the **#10 ruling + refinement** first: `2026-10-08-review-fixes-master-plan.md`.

**Goal:** An acceptance override waives exactly the criterion its author meant, in a monorepo too.

**Architecture:** A new pure module `acceptance/override-keys.ts` owns the key grammar and the lookup rule. The acceptance stage asks it for each failed AC instead of indexing `acceptanceOverrides[acId]`; `nax accept` learns to write the scoped form. All in `packages/nax`.

**Tech Stack:** TypeScript, bun:test.

**Spec:** `docs/superpowers/reviews/2026-10-08-whole-repo-code-review.md` finding #10, plus the master plan's ruling table.

**Branch:** `git fetch origin && git checkout -b fix/review-j-acceptance-overrides origin/main`

## Key grammar (the ruling, made exact)

- **Scoped key:** `<packageRel>::AC-N`, where `packageRel = path.relative(workdir, packageDir)`, or `.` for the repo-root package. Example: `apps/api::AC-2`. Always honoured for that package only.
- **Bare key:** `AC-N`. Honoured when the run has ONE acceptance test group (single package, or the single-file fallback), or when exactly one package in the run defines an AC numbered N (its in-scope AC count is ≥ N). Otherwise it is ignored, and the stage logs ONE warning per AC id naming the scoped spelling.
- A scoped key wins over a bare key for the same failure.
- Sentinels (`AC-HOOK`, `AC-ERROR`) are never overridable by a bare key in a multi-package run (no package "defines" them).

## Global Constraints

See the master plan. `packages/nax/src/pipeline/stages/acceptance.ts` is 583 lines (cap 600, budget +17); this bundle adds about +9. Run `wc -l` after Task 2.

## Review Focus

See the master plan. This bundle owns Review Focus line 4 (a bare key in a multi-package run), pinned in Tasks 1 and 2.

## Files

- Create: `packages/nax/src/acceptance/override-keys.ts` (Task 1)
- Modify: `packages/nax/src/acceptance/index.ts` (Task 1 — re-export)
- Modify: `packages/nax/src/pipeline/stages/acceptance.ts:242-249, 348-358` (Task 2)
- Modify: `packages/nax/src/cli/accept.ts:45-55` (Task 3)
- Modify: `docs/guides/cli-reference.md` (`nax accept` section, ~line 219) (Task 3)
- Test: `packages/nax/test/unit/acceptance/override-keys.test.ts` (new, mirrors the src module)
- Test: `packages/nax/test/unit/pipeline/stages/acceptance.test.ts` (635 lines)
- Test: `packages/nax/test/unit/cli/accept.test.ts` (95 lines)

---

### Task 1: The override lookup module

**Files:**
- Create: `packages/nax/src/acceptance/override-keys.ts`
- Modify: `packages/nax/src/acceptance/index.ts`
- Test: `packages/nax/test/unit/acceptance/override-keys.test.ts`

**Interfaces:**
- Produces (Task 2 and Task 3 consume):

```ts
export const OVERRIDE_SCOPE_SEPARATOR = "::";
export function scopedOverrideKey(workdir: string, packageDir: string, acId: string): string;
export interface OverrideLookup {
  reasonFor(packageDir: string, acId: string): string | undefined;
}
export function createOverrideLookup(opts: {
  readonly overrides: Readonly<Record<string, string>> | undefined;
  readonly workdir: string;
  readonly acCountByPackageDir: ReadonlyMap<string, number>;
  readonly multiPackage: boolean;
  readonly onIgnoredBareKey: (acId: string) => void;
}): OverrideLookup;
```

- [ ] **Step 1: Write the failing tests**

Create `packages/nax/test/unit/acceptance/override-keys.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createOverrideLookup, scopedOverrideKey } from "@/acceptance/override-keys";

const WORKDIR = "/repo";
const API = "/repo/apps/api";
const WEB = "/repo/apps/web";

function lookup(
  overrides: Record<string, string>,
  counts: Array<[string, number]>,
  multiPackage = counts.length > 1,
): { reasonFor: (dir: string, ac: string) => string | undefined; ignored: string[] } {
  const ignored: string[] = [];
  const l = createOverrideLookup({
    overrides,
    workdir: WORKDIR,
    acCountByPackageDir: new Map(counts),
    multiPackage,
    onIgnoredBareKey: (acId) => ignored.push(acId),
  });
  return { reasonFor: (dir, ac) => l.reasonFor(dir, ac), ignored };
}

describe("scopedOverrideKey", () => {
  test("names the package relative to the repo root", () => {
    expect(scopedOverrideKey(WORKDIR, API, "AC-2")).toBe("apps/api::AC-2");
  });

  test("names the root package '.'", () => {
    expect(scopedOverrideKey(WORKDIR, WORKDIR, "AC-2")).toBe(".::AC-2");
  });
});

describe("createOverrideLookup", () => {
  test("a scoped key waives only its own package's criterion", () => {
    const { reasonFor } = lookup({ "apps/api::AC-2": "waived" }, [
      [API, 3],
      [WEB, 3],
    ]);
    expect(reasonFor(API, "AC-2")).toBe("waived");
    expect(reasonFor(WEB, "AC-2")).toBeUndefined();
  });

  test("a bare key is honoured in a single-package run", () => {
    expect(lookup({ "AC-2": "waived" }, [[WORKDIR, 3]]).reasonFor(WORKDIR, "AC-2")).toBe("waived");
  });

  test("a bare key is honoured in the single-file fallback even when stories span packages", () => {
    const { reasonFor } = lookup(
      { "AC-2": "waived" },
      [
        [API, 3],
        [WEB, 3],
      ],
      false,
    );
    expect(reasonFor(WORKDIR, "AC-2")).toBe("waived");
  });

  test("a bare key is honoured when exactly one package defines that AC number", () => {
    const { reasonFor, ignored } = lookup({ "AC-3": "waived" }, [
      [API, 3],
      [WEB, 2],
    ]);
    expect(reasonFor(API, "AC-3")).toBe("waived");
    expect(ignored).toEqual([]);
  });

  test("an ambiguous bare key is ignored everywhere and reported once", () => {
    const { reasonFor, ignored } = lookup({ "AC-2": "waived" }, [
      [API, 3],
      [WEB, 3],
    ]);
    expect(reasonFor(API, "AC-2")).toBeUndefined();
    expect(reasonFor(WEB, "AC-2")).toBeUndefined();
    expect(reasonFor(API, "AC-2")).toBeUndefined();
    expect(ignored).toEqual(["AC-2"]);
  });

  test("a scoped key wins over a bare key", () => {
    const { reasonFor } = lookup({ "AC-1": "bare", "apps/api::AC-1": "scoped" }, [[API, 1]]);
    expect(reasonFor(API, "AC-1")).toBe("scoped");
  });

  test("a sentinel is never waived by a bare key in a multi-package run", () => {
    const { reasonFor } = lookup({ "AC-HOOK": "waived" }, [
      [API, 3],
      [WEB, 3],
    ]);
    expect(reasonFor(API, "AC-HOOK")).toBeUndefined();
  });

  test("no overrides at all is never an override", () => {
    const l = createOverrideLookup({
      overrides: undefined,
      workdir: WORKDIR,
      acCountByPackageDir: new Map(),
      multiPackage: false,
      onIgnoredBareKey: () => {},
    });
    expect(l.reasonFor(WORKDIR, "AC-1")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run (from `packages/nax`): `timeout 30 bun test test/unit/acceptance/override-keys.test.ts --timeout=5000`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/nax/src/acceptance/override-keys.ts`:

```ts
/**
 * Acceptance override keys (review #10).
 *
 * Each package numbers its acceptance criteria AC-1..N independently (BUG-12),
 * so a bare `AC-2` names a different criterion in every package. Keys:
 *   - `<packageRel>::AC-N` waives AC-N in that package only (`.` = repo root).
 *   - `AC-N` is honoured only where it is unambiguous: a run with one test group,
 *     or a run where exactly one package defines an AC numbered N.
 * An ambiguous bare key is ignored (never applied to every package) and reported
 * once through `onIgnoredBareKey`, so the author can rewrite it scoped.
 */
import { relative } from "node:path";

export const OVERRIDE_SCOPE_SEPARATOR = "::";

const NUMBERED_AC = /^AC-(\d+)$/;

export function scopedOverrideKey(workdir: string, packageDir: string, acId: string): string {
  return `${relative(workdir, packageDir) || "."}${OVERRIDE_SCOPE_SEPARATOR}${acId}`;
}

export interface OverrideLookup {
  /** The override reason for `acId` failing in `packageDir`, or undefined when no override applies. */
  reasonFor(packageDir: string, acId: string): string | undefined;
}

export interface OverrideLookupOptions {
  readonly overrides: Readonly<Record<string, string>> | undefined;
  readonly workdir: string;
  /** In-scope acceptance-criteria count per absolute package dir (the stage's `acsByPackageDir`). */
  readonly acCountByPackageDir: ReadonlyMap<string, number>;
  /** True when the run executes more than one acceptance test group. */
  readonly multiPackage: boolean;
  readonly onIgnoredBareKey: (acId: string) => void;
}

/** How many packages define a criterion numbered like `acId` (0 for sentinels such as AC-HOOK). */
function definingPackageCount(acId: string, counts: ReadonlyMap<string, number>): number {
  const n = Number(NUMBERED_AC.exec(acId)?.[1] ?? 0);
  if (n < 1) return 0;
  return [...counts.values()].filter((count) => count >= n).length;
}

export function createOverrideLookup(opts: OverrideLookupOptions): OverrideLookup {
  const table = opts.overrides ?? {};
  const reported = new Set<string>();
  return {
    reasonFor(packageDir, acId) {
      const scoped = table[scopedOverrideKey(opts.workdir, packageDir, acId)];
      if (scoped !== undefined) return scoped;
      const bare = table[acId];
      if (bare === undefined || !opts.multiPackage) return bare;
      if (definingPackageCount(acId, opts.acCountByPackageDir) === 1) return bare;
      if (!reported.has(acId)) {
        reported.add(acId);
        opts.onIgnoredBareKey(acId);
      }
      return undefined;
    },
  };
}
```

In `packages/nax/src/acceptance/index.ts` (a barrel that lists `export type { ... }` and `export { ... }` per module, alphabetically by module path), add after the `./heuristics` line:

```ts
export type { OverrideLookup, OverrideLookupOptions } from "./override-keys";
export { createOverrideLookup, OVERRIDE_SCOPE_SEPARATOR, scopedOverrideKey } from "./override-keys";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `timeout 30 bun test test/unit/acceptance/override-keys.test.ts --timeout=5000`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/nax/src/acceptance/override-keys.ts packages/nax/src/acceptance/index.ts packages/nax/test/unit/acceptance/override-keys.test.ts
git commit -m "feat(acceptance): package-scoped override keys and an unambiguous bare-key rule (review #10)"
```

---

### Task 2: The acceptance stage uses the lookup

**Files:**
- Modify: `packages/nax/src/pipeline/stages/acceptance.ts`
- Test: `packages/nax/test/unit/pipeline/stages/acceptance.test.ts`

**Interfaces:**
- Consumes: `createOverrideLookup` (Task 1), added to the EXISTING barrel import on `acceptance.ts:32` (`import { buildAcceptanceRunCommand, createOverrideLookup, resolveAcceptanceFeatureTestPath } from "@/acceptance";`) so the import costs no extra line.

- [ ] **Step 1: Write the failing tests**

Append a new describe at the end of `acceptance.test.ts`:

```ts
describe("acceptance overrides in a multi-package run (review #10)", () => {
  function twoPackageCtx(acceptanceOverrides: Record<string, string>): PipelineContext {
    const stories = [
      makeStory({
        id: "US-001",
        status: "passed",
        passes: true,
        attempts: 0,
        workdir: "apps/api",
        acceptanceCriteria: ["api one", "api two"],
      }),
      makeStory({
        id: "US-002",
        status: "passed",
        passes: true,
        attempts: 0,
        workdir: "apps/web",
        acceptanceCriteria: ["web one", "web two"],
      }),
    ];
    const base = makeCtx();
    return {
      ...base,
      prd: { ...base.prd, userStories: stories, acceptanceOverrides },
      story: stories[0],
      stories,
      acceptanceTestPaths: [
        { testPath: "/tmp/test-workdir/apps/api/.nax-acceptance.test.ts", packageDir: "/tmp/test-workdir/apps/api" },
        { testPath: "/tmp/test-workdir/apps/web/.nax-acceptance.test.ts", packageDir: "/tmp/test-workdir/apps/web" },
      ],
    };
  }

  async function runBothFailingAc2(ctx: PipelineContext) {
    const origSpawn = _executorDeps.spawn;
    const origFile = Bun.file;
    _executorDeps.spawn = makeSpawn(() => ({ stdout: "FAIL AC-2", exitCode: 1 })).spawn;
    Object.assign(Bun, { file: fileStub });
    try {
      return await acceptanceStage.execute(ctx);
    } finally {
      _executorDeps.spawn = origSpawn;
      Object.assign(Bun, { file: origFile });
    }
  }

  test("a scoped override waives AC-2 in its package only", async () => {
    const ctx = twoPackageCtx({ "apps/api::AC-2": "waived for api" });
    const result = await runBothFailingAc2(ctx);
    expect(result.action).toBe("fail");
    expect(ctx.acceptanceFailures?.failedPackages.map((p) => p.packageDir)).toEqual(["/tmp/test-workdir/apps/web"]);
  });

  test("an ambiguous bare override is ignored, so both packages still fail", async () => {
    const ctx = twoPackageCtx({ "AC-2": "meant for one package" });
    const result = await runBothFailingAc2(ctx);
    expect(result.action).toBe("fail");
    expect(ctx.acceptanceFailures?.failedPackages.map((p) => p.packageDir)).toEqual([
      "/tmp/test-workdir/apps/api",
      "/tmp/test-workdir/apps/web",
    ]);
  });
});
```

`UserStory.workdir` (`prd/types.ts:245`) is the package path the stage resolves through `storyAbsWorkdir(ctx.workdir, s)`; `makeStory` passes it through. `ctx.acceptanceFailures.failedPackages` is the same field the existing test `"records failed package metadata in acceptanceFailures for downstream fix routing"` asserts.

- [ ] **Step 2: Run them to verify they fail**

Run: `timeout 30 bun test test/unit/pipeline/stages/acceptance.test.ts --timeout=5000`
Expected: the scoped test FAILS (both packages fail: the scoped key is unknown today); the ambiguous test FAILS (the bare key waives BOTH packages and the stage passes).

If, after the fix, the scoped test shows the api package recorded with `failedACs: ["AC-ERROR"]`, the stub output tripped the BUG-12 "more failures than AC-tagged lines" guard (`acceptance.ts` ~397): make the stub output carry a framework summary consistent with one tagged failure, e.g. `"(fail) AC-2: criterion\n\n 0 pass\n 1 fail\n"`, for both packages.

- [ ] **Step 3: Implement**

In `acceptance.ts`:

1. Add `createOverrideLookup` to the `@/acceptance` import on line 32.

2. Right after the `for (const s of ctx.prd.userStories) { ... }` loop that fills `acsByPackageDir` (~line 249), add:

```ts
    // #10: `<pkg>::AC-N` keys; a bare AC-N only where it is unambiguous.
    const overrideLookup = createOverrideLookup({
      overrides: ctx.prd.acceptanceOverrides,
      workdir: ctx.workdir,
      acCountByPackageDir: acsByPackageDir,
      multiPackage: testGroups.length > 1,
      onIgnoredBareKey: (acId) =>
        logger.warn("acceptance", "Bare acceptance override ignored: several packages define this AC id", {
          storyId: ctx.story.id,
          acId,
          hint: `scope it to one package: "<package>::${acId}"`,
        }),
    });
```

(`testGroups` is declared above this point at ~line 222; if it is declared later, move this block to just after it.)

3. Replace the three override lines inside the per-package loop (~348-351):

```ts
      const overrides = ctx.prd.acceptanceOverrides ?? {};
      const actualFailures = failedACs.filter((acId) => !overrides[acId]);
      const overriddenFailures = failedACs.filter((acId) => overrides[acId]);
```

with:

```ts
      const reasonFor = (acId: string) => overrideLookup.reasonFor(packageDir, acId);
      const actualFailures = failedACs.filter((acId) => !reasonFor(acId));
      const overriddenFailures = failedACs.filter((acId) => reasonFor(acId));
```

4. In the `"Skipped failures (overridden)"` log just below, change `reason: overrides[acId]` to `reason: reasonFor(acId)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `timeout 60 bun test test/unit/pipeline/stages/ test/unit/acceptance/ --timeout=5000`
Expected: PASS, including every existing BUG-12 / BUG-32 test (a single-package run still honours bare keys). `wc -l src/pipeline/stages/acceptance.ts` — expect ≤ 600.

- [ ] **Step 5: Commit**

```bash
git add packages/nax/src/pipeline/stages/acceptance.ts packages/nax/test/unit/pipeline/stages/acceptance.test.ts
git commit -m "fix(acceptance): overrides waive only the package they name (review #10)"
```

---

### Task 3: `nax accept` writes scoped keys

**Files:**
- Modify: `packages/nax/src/cli/accept.ts:45-55`
- Modify: `docs/guides/cli-reference.md`
- Test: `packages/nax/test/unit/cli/accept.test.ts`

- [ ] **Step 1: Write the failing test**

Append inside the existing describe in `accept.test.ts` (copy the setup lines of `"adds an override to prd.json, normalizing the AC id to uppercase"`):

```ts
  test("accepts a package-scoped id and normalises only the AC part", async () => {
    const naxDir = join(tempDir, ".nax");
    mkdirSync(naxDir, { recursive: true });
    writeFileSync(join(naxDir, "config.json"), JSON.stringify({ name: "test-project" }));
    const prdPath = writePRD(naxDir, "scoped-feature");
    process.chdir(tempDir);

    await acceptCommand({ feature: "scoped-feature", override: "apps/api::ac-2", reason: "api only" });

    const prd = await loadPRD(prdPath);
    expect(prd.acceptanceOverrides).toEqual({ "apps/api::AC-2": "api only" });
  });

  test("rejects a scoped id with an empty package part", async () => {
    process.chdir(tempDir);
    await expect(acceptCommand({ feature: "f", override: "::AC-2", reason: "why" })).rejects.toThrow(
      /Invalid AC ID format/,
    );
  });
```

- [ ] **Step 2: Run them to verify the first fails**

Run: `timeout 30 bun test test/unit/cli/accept.test.ts --timeout=5000`
Expected: the scoped test FAILS with "Invalid AC ID format". The empty-package test passes already (keep it as a pin).

- [ ] **Step 3: Implement**

In `accept.ts`, replace the validation + normalisation block:

```ts
  // Validate AC ID format
  if (!override.match(/^AC-\d+$/i)) {
    logger.error("cli", "Invalid AC ID format", { override, expected: "AC-1, AC-2, etc." });
    throw new NaxError("Invalid AC ID format", "INVALID_AC_ID", { override, expected: "AC-1, AC-2, etc." });
  }

  // Normalize AC ID to uppercase
  const acId = override.toUpperCase();
```

with:

```ts
  // `AC-N`, or `<package>::AC-N` to waive the criterion in one package of a monorepo (#10).
  const expected = "AC-1, or <package>::AC-1 (package path relative to the repo root)";
  const match = /^(?:(.+)::)?(AC-\d+)$/i.exec(override);
  const pkg = match?.[1];
  const ac = match?.[2];
  if (!ac || pkg === "") {
    logger.error("cli", "Invalid AC ID format", { override, expected });
    throw new NaxError("Invalid AC ID format", "INVALID_AC_ID", { override, expected });
  }
  // Only the AC part is case-normalised; a package path is case-sensitive.
  const acId = pkg === undefined ? ac.toUpperCase() : `${pkg}::${ac.toUpperCase()}`;
```

Note `"::AC-2"` does not match `(.+)::` (the group needs ≥ 1 char) so it fails the whole regex — that is the rejection path.

In `docs/guides/cli-reference.md`, in the `nax accept` section after the example line, add:

```markdown
In a monorepo each package numbers its criteria from AC-1, so scope the override to one package with `<package>::AC-N`, the package path relative to the repo root (`.` for the root package):

```bash
nax accept -f my-feature --override apps/api::AC-2 -r "intentional: lazy expiry"
```

A bare `AC-N` still works in a single-package project. In a multi-package run it applies only when exactly one package has an AC with that number; otherwise it is ignored and the run logs a warning.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `timeout 30 bun test test/unit/cli/accept.test.ts --timeout=5000`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/nax/src/cli/accept.ts packages/nax/test/unit/cli/accept.test.ts docs/guides/cli-reference.md
git commit -m "feat(cli): nax accept takes <package>::AC-N overrides (review #10)"
```

---

## Bundle wrap-up

Run the master plan's **Per-bundle PR checklist** with scope `acceptance`. In the PR body, state the bare-key rule and the planner's refinement ("defines", not "failing") from the master plan so the maintainer can confirm it.
