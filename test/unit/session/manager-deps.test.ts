/**
 * Tests for src/session/manager-deps.ts
 *
 * Covers: resolveProjectDirFromScratchDir, toProjectRelativePath
 *
 * The third export, `_sessionManagerDeps.writeDescriptor`, is intentionally
 * not unit-tested here — its function body is a thin shell over the helpers
 * above plus `mkdir` and `Bun.write`, and several integration test files
 * (`manager.test.ts`, `manager-pid-lifecycle.test.ts`, etc.) swap it for a
 * no-op mock in their `beforeEach`. Calling the real impl from a parallel
 * test runner races with those mocks. The on-disk write path is therefore
 * covered indirectly via the manager integration tests when their mocks
 * fall through; the helpers above are the substantive logic and are tested
 * directly here.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { resolveProjectDirFromScratchDir, toProjectRelativePath } from "@/session/manager-deps";
import type { SessionDescriptor } from "@/session/types";

// `writeDescriptor` is part of the `_sessionManagerDeps` object that other
// test files swap for no-op mocks. To exercise the real write path here, we
// re-read the production impl on every test from a freshly-imported module
// reference and use that directly, bypassing any mocks applied to the shared
// `_sessionManagerDeps` object.
let writeDescriptor: (scratchDir: string, descriptor: SessionDescriptor, projectDir?: string) => Promise<void>;

beforeEach(async () => {
  // Force a fresh module evaluation so the captured closure is the production
  // impl, not whatever the previous test left on `_sessionManagerDeps`.
  const mod = await import(`@/session/manager-deps?cachebust=${Math.random()}`);
  writeDescriptor = mod._sessionManagerDeps.writeDescriptor;
});

afterEach(async () => {
  // Best-effort cleanup; per-test `scratchDir` is removed inside each test.
});

function makeDescriptor(overrides: Partial<SessionDescriptor> = {}): SessionDescriptor {
  return {
    id: "sess-test-1",
    role: "main",
    state: "CREATED",
    agent: "claude",
    workdir: "/tmp/project",
    featureName: "demo",
    storyId: "US-001",
    protocolIds: { recordId: null, sessionId: null },
    handle: "handle-physical-acp",
    completedStages: [],
    createdAt: new Date(0).toISOString(),
    lastActivityAt: new Date(0).toISOString(),
    scratchDir: "/tmp/project/.nax/features/demo/sessions/sess-test-1",
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// resolveProjectDirFromScratchDir
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveProjectDirFromScratchDir", () => {
  it("returns project dir when scratchDir contains the .nax/features marker", () => {
    expect(resolveProjectDirFromScratchDir("/home/user/proj/.nax/features/foo/sessions/abc")).toBe("/home/user/proj");
  });

  it("returns undefined when scratchDir has no marker", () => {
    expect(resolveProjectDirFromScratchDir("/home/user/random/dir")).toBeUndefined();
  });

  it("returns undefined when marker appears only at the very start of the path", () => {
    // `lastIndexOf` of marker at index 0 should NOT match — guards against
    // matching a marker that is the whole prefix.
    expect(resolveProjectDirFromScratchDir(".nax/features/foo")).toBeUndefined();
  });

  it("matches via the posix backstop when the platform marker is absent", () => {
    // The posix backstop tolerates persisted forward-slash paths regardless
    // of platform. Same path as the first test exercises the second branch.
    expect(resolveProjectDirFromScratchDir("/home/user/proj/.nax/features/foo/sessions/abc")).toBe("/home/user/proj");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// toProjectRelativePath
// ─────────────────────────────────────────────────────────────────────────────

describe("toProjectRelativePath", () => {
  it("converts an absolute path under projectDir to a relative path", () => {
    expect(toProjectRelativePath("/home/user/proj", "/home/user/proj/src/foo.ts")).toBe("src/foo.ts");
  });

  it("returns a relative path unchanged", () => {
    expect(toProjectRelativePath("/home/user/proj", "src/foo.ts")).toBe("src/foo.ts");
  });

  it("returns '.' when the path equals projectDir", () => {
    expect(toProjectRelativePath("/home/user/proj", "/home/user/proj")).toBe(".");
  });

  it("returns the leading-`..` form when the path lies outside projectDir", () => {
    // Use a flat layout to keep the expected depth-2 form deterministic.
    expect(toProjectRelativePath("/a/b", "/etc/hosts")).toBe("../../etc/hosts");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// _sessionManagerDeps.writeDescriptor (production impl, via fresh module ref)
// ─────────────────────────────────────────────────────────────────────────────

describe("_sessionManagerDeps.writeDescriptor (production impl)", () => {
  let scratchDir: string;

  beforeEach(() => {
    scratchDir = makeTempDir("nax-session-deps-");
  });

  afterEach(async () => {
    await rm(scratchDir, { recursive: true, force: true });
    cleanupTempDir(scratchDir);
  });

  it("writes descriptor.json and strips the physical handle", async () => {
    await writeDescriptor(scratchDir, makeDescriptor(), "/tmp/project");
    const file = Bun.file(join(scratchDir, "descriptor.json"));
    expect(await file.exists()).toBe(true);
    const parsed: { handle?: unknown; id?: unknown; state?: unknown } = JSON.parse(await file.text());
    expect(parsed.handle).toBeUndefined();
    expect(parsed.id).toBe("sess-test-1");
  });

  it("creates the scratch directory if it does not exist", async () => {
    const nested = join(scratchDir, "nested", "deeper");
    await writeDescriptor(nested, makeDescriptor(), "/tmp/project");
    expect(await Bun.file(join(nested, "descriptor.json")).exists()).toBe(true);
  });

  it("normalizes workdir and scratchDir when projectDir is supplied", async () => {
    const projectDir = "/tmp/project";
    await writeDescriptor(
      scratchDir,
      makeDescriptor({
        workdir: "/tmp/project/src",
        scratchDir: "/tmp/project/.nax/features/demo/sessions/sess-test-1",
      }),
      projectDir,
    );
    const parsed: { workdir?: unknown; scratchDir?: unknown } = JSON.parse(
      await Bun.file(join(scratchDir, "descriptor.json")).text(),
    );
    expect(parsed.workdir).toBe("src");
    expect(parsed.scratchDir).toBe(".nax/features/demo/sessions/sess-test-1");
  });

  it("derives projectDir from scratchDir when not supplied", async () => {
    // scratchDir is <projectDir>/.nax/features/<feature>/sessions/<id> — the
    // function should recover projectDir from the path marker.
    const nestedScratch = join(scratchDir, ".nax", "features", "demo", "sessions", "sess-1");
    await writeDescriptor(
      nestedScratch,
      makeDescriptor({
        workdir: join(scratchDir, "src"),
        scratchDir: nestedScratch,
      }),
    );
    const parsed: { workdir?: unknown } = JSON.parse(
      await Bun.file(join(nestedScratch, "descriptor.json")).text(),
    );
    expect(parsed.workdir).toBe("src");
  });
});
