import { NaxError } from "@/errors";
import type { RunFn } from "../types";

async function defaultRun(cmd: string[], opts: { cwd: string }) {
  const proc = Bun.spawn(cmd, { cwd: opts.cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { exitCode, stdout, stderr };
}

export const _contextDeps: { run: RunFn } = { run: defaultRun };

export async function detectBaseBranch(workdir: string): Promise<string> {
  const res = await _contextDeps.run(["git", "remote", "show", "origin"], { cwd: workdir });
  const m = res.stdout.match(/HEAD branch:\s*(\S+)/);
  if (m) return `origin/${m[1]}`;
  const main = await _contextDeps.run(["git", "rev-parse", "--verify", "origin/main"], { cwd: workdir });
  return main.exitCode === 0 ? "origin/main" : "origin/master";
}

export async function resolveSpec(feature: string, workdir: string): Promise<{ specPath: string; specKind: "markdown" | "prd" }> {
  const res = await _contextDeps.run(["nax", "features", "resolve", feature, "--json"], { cwd: workdir });
  const parsed = JSON.parse(res.stdout) as { specSource?: { kind: "markdown" | "prd"; path: string } };
  if (!parsed.specSource) {
    throw new NaxError(`nax features resolve returned no specSource for "${feature}"`, "FINISH_SPEC_NOT_FOUND", {
      stage: "finish-context",
      feature,
    });
  }
  return { specPath: parsed.specSource.path, specKind: parsed.specSource.kind };
}

export async function preflight(workdir: string, base: string): Promise<{ commitsAhead: number; route: "proceed" | "nothing-to-finish" }> {
  const res = await _contextDeps.run(["git", "rev-list", "--count", `${base}..HEAD`], { cwd: workdir });
  const commitsAhead = Number.parseInt(res.stdout.trim(), 10) || 0;
  return { commitsAhead, route: commitsAhead > 0 ? "proceed" : "nothing-to-finish" };
}
