/**
 * Sibling suites of coding-tool-support.test.ts (which sits at the 800-line
 * limit): scratchpad, Exec wiring/package, providers, Bash and the ledger
 * session-name. All assert `build*CodingToolSupport` / `resolveCodingToolSupport`
 * behaviour on the seams the stories changed, keeping each story's ticket in
 * the describe name.
 *
 * US-003 (scratchpad) — the story threads the scratchpad tools through
 * `declaredWithProviders` in `resolveCodingToolSupport` and adds them to
 * `DEFAULT_CODING_TOOLS`, so a callTool to any of them reaches the policy seam
 * on every op. Each AC has at least one assertion. AC4 (the scoped-without-
 * grant refusal path) doubles as a regression guard for "no declaration gate".
 *
 * Task 10 (PR2 root move) — post-Task-1 `codingToolRoot` is `storyExecRoot`.
 * If Exec's `packageWorkdir` is still derived from `root`,
 * `relative(repoRoot, packageWorkdir)` is always "" and
 * `package-managers.ts`'s `effectiveTarget` collapse sends EVERY Exec call to
 * the repo root. `pwd` is the observable: generic and prints the exact cwd
 * `normalizeExec` chose. C1: `packageName` must come from the story's package
 * dir, not the root manifest's.
 *
 * Provider gate (R12/R15) — a provider tool is advertised only when the
 * permission profile grants it, a provider-only op still builds support, and
 * each hop runs the provider tool at its own root.
 *
 * Bash wiring (spec §6) — declared ∩ granted reach the advertised set; the
 * description names the NARROWED grant and the project's shell.
 *
 * buildLedgerSessionName — the tool-audit ledger has to say WHICH session made
 * a call: three TDD roles run inside one story and all write to the same
 * `<outputDir>/tool-audit/<feature>/` directory (ADR-029's parity evidence).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { realpath as realpathAsync } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTempDir, makeNaxConfig, makeSpawn, makeTempDir } from "@test/helpers";
import { buildCodingToolSupport, buildLedgerSessionName, resolveCodingToolSupport } from "@/agents/coding-tool-support";
import { resolvePackageName } from "@/agents/exec-package-name";
import { DEFAULT_CODING_TOOLS } from "@/config/permissions";
import type { ToolProvider } from "@/tools";
import { _argvExecDeps } from "@/utils/argv-exec";

let scratchpadRoot: string;

beforeAll(() => {
  scratchpadRoot = mkdtempSync(join(tmpdir(), "nax-support-scratchpad-"));
  // Read on a missing path returns kind "error"; the AC5 reviewer-declared
  // test does NOT exercise Read, but having a writable fs surface means
  // resolved-paths are real paths and AC4's denied-outcome reflects the
  // policy verdict, not an unrelated tool-lookup miss.
  writeFileSync(join(scratchpadRoot, "file.txt"), "x");
});

let bashRoot: string;
let rootA: string;
let rootB: string;

beforeEach(() => {
  bashRoot = makeTempDir("bash-wiring-");
  rootA = makeTempDir("nax-providers-a-");
  rootB = makeTempDir("nax-providers-b-");
});

afterEach(() => {
  cleanupTempDir(bashRoot);
  cleanupTempDir(rootA);
  cleanupTempDir(rootB);
});

function staticProvider(): ToolProvider {
  return {
    id: "acme",
    kind: "static",
    stages: ["run"],
    tools: async (workdir) => [
      {
        localName: "probe",
        description: workdir,
        inputSchema: { type: "object", properties: {} },
        run: async () => ({ content: workdir }),
      },
    ],
  };
}

function ctx(root: string) {
  return { root, resolvedPaths: [], maxBytes: 100, maxFileBytes: 100 };
}

function names(support: Awaited<ReturnType<typeof resolveCodingToolSupport>>): string[] {
  return support?.tools.map((t) => t.name) ?? [];
}

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

const buildAt = (args: Parameters<typeof buildCodingToolSupport>[0]) =>
  buildCodingToolSupport({ root: bashRoot, ...args });

describe("US-003 AC1: an op declaring tools: ['Read'] advertises Read and the three scratchpad tools", () => {
  test("resolveCodingToolSupport includes the three scratchpad tools in the advertised set", async () => {
    // Going through resolveCodingToolSupport -- the path that does the
    // declaredWithProviders append -- so the test exercises the seam that
    // the story changes. The intersection invariant (grants caps what gets
    // advertised) is asserted alongside the scratchpad inclusion: under
    // unrestricted, every tool is granted, so the test only fails when the
    // declaredWithProviders append is missing.
    const support = await resolveCodingToolSupport({
      declaredTools: ["Read"],
      codingToolRoot: scratchpadRoot,
      pipelineStage: "run",
      config: makeNaxConfig({ execution: { permissionProfile: "unrestricted" } }),
    });
    const advertised = support?.tools.map((t) => t.name) ?? [];
    expect(advertised).toContain("Read");
    expect(advertised).toContain("ScratchpadWrite");
    expect(advertised).toContain("ScratchpadRead");
    expect(advertised).toContain("ScratchpadList");
  });
});

describe("US-003 AC6: a read-only review declaration advertises scratchpad tools but no repository mutating tool", () => {
  test("the review declaration advertises ScratchpadWrite/Read/List and excludes Write/Edit/Delete", async () => {
    // AC6 (companion to AC1): a read-only review declaration advertises the
    // scratchpad tools but none of Write / Edit / Delete. The op's
    // declaration is the ceiling on REPOSITORY tools; the scratchpad tools
    // are the universal layer appended on every op.
    const support = await resolveCodingToolSupport({
      declaredTools: ["Read", "Glob", "Grep", "Git"],
      codingToolRoot: scratchpadRoot,
      pipelineStage: "review",
      config: makeNaxConfig({ execution: { permissionProfile: "unrestricted" } }),
    });
    const advertised = support?.tools.map((t) => t.name) ?? [];
    expect(advertised).toContain("ScratchpadWrite");
    expect(advertised).toContain("ScratchpadRead");
    expect(advertised).toContain("ScratchpadList");
    // Read/Glob/Grep/Git were declared, so they reach the advertised set.
    expect(advertised).toContain("Read");
    expect(advertised).toContain("Glob");
    expect(advertised).toContain("Grep");
    expect(advertised).toContain("Git");
    // Repository mutating tools are not declared and must stay out of the set.
    expect(advertised).not.toContain("Write");
    expect(advertised).not.toContain("Edit");
    expect(advertised).not.toContain("Delete");
  });
});

describe("US-003 AC4: under scoped with no scratchpad rule, callTool returns a refused outcome naming the tool", () => {
  test("callTool('ScratchpadWrite') returns denied with a reason that contains 'ScratchpadWrite'", async () => {
    // The scoped profile lists only what the project wrote in
    // `execution.permissions.<stage>.allow`. With no scratchpad rule, no
    // grant for ScratchpadWrite reaches the compile, and callTool consults
    // the policy alone (not the op declaration) to refuse. The refusing
    // reason must name the tool so the model can react.
    //
    // Mirror the `cfg(execution: Record<string, unknown>)` helper from
    // test/unit/config/permissions.test.ts: `permissions.run.allow` is in
    // the zod schema but not in the narrow runtime-types alias, so the
    // execution block is widened at the boundary, the same idiom the
    // permissions suite uses for rule-list fields.
    const execution: Record<string, unknown> = {
      permissionProfile: "scoped",
      permissions: { run: { allow: ["Read"] } },
    };
    const support = await resolveCodingToolSupport({
      declaredTools: ["Read"],
      codingToolRoot: scratchpadRoot,
      pipelineStage: "run",
      config: makeNaxConfig({ execution }),
    });
    expect(support).toBeDefined();
    // The AC pins "rather than raising or silently succeeding". A future
    // refactor that throws on an ungranted call surfaces here: the catch
    // turns the throw into a structured absence, `outcome` is undefined,
    // and the assertions below fail uniformly. A future regression that
    // silently succeeds surfaces as `outcome.kind !== "denied"`.
    let outcome: Awaited<ReturnType<NonNullable<typeof support>["runtime"]["callTool"]>> | undefined;
    try {
      outcome = await support?.runtime.callTool("ScratchpadWrite", {
        path: "notes.md",
        content: "x",
      });
    } catch {
      // intentional: surfaced below through outcome being undefined
    }
    expect(outcome).toBeDefined();
    expect(outcome?.kind).toBe("denied");
    if (outcome?.kind !== "denied") throw new Error("expected a denied outcome");
    expect(outcome.reason).toContain("ScratchpadWrite");
  });
});

describe("US-003 AC5: under unrestricted with a read-only review declaration, ScratchpadWrite returns a non-error outcome", () => {
  test("callTool('ScratchpadWrite', {path:'findings.md',...}) returns kind: 'ok'", async () => {
    // The review op declares ["Read", "Glob", "Grep", "Git"]. None of those
    // are repository-mutating, so without the declaredWithProviders append
    // the reviewer never receives ScratchpadWrite. AC5 pins that the append
    // makes ScratchpadWrite reachable AND that the policy approves a
    // `findings.md` write under the confined scope.
    const support = await resolveCodingToolSupport({
      declaredTools: ["Read", "Glob", "Grep", "Git"],
      codingToolRoot: scratchpadRoot,
      pipelineStage: "review",
      config: makeNaxConfig({ execution: { permissionProfile: "unrestricted" } }),
    });
    expect(support).toBeDefined();
    const outcome = await support?.runtime.callTool("ScratchpadWrite", {
      path: "findings.md",
      content: "the review passed",
    });
    expect(outcome?.kind).toBe("ok");
  });
});

/**
 * Regression guard for the append's dedup branch.
 *
 * `declaredWithProviders` appends only the scratchpad names the declaration
 * does not already carry. Without that filter a declaration holding a
 * scratchpad name -- including the DEFAULT_CODING_TOOLS fallback
 * `resolveDeclaredTools` returns for an op that omits `tools` -- would put the
 * name into the union twice, and `runtime.advertised()` copies the list
 * verbatim: two entries, and from there two ToolDefinitions in the provider
 * request. AC1/AC6 above use `toContain`, which cannot see a duplicate, so
 * these assert counts and distinctness instead.
 */
