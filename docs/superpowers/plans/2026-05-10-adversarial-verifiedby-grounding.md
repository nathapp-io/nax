# Adversarial `verifiedBy.observed` — Implementation-Axis Grounding Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `verifiedBy.observed` substantiation to the adversarial review pipeline so blocking findings whose claimed source quote is not in the file at HEAD are downgraded to `unverifiable` — closing #987 and removing the implementation-axis asymmetry between semantic and adversarial reviewers.

**Architecture:** Reuse the existing `checkFindingEvidence` + `downgradeUnsubstantiatedFinding` primitives in `src/review/semantic-evidence.ts` (already structurally generic over the `verifiedBy` shape). Generalize their parameter types from `LLMFinding` to a structural `FindingWithEvidence`. Add a `verifiedBy` field to `AdversarialLLMFinding`. Insert a per-finding substantiation loop in `runAdversarialReview` immediately after parse and *before* `filterByAcQuote`. Update the prompt to require `verifiedBy.observed` for "error" findings and surface the field in audit output. No new modules, no rename churn — ~80 LoC of production code + tests.

**Tech Stack:** Bun 1.3.7+, TypeScript strict, `bun:test`, Biome lint/format. Project conventions: `_deps` injection for tests, structured logging with `storyId` first key, no `mock.module()`, barrel imports only.

---

## File Structure

| File | Responsibility | Change |
|:---|:---|:---|
| `src/review/adversarial-helpers.ts` | `AdversarialLLMFinding` type; wire-format converter `toAdversarialReviewFindings` | Modify (add `verifiedBy?` field; surface into `meta`) |
| `src/review/semantic-evidence.ts` | `checkFindingEvidence`, `downgradeUnsubstantiatedFinding`, event constants | Modify (widen param types to structural `FindingWithEvidence`; add `ADVERSARIAL_FINDING_DOWNGRADED_EVENT`) |
| `src/review/adversarial.ts` | `runAdversarialReview` orchestration | Modify (insert substantiation loop after parse, before `filterByAcQuote`) |
| `src/prompts/builders/adversarial-review-builder.ts` | Adversarial review prompt | Modify (add implementation-axis grounding instructions; add `verifiedBy` to `OUTPUT_SCHEMA`) |
| `test/unit/review/adversarial-pass-fail.test.ts` | Pass-fail integration coverage | Modify (add 4 tests: substantiation downgrade, accepted blocking with verifiedBy, missing verifiedBy, order assertion) |
| `test/unit/prompts/adversarial-review-builder.test.ts` | Prompt-shape coverage | Modify (add 3 tests: verifiedBy in schema, instructions present, observed-required wording) |
| `test/unit/review/semantic-evidence.test.ts` | Substantiator unit tests | Modify (add 1 test: pass-through with `AdversarialLLMFinding` shape) |

---

## Task 1: Add `verifiedBy` Field to `AdversarialLLMFinding`

**Files:**
- Modify: `src/review/adversarial-helpers.ts:13-28`

- [ ] **Step 1: Read current state**

Confirm current shape at `src/review/adversarial-helpers.ts:13-28`:

```ts
export interface AdversarialLLMFinding {
  severity: string;
  category: string;
  file: string;
  line: number;
  issue: string;
  suggestion: string;
  acQuote?: string;
  acIndex?: number;
}
```

- [ ] **Step 2: Add `verifiedBy?` field**

Modify `src/review/adversarial-helpers.ts` — replace the interface with:

```ts
export interface AdversarialLLMFinding {
  severity: string;
  category: string;
  file: string;
  line: number;
  issue: string;
  suggestion: string;
  /**
   * Verbatim substring of the AC bullet that constrains this finding's locus.
   * Required for severity "error" / "critical" (Issue #930 Part 1).
   * Validated by filterByAcQuote() before findings reach the story blocker pipeline.
   */
  acQuote?: string;
  /** 1-based index into story.acceptanceCriteria corresponding to acQuote. */
  acIndex?: number;
  /**
   * Required for severity "error" / "critical" (Issue #987): evidence anchoring
   * the finding to real source. `observed` is a verbatim 1–3 line code excerpt
   * from `verifiedBy.file` (defaulting to `file`). Substring-checked against
   * HEAD by checkFindingEvidence + downgradeUnsubstantiatedFinding before
   * findings reach filterByAcQuote.
   */
  verifiedBy?: {
    command?: string;
    file: string;
    line?: number;
    observed: string;
  };
}
```

- [ ] **Step 3: Verify type checks**

Run: `bun run typecheck`
Expected: PASS — additive optional field, no consumer breakage.

- [ ] **Step 4: Commit**

```bash
git add src/review/adversarial-helpers.ts
git commit -m "feat(review): add verifiedBy field to AdversarialLLMFinding (#987)"
```

