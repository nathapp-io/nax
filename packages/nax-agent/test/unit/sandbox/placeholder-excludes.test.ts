/**
 * US-007 — the root-anchored git excludes that hide the Linux sandbox's
 * shell-startup placeholders, driven the way production runs them: through the
 * first `wrap` of a fresh srt backend.
 *
 * Real git repositories and real exclude bytes. What this step promises is a
 * file git reads, so a stubbed git or a stubbed filesystem would prove nothing;
 * only the host facts (home, platform, srt itself) are injected, which is what
 * lets every case run on every platform.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getSafeLogger, NaxError, setAgentLogger } from "#src/infra/index";
import { gitSpawnEnv } from "#src/internal/git-env";
import { realOrRaw } from "#src/internal/realpath";
import { _placeholderDeps } from "#src/sandbox/placeholder-deps";
import { ensurePlaceholderExcludes } from "#src/sandbox/placeholder-excludes";
import { _srtBackendDeps, createSrtBackend } from "#src/sandbox/srt-backend";
import type { SandboxWrapRequest } from "#src/sandbox/types";
import { cleanupTempDir, type LogCall, makeLogger, makeTempDir, withDepsRestore } from "#test/helpers/index";

/** The one section header nax writes, spelled out so the assertion does not read it from the module. */
const HEADER = "# nax: Linux sandbox mount points";

/** The six shell-startup names srt creates a placeholder at, root-anchored, in the order they are written. */
const ENTRIES = ["/.bashrc", "/.bash_profile", "/.profile", "/.zshrc", "/.zprofile", "/.ripgreprc"];

const log = makeLogger();
const realLogger = getSafeLogger();

withDepsRestore(_srtBackendDeps);
withDepsRestore(_placeholderDeps);

let base: string;
let home: string;
let repo: string;

/**
 * git as these tests need it: the host's global and system configuration
 * excluded, so a developer's own `core.excludesFile` or `status` settings cannot
 * change what the fixture's `git status` reports.
 */
function git(args: string[], cwd: string): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: gitSpawnEnv({ GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }),
  });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
  return result.stdout.toString();
}

/** `<dir>/.git/info/exclude` — the file git reads for a main checkout, here `dir` is the checkout. */
function excludePath(dir: string): string {
  return join(dir, ".git", "info", "exclude");
}

function excludeText(dir: string): string {
  return readFileSync(excludePath(dir), "utf8");
}

/** The last lines of the file: the section nax appends, plus the trailing newline's empty line. */
function appendedBlock(content: string): string[] {
  return content.split("\n").slice(-(ENTRIES.length + 2));
}

function callsAt(level: LogCall["level"], message: string): LogCall[] {
  return log.calls.filter((call) => call.level === level && call.stage === "sandbox" && call.message === message);
}

/** The request a launcher would build for `directory`. */
function request(directory: string): SandboxWrapRequest {
  return {
    command: "true",
    shell: "/bin/sh",
    policy: { writeRoots: [directory], denyWrite: [], denyRead: [], network: {} },
    cwd: directory,
    commandId: "excludes",
  };
}

/**
 * Run the step the way the backend does: the first `wrap` of a fresh backend,
 * whose Linux initialize is where the excludes are added.
 */
async function wrapIn(directory: string): Promise<readonly string[]> {
  _srtBackendDeps.cwd = () => directory;
  return createSrtBackend({}).wrap(request(directory));
}

/** An srt double: the argv is what the caller observes, and nothing here touches bwrap. */
function stubSrt(): void {
  _srtBackendDeps.load = async () => ({
    SandboxManager: {
      initialize: async () => {},
      isSupportedPlatform: () => true,
      wrapWithSandboxArgv: async () => ({ argv: ["true"], env: {} }),
      annotateStderrWithSandboxFailures: (_commandId, stderr) => stderr,
      cleanupAfterCommand: () => {},
      reset: async () => {},
    },
  });
}

beforeEach(() => {
  setAgentLogger(log);
  log.reset();
  base = realOrRaw(makeTempDir("nax-placeholder-excludes-"));
  home = join(base, "home");
  repo = join(base, "repo");
  mkdirSync(home);
  git(["init", "-q", repo], base);

  stubSrt();
  _srtBackendDeps.platform = () => "linux";
  _srtBackendDeps.mkdir = async () => undefined;
  // The stale sweep (US-004) is another story's step: it must not run here, so
  // that anything this file sees was written by the excludes step alone.
  _srtBackendDeps.sweep = async () => undefined;
  // ...and the real function, because test/preload.ts replaces it with a no-op
  // for the whole suite: this file is the one that needs the real one.
  _srtBackendDeps.ensureExcludes = ensurePlaceholderExcludes;
  // The placeholder ledger (US-002/US-003) is a different story: this host keeps
  // none, so no ledger file and no ledger log reaches these assertions.
  _placeholderDeps.platform = () => "darwin";
  _placeholderDeps.homedir = () => home;
});

