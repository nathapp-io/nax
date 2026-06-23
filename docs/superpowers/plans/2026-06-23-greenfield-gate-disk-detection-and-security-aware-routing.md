# Greenfield Gate Disk-Detection + Security-Aware Routing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop greenfield stories from being forced off their correct `three-session-tdd` classification: fix the greenfield gate to detect the test-writer's freshly-authored (untracked) tests, then keep security-critical greenfield stories on three-session-tdd instead of downgrading them.

**Architecture:** Two changes on the existing branch `fix/rectifier-nax-artifact-guard`. (1) `greenfieldGateOp` switches from `isGreenfieldStory` (`git ls-files`, tracked-only) to `hasTestFilesOnDisk` (filesystem scan, sees untracked) so it can validate test-writer output. (2) The routing-stage greenfield override becomes security-aware: security-critical greenfield stories keep `three-session-tdd`; non-security greenfield stories still downgrade to `tdd-simple`.

**Tech Stack:** Bun 1.3.7+, TypeScript strict, `bun:test`, Biome.

## Global Constraints

- **Branch:** Work on `fix/rectifier-nax-artifact-guard`. Do NOT create a new branch. Do NOT checkout other branches. Verify with `git branch --show-current` → `fix/rectifier-nax-artifact-guard`.
- **Bun-native only:** `Bun.file`/`Bun.write`/`Bun.spawn`/`Bun.sleep`/`Bun.Glob`. No Node `fs`/`child_process` for delays/process. (Tests may use `node:fs/promises` + `node:path` — the existing gate tests already do.)
- **Test command wrapper (mandatory):** a PreToolUse hook BLOCKS bare `bun test`. Always wrap: `timeout 30 bun test <path> --timeout=5000`. Never run bare `bun test`.
- **Errors:** use `NaxError` (not `Error`) for thrown errors; these tasks throw none, but keep the rule.
- **Logging:** project logger only (`getLogger()` / `logger.info(...)`), no `console.*`; `storyId` first key in any log data object.
- **Imports:** value imports hit barrels (`@/routing`, `@/operations`); type-only imports may hit leaf paths. `greenfieldGateOp` already imports from the leaf `../context/greenfield` — match that existing style for the greenfield helpers.
- **Lint scope:** the repo's `bun run lint` only checks `src/ bin/`. Test files are NOT linted (so `as any` in tests is fine and pre-existing).
- **Do NOT touch** the other repo at `~/workspace/subrina-coder/projects/nestjs-infra/...`. Work only in the nax repo at `/Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax`.

## Background (why — read once, then ignore)

A run shipped a greenfield package with no real tests because greenfield detection forced the story off `three-session-tdd` onto a single-session strategy. Root cause analysis showed: (a) the three-session test-writer now writes good AC-driven tests when allowed to run; (b) it delegates "did you write tests?" to `greenfieldGateOp`; but (c) `greenfieldGateOp` uses `git ls-files`, which can't see the test-writer's freshly-authored untracked tests — so it would falsely fire `greenfield-no-tests`. That untracked-blindness is why the routing override exists to avoid three-session on greenfield at all. Fixing the gate (Task 1) makes three-session greenfield viable; making the override security-aware (Tasks 2–3) keeps the correct, higher-assurance strategy for security code.

`hasTestFilesOnDisk(workdir, patterns)` already exists in `src/context/greenfield.ts` (added earlier on this branch): a `Bun.Glob` filesystem scan that sees tracked AND untracked files and excludes `.nax/` (and `node_modules`, etc.) via `IGNORE_DIRS`. It throws if the workdir does not exist.

## File Structure

