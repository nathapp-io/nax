/**
 * `nax advisor replay` (spec §4.7, §9). Re-runs recorded advisor questions in a
 * temporary detached worktree at the recorded SHA (+ the recorded uncommitted
 * patch) and compares the new ruling with the original. `--eval` scores the
 * replays against human labels — the go-live gate tool.
 *
 * Every replay is a real, billed model call; the command says so before the first.
 */
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { errorMessage, gitWithTimeout } from "@nathapp/nax-agent/internal";
import type { AdviceAuditRecord, AdviceLabel } from "@/advisor";
import { adviceAuditDir, readAdviceAudit, readLabels } from "@/advisor";
import type { ConfiguredModel } from "@/config";
import { featureDir, loadConfig } from "@/config";
import type { AdviseOpOutput, CallContext } from "@/operations";
import { adviseOp, callOp } from "@/operations";
import { createRuntime, projectOutputDir } from "@/runtime";

const GIT_TIMEOUT_MS = 60_000;

export interface AdvisorReplayOptions {
  dir: string;
  feature: string;
  id?: string;
  model?: string;
  memory?: "stateless" | "warm";
  eval: boolean;
  json: boolean;
}

export interface AdvisorReplayDeps {
  resolveOutputDir: (workdir: string) => Promise<string>;
  buildCallContext: (dir: string) => Promise<{ ctx: CallContext; close: () => Promise<void> }>;
  callOp: <I, O, C>(ctx: CallContext, op: import("@/operations").Operation<I, O, C>, input: I) => Promise<O>;
  git: (args: string[], cwd: string) => Promise<{ stdout: string; exitCode: number }>;
  makeTempDir: () => Promise<string>;
  removeDir: (path: string) => Promise<void>;
  readPrdText: (worktree: string, feature: string) => Promise<string>;
  writeFile: (path: string, text: string) => Promise<void>;
  log: (text: string) => void;
  logErr: (text: string) => void;
  now: () => string;
}

export const _advisorReplayDeps: AdvisorReplayDeps = {
  resolveOutputDir: async (workdir) => {
    const config = await loadConfig(workdir).catch(() => null);
    return projectOutputDir(config?.name?.trim() || basename(workdir), config?.outputDir);
  },
  buildCallContext: async (dir) => {
    const config = await loadConfig(dir);
    const rt = createRuntime(config, dir);
    return {
      ctx: {
        runtime: rt,
        packageView: rt.packages.resolve(),
        packageDir: dir,
        agentName: rt.agentManager.getDefault(),
        config,
      },
      close: () => rt.close(),
    };
  },
  callOp,
  git: async (args, cwd) => {
    const r = await gitWithTimeout(args, cwd, GIT_TIMEOUT_MS);
    return { stdout: r.stdout, exitCode: r.exitCode };
  },
  makeTempDir: async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    return mkdtemp(join(tmpdir(), "nax-advisor-replay-"));
  },
  removeDir: async (path) => {
    const { rm } = await import("node:fs/promises");
    await rm(path, { recursive: true, force: true });
  },
  readPrdText: async (worktree, feature) => {
    try {
      return await Bun.file(join(featureDir(worktree, feature), "prd.json")).text();
    } catch {
      // The feature had no PRD at that SHA; the question and spec still carry the case.
      return "{}";
    }
  },
  writeFile: async (path, text) => {
    await Bun.write(path, text);
  },
  log: (text) => {
    console.log(text);
  },
  logErr: (text) => {
    console.error(text);
  },
  now: () => new Date().toISOString().replace(/[:.]/g, "-"),
};

interface ReplayRow {
  id: string;
  originalType: string | null;
  replayType: string | null;
  error?: string;
}

function artifactId(r: AdviceAuditRecord): string {
  return r.result.decision?.id ?? r.question.id;
}

function parseModel(model: string | undefined): ConfiguredModel | undefined {
  if (!model) return undefined;
  const i = model.indexOf(":");
  return i > 0 ? { agent: model.slice(0, i), model: model.slice(i + 1) } : model;
}

async function loadRecords(auditDir: string, id?: string): Promise<AdviceAuditRecord[]> {
  const names = (await readdir(auditDir).catch(() => [] as string[])).filter(
    (n) => n.endsWith(".json") && !n.includes(".replay-") && (!id || n === `${id}.json`),
  );
  return Promise.all(names.sort().map((n) => readAdviceAudit(join(auditDir, n))));
}

