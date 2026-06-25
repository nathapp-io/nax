# Review Evidence Monorepo Path-Resolution Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make semantic and adversarial review evidence-substantiation resolve finding file paths correctly inside monorepo subpackages, so false-positive "missing X" findings get downgraded instead of silently surviving as blocking errors.

**Architecture:** The shared primitive `checkFindingEvidence` / `readSafeFile` (`src/review/semantic-evidence.ts`) currently reads a finding's cited file relative to the story's **package** workdir. But git emits **repo-root-relative** paths (e.g. `apps/api/src/x.ts`), so in any monorepo subpackage the read targets a doubled path (`<pkg>/apps/api/src/x.ts`), returns `null` → status `"unreadable"`, and the downgrade gate (which only fires on `"unmatched"`) preserves the bogus finding. The fix threads a `repoRoot` (= `projectDir ?? workdir`) into the primitive and resolves against candidate anchors `[repoRoot, workdir]`, picking the first that **actually reads**. No change to the `unreadable`-preserves contract; no change to single-package or absolute-path behavior.

**Tech Stack:** Bun 1.3.7+, TypeScript strict, `bun:test`. Bun-native APIs only.

## Global Constraints

- **Bun-native only.** `Bun.file()`, no Node `fs` for reads in source. (Tests may use `node:fs` `writeFileSync`/`mkdirSync` for fixtures — existing tests already do.)
- **No `process.cwd()`** in `src/review/` or `src/operations/` — see `.claude/rules/monorepo-awareness.md`.
- **Backward compatible signatures.** `repoRoot` is an **optional** parameter everywhere. When absent (or equal to `workdir`), behavior is byte-identical to today. This keeps every existing call site and the 30 existing review tests green without edits.
- **Test command:** scoped runs use `timeout 60 bun test <path> --timeout=10000`. Never bare `bun test`.
- **Logging:** `storyId` first key in any log data object (not applicable to the pure functions here, but applies if you add logs).
- **Behavior-change scope:** only `diffMode: "ref"` + blocking findings + monorepo (`repoRoot !== workdir`). Single-package, embedded mode, non-blocking findings, and absolute-path findings are unchanged.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/review/semantic-evidence.ts` | shared evidence primitive (`readSafeFile`, `checkFindingEvidence`, `substantiateSemanticEvidence`) | repoRoot-aware resolution |
| `src/review/finding-filters.ts` | adversarial substantiate (`substantiateAdversarialFindings`) | accept + forward `repoRoot` |
| `src/operations/semantic-review.ts` | semantic op input + `verify()` + requote | add `repoRoot` field, pass through (3 sites) |
| `src/operations/adversarial-review.ts` | adversarial op input + `verify()` + requote | add `repoRoot` field, pass through (3 sites) |
| `src/review/semantic.ts` | builds semantic op `callOp` input | add `repoRoot: projectDir ?? workdir` |
| `src/review/adversarial.ts` | builds adversarial op `callOp` input | add `repoRoot: projectDir ?? workdir` |
| `test/unit/review/semantic-evidence.test.ts` | unit tests for the primitive + semantic substantiate | add monorepo cases |
| `test/unit/review/adversarial-verifiedby.test.ts` | adversarial substantiate unit test | add monorepo case |

---

## Background: exact current code (read before starting)

`src/review/semantic-evidence.ts` — `readSafeFile` (currently single-root):

```typescript
async function readSafeFile(workdir: string, file: string): Promise<string | null> {
  const validated = validateModulePath(file, [workdir]);
  if (validated.valid && validated.absolutePath) {
    try {
      return await Bun.file(validated.absolutePath).text();
    } catch {
      return null;
    }
  }
  if (isAbsolute(file)) {
    try {
      return await Bun.file(file).text();
    } catch {
      return null;
    }
  }
  return null;
}
```

`checkFindingEvidence` (currently single workdir):

```typescript
export async function checkFindingEvidence(opts: {
  finding: FindingWithEvidence;
  workdir: string;
}): Promise<EvidenceCheckResult> {
  const observed = opts.finding.verifiedBy?.observed?.trim();
  const file = opts.finding.verifiedBy?.file?.trim() || opts.finding.file;
  const line = opts.finding.verifiedBy?.line ?? opts.finding.line;
  if (!observed) return { status: "missing-observed", file, line };
  const contents = await readSafeFile(opts.workdir, file);
  if (contents === null) return { status: "unreadable", file, line, observed };
  return matchesEvidence(contents, observed, line)
    ? { status: "matched", file, line, observed }
    : { status: "unmatched", file, line, observed };
}
```

`substantiateSemanticEvidence` (caller of `checkFindingEvidence`):

```typescript
export async function substantiateSemanticEvidence(
  findings: LLMFinding[],
  diffMode: SemanticReviewConfig["diffMode"],
  workdir: string,
  storyId: string,
  blockingThreshold: "error" | "warning" | "info" = "error",
): Promise<LLMFinding[]> {
  if (diffMode !== "ref") return findings;
  return Promise.all(
    findings.map(async (finding) => {
      if (!isBlockingSeverity(finding.severity, blockingThreshold)) return finding;
      const evidence = await checkFindingEvidence({ finding, workdir });
      if (evidence.status !== "unmatched") return finding;
      return downgradeUnsubstantiatedFinding({ finding, storyId, ...evidence });
    }),
  );
}
```

**Why `repoRoot` is the right anchor:** `collectDiff` (`src/review/diff-utils.ts:61`) runs `git diff` and git always emits **repo-root-relative** paths regardless of cwd. The reviewer's `verifiedBy.file` and `inspectedFiles` therefore carry the package prefix (`apps/api/src/...`). `repoRoot = projectDir ?? workdir` (`src/review/prepare-inputs.ts:88`). In single-package repos `projectDir === workdir`, so `repoRoot === workdir` and nothing changes.

**Why keep the `unreadable`-preserves contract:** `test/unit/review/semantic-evidence.test.ts:169` ("preserves error finding when absolute verifiedBy.file does not exist on this machine") is intentional — the LLM may grep an absolute macOS path that does not exist in CI. We do **not** downgrade on `unreadable`. The fix only makes `unreadable` rarer by resolving relative paths correctly; it does not change what happens when a file genuinely cannot be read.

---

## Task 1: Make the shared evidence primitive repoRoot-aware

**Files:**
- Modify: `src/review/semantic-evidence.ts` (`readSafeFile`, `checkFindingEvidence`)
- Test: `test/unit/review/semantic-evidence.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `checkFindingEvidence(opts: { finding: FindingWithEvidence; workdir: string; repoRoot?: string }): Promise<EvidenceCheckResult>` — new optional `repoRoot`.
  - `readSafeFile(roots: string[], file: string): Promise<string | null>` — signature changes from `(workdir, file)` to `(roots[], file)`; returns the first root whose resolved file reads successfully, then the absolute-path fallback. (Private; only `checkFindingEvidence` calls it.)

