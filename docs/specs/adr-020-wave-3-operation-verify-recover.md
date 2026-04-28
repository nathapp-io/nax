# ADR-020 Wave 3 — Side-Effect-Aware `Operation` Contract (`verify` + `recover`)

> **Spec status:** Ready for implementation
> **Owning ADR:** [docs/adr/ADR-020-dispatch-boundary-ssot.md](../adr/ADR-020-dispatch-boundary-ssot.md) §D4
> **Closes:** Class behind PR #774 (acceptance-setup ACP recovery); latent equivalents in TDD ops
> **Estimated:** ~200 LOC source, ~150 LOC tests, single PR

---

## Goal

After this wave lands:

1. `Operation<I, O, C>` gains optional `verify` and `recover` hooks. Default behaviour unchanged for ops that don't declare them.
2. `callOp` runs `parse` → `verify` → `recover` automatically. Side-effect ops (ACP-mode agents that write files + reply conversationally) declare disk-recovery once in the op definition, not at every caller.
3. `acceptanceGenerateOp` declares `verify` + `recover`; `src/pipeline/stages/acceptance-setup.ts:350-441` Tier-1/2/3 disk-read ladder is deleted.
4. TDD `writeTddTestOp` and `implementTddOp` declare `verify`/`recover` for the same reason — agent writes test/source files, returns conversational summary.
5. `VerifyContext<C>` has read-only filesystem access, no agent calls, no writes — can't accidentally trigger recursive dispatch.

## Prerequisites

- ADR-020 Waves 1 + 2 merged (this wave is independent from a code perspective but reviewers benefit from the consistent ADR-020 mental model).

## Step-by-step implementation

### Step 1 — Extend `Operation` contract

**File: `src/operations/types.ts`** lines 9-58.

