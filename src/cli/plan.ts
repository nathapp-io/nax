/**
 * Plan Command — Generate prd.json from a spec file via LLM one-shot call
 *
 * Reads a spec file (--from), builds a planning prompt with codebase context,
 * calls adapter.complete(), validates the JSON response, and writes prd.json.
 *
 * Interactive mode: uses ACP session + stdin bridge for Q&A.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createAgentRegistry, getAgent } from "../agents/registry";
import type { AgentAdapter } from "../agents/types";
import { scanCodebase } from "../analyze/scanner";
import type { CodebaseScan } from "../analyze/types";
import type { NaxConfig } from "../config";
import { resolvePermissions } from "../config/permissions";
import type { ProjectProfile } from "../config/runtime-types";
import { COMPLEXITY_GUIDE, GROUPING_RULES, TEST_STRATEGY_GUIDE, getAcQualityRules } from "../config/test-strategy";
import { discoverWorkspacePackages } from "../context/generator";
import { DebateSession } from "../debate";
import type { DebateSessionOptions, DebateStageConfig } from "../debate";
import { NaxError } from "../errors";
import { PidRegistry } from "../execution/pid-registry";
import { buildInteractionBridge } from "../interaction/bridge-builder";
import { initInteractionChain } from "../interaction/init";
import { getLogger } from "../logger";
import { validatePlanOutput } from "../prd/schema";
import type { PRD, StoryStatus, UserStory } from "../prd/types";
import type { PrecheckResultWithCode } from "../precheck";

const DEFAULT_TIMEOUT_SECONDS = 600;
// ─────────────────────────────────────────────────────────────────────────────
// Dependency injection (_planDeps) — override in tests
// ─────────────────────────────────────────────────────────────────────────────

export const _planDeps = {
  readFile: (path: string): Promise<string> => Bun.file(path).text(),
  writeFile: (path: string, content: string): Promise<void> => Bun.write(path, content).then(() => {}),
  scanCodebase: (workdir: string): Promise<CodebaseScan> => scanCodebase(workdir),
  getAgent: (name: string, cfg?: NaxConfig): AgentAdapter | undefined =>
    cfg ? createAgentRegistry(cfg).getAgent(name) : getAgent(name),
  readPackageJson: (workdir: string): Promise<Record<string, unknown> | null> =>
    Bun.file(join(workdir, "package.json"))
      .json()
      .catch(() => null),
  spawnSync: (cmd: string[], opts?: { cwd?: string }): { stdout: Buffer; exitCode: number | null } => {
    const result = Bun.spawnSync(cmd, opts ? { cwd: opts.cwd } : {});
    return { stdout: result.stdout as Buffer, exitCode: result.exitCode };
  },
  mkdirp: (path: string): Promise<void> => Bun.spawn(["mkdir", "-p", path]).exited.then(() => {}),
  existsSync: (path: string): boolean => existsSync(path),
  discoverWorkspacePackages: (repoRoot: string): Promise<string[]> => discoverWorkspacePackages(repoRoot),
  readPackageJsonAt: (path: string): Promise<Record<string, unknown> | null> =>
    Bun.file(path)
      .json()
      .catch(() => null),
  createInteractionBridge: (): {
    detectQuestion: (text: string) => Promise<boolean>;
    onQuestionDetected: (text: string) => Promise<string>;
  } => createCliInteractionBridge(),
  initInteractionChain: (cfg: NaxConfig, headless: boolean) => initInteractionChain(cfg, headless),
  createDebateSession: (opts: DebateSessionOptions): DebateSession => new DebateSession(opts),
  runPrecheck: async (
    config: NaxConfig,
    prd: PRD,
    opts?: { workdir: string; silent?: boolean },
  ): Promise<PrecheckResultWithCode> => {
    const { runPrecheck } = await import("../precheck");
    return runPrecheck(config, prd, opts);
  },
  processExit: (code: number): never => process.exit(code),
  planDecompose: (
    workdir: string,
    config: NaxConfig,
    opts: { feature: string; storyId: string },
  ): Promise<() => void> => planDecomposeCommand(workdir, config, opts),
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
  const naxDir = join(workdir, ".nax");

  if (!existsSync(naxDir)) {
    throw new Error(`.nax directory not found. Run 'nax init' first in ${workdir}`);
  }

  const logger = getLogger();

  // Read spec from --from path
  logger?.info("plan", "Reading spec", { from: options.from });
  const specContent = await _planDeps.readFile(options.from);

  // Scan codebase for context
  logger?.info("plan", "Scanning codebase...");
  const [scan, discoveredPackages, pkg] = await Promise.all([
    _planDeps.scanCodebase(workdir),
    _planDeps.discoverWorkspacePackages(workdir),
    _planDeps.readPackageJson(workdir),
  ]);
  const codebaseContext = buildCodebaseContext(scan);

  // Normalize to repo-relative paths (discoverWorkspacePackages returns relative,
  // but mocks/legacy callers may return absolute — strip workdir prefix if present)
  const relativePackages = discoveredPackages.map((p) => (p.startsWith("/") ? p.replace(`${workdir}/`, "") : p));

  // Scan per-package tech stacks for richer monorepo planning context
  const packageDetails =
    relativePackages.length > 0
      ? await Promise.all(
          relativePackages.map(async (rel) => {
            const pkgJson = await _planDeps.readPackageJsonAt(join(workdir, rel, "package.json"));
            return buildPackageSummary(rel, pkgJson);
          }),
        )
      : [];

  // Auto-detect project name
  const projectName = detectProjectName(workdir, pkg);

  // Compute output path early — needed for interactive file-write prompt
  const branchName = options.branch ?? `feat/${options.feature}`;
  const outputDir = join(naxDir, "features", options.feature);
  const outputPath = join(outputDir, "prd.json");
  await _planDeps.mkdirp(outputDir);

  const agentName = config?.autoMode?.defaultAgent ?? "claude";

  // Timeout: from plan config, or DEFAULT_TIMEOUT_SECONDS
  const timeoutSeconds = config?.plan?.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;

  // Route: debate > auto (one-shot) > interactive (multi-turn)
  // Debate fires whenever config.debate.enabled + stages.plan.enabled — regardless of auto/interactive mode.
  let rawResponse: string;

  // Debate check is SSOT here — applies to both auto and interactive paths (Option A).
  const debateEnabled = config?.debate?.enabled && config?.debate?.stages?.plan?.enabled;

  if (debateEnabled) {
    // Debate path: run N agents in parallel via DebateSession.runPlan().
    // Each debater calls adapter.plan() writing to a temp path; resolver picks the best PRD.
    // basePrompt has no file-write instruction — DebateSession.runPlan() injects per-debater paths.
    const basePrompt = buildPlanningPrompt(
      specContent,
      codebaseContext,
      undefined, // no file path — runPlan() appends per-debater temp path
      relativePackages,
      packageDetails,
      config?.project,
    );
    const resolvedPerm = resolvePermissions(config, "plan");
    // Safe: debateEnabled guard confirms config.debate.stages.plan is defined
    const planStageConfig = config?.debate?.stages.plan as import("../debate").DebateStageConfig;
    const debateSession = _planDeps.createDebateSession({
      storyId: options.feature,
      stage: "plan",
      stageConfig: planStageConfig,
      config,
      workdir,
      featureName: options.feature,
      timeoutSeconds,
    });
    logger?.info("plan", "Starting debate planning session", {
      debaters: planStageConfig.debaters?.map((d) => d.agent),
      rounds: planStageConfig.rounds,
      feature: options.feature,
    });
    const debateResult = await debateSession.runPlan(basePrompt, {
      workdir,
      feature: options.feature,
      outputDir: outputDir,
      timeoutSeconds,
      dangerouslySkipPermissions: resolvedPerm.skipPermissions,
      maxInteractionTurns: config?.agent?.maxInteractionTurns,
    });
    if (debateResult.outcome !== "failed" && debateResult.output) {
      rawResponse = debateResult.output;
    } else {
      logger?.warn("debate", "All plan debaters failed — falling back to single agent", {
        stage: "plan",
        event: "fallback",
      });
      // Fallback: interactive single-agent plan (most robust — writes to file)
      rawResponse = await runInteractivePlan();
    }
  } else if (options.auto) {
    // Auto (one-shot) path — no debate
    // #91: Respect agent.protocol — ACP protocol uses adapter.plan() (session-based),
    // CLI protocol uses adapter.complete() (one-shot). This matches how the run path works.
    const isAcp = config?.agent?.protocol === "acp";
    const prompt = buildPlanningPrompt(
      specContent,
      codebaseContext,
      isAcp ? outputPath : undefined, // ACP writes directly to file; CLI returns inline
      relativePackages,
      packageDetails,
      config?.project,
    );

    const adapter = _planDeps.getAgent(agentName, config);
    if (!adapter) throw new Error(`[plan] No agent adapter found for '${agentName}'`);

    let autoModel: string | undefined;
    try {
      const planTier = config?.plan?.model ?? "balanced";
      const { resolveModelForAgent } = await import("../config/schema");
      if (config?.models) {
        const defaultAgent = config.autoMode?.defaultAgent ?? "claude";
        autoModel = resolveModelForAgent(config.models, defaultAgent, planTier, defaultAgent).model;
      }
    } catch {
      // fall through — adapter will use its own fallback
    }

    if (isAcp) {
      logger?.info("plan", "Starting ACP auto planning session", {
        agent: agentName,
        model: autoModel ?? config?.plan?.model ?? "balanced",
        workdir,
        feature: options.feature,
        timeoutSeconds,
      });
      const pidRegistry = new PidRegistry(workdir);
      try {
        await adapter.plan({
          prompt,
          workdir,
          interactive: false,
          timeoutSeconds,
          config,
          modelTier: config?.plan?.model ?? "balanced",
          dangerouslySkipPermissions: resolvePermissions(config, "plan").skipPermissions,
          maxInteractionTurns: config?.agent?.maxInteractionTurns,
          featureName: options.feature,
          pidRegistry,
          sessionRole: "plan",
        });
      } finally {
        await pidRegistry.killAll().catch(() => {});
      }
      if (!_planDeps.existsSync(outputPath)) {
        throw new Error(`[plan] ACP agent did not write PRD to ${outputPath}. Check agent logs for errors.`);
      }
      rawResponse = await _planDeps.readFile(outputPath);
    } else {
      // CLI: one-shot complete() — simple and fast, no session overhead
      const timeoutMs = (config?.plan?.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
      const completeResult = await adapter.complete(prompt, {
        model: autoModel,
        jsonMode: true,
        workdir,
        config,
        featureName: options.feature,
        sessionRole: "plan",
        timeoutMs,
      });
      let result = typeof completeResult === "string" ? completeResult : completeResult.output;
      // CLI adapter returns {"type":"result","result":"..."} envelope — unwrap it
      try {
        const envelope = JSON.parse(result) as Record<string, unknown>;
        if (envelope?.type === "result" && typeof envelope?.result === "string") {
          result = envelope.result;
        }
      } catch {
        // Not an envelope — use result as-is
      }
      rawResponse = result;
    }
  } else {
    rawResponse = await runInteractivePlan();
  }

  // ── Interactive plan helper (used by: interactive path + debate fallback) ──────────────────────
  async function runInteractivePlan(): Promise<string> {
    // Interactive: agent writes PRD JSON directly to outputPath (avoids output truncation)
    const prompt = buildPlanningPrompt(
      specContent,
      codebaseContext,
      outputPath,
      relativePackages,
      packageDetails,
      config?.project,
    );
    const adapter = _planDeps.getAgent(agentName, config);
    if (!adapter) throw new Error(`[plan] No agent adapter found for '${agentName}'`);
    // Use configured interaction plugin (telegram/webhook/auto) if available;
    // fall back to hardcoded stdin bridge when no interaction config is set.
    const headless = !process.stdin.isTTY;
    const interactionChain = config ? await _planDeps.initInteractionChain(config, headless) : null;
    const configuredBridge = interactionChain
      ? buildInteractionBridge(interactionChain, {
          featureName: options.feature,
          stage: "pre-flight",
        })
      : undefined;
    const interactionBridge = configuredBridge ?? _planDeps.createInteractionBridge();
    const pidRegistry = new PidRegistry(workdir);
    const resolvedPerm = resolvePermissions(config, "plan");
    const resolvedModel = config?.plan?.model ?? "balanced";
    logger?.info("plan", "Starting interactive planning session", {
      agent: agentName,
      model: resolvedModel,
      permission: resolvedPerm.mode,
      workdir,
      feature: options.feature,
      timeoutSeconds,
    });
    const planStartTime = Date.now();
    try {
      await adapter.plan({
        prompt,
        workdir,
        interactive: true,
        timeoutSeconds,
        interactionBridge,
        config,
        modelTier: resolvedModel,
        dangerouslySkipPermissions: resolvedPerm.skipPermissions,
        maxInteractionTurns: config?.agent?.maxInteractionTurns,
        featureName: options.feature,
        pidRegistry,
      });
    } finally {
      await pidRegistry.killAll().catch(() => {});
      if (interactionChain) await interactionChain.destroy().catch(() => {});
      logger?.info("plan", "Interactive session ended", { durationMs: Date.now() - planStartTime });
    }
    // Read back from file written by agent
    if (!_planDeps.existsSync(outputPath)) {
      throw new Error(`[plan] Agent did not write PRD to ${outputPath}. Check agent logs for errors.`);
    }
    return _planDeps.readFile(outputPath);
  }

  // Validate and normalize: handles markdown extraction, trailing commas, LLM quirks,
  // complexity normalization, dependency cross-ref, and forces status → pending.
  const finalPrd = validatePlanOutput(rawResponse, options.feature, branchName);

  // Override project with auto-detected name (validatePlanOutput fills feature/branchName already)
  finalPrd.project = projectName;

  // Write normalized PRD (overwrites agent-written file with validated/normalized version)
  await _planDeps.writeFile(outputPath, JSON.stringify(finalPrd, null, 2));

  logger?.info("plan", "[OK] PRD written", { outputPath });

  return outputPath;
}

// ─────────────────────────────────────────────────────────────────────────────
// Interaction and extraction helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a CLI interaction bridge for stdin-based human interaction.
 * This bridge accepts questions from the agent and prompts the user via stdin.
 */
