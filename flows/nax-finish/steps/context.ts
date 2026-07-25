import { FinishError } from "../errors";
import { runArgv } from "../exec";
import type { AcceptanceGroup, RunFn } from "../types";

export const _contextDeps: { run: RunFn } = { run: runArgv };

export async function detectBaseBranch(workdir: string): Promise<string> {
  const res = await _contextDeps.run(["git", "remote", "show", "origin"], { cwd: workdir });
  const m = res.stdout.match(/HEAD branch:\s*(\S+)/);
  if (m) return `origin/${m[1]}`;
  const main = await _contextDeps.run(["git", "rev-parse", "--verify", "origin/main"], { cwd: workdir });
  return main.exitCode === 0 ? "origin/main" : "origin/master";
}

export interface FeatureResolution {
  specPath: string;
  specKind: "markdown" | "prd";
  acceptanceStatus: string;
  groups: AcceptanceGroup[];
}

/**
 * One `nax features resolve` call for the whole flow — it yields both the spec
 * source (for the review prompts) and the acceptance groups (for the gate), so
 * `load_ctx` resolves once and the acceptance node reads the groups off
 * `ctx.outputs.load_ctx` instead of shelling out a second time.
 */
export async function resolveFeature(feature: string, workdir: string): Promise<FeatureResolution> {
  const res = await _contextDeps.run(["nax", "features", "resolve", feature, "--json"], { cwd: workdir });
  let parsed: {
    specSource?: { kind: "markdown" | "prd"; path: string };
    acceptance?: { status?: string; groups?: AcceptanceGroup[] };
  };
  try {
    parsed = JSON.parse(res.stdout);
  } catch (cause) {
    throw new FinishError(
      `nax features resolve returned unparseable JSON for "${feature}"`,
      "FINISH_RESOLVE_UNPARSEABLE",
      { stage: "finish-context", feature, exitCode: res.exitCode, cause },
    );
  }
  if (!parsed.specSource) {
    throw new FinishError(`nax features resolve returned no specSource for "${feature}"`, "FINISH_SPEC_NOT_FOUND", {
      stage: "finish-context",
      feature,
    });
  }
  return {
    specPath: parsed.specSource.path,
    specKind: parsed.specSource.kind,
    acceptanceStatus: parsed.acceptance?.status ?? "no-prd",
    groups: parsed.acceptance?.groups ?? [],
  };
}

export async function preflight(
  workdir: string,
  base: string,
): Promise<{ commitsAhead: number; route: "proceed" | "nothing-to-finish" }> {
  const res = await _contextDeps.run(["git", "rev-list", "--count", `${base}..HEAD`], { cwd: workdir });
  const commitsAhead = Number.parseInt(res.stdout.trim(), 10) || 0;
  return { commitsAhead, route: commitsAhead > 0 ? "proceed" : "nothing-to-finish" };
}