| File | Responsibility | Task |
|:--|:--|:--|
| `src/operations/test-presence-gate.ts` | (reference only — do not edit) the pattern Task 1 mirrors | — |
| `src/operations/greenfield-gate.ts` | Switch detection from `isGreenfieldStory` → `hasTestFilesOnDisk` | 1 |
| `test/unit/operations/greenfield-gate.test.ts` | Add git-untracked + `.nax/`-exclusion regression tests | 1 |
| `src/routing/classify.ts` | Add exported `isSecurityCriticalStory(title, tags)` helper; DRY `determineTestStrategy` | 2 |
| `src/routing/router.ts` | Re-export `isSecurityCriticalStory` from `./classify` (hop 1) | 2 |
| `src/routing/index.ts` | Re-export `isSecurityCriticalStory` from `./router` (hop 2) | 2 |
| `test/unit/routing/routing-core.test.ts` | Unit-test `isSecurityCriticalStory` | 2 |
| `src/pipeline/stages/routing.ts` | Make the greenfield override security-aware | 3 |
| `test/integration/routing/routing-stage-greenfield.test.ts` | Security story keeps three-session; non-security downgrades | 3 |
| `test/integration/routing/routing-stage-final-state.test.ts` | Update security-story greenfield assertions | 3 |
| `test/unit/pipeline/stages/routing-greenfield-monorepo.test.ts` | Update security-story greenfield assertions | 3 |

---

### Task 1: Greenfield gate detects test-writer output on disk

The gate runs AFTER the test-writer (`CANONICAL_ORDER`: test-writer → greenfield-gate → implementer). The test-writer's new tests are untracked at that point, so `git ls-files` misses them. Switch to `hasTestFilesOnDisk`.

**Files:**
- Modify: `src/operations/greenfield-gate.ts`
- Test: `test/unit/operations/greenfield-gate.test.ts`

**Interfaces:**
- Consumes: `hasTestFilesOnDisk(workdir: string, patterns: readonly string[]): Promise<boolean>` from `src/context/greenfield.ts` (already exists; throws on missing dir).
- Produces: `greenfieldGateOp` (unchanged `name: "greenfield-gate"`, output shape `{ success: boolean; hasPreExistingTests: boolean; pauseReason?: string }`). Behavior change only: detection now includes untracked on-disk tests and excludes `.nax/`.

- [ ] **Step 1: Write the failing regression test (git repo + untracked test file)**

Add these two tests to `test/unit/operations/greenfield-gate.test.ts`, inside the existing `describe("greenfieldGateOp — deterministic filesystem detection", ...)` block, after the last existing `test(...)`:

```typescript
  test("detects an UNTRACKED test file in a git repo (regression: must not use git ls-files)", async () => {
    const dir = makeTempDir();
    try {
      await Bun.spawn(["git", "init"], { cwd: dir }).exited;
      await writeFile(join(dir, "index.ts"), "export const x = 1;");
      await Bun.spawn(["git", "add", "index.ts"], { cwd: dir }).exited;
      await Bun.spawn(["git", "-c", "user.email=a@b.c", "-c", "user.name=t", "commit", "-m", "init"], {
        cwd: dir,
      }).exited;
      // Test-writer authored a test file — committed source, but the test is UNTRACKED.
      await mkdir(join(dir, "test"), { recursive: true });
      await writeFile(join(dir, "test", "index.test.ts"), "test('x', () => {});");
      const out = await (greenfieldGateOp as any).execute(
        {
          story: { id: "s5" } as any,
          workdir: dir,
          resolvedTestPatterns: { globs: ["test/**/*.test.ts"], regex: [/\.test\.ts$/], pathspec: [], testDirs: ["test"] },
        },
        { runtime: {} } as any,
      );
      expect(out.success).toBe(true);
      expect(out.hasPreExistingTests).toBe(true);
    } finally {
      cleanupTempDir(dir);
    }
  });

  test("does NOT count a .nax/ acceptance harness as a test file", async () => {
    const dir = makeTempDir();
    try {
      await mkdir(join(dir, ".nax", "features", "feat"), { recursive: true });
      await writeFile(join(dir, ".nax", "features", "feat", ".nax-acceptance.test.ts"), "test('ac', () => {});");
      const out = await (greenfieldGateOp as any).execute(
        {
          story: { id: "s6" } as any,
          workdir: dir,
          resolvedTestPatterns: { globs: ["**/*.test.ts"], regex: [/\.test\.ts$/], pathspec: [], testDirs: ["test"] },
        },
        { runtime: {} } as any,
      );
      expect(out.success).toBe(false);
      expect(out.hasPreExistingTests).toBe(false);
      expect(out.pauseReason).toBe("greenfield-no-tests");
    } finally {
      cleanupTempDir(dir);
    }
  });
```

- [ ] **Step 2: Run the new tests — verify the git-untracked one FAILS**

