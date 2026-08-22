/**
 * Unit tests for git utility functions (TC-003)
 *
 * Covers: detectMergeConflict helper, captureOutputFiles helper (ENH-005),
 * captureWorkingTreeChanges helper (US-003).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  _gitDeps,
  autoCommitIfDirty,
  captureOutputFiles,
  captureWorkingTreeChanges,
  detectMergeConflict,
  getUntrackedPaths,
  parsePorcelainForNaxPaths,
  parsePorcelainUntrackedPaths,
} from "@/utils/git";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

describe("detectMergeConflict", () => {
  // True positives — real git conflict signals
  test.each([
    ["CONFLICT (content): marker", "CONFLICT (content): Merge conflict in src/foo.ts"],
    ["CONFLICT (modify/delete) rebase output", "CONFLICT (modify/delete): src/bar.ts deleted in HEAD"],
    ["<<<<<<< conflict marker", "<<<<<<< HEAD\nconst x = 1;\n=======\nconst x = 2;\n>>>>>>> feature"],
    [">>>>>>> conflict marker", ">>>>>>> feature-branch"],
    ["Merge conflict in <file> message", "Merge conflict in src/index.ts"],
    [
      "typical merge output with CONFLICT",
      "Auto-merging src/index.ts\nCONFLICT (content): Merge conflict in src/index.ts\nAutomatic merge failed; fix conflicts and then commit the result.",
    ],
    ["combined stderr output", "stdout: commit abc123\nstderr: CONFLICT (content): Merge conflict in src/foo.ts"],
  ])("returns true for %s", (_label, output) => {
    expect(detectMergeConflict(output)).toBe(true);
  });

  // False positives — words that must NOT trigger the detector
  test.each([
    ["bare lowercase 'conflict'", "Auto-merging failed due to conflict in file"],
    ["HTTP 409 Conflict in agent output", "throw new HttpException('HTTP 409 Conflict: duplicate connection', 409)"],
    ["'already-synced conflict' wording", "// return 409 when there is a duplicate conflict"],
    ["CONFLICT without parenthesised type", "stderr: CONFLICT detected in merge"],
    ["no conflict markers", "All changes committed successfully."],
    ["empty string", ""],
    ["unrelated git output", "3 files changed, 10 insertions(+), 2 deletions(-)"],
  ])("returns false for %s", (_label, output) => {
    expect(detectMergeConflict(output)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// captureOutputFiles (ENH-005)
// ---------------------------------------------------------------------------

function mockSpawnOutput(output: string, exitCode = 0): typeof _gitDeps.spawn {
  return mock((_args: string[], _opts: unknown) => {
    const bytes = new TextEncoder().encode(output);
    return {
      stdout: new ReadableStream({
        start(c) {
          c.enqueue(bytes);
          c.close();
        },
      }),
      stderr: new ReadableStream({
        start(c) {
          c.close();
        },
      }),
      exited: Promise.resolve(exitCode),
      kill: mock(() => {}),
    };
  }) as typeof _gitDeps.spawn;
}

let origSpawn: typeof _gitDeps.spawn;
let origRetryTimeoutMs: number;
let origGetSafeLogger: typeof _gitDeps.getSafeLogger;

beforeEach(() => {
  origSpawn = _gitDeps.spawn;
  origRetryTimeoutMs = _gitDeps.timeoutRetryGitTimeoutMs;
  origGetSafeLogger = _gitDeps.getSafeLogger;
});

afterEach(() => {
  _gitDeps.spawn = origSpawn;
  _gitDeps.timeoutRetryGitTimeoutMs = origRetryTimeoutMs;
  _gitDeps.getSafeLogger = origGetSafeLogger;
  mock.restore();
});

describe("captureOutputFiles", () => {
  test("returns empty array when baseRef is undefined", async () => {
    const result = await captureOutputFiles("/tmp/repo", undefined);
    expect(result).toEqual([]);
  });

  test("returns files from git diff when baseRef is set", async () => {
    _gitDeps.spawn = mockSpawnOutput("src/index.ts\nsrc/utils.ts\n");
    const result = await captureOutputFiles("/tmp/repo", "abc123");
    expect(result).toEqual(["src/index.ts", "src/utils.ts"]);
  });

  test("passes baseRef in diff args", async () => {
    let capturedArgs: string[] = [];
    _gitDeps.spawn = mock((args: string[], _opts: unknown) => {
      capturedArgs = args as string[];
      const bytes = new TextEncoder().encode("src/a.ts\n");
      return {
        stdout: new ReadableStream({
          start(c) {
            c.enqueue(bytes);
            c.close();
          },
        }),
        stderr: new ReadableStream({
          start(c) {
            c.close();
          },
        }),
        exited: Promise.resolve(0),
        kill: mock(() => {}),
      };
    });
    await captureOutputFiles("/tmp/repo", "abc123");
    expect(capturedArgs).toContain("abc123..HEAD");
  });

  test("scopes to scopePrefix when provided", async () => {
    let capturedArgs: string[] = [];
    _gitDeps.spawn = mock((args: string[], _opts: unknown) => {
      capturedArgs = args as string[];
      const bytes = new TextEncoder().encode("apps/api/src/index.ts\n");
      return {
        stdout: new ReadableStream({
          start(c) {
            c.enqueue(bytes);
            c.close();
          },
        }),
        stderr: new ReadableStream({
          start(c) {
            c.close();
          },
        }),
        exited: Promise.resolve(0),
        kill: mock(() => {}),
      };
    });
    const result = await captureOutputFiles("/tmp/repo", "abc123", "apps/api");
    expect(capturedArgs).toContain("--");
    expect(capturedArgs).toContain("apps/api/");
    expect(result).toEqual(["apps/api/src/index.ts"]);
  });

  test("returns empty array on git spawn failure (non-fatal)", async () => {
    _gitDeps.spawn = mock(() => {
      throw new Error("git not found");
    });
    const result = await captureOutputFiles("/tmp/repo", "abc123");
    expect(result).toEqual([]);
  });

  test("filters out empty lines from output", async () => {
    _gitDeps.spawn = mockSpawnOutput("\nsrc/a.ts\n\nsrc/b.ts\n\n");
    const result = await captureOutputFiles("/tmp/repo", "abc123");
    expect(result).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("returns empty array when git diff produces no output", async () => {
    _gitDeps.spawn = mockSpawnOutput("");
    const result = await captureOutputFiles("/tmp/repo", "abc123");
    expect(result).toEqual([]);
  });

  // MED-04: captureOutputFiles previously spawned raw git with no deadline —
  // now routes through gitWithTimeout (same _gitDeps.spawn injection point,
  // so all the tests above are unaffected). A non-zero exit now correctly
  // discards any stray stdout instead of returning it as if it were real
  // changed-file output.
  test("MED-04: discards stdout when git diff exits non-zero", async () => {
    _gitDeps.spawn = mockSpawnOutput("src/stale-output.ts\n", 128);
    const result = await captureOutputFiles("/tmp/repo", "abc123");
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// captureDiffSummary — see git-capture-diff-summary.test.ts
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// captureWorkingTreeChanges (US-003 — timeout-retry working-tree diff)
// ---------------------------------------------------------------------------
//
// Unlike captureOutputFiles (which only diffs baseRef..HEAD, i.e. committed
// changes), this helper must include uncommitted working-tree state so the
// timeout-retry prompt can name files the timed-out agent edited without
// committing. Covers: tracked modifications vs HEAD, untracked files, and the
// pre-attempt ref→HEAD committed range.

function mockSequentialSpawn(outputs: string[]): typeof _gitDeps.spawn {
  let callIdx = 0;
  return mock((_args: unknown[], _opts: unknown) => {
    const out = outputs[callIdx++] ?? "";
    const bytes = new TextEncoder().encode(out);
    return {
      stdout: new ReadableStream({
        start(c) {
          c.enqueue(bytes);
          c.close();
        },
      }),
      stderr: new ReadableStream({
        start(c) {
          c.close();
        },
      }),
      exited: Promise.resolve(0),
      kill: mock(() => {}),
    };
  });
}

describe("captureWorkingTreeChanges", () => {
  test("returns empty array when baseRef is undefined", async () => {
    const result = await captureWorkingTreeChanges("/tmp/repo", undefined);
    expect(result).toEqual([]);
  });

  test("includes uncommitted tracked modifications against HEAD", async () => {
    // First call: diff baseRef..HEAD (committed range) — empty.
    // Second call: diff HEAD (uncommitted tracked) — includes modified tracked files.
    _gitDeps.spawn = mockSequentialSpawn(["", "src/modified.ts\n"]);
    const result = await captureWorkingTreeChanges("/tmp/repo", "abc123");
    expect(result).toEqual(["src/modified.ts"]);
  });

  test("includes untracked files via ls-files --others --exclude-standard", async () => {
    // First call: diff baseRef..HEAD — empty.
    // Second call: diff HEAD — empty.
    // Third call: ls-files --others --exclude-standard — new untracked files.
    _gitDeps.spawn = mockSequentialSpawn(["", "", "src/new.ts\n"]);
    const result = await captureWorkingTreeChanges("/tmp/repo", "abc123");
    expect(result).toEqual(["src/new.ts"]);
  });

  test("merges committed, uncommitted tracked, and untracked file lists (deduped)", async () => {
    // Committed: src/committed.ts
    // Uncommitted tracked: src/modified.ts (also in committed — dup)
    // Untracked: src/new.ts
    _gitDeps.spawn = mockSequentialSpawn(["src/committed.ts\nsrc/modified.ts\n", "src/modified.ts\n", "src/new.ts\n"]);
    const result = await captureWorkingTreeChanges("/tmp/repo", "abc123");
    expect(result).toEqual(["src/committed.ts", "src/modified.ts", "src/new.ts"]);
  });

  test("returns empty array on git spawn failure (non-fatal)", async () => {
    _gitDeps.spawn = mock(() => {
      throw new Error("git not found");
    });
    const result = await captureWorkingTreeChanges("/tmp/repo", "abc123");
    expect(result).toEqual([]);
  });

  test("scopes to scopePrefix when provided", async () => {
    const capturedArgs: string[][] = [];
    _gitDeps.spawn = mock((args: string[], _opts: unknown) => {
      capturedArgs.push(args as string[]);
      return {
        stdout: new ReadableStream({
          start(c) {
            c.close();
          },
        }),
        stderr: new ReadableStream({
          start(c) {
            c.close();
          },
        }),
        exited: Promise.resolve(0),
        kill: mock(() => {}),
      };
    });
    await captureWorkingTreeChanges("/tmp/repo", "abc123", "apps/api");
    // All three git calls must scope to apps/api.
    for (const args of capturedArgs) {
      expect(args).toContain("--");
      expect(args).toContain("apps/api/");
    }
  });

  test("does not stall when git subprocess hangs (SIGKILL after timeout)", async () => {
    // Adversarial review: a hung git must not stall timeout-retry recovery.
    // captureWorkingTreeChanges passes _gitDeps.timeoutRetryGitTimeoutMs (3s in
    // production) to gitWithTimeout, scoped separately from the general-purpose
    // GIT_TIMEOUT_MS (10s) so a slow retry-recovery capture can't shrink the
    // timeout for other gitWithTimeout callers. The mock simulates real
    // Bun.spawn behaviour: proc.kill() resolves the exited promise so the await
    // unblocks and the function returns the empty-on-failure contract.
    //
    // The timeout is injected down to 50ms — the contract under test is
    // "arms a timer, SIGKILLs on expiry, degrades to []", not the production
    // duration. Waiting the real 3s made this the slowest test in the suite.
    _gitDeps.timeoutRetryGitTimeoutMs = 50;
    let killCount = 0;
    _gitDeps.spawn = mock((_args: unknown[], _opts: unknown) => {
      let resolveExited: (code: number) => void = () => {};
      const proc = {
        stdout: new ReadableStream({
          start(c) {
            /* never closes */
          },
        }),
        stderr: new ReadableStream({
          start(c) {
            /* never closes */
          },
        }),
        exited: new Promise<number>((r) => {
          resolveExited = r;
        }),
        kill: () => {
          killCount++;
          resolveExited(137); // 128 + SIGKILL(9)
        },
      };
      return proc;
    });

    const start = Date.now();
    const result = await captureWorkingTreeChanges("/tmp/repo", "abc123");
    const elapsed = Date.now() - start;
    // Allow generous slack for CI; the injected timeout above is 50ms.
    expect(elapsed).toBeLessThan(5_000);
    // All three git subprocesses must be killed on timeout (one per diff call).
    expect(killCount).toBe(3);
    // Best-effort contract: hangs degrade to empty array.
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parsePorcelainForNaxPaths (US-002)
// ---------------------------------------------------------------------------
//
// Pure helper extracted from autoCommitIfDirty so it can be tested against real
// `git status --porcelain` strings rather than through a spawn mock. Returns
// the OLD path for renames so a `git checkout <old>` call restores the file
// where the agent last saw it. A path is "protected" iff its status is a
// deletion or a rename AND any segment of the path equals `.nax`.
//
// Detection is structural — a deletion or rename whose path lies under a
// `.nax/` segment is illegitimate for an agent session. This is broader than
// "the acceptance target" and deliberately so — it also protects `prd.json`,
// `checkpoint.jsonl`, and `acceptance-meta.json`.

