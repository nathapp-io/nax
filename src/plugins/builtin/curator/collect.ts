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

type JsonRecord = Record<string, unknown>;

function now(): string {
  return new Date().toISOString();
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function boolValue(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
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
      // Skip malformed lines; curator must never fail the run.
    }
  }
  return lines;
}

function tokenCount(story: JsonRecord): number {
  const tokens = asRecord(story.tokens);
  if (!tokens) return 0;
  return numberValue(tokens.inputTokens) + numberValue(tokens.outputTokens);
}

async function collectFromMetrics(context: CuratorPostRunContext): Promise<Observation[]> {
  const observations: Observation[] = [];
  const metricsPath = path.join(context.outputDir, "metrics.json");
  try {
    const data = await readJsonFile(metricsPath);
    const runs = Array.isArray(data) ? data : [data];
    const currentRun = runs.map(asRecord).find((run) => run?.runId === context.runId) ?? runs.map(asRecord).at(-1);
    if (!currentRun) return observations;

    for (const rawStory of asArray(currentRun.stories)) {
      const story = asRecord(rawStory);
      if (!story) continue;
      const success = boolValue(story.success, false);
      const storyId = stringValue(story.storyId ?? story.id, "unknown");
      const obs: VerdictObservation = {
        schemaVersion: 1,
        runId: context.runId,
        featureId: stringValue(currentRun.feature, context.feature),
        storyId,
        stage: "verdict",
        ts: now(),
        kind: "verdict",
        payload: {
          status: success ? "completed" : "failed",
          success,
          attempts: numberValue(story.attempts, 0),
          cost: numberValue(story.cost, 0),
          tokens: tokenCount(story),
        },
      };
      observations.push(obs);
    }
  } catch {
    // Missing or malformed metrics.json — skip.
  }
  return observations;
}

function findingRuleId(finding: JsonRecord): string {
  return stringValue(finding.rule ?? finding.ruleId ?? finding.checkId ?? finding.category, "unknown");
}

async function collectFromReviewAudit(context: CuratorPostRunContext): Promise<Observation[]> {
  const observations: Observation[] = [];
  const auditDir = path.join(context.outputDir, "review-audit");
  try {
    const glob = new Bun.Glob("**/*.json");
    for await (const file of glob.scan({ cwd: auditDir, absolute: false })) {
      const fullPath = path.join(auditDir, file);
      try {
        const audit = asRecord(await readJsonFile(fullPath));
        if (!audit) continue;
        const result = asRecord(audit.result);
        const findings = asArray(result?.findings);
        const storyId = stringValue(audit.storyId, "unknown");
        const featureId = stringValue(audit.featureName ?? audit.featureId, context.feature);
        for (const rawFinding of findings) {
          const finding = asRecord(rawFinding);
          if (!finding) continue;
          const ruleId = findingRuleId(finding);
          const obs: ReviewFindingObservation = {
            schemaVersion: 1,
            runId: context.runId,
            featureId,
            storyId,
            stage: "review",
            ts: stringValue(audit.timestamp, now()),
            kind: "review-finding",
            payload: {
              ruleId,
              checkId: ruleId,
              severity: stringValue(finding.severity, "info"),
              file: stringValue(finding.file),
              line: numberValue(finding.line, 0),
              message: stringValue(finding.message),
            },
          };
          observations.push(obs);
        }
      } catch {
        // Malformed audit file — skip.
      }
    }
  } catch {
    // Missing review-audit directory — skip.
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
        const manifest = asRecord(await readJsonFile(fullPath));
        if (!manifest) continue;
        const ts = now();
        const chunkSummaries = asRecord(manifest.chunkSummaries) ?? {};

        for (const chunkId of asArray(manifest.includedChunks)) {
          const id = String(chunkId);
          const obs: ChunkIncludedObservation = {
            schemaVersion: 1,
            runId: context.runId,
            featureId,
            storyId,
            stage: stringValue(manifest.stage, "context"),
            ts,
            kind: "chunk-included",
            payload: {
              chunkId: id,
              label: stringValue(chunkSummaries[id], id),
              tokens: 0,
            },
          };
          observations.push(obs);
        }

        for (const rawExcluded of asArray(manifest.excludedChunks)) {
          const excluded = asRecord(rawExcluded);
          if (!excluded) continue;
          const id = stringValue(excluded.id, "unknown");
          const obs: ChunkExcludedObservation = {
            schemaVersion: 1,
            runId: context.runId,
            featureId,
            storyId,
            stage: stringValue(manifest.stage, "context"),
            ts,
            kind: "chunk-excluded",
            payload: {
              chunkId: id,
              label: stringValue(chunkSummaries[id], id),
              reason: optionalString(excluded.reason),
            },
          };
          observations.push(obs);
        }

        for (const rawProvider of asArray(manifest.providerResults)) {
          const provider = asRecord(rawProvider);
          if (!provider || stringValue(provider.status) !== "empty") continue;
          const obs: ProviderEmptyObservation = {
            schemaVersion: 1,
            runId: context.runId,
            featureId,
            storyId,
            stage: stringValue(manifest.stage, "context"),
            ts,
            kind: "provider-empty",
            payload: {
              provider: stringValue(provider.providerId, "unknown"),
              reason: "empty",
            },
          };
          observations.push(obs);
        }
      } catch {
        // Malformed manifest — skip.
      }
    }
  } catch {
    // Missing features directory — skip.
  }
  return observations;
}