Run: `timeout 30 bun test test/unit/operations/greenfield-gate.test.ts --timeout=5000`
Expected: the `detects an UNTRACKED test file in a git repo` test FAILS (`expect(out.success).toBe(true)` receives `false`), because the current gate uses `isGreenfieldStory` → `git ls-files` and can't see the untracked file. (The `.nax/` test will already pass — `**/*.test.ts` requires no `test/` prefix but `.nax-acceptance.test.ts` is excluded by `IGNORE_DIRS` once the source change lands; before the change it uses `isGreenfieldStory` whose `git ls-files` also wouldn't list it, so it may already pass — that is fine.)

- [ ] **Step 3: Change the gate to use `hasTestFilesOnDisk`**

In `src/operations/greenfield-gate.ts`, change the import (line ~10) from:

```typescript
import { isGreenfieldStory } from "../context/greenfield";
```

to:

```typescript
import { hasTestFilesOnDisk } from "../context/greenfield";
```

Replace the entire `execute` method body with:

```typescript
    async execute(input: GreenfieldGateInput, _ctx: CallContext): Promise<GreenfieldGateOutput> {
      // Scan the FILESYSTEM (not `git ls-files`): the test-writer's freshly-authored
      // tests are still untracked when this gate runs, so a tracked-only check would
      // miss them and falsely report greenfield. hasTestFilesOnDisk also excludes
      // `.nax/` so the generated acceptance harness never counts.
      const globs: readonly string[] = input.resolvedTestPatterns.globs;
      let hasTests: boolean;
      try {
        hasTests = await hasTestFilesOnDisk(input.workdir, globs);
      } catch {
        // Scan failed (e.g. workdir vanished) — do not pause the story on a flaky scan.
        return { success: true, hasPreExistingTests: true };
      }
      if (!hasTests) {
        return { success: false, hasPreExistingTests: false, pauseReason: "greenfield-no-tests" };
      }
      return { success: true, hasPreExistingTests: true };
    },
```

Also update the op doc comment (the block directly above `export const greenfieldGateOp`) — replace its body with:

```typescript
/**
 * Greenfield Gate Operation — runs AFTER the test-writer and detects whether tests
 * now exist via a filesystem scan (`hasTestFilesOnDisk`). Tracked-only detection
 * (`git ls-files`) would miss the test-writer's freshly-authored, still-untracked
 * tests and false-fire `greenfield-no-tests`; the scan sees them and excludes `.nax/`
 * so nax's own acceptance harness never counts.
 *
 * When no tests exist, sets success=false + pauseReason="greenfield-no-tests".
 * No LLM session is opened — this is a pure deterministic filesystem check.
 */
```

- [ ] **Step 4: Update the stale "workdir does not exist" test comment**

In `test/unit/operations/greenfield-gate.test.ts`, find the test titled `returns success=true (safe fallback) when workdir does not exist (isGreenfieldStory absorbs error)`. Rename its title and replace its trailing comment so it reads:

```typescript
  test("returns success=true (safe fallback) when workdir does not exist (scan error absorbed)", async () => {
```

and replace the explanatory comment block just before its final `expect(...)` calls with:

```typescript
    // hasTestFilesOnDisk throws on a missing dir; the gate catches it and does NOT
    // pause the story on a flaky scan → success=true, hasPreExistingTests=true.
```

(Leave the assertions `expect(out.success).toBe(true)` / `expect(out.hasPreExistingTests).toBe(true)` unchanged.)

- [ ] **Step 5: Run the gate tests — verify all PASS**

Run: `timeout 30 bun test test/unit/operations/greenfield-gate.test.ts --timeout=5000`
Expected: PASS, 0 fail (the original tests + the 2 new regression tests).

- [ ] **Step 6: Typecheck + lint the changed source**

Run: `bun run typecheck`
Expected: exit 0, no errors.

Run: `bunx biome check src/operations/greenfield-gate.ts`
Expected: "No fixes applied" / no errors. (If it reports formatting, run `bunx biome check --write src/operations/greenfield-gate.ts` and re-run the check.)

- [ ] **Step 7: Commit**