describe("parsePorcelainForNaxPaths", () => {
  function paths(result: ReturnType<typeof parsePorcelainForNaxPaths>): string[] {
    return result.map((r) => r.path);
  }

  test("returns a deleted .nax/ path as protected", () => {
    const output = " D apps/web/.nax/features/f/.nax-acceptance.test.tsx\n";
    expect(paths(parsePorcelainForNaxPaths(output))).toEqual(["apps/web/.nax/features/f/.nax-acceptance.test.tsx"]);
  });

  test("returns a staged-deleted .nax/ path (D ) as protected", () => {
    // AC: any deletion under .nax/ must restore. `D ` is the staged-deletion
    // status (e.g. after `git rm .nax/...`) and must be treated identically
    // to ` D`. The auto-commit runs `git add -A`, which keeps a staged
    // deletion staged, so a missed `D ` line would still be lost.
    const output = "D  apps/web/.nax/features/f/.nax-acceptance.test.tsx\n";
    expect(paths(parsePorcelainForNaxPaths(output))).toEqual(["apps/web/.nax/features/f/.nax-acceptance.test.tsx"]);
  });

  test("flags a staged-deleted .nax/ path with staged=true", () => {
    // The caller needs the staged flag to choose between `git checkout --`
    // (index) and `git checkout HEAD --` (HEAD). For `D ` the index already
    // records the deletion, so HEAD is the only source that still has the
    // file.
    const output = "D  .nax/features/f/.nax-acceptance.test.tsx\n";
    const result = parsePorcelainForNaxPaths(output);
    expect(result).toHaveLength(1);
    expect(result[0].staged).toBe(true);
  });

  test("flags an unstaged-deleted .nax/ path with staged=false", () => {
    const output = " D .nax/features/f/.nax-acceptance.test.tsx\n";
    const result = parsePorcelainForNaxPaths(output);
    expect(result).toHaveLength(1);
    expect(result[0].staged).toBe(false);
  });

  test("returns a double-delete .nax/ path (DD) as protected", () => {
    const output = "DD apps/web/.nax/features/f/.nax-acceptance.test.tsx\n";
    expect(paths(parsePorcelainForNaxPaths(output))).toEqual(["apps/web/.nax/features/f/.nax-acceptance.test.tsx"]);
  });

  test("returns the OLD path when a rename moves a file out of .nax/", () => {
    // Rename: status 'R ', then "old -> new". We restore the old path because
    // that is where the agent last saw the file in HEAD.
    const output = " R .nax/features/f/.nax-acceptance.test.tsx -> src/orphan.test.tsx\n";
    expect(paths(parsePorcelainForNaxPaths(output))).toEqual([".nax/features/f/.nax-acceptance.test.tsx"]);
  });

  test("returns no protected paths for a modified .nax/ file", () => {
    // Modifications are agent edits; only deletions/renames are treated as
    // stray-agent mistakes that need restoring.
    const output = " M .nax/features/f/notes.md\n";
    expect(parsePorcelainForNaxPaths(output)).toEqual([]);
  });

  test("returns no protected paths for deletions outside .nax/", () => {
    const output = " D src/legacy.ts\n";
    expect(parsePorcelainForNaxPaths(output)).toEqual([]);
  });

  test("unquotes a deleted .nax/ path containing a space", () => {
    // git quotes paths with special characters, wrapping them in double quotes
    // and escaping backslashes/quotes inside. We must unquote before the
    // `git checkout <path>` call so the path resolves correctly.
    const output = ' D ".nax/features/f name/file.tsx"\n';
    expect(paths(parsePorcelainForNaxPaths(output))).toEqual([".nax/features/f name/file.tsx"]);
  });

  test("decodes octal escapes for a deleted .nax/ path with non-ASCII bytes", () => {
    // With `core.quotePath=true` (the default), git encodes non-ASCII bytes
    // as octal escapes inside the quoted path: `café` becomes `caf\303\251`.
    // A naive unquote that only handles `\"` and `\\` leaves the escapes in
    // place and the path no longer resolves. The decoded path must round-trip
    // to the actual UTF-8 bytes that exist on disk.
    const output = ' D ".nax/caf\\303\\251/file.tsx"\n';
    const result = paths(parsePorcelainForNaxPaths(output));
    expect(result).toHaveLength(1);
    // .nax/café/file.tsx in UTF-8: 'caf' + 0xC3 0xA9 + '/file.tsx'
    expect(result[0]).toBe(
      Buffer.from([
        0x2e, 0x6e, 0x61, 0x78, 0x2f, 0x63, 0x61, 0x66, 0xc3, 0xa9, 0x2f, 0x66, 0x69, 0x6c, 0x65, 0x2e, 0x74, 0x73,
        0x78,
      ]).toString(),
    );
    // The decoded path must contain the literal `.nax` segment (octal-decoded
    // bytes must not leak into the structural check).
    expect(result[0]).toContain(".nax/");
    expect(result[0]).not.toContain("\\303");
  });

  test("splits a rename on the unquoted ` -> ` boundary, not inside a quoted path", () => {
    // A rename whose OLD path is itself quoted AND contains the literal
    // sequence ` -> ` must split at the boundary outside the quotes, not at
    // the arrow inside the filename. Here the OLD path is literally
    // `foo -> bar.txt`; truncating at the first ` -> ` would yield `foo`.
    const output = ' R ".nax/features/f/foo -> bar.txt" -> src/elsewhere.txt\n';
    expect(paths(parsePorcelainForNaxPaths(output))).toEqual([".nax/features/f/foo -> bar.txt"]);
  });

  test("skips an uninterpretable line and still returns a deleted .nax/ path", () => {
    // Defensive: malformed status (single char) is not a deletion/rename, so
    // we ignore it. A subsequent deleted .nax/ path must still be parsed.
    const output = "??bogus\n D .nax/features/f/file.tsx\n";
    expect(paths(parsePorcelainForNaxPaths(output))).toEqual([".nax/features/f/file.tsx"]);
  });

  test("returns empty array on empty porcelain output", () => {
    expect(parsePorcelainForNaxPaths("")).toEqual([]);
    expect(parsePorcelainForNaxPaths("\n")).toEqual([]);
  });

  test("returns multiple protected paths in input order", () => {
    const output = [
      " D .nax/features/a/file.tsx",
      " D src/unrelated.ts",
      " R .nax/prd.json -> /tmp/leak.json",
      " D .nax/checkpoint.jsonl",
    ].join("\n");
    expect(paths(parsePorcelainForNaxPaths(output))).toEqual([
      ".nax/features/a/file.tsx",
      ".nax/prd.json",
      ".nax/checkpoint.jsonl",
    ]);
  });
});

