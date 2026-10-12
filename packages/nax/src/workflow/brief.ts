/** Story brief (spec §6 step 1): requirements, spec excerpts, rulings, red-base warnings. */
import { mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { buildWorkflowBrief } from "@/prompts";
import { readResult } from "./result";
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
  const result = await readResult(sc.runDir);
  return (sc.story.dependencies ?? [])
    .map((id) => result?.stories[id])
    .filter((r) => r?.state === "complete-gate-open")
    .map((r) => ({ storyId: r?.storyId ?? "", reason: r?.reason ?? "gate red" }));
}

function contextFilePaths(sc: StepContext): string[] {
  return (sc.story.contextFiles ?? []).map((entry) => (typeof entry === "string" ? entry : entry.path));
}

export async function writeBrief(sc: StepContext): Promise<void> {
  const [spec, redBase] = await Promise.all([loadSpec(sc), redBaseDependencies(sc)]);
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
    ...(sc.constitution ? { constitution: sc.constitution } : {}),
    rulings: [],
    redBaseDependencies: redBase,
    reportPath: sc.reportPath,
  });
  await mkdir(sc.storyDir, { recursive: true });
  await Bun.write(sc.briefPath, text);
}
