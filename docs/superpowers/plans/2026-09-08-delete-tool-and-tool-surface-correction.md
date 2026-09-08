# Delete Tool and Tool-Surface Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give file-mutating operations a way to delete a tracked file and read git, and make a denied `argv` call name a tool the session actually has.

**Architecture:** A new `Delete` coding tool drops into the existing policy seam (`scope.pathFields`, resolved and confined by `compileToolPolicy` before `run` is called), restricted to git-tracked files so every deletion is recoverable and `.git/` is excluded by construction. The existing read-only `Git` tool is declared on the nine op objects that already declare `Write`+`Edit`. A denial-time redirect is added in the coding-tool runtime, which is the only layer that knows both the policy verdict and which tools were advertised to this session.

**Tech Stack:** Bun 1.4.0, TypeScript strict, `bun:test`, Biome.

**Spec:** `docs/specs/2026-09-08-delete-tool-and-tool-surface-correction.md`

## Before You Start

You are picking this up cold. Everything you need is in the repo; nothing depends on the session that wrote this plan.

**Repo:** `~/workspace/subrina-coder/projects/nax/repos/nax` (GitHub `nathapp-io/nax`).

**Branch:** `feat/1925-1937-delete-tool-and-tool-surface`, already created off `main`. It currently contains **three docs-only commits** (this plan and the spec) and no implementation code. Check out that branch and work on it; do not branch again.

```bash
git checkout feat/1925-1937-delete-tool-and-tool-surface
git log --oneline -3   # expect: plan, spec review, spec
git status --short     # expect: clean
```

**Read first, in this order:**
1. `docs/specs/2026-09-08-delete-tool-and-tool-surface-correction.md` — the spec this plan implements. It carries the measurement and the reasoning; this plan carries only the steps.
2. `CLAUDE.md` at the repo root, and `.nax/rules/` — the repo's own conventions. `.claude/rules/` is generated from `.nax/rules/`; never edit the generated copies.

