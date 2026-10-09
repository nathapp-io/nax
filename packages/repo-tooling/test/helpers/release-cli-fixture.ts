import { execFileSync, spawnSync } from "node:child_process";
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

export interface ReleaseCliFixture {
  dir: string;
  git: (...args: string[]) => string;
  write: (path: string, text: string) => void;
  run: (
    args: readonly string[],
    input?: string,
    env?: Record<string, string>,
  ) => { status: number | null; output: string; calls: string[] };
}

/** A temp git repo holding the four lockstep packages and a copy of the release command, with git/bun/gh stubbed. */
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
  const bin = join(dir, "ignored-bin");
  mkdirSync(bin);
  for (const [name, body] of Object.entries(STUBS)) {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\necho "${name} $*" >> "$CALL_LOG"\n${body}\n`);
    chmodSync(path, 0o755);
  }
  // Runtime logs must not make the fixture repository dirty.
  writeFileSync(join(dir, ".git/info/exclude"), "/ignored-bin/\n/calls\n/pr-body\n");
  return {
    dir,
    git,
    write,
    run(args, input = "", extraEnv = {}) {
      writeFileSync(join(dir, "calls"), "");
      const result = spawnSync(process.execPath, [join(tooling, "scripts/release.ts"), ...args], {
        cwd: dir,
        input,
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          TMPDIR: bin,
          CALL_LOG: join(dir, "calls"),
          PR_BODY: join(dir, "pr-body"),
          ...extraEnv,
        },
      });
      if (result.error) throw result.error;
      return {
        status: result.status,
        output: result.stdout + result.stderr,
        calls: readFileSync(join(dir, "calls"), "utf8").trim().split("\n").filter(Boolean),
      };
    },
  };
}
