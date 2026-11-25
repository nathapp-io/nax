/**
 * #3038 -- the shell-startup placeholders now also appear at the SESSION ROOT
 * (its names are in the policy's denyWrite), which is not the process cwd when
 * `nax chat -d <dir>` starts elsewhere. The git excludes must cover each distinct
 * root, once, on the first wrap that names it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { realOrRaw } from "#src/internal/realpath";
import { _placeholderDeps } from "#src/sandbox/placeholder-deps";
import { ensurePlaceholderExcludes } from "#src/sandbox/placeholder-excludes";
import { _srtBackendDeps, createSrtBackend } from "#src/sandbox/srt-backend";
import type { SandboxWrapRequest } from "#src/sandbox/types";
import { cleanupTempDir, makeTempDir, withDepsRestore } from "#test/helpers/index";

const HEADER = "# nax: Linux sandbox mount points";

withDepsRestore(_srtBackendDeps);
withDepsRestore(_placeholderDeps);

let base: string;
let repo: string;
let elsewhere: string;
let seen: string[];

function git(args: string[], cwd: string): void {
  const result = Bun.spawnSync(["git", ...args], { cwd });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
}

function excludeText(dir: string): string {
  const path = join(dir, ".git", "info", "exclude");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function request(root: string | undefined, cwd: string): SandboxWrapRequest {
  return {
    command: "true",
    shell: "/bin/sh",
    policy: { writeRoots: [root ?? cwd], denyWrite: [], denyRead: [], network: {} },
    cwd,
    commandId: "root-excludes",
    ...(root !== undefined ? { root } : {}),
  };
}

beforeEach(() => {
  base = realOrRaw(makeTempDir("nax-excludes-root-"));
  repo = join(base, "repo");
  elsewhere = join(base, "elsewhere");
  mkdirSync(elsewhere);
  mkdirSync(join(base, "home"));
  git(["init", "-q", repo], base);
  seen = [];
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
  _srtBackendDeps.platform = () => "linux";
  _srtBackendDeps.mkdir = async () => undefined;
  _srtBackendDeps.sweep = async () => undefined;
  _srtBackendDeps.cwd = () => elsewhere;
  _srtBackendDeps.ensureExcludes = async (path: string) => {
    seen.push(path);
    await ensurePlaceholderExcludes(path);
  };
  _placeholderDeps.platform = () => "darwin";
  _placeholderDeps.homedir = () => join(base, "home");
});
afterEach(() => cleanupTempDir(base));

describe("git excludes for a session root that is not the process cwd (#3038)", () => {
  test("the first wrap names the root's repository, though the process cwd is elsewhere", async () => {
    await createSrtBackend({}).wrap(request(repo, repo));

    expect(excludeText(repo)).toContain(HEADER);
    expect(excludeText(repo)).toContain("/.bashrc");
  });

  test("each distinct root is handled once per backend", async () => {
    const backend = createSrtBackend({});
    await backend.wrap(request(repo, repo));
    await backend.wrap(request(repo, repo));

    expect(seen.filter((p) => p === repo)).toHaveLength(1);
  });

  test("a root equal to the process cwd is not handled a second time", async () => {
    _srtBackendDeps.cwd = () => repo;

    await createSrtBackend({}).wrap(request(repo, repo));

    expect(seen).toEqual([repo]);
  });

  test("a request with no root adds no work beyond the process cwd", async () => {
    await createSrtBackend({}).wrap(request(undefined, repo));

    expect(seen).toEqual([elsewhere]);
    expect(excludeText(repo)).not.toContain(HEADER);
  });

  test("a root below the repository top level is left alone (the top-level rule still holds)", async () => {
    const sub = join(repo, "packages", "a");
    mkdirSync(sub, { recursive: true });

    await createSrtBackend({}).wrap(request(sub, sub));

    expect(excludeText(repo)).not.toContain(HEADER);
  });

  test("a failing root step does not fail the wrap", async () => {
    _srtBackendDeps.ensureExcludes = async (path: string) => {
      if (path === repo) throw new Error("injected");
    };

    expect(await createSrtBackend({}).wrap(request(repo, repo))).toEqual(["true"]);
  });

  test("a root is handled again after reset() (forget)", async () => {
    const backend = createSrtBackend({});
    await backend.wrap(request(repo, repo));
    await backend.reset();
    await backend.wrap(request(repo, repo));

    expect(seen.filter((p) => p === repo)).toHaveLength(2);
  });

  test("two concurrent wraps on a new root share one excludes step", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    _srtBackendDeps.ensureExcludes = async (path: string) => {
      seen.push(path);
      await gate;
    };
    const backend = createSrtBackend({});

    const first = backend.wrap(request(repo, repo));
    const second = backend.wrap(request(repo, repo));
    // Let both wraps reach the step before the first one finishes it.
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    await Promise.all([first, second]);

    expect(seen.filter((p) => p === repo)).toHaveLength(1);
  });

  test("no root work on another platform", async () => {
    _srtBackendDeps.platform = () => "darwin";

    await createSrtBackend({}).wrap(request(repo, repo));

    expect(seen).toEqual([]);
  });
});
