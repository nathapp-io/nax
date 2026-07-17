# Adversarial Recurrence-Demotion (Phase 0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop adversarial review from deadlocking a story on out-of-AC-scope findings by auto-demoting a finding to advisory once its fingerprint keeps recurring, with a one-clause entry guard that eliminates severity flip-flops; plus close the test-gap laundering hole and fix review-audit fidelity.

**Architecture:** A single pure helper (`src/review/recurrence-demotion.ts`) classifies each accepted adversarial finding into block / advisory / demoted using a cumulative in-run appearance count computed from the `Iteration[]` history nax already threads. It is called from both the op `verify()` and the wrapper `runAdversarialReview` (the two independent verdict paths), keeping them in parity. A config flag (`recurrenceDemotion`, default on) gates the behavior. Separately, the review-audit writer stamps `naxVersion`/`naxCommit` and a resolved (never-null) `blockingThreshold`.

**Tech Stack:** Bun 1.3.7+, TypeScript strict, `bun:test`, Zod config schemas, Biome.

## Global Constraints

- Bun-native APIs only — `Bun.file`/`Bun.write`/`Bun.spawn`; no Node `fs`/`child_process`. (`.claude/rules/project-conventions.md`)
- No `console.log`/`console.error` in `src/` — use `getSafeLogger()` from `src/logger`. Every pipeline/review log call includes `storyId` as the first data key. (`.claude/rules/project-conventions.md`)
- Config defaults live in the Zod schema via `.default(...)`; `DEFAULT_CONFIG` is derived, never hand-edited. (`.claude/rules/config-patterns.md`)
- No hardcoded test-file patterns — classification of "is this a test file?" goes through `resolveTestFilePatterns()` / its `ResolvedTestPatterns`. (`.claude/rules/forbidden-patterns.md`)
- Do NOT branch on `Finding.meta` fields for load-bearing logic. (`src/findings/types.ts:166-173`)
- Import from barrels, not internal leaf paths, for value imports. (`.claude/rules/project-conventions.md`)
- Source file hard limit 600 lines; test file 800. (`.claude/rules/project-conventions.md`)
- Run scoped tests with a timeout wrapper: `timeout 30 bun test <path> --timeout=5000`. Never bare `bun test`. (`.claude/rules/testing-commands.md`)
- Conventional commits, one logical change per commit; never add `[run-release]`.

---

## File Structure

- **Create** `src/review/recurrence-demotion.ts` — pure classifier + fingerprint (the whole mechanism; ~120 lines).
- **Create** `test/unit/review/recurrence-demotion.test.ts` — helper unit tests.
- **Create** `test/e2e/adversarial-recurrence-demotion.e2e.test.ts` — orchestrator e2e.
- **Modify** `src/config/schemas-review.ts` — add `recurrenceDemotion` to `AdversarialReviewConfigSchema`.
- **Modify** `src/review/types.ts` — mirror the field on `AdversarialReviewConfig`.
- **Modify** `src/operations/adversarial-review.ts` — call the helper in `verify()`; add a top-level `resolvedTestPatterns?` input field.
- **Modify** `src/execution/story-orchestrator/run-phase.ts` — surface `resolvedTestPatterns` on the refreshed adversarial input (so the test-gap guard actually receives patterns — Finding A).
- **Modify** `src/review/adversarial.ts` — call the helper in the wrapper's block/advisory split (parity); add optional `resolvedTestPatterns` to `RunAdversarialReviewOptions`.
- **Modify** `src/review/review-audit.ts` — `ReviewAuditEntry` + `toPersistedEntry`: add `naxVersion`/`naxCommit`, resolve `blockingThreshold`.
- **Modify** `test/unit/review/review-audit*.test.ts` (whichever asserts persisted shape) — expect the new fields.

---

## Task 1: Fingerprint + prior-appearance counter (pure)

**Files:**
- Create: `src/review/recurrence-demotion.ts`
- Test: `test/unit/review/recurrence-demotion.test.ts`

**Interfaces:**
- Produces:
  - `normalizeIssueText(s: string): string`
  - `fingerprintFor(file: string | undefined, category: string | undefined, text: string): string`
  - `type PriorAppearance = { count: number; lastSeverity: string }`
  - `countPriorAppearances(priorIterations: Iteration[]): Map<string, PriorAppearance>`
- Consumes: `Iteration` from `src/findings` (has `findingsAfter: Finding[]`); `Finding.source`, `Finding.file`, `Finding.category`, `Finding.message`, `Finding.severity`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/review/recurrence-demotion.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import {
  fingerprintFor,
  normalizeIssueText,
  countPriorAppearances,
} from "@/review/recurrence-demotion";
import type { Iteration } from "@/findings";

function iter(num: number, findings: Array<{ file: string; category: string; message: string; severity: string }>): Iteration {
  return {
    iterationNum: num,
    findingsBefore: [],
    fixesApplied: [],
    findingsAfter: findings.map((f) => ({ source: "adversarial-review", severity: f.severity as any, category: f.category, file: f.file, message: f.message })),
    outcome: "fixes-applied" as any,
    startedAt: "2026-07-17T00:00:00.000Z",
    finishedAt: "2026-07-17T00:00:01.000Z",
  };
}

describe("normalizeIssueText", () => {
  test("strips backticks, collapses whitespace, lowercases, truncates to 160", () => {
    expect(normalizeIssueText("The `foo`   is\nBROKEN")).toBe("the foo is broken");
    expect(normalizeIssueText("x".repeat(200)).length).toBe(160);
  });
});

