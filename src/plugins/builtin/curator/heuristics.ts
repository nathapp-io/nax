/**
 * Curator Heuristics — Phase 2
 *
 * Six deterministic heuristics that convert observations into proposals.
 * Each heuristic is a pure function that groups observations and generates proposals.
 */

import { PROJECT_FEATURES_DIR } from "@/config";
import { normalizeIssueText } from "@/review";
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

/** Feature spread, as a multiple of the configured threshold, at which a proposal is HIGH. */
const HIGH_SEVERITY_MULTIPLE = 2;
/** Characters of the leading sample kept in the checkbox-line description. */
const DESCRIPTION_GIST_CHARS = 90;
/** Files listed in evidence before truncating. */
const MAX_EVIDENCE_FILES = 4;

/**
 * Characters of normalized message text that identify a defect across features.
 *
 * Shorter than `normalizeIssueText`'s own 160-char clamp, and deliberately so:
 * that clamp identifies one finding across successive rounds of ONE story, where
 * the reviewer is describing the same file and the wording barely moves. Across
 * features the wording diverges much faster — different files, symbols and
 * quoted snippets — so a 160-char key would put every occurrence in its own
 * group and H1 could never reach its feature threshold.
 *
 * The cost is the mirror image: two genuinely distinct defects that share a
 * category AND the first 48 normalized characters merge into one proposal. That
 * is accepted. Reviewer messages lead with the generic description and trail
 * into the specifics, so a shared 48-char lead is itself decent evidence the two
 * are the same class of defect — which is the granularity a *rule* proposal
 * wants. Do NOT "fix" this by mixing a hash of the full message into the key:
 * that makes identity exact-match, and exact cross-feature message equality
 * essentially never happens, which silently disables the heuristic.
 */
const CROSS_FEATURE_MESSAGE_PREFIX = 48;

/**
 * Identity of a defect ACROSS features (#1422).
 *
 * Deliberately NOT `fingerprintFor` from recurrence-demotion: that key leads with
 * the file path, which is correct for its own job (same story, successive rounds,
 * where the file is stable) and exactly wrong here. Different features touch
 * different files by definition, so a file-led key can only ever group the
 * same-file case — meaning H1 would stay silent on "test-gap recurs across the
 * project", the signal it exists to surface. The file is evidence, not identity.
 */
function crossFeatureKey(category: string | undefined, message: string): string {
  return `${category ?? ""}|${normalizeIssueText(message).slice(0, CROSS_FEATURE_MESSAGE_PREFIX)}`;
}

