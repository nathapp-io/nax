/**
 * `nax advisor import-finish` (spec §4.7, §9): turn a recorded finish
 * escalation into unanswered `finish-judgment` question artifacts, so the
 * go-live replay can ask the advisor the same questions a human answered.
 */
import { basename } from "node:path";
import type { AdviceAuditRecord, AdviceQuestion } from "@/advisor";
import { buildMenu, dedupeKeyFor, writeAdviceAudit } from "@/advisor";
import { loadConfig } from "@/config";
import { projectOutputDir } from "@/runtime";
import { NAX_COMMIT, NAX_VERSION } from "@/version";

export interface AdvisorImportOptions {
  dir: string;
  resultPath: string;
  sha: string;
  /** Import every finding, for results recorded before findings carried `judgment`. */
  allFindings: boolean;
}

export interface AdvisorImportDeps {
  resolveOutputDir: (workdir: string) => Promise<string>;
  acceptanceEnabled: (workdir: string) => Promise<boolean>;
  newId: () => string;
  log: (text: string) => void;
  logErr: (text: string) => void;
}

export const _advisorImportDeps: AdvisorImportDeps = {
  resolveOutputDir: async (workdir) => {
    const config = await loadConfig(workdir).catch(() => null);
    return projectOutputDir(config?.name?.trim() || basename(workdir), config?.outputDir);
  },
  // Today's root config, not the config at <sha>: the conservative reading (enabled ⇒ no AC supersede).
  acceptanceEnabled: async (workdir) => {
    const config = await loadConfig(workdir).catch(() => null);
    return config?.acceptance?.enabled !== false;
  },
  newId: () => `Q-${crypto.randomUUID().slice(0, 13)}`,
  log: (text) => {
    console.log(text);
  },
  logErr: (text) => {
    console.error(text);
  },
};

interface RecordedFinding {
  severity: string;
  title: string;
  problem: string;
  fix?: string;
  judgment?: boolean;
  judgmentReason?: string;
}

interface RecordedResult {
  feature: string;
  escalationReason?: string;
  findings?: RecordedFinding[];
  rounds?: { phase: string; outcome: string }[];
}

function escalatedPhase(r: RecordedResult): string {
  return [...(r.rounds ?? [])].reverse().find((x) => x.outcome === "escalated")?.phase ?? "quality";
}

function toQuestion(
  r: RecordedResult,
  f: RecordedFinding,
  sha: string,
  deps: AdvisorImportDeps,
  acceptanceOn: boolean,
): AdviceQuestion {
  const phase = escalatedPhase(r);
  return {
    id: deps.newId(),
    kind: "finish-judgment",
    feature: r.feature,
    dedupeKey: dedupeKeyFor(phase, f),
    askedAtSha: sha,
    summary: `${f.title}: ${f.problem}`,
    evidence: [{ source: "finding", text: `${f.problem}${f.fix ? `\nSuggested fix: ${f.fix}` : ""}` }],
    options: buildMenu({
      kind: "finish-judgment",
      acceptanceEnabledForStory: acceptanceOn,
      ...(/\bspec\b/i.test(f.problem) ? { citesSpecSection: "spec" } : {}),
    }),
    findingSeverity: f.severity,
  };
}

function toRecord(question: AdviceQuestion): AdviceAuditRecord {
  return {
    schemaVersion: 1,
    naxVersion: NAX_VERSION,
    naxCommit: NAX_COMMIT,
    runId: "imported",
    question,
    context: { specPath: "", specSha256: null, prdSha256: null, priorDecisions: [] },
    worktree: { sha: question.askedAtSha, patch: "", patchTruncated: false },
    memoryMode: "stateless",
    model: "",
    prompt: "",
    rawReply: "",
    result: { decision: null, fallbackReason: "imported" },
    costUsd: 0,
    headsUp: { sent: false, reason: "imported" },
  };
}

export async function runAdvisorImport(
  opts: AdvisorImportOptions,
  deps: AdvisorImportDeps = _advisorImportDeps,
): Promise<number> {
  if (!opts.sha) {
    deps.logErr("error: --sha is required (older finish results record no head SHA)");
    return 2;
  }
  const result = JSON.parse(await Bun.file(opts.resultPath).text()) as RecordedResult;
  const picked = (result.findings ?? []).filter((f) => opts.allFindings || f.judgment === true);
  if (picked.length === 0) {
    const gap = /reading obligations/i.test(result.escalationReason ?? "");
    deps.log(gap ? "not importable in A1 (evidence-gap escalation)" : "no judgment findings to import");
    return 0;
  }
  const outputDir = await deps.resolveOutputDir(opts.dir);
  const acceptanceOn = await deps.acceptanceEnabled(opts.dir);
  for (const f of picked) {
    await writeAdviceAudit(outputDir, result.feature, toRecord(toQuestion(result, f, opts.sha, deps, acceptanceOn)));
  }
  deps.log(`imported ${picked.length} question(s) for ${result.feature}`);
  return 0;
}