describe("fingerprintFor", () => {
  test("stable across line-shift and tail rephrase", () => {
    const a = fingerprintFor("lib/store.ts", "assumption", "window expiry is non-atomic because findFirst runs before upsert");
    const b = fingerprintFor("lib/store.ts", "assumption", "Window expiry is non-atomic because findFirst runs before upsert — and one more clause");
    expect(a).toBe(b);
  });
  test("distinct across file and category", () => {
    expect(fingerprintFor("a.ts", "input", "same text here padded padded padded")).not.toBe(fingerprintFor("b.ts", "input", "same text here padded padded padded"));
    expect(fingerprintFor("a.ts", "input", "same text here padded padded padded")).not.toBe(fingerprintFor("a.ts", "assumption", "same text here padded padded padded"));
  });
  test("normalizes backslash paths to forward slashes", () => {
    expect(fingerprintFor("lib\\store.ts", "x", "text")).toBe(fingerprintFor("lib/store.ts", "x", "text"));
  });
});

describe("countPriorAppearances", () => {
  test("counts one per iteration containing the fingerprint; tracks most-recent severity", () => {
    const fp = fingerprintFor("lib/store.ts", "assumption", "window expiry non-atomic");
    const priors = [
      iter(1, [{ file: "lib/store.ts", category: "assumption", message: "window expiry non-atomic", severity: "error" }]),
      iter(2, [{ file: "lib/store.ts", category: "assumption", message: "window expiry non-atomic", severity: "warning" }]),
    ];
    const m = countPriorAppearances(priors);
    expect(m.get(fp)).toEqual({ count: 2, lastSeverity: "warning" });
  });
  test("is cumulative — survives a one-iteration gap", () => {
    const fp = fingerprintFor("a.ts", "input", "same finding text padded padded");
    const priors = [
      iter(1, [{ file: "a.ts", category: "input", message: "same finding text padded padded", severity: "error" }]),
      iter(2, [{ file: "z.ts", category: "other", message: "unrelated", severity: "error" }]),
      iter(3, [{ file: "a.ts", category: "input", message: "same finding text padded padded", severity: "error" }]),
    ];
    expect(countPriorAppearances(priors).get(fp)?.count).toBe(2);
  });
  test("ignores non-adversarial-review findings", () => {
    const priors = [iter(1, [{ file: "a.ts", category: "input", message: "t", severity: "error" }])];
    priors[0].findingsAfter[0].source = "lint" as any;
    expect(countPriorAppearances(priors).size).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 30 bun test test/unit/review/recurrence-demotion.test.ts --timeout=5000`
Expected: FAIL — `Cannot find module '@/review/recurrence-demotion'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/review/recurrence-demotion.ts`:

```typescript
import type { Finding } from "../findings";
import type { Iteration } from "../findings";

const MAX_ISSUE_PREFIX = 160;

/** Backticks stripped, whitespace collapsed, lowercased, truncated to a bounded prefix. */
export function normalizeIssueText(s: string): string {
  return s.replace(/`/g, "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, MAX_ISSUE_PREFIX);
}

/**
 * Fingerprint = file + category + normalized issue text. Excludes line number
 * (shifts as code changes) and acIndex (only in Finding.meta on prior rounds,
 * which is not load-bearing-branchable). Used as a plain Map key.
 */
export function fingerprintFor(file: string | undefined, category: string | undefined, text: string): string {
  const normFile = (file ?? "").replace(/\\/g, "/");
  return `${normFile}|${category ?? ""}|${normalizeIssueText(text)}`;
}

export type PriorAppearance = { count: number; lastSeverity: string };

/**
 * One increment per prior iteration whose adversarial findings contain the
 * fingerprint (cumulative within run). `lastSeverity` is the severity in the
 * most-recent iteration containing it (iterations are chronological).
 */
export function countPriorAppearances(priorIterations: Iteration[]): Map<string, PriorAppearance> {
  const counts = new Map<string, PriorAppearance>();
  for (const it of priorIterations) {
    const seenThisIter = new Map<string, string>();
    for (const f of (it.findingsAfter ?? []) as Finding[]) {
      if (f.source !== "adversarial-review") continue;
      const fp = fingerprintFor(f.file, f.category, f.message);
      seenThisIter.set(fp, f.severity);
    }
    for (const [fp, sev] of seenThisIter) {
      const cur = counts.get(fp);
      counts.set(fp, { count: (cur?.count ?? 0) + 1, lastSeverity: sev });
    }
  }
  return counts;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `timeout 30 bun test test/unit/review/recurrence-demotion.test.ts --timeout=5000`
Expected: PASS (10 assertions).

- [ ] **Step 5: Commit**

```bash
git add src/review/recurrence-demotion.ts test/unit/review/recurrence-demotion.test.ts
git commit -m "feat(review): fingerprint + prior-appearance counter for recurrence demotion"
```

---

## Task 2: `classifyRecurrence` classifier

**Files:**
- Modify: `src/review/recurrence-demotion.ts`
- Test: `test/unit/review/recurrence-demotion.test.ts`

**Interfaces:**
- Consumes: `fingerprintFor`, `countPriorAppearances` (Task 1); `AdversarialLLMFinding` from `src/review/adversarial-helpers`; `isBlockingSeverity` from `src/review/adversarial-helpers`.
- Produces:
  - `type RecurrenceConfig = { enabled: boolean; maxBlockingRounds: number }`
  - `type RecurrenceResult = { blocking: AdversarialLLMFinding[]; advisory: AdversarialLLMFinding[]; demoted: AdversarialLLMFinding[] }`
  - `classifyRecurrence(accepted: AdversarialLLMFinding[], priorIterations: Iteration[], cfg: RecurrenceConfig, testFileMatch: (file: string) => boolean, threshold: "error" | "warning" | "info"): RecurrenceResult`

- [ ] **Step 1: Write the failing test**

Append to `test/unit/review/recurrence-demotion.test.ts`:

```typescript
import { classifyRecurrence } from "@/review/recurrence-demotion";
import type { AdversarialLLMFinding } from "@/review/adversarial-helpers";

const CFG = { enabled: true, maxBlockingRounds: 2 };
const noTest = (_f: string) => false;
const isTest = (_f: string) => true;

function adv(sev: string, over: Partial<AdversarialLLMFinding> = {}): AdversarialLLMFinding {
  return { severity: sev, category: "assumption", file: "lib/store.ts", line: 1, issue: "window expiry non-atomic", suggestion: "fix", ...over };
}
function priorAdv(sev: string, n: number): Iteration[] {
  return Array.from({ length: n }, (_v, i) => iter(i + 1, [{ file: "lib/store.ts", category: "assumption", message: "window expiry non-atomic", severity: sev }]));
}

describe("classifyRecurrence", () => {
  test("stable error: blocks at n=1 and n=2, demotes at n=3", () => {
    expect(classifyRecurrence([adv("error")], [], CFG, noTest, "error").blocking.length).toBe(1);       // n=1
    expect(classifyRecurrence([adv("error")], priorAdv("error", 1), CFG, noTest, "error").blocking.length).toBe(1); // n=2, prev=error
    const r3 = classifyRecurrence([adv("error")], priorAdv("error", 2), CFG, noTest, "error");           // n=3
    expect(r3.blocking.length).toBe(0);
    expect(r3.demoted.length).toBe(1);
  });

  test("oscillating w,e,w,e: never blocks (entry guard)", () => {
    // this round is error, n=2, prev sighting was warning
    const priors = [iter(1, [{ file: "lib/store.ts", category: "assumption", message: "window expiry non-atomic", severity: "warning" }])];
    const r = classifyRecurrence([adv("error")], priors, CFG, noTest, "error");
    expect(r.blocking.length).toBe(0);
    expect(r.advisory.length + r.demoted.length).toBe(1);
  });

  test("non-error accepted finding is advisory, never blocking", () => {
    const r = classifyRecurrence([adv("warning")], [], CFG, noTest, "error");
    expect(r.blocking.length).toBe(0);
    expect(r.advisory.length).toBe(1);
  });

  test("test-gap on a test-file path blocks regardless of recurrence", () => {
    const f = adv("error", { category: "test-gap", file: "test/store.spec.ts" });
    const r = classifyRecurrence([f], priorAdv("error", 5), CFG, isTest, "error");
    expect(r.blocking.length).toBe(1);
  });

  test("non-blocking (warning) test-gap on a test-file path does NOT block", () => {
    const f = adv("warning", { category: "test-gap", file: "test/store.spec.ts" });
    const r = classifyRecurrence([f], [], CFG, isTest, "error");
    expect(r.blocking.length).toBe(0);
    expect(r.advisory.length).toBe(1);
  });

  test("test-gap on a source path is reclassified → subject to recurrence demotion", () => {
    const f = adv("error", { category: "test-gap", file: "lib/store.ts" });
    // n=3 via priors under the SAME fingerprint (category test-gap)
    const priors = Array.from({ length: 2 }, (_v, i) => iter(i + 1, [{ file: "lib/store.ts", category: "test-gap", message: "window expiry non-atomic", severity: "error" }]));
    const r = classifyRecurrence([f], priors, CFG, noTest, "error");
    expect(r.blocking.length).toBe(0);
    expect(r.demoted.length).toBe(1);
  });

  test("enabled:false → legacy behavior (all error accepted findings block, no demotion)", () => {
    const r = classifyRecurrence([adv("error"), adv("warning")], priorAdv("error", 9), { enabled: false, maxBlockingRounds: 2 }, noTest, "error");
    expect(r.blocking.length).toBe(1);
    expect(r.advisory.length).toBe(1);
    expect(r.demoted.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 30 bun test test/unit/review/recurrence-demotion.test.ts --timeout=5000`
Expected: FAIL — `classifyRecurrence is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/review/recurrence-demotion.ts`:

```typescript
import type { AdversarialLLMFinding } from "./adversarial-helpers";
import { isBlockingSeverity } from "./adversarial-helpers";

export type RecurrenceConfig = { enabled: boolean; maxBlockingRounds: number };
export type RecurrenceResult = {
  blocking: AdversarialLLMFinding[];
  advisory: AdversarialLLMFinding[];
  demoted: AdversarialLLMFinding[];
};

/**
 * Partition accepted adversarial findings into block / advisory / demoted.
 *
 * - test-gap (file matches a test-file pattern) → block (carve-out preserved).
 * - non-error severity → advisory.
 * - error, count n ≥ maxBlockingRounds+1 → demoted (recurrence coverage-gap).
 * - error, (n==1 OR prev sighting was error) → block (entry guard).
 * - error, else (n==2, prev not error) → advisory (oscillation suppressed).
 *
 * `demoted` is a subset reported separately for coverage-gap logging; callers
 * surface it through advisoryFindings.
 */
export function classifyRecurrence(
  accepted: AdversarialLLMFinding[],
  priorIterations: Iteration[],
  cfg: RecurrenceConfig,
  testFileMatch: (file: string) => boolean,
  threshold: "error" | "warning" | "info",
): RecurrenceResult {
  const blocking: AdversarialLLMFinding[] = [];
  const advisory: AdversarialLLMFinding[] = [];
  const demoted: AdversarialLLMFinding[] = [];

  if (!cfg.enabled) {
    for (const f of accepted) (isBlockingSeverity(f.severity, threshold) ? blocking : advisory).push(f);
    return { blocking, advisory, demoted };
  }

  const priorCounts = countPriorAppearances(priorIterations);

  for (const f of accepted) {
    // test-gap carve-out applies only to blocking severities (mirrors the
    // upstream BLOCKING_SEVERITIES gate in ac-quote-validator.ts) — a warning/
    // info test-gap must never block.
    if (f.category === "test-gap" && testFileMatch(f.file) && isBlockingSeverity(f.severity, threshold)) {
      blocking.push(f);
      continue;
    }
    if (!isBlockingSeverity(f.severity, threshold)) {
      advisory.push(f);
      continue;
    }
    const prior = priorCounts.get(fingerprintFor(f.file, f.category, f.issue));
    const n = (prior?.count ?? 0) + 1;
    const prevWasBlocking = prior !== undefined && isBlockingSeverity(prior.lastSeverity, threshold);

    if (n >= cfg.maxBlockingRounds + 1) {
      demoted.push(f);
    } else if (n === 1 || prevWasBlocking) {
      blocking.push(f);
    } else {
      advisory.push(f);
    }
  }
  return { blocking, advisory, demoted };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `timeout 30 bun test test/unit/review/recurrence-demotion.test.ts --timeout=5000`
Expected: PASS (all Task 1 + Task 2 assertions).

- [ ] **Step 5: Commit**

```bash
git add src/review/recurrence-demotion.ts test/unit/review/recurrence-demotion.test.ts
git commit -m "feat(review): classifyRecurrence — recurrence + entry-guard demotion"
```

---

## Task 3: Config field `recurrenceDemotion`

**Files:**
- Modify: `src/config/schemas-review.ts` (add to `AdversarialReviewConfigSchema`, after `acRegroundOnDrop` at :97)
- Modify: `src/review/types.ts` (add to `AdversarialReviewConfig`, after `acRegroundOnDrop?` at :214)
- Test: `test/unit/config/schemas-review.test.ts` (or the nearest existing review-schema test; if none, `test/unit/config/defaults.test.ts`)

**Interfaces:**
- Produces: `config.review.adversarial.recurrenceDemotion: { enabled: boolean; maxBlockingRounds: number }` with defaults `{ enabled: true, maxBlockingRounds: 2 }`.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/config/schemas-review.test.ts` (create if absent, mirroring existing config test imports):

```typescript
import { describe, expect, test } from "bun:test";
import { AdversarialReviewConfigSchema } from "@/config/schemas-review";

describe("AdversarialReviewConfigSchema.recurrenceDemotion", () => {
  test("defaults to enabled with maxBlockingRounds 2", () => {
    const parsed = AdversarialReviewConfigSchema.parse({});
    expect(parsed.recurrenceDemotion).toEqual({ enabled: true, maxBlockingRounds: 2 });
  });
  test("accepts overrides", () => {
    const parsed = AdversarialReviewConfigSchema.parse({ recurrenceDemotion: { enabled: false, maxBlockingRounds: 3 } });
    expect(parsed.recurrenceDemotion).toEqual({ enabled: false, maxBlockingRounds: 3 });
  });
});
```

Note: if `AdversarialReviewConfigSchema` is not exported, add `export` to it at `src/config/schemas-review.ts:58` (it already is per the grep) — confirm before writing.

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 30 bun test test/unit/config/schemas-review.test.ts --timeout=5000`
Expected: FAIL — `recurrenceDemotion` is `undefined`.

- [ ] **Step 3: Write minimal implementation**

In `src/config/schemas-review.ts`, immediately after the `acRegroundOnDrop: z.boolean().default(true),` line (:97) inside `AdversarialReviewConfigSchema`, add:

```typescript
  /**
   * Phase 0 recurrence-demotion (docs/superpowers/specs/2026-07-17-adversarial-recurrence-demotion-design.md).
   * A non-test-gap error finding blocks for at most `maxBlockingRounds` rounds; once its
   * fingerprint recurs beyond that it auto-demotes to advisory (coverage-gap). An entry
   * guard suppresses severity flip-flops. `enabled: false` restores legacy severity-only blocking.
   */
  recurrenceDemotion: z
    .object({
      enabled: z.boolean().default(true),
      maxBlockingRounds: z.number().int().min(1).default(2),
    })
    .default({ enabled: true, maxBlockingRounds: 2 }),
```

In `src/review/types.ts`, after `acRegroundOnDrop?: boolean;` (:214) inside `AdversarialReviewConfig`, add:

```typescript
  /**
   * Phase 0 recurrence-demotion. Non-test-gap error findings demote to advisory
   * after recurring beyond `maxBlockingRounds` rounds; entry guard suppresses
   * flip-flops. Default `{ enabled: true, maxBlockingRounds: 2 }`.
   */
  recurrenceDemotion?: { enabled: boolean; maxBlockingRounds: number };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `timeout 30 bun test test/unit/config/schemas-review.test.ts --timeout=5000`
Expected: PASS.
Then typecheck the touched files: `timeout 60 bun run typecheck` — Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/config/schemas-review.ts src/review/types.ts test/unit/config/schemas-review.test.ts
git commit -m "feat(config): recurrenceDemotion adversarial config (default on, maxBlockingRounds 2)"
```

---

## Task 4: Wire classifier into op `verify()`

**Files:**
- Modify: `src/operations/adversarial-review.ts` (add `resolvedTestPatterns?` to `AdversarialReviewInput`; rewrite the block/advisory split in `verify()` at :490-503)
- Modify: `src/execution/story-orchestrator/run-phase.ts` (surface `resolvedTestPatterns` on the refreshed adversarial input so it reaches `verify()`)
- Test: `test/unit/operations/adversarial-review-verify.test.ts`

**Wiring note (Finding A):** at `verify()` time `input._refresh` has already been stripped by the refresh step, and neither construction site currently carries `resolvedTestPatterns` forward. The op reads `input.resolvedTestPatterns` (top-level), which this task populates in the orchestrator path; the wrapper path is handled in Task 5. Where the field is absent, `testFileMatch` returns `false` and `test-gap` findings degrade to the recurrence path (block ≤ maxBlockingRounds, then demote) rather than the unlimited carve-out — safe, documented degradation.

**Interfaces:**
- Consumes: `classifyRecurrence`, `RecurrenceConfig` (Task 2); `ResolvedTestPatterns` from `src/test-runners`.
- Produces: `verify()` returns the same `AdversarialReviewOutput` shape; `blocking` now excludes demoted findings; `advisoryFindings` includes them.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/operations/adversarial-review-verify.test.ts` (follow the file's existing `verify` invocation pattern for building `parsed`/`input`):

```typescript
test("recurrence: an error finding recurring beyond maxBlockingRounds demotes to advisory (passes)", async () => {
  const finding = { severity: "error", category: "assumption", file: "lib/store.ts", line: 1, issue: "window expiry non-atomic", suggestion: "x", acQuote: AC_TEXT, acIndex: 1, verifiedBy: { file: "lib/store.ts", observed: OBSERVED } };
  const priors = Array.from({ length: 2 }, (_v, i) => ({
    iterationNum: i + 1, findingsBefore: [], fixesApplied: [], outcome: "fixes-applied",
    startedAt: "2026-07-17T00:00:00.000Z", finishedAt: "2026-07-17T00:00:01.000Z",
    findingsAfter: [{ source: "adversarial-review", severity: "error", category: "assumption", file: "lib/store.ts", message: "window expiry non-atomic" }],
  }));
  const input = makeVerifyInput({ findings: [finding], priorAdversarialIterations: priors as any, resolvedTestPatterns: { regex: [/\.spec\.ts$/] } as any });
  const out = await adversarialReviewOp.verify({ passed: false, findings: [finding], normalizedFindings: [], acDropped: [] } as any, input, {} as any);
  expect(out.passed).toBe(true);
  expect(out.normalizedFindings.length).toBe(0);
  expect((out.advisoryFindings ?? []).length).toBe(1);
});
```

(`makeVerifyInput`, `AC_TEXT`, `OBSERVED` follow the helpers already in this test file; if `makeVerifyInput` does not exist, construct `input` inline exactly as the file's other `verify` tests do, adding `priorAdversarialIterations` and `resolvedTestPatterns`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 30 bun test test/unit/operations/adversarial-review-verify.test.ts --timeout=5000`
Expected: FAIL — `out.passed` is `false` (current code still blocks).

- [ ] **Step 3: Write minimal implementation**

In `src/operations/adversarial-review.ts`:

(a) Add the import near the other `src/review` imports:

```typescript
import { classifyRecurrence } from "../review/recurrence-demotion";
import type { ResolvedTestPatterns } from "../test-runners";
```

(b) Add a top-level field to `AdversarialReviewInput` (near `priorAdversarialIterations` at :48-49):

```typescript
  /** Resolved test-file patterns (ADR-009) for the test-gap structural guard. */
  resolvedTestPatterns?: ResolvedTestPatterns;
```

(c) Replace the block/advisory computation in `verify()` (currently :492-503):

```typescript
    const { accepted, dropped } = filterByAcQuote(substantiated, input.story.acceptanceCriteria);

    const recurrenceCfg = input.adversarialConfig.recurrenceDemotion ?? { enabled: true, maxBlockingRounds: 2 };
    const patterns = input.resolvedTestPatterns?.regex ?? [];
    const testFileMatch = (file: string): boolean => patterns.some((re) => re.test(file));

    const { blocking, advisory, demoted } = classifyRecurrence(accepted, input.priorAdversarialIterations ?? [], recurrenceCfg, testFileMatch, threshold);

    for (const f of demoted) {
      getSafeLogger()?.info("review", "Adversarial finding demoted to advisory (recurrence coverage-gap)", {
        storyId: input.story.id,
        event: "review.adversarial.recurrence_demoted",
        file: f.file,
        category: f.category,
      });
    }

    const passed = parsed.passed && blocking.length === 0;

    return {
      ...parsed,
      passed,
      findings: accepted,
      normalizedFindings: toAdversarialReviewFindings(blocking),
      advisoryFindings: toAdversarialReviewFindings([...advisory, ...demoted]),
      acDropped: dropped,
    };
```

(d) Surface `resolvedTestPatterns` on the refreshed orchestrator input. In `src/execution/story-orchestrator/run-phase.ts`, the adversarial refresh (~:98-110) spreads `{ ...advInput, stat, diff, excludePatterns, storyGitRef }` but drops `_refresh` (and with it `resolvedTestPatterns`). Add the field to that return object:

```typescript
    return {
      ...advInput,
      stat: fresh.stat,
      diff: fresh.diff,
      excludePatterns: fresh.excludePatterns,
      storyGitRef: fresh.effectiveRef ?? advInput.storyGitRef,
      resolvedTestPatterns: _refresh.resolvedTestPatterns,
    };
```

(This is the only orchestrator-path site — `_refresh.resolvedTestPatterns` is populated upstream by the context stage. Confirm the exact surrounding keys against the file before editing; add only the `resolvedTestPatterns` line.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `timeout 60 bun test test/unit/operations/adversarial-review-verify.test.ts test/unit/operations/adversarial-review.test.ts --timeout=5000`
Expected: PASS. Fix any pre-existing assertion that assumed severity-only blocking by threading `recurrenceDemotion: { enabled: false, maxBlockingRounds: 2 }` into that test's `adversarialConfig` (legacy behavior) OR by giving the finding a first-sighting (`n==1`) context, whichever matches the test's intent.

- [ ] **Step 5: Commit**

```bash
git add src/operations/adversarial-review.ts src/execution/story-orchestrator/run-phase.ts test/unit/operations/adversarial-review-verify.test.ts
git commit -m "feat(review): apply recurrence demotion in adversarial verify() + thread test patterns"
```

---

## Task 5: Wire classifier into the wrapper (parity)

**Files:**
- Modify: `src/review/adversarial.ts` (the block/advisory split at :360-363)
- Test: `test/unit/review/adversarial-pass-fail.test.ts`, `test/unit/review/orchestrator-wrapper-parity.test.ts`

**Interfaces:**
- Consumes: `classifyRecurrence` (Task 2); `opts.priorAdversarialIterations`, `opts.adversarialConfig.recurrenceDemotion`, resolved test patterns available to the wrapper.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/review/adversarial-pass-fail.test.ts` a case mirroring Task 4's recurrence scenario but through `runAdversarialReview(opts)`, asserting the returned `ReviewCheckResult.success === true` and the finding surfaces as advisory (follow the file's existing `runAdversarialReview` harness — it stubs the op via `callOp`/runtime; script the op to return the recurring finding and pass `priorAdversarialIterations`).

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 30 bun test test/unit/review/adversarial-pass-fail.test.ts --timeout=5000`
Expected: FAIL — wrapper still reports `success: false`.

- [ ] **Step 3: Write minimal implementation**

In `src/review/adversarial.ts`, replace the re-filter at :360-363:

```typescript
  const threshold = blockingThreshold ?? "error";
  const allFindings = opResult.findings as AdversarialLLMFinding[];
  const patterns = opts.resolvedTestPatterns?.regex ?? [];
  const testFileMatch = (file: string): boolean => patterns.some((re) => re.test(file));
  const recurrenceCfg = adversarialConfig.recurrenceDemotion ?? { enabled: true, maxBlockingRounds: 2 };
  const { blocking: blockingFindings, advisory: advisoryOnly, demoted } = classifyRecurrence(
    allFindings, opts.priorAdversarialIterations ?? [], recurrenceCfg, testFileMatch, threshold,
  );
  const advisoryFindings = [...advisoryOnly, ...demoted];
```

Add the import at the top: `import { classifyRecurrence } from "./recurrence-demotion";`. Add `resolvedTestPatterns?: import("../test-runners").ResolvedTestPatterns;` to `RunAdversarialReviewOptions` and pass it into the `callOp(... adversarialReviewOp, { ... })` input at `adversarial.ts:249` (add `resolvedTestPatterns: opts.resolvedTestPatterns,`).

**Caller (Finding A, wrapper path):** the sole caller is `src/review/runner.ts:405`, which holds only a `ReviewConfig` (not the `NaxConfig` that `resolveTestFilePatterns` requires), so it cannot resolve patterns itself. Two acceptable options — pick per what the runner already receives:
- If the review runner's entry already receives a resolved `ResolvedTestPatterns` from the pipeline context, thread it through to `runAdversarialReview({ ..., resolvedTestPatterns })`.
- Otherwise pass nothing: `resolvedTestPatterns` stays `undefined`, `testFileMatch` returns `false`, and `test-gap` findings degrade to the recurrence path (block ≤ maxBlockingRounds then demote) instead of the unlimited carve-out. This is safe and is the documented Phase-0 degradation — the wrapper/review-runner path is not the live story path that produced US-004 (that path is the orchestrator, fixed in Task 4).

Do NOT block this task on deep pattern-threading into the runner; the orchestrator path (Task 4) is the correctness-critical one.

- [ ] **Step 4: Run tests to verify they pass**

Run: `timeout 60 bun test test/unit/review/adversarial-pass-fail.test.ts test/unit/review/orchestrator-wrapper-parity.test.ts --timeout=5000`
Expected: PASS — both paths now demote identically; parity holds.

- [ ] **Step 5: Commit**

```bash
git add src/review/adversarial.ts test/unit/review/adversarial-pass-fail.test.ts
git commit -m "feat(review): apply recurrence demotion in runAdversarialReview wrapper (parity)"
```

---

## Task 6: Review-audit fidelity — version, commit, resolved threshold

**Files:**
- Modify: `src/review/review-audit.ts` (`ReviewAuditEntry` at :21; `toPersistedEntry` at :139-166)
- Test: `test/unit/review/review-audit.test.ts` (or the file asserting persisted shape; create `test/unit/review/review-audit-shape.test.ts` if none)

**Interfaces:**
- Consumes: `NAX_VERSION`, `NAX_COMMIT` from `src/version`.
- Produces: persisted review-audit JSON gains `naxVersion: string`, `naxCommit: string`, and `blockingThreshold` is always one of `"error"|"warning"|"info"` (never null).

- [ ] **Step 1: Write the failing test**

Create/append `test/unit/review/review-audit.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { NAX_VERSION, NAX_COMMIT } from "@/version";
// toPersistedEntry is module-private; assert via the exported persist path or
// temporarily export it. Prefer exporting toPersistedEntry for testability.
import { toPersistedEntry } from "@/review/review-audit";

describe("toPersistedEntry", () => {
  const base = { reviewer: "adversarial" as const, sessionName: "s", parsed: true, result: { passed: false, findings: [] } };

  test("stamps naxVersion and naxCommit", () => {
    const json = JSON.parse(toPersistedEntry(base as any, 1_700_000_000_000));
    expect(json.naxVersion).toBe(NAX_VERSION);
    expect(json.naxCommit).toBe(NAX_COMMIT);
  });

  test("resolves blockingThreshold to 'error' when unset (never null)", () => {
    const json = JSON.parse(toPersistedEntry(base as any, 1_700_000_000_000));
    expect(json.blockingThreshold).toBe("error");
  });

  test("preserves an explicit blockingThreshold", () => {
    const json = JSON.parse(toPersistedEntry({ ...base, blockingThreshold: "warning" } as any, 1_700_000_000_000));
    expect(json.blockingThreshold).toBe("warning");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 30 bun test test/unit/review/review-audit.test.ts --timeout=5000`
Expected: FAIL — `toPersistedEntry` not exported / `naxVersion` undefined / `blockingThreshold` is `null`.

- [ ] **Step 3: Write minimal implementation**

In `src/review/review-audit.ts`:

(a) Add the import at the top:

```typescript
import { NAX_VERSION, NAX_COMMIT } from "../version";
```

(b) Export `toPersistedEntry` (change `function toPersistedEntry` at :139 to `export function toPersistedEntry`).

(c) Add fields to `ReviewAuditEntry` (near the other optional fields, ~:36):

```typescript
  /** nax version + short commit that produced this record (audit provenance). */
  naxVersion?: string;
  naxCommit?: string;
```

(d) In `toPersistedEntry`, change the `blockingThreshold` line (:135 within the object) and add the two version fields:

```typescript
      naxVersion: entry.naxVersion ?? NAX_VERSION,
      naxCommit: entry.naxCommit ?? NAX_COMMIT,
      blockingThreshold: entry.blockingThreshold ?? "error",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `timeout 30 bun test test/unit/review/review-audit.test.ts --timeout=5000`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/review/review-audit.ts test/unit/review/review-audit.test.ts
git commit -m "feat(review): stamp naxVersion/naxCommit and resolve blockingThreshold in review audit"
```

---

## Task 7: Orchestrator e2e

**Files:**
- Create: `test/e2e/adversarial-recurrence-demotion.e2e.test.ts`

**Interfaces:**
- Consumes: `runOrchestratorE2E`, `E2EResult` from `@test/helpers`; the `ScriptedAgentSpec` role map keyed by `"reviewer-adversarial"` (pattern established in `test/e2e/non-blocking-fix.e2e.test.ts`).

- [ ] **Step 1: Write the e2e test**

Create `test/e2e/adversarial-recurrence-demotion.e2e.test.ts`, following the imports and scripted-agent structure of `test/e2e/non-blocking-fix.e2e.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { runOrchestratorE2E } from "@test/helpers";
import type { NaxConfig } from "@/config";

// A blocking adversarial finding the reviewer emits every round with the SAME
// fingerprint (file + category + issue). With recurrenceDemotion default-on it
// blocks rounds 1-2 then demotes at round 3, so the story converges.
const RECURRING_BLOCK = JSON.stringify({
  passed: false,
  inspectedFiles: ["lib/store.ts"],
  findings: [{ severity: "error", category: "assumption", file: "lib/store.ts", line: 10, issue: "window expiry is non-atomic", suggestion: "make it atomic", acQuote: "<verbatim AC substring>", acIndex: 1, verifiedBy: { file: "lib/store.ts", line: 10, observed: "<verbatim code line present in the scripted workdir>" } }],
});

describe("E2E: adversarial recurrence demotion (Phase 0)", () => {
  test("a non-test-gap finding recurring past maxBlockingRounds demotes and the story converges", async () => {
    const result: Awaited<ReturnType<typeof runOrchestratorE2E>> = await runOrchestratorE2E({
      strategy: "three-session-tdd",
      agent: {
        // Script the adversarial reviewer to return the SAME blocking finding on
        // every call; implementer/test-writer make no relevant change so the
        // finding recurs. Follow the sibling file's ScriptedAgentSpec shape.
        "reviewer-adversarial": [RECURRING_BLOCK, RECURRING_BLOCK, RECURRING_BLOCK, RECURRING_BLOCK],
        // ...other roles scripted green as in non-blocking-fix.e2e.test.ts
      } as any,
      config: { review: { checks: ["adversarial"], adversarial: { recurrenceDemotion: { enabled: true, maxBlockingRounds: 2 } } } } as Partial<NaxConfig>,
    });
    expect(result.result.success).toBe(true);
  });

  test("with recurrenceDemotion disabled the same finding blocks indefinitely (rectification exhausts)", async () => {
    const result = await runOrchestratorE2E({
      strategy: "three-session-tdd",
      agent: { "reviewer-adversarial": [RECURRING_BLOCK, RECURRING_BLOCK, RECURRING_BLOCK, RECURRING_BLOCK] } as any,
      config: { review: { checks: ["adversarial"], adversarial: { recurrenceDemotion: { enabled: false, maxBlockingRounds: 2 } } } } as Partial<NaxConfig>,
      rectification: { maxAttempts: 2 },
    });
    expect(result.result.success).toBe(false);
    expect(result.result.rectificationExhausted).toBe(true);
  });
});
```

Note: match the exact `ScriptedAgentSpec` shape and the green scripts for the other roles from `test/e2e/non-blocking-fix.e2e.test.ts` (lines ~40-160) — the `acQuote`/`observed` values MUST be a verbatim AC substring and a verbatim line in the scripted workdir so the finding survives `filterByAcQuote` + substantiation. If the harness cannot vary responses per successive call to the same role, extend the scripted-agent spec's per-role response to accept a sequential array (see `test/e2e/scripted-agent.e2e.test.ts` for the sequencing pattern) as part of this task.

- [ ] **Step 2: Run the e2e**

Run: `timeout 120 bun test test/e2e/adversarial-recurrence-demotion.e2e.test.ts --timeout=60000`
Expected: both tests PASS.

- [ ] **Step 3: Commit**

```bash
git add test/e2e/adversarial-recurrence-demotion.e2e.test.ts
git commit -m "test(e2e): adversarial recurrence demotion convergence + disabled-flag exhaustion"
```

---

## Task 8: Full-suite gate + audit-shape sweep

**Files:** none new — this task runs the suite and fixes fallout.

- [ ] **Step 1: Run the adversarial + review unit suite**

Run: `timeout 120 bun test test/unit/review/ test/unit/operations/ --timeout=5000`
Expected: PASS. Any failure is a pre-existing test that assumed severity-only blocking or the old audit shape (`blockingThreshold: null`). Fix each by:
- audit-shape tests: expect resolved `blockingThreshold` and the new `naxVersion`/`naxCommit` keys.
- adversarial-decision tests: where the intent is legacy severity-only blocking, set `adversarialConfig.recurrenceDemotion.enabled = false`; where the intent is a genuine first-round block, ensure no matching `priorAdversarialIterations` are present (so `n == 1`).

- [ ] **Step 2: Typecheck + lint**

Run: `timeout 120 bun run typecheck && timeout 120 bun run lint`
Expected: clean.

- [ ] **Step 3: Full suite**

Run: `bun run test`
Expected: green.

- [ ] **Step 4: Commit any test fixups**

```bash
git add -A
git commit -m "test(review): align adversarial + audit-shape tests with recurrence demotion"
```

---

## Self-Review (completed during authoring)

- **Spec coverage:** §3 core rule → Tasks 2,4,5. §4 fingerprint → Task 1. §5 test-gap guard → Task 2 (`testFileMatch`, blocking-severity-gated) + Task 4 orchestrator pattern threading (`run-phase.ts`) + Task 5 wrapper threading. §6 config → Task 3. §7 shared helper + parity → Tasks 2,4,5. §8 audit fidelity → Task 6. §11 testing → Tasks 1-8. §3 worked cases → Task 2 tests. No spec section left without a task.
- **Review fixes applied (2026-07-17):** Finding A — `resolvedTestPatterns` is now explicitly threaded to `verify()` via `run-phase.ts` (orchestrator) and `RunAdversarialReviewOptions` (wrapper); the dead `_refresh` fallback removed; graceful degradation documented. Finding B — the `test-gap` guard now also requires blocking severity, with a regression test. Finding C — the load-bearing `?? { enabled: true, maxBlockingRounds: 2 }` consumer fallback is retained by design (`review.adversarial` is `.optional()`).
- **Placeholder scan:** every code step carries real code; the only `<...>` are e2e fixture values (verbatim AC substring / observed code line) that are workdir-specific by nature and flagged as such.
- **Type consistency:** `classifyRecurrence`, `RecurrenceConfig`, `RecurrenceResult`, `fingerprintFor`, `countPriorAppearances`, `PriorAppearance` are named identically across Tasks 1,2,4,5. `AdversarialReviewInput.resolvedTestPatterns` added in Task 4 and consumed by the same op; wrapper `resolvedTestPatterns` added in Task 5. `recurrenceDemotion` shape identical in schema (Task 3), types (Task 3), and both consumers (Tasks 4,5).
