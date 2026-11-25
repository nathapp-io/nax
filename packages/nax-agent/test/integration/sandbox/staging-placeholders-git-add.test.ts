/**
 * US-006 — a real repository proves a broad `git add` never stages a
 * placeholder-shaped file at a path nax must protect.
 *
 * Every case drives `gitlinkSafeAdd` with the production `gitWithTimeout`, in a
 * temporary repository built here: the exclusion is a pathspec git itself
 * interprets, so only real git can say whether it holds. The ledger directory is
 * injected through `_placeholderDeps`; nothing here depends on the developer's
 * own `~/.nax`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gitlinkSafeAdd, gitSpawnEnv, gitWithTimeout } from "@nathapp/nax-agent/internal";
import { _placeholderDeps } from "#src/sandbox/placeholder-deps";
import type { LedgerEntry, LedgerFile } from "#src/sandbox/placeholder-ledger";
import { cleanupTempDir, makeTempDir, withDepsRestore } from "#test/helpers/index";

withDepsRestore(_placeholderDeps);

let root: string;
let ledgerRoot: string;
let ledgerDir: string;

/**
 * `git` for the fixture and for the assertions, never for the behaviour under
 * test: `gitSpawnEnv()` is the repository's one hardened spawn environment, and
 * every git spawn in a test passes it (as `git-add.test.ts` does).
 */
function git(cwd: string, ...args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const proc = Bun.spawnSync(["git", ...args], { cwd, env: gitSpawnEnv() });
  return { stdout: proc.stdout.toString(), stderr: proc.stderr.toString(), exitCode: proc.exitCode ?? -1 };
}

function gitOk(cwd: string, ...args: string[]): string {
  const result = git(cwd, ...args);
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

/** A committed baseline file, so "staged" means "staged by this call", not "in the initial commit". */
function makeRepo(): string {
  const repo = makeTempDir("nax-staging-placeholders-git-");
  gitOk(repo, "init", "-q");
  gitOk(repo, "config", "user.email", "test@nax.local");
  gitOk(repo, "config", "user.name", "Nax Test");
  writeFileSync(join(repo, "a.txt"), "a\n");
  gitOk(repo, "add", "--", "a.txt");
  gitOk(repo, "commit", "-qm", "init");
  return repo;
}

/** bwrap's leaf placeholder: an empty, read-only, single-link file. */
function placeholder(target: string): void {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, "");
  chmodSync(target, 0o444);
}

/** One ledger file in the injected ledger directory, recording `entries` for a dead owner. */
function writeLedger(paths: readonly string[], mode = 0o600): void {
  const entries: LedgerEntry[] = paths.map((path) => {
    const { dev, ino } = lstatSync(path);
    return { path, kind: "file", dev, ino };
  });
  const file: LedgerFile = { version: 1, pid: 424242, bootId: "boot-A", startTicks: 5, entries };
  const path = join(ledgerDir, "424242.json");
  writeFileSync(path, JSON.stringify(file), { mode });
  chmodSync(path, mode);
}

/** The one call under test: a broad `-A` over the whole tree, through the gitlink-safe guard. */
function addAll(cwd: string) {
  return gitlinkSafeAdd(gitWithTimeout, cwd, { flags: ["-A"] });
}

/** True when `relPath` is in the repository's index. */
function isTracked(cwd: string, relPath: string): boolean {
  return git(cwd, "ls-files", "--error-unmatch", relPath).exitCode === 0;
}

/** The paths this call staged, from the repository's own index. */
async function staged(cwd: string): Promise<string[]> {
  const { stdout, exitCode } = await gitWithTimeout(["diff", "--cached", "--name-only"], cwd);
  expect(exitCode).toBe(0);
  return stdout.trim() === "" ? [] : stdout.trim().split("\n").sort();
}

beforeEach(() => {
  root = makeRepo();
  ledgerRoot = makeTempDir("nax-staging-placeholders-ledgers-");
  ledgerDir = join(ledgerRoot, "ledgers");
  mkdirSync(ledgerDir);
  _placeholderDeps.ledgerDir = () => ledgerDir;
});

