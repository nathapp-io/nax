/**
 * GitHistoryProvider — unit tests
 *
 * All git calls are intercepted via _gitHistoryDeps injection.
 * No real git process is spawned.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { GitHistoryProvider, _gitHistoryDeps } from "../../../../../src/context/engine/providers/git-history";
import type { GitHistoryProviderOptions } from "../../../../../src/context/engine/providers/git-history";
import type { ContextRequest } from "../../../../../src/context/engine/types";

// ─────────────────────────────────────────────────────────────────────────────
// Saved originals
// ─────────────────────────────────────────────────────────────────────────────

let origGitWithTimeout: typeof _gitHistoryDeps.gitWithTimeout;

beforeEach(() => {
  origGitWithTimeout = _gitHistoryDeps.gitWithTimeout;
});

afterEach(() => {
  _gitHistoryDeps.gitWithTimeout = origGitWithTimeout;
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

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

function mockGit(responses: Map<string, { stdout: string; exitCode: number }>) {
  _gitHistoryDeps.gitWithTimeout = async (args: string[], _workdir: string) => {
    // Last arg in git log is the file path (after "--")
    const fileArg = args[args.length - 1] ?? "";
    return responses.get(fileArg) ?? { stdout: "", exitCode: 0 };
  };
}

/** Installs a mock that captures workdirs and returns success for every file */
function captureWorkdirs(): string[] {
  const captured: string[] = [];
  _gitHistoryDeps.gitWithTimeout = async (_args: string[], workdir: string) => {
    captured.push(workdir);
    return { stdout: "abc1234 feat: something", exitCode: 0 };
  };
  return captured;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("GitHistoryProvider", () => {
  const provider = new GitHistoryProvider();

  test("returns empty when touchedFiles is absent", async () => {
    const result = await provider.fetch(makeRequest());
    expect(result.chunks).toHaveLength(0);
  });

  test("returns empty when touchedFiles is empty array", async () => {
    const result = await provider.fetch(makeRequest({ touchedFiles: [] }));
    expect(result.chunks).toHaveLength(0);
  });

  test("returns empty when git returns no output for any file", async () => {
    mockGit(new Map([["src/foo.ts", { stdout: "", exitCode: 0 }]]));
    const result = await provider.fetch(makeRequest({ touchedFiles: ["src/foo.ts"] }));
    expect(result.chunks).toHaveLength(0);
  });

  test("returns empty when git returns non-zero exit for all files", async () => {
    mockGit(new Map([["src/foo.ts", { stdout: "some output", exitCode: 1 }]]));
    const result = await provider.fetch(makeRequest({ touchedFiles: ["src/foo.ts"] }));
    expect(result.chunks).toHaveLength(0);
  });

  test("returns one chunk with git history when a file has history", async () => {
    mockGit(
      new Map([
        ["src/foo.ts", { stdout: "abc1234 fix: add null check\ndef5678 feat: initial impl", exitCode: 0 }],
      ]),
    );
    const result = await provider.fetch(makeRequest({ touchedFiles: ["src/foo.ts"] }));
    expect(result.chunks).toHaveLength(1);
  });

  test("chunk has kind 'history'", async () => {
    mockGit(new Map([["src/foo.ts", { stdout: "abc1234 fix: something", exitCode: 0 }]]));
    const result = await provider.fetch(makeRequest({ touchedFiles: ["src/foo.ts"] }));
    expect(result.chunks[0]?.kind).toBe("history");
  });

  test("chunk has scope 'story'", async () => {
    mockGit(new Map([["src/foo.ts", { stdout: "abc1234 fix: something", exitCode: 0 }]]));
    const result = await provider.fetch(makeRequest({ touchedFiles: ["src/foo.ts"] }));
    expect(result.chunks[0]?.scope).toBe("story");
  });

  test("chunk role includes implementer and tdd", async () => {
    mockGit(new Map([["src/foo.ts", { stdout: "abc1234 fix: something", exitCode: 0 }]]));
    const result = await provider.fetch(makeRequest({ touchedFiles: ["src/foo.ts"] }));
    expect(result.chunks[0]?.role).toContain("implementer");
    expect(result.chunks[0]?.role).toContain("tdd");
  });

  test("chunk rawScore is 0.7", async () => {
    mockGit(new Map([["src/foo.ts", { stdout: "abc1234 fix: something", exitCode: 0 }]]));
    const result = await provider.fetch(makeRequest({ touchedFiles: ["src/foo.ts"] }));
    expect(result.chunks[0]?.rawScore).toBe(0.7);
  });

  test("chunk content includes file path as section header", async () => {
    mockGit(new Map([["src/foo.ts", { stdout: "abc1234 fix: null check", exitCode: 0 }]]));
    const result = await provider.fetch(makeRequest({ touchedFiles: ["src/foo.ts"] }));
    expect(result.chunks[0]?.content).toContain("src/foo.ts");
    expect(result.chunks[0]?.content).toContain("abc1234 fix: null check");
  });

  test("combines history from multiple files into one chunk", async () => {
    mockGit(
      new Map([
        ["src/foo.ts", { stdout: "abc1234 fix: foo", exitCode: 0 }],
        ["src/bar.ts", { stdout: "def5678 feat: bar", exitCode: 0 }],
      ]),
    );
    const result = await provider.fetch(makeRequest({ touchedFiles: ["src/foo.ts", "src/bar.ts"] }));
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.content).toContain("src/foo.ts");
    expect(result.chunks[0]?.content).toContain("src/bar.ts");
  });

  test("skips files where git fails and includes files that succeed", async () => {
    mockGit(
      new Map([
        ["src/good.ts", { stdout: "abc1234 feat: works", exitCode: 0 }],
        ["src/bad.ts", { stdout: "", exitCode: 1 }],
      ]),
    );
    const result = await provider.fetch(makeRequest({ touchedFiles: ["src/good.ts", "src/bad.ts"] }));
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.content).toContain("src/good.ts");
    expect(result.chunks[0]?.content).not.toContain("src/bad.ts");
  });

  test("chunk tokens equals ceil(content.length / 4)", async () => {
    mockGit(new Map([["src/foo.ts", { stdout: "abc1234 fix: null check", exitCode: 0 }]]));
    const result = await provider.fetch(makeRequest({ touchedFiles: ["src/foo.ts"] }));
    const chunk = result.chunks[0]!;
    expect(chunk.tokens).toBe(Math.ceil(chunk.content.length / 4));
  });

  test("respects MAX_FILES limit — only first 10 files processed", async () => {
    const files = Array.from({ length: 15 }, (_, i) => `src/file${i}.ts`);
    const responses = new Map(files.map((f) => [f, { stdout: `abc feat: ${f}`, exitCode: 0 }]));
    mockGit(responses);

    let callCount = 0;
    const orig = _gitHistoryDeps.gitWithTimeout;
    _gitHistoryDeps.gitWithTimeout = async (args, workdir) => {
      callCount++;
      return orig(args, workdir);
    };

    await provider.fetch(makeRequest({ touchedFiles: files }));
    expect(callCount).toBeLessThanOrEqual(10);
  });

  test("chunk content is capped at MAX_CHUNK_TOKENS * 4 characters", async () => {
    // Generate content that would exceed the cap
    const longLog = "a".repeat(3_000);
    mockGit(new Map([["src/big.ts", { stdout: longLog, exitCode: 0 }]]));
    const result = await provider.fetch(makeRequest({ touchedFiles: ["src/big.ts"] }));
    const chunk = result.chunks[0]!;
    expect(chunk.content.length).toBeLessThanOrEqual(600 * 4);
    expect(chunk.tokens).toBe(Math.ceil(chunk.content.length / 4));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-55: historyScope option
// ─────────────────────────────────────────────────────────────────────────────

describe("GitHistoryProvider — AC-55 historyScope", () => {
  const MONOREPO_REQUEST: ContextRequest = {
    storyId: "US-002",
    repoRoot: "/repo",
    packageDir: "/repo/packages/api",
    stage: "execution",
    role: "implementer",
    budgetTokens: 8_000,
    touchedFiles: ["src/service.ts"],
  };

  test("default historyScope is 'package' — uses packageDir", async () => {
    const workdirs = captureWorkdirs();
    const p = new GitHistoryProvider();
    await p.fetch(MONOREPO_REQUEST);
    expect(workdirs[0]).toBe("/repo/packages/api");
  });

  test("historyScope 'repo' — uses repoRoot", async () => {
    const workdirs = captureWorkdirs();
    const p = new GitHistoryProvider({ historyScope: "repo" } as GitHistoryProviderOptions);
    await p.fetch(MONOREPO_REQUEST);
    expect(workdirs[0]).toBe("/repo");
  });

  test("historyScope 'package' — uses packageDir", async () => {
    const workdirs = captureWorkdirs();
    const p = new GitHistoryProvider({ historyScope: "package" } as GitHistoryProviderOptions);
    await p.fetch(MONOREPO_REQUEST);
    expect(workdirs[0]).toBe("/repo/packages/api");
  });

  test("non-monorepo: historyScope 'package' uses repoRoot when packageDir === repoRoot", async () => {
    const workdirs = captureWorkdirs();
    const p = new GitHistoryProvider({ historyScope: "package" } as GitHistoryProviderOptions);
    await p.fetch(makeRequest({ touchedFiles: ["src/foo.ts"] })); // packageDir === repoRoot === "/repo"
    expect(workdirs[0]).toBe("/repo");
  });

  test("historyScope 'package' — chunk content still contains file history", async () => {
    mockGit(new Map([["src/service.ts", { stdout: "abc1234 feat: service impl", exitCode: 0 }]]));
    const p = new GitHistoryProvider({ historyScope: "package" } as GitHistoryProviderOptions);
    const result = await p.fetch(MONOREPO_REQUEST);
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.content).toContain("src/service.ts");
  });
});
