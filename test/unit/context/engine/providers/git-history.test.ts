/**
 * GitHistoryProvider — unit tests
 *
 * All git calls are intercepted via _gitHistoryDeps injection.
 * No real git process is spawned.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { assertDefined, makeLogger } from "@test/helpers";
import type { GitHistoryProviderOptions } from "@/context/engine/providers/git-history";
import { _gitHistoryDeps, GitHistoryProvider } from "@/context/engine/providers/git-history";
import type { ContextRequest } from "@/context/engine/types";

// ─────────────────────────────────────────────────────────────────────────────
// Saved originals
// ─────────────────────────────────────────────────────────────────────────────

let origGitWithTimeout: typeof _gitHistoryDeps.gitWithTimeout;
let origGetLogger: typeof _gitHistoryDeps.getLogger;
let origExistsSync: typeof _gitHistoryDeps.existsSync;

beforeEach(() => {
  origGitWithTimeout = _gitHistoryDeps.gitWithTimeout;
  origGetLogger = _gitHistoryDeps.getLogger;
  origExistsSync = _gitHistoryDeps.existsSync;
});

afterEach(() => {
  _gitHistoryDeps.gitWithTimeout = origGitWithTimeout;
  _gitHistoryDeps.getLogger = origGetLogger;
  _gitHistoryDeps.existsSync = origExistsSync;
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
      new Map([["src/foo.ts", { stdout: "abc1234 fix: add null check\ndef5678 feat: initial impl", exitCode: 0 }]]),
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
    const chunk = result.chunks[0];
    assertDefined(chunk, "result.chunks[0]");
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
    const chunk = result.chunks[0];
    assertDefined(chunk, "result.chunks[0]");
    expect(chunk.content.length).toBeLessThanOrEqual(600 * 4);
    expect(chunk.tokens).toBe(Math.ceil(chunk.content.length / 4));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-55: historyScope (nax#2088)
//
// The frame contract flipped in nax#2088: touchedFiles is REPO-ROOTED and git
// ALWAYS runs in repoRoot against the repo-rooted pathspec. historyScope is a
// POST-FILTER, not a workdir switch — under "package" only entries beneath
// packageDir are queried; under "repo" the whole repo is in scope.
// ─────────────────────────────────────────────────────────────────────────────

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
      queried.push(fileArg);
      const stdout =
        fileArg === "src/client.ts" ? "abc1234 root-level client history" : "abc1234 package client history";
      return { stdout, stderr: "", exitCode: 0 };
    };
    _gitHistoryDeps.existsSync = (p) => p === "/repo/packages/api/src/client.ts" || p === "/repo/src/client.ts";
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

  test("historyScope 'repo' — a canonical set keeps a genuine repo-rooted path, no collision probe", async () => {
    // contextFilesCanonical asserts the plan-time write seam re-spelled every
    // existing path, so a toPackageFrame miss is genuinely out-of-package. Even
    // with a same-named file under the package, the repo-rooted path stands.
    const queried: string[] = [];
    _gitHistoryDeps.gitWithTimeout = async (args: string[], _cwd: string) => {
      const fileArg = args[args.length - 1] ?? "";
      queried.push(fileArg);
      return { stdout: "abc1234 root manifest history", stderr: "", exitCode: 0 };
    };
    _gitHistoryDeps.existsSync = () => true; // same-named file exists under the package too
    const logger = makeLogger();
    _gitHistoryDeps.getLogger = () => logger;

    const p = new GitHistoryProvider({ historyScope: "repo" } as GitHistoryProviderOptions);
    const result = await p.fetch({
      ...MONOREPO_REQUEST,
      contextFilesCanonical: true,
      touchedFiles: ["package.json"],
    });

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
      queried.push(fileArg);
      return { stdout: "abc1234 root-only history", stderr: "", exitCode: 0 };
    };
    _gitHistoryDeps.existsSync = (p) => p === "/repo/package.json"; // only at the repo root
    const logger = makeLogger();
    _gitHistoryDeps.getLogger = () => logger;

    const p = new GitHistoryProvider({ historyScope: "repo" } as GitHistoryProviderOptions);
    const result = await p.fetch({ ...MONOREPO_REQUEST, touchedFiles: ["package.json"] });

    expect(queried).toEqual(["package.json"]);
    expect(result.chunks[0]?.content).toContain("root-only history");
    // Part A: an out-of-package file is marked, not silently re-rooted.
    expect(result.chunks[0]?.content).toContain(
      "package.json (other package - not readable from this story's workdir)",
    );
    expect(result.chunks[0]?.scopePaths).toEqual(["package.json"]);
    expect(logger.calls.some((call) => call.message.includes("colliding"))).toBe(false);
  });

  test("historyScope 'package' — chunk heading is package-relative, scopePaths repo-rooted", async () => {
    mockGit(new Map([["packages/api/src/service.ts", { stdout: "abc1234 feat: service impl", exitCode: 0 }]]));
    const p = new GitHistoryProvider({ historyScope: "package" } as GitHistoryProviderOptions);
    const result = await p.fetch(MONOREPO_REQUEST);
    expect(result.chunks).toHaveLength(1);
    // H9: content crosses into the agent's prompt, whose file tools are rooted
    // at the package dir — the heading must be package-relative to open.
    expect(result.chunks[0]?.content).toContain("### src/service.ts");
    expect(result.chunks[0]?.content).not.toContain("### packages/api/src/service.ts");
    // ...while scopePaths is matched against the repo-framed diff and stays
    // repo-rooted (code-neighbor-chunk.ts splits the two the same way).
    expect(result.chunks[0]?.scopePaths).toEqual(["packages/api/src/service.ts"]);
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

describe("GitHistoryProvider — nax#2067 touchedFiles frame contract", () => {
  const p = new GitHistoryProvider(); // package scope (default) — cwd is repoRoot

  test("a repo-rooted touchedFile from a canonicalized PRD yields a chunk at cwd=repoRoot", async () => {
    mockGit(new Map([["packages/app/src/service.ts", { stdout: "abc1234 feat: service impl", exitCode: 0 }]]));
    const cwds: string[] = [];
    const orig = _gitHistoryDeps.gitWithTimeout;
    _gitHistoryDeps.gitWithTimeout = async (args, cwd) => {
      cwds.push(cwd);
      return orig(args, cwd);
    };
    const result = await p.fetch({
      storyId: "US-001",
      repoRoot: "/repo",
      packageDir: "/repo/packages/app",
      storyWorkdir: "packages/app",
      stage: "execution",
      role: "implementer",
      budgetTokens: 8_000,
      touchedFiles: ["packages/app/src/service.ts"],
    });
    expect(cwds[0]).toBe("/repo");
    expect(result.chunks).toHaveLength(1);
    // H9: the heading is package-relative for the package-contained agent;
    // scopePaths keeps the repo-rooted spelling the diff is matched against.
    expect(result.chunks[0]?.content).toContain("### src/service.ts");
    expect(result.chunks[0]?.scopePaths).toEqual(["packages/app/src/service.ts"]);
  });

  test("the package-framed spelling (what OLD request builders sent) is filtered out at package scope", async () => {
    // Under the new contract a package-framed "src/service.ts" names the
    // ROOT-level file, which is outside packages/app — the package post-filter
    // drops it before git is ever invoked.
    let queried = false;
    _gitHistoryDeps.gitWithTimeout = async () => {
      queried = true;
      return { stdout: "abc1234 root history", stderr: "", exitCode: 0 };
    };
    const result = await p.fetch({
      storyId: "US-001",
      repoRoot: "/repo",
      packageDir: "/repo/packages/app",
      storyWorkdir: "packages/app",
      stage: "execution",
      role: "implementer",
      budgetTokens: 8_000,
      touchedFiles: ["src/service.ts"],
    });
    expect(queried).toBe(false);
    expect(result.chunks).toHaveLength(0);
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
    const result = await provider.fetch(makeRequest({ touchedFiles: ["src/foo.ts", "src/bar.ts", "src/baz.ts"] }));
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
    const result = await provider.fetch(makeRequest({ touchedFiles: ["src/a.ts", "src/b.ts", "src/c.ts"] }));
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

describe("GitHistoryProvider — worktree isolation (nax#2088 follow-up)", () => {
  // Under storyIsolation: "worktree", packageDir is `.nax-wt/<storyId>/<pkg>`
  // while repoRoot stays the main checkout. Deriving the package frame as
  // packageDirRelative(repoRoot, packageDir) yields ".nax-wt/<storyId>/<pkg>",
  // which the historyScope "package" post-filter compares against repo-rooted
  // touchedFiles — matching nothing, so every file is dropped and the
  // provider returns zero chunks, silently. The fix reads request.storyWorkdir
  // (threaded from the story) instead of deriving it from repoRoot/packageDir.
  test("touchedFiles resolve under storyIsolation: worktree via request.storyWorkdir", async () => {
    mockGit(new Map([["packages/app/src/service.ts", { stdout: "abc1234 feat: service impl", exitCode: 0 }]]));
    const p = new GitHistoryProvider({ historyScope: "package" });

    const result = await p.fetch({
      storyId: "US-001",
      repoRoot: "/repo",
      packageDir: "/repo/.nax-wt/US-001/packages/app",
      storyWorkdir: "packages/app",
      stage: "execution",
      role: "implementer",
      budgetTokens: 8_000,
      touchedFiles: ["packages/app/src/service.ts"],
    });

    expect(result.chunks).toHaveLength(1);
    // H9: content is re-spelled for the package-contained consumer; scopePaths
    // stays repo-rooted so it still matches the repo-framed diff. Both are
    // pinned on the SAME chunk, since sharing one string for both was the bug.
    // (Supersedes the M-5 note that pinned the pre-H9 repo-rooted heading.)
    expect(result.chunks[0]?.content).toContain("### src/service.ts");
    expect(result.chunks[0]?.content).not.toContain("### packages/app/src/service.ts");
    expect(result.chunks[0]?.scopePaths).toEqual(["packages/app/src/service.ts"]);
  });
});

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
    const result = await p.fetch(makeRequest({ touchedFiles: ["src/a.ts", "src/b.ts"] }), controller.signal);

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
    await p.fetch(makeRequest({ touchedFiles: ["src/a.ts", "src/b.ts", "src/c.ts"] }), controller.signal);

    // The first spawn aborts the signal; no further files are queried.
    expect(queried).toEqual(["src/a.ts"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// M14: both silent-drop diagnostics are injectable through
// _gitHistoryDeps.getLogger but were never injected by a test, so either could
// be silenced by a refactor with the suite green. One fire / no-fire pair each.
// (Supersedes the M-2 fire-only tests: same coverage with the M-3 log
// vocabulary — `packageDir` is the ABSOLUTE package dir, `workdir` the
// relative story.workdir — plus the no-fire halves.)
// ─────────────────────────────────────────────────────────────────────────────

describe("GitHistoryProvider — drop diagnostics (M14)", () => {
  const provider = new GitHistoryProvider();

  test("empty-history warn fires once with storyId, filePath, pathspec and packageDir", async () => {
    mockGit(new Map([["src/foo.ts", { stdout: "", exitCode: 0 }]]));
    const logger = makeLogger();
    _gitHistoryDeps.getLogger = () => logger;

    await provider.fetch(makeRequest({ touchedFiles: ["src/foo.ts"] }));

    const emptyWarns = logger.calls.filter((call) => call.message.includes("git history empty"));
    expect(emptyWarns).toHaveLength(1);
    expect(emptyWarns[0]?.data).toMatchObject({
      storyId: "US-001",
      filePath: "src/foo.ts",
      pathspec: "src/foo.ts",
      packageDir: "/repo",
      workdir: ".",
    });
  });

  test("empty-history warn does NOT fire when every file has history", async () => {
    mockGit(new Map([["src/foo.ts", { stdout: "abc1234 fix: foo", exitCode: 0 }]]));
    const logger = makeLogger();
    _gitHistoryDeps.getLogger = () => logger;

    await provider.fetch(makeRequest({ touchedFiles: ["src/foo.ts"] }));

    expect(logger.calls.filter((call) => call.message.includes("git history empty"))).toHaveLength(0);
  });

  test("package-scope drop warn fires once with storyId, packageDir, count and files", async () => {
    mockGit(new Map([["packages/api/src/service.ts", { stdout: "abc1234 feat: service", exitCode: 0 }]]));
    const logger = makeLogger();
    _gitHistoryDeps.getLogger = () => logger;

    const p = new GitHistoryProvider({ historyScope: "package" } as GitHistoryProviderOptions);
    await p.fetch({
      storyId: "US-002",
      repoRoot: "/repo",
      packageDir: "/repo/packages/api",
      storyWorkdir: "packages/api",
      stage: "execution",
      role: "implementer",
      budgetTokens: 8_000,
      touchedFiles: ["packages/api/src/service.ts", "package.json"],
    });

    const scopeWarns = logger.calls.filter((call) => call.message.includes("outside package scope"));
    expect(scopeWarns).toHaveLength(1);
    expect(scopeWarns[0]?.data).toMatchObject({
      storyId: "US-002",
      packageDir: "/repo/packages/api",
      workdir: "packages/api",
      count: 1,
      files: ["package.json"],
    });
  });

  test("package-scope drop warn does NOT fire when every file is inside the package", async () => {
    mockGit(new Map([["packages/api/src/service.ts", { stdout: "abc1234 feat: service", exitCode: 0 }]]));
    const logger = makeLogger();
    _gitHistoryDeps.getLogger = () => logger;

    const p = new GitHistoryProvider({ historyScope: "package" } as GitHistoryProviderOptions);
    await p.fetch({
      storyId: "US-002",
      repoRoot: "/repo",
      packageDir: "/repo/packages/api",
      storyWorkdir: "packages/api",
      stage: "execution",
      role: "implementer",
      budgetTokens: 8_000,
      touchedFiles: ["packages/api/src/service.ts"],
    });

    expect(logger.calls.filter((call) => call.message.includes("outside package scope"))).toHaveLength(0);
  });
});