describe("US-003: the scratchpad append never duplicates a name the declaration already carries", () => {
  test("a declaration naming one scratchpad tool advertises it once, with the other two appended once", async () => {
    const support = await resolveCodingToolSupport({
      declaredTools: ["Read", "ScratchpadWrite"],
      codingToolRoot: scratchpadRoot,
      pipelineStage: "review",
      config: makeNaxConfig({ execution: { permissionProfile: "unrestricted" } }),
    });
    const advertised = support?.tools.map((t) => t.name) ?? [];
    expect(advertised.filter((name) => name === "ScratchpadWrite")).toHaveLength(1);
    expect(advertised.filter((name) => name === "ScratchpadRead")).toHaveLength(1);
    expect(advertised.filter((name) => name === "ScratchpadList")).toHaveLength(1);
    expect(advertised.filter((name) => name === "Read")).toHaveLength(1);
  });

  test("an op that omits `tools` (DEFAULT_CODING_TOOLS) advertises each scratchpad exactly once", async () => {
    // This is the production shape the filter exists for: resolveDeclaredTools
    // returns DEFAULT_CODING_TOOLS when an op omits `tools`, and that list
    // already carries all three scratchpad names.
    const support = await resolveCodingToolSupport({
      declaredTools: DEFAULT_CODING_TOOLS,
      codingToolRoot: scratchpadRoot,
      pipelineStage: "review",
      config: makeNaxConfig({ execution: { permissionProfile: "unrestricted" } }),
    });
    const advertised = support?.tools.map((t) => t.name) ?? [];
    // Every advertised name is distinct -- a duplicate means two
    // ToolDefinitions for the same tool reach the provider.
    expect(new Set(advertised).size).toBe(advertised.length);
    expect(advertised.filter((name) => name === "ScratchpadWrite")).toHaveLength(1);
    expect(advertised.filter((name) => name === "ScratchpadRead")).toHaveLength(1);
    expect(advertised.filter((name) => name === "ScratchpadList")).toHaveLength(1);
  });
});

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
      // Record<string, unknown> mirrors the Exec findLast test in the sibling
      // file: the resolved permissions block's Zod-declared shape is narrower
      // than the runtime object the config loader accepts.
      const execution: Record<string, unknown> = {
        permissionProfile: "unrestricted",
        permissions: { run: { allow: ["Exec(pwd)"] } },
      };
      const support = await resolveCodingToolSupport({
        declaredTools: ["RunCommand", "Exec"],
        codingToolRoot: repo,
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

/**
 * Whole-branch review C1: `packageName` was resolved from `root` (the repo
 * root post-PR2), so a cargo/uv/yarn workspace install was scoped with the
 * ROOT manifest's name — or denied outright when the root had none. The name
 * must come from the story's package dir.
 *
 * `_argvExecDeps.spawn` is stubbed so the normalized argv is inspectable
 * without a real cargo binary or PATH manipulation.
 */
describe("resolveCodingToolSupport — Exec package name from the story package dir (C1)", () => {
  test("scopes cargo with the MEMBER's manifest name, not the repo-root manifest's", async () => {
    const projectDir = makeTempDir("nax-exec-pkgname-");
    const memberDir = join(projectDir, "packages", "api");
    mkdirSync(memberDir, { recursive: true });
    writeFileSync(join(projectDir, "package.json"), JSON.stringify({ name: "repo-root-pkg" }));
    writeFileSync(join(memberDir, "Cargo.toml"), '[package]\nname = "member-crate"\nversion = "0.1.0"\n');

    const originalSpawn = _argvExecDeps.spawn;
    const spawnStub = makeSpawn(() => "");
    _argvExecDeps.spawn = spawnStub.spawn;

    try {
      const execution: Record<string, unknown> = {
        permissionProfile: "unrestricted",
        permissions: { run: { allow: ["Exec(cargo add*)"] } },
      };
      const support = await resolveCodingToolSupport({
        declaredTools: ["RunCommand", "Exec"],
        codingToolRoot: projectDir,
        codingToolPackageDir: "packages/api",
        projectDir,
        pipelineStage: "run",
        config: makeNaxConfig({ execution }),
      });
      const result = await support?.runtime.callTool("RunCommand", {
        argv: ["cargo", "add", "serde"],
        target: "package",
      });
      expect(result?.kind).toBe("ok");
      expect(spawnStub.calls).toHaveLength(1);
      expect(spawnStub.calls[0]?.cmd).toEqual(["cargo", "add", "-p", "member-crate", "serde"]);
      expect(spawnStub.calls[0]?.cmd).not.toContain("repo-root-pkg");
      expect(spawnStub.calls[0]?.opts.cwd).toBe(projectDir);
    } finally {
      _argvExecDeps.spawn = originalSpawn;
      cleanupTempDir(projectDir);
    }
  });
});

describe("buildCodingToolSupport with Exec", () => {
  test("does not advertise a tool named Exec", () => {
    const support = buildCodingToolSupport({
      root: "/repo/packages/foo",
      repoRoot: "/repo",
      grants: [
        { tool: "RunCommand", patterns: ["*"] },
        { tool: "Exec", patterns: ["bun add*"] },
      ],
      declared: ["RunCommand", "Exec"],
      declaredCommands: new Map([["test", "bun test"]]),
    });
    const names = (support?.tools ?? []).map((t) => t.name);
    expect(names).toContain("RunCommand");
    expect(names).not.toContain("Exec");
  });

  test("still returns undefined when Exec is the only declared tool and nothing else is granted", () => {
    const support = buildCodingToolSupport({
      root: "/repo",
      repoRoot: "/repo",
      grants: [{ tool: "RunCommand", patterns: ["*"] }],
      declared: ["Exec"],
    });
    expect(support).toBeUndefined();
  });

  test("does not expose argv when the op declares Exec but policy does not grant it", () => {
    const support = buildCodingToolSupport({
      root: "/repo",
      grants: [{ tool: "RunCommand", patterns: ["*"] }],
      declared: ["RunCommand", "Exec"],
      declaredCommands: new Map([["test", "bun test"]]),
    });
    const runCommand = support?.tools.find((tool) => tool.name === "RunCommand");
    expect(runCommand?.inputSchema.properties).not.toHaveProperty("argv");
    expect(runCommand?.inputSchema.required).toEqual(["command"]);
  });

  // #1937 (first half): the RunCommand description's argv allowlist must
  // reflect the ACTUAL compiled Exec grant, since a project's own `Exec(...)`
  // expression replaces the built-in list entirely (src/config/permissions.ts
  // comment at BUILT_IN_EXEC_PATTERNS). Threading `grants.find(...).patterns`
  // through, rather than importing the built-in constant, is what keeps the
  // description honest for such a project.
  test("threads the compiled Exec grant's patterns into RunCommand's description", () => {
    const support = buildCodingToolSupport({
      root: "/repo",
      repoRoot: "/repo",
      grants: [
        { tool: "RunCommand", patterns: ["*"] },
        { tool: "Exec", patterns: ["bun install", "bun add*"] },
      ],
      declared: ["RunCommand", "Exec"],
      declaredCommands: new Map([["test", "bun test"]]),
    });
    const runCommand = support?.tools.find((tool) => tool.name === "RunCommand");
    expect(runCommand?.description).toContain("bun install, bun add*");
  });

  test("a project-overridden Exec grant is what appears, not the built-in list", () => {
    const support = buildCodingToolSupport({
      root: "/repo",
      repoRoot: "/repo",
      grants: [
        { tool: "RunCommand", patterns: ["*"] },
        { tool: "Exec", patterns: ["bun x tsc*"] },
      ],
      declared: ["RunCommand", "Exec"],
      declaredCommands: new Map([["test", "bun test"]]),
    });
    const runCommand = support?.tools.find((tool) => tool.name === "RunCommand");
    expect(runCommand?.description).toContain("bun x tsc*");
    expect(runCommand?.description).not.toContain("bun add*");
  });
});

describe("resolvePackageName", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "nax-exec-package-name-"));
  });

  afterEach(() => {
    rmSync(join(root, "package.json"), { force: true });
    rmSync(join(root, "Cargo.toml"), { force: true });
    rmSync(join(root, "pyproject.toml"), { force: true });
  });

  test("returns undefined when no manifest is present", async () => {
    expect(await resolvePackageName(root)).toBeUndefined();
  });

  test("reads the name from package.json", async () => {
    await Bun.write(join(root, "package.json"), JSON.stringify({ name: "@scope/widget" }));
    expect(await resolvePackageName(root)).toBe("@scope/widget");
  });

  test("reads the name from Cargo.toml's [package] section, not a later [dependencies] entry", async () => {
    await Bun.write(
      join(root, "Cargo.toml"),
      [
        "[package]",
        'name = "widget-crate"',
        'version = "0.1.0"',
        "",
        "[dependencies]",
        'name = "not-the-package-name"',
      ].join("\n"),
    );
    expect(await resolvePackageName(root)).toBe("widget-crate");
  });

  test("reads the name from pyproject.toml's [project] section", async () => {
    await Bun.write(join(root, "pyproject.toml"), ["[project]", 'name = "widget-py"', 'version = "0.1.0"'].join("\n"));
    expect(await resolvePackageName(root)).toBe("widget-py");
  });

  test("package.json wins over Cargo.toml when both are present", async () => {
    await Bun.write(join(root, "package.json"), JSON.stringify({ name: "node-name" }));
    await Bun.write(join(root, "Cargo.toml"), ["[package]", 'name = "rust-name"'].join("\n"));
    expect(await resolvePackageName(root)).toBe("node-name");
  });
});