```bash
git add src/operations/greenfield-gate.ts test/unit/operations/greenfield-gate.test.ts
git commit -m "fix(execution): greenfield-gate must scan disk, not git ls-files

The gate runs after the test-writer to validate it authored tests, but used
isGreenfieldStory (git ls-files, tracked-only) — so it could not see the
test-writer's freshly-authored untracked tests and would false-fire
greenfield-no-tests. Switch to hasTestFilesOnDisk (filesystem scan, sees
untracked, excludes .nax/). Prerequisite for letting three-session-tdd run on
greenfield."
```

---

### Task 2: `isSecurityCriticalStory` helper

A small, pure, exported predicate so the routing override can decide whether a greenfield story is security-critical (and must keep three-session-tdd). Reuses the existing `SECURITY_KEYWORDS` / `PUBLIC_API_KEYWORDS` constants already in `classify.ts` — these are the exact signals that force `three-session-tdd` in `determineTestStrategy`.

**Files:**
- Modify: `src/routing/classify.ts` (add + export the helper; DRY `determineTestStrategy`)
- Modify: `src/routing/router.ts` (re-export the helper from `./classify`)
- Modify: `src/routing/index.ts` (re-export the helper from `./router`)
- Test: `test/unit/routing/routing-core.test.ts`

**Interfaces:**
- Produces: `isSecurityCriticalStory(title: string, tags?: readonly string[]): boolean` — exported from `src/routing/classify.ts` and re-exported from the `@/routing` barrel. Returns `true` when the lower-cased `[title, ...tags]` text contains any `SECURITY_KEYWORDS` or `PUBLIC_API_KEYWORDS` entry. Description is intentionally excluded (BUG-031: only stable, immutable story fields).

- [ ] **Step 1: Write the failing unit test**

In `test/unit/routing/routing-core.test.ts`, add `isSecurityCriticalStory` to the EXISTING routing import line (do not add a second import line). The current line is:

```typescript
import { classifyComplexity, complexityToModelTier, determineTestStrategy, routeTask } from "../../../src/routing";
```

Change it to:

```typescript
import { classifyComplexity, complexityToModelTier, determineTestStrategy, isSecurityCriticalStory, routeTask } from "../../../src/routing";
```

Then add this `describe` block at the end of the file (top-level):

```typescript
describe("isSecurityCriticalStory", () => {
  test.each([
    ["security tag", "Add login", ["security"], true],
    ["auth in title", "Add user authentication", [], true],
    ["oauth keyword", "OAuth claim release", [], true],
    ["token keyword", "Refresh token rotation", [], true],
    ["public-api keyword", "Publish SDK endpoint", [], true],
    ["case-insensitive", "Add OAUTH Bridge", [], true],
    ["neutral story", "Fix typo in README", [], false],
    ["neutral with ui tag", "Render dashboard", ["ui"], false],
  ])("%s -> %p", (_label, title, tags, expected) => {
    expect(isSecurityCriticalStory(title, tags as string[])).toBe(expected);
  });

  test("defaults tags to empty array", () => {
    expect(isSecurityCriticalStory("Add auth guard")).toBe(true);
    expect(isSecurityCriticalStory("Rename variable")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test — verify it FAILS to import**

Run: `timeout 30 bun test test/unit/routing/routing-core.test.ts --timeout=5000`
Expected: FAIL — `isSecurityCriticalStory` is not exported yet (import error / `undefined is not a function`).

- [ ] **Step 3: Add the helper to `classify.ts`**

In `src/routing/classify.ts`, add this exported function immediately AFTER the `PUBLIC_API_KEYWORDS` array declaration (around line 75, before the `Core classification functions` comment):

```typescript
/**
 * True when a story's title/tags indicate security-critical or public-API work —
 * the same signals that force three-session-tdd in determineTestStrategy. The
 * greenfield routing override uses this to KEEP three-session-tdd on greenfield for
 * these stories (preserving the verifier + test/impl isolation) instead of
 * downgrading to a single-session strategy. Description is excluded (BUG-031:
 * only stable, immutable story fields).
 */
export function isSecurityCriticalStory(title: string, tags: readonly string[] = []): boolean {
  const text = [title, ...tags].join(" ").toLowerCase();
  return SECURITY_KEYWORDS.some((kw) => text.includes(kw)) || PUBLIC_API_KEYWORDS.some((kw) => text.includes(kw));
}
```

Then DRY up `determineTestStrategy` (it already computes the same thing). Inside `determineTestStrategy`, replace these four lines:

```typescript
  const text = [title, ...(tags ?? [])].join(" ").toLowerCase();

  const isSecurityCritical = SECURITY_KEYWORDS.some((kw) => text.includes(kw));
  const isPublicApi = PUBLIC_API_KEYWORDS.some((kw) => text.includes(kw));

  if (isSecurityCritical || isPublicApi) return "three-session-tdd";
