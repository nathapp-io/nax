import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTempDir, makeLogger, makeNaxConfig, makeTempDir } from "@test/helpers";
import { buildCodingToolSupport, resolveCodingToolSupport } from "@/agents/coding-tool-support";
import { _codingToolDeps } from "@/tools";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "nax-support-"));
});

describe("buildCodingToolSupport", () => {
  test("builds a runtime advertising the intersection of declared and granted", () => {
    const support = buildCodingToolSupport({
      root,
      grants: [
        { tool: "Read", patterns: ["*"] },
        { tool: "Write", patterns: ["*"] },
      ],
      declared: ["Read", "Git"],
    });
    expect(support?.tools.map((t) => t.name)).toEqual(["Read"]);
  });

  test("returns undefined when the op declares no tools", () => {
    expect(buildCodingToolSupport({ root, grants: [{ tool: "Read", patterns: ["*"] }], declared: [] })).toBeUndefined();
  });

  test("returns undefined when the policy grants nothing", () => {
    expect(buildCodingToolSupport({ root, grants: [], declared: ["Read"] })).toBeUndefined();
  });

  test("returns undefined when the intersection is empty", () => {
    const support = buildCodingToolSupport({
      root,
      grants: [{ tool: "Write", patterns: ["*"] }],
      declared: ["Read"],
    });
    expect(support).toBeUndefined();
  });

  // The #1794 lesson: an empty root silently becomes process.cwd(), which with
  // -d is a different repository entirely. Refuse rather than guess.
  //
  // The CALLER is responsible for never producing an empty root: it passes
  // packageWorkdir(ctx.packageView), which returns repoRoot when packageDir is
  // "". These two cases guard the seam, they are not the expected path.
  test("fails loudly rather than defaulting when the root is missing", () => {
    expect(() =>
      buildCodingToolSupport({ root: undefined, grants: [{ tool: "Read", patterns: ["*"] }], declared: ["Read"] }),
    ).toThrow(/root/i);
  });

  test("fails loudly on an empty-string root", () => {
    expect(() =>
      buildCodingToolSupport({ root: "", grants: [{ tool: "Read", patterns: ["*"] }], declared: ["Read"] }),
    ).toThrow(/root/i);
  });

  test("the runtime it returns enforces the root", async () => {
    const support = buildCodingToolSupport({
      root,
      grants: [{ tool: "Read", patterns: ["*"] }],
      declared: ["Read"],
    });
    const outcome = await support?.runtime.callTool("Read", { path: "../../etc/hosts" });
    expect(outcome?.kind).toBe("denied");
  });
});

/**
 * The runtime's invocation log carries storyId as its first field, per the
 * structured-log convention. That is only possible if the story reaches the
 * runtime, so the thread is asserted here rather than assumed.
 */
/**
 * Where the ledger lands, asserted by writing one and reading it back off disk.
 *
 * Not a path-shape assertion on a helper: C2's bug was that the seam never
 * consulted the run's output dir at all, so every unit test on the path helper
 * would have stayed green. The only thing that proves the wiring is a flushed
 * file in the directory a run would actually keep.
 */
describe("resolveCodingToolSupport — ledger location", () => {
  test("writes the ledger under the run's output dir, not the (ephemeral) tool root", async () => {
    const root = makeTempDir("nax-audit-root-");
    const outputDir = makeTempDir("nax-audit-out-");
    try {
      await Bun.write(`${root}/a.ts`, "const a = 1;\n");
      const support = resolveCodingToolSupport({
        declaredTools: ["Read"],
        codingToolRoot: root,
        outputDir,
        pipelineStage: "review",
        storyId: "US-002",
        featureName: "auth-system",
        config: makeNaxConfig(),
      });

      await support?.runtime.callTool("Read", { path: "a.ts" });
      await support?.auditSink.flush();

      const written = [...new Bun.Glob("**/*.json").scanSync(join(outputDir, "tool-audit", "auth-system"))];
      expect(written.length).toBe(1);
      // Nothing at all under the tool root: the fallback tree is never created
      // when a run supplies an output dir, so the worktree removal that follows
      // a story cannot take the ledger with it.
      expect(existsSync(join(root, ".nax"))).toBe(false);
    } finally {
      cleanupTempDir(root);
      cleanupTempDir(outputDir);
    }
  });

  test("still falls back to the tool root when a run supplies no output dir", async () => {
    const root = makeTempDir("nax-audit-fallback-");
    try {
      await Bun.write(`${root}/a.ts`, "const a = 1;\n");
      const support = resolveCodingToolSupport({
        declaredTools: ["Read"],
        codingToolRoot: root,
        pipelineStage: "review",
        storyId: "US-002",
        featureName: "auth-system",
        config: makeNaxConfig(),
      });

      await support?.runtime.callTool("Read", { path: "a.ts" });
      await support?.auditSink.flush();

      const written = [...new Bun.Glob("*.json").scanSync(join(root, ".nax", "tool-audit", "auth-system"))];
      expect(written.length).toBe(1);
    } finally {
      cleanupTempDir(root);
    }
  });
});

