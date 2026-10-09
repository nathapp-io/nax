import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "@nathapp/nax-test-kit/bun/temp";

export interface WorkflowStep {
  name?: string;
  id?: string;
  uses?: string;
  with?: Record<string, unknown>;
  if?: string;
  run?: string;
  shell?: string;
  env?: Record<string, string>;
  "working-directory"?: string;
}

export interface WorkflowJob {
  needs?: string | string[];
  environment?: string;
  outputs?: Record<string, string>;
  steps: WorkflowStep[];
}

const REPO = new URL("../../../../", import.meta.url);

export const releaseWorkflow = Bun.YAML.parse(readFileSync(new URL(".github/workflows/release.yml", REPO), "utf8")) as {
  on: { push: { tags: string[] } };
  jobs: Record<string, WorkflowJob>;
};

export const publishAction = Bun.YAML.parse(
  readFileSync(new URL(".github/actions/publish-package/action.yml", REPO), "utf8"),
) as { inputs: Record<string, unknown>; runs: { using: string; steps: WorkflowStep[] } };

export function allSteps(): WorkflowStep[] {
  return [...Object.values(releaseWorkflow.jobs).flatMap((job) => job.steps), ...publishAction.runs.steps];
}

export function releaseStep(name: string): WorkflowStep {
  const step = allSteps().find((candidate) => candidate.name === name);
  if (!step) throw new Error(`No release step ${name}`);
  return step;
}

const STUB = `#!/bin/sh
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
    echo "\\"\${NPM_VIEW_VERSION:-0.84.0}\\""
    ;;
  publish) exit "\${NPM_PUBLISH_EXIT:-0}" ;;
  *) exit 1 ;;
esac
`;

export interface ReleaseShell {
  dir: string;
  run: (
    name: string,
    env?: Record<string, string>,
  ) => { status: number | null; output: string; calls: string[]; values: string };
}

/** Runs one release step's shell body in a temp package dir, with stub bun and npm on PATH. */
export function makeReleaseShell(opts: { manifest?: Record<string, unknown> } = {}): ReleaseShell {
  const dir = makeTempDir("release-shell-");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  mkdirSync(join(dir, ".publish"));
  const manifest = opts.manifest ?? {
    version: "0.84.0",
    dependencies: { "@nathapp/nax-ai": "0.84.0" },
    publishConfig: { tag: "latest" },
  };
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, ".publish/package.json"), JSON.stringify(manifest));
  for (const command of ["bun", "npm"]) {
    writeFileSync(join(bin, command), STUB);
    chmodSync(join(bin, command), 0o755);
  }
  return {
    dir,
    run(name, env = {}) {
      const body = releaseStep(name).run;
      if (!body) throw new Error(`No shell body for ${name}`);
      if (body.includes("${{")) throw new Error(`${name} interpolates an expression; read it from env instead`);
      const output = join(dir, "output");
      const calls = join(dir, "calls");
      writeFileSync(output, "");
      writeFileSync(calls, "");
      const result = spawnSync("/bin/bash", ["-e", "-o", "pipefail", "-c", body], {
        cwd: dir,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          CALL_LOG: calls,
          GITHUB_OUTPUT: output,
          RUNNER_TEMP: dir,
          NAME: "@nathapp/nax-agent",
          VERSION: "0.84.0",
          TAG: "v0.84.0",
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
