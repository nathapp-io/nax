/**
 * GitHistoryProvider — concurrency test
 *
 * Verifies that per-file git log calls are issued concurrently (Promise.all)
 * rather than serially. All git calls are intercepted via _gitHistoryDeps injection.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { GitHistoryProvider, _gitHistoryDeps } from "../../../../../src/context/engine/providers/git-history";
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

// ─────────────────────────────────────────────────────────────────────────────
// Tests
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
      return { stdout: `abc1234 feat: change in ${fileArg}`, exitCode: 0 };
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
      if (fileArg === "src/b.ts") return { stdout: "", exitCode: 0 }; // no history
      return { stdout: `abc1234 feat: change in ${fileArg}`, exitCode: 0 };
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
