import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { realpath as realpathAsync } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTempDir, makeLogger, makeNaxConfig, makeTempDir } from "@test/helpers";
import { _codingToolSupportDeps, buildCodingToolSupport, resolveCodingToolSupport } from "@/agents/coding-tool-support";
import { loadConfigForPackage, packageConfigCache } from "@/config";
import { _clearRootConfigCache } from "@/config/loader";
import { addSink, initLogger, resetLogger } from "@/logger";
import type { LogEntry } from "@/logger/types";
import { verifierOp } from "@/operations";
import { VERDICT_FILE } from "@/tdd";
import { _codingToolDeps } from "@/tools";
import { gitWithTimeout } from "@/utils/git";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "nax-support-"));
  // The deny/ask tests read a granted file to prove only the matching rule
  // refuses; Read on a missing path returns kind "error", masking the "ok".
  writeFileSync(join(root, "file.txt"), "x");
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
      const support = await resolveCodingToolSupport({
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
      const support = await resolveCodingToolSupport({
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

describe("resolveCodingToolSupport — denyPaths (nax#1972)", () => {
  test("config.execution.denyPaths reaches Delete through resolveCodingToolSupport", async () => {
    const root = makeTempDir("nax-denypaths-");
    try {
      await Bun.write(`${root}/tracked.ts`, "const a = 1;\n");
      await gitWithTimeout(["init", "-q", "."], root, 30_000);
      await gitWithTimeout(["config", "user.email", "t@example.com"], root, 30_000);
      await gitWithTimeout(["config", "user.name", "t"], root, 30_000);
      await gitWithTimeout(["add", "-A"], root, 30_000);
      await gitWithTimeout(["commit", "-q", "-m", "init"], root, 30_000);

      const support = await resolveCodingToolSupport({
        declaredTools: ["Delete"],
        codingToolRoot: root,
        pipelineStage: "run",
        config: makeNaxConfig({ execution: { denyPaths: ["tracked.ts"] } }),
      });

      const outcome = await support?.runtime.callTool("Delete", { path: "tracked.ts" });
      expect(outcome?.kind).toBe("error");
      if (outcome?.kind !== "error") throw new Error("expected a tool-level refusal");
      expect(outcome.content).toContain("denyPaths");
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
      const support = await resolveCodingToolSupport({
        declaredTools: ["Read"],
        codingToolRoot: root,
        pipelineStage: "review",
        storyId: "US-002",
        config: makeNaxConfig(),
      });

      await support?.runtime.callTool("Read", { path: "a.ts" });

      // The message now names the tool and outcome ("Read ok"); the stage is the
      // stable selector.
      const line = logger.calls.find((c) => c.stage === "coding-tool");
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
      const support = await resolveCodingToolSupport({
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

describe("buildCodingToolSupport — commandCwd reaches RunCommand (PR1)", () => {
  test("a declared command runs at commandCwd, not root, when the two differ", async () => {
    const containmentRoot = makeTempDir("nax-support-cwd-root-");
    const packageCwd = makeTempDir("nax-support-cwd-pkg-");
    try {
      const support = buildCodingToolSupport({
        root: containmentRoot,
        commandCwd: packageCwd,
        grants: runCommandGrants,
        declared: ["RunCommand"],
        declaredCommands: new Map([["where", "pwd"]]),
      });
      const result = await support?.runtime.callTool("RunCommand", { command: "where" });
      expect(result?.kind).toBe("ok");
      if (result?.kind !== "ok") throw new Error("expected RunCommand to succeed");
      expect(result.content).toContain(await realpathAsync(packageCwd));
      expect(result.content).not.toContain(await realpathAsync(containmentRoot));
    } finally {
      cleanupTempDir(containmentRoot);
      cleanupTempDir(packageCwd);
    }
  });
});

/**
 * End-to-end proof that an op's `toolPatterns` actually reach the compiled
 * policy at dispatch time (nax#2013) -- not just that `narrowGrants` behaves
 * correctly in isolation, and not just that `verifierOp.tools` /
 * `verifierOp.toolPatterns` hold the right literals. Exercises the real seam
 * (`buildCodingToolSupport` -> `narrowGrants` -> `compileToolPolicy`) under an
 * `unrestricted`-shaped grant set (`["*"]`), the exact shape that would hide a
 * dropped forwarding: a permit-only assertion would still pass if
 * `toolPatterns` were silently ignored, so the refusal case is load-bearing.
 */
describe("buildCodingToolSupport — toolPatterns reaches the compiled policy (nax#2013)", () => {
  let verifierRoot: string;

  beforeEach(() => {
    verifierRoot = makeTempDir("nax-verifier-toolpatterns-");
  });

  afterEach(() => {
    cleanupTempDir(verifierRoot);
  });

  function buildVerifierSupport() {
    const unrestrictedGrants = verifierOp.tools?.map((tool) => ({ tool, patterns: ["*"] })) ?? [];
    return buildCodingToolSupport({
      root: verifierRoot,
      grants: unrestrictedGrants,
      declared: verifierOp.tools ?? [],
      toolPatterns: verifierOp.toolPatterns,
    });
  }

  test("permits a write to the verdict file", async () => {
    const support = buildVerifierSupport();

    const outcome = await support?.runtime.callTool("Write", { path: VERDICT_FILE, content: "{}" });

    expect(outcome?.kind).toBe("ok");
  });

  test("refuses a write to any other path -- the half a dropped forwarding would not catch", async () => {
    const support = buildVerifierSupport();

    const outcome = await support?.runtime.callTool("Write", { path: "src/index.ts", content: "// nope" });

    expect(outcome?.kind).toBe("denied");
  });
});

/**
 * The deny/ask rule lists travel from resolved permissions into the compiled
 * policy through this seam. Without the forwarding, a stage's deny/ask config
 * is silently inert: the tool runs as if the rule did not exist.
 */
describe("buildCodingToolSupport — deny/ask rule plumbing", () => {
  test("a deny rule reaches the compiled policy", async () => {
    const support = buildCodingToolSupport({
      root,
      grants: [{ tool: "Read", patterns: ["*"] }],
      declared: ["Read"],
      denyRules: [{ tool: "Read", patterns: [".env*"] }],
    });
    expect(support).toBeDefined();
    const denied = await support?.runtime.callTool("Read", { path: ".env.local" });
    expect(denied?.kind).toBe("denied");
    const allowed = await support?.runtime.callTool("Read", { path: "file.txt" });
    expect(allowed?.kind).toBe("ok");
  });

  // narrowGrants only rewrites allow grants; deny/ask are separate args and
  // therefore bypass it by construction. This pins that an op's toolPatterns
  // cannot silently erase a deny rule.
  test("op toolPatterns narrowing does not erase a deny rule", async () => {
    const support = buildCodingToolSupport({
      root,
      grants: [{ tool: "Write", patterns: ["*"] }],
      declared: ["Write"],
      toolPatterns: { Write: ["src/**"] },
      denyRules: [{ tool: "Write", patterns: ["src/generated/**"] }],
    });
    const denied = await support?.runtime.callTool("Write", {
      path: "src/generated/x.ts",
      content: "x",
    });
    expect(denied?.kind).toBe("denied");
  });
});

/**
 * Task 3 concatenates the unrestricted baseline's Exec grant with the stage's
 * `allow` rules, and the compiled policy is last-write-wins per tool. The
 * advertised allowlist (RunCommand's description) must read the LAST grant —
 * `find` (first) would name the baseline patterns the policy no longer
 * enforces, telling the model forms are ungrantable that would actually pass.
 */
describe("buildCodingToolSupport — Exec grant selection (findLast)", () => {
  test("advertises the last Exec grant, matching the policy's last-write-wins", async () => {
    const execution: Record<string, unknown> = {
      permissionProfile: "unrestricted",
      permissions: { run: { allow: ["Exec(bun x tsc*)"] } },
    };
    const support = await resolveCodingToolSupport({
      declaredTools: ["RunCommand", "Exec"],
      codingToolRoot: root,
      pipelineStage: "run",
      config: makeNaxConfig({ execution }),
    });
    const runCommand = support?.tools.find((tool) => tool.name === "RunCommand");
    expect(runCommand?.description).toContain("permitted forms: bun x tsc*");
  });
});

describe("resolveCodingToolSupport — dispatch visibility (#2066)", () => {
  let logCalls: LogEntry[];

  beforeEach(() => {
    resetLogger();
    logCalls = [];
    initLogger({ level: "silent" });
    addSink((entry) => logCalls.push(entry));
  });

  afterEach(() => {
    resetLogger();
  });

  test("logs the declared command keys and the resolved permission profile", async () => {
    const root = makeTempDir("nax-dispatch-log-");
    await resolveCodingToolSupport({
      declaredTools: ["Read"],
      codingToolRoot: root,
      pipelineStage: "run",
      storyId: "US-005",
      config: makeNaxConfig({ quality: { commands: { testScoped: "pkg-runner {{files}}" } } }),
    });

    const entry = logCalls.find((l) => l.message.includes("Declared commands resolved"));
    expect(entry).toBeDefined();
    expect(entry?.data?.commands).toEqual(["testScoped"]);
    expect(entry?.data?.storyId).toBe("US-005");
    // DEFAULT_CONFIG.execution.permissionProfile is "unrestricted"; the test's
    // quality override leaves it untouched, so that is the resolved value.
    expect(entry?.data?.permissionProfile).toBe("unrestricted");
  });
});

describe("resolveCodingToolSupport — per-package declared commands (#2066 residual)", () => {
  let tempDir: string;
  let originalGlobalDir: string | undefined;

  beforeEach(() => {
    tempDir = makeTempDir("nax-coding-tool-pkg-");
    originalGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;
    process.env.NAX_GLOBAL_CONFIG_DIR = join(tempDir, ".global-nax");
    mkdirSync(join(tempDir, ".nax", "mono", "packages", "api"), { recursive: true });
    mkdirSync(join(tempDir, "packages", "api"), { recursive: true });
    writeFileSync(join(tempDir, ".nax", "config.json"), JSON.stringify({}));
    writeFileSync(
      join(tempDir, ".nax", "mono", "packages", "api", "config.json"),
      JSON.stringify({ quality: { commands: { test: "echo PACKAGE" } } }),
    );
    _clearRootConfigCache();
    packageConfigCache.clear();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
    if (originalGlobalDir === undefined) delete process.env.NAX_GLOBAL_CONFIG_DIR;
    else process.env.NAX_GLOBAL_CONFIG_DIR = originalGlobalDir;
    _clearRootConfigCache();
    packageConfigCache.clear();
  });

  test("a package story's RunCommand runs the PACKAGE override, not the root-only config a stale caller threaded", async () => {
    const packageDir = join(tempDir, "packages", "api");
    const support = await resolveCodingToolSupport({
      declaredTools: ["RunCommand"],
      codingToolRoot: packageDir,
      codingToolPackageDir: "packages/api",
      projectDir: tempDir,
      pipelineStage: "run",
      // Simulates the #2066 residual directly: options.config still carries
      // a ROOT-only "test" command. resolveCodingToolSupport must resolve
      // the PACKAGE override from disk rather than trusting this value.
      config: makeNaxConfig({ quality: { commands: { test: "echo ROOT" } } }),
    });
    const result = await support?.runtime.callTool("RunCommand", { command: "test" });
    expect(result?.kind).toBe("ok");
    if (result?.kind !== "ok") throw new Error("expected RunCommand to succeed");
    expect(result.content).toContain("PACKAGE");
    expect(result.content).not.toContain("ROOT");
  });

  test("the resolved package config is cached — second dispatch for the same package/profile hits packageConfigCache", async () => {
    const packageDir = join(tempDir, "packages", "api");
    const dispatch = () =>
      resolveCodingToolSupport({
        declaredTools: ["RunCommand"],
        codingToolRoot: packageDir,
        codingToolPackageDir: "packages/api",
        projectDir: tempDir,
        pipelineStage: "run",
        config: makeNaxConfig(),
      });

    await dispatch();
    const rootConfigPath = join(tempDir, ".nax", "config.json");
    const afterFirst = packageConfigCache.get(rootConfigPath, "packages/api", "");
    expect(afterFirst).toBeDefined();

    await dispatch();
    const afterSecond = packageConfigCache.get(rootConfigPath, "packages/api", "");
    // Reference equality: a cache HIT returns the exact object
    // loadConfigForWorkdir built on the first call. A re-parse (cache MISS)
    // would construct a fresh object via NaxConfigSchema.safeParse — deep-
    // equal but a different reference — and fail this assertion.
    expect(afterSecond).toBe(afterFirst);
  });

  test("RunCommand's resolved 'test' template equals loadConfigForPackage's — the resolver acceptance-setup.ts already uses", async () => {
    const rootConfig = makeNaxConfig();
    const acceptanceResolved = await loadConfigForPackage(tempDir, "packages/api", rootConfig);
    expect(acceptanceResolved.quality.commands.test).toBe("echo PACKAGE");

    const support = await resolveCodingToolSupport({
      declaredTools: ["RunCommand"],
      codingToolRoot: join(tempDir, "packages", "api"),
      codingToolPackageDir: "packages/api",
      projectDir: tempDir,
      pipelineStage: "run",
      config: rootConfig,
    });
    const result = await support?.runtime.callTool("RunCommand", { command: "test" });
    expect(result?.kind).toBe("ok");
    if (result?.kind !== "ok") throw new Error("expected RunCommand to succeed");
    expect(result.content).toContain("PACKAGE");
  });

  test("a per-package config load failure logs a warning and falls back to the root config without throwing", async () => {
    resetLogger();
    const logCalls: LogEntry[] = [];
    initLogger({ level: "silent" });
    const removeSink = addSink((entry) => logCalls.push(entry));
    const originalLoad = _codingToolSupportDeps.loadConfigForPackage;
    _codingToolSupportDeps.loadConfigForPackage = async () => {
      throw new Error("simulated per-package config failure");
    };
    try {
      const support = await resolveCodingToolSupport({
        declaredTools: ["RunCommand"],
        codingToolRoot: join(tempDir, "packages", "api"),
        codingToolPackageDir: "packages/api",
        projectDir: tempDir,
        pipelineStage: "run",
        storyId: "US-FALLBACK",
        config: makeNaxConfig({ quality: { commands: { test: "echo ROOT-FALLBACK" } } }),
      });
      const result = await support?.runtime.callTool("RunCommand", { command: "test" });
      expect(result?.kind).toBe("ok");
      if (result?.kind !== "ok") throw new Error("expected RunCommand to succeed");
      // The package override is unreachable, so the root-declared command runs.
      expect(result.content).toContain("ROOT-FALLBACK");
      expect(result.content).not.toContain("PACKAGE");

      const warning = logCalls.find((entry) => entry.message.includes("Per-package config failed to load"));
      expect(warning).toBeDefined();
      expect(warning?.level).toBe("warn");
      expect(warning?.stage).toBe("tools");
      // storyId is the FIRST key of the structured payload, per log convention.
      expect(Object.keys(warning?.data ?? {})[0]).toBe("storyId");
      expect(warning?.data?.storyId).toBe("US-FALLBACK");
      expect(warning?.data?.packageDir).toBe("packages/api");
    } finally {
      _codingToolSupportDeps.loadConfigForPackage = originalLoad;
      removeSink();
      resetLogger();
    }
  });

  // C1 regression (final whole-branch review): under storyIsolation "worktree"
  // PackageView.packageDir is `.nax-wt/<storyId>/<pkg>`. Passing it verbatim to
  // loadConfigForPackage joined a missing `.nax/mono/.nax-wt/...` path, returned
  // the ROOT config, and (being truthy) discarded the already-package options.config
  // — so declared commands silently ran root templates. The fix strips the prefix
  // for the override lookup only; commandCwd must keep it so the command runs in
  // the story's worktree.
  test("a worktree-prefixed package dir resolves the PACKAGE override and runs at the worktree cwd", async () => {
    const worktreePkg = join(tempDir, ".nax-wt", "US-001", "packages", "api");
    mkdirSync(worktreePkg, { recursive: true });
    writeFileSync(
      join(tempDir, ".nax", "config.json"),
      JSON.stringify({ quality: { commands: { test: "echo ROOT" } } }),
    );
    writeFileSync(
      join(tempDir, ".nax", "mono", "packages", "api", "config.json"),
      JSON.stringify({ quality: { commands: { test: "echo PACKAGE && pwd" } } }),
    );
    _clearRootConfigCache();
    packageConfigCache.clear();

    const support = await resolveCodingToolSupport({
      declaredTools: ["RunCommand"],
      codingToolRoot: worktreePkg,
      codingToolPackageDir: ".nax-wt/US-001/packages/api",
      projectDir: tempDir,
      pipelineStage: "run",
      config: makeNaxConfig({ quality: { commands: { test: "echo ROOT" } } }),
    });
    const result = await support?.runtime.callTool("RunCommand", { command: "test" });
    expect(result?.kind).toBe("ok");
    if (result?.kind !== "ok") throw new Error("expected RunCommand to succeed");
    // The package override ran, not the root template.
    expect(result.content).toContain("PACKAGE");
    expect(result.content).not.toContain("ROOT");
    // commandCwd used the RAW worktree-prefixed dir, not the normalized key.
    expect(result.content).toContain(await realpathAsync(worktreePkg));
  });

  // I1 / PR2 guard: once PR2 repoints codingToolRoot at the repo root, the
  // declared-command cwd must still follow codingToolPackageDir + projectDir.
  // Proving the shape end-to-end (root + package both wired to real dirs) is
  // what keeps that repoint from silently running commands at the repo root.
  test("commandCwd follows codingToolPackageDir even when codingToolRoot is the repo root", async () => {
    const packagePath = join(tempDir, "packages", "api");
    writeFileSync(
      join(tempDir, ".nax", "mono", "packages", "api", "config.json"),
      JSON.stringify({ quality: { commands: { test: "pwd" } } }),
    );
    _clearRootConfigCache();
    packageConfigCache.clear();

    const support = await resolveCodingToolSupport({
      declaredTools: ["RunCommand"],
      codingToolRoot: tempDir,
      codingToolPackageDir: "packages/api",
      projectDir: tempDir,
      pipelineStage: "run",
      config: makeNaxConfig(),
    });
    const result = await support?.runtime.callTool("RunCommand", { command: "test" });
    expect(result?.kind).toBe("ok");
    if (result?.kind !== "ok") throw new Error("expected RunCommand to succeed");
    // The command's cwd line is the PACKAGE dir, not the repo root it was
    // handed as codingToolRoot — the PR2 repoint guard.
    const cwdLines = result.content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    expect(cwdLines).toContain(await realpathAsync(packagePath));
    expect(cwdLines).not.toContain(await realpathAsync(tempDir));
  });
});

/**
 * Task 10 (PR2 root move): post-Task-1 `codingToolRoot` and `codingToolRepoRoot`
 * are BOTH `storyExecRoot` (the repo/worktree root). If Exec's `packageWorkdir`
 * is still derived from `root`, `relative(repoRoot, packageWorkdir)` is always
 * "" and `package-managers.ts`'s `effectiveTarget` collapse sends EVERY Exec
 * call — `target: "package"` included — to the repo root. These tests pin the
 * collapse (fallback path) and prove the two targets stay distinguishable once
 * an ABSOLUTE `packageWorkdir` is threaded through `buildCodingToolSupport`.
 *
 * `pwd` is the observable: it is generic (unaffected by install hardening) and
 * prints the exact cwd `normalizeExec` chose.
 */
const execPwdGrants = [
  { tool: "RunCommand", patterns: ["*"] },
  { tool: "Exec", patterns: ["pwd"] },
];

function cwdLines(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

describe("buildCodingToolSupport — Exec package workdir vs collapsed root (Task 10)", () => {
  test("without an explicit packageWorkdir, target 'package' collapses to the repo root (post-root-move bug, pinned)", async () => {
    const repo = makeTempDir("nax-exec-collapse-");
    const pkg = join(repo, "packages", "api");
    mkdirSync(pkg, { recursive: true });
    try {
      // Post-Task-1 production shape: root === repoRoot === storyExecRoot.
      // packageWorkdir is deliberately omitted, so it falls back to root and
      // packageRelPath collapses to "".
      const support = buildCodingToolSupport({
        root: repo,
        repoRoot: repo,
        grants: execPwdGrants,
        declared: ["RunCommand", "Exec"],
        declaredCommands: new Map(),
      });
      const result = await support?.runtime.callTool("RunCommand", { argv: ["pwd"], target: "package" });
      expect(result?.kind).toBe("ok");
      if (result?.kind !== "ok") throw new Error("expected Exec to succeed");
      const lines = cwdLines(result.content);
      // Collapsed: even a package-targeted call runs at the repo root.
      expect(lines).toContain(await realpathAsync(repo));
      expect(lines).not.toContain(await realpathAsync(pkg));
    } finally {
      cleanupTempDir(repo);
    }
  });

  test("with an explicit ABSOLUTE packageWorkdir, target 'package' and 'repoRoot' stay distinguishable", async () => {
    const repo = makeTempDir("nax-exec-distinct-");
    const pkg = join(repo, "packages", "api");
    mkdirSync(pkg, { recursive: true });
    try {
      const support = buildCodingToolSupport({
        root: repo,
        repoRoot: repo,
        packageWorkdir: pkg,
        grants: execPwdGrants,
        declared: ["RunCommand", "Exec"],
        declaredCommands: new Map(),
      });
      const pkgResult = await support?.runtime.callTool("RunCommand", { argv: ["pwd"], target: "package" });
      const rootResult = await support?.runtime.callTool("RunCommand", { argv: ["pwd"], target: "repoRoot" });
      expect(pkgResult?.kind).toBe("ok");
      expect(rootResult?.kind).toBe("ok");
      if (pkgResult?.kind !== "ok" || rootResult?.kind !== "ok") throw new Error("expected Exec to succeed");
      expect(cwdLines(pkgResult.content)).toContain(await realpathAsync(pkg));
      expect(cwdLines(rootResult.content)).toContain(await realpathAsync(repo));
    } finally {
      cleanupTempDir(repo);
    }
  });
});

describe("resolveCodingToolSupport — Exec package workdir is ABSOLUTE (Task 10)", () => {
  test("threads the resolved absolute package dir, not the raw relative codingToolPackageDir", async () => {
    const repo = makeTempDir("nax-exec-resolve-");
    const pkg = join(repo, "packages", "api");
    mkdirSync(pkg, { recursive: true });
    try {
      // Record<string, unknown> mirrors the Exec findLast test above: the
      // resolved permissions block's Zod-declared shape is narrower than the
      // runtime object the config loader accepts.
      const execution: Record<string, unknown> = {
        permissionProfile: "unrestricted",
        permissions: { run: { allow: ["Exec(pwd)"] } },
      };
      const support = await resolveCodingToolSupport({
        declaredTools: ["RunCommand", "Exec"],
        codingToolRoot: repo,
        codingToolRepoRoot: repo,
        // RELATIVE to projectDir and worktree-shaped in production; feeding it
        // raw to Exec would make `relative(absoluteRepoRoot, relativeValue)`
        // garbage. resolveCodingToolSupport must convert it via packageWorkdir.
        codingToolPackageDir: "packages/api",
        projectDir: repo,
        pipelineStage: "run",
        config: makeNaxConfig({ execution }),
      });
      const result = await support?.runtime.callTool("RunCommand", { argv: ["pwd"], target: "package" });
      expect(result?.kind).toBe("ok");
      if (result?.kind !== "ok") throw new Error("expected Exec to succeed");
      const lines = cwdLines(result.content);
      expect(lines).toContain(await realpathAsync(pkg));
      // A relative value would have resolved against process.cwd() (the nax
      // checkout), never the story's package dir.
      expect(lines).not.toContain("packages/api");
    } finally {
      cleanupTempDir(repo);
    }
  });
});
