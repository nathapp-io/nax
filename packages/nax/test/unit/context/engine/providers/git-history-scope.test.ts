/**
 * GitHistoryProvider — historyScope and path-frame tests (AC-55)
 *
 * Split from git-history.test.ts on the 800-line test limit. This file owns the
 * scope post-filter, the repo/package frame split, and the ambiguity probe;
 * git-history.test.ts keeps core behaviour, attribution and diagnostics.
 *
 * All git calls are intercepted via _gitHistoryDeps injection.
 * No real git process is spawned.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeLogger } from "@test/helpers";
import type { GitHistoryProviderOptions } from "@/context/engine/providers/git-history";
import { _gitHistoryDeps, GitHistoryProvider } from "@/context/engine/providers/git-history";
import type { ContextRequest } from "@/context/engine/types";

let origGitWithTimeout: typeof _gitHistoryDeps.gitWithTimeout;
let origGetLogger: typeof _gitHistoryDeps.getLogger;

beforeEach(() => {
  origGitWithTimeout = _gitHistoryDeps.gitWithTimeout;
  origGetLogger = _gitHistoryDeps.getLogger;
});

afterEach(() => {
  _gitHistoryDeps.gitWithTimeout = origGitWithTimeout;
  _gitHistoryDeps.getLogger = origGetLogger;
});

function makeRequest(overrides: Partial<ContextRequest> = {}): ContextRequest {
  return {
    storyId: "US-001",
    repoRoot: "/repo",
    packageDir: "/repo",
    stage: "execution",
    role: "implementer",
    budgetTokens: 8_000,
    ...overrides,
  };
}

function mockGit(responses: Map<string, { stdout: string; stderr?: string; exitCode: number }>) {
  _gitHistoryDeps.gitWithTimeout = async (args: string[], _workdir: string) => {
    const fileArg = args[args.length - 1] ?? "";
    const r = responses.get(fileArg) ?? { stdout: "", exitCode: 0 };
    return { stderr: "", ...r };
  };
}

describe("GitHistoryProvider — AC-55 historyScope", () => {
  const MONOREPO_REQUEST: ContextRequest = {
    storyId: "US-002",
    repoRoot: "/repo",
    packageDir: "/repo/packages/api",
    storyWorkdir: "packages/api",
    stage: "execution",
    role: "implementer",
    budgetTokens: 8_000,
    touchedFiles: ["packages/api/src/service.ts"],
  };

  /** Captures (args, cwd) per git invocation; returns success for every file. */
  function captureInvocations(): Array<{ args: string[]; cwd: string }> {
    const captured: Array<{ args: string[]; cwd: string }> = [];
    _gitHistoryDeps.gitWithTimeout = async (args: string[], cwd: string) => {
      captured.push({ args, cwd });
      return { stdout: "abc1234 feat: something", stderr: "", exitCode: 0 };
    };
    return captured;
  }

  test("default historyScope is 'package' — git ALWAYS runs in repoRoot", async () => {
    const invocations = captureInvocations();
    const p = new GitHistoryProvider();
    await p.fetch(MONOREPO_REQUEST);
    expect(invocations[0]?.cwd).toBe("/repo");
  });

  test("historyScope 'repo' — git runs in repoRoot with the repo-rooted pathspec", async () => {
    const invocations = captureInvocations();
    const p = new GitHistoryProvider({ historyScope: "repo" } as GitHistoryProviderOptions);
    await p.fetch(MONOREPO_REQUEST);
    expect(invocations[0]?.cwd).toBe("/repo");
    expect(invocations[0]?.args).toContain("packages/api/src/service.ts");
  });

  test("historyScope 'package' — cwd is STILL repoRoot, pathspec still repo-rooted", async () => {
    const invocations = captureInvocations();
    const p = new GitHistoryProvider({ historyScope: "package" } as GitHistoryProviderOptions);
    await p.fetch(MONOREPO_REQUEST);
    expect(invocations[0]?.cwd).toBe("/repo");
    expect(invocations[0]?.args).toContain("packages/api/src/service.ts");
  });

  test("historyScope 'package' — a file outside the package is filtered out, never queried", async () => {
    const queried: string[] = [];
    _gitHistoryDeps.gitWithTimeout = async (args: string[], _cwd: string) => {
      queried.push(args[args.length - 1] ?? "");
      return { stdout: "abc1234 feat: something", stderr: "", exitCode: 0 };
    };
    const p = new GitHistoryProvider({ historyScope: "package" } as GitHistoryProviderOptions);
    await p.fetch({
      ...MONOREPO_REQUEST,
      touchedFiles: ["packages/api/src/service.ts", "package.json"],
    });
    expect(queried).toEqual(["packages/api/src/service.ts"]);
  });

  test("sharper variant: a root-level src/client.ts is NOT returned under a packages/api story", async () => {
    // A root-level src/client.ts exists. Under the OLD "repo"-scope code a
    // package-framed "src/client.ts" resolved at repoRoot and surfaced the ROOT
    // file's history under the story's label. Under the new contract the
    // package post-filter must drop the root-level path before git is called.
    const queried: string[] = [];
    _gitHistoryDeps.gitWithTimeout = async (args: string[], _cwd: string) => {
      const fileArg = args[args.length - 1] ?? "";
      queried.push(fileArg);
      // The root-level file's history — would corrupt attribution if queried.
      const stdout =
        fileArg === "src/client.ts" ? "abc1234 root-level client history" : "abc1234 package client history";
      return { stdout, stderr: "", exitCode: 0 };
    };
    const p = new GitHistoryProvider({ historyScope: "package" } as GitHistoryProviderOptions);
    const result = await p.fetch({
      ...MONOREPO_REQUEST,
      touchedFiles: ["packages/api/src/client.ts", "src/client.ts"],
    });
    expect(queried).toEqual(["packages/api/src/client.ts"]);
    expect(result.chunks[0]?.content).not.toContain("root-level client history");
  });

  test("historyScope 'repo' — an ambiguous legacy spelling colliding at the repo root is dropped, not queried", async () => {
    // M13: under "repo" scope every file is queried at repoRoot, so a pre-#2067
    // package-relative legacy spelling ("src/client.ts" for a packages/api
    // story) resolves the ROOT file and surfaces its history under the story's
    // label. When the same spelling ALSO resolves under the package, the two
    // readings are indistinguishable and the root answer is the wrong one:
    // disambiguate by dropping it (and logging), rather than assume repo-rooted.
    const queried: string[] = [];
    _gitHistoryDeps.gitWithTimeout = async (args: string[], _cwd: string) => {
      const fileArg = args[args.length - 1] ?? "";
      // Both spellings have history, so "src/client.ts" is ambiguous.
      if (args.includes("-1")) return { stdout: "abc1234 a commit", stderr: "", exitCode: 0 };
      queried.push(fileArg);
      const stdout =
        fileArg === "src/client.ts" ? "abc1234 root-level client history" : "abc1234 package client history";
      return { stdout, stderr: "", exitCode: 0 };
    };
    const logger = makeLogger();
    _gitHistoryDeps.getLogger = () => logger;

    const p = new GitHistoryProvider({ historyScope: "repo" } as GitHistoryProviderOptions);
    const result = await p.fetch({
      ...MONOREPO_REQUEST,
      touchedFiles: ["packages/api/src/client.ts", "src/client.ts"],
    });

    expect(queried).toEqual(["packages/api/src/client.ts"]);
    expect(result.chunks[0]?.content).not.toContain("root-level client history");
    const dropWarn = logger.calls.find((call) => call.message.includes("colliding"));
    expect(dropWarn?.data).toMatchObject({
      storyId: "US-002",
      packageDir: "/repo/packages/api",
      workdir: "packages/api",
      count: 1,
      files: ["src/client.ts"],
    });
  });

  test("historyScope 'repo' — a DELETED root file still collides: ambiguity is about history, not the disk", async () => {
    // The collision probe gates `git log --follow`, which reports HISTORY. A
    // root-level src/client.ts deleted last month has no on-disk presence but a
    // full history, and the package's src/client.ts may be a file this story is
    // about to CREATE. A working-tree probe sees neither, reports no
    // collision, and the root file's history is attributed to this story --
    // exactly the #2088 sharper variant the drop exists to close.
    const queried: string[] = [];
    _gitHistoryDeps.gitWithTimeout = async (args: string[], _cwd: string) => {
      const fileArg = args[args.length - 1] ?? "";
      // `-1` marks the collision probe; anything else is a real history fetch.
      if (args.includes("-1")) {
        // BOTH spellings have history, though neither file is on disk now.
        return { stdout: "abc1234 a commit", stderr: "", exitCode: 0 };
      }
      queried.push(fileArg);
      return { stdout: "abc1234 root-level client history", stderr: "", exitCode: 0 };
    };
    const logger = makeLogger();
    _gitHistoryDeps.getLogger = () => logger;

    const p = new GitHistoryProvider({ historyScope: "repo" } as GitHistoryProviderOptions);
    const result = await p.fetch({ ...MONOREPO_REQUEST, touchedFiles: ["src/client.ts"] });

    expect(queried).not.toContain("src/client.ts");
    expect(result.chunks[0]?.content ?? "").not.toContain("root-level client history");
    expect(logger.calls.some((call) => call.message.includes("colliding"))).toBe(true);
  });

  test("historyScope 'repo' — a canonical set keeps a genuine repo-rooted path, no collision probe", async () => {
    // contextFilesCanonical asserts the plan-time write seam re-spelled every
    // existing path, so an out-of-package file is genuinely repo-rooted. Even
    // with a same-named file under the package, the repo-rooted path stands.
    const queried: string[] = [];
    _gitHistoryDeps.gitWithTimeout = async (args: string[], _cwd: string) => {
      const fileArg = args[args.length - 1] ?? "";
      queried.push(fileArg);
      return { stdout: "abc1234 root manifest history", stderr: "", exitCode: 0 };
    };
    const logger = makeLogger();
    _gitHistoryDeps.getLogger = () => logger;

    const p = new GitHistoryProvider({ historyScope: "repo" } as GitHistoryProviderOptions);
    const result = await p.fetch({
      ...MONOREPO_REQUEST,
      contextFilesCanonical: true,
      touchedFiles: ["package.json"],
    });

    // A canonical set is passed through untouched — no collision probe runs at
    // all, so the only git call is the history fetch itself.
    expect(queried).toEqual(["package.json"]);
    expect(result.chunks[0]?.content).toContain("root manifest history");
    expect(result.chunks[0]?.scopePaths).toEqual(["package.json"]);
    expect(logger.calls.some((call) => call.message.includes("colliding"))).toBe(false);
  });

  test("historyScope 'repo' — a non-canonical repo-root-only path is kept (no package counterpart)", async () => {
    // A genuine repo-root file at a non-canonical request: it does NOT resolve
    // under the package, so there is no collision and the repo history stands.
    const queried: string[] = [];
    _gitHistoryDeps.gitWithTimeout = async (args: string[], _cwd: string) => {
      const fileArg = args[args.length - 1] ?? "";
      // Only the repo-root spelling has history; packages/api/package.json
      // has none, so there is no ambiguity to resolve.
      if (args.includes("-1")) {
        const has = fileArg === "package.json";
        return { stdout: has ? "abc1234 a commit" : "", stderr: "", exitCode: 0 };
      }
      queried.push(fileArg);
      return { stdout: "abc1234 root-only history", stderr: "", exitCode: 0 };
    };
    const logger = makeLogger();
    _gitHistoryDeps.getLogger = () => logger;

    const p = new GitHistoryProvider({ historyScope: "repo" } as GitHistoryProviderOptions);
    const result = await p.fetch({ ...MONOREPO_REQUEST, touchedFiles: ["package.json"] });

    expect(queried).toEqual(["package.json"]);
    expect(result.chunks[0]?.content).toContain("root-only history");
    // Single frame: the heading is repo-rooted verbatim, no marker appended.
    expect(result.chunks[0]?.content).toContain("### package.json\n");
    expect(result.chunks[0]?.content).not.toContain("(other package");
    expect(result.chunks[0]?.scopePaths).toEqual(["package.json"]);
    expect(logger.calls.some((call) => call.message.includes("colliding"))).toBe(false);
  });

  test("historyScope 'package' — chunk heading is repo-rooted and equals scopePath", async () => {
    mockGit(new Map([["packages/api/src/service.ts", { stdout: "abc1234 feat: service impl", exitCode: 0 }]]));
    const p = new GitHistoryProvider({ historyScope: "package" } as GitHistoryProviderOptions);
    const result = await p.fetch(MONOREPO_REQUEST);
    expect(result.chunks).toHaveLength(1);
    // Single-frame redesign: content and scopePaths share one repo-rooted
    // spelling, so the rendered heading is exactly the attribution key.
    expect(result.chunks[0]?.content).toContain("### packages/api/src/service.ts");
    expect(result.chunks[0]?.scopePaths).toEqual(["packages/api/src/service.ts"]);
    for (const path of result.chunks[0]?.scopePaths ?? []) {
      expect(result.chunks[0]?.content).toContain(path);
    }
  });

  test("non-monorepo: packageDir === repoRoot — every file stays in scope", async () => {
    const invocations = captureInvocations();
    const p = new GitHistoryProvider({ historyScope: "package" } as GitHistoryProviderOptions);
    await p.fetch(makeRequest({ touchedFiles: ["src/foo.ts"] })); // packageDir === repoRoot === "/repo"
    expect(invocations[0]?.cwd).toBe("/repo");
    expect(invocations[0]?.args).toContain("src/foo.ts");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// nax#2067: touchedFiles is REPO-ROOTED per the path-frame convention (nax#2071)
// and git ALWAYS runs in repoRoot (nax#2088). A repo-rooted touchedFile from a
// canonicalized PRD therefore yields a chunk — the OLD contract where it
// yielded nothing (and where the builders re-framed touched files themselves)
// is gone.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// GitHistoryProvider — concurrency
//
// Verifies that per-file git log calls are issued concurrently (Promise.all)
// rather than serially. All git calls are intercepted via _gitHistoryDeps.
// ─────────────────────────────────────────────────────────────────────────────

describe("GitHistoryProvider — concurrency", () => {
  test("fetches file history concurrently, not serially", async () => {
    let active = 0;
    let maxActive = 0;

    // Track how many git invocations are in-flight simultaneously.
    // Each fake call bumps active on entry, defers, then decrements on resolution.
    _gitHistoryDeps.gitWithTimeout = async (args: string[], _workdir: string) => {
      active++;
      if (active > maxActive) maxActive = active;
      // Yield to the event loop so all concurrent calls can reach their peak
      await Promise.resolve();
      active--;
      const fileArg = args[args.length - 1] ?? "file";
      return { stdout: `abc1234 feat: change in ${fileArg}`, stderr: "", exitCode: 0 };
    };

    const provider = new GitHistoryProvider();
    const result = await provider.fetch(
      makeRequest({
        touchedFiles: ["src/a.ts", "src/b.ts", "src/c.ts"],
      }),
    );

    // All three files should have history sections in the output
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].content).toContain("src/a.ts");
    expect(result.chunks[0].content).toContain("src/b.ts");
    expect(result.chunks[0].content).toContain("src/c.ts");

    // Concurrency assertion — with Promise.all the 3 calls must overlap
    expect(maxActive).toBeGreaterThan(1);
  });

  test("collects all file sections even when some files have no history", async () => {
    _gitHistoryDeps.gitWithTimeout = async (args: string[], _workdir: string) => {
      const fileArg = args[args.length - 1] ?? "";
      if (fileArg === "src/b.ts") return { stdout: "", stderr: "", exitCode: 0 }; // no history
      return { stdout: `abc1234 feat: change in ${fileArg}`, stderr: "", exitCode: 0 };
    };

    const provider = new GitHistoryProvider();
    const result = await provider.fetch(
      makeRequest({
        touchedFiles: ["src/a.ts", "src/b.ts", "src/c.ts"],
      }),
    );

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].content).toContain("src/a.ts");
    expect(result.chunks[0].content).not.toContain("src/b.ts");
    expect(result.chunks[0].content).toContain("src/c.ts");
  });
});
