/**
 * A1 decisions ledger (spec §4.6): `featureDir(repoRoot, feature)/decisions.jsonl`, append-only,
 * written by nax only. `repoRoot` is always the MAIN checkout so parallel worktree stories serialise
 * on one file. Ids are `D-<n>`, n = valid lines + 1, computed inside the lock.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withPathFileLock } from "@nathapp/nax-agent/internal";
import { featureDir } from "../config";
import { getSafeLogger } from "../logger";
import type { AdviceDecision } from "./types";

export const _ledgerDeps = {
  readText: async (path: string): Promise<string | null> => {
    const file = Bun.file(path);
    return (await file.exists()) ? file.text() : null;
  },
  appendText: async (path: string, text: string): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, text);
  },
  // The lock file sits beside the ledger, so its directory must exist first.
  withLock: async <T>(path: string, fn: () => Promise<T>): Promise<T> => {
    await mkdir(dirname(path), { recursive: true });
    return withPathFileLock(path, fn);
  },
};

export function ledgerPath(repoRoot: string, feature: string): string {
  return join(featureDir(repoRoot, feature), "decisions.jsonl");
}

function parseLines(text: string, path: string): AdviceDecision[] {
  const out: AdviceDecision[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line) as AdviceDecision);
    } catch {
      getSafeLogger()?.warn("advisor", "Skipping unreadable ledger line", { storyId: "_run", path });
    }
  }
  return out;
}

export async function readDecisions(repoRoot: string, feature: string): Promise<AdviceDecision[]> {
  const path = ledgerPath(repoRoot, feature);
  const text = await _ledgerDeps.readText(path);
  return text === null ? [] : parseLines(text, path);
}

/** A draft, or a builder that receives the assigned id (so the line can name its own audit file). */
export type DecisionDraft = Omit<AdviceDecision, "id"> | ((id: string) => Omit<AdviceDecision, "id">);

export async function appendDecision(repoRoot: string, feature: string, draft: DecisionDraft): Promise<AdviceDecision> {
  const path = ledgerPath(repoRoot, feature);
  return _ledgerDeps.withLock(path, async () => {
    const existing = await readDecisions(repoRoot, feature);
    const id = `D-${existing.length + 1}`;
    const decision: AdviceDecision = { ...(typeof draft === "function" ? draft(id) : draft), id };
    const text = (await _ledgerDeps.readText(path)) ?? "";
    // A crash mid-append can leave a partial last line without "\n"; start ours on a fresh line.
    const prefix = text.length > 0 && !text.endsWith("\n") ? "\n" : "";
    await _ledgerDeps.appendText(path, `${prefix}${JSON.stringify(decision)}\n`);
    return decision;
  });
}

const STORY_RULING_KINDS = new Set(["fix-cycle-give-up", "uncategorised-failure"]);

export function countStoryRulings(decisions: readonly AdviceDecision[], storyId: string): number {
  return decisions.filter((d) => d.storyId === storyId && STORY_RULING_KINDS.has(d.kind)).length;
}

export function findReusable(decisions: readonly AdviceDecision[], dedupeKey: string): AdviceDecision | undefined {
  return [...decisions]
    .reverse()
    .find((d) => d.dedupeKey === dedupeKey && (d.action.type === "waive" || d.action.type === "supersede"));
}
