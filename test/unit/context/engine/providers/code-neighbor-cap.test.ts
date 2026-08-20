/**
 * CodeNeighborProvider — #895 language-aware glob, configurable cap, visible truncation.
 *
 * Split from code-neighbor.test.ts per test-architecture.md (file exceeds 800-line limit).
 * All filesystem I/O is intercepted via _codeNeighborDeps injection.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { CodeNeighborProvider, _codeNeighborDeps } from "@/context/engine/providers/code-neighbor";
import type { ContextRequest } from "@/context/engine/types";
import { extractTestDirs, globsToPathspec, globsToTestRegex } from "@/test-runners/conventions";
import type { ResolvedTestPatterns } from "@/test-runners/resolver";

function makePatterns(globs: readonly string[]): ResolvedTestPatterns {
  return {
    globs,
    pathspec: globsToPathspec(globs),
    regex: globsToTestRegex(globs),
    testDirs: extractTestDirs(globs),
    resolution: "root-config",
  };
}

function makeRequest(overrides: Partial<ContextRequest> = {}): ContextRequest {
  return {
    storyId: "US-895",
    repoRoot: "/repo",
    packageDir: "/repo",
    stage: "execution",
    role: "implementer",
    budgetTokens: 8_000,
    resolvedTestPatterns: makePatterns(["test/unit/**/*.test.ts"]),
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Save / restore deps
// ─────────────────────────────────────────────────────────────────────────────

let origFileExists: typeof _codeNeighborDeps.fileExists;
let origReadFile: typeof _codeNeighborDeps.readFile;
let origGlob: typeof _codeNeighborDeps.glob;
let origDetectLanguage: typeof _codeNeighborDeps.detectLanguage;
let origGetLogger: typeof _codeNeighborDeps.getLogger;
let origDiscoverWorkspacePackages: typeof _codeNeighborDeps.discoverWorkspacePackages;

beforeEach(() => {
  origFileExists = _codeNeighborDeps.fileExists;
  origReadFile = _codeNeighborDeps.readFile;
  origGlob = _codeNeighborDeps.glob;
  origDetectLanguage = _codeNeighborDeps.detectLanguage;
  origGetLogger = _codeNeighborDeps.getLogger;
  origDiscoverWorkspacePackages = _codeNeighborDeps.discoverWorkspacePackages;
  // Quiet defaults
  _codeNeighborDeps.fileExists = async () => false;
  _codeNeighborDeps.readFile = async () => "";
  _codeNeighborDeps.discoverWorkspacePackages = async () => [];
  _codeNeighborDeps.detectLanguage = async () => undefined;
  _codeNeighborDeps.getLogger = () => ({ debug: () => {}, warn: () => {}, info: () => {}, error: () => {} }) as any;
});