describe("resolveCodingToolSupport — story correlation", () => {
  test("threads storyId from the run options into the runtime's log", async () => {
    const logger = makeLogger();
    const orig = _codingToolDeps.getLogger;
    _codingToolDeps.getLogger = () => logger;
    const root = makeTempDir("nax-tool-story-");
    try {
      await Bun.write(`${root}/a.ts`, "const a = 1;\n");
      const support = resolveCodingToolSupport({
        declaredTools: ["Read"],
        codingToolRoot: root,
        pipelineStage: "review",
        storyId: "US-002",
        config: makeNaxConfig(),
      });

      await support?.runtime.callTool("Read", { path: "a.ts" });

      const line = logger.calls.find((c) => c.stage === "coding-tool" && c.message === "invoked");
      expect(line?.data?.storyId).toBe("US-002");
    } finally {
      _codingToolDeps.getLogger = orig;
      cleanupTempDir(root);
    }
  });
});

/**
 * RunCommand cannot live in the global registry (its declared commands are
 * per-project), so it reaches the runtime through the session-local extraTools
 * layer. These three tests pin that seam — a producer that is never wired up
 * leaves every coding tool silently missing while per-task reviews pass.
 */
const runCommandGrants = [
  { tool: "RunCommand", patterns: ["*"] },
  { tool: "GitCommit", patterns: ["*"] },
];

describe("buildCodingToolSupport — declared-command seam and audit sink", () => {
  test("advertises a RunCommand built from the declared commands", () => {
    const support = buildCodingToolSupport({
      root: process.cwd(),
      grants: runCommandGrants,
      declared: ["RunCommand"],
      declaredCommands: new Map([["test", "bun run test"]]),
    });
    expect(support?.tools.map((t) => t.name)).toContain("RunCommand");
  });

  test("omits RunCommand when the project declares no commands", () => {
    const support = buildCodingToolSupport({
      root: process.cwd(),
      grants: runCommandGrants,
      declared: ["RunCommand"],
      declaredCommands: new Map(),
    });
    expect(support).toBeUndefined();
  });

  test("threads quality.stripEnvVars into the session-local RunCommand", async () => {
    const secretName = "NAX_C2_SUPPORT_SECRET";
    const previous = process.env[secretName];
    process.env[secretName] = "must-not-reach-the-model";
    try {
      const support = resolveCodingToolSupport({
        declaredTools: ["RunCommand"],
        codingToolRoot: process.cwd(),
        pipelineStage: "run",
        config: makeNaxConfig({
          quality: {
            commands: { test: `printf '%s' "$${secretName}"` },
            stripEnvVars: [secretName],
          },
        }),
      });
      const result = await support?.runtime.callTool("RunCommand", { command: "test" });
      expect(result?.kind).toBe("ok");
      if (result?.kind !== "ok") throw new Error("expected RunCommand to succeed");
      expect(result.content).not.toContain("must-not-reach-the-model");
    } finally {
      if (previous === undefined) delete process.env[secretName];
      else process.env[secretName] = previous;
    }
  });

  test("exposes an audit sink so calls can be persisted", () => {
    const support = buildCodingToolSupport({
      root: process.cwd(),
      grants: runCommandGrants,
      declared: ["GitCommit"],
      declaredCommands: new Map(),
      auditDir: "/tmp/c2-audit-test",
      sessionName: "s1",
    });
    expect(support?.auditSink).toBeDefined();
  });
});
