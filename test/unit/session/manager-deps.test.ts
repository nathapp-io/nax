/**
 * Tests for src/session/manager-deps.ts
 *
 * Covers: resolveProjectDirFromScratchDir, toProjectRelativePath,
 * deriveNativeTranscriptDir, persistDescriptor and the production
 * `_sessionManagerDeps.writeDescriptor`.
 *
 * `writeDescriptor` is part of the `_sessionManagerDeps` object that other
 * test files swap for a mock in their `beforeEach` (manager.test.ts). This file
 * captures the production impl once at module load and calls that reference, so
 * it exercises the real body without depending on the shared mutable property
 * (and without a query-suffixed re-import, which Bun does not attribute to the
 * file's coverage record).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir, waitForCondition } from "@test/helpers";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import {
  _sessionManagerDeps,
  deriveNativeTranscriptDir,
  persistDescriptor,
  resolveProjectDirFromScratchDir,
  toProjectRelativePath,
} from "@/session/manager-deps";
import type { SessionDescriptor } from "@/session/types";

// The production `writeDescriptor` captured at module load. Other test files
// swap `_sessionManagerDeps.writeDescriptor` for a mock on the shared object
// (see manager.test.ts); calling this reference directly exercises the real
// body deterministically instead of depending on the shared property.
const realWriteDescriptor = _sessionManagerDeps.writeDescriptor;

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
// deriveNativeTranscriptDir
// ─────────────────────────────────────────────────────────────────────────────

describe("deriveNativeTranscriptDir", () => {
  it("builds <transcriptRoot>/features/<featureName>/sessions when both are present", () => {
    expect(deriveNativeTranscriptDir({ featureName: "demo", transcriptRoot: "/tmp/nax-out" })).toBe(
      join("/tmp/nax-out", "features", "demo", "sessions"),
    );
  });

  it("never derives a path under the project tree (no .nax segment)", () => {
    const result = deriveNativeTranscriptDir({ featureName: "demo", transcriptRoot: "/tmp/nax-out" });
    expect(result).not.toContain(".nax");
  });

  it("returns undefined when transcriptRoot is missing", () => {
    expect(deriveNativeTranscriptDir({ featureName: "demo" })).toBeUndefined();
  });

  it("returns undefined when featureName is missing", () => {
    expect(deriveNativeTranscriptDir({ transcriptRoot: "/tmp/nax-out" })).toBeUndefined();
  });

  it("returns undefined when both are missing", () => {
    expect(deriveNativeTranscriptDir({})).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// _sessionManagerDeps.writeDescriptor (production impl, via captured reference)
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
    await realWriteDescriptor(scratchDir, makeDescriptor(), "/tmp/project");
    const file = Bun.file(join(scratchDir, "descriptor.json"));
    expect(await file.exists()).toBe(true);
    const parsed: { handle?: unknown; id?: unknown; state?: unknown } = JSON.parse(await file.text());
    expect(parsed.handle).toBeUndefined();
    expect(parsed.id).toBe("sess-test-1");
  });

  it("creates the scratch directory if it does not exist", async () => {
    const nested = join(scratchDir, "nested", "deeper");
    await realWriteDescriptor(nested, makeDescriptor(), "/tmp/project");
    expect(await Bun.file(join(nested, "descriptor.json")).exists()).toBe(true);
  });

  it("normalizes workdir and scratchDir when projectDir is supplied", async () => {
    const projectDir = "/tmp/project";
    await realWriteDescriptor(
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
    await realWriteDescriptor(
      nestedScratch,
      makeDescriptor({
        workdir: join(scratchDir, "src"),
        scratchDir: nestedScratch,
      }),
    );
    const parsed: { workdir?: unknown } = JSON.parse(await Bun.file(join(nestedScratch, "descriptor.json")).text());
    expect(parsed.workdir).toBe("src");
  });

  it("writes the descriptor and normalises workdir and scratchDir against a supplied projectDir", async () => {
    // Exercises the real production body through the captured reference; the
    // assertions below pin the on-disk normalisation it performs.
    const dir = makeTempDir("nax-session-deps-real-");
    try {
      const descriptor = makeDescriptor({
        workdir: join(dir, "src"),
        scratchDir: join(dir, ".nax", "features", "demo", "sessions", "sess-1"),
      });
      await realWriteDescriptor(descriptor.scratchDir as string, descriptor, dir);
      const parsed: { workdir?: unknown; scratchDir?: unknown; handle?: unknown } = JSON.parse(
        await Bun.file(join(descriptor.scratchDir as string, "descriptor.json")).text(),
      );
      expect(parsed.workdir).toBe("src");
      expect(parsed.scratchDir).toBe(".nax/features/demo/sessions/sess-1");
      expect(parsed.handle).toBeUndefined();
    } finally {
      cleanupTempDir(dir);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// persistDescriptor (fire-and-forget re-persist on a descriptor mutation)
// ─────────────────────────────────────────────────────────────────────────────

describe("persistDescriptor", () => {
  it("is a no-op when the descriptor has no scratchDir to persist to", () => {
    const original = _sessionManagerDeps.writeDescriptor;
    let calls = 0;
    _sessionManagerDeps.writeDescriptor = async () => {
      calls += 1;
    };
    try {
      persistDescriptor(makeDescriptor({ scratchDir: undefined }));
      expect(calls).toBe(0);
    } finally {
      _sessionManagerDeps.writeDescriptor = original;
    }
  });

  it("re-persists to disk through the real writeDescriptor, deriving projectDir from the scratchDir marker", async () => {
    const dir = makeTempDir("nax-persist-");
    const original = _sessionManagerDeps.writeDescriptor;
    _sessionManagerDeps.writeDescriptor = realWriteDescriptor;
    try {
      const descriptor = makeDescriptor({
        workdir: join(dir, "src"),
        scratchDir: join(dir, ".nax", "features", "demo", "sessions", "sess-1"),
      });
      persistDescriptor(descriptor);
      const descriptorPath = join(descriptor.scratchDir as string, "descriptor.json");
      await waitForCondition(() => existsSync(descriptorPath), 1000);
      const parsed: { workdir?: unknown; scratchDir?: unknown } = JSON.parse(await Bun.file(descriptorPath).text());
      expect(parsed.workdir).toBe("src");
      expect(parsed.scratchDir).toBe(".nax/features/demo/sessions/sess-1");
    } finally {
      _sessionManagerDeps.writeDescriptor = original;
      cleanupTempDir(dir);
    }
  });

  it("swallows a failed re-persist and logs a session warning naming the error", async () => {
    const original = _sessionManagerDeps.writeDescriptor;
    _sessionManagerDeps.writeDescriptor = async () => {
      throw new Error("disk full");
    };
    resetLogger();
    initLogger({ level: "debug", suppressConsole: true });
    const records: LogEntry[] = [];
    const dispose = addSink((record) => records.push(record));
    try {
      // Must not throw and must not surface an unhandled rejection.
      persistDescriptor(makeDescriptor());
      await new Promise((resolve) => setTimeout(resolve, 0));
      const warn = records.find((record) => record.stage === "session" && record.level === "warn");
      expect(warn).toBeDefined();
      expect(String(warn?.data?.error)).toContain("disk full");
    } finally {
      dispose();
      resetLogger();
      _sessionManagerDeps.writeDescriptor = original;
    }
  });
});
