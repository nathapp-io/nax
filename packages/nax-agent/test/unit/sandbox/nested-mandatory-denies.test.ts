/**
 * #3038 (Linux): srt denies the mandatory names at any depth beneath the process cwd by
 * a ripgrep scan of the ones that EXIST. `listNestedMandatoryDenies` runs the same scan
 * beneath a session root that is not the cwd, with srt's exact arguments and mapping.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getSafeLogger, setAgentLogger } from "#src/infra/index";
import type { ArgvExecResult } from "#src/internal/argv-exec";
import { realOrRaw } from "#src/internal/realpath";
import {
  _nestedDenyDeps,
  listNestedMandatoryDenies,
  nestedDenyPaths,
  ripgrepScanArgs,
} from "#src/sandbox/nested-mandatory-denies";
import { cleanupTempDir, makeLogger, makeTempDir, withDepsRestore } from "#test/helpers/index";

withDepsRestore(_nestedDenyDeps);
const log = makeLogger();
const realLogger = getSafeLogger();

let base: string;
let root: string;
let elsewhere: string;
let calls: Array<{ argv: readonly string[]; cwd: string; timeoutMs: number }>;

function result(over: Partial<ArgvExecResult>): ArgvExecResult {
  return { exitCode: 0, stdout: "", stderr: "", timedOut: false, ...over };
}

function fakeRun(r: ArgvExecResult): void {
  _nestedDenyDeps.run = async (options) => {
    calls.push({ argv: options.argv, cwd: options.cwd, timeoutMs: options.timeoutMs });
    return r;
  };
}

beforeEach(() => {
  log.reset();
  setAgentLogger(log);
  base = realOrRaw(makeTempDir("nax-nested-denies-"));
  root = join(base, "root");
  elsewhere = join(base, "elsewhere");
  mkdirSync(root);
  mkdirSync(elsewhere);
  calls = [];
  _nestedDenyDeps.cwd = () => elsewhere;
});
afterEach(() => {
  setAgentLogger(realLogger);
  cleanupTempDir(base);
});

describe("ripgrepScanArgs", () => {
  test("is srt 0.0.77's linuxGetMandatoryDenyPaths scan, arguments and order", () => {
    expect(ripgrepScanArgs(root)).toEqual([
      "rg",
      "--files",
      "--hidden",
      "--max-depth",
      "3",
      "--iglob",
      ".gitconfig",
      "--iglob",
      ".gitmodules",
      "--iglob",
      ".bashrc",
      "--iglob",
      ".bash_profile",
      "--iglob",
      ".zshrc",
      "--iglob",
      ".zprofile",
      "--iglob",
      ".profile",
      "--iglob",
      ".ripgreprc",
      "--iglob",
      ".mcp.json",
      "--iglob",
      "**/.vscode/**",
      "--iglob",
      "**/.idea/**",
      "--iglob",
      "**/.claude/commands/**",
      "--iglob",
      "**/.claude/agents/**",
      "--iglob",
      "**/.git/hooks/**",
      "--iglob",
      "**/.git/config",
      "-g",
      "!**/node_modules/**",
      root,
    ]);
  });
});

describe("nestedDenyPaths (srt's own match mapping)", () => {
  const abs = (rel: string): string => join(root, rel);

  test("a file match is denied as that file", () => {
    expect(nestedDenyPaths(root, [abs("sub/.mcp.json"), abs("a/b/.bashrc")])).toEqual([
      abs("sub/.mcp.json"),
      abs("a/b/.bashrc"),
    ]);
  });

  test("a match inside .vscode or .idea denies the directory", () => {
    expect(nestedDenyPaths(root, [abs("sub/.vscode/tasks.json"), abs("sub/.idea/x/y")])).toEqual([
      abs("sub/.vscode"),
      abs("sub/.idea"),
    ]);
  });

  test(".git/hooks and .git/config deny the hooks dir and the config file, not .git", () => {
    expect(
      nestedDenyPaths(root, [abs("n/.git/hooks/pre-commit.sample"), abs("n/.git/config"), abs("m/.git/hooks/x")]),
    ).toEqual([abs("n/.git/hooks"), abs("n/.git/config"), abs("m/.git/hooks")]);
  });

  test("a file under .claude/commands is denied as the FILE: srt's directory name holds a slash and never matches a segment", () => {
    expect(nestedDenyPaths(root, [abs("sub/.claude/commands/e.md")])).toEqual([abs("sub/.claude/commands/e.md")]);
  });

  test("a case-differing directory segment still maps to its directory (srt folds case)", () => {
    expect(nestedDenyPaths(root, [abs("sub/.VSCode/tasks.json")])).toEqual([abs("sub/.VSCode")]);
  });

  test("duplicates collapse; a path outside the root is dropped; a glob character is dropped", () => {
    const out = nestedDenyPaths(root, [
      abs("sub/.vscode/a"),
      abs("sub/.vscode/b"),
      join(base, "other/.mcp.json"),
      abs("we*ird/.mcp.json"),
      abs("br[ack]et/.bashrc"),
    ]);
    expect(out).toEqual([abs("sub/.vscode")]);
  });

  test("a dangerous name among the ROOT's own segments never denies an ancestor of the root", () => {
    const odd = join(base, ".vscode", "proj");
    expect(nestedDenyPaths(odd, [join(odd, "sub/.mcp.json")])).toEqual([join(odd, "sub/.mcp.json")]);
  });
});

