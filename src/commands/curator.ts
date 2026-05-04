/**
 * Curator CLI Commands
 *
 * Provides `nax curator status`, `commit`, `dryrun`, and `gc` subcommands
 * for inspecting, accepting, re-running, and managing curator proposals.
 */

import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { NaxConfig } from "../config";
import { loadConfig } from "../config";
import type { CuratorThresholds } from "../plugins/builtin/curator/heuristics";
import { runHeuristics } from "../plugins/builtin/curator/heuristics";
import { renderProposals } from "../plugins/builtin/curator/render";
import type { Observation } from "../plugins/builtin/curator/types";
import { curatorRollupPath, globalOutputDir, projectOutputDir } from "../runtime/paths";
import type { ResolveProjectOptions, ResolvedProject } from "./common";
import { resolveProject } from "./common";

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface CuratorStatusOptions {
  project?: string;
  run?: string;
}

export interface CuratorCommitOptions {
  project?: string;
  runId: string;
}

export interface CuratorDryrunOptions {
  project?: string;
  run?: string;
}

export interface CuratorGcOptions {
  project?: string;
  keep?: number;
}

// ─── Injectable deps ──────────────────────────────────────────────────────────

export const _curatorCmdDeps = {
  resolveProject: (opts?: ResolveProjectOptions): ResolvedProject => resolveProject(opts),
  loadConfig: (dir?: string): Promise<NaxConfig> => loadConfig(dir),
  projectOutputDir: (key: string, override?: string): string => projectOutputDir(key, override),
  globalOutputDir: (): string => globalOutputDir(),
  curatorRollupPath: (gDir: string, override?: string): string => curatorRollupPath(gDir, override),
  readFile: async (p: string): Promise<string> => Bun.file(p).text(),
  writeFile: async (p: string, content: string): Promise<void> => {
    await Bun.write(p, content);
  },
  appendFile: async (p: string, content: string): Promise<void> => {
    const existing = Bun.file(p);
    const prev = (await existing.exists()) ? await existing.text() : "";
    await Bun.write(p, prev + content);
  },
  openInEditor: async (filePath: string): Promise<void> => {
    const editor = process.env.EDITOR ?? process.env.VISUAL ?? "vi";
    const proc = Bun.spawnSync([editor, filePath], { stdio: ["inherit", "inherit", "inherit"] });
    if (proc.exitCode !== 0) {
      console.log(`[WARN] Editor exited with code ${proc.exitCode}`);
    }
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getProjectKey(config: NaxConfig, projectDir: string): string {
  return config.name?.trim() || basename(projectDir);
}

function listRunIds(runsDir: string): string[] {
  try {
    return readdirSync(runsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

async function parseObservations(observationsPath: string): Promise<Observation[]> {
  const text = await _curatorCmdDeps.readFile(observationsPath).catch(() => "");
  if (!text.trim()) return [];
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Observation);
}

function getThresholds(config: NaxConfig): CuratorThresholds {
  const t = config.curator?.thresholds;
  return {
    repeatedFinding: t?.repeatedFinding ?? 3,
    emptyKeyword: t?.emptyKeyword ?? 2,
    rectifyAttempts: t?.rectifyAttempts ?? 3,
    escalationChain: t?.escalationChain ?? 2,
    staleChunkRuns: t?.staleChunkRuns ?? 5,
    unchangedOutcome: t?.unchangedOutcome ?? 2,
  };
}

// ─── Proposal parsing for curatorCommit ──────────────────────────────────────

interface ParsedProposal {
  action: "add" | "drop" | "advisory";
  canonicalFile: string;
  description: string;
  evidence: string;
}

function parseCheckedProposals(markdown: string): ParsedProposal[] {
  const lines = markdown.split("\n");
  const proposals: ParsedProposal[] = [];

  let currentAction: "add" | "drop" | "advisory" | null = null;
  let currentFile: string | null = null;
  let pendingProposal: ParsedProposal | null = null;

  for (const line of lines) {
    // Detect action section: ## add —, ## drop —, ## advisory —
    const actionMatch = line.match(/^##\s+(add|drop|advisory)\s+—/i);
    if (actionMatch) {
      if (pendingProposal) proposals.push(pendingProposal);
      pendingProposal = null;
      currentAction = actionMatch[1].toLowerCase() as "add" | "drop" | "advisory";
      currentFile = null;
      continue;
    }

    // Detect target file section: ### <path>
    if (line.startsWith("### ") && currentAction !== null) {
      if (pendingProposal) proposals.push(pendingProposal);
      pendingProposal = null;
      currentFile = line.slice(4).trim();
      continue;
    }

    // Checked proposal line: - [x] ...
    if (line.match(/^-\s+\[x\]/i) && currentAction !== null && currentFile !== null) {
      if (pendingProposal) proposals.push(pendingProposal);
      pendingProposal = {
        action: currentAction,
        canonicalFile: currentFile,
        description: line.replace(/^-\s+\[x\]\s*/i, "").trim(),
        evidence: "",
      };
      continue;
    }

    // Skip unchecked lines: - [ ] ...
    if (line.match(/^-\s+\[\s\]/)) {
      if (pendingProposal) proposals.push(pendingProposal);
      pendingProposal = null;
      continue;
    }

    // Evidence continuation for current proposal
    if (pendingProposal && line.match(/^\s+_Evidence:/)) {
      pendingProposal.evidence = line
        .replace(/^\s+_Evidence:\s*/i, "")
        .replace(/_$/, "")
        .trim();
    }
  }

  if (pendingProposal) proposals.push(pendingProposal);
  return proposals;
}

// ─── curatorStatus ────────────────────────────────────────────────────────────

export async function curatorStatus(options: CuratorStatusOptions): Promise<void> {
  const resolved = _curatorCmdDeps.resolveProject({ dir: options.project });
  const config = await _curatorCmdDeps.loadConfig(resolved.projectDir);
  const projectKey = getProjectKey(config, resolved.projectDir);
  const outputDir = _curatorCmdDeps.projectOutputDir(projectKey, config.outputDir as string | undefined);
  const runsDir = join(outputDir, "runs");

  const runIds = listRunIds(runsDir);

  let runId: string;
  if (options.run) {
    if (!runIds.includes(options.run)) {
      console.log(`Run ${options.run} not found in ${runsDir}.`);
      return;
    }
    runId = options.run;
  } else {
    if (runIds.length === 0) {
      console.log("No runs found.");
      return;
    }
    runId = runIds[runIds.length - 1];
  }

  console.log(`Run: ${runId}`);

  const runDir = join(runsDir, runId);
  const observationsPath = join(runDir, "observations.jsonl");
  const observations = await parseObservations(observationsPath);

  // Count by kind
  const counts = new Map<string, number>();
  for (const obs of observations) {
    counts.set(obs.kind, (counts.get(obs.kind) ?? 0) + 1);
  }

  console.log(`Observations: ${observations.length} total`);
  for (const [kind, count] of counts.entries()) {
    console.log(`  ${kind}: ${count}`);
  }

  // Print proposal markdown if present
  const proposalsPath = join(runDir, "curator-proposals.md");
  const proposalText = await _curatorCmdDeps.readFile(proposalsPath).catch(() => null);
  if (proposalText !== null) {
    console.log("");
    console.log(proposalText);
  } else {
    console.log("No proposals file found for this run.");
  }
}

// ─── curatorCommit ────────────────────────────────────────────────────────────

export async function curatorCommit(options: CuratorCommitOptions): Promise<void> {
  const resolved = _curatorCmdDeps.resolveProject({ dir: options.project });
  const config = await _curatorCmdDeps.loadConfig(resolved.projectDir);
  const projectKey = getProjectKey(config, resolved.projectDir);
  const outputDir = _curatorCmdDeps.projectOutputDir(projectKey, config.outputDir as string | undefined);
  const runDir = join(outputDir, "runs", options.runId);
  const proposalsPath = join(runDir, "curator-proposals.md");

  const proposalText = await _curatorCmdDeps.readFile(proposalsPath).catch(() => null);
  if (proposalText === null) {
    console.log(`curator-proposals.md not found for run ${options.runId}.`);
    return;
  }

  const proposals = parseCheckedProposals(proposalText);

  if (proposals.length === 0) {
    console.log("No proposals selected. Nothing to apply.");
    return;
  }

  const modifiedFiles = new Set<string>();

  // Validate all drops before any writes: key token must exist, no overlapping ranges
  const drops = proposals.filter((p) => p.action === "drop");
  const dropFileState = new Map<string, { existing: string; usedLines: Set<number> }>();

  for (const drop of drops) {
    const targetPath = join(resolved.projectDir, drop.canonicalFile);

    if (!dropFileState.has(targetPath)) {
      const existing = await _curatorCmdDeps.readFile(targetPath).catch(() => "");
      dropFileState.set(targetPath, { existing, usedLines: new Set() });
    }

    const fileState = dropFileState.get(targetPath);
    if (!fileState) continue;

    const keyToken = extractKeyToken(drop.description);

    if (!keyToken) {
      throw new Error(`[curator-commit] conflict: cannot extract key token for drop in ${drop.canonicalFile} — abort`);
    }

    const lines = fileState.existing.split("\n");
    const matchedIndices = lines
      .map((line, idx) => ({ line, idx }))
      .filter(({ line }) => line.includes(keyToken))
      .map(({ idx }) => idx);

    if (matchedIndices.length === 0) {
      throw new Error(`[curator-commit] conflict: key token "${keyToken}" not found in ${drop.canonicalFile} — abort`);
    }

    for (const lineIdx of matchedIndices) {
      if (fileState.usedLines.has(lineIdx)) {
        throw new Error(`[curator-commit] conflict: overlapping drop ranges in ${drop.canonicalFile} — abort`);
      }
      fileState.usedLines.add(lineIdx);
    }
  }

  // Apply drops first (all validated above)
  for (const drop of drops) {
    const targetPath = join(resolved.projectDir, drop.canonicalFile);
    const existing = await _curatorCmdDeps.readFile(targetPath).catch(() => "");
    const filtered = filterDropContent(existing, drop.description);
    await _curatorCmdDeps.writeFile(targetPath, filtered);
    modifiedFiles.add(targetPath);
    console.log(`[drop] Applied to ${drop.canonicalFile}`);
  }

  // Apply adds second
  const adds = proposals.filter((p) => p.action === "add" || p.action === "advisory");
  for (const add of adds) {
    const targetPath = join(resolved.projectDir, add.canonicalFile);
    const content = buildAddContent(add);
    await _curatorCmdDeps.appendFile(targetPath, content);
    modifiedFiles.add(targetPath);
    console.log(`[add] Applied to ${add.canonicalFile}`);
  }

  // Open modified files in editor
  for (const filePath of modifiedFiles) {
    await _curatorCmdDeps.openInEditor(filePath);
  }

  console.log(`Applied ${proposals.length} proposal(s). Review the opened files before committing.`);
}

function filterDropContent(content: string, description: string): string {
  const keyToken = extractKeyToken(description);
  if (!keyToken) return content;
  return content
    .split("\n")
    .filter((line) => !line.includes(keyToken))
    .join("\n");
}

function extractKeyToken(description: string): string {
  // Extract first non-bracket token from description (e.g. "chunkId" from "Stale chunk: chunkId ...")
  const match = description.match(/:\s+([^\s(—]+)/);
  return match ? match[1] : "";
}

function buildAddContent(proposal: ParsedProposal): string {
  const lines: string[] = ["", `<!-- curator: ${proposal.description} -->`];
  if (proposal.evidence) {
    lines.push(`<!-- evidence: ${proposal.evidence} -->`);
  }
  lines.push("");
  return lines.join("\n");
}

// ─── curatorDryrun ────────────────────────────────────────────────────────────

export async function curatorDryrun(options: CuratorDryrunOptions): Promise<void> {
  const resolved = _curatorCmdDeps.resolveProject({ dir: options.project });
  const config = await _curatorCmdDeps.loadConfig(resolved.projectDir);
  const projectKey = getProjectKey(config, resolved.projectDir);
  const outputDir = _curatorCmdDeps.projectOutputDir(projectKey, config.outputDir as string | undefined);
  const runsDir = join(outputDir, "runs");

  const runIds = listRunIds(runsDir);

  if (runIds.length === 0) {
    console.log("No runs found.");
    return;
  }

  const runId = options.run ?? runIds[runIds.length - 1];

  if (options.run && !runIds.includes(options.run)) {
    console.log(`Run ${options.run} not found in ${runsDir}.`);
    return;
  }

  const observationsPath = join(runsDir, runId, "observations.jsonl");
  const observations = await parseObservations(observationsPath);
  const thresholds = getThresholds(config);
  const proposals = runHeuristics(observations, thresholds);
  const markdown = renderProposals(proposals, runId, observations.length);

  console.log(markdown);
}

// ─── curatorGc ────────────────────────────────────────────────────────────────

const DEFAULT_KEEP = 50;

export async function curatorGc(options: CuratorGcOptions): Promise<void> {
  const resolved = _curatorCmdDeps.resolveProject({ dir: options.project });
  const config = await _curatorCmdDeps.loadConfig(resolved.projectDir);
  const gDir = _curatorCmdDeps.globalOutputDir();
  const rollupPath = _curatorCmdDeps.curatorRollupPath(gDir, config.curator?.rollupPath as string | undefined);

  const rollupText = await _curatorCmdDeps.readFile(rollupPath).catch(() => null);
  if (rollupText === null) {
    return;
  }

  const lines = rollupText.trim().split("\n").filter(Boolean);
  const observations = lines.map((l) => JSON.parse(l) as Observation);

  // Group by runId, find max ts per runId
  const maxTsByRunId = new Map<string, string>();
  for (const obs of observations) {
    const existing = maxTsByRunId.get(obs.runId);
    if (!existing || obs.ts > existing) {
      maxTsByRunId.set(obs.runId, obs.ts);
    }
  }

  const keep = options.keep ?? DEFAULT_KEEP;
  const uniqueRunIds = [...maxTsByRunId.entries()]
    .sort((a, b) => (a[1] > b[1] ? -1 : a[1] < b[1] ? 1 : 0))
    .map(([runId]) => runId);

  if (uniqueRunIds.length <= keep) {
    return;
  }

  const keepSet = new Set(uniqueRunIds.slice(0, keep));
  const filtered = observations.filter((obs) => keepSet.has(obs.runId));
  const newContent = `${filtered.map((obs) => JSON.stringify(obs)).join("\n")}\n`;

  await _curatorCmdDeps.writeFile(rollupPath, newContent);
  console.log(`[gc] Pruned rollup to ${keep} most recent runs (was ${uniqueRunIds.length}).`);
}
