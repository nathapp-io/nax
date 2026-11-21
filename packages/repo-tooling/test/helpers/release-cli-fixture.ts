import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "@nathapp/nax-test-kit/bun/temp";

const TOOLING = new URL("../../", import.meta.url);
const VERSION = "0.84.0";

const MANIFESTS: Record<string, Record<string, unknown>> = {
  "packages/nax-ai": { name: "@nathapp/nax-ai", version: VERSION },
  "packages/nax-agent": { name: "@nathapp/nax-agent", version: VERSION, dependencies: { "@nathapp/nax-ai": VERSION } },
  "packages/nax-agent-acp": {
    name: "@nathapp/nax-agent-acp",
    version: VERSION,
    peerDependencies: { "@nathapp/nax-agent": "workspace:*" },
  },
  "packages/nax": { name: "@nathapp/nax", version: VERSION, dependencies: { "@nathapp/nax-ai": VERSION } },
};

const STUBS: Record<string, string> = {
  git: `case "$1" in
  pull) exit 0 ;;
  push) exit "\${FAIL_PUSH:-0}" ;;
  *) exec /usr/bin/git "$@" ;;
esac`,
  bun: `if [ "$*" != "install" ]; then exit 1; fi
echo refreshed >> bun.lock`,
  gh: `while [ "$#" -gt 0 ]; do
  if [ "$1" = "--body-file" ]; then cp "$2" "$PR_BODY"; break; fi
  shift
done
echo 'https://example.invalid/pr/1'`,
};

export interface RunResult {
  status: number | null;
  output: string;
  calls: string[];
}

export interface ReleaseCliFixture {
  dir: string;
  git: (...args: string[]) => string;
  write: (path: string, text: string) => void;
  run: (args: readonly string[], input?: string, env?: Record<string, string>) => RunResult;
  /**
   * Like `run`, but stdin is held open: `whileWaiting` runs once the confirmation question is on
   * screen and before the answer is written, so a test can move the checkout while the prompt waits.
   * The answer written once `whileWaiting` returns is `y`.
   */
  runPaused: (
    args: readonly string[],
    whileWaiting: () => void,
    env?: Record<string, string>,
  ) => Promise<RunResult & { prompted: boolean }>;
}

/**
 * A temp git repo holding the four lockstep packages and a copy of the release command, with git/bun/gh
 * stubbed. A bare `origin.git` inside the temp dir is seeded from `main` with the real git binary, so
 * an un-stubbed (real git) run has a remote whose main equals the local HEAD and holds no tags.
 */
export function makeReleaseCliFixture(): ReleaseCliFixture {
  const dir = makeTempDir("release-cli-");
  const tooling = join(dir, "packages/repo-tooling");
  mkdirSync(join(tooling, "scripts/lib"), { recursive: true });
  for (const file of [
    "package.json",
    "scripts/release.ts",
    "scripts/lib/lockstep.ts",
    "scripts/lib/release-version.ts",
  ]) {
    cpSync(new URL(file, TOOLING), join(tooling, file));
  }
  const write = (path: string, text: string) => {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  for (const [pkg, manifest] of Object.entries(MANIFESTS)) {
    write(`${pkg}/package.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  write(
    "packages/nax-agent/CHANGELOG.md",
    "# Changelog\n\n## [Unreleased]\n\n- New tools.\n\n## [0.84.0] - 2026-10-09\n\n- Lockstep.\n",
  );
  write(
    "packages/nax-agent-acp/CHANGELOG.md",
    "# Changelog\n\n## [Unreleased]\n\n## [0.84.0] - 2026-10-09\n\n- Lockstep.\n",
  );
  write("bun.lock", "lockfile\n");
  const git = (...args: string[]) =>
    execFileSync("/usr/bin/git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Release Test");
  git("config", "user.email", "release@example.invalid");
  git("add", ".");
  git("commit", "-m", "fixture");
  // A real remote for the post-confirmation checks: seeded here through the real
  // binary (never the stub below), so origin/main starts equal to the local HEAD.
  const origin = join(dir, "origin.git");
  git("init", "--bare", origin);
  git("remote", "add", "origin", origin);
  git("push", "--quiet", "origin", "main");
  const bin = join(dir, "ignored-bin");
  mkdirSync(bin);
  for (const [name, body] of Object.entries(STUBS)) {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\necho "${name} $*" >> "$CALL_LOG"\n${body}\n`);
    chmodSync(path, 0o755);
  }
  // Runtime logs and the bare origin must not make the fixture repository dirty.
  writeFileSync(join(dir, ".git/info/exclude"), "/ignored-bin/\n/calls\n/pr-body\n/origin.git/\n");
  const script = join(tooling, "scripts/release.ts");
  const callLog = join(dir, "calls");
  const envFor = (extraEnv: Record<string, string>) => ({
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    TMPDIR: bin,
    CALL_LOG: callLog,
    PR_BODY: join(dir, "pr-body"),
    ...extraEnv,
  });
  const record = (status: number | null, output: string): RunResult => ({
    status,
    output,
    calls: readFileSync(callLog, "utf8").trim().split("\n").filter(Boolean),
  });
  const run = (args: readonly string[], input = "", extraEnv: Record<string, string> = {}): RunResult => {
    writeFileSync(callLog, "");
    const result = spawnSync(process.execPath, [script, ...args], {
      cwd: dir,
      input,
      encoding: "utf8",
      timeout: 10_000,
      env: envFor(extraEnv),
    });
    if (result.error) throw result.error;
    return record(result.status, result.stdout + result.stderr);
  };
  const runPaused = async (
    args: readonly string[],
    whileWaiting: () => void,
    extraEnv: Record<string, string> = {},
  ): Promise<RunResult & { prompted: boolean }> => {
    writeFileSync(callLog, "");
    const child = spawn(process.execPath, [script, ...args], {
      cwd: dir,
      env: envFor(extraEnv),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let prompted = false;
    let hookError: unknown;
    const onOutput = (chunk: Buffer) => {
      output += chunk.toString();
      if (prompted || !output.includes("[y/N]")) return;
      prompted = true;
      try {
        whileWaiting();
      } catch (error) {
        hookError = error;
      }
      child.stdin.end("y\n");
    };
    child.stdout.on("data", onOutput);
    child.stderr.on("data", onOutput);
    // A question the harness never sees would otherwise hang the suite instead of failing it.
    const killer = setTimeout(() => {
      if (!prompted) child.kill("SIGKILL");
    }, 20_000);
    const status = await new Promise<number | null>((settle) => child.on("close", (code) => settle(code)));
    clearTimeout(killer);
    if (hookError) throw hookError;
    return { ...record(status, output), prompted };
  };
  return { dir, git, write, run, runPaused };
}