function createCliInteractionBridge(): {
  detectQuestion: (text: string) => Promise<boolean>;
  onQuestionDetected: (text: string) => Promise<string>;
} {
  return {
    async detectQuestion(text: string): Promise<boolean> {
      return text.includes("?");
    },

    async onQuestionDetected(text: string): Promise<string> {
      // In non-TTY mode (headless/pipes), skip interaction and continue
      if (!process.stdin.isTTY) {
        return "";
      }

      // Print agent question and read one line from stdin
      process.stdout.write(`\n🤖 Agent: ${text}\nYou: `);

      return new Promise<string>((resolve) => {
        const rl = createInterface({ input: process.stdin, terminal: false });
        rl.once("line", (line) => {
          rl.close();
          resolve(line.trim());
        });
        rl.once("close", () => resolve(""));
      });
    },
  };
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

  const result = _planDeps.spawnSync(["git", "remote", "get-url", "origin"], { cwd: workdir });
  if (result.exitCode === 0) {
    const url = result.stdout.toString().trim();
    const match = url.match(/\/([^/]+?)(?:\.git)?$/);
    if (match?.[1]) return match[1];
  }

  return "unknown";
}

/** Compact per-package summary for the planning prompt. */
interface PackageSummary {
  path: string;
  name: string;
  runtime: string;
  framework: string;
  testRunner: string;
  keyDeps: string[];
}