**Two prior commits on `main` are worth reading before Task 4**, because they establish the pattern every refusal message here follows — naming the legal alternative rather than bare-refusing:
- `1665ab2a4` (#1924/#1937 first half) — `RunCommand` naming its placeholders and argv allowlist.
- `src/tools/policy.ts:253` and `src/tools/git.ts:94` — the two in-tree precedents, both with comments explaining the defect they fixed.

**Expected baseline before you change anything** (run these; if any differs, investigate before proceeding rather than assuming the plan is stale):

```bash
bun run lint          # ends: OK: all 24 check scripts are reachable from CI
bun run typecheck     # no output
bun test test/unit/tools/ --timeout=30000   # all pass
```

**Commit discipline:** one commit per task, as each task's final step specifies. The pre-commit hook runs typecheck plus 24 check scripts and takes roughly a minute; it will reject the commit rather than let a gate slip. Do not use `--no-verify`.

**Do not push and do not open a PR.** Stop after Task 5 and report. Pushing is the human's call.

**If a step's expected output does not match:** stop and say so rather than adapting around it. Every code block here was written against the tree at `main` as of 2026-09-08, and a mismatch more likely means the tree moved than that the step is wrong. In particular the line numbers cited (for example `permissions.ts:167-176`) are hints, not addresses — locate the code by its content.

## Global Constraints

- Bun-native APIs only; no Node.js equivalents where Bun has one. `node:fs/promises` is used by the existing `writeTool`, so it is the established idiom for file work.
- TypeScript strict. No `any` without justification.
- Source files stay under 600 lines, test files under 800 (`bun run check:file-sizes`).
- No emojis in code, comments, or documentation.
- Every refusal message must name the legal alternative. This is an enforced repo norm (`policy.ts:253`, `git.ts:94`).
- Conventional commits: `feat:`, `fix:`, `docs:`, `test:`.
- Do not modify `src/tools/policy.ts`'s denial message. Task 4 adds to it from the runtime layer; changing `policy.ts` would put the redirect in a layer that cannot see the advertised tool set.
- Run `bun run lint` and `bun run typecheck` before each commit. The pre-commit hook runs both plus 24 check scripts and will reject the commit otherwise.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/tools/delete.ts` (create) | The `Delete` tool: tracked-only guard, directory guard, `unlink` | 1 |
| `test/unit/tools/delete.test.ts` (create) | `deleteTool.run` behaviour, called directly | 1 |
| `src/tools/types.ts` (modify) | Add `"Delete"` to `CodingToolName` | 2 |
| `src/tools/registry.ts` (modify) | Add `"Delete"` to `RESERVED_TOOL_NAMES` | 2 |
| `src/tools/runtime.ts` (modify) | Register `deleteTool` as a builtin | 2 |
| `src/tools/index.ts` (modify) | Export `deleteTool` from the barrel | 1 |
| `src/config/permissions.ts` (modify) | Grant `Delete` in the `unrestricted` profile | 2 |
| `test/unit/tools/delete-wiring.test.ts` (create) | Delete is registered, granted, and reaches `run` through the runtime | 2 |
| `src/operations/*.ts` (modify, 8 files) | Declare `Git` and `Delete` on the nine op objects | 3 |
| `test/unit/operations/tool-declarations.test.ts` (create) | Which ops declare what, read from the barrel | 3 |
| `src/tools/denial-redirect.ts` (create) | Static argv-shape to tool-name table plus the message builder | 4 |
| `src/tools/runtime.ts` (modify) | Append the redirect to a denial reason | 4 |
| `test/unit/tools/denial-redirect.test.ts` (create) | Redirect fires only for advertised tools | 4 |

`denial-redirect.ts` is a separate module rather than inline in `runtime.ts` so the table can be tested without constructing a runtime, and so `runtime.ts` (currently 8.5K) does not grow a second responsibility.

---

### Task 1: The `Delete` tool

**Files:**
- Create: `src/tools/delete.ts`
- Test: `test/unit/tools/delete.test.ts`

**Interfaces:**
- Consumes: `CodingTool`, `ToolResult`, `ToolRunContext` from `./registry`; `gitWithTimeout(args: string[], workdir: string, timeoutMs?: number, maxBytes?: number): Promise<{stdout: string; stderr: string; exitCode: number}>` from `@/utils/git`.
- Produces: `export const deleteTool: CodingTool` with `name: "Delete"` and `scope: { pathFields: ["path"] }`. Tasks 2 and 4 both refer to it by that exact name.

This task builds the tool in isolation, calling `run` directly with a hand-built context — the same shape `test/unit/tools/write-edit.test.ts` uses. The tool is not registered or granted yet; that is Task 2, and until then nothing in production can reach it.

- [ ] **Step 1: Write the failing test**

Create `test/unit/tools/delete.test.ts`:

```typescript
import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TOOL_MAX_FILE_BYTES, deleteTool } from "@/tools";
import { gitWithTimeout } from "@/utils/git";

let root: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "nax-delete-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "tracked.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "src", "also-tracked.ts"), "export const b = 2;\n");
  await gitWithTimeout(["init", "-q", "."], root, 30_000);
  await gitWithTimeout(["config", "user.email", "t@example.com"], root, 30_000);
  await gitWithTimeout(["config", "user.name", "t"], root, 30_000);
  await gitWithTimeout(["add", "-A"], root, 30_000);
  await gitWithTimeout(["commit", "-q", "-m", "init"], root, 30_000);
});

function ctx(paths: string[]) {
  return { root, resolvedPaths: paths, maxBytes: 10_000, maxFileBytes: DEFAULT_TOOL_MAX_FILE_BYTES };
}

describe("deleteTool", () => {
  test("deletes a tracked file and names the staging step", async () => {
    const target = join(root, "src", "tracked.ts");
    const res = await deleteTool.run({ path: "src/tracked.ts" }, ctx([target]));
    expect(res.isError).toBeFalsy();
    expect(existsSync(target)).toBe(false);
    expect(res.content).toContain("GitCommit");
  });

  test("refuses an untracked file and names the tracked-only rule", async () => {
    writeFileSync(join(root, "src", "scratch.ts"), "x\n");
    const target = join(root, "src", "scratch.ts");
    const res = await deleteTool.run({ path: "src/scratch.ts" }, ctx([target]));
    expect(res.isError).toBe(true);
    expect(res.content).toContain("not tracked by git");
    expect(res.content).toContain("tracked files only");
    expect(existsSync(target)).toBe(true);
  });

  test("refuses a directory", async () => {
    const target = join(root, "src");
    const res = await deleteTool.run({ path: "src" }, ctx([target]));
    expect(res.isError).toBe(true);
    expect(res.content).toContain("directory");
    expect(existsSync(target)).toBe(true);
  });

  test("refuses a missing path rather than reporting success", async () => {
    const res = await deleteTool.run({ path: "src/nope.ts" }, ctx([join(root, "src", "nope.ts")]));
    expect(res.isError).toBe(true);
    expect(res.content).toContain("does not exist");
  });

  test("refuses a file under .git, which is what makes tracked-only a boundary", async () => {
    const target = join(root, ".git", "index");
    const res = await deleteTool.run({ path: ".git/index" }, ctx([target]));
    expect(res.isError).toBe(true);
    expect(existsSync(target)).toBe(true);
  });

  test("errors when no path was resolved", async () => {
    const res = await deleteTool.run({ path: "src/tracked.ts" }, ctx([]));
    expect(res.isError).toBe(true);
  });

  test("declares its path field so the policy can gate it", () => {
    expect(deleteTool.scope.pathFields).toEqual(["path"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/unit/tools/delete.test.ts --timeout=30000`

Expected: FAIL. The import of `deleteTool` from `@/tools` does not resolve, so every test in the file errors.

> This task's test and implementation were smoke-tested verbatim against the tree
> at `0ade624ca` before handover: 7 pass, 0 fail, and both `bun run typecheck` and
> `biome check` clean. The files were then reverted, so you are writing them fresh.
> If they do not pass for you, the tree has moved — stop and say so.

- [ ] **Step 3: Write the implementation**

Create `src/tools/delete.ts`:

```typescript
/**
 * Delete a tracked file whose path the policy already resolved and approved.
 *
 * Tracked-only, and that is a safety boundary rather than a convenience: a
 * tracked file's content is in git history, so removing it is an undo away,
 * while an untracked file exists only on disk. It also excludes everything
 * under `.git/` by construction -- nothing there is tracked -- which matters
 * because the policy confines paths to the permitted root and `.git` is inside
 * it (nax#1943).
 *
 * Not `git rm`: gitTool documents a deliberate read/write split, and `git rm`
 * both deletes and stages, folding two capabilities into one call. Plain
 * unlink plus the existing GitCommit keeps each seam doing one thing --
 * `git add -- <deleted path>` stages a deletion, so no change to GitCommit is
 * needed.
 */

import { stat, unlink } from "node:fs/promises";
import { gitWithTimeout } from "@/utils/git";
import type { CodingTool, ToolResult, ToolRunContext } from "./registry";

const GIT_TIMEOUT_MS = 30_000;

export const deleteTool: CodingTool = {
  name: "Delete",
  description:
    "Delete a file the repository already tracks. Only tracked files can be removed, so every deletion stays recoverable from git history; untracked files and directories are refused. The removal still has to be staged -- pass the same path to GitCommit afterwards.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to the repository root" },
    },
    required: ["path"],
  },
  scope: { pathFields: ["path"] },

  async run(input: Record<string, unknown>, ctx: ToolRunContext): Promise<ToolResult> {
    const [target] = ctx.resolvedPaths;
    if (target === undefined) return { content: "no path supplied", isError: true };
    const shown = String(input.path);

    // Existence and directory come first so each refusal says the true thing.
    // Tracked-first would report a mistyped path as "not tracked", which is
    // technically true and diagnostically useless.
    let isDirectory: boolean;
    try {
      isDirectory = (await stat(target)).isDirectory();
    } catch {
      return { content: `"${shown}" does not exist`, isError: true };
    }
    if (isDirectory) {
      // Reachable, not defensive: `ls-files --error-unmatch` exits 0 for a
      // directory holding tracked files, so "tracked" does not imply "file".
      return { content: `"${shown}" is a directory; Delete removes one file at a time`, isError: true };
    }

    const tracked = await gitWithTimeout(["ls-files", "--error-unmatch", "--", target], ctx.root, GIT_TIMEOUT_MS);
    if (tracked.exitCode !== 0) {
      // "untracked" and "git failed" get the same message on purpose: both
      // mean the tool cannot prove the deletion would be recoverable.
      return {
        content: `"${shown}" is not tracked by git, so deleting it would be unrecoverable. Delete removes tracked files only -- commit it first if you want it gone.`,
        isError: true,
      };
    }

    try {
      await unlink(target);
      return { content: `deleted ${shown} -- stage the removal by passing the same path to GitCommit` };
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  },
};
```

- [ ] **Step 4: Export it from the barrel so the test's import resolves**

In `src/tools/index.ts`, add alongside the existing tool exports:

```typescript
export { deleteTool } from "./delete";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test test/unit/tools/delete.test.ts --timeout=30000`

Expected: PASS, 7 tests.

If the `.git/index` test fails, do not "fix" it by adding a `.git` string check — that would mask the real property. It should pass because `ls-files --error-unmatch -- .git/index` exits non-zero.

- [ ] **Step 6: Lint, typecheck, commit**

```bash
bun run lint && bun run typecheck
git add src/tools/delete.ts src/tools/index.ts test/unit/tools/delete.test.ts
git commit -m "feat(tools): add a Delete tool restricted to tracked files (#1925)"
```

---

### Task 2: Register and grant `Delete`

**Files:**
- Modify: `src/tools/types.ts` (the `CodingToolName` union, lines 19-29)
- Modify: `src/tools/registry.ts` (`RESERVED_TOOL_NAMES`)
- Modify: `src/tools/runtime.ts` (`registerBuiltinCodingTools`, the builtin array)
- Modify: `src/config/permissions.ts` (the `unrestricted` profile's tool list, lines 167-176)
- Test: `test/unit/tools/delete-wiring.test.ts`

**Interfaces:**
- Consumes: `deleteTool` from Task 1.
- Produces: `"Delete"` as a valid `CodingToolName`, granted under the `unrestricted` profile. Task 3 declares it on ops; Task 4 names it in the redirect table.

This is the task the spec singles out as easy to miss. `unrestricted` grants an **explicit list**, not everything registered — without the grant, `compiled.get("Delete")` is `undefined` and every call is denied with `tool "Delete" is not permitted for this stage`, while all of Task 1's tests still pass.

- [ ] **Step 1: Write the failing test**

Create `test/unit/tools/delete-wiring.test.ts`:

```typescript
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeNaxConfig } from "@test/helpers";
import { resolvePermissions } from "@/config/permissions";
import { compileToolPolicy } from "@/tools/policy";
import { createCodingToolRuntime } from "@/tools/runtime";
import { gitWithTimeout } from "@/utils/git";

