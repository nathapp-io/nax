/**
 * The Git tool's default `.nax/` exclusions (#2007) and the verbs exempt from them (#2693).
 * Split from git.test.ts by concern.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildGitArgv, compileToolPolicy, createCodingToolRuntime, DEFAULT_LOG_MAX_COUNT } from "@nathapp/nax-agent";
import { _gitDeps } from "@nathapp/nax-agent/internal";
import { cleanupTempDir, makeTempDir, TEST_GIT_EXCLUDE_PATHSPECS, testProtectedPaths } from "#test/helpers/index";

const tempDirs: string[] = [];

function makeTestDir(prefix: string): string {
  const dir = makeTempDir(prefix);
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) cleanupTempDir(dir);
});

const GIT_EXCLUDES = [...TEST_GIT_EXCLUDE_PATHSPECS];

function contentOf(result: { kind: string; content?: string }): string {
  if (result.kind !== "ok") throw new Error(`expected ok, got ${result.kind}: ${JSON.stringify(result)}`);
  return result.content ?? "";
}

function argvOf(input: Record<string, unknown>): string[] {
  const built = buildGitArgv(input, GIT_EXCLUDES);
  if ("error" in built) throw new Error(`expected argv, got error: ${built.error}`);
  return built;
}

describe("buildGitArgv — nax-owned paths are excluded from the default view", () => {
  // The SSOT pin (NAX_OWNED_GIT_EXCLUDE_PATHSPECS === this form) stays in nax: test/unit/tools/git-ssot.test.ts.
  test("status with no paths ends with the root and the nax exclusions", () => {
    expect(argvOf({ subcommand: "status" })).toEqual(["status", "--", ".", ...GIT_EXCLUDES]);
  });

  test("diff with no paths gets the exclusions, ahead of the refs", () => {
    expect(argvOf({ subcommand: "diff" })).toEqual(["diff", "--", ".", ...GIT_EXCLUDES]);
    expect(argvOf({ subcommand: "diff", refs: ["HEAD~1", "HEAD"] })).toEqual([
      "diff",
      "HEAD~1",
      "HEAD",
      "--",
      ".",
      ...GIT_EXCLUDES,
    ]);
  });

  test("blame with no paths is exempt — exclude pathspecs are a git usage error there", () => {
    expect(argvOf({ subcommand: "blame" })).toEqual(["blame", "--", "."]);
  });

  test("an explicitly named path is answered as given, with no exclusion injected", () => {
    expect(argvOf({ subcommand: "diff", paths: ["src/a.ts"] })).toEqual(["diff", "--", "src/a.ts"]);
  });

  test("an explicitly named .nax path still reaches the file", () => {
    expect(argvOf({ subcommand: "diff", paths: [".nax/features/f/prd.json"] })).toEqual([
      "diff",
      "--",
      ".nax/features/f/prd.json",
    ]);
  });

  // #2693: on log and show an exclude pathspec drops whole COMMITS, not just files.
  test("log with no paths keeps the root scope and the --max-count default, with no exclusions", () => {
    const argv = argvOf({ subcommand: "log" });
    expect(argv).toContain(`--max-count=${DEFAULT_LOG_MAX_COUNT}`);
    expect(argv.slice(-2)).toEqual(["--", "."]);
  });

  test("show with a ref and no paths keeps the root scope, with no exclusions", () => {
    expect(argvOf({ subcommand: "show", refs: ["HEAD"] })).toEqual(["show", "HEAD", "--", "."]);
  });
});

/**
 * #2693 — a nax-run branch ends in commits that only touch `.nax/` (progress,
 * auto-commits, decisions). With the default excludes, an unscoped `log HEAD`
 * skipped them and reported an older commit in place of HEAD, and `show HEAD` printed
 * nothing at all.
 */
