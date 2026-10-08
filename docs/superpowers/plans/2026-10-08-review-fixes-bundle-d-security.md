# Review Fixes Bundle D — Security Hardening

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Read the master plan's **Global Constraints** first: `2026-10-08-review-fixes-master-plan.md`.

**Goal:** Keep the #2210 submodule defence on git commands an interceptor rewrote, and stop trusting a `/tmp/nax` another user owns.

**Architecture:** Two independent tasks in `packages/nax-agent` (plus the shared test stub in `packages/test-kit`). Task 1 teaches `hardenedGitArgv` to find the git program behind the one leading token an interceptor may add. Task 2 adds an ownership check to the shared temp parent.

**Tech Stack:** TypeScript, bun:test.

**Spec:** `docs/superpowers/reviews/2026-10-08-whole-repo-code-review.md` findings #4, #17.

**Branch:** `git fetch origin && git checkout -b fix/review-d-security origin/main`

## Global Constraints

See the master plan. All files here are far below the size caps.

## Files

- Modify: `packages/nax-agent/src/internal/git-env.ts:77-99` (Task 1)
- Test: `packages/nax-agent/test/unit/internal/git-env.test.ts` (Task 1)
- Modify: `packages/nax-agent/src/sandbox/session-tmp.ts:33-65` (Task 2)
- Modify: `packages/test-kit/src/bun/session-tmp-deps.ts` (Task 2)
- Test: `packages/nax-agent/test/unit/sandbox/session-tmp.test.ts` (Task 2)

---

### Task 1: The submodule flag survives interceptor rewrites (#4)

`validateRewrite` (`command-interceptor/index.ts:58-69`) only admits a rewrite that adds exactly ONE leading token (the provider binary) in front of the original argv. So a rewritten git argv is `["<provider>", "git", <verb>, ...]`. `hardenedGitArgv` assumes `argv[0]` is git and reads `argv[1]` (`"git"`) as the subcommand, so it never inserts `--ignore-submodules=dirty`. Fix: when `argv[0]` is not a git program but `argv[1]` is, start the subcommand walk after index 1.

**Files:**
- Modify: `packages/nax-agent/src/internal/git-env.ts`
- Test: `packages/nax-agent/test/unit/internal/git-env.test.ts`

**Interfaces:**
- `hardenedGitArgv(argv: readonly string[]): string[]` keeps its signature.

- [ ] **Step 1: Write the failing tests**

In `git-env.test.ts`, add `_gitDeps` to the existing import from `"@nathapp/nax-agent/internal"` (it is re-exported there from `internal/git-exec`), add `makeSpawn` and `withDepsRestore` to the `#test/helpers/index` import, and append inside `describe("hardenedGitArgv", ...)`:

```ts
  test.each([
    [
      ["rtk", "git", "status", "--porcelain"],
      ["rtk", "git", "status", "--ignore-submodules=dirty", "--porcelain"],
    ],
    [
      ["rtk", "git", "-C", "/r", "diff", "HEAD"],
      ["rtk", "git", "-C", "/r", "diff", "--ignore-submodules=dirty", "HEAD"],
    ],
    [
      ["/usr/bin/git", "diff"],
      ["/usr/bin/git", "diff", "--ignore-submodules=dirty"],
    ],
  ])("finds the subcommand behind an interceptor's leading token: %j", (argv, expected) => {
    expect(hardenedGitArgv(argv)).toEqual(expected);
  });

  test.each([[["rtk", "git", "log"]], [["git", "git", "status"]]])(
    "a wrapped argv with no dirty-check subcommand is left alone: %j",
    (argv) => {
      expect(hardenedGitArgv(argv)).toEqual(argv);
    },
  );
```

And add a new describe at the end of the file:

