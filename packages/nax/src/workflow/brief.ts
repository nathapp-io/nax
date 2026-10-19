/** Story brief (spec §6 step 1): requirements, spec excerpts, rulings, red-base warnings. */
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { AdviceDecision } from "@/advisor";
import { getLogger } from "@/logger";
import { buildWorkflowBrief, toRulesIndexEntry, type WorkflowBriefInput } from "@/prompts";
import { storyWorkdir } from "@/utils/path-frame";
import { collectStoryRecords } from "./feature-record";
import { rulingsForStory } from "./rulings";
import { _workflowDeps, type StepContext } from "./step-context";

const MAX_EXCERPT_CHARS = 12_000;

/** Markdown sections (any heading level) whose text names the story id. */
export function specExcerpts(specText: string, storyId: string): string[] {
  const sections = specText
    .split(/^(?=#{1,6} )/m)
    .map((s) => s.trim())
    .filter(Boolean);
  const hits = sections.filter((s) => s.includes(storyId));
  const kept: string[] = [];
  let used = 0;
  for (const hit of hits) {
    if (used + hit.length > MAX_EXCERPT_CHARS) break;
    kept.push(hit);
    used += hit.length;
  }
  return kept;
}

/** The feature spec path relative to the repo ("" when there is none). */
export async function specPathFor(feature: string, projectDir: string): Promise<string> {
  try {
    return (await _workflowDeps.resolveFeatureSpec(feature, projectDir)).specSource?.path ?? "";
  } catch {
    return "";
  }
}

async function loadSpec(sc: StepContext): Promise<{ path?: string; excerpts: string[] }> {
  try {
    const resolved = await _workflowDeps.resolveFeatureSpec(sc.feature, sc.projectDir);
    const rel = resolved.specSource?.path;
    if (!rel) return { excerpts: [] };
    const abs = isAbsolute(rel) ? rel : join(sc.projectDir, rel);
    const file = Bun.file(abs);
    return { path: rel, excerpts: (await file.exists()) ? specExcerpts(await file.text(), sc.story.id) : [] };
  } catch {
    return { excerpts: [] };
  }
}

async function redBaseDependencies(sc: StepContext): Promise<{ storyId: string; reason: string }[]> {
  const records = await collectStoryRecords(dirname(sc.runDir));
  return (sc.story.dependencies ?? [])
    .map((id) => records[id]?.record)
    .filter((r) => r?.state === "complete-gate-open")
    .map((r) => ({ storyId: r?.storyId ?? "", reason: r?.reason ?? "gate red" }));
}

function contextFilePaths(sc: StepContext): string[] {
  return (sc.story.contextFiles ?? []).map((entry) => (typeof entry === "string" ? entry : entry.path));
}

async function loadDecisions(sc: StepContext): Promise<AdviceDecision[]> {
  try {
    return await _workflowDeps.readTrustedDecisions(sc.projectDir, sc.feature, sc.outputDir);
  } catch (err) {
    getLogger().warn("workflow", "Could not read advisor decisions for the brief - writing it without rulings", {
      storyId: sc.story.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * US-003: the brief's rules index.
 *
 * Resolved only under `delivery: "index"` (the default). `"push"` restores the
 * pre-feature behaviour, where the v2 orchestrator carries every rule body in
 * `featureContext` instead — resolving a set the brief would not print is work
 * with no consumer.
 */
async function resolveRulesIndex(sc: StepContext): Promise<WorkflowBriefInput["rulesIndex"]> {
  const rules = sc.config.context?.rules;
  if ((rules?.delivery ?? "index") !== "index") return undefined;
  const set = await _workflowDeps.resolveRuleSet({
    repoRoot: sc.projectDir,
    packageDir: sc.workdir,
    storyWorkdir: storyWorkdir(sc.story),
    ...(rules?.overrideDir !== undefined && { overrideDir: rules.overrideDir }),
    overrideMode: rules?.overrideMode ?? "merge",
  });
  return {
    entries: set.rules.map(toRulesIndexEntry),
    // Only a native session gets the bodies pushed at it by the rule-delivery
    // handlers, so only it is told the text arrives on its own.
    shownAutomatically: sc.callCtx.agentName === "native",
  };
}

export async function writeBrief(sc: StepContext): Promise<void> {
  const [spec, redBase, decisions, rulesIndex, projectContextOverride] = await Promise.all([
    loadSpec(sc),
    redBaseDependencies(sc),
    loadDecisions(sc),
    resolveRulesIndex(sc),
    // US-007: a throw here fails the step rather than writing a brief without the
    // override. The file was validated at run start, so reaching this arm means it
    // disappeared mid-run — and a brief that silently omits what the operator
    // configured is the failure mode the run-start check exists to prevent.
    _workflowDeps.loadProjectContextOverride(sc.config),
  ]);
  const text = buildWorkflowBrief({
    storyId: sc.story.id,
    title: sc.story.title,
    description: sc.story.description,
    acceptanceCriteria: sc.story.acceptanceCriteria,
    contextFiles: contextFilePaths(sc),
    expectedFiles: sc.story.expectedFiles ?? [],
    ...(spec.path ? { specPath: spec.path } : {}),
    specExcerpts: spec.excerpts,
    ...(sc.contextMarkdown ? { storyContext: sc.contextMarkdown } : {}),
    ...(sc.featureContextMarkdown ? { featureContext: sc.featureContextMarkdown } : {}),
    ...(rulesIndex ? { rulesIndex } : {}),
    ...(projectContextOverride !== undefined ? { projectContextOverride } : {}),
    ...(sc.constitution ? { constitution: sc.constitution } : {}),
    rulings: rulingsForStory(decisions, sc.story.id),
    redBaseDependencies: redBase,
    reportPath: sc.reportPath,
  });
  await mkdir(sc.storyDir, { recursive: true });
  await Bun.write(sc.briefPath, text);
}