describe("resolveCodingToolSupport — provider gate (R12)", () => {
  test("advertises a provider tool under unrestricted", async () => {
    const support = await resolveCodingToolSupport({
      declaredTools: ["Read"],
      providers: [staticProvider()],
      codingToolRoot: rootA,
      pipelineStage: "run",
      config: makeNaxConfig(),
    });

    expect(names(support)).toContain("acme__probe");
  });

  test("does not advertise a provider tool under safe", async () => {
    const support = await resolveCodingToolSupport({
      declaredTools: ["Read"],
      providers: [staticProvider()],
      codingToolRoot: rootA,
      pipelineStage: "run",
      config: makeNaxConfig({ execution: { permissionProfile: "safe" } }),
    });

    expect(names(support)).not.toContain("acme__probe");
  });

  test("does not advertise a provider tool under scoped with no Mcp rule", async () => {
    // A stage WITH an Mcp(...) rule DOES get its provider tools under scoped —
    // see test/unit/agents/mcp-under-scoped.test.ts.
    const support = await resolveCodingToolSupport({
      declaredTools: ["Read"],
      providers: [staticProvider()],
      codingToolRoot: rootA,
      pipelineStage: "run",
      config: makeNaxConfig({
        execution: { permissionProfile: "scoped", permissions: { default: { allowedTools: ["Read"] } } },
      }),
    });

    expect(names(support)).toContain("Read");
    expect(names(support)).not.toContain("acme__probe");
  });
});

