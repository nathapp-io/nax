/**
 * Curator CLI Commands
 *
 * Provides `nax curator status`, `commit`, `dryrun`, and `gc` subcommands
 * for inspecting, accepting, re-running, and managing curator proposals.
 */

import { readdirSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import type { NaxConfig } from "../config";
import { getProjectKey, loadConfig } from "../config";
import { CANONICAL_RULES_DIR, lintForNeutrality } from "../context/rules/canonical-loader";
import type { CuratorThresholds } from "../plugins/builtin/curator/heuristics";
import { runHeuristics } from "../plugins/builtin/curator/heuristics";
import { renderProposals } from "../plugins/builtin/curator/render";
import type { PruneResult, PruneRollupInput } from "../plugins/builtin/curator/rollup-prune";
import { pruneRollup, scanProjectRunIds } from "../plugins/builtin/curator/rollup-prune";
import type { Observation } from "../plugins/builtin/curator/types";
import { curatorRollupPath, globalOutputDir, projectOutputDir } from "../runtime/paths";
import type { ResolvedProject, ResolveProjectOptions } from "./common";
import { resolveProjectAsync } from "./common";

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
  /**
   * Also drop rows carrying no `projectKey` — pre-#1429 history that belongs to
   * no project and that no reader can ever return (windows filter on
   * `projectKey`). Opt-in and machine-wide: it deletes rows this project does
   * not own, so it is never implied by a per-project prune.
   */
  sweepUnattributed?: boolean;
}

// ─── Injectable deps ──────────────────────────────────────────────────────────

