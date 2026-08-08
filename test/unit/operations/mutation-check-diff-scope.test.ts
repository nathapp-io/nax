/**
 * mutationCheckOp — diff-scoped candidate filtering (US-003).
 *
 * Covers AC7–AC15: the op fetches line ranges once via `_mutationCheckDeps.getChangedLineRanges`,
 * skips files without map entries, threads the ranges to `generateMutants`,
 * and emits the expected warn/debug log lines.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import * as loggerModule from "@/logger";
import { mutationCheckOp } from "@/operations";
import {
  cleanupTempDir,
  makeMutationCheckCtx,
  makeMutationCheckDeps as fakeDeps,
  makeTempDir,
} from "@test/helpers";
import * as mutationModule from "@/verification/mutation";

const FAKE_STORY = { id: "US-003", title: "scope mutation candidates" } as any;

const ctxWithConfig = (execution: Record<string, unknown> = {}) =>
  makeMutationCheckCtx(execution, { storyId: "US-003" });

describe("mutationCheckOp — US-003 AC7: getChangedLineRanges resolves to null", () => {
  test("returns success:true with outcomes { killed: 0, survived: 0, errored: 0 }", async () => {
    const dir = makeTempDir("nax-mutation-test-");
    try {
      const deps = fakeDeps({
        getChangedLineRanges: async () => null,
        getChangedNonTestFiles: async () => [join(dir, "src", "foo.ts")],
      });

      const out = await mutationCheckOp.execute(
        {
          story: FAKE_STORY,
          workdir: dir,
          storyId: "US-003",
          storyGitRef: "abc",
          repoRoot: dir,
          resolvedTestPatterns: { globs: [], regex: [], pathspec: [], testDirs: [] },
        },
        ctxWithConfig({ mutationCheck: { enabled: true, maxMutants: 3, timeoutSeconds: 60 } }),
        deps,
      );

      expect(out.success).toBe(true);
      expect(out.outcomes).toEqual({ killed: 0, survived: 0, errored: 0 });
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe("mutationCheckOp — US-003 AC8: null range result never invokes regression", () => {
  test("regression is not called when getChangedLineRanges returns null", async () => {
    const dir = makeTempDir("nax-mutation-test-");
    let regressionCalls = 0;
    try {
      const file = join(dir, "src", "foo.ts");
      await Bun.write(file, "if (a == b) { return 1; }\n");
      const deps = fakeDeps({
        getChangedLineRanges: async () => null,
        getChangedNonTestFiles: async () => [file],
        regression: async () => {
          regressionCalls += 1;
          return { status: "SUCCESS" as const, success: true, countsTowardEscalation: true, output: "" };
        },
      });

      await mutationCheckOp.execute(
        {
          story: FAKE_STORY,
          workdir: dir,
          storyId: "US-003",
          storyGitRef: "abc",
          repoRoot: dir,
          resolvedTestPatterns: { globs: [], regex: [], pathspec: [], testDirs: [] },
        },
        ctxWithConfig({ mutationCheck: { enabled: true, maxMutants: 3, timeoutSeconds: 60 } }),
        deps,
      );
      expect(regressionCalls).toBe(0);
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe("mutationCheckOp — US-003 AC9: null range result emits a warning with storyId", () => {
  let warnSpy: ReturnType<typeof spyOn> | undefined;

  beforeEach(async () => {
    const { resetLogger, initLogger } = await import("@/logger");
    resetLogger();
    initLogger({ level: "silent" });
    warnSpy = spyOn(loggerModule.getLogger(), "warn");
  });

  afterEach(async () => {
    warnSpy?.mockRestore();
    warnSpy = undefined;
    const { resetLogger } = await import("@/logger");
    resetLogger();
  });

  test("logger.warn is called with storyId='US-003' and a message mentioning the diff/range fallback", async () => {
    const dir = makeTempDir("nax-mutation-test-");
    try {
      const deps = fakeDeps({
        getChangedLineRanges: async () => null,
        getChangedNonTestFiles: async () => [join(dir, "src", "foo.ts")],
      });

      await mutationCheckOp.execute(
        {
          story: FAKE_STORY,
          workdir: dir,
          storyId: "US-003",
          storyGitRef: "abc",
          repoRoot: dir,
          resolvedTestPatterns: { globs: [], regex: [], pathspec: [], testDirs: [] },
        },
        ctxWithConfig({ mutationCheck: { enabled: true, maxMutants: 3, timeoutSeconds: 60 } }),
        deps,
      );

      const calls = warnSpy!.mock.calls as Array<[string, string, Record<string, unknown>]>;
      const matching = calls.filter(
        ([stage, message, data]) =>
          data?.storyId === "US-003" &&
          typeof message === "string" &&
          /diff|range|scope/i.test(message) &&
          (stage === "mutation-check" || data?.stage === "mutation-check"),
      );
      expect(matching.length).toBeGreaterThan(0);
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe("mutationCheckOp — US-003 AC10: changed file absent from range map is skipped", () => {
  test("generates no mutants for an unmapped file and resolves with success:true", async () => {
    const dir = makeTempDir("nax-mutation-test-");
    let regressionCalls = 0;
    try {
      const file = join(dir, "src", "foo.ts");
      await Bun.write(file, "if (a == b) { return 1; }\n");
      // Map does NOT include the file.
      const deps = fakeDeps({
        getChangedNonTestFiles: async () => [file],
        getChangedLineRanges: async () => new Map(),
        regression: async () => {
          regressionCalls += 1;
          return { status: "SUCCESS" as const, success: true, countsTowardEscalation: true, output: "" };
        },
      });

      const out = await mutationCheckOp.execute(
        {
          story: FAKE_STORY,
          workdir: dir,
          storyId: "US-003",
          storyGitRef: "abc",
          repoRoot: dir,
          resolvedTestPatterns: { globs: [], regex: [], pathspec: [], testDirs: [] },
        },
        ctxWithConfig({ mutationCheck: { enabled: true, maxMutants: 3, timeoutSeconds: 60 } }),
        deps,
      );

      expect(out.success).toBe(true);
      expect(out.survivors).toEqual([]);
      expect(out.outcomes).toEqual({ killed: 0, survived: 0, errored: 0 });
      expect(regressionCalls).toBe(0);
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe("mutationCheckOp — US-003 AC11: unmapped file emits a debug log with storyId and file", () => {
  let debugSpy: ReturnType<typeof spyOn> | undefined;

  beforeEach(async () => {
    const { resetLogger, initLogger } = await import("@/logger");
    resetLogger();
    initLogger({ level: "silent" });
    debugSpy = spyOn(loggerModule.getLogger(), "debug");
  });

  afterEach(async () => {
    debugSpy?.mockRestore();
    debugSpy = undefined;
    const { resetLogger } = await import("@/logger");
    resetLogger();
  });

  test("logger.debug is called with storyId='US-003' and the unmapped file path", async () => {
    const dir = makeTempDir("nax-mutation-test-");
    try {
      const file = join(dir, "src", "foo.ts");
      const deps = fakeDeps({
        getChangedNonTestFiles: async () => [file],
        getChangedLineRanges: async () => new Map(),
      });

      await mutationCheckOp.execute(
        {
          story: FAKE_STORY,
          workdir: dir,
          storyId: "US-003",
          storyGitRef: "abc",
          repoRoot: dir,
          resolvedTestPatterns: { globs: [], regex: [], pathspec: [], testDirs: [] },
        },
        ctxWithConfig({ mutationCheck: { enabled: true, maxMutants: 3, timeoutSeconds: 60 } }),
        deps,
      );

      const calls = debugSpy!.mock.calls as Array<[string, string, Record<string, unknown>]>;
      const matching = calls.filter(
        ([, , data]) => data?.storyId === "US-003" && data?.file === file,
      );
      expect(matching.length).toBeGreaterThan(0);
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe("mutationCheckOp — US-003 AC12: generateMutants receives the file's lineRanges", () => {
  test("the lineRanges returned for a mapped file are forwarded to generateMutants", async () => {
    const dir = makeTempDir("nax-mutation-test-");
    const capturedInputs: mutationModule.GenerateMutantsInput[] = [];
    const origGenerateMutants = mutationModule.generateMutants;
    const spy = spyOn(mutationModule, "generateMutants").mockImplementation((input) => {
      capturedInputs.push(input);
      return origGenerateMutants(input);
    });
    try {
      const file = join(dir, "src", "foo.ts");
      await Bun.write(file, "// just a comment\n");
      const fileRanges = [{ start: 5, end: 5 }];
      const deps = fakeDeps({
        getChangedNonTestFiles: async () => [file],
        getChangedLineRanges: async () => new Map([[file, fileRanges]]),
      });

      await mutationCheckOp.execute(
        {
          story: FAKE_STORY,
          workdir: dir,
          storyId: "US-003",
          storyGitRef: "abc",
          repoRoot: dir,
          resolvedTestPatterns: { globs: [], regex: [], pathspec: [], testDirs: [] },
        },
        ctxWithConfig({ mutationCheck: { enabled: true, maxMutants: 10, timeoutSeconds: 60 } }),
        deps,
      );

      // AC12: generateMutants must be invoked with the file's lineRanges —
      // assert against the captured call, not against out.survivors (which
      // is empty for a comment-only source, making a survivor-loop assertion
      // vacuous).
      const callsForFile = capturedInputs.filter((i) => i.file === file);
      expect(callsForFile).toHaveLength(1);
      expect(callsForFile[0]?.lineRanges).toEqual(fileRanges);
    } finally {
      spy.mockRestore();
      cleanupTempDir(dir);
    }
  });
});

describe("mutationCheckOp — US-003 AC13: getChangedLineRanges is invoked exactly once", () => {
  test("calls getChangedLineRanges exactly once with story workdir and storyGitRef", async () => {
    const dir = makeTempDir("nax-mutation-test-");
    try {
      let calls = 0;
      let capturedWorkdir: string | undefined;
      let capturedRef: string | undefined;
      const deps = fakeDeps({
        getChangedNonTestFiles: async () => [join(dir, "src", "foo.ts")],
        getChangedLineRanges: async (wd: string, ref?: string) => {
          calls += 1;
          capturedWorkdir = wd;
          capturedRef = ref;
          return new Map();
        },
      });

      await mutationCheckOp.execute(
        {
          story: FAKE_STORY,
          workdir: dir,
          storyId: "US-003",
          storyGitRef: "abc123",
          repoRoot: dir,
          resolvedTestPatterns: { globs: [], regex: [], pathspec: [], testDirs: [] },
        },
        ctxWithConfig({ mutationCheck: { enabled: true, maxMutants: 3, timeoutSeconds: 60 } }),
        deps,
      );

      expect(calls).toBe(1);
      expect(capturedWorkdir).toBe(dir);
      expect(capturedRef).toBe("abc123");
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe("mutationCheckOp — US-003 AC14: file with no mutable content never invokes regression", () => {
  test("a file mapped to comment-only ranges resolves with success:true and no regression", async () => {
    const dir = makeTempDir("nax-mutation-test-");
    let regressionCalls = 0;
    try {
      const file = join(dir, "src", "foo.ts");
      await Bun.write(file, "// just a comment\n");
      const deps = fakeDeps({
        getChangedNonTestFiles: async () => [file],
        getChangedLineRanges: async () => new Map([[file, [{ start: 1, end: 1 }]]]),
        regression: async () => {
          regressionCalls += 1;
          return { status: "SUCCESS" as const, success: true, countsTowardEscalation: true, output: "" };
        },
      });

      const out = await mutationCheckOp.execute(
        {
          story: FAKE_STORY,
          workdir: dir,
          storyId: "US-003",
          storyGitRef: "abc",
          repoRoot: dir,
          resolvedTestPatterns: { globs: [], regex: [], pathspec: [], testDirs: [] },
        },
        ctxWithConfig({ mutationCheck: { enabled: true, maxMutants: 3, timeoutSeconds: 60 } }),
        deps,
      );

      expect(out.success).toBe(true);
      expect(out.survivors).toEqual([]);
      expect(out.outcomes).toEqual({ killed: 0, survived: 0, errored: 0 });
      expect(regressionCalls).toBe(0);
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe("mutationCheckOp — US-003 AC15: file with no mutable content emits no warning", () => {
  let warnSpy: ReturnType<typeof spyOn> | undefined;

  beforeEach(async () => {
    const { resetLogger, initLogger } = await import("@/logger");
    resetLogger();
    initLogger({ level: "silent" });
    warnSpy = spyOn(loggerModule.getLogger(), "warn");
  });

  afterEach(async () => {
    warnSpy?.mockRestore();
    warnSpy = undefined;
    const { resetLogger } = await import("@/logger");
    resetLogger();
  });

  test("no warn is emitted for a file whose ranges contain no mutable content", async () => {
    const dir = makeTempDir("nax-mutation-test-");
    try {
      const file = join(dir, "src", "foo.ts");
      await Bun.write(file, "// just a comment\n");
      const deps = fakeDeps({
        getChangedNonTestFiles: async () => [file],
        getChangedLineRanges: async () => new Map([[file, [{ start: 1, end: 1 }]]]),
      });

      await mutationCheckOp.execute(
        {
          story: FAKE_STORY,
          workdir: dir,
          storyId: "US-003",
          storyGitRef: "abc",
          repoRoot: dir,
          resolvedTestPatterns: { globs: [], regex: [], pathspec: [], testDirs: [] },
        },
        ctxWithConfig({ mutationCheck: { enabled: true, maxMutants: 3, timeoutSeconds: 60 } }),
        deps,
      );

      const calls = warnSpy!.mock.calls as Array<[string, string, Record<string, unknown>]>;
      const matching = calls.filter(
        ([, message, data]) =>
          data?.storyId === "US-003" && data?.file === file && typeof message === "string",
      );
      expect(matching).toHaveLength(0);
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe("mutationCheckOp — issue #1485: anchor root matches getChangedLineRanges when repoRoot diverges from git root and packagePrefix is unset", () => {
  test("without packagePrefix, changed files anchor to the resolved git root — not repoRoot — so range-map lookups hit", async () => {
    const dir = makeTempDir("nax-mutation-test-");
    try {
      // Simulate repoRoot sitting deeper than the true git root (e.g. a
      // subdirectory checkout) with no packagePrefix configured — the
      // exact divergence case from #1485. getChangedNonTestFiles returns a
      // git-root-relative path (still inside repoRoot's own subtree — this
      // is an in-scope file, just anchored wrong); getChangedLineRanges
      // keys its map against the same resolved git root.
      const gitRoot = dir;
      const repoRoot = join(dir, "nested-repo-root");
      const relativeFile = "nested-repo-root/src/foo.ts";
      const absoluteFile = join(gitRoot, relativeFile);
      await Bun.write(absoluteFile, "if (a == b) { return 1; }\n");

      const deps = fakeDeps({
        getGitRoot: async () => gitRoot,
        getChangedNonTestFiles: async () => [relativeFile],
        getChangedLineRanges: async () => new Map([[absoluteFile, [{ start: 1, end: 1 }]]]),
      });

      const out = await mutationCheckOp.execute(
        {
          story: FAKE_STORY,
          workdir: dir,
          storyId: "US-003",
          storyGitRef: "abc123",
          repoRoot,
          resolvedTestPatterns: { globs: [], regex: [], pathspec: [], testDirs: [] },
        },
        ctxWithConfig({ mutationCheck: { enabled: true, maxMutants: 3, timeoutSeconds: 60 } }),
        deps,
      );

      expect(out.candidates).toBeGreaterThan(0);
    } finally {
      cleanupTempDir(dir);
    }
  });

  test("with packagePrefix set, changed files still anchor to repoRoot (existing #565 behavior preserved)", async () => {
    const dir = makeTempDir("nax-mutation-test-");
    try {
      const repoRoot = dir;
      const relativeFile = "packages/api/src/foo.ts";
      const absoluteFile = join(repoRoot, relativeFile);
      await Bun.write(absoluteFile, "if (a == b) { return 1; }\n");

      // Assert the anchoring OUTCOME, not that getGitRoot goes uncalled: the
      // journal anchors to the working tree's git root, so the dep is now
      // reached on every run. Handing back a bogus root proves the changed-file
      // anchor ignores it — a stronger guarantee than a never-called stub, and
      // one that does not break the next caller who legitimately needs the dep.
      const deps = fakeDeps({
        getGitRoot: async () => "/somewhere/else/entirely",
        getChangedNonTestFiles: async () => [relativeFile],
        getChangedLineRanges: async () => new Map([[absoluteFile, [{ start: 1, end: 1 }]]]),
      });

      const out = await mutationCheckOp.execute(
        {
          story: FAKE_STORY,
          workdir: dir,
          storyId: "US-003",
          storyGitRef: "abc123",
          repoRoot,
          packagePrefix: "packages/api",
          resolvedTestPatterns: { globs: [], regex: [], pathspec: [], testDirs: [] },
        },
        ctxWithConfig({ mutationCheck: { enabled: true, maxMutants: 3, timeoutSeconds: 60 } }),
        deps,
      );

      expect(out.candidates).toBeGreaterThan(0);
    } finally {
      cleanupTempDir(dir);
    }
  });

  test("warns once when every changed file misses the range map (total anchoring failure signal)", async () => {
    const dir = makeTempDir("nax-mutation-test-");
    const warnSpy = spyOn(loggerModule.getLogger(), "warn");
    try {
      const file = join(dir, "src", "foo.ts");
      await Bun.write(file, "if (a == b) { return 1; }\n");
      const deps = fakeDeps({
        getChangedNonTestFiles: async () => [file],
        getChangedLineRanges: async () => new Map([[join(dir, "src", "other.ts"), [{ start: 1, end: 1 }]]]),
      });

      const out = await mutationCheckOp.execute(
        {
          story: FAKE_STORY,
          workdir: dir,
          storyId: "US-003",
          storyGitRef: "abc123",
          repoRoot: dir,
          resolvedTestPatterns: { globs: [], regex: [], pathspec: [], testDirs: [] },
        },
        ctxWithConfig({ mutationCheck: { enabled: true, maxMutants: 3, timeoutSeconds: 60 } }),
        deps,
      );

      expect(out.candidates).toBe(0);
      const calls = warnSpy.mock.calls as Array<[string, string, Record<string, unknown>]>;
      const totalMissWarn = calls.filter(
        ([, message]) => typeof message === "string" && message.includes("zero candidates"),
      );
      expect(totalMissWarn).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
      cleanupTempDir(dir);
    }
  });

  test("without packagePrefix, a changed file outside repoRoot (but inside the git root) is filtered out of scope", async () => {
    const dir = makeTempDir("nax-mutation-test-");
    try {
      // git root is an ancestor of repoRoot; the changed file sits in a
      // sibling directory that is inside the git root but outside the
      // project's own repoRoot — it must never become a mutation candidate.
      const gitRoot = dir;
      const repoRoot = join(dir, "nested-repo-root");
      const siblingFile = join(gitRoot, "other-project", "src", "foo.ts");
      await Bun.write(siblingFile, "if (a == b) { return 1; }\n");

      const deps = fakeDeps({
        getGitRoot: async () => gitRoot,
        getChangedNonTestFiles: async () => ["other-project/src/foo.ts"],
        getChangedLineRanges: async () => new Map([[siblingFile, [{ start: 1, end: 1 }]]]),
      });

      const out = await mutationCheckOp.execute(
        {
          story: FAKE_STORY,
          workdir: dir,
          storyId: "US-003",
          storyGitRef: "abc123",
          repoRoot,
          resolvedTestPatterns: { globs: [], regex: [], pathspec: [], testDirs: [] },
        },
        ctxWithConfig({ mutationCheck: { enabled: true, maxMutants: 3, timeoutSeconds: 60 } }),
        deps,
      );

      expect(out.candidates).toBe(0);
    } finally {
      cleanupTempDir(dir);
    }
  });

  test("packagePrefix set without repoRoot still anchors to the resolved git root, not workdir", async () => {
    const dir = makeTempDir("nax-mutation-test-");
    try {
      // packagePrefix alone does not trigger getChangedNonTestFiles's prefix
      // surgery (it also requires repoRoot) — so paths stay git-root-relative
      // here too, and the op must fall back to the git-root anchor.
      const gitRoot = dir;
      const relativeFile = "packages/api/src/foo.ts";
      const absoluteFile = join(gitRoot, relativeFile);
      await Bun.write(absoluteFile, "if (a == b) { return 1; }\n");

      const deps = fakeDeps({
        getGitRoot: async () => gitRoot,
        getChangedNonTestFiles: async () => [relativeFile],
        getChangedLineRanges: async () => new Map([[absoluteFile, [{ start: 1, end: 1 }]]]),
      });

      const out = await mutationCheckOp.execute(
        {
          story: FAKE_STORY,
          workdir: dir,
          storyId: "US-003",
          storyGitRef: "abc123",
          packagePrefix: "packages/api",
          resolvedTestPatterns: { globs: [], regex: [], pathspec: [], testDirs: [] },
        },
        ctxWithConfig({ mutationCheck: { enabled: true, maxMutants: 3, timeoutSeconds: 60 } }),
        deps,
      );

      expect(out.candidates).toBeGreaterThan(0);
    } finally {
      cleanupTempDir(dir);
    }
  });
});
