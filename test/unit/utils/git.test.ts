/**
 * Unit tests for git utility functions (TC-003)
 *
 * Covers: detectMergeConflict helper, captureOutputFiles helper (ENH-005),
 * captureWorkingTreeChanges helper (US-003).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  _gitDeps,
  autoCommitIfDirty,
  captureOutputFiles,
  captureWorkingTreeChanges,
  detectMergeConflict,
  parsePorcelainForNaxPaths,
} from "@/utils/git";

describe("detectMergeConflict", () => {
  // True positives — real git conflict signals
  test.each([
    ["CONFLICT (content): marker", "CONFLICT (content): Merge conflict in src/foo.ts"],
    ["CONFLICT (modify/delete) rebase output", "CONFLICT (modify/delete): src/bar.ts deleted in HEAD"],
    ["<<<<<<< conflict marker", "<<<<<<< HEAD\nconst x = 1;\n=======\nconst x = 2;\n>>>>>>> feature"],
    [">>>>>>> conflict marker", ">>>>>>> feature-branch"],
    ["Merge conflict in <file> message", "Merge conflict in src/index.ts"],
    ["typical merge output with CONFLICT", "Auto-merging src/index.ts\nCONFLICT (content): Merge conflict in src/index.ts\nAutomatic merge failed; fix conflicts and then commit the result."],
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

function mockSpawnOutput(output: string, exitCode = 0) {
  return mock((_args: string[], _opts: unknown) => {
    const bytes = new TextEncoder().encode(output);
    return {
      stdout: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }),
      stderr: new ReadableStream({ start(c) { c.close(); } }),
      exited: Promise.resolve(exitCode),
      kill: mock(() => {}),
    };
  });
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
        stdout: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
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
        stdout: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
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
    _gitDeps.spawn = mock(() => { throw new Error("git not found"); });
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
});

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
      stdout: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }),
      stderr: new ReadableStream({ start(c) { c.close(); } }),
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
    _gitDeps.spawn = mockSequentialSpawn([
      "src/committed.ts\nsrc/modified.ts\n",
      "src/modified.ts\n",
      "src/new.ts\n",
    ]);
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
    let capturedArgs: string[][] = [];
    _gitDeps.spawn = mock((args: string[], _opts: unknown) => {
      capturedArgs.push(args as string[]);
      return {
        stdout: new ReadableStream({ start(c) { c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
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
        stdout: new ReadableStream({ start(c) { /* never closes */ } }),
        stderr: new ReadableStream({ start(c) { /* never closes */ } }),
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
  test("returns a deleted .nax/ path as protected", () => {
    const output = " D apps/web/.nax/features/f/.nax-acceptance.test.tsx\n";
    expect(parsePorcelainForNaxPaths(output)).toEqual([
      "apps/web/.nax/features/f/.nax-acceptance.test.tsx",
    ]);
  });

  test("returns the OLD path when a rename moves a file out of .nax/", () => {
    // Rename: status 'R ', then "old -> new". We restore the old path because
    // that is where the agent last saw the file in HEAD.
    const output = " R .nax/features/f/.nax-acceptance.test.tsx -> src/orphan.test.tsx\n";
    expect(parsePorcelainForNaxPaths(output)).toEqual([
      ".nax/features/f/.nax-acceptance.test.tsx",
    ]);
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
    expect(parsePorcelainForNaxPaths(output)).toEqual([
      ".nax/features/f name/file.tsx",
    ]);
  });

  test("skips an uninterpretable line and still returns a deleted .nax/ path", () => {
    // Defensive: malformed status (single char) is not a deletion/rename, so
    // we ignore it. A subsequent deleted .nax/ path must still be parsed.
    const output = "??bogus\n D .nax/features/f/file.tsx\n";
    expect(parsePorcelainForNaxPaths(output)).toEqual([
      ".nax/features/f/file.tsx",
    ]);
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
    expect(parsePorcelainForNaxPaths(output)).toEqual([
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
}

function captureSpawn(outputs: Array<{ output: string; exitCode?: number }>): {
  spawn: typeof _gitDeps.spawn;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  let callIdx = 0;
  const spawn = mock((args: unknown[], _opts: unknown) => {
    calls.push({ args: args as string[] });
    const spec = outputs[callIdx++] ?? { output: "", exitCode: 0 };
    const bytes = new TextEncoder().encode(spec.output);
    return {
      stdout: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }),
      stderr: new ReadableStream({ start(c) { c.close(); } }),
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
    const checkoutIdx = calls.findIndex((c) =>
      c.args[0] === "git" && c.args[1] === "checkout"
    );
    const addIdx = calls.findIndex((c) =>
      c.args[0] === "git" && c.args[1] === "add"
    );
    const commitIdx = calls.findIndex((c) =>
      c.args[0] === "git" && c.args[1] === "commit"
    );
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

  test("does not run git checkout when only changes outside .nax/ are dirty", async () => {
    const { spawn, calls } = captureSpawn([
      { output: "/tmp/repo\n" },
      { output: " M src/foo.ts\n" }, // status — only a tracked modification outside .nax/
      { output: "" }, // add
      { output: "" }, // commit
    ]);
    _gitDeps.spawn = spawn;

    await autoCommitIfDirty("/tmp/repo", "test", "implementer", "US-002");

    const checkoutCalls = calls.filter((c) =>
      c.args[0] === "git" && c.args[1] === "checkout"
    );
    expect(checkoutCalls.length).toBe(0);
    // But commit still runs
    const commitCalls = calls.filter((c) =>
      c.args[0] === "git" && c.args[1] === "commit"
    );
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

    const addCalls = calls.filter((c) =>
      c.args[0] === "git" && c.args[1] === "add"
    );
    const commitCalls = calls.filter((c) =>
      c.args[0] === "git" && c.args[1] === "commit"
    );
    expect(addCalls.length).toBe(1);
    expect(commitCalls.length).toBe(1);
  });
});