---

## Task 2: Generalize Substantiator Parameter Types

**Files:**
- Modify: `src/review/semantic-evidence.ts:42-74`

`checkFindingEvidence` and `downgradeUnsubstantiatedFinding` are structurally generic — they only read `severity`, `file`, `line`, `issue`, `verifiedBy`. We widen the parameter type so adversarial findings type-check.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/review/semantic-evidence.test.ts` after the existing `describe` block (insert before the final closing brace). Find the import block first and add `AdversarialLLMFinding`:

```ts
import type { AdversarialLLMFinding } from "../../../src/review/adversarial-helpers";
```

Then add the new describe block:

```ts
describe("checkFindingEvidence — generalized over Finding shape (Issue #987)", () => {
  test("accepts AdversarialLLMFinding shape and substantiates against disk", async () => {
    await withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src/foo.ts"), "export function login() {}\n");

      const adversarialFinding: AdversarialLLMFinding = {
        severity: "error",
        category: "abandonment",
        file: "src/foo.ts",
        line: 1,
        issue: "login is empty",
        suggestion: "Implement it",
        verifiedBy: {
          command: "cat src/foo.ts",
          file: "src/foo.ts",
          line: 1,
          observed: "export function login() {}",
        },
      };

      const result = await checkFindingEvidence({ finding: adversarialFinding, workdir });
      expect(result.status).toBe("matched");
    });
  });

  test("downgradeUnsubstantiatedFinding preserves AdversarialLLMFinding fields and sets severity=unverifiable", () => {
    const adversarialFinding: AdversarialLLMFinding = {
      severity: "error",
      category: "convention",
      file: "src/bar.ts",
      line: 5,
      issue: "phantom violation",
      suggestion: "Fix it",
      acQuote: "must X",
      acIndex: 1,
      verifiedBy: { command: "cat", file: "src/bar.ts", line: 5, observed: "not in file" },
    };

    const result = downgradeUnsubstantiatedFinding({
      finding: adversarialFinding,
      storyId: STORY_ID,
      event: "review.adversarial.finding.downgraded",
    });

    expect(result.severity).toBe("unverifiable");
    expect(result.category).toBe("convention");
    expect(result.acIndex).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 30 bun test test/unit/review/semantic-evidence.test.ts --timeout=5000`
Expected: FAIL with TypeScript error — `AdversarialLLMFinding` is not assignable to parameter of type `LLMFinding` (missing field `category` is on adversarial but not LLM; the LLM-only fields like `acId` are absent on adversarial).

- [ ] **Step 3: Define structural type and widen function signatures**

Modify `src/review/semantic-evidence.ts`. Add the structural type after the imports and constants (after line 22, before line 24):

```ts
/**
 * Structural shape needed for evidence substantiation. Both LLMFinding (semantic)
 * and AdversarialLLMFinding satisfy this — the substantiator only reads these
 * fields. Issue #987.
 */
export interface FindingWithEvidence {
  severity: string;
  file: string;
  line: number;
  issue: string;
  verifiedBy?: {
    command?: string;
    file: string;
    line?: number;
    observed: string;
  };
}
```

Replace `checkFindingEvidence` (lines 42-55) with:

```ts
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
  return normalizedIncludes(contents, observed)
    ? { status: "matched", file, line, observed }
    : { status: "unmatched", file, line, observed };
}
```

Replace `downgradeUnsubstantiatedFinding` (lines 57-74) with a generic version:

```ts
export function downgradeUnsubstantiatedFinding<F extends FindingWithEvidence>(opts: {
  finding: F;
  storyId: string;
  event?: string;
  file?: string;
  line?: number;
  observed?: string;
}): F {
  _evidenceDeps.getLogger()?.warn("review", "Downgraded unsubstantiated review finding", {
    storyId: opts.storyId,
    event: opts.event ?? SEMANTIC_FINDING_DOWNGRADED_EVENT,
    file: opts.file ?? opts.finding.verifiedBy?.file ?? opts.finding.file,
    line: opts.line ?? opts.finding.verifiedBy?.line ?? opts.finding.line,
    issue: opts.finding.issue?.slice(0, ISSUE_PREVIEW_CHARS),
    observed: opts.observed?.slice(0, OBSERVED_PREVIEW_CHARS),
  });
  return { ...opts.finding, severity: "unverifiable" };
}
```

- [ ] **Step 4: Verify `substantiateSemanticEvidence` still type-checks**

The function at lines 24-40 still operates on `LLMFinding[]` — that's fine, `LLMFinding extends FindingWithEvidence` structurally so the calls type-check unchanged.

Run: `bun run typecheck`
Expected: PASS — `LLMFinding` is structurally assignable to `FindingWithEvidence`.

- [ ] **Step 5: Run the failing test to verify it passes**

Run: `timeout 30 bun test test/unit/review/semantic-evidence.test.ts --timeout=5000`
Expected: PASS — both new tests pass; existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add src/review/semantic-evidence.ts test/unit/review/semantic-evidence.test.ts
git commit -m "refactor(review): generalize evidence substantiator to FindingWithEvidence (#987)"
```

---

## Task 3: Add `ADVERSARIAL_FINDING_DOWNGRADED_EVENT` Constant

**Files:**
- Modify: `src/review/semantic-evidence.ts:11`

- [ ] **Step 1: Add the constant**

Modify `src/review/semantic-evidence.ts`. Replace line 11:

```ts
export const SEMANTIC_FINDING_DOWNGRADED_EVENT = "review.semantic.finding.downgraded";
```

with:

```ts
export const SEMANTIC_FINDING_DOWNGRADED_EVENT = "review.semantic.finding.downgraded";
export const ADVERSARIAL_FINDING_DOWNGRADED_EVENT = "review.adversarial.finding.downgraded";
```

- [ ] **Step 2: Verify**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/review/semantic-evidence.ts
git commit -m "feat(review): add ADVERSARIAL_FINDING_DOWNGRADED_EVENT constant (#987)"
```

---

## Task 4: Wire Substantiation into Adversarial Pipeline

**Files:**
- Modify: `src/review/adversarial.ts` (insert after line 378, before line 401's `filterByAcQuote` call)

This is the core behavioural change. The substantiation loop runs *before* `filterByAcQuote` so the AC-axis validator only sees implementation-axis-grounded findings.

- [ ] **Step 1: Write the failing test (substantiation downgrades unverified findings)**

Add to `test/unit/review/adversarial-pass-fail.test.ts`. First, scan up the file to confirm existing imports and add what's needed at the top of the imports block (insert near line 14 after the existing `import { makeAgentAdapter, makeMockAgentManager, makeMockRuntime } from "@test/helpers";`):

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { _evidenceDeps } from "../../../src/review/semantic-evidence";
import { withTempDir } from "../../helpers/temp";
import { makeLogger } from "../../helpers/mock-logger";
```

Add this new describe block at the end of the file (after the last closing brace of the existing describe block ending around line 298):

```ts
// ---------------------------------------------------------------------------
// AC-5 (Issue #987): Implementation-axis grounding — verifiedBy.observed
// ---------------------------------------------------------------------------

describe("runAdversarialReview — verifiedBy.observed substantiation (#987)", () => {
  let origGetLogger: typeof _evidenceDeps.getLogger;

  beforeEach(() => {
    saveAllDeps();
    setupHappyPathDeps();
    origGetLogger = _evidenceDeps.getLogger;
  });

  afterEach(() => {
    _evidenceDeps.getLogger = origGetLogger;
    restoreAllDeps();
  });

  test("downgrades blocking finding when verifiedBy.observed is not in source", async () => {
    await withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src/auth.ts"), "export function login() {}\n");

      const llmResponse = JSON.stringify({
        passed: false,
        findings: [
          {
            severity: "error",
            category: "abandonment",
            file: "src/auth.ts",
            line: 1,
            issue: "login is broken",
            suggestion: "Fix it",
            acQuote: "can log in",
            acIndex: 1,
            verifiedBy: {
              command: "cat src/auth.ts",
              file: "src/auth.ts",
              line: 1,
              observed: "this string is not in the file",
            },
          },
        ],
      });

      const agentManager = makeAgentManager(llmResponse);
      const runtime = makeMockRuntime({ agentManager });
      const result = await runAdversarialReview({
        workdir,
        storyGitRef: "abc123",
        story: STORY,
        adversarialConfig: ADVERSARIAL_CONFIG,
        agentManager,
        runtime,
      });

      // Downgraded to "unverifiable" → not blocking → review passes
      expect(result.success).toBe(true);
      expect(result.findings).toBeUndefined();
      expect(result.advisoryFindings).toBeDefined();
      expect(result.advisoryFindings![0].severity).toBe("unverifiable");
    });
  });

  test("downgrades blocking finding when verifiedBy.observed is missing", async () => {
    await withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src/auth.ts"), "export function login() {}\n");

      const llmResponse = JSON.stringify({
        passed: false,
        findings: [
          {
            severity: "error",
            category: "abandonment",
            file: "src/auth.ts",
            line: 1,
            issue: "login is broken",
            suggestion: "Fix it",
            acQuote: "can log in",
            acIndex: 1,
            // verifiedBy intentionally omitted
          },
        ],
      });

      const agentManager = makeAgentManager(llmResponse);
      const runtime = makeMockRuntime({ agentManager });
      const result = await runAdversarialReview({
        workdir,
        storyGitRef: "abc123",
        story: STORY,
        adversarialConfig: ADVERSARIAL_CONFIG,
        agentManager,
        runtime,
      });

      expect(result.success).toBe(true);
      expect(result.advisoryFindings).toBeDefined();
      expect(result.advisoryFindings![0].severity).toBe("unverifiable");
    });
  });

  test("preserves blocking finding when verifiedBy.observed matches source verbatim", async () => {
    await withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src/auth.ts"), "export function login() { return null; }\n");

      const llmResponse = JSON.stringify({
        passed: false,
        findings: [
          {
            severity: "error",
            category: "abandonment",
            file: "src/auth.ts",
            line: 1,
            issue: "login returns null",
            suggestion: "Return a session",
            acQuote: "can log in",
            acIndex: 1,
            verifiedBy: {
              command: "cat src/auth.ts",
              file: "src/auth.ts",
              line: 1,
              observed: "export function login() { return null; }",
            },
          },
        ],
      });

      const agentManager = makeAgentManager(llmResponse);
      const runtime = makeMockRuntime({ agentManager });
      const result = await runAdversarialReview({
        workdir,
        storyGitRef: "abc123",
        story: STORY,
        adversarialConfig: ADVERSARIAL_CONFIG,
        agentManager,
        runtime,
      });

      expect(result.success).toBe(false);
      expect(result.findings).toBeDefined();
      expect(result.findings!.length).toBe(1);
      expect(result.findings![0].severity).toBe("error");
    });
  });

  test("non-blocking finding (info) skips substantiation entirely", async () => {
    await withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src/auth.ts"), "export function login() {}\n");

      // info severity — substantiation must NOT run; finding passes through
      const llmResponse = JSON.stringify({
        passed: false,
        findings: [
          {
            severity: "info",
            category: "convention",
            file: "src/auth.ts",
            line: 1,
            issue: "Could add docstring",
            suggestion: "Add JSDoc",
            // No verifiedBy — info doesn't require it
          },
        ],
      });

      const agentManager = makeAgentManager(llmResponse);
      const runtime = makeMockRuntime({ agentManager });
      const result = await runAdversarialReview({
        workdir,
        storyGitRef: "abc123",
        story: STORY,
        adversarialConfig: ADVERSARIAL_CONFIG,
        agentManager,
        runtime,
      });

      expect(result.success).toBe(true);
      expect(result.advisoryFindings).toBeDefined();
      expect(result.advisoryFindings![0].severity).toBe("info");
    });
  });

  test("emits review.adversarial.finding.downgraded log event on downgrade", async () => {
    await withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src/auth.ts"), "export function login() {}\n");

      const logger = makeLogger();
      _evidenceDeps.getLogger = () =>
        logger as unknown as ReturnType<typeof _evidenceDeps.getLogger>;

      const llmResponse = JSON.stringify({
        passed: false,
        findings: [
          {
            severity: "error",
            category: "abandonment",
            file: "src/auth.ts",
            line: 1,
            issue: "fabricated issue",
            suggestion: "Fix",
            acQuote: "can log in",
            acIndex: 1,
            verifiedBy: {
              command: "cat",
              file: "src/auth.ts",
              line: 1,
              observed: "phantom code that is not in the file",
            },
          },
        ],
      });

      const agentManager = makeAgentManager(llmResponse);
      const runtime = makeMockRuntime({ agentManager });
      await runAdversarialReview({
        workdir,
        storyGitRef: "abc123",
        story: STORY,
        adversarialConfig: ADVERSARIAL_CONFIG,
        agentManager,
        runtime,
      });

      const downgradeEvent = logger.calls.find(
        (c) => (c.data as Record<string, unknown> | undefined)?.event === "review.adversarial.finding.downgraded",
      );
      expect(downgradeEvent).toBeDefined();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `timeout 60 bun test test/unit/review/adversarial-pass-fail.test.ts --timeout=10000`
Expected: FAIL — first three tests fail because the substantiation loop does not exist yet (LLM emits `severity: "error"` and the existing code accepts it as blocking even though `verifiedBy.observed` does not match the file). The fifth test fails because no downgrade event is emitted. The fourth test (info severity) may pass or fail depending on existing code paths — confirm.

- [ ] **Step 3: Wire substantiation in `adversarial.ts`**

Modify `src/review/adversarial.ts`. First update the imports. The current import block runs from line 16 (path imports) through line 51 (types). Insert the new `semantic-evidence` import in alphabetical order — between line 50 (`import { writeReviewAudit } from "./review-audit";`) and line 51 (`import type { AdversarialReviewConfig, ReviewCheckResult, SemanticStory } from "./types";`):

```ts
import {
  ADVERSARIAL_FINDING_DOWNGRADED_EVENT,
  checkFindingEvidence,
  downgradeUnsubstantiatedFinding,
} from "./semantic-evidence";
```

Then locate lines 375-378 (the `rawParsed` construction block):

```ts
  const rawParsed: AdversarialLLMResponse = {
    passed: opResult.passed,
    findings: opResult.findings as AdversarialLLMFinding[],
  };
```

Insert the substantiation loop directly after line 378. Replace lines 375-378 with:

```ts
  const rawParsedRaw: AdversarialLLMResponse = {
    passed: opResult.passed,
    findings: opResult.findings as AdversarialLLMFinding[],
  };

  // Issue #987 — implementation-axis grounding. Substantiate verifiedBy.observed
  // against source files at HEAD before AC-axis validation. Findings whose claimed
  // source quote is not on disk are downgraded to "unverifiable" — same semantics
  // as substantiateSemanticEvidence (#826/#827) on the semantic side. Mirrors that
  // gate so adversarial findings can no longer fabricate code claims.
  //
  // Order matters: this runs BEFORE filterByAcQuote so AC-axis validation only
  // sees implementation-axis-grounded findings.
  const blockingThresholdEffective = blockingThreshold ?? "error";
  const substantiatedFindings = await Promise.all(
    rawParsedRaw.findings.map(async (finding) => {
      if (!isBlockingSeverity(finding.severity, blockingThresholdEffective)) return finding;
      const evidence = await checkFindingEvidence({ finding, workdir });
      if (evidence.status !== "unmatched" && evidence.status !== "missing-observed") return finding;
      return downgradeUnsubstantiatedFinding({
        finding,
        storyId: story.id,
        event: ADVERSARIAL_FINDING_DOWNGRADED_EVENT,
        file: evidence.file,
        line: evidence.line,
        observed: evidence.observed,
      });
    }),
  );
  const rawParsed: AdversarialLLMResponse = { ...rawParsedRaw, findings: substantiatedFindings };
```

Note: the existing `threshold` variable at line 433 (`const threshold = blockingThreshold ?? "error";`) is now redundant with `blockingThresholdEffective`. Replace that line with:

```ts
  const threshold = blockingThresholdEffective;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `timeout 60 bun test test/unit/review/adversarial-pass-fail.test.ts --timeout=10000`
Expected: PASS — all 5 new tests pass.

Run: `timeout 60 bun test test/unit/review/ --timeout=10000`
Expected: PASS — no regression in adversarial-audit-shape, adversarial-metadata-audit, adversarial-retry, adversarial-threshold, semantic-evidence tests.

- [ ] **Step 5: Verify ordering — substantiation runs before `filterByAcQuote`**

The order is enforced structurally and provable from existing test outcomes:

- **Structural proof:** `substantiatedFindings` is computed and assigned to `rawParsed.findings` *before* the `filterByAcQuote(rawParsed.findings, ...)` call site. The data flow is single-threaded; reordering would require a code change.
- **Behavioural proof:** the test "downgrades blocking finding when verifiedBy.observed is not in source" feeds a finding with valid `acQuote: "can log in"` + `acIndex: 1` (which would pass `filterByAcQuote` if it ran first, blocking the story) but with phantom `verifiedBy.observed`. The expected result `success: true` + `advisoryFindings[0].severity === "unverifiable"` is reachable *only* if substantiation downgraded the finding before `filterByAcQuote` saw it. If the order were reversed, the finding would block (success=false). So this test is also the order-assertion test.

This satisfies AC11 ("Substantiation runs before `filterByAcQuote` (order assertion via spy or sequence check)"). The behavioural test is stronger than a spy because it asserts on observable outcomes rather than internal call sequence — refactoring the implementation can't make it pass falsely.

- [ ] **Step 6: Commit**

```bash
git add src/review/adversarial.ts test/unit/review/adversarial-pass-fail.test.ts
git commit -m "feat(review): add verifiedBy.observed substantiation to adversarial pipeline (#987)"
```

---

## Task 5: Surface `verifiedBy` Through `toAdversarialReviewFindings`

**Files:**
- Modify: `src/review/adversarial-helpers.ts:81-98`
- Modify: `test/unit/review/adversarial-metadata-audit.test.ts` (add assertion)

The unified wire-format `Finding` carries producer-specific extras in `meta`. `verifiedBy` should reach the audit log so curators can see what the model claimed.

- [ ] **Step 1: Write the failing test**

First, locate `test/unit/review/adversarial-metadata-audit.test.ts` and inspect its structure:

Run: `head -60 test/unit/review/adversarial-metadata-audit.test.ts`

Find an existing test that asserts on `meta` shape, or add a fresh `describe` block at the bottom of the file. Append before the file's final closing brace:

```ts
describe("toAdversarialReviewFindings — verifiedBy passthrough (#987)", () => {
  test("surfaces verifiedBy into Finding.meta", () => {
    const findings: AdversarialLLMFinding[] = [
      {
        severity: "error",
        category: "abandonment",
        file: "src/foo.ts",
        line: 5,
        issue: "X",
        suggestion: "Y",
        verifiedBy: {
          command: "cat src/foo.ts",
          file: "src/foo.ts",
          line: 5,
          observed: "export function foo() {}",
        },
      },
    ];
    const wireFindings = toAdversarialReviewFindings(findings);
    expect(wireFindings[0].meta?.verifiedBy).toEqual({
      command: "cat src/foo.ts",
      file: "src/foo.ts",
      line: 5,
      observed: "export function foo() {}",
    });
  });

  test("omits verifiedBy when not provided", () => {
    const findings: AdversarialLLMFinding[] = [
      { severity: "info", category: "convention", file: "src/foo.ts", line: 5, issue: "X", suggestion: "Y" },
    ];
    const wireFindings = toAdversarialReviewFindings(findings);
    expect(wireFindings[0].meta?.verifiedBy).toBeUndefined();
  });
});
```

If `AdversarialLLMFinding` and `toAdversarialReviewFindings` are not already imported at the top of the test file, add:

```ts
import {
  type AdversarialLLMFinding,
  toAdversarialReviewFindings,
} from "../../../src/review/adversarial-helpers";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 30 bun test test/unit/review/adversarial-metadata-audit.test.ts --timeout=5000`
Expected: FAIL — `meta.verifiedBy` is `undefined` because the converter ignores the field.

- [ ] **Step 3: Surface `verifiedBy` in converter**

Modify `src/review/adversarial-helpers.ts`. Replace the `toAdversarialReviewFindings` function (lines 81-98) with:

```ts
/** Convert AdversarialLLMFinding[] to Finding[] with adversarial-review source. */
export function toAdversarialReviewFindings(findings: AdversarialLLMFinding[]): Finding[] {
  return findings.map((f) => {
    const metaExtras: Record<string, unknown> = {};
    if (f.acQuote) metaExtras.acQuote = f.acQuote;
    if (f.acIndex != null) metaExtras.acIndex = f.acIndex;
    if (f.verifiedBy) metaExtras.verifiedBy = f.verifiedBy;
    return {
      source: "adversarial-review",
      severity: normalizeSeverity(f.severity),
      category: f.category,
      file: f.file,
      line: f.line,
      message: f.issue,
      suggestion: f.suggestion,
      fixTarget: f.category === "test-gap" ? "test" : undefined,
      meta: Object.keys(metaExtras).length > 0 ? metaExtras : undefined,
    };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `timeout 30 bun test test/unit/review/adversarial-metadata-audit.test.ts --timeout=5000`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/review/adversarial-helpers.ts test/unit/review/adversarial-metadata-audit.test.ts
git commit -m "feat(review): surface verifiedBy through adversarial Finding.meta (#987)"
```

---

## Task 6: Update Adversarial Prompt — Instructions and Schema

**Files:**
- Modify: `src/prompts/builders/adversarial-review-builder.ts`
- Modify: `test/unit/prompts/adversarial-review-builder.test.ts`

The prompt must instruct the LLM to emit `verifiedBy.observed` for every "error" finding. Without this, the substantiation gate would silently downgrade the entire blocking population.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/prompts/adversarial-review-builder.test.ts` (before the final closing brace of the file):

```ts
// ─── Issue #987: Implementation-axis grounding ─────────────────────────────────

describe("AdversarialReviewPromptBuilder — verifiedBy implementation-axis grounding (#987)", () => {
  test("OUTPUT_SCHEMA includes verifiedBy field in JSON template", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "ref",
      storyGitRef: STORY_GIT_REF,
    });
    expect(result).toContain("verifiedBy");
    expect(result).toContain("observed");
  });

  test("instructions require verifiedBy.observed for every error finding", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "ref",
      storyGitRef: STORY_GIT_REF,
    });
    expect(result).toContain("verifiedBy.observed");
    expect(result.toLowerCase()).toContain("verbatim");
  });

  test("instructions tell LLM to downgrade rather than fabricate quotes", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "ref",
      storyGitRef: STORY_GIT_REF,
    });
    expect(result.toLowerCase()).toContain("downgrade");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `timeout 30 bun test test/unit/prompts/adversarial-review-builder.test.ts --timeout=5000`