type H1Group = {
  featureIds: Set<string>;
  /** `featureId/storyId` pairs — story IDs alone collide across features. */
  sites: Set<string>;
  files: Set<string>;
  samples: string[];
  category?: string;
};

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

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

    const key = crossFeatureKey(category, message);
    let group = groups.get(key);
    if (!group) {
      group = { featureIds: new Set<string>(), sites: new Set<string>(), files: new Set<string>(), samples: [] };
      groups.set(key, group);
      group.category = category;
    }
    group.featureIds.add(obs.featureId);
    // Story IDs are feature-scoped (`US-001` exists in every feature), so the
    // pair is the only unambiguous site reference.
    group.sites.add(`${obs.featureId}/${obs.storyId}`);
    if (file) group.files.add(file);
    const sample = firstLine(message);
    if (sample && group.samples.length < 2 && !group.samples.includes(sample)) group.samples.push(sample);
  }

  const proposals: Proposal[] = [];
  for (const group of groups.values()) {
    // Threshold is on DISTINCT FEATURES, not raw occurrences (#1422). One feature
    // repeating a defect is a story problem; the same defect crossing features is
    // what a project rule exists to prevent.
    const featureCount = group.featureIds.size;
    if (featureCount < threshold) continue;
    const features = [...group.featureIds];
    const sites = [...group.sites];
    const files = [...group.files];
    // The description must distinguish one proposal from another on the checkbox
    // line alone — `nax curator commit` ticks are made against that line, and a
    // bare category collapse is the #942 defect this must not reintroduce.
    const gist = group.samples[0] ? truncate(group.samples[0], DESCRIPTION_GIST_CHARS) : "(no description)";
    const categoryLabel = group.category ? `${group.category}: ` : "";
    const fileSection = files.length > 0 ? ` Files: ${files.slice(0, MAX_EVIDENCE_FILES).join(", ")}.` : "";
    const sampleSection = group.samples.length > 0 ? `\n  Examples: ${group.samples.join(" | ")}` : "";
    proposals.push({
      id: "H1",
      // Relative to the configured threshold: a fixed constant would pin every
      // proposal to HIGH once the threshold is raised past it.
      severity: featureCount >= threshold * HIGH_SEVERITY_MULTIPLE ? "HIGH" : "MED",
      target: { canonicalFile: ".nax/rules/curator-suggestions.md", action: "add" },
      description: `Recurring across ${featureCount} features — ${categoryLabel}${gist}`,
      evidence: `Seen in ${featureCount} features: ${features.join(", ")} (sites: ${sites.join(", ")}).${fileSection}${sampleSection}`,
      sourceKinds: ["review-finding"],
      storyIds: sites,
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

  // Sites are featureId/storyId composites, not bare story IDs — story IDs are
  // feature-scoped, so two features' unrelated "US-001" would otherwise dedupe
  // into one displayed site and understate how widely this empty-keyword pattern
  // actually recurs (BUG-48; same fix as H1/H4's `sites`).
  const byKeyword = new Map<string, { sites: string[]; featureId: string }>();
  for (const obs of pulls) {
    const keyword = obs.payload.keyword as string;
    const site = `${obs.featureId}/${obs.storyId}`;
    const existing = byKeyword.get(keyword);
    if (existing) {
      existing.sites.push(site);
    } else {
      byKeyword.set(keyword, { sites: [site], featureId: obs.featureId });
    }
  }

  const proposals: Proposal[] = [];
  for (const [keyword, data] of byKeyword.entries()) {
    if (data.sites.length < threshold) continue;
    const count = data.sites.length;
    const unique = uniqueStoryIds(data.sites);
    proposals.push({
      id: "H2",
      severity: "MED",
      target: { canonicalFile: `${PROJECT_FEATURES_DIR}/${data.featureId}/context.md`, action: "add" },
      description: `Pull-tool keyword returned empty: "${keyword}" returned zero results ${count}x`,
      evidence: `Keyword "${keyword}" returned zero results ${count}× in stories: ${unique.join(", ")}`,
      sourceKinds: ["pull-call"],
      storyIds: unique,
    });
  }
  return proposals;
}

/** H3: Repeated rectification cycle — same story has many rectify attempts */
function h3RepeatedRectification(observations: Observation[], threshold: number): Proposal[] {
  const cycles = observations.filter((o): o is RectifyCycleObservation => o.kind === "rectify-cycle");

  // Keyed by featureId/storyId — story IDs are feature-scoped ("US-001" exists in
  // every feature), so grouping by the bare storyId merges unrelated features'
  // rectify counts into one fabricated recurrence (BUG-48; see H1's crossFeatureKey
  // comment for the same issue).
  const byStory = new Map<string, { count: number; featureId: string; storyId: string }>();
  for (const obs of cycles) {
    const key = `${obs.featureId}/${obs.storyId}`;
    const existing = byStory.get(key);
    if (existing) {
      existing.count++;
    } else {
      byStory.set(key, { count: 1, featureId: obs.featureId, storyId: obs.storyId });
    }
  }

  const proposals: Proposal[] = [];
  for (const { count, featureId, storyId } of byStory.values()) {
    if (count < threshold) continue;
    proposals.push({
      id: "H3",
      severity: "HIGH",
      target: { canonicalFile: `${PROJECT_FEATURES_DIR}/${featureId}/context.md`, action: "add" },
      description: `Repeated rectification cycle: story ${storyId} required ${count} rectify attempts`,
      evidence: `Story ${storyId} triggered ${count} rectify cycles`,
      sourceKinds: ["rectify-cycle"],
      storyIds: [storyId],
    });
  }
  return proposals;
}

/** H4: Escalation chain — same from→to tier escalation appears repeatedly */
function h4EscalationChain(observations: Observation[], threshold: number): Proposal[] {
  const escalations = observations.filter((o): o is EscalationObservation => o.kind === "escalation");

  // Sites are featureId/storyId composites, not bare story IDs — story IDs are
  // feature-scoped, so two features' unrelated "US-001" would otherwise dedupe
  // into one displayed site and understate how widely this escalation path
  // actually recurs (BUG-48; same fix as H1's `sites`).
  const byPath = new Map<string, { sites: string[]; featureId: string }>();
  for (const obs of escalations) {
    const key = `${obs.payload.from}->${obs.payload.to}`;
    const site = `${obs.featureId}/${obs.storyId}`;
    const existing = byPath.get(key);
    if (existing) {
      existing.sites.push(site);
    } else {
      byPath.set(key, { sites: [site], featureId: obs.featureId });
    }
  }

  const proposals: Proposal[] = [];
  for (const [escalationPath, data] of byPath.entries()) {
    if (data.sites.length < threshold) continue;
    const count = data.sites.length;
    const unique = uniqueStoryIds(data.sites);
    proposals.push({
      id: "H4",
      severity: "MED",
      target: { canonicalFile: `${PROJECT_FEATURES_DIR}/${data.featureId}/context.md`, action: "add" },
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

  // Keyed by featureId/storyId (BUG-48) — grouping by the bare storyId here is the
  // most severe instance of this bug: it doesn't just inflate a count, it interleaves
  // two unrelated features' iterations (whose iterationNum both restart from 1) into
  // one fabricated streak.
  const byStory = new Map<string, FixCycleIterationObservation[]>();
  for (const obs of iterations) {
    const key = `${obs.featureId}/${obs.storyId}`;
    const existing = byStory.get(key);
    if (existing) {
      existing.push(obs);
    } else {
      byStory.set(key, [obs]);
    }
  }

  const proposals: Proposal[] = [];
  for (const storyIterations of byStory.values()) {
    const storyId = storyIterations[0].storyId;
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