> **Verified types** (from reading the file):
> - `OperationBase<I, O, C>` is **not exported** (line 40, no `export` keyword). It's an internal interface that `RunOperation` (line 81) and `CompleteOperation` (line 109) extend. `Operation<I, O, C>` (line 120) is the union — also exported.
> - `BuildContext<C>` (line 9) has only `packageView: PackageView` and `config: C`. **Narrow** — exactly the right scope for `VerifyContext`.
> - `parse` returns `O` (non-null); ops that may not produce output use `O = SomeType | null` (e.g. `acceptanceGenerateOp`'s `AcceptanceGenerateOutput = { testCode: string | null }`).
> - All edits to `OperationBase` are made on the un-exported declaration. Both `RunOperation` and `CompleteOperation` inherit `verify` and `recover` automatically.

Extend `OperationBase` and add `VerifyContext`:

```typescript
// src/operations/types.ts — additions

/**
 * Read-only context for verify/recover. Mirrors BuildContext<C>'s narrow
 * surface plus filesystem reads. No agent calls, no writes, no runtime
 * mutation — both hooks operate on disk artifacts the agent may have
 * produced as side effects.
 *
 * @see docs/adr/ADR-020-dispatch-boundary-ssot.md §D4
 */
export interface VerifyContext<C> extends BuildContext<C> {
  readonly readFile: (path: string) => Promise<string | null>;
  readonly fileExists: (path: string) => Promise<boolean>;
  // Future read-only helpers go here. Banned: writes, agent calls.
}

// Modify the existing un-exported OperationBase declaration (line 40):
interface OperationBase<I, O, C> {
  readonly name: string;
  readonly stage: PipelineStage;
  readonly config: ConfigSelector<C> | readonly (keyof NaxConfig)[];
  readonly build: (input: I, ctx: BuildContext<C>) => ComposeInput;
  readonly parse: (output: string, input: I, ctx: BuildContext<C>) => O;

  /**
   * Optional. Validate parsed output against on-disk artifacts. Returning
   * non-null wins; returning null means "parsed output insufficient — fall
   * through to recover (if defined) or surface as if parse returned null".
   *
   * The "parsed output insufficient" signal is op-defined. For ops where
   * O is `T | null`, returning null commonly means "parse gave us null and
   * we couldn't recover from disk either."
   *
   * Use when the agent's contract is "stdout has the answer, but disk has
   * the canonical artifact" (e.g. ACP test-writer: stdout is conversational,
   * disk has the test file).
   */
  readonly verify?: (parsed: O, input: I, ctx: VerifyContext<C>) => Promise<O | null>;

  /**
   * Optional. Recover output from on-disk artifacts when parse + verify
   * both produced "no useful result." Last resort before the caller sees
   * the null/empty value.
   *
   * Use when the agent may have completed its work entirely as a
   * filesystem side-effect and stdout is unparseable.
   */
  readonly recover?: (input: I, ctx: VerifyContext<C>) => Promise<O | null>;
}
```

`VerifyContext<C>` is exported from the operations barrel (`src/operations/index.ts`).

### Step 2 — Update `callOp` to run the post-parse pipeline

**File: `src/operations/call.ts`** lines 60-72 (complete-kind path) and 140-148 (run-kind path).

Today, both paths end with `return op.parse(...)` — synchronous. Wave 3 makes both async-aware: run `verify`, then `recover`, return the final result. **`parse` stays sync** (preserves existing contract); only the new hooks are async.

The current type signature `Operation<I, O, C> → Promise<O>` already returns a Promise, so adding async hooks is non-breaking for callers.

Build a single shared post-parse helper:

```typescript
// src/operations/call.ts — add helper at the bottom of the file

async function runPostParse<I, O, C>(
  op: Operation<I, O, C>,
  parsed: O,
  input: I,
  buildCtx: BuildContext<C>,
): Promise<O> {
  if (!op.verify && !op.recover) return parsed;

  const verifyCtx: VerifyContext<C> = {
    packageView: buildCtx.packageView,
    config: buildCtx.config,
    readFile: async (p) => {
      try { return await Bun.file(p).text(); }
      catch { return null; }   // ENOENT or any read failure → null (caller decides)
    },
    fileExists: async (p) => Bun.file(p).exists(),
  };

  let final: O | null = parsed;

  if (op.verify) {
    final = await op.verify(parsed, input, verifyCtx);
  }

  if (final === null && op.recover) {
    final = await op.recover(input, verifyCtx);
  }

  // Returning null when both hooks return null is the op's contract — callers
  // that defined O as `T | null` handle it. Ops that defined O as non-null
  // must not return null from verify/recover (compile error caught by the
  // generic `O | null` signature on the hooks).
  return (final ?? parsed) as O;
}
```

**Replace the two terminal `return op.parse(...)` lines:**

Line 71 (complete-kind):
```typescript
// Before:
return op.parse(raw.output, input, buildCtx);
// After:
const parsed = op.parse(raw.output, input, buildCtx);
return runPostParse(op, parsed, input, buildCtx);
```

Line 148 (run-kind):
```typescript
// Before:
return op.parse(rawOutput, input, buildCtx);
// After:
const parsed = op.parse(rawOutput, input, buildCtx);
return runPostParse(op, parsed, input, buildCtx);
```

**Behaviour for ops without `verify`/`recover`:** `runPostParse` short-circuits at the top — zero overhead. Existing ops are unaffected.

**Behaviour when verify returns null and recover is absent:** `final ?? parsed` returns the original parsed value (which may itself be a `T | null` sentinel). This preserves "parse said null, no recovery available" semantics for callers that already handle nullable parse output (e.g. `acceptanceGenerateOp`).

### Step 3 — `acceptanceGenerateOp.verify` + `recover`

**File: `src/operations/acceptance-generate.ts`** (verified to exist; current parse at line 45-47).

Verified existing shape:
- Input has `targetTestFilePath: string` (line 10) — that's the disk path verify reads
- Output is `AcceptanceGenerateOutput = { testCode: string | null }` (line 16) — null is the existing failure signal
- `extractTestCode` already imported from `../acceptance/generator` (line 1)

Add `verify` and `recover` to the op declaration:

```typescript
import { extractTestCode } from "../acceptance/generator";
import {
  hasLikelyTestContent,
  isStubTestContent,
} from "../acceptance/heuristics";   // NEW — see migration below

export const acceptanceGenerateOp: CompleteOperation<
  AcceptanceGenerateInput,
  AcceptanceGenerateOutput,
  AcceptanceConfig
> = {
  // ... existing fields (kind, name, stage, jsonMode, config, build, parse) ...

  parse(output, _input, _ctx) {
    return { testCode: extractTestCode(output) };
  },

  async verify(parsed, input, ctx) {
    // Stdout had real test code → accept.
    if (parsed.testCode !== null) return parsed;

    // Otherwise check the agent's side-effect: did it write the file?
    const diskContent = await ctx.readFile(input.targetTestFilePath);
    if (diskContent === null) return null;   // no file — let recover try (it won't, but be explicit)

    // Tier 1: disk content has a fenced/code marker → extract it
    const extracted = extractTestCode(diskContent);
    if (extracted) return { testCode: extracted };

    // Tier 2: disk content looks like a real test file but no fence
    if (hasLikelyTestContent(diskContent) && !isStubTestContent(diskContent)) {
      return { testCode: diskContent };
    }

    return null;   // verify exhausted; will return parsed (= { testCode: null })
  },

  // No `recover` for this op — Tier 3 (skeleton fallback) is a stage policy
  // decision (stage knows whether to skeleton-overwrite vs leave the file
  // alone), not an op concern. recover is omitted intentionally.
};
```

**New file: `src/acceptance/heuristics.ts`** (~40 LOC)

Migrate the helpers from `src/pipeline/stages/acceptance-setup.ts:350-441` (where they were defined locally as `hasLikelyTestContent` and `isStubTestContent`):

```typescript
/**
 * Heuristics for detecting whether on-disk content is plausible test code.
 * Migrated from acceptance-setup stage (post-#774 ladder) into a shared
 * module so the acceptance-generate op (verify hook) and any future
 * consumer share one definition.
 */

const TEST_MARKERS = /\b(describe|test|it|func Test|def test_|@Test)\b/;
const STUB_MARKERS = /^[\s\S]*\b(skeleton|TODO|FIXME)\b[\s\S]*$/;   // copy from existing impl

export function hasLikelyTestContent(content: string): boolean {
  return TEST_MARKERS.test(content);
}

export function isStubTestContent(content: string): boolean {
  // Copy regex/heuristic from existing isStubTestFile in src/acceptance/acceptance-helpers.ts
  // — both must align (PR #774 noted this dependency).
  return STUB_MARKERS.test(content);
}
```

The existing `isStubTestFile` in `src/acceptance/acceptance-helpers.ts` and the new `isStubTestContent` here must use the same regex. Either: (a) export from one location, import in the other — preferred; (b) align the regex literals and add a comment cross-referencing both.

**Decision: option (a).** Move `isStubTestContent` to `src/acceptance/heuristics.ts`; have `acceptance-helpers.ts` import from there.

### Step 4 — Delete the Tier-1/2/3 ladder from `acceptance-setup.ts`

**File: `src/pipeline/stages/acceptance-setup.ts:350-441`**.

Replace the current ladder:

```typescript
let testCode = genResult.testCode;
if (!testCode) {
  // Tier 1: re-parse on-disk file
  const existing = await readFile(testPath);
  const extracted = extractTestCode(existing);
  if (extracted) testCode = extracted;
  // Tier 2: heuristic match
  else if (hasLikelyTestContent(existing)) testCode = existing;
  // Tier 3: skeleton fallback
  else if (existing.length > 0) { /* backup + warn */ }
}
if (testCode) await writeFile(testPath, testCode);
```

With:

```typescript
const testCode = genResult.testCode;  // verify+recover already ran inside callOp

if (testCode) {
  await writeFile(testPath, testCode);
} else {
  // Stage decision: skeleton fallback. Op exhausted; this is policy.
  await writeFile(testPath, generateSkeleton(...));
  logger.warn("acceptance", "agent did not produce test content; using skeleton",
    { storyId: ctx.story.id, testPath });
}
```

The stage now contains only the **stage decision** (use skeleton if op fully exhausted), not the recovery ladder. Recovery moved into the op where it belongs.

### Step 5 — TDD ops: **NOT applicable as Operations**

> **Verified shape after reading code:** TDD "ops" in `src/operations/{write-test,implement,verify}.ts` are 1-line re-exports. The actual definitions in `src/tdd/session-op.ts` are minimal role tags:
>
> ```typescript
> export type TddRunOp = { role: TddSessionRole };
> export const writeTddTestOp: TddRunOp = { role: "test-writer" };
> export const implementTddOp: TddRunOp = { role: "implementer" };
> export const verifyTddOp:    TddRunOp = { role: "verifier" };
> ```
>
> **They are not `Operation<I, O, C>` shapes** — no `build`, no `parse`, no `kind`. They're consumed by `runTddSession(role, agent, story, ...)` (a custom orchestrator that pre-dates the `callOp` migration), which builds prompts and parses results internally. `verify`/`recover` cannot be added at this layer.

**Decision: out of scope for Wave 3.** The TDD test-writer / implementer agents do write files as side-effects, but the recovery for that lives in `src/tdd/session-runner.ts` and `src/tdd/orchestrator.ts` — not in an Operation contract. Migrating TDD ops to true `Operation<I, O, C>` shapes is its own architectural change, not part of D4.

**What to do instead:** if a TDD agent's file-write is going wrong, fix it in the TDD orchestrator (where the actual prompt-build and result-parse live). When TDD eventually migrates to `callOp`-based ops (deferred per ADR-018 §5.3 amendment — TDD orchestrator stays a plain function for now), it picks up `verify`/`recover` for free at that point.

**Documented for future work:** add a TODO in `src/tdd/session-op.ts` referencing this decision so the next person reading the file understands why TDD ops don't have hooks.

```typescript
// src/tdd/session-op.ts — add at top
/**
 * TDD ops are minimal role tags consumed by runTddSession (src/tdd/session-runner.ts),
 * not full Operation<I, O, C> shapes. See ADR-020 Wave 3 §Step 5 — verify/recover
 * hooks live on Operation, so TDD's session-side recovery (when needed) belongs
 * in the orchestrator, not here. Migration to true callOp ops is deferred per
 * ADR-018 §5.3 amendment.
 */
```

### Step 6 — Inventory other Operation callers needing migration

Grep for stage-side disk-recovery ladders (the anti-pattern Wave 3 removes):

```bash
# Pattern: callOp result is null/empty, stage reads disk to recover
rg "callOp\(" src/pipeline/stages/ src/execution/lifecycle/ -A 20 \
  | grep -E "readFile|Bun.file|fileExists" \
  | head -30
```

Check each match: if the stage reads disk after `callOp` to recover from null/empty parse output, that op is a migration candidate. The corresponding op gets `verify`/`recover`; the stage-side ladder is removed (mirroring Steps 3+4 for acceptance).

**Known ops to inspect** (from `ls src/operations/`):

| Op file | Side-effect? | Action |
|:---|:---|:---|
| `src/operations/acceptance-generate.ts` | Yes — agent writes test file | Migrated in Step 3 |
| `src/operations/acceptance-fix.ts` | Likely — agent writes source/test files | Inspect; migrate if stage has Tier-recovery ladder |
| `src/operations/acceptance-diagnose.ts` | No — diagnosis is read-only | Skip |
| `src/operations/acceptance-refine.ts` | No — refinement output is in stdout | Skip |
| `src/operations/decompose.ts` | No — output is structured JSON in stdout | Skip |
| `src/operations/plan.ts` | No — output is structured JSON in stdout | Skip |
| `src/operations/classify-route.ts` | No — output is enum in stdout | Skip |
| `src/operations/rectify.ts` | Yes — agent applies code changes on disk | Inspect rectifier loop for disk-recovery; migrate if found |
| `src/operations/debate-{propose,rebut}.ts` | No — debate output is text | Skip |
| `src/operations/{semantic,adversarial}-review.ts` | No — review output is structured findings JSON | Skip |
| `src/operations/write-test.ts`, `implement.ts`, `verify.ts` | Re-exports of TDD role tags — see Step 5 | Skip — out of scope |

**Decision rule:** an op needs `verify`/`recover` iff (a) the agent writes files as side effects AND (b) those file writes are part of the op's deliverable. Read-only ops (diagnose, classify, debate-propose) don't need the hooks even if the agent reads files.

For each candidate identified by the grep: if the migration is a 1:1 lift like Step 3, include it in this PR. If it requires more thought (e.g. multi-file artifacts, complex recovery), defer to a follow-up PR — the optional hooks make incremental migration safe.

### Step 7 — Update forbidden-patterns rule

**File: `.claude/rules/forbidden-patterns.md`**.

Add row under "Source Code" table:

| ❌ Forbidden | ✅ Use Instead | Why |
|:---|:---|:---|
| Manual disk-recovery ladder in pipeline stages after `callOp` (Tier-1/2/3 patterns) | Declare `verify`/`recover` on the op | Recovery logic belongs with the op (one place to maintain), not duplicated in every stage that calls it. ADR-020 §D4. |

## Tests

### `test/unit/operations/verify-recover.test.ts` (new, ~120 LOC)

```typescript
test("op without verify or recover returns parse output unchanged", ...);

test("op.verify returning non-null wins", async () => {
  const op = {
    build: () => ({ ... }),
    parse: () => ({ testCode: null }),
    verify: async (parsed, input, ctx) => ({ testCode: "real test code" }),
  };
  const result = await callOp(ctx, op, input);
  expect(result.testCode).toBe("real test code");
});

test("op.verify returning null falls through to recover", async () => {
  const op = {
    parse: () => ({ testCode: null }),
    verify: async () => null,
    recover: async () => ({ testCode: "recovered from disk" }),
  };
  const result = await callOp(ctx, op, input);
  expect(result.testCode).toBe("recovered from disk");
});

test("both verify and recover null → caller sees null", ...);

test("VerifyContext.readFile returns null for missing file", ...);
test("VerifyContext.fileExists returns false for missing file", ...);
test("VerifyContext does NOT expose write or agent-call methods", ...); // type-level check
```

### `test/unit/pipeline/stages/acceptance-setup-agent-file.test.ts` (rewrite ~80 LOC)

The existing post-#774 tests assert the stage's Tier-1/2/3 ladder. Rewrite to assert the **op's** verify/recover behaviour:

- agent writes valid file to disk → `verify` returns it; stage just writes the result
- agent writes stub file → `verify` returns null; `recover` returns null; stage uses skeleton
- agent writes nothing → both null; stage uses skeleton
- agent returns code in stdout → `parse` extracts; `verify` accepts; stage writes

### `test/integration/acceptance/agent-file-recovery.test.ts` (new, ~50 LOC)

End-to-end: invoke acceptance-setup with a stub agent that writes a valid test file to disk and returns conversational stdout. Assert the agent-written file is preserved (not overwritten by skeleton). This is the regression test for #774 that survives the migration.

### `test/unit/operations/acceptance-generate.test.ts` (update)

Add cases for the new `verify` hook on `acceptanceGenerateOp` (no `recover` per Step 3 — recovery is stage policy):

- `verify` returns parsed unchanged when `parsed.testCode` is non-null
- `verify` reads disk and returns extracted code when stdout was empty but disk has fenced content
- `verify` returns disk content when fenced extraction fails but `hasLikelyTestContent` && `!isStubTestContent`
- `verify` returns null when disk content is missing or stub-shaped

Mock `VerifyContext.readFile`/`fileExists` via the `_acceptanceGenerateDeps` injection pattern (or per-test fakes if no DI seam exists yet — add one if not, ~5 LOC).

## Validation

1. **Tests pass:** `bun run test`
2. **#774 regression:** the integration test confirms agent-written test files are preserved
3. **No regressions in `acceptance-setup` stage:** existing dogfood runs produce the same on-disk results
4. **TDD ops:** if step 5 migrated TDD ops, run a `tdd-calc` dogfood and confirm test/source files agent writes are preserved across rectification cycles
5. **Grep:** `rg 'extractTestCode' src/pipeline/stages/` returns zero hits (the recovery helper moved into the op)

## Rollback

Single PR. Revert restores the stage-side ladder and removes the optional `verify`/`recover` fields. No behaviour change for ops that didn't declare the hooks (they're optional, additive).

