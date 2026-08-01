/**
 * Curator Heuristics — Phase 2
 *
 * Six deterministic heuristics that convert observations into proposals.
 * Each heuristic is a pure function that groups observations and generates proposals.
 */

import { fingerprintFor } from "../../../review";
import type {
  ChunkExcludedObservation,
  EscalationObservation,
  FixCycleIterationObservation,
  Observation,
  PullCallObservation,
  RectifyCycleObservation,
  ReviewFindingObservation,
} from "./types";

/** Curator threshold configuration */
export interface CuratorThresholds {
  repeatedFinding: number;
  emptyKeyword: number;
  rectifyAttempts: number;
  escalationChain: number;
  staleChunkRuns: number;
  unchangedOutcome: number;
}

/** Proposal target file and action */
export interface ProposalTarget {
  canonicalFile: string;
  action: "add" | "drop" | "advisory";
}

/** Curator proposal output */
export interface Proposal {
  id: "H1" | "H2" | "H3" | "H4" | "H5" | "H6";
  severity: "LOW" | "MED" | "HIGH";
  target: ProposalTarget;
  description: string;
  evidence: string;
  sourceKinds: Observation["kind"][];
  storyIds: string[];
}

const DEFAULT_THRESHOLDS: CuratorThresholds = {
  repeatedFinding: 2,
  emptyKeyword: 2,
  rectifyAttempts: 2,
  escalationChain: 2,
  staleChunkRuns: 2,
  unchangedOutcome: 2,
};

function mergeThresholds(thresholds: CuratorThresholds): CuratorThresholds {
  return {
    repeatedFinding: thresholds.repeatedFinding ?? DEFAULT_THRESHOLDS.repeatedFinding,
    emptyKeyword: thresholds.emptyKeyword ?? DEFAULT_THRESHOLDS.emptyKeyword,
    rectifyAttempts: thresholds.rectifyAttempts ?? DEFAULT_THRESHOLDS.rectifyAttempts,
    escalationChain: thresholds.escalationChain ?? DEFAULT_THRESHOLDS.escalationChain,
    staleChunkRuns: thresholds.staleChunkRuns ?? DEFAULT_THRESHOLDS.staleChunkRuns,
    unchangedOutcome: thresholds.unchangedOutcome ?? DEFAULT_THRESHOLDS.unchangedOutcome,
  };
}

function uniqueStoryIds(storyIds: string[]): string[] {
  return [...new Set(storyIds)];
}

/** Feature spread at which a recurring finding is worth flagging as HIGH. */
const HIGH_SEVERITY_FEATURE_SPREAD = 5;

type H1Group = {
  featureIds: Set<string>;
  storyIds: Set<string>;
  samples: string[];
  locus?: { file: string; category?: string };
};

function firstLine(message: string): string {
  return message.split("\n")[0] ?? message;
}

/** H1: Repeated review finding — same ruleId appearing across stories */
function h1RepeatedReviewFinding(observations: Observation[], threshold: number): Proposal[] {
  const findings = observations.filter((o): o is ReviewFindingObservation => o.kind === "review-finding");

  const groups = new Map<string, H1Group>();
  for (const obs of findings) {
    // A finding with no locus (no file AND no category) describes nothing a rule
    // could constrain — carry-forward bookkeeping and free-text notes land here.
    const { file, category, message } = obs.payload;
    if (!file && !category) continue;

    const key = fingerprintFor(file, category, message);
    const group = groups.get(key) ?? { featureIds: new Set<string>(), storyIds: new Set<string>(), samples: [] };
    group.featureIds.add(obs.featureId);
    group.storyIds.add(obs.storyId);
    group.locus = group.locus ?? { file, category };
    const sample = firstLine(message);
    if (sample && group.samples.length < 2 && !group.samples.includes(sample)) group.samples.push(sample);
    groups.set(key, group);
  }

  const proposals: Proposal[] = [];
  for (const group of groups.values()) {
    // Threshold is on DISTINCT FEATURES, not raw occurrences (#1422). One feature
    // repeating a defect is a story problem; the same defect crossing features is
    // what a project rule exists to prevent.
    const featureCount = group.featureIds.size;
    if (featureCount < threshold) continue;
    const features = [...group.featureIds];
    const stories = [...group.storyIds];
    const locus = group.locus?.category
      ? `${group.locus.category}${group.locus.file ? ` in ${group.locus.file}` : ""}`
      : (group.locus?.file ?? "review finding");
    const sampleSection = group.samples.length > 0 ? `\n  Examples: ${group.samples.join(" | ")}` : "";
    proposals.push({
      id: "H1",
      severity: featureCount >= HIGH_SEVERITY_FEATURE_SPREAD ? "HIGH" : "MED",
      target: { canonicalFile: ".nax/rules/curator-suggestions.md", action: "add" },
      description: `Recurring review finding (${locus}) — hit ${featureCount} features`,
      evidence: `Seen in ${featureCount} features: ${features.join(", ")} (stories: ${stories.join(", ")})${sampleSection}`,
      sourceKinds: ["review-finding"],
      storyIds: stories,
    });
  }
  return proposals;
}

