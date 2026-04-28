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

**File: `src/operations/types.ts`**.

Today's `OperationBase`:

```typescript
interface OperationBase<I, O, C> {
  readonly build: (input: I, ctx: BuildContext<C>) => ComposeInput;
  readonly parse: (output: string, input: I, ctx: BuildContext<C>) => O;
}
```

Extend with optional hooks:

```typescript
import type { ResolvedTestPatterns } from "../test-runners/types"; // example existing read-only resource

/**
 * Read-only context for verify/recover. No agent calls, no writes — both
 * hooks operate on disk artifacts the agent may have produced as side effects.
 *
 * @see docs/adr/ADR-020-dispatch-boundary-ssot.md §D4
 */
export interface VerifyContext<C> extends BuildContext<C> {
  readFile(path: string): Promise<string | null>;
  fileExists(path: string): Promise<boolean>;
  // Add narrow read-only helpers as future ops need them.
  // Banned: anything that would write or trigger another agent dispatch.
}

interface OperationBase<I, O, C> {
  readonly build: (input: I, ctx: BuildContext<C>) => ComposeInput;
  readonly parse: (output: string, input: I, ctx: BuildContext<C>) => O;

  /**
   * Optional. Validate parsed output against on-disk artifacts. Returning
   * non-null wins; returning null means "parsed output insufficient — fall
   * through to recover (if defined) or surface null".
   *
   * Use when the agent's contract is "stdout has the answer, but disk has
   * the canonical artifact" (e.g. ACP test-writer: stdout is conversational,
   * disk has the test file).
   */
  readonly verify?: (parsed: O, input: I, ctx: VerifyContext<C>) => Promise<O | null>;

  /**
   * Optional. Recover output from on-disk artifacts when parse returned null
   * AND verify is absent or also returned null. Last resort before the caller
   * sees a null result.
   *
   * Use when the agent may have completed its work entirely as a filesystem
   * side-effect and stdout is unparseable.
   */
  readonly recover?: (input: I, ctx: VerifyContext<C>) => Promise<O | null>;
}
```

### Step 2 — Update `callOp` to run the post-parse pipeline

**File: `src/operations/call.ts`**.

Find the section after `parse(output, input, ctx)` returns. Today it returns the parsed result directly. Add:

```typescript
const parsed = op.parse(output, input, buildCtx);
const verifyCtx: VerifyContext<C> = {
  ...buildCtx,
  readFile: async (p) => {
    try { return await Bun.file(p).text(); }
    catch { return null; }
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

if (final === null) {
  // Caller sees null; existing call sites already handle this case
  // (they had to before, since parse could already return null for some ops).
  return null as O;  // or however the existing return type handles null
}

return final;
```

The exact signature depends on whether `parse` was nullable today. If `parse: (...) => O` (non-null), make `verify`/`recover` only fire when `parsed` is sentinel-empty (e.g. `{ testCode: null }`). The Wave 3 implementer should adapt to the existing parse-return convention for each op type.

### Step 3 — `acceptanceGenerateOp.verify` + `recover`

**File: `src/operations/acceptance-generate.ts`** (or wherever the op lives — verify path).

Today's parse:

```typescript
parse(output, _input, _ctx) {
  return { testCode: extractTestCode(output) };
}
```

Add `verify` and `recover`:

```typescript
verify: async (parsed, input, ctx) => {
  // If parse extracted real code from stdout, accept it.
  if (parsed.testCode !== null) return parsed;

  // Otherwise check disk — agent may have written the file as a side effect.
  const diskContent = await ctx.readFile(input.testPath);
  if (diskContent === null) return null;  // no file → recover may try harder

  const extracted = extractTestCode(diskContent);
  if (extracted) return { testCode: extracted };

  // File exists with no code-fence but plausible test content
  if (hasLikelyTestContent(diskContent) && !isStubTestContent(diskContent)) {
    return { testCode: diskContent };
  }

  return null;  // verify exhausted; recover gets a shot
},

recover: async (input, ctx) => {
  // Last-resort: file exists, content unparseable but non-empty.
  // Caller (stage) decides whether to skeleton-fallback; we just return null.
  return null;
},
```

Where `hasLikelyTestContent` and `isStubTestContent` migrate from `src/pipeline/stages/acceptance-setup.ts` into the op file (or a shared helper in `src/acceptance/heuristics.ts`).

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

### Step 5 — TDD ops: `writeTddTestOp` + `implementTddOp`

**Files: `src/operations/tdd-write-test.ts` (or wherever defined), `src/operations/tdd-implement.ts`**.

Same pattern. The TDD test-writer agent (ACP-mode) writes the test file on disk and replies conversationally; same for the implementer with source files.

For `writeTddTestOp`:

```typescript
verify: async (parsed, input, ctx) => {
  if (parsed.success) return parsed;  // stdout had a clear success signal
  // Check disk: did the agent write the test file?
  const exists = await ctx.fileExists(input.expectedTestPath);
  if (exists) {
    const content = await ctx.readFile(input.expectedTestPath);
    if (content && hasLikelyTestContent(content)) {
      return { success: true, testPath: input.expectedTestPath };
    }
  }
  return null;
},
```

Mirror for `implementTddOp` against the source file path the agent was instructed to write.

The exact field shape depends on each op's existing return type — verify/recover construct values that match `O` for that op.

### Step 6 — Inventory other callers that may need migration

Grep for callers that currently use `callOp` and then perform manual disk-recovery. Likely sites:

- `src/operations/decompose.ts` — does the agent write JSON to disk? Check.
- `src/operations/plan.ts` — same.
- `src/review/*` — semantic/adversarial reviewers may or may not have side effects.

For each: if the existing call site has a "after callOp, also read disk to confirm" pattern, that's a migration candidate. Migrate at the same time so the wave covers all known cases.

If unsure, leave the op un-migrated (verify/recover are optional — no behaviour change for ops that don't declare them).

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

Add cases for the new `verify` and `recover` hooks on `acceptanceGenerateOp`. Mock `VerifyContext.readFile` / `fileExists` to simulate disk states.

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
- Step 5 (TDD ops) can be a follow-up sub-PR; not required to land alongside acceptance.
- Step 6 inventory + Step 7 docs land last after migrations stabilise.