// ---------------------------------------------------------------------------
// autoCommitIfDirty .nax/ restore (US-002)
// ---------------------------------------------------------------------------
//
// The auto-commit safety net must restore deleted/renamed .nax/ paths before
// `git add -A` sweeps them onto the branch. All subprocess spawning goes
// through `_gitDeps.spawn` so we can assert the sequence of git calls without
// touching real git. The logger is injected via `_gitDeps.getSafeLogger`.
//
// Spawn sequence for a typical run:
//   1. `git rev-parse --show-toplevel` — guard against non-repo workdirs
//   2. `git status --porcelain` — read working-tree state
//   3. (NEW) `git checkout -- <path>` — one call per deleted .nax/ path
//   4. `git add -A` — stage
//   5. `git commit -m ...` — commit

interface CapturedCall {
  args: string[];
  cwd?: string;
}

function captureSpawn(outputs: Array<{ output: string; exitCode?: number; stderr?: string }>): {
  spawn: typeof _gitDeps.spawn;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  let callIdx = 0;
  const spawn = mock((args: unknown[], opts: { cwd?: string } = {}) => {
    calls.push({ args: args as string[], cwd: opts.cwd });
    const spec = outputs[callIdx++] ?? { output: "", exitCode: 0 };
    const bytes = new TextEncoder().encode(spec.output);
    const stderrBytes = new TextEncoder().encode(spec.stderr ?? "");
    return {
      stdout: new ReadableStream({
        start(c) {
          c.enqueue(bytes);
          c.close();
        },
      }),
      stderr: new ReadableStream({
        start(c) {
          c.enqueue(stderrBytes);
          c.close();
        },
      }),
      exited: Promise.resolve(spec.exitCode ?? 0),
      kill: mock(() => {}),
    };
  }) as typeof _gitDeps.spawn;
  return { spawn, calls };
}