```ts
describe("gitWithTimeout: an interceptor-rewritten argv keeps the #2210 flag", () => {
  withDepsRestore(_gitDeps);

  test("the spawned argv carries --ignore-submodules=dirty after the wrapped subcommand", async () => {
    const stub = makeSpawn(() => "");
    _gitDeps.spawn = stub.spawn;

    await gitWithTimeout(["status", "--porcelain"], process.cwd(), undefined, undefined, [
      "rtk",
      "git",
      "status",
      "--porcelain",
    ]);

    expect(stub.calls[0]?.cmd).toEqual(["rtk", "git", "status", "--ignore-submodules=dirty", "--porcelain"]);
  });
});
```

`makeSpawn` (`packages/test-kit/src/bun/spawn.ts:177`) records every call's `cmd`; `git-commit.test.ts:262` assigns its `.spawn` to `_gitDeps.spawn` the same way. If `SpawnStub` exposes the recorded calls under a different name than `calls`, use that name (read the `SpawnStub` interface in the same file).

- [ ] **Step 2: Run them to verify they fail**

Run (from `packages/nax-agent`): `timeout 30 bun test test/unit/internal/git-env.test.ts --timeout=5000`
Expected: FAIL — the `rtk` cases come back unchanged; the `/usr/bin/git` case already passes (argv[0] path is a git program today).

- [ ] **Step 3: Implement**

In `git-env.ts`, add above `hardenedGitArgv`:

```ts
/** `git` or a path ending in `/git`: the program, as opposed to a wrapper in front of it. */
function isGitProgram(token: string | undefined): boolean {
  return token === "git" || (token?.endsWith("/git") ?? false);
}
```

Change the first two lines of `hardenedGitArgv`'s body:

```ts
  const out = [...argv];
  let i = 1;
```

to:

```ts
  const out = [...argv];
  // A command interceptor may add exactly ONE leading token (validateRewrite), so a
  // rewritten argv is `<provider> git <verb> ...`: the walk starts after the git program.
  let i = !isGitProgram(out[0]) && isGitProgram(out[1]) ? 2 : 1;
```

Extend the doc comment's first sentence: "`argv` (argv[0] is the git program, or an interceptor token followed by it) with ...".

- [ ] **Step 4: Run tests to verify they pass**

Run: `timeout 30 bun test test/unit/internal/ test/unit/tools/ test/unit/command-interceptor/ --timeout=5000`
Expected: PASS (skip any of those directories that does not exist).

- [ ] **Step 5: Commit**

```bash
git add packages/nax-agent/src/internal/git-env.ts packages/nax-agent/test/unit/internal/git-env.test.ts
git commit -m "fix(git): keep --ignore-submodules=dirty on interceptor-rewritten git argv (review #4)"
```

---

### Task 2: `/tmp/nax` is trusted only when the current user owns it (#17)

`isUsableSharedParent` accepts any real directory the current user can write and search, so a world-writable `/tmp/nax` that another user created passes, and every session temp dir lands inside a directory a hostile local user controls. Add the ownership check; a foreign owner falls back to the per-user `/tmp/nax-<uid>` exactly like an unwritable one.

**Files:**
- Modify: `packages/nax-agent/src/sandbox/session-tmp.ts`
- Modify: `packages/test-kit/src/bun/session-tmp-deps.ts`
- Test: `packages/nax-agent/test/unit/sandbox/session-tmp.test.ts`

**Interfaces:**
- `SessionTmpDepsLike.lstat` (test-kit) return type gains `readonly uid: number`.
- `SessionTmpHostFacts` (test-kit) gains `readonly owner?: number` — the uid that owns `/tmp/nax`. Defaults to the stubbed `uid`, so every existing test keeps "the current user owns it".

- [ ] **Step 1: Extend the shared stub (no behaviour change yet)**

In `packages/test-kit/src/bun/session-tmp-deps.ts`:

```ts
export interface SessionTmpDepsLike {
  lstat(path: string): { isDirectory(): boolean; isSymbolicLink(): boolean; readonly uid: number };
  access(path: string, mode: number): void;
  uid(): number;
}
```

Add to `SessionTmpHostFacts`:

```ts
  /** The uid that owns `/tmp/nax`. Defaults to `uid` — the current user owns it. */
  readonly owner?: number;
```

