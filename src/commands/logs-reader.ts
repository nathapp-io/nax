/**
 * Log reading and parsing utilities
 */

import { existsSync, readdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { LogEntry } from "../logger/types";
import type { MetaJson } from "../pipeline/subscribers/registry";
import { getRunsDir } from "../utils/paths";

/**
 * Swappable dependencies for testing
 */
export const _logsReaderDeps = {
  getRunsDir,
};

/**
 * Resolve log file path for a runId from the central registry
 */
export async function resolveRunFileFromRegistry(runId: string): Promise<string | null> {
  const runsDir = _logsReaderDeps.getRunsDir();

  let entries: string[];
  try {
    entries = await readdir(runsDir);
  } catch {
    throw new Error(`Run not found in registry: ${runId}`);
  }

  // Exact match wins immediately and unambiguously. Otherwise collect every prefix
  // match instead of taking the first one — `entries` order is whatever readdir()
  // returns (not sorted, not deterministic across filesystems), so silently picking
  // the first prefix match could return an arbitrary run among several sharing that
  // prefix (BUG-54). Error on genuine ambiguity instead.
  let exactMatch: MetaJson | null = null;
  const prefixMatches: MetaJson[] = [];
  for (const entry of entries) {
    const metaPath = join(runsDir, entry, "meta.json");
    try {
      const meta: MetaJson = await Bun.file(metaPath).json();
      if (meta.runId === runId) {
        exactMatch = meta;
        break;
      }
      if (meta.runId.startsWith(runId)) {
        prefixMatches.push(meta);
      }
    } catch {
      // skip unreadable meta.json entries
    }
  }

  let matched: MetaJson | null = exactMatch;
  if (!matched) {
    if (prefixMatches.length > 1) {
      const candidates = prefixMatches.map((m) => m.runId).join(", ");
      throw new Error(`Ambiguous run ID "${runId}" matches multiple runs: ${candidates}`);
    }
    matched = prefixMatches[0] ?? null;
  }

  if (!matched) {
    throw new Error(`Run not found in registry: ${runId}`);
  }

  if (!existsSync(matched.eventsDir)) {
    console.log(`Log directory unavailable for run: ${runId}`);
    return null;
  }

  const files = readdirSync(matched.eventsDir)
    .filter((f) => f.endsWith(".jsonl") && f !== "latest.jsonl")
    .sort()
    .reverse();

  if (files.length === 0) {
    console.log(`No log files found for run: ${runId}`);
    return null;
  }

  const specificFile = files.find((f) => f === `${matched.runId}.jsonl`);
  return join(matched.eventsDir, specificFile ?? files[0]);
}

/**
 * Select latest run file from directory
 */
export async function selectRunFile(runsDir: string): Promise<string | null> {
  const files = readdirSync(runsDir)
    .filter((f) => f.endsWith(".jsonl") && f !== "latest.jsonl")
    .sort()
    .reverse();

  if (files.length === 0) {
    return null;
  }

  return join(runsDir, files[0]);
}

/**
 * Extract run summary from log file
 */
export async function extractRunSummary(filePath: string): Promise<{
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  totalCost: number;
  startedAt: string;
  completedAt: string | undefined;
} | null> {
  const file = Bun.file(filePath);
  const content = await file.text();
  const lines = content.trim().split("\n");

  let total = 0;
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let totalCost = 0;
  let startedAt = "";
  let completedAt: string | undefined;
  let firstTimestamp = "";
  let lastTimestamp = "";

  for (const line of lines) {
    if (!line.trim()) continue;

    try {
      const entry: LogEntry = JSON.parse(line);

      if (!firstTimestamp) {
        firstTimestamp = entry.timestamp;
      }
      lastTimestamp = entry.timestamp;

      if (entry.stage === "run.start") {
        startedAt = entry.timestamp;
        const runData = entry.data as Record<string, unknown>;
        total = typeof runData?.totalStories === "number" ? runData.totalStories : 0;
      }

      if (entry.stage === "story.complete" || entry.stage === "agent.complete") {
        const data = entry.data as Record<string, unknown>;
        const success = data?.success ?? true;
        const action = data?.finalAction || data?.action;

        if (success) {
          passed++;
        } else if (action === "skip") {
          skipped++;
        } else {
          failed++;
        }

        if (data?.cost && typeof data.cost === "number") {
          totalCost += data.cost;
        }
      }

      if (entry.stage === "run.end") {
        completedAt = entry.timestamp;
      }
    } catch {
      // Skip invalid JSON lines
    }
  }

  if (!startedAt) {
    return null;
  }

  const durationMs = lastTimestamp ? new Date(lastTimestamp).getTime() - new Date(firstTimestamp).getTime() : 0;

  return {
    total,
    passed,
    failed,
    skipped,
    durationMs,
    totalCost,
    startedAt,
    completedAt,
  };
}