```

with:

```typescript
  if (isSecurityCriticalStory(title, tags)) return "three-session-tdd";
```

(`tags` already defaults to `[]` in the signature, so no `?? []` is needed. The `text` local is not used after this point — the rest of `determineTestStrategy` branches on `complexity` only — so removing it is safe.)

- [ ] **Step 4: Export through the two-hop barrel chain**

The public classify symbols flow `classify.ts` → re-exported by `router.ts` → re-exported by `index.ts`. `isSecurityCriticalStory` must be added at BOTH re-export hops (there is NO `from "./classify"` block in `index.ts`).

(a) In `src/routing/router.ts`, find the line (around line 26):

```typescript
export { classifyComplexity, determineTestStrategy } from "./classify";
```

and change it to:

```typescript
export { classifyComplexity, determineTestStrategy, isSecurityCriticalStory } from "./classify";
```

(b) In `src/routing/index.ts`, find the `export { ... } from "./router";` block that lists `classifyComplexity` and `determineTestStrategy` (around line 14-22) and add `isSecurityCriticalStory,` to it, immediately after `determineTestStrategy,`:

```typescript
export {
  routeStory,
  routeTask,
  classifyComplexity,
  determineTestStrategy,
  isSecurityCriticalStory,
  complexityToModelTier,
  tryLlmBatchRoute,
  _tryLlmBatchRouteDeps,
} from "./router";
```

- [ ] **Step 5: Run the helper test + the classify regression tests — verify PASS**

Run: `timeout 30 bun test test/unit/routing/routing-core.test.ts test/unit/routing/strategies/keyword.test.ts --timeout=5000`
Expected: PASS, 0 fail. (`keyword.test.ts` exercises `determineTestStrategy` — confirms the DRY refactor did not change classification behavior.)

- [ ] **Step 6: Typecheck + lint**

Run: `bun run typecheck`
Expected: exit 0.

Run: `bunx biome check src/routing/classify.ts src/routing/index.ts`
Expected: no errors. (If formatting, `--write` then re-check.)

- [ ] **Step 7: Commit**

```bash
git add src/routing/classify.ts src/routing/index.ts test/unit/routing/routing-core.test.ts
git commit -m "feat(routing): add isSecurityCriticalStory helper

Exported predicate over title+tags (SECURITY_KEYWORDS | PUBLIC_API_KEYWORDS) —
the same signals that force three-session-tdd. Used next by the greenfield
override to keep security-critical greenfield stories on three-session-tdd.
DRY: determineTestStrategy now reuses it."
```

---

### Task 3: Security-aware greenfield routing override

With the gate fixed (Task 1), three-session-tdd can run correctly on greenfield. Keep it for security-critical stories; non-security greenfield still downgrades to `tdd-simple`.

**Files:**
- Modify: `src/pipeline/stages/routing.ts`
- Test: `test/integration/routing/routing-stage-greenfield.test.ts`
- Test: `test/integration/routing/routing-stage-final-state.test.ts`
- Test: `test/unit/pipeline/stages/routing-greenfield-monorepo.test.ts`

**Interfaces:**
- Consumes: `isSecurityCriticalStory(title, tags?)` from `@/routing` (Task 2).
- Produces: routing behavior — greenfield + security-critical → `testStrategy` unchanged (stays `three-session-tdd` / `three-session-tdd-lite`), no `GREENFIELD OVERRIDE` reasoning appended; greenfield + non-security → `testStrategy = "tdd-simple"` with `GREENFIELD OVERRIDE` reasoning (unchanged from current behavior).

- [ ] **Step 1: Write the failing tests (security preserved + non-security downgraded)**

In `test/integration/routing/routing-stage-greenfield.test.ts`:

(a) The existing test `forces test-after when no test files exist (greenfield)` uses the default story (`title: "Add user authentication"`, `tags: ["security", "auth"]`) — now security-critical. Replace that whole `test(...)` with:

```typescript
  test("keeps three-session-tdd for SECURITY-critical greenfield (no downgrade)", async () => {
    const ctx = createTestContext(workdir, true);
    // default story is "Add user authentication" / tags [security, auth] → security-critical

    const result = await routingStage.execute(ctx);

    expect(result.action).toBe("continue");
    expect(ctx.routing?.testStrategy).toBe("three-session-tdd");
    expect(ctx.routing?.reasoning).not.toContain("GREENFIELD OVERRIDE");
  });

  test("downgrades NON-security greenfield to tdd-simple", async () => {
    const ctx = createTestContext(workdir, true);
    ctx.story.title = "Render dashboard widget";
    ctx.story.description = "Add a chart component";
    ctx.story.acceptanceCriteria = ["Renders chart"];
    ctx.story.tags = [];
    ctx.story.routing = {
      complexity: "complex",
      modelTier: "balanced",
      testStrategy: "three-session-tdd",
      reasoning: "complex non-security",
    };

    const result = await routingStage.execute(ctx);

    expect(result.action).toBe("continue");
    expect(ctx.routing?.testStrategy).toBe("tdd-simple");
    expect(ctx.routing?.reasoning).toContain("GREENFIELD OVERRIDE");
  });