function entryData(entry: JsonRecord): JsonRecord {
  return asRecord(entry.data) ?? asRecord(entry.payload) ?? {};
}

function entryStoryId(entry: JsonRecord, data: JsonRecord): string {
  return stringValue(entry.storyId ?? data.storyId, "unknown");
}

function entryFeatureId(context: CuratorPostRunContext, entry: JsonRecord, data: JsonRecord): string {
  return stringValue(entry.featureId ?? data.featureId ?? data.featureName, context.feature);
}

function collectPullCall(context: CuratorPostRunContext, entry: JsonRecord, data: JsonRecord): PullCallObservation {
  const toolName = stringValue(data.tool ?? data.toolName, "unknown");
  return {
    schemaVersion: 1,
    runId: context.runId,
    featureId: entryFeatureId(context, entry, data),
    storyId: entryStoryId(entry, data),
    stage: "pull",
    ts: stringValue(entry.timestamp ?? entry.ts, now()),
    kind: "pull-call",
    payload: {
      toolName,
      tool: toolName,
      keyword: data.keyword === null ? null : optionalString(data.keyword),
      resultCount: numberValue(data.resultCount, 0),
      resultBytes: numberValue(data.resultBytes, 0),
      status: "completed",
    },
  };
}

function collectAcceptanceVerdict(
  context: CuratorPostRunContext,
  entry: JsonRecord,
  data: JsonRecord,
): AcceptanceVerdictObservation {
  return {
    schemaVersion: 1,
    runId: context.runId,
    featureId: entryFeatureId(context, entry, data),
    storyId: entryStoryId(entry, data),
    stage: "acceptance",
    ts: stringValue(entry.timestamp ?? entry.ts, now()),
    kind: "acceptance-verdict",
    payload: {
      passed: boolValue(data.passed, false),
      failedACs: asArray(data.failedACs).map(String),
      retries: numberValue(data.retries, 0),
      packageDir: optionalString(data.packageDir),
      durationMs: numberValue(data.durationMs, 0),
    },
  };
}

function collectRectify(context: CuratorPostRunContext, entry: JsonRecord, data: JsonRecord): RectifyCycleObservation {
  return {
    schemaVersion: 1,
    runId: context.runId,
    featureId: entryFeatureId(context, entry, data),
    storyId: entryStoryId(entry, data),
    stage: "rectify",
    ts: stringValue(entry.timestamp ?? entry.ts, now()),
    kind: "rectify-cycle",
    payload: {
      iteration: numberValue(data.attempt ?? data.rectifyAttempt ?? data.iteration, 1),
      status: stringValue(data.status, "started") as "started" | "failed" | "passed",
    },
  };
}