const FRAMEWORK_PATTERNS: [RegExp, string][] = [
  [/\bnext\b/, "Next.js"],
  [/\bnuxt\b/, "Nuxt"],
  [/\bremix\b/, "Remix"],
  [/\bexpress\b/, "Express"],
  [/\bfastify\b/, "Fastify"],
  [/\bhono\b/, "Hono"],
  [/\bnestjs|@nestjs\b/, "NestJS"],
  [/\breact\b/, "React"],
  [/\bvue\b/, "Vue"],
  [/\bsvelte\b/, "Svelte"],
  [/\bastro\b/, "Astro"],
  [/\belectron\b/, "Electron"],
];

const TEST_RUNNER_PATTERNS: [RegExp, string][] = [
  [/\bvitest\b/, "vitest"],
  [/\bjest\b/, "jest"],
  [/\bmocha\b/, "mocha"],
  [/\bava\b/, "ava"],
];

const KEY_DEP_PATTERNS: [RegExp, string][] = [
  [/\bprisma\b/, "prisma"],
  [/\bdrizzle-orm\b/, "drizzle"],
  [/\btypeorm\b/, "typeorm"],
  [/\bmongoose\b/, "mongoose"],
  [/\bsqlite\b|better-sqlite/, "sqlite"],
  [/\bstripe\b/, "stripe"],
  [/\bgraphql\b/, "graphql"],
  [/\btrpc\b/, "tRPC"],
  [/\bzod\b/, "zod"],
  [/\btailwind\b/, "tailwind"],
];

