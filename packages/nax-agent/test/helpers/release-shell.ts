import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "./index";

interface WorkflowStep {
  name?: string;
  uses?: string;
  with?: Record<string, unknown>;
  if?: string;
  run?: string;
  env?: Record<string, string>;
  "working-directory"?: string;
}

export const releaseWorkflow = Bun.YAML.parse(
  readFileSync(new URL("../../../../.github/workflows/release.yml", import.meta.url), "utf8"),
) as { jobs: { release: { steps: WorkflowStep[] } }; on: { push: { tags: string[] } } };

export function releaseStep(name: string): WorkflowStep {
  const step = releaseWorkflow.jobs.release.steps.find((candidate) => candidate.name === name);
  if (!step) throw new Error(`No release step ${name}`);
  return step;
}

export function makeReleaseShell(opts: { manifest?: Record<string, unknown> } = {}): {
  dir: string;
  run: (
    name: string,
    env?: Record<string, string>,
  ) => { status: number | null; output: string; calls: string[]; values: string };
} {
  const dir = makeTempDir("release-shell-");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  mkdirSync(join(dir, ".publish"));
  const manifest = opts.manifest ?? {
    version: "0.1.0",
    dependencies: { "@nathapp/nax-ai": "0.1.16" },
    publishConfig: { tag: "latest" },
  };
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, ".publish/package.json"), JSON.stringify(manifest));
  for (const command of ["bun", "npm"]) {
    const path = join(bin, command);
    writeFileSync(
      path,
      `#!/bin/sh
echo "\${0##*/} $*" >> "$CALL_LOG"
if [ "\${0##*/}" = bun ]; then
  if [ "$*" = "$BUN_FAIL" ]; then exit 7; fi
  exit 0
fi
case "$1" in
  --version) echo "\${NPM_VERSION:-11.5.1}" ;;
  view)
    if [ -n "$NPM_ERROR" ]; then
      echo "{\\"error\\":{\\"code\\":\\"$NPM_ERROR\\"}}"
      exit 1
    fi
    if [ -n "$NPM_VIEW_EMPTY" ]; then exit 0; fi
    echo '"0.1.0"'
    ;;
  publish) exit "\${NPM_PUBLISH_EXIT:-0}" ;;
  *) exit 1 ;;
esac
`,
    );
    chmodSync(path, 0o755);
  }
  return {
    dir,
    run(name, env = {}) {
      const step = releaseStep(name);
      if (!step.run) throw new Error(`No shell body for ${name}`);
      const output = join(dir, "output");
      const calls = join(dir, "calls");
      writeFileSync(output, "");
      writeFileSync(calls, "");
      const body = step.run
        .replaceAll(`\${{ steps.pkg.outputs.version }}`, "$VERSION")
        .replaceAll(`\${{ steps.info.outputs.npm_tag }}`, "$NPM_TAG");
      const result = spawnSync("/bin/bash", ["-e", "-o", "pipefail", "-c", body], {
        cwd: dir,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          CALL_LOG: calls,
          GITHUB_OUTPUT: output,
          NAME: "@nathapp/nax-agent",
          VERSION: "0.1.0",
          TAG: "nax-agent-v0.1.0",
          NPM_TAG: "latest",
          ...env,
        },
        encoding: "utf8",
        timeout: 10_000,
      });
      if (result.error) throw result.error;
      return {
        status: result.status,
        output: result.stdout + result.stderr,
        calls: readFileSync(calls, "utf8").trim().split("\n").filter(Boolean),
        values: readFileSync(output, "utf8"),
      };
    },
  };
}