describe("resolveCodingToolSupport — provider-only op (R15)", () => {
  test("builds support when a provider supplies the only tool", async () => {
    const support = await resolveCodingToolSupport({
      declaredTools: [],
      providers: [staticProvider()],
      codingToolRoot: rootA,
      pipelineStage: "run",
      config: makeNaxConfig(),
    });

    expect(support).toBeDefined();
    expect(names(support)).toContain("acme__probe");
  });
});

describe("resolveCodingToolSupport — hop root reaches the provider tool", () => {
  test("each hop runs the provider tool at its own root", async () => {
    const a = await resolveCodingToolSupport({
      declaredTools: ["Read"],
      providers: [staticProvider()],
      codingToolRoot: rootA,
      pipelineStage: "run",
      config: makeNaxConfig(),
    });
    const b = await resolveCodingToolSupport({
      declaredTools: ["Read"],
      providers: [staticProvider()],
      codingToolRoot: rootB,
      pipelineStage: "run",
      config: makeNaxConfig(),
    });

    const toolA = a?.tools.find((t) => t.name === "acme__probe");
    const toolB = b?.tools.find((t) => t.name === "acme__probe");
    if (toolA === undefined || toolB === undefined) throw new Error("provider tool was not advertised");

    expect(await toolA.run({}, ctx(rootA))).toEqual({ content: rootA });
    expect(await toolB.run({}, ctx(rootB))).toEqual({ content: rootB });
  });
});