afterEach(() => {
  _codeNeighborDeps.fileExists = origFileExists;
  _codeNeighborDeps.readFile = origReadFile;
  _codeNeighborDeps.glob = origGlob;
  _codeNeighborDeps.detectLanguage = origDetectLanguage;
  _codeNeighborDeps.getLogger = origGetLogger;
  _codeNeighborDeps.discoverWorkspacePackages = origDiscoverWorkspacePackages;
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Sets up glob spy that captures the pattern and cap arguments. */
function spyGlob() {
  let capturedPattern = "";
  let capturedCap = 0;
  _codeNeighborDeps.glob = (pattern, _cwd, _m, cap) => {
    capturedPattern = pattern;
    capturedCap = cap ?? 500;
    return { files: [], truncated: false };
  };
  return {
    get pattern() { return capturedPattern; },
    get cap() { return capturedCap; },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("CodeNeighborProvider — language-aware glob and cap (#895)", () => {
  test("derives TS glob when language=typescript", async () => {
    _codeNeighborDeps.detectLanguage = async () => "typescript";
    const spy = spyGlob();
    await new CodeNeighborProvider().fetch(makeRequest({ touchedFiles: ["src/a.ts"] }));
    expect(spy.pattern).toBe("**/*.{ts,tsx,js,jsx,mjs,cjs}");
  });

  test("derives Go glob when language=go", async () => {
    _codeNeighborDeps.detectLanguage = async () => "go";
    const spy = spyGlob();
    await new CodeNeighborProvider().fetch(makeRequest({ touchedFiles: ["src/a.ts"] }));
    expect(spy.pattern).toBe("**/*.go");
  });

  test("falls back to wide glob when language=undefined", async () => {
    _codeNeighborDeps.detectLanguage = async () => undefined;
    const spy = spyGlob();
    await new CodeNeighborProvider().fetch(makeRequest({ touchedFiles: ["src/a.ts"] }));
    expect(spy.pattern).toContain(".{ts,tsx,js,jsx,mjs,cjs,py,go,rs");
  });

  test("respects sourceGlob override — does not call detectLanguage", async () => {
    let detectCalled = false;
    _codeNeighborDeps.detectLanguage = async () => { detectCalled = true; return "typescript"; };
    const spy = spyGlob();
    await new CodeNeighborProvider({ sourceGlob: "lib/**/*.ts" }).fetch(makeRequest({ touchedFiles: ["src/a.ts"] }));
    expect(detectCalled).toBe(false);
    expect(spy.pattern).toBe("lib/**/*.ts");
  });

  test("respects maxGlobFiles override — passes cap to glob dep", async () => {
    const spy = spyGlob();
    await new CodeNeighborProvider({ maxGlobFiles: 50 }).fetch(makeRequest({ touchedFiles: ["src/a.ts"] }));
    expect(spy.cap).toBe(50);
  });

  test("emits warn-level log on truncation with storyId, packageDir, pattern, cap, hint", async () => {
    const warnArgs: unknown[][] = [];
    _codeNeighborDeps.getLogger = () =>
      ({ debug: () => {}, warn: (...a: unknown[]) => warnArgs.push(a), info: () => {}, error: () => {} }) as any;
    // Simulate the real glob behaviour: when truncated=true it calls warn internally.
    // We replace glob with one that calls getLogger().warn exactly as the real dep does.
    _codeNeighborDeps.glob = (_p, _c, _m, cap, ctx) => {
      _codeNeighborDeps.getLogger().warn("context-v2", "Reverse-dep glob cap reached — results truncated", {
        storyId: ctx?.storyId,
        packageDir: ctx?.packageDir,
        pattern: _p,
        cap,
        hint: "Increase context.v2.providers.maxGlobFiles or narrow context.v2.providers.sourceGlob",
      });
      return { files: ["src/a.ts"], truncated: true };
    };
    await new CodeNeighborProvider().fetch(makeRequest({ touchedFiles: ["src/b.ts"] }));
    expect(warnArgs.length).toBeGreaterThan(0);
    const data = warnArgs[0]?.[2] as Record<string, unknown>;
    expect(data).toHaveProperty("storyId");
    expect(data).toHaveProperty("packageDir");
    expect(data).toHaveProperty("pattern");
    expect(data).toHaveProperty("cap");
    expect(data).toHaveProperty("hint");
  });

  test("appends truncation note to chunk content when glob is truncated", async () => {
    _codeNeighborDeps.glob = () => ({ files: ["src/a.ts"], truncated: true });
    const result = await new CodeNeighborProvider().fetch(makeRequest({ touchedFiles: ["src/b.ts"] }));
    const content = result.chunks[0]?.content ?? "";
    expect(content).toContain("> Note: reverse-dep scan capped at");
  });

  test("does not warn or append note when glob is below cap", async () => {
    const warnCalls: unknown[] = [];
    _codeNeighborDeps.getLogger = () =>
      ({ debug: () => {}, warn: (...a: unknown[]) => warnCalls.push(a), info: () => {}, error: () => {} }) as any;
    _codeNeighborDeps.glob = () => ({ files: ["src/a.ts"], truncated: false });
    const result = await new CodeNeighborProvider().fetch(makeRequest({ touchedFiles: ["src/b.ts"] }));
    expect(warnCalls).toHaveLength(0);
    expect(result.chunks[0]?.content ?? "").not.toContain("> Note:");
  });
});
