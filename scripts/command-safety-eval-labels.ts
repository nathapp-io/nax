/**
 * Labels pass for the P5 eval: scores the labelled shadow commands (a
 * directory of `*.labels.jsonl` files, kept OUTSIDE this repo) with every
 * scorer, so the A-mode threshold is ruled on real agent commands and not
 * only on the red-team corpus. It decides nothing.
 *
 * Model answers are never re-requested. Each label is joined to a stored
 * shadow row (`--rows`): by decisionId first, then by (command, cwd). A label
 * with no scorable row keeps its rule score and is counted as unmatched,
 * never dropped. Grey labels are counted and excluded from every rate, the
 * same as grey corpus rows.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { scoreRules } from "../src/command-safety";
import {
  allScores,
  type ModelScores,
  type NarrowableRow,
  type Scored,
  scoreModel,
  type Weights,
} from "./command-safety-eval";

export interface LabelRecord {
  readonly command: string;
  readonly cwd?: string;
  readonly questionSetVersion: number;
  readonly labeller: string;
  readonly verdict?: string;
  readonly decisionIds?: readonly string[];
  readonly gold?: { readonly harm: { readonly label: string } };
}

export type LabelSource = "human" | "rule" | "claude-review" | "other";
export type LabelMatch = "decisionId" | "commandCwd" | "none";

export interface LabelledScored extends Scored {
  readonly source: LabelSource;
  readonly match: LabelMatch;
}

export function labelSource(labeller: string): LabelSource {
  if (labeller === "human") return "human";
  if (labeller.startsWith("claude-rule-")) return "rule";
  if (labeller.startsWith("claude-review-")) return "claude-review";
  return "other";
}

/** "grey" for a grey verdict or a record without gold; otherwise the gold harm label ("none" = safe). */
export function labelClass(record: LabelRecord): string {
  if (record.verdict === "grey" || record.gold === undefined) return "grey";
  return record.gold.harm.label;
}

function parseLabelLine(file: string, line: string, lineNo: number): LabelRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (err) {
    throw new Error(`${file}:${lineNo}: not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  const r = parsed as Partial<LabelRecord>;
  if (typeof r.command !== "string" || typeof r.labeller !== "string" || typeof r.questionSetVersion !== "number") {
    throw new Error(
      `${file}:${lineNo}: a label record needs string command, string labeller, number questionSetVersion`,
    );
  }
  return r as LabelRecord;
}

/** Every record of every `*.labels.jsonl` in `dir`, files in name order. Other files are ignored. */
export function readLabels(dir: string): LabelRecord[] {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".labels.jsonl"))
    .sort((a, b) => a.localeCompare(b));
  if (files.length === 0) throw new Error(`--labels ${dir}: no *.labels.jsonl files`);
  return files.flatMap((name) =>
    readFileSync(join(dir, name), "utf8")
      .split("\n")
      .flatMap((line, i) => (line.trim().length === 0 ? [] : [parseLabelLine(name, line, i + 1)])),
  );
}

/** The one question-set version every label shares; it must equal the live rows' version when there is one. */
export function checkLabelVersions(labels: readonly LabelRecord[], liveVersion: number | undefined): number {
  const versions = [...new Set(labels.map((l) => l.questionSetVersion))];
  if (versions.length === 0) throw new Error("--labels: no label records");
  if (versions.length > 1) throw new Error(`labels mix question-set versions (${versions.join(", ")})`);
  const version = versions[0] as number;
  if (liveVersion !== undefined && version !== liveVersion) {
    throw new Error(`labels are question set v${version} but the live rows are v${liveVersion}; never mix versions`);
  }
  return version;
}

const joinKey = (command: string, cwd: string | undefined) => `${cwd ?? ""}\u0000${command}`;

function indexRows(rows: readonly NarrowableRow[]) {
  const byId = new Map<string, ModelScores>();
  const byKey = new Map<string, ModelScores>();
  for (const r of rows) {
    const model = scoreModel(r.model);
    if (model === undefined) continue;
    const id = r.model.decisionId;
    if (id !== undefined && !byId.has(id)) byId.set(id, model);
    if (r.command !== undefined) {
      const key = joinKey(r.command, r.cwd);
      if (!byKey.has(key)) byKey.set(key, model);
    }
  }
  return { byId, byKey };
}

/** Each label with every scorer's value, its source group and how its model answer was found. */
export function joinLabels(
  labels: readonly LabelRecord[],
  rows: readonly NarrowableRow[],
  weights?: Weights,
): LabelledScored[] {
  const { byId, byKey } = indexRows(rows);
  return labels.map((l): LabelledScored => {
    const fromId = (l.decisionIds ?? []).map((id) => byId.get(id)).find((m) => m !== undefined);
    const fromKey = fromId === undefined ? byKey.get(joinKey(l.command, l.cwd)) : undefined;
    const match: LabelMatch = fromId !== undefined ? "decisionId" : fromKey !== undefined ? "commandCwd" : "none";
    const hits = scoreRules(l.command, l.cwd !== undefined ? { root: l.cwd } : {}).hits;
    const rule = Object.values(hits).some(Boolean);
    const cls = labelClass(l);
    return {
      label: cls === "grey" ? "grey" : cls === "none" ? "benign" : "dangerous",
      category: cls === "grey" || cls === "none" ? null : cls,
      scores: allScores(rule, fromId ?? fromKey, weights),
      source: labelSource(l.labeller),
      match,
    };
  });
}