function collectEscalation(context: CuratorPostRunContext, entry: JsonRecord, data: JsonRecord): EscalationObservation {
  return {
    schemaVersion: 1,
    runId: context.runId,
    featureId: entryFeatureId(context, entry, data),
    storyId: entryStoryId(entry, data),
    stage: "escalation",
    ts: stringValue(entry.timestamp ?? entry.ts, now()),
    kind: "escalation",
    payload: {
      from: stringValue(data.fromTier ?? data.from ?? data.currentTier),
      to: stringValue(data.toTier ?? data.to ?? data.nextTier),
    },
  };
}

function collectFixCycleIteration(
  context: CuratorPostRunContext,
  entry: JsonRecord,
  data: JsonRecord,
): FixCycleIterationObservation {
  const outcome = optionalString(data.outcome) as FixCycleIterationObservation["payload"]["outcome"];
  return {
    schemaVersion: 1,
    runId: context.runId,
    featureId: entryFeatureId(context, entry, data),
    storyId: entryStoryId(entry, data),
    stage: "fix-cycle",
    ts: stringValue(entry.timestamp ?? entry.ts, now()),
    kind: "fix-cycle-iteration",
    payload: {
      iteration: numberValue(data.iterationNum ?? data.iteration, 0),
      iterationNum: numberValue(data.iterationNum ?? data.iteration, 0),
      status: outcome === "resolved" ? "passed" : "failed",
      outcome,
      findingsBefore: numberValue(data.findingsBefore, 0),
      findingsAfter: numberValue(data.findingsAfter, 0),
      costUsd: numberValue(data.costUsd, 0),
    },
  };
}

function collectFixCycleExit(
  context: CuratorPostRunContext,
  entry: JsonRecord,
  data: JsonRecord,
): FixCycleExitObservation {
  return {
    schemaVersion: 1,
    runId: context.runId,
    featureId: entryFeatureId(context, entry, data),
    storyId: entryStoryId(entry, data),
    stage: "fix-cycle",
    ts: stringValue(entry.timestamp ?? entry.ts, now()),
    kind: "fix-cycle-exit",
    payload: {
      reason: stringValue(data.reason, ""),
      finalStatus: stringValue(data.finalStatus ?? data.exitReason, ""),
    },
  };
}

function collectFixCycleRetry(
  context: CuratorPostRunContext,
  entry: JsonRecord,
  data: JsonRecord,
): FixCycleValidatorRetryObservation {
  return {
    schemaVersion: 1,
    runId: context.runId,
    featureId: entryFeatureId(context, entry, data),
    storyId: entryStoryId(entry, data),
    stage: "fix-cycle",
    ts: stringValue(entry.timestamp ?? entry.ts, now()),
    kind: "fix-cycle-validator-retry",
    payload: {
      retryCount: numberValue(data.retryCount ?? data.attempt, 0),
      reason: stringValue(data.reason ?? data.error, ""),
    },
  };
}

async function collectFromRunJsonl(context: CuratorPostRunContext): Promise<Observation[]> {
  if (!context.logFilePath) return [];
  const observations: Observation[] = [];
  try {
    const lines = await readJsonLines(context.logFilePath);
    for (const rawLine of lines) {
      const entry = asRecord(rawLine);
      if (!entry) continue;
      const data = entryData(entry);
      const stage = stringValue(entry.stage);
      const message = stringValue(entry.message);

      if (stage === "pull-tool" && message === "invoked") {
        observations.push(collectPullCall(context, entry, data));
      } else if (stage === "acceptance" && message === "verdict") {
        observations.push(collectAcceptanceVerdict(context, entry, data));
      } else if (stage === "rectify" && message === "Starting rectification loop") {
        observations.push(collectRectify(context, entry, data));
      } else if (stage === "escalation" && message.includes("Escalating")) {
        observations.push(collectEscalation(context, entry, data));
      } else if (stage === "findings.cycle" && message === "iteration completed") {
        observations.push(collectFixCycleIteration(context, entry, data));
      } else if (stage === "findings.cycle" && message.startsWith("cycle exited")) {
        observations.push(collectFixCycleExit(context, entry, data));
      } else if (stage === "findings.cycle" && message === "validator retry") {
        observations.push(collectFixCycleRetry(context, entry, data));
      }
    }
  } catch {
    // Missing or malformed log file — skip.
  }
  return observations;
}

/**
 * Collect observations from run artifacts. Never throws.
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
