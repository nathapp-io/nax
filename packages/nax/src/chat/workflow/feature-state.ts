import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { errorMessage, isProcessAlive } from "@nathapp/nax-agent/internal";
import { featureDir, featuresDir } from "@/config";
import { NaxError } from "@/errors";
import { countStories, loadPRD } from "@/prd";
import { gitWithTimeout } from "@/utils/git";
// biome-ignore lint/style/noRestrictedImports: shared status reader must use the relative leaf to avoid the execution barrel.
import { readStatusFile } from "../../execution/status-file-read";
// Relative workflow leaves avoid the workflow -> step-context -> cli import cycle.
// biome-ignore lint/style/noRestrictedImports: workflow barrel closes a runtime cycle.
import { buildVerdict } from "../../workflow/open-items";
// biome-ignore lint/style/noRestrictedImports: workflow barrel closes a runtime cycle.
import { fillStoryStates, loadRunVerdict } from "../../workflow/run-verdict";

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
  readdir: readdirSync,
  loadRunVerdict,
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
    workflow: await readWorkflow(name, options, warnings),
    branch: prd ? await readBranch(prd.branchName, options.repoRoot) : null,
    lastRunLog: readLastRunLog(name, options.outputDir),
    warnings,
  };
}

async function readWorkflow(
  name: string,
  options: FeatureStateOptions,
  warnings: string[],
): Promise<FeatureState["workflow"]> {
  try {
    const loaded = await _featureStateDeps.loadRunVerdict(options.repoRoot, name, async () => options.outputDir);
    const { record } = loaded;
    const verdict = buildVerdict(fillStoryStates(record, loaded.result));
    return {
      runId: loaded.runId,
      step: record.step,
      ...(verdict ? { outcome: verdict.outcome } : {}),
      ...(record.url === undefined ? {} : { url: record.url }),
      ...(record.ci === undefined ? {} : { ci: record.ci }),
      openItems: loaded.openItems.length,
      firstOpenItems: loaded.openItems.slice(0, FIRST_OPEN_ITEMS_LIMIT).map((i) => `[${i.kind}] ${i.id} — ${i.issue}`),
    };
  } catch (err) {
    if (!(err instanceof NaxError && ["WORKFLOW_RESULT_MISSING", "WORKFLOW_NOT_STARTED"].includes(err.code))) {
      warnings.push(`workflow record unreadable: ${errorMessage(err)}`);
    }
    return null;
  }
}

/** Missing artifact trees are ordinary absence; other filesystem failures remain visible. */
function directoryEntries(path: string) {
  try {
    return _featureStateDeps.readdir(path, { withFileTypes: true });
  } catch (err) {
    if (isMissingFile(err)) return [];
    throw err;
  }
}

function isMissingFile(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}

function readLastRunLog(name: string, outputDir: string): string | null {
  // Same descending timestamp-filename ordering as nax status; never read log contents.
  const names = directoryEntries(join(outputDir, "features", name, "runs"))
    .filter((e) => e.isFile() && e.name.endsWith(".jsonl") && e.name !== "latest.jsonl")
    .map((e) => e.name)
    .sort()
    .reverse();
  return names[0]?.slice(0, -".jsonl".length) ?? null;
}

/** List only valid feature directories, projecting artifacts only after applying the bound. */
export async function readWorkflowStateList(options: FeatureStateOptions): Promise<WorkflowStateList> {
  const directories = directoryEntries(featuresDir(options.repoRoot)).filter((e) => e.isDirectory());
  const valid = directories.flatMap((entry) => {
    try {
      return [{ name: entry.name, dir: featureDir(options.repoRoot, entry.name) }];
    } catch {
      // Stray invalid directory names cannot abort the feature list.
      return [];
    }
  });
  const recent = await Promise.all(
    valid.map(async (entry) => ({ ...entry, modified: await featureRecency(entry.dir) })),
  );
  recent.sort((a, b) => b.modified - a.modified || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    features: await Promise.all(
      recent.slice(0, WORKFLOW_STATE_LIST_LIMIT).map((e) => readFeatureState(e.name, options)),
    ),
    omitted: Math.max(0, valid.length - WORKFLOW_STATE_LIST_LIMIT),
  };
}

async function featureRecency(dir: string): Promise<number> {
  const times = await Promise.all(
    ["spec.md", "prd.json", "status.json"].map(async (name) => {
      try {
        return (await _featureStateDeps.file(join(dir, name)).stat()).mtimeMs;
      } catch (err) {
        if (isMissingFile(err)) return 0;
        throw err;
      }
    }),
  );
  return Math.max(0, ...times);
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
    if (typeof prd.branchName !== "string") {
      throw new NaxError("[chat] prd.branchName must be a string", "SCHEMA_VALIDATION_FAILED", { stage: "chat" });
    }
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