/**
 * Build a compact summary of a package's tech stack from its package.json.
 */
function buildPackageSummary(rel: string, pkg: Record<string, unknown> | null): PackageSummary {
  const name = typeof pkg?.name === "string" ? pkg.name : rel;
  const allDeps = { ...(pkg?.dependencies as object | undefined), ...(pkg?.devDependencies as object | undefined) };
  const depNames = Object.keys(allDeps).join(" ");
  const scripts = (pkg?.scripts ?? {}) as Record<string, string>;

  // Detect runtime from scripts or lock files
  const testScript = scripts.test ?? "";
  const runtime = testScript.includes("bun ") ? "bun" : testScript.includes("node ") ? "node" : "unknown";

  // Detect framework
  const framework = FRAMEWORK_PATTERNS.find(([re]) => re.test(depNames))?.[1] ?? "";

  // Detect test runner
  const testRunner =
    TEST_RUNNER_PATTERNS.find(([re]) => re.test(depNames))?.[1] ?? (testScript.includes("bun test") ? "bun:test" : "");

  // Key deps
  const keyDeps = KEY_DEP_PATTERNS.filter(([re]) => re.test(depNames)).map(([, label]) => label);

  return { path: rel, name, runtime, framework, testRunner, keyDeps };
}

/**
 * Render per-package summaries as a compact markdown table for the prompt.
 */
