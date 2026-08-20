/**
 * GitHistoryProvider — unit tests
 *
 * All git calls are intercepted via _gitHistoryDeps injection.
 * No real git process is spawned.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { GitHistoryProvider, _gitHistoryDeps } from "@/context/engine/providers/git-history";
import type { GitHistoryProviderOptions } from "@/context/engine/providers/git-history";
import type { ContextRequest } from "@/context/engine/types";

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

function mockGit(responses: Map<string, { stdout: string; stderr?: string; exitCode: number }>) {
  _gitHistoryDeps.gitWithTimeout = async (args: string[], _workdir: string) => {
    // Last arg in git log is the file path (after "--")
    const fileArg = args[args.length - 1] ?? "";
    const r = responses.get(fileArg) ?? { stdout: "", exitCode: 0 };
    return { stderr: "", ...r };
  };
}

/** Installs a mock that captures workdirs and returns success for every file */
function captureWorkdirs(): string[] {
  const captured: string[] = [];
  _gitHistoryDeps.gitWithTimeout = async (_args: string[], workdir: string) => {
    captured.push(workdir);
    return { stdout: "abc1234 feat: something", stderr: "", exitCode: 0 };
  };
  return captured;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("GitHistoryProvider", () => {
  const provider = new GitHistoryProvider();

  test.each([
    ["touchedFiles absent", makeRequest()],
    ["touchedFiles empty array", makeRequest({ touchedFiles: [] })],
  ])("returns empty when %s", async (_label, request) => {
    const result = await provider.fetch(request);
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

  test.each([
    ["kind", "kind" as const, "history" as const],
    ["scope", "scope" as const, "story" as const],
    ["rawScore", "rawScore" as const, 0.7 as const],
  ])("chunk has %s property", async (_label, prop, expected) => {
    mockGit(new Map([["src/foo.ts", { stdout: "abc1234 fix: something", exitCode: 0 }]]));
    const result = await provider.fetch(makeRequest({ touchedFiles: ["src/foo.ts"] }));
    expect(result.chunks[0]?.[prop]).toBe(expected);
  });

  test("chunk role includes implementer and tdd", async () => {
    mockGit(new Map([["src/foo.ts", { stdout: "abc1234 fix: something", exitCode: 0 }]]));
    const result = await provider.fetch(makeRequest({ touchedFiles: ["src/foo.ts"] }));
    expect(result.chunks[0]?.role).toContain("implementer");
    expect(result.chunks[0]?.role).toContain("tdd");
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

// ─────────────────────────────────────────────────────────────────────────────
// US-001 — scope attribution: chunk.scopePaths lists only files that
// actually contributed a history section (filtered by fetchFileHistory
// returning null). Out-of-scope files are NOT attributed to the chunk.
// ─────────────────────────────────────────────────────────────────────────────

describe("GitHistoryProvider — US-001 scope attribution", () => {
  const provider = new GitHistoryProvider();

  test("AC1: scopePaths contains only the first touchedFile when only the first has commit history", async () => {
    mockGit(
      new Map([
        ["src/foo.ts", { stdout: "abc1234 fix: foo", exitCode: 0 }],
        ["src/bar.ts", { stdout: "", exitCode: 0 }], // no history — fetchFileHistory returns null
      ]),
    );
    const result = await provider.fetch(makeRequest({ touchedFiles: ["src/foo.ts", "src/bar.ts"] }));
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.scopePaths).toEqual(["src/foo.ts"]);
  });

  test("AC2: scopePaths lists every requested file with history in the same order as touchedFiles", async () => {
    mockGit(
      new Map([
        ["src/foo.ts", { stdout: "abc1234 fix: foo", exitCode: 0 }],
        ["src/bar.ts", { stdout: "def5678 feat: bar", exitCode: 0 }],
        ["src/baz.ts", { stdout: "ghi9abc refactor: baz", exitCode: 0 }],
      ]),
    );
    const result = await provider.fetch(
      makeRequest({ touchedFiles: ["src/foo.ts", "src/bar.ts", "src/baz.ts"] }),
    );
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.scopePaths).toEqual(["src/foo.ts", "src/bar.ts", "src/baz.ts"]);
  });

  test("AC2 (subset): scopePaths preserves the input order even when only some files contribute history", async () => {
    mockGit(
      new Map([
        // Order matters: the chunk's scopePaths must follow the touchedFiles
        // order, not the order in which fetchFileHistory resolves.
        ["src/a.ts", { stdout: "a feat: a", exitCode: 0 }],
        ["src/c.ts", { stdout: "c feat: c", exitCode: 0 }],
      ]),
    );
    const result = await provider.fetch(
      makeRequest({ touchedFiles: ["src/a.ts", "src/b.ts", "src/c.ts"] }),
    );
    expect(result.chunks[0]?.scopePaths).toEqual(["src/a.ts", "src/c.ts"]);
  });

  test("AC3: returns empty chunks when no requested file has commit history", async () => {
    mockGit(
      new Map([
        ["src/foo.ts", { stdout: "", exitCode: 0 }],
        ["src/bar.ts", { stdout: "", exitCode: 1 }], // exit-code failure too
      ]),
    );
    const result = await provider.fetch(makeRequest({ touchedFiles: ["src/foo.ts", "src/bar.ts"] }));
    expect(result.chunks).toHaveLength(0);
  });

  test("AC4: returned chunk always has a non-empty scopePaths field", async () => {
    mockGit(new Map([["src/foo.ts", { stdout: "abc1234 feat: foo", exitCode: 0 }]]));
    const result = await provider.fetch(makeRequest({ touchedFiles: ["src/foo.ts"] }));
    expect(result.chunks).toHaveLength(1);
    expect(Array.isArray(result.chunks[0]?.scopePaths)).toBe(true);
    expect(result.chunks[0]?.scopePaths?.length).toBeGreaterThan(0);
  });

  test("scopePaths excludes files where git returned a non-zero exit code", async () => {
    mockGit(
      new Map([
        ["src/good.ts", { stdout: "abc1234 feat: good", exitCode: 0 }],
        ["src/broken.ts", { stdout: "some content", exitCode: 1 }], // exit-code failure
      ]),
    );
    const result = await provider.fetch(makeRequest({ touchedFiles: ["src/good.ts", "src/broken.ts"] }));
    expect(result.chunks[0]?.scopePaths).toEqual(["src/good.ts"]);
  });

  test("scopePaths preserves the touchedFiles order even when fetchFileHistory resolves out of order", async () => {
    // fetchFileHistory is called concurrently via Promise.all. The first
    // promise that resolves is NOT necessarily the first touchedFile — but
    // scopePaths must still match the touchedFiles declaration order.
    let aDone = false;
    _gitHistoryDeps.gitWithTimeout = async (args: string[]) => {
      const fileArg = args[args.length - 1] ?? "";
      if (fileArg === "src/a.ts") {
        await Promise.resolve();
        aDone = true;
        return { stdout: "a feat: a", stderr: "", exitCode: 0 };
      }
      if (fileArg === "src/b.ts") {
        // b resolves first even though it is declared second
        if (!aDone) return { stdout: "b feat: b", stderr: "", exitCode: 0 };
        return { stdout: "b feat: b", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const result = await provider.fetch(makeRequest({ touchedFiles: ["src/a.ts", "src/b.ts"] }));
    expect(result.chunks[0]?.scopePaths).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("scopePaths excludes a file whose section was truncated away from chunk.content", async () => {
    // Two files with sections large enough that the second one is dropped
    // by the MAX_CHUNK_TOKENS cap. The chunk must NOT claim scope over the
    // truncated file — its section is absent from chunk.content.
    // Each section is `### <path>\n` (14 chars) + 1800 chars of log output
    // (~1814 chars). Header + "\n\n" is ~52 chars. The first section
    // (~1814) fits under the 2400-char cap; the second pushes the total
    // above the cap and must be excluded entirely.
    const bigStdout = "x".repeat(1800);
    mockGit(
      new Map([
        ["src/a.ts", { stdout: bigStdout, exitCode: 0 }],
        ["src/b.ts", { stdout: bigStdout, exitCode: 0 }],
      ]),
    );
    const result = await provider.fetch(makeRequest({ touchedFiles: ["src/a.ts", "src/b.ts"] }));
    expect(result.chunks).toHaveLength(1);
    // The chunk's content was capped — src/b.ts's section is absent.
    expect(result.chunks[0]?.content).not.toContain("src/b.ts");
    // Therefore src/b.ts must NOT appear in scopePaths.
    expect(result.chunks[0]?.scopePaths).toEqual(["src/a.ts"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SEC-503: path traversal prevention
// ─────────────────────────────────────────────────────────────────────────────

describe("GitHistoryProvider — SEC-503 path traversal prevention", () => {
  test("drops touchedFiles with '..' traversal — never calls git for them", async () => {
    const queriedFiles: string[] = [];
    _gitHistoryDeps.gitWithTimeout = async (args: string[]) => {
      queriedFiles.push(args[args.length - 1] ?? "");
      return { stdout: "abc1234 feat: something", stderr: "", exitCode: 0 };
    };

    const p = new GitHistoryProvider();
    await p.fetch(makeRequest({ touchedFiles: ["../../../etc/passwd", "src/service.ts"] }));

    expect(queriedFiles.some((f) => f.includes("etc/passwd"))).toBe(false);
    expect(queriedFiles).toContain("src/service.ts");
  });

  test("drops absolute path touchedFiles — never calls git for them", async () => {
    const queriedFiles: string[] = [];
    _gitHistoryDeps.gitWithTimeout = async (args: string[]) => {
      queriedFiles.push(args[args.length - 1] ?? "");
      return { stdout: "abc1234 feat: something", stderr: "", exitCode: 0 };
    };

    const p = new GitHistoryProvider();
    await p.fetch(makeRequest({ touchedFiles: ["/etc/passwd", "src/service.ts"] }));

    expect(queriedFiles.some((f) => f.includes("etc/passwd"))).toBe(false);
    expect(queriedFiles).toContain("src/service.ts");
  });

  test("returns empty when all touchedFiles are unsafe", async () => {
    let gitCalled = false;
    _gitHistoryDeps.gitWithTimeout = async () => {
      gitCalled = true;
      return { stdout: "", stderr: "", exitCode: 0 };
    };

    const p = new GitHistoryProvider();
    const result = await p.fetch(makeRequest({ touchedFiles: ["../evil", "/absolute/path"] }));

    expect(gitCalled).toBe(false);
    expect(result.chunks).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PERF-2: cooperative cancellation — an aborted fetch must stop doing work
// ─────────────────────────────────────────────────────────────────────────────

describe("GitHistoryProvider — cooperative cancellation (PERF-2)", () => {
  test("an already-aborted signal never spawns git", async () => {
    let gitCalls = 0;
    _gitHistoryDeps.gitWithTimeout = async () => {
      gitCalls++;
      return { stdout: "abc1234 feat: something", stderr: "", exitCode: 0 };
    };

    const controller = new AbortController();
    controller.abort();

    const p = new GitHistoryProvider();
    const result = await p.fetch(
      makeRequest({ touchedFiles: ["src/a.ts", "src/b.ts"] }),
      controller.signal,
    );

    expect(result.chunks).toHaveLength(0);
    expect(gitCalls).toBe(0);
  });

  test("an abort mid-fetch stops further per-file git spawns", async () => {
    const queried: string[] = [];
    const controller = new AbortController();
    let first = true;

    _gitHistoryDeps.gitWithTimeout = async (args: string[]) => {
      queried.push(args[args.length - 1] ?? "");
      if (first) controller.abort();
      first = false;
      return { stdout: "abc1234 feat: something", stderr: "", exitCode: 0 };
    };

    const p = new GitHistoryProvider();
    await p.fetch(
      makeRequest({ touchedFiles: ["src/a.ts", "src/b.ts", "src/c.ts"] }),
      controller.signal,
    );

    // The first spawn aborts the signal; no further files are queried.
    expect(queried).toEqual(["src/a.ts"]);
  });
});