- [ ] **Step 1: Write the failing test**

Add these tests at the end of `test/unit/review/semantic-evidence.test.ts`, inside a new `describe` block (after the existing top-level `describe` closes). They exercise `checkFindingEvidence` directly with a monorepo layout. `makeFinding` and `withTempDir` are already imported in this file.

```typescript
describe("checkFindingEvidence — monorepo repoRoot resolution", () => {
  test("repo-relative finding path resolves against repoRoot, not packageDir", async () => {
    await withTempDir(async (repoRoot) => {
      // Monorepo: package lives at <repoRoot>/apps/api ; source at apps/api/src/x.ts
      mkdirSync(join(repoRoot, "apps/api/src"), { recursive: true });
      writeFileSync(join(repoRoot, "apps/api/src/x.ts"), "export const handler = () => 1;\n");
      const packageDir = join(repoRoot, "apps/api");

      // Finding cites the repo-root-relative path (as git emits it). `observed`
      // is NOT in the file (simulates a bogus diff-stat "observed").
      const finding = makeFinding({
        file: "apps/api/src/x.ts",
        line: 0,
        verifiedBy: {
          command: "git diff --stat",
          file: "apps/api/src/x.ts",
          line: 0,
          observed: "no x.ts in the changeset",
        },
      });

      const result = await checkFindingEvidence({ finding, workdir: packageDir, repoRoot });

      // File is now readable (resolved against repoRoot), observed absent -> "unmatched".
      // Before the fix this was "unreadable" (doubled path) and the finding survived.
      expect(result.status).toBe("unmatched");
    });
  });

  test("repo-relative finding path with matching observed resolves to matched", async () => {
    await withTempDir(async (repoRoot) => {
      mkdirSync(join(repoRoot, "apps/api/src"), { recursive: true });
      writeFileSync(join(repoRoot, "apps/api/src/x.ts"), "export const handler = () => 1;\n");
      const packageDir = join(repoRoot, "apps/api");

      const finding = makeFinding({
        file: "apps/api/src/x.ts",
        line: 1,
        verifiedBy: {
          command: "Read apps/api/src/x.ts",
          file: "apps/api/src/x.ts",
          line: 1,
          observed: "export const handler = () => 1;",
        },
      });

      const result = await checkFindingEvidence({ finding, workdir: packageDir, repoRoot });

      expect(result.status).toBe("matched");
    });
  });

  test("package-relative finding path still resolves against packageDir (belt-and-suspenders)", async () => {
    await withTempDir(async (repoRoot) => {
      mkdirSync(join(repoRoot, "apps/api/src"), { recursive: true });
      writeFileSync(join(repoRoot, "apps/api/src/x.ts"), "export const handler = () => 1;\n");
      const packageDir = join(repoRoot, "apps/api");

      // Package-relative path (no apps/api prefix). Must still resolve via the
      // workdir anchor when repoRoot resolution misses.
      const finding = makeFinding({
        file: "src/x.ts",
        line: 1,
        verifiedBy: {
          command: "Read src/x.ts",
          file: "src/x.ts",
          line: 1,
          observed: "export const handler = () => 1;",
        },
      });

      const result = await checkFindingEvidence({ finding, workdir: packageDir, repoRoot });

      expect(result.status).toBe("matched");
    });
  });

  test("single-package (repoRoot omitted) is unchanged", async () => {
    await withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src/foo.ts"), "export function foo() {}\n");

      const result = await checkFindingEvidence({ finding: makeFinding(), workdir });

      expect(result.status).toBe("matched");
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 60 bun test test/unit/review/semantic-evidence.test.ts --timeout=10000`
Expected: FAIL — the first monorepo test reports `status` `"unreadable"` instead of `"unmatched"` (the file is read at the doubled path `apps/api/apps/api/src/x.ts`). The other new tests may pass or fail depending on layout, but at least the first one must fail. The existing tests must still pass.

