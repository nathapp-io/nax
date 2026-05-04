/**
 * Curator Observation Collector
 *
 * Reads Tier 1 run artifacts and projects them to normalized observations.
 */

import * as path from "node:path";
import type {
  AcceptanceVerdictObservation,
  ChunkExcludedObservation,
  ChunkIncludedObservation,
  CuratorPostRunContext,
  EscalationObservation,
  FixCycleExitObservation,
  FixCycleIterationObservation,
  FixCycleValidatorRetryObservation,
  Observation,
  ProviderEmptyObservation,
  PullCallObservation,
  RectifyCycleObservation,
  ReviewFindingObservation,
  VerdictObservation,
} from "./types";

function now(): string {
  return new Date().toISOString();
}

async function readJsonFile(filePath: string): Promise<unknown> {
  const file = Bun.file(filePath);
  const text = await file.text();
  return JSON.parse(text);
}

async function readJsonLines(filePath: string): Promise<unknown[]> {
  const file = Bun.file(filePath);
  const text = await file.text();
  const lines: unknown[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      lines.push(JSON.parse(trimmed));
    } catch {
      // skip malformed lines
    }
  }
  return lines;
}

async function collectFromMetrics(context: CuratorPostRunContext): Promise<Observation[]> {
  const observations: Observation[] = [];
  const metricsPath = path.join(context.outputDir, "metrics.json");
  try {
    const data = await readJsonFile(metricsPath);
    if (!data || typeof data !== "object") return observations;
    const metrics = data as Record<string, unknown>;
    const stories = metrics.stories as Record<string, unknown>[] | undefined;
    if (!Array.isArray(stories)) return observations;
    for (const story of stories) {
      const storyRecord = story as Record<string, unknown>;
      const storyId = String(storyRecord.storyId ?? storyRecord.id ?? "unknown");
      const featureId = String(storyRecord.featureId ?? context.feature);
      const obs: VerdictObservation = {
        schemaVersion: 1,
        runId: context.runId,
        featureId,
        storyId,
        stage: "verdict",
        ts: now(),
        kind: "verdict",
        payload: {
          status: String(storyRecord.status ?? "unknown") as "completed" | "failed" | "skipped",
          cost: Number(storyRecord.cost ?? 0),
          tokens: Number(storyRecord.tokens ?? 0),
        },
      };
      observations.push(obs);
    }
  } catch {
    // Missing or malformed metrics.json — skip silently
  }
  return observations;
}

async function collectFromReviewAudit(context: CuratorPostRunContext): Promise<Observation[]> {
  const observations: Observation[] = [];
  const auditDir = path.join(context.outputDir, "review-audit");
  try {
    const glob = new Bun.Glob("**/*.json");
    for await (const file of glob.scan({ cwd: auditDir, absolute: false })) {
      const fullPath = path.join(auditDir, file);
      try {
        const data = await readJsonFile(fullPath);
        if (!data || typeof data !== "object") continue;
        const audit = data as Record<string, unknown>;
        const findings = audit.findings as Record<string, unknown>[] | undefined;
        if (!Array.isArray(findings)) continue;
        const storyId = String(audit.storyId ?? "unknown");
        const featureId = String(audit.featureId ?? context.feature);
        for (const finding of findings) {
          const f = finding as Record<string, unknown>;
          const obs: ReviewFindingObservation = {
            schemaVersion: 1,
            runId: context.runId,
            featureId,
            storyId,
            stage: "review",
            ts: now(),
            kind: "review-finding",
            payload: {
              ruleId: String(f.ruleId ?? "unknown"),
              severity: String(f.severity ?? "info"),
              file: String(f.file ?? ""),
              line: Number(f.line ?? 0),
              message: String(f.message ?? ""),
            },
          };
          observations.push(obs);
        }
      } catch {
        // Malformed audit file — skip
      }
    }
  } catch {
    // Missing review-audit directory — skip silently
  }
  return observations;
}