In `stubSessionTmpDeps`, after `const uid = facts.uid ?? 501;` add `const owner = facts.owner ?? uid;` and make the stubbed `lstat` return `uid: owner` alongside `isDirectory` / `isSymbolicLink`. Update the module doc's "three host facts" sentence to "four" and list the owner.

- [ ] **Step 2: Write the failing test**

Append inside `describe("US-001 — run temp root resolution (src/sandbox/session-tmp)", ...)` in `session-tmp.test.ts`:

```ts
  test("falls back when /tmp/nax is owned by another user, even if it is writable", () => {
    // A world-writable /tmp/nax another user created would let that user plant
    // symlinks or read what sandboxed commands write via $TMPDIR.
    stubSessionTmpDeps(_sessionTmpDeps, { parent: "directory", access: "ok", uid: 501, owner: 502 });

    expect(runTmpRoot("run-1")).toBe("/tmp/nax-501/run-1");
  });

  test("keeps the shared parent when the current user owns it", () => {
    stubSessionTmpDeps(_sessionTmpDeps, { parent: "directory", access: "ok", uid: 501, owner: 501 });

    expect(runTmpRoot("run-1")).toBe("/tmp/nax/run-1");
  });
```

- [ ] **Step 3: Run it to verify it fails**

Run (from `packages/nax-agent`): `timeout 30 bun test test/unit/sandbox/session-tmp.test.ts --timeout=5000`
Expected: the foreign-owner test FAILS (received `/tmp/nax/run-1`); the other passes.

- [ ] **Step 4: Implement**

In `session-tmp.ts`, change the first `try` block of `isUsableSharedParent`:

```ts
  try {
    const stats = _sessionTmpDeps.lstat(SHARED_TMP_PARENT);
    if (!stats.isDirectory() || stats.isSymbolicLink()) return false;
  } catch (err) {
```

to:

```ts
  try {
    const stats = _sessionTmpDeps.lstat(SHARED_TMP_PARENT);
    if (!stats.isDirectory() || stats.isSymbolicLink()) return false;
    // Writability is not trust: a 0777 /tmp/nax another user created lets that user
    // pre-create the run directories or read what sandboxed commands write there.
    if (stats.uid !== _sessionTmpDeps.uid()) return false;
  } catch (err) {
```

Update the function's doc comment ("True when `/tmp/nax` is a real directory the current user OWNS and can write and search.") and the module doc's "three host facts" sentence (lstat now also reports the owner).

- [ ] **Step 5: Run tests to verify they pass**

Run: `timeout 30 bun test test/unit/sandbox/ --timeout=5000`
Then, because `stubSessionTmpDeps` is shared, run the nax suites that use it (from `packages/nax`):
`timeout 60 bun test test/unit/agents/coding-tool-support-session-tmp.test.ts test/unit/agents/coding-tool-support-resolve.test.ts test/unit/execution/lifecycle/run-tmp-wipe.test.ts test/integration/execution/lifecycle/run-tmp-wipe.test.ts --timeout=5000`
Expected: PASS everywhere (owner defaults to uid).

Run (from `packages/test-kit`): `bun run typecheck && bun run check:all`.

- [ ] **Step 6: Commit**

```bash
git add packages/nax-agent/src/sandbox/session-tmp.ts packages/test-kit/src/bun/session-tmp-deps.ts packages/nax-agent/test/unit/sandbox/session-tmp.test.ts
git commit -m "fix(sandbox): trust a shared /tmp/nax only when the current user owns it (review #17)"
```

Known residual for the PR body (do not fix here): the per-user fallback `/tmp/nax-<uid>` is not ownership-checked either; a hostile user who pre-creates it gets the same position. Recommend a follow-up issue.

---

## Bundle wrap-up

Run the master plan's **Per-bundle PR checklist** with scope `nax-agent`. This bundle touches nax-agent, test-kit, and (via the shared stub) nax tests: run the nax gates too.