export const _curatorCmdDeps = {
  resolveProject: (opts?: ResolveProjectOptions): Promise<ResolvedProject> => resolveProjectAsync(opts),
  loadConfig: (dir?: string): Promise<NaxConfig> => loadConfig(dir),
  projectOutputDir: (key: string, override?: string): string => projectOutputDir(key, override),
  globalOutputDir: (): string => globalOutputDir(),
  curatorRollupPath: (gDir: string, override?: string): string => curatorRollupPath(gDir, override),
  readFile: async (p: string): Promise<string> => Bun.file(p).text(),
  fileExists: async (p: string): Promise<boolean> => Bun.file(p).exists(),
  scanProjectRunIds: (rollupPath: string, projectKey: string): Promise<string[]> =>
    scanProjectRunIds(rollupPath, projectKey),
  pruneRollup: (input: PruneRollupInput): Promise<PruneResult> => pruneRollup(input),
  writeFile: async (p: string, content: string): Promise<void> => {
    await Bun.write(p, content);
  },
  appendFile: async (p: string, content: string): Promise<void> => {
    const existing = Bun.file(p);
    const prev = (await existing.exists()) ? await existing.text() : "";
    await Bun.write(p, prev + content);
  },
  removeFile: async (p: string): Promise<void> => {
    try {
      await unlink(p);
    } catch {
      // File may not exist — ignore
    }
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

  const observations: Observation[] = [];
  let skipped = 0;
  for (const line of text.trim().split("\n")) {
    if (!line) continue;
    try {
      observations.push(JSON.parse(line) as Observation);
    } catch {
      // A crash mid-write (or any other truncation) can leave the final line
      // of observations.jsonl partial. Skip it rather than letting one bad
      // line kill the whole read — this file is inspected specifically to
      // diagnose crashes, so it must tolerate the artifacts crashes leave.
      skipped++;
    }
  }
  if (skipped > 0) {
    console.log(`[WARN] Skipped ${skipped} unparseable line(s) in ${observationsPath}`);
  }
  return observations;
}

function getThresholds(config: NaxConfig): CuratorThresholds {
  const t = config.curator?.thresholds;
  return {
    repeatedFinding: t?.repeatedFinding ?? 2,
    emptyKeyword: t?.emptyKeyword ?? 2,
    rectifyAttempts: t?.rectifyAttempts ?? 2,
    escalationChain: t?.escalationChain ?? 2,
    staleChunkRuns: t?.staleChunkRuns ?? 2,
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

/** @internal Exported for round-trip tests against `renderProposals`; not a public API. */
export const _testing = { parseCheckedProposals };

// ─── curatorStatus ────────────────────────────────────────────────────────────

export async function curatorStatus(options: CuratorStatusOptions): Promise<void> {
  const resolved = await _curatorCmdDeps.resolveProject({ dir: options.project });
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

/**
 * Shapes a proposal's `### <path>` heading is allowed to take, matched
 * against the RESOLVED path relative to the project root (never the raw
 * heading text — `resolve()` collapses any `..` first, so a heading like
 * `.nax/rules/../x.md` is judged on where it actually lands, `.nax/x.md`,
 * which matches neither shape below and is rejected).
 *
 * These are exactly the two shapes built-in heuristics emit today (see
 * plugins/builtin/curator/heuristics.ts): `.nax/rules/<file>.md` (one
 * optional subdirectory, matching canonical-loader.ts's own depth-2 limit)
 * and `.nax/features/<id>/context.md`.
 */
const CURATOR_TARGET_SHAPES = [/^\.nax\/rules\/([^/]+\/)?[^/]+\.md$/, /^\.nax\/features\/[^/]+\/context\.md$/];

/**
 * Resolve a proposal's `### <path>` heading to an absolute path, rejecting
 * anything outside the allow-listed target shapes.
 *
 * `canonicalFile` comes from re-parsing `curator-proposals.md` — a file the
 * operator (or a corrupted run) may have hand-edited — so it is untrusted
 * input. `join()`/`resolve()` alone would happily resolve a
 * `### ../../../etc/whatever` heading outside the project entirely; this
 * additionally confines targets to the two shapes curator actually writes.
 */
function resolveCanonicalTargetPath(projectDir: string, canonicalFile: string): string | null {
  const target = resolve(projectDir, canonicalFile);
  const root = resolve(projectDir);
  if (target !== root && !target.startsWith(root + sep)) return null; // escaped the project

  const relative = target.slice(root.length + 1).replaceAll(sep, "/");
  return CURATOR_TARGET_SHAPES.some((shape) => shape.test(relative)) ? target : null;
}

/** Whether a resolved target path falls inside the canonical rules store (`.nax/rules/`). */
function isWithinCanonicalRulesDir(projectDir: string, targetPath: string): boolean {
  const rulesRoot = resolve(projectDir, CANONICAL_RULES_DIR);
  return targetPath === rulesRoot || targetPath.startsWith(rulesRoot + sep);
}

export async function curatorCommit(options: CuratorCommitOptions): Promise<void> {
  const resolved = await _curatorCmdDeps.resolveProject({ dir: options.project });
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
  // Proposals dropped from this commit for reasons other than the existing
  // "no content to drop" skip below — invalid target path, or (for adds
  // targeting the rules store) failing the neutrality linter. These skip
  // rather than abort the whole commit: unlike the drop-conflict checks
  // further down (which indicate genuine data corruption risk), an invalid
  // heading or a stray "the X tool" phrase in ONE proposal's free-text
  // description shouldn't block every other selected proposal in the batch.
  const skippedProposals = new Set<ParsedProposal>();

  // Resolve every proposal's target path up front; invalid targets are
  // skipped, not applied. Re-parsed from a file the operator may have
  // hand-edited, so it's untrusted.
  const resolvedTargets = new Map<ParsedProposal, string>();
  for (const proposal of proposals) {
    const targetPath = resolveCanonicalTargetPath(resolved.projectDir, proposal.canonicalFile);
    if (targetPath === null) {
      console.log(
        `[skip] Proposal target "${proposal.canonicalFile}" is not an allowed curator target (.nax/rules/*.md or .nax/features/<id>/context.md) — skipping.`, // nax-feature-dir-allow: log message
      );
      skippedProposals.add(proposal);
      continue;
    }
    resolvedTargets.set(proposal, targetPath);
  }

  // Lint add/advisory content targeting the canonical rules store before any
  // writes: appending text that fails the neutrality linter (e.g. an
  // "IMPORTANT:" or emoji surfaced verbatim from a run finding) would break
  // the whole store the next time it loads (the orchestrator now treats
  // that as fatal). Proposals targeting other allowed files (e.g. feature
  // context.md) aren't part of that contract and are left alone.
  for (const add of proposals) {
    if (skippedProposals.has(add) || (add.action !== "add" && add.action !== "advisory")) continue;
    const targetPath = resolvedTargets.get(add);
    if (!targetPath || !isWithinCanonicalRulesDir(resolved.projectDir, targetPath)) continue;

    const content = buildAddContent(add);
    const violations = lintForNeutrality(content, add.canonicalFile);
    if (violations.length > 0) {
      const summary = violations.map((v) => `${v.pattern}: "${v.line.slice(0, 80)}"`).join("; ");
      console.log(`[skip] Proposal for ${add.canonicalFile} fails the neutrality linter (${summary}) — skipping.`);
      skippedProposals.add(add);
    }
  }

  // Validate all drops before any writes: key token must exist, no overlapping ranges
  const drops = proposals.filter((p) => p.action === "drop" && !skippedProposals.has(p));
  const dropFileState = new Map<string, { existing: string; usedLines: Set<number> }>();
  const skippedDrops = new Set<ParsedProposal>();

  for (const drop of drops) {
    // Non-null: every proposal's target path was resolved and validated above.
    const targetPath = resolvedTargets.get(drop);
    if (!targetPath) continue;

    if (!dropFileState.has(targetPath)) {
      const fileExists = await Bun.file(targetPath).exists();
      const existing = fileExists ? await _curatorCmdDeps.readFile(targetPath).catch(() => "") : "";
      dropFileState.set(targetPath, { existing, usedLines: new Set() });
    }

    const fileState = dropFileState.get(targetPath);
    if (!fileState) continue;

    // Skip drops for non-existent files (no content to drop)
    if (fileState.existing === "") {
      skippedDrops.add(drop);
      continue;
    }

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

  // Apply drops first (all validated above, skip non-existent files)
  for (const drop of drops) {
    if (skippedDrops.has(drop)) {
      continue;
    }
    const targetPath = resolvedTargets.get(drop);
    if (!targetPath) continue;
    const existing = await _curatorCmdDeps.readFile(targetPath).catch(() => "");
    const filtered = filterDropContent(existing, drop.description);
    await _curatorCmdDeps.writeFile(targetPath, filtered);
    modifiedFiles.add(targetPath);
    console.log(`[drop] Applied to ${drop.canonicalFile}`);
  }

  // Apply adds second (validated above)
  const adds = proposals.filter((p) => (p.action === "add" || p.action === "advisory") && !skippedProposals.has(p));
  for (const add of adds) {
    const targetPath = resolvedTargets.get(add);
    if (!targetPath) continue;
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
  const resolved = await _curatorCmdDeps.resolveProject({ dir: options.project });
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
  const resolved = await _curatorCmdDeps.resolveProject({ dir: options.project });
  const config = await _curatorCmdDeps.loadConfig(resolved.projectDir);
  const gDir = _curatorCmdDeps.globalOutputDir();
  const rollupPath = _curatorCmdDeps.curatorRollupPath(gDir, config.curator?.rollupPath as string | undefined);

  if (!(await _curatorCmdDeps.fileExists(rollupPath))) {
    console.log(`[gc] No rollup file found at ${rollupPath}. Nothing to prune.`);
    return;
  }

  // The rollup defaults to ONE global file shared by every project on the
  // machine (#1429), so pruning by global recency lets a busy project evict a
  // quiet one. Only rows this project owns are eligible; a neighbour's rows —
  // and pre-#1429 rows, which belong to no project — are preserved unless
  // --sweep-unattributed opts in explicitly.
  const projectKey = getProjectKey(config, resolved.projectDir);
  const uniqueRunIds = await _curatorCmdDeps.scanProjectRunIds(rollupPath, projectKey);

  const keep = options.keep ?? DEFAULT_KEEP;
  const sweep = options.sweepUnattributed === true;

  if (uniqueRunIds.length <= keep && !sweep) {
    console.log(
      `[gc] ${uniqueRunIds.length} unique run(s) for ${projectKey} in rollup — at or below keep=${keep}. Nothing to prune.`,
    );
    return;
  }

  const keepSet = new Set(uniqueRunIds.slice(0, keep));
  const result = await _curatorCmdDeps.pruneRollup({
    rollupPath,
    projectKey,
    keepRunIds: keepSet,
    dropUnattributed: sweep,
  });

  // Delete curator artifacts from per-run directories that are no longer kept
  const outputDir = _curatorCmdDeps.projectOutputDir(projectKey, config.outputDir as string | undefined);
  const perRunsDir = join(outputDir, "runs");
  for (const runId of uniqueRunIds) {
    if (!keepSet.has(runId)) {
      const runDir = join(perRunsDir, runId);
      await _curatorCmdDeps.removeFile(join(runDir, "observations.jsonl"));
      await _curatorCmdDeps.removeFile(join(runDir, "curator-proposals.md"));
    }
  }

  // Runs evicted, NOT rows — `result.dropped` below counts rows, and the two
  // sat one line apart under near-identical names.
  const droppedRuns = Math.max(0, uniqueRunIds.length - keepSet.size);
  console.log(
    `[gc] Pruned rollup for ${projectKey}: kept ${keepSet.size} of ${uniqueRunIds.length} run(s), dropped ${result.dropped} row(s).`,
  );
  console.log(
    `[gc] Preserved ${result.keptOtherProjects} row(s) from other projects and ${result.keptUnattributed} unattributed row(s).`,
  );
  if (!sweep && result.keptUnattributed > 0) {
    console.log(
      `[gc] ${result.keptUnattributed} unattributed row(s) predate project scoping (#1429) and can never be read back. Run with --sweep-unattributed to drop them machine-wide.`,
    );
  }
  if (droppedRuns === 0 && sweep) console.log("[gc] No run-level pruning was needed; only the unattributed sweep ran.");
}