afterEach(() => {
  setAgentLogger(realLogger);
  cleanupTempDir(base);
});

describe("US-007 placeholder excludes through a fresh Linux backend", () => {
  test("AC-1: a fresh repository ends with the header and the six entries, one per line", async () => {
    expect(excludeText(repo)).not.toContain(HEADER);

    await wrapIn(repo);

    expect(appendedBlock(excludeText(repo))).toEqual([HEADER, ...ENTRIES, ""]);
  });

  test("AC-2: user lines with no trailing newline keep their bytes and gain the five missing entries", async () => {
    const user = "*.log\n/build\n/.profile";
    writeFileSync(excludePath(repo), user);

    await wrapIn(repo);

    const missing = ["/.bashrc", "/.bash_profile", "/.zshrc", "/.zprofile", "/.ripgreprc"];
    expect(excludeText(repo)).toBe(`${user}\n${HEADER}\n${missing.join("\n")}\n`);
  });

  test("AC-3: a second backend in the same repository does not touch the file", async () => {
    await wrapIn(repo);
    // The first wrap did write the section, so the second one had something to leave alone.
    expect(excludeText(repo)).toContain(HEADER);
    const bytes = readFileSync(excludePath(repo));
    const writtenAt = lstatSync(excludePath(repo)).mtimeMs;

    await wrapIn(repo);

    expect(readFileSync(excludePath(repo))).toEqual(bytes);
    // Not merely equal bytes: nothing wrote the file a second time.
    expect(lstatSync(excludePath(repo)).mtimeMs).toBe(writtenAt);
  });

  test("AC-4: a linked worktree writes the common dir's exclude, not the worktree's", async () => {
    git(["config", "user.email", "t@t"], repo);
    git(["config", "user.name", "t"], repo);
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(["add", "a.txt"], repo);
    git(["commit", "-qm", "init"], repo);
    const worktree = join(base, "wt");
    git(["worktree", "add", "-q", "-b", "feat", worktree], repo);

    await wrapIn(worktree);

    expect(appendedBlock(excludeText(repo))).toEqual([HEADER, ...ENTRIES, ""]);
    // git reads `info/exclude` only from the common dir; a file under the
    // per-worktree admin dir would be inert.
    expect(existsSync(join(repo, ".git", "worktrees", "wt", "info", "exclude"))).toBe(false);
  });

  test("AC-5: a subdirectory of the repository is left alone", async () => {
    const sub = join(repo, "src", "deep");
    mkdirSync(sub, { recursive: true });
    const before = excludeText(repo);

    await wrapIn(sub);

    expect(excludeText(repo)).toBe(before);
    // The same repository from its root IS written, so the subdirectory is the
    // reason for the skip — not a fixture the step never reached.
    await wrapIn(repo);
    expect(excludeText(repo)).toContain(HEADER);
  });

  test("AC-6: the injected home directory is left alone even when it is a repository", async () => {
    git(["init", "-q", home], base);
    const before = excludeText(home);
    // The home check is the only reason this is skipped: it *is* a git root.
    expect(git(["rev-parse", "--show-toplevel"], home).trim()).toBe(home);

    await wrapIn(home);

    expect(excludeText(home)).toBe(before);
    // Another repository of the same shape is written: being $HOME is the reason.
    await wrapIn(repo);
    expect(excludeText(repo)).toContain(HEADER);
  });

  test("AC-7: a directory that is not a repository gains nothing at all", async () => {
    const plain = join(base, "plain");
    mkdirSync(plain);

    const argv = await wrapIn(plain);

    expect(argv).toEqual(["true"]);
    expect(readdirSync(plain)).toEqual([]);
    expect(existsSync(join(plain, ".git"))).toBe(false);
  });

  test("AC-8: git stops seeing a root placeholder but still sees the names repositories commit", async () => {
    writeFileSync(join(repo, ".bashrc"), "");
    chmodSync(join(repo, ".bashrc"), 0o444);
    writeFileSync(join(repo, ".gitconfig"), "");
    writeFileSync(join(repo, ".mcp.json"), "");

    await wrapIn(repo);

    expect(
      git(["status", "--porcelain"], repo)
        .split("\n")
        .filter((line) => line !== ""),
    ).toEqual(["?? .gitconfig", "?? .mcp.json"]);
    // The placeholder is hidden from git, not removed: a live sandbox still owns it.
    expect(existsSync(join(repo, ".bashrc"))).toBe(true);
  });

  test("AC-9: an exclude path that is a directory still wraps, with one warn", async () => {
    unlinkSync(excludePath(repo));
    mkdirSync(excludePath(repo));

    const argv = await wrapIn(repo);

    expect(argv).toEqual(["true"]);
    expect(callsAt("warn", "could not update git excludes")).toHaveLength(1);
  });

  test("AC-9: the section lands by an atomic replace, never a truncation in place", async () => {
    const user = "*.log\n/build\n/.profile";
    writeFileSync(excludePath(repo), user);
    chmodSync(excludePath(repo), 0o600);
    const before = lstatSync(excludePath(repo));

    await wrapIn(repo);

    const after = lstatSync(excludePath(repo));
    const missing = ["/.bashrc", "/.bash_profile", "/.zshrc", "/.zprofile", "/.ripgreprc"];
    // A new inode: the bytes arrived by a rename, so the destination was never
    // emptied first — a write that fails partway cannot lose the user's lines.
    expect(after.ino).not.toBe(before.ino);
    expect(excludeText(repo)).toBe(`${user}\n${HEADER}\n${missing.join("\n")}\n`);
    // The user's permission bits survive the replace, and no temporary file is
    // left beside it.
    expect(after.mode & 0o777).toBe(0o600);
    expect(readdirSync(join(repo, ".git", "info"))).toEqual(["exclude"]);
  });

  test("AC-9: a linked exclude file is written through, not replaced by a regular file", async () => {
    const shared = join(base, "shared-exclude");
    writeFileSync(shared, "*.log\n");
    unlinkSync(excludePath(repo));
    symlinkSync(shared, excludePath(repo));

    await wrapIn(repo);

    // The user's link survives, and the entries landed in the file git reads
    // through it — not on a new regular file where the link used to be.
    expect(lstatSync(excludePath(repo)).isSymbolicLink()).toBe(true);
    expect(readFileSync(shared, "utf8")).toBe(`*.log\n${HEADER}\n${ENTRIES.join("\n")}\n`);
  });

  test("B3: a dangling exclude symlink is written through, not replaced by a regular file", async () => {
    const shared = join(base, "not-created-yet");
    unlinkSync(excludePath(repo));
    // The user's link points at a file that does not exist (yet): `statSync`
    // reports ENOENT for it, so it reads as an absent exclude.
    symlinkSync(shared, excludePath(repo));
    expect(existsSync(shared)).toBe(false);

    await wrapIn(repo);

    // Renaming a regular file over the link would delete the user's link and
    // leave the file git reads through it untouched (B3).
    expect(lstatSync(excludePath(repo)).isSymbolicLink()).toBe(true);
    expect(readFileSync(shared, "utf8")).toBe(`${HEADER}\n${ENTRIES.join("\n")}\n`);
  });

  test("AC-10: a throwing ensureExcludes seam still lets wrap resolve its argv", async () => {
    _srtBackendDeps.ensureExcludes = async () => {
      throw new NaxError("injected excludes failure", "SANDBOX_EXCLUDES_FAILED", { stage: "sandbox" });
    };

    const argv = await wrapIn(repo);

    expect(argv).toEqual(["true"]);
    // The seam really stood in for the real function: no entries were written.
    expect(excludeText(repo)).not.toContain(HEADER);
  });

  test("AC-11: a throwing ensureExcludes seam is logged at warn by initialize", async () => {
    _srtBackendDeps.ensureExcludes = async () => {
      throw new NaxError("injected excludes failure", "SANDBOX_EXCLUDES_FAILED", { stage: "sandbox" });
    };

    await wrapIn(repo);

    const warnings = log.calls.filter(
      (call) => call.level === "warn" && call.data?.error === "injected excludes failure",
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.stage).toBe("sandbox");
    expect(warnings[0]?.message).toBe("git excludes initialization failed");
  });
});

