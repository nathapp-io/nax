/** A5 PR3: the pre-flight batch (spec §8) and preflight.json. PR4 calls runPreflight once before the first story. */
import { rename } from "node:fs/promises";
import { join } from "node:path";
import type { AdviceDecision, Advisor } from "@/advisor";
import { describeTarget } from "@/advisor";
import { getLogger } from "@/logger";
import { costIfWrongOf } from "./advisor-live";
import { ledgerText } from "./ledger";

export interface PreflightConflictRecord {
  readonly questionId: string;
  readonly storyIds: readonly string[];
  readonly summary: string;
  readonly decisionId: string | null;
  /** Decision action type, or "hold" (default). */
  readonly action: string;
  readonly fallbackReason?: string;
}

export interface PreflightFile {
  readonly schemaVersion: 1;
  readonly overlap: readonly { readonly storyId: string; readonly specSections: readonly string[] }[];
  readonly conflicts: readonly PreflightConflictRecord[];
  readonly fallbackReason?: string;
}

export function preflightPath(runDir: string): string {
  return join(runDir, "preflight.json");
}

function what(d: AdviceDecision): string {
  return d.action.type === "supersede" ? `supersede ${describeTarget(d.action.target)}` : d.action.type;
}

function isReusable(v: unknown): v is PreflightFile {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return o.schemaVersion === 1 && Array.isArray(o.overlap) && Array.isArray(o.conflicts) && !o.fallbackReason;
}

async function readExisting(path: string): Promise<PreflightFile | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  try {
    const parsed: unknown = JSON.parse(await file.text());
    if (isReusable(parsed)) return parsed;
    getLogger().warn("workflow", "preflight.json is unusable (wrong shape or failed pre-flight) - re-running", {
      storyId: "_run",
      reason: "wrong-shape-or-fallback",
    });
  } catch (err) {
    getLogger().warn("workflow", "preflight.json is unreadable - re-running pre-flight", {
      storyId: "_run",
      reason: err instanceof Error ? err.message : String(err),
    });
  }
  return null;
}

export async function runPreflight(input: {
  readonly advisor: Advisor;
  readonly runDir: string;
  readonly storyIds: readonly string[];
  readonly ledger: (storyId: string, text: string) => Promise<void>;
}): Promise<PreflightFile> {
  const path = preflightPath(input.runDir);
  const existing = await readExisting(path);
  if (existing) return existing;
  const result = await input.advisor.adviseBatch({
    kind: "preflight",
    summary: `Pre-flight for ${input.storyIds.length} stories.`,
    storyIds: [...input.storyIds],
  });
  const items = result.kind === "preflight" ? result.items : [];
  const conflicts: PreflightConflictRecord[] = items.map((item) => ({
    questionId: item.question.id,
    storyIds: item.decision?.appliesTo ?? (item.question.storyId ? [item.question.storyId] : []),
    summary: item.question.summary,
    decisionId: item.decision?.id ?? null,
    action: item.decision?.action.type ?? "hold",
    ...(item.fallbackReason ? { fallbackReason: item.fallbackReason } : {}),
  }));
  const file: PreflightFile = {
    schemaVersion: 1,
    overlap: result.kind === "preflight" ? result.overlap : [],
    conflicts,
    ...(result.kind === "preflight" && result.fallbackReason ? { fallbackReason: result.fallbackReason } : {}),
  };
  const tmp = `${path}.tmp`;
  await Bun.write(tmp, `${JSON.stringify(file, null, 2)}\n`);
  await rename(tmp, path);
  for (const [i, item] of items.entries()) {
    const record = conflicts[i];
    if (!record) continue;
    const text = item.decision
      ? ledgerText.ruling({
          action: "hold",
          text: `pre-flight ${item.decision.id}: ${what(item.decision)}`,
          why: item.decision.rationale,
          costIfWrong: costIfWrongOf(item.decision),
          source: "advisor",
        })
      : ledgerText.ruling({
          action: "hold",
          text: "pre-flight hold (default)",
          why: item.fallbackReason ?? "no advisor ruling",
          costIfWrong: "the story runs under the spec as written",
          source: "default",
        });
    for (const storyId of record.storyIds) await input.ledger(storyId, text);
  }
  return file;
}