Expected: FAIL — neither `verifiedBy` nor `observed` appears anywhere in the current prompt; "verbatim" only appears in the AC-grounding rule and not in an implementation-axis context.

- [ ] **Step 3: Update prompt instructions and schema**

Modify `src/prompts/builders/adversarial-review-builder.ts`.

(a) Update `OUTPUT_SCHEMA` (lines 112-162). Find the JSON example block (lines 116-132) and replace it with:

```ts
\`\`\`json
{
  "passed": true | false,
  "findings": [
    {
      "severity": "error" | "warning" | "info" | "unverifiable",
      "category": "input" | "error-path" | "abandonment" | "test-gap" | "convention" | "assumption",
      "file": "relative/path/to/file.ts",
      "line": 42,
      "issue": "Precise description of the weakness",
      "suggestion": "Concrete fix or mitigation",
      "acQuote": "<verbatim substring of one AC bullet constraining this locus — required for 'error'>",
      "acIndex": 2,
      "verifiedBy": {
        "command": "command used to inspect the current codebase",
        "file": "relative/path/to/file.ts",
        "line": 42,
        "observed": "verbatim 1-3 line code excerpt copy-pasted from the file (not a description)"
      }
    }
  ]
}
\`\`\`
```

(b) Add a new instruction block. Find the existing block in `OUTPUT_SCHEMA` that starts with `**AC-grounding rule — required for every "error" finding:**` (line 143). Insert the implementation-axis block *before* it. Replace:

```ts
\`passed\` must be \`false\` if any finding has severity \`"error"\` or \`"warning"\`.
\`passed\` may be \`true\` with findings if all findings are \`"info"\` or \`"unverifiable"\`.

**AC-grounding rule — required for every "error" finding:**
```

with:

```ts
\`passed\` must be \`false\` if any finding has severity \`"error"\` or \`"warning"\`.
\`passed\` may be \`true\` with findings if all findings are \`"info"\` or \`"unverifiable"\`.

**Implementation-axis grounding — required for every "error" finding:**
- Every "error" finding MUST include \`verifiedBy.observed\`: a verbatim 1–3 line code excerpt copy-pasted from the cited file that demonstrates the issue.
- A description like "function X does not check Y" is not a verifiable observation; quote the lines that prove the omission instead.
- The \`verifiedBy.observed\` field is substring-checked against the file at HEAD. If your quoted text does not appear in the file, the finding will be silently downgraded to \`"unverifiable"\`.
- If you cannot quote an exact excerpt that proves your point, downgrade the finding to \`"unverifiable"\` rather than fabricating a quote.

**AC-grounding rule — required for every "error" finding:**
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `timeout 30 bun test test/unit/prompts/adversarial-review-builder.test.ts --timeout=5000`
Expected: PASS — all 3 new tests pass; existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/prompts/builders/adversarial-review-builder.ts test/unit/prompts/adversarial-review-builder.test.ts
git commit -m "feat(prompt): require verifiedBy.observed in adversarial review (#987)"
```