async function collectFromContextManifests(context: CuratorPostRunContext): Promise<Observation[]> {
  const observations: Observation[] = [];
  const featuresDir = path.join(context.workdir, ".nax", "features");
  try {
    const glob = new Bun.Glob("*/stories/*/context-manifest-*.json");
    for await (const file of glob.scan({ cwd: featuresDir, absolute: false })) {
      const fullPath = path.join(featuresDir, file);
      try {
        const parts = file.split("/");
        const featureId = parts[0] ?? context.feature;
        const storyId = parts[2] ?? "unknown";
        const data = await readJsonFile(fullPath);
        if (!data || typeof data !== "object") continue;
        const manifest = data as Record<string, unknown>;
        const chunks = manifest.chunks as Record<string, unknown>[] | undefined;
        if (!Array.isArray(chunks)) continue;
        for (const chunk of chunks) {
          const c = chunk as Record<string, unknown>;
          const included = Boolean(c.included ?? true);
          if (included) {
            const obs: ChunkIncludedObservation = {
              schemaVersion: 1,
              runId: context.runId,
              featureId,
              storyId,
              stage: "context",
              ts: now(),
              kind: "chunk-included",
              payload: {
                chunkId: String(c.chunkId ?? c.id ?? "unknown"),
                label: String(c.label ?? ""),
                tokens: Number(c.tokens ?? 0),
              },
            };
            observations.push(obs);
          } else {
            const obs: ChunkExcludedObservation = {
              schemaVersion: 1,
              runId: context.runId,
              featureId,
              storyId,
              stage: "context",
              ts: now(),
              kind: "chunk-excluded",
              payload: {
                chunkId: String(c.chunkId ?? c.id ?? "unknown"),
                label: String(c.label ?? ""),
                reason: c.reason ? String(c.reason) : undefined,
              },
            };
            observations.push(obs);
          }
        }
        const emptyProviders = manifest.emptyProviders as Record<string, unknown>[] | undefined;
        if (Array.isArray(emptyProviders)) {
          for (const ep of emptyProviders) {
            const e = ep as Record<string, unknown>;
            const obs: ProviderEmptyObservation = {
              schemaVersion: 1,
              runId: context.runId,
              featureId,
              storyId,
              stage: "context",
              ts: now(),
              kind: "provider-empty",
              payload: {
                provider: String(e.provider ?? "unknown"),
                reason: e.reason ? String(e.reason) : undefined,
              },
            };
            observations.push(obs);
          }
        }
      } catch {
        // Malformed manifest — skip
      }
    }
  } catch {
    // Missing features directory — skip silently
  }
  return observations;
}

const LOGGER_LINE_KINDS: Record<string, string> = {
  "rectify-cycle": "rectify-cycle",
  escalation: "escalation",
  "pull-call": "pull-call",
  "pull-tool": "pull-call",
  "acceptance-verdict": "acceptance-verdict",
  "fix-cycle-iteration": "fix-cycle-iteration",
  "fix-cycle-exit": "fix-cycle-exit",
  "fix-cycle-validator-retry": "fix-cycle-validator-retry",
};