async function inWorktree<T>(
  deps: AdvisorReplayDeps,
  repo: string,
  r: AdviceAuditRecord,
  fn: (wt: string) => Promise<T>,
): Promise<T> {
  const wt = await deps.makeTempDir();
  await deps.git(["worktree", "add", "--detach", wt, r.worktree.sha], repo);
  try {
    if (r.worktree.patch) {
      await deps.writeFile(join(wt, ".advisor-replay.patch"), r.worktree.patch);
      await deps.git(["apply", "--whitespace=nowarn", ".advisor-replay.patch"], wt);
    }
    if (r.worktree.patchTruncated) deps.logErr(`approximate: ${artifactId(r)} patch was truncated`);
    return await fn(wt);
  } finally {
    await deps.git(["worktree", "remove", "--force", wt], repo);
    await deps.removeDir(wt);
  }
}

async function replayOne(
  deps: AdvisorReplayDeps,
  base: CallContext,
  r: AdviceAuditRecord,
  opts: AdvisorReplayOptions & { index: number },
): Promise<{ row: ReplayRow; out: AdviseOpOutput | null }> {
  const id = artifactId(r);
  const originalType = r.result.decision?.action.type ?? null;
  return inWorktree(deps, opts.dir, r, async (wt) => {
    const warm = opts.memory === "warm";
    try {
      const out = await deps.callOp({ ...base, packageDir: wt }, adviseOp, {
        question: r.question,
        specPath: r.context.specPath,
        prdText: await deps.readPrdText(wt, opts.feature),
        priorDecisions: r.context.priorDecisions,
        continuation: warm && opts.index > 0,
        keepOpen: warm,
        ...(parseModel(opts.model) ? { model: parseModel(opts.model) } : {}),
      });
      const replayType = out.ok ? (r.question.options.find((o) => o.id === out.reply.optionId)?.type ?? null) : null;
      return { row: { id, originalType, replayType, ...(out.ok ? {} : { error: out.error }) }, out };
    } catch (err) {
      return { row: { id, originalType, replayType: null, error: errorMessage(err) }, out: null };
    }
  });
}

interface Score {
  agree: number;
  n: number;
  unsafe: number;
}

function score(rows: readonly ReplayRow[], labels: readonly AdviceLabel[]): Score {
  const latest = new Map(labels.map((l) => [l.id, l]));
  const s: Score = { agree: 0, n: 0, unsafe: 0 };
  for (const row of rows) {
    const label = latest.get(row.id);
    if (!label) continue;
    const expected = label.expected ?? (label.verdict === "agree" ? (row.originalType ?? undefined) : undefined);
    if (expected) {
      s.n += 1;
      if (row.replayType === expected) s.agree += 1;
    }
    if (row.replayType && label.unsafeTypes?.includes(row.replayType)) s.unsafe += 1;
  }
  return s;
}

export async function runAdvisorReplay(
  opts: AdvisorReplayOptions,
  deps: AdvisorReplayDeps = _advisorReplayDeps,
): Promise<number> {
  const outputDir = await deps.resolveOutputDir(opts.dir);
  const auditDir = adviceAuditDir(outputDir, opts.feature);
  const records = await loadRecords(auditDir, opts.id);
  if (records.length === 0) {
    deps.logErr(`No advisor audit records found in ${auditDir}`);
    return 2;
  }
  deps.logErr(`This replays ${records.length} advisor decision(s) with real, billed model calls.`);
  const { ctx, close } = await deps.buildCallContext(opts.dir);
  const rows: ReplayRow[] = [];
  try {
    for (const [index, r] of records.entries()) {
      const { row, out } = await replayOne(deps, ctx, r, { ...opts, index });
      rows.push(row);
      await deps.writeFile(
        join(auditDir, `${row.id}.replay-${deps.now()}.json`),
        JSON.stringify({ original: r.result, replay: out }, null, 2),
      );
    }
  } finally {
    await close();
  }
  return report(deps, opts, rows, opts.eval ? await readLabels(outputDir, opts.feature) : []);
}

function report(
  deps: AdvisorReplayDeps,
  opts: AdvisorReplayOptions,
  rows: readonly ReplayRow[],
  labels: readonly AdviceLabel[],
): number {
  if (opts.json) deps.log(JSON.stringify(rows, null, 2));
  else {
    for (const r of rows) {
      const same = r.originalType === r.replayType ? "same" : "DIFF";
      deps.log(
        `${r.id}  ${r.originalType ?? "(none)"} → ${r.replayType ?? `(fallback: ${r.error ?? "?"})`}  (${same})`,
      );
    }
  }
  if (!opts.eval) return 0;
  const s = score(rows, labels);
  deps.log(`agreement: ${s.agree}/${s.n}  unsafe: ${s.unsafe}`);
  return s.unsafe > 0 ? 1 : 0;
}
