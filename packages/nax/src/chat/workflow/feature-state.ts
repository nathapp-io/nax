import { join, relative } from "node:path";
import { errorMessage, isProcessAlive } from "@nathapp/nax-agent/internal";
import { featureDir } from "@/config";
import { countStories, loadPRD } from "@/prd";
import { gitWithTimeout } from "@/utils/git";
// biome-ignore lint/style/noRestrictedImports: shared status reader must use the relative leaf to avoid the execution barrel.
import { readStatusFile } from "../../execution/status-file-read";

export interface FeatureStateOptions {
  readonly repoRoot: string;
  /** `~/.nax/<projectKey>` (or the configured outputDir). */
  readonly outputDir: string;
  /** Resolved config.execution.maxIterations. */
  readonly maxIterations: number;
}

export interface FeatureState {
  readonly name: string;
  /** Repo-relative feature spec path, falling back to the legacy specs directory. */
  readonly spec: string | null;
  readonly prd: {
    readonly branchName: string;
    readonly total: number;
    readonly passed: number;
    readonly failed: number;
    readonly pending: number;
  } | null;
  /** From the feature's status.json. */
  readonly run: {
    readonly id: string;
    readonly status: string;
    readonly startedAt: string;
    readonly alive: boolean;
    readonly spent: number;
    readonly passed: number;
    readonly total: number;
  } | null;
  /** From the newest readable workflow/<runId>/result.json. */
  readonly workflow: {
    readonly runId: string;
    readonly step: string;
    readonly outcome?: string;
    readonly url?: string;
    readonly ci?: string;
    readonly openItems: number;
    readonly firstOpenItems: readonly string[];
  } | null;
  /** Present only when prd is present (the branch name comes from it). */
  readonly branch: {
    readonly name: string;
    readonly exists: boolean;
    readonly current: boolean;
    readonly upstream: string | null;
  } | null;
  /** Newest outputDir/features/<name>/runs/*.jsonl stem, excluding latest.jsonl. */
  readonly lastRunLog: string | null;
  readonly warnings: readonly string[];
}

export interface WorkflowStateList {
  readonly features: readonly FeatureState[];
  /** Feature directories beyond the list limit. */
  readonly omitted: number;
}

export const WORKFLOW_STATE_LIST_LIMIT = 10;
export const FIRST_OPEN_ITEMS_LIMIT = 5;

export const _featureStateDeps = {
  git: gitWithTimeout,
  isProcessAlive,
  file: Bun.file,
};

/** Read repo-scoped feature artifacts without mutating them. */
export async function readFeatureState(name: string, options: FeatureStateOptions): Promise<FeatureState> {
  const dir = featureDir(options.repoRoot, name);
  const warnings: string[] = [];
  const [spec, prd, status] = await Promise.all([
    readSpec(name, options.repoRoot),
    readPrd(join(dir, "prd.json"), warnings),
    readStatusFile(dir),
  ]);
  if (prd && prd.pending > options.maxIterations) {
    warnings.push(
      `prd has ${prd.pending} stories left but execution.maxIterations is ${options.maxIterations}; pass -m ${prd.pending} to nax run (nax#2706)`,
    );
  }
  const run = status
    ? {
        id: status.run.id,
        status: status.run.status,
        startedAt: status.run.startedAt,
        alive: _featureStateDeps.isProcessAlive(status.run.pid),
        spent: status.cost.spent,
        passed: status.progress.passed,
        total: status.progress.total,
      }
    : null;
  if (run?.status === "running" && !run.alive) {
    warnings.push(`run ${run.id} is marked running but its process is gone`);
  }
  return {
    name,
    spec,
    prd,
    run,
    workflow: null,
    branch: prd ? await readBranch(prd.branchName, options.repoRoot) : null,
    lastRunLog: null,
    warnings,
  };
}

async function readSpec(name: string, repoRoot: string): Promise<string | null> {
  const preferred = join(featureDir(repoRoot, name), "spec.md");
  if (await _featureStateDeps.file(preferred).exists()) return relative(repoRoot, preferred);
  const legacy = join(repoRoot, ".nax", "specs", `${name}.md`);
  return (await _featureStateDeps.file(legacy).exists()) ? relative(repoRoot, legacy) : null;
}

async function readPrd(path: string, warnings: string[]): Promise<FeatureState["prd"]> {
  if (!(await _featureStateDeps.file(path).exists())) return null;
  try {
    const prd = await loadPRD(path);
    const { total, passed, failed, pending } = countStories(prd);
    return { branchName: prd.branchName, total, passed, failed, pending };
  } catch (err) {
    warnings.push(`prd.json unreadable: ${errorMessage(err)}`);
    return null;
  }
}

/** A failed probe affects only its own field, and never becomes a user warning. */
async function probe(args: string[], repoRoot: string): Promise<string | null> {
  try {
    const result = await _featureStateDeps.git(args, repoRoot);
    return result.exitCode === 0 && !result.timedOut ? result.stdout.trim() : null;
  } catch {
    // Branch diagnostics are best-effort, including missing git and timeouts.
    return null;
  }
}

async function readBranch(name: string, repoRoot: string): Promise<FeatureState["branch"]> {
  if (!name || name.startsWith("-")) return { name, exists: false, current: false, upstream: null };
  const [exists, current, upstream] = await Promise.all([
    probe(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], repoRoot),
    probe(["symbolic-ref", "--short", "HEAD"], repoRoot),
    probe(["rev-parse", "--abbrev-ref", `${name}@{upstream}`], repoRoot),
  ]);
  return { name, exists: exists !== null, current: current === name, upstream };
}