describe("autoCommitIfDirty .nax/ restore", () => {
  test("runs git checkout for a deleted .nax/ file before git add", async () => {
    // First call: rev-parse -> returns gitRoot
    // Second call: git status --porcelain -> reports a deleted .nax/ file
    // Third call: git checkout -> restores it
    // Fourth call: git add -A
    // Fifth call: git commit -m ...
    const { spawn, calls } = captureSpawn([
      { output: "/tmp/repo\n" }, // rev-parse
      { output: " D .nax/features/f/.nax-acceptance.test.tsx\n" }, // status
      { output: "" }, // checkout
      { output: "" }, // add
      { output: "" }, // commit
    ]);
    _gitDeps.spawn = spawn;

    await autoCommitIfDirty("/tmp/repo", "test", "implementer", "US-002");

    // Order matters: checkout MUST come before add
    const checkoutIdx = calls.findIndex((c) => c.args[0] === "git" && c.args[1] === "checkout");
    const addIdx = calls.findIndex((c) => c.args[0] === "git" && c.args[1] === "add");
    const commitIdx = calls.findIndex((c) => c.args[0] === "git" && c.args[1] === "commit");
    expect(checkoutIdx).toBeGreaterThanOrEqual(0);
    expect(addIdx).toBeGreaterThan(checkoutIdx);
    expect(commitIdx).toBeGreaterThan(addIdx);
    // The checkout command targets the deleted path
    const checkoutCall = calls[checkoutIdx];
    expect(checkoutCall.args).toContain(".nax/features/f/.nax-acceptance.test.tsx");
  });

  test("logs an error with storyId as the first field when restoring .nax/ paths", async () => {
    const { spawn } = captureSpawn([
      { output: "/tmp/repo\n" },
      { output: " D .nax/features/f/.nax-acceptance.test.tsx\n" },
      { output: "" }, // checkout
      { output: "" }, // add
      { output: "" }, // commit
    ]);
    _gitDeps.spawn = spawn;

    const errorCalls: Array<{ message: string; data: Record<string, unknown> }> = [];
    _gitDeps.getSafeLogger = () => ({
      error: (stage: string, message: string, data?: Record<string, unknown>) => {
        errorCalls.push({ message, data: data ?? {} });
      },
      warn: () => {},
      info: () => {},
      debug: () => {},
    });

    await autoCommitIfDirty("/tmp/repo", "test", "implementer", "US-002");

    expect(errorCalls.length).toBeGreaterThan(0);
    for (const call of errorCalls) {
      // storyId must be the FIRST key in the data payload
      const keys = Object.keys(call.data);
      expect(keys[0]).toBe("storyId");
      expect(call.data.storyId).toBe("US-002");
    }
  });

  test("logs an error with the exit code and stderr when the restore checkout fails", async () => {
    const { spawn } = captureSpawn([
      { output: "/tmp/repo\n" },
      { output: " D .nax/features/f/.nax-acceptance.test.tsx\n" },
      { output: "", exitCode: 128, stderr: "error: pathspec did not match" }, // checkout fails
      { output: "" }, // add
      { output: "" }, // commit
    ]);
    _gitDeps.spawn = spawn;

    const errorCalls: Array<{ message: string; data: Record<string, unknown> }> = [];
    _gitDeps.getSafeLogger = () => ({
      error: (stage: string, message: string, data?: Record<string, unknown>) => {
        errorCalls.push({ message, data: data ?? {} });
      },
      warn: () => {},
      info: () => {},
      debug: () => {},
    });

    await autoCommitIfDirty("/tmp/repo", "test", "implementer", "US-002");

    expect(errorCalls.length).toBeGreaterThan(0);
    const failureLog = errorCalls.find((c) => c.data.exitCode === 128);
    expect(failureLog).toBeDefined();
    expect(failureLog!.data.storyId).toBe("US-002");
    expect(failureLog!.data.stderr).toContain("pathspec");
  });

  test("spawns the restore checkout from the repo root, not a monorepo package subdir", async () => {
    // git status --porcelain paths are repo-root-relative regardless of the cwd
    // git was invoked from, so the restore checkout must also run from the repo
    // root — matching the `git add -A` staging call — or the pathspec silently
    // fails to match from a package subdir. Real directories are used (rather
    // than the "/tmp/repo" convention above) so realpathSync resolves the root
    // and the subdir consistently, exercising the actual isSubdir branch.
    const repoRoot = makeTempDir("nax-git-root-");
    const packageDir = path.join(repoRoot, "apps", "web");
    await fs.mkdir(packageDir, { recursive: true });
    try {
      const realRepoRoot = realpathSync(repoRoot);
      const { spawn, calls } = captureSpawn([
        { output: `${realRepoRoot}\n` }, // rev-parse --show-toplevel
        { output: " D apps/web/.nax/features/f/.nax-acceptance.test.tsx\n" }, // status
        { output: "" }, // checkout
        { output: "" }, // add
        { output: "" }, // commit
      ]);
      _gitDeps.spawn = spawn;

      await autoCommitIfDirty(packageDir, "test", "implementer", "US-002");

      const checkoutCall = calls.find((c) => c.args[0] === "git" && c.args[1] === "checkout");
      expect(checkoutCall).toBeDefined();
      expect(checkoutCall!.cwd).toBe(realRepoRoot);
    } finally {
      cleanupTempDir(repoRoot);
    }
  });

  test("does not run git checkout when only changes outside .nax/ are dirty", async () => {
    const { spawn, calls } = captureSpawn([
      { output: "/tmp/repo\n" },
      { output: " M src/foo.ts\n" }, // status — only a tracked modification outside .nax/
      { output: "" }, // add
      { output: "" }, // commit
    ]);
    _gitDeps.spawn = spawn;

    await autoCommitIfDirty("/tmp/repo", "test", "implementer", "US-002");

    const checkoutCalls = calls.filter((c) => c.args[0] === "git" && c.args[1] === "checkout");
    expect(checkoutCalls.length).toBe(0);
    // But commit still runs
    const commitCalls = calls.filter((c) => c.args[0] === "git" && c.args[1] === "commit");
    expect(commitCalls.length).toBe(1);
  });

  test("continues to git add and git commit when checkout exits non-zero", async () => {
    const { spawn, calls } = captureSpawn([
      { output: "/tmp/repo\n" },
      { output: " D .nax/features/f/.nax-acceptance.test.tsx\n" },
      { output: "", exitCode: 128 }, // checkout — file not in HEAD, fails
      { output: "" }, // add — must still run
      { output: "" }, // commit — must still run
    ]);
    _gitDeps.spawn = spawn;

    await autoCommitIfDirty("/tmp/repo", "test", "implementer", "US-002");

    const addCalls = calls.filter((c) => c.args[0] === "git" && c.args[1] === "add");
    const commitCalls = calls.filter((c) => c.args[0] === "git" && c.args[1] === "commit");
    expect(addCalls.length).toBe(1);
    expect(commitCalls.length).toBe(1);
  });

  test("uses git checkout HEAD -- <path> for a staged deletion (D )", async () => {
    // A staged deletion means the index already records the deletion, so a bare
    // `git checkout -- <path>` cannot restore it (the index says the file is
    // gone). Restoring from HEAD brings the file back into the worktree AND
    // the index. Without this, the snapshot auto-commit would still sweep a
    // `git rm`-deleted .nax/ file onto the branch.
    const { spawn, calls } = captureSpawn([
      { output: "/tmp/repo\n" }, // rev-parse
      { output: "D  .nax/features/f/.nax-acceptance.test.tsx\n" }, // status — staged delete
      { output: "" }, // checkout HEAD --
      { output: "" }, // add
      { output: "" }, // commit
    ]);
    _gitDeps.spawn = spawn;

    await autoCommitIfDirty("/tmp/repo", "test", "implementer", "US-002");

    const checkoutCall = calls.find((c) => c.args[0] === "git" && c.args[1] === "checkout");
    expect(checkoutCall).toBeDefined();
    // The `HEAD` token MUST appear so the index-level deletion is bypassed.
    expect(checkoutCall!.args).toContain("HEAD");
    expect(checkoutCall!.args).toContain("--");
    expect(checkoutCall!.args).toContain(".nax/features/f/.nax-acceptance.test.tsx");
  });

  test("uses git checkout HEAD -- <path> for a staged rename (R )", async () => {
    // The OLD path is gone from the index (only the NEW path is there). Bare
    // `git checkout -- <old>` fails; `git checkout HEAD -- <old>` works.
    const { spawn, calls } = captureSpawn([
      { output: "/tmp/repo\n" },
      { output: "R  .nax/features/f/.nax-acceptance.test.tsx -> src/leak.tsx\n" },
      { output: "" }, // checkout HEAD --
      { output: "" }, // add
      { output: "" }, // commit
    ]);
    _gitDeps.spawn = spawn;

    await autoCommitIfDirty("/tmp/repo", "test", "implementer", "US-002");

    const checkoutCall = calls.find((c) => c.args[0] === "git" && c.args[1] === "checkout");
    expect(checkoutCall).toBeDefined();
    expect(checkoutCall!.args).toContain("HEAD");
    // Restoring the OLD path (not the new one)
    expect(checkoutCall!.args).toContain(".nax/features/f/.nax-acceptance.test.tsx");
    expect(checkoutCall!.args).not.toContain("src/leak.tsx");
  });

  test("uses plain git checkout -- <path> for an unstaged deletion ( D)", async () => {
    // The index still has the file — restore from the index. Adding HEAD here
    // would be unnecessary and changes semantics for the unstaged case.
    const { spawn, calls } = captureSpawn([
      { output: "/tmp/repo\n" },
      { output: " D .nax/features/f/.nax-acceptance.test.tsx\n" },
      { output: "" },
      { output: "" },
      { output: "" },
    ]);
    _gitDeps.spawn = spawn;

    await autoCommitIfDirty("/tmp/repo", "test", "implementer", "US-002");

    const checkoutCall = calls.find((c) => c.args[0] === "git" && c.args[1] === "checkout");
    expect(checkoutCall).toBeDefined();
    expect(checkoutCall!.args).not.toContain("HEAD");
    expect(checkoutCall!.args).toContain("--");
  });
});