/** H2: Pull-tool empty result — same keyword returns zero results repeatedly */
function h2PullToolEmptyResult(observations: Observation[], threshold: number): Proposal[] {
  const pulls = observations.filter(
    (o): o is PullCallObservation =>
      o.kind === "pull-call" &&
      o.payload.resultCount === 0 &&
      typeof o.payload.keyword === "string" &&
      o.payload.keyword.length > 0,
  );

  const byKeyword = new Map<string, { storyIds: string[]; featureId: string }>();
  for (const obs of pulls) {
    const keyword = obs.payload.keyword as string;
    const existing = byKeyword.get(keyword);
    if (existing) {
      existing.storyIds.push(obs.storyId);
    } else {
      byKeyword.set(keyword, { storyIds: [obs.storyId], featureId: obs.featureId });
    }
  }

  const proposals: Proposal[] = [];
  for (const [keyword, data] of byKeyword.entries()) {
    if (data.storyIds.length < threshold) continue;
    const count = data.storyIds.length;
    const unique = uniqueStoryIds(data.storyIds);
    proposals.push({
      id: "H2",
      severity: "MED",
      target: { canonicalFile: `.nax/features/${data.featureId}/context.md`, action: "add" },
      description: `Pull-tool keyword returned empty: \"${keyword}\" returned zero results ${count}x`,
      evidence: `Keyword \"${keyword}\" returned zero results ${count}× in stories: ${unique.join(", ")}`,
      sourceKinds: ["pull-call"],
      storyIds: unique,
    });
  }
  return proposals;
}

/** H3: Repeated rectification cycle — same story has many rectify attempts */
function h3RepeatedRectification(observations: Observation[], threshold: number): Proposal[] {
  const cycles = observations.filter((o): o is RectifyCycleObservation => o.kind === "rectify-cycle");

  const byStory = new Map<string, { count: number; featureId: string }>();
  for (const obs of cycles) {
    const existing = byStory.get(obs.storyId);
    if (existing) {
      existing.count++;
    } else {
      byStory.set(obs.storyId, { count: 1, featureId: obs.featureId });
    }
  }

  const proposals: Proposal[] = [];
  for (const [storyId, data] of byStory.entries()) {
    if (data.count < threshold) continue;
    proposals.push({
      id: "H3",
      severity: "HIGH",
      target: { canonicalFile: `.nax/features/${data.featureId}/context.md`, action: "add" },
      description: `Repeated rectification cycle: story ${storyId} required ${data.count} rectify attempts`,
      evidence: `Story ${storyId} triggered ${data.count} rectify cycles`,
      sourceKinds: ["rectify-cycle"],
      storyIds: [storyId],
    });
  }
  return proposals;
}

/** H4: Escalation chain — same from→to tier escalation appears repeatedly */
function h4EscalationChain(observations: Observation[], threshold: number): Proposal[] {
  const escalations = observations.filter((o): o is EscalationObservation => o.kind === "escalation");

  const byPath = new Map<string, { storyIds: string[]; featureId: string }>();
  for (const obs of escalations) {
    const key = `${obs.payload.from}->${obs.payload.to}`;
    const existing = byPath.get(key);
    if (existing) {
      existing.storyIds.push(obs.storyId);
    } else {
      byPath.set(key, { storyIds: [obs.storyId], featureId: obs.featureId });
    }
  }

  const proposals: Proposal[] = [];
  for (const [escalationPath, data] of byPath.entries()) {
    if (data.storyIds.length < threshold) continue;
    const count = data.storyIds.length;
    const unique = uniqueStoryIds(data.storyIds);
    proposals.push({
      id: "H4",
      severity: "MED",
      target: { canonicalFile: `.nax/features/${data.featureId}/context.md`, action: "add" },
      description: `Escalation chain: ${escalationPath} occurred ${count}x`,
      evidence: `Escalation ${escalationPath} triggered ${count}× in stories: ${unique.join(", ")}`,
      sourceKinds: ["escalation"],
      storyIds: unique,
    });
  }
  return proposals;
}

