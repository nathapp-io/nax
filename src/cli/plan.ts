/**
 * Plan Command — Generate prd.json from a spec file via LLM one-shot call
 *
 * Reads a spec file (--from), builds a planning prompt with codebase context,
 * calls adapter.complete(), validates the JSON response, and writes prd.json.
 *
 * Interactive mode is not yet implemented (PLN-002).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { getAgent } from "../agents/registry";
import type { AgentAdapter } from "../agents/types";
import { scanCodebase } from "../analyze/scanner";
import type { CodebaseScan } from "../analyze/types";
import type { NaxConfig } from "../config";
import { getLogger } from "../logger";
import type { PRD, UserStory } from "../prd/types";

// ─────────────────────────────────────────────────────────────────────────────
// Dependency injection (_deps) — override in tests
// ─────────────────────────────────────────────────────────────────────────────

export const _deps = {
  readFile: (path: string): Promise<string> => Bun.file(path).text(),
  writeFile: (path: string, content: string): Promise<void> => Bun.write(path, content).then(() => {}),
  scanCodebase: (workdir: string): Promise<CodebaseScan> => scanCodebase(workdir),
  getAgent: (name: string): AgentAdapter | undefined => getAgent(name),
  readPackageJson: (workdir: string): Promise<Record<string, unknown> | null> =>
    Bun.file(join(workdir, "package.json"))
      .json()
      .catch(() => null),
  spawnSync: (cmd: string[], opts?: { cwd?: string }): { stdout: Buffer; exitCode: number | null } => {
    const result = Bun.spawnSync(cmd, opts ? { cwd: opts.cwd } : {});
    return { stdout: result.stdout as Buffer, exitCode: result.exitCode };
  },
  mkdirp: (path: string): Promise<void> => Bun.spawn(["mkdir", "-p", path]).exited.then(() => {}),
};

// ─────────────────────────────────────────────────────────────────────────────
// Plan options
// ─────────────────────────────────────────────────────────────────────────────

export interface PlanCommandOptions {
  /** Path to spec file (--from) — required */
  from: string;
  /** Feature name (-f) — required */
  feature: string;
  /** Run in auto (one-shot LLM) mode */
  auto?: boolean;
  /** Override default branch name (-b) */
  branch?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the plan command: read spec, call LLM, write prd.json.
 *
 * @param workdir - Project root directory
 * @param config  - Nax configuration
 * @param options - Command options
 * @returns Path to generated prd.json
 */
export async function planCommand(workdir: string, config: NaxConfig, options: PlanCommandOptions): Promise<string> {
  const naxDir = join(workdir, "nax");

  if (!existsSync(naxDir)) {
    throw new Error(`nax directory not found. Run 'nax init' first in ${workdir}`);
  }

  if (!options.auto) {
    throw new Error("Interactive mode not yet implemented, use --auto");
  }

  const logger = getLogger();

  // Read spec from --from path
  logger?.info("plan", "Reading spec", { from: options.from });
  const specContent = await _deps.readFile(options.from);

  // Scan codebase for context
  logger?.info("plan", "Scanning codebase...");
  const scan = await _deps.scanCodebase(workdir);
  const codebaseContext = buildCodebaseContext(scan);

  // Auto-detect project name
  const pkg = await _deps.readPackageJson(workdir);
  const projectName = detectProjectName(workdir, pkg);

  // Build prompt
  const branchName = options.branch ?? `feat/${options.feature}`;
  const prompt = buildPlanningPrompt(specContent, codebaseContext);

  // Get agent adapter
  const agentName = config?.autoMode?.defaultAgent ?? "claude";
  const adapter = _deps.getAgent(agentName);
  if (!adapter) {
    throw new Error(`[plan] No agent adapter found for '${agentName}'`);
  }

  // One-shot LLM call
  logger?.info("plan", "Running LLM planning...", { agent: agentName });
  const responseText = await adapter.complete(prompt, { jsonMode: true });

  // Parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch (err) {
    throw new Error(`[plan] LLM returned invalid JSON: ${(err as Error).message}`, { cause: err });
  }

  // Validate PRD structure
  const prd = validatePrdResponse(parsed);

  // Override metadata and force all statuses to pending
  const now = new Date().toISOString();
  const finalPrd: PRD = forceStatusPending({
    ...prd,
    project: projectName,
    feature: options.feature,
    branchName,
    createdAt: prd.createdAt ?? now,
    updatedAt: now,
  });

  // Write output
  const outputDir = join(naxDir, "features", options.feature);
  const outputPath = join(outputDir, "prd.json");
  await _deps.mkdirp(outputDir);
  await _deps.writeFile(outputPath, JSON.stringify(finalPrd, null, 2));

  logger?.info("plan", "[OK] PRD written", { outputPath });

  return outputPath;
}

// ─────────────────────────────────────────────────────────────────────────────
// Private helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect project name from package.json or git remote.
 */
function detectProjectName(workdir: string, pkg: Record<string, unknown> | null): string {
  if (pkg?.name && typeof pkg.name === "string") {
    return pkg.name;
  }

  const result = _deps.spawnSync(["git", "remote", "get-url", "origin"], { cwd: workdir });
  if (result.exitCode === 0) {
    const url = result.stdout.toString().trim();
    const match = url.match(/\/([^/]+?)(?:\.git)?$/);
    if (match?.[1]) return match[1];
  }

  return "unknown";
}

/**
 * Validate a raw LLM response against the PRD schema.
 * Throws with a clear error message on any violation.
 */