## Risk + mitigation

| Risk | Mitigation |
|:---|:---|
| Op author forgets to declare `verify`/`recover` for a new side-effect op | Forbidden-patterns rule catches it in code review; failing dogfood runs catch it at runtime |
| `VerifyContext` over-narrowed; some legitimate verify needs another resource | Easy to extend — add a narrow read-only helper to the interface. Banned additions: writes, agent calls. |
| `verify`/`recover` accidentally do writes | Type system: `VerifyContext` deliberately doesn't expose write APIs. Reviewers spot direct `Bun.write`/`writeFile` imports in op files. |
| Migration of TDD ops introduces subtle behaviour change vs current rectification flow | Per-op migration; one PR per op if Wave 3 grows large; integration tests cover the rectification cycle |

## Out of scope

- ADR-020 Waves 1, 2 work — assumed merged
- A full "Effects" subsystem that tracks all side effects uniformly (filesystem, network, subprocess) — explicitly rejected per ADR-020 §A4 as out-of-scope speculation
- Agent re-prompting from `verify`/`recover` (e.g. "ask the agent to repair its output") — explicitly out per ADR-020 Open Question 3; rectification is a separate subsystem and lives in the rectifier, not the op contract

## Sequencing notes for the implementer

- Step 1 + 2 are pure additions (optional fields, optional hook execution). Land them first as a self-contained sub-PR if you want to keep the diff small.
- Steps 3 + 4 (acceptance migration) are atomic — must land together to avoid duplicate recovery (op-level + stage-level).
- Step 5 is an explicit no-op for TDD ops (they aren't full Operations); add the in-code TODO referencing this spec.
- Step 6 inventory may surface follow-up migrations (e.g. rectify if it has a stage ladder); land those as separate small PRs after Steps 1–4 are stable.
- Step 7 docs (forbidden-patterns row) lands with Step 4.