describe("US-007 excludes step boundaries", () => {
  test("a failed sweep does not suppress the excludes step, which runs after it", async () => {
    const order: string[] = [];
    _srtBackendDeps.sweep = async () => {
      order.push("sweep");
      throw new NaxError("injected sweep failure", "SANDBOX_SWEEP_FAILED", { stage: "sandbox" });
    };
    const realEnsure = _srtBackendDeps.ensureExcludes;
    _srtBackendDeps.ensureExcludes = async (path: string) => {
      order.push(`excludes:${path}`);
      return realEnsure(path);
    };

    await wrapIn(repo);

    // The excludes step is second and is handed the process cwd, not the request's.
    expect(order).toEqual(["sweep", `excludes:${repo}`]);
    expect(appendedBlock(excludeText(repo))).toEqual([HEADER, ...ENTRIES, ""]);
    expect(log.calls.filter((call) => call.data?.error === "injected sweep failure")).toHaveLength(1);
  });

  test("no excludes work runs on another platform", async () => {
    _srtBackendDeps.platform = () => "darwin";
    // Nothing may consult the host for a path: the step is not reached at all.
    _placeholderDeps.homedir = () => {
      throw new NaxError("the excludes step ran on darwin", "SANDBOX_UNEXPECTED_STEP", { stage: "sandbox" });
    };
    const before = excludeText(repo);

    const argv = await wrapIn(repo);

    expect(argv).toEqual(["true"]);
    expect(excludeText(repo)).toBe(before);
  });
});
