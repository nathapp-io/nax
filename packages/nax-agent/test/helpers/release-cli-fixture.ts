import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "./index";

export function makeReleaseCliFixture(): {
  dir: string;
  git: (...args: string[]) => string;
  run: (
    args: readonly string[],
    input?: string,
    env?: Record<string, string>,
  ) => { status: number | null; output: string; calls: string[] };
} {
  const dir = makeTempDir("release-cli-");
  const pkg = join(dir, "packages/nax-agent");
  mkdirSync(join(pkg, "scripts/lib"), { recursive: true });
  for (const file of ["release.ts", "lib/release-version.ts"]) {
    cpSync(new URL(`../../scripts/${file}`, import.meta.url), join(pkg, "scripts", file));
  }
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({ name: "@nathapp/nax-agent", version: "0.1.0", private: true }),
  );
  writeFileSync(
    join(pkg, "CHANGELOG.md"),
    "# Changelog\n\n## [Unreleased]\n\n- New tools.\n\n## [0.1.0] - 2026-10-03\n\n- Native agent.\n",
  );
  writeFileSync(join(dir, "bun.lock"), "lockfile\n");
  const acp = join(dir, "packages/nax-agent-acp");
  mkdirSync(acp, { recursive: true });
  writeFileSync(
    join(acp, "package.json"),
    JSON.stringify({ name: "@nathapp/nax-agent-acp", version: "0.1.0", private: true }),
  );
  writeFileSync(join(acp, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\n- ACP backend.\n");
  const git = (...args: string[]) =>
    execFileSync("/usr/bin/git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Release Test");
  git("config", "user.email", "release@example.invalid");
  git("add", ".");
  git("commit", "-m", "fixture");
  const bin = join(dir, "ignored-bin");
  mkdirSync(bin);
  for (const [name, body] of Object.entries({
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
    npm: `if [ "$NPM_VIEW_FAIL" = "1" ]; then exit 1; fi
if [ -n "$NPM_VIEW_MISSING" ] && [ "$2" = "$NPM_VIEW_MISSING" ]; then exit 1; fi
if [ "$NPM_VIEW_EMPTY" = "1" ]; then exit 0; fi
echo "0.1.0"`,
  })) {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\necho "${name} $*" >> "$CALL_LOG"\n${body}\n`);
    chmodSync(path, 0o755);
  }
  // Runtime test fixtures/logs must not make the real repository dirty.
  writeFileSync(join(dir, ".git/info/exclude"), "/ignored-bin/\n/calls\n/pr-body\n");
  return {
    dir,
    git,
    run(args, input = "", extraEnv = {}) {
      writeFileSync(join(dir, "calls"), "");
      const result = spawnSync(process.execPath, [join(pkg, "scripts/release.ts"), ...args], {
        cwd: pkg,
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