describe("gitTool — a .nax-only HEAD commit is still reported by log and show", () => {
  async function makeRepoWithLedgerHead(): Promise<string> {
    const repo = makeTestDir("nax-git-ledger-head-");
    const run = (args: string[]) => _gitDeps.spawn(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
    await run(["init", "-q"]).exited;
    await run(["config", "user.email", "t@e.com"]).exited;
    await run(["config", "user.name", "T"]).exited;
    writeFileSync(join(repo, "a.ts"), "seed\n");
    await run(["add", "-A"]).exited;
    await run(["commit", "-q", "-m", "source commit"]).exited;
    mkdirSync(join(repo, ".nax/features/f"), { recursive: true });
    writeFileSync(join(repo, ".nax/features/f/decisions.jsonl"), "{}\n");
    await run(["add", "-A"]).exited;
    await run(["commit", "-q", "-m", "ledger only commit"]).exited;
    return repo;
  }

  function runtimeFor(repo: string) {
    return createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Git", patterns: ["*"] }], repo),
      protectedPaths: testProtectedPaths(),
    });
  }

  test("log HEAD with maxCount 1 returns the ledger-only commit", async () => {
    const repo = await makeRepoWithLedgerHead();

    const content = contentOf(
      await runtimeFor(repo).callTool("Git", { subcommand: "log", refs: ["HEAD"], maxCount: 1 }),
    );

    expect(content).toContain("ledger only commit");
    expect(content).not.toContain("source commit");
  });

  test("show HEAD returns the ledger-only commit", async () => {
    const repo = await makeRepoWithLedgerHead();

    const content = contentOf(await runtimeFor(repo).callTool("Git", { subcommand: "show", refs: ["HEAD"] }));

    expect(content).toContain("ledger only commit");
  });
});

/**
 * #2007 — the exclusion must hide a NESTED `.nax/` too, not just the repo-root
 * one. Proven against a real repository: a bare doublestar without `:(glob)`
 * left `packages/app/.nax/...` in the default view, so a monorepo package's
 * run state still reported as the agent's own diff.
 */
describe("gitTool — the default view hides nested and root .nax run state", () => {
  const repos: string[] = [];

  afterEach(() => {
    for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const NAX_PATHS = [".nax/features/f/prd.json", "packages/app/.nax/features/f/prd.json"];

  /** Commits the three seed files, then dirties all three. */
  async function makeRepo(): Promise<string> {
    const repo = makeTestDir("nax-git-nax-exclude-");
    repos.push(repo);
    for (const relativePath of [...NAX_PATHS, "src/a.ts"]) {
      const full = join(repo, relativePath);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, "seed\n");
    }
    const run = (args: string[]) => _gitDeps.spawn(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
    await run(["init", "-q"]).exited;
    await run(["config", "user.email", "t@e.com"]).exited;
    await run(["config", "user.name", "T"]).exited;
    await run(["add", "-A"]).exited;
    await run(["commit", "-q", "-m", "seed"]).exited;
    for (const relativePath of [...NAX_PATHS, "src/a.ts"]) {
      writeFileSync(join(repo, relativePath), "dirty\n");
    }
    return repo;
  }

  test("status reports the dirtied src/a.ts but neither .nax path", async () => {
    const repo = await makeRepo();
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Git", patterns: ["*"] }], repo),
      protectedPaths: testProtectedPaths(),
    });

    const content = contentOf(await rt.callTool("Git", { subcommand: "status" }));

    expect(content).toContain("src/a.ts");
    expect(content).not.toContain(".nax/features/f/prd.json");
    expect(content).not.toContain("packages/app/.nax/features/f/prd.json");
  });

  test("diff reports the dirtied src/a.ts but neither .nax path", async () => {
    const repo = await makeRepo();
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Git", patterns: ["*"] }], repo),
      protectedPaths: testProtectedPaths(),
    });

    const content = contentOf(await rt.callTool("Git", { subcommand: "diff" }));

    expect(content).toContain("src/a.ts");
    expect(content).not.toContain(".nax/features/f/prd.json");
    expect(content).not.toContain("packages/app/.nax/features/f/prd.json");
  });
});