function buildPackageDetailsSection(details: PackageSummary[]): string {
  if (details.length === 0) return "";

  const rows = details.map((d) => {
    const stack = [d.framework, d.testRunner, ...d.keyDeps].filter(Boolean).join(", ") || "—";
    return `| \`${d.path}\` | ${d.name} | ${stack} |`;
  });

  return `\n## Package Tech Stacks\n\n| Path | Package | Stack |\n|:-----|:--------|:------|\n${rows.join("\n")}\n`;
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
 * Structured as 3 explicit steps (ENH-006):
 *   Step 1: Understand the spec
 *   Step 2: Analyze codebase (existing) or architecture decisions (greenfield)
 *   Step 3: Generate implementation stories from analysis
 *
 * Includes:
 * - Spec content + codebase context
 * - Output schema with analysis + contextFiles fields
 * - Complexity + test strategy guides
 * - MW-007: Monorepo hint and package list when packages are detected
 */
export function buildPlanningPrompt(
  specContent: string,
  codebaseContext: string,
  outputFilePath?: string,
  packages?: string[],
  packageDetails?: PackageSummary[],
  projectProfile?: ProjectProfile,
): string {
  const isMonorepo = packages && packages.length > 0;
  const packageDetailsSection =
    packageDetails && packageDetails.length > 0 ? buildPackageDetailsSection(packageDetails) : "";
  const monorepoHint = isMonorepo
    ? `\n## Monorepo Context\n\nThis is a monorepo. Detected packages:\n${packages.map((p) => `- ${p}`).join("\n")}\n${packageDetailsSection}\nFor each user story, set the "workdir" field to the relevant package path (e.g. "packages/api"). Stories that span the root should omit "workdir".`
    : "";

  const workdirField = isMonorepo
    ? `\n      "workdir": "string — optional, relative path to package (e.g. \\"packages/api\\"). Omit for root-level stories.",`
    : "";

  return `You are a senior software architect generating a product requirements document (PRD) as JSON.

## Step 1: Understand the Spec

Read the spec carefully. Identify the goal, scope, constraints, and what "done" looks like.

## Spec

${specContent}

## Step 2: Analyze

Examine the codebase context below.

If the codebase has existing code (refactoring, enhancement, bug fix):
- Which existing files need modification?
- Which files import from or depend on them?
- What tests cover the affected code?
- What are the risks (breaking changes, backward compatibility)?
- What is the migration path?

If this is a greenfield project (empty or minimal codebase):
- What is the target architecture?
- What are the key technical decisions (framework, patterns, conventions)?
- What should be built first (dependency order)?

Record ALL findings in the "analysis" field of the output JSON. This analysis is provided to every implementation agent as context — be thorough.

## Codebase Context

${codebaseContext}${monorepoHint}

## Step 3: Generate Implementation Stories

Based on your Step 2 analysis, create stories that produce CODE CHANGES.

${GROUPING_RULES}

${getAcQualityRules(projectProfile)}

For each story, set "contextFiles" to the key source files the agent should read before implementing (max 5 per story). Use your Step 2 analysis to identify the most relevant files. Leave empty for greenfield stories with no existing files to reference.

${COMPLEXITY_GUIDE}

${TEST_STRATEGY_GUIDE}

## Output Schema

Generate a JSON object with this exact structure (no markdown, no explanation — JSON only):

{
  "project": "string — project name",
  "feature": "string — feature name",
  "analysis": "string — your Step 2 analysis: key files, impact areas, risks, architecture decisions, migration notes. All implementation agents will receive this.",
  "branchName": "string — git branch (e.g. feat/my-feature)",
  "createdAt": "ISO 8601 timestamp",
  "updatedAt": "ISO 8601 timestamp",
  "userStories": [
    {
      "id": "string — e.g. US-001",
      "title": "string — concise story title",
      "description": "string — detailed description of the story",
      "acceptanceCriteria": ["string — behavioral, testable criteria. Format: 'When [X], then [Y]'. One assertion per AC. Never include quality gates."],
      "contextFiles": ["string — key source files the agent should read (max 5, relative paths)"],
      "tags": ["string — routing tags, e.g. feature, security, api"],
      "dependencies": ["string — story IDs this story depends on"],${workdirField}
      "status": "pending",
      "passes": false,
      "routing": {
        "complexity": "simple | medium | complex | expert",
        "testStrategy": "no-test | tdd-simple | three-session-tdd-lite | three-session-tdd | test-after",
        "noTestJustification": "string — REQUIRED when testStrategy is no-test, explains why tests are unnecessary",
        "reasoning": "string — brief classification rationale"
      },
      "escalations": [],
      "attempts": 0
    }
  ]
}

${
  outputFilePath
    ? `Write the PRD JSON directly to this file path: ${outputFilePath}\nDo NOT output the JSON to the conversation. Write the file, then reply with a brief confirmation.`
    : "Output ONLY the JSON object. Do not wrap in markdown code blocks."
}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Decompose command
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a decompose prompt that instructs the LLM to split a story into sub-stories.
 */
export function buildDecomposePrompt(targetStory: UserStory, siblings: UserStory[], codebaseContext: string): string {
  const siblingsSummary =
    siblings.length > 0 ? `\n## Sibling Stories\n\n${siblings.map((s) => `- ${s.id}: ${s.title}`).join("\n")}\n` : "";

  return `You are a senior software architect decomposing a complex user story into smaller, implementable sub-stories.

## Target Story

${JSON.stringify(targetStory, null, 2)}${siblingsSummary}
## Codebase Context

${codebaseContext}

${COMPLEXITY_GUIDE}

${TEST_STRATEGY_GUIDE}

${GROUPING_RULES}

${getAcQualityRules()}

## Output

Return JSON with this exact structure (no markdown, no explanation — JSON only):

{
  "subStories": [
    {
      "id": "string — e.g. ${targetStory.id}-A",
      "title": "string",
      "description": "string",
      "acceptanceCriteria": ["string — behavioral, testable criteria"],
      "contextFiles": ["string — required, non-empty list of key source files"],
      "tags": ["string"],
      "dependencies": ["string"],
      "status": "pending",
      "passes": false,
      "routing": {
        "complexity": "simple | medium | complex | expert",
        "testStrategy": "no-test | tdd-simple | three-session-tdd-lite | three-session-tdd | test-after",
        "modelTier": "fast | balanced | powerful",
        "reasoning": "string"
      },
      "escalations": [],
      "attempts": 0
    }
  ]
}`;
}

/**
 * Decompose an existing story into sub-stories.
 *
 * @param workdir - Project root directory
 * @param config  - Nax configuration
 * @param options - feature name and storyId to decompose
 * @returns no-op function (resolves on success)
 */
export async function planDecomposeCommand(
  workdir: string,
  config: NaxConfig,
  options: { feature: string; storyId: string },
): Promise<() => void> {
  const prdPath = join(workdir, ".nax", "features", options.feature, "prd.json");

  if (!_planDeps.existsSync(prdPath)) {
    throw new NaxError(`PRD not found: ${prdPath}`, "PRD_NOT_FOUND", {
      stage: "decompose",
      feature: options.feature,
    });
  }

  const prdContent = await _planDeps.readFile(prdPath);
  const prd = JSON.parse(prdContent) as PRD;

  const targetStory = prd.userStories.find((s) => s.id === options.storyId) ?? null;
  if (!targetStory) {
    throw new NaxError(`Story "${options.storyId}" not found in PRD`, "STORY_NOT_FOUND", {
      stage: "decompose",
      storyId: options.storyId,
    });
  }

  if (targetStory.status === "decomposed") {
    throw new NaxError(`Story "${options.storyId}" is already decomposed`, "STORY_ALREADY_DECOMPOSED", {
      stage: "decompose",
      storyId: options.storyId,
    });
  }

  const scan = await _planDeps.scanCodebase(workdir);
  const codebaseContext = buildCodebaseContext(scan);

  const siblings = prd.userStories.filter((s) => s.id !== options.storyId);
  const prompt = buildDecomposePrompt(targetStory, siblings, codebaseContext);

  const agentName = config?.autoMode?.defaultAgent ?? "claude";
  const adapter = _planDeps.getAgent(agentName, config);
  if (!adapter) throw new Error(`[decompose] No agent adapter found for '${agentName}'`);

  const stages = config?.debate?.stages as Record<string, DebateStageConfig> | undefined;
  const debateEnabled = config?.debate?.enabled && stages?.decompose?.enabled;

  let rawResponse: string;
  const timeoutSeconds = config?.plan?.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  const timeoutMs = timeoutSeconds * 1000;
  if (debateEnabled) {
    const stageConfig = stages?.decompose as DebateStageConfig;
    const debateSession = _planDeps.createDebateSession({
      storyId: options.storyId,
      stage: "decompose",
      stageConfig,
      config,
      workdir,
      featureName: options.feature,
      timeoutSeconds: timeoutSeconds,
    });
    const debateResult = await debateSession.run(prompt);
    if (debateResult.outcome !== "failed" && debateResult.output) {
      rawResponse = debateResult.output;
    } else {
      const completeResult = await adapter.complete(prompt, {
        jsonMode: true,
        workdir,
        sessionRole: "decompose",
        featureName: options.feature,
        storyId: options.storyId,
        timeoutMs,
      });
      rawResponse = typeof completeResult === "string" ? completeResult : completeResult.output;
    }
  } else {
    const completeResult = await adapter.complete(prompt, {
      jsonMode: true,
      workdir,
      sessionRole: "decompose",
      featureName: options.feature,
      storyId: options.storyId,
      timeoutMs,
    });
    rawResponse = typeof completeResult === "string" ? completeResult : completeResult.output;
  }

  // Strip markdown code fences if the LLM wrapped JSON in backticks
  const jsonMatch = rawResponse.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const cleanedResponse = jsonMatch ? jsonMatch[1] : rawResponse;

  let parsed: { subStories: UserStory[] };
  try {
    parsed = JSON.parse(cleanedResponse.trim()) as { subStories: UserStory[] };
  } catch (err) {
    throw new NaxError(
      `Failed to parse decompose response as JSON: ${(err as Error).message}\n\nResponse (first 500 chars):\n${rawResponse.slice(0, 500)}`,
      "DECOMPOSE_PARSE_FAILED",
      { stage: "decompose", storyId: options.storyId },
    );
  }
  const subStories = parsed.subStories;

  const maxAcCount = config?.precheck?.storySizeGate?.maxAcCount ?? Number.POSITIVE_INFINITY;
  for (const sub of subStories) {
    if (!sub.contextFiles || sub.contextFiles.length === 0) {
      throw new NaxError(`Sub-story "${sub.id}" has empty contextFiles`, "DECOMPOSE_VALIDATION_FAILED", {
        stage: "decompose",
        storyId: sub.id,
      });
    }
    if (!sub.routing?.complexity || !sub.routing?.testStrategy || !sub.routing?.modelTier) {
      throw new NaxError(`Sub-story "${sub.id}" is missing required routing fields`, "DECOMPOSE_VALIDATION_FAILED", {
        stage: "decompose",
        storyId: sub.id,
      });
    }
    if (sub.acceptanceCriteria && sub.acceptanceCriteria.length > maxAcCount) {
      throw new NaxError(
        `Sub-story "${sub.id}" has ${sub.acceptanceCriteria.length} ACs, exceeds maxAcCount of ${maxAcCount}`,
        "DECOMPOSE_VALIDATION_FAILED",
        { stage: "decompose", storyId: sub.id },
      );
    }
  }

  const updatedStories = prd.userStories.map((s) =>
    s.id === options.storyId ? { ...s, status: "decomposed" as StoryStatus } : s,
  );

  const subStoriesWithParent: UserStory[] = subStories.map((s) => ({ ...s, parentStoryId: options.storyId }));

  const originalIndex = updatedStories.findIndex((s) => s.id === options.storyId);
  const finalStories = [
    ...updatedStories.slice(0, originalIndex + 1),
    ...subStoriesWithParent,
    ...updatedStories.slice(originalIndex + 1),
  ];

  const updatedPrd: PRD = { ...prd, userStories: finalStories };
  await _planDeps.writeFile(prdPath, JSON.stringify(updatedPrd, null, 2));
  return () => {};
}

// ─────────────────────────────────────────────────────────────────────────────
// Replan loop
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the replan loop — decomposes oversized stories and re-runs precheck.
 *
 * When storySizeGate blocks stories with `action === 'block'`, this loop calls
 * planDecomposeCommand for each flagged story, reloads the PRD, and re-runs
 * precheck. Exits with code 1 if stories remain blocked after maxReplanAttempts.
 *
 * No-op when action === 'warn' (gate is non-blocking) or no stories are flagged.
 *
 * @param workdir  - Project root directory
 * @param config   - Nax configuration
 * @param options  - feature name, initial prd, and prd file path
 */
export async function runReplanLoop(
  workdir: string,
  config: NaxConfig,
  options: { feature: string; prd: PRD; prdPath: string },
): Promise<void> {
  const action = config?.precheck?.storySizeGate?.action ?? "block";
  const maxAttempts = config?.precheck?.storySizeGate?.maxReplanAttempts ?? 3;

  // AC-6: warn/skip action — replan loop does not fire
  if (action !== "block") return;

  const logger = getLogger();

  // Initial precheck
  let precheckResult = await _planDeps.runPrecheck(config, options.prd, { workdir, silent: true });

  // No flagged stories — nothing to replan
  if ((precheckResult.flaggedStories ?? []).length === 0) return;

  let currentPrd = options.prd;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const flagged = precheckResult.flaggedStories ?? [];
    logger?.info("replan", `[Replan ${attempt}/${maxAttempts}] Decomposing ${flagged.length} oversized stories...`);

    for (const flaggedStory of flagged) {
      await _planDeps.planDecompose(workdir, config, {
        feature: options.feature,
        storyId: flaggedStory.storyId,
      });
    }

    // Reload PRD from disk after decompose
    const prdContent = await _planDeps.readFile(options.prdPath);
    currentPrd = JSON.parse(prdContent) as PRD;

    // Re-run precheck with reloaded PRD
    precheckResult = await _planDeps.runPrecheck(config, currentPrd, { workdir, silent: true });

    // AC-3: exit early when all stories cleared
    if ((precheckResult.flaggedStories ?? []).length === 0) return;
  }

  // AC-5: still blocked after max attempts
  const remainingIds = (precheckResult.flaggedStories ?? []).map((f) => f.storyId).join(", ");
  logger?.error("replan", `Replan exhausted: stories still oversized after ${maxAttempts} attempts`, {
    storyIds: remainingIds,
  });
  _planDeps.processExit(1);
}