// ---------------------------------------------------------------------------
// parsePorcelainUntrackedPaths + getUntrackedPaths (BUG-07)
// ---------------------------------------------------------------------------

describe("parsePorcelainUntrackedPaths", () => {
  test("returns untracked paths from '?? path' lines", () => {
    const porcelain = "?? stray-agent-file.ts\n?? scratch/notes.md\n";
    expect(parsePorcelainUntrackedPaths(porcelain)).toEqual(["stray-agent-file.ts", "scratch/notes.md"]);
  });

  test("ignores non-untracked status lines", () => {
    const porcelain = " M src/index.ts\nA  src/new.ts\n?? actually-untracked.ts\n";
    expect(parsePorcelainUntrackedPaths(porcelain)).toEqual(["actually-untracked.ts"]);
  });

  test("unquotes a quoted path (space-containing filename)", () => {
    const porcelain = '?? "with space.ts"\n';
    expect(parsePorcelainUntrackedPaths(porcelain)).toEqual(["with space.ts"]);
  });

  test("returns an empty array for empty or all-clean porcelain output", () => {
    expect(parsePorcelainUntrackedPaths("")).toEqual([]);
    expect(parsePorcelainUntrackedPaths(" M src/index.ts\n")).toEqual([]);
  });
});

describe("getUntrackedPaths", () => {
  test("spawns git status --porcelain and parses the untracked entries", async () => {
    _gitDeps.spawn = mockSpawnOutput("?? new-file.ts\n?? dir/other.ts\n");
    const result = await getUntrackedPaths("/tmp/repo");
    expect(result).toEqual(["new-file.ts", "dir/other.ts"]);
    const call = (_gitDeps.spawn as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toEqual(["git", "status", "--porcelain"]);
  });

  test("returns an empty array for a clean working tree", async () => {
    _gitDeps.spawn = mockSpawnOutput("");
    expect(await getUntrackedPaths("/tmp/repo")).toEqual([]);
  });

  test("returns null (not []) when git status fails — a failed read must not look like a clean tree", async () => {
    _gitDeps.spawn = mockSpawnOutput("fatal: not a git repository", 128);
    expect(await getUntrackedPaths("/tmp/repo")).toBeNull();
  });
});
