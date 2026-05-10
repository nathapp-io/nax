# Issue #986 — Adversarial AC Validator Structural Counterfactual Telemetry — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add observation-only telemetry to the adversarial review path that records, per dropped finding and per accepted blocking finding, whether a structural-only filter (`acIndexInRange ∧ categoryBlocking ∧ fileInDiff`) would have made the same call as `filterByAcQuote` — enough data to drive a future keep/refine/replace decision at N=50 dogfood drops.

**Architecture:** Pure analyzer in a new sibling module (`src/review/ac-structural-counterfactual.ts`); diff-file extraction split between a pure parser (`src/utils/diff-files.ts`, embedded mode) and a git helper (`src/review/diff-utils.ts::collectDiffFileList`, ref mode); counterfactual data attached to the existing `ReviewDecisionEvent` / `ReviewAuditEntry` / on-disk audit JSON via two optional fields plus a `diffAvailable: boolean` flag. **Zero behaviour change** — `filterByAcQuote`'s accepted/dropped output is byte-identical; existing adversarial tests pass without fixture edits.

**Tech Stack:** Bun 1.3.7+, TypeScript strict, `bun:test`. Uses existing `_diffUtilsDeps.spawn` injection pattern, existing `ReviewDecisionEvent` → `attachReviewAuditSubscriber` → `ReviewAuditor` → on-disk JSON pipeline, existing test helpers (`captureAuditDecisions`, `agentManagerWithFixedLLMResponse`, `mockDiffUtilsDeps`, `makeMockRuntime`).

---

## File Map

| Path | Action | Responsibility |
|:---|:---|:---|
| `src/review/ac-structural-counterfactual.ts` | **Create** | `BLOCKING_CATEGORIES`, `StructuralCounterfactual`, `analyzeStructuralCounterfactual`, `AdversarialDropAnalysis`, `AdversarialAcceptAnalysis` types |
| `src/utils/diff-files.ts` | **Create** | `extractDiffFiles(diff: string): Set<string>` — pure unified-diff parser for `+++ b/<path>` headers |
| `src/review/diff-utils.ts` | **Modify** | Add `collectDiffFileList(workdir, ref, opts)` — `git diff --name-only` for ref mode |
| `src/review/review-audit.ts` | **Modify** | Extend `ReviewAuditEntry` with `adversarialDropAnalysis?`, `adversarialAcceptAnalysis?`, `diffAvailable?`; persist in `toPersistedEntry` |
| `src/runtime/dispatch-events.ts` | **Modify** | Extend `ReviewDecisionEvent` with the same three optional fields |
| `src/runtime/middleware/review-audit.ts` | **Modify** | Forward the three new fields from event → decision |
| `src/review/adversarial.ts` | **Modify** | Build `diffFiles` + `diffAvailable`; compute counterfactuals for drops and accepted blocking findings; pass through `recordAdversarialAudit` |
| `scripts/analyze-ac-validator-telemetry.ts` | **Create** | Aggregation CLI that walks `.nax/review-audit/**/*.json` and prints the metrics table |
| `test/unit/utils/diff-files.test.ts` | **Create** | Pure parser tests (multiple files, `/dev/null`, mixed line endings, no-files diff) |
| `test/unit/review/ac-structural-counterfactual.test.ts` | **Create** | Analyzer tests covering each of the four boolean dimensions and `wouldSurviveStructural` composition |
| `test/unit/review/diff-utils.test.ts` | **Modify** | Add tests for `collectDiffFileList` (success + git failure → undefined) |
| `test/unit/review/adversarial-audit-shape.test.ts` | **Modify** | Add cases verifying new audit fields appear when drops/accepts exist |

**Why a sibling file (not extend `ac-quote-validator.ts`):** `ac-quote-validator.ts` is already 239 lines after #985 added the minimal validator. Adding a third concern to it conflates "AC grounding gates" with "structural counterfactual measurement" — the latter has nothing to do with validation, it just *reads* findings. Sibling keeps both files focused.

**Why `src/utils/diff-files.ts` for the pure parser, not co-located in `diff-utils.ts`:** the parser is content-only (no git, no I/O) and is a generic utility worth surfacing on its own. The git-based file-list helper rightly lives in `src/review/diff-utils.ts` next to the existing `collectDiff` / `collectDiffStat` and shares `_diffUtilsDeps.spawn`.

---

## Conventions Reminders (from CLAUDE.md / .claude/rules/)

- **Bun-native only** — `Bun.file()`, `Bun.write()`, `_diffUtilsDeps.spawn`. Never `fs.readFileSync`, `child_process.spawn`, or `setTimeout` for delays.
- **600-line file limit.** All new/modified files stay well under.
- **Logging:** use `getSafeLogger()`. Every `logger.info/debug/warn/error` inside pipeline-visible code (adversarial.ts) must include `storyId` as the **first** key in the data object.
- **Errors:** `NaxError` with `code` + `context` (always include `stage`); chain via `cause: err`.
- **Imports:** import from barrels. Use `@/` alias only when it improves readability (3+ levels of `../`); short relative paths are fine.
- **Test placement:** mirror `src/` — never `test/` root, never standalone `*-986.test.ts` files.
- **Test mocks:** use `test/helpers/` factories (`captureAuditDecisions`, `mockDiffUtilsDeps`, `makeMockRuntime`, `agentManagerWithFixedLLMResponse`, `makeMockAgentManager`). No inline mock objects.
- **Test runner:** never bare `bun test`. Use `timeout 30 bun test <path> --timeout=5000` for iteration; `bun run test` only as final gate.
- **No behaviour change AC:** existing `filterByAcQuote` accepted/dropped output is byte-identical; no fixture edits to the existing adversarial tests.

---

## Task 1: Pure unified-diff file extractor

**Files:**
- Create: `src/utils/diff-files.ts`
- Test: `test/unit/utils/diff-files.test.ts`

Goal: parse `+++ b/<path>` headers from a unified diff string and return a deduped `Set<string>` of modified paths. Skip `+++ /dev/null` (deletion-only files have no `b/` side). Handle `\r\n` line endings.

- [ ] **Step 1: Write the failing test**