afterEach(() => {
  cleanupTempDir(root);
  cleanupTempDir(ledgerRoot);
});

describe("gitlinkSafeAdd leaves a mandatory-name placeholder untracked", () => {
  test("AC-1: an untracked 0444 empty .mcp.json is not staged, and notes.md is", async () => {
    placeholder(join(root, ".mcp.json"));
    writeFileSync(join(root, "notes.md"), "notes\n");

    expect((await addAll(root)).exitCode).toBe(0);

    expect(await staged(root)).toEqual(["notes.md"]);
    expect(isTracked(root, "notes.md")).toBe(true);
    expect(isTracked(root, ".mcp.json")).toBe(false);
  });

  test("AC-2: the same repository with .mcp.json as an untracked 0644 empty file stages it", async () => {
    writeFileSync(join(root, ".mcp.json"), "");
    chmodSync(join(root, ".mcp.json"), 0o644);
    writeFileSync(join(root, "notes.md"), "notes\n");

    expect((await addAll(root)).exitCode).toBe(0);

    expect(await staged(root)).toEqual([".mcp.json", "notes.md"]);
  });
});

describe("gitlinkSafeAdd follows the trusted ledger", () => {
  test("AC-3: a trusted ledger entry's 0444 empty placeholder is left untracked", async () => {
    placeholder(join(root, ".claude", "settings.json"));
    writeLedger([join(root, ".claude", "settings.json")]);
    writeFileSync(join(root, "notes.md"), "notes\n");

    expect((await addAll(root)).exitCode).toBe(0);

    expect(await staged(root)).toEqual(["notes.md"]);
    expect(isTracked(root, ".claude/settings.json")).toBe(false);
  });

  test("AC-4: a 0644 ledger is not trusted, so its entry's placeholder is staged", async () => {
    placeholder(join(root, "docs", "x"));
    writeLedger([join(root, "docs", "x")], 0o644);
    writeFileSync(join(root, "notes.md"), "notes\n");

    expect((await addAll(root)).exitCode).toBe(0);

    expect(await staged(root)).toEqual(["docs/x", "notes.md"]);
  });
});

describe("gitlinkSafeAdd stages ordinary empty files", () => {
  test("AC-5: a 0444 empty file that is neither a mandatory name nor a ledger entry is staged", async () => {
    placeholder(join(root, "docs", "readme.txt"));
    writeFileSync(join(root, "notes.md"), "notes\n");

    expect((await addAll(root)).exitCode).toBe(0);

    expect(await staged(root)).toEqual(["docs/readme.txt", "notes.md"]);
  });

  test("AC-6: a committed .gitmodules changed to a 0444 empty file is staged as that change", async () => {
    writeFileSync(join(root, ".gitmodules"), '[submodule "n"]\n\tpath = n\n\turl = ./n\n');
    gitOk(root, "add", "--", ".gitmodules");
    gitOk(root, "commit", "-qm", "gitmodules");
    writeFileSync(join(root, ".gitmodules"), "");
    chmodSync(join(root, ".gitmodules"), 0o444);

    expect((await addAll(root)).exitCode).toBe(0);

    expect(await staged(root)).toEqual([".gitmodules"]);
    // The staged blob is the empty file, not the previous content.
    expect(gitOk(root, "show", ":.gitmodules")).toBe("");
  });
});

describe("gitlinkSafeAdd keeps the mandatory names when the ledger directory is unusable", () => {
  test("AC-7: a throwing ledgerDir leaves the 0444 empty .mcp.json untracked and stages notes.md", async () => {
    placeholder(join(root, ".mcp.json"));
    writeFileSync(join(root, "notes.md"), "notes\n");
    _placeholderDeps.ledgerDir = () => {
      throw new Error("CREDENTIALS_NOT_CONFIGURED");
    };

    expect((await addAll(root)).exitCode).toBe(0);

    expect(await staged(root)).toEqual(["notes.md"]);
    expect(isTracked(root, ".mcp.json")).toBe(false);
  });

  test("AC-10: an unreadable ledger directory leaves the mandatory placeholder untracked and stages notes.md", async () => {
    placeholder(join(root, ".mcp.json"));
    writeFileSync(join(root, "notes.md"), "notes\n");
    _placeholderDeps.ledgerDir = () => join(ledgerRoot, "no-such-ledger-dir");

    expect((await addAll(root)).exitCode).toBe(0);

    expect(await staged(root)).toEqual(["notes.md"]);
    expect(isTracked(root, ".mcp.json")).toBe(false);
  });
});