```

> Notes on the fixtures (both verified against `resolveRouting` in `src/routing/router.ts:160`):
> - `resolveRouting` short-circuits and returns the cached strategy verbatim ONLY when `story.routing.complexity` AND `story.routing.testStrategy` are BOTH set. The non-security fixture therefore sets both (`complexity: "complex"`, `testStrategy: "three-session-tdd"`) — do not drop either, or it falls through to live keyword classification and the neutral title yields `tdd-simple` directly (no override, no `GREENFIELD OVERRIDE` reasoning), failing the assertion.
> - The security test relies on LIVE classification: the default story has no `story.routing`, so `resolveRouting` runs keyword classification on `"Add user authentication"` + tags `["security","auth"]` → `determineTestStrategy` returns `three-session-tdd` (security keywords force it). The override then keeps it because `isSecurityCriticalStory` is `true`.
> - `tags = []` + a neutral title (no `auth/security/oauth/token/...` or `public api/sdk/endpoint/...` substrings) guarantees `isSecurityCriticalStory` returns `false`.

- [ ] **Step 2: Run — verify the security test FAILS**

Run: `timeout 30 bun test test/integration/routing/routing-stage-greenfield.test.ts --timeout=10000`
Expected: `keeps three-session-tdd for SECURITY-critical greenfield` FAILS (current code downgrades it to `tdd-simple`). The non-security test passes already.

- [ ] **Step 3: Make the routing override security-aware**

In `src/pipeline/stages/routing.ts`:

Add `isSecurityCriticalStory` to the `@/routing` import (line 17):

```typescript
import { clearCache, complexityToModelTier, isSecurityCriticalStory, resolveRouting } from "@/routing";
```

Replace the `if (isGreenfield) { ... }` block (the one that currently always sets `routing.testStrategy = "tdd-simple"`) with:

```typescript
      const isGreenfield = await _routingDeps.isGreenfieldStory(ctx.story, greenfieldScanDir, resolved?.globs);
      if (isGreenfield) {
        if (isSecurityCriticalStory(ctx.story.title, ctx.story.tags)) {
          // Security-critical greenfield: KEEP three-session-tdd. The greenfield gate
          // (disk detection) now validates the test-writer's authored tests, and the
          // verifier + test/impl isolation matter for security code. Do not downgrade.
          logger.info("routing", "Greenfield + security-critical — keeping three-session strategy", {
            storyId: ctx.story.id,
            strategy: routing.testStrategy,
            scanDir: greenfieldScanDir,
          });
        } else {
          // Non-security greenfield uses the single-session test-first strategy:
          // cheaper than three sessions, and tdd-simple writes tests FIRST (RED) from
          // the ACs — guaranteeing non-empty, AC-anchored coverage.
          logger.info("routing", "Greenfield detected — forcing tdd-simple strategy", {
            storyId: ctx.story.id,
            originalStrategy: routing.testStrategy,
            scanDir: greenfieldScanDir,
          });
          routing.testStrategy = "tdd-simple";
          routing.reasoning = `${routing.reasoning} [GREENFIELD OVERRIDE: No test files exist, using tdd-simple (test-first, single-session) instead of three-session TDD]`;
        }
      }