function validatePrdResponse(data: unknown): PRD {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("[plan] Invalid PRD structure: expected an object");
  }

  const obj = data as Record<string, unknown>;

  for (const field of ["project", "feature", "branchName", "userStories"] as const) {
    if (obj[field] === undefined || obj[field] === null) {
      throw new Error(`[plan] Invalid PRD structure: missing required field '${field}'`);
    }
  }

  if (typeof obj.project !== "string") throw new Error("[plan] Invalid PRD: 'project' must be a string");
  if (typeof obj.feature !== "string") throw new Error("[plan] Invalid PRD: 'feature' must be a string");
  if (typeof obj.branchName !== "string") throw new Error("[plan] Invalid PRD: 'branchName' must be a string");
  if (!Array.isArray(obj.userStories)) throw new Error("[plan] Invalid PRD: 'userStories' must be an array");

  const VALID_COMPLEXITY = new Set(["simple", "medium", "complex", "expert"]);

  for (const rawStory of obj.userStories as unknown[]) {
    if (!rawStory || typeof rawStory !== "object" || Array.isArray(rawStory)) {
      throw new Error("[plan] Invalid PRD: each story must be an object");
    }
    const s = rawStory as Record<string, unknown>;

    for (const field of ["id", "title", "description", "acceptanceCriteria", "tags", "dependencies"] as const) {
      if (s[field] === undefined || s[field] === null) {
        throw new Error(`[plan] Invalid PRD: story missing required field '${field}'`);
      }
    }

    if (s.routing && typeof s.routing === "object") {
      const routing = s.routing as Record<string, unknown>;
      if (routing.complexity && !VALID_COMPLEXITY.has(routing.complexity as string)) {
        throw new Error(`[plan] Invalid PRD: story '${s.id}' has invalid complexity '${routing.complexity}'`);
      }
    }
  }

  // Validate dependency references
  const storyIds = new Set((obj.userStories as Array<{ id: string }>).map((s) => s.id));
  for (const story of obj.userStories as Array<{ id: string; dependencies: unknown }>) {
    if (Array.isArray(story.dependencies)) {
      for (const dep of story.dependencies) {
        if (typeof dep === "string" && dep && !storyIds.has(dep)) {
          throw new Error(`[plan] Invalid PRD: story '${story.id}' depends on unknown story '${dep}'`);
        }
      }
    }
  }

  return obj as unknown as PRD;
}

/**
 * Force all story statuses to 'pending' and reset passes/attempts/escalations.
 */
function forceStatusPending(prd: PRD): PRD {
  return {
    ...prd,
    userStories: prd.userStories.map(
      (story): UserStory => ({
        ...story,
        status: "pending",
        passes: false,
        escalations: story.escalations ?? [],
        attempts: story.attempts ?? 0,
      }),
    ),
  };
}

/**
 * Build codebase context markdown from scan results.
 */
function buildCodebaseContext(scan: CodebaseScan): string {
  const sections: string[] = [];

  sections.push("## Codebase Structure\n");
  sections.push("```");
  sections.push(scan.fileTree);
  sections.push("```\n");

  const allDeps = { ...scan.dependencies, ...scan.devDependencies };
  const depList = Object.entries(allDeps)
    .map(([name, version]) => `- ${name}@${version}`)
    .join("\n");

  if (depList) {
    sections.push("## Dependencies\n");
    sections.push(depList);
    sections.push("");
  }

  if (scan.testPatterns.length > 0) {
    sections.push("## Test Setup\n");
    sections.push(scan.testPatterns.map((p) => `- ${p}`).join("\n"));
    sections.push("");
  }

  return sections.join("\n");
}

/**
 * Build the full planning prompt sent to the LLM.
 *
 * Includes:
 * - Spec content
 * - Codebase context
 * - Output schema (exact prd.json JSON structure)
 * - Complexity classification guide
 * - Test strategy guide
 */
function buildPlanningPrompt(specContent: string, codebaseContext: string): string {
  return `You are a senior software architect generating a product requirements document (PRD) as JSON.

## Spec

${specContent}

## Codebase Context

${codebaseContext}

## Output Schema

Generate a JSON object with this exact structure (no markdown, no explanation — JSON only):

{
  "project": "string — project name",
  "feature": "string — feature name",
  "branchName": "string — git branch (e.g. feat/my-feature)",
  "createdAt": "ISO 8601 timestamp",
  "updatedAt": "ISO 8601 timestamp",
  "userStories": [
    {
      "id": "string — e.g. US-001",
      "title": "string — concise story title",
      "description": "string — detailed description of the story",
      "acceptanceCriteria": ["string — each AC line"],
      "tags": ["string — routing tags, e.g. feature, security, api"],
      "dependencies": ["string — story IDs this story depends on"],
      "status": "pending",
      "passes": false,
      "routing": {
        "complexity": "simple | medium | complex | expert",
        "testStrategy": "test-after | tdd-lite | three-session-tdd",
        "reasoning": "string — brief classification rationale"
      },
      "escalations": [],
      "attempts": 0
    }
  ]
}

## Complexity Classification Guide

- simple: ≤50 LOC, single-file change, purely additive, no new dependencies → test-after
- medium: 50–200 LOC, 2–5 files, standard patterns, clear requirements → tdd-lite
- complex: 200–500 LOC, multiple modules, new abstractions or integrations → three-session-tdd
- expert: 500+ LOC, architectural changes, cross-cutting concerns, high risk → three-session-tdd

## Test Strategy Guide

- test-after: Simple changes with well-understood behavior. Write tests after implementation.
- tdd-lite: Medium complexity. Write key tests first, implement, then fill coverage.
- three-session-tdd: Complex/expert. Full TDD cycle with separate sessions for tests and implementation.

Output ONLY the JSON object. Do not wrap in markdown code blocks.`;
}