/** H5: Stale chunk excluded — same chunk excluded with reason=stale across runs */
function h5StaleChunk(observations: Observation[], threshold: number): Proposal[] {
  const excluded = observations.filter(
    (o): o is ChunkExcludedObservation => o.kind === "chunk-excluded" && o.payload.reason === "stale",
  );

  const byChunk = new Map<string, { runIds: Set<string>; storyIds: string[]; label: string }>();
  for (const obs of excluded) {
    const chunkId = obs.payload.chunkId;
    const existing = byChunk.get(chunkId);
    if (existing) {
      existing.runIds.add(obs.runId);
      existing.storyIds.push(obs.storyId);
    } else {
      byChunk.set(chunkId, { runIds: new Set([obs.runId]), storyIds: [obs.storyId], label: obs.payload.label });
    }
  }

  const proposals: Proposal[] = [];
  for (const [chunkId, data] of byChunk.entries()) {
    if (data.runIds.size < threshold) continue;
    const unique = uniqueStoryIds(data.storyIds);
    proposals.push({
      id: "H5",
      severity: "LOW",
      target: { canonicalFile: ".nax/rules/curator-suggestions.md", action: "drop" },
      description: `Stale chunk: ${chunkId} (${data.label}) excluded as stale in ${data.runIds.size} runs`,
      evidence: `Chunk ${chunkId} marked stale across ${data.runIds.size} runs in stories: ${unique.join(", ")}`,
      sourceKinds: ["chunk-excluded"],
      storyIds: unique,
    });
  }
  return proposals;
}

/** H6: Fix-cycle unchanged outcome — same story has repeated unchanged outcomes */
function h6FixCycleUnchanged(observations: Observation[], threshold: number): Proposal[] {
  const iterations = observations.filter((o): o is FixCycleIterationObservation => o.kind === "fix-cycle-iteration");

  const byStory = new Map<string, FixCycleIterationObservation[]>();
  for (const obs of iterations) {
    const existing = byStory.get(obs.storyId);
    if (existing) {
      existing.push(obs);
    } else {
      byStory.set(obs.storyId, [obs]);
    }
  }

  const proposals: Proposal[] = [];
  for (const [storyId, storyIterations] of byStory.entries()) {
    const ordered = [...storyIterations].sort(
      (a, b) => (a.payload.iterationNum ?? a.payload.iteration) - (b.payload.iterationNum ?? b.payload.iteration),
    );
    let currentStreak = 0;
    let maxStreak = 0;
    for (const iteration of ordered) {
      if (iteration.payload.outcome === "unchanged") {
        currentStreak += 1;
        maxStreak = Math.max(maxStreak, currentStreak);
      } else {
        currentStreak = 0;
      }
    }
    if (maxStreak < threshold) continue;
    proposals.push({
      id: "H6",
      severity: "LOW",
      target: { canonicalFile: ".nax/rules/curator-suggestions.md", action: "advisory" },
      description: `Fix-cycle unchanged: story ${storyId} had ${maxStreak} consecutive unchanged outcomes`,
      evidence: `Story ${storyId} had ${maxStreak} consecutive fix-cycle iterations with outcome=unchanged`,
      sourceKinds: ["fix-cycle-iteration"],
      storyIds: [storyId],
    });
  }
  return proposals;
}

/**
 * Run all heuristics on observations.
 *
 * @param observations - Array of observations from a run
 * @param thresholds - Configuration thresholds for heuristics
 * @returns Array of proposals
 */
export function runHeuristics(observations: Observation[], thresholds: CuratorThresholds): Proposal[] {
  const t = mergeThresholds(thresholds);
  return [
    ...h1RepeatedReviewFinding(observations, t.repeatedFinding),
    ...h2PullToolEmptyResult(observations, t.emptyKeyword),
    ...h3RepeatedRectification(observations, t.rectifyAttempts),
    ...h4EscalationChain(observations, t.escalationChain),
    ...h5StaleChunk(observations, t.staleChunkRuns),
    ...h6FixCycleUnchanged(observations, t.unchangedOutcome),
  ];
}