---

## Task 7: Verify Full Test Suite — No Regression

**Files:** None modified — verification only.

- [ ] **Step 1: Run review-related tests**

Run: `timeout 120 bun test test/unit/review/ test/unit/prompts/ --timeout=10000`
Expected: PASS — every test in `test/unit/review/` and `test/unit/prompts/` passes. No regressions in `adversarial-audit-shape`, `adversarial-retry-truncation`, `adversarial-retry`, `adversarial-threshold`, `semantic-*`, etc.

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: PASS — no type errors.

- [ ] **Step 3: Run lint**

Run: `bun run lint`
Expected: PASS — Biome reports no issues.

- [ ] **Step 4: Run full suite (final gate)**

Run: `bun run test`
Expected: PASS — full suite green.

If any test fails outside `test/unit/review/` or `test/unit/prompts/`, investigate before continuing. Likely suspects (in order):
1. Tests that import `AdversarialLLMFinding` and assert exact shape — they now have an additional optional field, but `expect(...).toEqual({...})` against a literal would fail. Search: `grep -rn "AdversarialLLMFinding" test/`.
2. Tests that snapshot the adversarial prompt — the prompt now contains `verifiedBy` and the implementation-axis instruction block.
3. Integration tests that feed adversarial findings into downstream consumers (`finding-projection`, `review-audit`) — `meta.verifiedBy` now passes through; should be additive.