/** Names in `.git/info/exclude`, the way the US-007 step writes them for the shell rc placeholders. */
function excludeLocally(cwd: string, ...names: string[]): void {
  writeFileSync(join(cwd, ".git", "info", "exclude"), `${names.join("\n")}\n`);
}

describe("gitlinkSafeAdd with a placeholder at a path git already ignores (#2986)", () => {
  test("a .bashrc placeholder named in .git/info/exclude exits 0, stages the rest and not the placeholder", async () => {
    excludeLocally(root, ".bashrc");
    placeholder(join(root, ".bashrc"));
    writeFileSync(join(root, "notes.md"), "notes\n");

    const result = await addAll(root);

    expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(await staged(root)).toEqual(["notes.md"]);
    expect(isTracked(root, ".bashrc")).toBe(false);
  });

  test("a .gitignore'd placeholder is handled the same way", async () => {
    writeFileSync(join(root, ".gitignore"), ".mcp.json\n");
    placeholder(join(root, ".mcp.json"));

    expect((await addAll(root)).exitCode).toBe(0);

    expect(await staged(root)).toEqual([".gitignore"]);
    expect(isTracked(root, ".mcp.json")).toBe(false);
  });

  test("an ignored placeholder does not unguard an un-ignored one beside it", async () => {
    excludeLocally(root, ".bashrc");
    placeholder(join(root, ".bashrc"));
    placeholder(join(root, ".mcp.json"));
    writeFileSync(join(root, "notes.md"), "notes\n");

    expect((await addAll(root)).exitCode).toBe(0);

    expect(await staged(root)).toEqual(["notes.md"]);
    expect(isTracked(root, ".mcp.json")).toBe(false);
  });

  test("a git that cannot answer check-ignore keeps the guard: the placeholder is still not staged", async () => {
    placeholder(join(root, ".mcp.json"));
    writeFileSync(join(root, "notes.md"), "notes\n");
    const failing = (args: string[], cwd: string, timeoutMs?: number) =>
      args[0] === "check-ignore"
        ? Promise.resolve({ stdout: "", stderr: "fatal", exitCode: 128 })
        : gitWithTimeout(args, cwd, timeoutMs);

    expect((await gitlinkSafeAdd(failing, root, { flags: ["-A"] })).exitCode).toBe(0);

    expect(await staged(root)).toEqual(["notes.md"]);
  });
});

describe("gitlinkSafeAdd leaves an .idea / .vscode placeholder untracked (#2986)", () => {
  test.each([".idea", ".vscode"])("an empty 0444 REGULAR FILE at %s is not staged", async (name) => {
    placeholder(join(root, name));
    writeFileSync(join(root, "notes.md"), "notes\n");

    expect((await addAll(root)).exitCode).toBe(0);

    expect(await staged(root)).toEqual(["notes.md"]);
    expect(isTracked(root, name)).toBe(false);
  });

  test("an .idea directory with a real file in it is still staged", async () => {
    mkdirSync(join(root, ".idea"));
    writeFileSync(join(root, ".idea", "workspace.xml"), "<x/>\n");

    expect((await addAll(root)).exitCode).toBe(0);

    expect(await staged(root)).toEqual([".idea/workspace.xml"]);
  });

  test("an empty 0444 file at .vscode that is ignored locally exits 0", async () => {
    excludeLocally(root, ".vscode");
    placeholder(join(root, ".vscode"));
    writeFileSync(join(root, "notes.md"), "notes\n");

    expect((await addAll(root)).exitCode).toBe(0);

    expect(await staged(root)).toEqual(["notes.md"]);
  });
});