async function collectFromRunJsonl(context: CuratorPostRunContext): Promise<Observation[]> {
  if (!context.logFilePath) return [];
  const observations: Observation[] = [];
  try {
    const lines = await readJsonLines(context.logFilePath);
    for (const line of lines) {
      if (!line || typeof line !== "object") continue;
      const entry = line as Record<string, unknown>;
      const kind = String(entry.kind ?? entry.event ?? "");
      const mappedKind = LOGGER_LINE_KINDS[kind];
      if (!mappedKind) continue;
      const storyId = String(entry.storyId ?? "unknown");
      const featureId = String(entry.featureId ?? context.feature);
      const payload = (entry.payload ?? entry.data ?? {}) as Record<string, unknown>;
      const ts = String(entry.ts ?? entry.timestamp ?? now());

      if (mappedKind === "rectify-cycle") {
        const obs: RectifyCycleObservation = {
          schemaVersion: 1,
          runId: context.runId,
          featureId,
          storyId,
          stage: "rectify",
          ts,
          kind: "rectify-cycle",
          payload: {
            iteration: Number(payload.iteration ?? 0),
            status: (payload.status ?? "started") as "started" | "failed" | "passed",
          },
        };
        observations.push(obs);
      } else if (mappedKind === "escalation") {
        const obs: EscalationObservation = {
          schemaVersion: 1,
          runId: context.runId,
          featureId,
          storyId,
          stage: "escalation",
          ts,
          kind: "escalation",
          payload: {
            from: String(payload.from ?? ""),
            to: String(payload.to ?? ""),
          },
        };
        observations.push(obs);
      } else if (mappedKind === "pull-call") {
        const obs: PullCallObservation = {
          schemaVersion: 1,
          runId: context.runId,
          featureId,
          storyId,
          stage: "pull",
          ts,
          kind: "pull-call",
          payload: {
            toolName: String(payload.toolName ?? ""),
            status: (payload.status ?? "completed") as "started" | "completed" | "failed",
          },
        };
        observations.push(obs);
      } else if (mappedKind === "acceptance-verdict") {
        const obs: AcceptanceVerdictObservation = {
          schemaVersion: 1,
          runId: context.runId,
          featureId,
          storyId,
          stage: "acceptance",
          ts,
          kind: "acceptance-verdict",
          payload: {
            passed: Number(payload.passed ?? 0),
            failed: Number(payload.failed ?? 0),
          },
        };
        observations.push(obs);
      } else if (mappedKind === "fix-cycle-iteration") {
        const obs: FixCycleIterationObservation = {
          schemaVersion: 1,
          runId: context.runId,
          featureId,
          storyId,
          stage: "fix-cycle",
          ts,
          kind: "fix-cycle-iteration",
          payload: {
            iteration: Number(payload.iteration ?? 0),
            status: (payload.status ?? "started") as "started" | "passed" | "failed",
          },
        };
        observations.push(obs);
      } else if (mappedKind === "fix-cycle-exit") {
        const obs: FixCycleExitObservation = {
          schemaVersion: 1,
          runId: context.runId,
          featureId,
          storyId,
          stage: "fix-cycle",
          ts,
          kind: "fix-cycle-exit",
          payload: {
            reason: String(payload.reason ?? ""),
            finalStatus: String(payload.finalStatus ?? ""),
          },
        };
        observations.push(obs);
      } else if (mappedKind === "fix-cycle-validator-retry") {
        const obs: FixCycleValidatorRetryObservation = {
          schemaVersion: 1,
          runId: context.runId,
          featureId,
          storyId,
          stage: "fix-cycle",
          ts,
          kind: "fix-cycle-validator-retry",
          payload: {
            retryCount: Number(payload.retryCount ?? 0),
            reason: String(payload.reason ?? ""),
          },
        };
        observations.push(obs);
      }
    }
  } catch {
    // Missing or malformed log file — skip silently
  }
  return observations;
}

/**
 * Collect observations from run artifacts.
 *
 * Reads from:
 * - metrics.json in outputDir
 * - review-audit/<feature>/*.json in outputDir
 * - context manifests in workdir/.nax/features/<feature>/stories/<storyId>/
 * - active run JSONL when logFilePath is available
 *
 * Returns a list of schemaVersion=1 observations. Never throws — logs warnings
 * for missing sources or malformed data and continues.
 *
 * @param context - Extended post-run context with curator fields
 * @returns Array of observations
 */
export async function collectObservations(context: CuratorPostRunContext): Promise<Observation[]> {
  const [metricsObs, auditObs, manifestObs, jsonlObs] = await Promise.all([
    collectFromMetrics(context).catch(() => [] as Observation[]),
    collectFromReviewAudit(context).catch(() => [] as Observation[]),
    collectFromContextManifests(context).catch(() => [] as Observation[]),
    collectFromRunJsonl(context).catch(() => [] as Observation[]),
  ]);
  return [...metricsObs, ...auditObs, ...manifestObs, ...jsonlObs];
}
