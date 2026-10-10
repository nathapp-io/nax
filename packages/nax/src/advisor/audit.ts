/**
 * A1 advisor audit (spec §4.7): one replayable JSON artifact per decision under
 * `<outputDir>/advisor-audit/<feature>/`, plus `labels.jsonl` for human labels.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { gitWithTimeout } from "@nathapp/nax-agent/internal";
import { NaxError } from "../errors";
import type { AdviceDecision, AdviceQuestion, AdviceResult } from "./types";

export const PATCH_CAP_BYTES = 262_144;
const GIT_TIMEOUT_MS = 30_000;

export interface AdviceAuditRecord {
  schemaVersion: 1;
  naxVersion: string;
  naxCommit: string;
  runId: string;
  question: AdviceQuestion;
  context: { specPath: string; specSha256: string | null; prdSha256: string | null; priorDecisions: AdviceDecision[] };
  worktree: { sha: string; patch: string; patchTruncated: boolean };
  memoryMode: "stateless" | "warm";
  model: string;
  prompt: string;
  rawReply: string;
  result: AdviceResult;
  costUsd: number;
  headsUp: { sent: boolean; reason?: string };
}

export interface AdviceLabel {
  id: string;
  verdict: "agree" | "disagree";
  expected?: string;
  /** Action types that are unsafe for this case (spec §9). */
  unsafeTypes?: string[];
  note?: string;
  labelledAt: string;
}

export const _auditDeps = {
  git: async (args: string[], cwd: string): Promise<{ stdout: string; exitCode: number }> => {
    const r = await gitWithTimeout(args, cwd, GIT_TIMEOUT_MS);
    return { stdout: r.stdout, exitCode: r.exitCode };
  },
  write: async (path: string, text: string): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, text);
  },
  readText: async (path: string): Promise<string | null> => {
    const f = Bun.file(path);
    return (await f.exists()) ? f.text() : null;
  },
  append: async (path: string, text: string): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, text);
  },
};

export function adviceAuditDir(outputDir: string, feature: string): string {
  return join(outputDir, "advisor-audit", feature);
}

export async function writeAdviceAudit(outputDir: string, feature: string, record: AdviceAuditRecord): Promise<string> {
  const name = record.result.decision?.id ?? record.question.id;
  const path = join(adviceAuditDir(outputDir, feature), `${name}.json`);
  await _auditDeps.write(path, JSON.stringify(record, null, 2));
  return relative(outputDir, path);
}

export async function readAdviceAudit(path: string): Promise<AdviceAuditRecord> {
  const text = await _auditDeps.readText(path);
  if (text === null) {
    throw new NaxError(`[advisor] advisor audit not found: ${path}`, "ADVISOR_AUDIT_NOT_FOUND", {
      stage: "advisor",
      path,
    });
  }
  return JSON.parse(text) as AdviceAuditRecord;
}

export async function captureWorktreePatch(
  workdir: string,
  capBytes: number = PATCH_CAP_BYTES,
): Promise<{ sha: string; patch: string; patchTruncated: boolean }> {
  const sha = (await _auditDeps.git(["rev-parse", "HEAD"], workdir)).stdout.trim();
  const tracked = (await _auditDeps.git(["diff", "HEAD"], workdir)).stdout;
  // NUL-separated and after `--`: an agent-created file named like an option
  // (`--output=…`) must never be read as one by git.
  const untrackedList = (await _auditDeps.git(["ls-files", "-z", "--others", "--exclude-standard"], workdir)).stdout
    .split("\0")
    .filter((l) => l !== "");
  const untracked: string[] = [];
  for (const f of untrackedList) {
    untracked.push((await _auditDeps.git(["diff", "--no-index", "--", "/dev/null", f], workdir)).stdout);
  }
  const full = [tracked, ...untracked].join("");
  return full.length > capBytes
    ? { sha, patch: full.slice(0, capBytes), patchTruncated: true }
    : { sha, patch: full, patchTruncated: false };
}

export async function appendLabel(outputDir: string, feature: string, label: AdviceLabel): Promise<void> {
  await _auditDeps.append(join(adviceAuditDir(outputDir, feature), "labels.jsonl"), `${JSON.stringify(label)}\n`);
}

export async function readLabels(outputDir: string, feature: string): Promise<AdviceLabel[]> {
  const text = await _auditDeps.readText(join(adviceAuditDir(outputDir, feature), "labels.jsonl"));
  if (!text) return [];
  return text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as AdviceLabel);
}