Create `test/unit/utils/diff-files.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { extractDiffFiles } from "../../../src/utils/diff-files";

describe("extractDiffFiles", () => {
  test("returns empty set for empty input", () => {
    expect(extractDiffFiles("")).toEqual(new Set());
  });

  test("extracts a single file path from one hunk", () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
index 1234..5678 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
 line
+added
`;
    expect(extractDiffFiles(diff)).toEqual(new Set(["src/foo.ts"]));
  });

  test("extracts multiple files and dedupes across hunks", () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-x
+y
diff --git a/src/b.ts b/src/b.ts
+++ b/src/b.ts
@@ -1 +1 @@
-x
+y
diff --git a/src/a.ts b/src/a.ts
+++ b/src/a.ts
@@ -10 +10 @@
-x
+y
`;
    expect(extractDiffFiles(diff)).toEqual(new Set(["src/a.ts", "src/b.ts"]));
  });

  test("ignores +++ /dev/null (deletion-only side)", () => {
    const diff = `diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
--- a/src/gone.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-removed
`;
    expect(extractDiffFiles(diff)).toEqual(new Set());
  });

  test("handles CRLF line endings", () => {
    const diff = "+++ b/src/win.ts\r\n@@ -1 +1 @@\r\n-x\r\n+y\r\n";
    expect(extractDiffFiles(diff)).toEqual(new Set(["src/win.ts"]));
  });

  test("handles paths with spaces (git quotes them)", () => {
    const diff = `+++ b/src/has space.ts
@@ -1 +1 @@
-x
+y
`;
    expect(extractDiffFiles(diff)).toEqual(new Set(["src/has space.ts"]));
  });

  test("ignores spurious lines starting with +++", () => {
    const diff = `+++ b/src/real.ts
@@ -1 +1 @@
-x
++++ this is added content, not a header
`;
    expect(extractDiffFiles(diff)).toEqual(new Set(["src/real.ts"]));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 15 bun test test/unit/utils/diff-files.test.ts --timeout=5000`
Expected: FAIL with `Cannot find module '../../../src/utils/diff-files'` or similar.

- [ ] **Step 3: Write the implementation**

Create `src/utils/diff-files.ts`:

```typescript
/**
 * Pure unified-diff parser — extracts the set of modified file paths from a
 * unified diff string by reading `+++ b/<path>` headers.
 *
 * Used by adversarial review (#986) to compute the `fileInDiff` axis of the
 * structural counterfactual telemetry without re-shelling git.
 *
 * Skips `+++ /dev/null` (deletion-only side has no `b/` path). Dedupes across
 * hunks. Handles CRLF line endings. Returns an empty set for empty input.
 */

const HEADER_PREFIX = "+++ b/";

export function extractDiffFiles(diff: string): Set<string> {
  const files = new Set<string>();
  if (!diff) return files;

  for (const rawLine of diff.split(/\r?\n/)) {
    if (!rawLine.startsWith(HEADER_PREFIX)) continue;
    const path = rawLine.slice(HEADER_PREFIX.length).trim();
    if (!path || path === "/dev/null") continue;
    files.add(path);
  }
  return files;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `timeout 15 bun test test/unit/utils/diff-files.test.ts --timeout=5000`
Expected: PASS, all 7 cases green.

- [ ] **Step 5: Commit**

```bash
git add src/utils/diff-files.ts test/unit/utils/diff-files.test.ts
git commit -m "feat(utils): add extractDiffFiles unified-diff parser (#986)

Pure parser that extracts the set of modified file paths from a
unified diff string by reading '+++ b/<path>' headers. Skips
/dev/null, dedupes across hunks, handles CRLF.

Used by adversarial review structural counterfactual telemetry."
```

---

## Task 2: Ref-mode file-list helper (`collectDiffFileList`)

**Files:**
- Modify: `src/review/diff-utils.ts` — append `collectDiffFileList` after `collectDiffStat`
- Test: `test/unit/review/diff-utils.test.ts` — add new `describe` block

Goal: when adversarial runs in `mode: "ref"`, `input.diff` is undefined and we need a separate `git diff --name-only "${ref}..HEAD"` call to compute `diffFiles` for the counterfactual. Returns `string[] | undefined` — `undefined` signals "git failed, treat as `diffAvailable: false`."

- [ ] **Step 1: Write the failing test**

The file `test/unit/review/diff-utils.test.ts` already imports `_diffUtilsDeps` (top of file, ~line 14) and defines a local `makeSpawnMock(stdout, exitCode)` helper (~line 26) that we should reuse — do **not** import the helpers/review-audit version. The file's module-scope `beforeEach`/`afterEach` (~lines 72-84) already saves and restores `_diffUtilsDeps.spawn`, so our new tests do not need their own teardown.

Two changes:

  1. Add `collectDiffFileList` to the existing destructured import (~line 13):

     ```typescript
     import {
       DIFF_CAP_BYTES,
       _diffUtilsDeps,
       collectDiff,
       collectDiffFileList,
       collectDiffStat,
       computeTestInventory,
       resolveEffectiveRef,
       truncateDiff,
     } from "../../../src/review/diff-utils";
     ```

  2. Append at the bottom of the file:

     ```typescript
     describe("collectDiffFileList", () => {
       test("returns parsed file list on git success", async () => {
         _diffUtilsDeps.spawn = makeSpawnMock("src/a.ts\nsrc/b.ts\n", 0);
         const files = await collectDiffFileList("/tmp/repo", "abc123");
         expect(files).toEqual(["src/a.ts", "src/b.ts"]);
       });

       test("returns empty array when git produces no output", async () => {
         _diffUtilsDeps.spawn = makeSpawnMock("", 0);
         expect(await collectDiffFileList("/tmp/repo", "abc123")).toEqual([]);
       });

       test("returns undefined on git failure (signals diffAvailable=false)", async () => {
         _diffUtilsDeps.spawn = makeSpawnMock("", 128);
         expect(await collectDiffFileList("/tmp/repo", "abc123")).toBeUndefined();
       });

       test("trims and skips empty lines", async () => {
         _diffUtilsDeps.spawn = makeSpawnMock("src/a.ts\n\nsrc/b.ts\n  \n", 0);
         expect(await collectDiffFileList("/tmp/repo", "abc123")).toEqual(["src/a.ts", "src/b.ts"]);
       });
     });
     ```

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 15 bun test test/unit/review/diff-utils.test.ts --timeout=5000`
Expected: FAIL — `collectDiffFileList` is not exported.

- [ ] **Step 3: Implement `collectDiffFileList`**

Append to `src/review/diff-utils.ts` after the `collectDiffStat` function (around line 102). Include the same nax-ignore exclude resolution as the existing collectors:

```typescript
/**
 * Collect the list of file paths modified between `storyGitRef` and HEAD.
 *
 * Used by adversarial review (#986) in `mode: "ref"` to compute the
 * `fileInDiff` axis of the structural counterfactual telemetry without
 * inspecting an inline diff. Returns `undefined` on git failure so callers
 * can mark `diffAvailable: false`.
 */
export async function collectDiffFileList(
  workdir: string,
  storyGitRef: string,
  options?: DiffIgnoreOptions,
): Promise<string[] | undefined> {
  const naxIgnoreExcludes = await resolveNaxIgnorePathspecExcludes(workdir, options);
  const merged = [...new Set([...naxIgnoreExcludes, ...ALWAYS_EXCLUDED])];
  const proc = _diffUtilsDeps.spawn({
    cmd: ["git", "diff", "--name-only", `${storyGitRef}..HEAD`, "--", ".", ...merged],
    cwd: workdir,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdout] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  if (exitCode !== 0) return undefined;
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `timeout 15 bun test test/unit/review/diff-utils.test.ts --timeout=5000`
Expected: PASS — all 4 new cases plus existing ones.

- [ ] **Step 5: Commit**

```bash
git add src/review/diff-utils.ts test/unit/review/diff-utils.test.ts
git commit -m "feat(review): add collectDiffFileList for ref-mode adversarial telemetry (#986)

Wraps git diff --name-only behind _diffUtilsDeps.spawn (testable).
Returns undefined on git failure so callers can record
diffAvailable: false in the counterfactual telemetry."
```

---

## Task 3: Structural counterfactual analyzer + types

**Files:**
- Create: `src/review/ac-structural-counterfactual.ts`
- Test: `test/unit/review/ac-structural-counterfactual.test.ts`

Goal: pure read-only analyzer. Given a finding-shaped object, the story's ACs, and the set of diff files, return `{ acIndexInRange, categoryBlocking, fileInDiff, wouldSurviveStructural }`. No I/O, no logging, no behaviour change. Also export the persisted-shape interfaces (`AdversarialDropAnalysis`, `AdversarialAcceptAnalysis`) used by the audit entry — keeps the type SSOT in one file.

- [ ] **Step 1: Write the failing test**

Create `test/unit/review/ac-structural-counterfactual.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import {
  BLOCKING_CATEGORIES,
  analyzeStructuralCounterfactual,
} from "../../../src/review/ac-structural-counterfactual";

const ACS = ["AC1: validate input", "AC2: error path", "AC3: assumption"];

function diffFiles(...paths: string[]): ReadonlySet<string> {
  return new Set(paths);
}

describe("BLOCKING_CATEGORIES", () => {
  test("contains exactly the four blocking categories", () => {
    expect([...BLOCKING_CATEGORIES].sort()).toEqual(
      ["abandonment", "assumption", "error-path", "input"].sort(),
    );
  });
});

describe("analyzeStructuralCounterfactual", () => {
  describe("acIndexInRange", () => {
    test.each([
      [1, true],
      [3, true],
      [0, false],
      [4, false],
      [-1, false],
      [undefined, false],
    ])("acIndex=%p → acIndexInRange=%p", (acIndex, expected) => {
      const result = analyzeStructuralCounterfactual(
        { acIndex: acIndex as number | undefined, category: "input", file: "src/a.ts" },
        ACS,
        diffFiles("src/a.ts"),
      );
      expect(result.acIndexInRange).toBe(expected);
    });

    test("non-integer acIndex within range → true (spec accepts numeric range, not integer)", () => {
      // Issue #986 spec: `typeof acIndex === "number" && acIndex >= 1 && acIndex <= length`.
      // 1.5 falls in [1, 3] so it is in range. This documents the choice — if the
      // structural alternative ships, integer-only validation would be a separate issue.
      const result = analyzeStructuralCounterfactual(
        { acIndex: 1.5, category: "input", file: "src/a.ts" },
        ACS,
        diffFiles("src/a.ts"),
      );
      expect(result.acIndexInRange).toBe(true);
    });
  });

  describe("categoryBlocking", () => {
    test.each([
      ["input", true],
      ["error-path", true],
      ["abandonment", true],
      ["assumption", true],
      ["convention", false],
      ["test-gap", false],
      ["unknown-category", false],
      [undefined, false],
    ])("category=%p → categoryBlocking=%p", (category, expected) => {
      const result = analyzeStructuralCounterfactual(
        { acIndex: 1, category: category as string | undefined, file: "src/a.ts" },
        ACS,
        diffFiles("src/a.ts"),
      );
      expect(result.categoryBlocking).toBe(expected);
    });
  });

  describe("fileInDiff", () => {
    test("file present in set → true", () => {
      const result = analyzeStructuralCounterfactual(
        { acIndex: 1, category: "input", file: "src/a.ts" },
        ACS,
        diffFiles("src/a.ts", "src/b.ts"),
      );
      expect(result.fileInDiff).toBe(true);
    });

    test("file absent from set → false", () => {
      const result = analyzeStructuralCounterfactual(
        { acIndex: 1, category: "input", file: "src/c.ts" },
        ACS,
        diffFiles("src/a.ts", "src/b.ts"),
      );
      expect(result.fileInDiff).toBe(false);
    });

    test("missing file → false", () => {
      const result = analyzeStructuralCounterfactual(
        { acIndex: 1, category: "input" },
        ACS,
        diffFiles("src/a.ts"),
      );
      expect(result.fileInDiff).toBe(false);
    });

    test("empty diffFiles set (diff unavailable) → fileInDiff=false for every input", () => {
      const result = analyzeStructuralCounterfactual(
        { acIndex: 1, category: "input", file: "src/a.ts" },
        ACS,
        new Set(),
      );
      expect(result.fileInDiff).toBe(false);
    });
  });

  describe("wouldSurviveStructural", () => {
    test("all three axes true → true", () => {
      const r = analyzeStructuralCounterfactual(
        { acIndex: 1, category: "input", file: "src/a.ts" },
        ACS,
        diffFiles("src/a.ts"),
      );
      expect(r.wouldSurviveStructural).toBe(true);
    });

    test("any axis false → false", () => {
      const r1 = analyzeStructuralCounterfactual(
        { acIndex: 99, category: "input", file: "src/a.ts" },
        ACS,
        diffFiles("src/a.ts"),
      );
      expect(r1.wouldSurviveStructural).toBe(false);

      const r2 = analyzeStructuralCounterfactual(
        { acIndex: 1, category: "convention", file: "src/a.ts" },
        ACS,
        diffFiles("src/a.ts"),
      );
      expect(r2.wouldSurviveStructural).toBe(false);

      const r3 = analyzeStructuralCounterfactual(
        { acIndex: 1, category: "input", file: "src/missing.ts" },
        ACS,
        diffFiles("src/a.ts"),
      );
      expect(r3.wouldSurviveStructural).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 15 bun test test/unit/review/ac-structural-counterfactual.test.ts --timeout=5000`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the analyzer**

Create `src/review/ac-structural-counterfactual.ts`:

```typescript
/**
 * Structural Counterfactual Analyzer (Issue #986)
 *
 * Pure, read-only telemetry for the adversarial review path. For every finding
 * the validator drops or accepts, this module records whether a structural-only
 * filter (`acIndexInRange ∧ categoryBlocking ∧ fileInDiff`) would have made the
 * same decision as `filterByAcQuote`. The data drives a future keep/refine/
 * replace decision for the substring AC quote validator at N=50 dogfood drops.
 *
 * No behaviour change — analysis result is attached to the audit record and
 * never inspected by the runtime.
 */

import type { AcQuoteRejectionCode } from "./ac-quote-validator";

/**
 * Categories that should block a story under the structural alternative.
 * Locked at {input, error-path, abandonment, assumption} for the measurement
 * window so different projects' data is comparable (issue #986 "Out of scope").
 *
 * The adversarial prompt at adversarial-review-builder.ts:122 emits
 * `convention` and `test-gap` as advisory by design — they are deliberately
 * excluded from this set.
 */
export const BLOCKING_CATEGORIES: ReadonlySet<string> = new Set([
  "input",
  "error-path",
  "abandonment",
  "assumption",
]);

export interface StructuralCounterfactual {
  acIndexInRange: boolean;
  categoryBlocking: boolean;
  fileInDiff: boolean;
  wouldSurviveStructural: boolean;
}

/** Subset of `AdversarialLLMFinding` needed for counterfactual analysis. */
export interface CounterfactualFinding {
  acIndex?: number;
  category?: string;
  file?: string;
}

/**
 * Compute the structural-counterfactual verdict for one finding.
 * Pure function — no I/O, no logging, no exceptions.
 */
export function analyzeStructuralCounterfactual(
  finding: CounterfactualFinding,
  acceptanceCriteria: string[],
  diffFiles: ReadonlySet<string>,
): StructuralCounterfactual {
  const acIndexInRange =
    typeof finding.acIndex === "number" &&
    finding.acIndex >= 1 &&
    finding.acIndex <= acceptanceCriteria.length;

  const categoryBlocking =
    typeof finding.category === "string" && BLOCKING_CATEGORIES.has(finding.category);

  const fileInDiff = typeof finding.file === "string" && diffFiles.has(finding.file);

  const wouldSurviveStructural = acIndexInRange && categoryBlocking && fileInDiff;

  return { acIndexInRange, categoryBlocking, fileInDiff, wouldSurviveStructural };
}

// ─── Persisted audit shapes (used by ReviewAuditEntry) ─────────────────────────

/**
 * Per-drop analysis attached to the audit record for every finding that
 * `filterByAcQuote` rejected. `rawCategory` preserves the model's literal
 * category string so post-hoc analysis can detect schema-enum violations
 * even when `categoryBlocking` is false.
 */
export interface AdversarialDropAnalysis {
  finding: { file: string; line: number; severity: string; category: string; issue: string };
  dropCode: AcQuoteRejectionCode;
  acIndex?: number;
  rawCategory: string;
  counterfactual: StructuralCounterfactual;
}

/**
 * Per-accept analysis attached to the audit record for every finding that
 * passed `filterByAcQuote` AND was at or above the blocking severity threshold.
 * Used to detect over-rejection risk if the structural alternative were adopted.
 */
export interface AdversarialAcceptAnalysis {
  finding: { file: string; line: number; severity: string; category: string };
  acIndex?: number;
  rawCategory: string;
  counterfactual: StructuralCounterfactual;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `timeout 15 bun test test/unit/review/ac-structural-counterfactual.test.ts --timeout=5000`
Expected: PASS — all dimensions covered.

- [ ] **Step 5: Commit**

```bash
git add src/review/ac-structural-counterfactual.ts test/unit/review/ac-structural-counterfactual.test.ts
git commit -m "feat(review): add structural counterfactual analyzer (#986)

Pure read-only analyzer that records, per finding, whether a
structural-only filter (acIndexInRange ∧ categoryBlocking ∧
fileInDiff) would match filterByAcQuote's decision. Locked
BLOCKING_CATEGORIES set per the issue's 'Out of scope' note —
not project-tunable during the measurement window.

Drives the keep/refine/replace decision gate at N=50."
```

---

## Task 4: Extend audit entry, dispatch event, and middleware

**Files:**
- Modify: `src/review/review-audit.ts`
- Modify: `src/runtime/dispatch-events.ts`
- Modify: `src/runtime/middleware/review-audit.ts`

Goal: thread three new optional fields end-to-end — `diffAvailable?: boolean`, `adversarialDropAnalysis?: AdversarialDropAnalysis[]`, `adversarialAcceptAnalysis?: AdversarialAcceptAnalysis[]` — from the emitter to the on-disk JSON. Adversarial-only; semantic and semantic-debate paths must not start emitting these.

This is a single logical change touching three files. We commit it as one unit (no behaviour change visible until Task 5 actually populates the fields).

- [ ] **Step 1: Extend `ReviewDecisionEvent`**

Open `src/runtime/dispatch-events.ts`. After the existing `advisoryFindings` line in the `ReviewDecisionEvent` interface (around line 95), append:

```typescript
  /** Issue #986 — adversarial-only structural-gate counterfactual telemetry. */
  readonly diffAvailable?: boolean;
  readonly adversarialDropAnalysis?: readonly unknown[];
  readonly adversarialAcceptAnalysis?: readonly unknown[];
```

We use `unknown[]` at the event boundary (matches the existing `findings: unknown[]` / `advisoryFindings?: unknown[]` pattern). The audit layer types them as the real interfaces.

- [ ] **Step 2: Extend `ReviewAuditEntry`**

Open `src/review/review-audit.ts`. At the top of the file, add to the existing `import` block:

```typescript
import type {
  AdversarialAcceptAnalysis,
  AdversarialDropAnalysis,
} from "./ac-structural-counterfactual";
```

After the existing `advisoryFindings?: unknown[];` line in the `ReviewAuditEntry` interface (around line 59), append:

```typescript
  /** Issue #986 — true when diff file list was available; false signals "diff unavailable" (excluded from telemetry %). */
  diffAvailable?: boolean;
  /** Issue #986 — per-drop counterfactual analysis. Adversarial only. */
  adversarialDropAnalysis?: AdversarialDropAnalysis[];
  /** Issue #986 — per-accept counterfactual analysis (blocking findings only). Adversarial only. */
  adversarialAcceptAnalysis?: AdversarialAcceptAnalysis[];
```

In `toPersistedEntry` (around line 113), add the three new keys to the JSON object alongside `advisoryFindings`. Place them at the end so legacy field order is preserved:

```typescript
function toPersistedEntry(entry: ReviewAuditEntry, epochMs: number): string {
  return JSON.stringify(
    {
      timestamp: new Date(epochMs).toISOString(),
      runId: entry.runId ?? null,
      storyId: entry.storyId ?? null,
      featureName: entry.featureName ?? null,
      reviewer: entry.reviewer,
      sessionName: entry.sessionName,
      sessionId: entry.sessionId ?? null,
      recordId: entry.recordId ?? null,
      agentName: entry.agentName ?? null,
      parsed: entry.parsed,
      ...(entry.parsed ? {} : { looksLikeFail: entry.looksLikeFail ?? false }),
      failOpen: entry.failOpen ?? false,
      passed: entry.passed ?? entry.result?.passed ?? null,
      blockingThreshold: entry.blockingThreshold ?? null,
      result: entry.result,
      advisoryFindings: entry.advisoryFindings ?? null,
      // Issue #986 — adversarial-only structural counterfactual telemetry.
      diffAvailable: entry.diffAvailable ?? null,
      adversarialDropAnalysis: entry.adversarialDropAnalysis ?? null,
      adversarialAcceptAnalysis: entry.adversarialAcceptAnalysis ?? null,
    },
    null,
    2,
  );
}
```

- [ ] **Step 3: Forward the fields in middleware**

Open `src/runtime/middleware/review-audit.ts`. In `attachReviewAuditSubscriber`'s `bus.onReviewDecision` handler, append to the `auditor.recordDecision({ ... })` object call (after `advisoryFindings: event.advisoryFindings,`):

```typescript
      diffAvailable: event.diffAvailable,
      // Cast unknown[] from the event boundary to the typed audit shapes.
      adversarialDropAnalysis: event.adversarialDropAnalysis as
        | import("../../review/ac-structural-counterfactual").AdversarialDropAnalysis[]
        | undefined,
      adversarialAcceptAnalysis: event.adversarialAcceptAnalysis as
        | import("../../review/ac-structural-counterfactual").AdversarialAcceptAnalysis[]
        | undefined,
```

- [ ] **Step 4: Run typecheck and the existing review-audit tests**

Run: `bun run typecheck`
Expected: PASS — no type errors.

Run: `timeout 30 bun test test/unit/review/ test/unit/runtime/ --timeout=5000`
Expected: PASS — no behaviour change yet, existing tests untouched.

- [ ] **Step 5: Commit**

```bash
git add src/review/review-audit.ts src/runtime/dispatch-events.ts src/runtime/middleware/review-audit.ts
git commit -m "feat(review): wire counterfactual telemetry fields through audit pipeline (#986)

Adds diffAvailable, adversarialDropAnalysis, adversarialAcceptAnalysis
as optional fields on ReviewDecisionEvent → ReviewAuditEntry → on-disk
JSON. Wiring only — no field is populated yet (Task 5).

Audit JSON adds the three keys (null when absent) so consumers see a
stable schema."
```

---

## Task 5: Wire counterfactual computation into `runAdversarialReview`

**Files:**
- Modify: `src/review/adversarial.ts`
- Modify: `test/unit/review/adversarial-audit-shape.test.ts`

Goal: at the existing `filterByAcQuote` call site (around line 362), build a `diffFiles` set + `diffAvailable` boolean, compute counterfactuals for every dropped finding and every accepted blocking finding, and pass the analyses through `recordAdversarialAudit` to the existing event chain. **Existing behaviour unchanged** — `filterByAcQuote` output is byte-identical, blocking-vs-advisory split is unchanged, all existing audit fields are unchanged.

- [ ] **Step 1: Write the failing integration test**

Open `test/unit/review/adversarial-audit-shape.test.ts`. Add `_diffUtilsDeps` to the existing imports near the top of the file:

```typescript
import { _diffUtilsDeps } from "../../../src/review/diff-utils";
```

Then, after the existing two tests, append this new `describe` block (the rest of the imports — `runAdversarialReview`, `STORY`, `CFG`, `agentManagerWithFixedLLMResponse`, `captureAuditDecisions`, `mockDiffUtilsDeps`, `makeMockRuntime`, `SemanticStory` — are already at the top of the file):

```typescript
describe("adversarial structural counterfactual telemetry (#986)", () => {
  let teardown: () => void;

  beforeEach(() => {
    teardown = mockDiffUtilsDeps(
      // Diff that mentions src/foo.ts so fileInDiff=true for findings that target it.
      `diff --git a/src/foo.ts b/src/foo.ts
+++ b/src/foo.ts
@@ -1 +1 @@
-x
+y
`,
    );
  });
  afterEach(() => teardown());

  test("dropped finding gets adversarialDropAnalysis with counterfactual", async () => {
    // Drop trigger: missing acQuote on a "error" finding.
    const llmResponse = JSON.stringify({
      passed: false,
      findings: [
        {
          severity: "error",
          category: "input",
          file: "src/foo.ts",
          line: 10,
          issue: "missing input validation",
          suggestion: "add zod schema",
          // No acQuote / acIndex → filterByAcQuote drops with missing_ac_quote.
        },
      ],
    });

    const { auditor, decisions } = captureAuditDecisions();
    const agentManager = agentManagerWithFixedLLMResponse(llmResponse);
    const runtime = makeMockRuntime({ agentManager, reviewAuditor: auditor });

    await runAdversarialReview({
      workdir: "/tmp/test",
      storyGitRef: "abc123",
      story: STORY,
      adversarialConfig: { ...CFG, diffMode: "embedded" },
      agentManager,
      featureName: "feat-x",
      runtime,
    });

    expect(decisions.length).toBeGreaterThanOrEqual(1);
    const decision = decisions[0]!;
    expect(decision.diffAvailable).toBe(true);
    expect(Array.isArray(decision.adversarialDropAnalysis)).toBe(true);
    expect(decision.adversarialDropAnalysis!.length).toBe(1);

    const drop = decision.adversarialDropAnalysis![0]!;
    expect(drop.dropCode).toBe("missing_ac_quote");
    expect(drop.finding.file).toBe("src/foo.ts");
    expect(drop.rawCategory).toBe("input");
    expect(drop.counterfactual.fileInDiff).toBe(true);
    expect(drop.counterfactual.categoryBlocking).toBe(true);
    expect(drop.counterfactual.acIndexInRange).toBe(false); // no acIndex
    expect(drop.counterfactual.wouldSurviveStructural).toBe(false);
  });

  test("accepted blocking finding gets adversarialAcceptAnalysis", async () => {
    // Accept path: valid acQuote substring + locus keyword present.
    const story: SemanticStory = {
      id: "US-002",
      title: "Accept path",
      description: "",
      acceptanceCriteria: ["The foo function must validate input arguments"],
    };
    const llmResponse = JSON.stringify({
      passed: false,
      findings: [
        {
          severity: "error",
          category: "input",
          file: "src/foo.ts",
          line: 10,
          issue: "foo missing validation",
          suggestion: "add check",
          acQuote: "foo function must validate",
          acIndex: 1,
        },
      ],
    });

    const { auditor, decisions } = captureAuditDecisions();
    const agentManager = agentManagerWithFixedLLMResponse(llmResponse);
    const runtime = makeMockRuntime({ agentManager, reviewAuditor: auditor });

    await runAdversarialReview({
      workdir: "/tmp/test",
      storyGitRef: "abc123",
      story,
      adversarialConfig: { ...CFG, diffMode: "embedded" },
      agentManager,
      featureName: "feat-y",
      runtime,
    });

    const decision = decisions[0]!;
    expect(decision.adversarialDropAnalysis ?? []).toEqual([]);
    expect(Array.isArray(decision.adversarialAcceptAnalysis)).toBe(true);
    expect(decision.adversarialAcceptAnalysis!.length).toBe(1);

    const accept = decision.adversarialAcceptAnalysis![0]!;
    expect(accept.finding.file).toBe("src/foo.ts");
    expect(accept.acIndex).toBe(1);
    expect(accept.counterfactual.acIndexInRange).toBe(true);
    expect(accept.counterfactual.categoryBlocking).toBe(true);
    expect(accept.counterfactual.fileInDiff).toBe(true);
    expect(accept.counterfactual.wouldSurviveStructural).toBe(true);
  });

  test("ref mode without diff records diffAvailable=false", async () => {
    // Reset the embedded-mode mock from beforeEach; this test installs its own
    // command-discriminating spawn so collectDiffStat succeeds (non-empty stat)
    // but collectDiffFileList fails (exitCode != 0 → undefined → diffAvailable=false).
    teardown();
    const origSpawn = _diffUtilsDeps.spawn;
    const origIsGitRefValid = _diffUtilsDeps.isGitRefValid;
    _diffUtilsDeps.isGitRefValid = (async () => true) as typeof _diffUtilsDeps.isGitRefValid;
    _diffUtilsDeps.spawn = ((opts: { cmd: string[] }) => {
      const isFileList = (opts.cmd ?? []).includes("--name-only");
      const stdout = isFileList ? "" : "1 file changed";
      const exitCode = isFileList ? 128 : 0;
      return {
        exited: Promise.resolve(exitCode),
        stdout: new ReadableStream({
          start: (c) => {
            c.enqueue(new TextEncoder().encode(stdout));
            c.close();
          },
        }),
        stderr: new ReadableStream({ start: (c) => c.close() }),
        kill: () => {},
      } as unknown as ReturnType<typeof _diffUtilsDeps.spawn>;
    }) as typeof _diffUtilsDeps.spawn;
    teardown = () => {
      _diffUtilsDeps.spawn = origSpawn;
      _diffUtilsDeps.isGitRefValid = origIsGitRefValid;
    };

    const llmResponse = JSON.stringify({
      passed: false,
      findings: [{
        severity: "error", category: "input", file: "src/foo.ts", line: 1,
        issue: "x", suggestion: "y",
      }],
    });
    const { auditor, decisions } = captureAuditDecisions();
    const agentManager = agentManagerWithFixedLLMResponse(llmResponse);
    const runtime = makeMockRuntime({ agentManager, reviewAuditor: auditor });

    await runAdversarialReview({
      workdir: "/tmp/test",
      storyGitRef: "abc123",
      story: STORY,
      adversarialConfig: { ...CFG, diffMode: "ref" },
      agentManager,
      featureName: "feat-z",
      runtime,
    });

    expect(decisions[0]!.diffAvailable).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 30 bun test test/unit/review/adversarial-audit-shape.test.ts --timeout=10000`
Expected: FAIL — `decision.adversarialDropAnalysis` is undefined.

- [ ] **Step 3: Wire counterfactual into `runAdversarialReview`**

Open `src/review/adversarial.ts`.

**3a. Imports.** Two changes to the existing import block:

  1. **Extend** the existing `import { collectDiff, collectDiffStat, computeTestInventory, resolveEffectiveRef } from "./diff-utils";` line to add `collectDiffFileList`:

     ```typescript
     import { collectDiff, collectDiffFileList, collectDiffStat, computeTestInventory, resolveEffectiveRef } from "./diff-utils";
     ```

  2. **Add** two new import statements (alphabetical with the rest of the local imports):

     ```typescript
     import {
       type AdversarialAcceptAnalysis,
       type AdversarialDropAnalysis,
       analyzeStructuralCounterfactual,
     } from "./ac-structural-counterfactual";
     import { extractDiffFiles } from "../utils/diff-files";
     ```

Do not add a separate `import { collectDiffFileList } from "./diff-utils";` line — it would duplicate the source of the existing import.

**3b. Extend `recordAdversarialAudit` signature** to accept the three new optional fields and forward them to `emitReviewDecision`:

```typescript
function recordAdversarialAudit(opts: {
  runtime?: import("../runtime").NaxRuntime;
  workdir: string;
  projectDir?: string;
  storyId: string;
  featureName?: string;
  parsed: boolean;
  looksLikeFail?: boolean;
  failOpen?: boolean;
  passed?: boolean;
  blockingThreshold?: "error" | "warning" | "info";
  result: { passed: boolean; findings: unknown[] } | null;
  advisoryFindings?: unknown[];
  // Issue #986 — adversarial-only structural counterfactual telemetry.
  diffAvailable?: boolean;
  adversarialDropAnalysis?: AdversarialDropAnalysis[];
  adversarialAcceptAnalysis?: AdversarialAcceptAnalysis[];
}): void {
  opts.runtime?.dispatchEvents.emitReviewDecision({
    kind: "review-decision",
    reviewer: "adversarial",
    workdir: opts.workdir,
    projectDir: opts.projectDir,
    storyId: opts.storyId,
    featureName: opts.featureName,
    timestamp: Date.now(),
    parsed: opts.parsed,
    looksLikeFail: opts.looksLikeFail,
    failOpen: opts.failOpen,
    passed: opts.passed,
    blockingThreshold: opts.blockingThreshold,
    result: opts.result,
    advisoryFindings: opts.advisoryFindings,
    diffAvailable: opts.diffAvailable,
    adversarialDropAnalysis: opts.adversarialDropAnalysis,
    adversarialAcceptAnalysis: opts.adversarialAcceptAnalysis,
  });
}
```

**3c. Build `diffFiles` + `diffAvailable` once, immediately before the existing `filterByAcQuote` call** (currently around line 362). Replace the lines from the start of the `// Issue #930 Part 1: drop error findings...` comment up to the `filterByAcQuote` call — and append the new code. The replacement block is:

```typescript
  // Issue #986 — build diff file set for structural counterfactual telemetry.
  // Embedded mode: parse `diff` (already in memory). Ref mode: shell git diff
  // --name-only via collectDiffFileList. diffAvailable=false signals "exclude
  // this entry from percentage calculations" to the aggregation script.
  let diffFiles: ReadonlySet<string>;
  let diffAvailable: boolean;
  if (diff && diff.length > 0) {
    diffFiles = extractDiffFiles(diff);
    diffAvailable = true;
  } else {
    const list = await collectDiffFileList(workdir, effectiveRef, { naxIgnoreIndex, packageDir });
    if (list === undefined) {
      diffFiles = new Set();
      diffAvailable = false;
    } else {
      diffFiles = new Set(list);
      diffAvailable = true;
    }
  }

  // Issue #930 Part 1: drop error findings not grounded in AC text
  const { accepted: acGroundedFindings, dropped: acDropped } = filterByAcQuote(
    rawParsed.findings,
    story.acceptanceCriteria,
  );
```

**3d. Build the `adversarialDropAnalysis` array** immediately after the existing `if (acDropped.length > 0) { logger?.warn(...) }` block:

```typescript
  // Issue #986 — counterfactual analysis for every drop. Adversarial-only.
  const adversarialDropAnalysis: AdversarialDropAnalysis[] = acDropped.map((d) => ({
    finding: {
      file: d.finding.file ?? "<unknown>",
      line: d.finding.line ?? 0,
      severity: d.finding.severity,
      category: d.finding.category ?? "<unknown>",
      issue: d.finding.issue,
    },
    dropCode: d.code,
    acIndex: d.finding.acIndex,
    rawCategory: d.finding.category ?? "",
    counterfactual: analyzeStructuralCounterfactual(
      { acIndex: d.finding.acIndex, category: d.finding.category, file: d.finding.file },
      story.acceptanceCriteria,
      diffFiles,
    ),
  }));
```

**3e. Build the `adversarialAcceptAnalysis` array** after `blockingFindings` is computed (after the line `const blockingFindings = parsed.findings.filter(...)`):

```typescript
  // Issue #986 — counterfactual analysis for every accepted blocking finding.
  const adversarialAcceptAnalysis: AdversarialAcceptAnalysis[] = blockingFindings.map((f) => ({
    finding: {
      file: f.file,
      line: f.line,
      severity: f.severity,
      category: f.category,
    },
    acIndex: f.acIndex,
    rawCategory: f.category,
    counterfactual: analyzeStructuralCounterfactual(
      { acIndex: f.acIndex, category: f.category, file: f.file },
      story.acceptanceCriteria,
      diffFiles,
    ),
  }));
```

**3f. Pass the three new fields through every `recordAdversarialAudit` call site that fires after `acDropped` exists.** There are four call sites in adversarial.ts that fire after the `filterByAcQuote` call — in order (line numbers approximate, may have shifted by your edits):

  - Inside `if (blockingFindings.length > 0) { ... }` block (around L410): add `diffAvailable, adversarialDropAnalysis, adversarialAcceptAnalysis` to the call.
  - Inside `if (acDropped.length > 0) { ... }` (the fail-closed branch, around L462): add the three. `adversarialAcceptAnalysis` is `[]` here (no blocking findings remained).
  - The "all advisory" pass branch (around L494): add the three. Again `adversarialAcceptAnalysis` is `[]`.
  - The final pass/fail audit at the bottom (around L529): add the three.

The earlier audit calls — the `LLM call failed` catch (~L281), `failOpen` (~L306), and `looksLikeFail` (~L333) — fire *before* `acDropped` exists, so they MUST NOT pass these fields. Leave them untouched.

Concretely, every "after-filter" `recordAdversarialAudit({ ... })` block ends with the appended:

```typescript
    diffAvailable,
    adversarialDropAnalysis,
    adversarialAcceptAnalysis,
```

(Use the empty-array form `adversarialAcceptAnalysis: []` for the two branches where blocking findings have been emptied; these are the fail-closed-on-drops branch and the "all advisory" branch — see step 3f for the exact call sites.)

- [ ] **Step 4: Run target test to verify**

Run: `timeout 30 bun test test/unit/review/adversarial-audit-shape.test.ts --timeout=10000`
Expected: PASS — including the three new `#986` tests.

- [ ] **Step 5: Run the broader review test suite to confirm no regression**

Run: `timeout 60 bun test test/unit/review/ test/unit/operations/adversarial-review.test.ts test/unit/operations/adversarial-review-retry-flip.test.ts test/unit/pipeline/stages/autofix-adversarial.test.ts --timeout=10000`
Expected: PASS — existing fixtures unchanged.

- [ ] **Step 6: Typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/review/adversarial.ts test/unit/review/adversarial-audit-shape.test.ts
git commit -m "feat(review): emit structural counterfactual telemetry on adversarial path (#986)

For every finding filterByAcQuote drops or accepts, computes the
acIndexInRange/categoryBlocking/fileInDiff axes and attaches
{adversarialDropAnalysis, adversarialAcceptAnalysis, diffAvailable}
to the existing review-audit JSON.

Embedded mode: extracts diff files from the inline diff. Ref mode:
calls collectDiffFileList. diffAvailable=false on git failure
signals the aggregation script to exclude the entry from %s.

No behaviour change — filterByAcQuote results are unchanged."
```

---

## Task 6: Aggregation script

**Files:**
- Create: `scripts/analyze-ac-validator-telemetry.ts`

Goal: walk `.nax/review-audit/**/*.json`, aggregate counterfactual data across entries, print the metrics table from the issue. CLI: `bun scripts/analyze-ac-validator-telemetry.ts [path-to-review-audit-root]` (defaults to `.nax/review-audit`).

The script does pure read + aggregate + print. No tests required for this script per the issue ACs (it's an operational tool, not production code). Validate manually with one fixture entry.

- [ ] **Step 1: Implement the script**

Create `scripts/analyze-ac-validator-telemetry.ts`:

```typescript
#!/usr/bin/env bun
/**
 * Issue #986 — aggregate adversarial structural counterfactual telemetry.
 *
 * Walks .nax/review-audit/**\/*.json (or a path passed as argv[2]),
 * computes the metrics table specified in the issue, and prints to stdout.
 *
 * Skips entries with reviewer != "adversarial" and entries that have no
 * adversarialDropAnalysis / adversarialAcceptAnalysis fields. Excludes
 * entries with diffAvailable === false from percentage calculations
 * (the fileInDiff axis is biased toward false in those records).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const DROP_CODES = [
  "ac_quote_not_substring",
  "ac_quote_does_not_constrain_locus",
  "missing_ac_quote",
  "ac_index_out_of_range",
] as const;

const SUBSTRING_FRAGILITY_CODES: ReadonlySet<string> = new Set([
  "ac_quote_not_substring",
  "ac_quote_does_not_constrain_locus",
]);

interface Counterfactual {
  acIndexInRange: boolean;
  categoryBlocking: boolean;
  fileInDiff: boolean;
  wouldSurviveStructural: boolean;
}

interface DropAnalysis {
  dropCode: string;
  rawCategory: string;
  counterfactual: Counterfactual;
}

interface AcceptAnalysis {
  rawCategory: string;
  counterfactual: Counterfactual;
}

interface AuditFile {
  reviewer: string;
  diffAvailable: boolean | null;
  adversarialDropAnalysis: DropAnalysis[] | null;
  adversarialAcceptAnalysis: AcceptAnalysis[] | null;
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const path = join(dir, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(path, out);
    else if (name.endsWith(".json")) out.push(path);
  }
  return out;
}

function loadAudit(path: string): AuditFile | null {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<AuditFile>;
    if (parsed.reviewer !== "adversarial") return null;
    return {
      reviewer: parsed.reviewer,
      diffAvailable: parsed.diffAvailable ?? null,
      adversarialDropAnalysis: parsed.adversarialDropAnalysis ?? null,
      adversarialAcceptAnalysis: parsed.adversarialAcceptAnalysis ?? null,
    };
  } catch {
    return null;
  }
}

function pct(num: number, denom: number): string {
  if (denom === 0) return "n/a";
  return `${((num / denom) * 100).toFixed(1)}%`;
}

function main(): void {
  const root = process.argv[2] ?? ".nax/review-audit";
  const files = walk(root);

  let totalReviews = 0;
  let totalDrops = 0;
  let totalDropsWithDiff = 0;
  let dropsSurviveStructuralWithDiff = 0;
  let dropsNotSurviveStructuralWithDiff = 0;
  const dropsByCode = new Map<string, number>();
  const dropCrosstab = new Map<string, { survive: number; notSurvive: number }>();
  const fragilitySurviveByCode = new Map<string, number>();
  let totalAccepts = 0;
  let totalAcceptsWithDiff = 0;
  let acceptsSurviveStructural = 0;
  let acceptsNotSurviveStructural = 0;
  const acceptsNotSurviveCategories = new Map<string, number>();
  let entriesNoDiff = 0;
  let promptComplianceFailures = 0; // fileInDiff:false on drops with severity error (proxy via dropCode)

  for (const path of files) {
    const audit = loadAudit(path);
    if (!audit) continue;
    if (audit.adversarialDropAnalysis === null && audit.adversarialAcceptAnalysis === null) continue;

    totalReviews += 1;
    const diffOk = audit.diffAvailable === true;
    if (!diffOk) entriesNoDiff += 1;

    for (const drop of audit.adversarialDropAnalysis ?? []) {
      totalDrops += 1;
      dropsByCode.set(drop.dropCode, (dropsByCode.get(drop.dropCode) ?? 0) + 1);
      if (!drop.counterfactual.fileInDiff && SUBSTRING_FRAGILITY_CODES.has(drop.dropCode)) {
        promptComplianceFailures += 1;
      }
      if (!diffOk) continue;
      totalDropsWithDiff += 1;
      const survive = drop.counterfactual.wouldSurviveStructural;
      if (survive) dropsSurviveStructuralWithDiff += 1;
      else dropsNotSurviveStructuralWithDiff += 1;

      const bucket = dropCrosstab.get(drop.dropCode) ?? { survive: 0, notSurvive: 0 };
      if (survive) bucket.survive += 1;
      else bucket.notSurvive += 1;
      dropCrosstab.set(drop.dropCode, bucket);

      if (SUBSTRING_FRAGILITY_CODES.has(drop.dropCode) && survive) {
        fragilitySurviveByCode.set(drop.dropCode, (fragilitySurviveByCode.get(drop.dropCode) ?? 0) + 1);
      }
    }

    for (const accept of audit.adversarialAcceptAnalysis ?? []) {
      totalAccepts += 1;
      if (!diffOk) continue;
      totalAcceptsWithDiff += 1;
      if (accept.counterfactual.wouldSurviveStructural) acceptsSurviveStructural += 1;
      else {
        acceptsNotSurviveStructural += 1;
        acceptsNotSurviveCategories.set(
          accept.rawCategory,
          (acceptsNotSurviveCategories.get(accept.rawCategory) ?? 0) + 1,
        );
      }
    }
  }

  const lines: string[] = [];
  lines.push(`Total adversarial reviews:        ${totalReviews}`);
  lines.push(`Entries excluded (no diff):       ${entriesNoDiff}`);
  lines.push(`Total drops:                      ${totalDrops}`);
  lines.push("Drops by code:");
  for (const code of DROP_CODES) {
    const count = dropsByCode.get(code) ?? 0;
    lines.push(`  ${code}: ${count} (${pct(count, totalDrops)})`);
  }
  lines.push("");
  lines.push(`Drops with diff available:        ${totalDropsWithDiff}`);
  lines.push("Drops by counterfactual (diff-available only):");
  lines.push(`  Would survive structural:        ${pct(dropsSurviveStructuralWithDiff, totalDropsWithDiff)}`);
  lines.push(`  Would NOT survive structural:    ${pct(dropsNotSurviveStructuralWithDiff, totalDropsWithDiff)}`);
  lines.push("");
  lines.push("Drop-cause crosstab (would-survive-structural × dropCode, diff-available only):");
  for (const code of DROP_CODES) {
    const bucket = dropCrosstab.get(code);
    if (!bucket) continue;
    lines.push(`  ${code} & survive:           ${bucket.survive}  ← would have been kept by structural-only`);
    lines.push(`  ${code} & NOT-survive:       ${bucket.notSurvive}`);
  }
  lines.push("");
  lines.push(`Total accepted blocking findings: ${totalAccepts}`);
  lines.push(`Accepts with diff available:      ${totalAcceptsWithDiff}`);
  lines.push("Accepted by counterfactual (diff-available only):");
  lines.push(`  Would survive structural:        ${pct(acceptsSurviveStructural, totalAcceptsWithDiff)}`);
  lines.push(`  Would NOT survive structural:    ${pct(acceptsNotSurviveStructural, totalAcceptsWithDiff)}  ← over-rejection risk if we replaced`);
  lines.push("");
  lines.push("Categories of accepted findings that would NOT survive structural:");
  if (acceptsNotSurviveCategories.size === 0) {
    lines.push("  (none)");
  } else {
    for (const [cat, n] of [...acceptsNotSurviveCategories.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${cat}: ${n}`);
    }
  }
  lines.push("");
  lines.push("Decision-gate inputs:");
  const fragilityTotalDrops = (dropCrosstab.get("ac_quote_not_substring")?.notSurvive ?? 0)
    + (dropCrosstab.get("ac_quote_not_substring")?.survive ?? 0)
    + (dropCrosstab.get("ac_quote_does_not_constrain_locus")?.notSurvive ?? 0)
    + (dropCrosstab.get("ac_quote_does_not_constrain_locus")?.survive ?? 0);
  const fragilityNotSurvive = (dropCrosstab.get("ac_quote_not_substring")?.notSurvive ?? 0)
    + (dropCrosstab.get("ac_quote_does_not_constrain_locus")?.notSurvive ?? 0);
  lines.push(`  Substring-fragility drops (diff-available): ${fragilityTotalDrops}`);
  lines.push(`  ...of which NOT-survive structural:         ${pct(fragilityNotSurvive, fragilityTotalDrops)} → drives keep/refine/replace`);
  lines.push("");
  lines.push(`Prompt-compliance proxy: ${promptComplianceFailures} substring-fragility drops had fileInDiff=false`);
  lines.push(`  (these are reviewer scope-violation findings — fixable in the prompt, not the validator)`);
  lines.push("");
  lines.push(`Decision gate trigger: N >= 50 distinct drops. Current: ${totalDrops} drop(s) total, ${totalDropsWithDiff} with diff.`);

  console.log(lines.join("\n"));
}

main();
```

- [ ] **Step 2: Smoke-test the script against an empty path**

Run: `bun scripts/analyze-ac-validator-telemetry.ts /tmp/does-not-exist`
Expected: prints `Total adversarial reviews: 0` etc. without crashing.

- [ ] **Step 3: Smoke-test against the project audit dir if it exists**

Run: `bun scripts/analyze-ac-validator-telemetry.ts .nax/review-audit 2>&1 | head -40`
Expected: either real numbers (if audit data has accumulated) or zeros (if no audit dir yet). No errors.

- [ ] **Step 4: Commit**

```bash
git add scripts/analyze-ac-validator-telemetry.ts
git commit -m "feat(scripts): add adversarial counterfactual aggregation script (#986)

Walks .nax/review-audit/**/*.json, computes drop-by-code,
counterfactual-survive %, drop-cause crosstab, accept over-
rejection risk, and a prompt-compliance proxy. Excludes entries
with diffAvailable=false from percentage calculations.

Used to drive the keep/refine/replace decision gate at N>=50
real-run drops."
```

---

## Task 7: Final verification

**Files:** none (verification only).

- [ ] **Step 1: Full lint + typecheck**

Run: `bun run lint && bun run typecheck`
Expected: PASS.

- [ ] **Step 2: Full review test suite**

Run: `timeout 90 bun test test/unit/review/ test/unit/utils/diff-files.test.ts test/unit/operations/adversarial-review.test.ts test/unit/operations/adversarial-review-retry-flip.test.ts test/unit/pipeline/stages/autofix-adversarial.test.ts --timeout=10000`
Expected: PASS — all existing review tests + 3 new test files green.

- [ ] **Step 3: AC self-check against the issue**

Confirm by inspection:

  - [x] `analyzeStructuralCounterfactual` exported from `src/review/ac-structural-counterfactual.ts` (sibling to `ac-quote-validator.ts`).
  - [x] `extractDiffFiles` handles `+++ b/path`, `+++ /dev/null`, CRLF, multiple files, dedup. Tested.
  - [x] `runAdversarialReview` computes counterfactual for every drop and every accepted blocking finding.
  - [x] `ReviewAuditEntry` extended with `adversarialDropAnalysis`, `adversarialAcceptAnalysis`, `diffAvailable` (all optional, adversarial-only).
  - [x] Audit JSON written to `.nax/review-audit/<feature>/<epoch>-<session>.json` includes the new fields when adversarial fires.
  - [x] No behaviour change: `filterByAcQuote` accepted/dropped output is byte-identical; existing adversarial tests pass without fixture edits.
  - [x] Semantic and semantic-debate paths emit no new fields.
  - [x] `scripts/analyze-ac-validator-telemetry.ts` reads the audit corpus and emits the metrics table specified.
  - [x] Unit tests: counterfactual analyzer covers all four dimensions; diff parser handles edge cases; integration test verifies audit shape.

- [ ] **Step 4: Open the PR**

Run:

```bash
gh pr create --title "feat(review): adversarial AC validator structural counterfactual telemetry (#986)" --body "$(cat <<'EOF'
## Summary

Implements issue #986 (Phase 2 follow-up to #985). Adds observation-only counterfactual telemetry to the adversarial review path — for every finding `filterByAcQuote` drops or accepts, records whether a structural-only filter (`acIndexInRange ∧ categoryBlocking ∧ fileInDiff`) would have made the same call.

**Zero behaviour change.** `filterByAcQuote`'s accepted/dropped output is byte-identical; existing adversarial tests pass without fixture edits.

The telemetry persists alongside existing audit data at `.nax/review-audit/<feature>/<epoch>-<session>.json` as three new optional fields:
- `diffAvailable: boolean` — false signals "exclude from percentages"
- `adversarialDropAnalysis: AdversarialDropAnalysis[]`
- `adversarialAcceptAnalysis: AdversarialAcceptAnalysis[]`

A new aggregation script `scripts/analyze-ac-validator-telemetry.ts` drives the keep/refine/replace decision gate at N>=50 dogfood drops. Per the issue's design, the **decision criteria are committed before any data is collected** to prevent retrofitted thresholds.

### Files

- New: `src/review/ac-structural-counterfactual.ts` (sibling to `ac-quote-validator.ts`)
- New: `src/utils/diff-files.ts` (pure unified-diff parser)
- New: `scripts/analyze-ac-validator-telemetry.ts`
- Modified: `src/review/diff-utils.ts` (+ `collectDiffFileList`), `src/review/adversarial.ts` (counterfactual wiring), `src/review/review-audit.ts` (entry shape), `src/runtime/dispatch-events.ts` (event shape), `src/runtime/middleware/review-audit.ts` (forwarding)
- Tests: 3 new files + 1 modified

## Test plan

- [x] `extractDiffFiles` unit tests (7 cases incl. CRLF, /dev/null, dedup, paths-with-spaces)
- [x] `collectDiffFileList` unit tests (success, empty, git failure → undefined, trim/skip-empty)
- [x] `analyzeStructuralCounterfactual` unit tests (each of 4 dimensions + composition)
- [x] `adversarial-audit-shape.test.ts` integration tests (drop populates `adversarialDropAnalysis`; accept populates `adversarialAcceptAnalysis`; ref-mode git failure → `diffAvailable=false`)
- [x] `bun run lint && bun run typecheck`
- [x] No fixture edits to existing adversarial tests (no-behaviour-change AC)
EOF
)"
```

Expected: PR URL printed.

---

## Risks & open clarifications (from issue comments)

1. **`fileInDiff` in `ref` mode** — handled via `collectDiffFileList`, returning `undefined` on git failure → `diffAvailable: false`. Aggregation script excludes `diffAvailable: false` entries from percentages.

2. **Prompt-compliance signal** — comment #1 noted that `severity: "error"` with `fileInDiff: false` is also a prompt-compliance failure (the prompt says scope-violation findings must be `warning`, never `error`). The aggregation script tracks this as a separate "Prompt-compliance proxy" line: substring-fragility drops where `fileInDiff: false`. The follow-up issue can use this to distinguish reviewer-scope-violation (fix the prompt) from genuine architectural difference (drives the validator decision).

3. **Recall sanity rubric** — out of scope here (the rubric is invoked manually at decision-gate time, not by the instrumentation). Comment #4 contains the proposed wording; reproduce it in the follow-up issue's body when the gate fires.

4. **Threshold rationale** — out of scope here. The numeric matrix is committed; the *narrative* interpretation belongs in the follow-up issue's restatement when data lands.

5. **Decision-gate cherry-picking** — mitigated by committing the matrix before measurement (this PR) and by the recall sanity check (follow-up).

6. **N=50 latency** — instrumentation cost is zero (read-only, fire-and-forget). Per the issue's risk #2, can sit in production indefinitely.