```

- [ ] **Step 4: Run the greenfield integration test — verify PASS**

Run: `timeout 30 bun test test/integration/routing/routing-stage-greenfield.test.ts --timeout=10000`
Expected: the two new tests PASS. Other tests in the file may now FAIL if they use a security story and assert `tdd-simple` — those are handled in Step 5.

- [ ] **Step 5: Sweep the remaining greenfield assertions across all three test files**

Run all three together to surface every flipped assertion:

`timeout 60 bun test test/integration/routing/routing-stage-greenfield.test.ts test/integration/routing/routing-stage-final-state.test.ts test/unit/pipeline/stages/routing-greenfield-monorepo.test.ts --timeout=10000`

For EACH failing test, apply this rule based on the story under test (its `title` + `tags`; check `isSecurityCriticalStory` mentally — any of `auth security permission jwt oauth token encryption secret credential password rbac casl` OR `public api / breaking change / external / consumer / sdk / npm publish / release / endpoint`):

- **Story is security-critical (e.g. title "Add user authentication", "Config & Auth"; tags include `security`/`auth`):** the greenfield override no longer downgrades it. Change the assertion from `toBe("tdd-simple")` to the story's ORIGINAL strategy (`"three-session-tdd"` or `"three-session-tdd-lite"` — whatever the test set as the cached/classified strategy), and change `expect(...reasoning).toContain("GREENFIELD OVERRIDE")` to `expect(...reasoning).not.toContain("GREENFIELD OVERRIDE")`. Update the test title if it says "tdd-simple"/"override".
- **Story is non-security:** keep `toBe("tdd-simple")` + `GREENFIELD OVERRIDE` (unchanged behavior). If a test had no non-security counterpart, leave it.
- **Tests asserting "test files exist → preserve three-session" or "greenfieldDetection disabled":** unaffected — leave unchanged.

Concretely, expect to update:
- `routing-stage-greenfield.test.ts` `handles both TDD and TDD-lite strategies` (uses the security default story with a cached `three-session-tdd-lite`) → assert `toBe("three-session-tdd-lite")` and `.not.toContain("GREENFIELD OVERRIDE")`; retitle to `keeps three-session-tdd-lite for security-critical greenfield`.
- `routing-stage-greenfield.test.ts` `ignores test files in node_modules` (security default story, greenfield) → assert `toBe("three-session-tdd")` and `.not.toContain("GREENFIELD OVERRIDE")`. (The node_modules-ignored behavior is still exercised: it's still greenfield, just no longer downgraded.)
- `routing-stage-final-state.test.ts` lines ~181, ~201, ~235: these set `testStrategy: "three-session-tdd"` (or `-lite`) on the security default story and assert `tdd-simple`. Flip each to assert the original three-session strategy and `.not.toContain("GREENFIELD OVERRIDE")`. (Leave the line ~215/218 test that asserts `toMatch(/three-session-tdd/)` + `.not.toContain("GREENFIELD OVERRIDE")` — it already expects preservation.)
- `routing-greenfield-monorepo.test.ts` the test with story `title: "Config & Auth"` asserting `tdd-simple` → flip to assert the cached `three-session-tdd` and `.not.toContain("GREENFIELD OVERRIDE")`.

For any sweep test where you want to KEEP coverage of the non-security downgrade path, either rely on the new `downgrades NON-security greenfield to tdd-simple` test (Step 1) or set that specific test's `ctx.story.tags = []` and a neutral title and keep its `tdd-simple` assertion — but only if the test's intent is the downgrade path, not security preservation.

- [ ] **Step 6: Re-run all three test files — verify PASS**

Run: `timeout 60 bun test test/integration/routing/routing-stage-greenfield.test.ts test/integration/routing/routing-stage-final-state.test.ts test/unit/pipeline/stages/routing-greenfield-monorepo.test.ts --timeout=10000`
Expected: PASS, 0 fail.

- [ ] **Step 7: Typecheck + lint**

Run: `bun run typecheck`
Expected: exit 0.

Run: `bunx biome check src/pipeline/stages/routing.ts`
Expected: no errors. (If formatting, `--write` then re-check.)

- [ ] **Step 8: Broad regression sweep**

Run: `timeout 200 bun test test/unit/routing/ test/unit/pipeline/ test/integration/routing/ test/unit/operations/ test/unit/execution/ --timeout=15000`
Expected: PASS, 0 fail. Investigate and fix any failure before committing — do not skip or weaken tests.

- [ ] **Step 9: Commit**

```bash
git add src/pipeline/stages/routing.ts test/integration/routing/routing-stage-greenfield.test.ts test/integration/routing/routing-stage-final-state.test.ts test/unit/pipeline/stages/routing-greenfield-monorepo.test.ts
git commit -m "feat(routing): keep three-session-tdd for security-critical greenfield