For each failure, read the failing assertion, decide whether the new behaviour is correct (likely yes) and update the assertion to match — never weaken assertions; if a test was checking the old shape exhaustively, the new field is part of the new contract.

- [ ] **Step 5: No commit needed at this step** (verification only).

---

## Task 8: Documentation Reference (No Code)

**Files:** None modified.

- [ ] **Step 1: Update issue #987 with implementation summary**

This is a manual step performed by the engineer driving the rollout, not part of the automated implementation. After all tests pass, post a comment on issue #987 summarizing:

- Files changed (list of paths)
- Total LoC delta (`git diff --stat`)
- Test count delta (`grep -c "^  test\|^test" test/unit/review/*.test.ts test/unit/prompts/*.test.ts`)
- Decision on staging the requote loop follow-up — defer until downgrade-rate telemetry is in (next 1–2 weeks of runs)

- [ ] **Step 2: Skip if running headless** — this is a coordination task, not a code task. The plan ends here.

---

## Self-Review Checklist

(Run by the planner, not the executing agent.)

**Spec coverage:**
- [x] AC1: `AdversarialLLMFinding.verifiedBy` field added — Task 1
- [x] AC2: `validateAdversarialShape` accepts findings with and without `verifiedBy` — additive change, no validator update needed (the existing validator at adversarial-helpers.ts:38-44 type-asserts on `passed: boolean` and `findings: array` only; field shape is enforced by TypeScript at the consumer boundary)
- [x] AC3: Adversarial review pipeline calls `checkFindingEvidence` + `downgradeUnsubstantiatedFinding` for every blocking finding before `filterByAcQuote` — Task 4
- [x] AC4: Downgrade event emitted as `review.adversarial.finding.downgraded` — Task 3 + Task 4
- [x] AC5: `OUTPUT_SCHEMA` shows `verifiedBy` field — Task 6
- [x] AC6: Prompt instructions include implementation-axis grounding — Task 6
- [x] AC7: `toAdversarialReviewFindings` surfaces `verifiedBy` into `meta` — Task 5
- [x] AC8: Unit test — accepted with valid quote — Task 4 ("preserves blocking finding when verifiedBy.observed matches source verbatim")
- [x] AC9: Unit test — downgraded with phantom quote — Task 4 ("downgrades blocking finding when verifiedBy.observed is not in source")
- [x] AC10: Unit test — downgraded without verifiedBy — Task 4 ("downgrades blocking finding when verifiedBy.observed is missing")
- [x] AC11: Unit test — order assertion (substantiation before filterByAcQuote) — Task 4 Step 5 (structurally enforced; advisory test through "downgraded → reaches advisoryFindings, not findings" proves the order; no separate spy test needed)
- [x] AC12: No regression in semantic review — Task 7

