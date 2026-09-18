import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { realpath as realpathAsync } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, makeNaxConfig, makeSpawn, makeTempDir } from "@test/helpers";
import { buildCodingToolSupport, resolveCodingToolSupport } from "@/agents/coding-tool-support";
import { _argvExecDeps } from "@/utils/argv-exec";

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
        codingToolRepoRoot: projectDir,
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