describe("Bash wiring", () => {
  test("declared and granted: advertised", () => {
    const built = buildAt({
      declared: ["Read", "Bash"],
      grants: [
        { tool: "Read", patterns: ["*"] },
        { tool: "Bash", patterns: ["bun test *"] },
      ],
    });
    expect(built?.tools.map((tool) => tool.name)).toContain("Bash");
  });

  test("granted but NOT declared: never reachable (spec §6 row 11, the op ceiling)", async () => {
    const built = buildAt({
      declared: ["Read"],
      grants: [
        { tool: "Read", patterns: ["*"] },
        { tool: "Bash", patterns: ["bun test *"] },
      ],
    });
    expect(built?.tools.map((tool) => tool.name)).not.toContain("Bash");
    const outcome = await built?.runtime.callTool("Bash", { command: "bun test" });
    expect(outcome?.kind).toBe("denied");
    if (outcome?.kind === "denied") expect(outcome.reason).toContain("unknown tool");
  });

  test("declared but NOT granted: not advertised, and denied BY THE POLICY (spec §6 rows 1-2)", async () => {
    const built = buildAt({ declared: ["Read", "Bash"], grants: [{ tool: "Read", patterns: ["*"] }] });
    expect(built?.tools.map((tool) => tool.name)).not.toContain("Bash");
    const outcome = await built?.runtime.callTool("Bash", { command: "bun test" });
    expect(outcome?.kind).toBe("denied");
    // NOT "unknown tool": the tool exists, the grant does not. That is what
    // lets the denial carry a redirect (row 1), and it is the whole reason
    // creation is gated on declaration rather than on the grant.
    if (outcome?.kind === "denied") expect(outcome.reason).not.toContain("unknown tool");
  });

  test("the description names the NARROWED grant, not the raw one", () => {
    const built = buildAt({
      declared: ["Bash"],
      grants: [{ tool: "Bash", patterns: ["*"] }],
      toolPatterns: { Bash: ["bun test *"] },
    });
    const description = built?.tools.find((tool) => tool.name === "Bash")?.description ?? "";
    // narrowGrants is what the POLICY compiles, so a description built from the
    // raw list would advertise forms the policy refuses.
    expect(description).toContain("bun test *");
    expect(description).not.toContain("every command form is granted");
  });

  test("the project's shell reaches the tool", () => {
    const built = buildAt({
      declared: ["Bash"],
      grants: [{ tool: "Bash", patterns: ["*"] }],
      shell: "/bin/zsh",
    });
    expect(built?.tools.find((tool) => tool.name === "Bash")?.description).toContain("/bin/zsh");
  });
});

describe("buildLedgerSessionName", () => {
  test("distinguishes two roles within one story", () => {
    const writer = buildLedgerSessionName({ storyId: "US-001", sessionRole: "test-writer" });
    const verifier = buildLedgerSessionName({ storyId: "US-001", sessionRole: "verifier" });

    expect(writer).not.toBe(verifier);
    expect(writer).toBe("US-001-test-writer");
  });

  test("falls back to the story when no role is supplied", () => {
    expect(buildLedgerSessionName({ storyId: "US-001" })).toBe("US-001");
  });

  test("falls back to the feature when there is no story", () => {
    expect(buildLedgerSessionName({ featureName: "my-feature" })).toBe("my-feature");
  });

  test("names an unattached session rather than producing an empty string", () => {
    expect(buildLedgerSessionName({})).toBe("unattached");
  });
});