let root: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "nax-delete-wiring-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "tracked.ts"), "export const a = 1;\n");
  await gitWithTimeout(["init", "-q", "."], root, 30_000);
  await gitWithTimeout(["config", "user.email", "t@example.com"], root, 30_000);
  await gitWithTimeout(["config", "user.name", "t"], root, 30_000);
  await gitWithTimeout(["add", "-A"], root, 30_000);
  await gitWithTimeout(["commit", "-q", "-m", "init"], root, 30_000);
});

describe("Delete wiring", () => {
  test("the unrestricted profile grants Delete", () => {
    // makeNaxConfig, not a raw literal: `.nax/rules/test-helpers.md` forbids
    // re-implementing shared fixtures inline, and a bare object literal does
    // not narrow permissionProfile to its union type.
    const { toolGrants } = resolvePermissions(makeNaxConfig({ execution: { permissionProfile: "unrestricted" } }), "run");
    expect((toolGrants ?? []).map((g) => g.tool)).toContain("Delete");
  });

  test("the safe profile does NOT grant Delete", () => {
    const { toolGrants } = resolvePermissions(makeNaxConfig({ execution: { permissionProfile: "safe" } }), "run");
    expect((toolGrants ?? []).map((g) => g.tool)).not.toContain("Delete");
  });

  test("a declared Delete reaches the tool through the runtime and deletes", async () => {
    const policy = compileToolPolicy([{ tool: "Delete", patterns: ["*"] }], root);
    const runtime = createCodingToolRuntime({ policy });
    expect(runtime.advertised(["Delete"]).map((t) => t.name)).toEqual(["Delete"]);

    const outcome = await runtime.callTool("Delete", { path: "src/tracked.ts" });
    expect(outcome.kind).toBe("ok");
  });

  test("without a grant the runtime refuses before reaching the tool", async () => {
    const policy = compileToolPolicy([{ tool: "Read", patterns: ["*"] }], root);
    const runtime = createCodingToolRuntime({ policy });
    const outcome = await runtime.callTool("Delete", { path: "src/tracked.ts" });
    expect(outcome.kind).toBe("denied");
  });

  test("the policy refuses a path outside the permitted root, and flags it as a breach", async () => {
    const policy = compileToolPolicy([{ tool: "Delete", patterns: ["*"] }], root);
    const runtime = createCodingToolRuntime({ policy });
    const outcome = await runtime.callTool("Delete", { path: "../escape.ts" });
    expect(outcome.kind).toBe("denied");
    if (outcome.kind !== "denied") throw new Error("expected a denial");
    expect(outcome.breach).toBe(true);
    expect(outcome.reason).toContain("outside the permitted root");
  });

  test("Delete then GitCommit records the removal in a commit", async () => {
    const policy = compileToolPolicy(
      [
        { tool: "Delete", patterns: ["*"] },
        { tool: "GitCommit", patterns: ["*"] },
      ],
      root,
    );
    const runtime = createCodingToolRuntime({ policy });

    const deleted = await runtime.callTool("Delete", { path: "src/tracked.ts" });
    expect(deleted.kind).toBe("ok");

    // The deleted path is passed straight to GitCommit. This is the property
    // the spec verified by hand: `git add -- <deleted path>` stages a deletion,
    // and realOrRaw resolves a path that no longer exists, so the policy still
    // admits it. If either stopped holding, this test is where it shows.
    const committed = await runtime.callTool("GitCommit", {
      message: "chore: remove tracked.ts",
      paths: ["src/tracked.ts"],
    });
    expect(committed.kind).toBe("ok");

    const show = await gitWithTimeout(["show", "--stat", "--oneline", "HEAD"], root, 30_000);
    expect(show.exitCode).toBe(0);
    expect(show.stdout).toContain("src/tracked.ts");
    expect(show.stdout).toContain("1 deletion");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/unit/tools/delete-wiring.test.ts --timeout=30000`

Expected: FAIL. "the unrestricted profile grants Delete" fails because the list does not contain it, and the runtime test fails as denied because there is no registered `Delete` builtin.

- [ ] **Step 3: Add the name to the type union**

In `src/tools/types.ts`, extend `CodingToolName` (it currently ends `| "Exec";`):

```typescript
export type CodingToolName =
  | "Read"
  | "Glob"
  | "Grep"
  | "Write"
  | "Edit"
  | "Delete"
  | "Git"
  | "GitCommit"
  | "RunCommand"
  | "RequestCapability"
  | "Exec";
```

- [ ] **Step 4: Reserve the name and register the builtin**

In `src/tools/registry.ts`, add `"Delete"` to `RESERVED_TOOL_NAMES` after `"Edit"`. A third party registering a tool called `Delete` would otherwise shadow the gated implementation.

In `src/tools/runtime.ts`, add `deleteTool` to the array inside `registerBuiltinCodingTools`, after `editTool`, and add the import:

```typescript
import { deleteTool } from "./delete";
```

- [ ] **Step 5: Grant it in the unrestricted profile**

In `src/config/permissions.ts`, add `"Delete"` to the `unrestricted` profile's list, after `"Edit"`:

```typescript
        toolGrants: unconditionalGrants([
          ...DEFAULT_CODING_TOOLS,
          "Write",
          "Edit",
          "Delete",
          "Git",
          "GitCommit",
          "RunCommand",
          "RequestCapability",
          EXEC_TOOL_NAME,
        ]),
```

Do **not** add it to `safe`, which grants only `DEFAULT_CODING_TOOLS` (the read set). `scoped` resolves per-stage through `resolveScopedPermissions` and inherits whatever the project's `execution.permissions` block names, so it needs no change here.

- [ ] **Step 6: Run the test to verify it passes**

Run: `bun test test/unit/tools/delete-wiring.test.ts --timeout=30000`

Expected: PASS, 6 tests.

- [ ] **Step 7: Run the neighbouring suites for regressions**

Run: `bun test test/unit/tools/ test/unit/config/ --timeout=30000`

Expected: all pass. `test/unit/config/permissions.test.ts` may assert on the granted tool list; if it fails, update the expectation to include `Delete` — that is the assertion doing its job, not a broken test.

- [ ] **Step 8: Lint, typecheck, commit**

```bash
bun run lint && bun run typecheck
git add src/tools/types.ts src/tools/registry.ts src/tools/runtime.ts src/config/permissions.ts test/unit/tools/delete-wiring.test.ts
git commit -m "feat(tools): register and grant the Delete tool (#1925)"
```

---

### Task 3: Declare `Git` and `Delete` on the file-mutating ops

**Files:**
- Modify: `src/operations/implement.ts:45`
- Modify: `src/operations/autofix-implementer.ts:32`
- Modify: `src/operations/autofix-test-writer.ts:29`
- Modify: `src/operations/write-test.ts:69`
- Modify: `src/operations/acceptance-fix.ts:34` and `:66` (two op objects in one file)
- Modify: `src/operations/rectify.ts:22`
- Modify: `src/operations/finish-fix.ts:38`
- Modify: `src/operations/full-suite-rectify-op.ts:39`
- Test: `test/unit/operations/tool-declarations.test.ts`

**Interfaces:**
- Consumes: `"Delete"` as a `CodingToolName` from Task 2.
- Produces: nothing other tasks consume. Task 4's `Delete` and `Git` redirect rows become reachable in practice once this lands, but do not depend on it to compile.

These are the same eight files whether you select on `Write`+`Edit` or on `Exec` — the two sets are identical, which is why one edit list serves both changes. `Git` is read-only (`GIT_READ_VERBS = ["diff","log","show","status","blame"]`, enforced at `git.ts:115` and `:220`).

- [ ] **Step 1: Write the failing test**

Create `test/unit/operations/tool-declarations.test.ts`. It reads the operations barrel rather than parsing source, for the reason `scripts/check-op-tool-capability.ts` documents: ops are exported under aliases and one module can define several.

```typescript
import { describe, expect, test } from "bun:test";
import {
  acceptanceFixSourceOp,
  acceptanceFixTestOp,
  adversarialReviewOp,
  finishFixOp,
  fullSuiteRectifyOp,
  implementerOp,
  implementerRectifyOp,
  planInteractiveOp,
  rectifyOp,
  testWriterOp,
  testWriterRectifyOp,
  verifierOp,
} from "@/operations";

const FILE_MUTATING_OPS = [
  ["implementer", implementerOp],
  ["autofix-implementer", implementerRectifyOp],
  ["autofix-test-writer", testWriterRectifyOp],
  ["write-test", testWriterOp],
  ["acceptance-fix-source", acceptanceFixSourceOp],
  ["acceptance-fix-test", acceptanceFixTestOp],
  ["rectify", rectifyOp],
  ["finish-fix", finishFixOp],
  ["full-suite-rectify", fullSuiteRectifyOp],
] as const;

describe("file-mutating ops declare Delete and Git", () => {
  test.each(FILE_MUTATING_OPS)("%s declares Delete", (_name, op) => {
    expect(op.tools).toContain("Delete");
  });

  test.each(FILE_MUTATING_OPS)("%s declares Git", (_name, op) => {
    expect(op.tools).toContain("Git");
  });

  test.each(FILE_MUTATING_OPS)("%s still declares Write and Edit", (_name, op) => {
    expect(op.tools).toContain("Write");
    expect(op.tools).toContain("Edit");
  });
});

describe("read-only ops gain neither", () => {
  test.each([
    ["verifier", verifierOp],
    ["adversarial-review", adversarialReviewOp],
    ["plan", planInteractiveOp],
  ] as const)("%s does not declare Delete", (_name, op) => {
    expect(op.tools ?? []).not.toContain("Delete");
  });
});
```

These are the barrel's real export names, verified against `src/operations/index.ts` — note that they do NOT match the file names: `autofix-implementer.ts` exports `implementerRectifyOp`, `autofix-test-writer.ts` exports `testWriterRectifyOp`, `write-test.ts` exports `testWriterOp`, and `plan.ts` exports `planInteractiveOp`. `implement.ts` also exports `implementTddOp` as an alias of the same object, so asserting on both would test one object twice.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/unit/operations/tool-declarations.test.ts --timeout=30000`

Expected: FAIL. The `Delete` and `Git` assertions fail for all nine ops; the `Write`/`Edit` and read-only assertions already pass.

- [ ] **Step 3: Add the two names to each of the nine declarations**

In each file listed above, extend the `tools` array. For example `src/operations/implement.ts:45` becomes:

```typescript
  tools: ["Read", "Glob", "Grep", "Write", "Edit", "Delete", "Git", "RunCommand", "GitCommit", "Exec", "RequestCapability"],
```

Apply the same two additions (`"Delete"` after `"Edit"`, `"Git"` after it) to the other eight declarations, preserving each file's existing entries and their order. Note that `finish-fix.ts` and `full-suite-rectify-op.ts` deliberately omit `GitCommit` — leave that omission alone, it is documented in comments above each.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/unit/operations/tool-declarations.test.ts --timeout=30000`

Expected: PASS, 30 tests.

- [ ] **Step 5: Confirm the capability ratchet still passes**

Run: `bun run check:op-tool-capability`

Expected: `OK: 25 run op(s) checked, 0 grandfathered.` `REQUIRED_TOOLS_BY_ROLE` is a minimum, not an exact set, so adding tools cannot breach it. If it fails, stop — something other than this change is wrong.

- [ ] **Step 6: Lint, typecheck, commit**

```bash
bun run lint && bun run typecheck
git add src/operations/ test/unit/operations/tool-declarations.test.ts
git commit -m "feat(operations): declare Delete and Git on file-mutating ops (#1925, #1937)"
```

---

### Task 4: Denials that name a tool the session has

**Files:**
- Create: `src/tools/denial-redirect.ts`
- Modify: `src/tools/runtime.ts` (the opts type, the `advertised` method, and the denial branch at ~line 187)
- Modify: `src/agents/coding-tool-support.ts` (~line 95, pass `declaredCommands` to the runtime)
- Test: `test/unit/tools/denial-redirect.test.ts`

**Interfaces:**
- Consumes: `"Delete"` and `"Git"` being real advertised tools (Tasks 2 and 3), which is what makes those two table rows honest.
- Produces: `redirectForArgv(argv: readonly string[], available: ReadonlySet<string>, declaredCommands: ReadonlySet<string>): string | undefined` — returns a clause to append to a denial reason, or `undefined` when nothing applies.

The redirect lives in the runtime, not `policy.ts`, because only the runtime knows **both** the verdict and which tools were advertised. Naming a tool the session was never given would recreate the exact defect this fixes.

- [ ] **Step 1: Write the failing test for the table**

Create `test/unit/tools/denial-redirect.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { redirectForArgv } from "@/tools/denial-redirect";

const ALL = new Set(["Glob", "Git", "Delete", "RunCommand"]);
const CMDS = new Set(["test", "testScoped", "lint"]);

describe("redirectForArgv", () => {
  test("points ls at Glob when Glob is advertised", () => {
    expect(redirectForArgv(["ls", "-la", "src"], ALL, CMDS)).toContain("Glob");
  });

  test("points find at Glob", () => {
    expect(redirectForArgv(["find", ".", "-type", "f"], ALL, CMDS)).toContain("Glob");
  });

  test("says nothing when the tool is not advertised", () => {
    expect(redirectForArgv(["ls"], new Set(["Read"]), CMDS)).toBeUndefined();
  });

  test("points a read-only git verb at Git", () => {
    expect(redirectForArgv(["git", "status", "--porcelain"], ALL, CMDS)).toContain("Git");
  });

  test("points git rm and rm at Delete", () => {
    expect(redirectForArgv(["git", "rm", "a.ts"], ALL, CMDS)).toContain("Delete");
    expect(redirectForArgv(["rm", "a.ts"], ALL, CMDS)).toContain("Delete");
  });

  test("points a scoped test run at testScoped only when the project declares it", () => {
    expect(redirectForArgv(["bun", "test", "a.test.ts"], ALL, CMDS)).toContain("testScoped");
    expect(redirectForArgv(["bun", "test", "a.test.ts"], ALL, new Set(["test"]))).toBeUndefined();
  });

  test("sees through a timeout prefix", () => {
    expect(redirectForArgv(["timeout", "30", "bun", "test", "a.test.ts"], ALL, CMDS)).toContain("testScoped");
  });

  test("says nothing about an install form, which is already granted", () => {
    expect(redirectForArgv(["bun", "add", "left-pad"], ALL, CMDS)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/unit/tools/denial-redirect.test.ts --timeout=30000`

Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write the redirect module**

Create `src/tools/denial-redirect.ts`:

```typescript
/**
 * Name the tool that serves the intent behind a denied argv call.
 *
 * `policy.ts` already names the granted argv FORMS, which is the right answer
 * when the model wanted a different install. It is the wrong answer when the
 * model wanted `git status`: across three runs, 8 of 32 denied argv calls were
 * for capabilities the session already held as a first-class tool (nax#1937).
 *
 * Lives here rather than in policy.ts because the policy knows the grants but
 * not which tools were ADVERTISED to this session. Naming a tool the session
 * never received would reproduce the defect this exists to fix, so every row
 * is gated on the caller's `available` set.
 */

const GIT_READ_VERBS = new Set(["diff", "log", "show", "status", "blame"]);

/** Argv shapes that are really a request for a first-class tool. */
function intendedTool(argv: readonly string[]): { tool: string; how: string } | undefined {
  // A `timeout N ...` prefix wraps the real command; look past it.
  const av = argv[0] === "timeout" ? argv.slice(2) : argv;
  const [head, second] = av;
  if (head === undefined) return undefined;

  if (head === "ls" || head === "find") {
    return { tool: "Glob", how: "Glob lists repository paths by pattern" };
  }
  if (head === "rm") {
    return { tool: "Delete", how: "Delete removes one tracked file at a time" };
  }
  if (head === "git" && second === "rm") {
    return { tool: "Delete", how: "Delete removes one tracked file at a time" };
  }
  if (head === "git" && second !== undefined && GIT_READ_VERBS.has(second)) {
    return { tool: "Git", how: `Git runs read-only git (${[...GIT_READ_VERBS].join(", ")})` };
  }
  if (head === "bun" && second === "test") {
    return { tool: "RunCommand:testScoped", how: 'RunCommand {"command":"testScoped"} runs the project test command on named files' };
  }
  return undefined;
}

export function redirectForArgv(
  argv: readonly string[],
  available: ReadonlySet<string>,
  declaredCommands: ReadonlySet<string>,
): string | undefined {
  const hit = intendedTool(argv);
  if (hit === undefined) return undefined;

  if (hit.tool === "RunCommand:testScoped") {
    // Conditioned on the project actually declaring the command, not hardcoded:
    // naming a command this project never declared is the same defect again.
    if (!available.has("RunCommand") || !declaredCommands.has("testScoped")) return undefined;
    return `this session already has ${hit.how}`;
  }
  if (!available.has(hit.tool)) return undefined;
  return `this session already has \`${hit.tool}\` -- ${hit.how}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/unit/tools/denial-redirect.test.ts --timeout=30000`

Expected: PASS, 8 tests.

- [ ] **Step 5: Write the failing runtime-integration test**

Append to `test/unit/tools/denial-redirect.test.ts`:

```typescript
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileToolPolicy } from "@/tools/policy";
import { createCodingToolRuntime } from "@/tools/runtime";

describe("runtime appends the redirect to a denial", () => {
  const root = mkdtempSync(join(tmpdir(), "nax-redirect-"));

  test("a denied ls names Glob once Glob has been advertised", async () => {
    const policy = compileToolPolicy(
      [
        { tool: "Glob", patterns: ["*"] },
        { tool: "RunCommand", patterns: ["*"] },
        { tool: "Exec", patterns: ["bun install"] },
      ],
      root,
    );
    const runtime = createCodingToolRuntime({ policy });
    runtime.advertised(["Glob", "RunCommand"]);

    const outcome = await runtime.callTool("RunCommand", { argv: ["ls", "-la"] });
    expect(outcome.kind).toBe("denied");
    if (outcome.kind !== "denied") throw new Error("expected a denial");
    expect(outcome.reason).toContain("is not granted for argv");
    expect(outcome.reason).toContain("Glob");
  });

  test("the same denial stays silent when Glob was never advertised", async () => {
    const policy = compileToolPolicy(
      [
        { tool: "RunCommand", patterns: ["*"] },
        { tool: "Exec", patterns: ["bun install"] },
      ],
      root,
    );
    const runtime = createCodingToolRuntime({ policy });
    runtime.advertised(["RunCommand"]);

    const outcome = await runtime.callTool("RunCommand", { argv: ["ls", "-la"] });
    expect(outcome.kind).toBe("denied");
    if (outcome.kind !== "denied") throw new Error("expected a denial");
    expect(outcome.reason).not.toContain("Glob");
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `bun test test/unit/tools/denial-redirect.test.ts --timeout=30000`

Expected: FAIL on "names Glob" — the reason contains the granted forms but not `Glob`.

- [ ] **Step 7: Wire the redirect into the runtime**

In `src/tools/runtime.ts`:

Add the import:

```typescript
import { redirectForArgv } from "./denial-redirect";
```

Inside `createCodingToolRuntime`, before the returned object, add a record of what was advertised:

```typescript
  // What `advertised()` actually returned, so a denial can name only tools the
  // session really received. Recomputing from `granted` would be wrong: an op
  // narrows the set by declaring fewer tools than it was granted.
  let advertisedNames: ReadonlySet<string> = new Set();
```

In the `advertised(declared)` method, record the result before returning it (it currently builds `out` then returns it):

```typescript
      advertisedNames = new Set(out.map((t) => t.name));
      return out;
```

Add a typed option for the project's declared command names, alongside the existing `extraTools`:

```typescript
export function createCodingToolRuntime(opts: {
  policy: ToolPolicy;
  maxBytes?: number;
  maxFileBytes?: number;
  storyId?: string;
  sink?: ToolAuditSink;
  extraTools?: readonly CodingTool[];
  /** Declared command names, so a denial can name `testScoped` only when the project has one. */
  declaredCommands?: ReadonlySet<string>;
}): CodingToolRuntime {
```

Do **not** try to read the command names back out of `RunCommand`'s `inputSchema`. `JSONSchema` is `Record<string, unknown>` (`src/context/engine/types.ts:72`), so `inputSchema.properties?.command` does not typecheck and would need a chain of casts to compile — passing the set in is both typed and honest about where the data comes from.

In the denial branch, build the reason with the redirect appended. Replace the two lines that log and return the verdict's reason with:

```typescript
        const rawArgv = argvField === undefined ? undefined : input[argvField];
        const extra = Array.isArray(rawArgv)
          ? redirectForArgv(rawArgv as readonly string[], advertisedNames, opts.declaredCommands ?? new Set())
          : undefined;
        const reason = extra === undefined ? verdict.reason : `${verdict.reason} -- ${extra}`;
        log(policyIdentity, "denied", reason.length, input, verdict.breach, reason);
        return { kind: "denied", reason, breach: verdict.breach };
```

Then pass it at the one production construction site, `src/agents/coding-tool-support.ts` (which already holds `declaredCommands` as a `ReadonlyMap<string, string>` at line 81):

```typescript
  const runtime = createCodingToolRuntime({
    policy: compileToolPolicy(grants, args.root, { execTouchedPaths }),
    declaredCommands: new Set(declaredCommands.keys()),
    ...(args.storyId !== undefined ? { storyId: args.storyId } : {}),
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `bun test test/unit/tools/denial-redirect.test.ts --timeout=30000`

Expected: PASS, 10 tests.

- [ ] **Step 9: Confirm policy.ts was not modified**

Run: `git diff --stat src/tools/policy.ts`

Expected: no output. If `policy.ts` changed, the redirect went into the wrong layer — revert that file and put the change in `runtime.ts`.

- [ ] **Step 10: Run the full tools and agents suites**

Run: `bun test test/unit/tools/ test/unit/agents/ --timeout=30000`

Expected: all pass. `runtime.test.ts` and `runtime-log-levels.test.ts` assert on denial reasons; if one fails because a reason now carries a redirect clause, that is correct behaviour — update the expectation.

- [ ] **Step 11: Lint, typecheck, commit**

```bash
bun run lint && bun run typecheck
git add src/tools/denial-redirect.ts src/tools/runtime.ts src/agents/coding-tool-support.ts test/unit/tools/denial-redirect.test.ts
git commit -m "feat(tools): denied argv calls name a tool the session already has (#1937)"
```

---

### Task 5: Documentation and final verification

**Files:**
- Modify: `docs/specs/2026-09-08-delete-tool-and-tool-surface-correction.md` (status line only)

- [ ] **Step 1: Run the full suite**

Run: `bun run test`

Expected: all pass. Do not use a bare `bun test` — the repo's full-suite command is `bun run test`.

- [ ] **Step 2: Run the coverage gate**

Run: `bun run test:coverage`

Expected: pass. This is a separate CI step with a per-file floor and is not part of the nax pipeline, so a green suite can still fail it. New files (`delete.ts`, `denial-redirect.ts`) need to clear the floor; if either falls short, add the missing cases to its existing test file rather than lowering the baseline.

- [ ] **Step 3: Mark the spec implemented**

Add under the spec's title line:

```markdown
Status: implemented 2026-09-08 — see #1925, #1937.
```

- [ ] **Step 4: Commit**

```bash
git add docs/specs/2026-09-08-delete-tool-and-tool-surface-correction.md
git commit -m "docs: mark the delete-tool spec implemented (#1925, #1937)"
```

---

## Verification Checklist

- [ ] `Delete` refuses `.git/index` (the property that makes tracked-only a boundary)
- [ ] `Delete` appears in the `unrestricted` grant list and NOT in `safe`
- [ ] All nine file-mutating op objects declare both `Delete` and `Git`
- [ ] `verify`, `adversarial-review` and `plan` declare neither
- [ ] `src/tools/policy.ts` is unchanged by Task 4
- [ ] A denial names a tool only when that tool was advertised
- [ ] `bun run lint`, `bun run typecheck`, `bun run test`, `bun run test:coverage` all green

## Out of Scope

Carried from the spec; do not implement these:

- `mv` (rename) — one denied call, no tool covers it.
- `wc -l` — one call, not worth a tool.
- The scoped-lint bucket — a gap in this repo's own `.nax/config.json`, not a nax defect.
- `Write` reaching `.git/` — filed as **#1943**; needs a path guard in the policy, which is a wider change than this plan.
- Prompt-driven shell reaching — #1800/#1906.