- [ ] **Step 3: Implement repoRoot-aware resolution**

In `src/review/semantic-evidence.ts`, replace `readSafeFile` with the multi-root version:

```typescript
async function readSafeFile(roots: string[], file: string): Promise<string | null> {
  // Relative paths: try each candidate root, return the first that actually
  // reads. git emits repo-root-relative paths (e.g. "apps/api/src/x.ts"), so a
  // package-scoped workdir alone double-prefixes and misses. Trying [repoRoot,
  // workdir] resolves both repo-relative and package-relative findings without
  // assuming which style the reviewer used. validateModulePath checks
  // containment (not existence), so the Bun.file read is what disambiguates.
  for (const root of roots) {
    const validated = validateModulePath(file, [root]);
    if (validated.valid && validated.absolutePath) {
      try {
        return await Bun.file(validated.absolutePath).text();
      } catch {
        // File not present under this root — try the next candidate.
      }
    }
  }
  if (isAbsolute(file)) {
    try {
      return await Bun.file(file).text();
    } catch {
      return null;
    }
  }
  return null;
}
```

Then update `checkFindingEvidence` to accept `repoRoot` and build the candidate root list:

```typescript
export async function checkFindingEvidence(opts: {
  finding: FindingWithEvidence;
  workdir: string;
  repoRoot?: string;
}): Promise<EvidenceCheckResult> {
  const observed = opts.finding.verifiedBy?.observed?.trim();
  const file = opts.finding.verifiedBy?.file?.trim() || opts.finding.file;
  const line = opts.finding.verifiedBy?.line ?? opts.finding.line;
  if (!observed) return { status: "missing-observed", file, line };
  // repoRoot first (git paths are repo-root-relative), then workdir as a
  // package-relative fallback. Dedupe when they are equal (single-package).
  const roots =
    opts.repoRoot && opts.repoRoot !== opts.workdir ? [opts.repoRoot, opts.workdir] : [opts.workdir];
  const contents = await readSafeFile(roots, file);
  if (contents === null) return { status: "unreadable", file, line, observed };
  return matchesEvidence(contents, observed, line)
    ? { status: "matched", file, line, observed }
    : { status: "unmatched", file, line, observed };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `timeout 60 bun test test/unit/review/semantic-evidence.test.ts --timeout=10000`
Expected: PASS — all new monorepo tests green AND all 19 pre-existing tests still green (including "preserves error finding when absolute verifiedBy.file does not exist on this machine").

- [ ] **Step 5: Commit**

```bash
git add src/review/semantic-evidence.ts test/unit/review/semantic-evidence.test.ts
git commit -m "fix(review): resolve evidence file paths against repoRoot for monorepo packages"
```

---

## Task 2: Thread repoRoot through the semantic review op

**Files:**
- Modify: `src/review/semantic-evidence.ts` (`substantiateSemanticEvidence` signature)
- Modify: `src/operations/semantic-review.ts` (`SemanticReviewInput`, `verify()`, `requoteBlockingFindings`)
- Modify: `src/review/semantic.ts` (`callOp` input)
- Test: `test/unit/review/semantic-evidence.test.ts`

**Interfaces:**
- Consumes: `checkFindingEvidence({ finding, workdir, repoRoot })` from Task 1.
- Produces:
  - `substantiateSemanticEvidence(findings, diffMode, workdir, storyId, blockingThreshold?, repoRoot?)` — new trailing optional `repoRoot`.
  - `SemanticReviewInput.repoRoot?: string` — consumed by `verify()` and `requoteBlockingFindings`.

- [ ] **Step 1: Write the failing test**

Add to the `describe("substantiateSemanticEvidence — ref mode", ...)` block in `test/unit/review/semantic-evidence.test.ts`:

```typescript
  test("downgrades monorepo finding whose observed is absent once repoRoot resolves the path", async () => {
    await withTempDir(async (repoRoot) => {
      mkdirSync(join(repoRoot, "apps/api/src"), { recursive: true });
      writeFileSync(join(repoRoot, "apps/api/src/x.ts"), "export const handler = () => 1;\n");
      const packageDir = join(repoRoot, "apps/api");

      const finding = makeFinding({
        file: "apps/api/src/x.ts",
        line: 0,
        verifiedBy: {
          command: "git diff --stat",
          file: "apps/api/src/x.ts",
          line: 0,
          observed: "no x.ts in the changeset",
        },
      });

      const result = await substantiateSemanticEvidence(
        [finding],
        "ref",
        packageDir,
        STORY_ID,
        "error",
        repoRoot,
      );

      expect(result[0].severity).toBe("unverifiable");
      expect(logger.calls.find((c) => c.message.includes("Downgraded"))).toBeDefined();
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 60 bun test test/unit/review/semantic-evidence.test.ts --timeout=10000`
Expected: FAIL — `substantiateSemanticEvidence` does not yet accept a 6th `repoRoot` argument, so resolution falls back to `packageDir`, the file is unreadable, status is `"unreadable"` (not `"unmatched"`), and the finding stays `"error"` (no "Downgraded" log).

- [ ] **Step 3: Add `repoRoot` to `substantiateSemanticEvidence`**

In `src/review/semantic-evidence.ts`:

```typescript
export async function substantiateSemanticEvidence(
  findings: LLMFinding[],
  diffMode: SemanticReviewConfig["diffMode"],
  workdir: string,
  storyId: string,
  blockingThreshold: "error" | "warning" | "info" = "error",
  repoRoot?: string,
): Promise<LLMFinding[]> {
  if (diffMode !== "ref") return findings;
  return Promise.all(
    findings.map(async (finding) => {
      if (!isBlockingSeverity(finding.severity, blockingThreshold)) return finding;
      const evidence = await checkFindingEvidence({ finding, workdir, repoRoot });
      if (evidence.status !== "unmatched") return finding;
      return downgradeUnsubstantiatedFinding({ finding, storyId, ...evidence });
    }),
  );
}
```

- [ ] **Step 4: Run the new test to verify it passes**

Run: `timeout 60 bun test test/unit/review/semantic-evidence.test.ts --timeout=10000`
Expected: PASS — the monorepo finding downgrades to `"unverifiable"` and emits the "Downgraded" log.

- [ ] **Step 5: Add `repoRoot` to the semantic op input + verify/requote wiring**

In `src/operations/semantic-review.ts`, add the field to `SemanticReviewInput` (place it next to `workdir`):

```typescript
export interface SemanticReviewInput {
  workdir: string;
  /** Absolute repo root (= projectDir ?? workdir). Anchors evidence path resolution for monorepo packages. */
  repoRoot?: string;
  story: SemanticStory;
  // ...rest unchanged...
```

In `verify()` (around line 350), pass `input.repoRoot` as the new 6th argument:

```typescript
    const substantiated = await substantiateSemanticEvidence(
      sanitized,
      input.mode,
      input.workdir,
      input.story.id,
      threshold,
      input.repoRoot,
    );
```

In `requoteBlockingFindings`, update **both** `checkFindingEvidence` calls (around lines 389 and 417) to forward `repoRoot`:

```typescript
    const initialEvidence = await checkFindingEvidence({
      finding,
      workdir: ctx.input.workdir,
      repoRoot: ctx.input.repoRoot,
    });
```

```typescript
    const requotedEvidence = await checkFindingEvidence({
      finding: updatedFinding,
      workdir: ctx.input.workdir,
      repoRoot: ctx.input.repoRoot,
    });
```

- [ ] **Step 6: Populate `repoRoot` when building the semantic op input**

In `src/review/semantic.ts`, the `callOp(callCtx, semanticReviewOp, { ... })` input object (around line 298) — add `repoRoot`. `projectDir` and `workdir` are both in scope in `runSemanticReview`:

```typescript
    opResult = await _semanticDeps.callOp(callCtx, semanticReviewOp, {
      workdir,
      repoRoot: projectDir ?? workdir,
      story,
      semanticConfig,
      mode: diffMode,
      diff,
      storyGitRef: effectiveRef,
      stat,
      priorSemanticIterations,
      excludePatterns,
      featureCtxBlock,
      blockingThreshold,
    });
```

- [ ] **Step 7: Run semantic op + evidence tests to verify everything passes**

Run: `timeout 60 bun test test/unit/review/semantic-evidence.test.ts test/unit/review/semantic-findings.test.ts --timeout=10000`
Expected: PASS — all green.

- [ ] **Step 8: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/review/semantic-evidence.ts src/operations/semantic-review.ts src/review/semantic.ts test/unit/review/semantic-evidence.test.ts
git commit -m "fix(review): thread repoRoot into semantic evidence substantiation"
```

---

## Task 3: Thread repoRoot through the adversarial review op

**Files:**
- Modify: `src/review/finding-filters.ts` (`substantiateAdversarialFindings`)
- Modify: `src/operations/adversarial-review.ts` (`AdversarialReviewInput`, `verify()`, requote)
- Modify: `src/review/adversarial.ts` (`callOp` input)
- Test: `test/unit/review/adversarial-verifiedby.test.ts`

**Interfaces:**
- Consumes: `checkFindingEvidence({ finding, workdir, repoRoot })` from Task 1.
- Produces:
  - `substantiateAdversarialFindings({ findings, workdir, storyId, blockingThreshold, repoRoot? })` — new optional `repoRoot`.
  - `AdversarialReviewInput.repoRoot?: string`.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/review/adversarial-verifiedby.test.ts`. This test imports `substantiateAdversarialFindings` directly (a pure function) from the leaf module and verifies the monorepo downgrade. Add the import near the top of the file (with the other imports):

```typescript
import { substantiateAdversarialFindings } from "@/review/finding-filters";
import type { AdversarialLLMFinding } from "@/review/adversarial-helpers";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withTempDir } from "@test/helpers";
```

(If any of these are already imported in the file, do not duplicate them.)

Then add this `describe` block at the end of the file:

```typescript
describe("substantiateAdversarialFindings — monorepo repoRoot resolution", () => {
  function makeAdvFinding(overrides: Partial<AdversarialLLMFinding> = {}): AdversarialLLMFinding {
    return {
      severity: "error",
      file: "apps/api/src/x.ts",
      line: 0,
      issue: "AC not implemented",
      suggestion: "Implement it",
      verifiedBy: {
        file: "apps/api/src/x.ts",
        line: 0,
        observed: "no x.ts in the changeset",
      },
      ...overrides,
    } as AdversarialLLMFinding;
  }

  test("downgrades monorepo finding whose observed is absent once repoRoot resolves the path", async () => {
    await withTempDir(async (repoRoot) => {
      mkdirSync(join(repoRoot, "apps/api/src"), { recursive: true });
      writeFileSync(join(repoRoot, "apps/api/src/x.ts"), "export const handler = () => 1;\n");
      const packageDir = join(repoRoot, "apps/api");

      const result = await substantiateAdversarialFindings({
        findings: [makeAdvFinding()],
        workdir: packageDir,
        storyId: "STORY-001",
        blockingThreshold: "error",
        repoRoot,
      });

      expect(result[0].severity).toBe("unverifiable");
    });
  });

  test("preserves monorepo finding whose observed matches the file", async () => {
    await withTempDir(async (repoRoot) => {
      mkdirSync(join(repoRoot, "apps/api/src"), { recursive: true });
      writeFileSync(join(repoRoot, "apps/api/src/x.ts"), "export const handler = () => 1;\n");
      const packageDir = join(repoRoot, "apps/api");

      const finding = makeAdvFinding({
        line: 1,
        verifiedBy: { file: "apps/api/src/x.ts", line: 1, observed: "export const handler = () => 1;" },
      });

      const result = await substantiateAdversarialFindings({
        findings: [finding],
        workdir: packageDir,
        storyId: "STORY-001",
        blockingThreshold: "error",
        repoRoot,
      });

      expect(result[0].severity).toBe("error");
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 60 bun test test/unit/review/adversarial-verifiedby.test.ts --timeout=10000`
Expected: FAIL — `substantiateAdversarialFindings` does not yet accept `repoRoot`; the file is unreadable at the doubled path → status `"unreadable"` → finding preserved as `"error"` (first test expects `"unverifiable"`).

- [ ] **Step 3: Add `repoRoot` to `substantiateAdversarialFindings`**

In `src/review/finding-filters.ts`:

```typescript
export async function substantiateAdversarialFindings(opts: {
  findings: AdversarialLLMFinding[];
  workdir: string;
  storyId: string;
  blockingThreshold: "error" | "warning" | "info";
  repoRoot?: string;
}): Promise<AdversarialLLMFinding[]> {
  const { findings, workdir, storyId, blockingThreshold, repoRoot } = opts;
  return Promise.all(
    findings.map(async (finding) => {
      if (!isBlockingSeverity(finding.severity, blockingThreshold)) return finding;
      const evidence = await checkFindingEvidence({ finding, workdir, repoRoot });
      // NOTE: adversarial downgrades on "missing-observed" too — semantic handles
      // that upstream in sanitizeRefModeFindings, so the divergence is intentional.
      if (evidence.status !== "unmatched" && evidence.status !== "missing-observed") return finding;
      return downgradeUnsubstantiatedFinding({
        finding,
        storyId,
        event: ADVERSARIAL_FINDING_DOWNGRADED_EVENT,
        file: evidence.file,
        line: evidence.line,
        observed: evidence.observed,
      });
    }),
  );
}
```

- [ ] **Step 4: Run the new tests to verify they pass**

Run: `timeout 60 bun test test/unit/review/adversarial-verifiedby.test.ts --timeout=10000`
Expected: PASS — first test downgrades to `"unverifiable"`, second preserves `"error"`, and all pre-existing tests in the file stay green.

- [ ] **Step 5: Add `repoRoot` to the adversarial op input + verify/requote wiring**

In `src/operations/adversarial-review.ts`, add the field to `AdversarialReviewInput` (next to `workdir`):

```typescript
export interface AdversarialReviewInput {
  /** Absolute path to the package workdir — required by verify() for evidence substantiation. */
  workdir: string;
  /** Absolute repo root (= projectDir ?? workdir). Anchors evidence path resolution for monorepo packages. */
  repoRoot?: string;
  story: SemanticStory;
  // ...rest unchanged...
```

In `verify()` (the `substantiateAdversarialFindings` call around line 475), add `repoRoot`:

```typescript
    const substantiated = await substantiateAdversarialFindings({
      findings,
      workdir: input.workdir,
      repoRoot: input.repoRoot,
      storyId: input.story.id,
      blockingThreshold: threshold,
    });
```

In the requote loop, update **both** `checkFindingEvidence` calls (around lines 165 and 192) to forward `repoRoot`:

```typescript
    const initialEvidence = await checkFindingEvidence({
      finding,
      workdir: ctx.input.workdir,
      repoRoot: ctx.input.repoRoot,
    });
```

```typescript
    const requotedEvidence = await checkFindingEvidence({
      finding: updatedFinding,
      workdir: ctx.input.workdir,
      repoRoot: ctx.input.repoRoot,
    });
```

- [ ] **Step 6: Populate `repoRoot` when building the adversarial op input**

In `src/review/adversarial.ts`, the `callOp(callCtx, adversarialReviewOp, { ... })` input object (around line 250) — add `repoRoot`. `projectDir` and `workdir` are in scope:

```typescript
    opResult = await _adversarialDeps.callOp(callCtx, adversarialReviewOp, {
      workdir,
      repoRoot: projectDir ?? workdir,
      story,
      adversarialConfig,
      mode: diffMode,
      diff,
      storyGitRef: effectiveRef,
      stat,
      testInventory,
      excludePatterns: adversarialConfig.excludePatterns,
      testGlobs,
      featureCtxBlock,
      priorAdversarialIterations,
      blockingThreshold,
      refExcludePatterns: effectiveRefExcludePatterns,
    });
```

- [ ] **Step 7: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/review/finding-filters.ts src/operations/adversarial-review.ts src/review/adversarial.ts test/unit/review/adversarial-verifiedby.test.ts
git commit -m "fix(review): thread repoRoot into adversarial evidence substantiation"
```

---

## Task 4: Full review-suite regression gate + lint

**Files:** none modified — verification only.

**Interfaces:** none.

- [ ] **Step 1: Run the full scoped review unit + integration suites**

Run: `timeout 120 bun test test/unit/review/ test/integration/review/ --timeout=15000`
Expected: PASS — all review tests green, including `adversarial-reprompt-telemetry.test.ts` (requote telemetry) and `semantic-findings.test.ts`.

- [ ] **Step 2: Run lint (includes Biome + file-size + alias checks)**

Run: `bun run lint`
Expected: no errors. If Biome reports formatting, run `bun run lint:fix` and re-run `bun run lint`.

- [ ] **Step 3: Run typecheck once more across the whole project**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 4: Final verification commit (only if lint:fix changed files)**

```bash
git add -A
git commit -m "chore(review): lint/format after evidence path-resolution fix"
```

(Skip if there is nothing to commit.)

---

## Self-Review checklist (already applied)

- **Spec coverage:** Path-resolution fix (Task 1) + semantic threading (Task 2) + adversarial threading (Task 3) + regression gate (Task 4). The two reviewers share `checkFindingEvidence`, fixed once in Task 1.
- **Dropped from scope (intentional):** downgrade-on-`unreadable` — contradicts the tested macOS-absolute-path preserve contract (`semantic-evidence.test.ts:169`). The `unmatched`/`missing-observed` divergence between semantic and adversarial is **left as-is** (semantic handles `missing-observed` upstream in `sanitizeRefModeFindings`); a clarifying comment is added in Task 3 Step 3.
- **Type consistency:** `repoRoot?: string` is optional everywhere — `checkFindingEvidence` opts, `substantiateSemanticEvidence` 6th param, `substantiateAdversarialFindings` opts, `SemanticReviewInput`, `AdversarialReviewInput`. Every existing call site compiles unchanged (omitted `repoRoot` ⇒ prior behavior). `readSafeFile` is private; its signature change `(workdir)` → `(roots[])` has exactly one caller (`checkFindingEvidence`), updated in the same task.
- **Behavior bound:** changes only fire for `diffMode: "ref"` + blocking severity + `repoRoot !== workdir` (monorepo). Single-package, embedded mode, non-blocking, and absolute-path findings are byte-identical.

## Manual end-to-end validation (optional, after merge)

The original failure is in `logs/2026-06-25T01-34-59.jsonl` (story US-004, feature `portfolio-order-submission`, a monorepo at `apps/api`). To confirm the fix on a real run, re-run that feature and verify the semantic review either (a) downgrades the phantom "missing `_portfolio.py`" findings to `unverifiable` (visible as a "Downgraded unsubstantiated review finding" warn log with `event: review.semantic.finding.downgraded`), or (b) requotes and recovers — instead of failing US-004 with 3→7 phantom findings.