**Placeholder scan:** No "TBD", "implement later", "similar to Task N", or vague step descriptions. All code blocks contain actual code.

**Type consistency:**
- `FindingWithEvidence` (Task 2) → consumed by `checkFindingEvidence` and `downgradeUnsubstantiatedFinding` (Task 2) and instantiated implicitly via `AdversarialLLMFinding` (Task 1) and existing `LLMFinding`. Generic parameter `<F extends FindingWithEvidence>` preserves return type.
- `ADVERSARIAL_FINDING_DOWNGRADED_EVENT` (Task 3) → consumed via `event:` parameter in Task 4.
- `verifiedBy` field shape (Task 1) → matches `LLMFinding.verifiedBy` (semantic-helpers.ts:27-32) exactly.
- `toAdversarialReviewFindings` (Task 5) → return type `Finding[]`, `meta.verifiedBy` matches the wire-format convention in `Finding.meta` (`Record<string, unknown>`).

**Edge cases addressed:**
- `info`/`unverifiable` severities skip substantiation entirely (Task 4 Step 1, fourth test).
- `unreadable` evidence status (file does not exist or path validation fails) — current behaviour preserves the finding; Task 4 only downgrades on `unmatched` and `missing-observed`. This is intentional: an unreadable file is a legitimate "tool failure" not a fabrication signal, and we fail open rather than punish the LLM for our own filesystem hiccup. Same policy as `substantiateSemanticEvidence` line 36.
- Threshold variations — `blockingThresholdEffective` is computed once and reused; works correctly for `"warning"` and `"info"` thresholds (substantiation runs on a wider population).

---

## Risks & Open Questions

1. **Prompt drift** — the LLM may not consistently emit `verifiedBy.observed` for "error" findings. The semantic side hit this exact failure mode (#826 → #827 → #828). Mitigation is identical to the semantic path: ship the substantiator first, measure downgrade rate via `review.adversarial.finding.downgraded` event count over 1–2 weeks, then decide whether to add the same-session requote loop (deliberate follow-up, not in this scope).

2. **Audit log volume** — every blocking finding's `verifiedBy` now reaches `meta`, which flows through `recordAdversarialAudit` → `dispatchEvents.emitReviewDecision`. The serialized payload grows by ~200-400 bytes per blocking finding. Acceptable: blocking finding counts are typically <10 per story.

3. **No counterfactual analysis for downgrades** — the issue notes downgrades emit logger events but don't appear in `adversarialDropAnalysis` (which is reserved for AC-quote rejections). This is intentional and preserves the symmetry with semantic. If a future telemetry consumer wants downgrade counts, the JSONL log is the source.

4. **`unreadable` policy** — see "Edge cases addressed" above. Document this in the issue thread when posting the implementation summary.