describe("listNestedMandatoryDenies", () => {
  test("runs rg at the root with a timeout and maps the matches", async () => {
    fakeRun(result({ stdout: `${join(root, "sub/.mcp.json")}\n${join(root, "n/.git/hooks/x")}\n` }));
    const out = await listNestedMandatoryDenies(root);
    expect(out).toEqual([join(root, "sub/.mcp.json"), join(root, "n/.git/hooks")]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.argv).toEqual(ripgrepScanArgs(root));
    expect(calls[0]?.cwd).toBe(root);
    expect(calls[0]?.timeoutMs).toBeGreaterThan(0);
  });

  test("exit code 1 means no matches, quietly", async () => {
    fakeRun(result({ exitCode: 1 }));
    expect(await listNestedMandatoryDenies(root)).toEqual([]);
    expect(log.calls.filter((c) => c.level === "warn")).toHaveLength(0);
  });

  test("a failed scan falls back to no nested denies and warns", async () => {
    fakeRun(result({ exitCode: 2, stderr: "boom" }));
    expect(await listNestedMandatoryDenies(root)).toEqual([]);
    expect(log.calls.filter((c) => c.level === "warn" && c.stage === "sandbox")).toHaveLength(1);
  });

  test("a timed-out scan falls back and warns", async () => {
    fakeRun(result({ exitCode: 124, timedOut: true }));
    expect(await listNestedMandatoryDenies(root)).toEqual([]);
    expect(log.calls.filter((c) => c.level === "warn")).toHaveLength(1);
  });

  test("a spawn that throws (no rg) falls back and warns; the command is never failed", async () => {
    _nestedDenyDeps.run = async () => {
      throw new Error("spawn rg ENOENT");
    };
    expect(await listNestedMandatoryDenies(root)).toEqual([]);
    expect(log.calls.filter((c) => c.level === "warn")).toHaveLength(1);
  });

  test("with the process cwd == root srt scans it itself: nothing to add, nothing run", async () => {
    _nestedDenyDeps.cwd = () => root;
    fakeRun(result({ stdout: `${join(root, "sub/.mcp.json")}\n` }));
    expect(await listNestedMandatoryDenies(root)).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe("listNestedMandatoryDenies with the real ripgrep", () => {
  const hasRg = Bun.which("rg") !== null;

  // Which names ripgrep reports also depends on the host's own ignore files (a global
  // gitignore naming `.claude`, or ripgrep skipping `.git`), exactly as it does for srt's
  // scan; the Linux VM run covers `.claude/commands` and `.git/hooks`.
  test.skipIf(!hasRg)("finds existing nested names, honours the depth and node_modules exclusions", async () => {
    for (const rel of [
      "sub/.mcp.json",
      "sub/.vscode/tasks.json",
      "node_modules/pkg/.mcp.json",
      "a/b/c/d/.mcp.json",
      "sub/readme.md",
    ]) {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), "x\n");
    }
    const out = await listNestedMandatoryDenies(root);
    const byName = (a: string, b: string): number => a.localeCompare(b);
    expect(out.sort(byName)).toEqual([join(root, "sub/.mcp.json"), join(root, "sub/.vscode")].sort(byName));
  });
});