With the greenfield gate now validating test-writer output on disk, three-session
TDD runs correctly on greenfield. Stop downgrading security-critical greenfield
stories to single-session — keep three-session-tdd so the verifier and test/impl
isolation still apply. Non-security greenfield still uses tdd-simple."
```

---

## Out of Scope (explicit non-goals — do NOT implement)

- **The escalation fallback** in `src/execution/escalation/tier-escalation.ts` (`greenfield-no-tests` → switch to `tdd-simple`) stays as-is. It is a last-resort safety net: if a security three-session story's test-writer genuinely produces nothing across retries, downgrading to single-session to salvage the story is acceptable. Making it security-aware is a separate decision.
- **Removing the `tdd.greenfieldDetection` config flag** — keep it; it still gates the whole override.
- **Deduplicating `SECURITY_KEYWORDS`** between `classify.ts` and `router.ts` — out of scope (YAGNI for this fix).
- **The test-presence gate** (`testPresenceGateOp`) and the `.nax/` rectifier-prompt disqualifier already on this branch — do not modify.

## Self-Review (completed by plan author, then re-verified against code)

- **Spec coverage:** Step 1 (gate disk-detection) = Task 1. Step 2 (security-aware routing) = Tasks 2 + 3. The `isSecurityCriticalStory` precondition is Task 2. ✓
- **Placeholder scan:** no TBD/"handle edge cases"; every code step shows full code; the Step-5 sweep gives an explicit transformation rule plus the concrete list of tests to change (line numbers will drift, so the rule + grep-by-keyword is authoritative). ✓
- **Type consistency:** `isSecurityCriticalStory(title: string, tags?: readonly string[]): boolean` is defined in Task 2 and consumed with `(ctx.story.title, ctx.story.tags)` in Task 3 — verified `UserStory.tags` is `string[]` (`src/prd/types.ts:129`), assignable to `readonly string[]`. `hasTestFilesOnDisk(workdir, patterns)` matches the existing export in `src/context/greenfield.ts:72`. Gate output field `hasPreExistingTests` preserved unchanged. ✓
- **Ordering:** Task 1 (gate correct) precedes Task 3 (lets three-session greenfield reach the now-correct gate) — required. Task 2 precedes Task 3 (provides the predicate). ✓

### Corrections made during code re-verification

1. **Barrel export path (was wrong):** the public classify symbols are NOT exported via a `from "./classify"` block in `index.ts`. They flow `classify.ts` → `router.ts:26` (`export {...} from "./classify"`) → `index.ts` (`export {...} from "./router"`). Task 2 Step 4 now patches BOTH hops. (Verified: `src/routing/router.ts:26`, `src/routing/index.ts:14-22`.)
2. **`resolveRouting` cached short-circuit (verified, fixtures depend on it):** `src/routing/router.ts:160` returns the cached strategy verbatim only when `story.routing.complexity` AND `story.routing.testStrategy` are both set. Task 3's non-security fixture sets both; the security fixture deliberately sets neither (relies on live classification giving `three-session-tdd` from the security keywords). Note added to Task 3 Step 1.
3. **Sweep targets confirmed security-critical:** `routing-stage-final-state.test.ts` default story = "Add user authentication" / tags `[security, auth]`; `routing-greenfield-monorepo.test.ts` story = "Config & Auth" (title contains `auth`). Both flip from `tdd-simple` to three-session-preserved under the new override — Step 5's listed targets are correct.
4. **`determineTestStrategy` refactor:** `tags` already defaults to `[]` in its signature (`src/routing/classify.ts:119`), so the helper call uses `tags` (no `?? []`).
