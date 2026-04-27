/**
 * Plan Command — Generate prd.json from a spec file via LLM one-shot call
 *
 * Reads a spec file (--from), builds a planning prompt with codebase context,
 * runs planning via agent adapter (plan()/complete() depending on mode),
 * validates the JSON response, and writes prd.json.
 *
 * Interactive mode: uses ACP session + stdin bridge for Q&A.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { resolveDefaultAgent } from "../agents";
import { parseDecomposeOutput } from "../agents/shared/decompose";
import { buildDecomposePromptAsync } from "../agents/shared/decompose-prompt";
import type { DecomposedStory } from "../agents/shared/types-extended";
import { scanCodebase } from "../analyze/scanner";
import type { CodebaseScan } from "../analyze/types";
import type { NaxConfig } from "../config";
import { DEFAULT_CONFIG, resolveConfiguredModel } from "../config";
import { resolvePermissions } from "../config/permissions";
import { discoverWorkspacePackages } from "../context/generator";
import { DebateRunner } from "../debate";
import type { DebateRunnerOptions, DebateStageConfig } from "../debate";
import { NaxError } from "../errors";
import { PidRegistry } from "../execution/pid-registry";
import { buildInteractionBridge } from "../interaction/bridge-builder";
import { initInteractionChain } from "../interaction/init";
import { getLogger } from "../logger";
import { callOp, decomposeOp, planOp } from "../operations";
import { mapDecomposedStoriesToUserStories } from "../prd/decompose-mapper";
import { validatePlanOutput } from "../prd/schema";
import type { PRD, StoryStatus, UserStory } from "../prd/types";
import type { PrecheckResultWithCode } from "../precheck";
import { PlanPromptBuilder } from "../prompts";
import type { PackageSummary } from "../prompts";
import { createRuntime } from "../runtime";
import { errorMessage } from "../utils/errors";

const DEFAULT_TIMEOUT_SECONDS = 600;

function isRuntimeWithAgentManager(value: unknown): value is import("../runtime").NaxRuntime {
  return typeof value === "object" && value !== null && "agentManager" in value;
}

function createPlanRuntime(config: NaxConfig, workdir: string): import("../runtime").NaxRuntime {
  const candidate = _planDeps.createRuntime(config, workdir) as unknown;
  if (isRuntimeWithAgentManager(candidate)) return candidate;
  return createRuntime(config, workdir, {
    agentManager: candidate as import("../agents").IAgentManager,
  });
}

function resolvePlanModelSelection(config: NaxConfig, preferredAgent: string) {
  const selection = config.plan?.model ?? "balanced";
  const defaultAgent = config.agent?.default ?? preferredAgent;
  try {
    return resolveConfiguredModel(config.models ?? DEFAULT_CONFIG.models, preferredAgent, selection, defaultAgent);
  } catch (err) {
    getLogger()?.warn("plan", "Failed to resolve plan model from config, falling back to defaults", {
      error: errorMessage(err),
    });
    return resolveConfiguredModel(DEFAULT_CONFIG.models, preferredAgent, "balanced", defaultAgent);
  }
}
// ─────────────────────────────────────────────────────────────────────────────
// Dependency injection (_planDeps) — override in tests
// ─────────────────────────────────────────────────────────────────────────────

export const _planDeps = {
  readFile: (path: string): Promise<string> => Bun.file(path).text(),
  writeFile: (path: string, content: string): Promise<void> => Bun.write(path, content).then(() => {}),
  scanCodebase: (workdir: string): Promise<CodebaseScan> => scanCodebase(workdir),
  createRuntime: (cfg: NaxConfig, wd: string) => createRuntime(cfg, wd),
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
  createDebateRunner: (opts: DebateRunnerOptions): DebateRunner => new DebateRunner(opts),
  runPrecheck: async (
    config: NaxConfig,
    prd: PRD,
    opts: { workdir: string; silent?: boolean },
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

  const defaultAgentName = resolveDefaultAgent(config);

  // Timeout: from plan config, or DEFAULT_TIMEOUT_SECONDS
  const timeoutSeconds = config?.plan?.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;

  // Route: debate > auto (one-shot) > interactive (multi-turn)
  // Debate fires whenever config.debate.enabled + stages.plan.enabled — regardless of auto/interactive mode.
  let rawResponse: string;

  // Debate check is SSOT here — applies to both auto and interactive paths (Option A).
  const debateEnabled = config?.debate?.enabled && config?.debate?.stages?.plan?.enabled;

  if (debateEnabled) {
    // Debate path: run N agents in parallel via DebateRunner.runPlan().
    // Each debater calls adapter.plan() writing to a temp path; resolver picks the best PRD.
    // taskContext is passed to the rebuttal loop; outputFormat is proposal-round only.
    const { taskContext: planTaskContext, outputFormat: planOutputFormat } = new PlanPromptBuilder().build(
      specContent,
      codebaseContext,
      undefined, // no file path — runPlan() appends per-debater temp path
      relativePackages,
      packageDetails,
      config?.project,
    );
    // Safe: debateEnabled guard confirms config.debate.stages.plan is defined
    const planStageConfig = config?.debate?.stages.plan as import("../debate").DebateStageConfig;
    const debateRt = createPlanRuntime(config, workdir);
    const debateAgentManager = debateRt.agentManager;
    const debateCallCtx = {
      runtime: debateRt,
      packageView: debateRt.packages.resolve(),
      packageDir: workdir,
      agentName: debateAgentManager.getDefault(),
      storyId: options.feature,
      featureName: options.feature,
    } satisfies import("../operations/types").CallContext;
    const debateRunner = _planDeps.createDebateRunner({
      ctx: debateCallCtx,
      stage: "plan",
      stageConfig: planStageConfig,
      config,
      workdir,
      featureName: options.feature,
      timeoutSeconds,
      sessionManager: debateRt.sessionManager,
    });
    logger?.info("plan", "Starting debate planning session", {
      debaters: planStageConfig.debaters?.map((d) => d.agent),
      rounds: planStageConfig.rounds,
      feature: options.feature,
    });
    const debateResult = await debateRunner.runPlan(planTaskContext, planOutputFormat, {
      workdir,
      feature: options.feature,
      outputDir: outputDir,
      timeoutSeconds,
      maxInteractionTurns: config?.agent?.maxInteractionTurns,
      specContent,
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
    // Auto (one-shot) path — callOp routes via completeAs, returns JSON directly
    const resolvedPlanModel = resolvePlanModelSelection(config, defaultAgentName);
    const agentName = resolvedPlanModel.agent;
    const rt = createPlanRuntime(config, workdir);
    const agentManager = rt.agentManager;
    if (!agentManager.getAgent(agentName)) throw new Error(`[plan] No agent adapter found for '${agentName}'`);

    logger?.info("plan", "Starting auto planning via callOp", {
      agent: agentName,
      model: resolvedPlanModel.modelDef.model,
      workdir,
      feature: options.feature,
    });

    let autoPrd: PRD;
    try {
      autoPrd = await callOp(
        {
          runtime: rt,
          packageView: rt.packages.resolve(),
          packageDir: workdir,
          agentName,
          featureName: options.feature,
        },
        planOp,
        {
          specContent,
          codebaseContext,
          featureName: options.feature,
          branchName,
          packages: relativePackages,
          packageDetails,
          projectProfile: config?.project,
        },
      );
    } finally {
      await rt.close().catch(() => {});
    }
    await _planDeps.writeFile(outputPath, JSON.stringify({ ...autoPrd, project: projectName }, null, 2));
    logger?.info("plan", "[OK] PRD written", { outputPath });
    return outputPath;
  } else {
    rawResponse = await runInteractivePlan();
  }

  // ── Interactive plan helper (used by: interactive path + debate fallback) ──────────────────────
  async function runInteractivePlan(): Promise<string> {
    // Interactive: agent writes PRD JSON directly to outputPath (avoids output truncation)
    const { taskContext: interactiveTaskCtx, outputFormat: interactiveOutputFmt } = new PlanPromptBuilder().build(
      specContent,
      codebaseContext,
      outputPath,
      relativePackages,
      packageDetails,
      config?.project,
    );
    const prompt = `${interactiveTaskCtx}\n\n${interactiveOutputFmt}`;
    const resolvedPlanModel = resolvePlanModelSelection(config, defaultAgentName);
    const agentName = resolvedPlanModel.agent;
    const rt = createPlanRuntime(config, workdir);
    const agentManager = rt.agentManager;
    if (!agentManager.getAgent(agentName)) throw new Error(`[plan] No agent adapter found for '${agentName}'`);
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
    logger?.info("plan", "Starting interactive planning session", {
      agent: agentName,
      model: resolvedPlanModel.modelDef.model,
      permission: resolvedPerm.mode,
      workdir,
      feature: options.feature,
      timeoutSeconds,
    });
    const planStartTime = Date.now();
    let planError: Error | null = null;
    try {
      try {
        await agentManager.runAs(agentName, {
          runOptions: {
            prompt,
            workdir,
            timeoutSeconds,
            interactionBridge,
            config,
            modelTier: resolvedPlanModel.modelTier ?? "balanced",
            modelDef: resolvedPlanModel.modelDef,
            maxInteractionTurns: config?.agent?.maxInteractionTurns,
            featureName: options.feature,
            onPidSpawned: (pid: number) => pidRegistry.register(pid),
            sessionRole: "plan",
            pipelineStage: "plan",
          },
        });
      } catch (err) {
        planError = err instanceof Error ? err : new Error(String(err));
        logger?.warn("plan", "Interactive planning did not complete cleanly; checking for written PRD", {
          error: planError.message,
          outputPath,
        });
      }
    } finally {
      await pidRegistry.killAll().catch(() => {});
      if (interactionChain) await interactionChain.destroy().catch(() => {});
      await rt.close().catch(() => {});
      logger?.info("plan", "Interactive session ended", { durationMs: Date.now() - planStartTime });
    }
    // Read back from file written by agent
    if (!_planDeps.existsSync(outputPath)) {
      if (planError) {
        throw new Error(`[plan] Planning failed and no PRD was written: ${planError.message}`, { cause: planError });
      }
      throw new Error(`[plan] Agent did not write PRD to ${outputPath}. Check agent logs for errors.`);
    }
    if (planError) {
      logger?.warn("plan", "Proceeding with PRD written by agent despite incomplete terminal response", {
        outputPath,
      });
    }
    return _planDeps.readFile(outputPath);
  }

  // Validate and normalize: handles markdown extraction, trailing commas, LLM quirks,
  // complexity normalization, dependency cross-ref, and forces status → pending.
  const finalPrd = validatePlanOutput(rawResponse, options.feature, branchName);

  // Write normalized PRD — spread to avoid mutating the validated object
  await _planDeps.writeFile(outputPath, JSON.stringify({ ...finalPrd, project: projectName }, null, 2));

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

// ─────────────────────────────────────────────────────────────────────────────
// Decompose command
// ─────────────────────────────────────────────────────────────────────────────

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

  const defaultAgentName = resolveDefaultAgent(config);
  const resolvedPlanModel = resolvePlanModelSelection(config, defaultAgentName);
  const agentName = resolvedPlanModel.agent;
  const rt = createPlanRuntime(config, workdir);
  const agentManager = rt.agentManager;
  const adapterForCapCheck = agentManager.getAgent(agentName);
  if (!adapterForCapCheck) throw new Error(`[decompose] No agent adapter found for '${agentName}'`);

  const timeoutSeconds = config?.plan?.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  const maxAcCount = config?.precheck?.storySizeGate?.maxAcCount ?? Number.POSITIVE_INFINITY;
  const maxReplanAttempts = config?.precheck?.storySizeGate?.maxReplanAttempts ?? 3;

  const debateStages = config?.debate?.stages as unknown as Record<string, DebateStageConfig | undefined>;
  const debateDecompEnabled = config?.debate?.enabled && debateStages?.decompose?.enabled;

  let decompStories: DecomposedStory[] | undefined;
  let repairHint = "";

  try {
    for (let attempt = 0; attempt < maxReplanAttempts; attempt++) {
      if (attempt === 0 && debateDecompEnabled) {
        const decomposeStageConfig = debateStages.decompose as DebateStageConfig;
        const prompt = await buildDecomposePromptAsync({
          specContent: "",
          codebaseContext,
          workdir,
          targetStory,
          siblings,
          featureName: options.feature,
          storyId: options.storyId,
          config,
        });
        const decompCallCtx = {
          runtime: rt,
          packageView: rt.packages.resolve(),
          packageDir: workdir,
          agentName: agentManager.getDefault(),
          storyId: options.storyId,
          featureName: options.feature,
        } satisfies import("../operations/types").CallContext;
        const debateRunner2 = _planDeps.createDebateRunner({
          ctx: decompCallCtx,
          stage: "decompose",
          stageConfig: decomposeStageConfig,
          config,
          workdir,
          featureName: options.feature,
          timeoutSeconds,
          sessionManager: rt.sessionManager,
        });
        const debateResult = await debateRunner2.run(prompt);
        if (debateResult.outcome !== "failed" && debateResult.output) {
          decompStories = parseDecomposeOutput(debateResult.output);
        }
      }

      if (!decompStories) {
        const effectiveContext = repairHint ? `${codebaseContext}\n\n${repairHint}` : codebaseContext;
        decompStories = await callOp(
          {
            runtime: rt,
            packageView: rt.packages.resolve(),
            packageDir: workdir,
            agentName,
            featureName: options.feature,
            storyId: options.storyId,
          },
          decomposeOp,
          {
            specContent: "",
            codebaseContext: effectiveContext,
            targetStory,
            siblings,
            maxAcCount: config?.precheck?.storySizeGate?.maxAcCount ?? null,
          },
        );
      }

      // Structural validation: throw immediately — no retry benefit
      for (const sub of decompStories) {
        if (!sub.complexity || !sub.testStrategy) {
          throw new NaxError(
            `Sub-story "${sub.id}" is missing required routing fields`,
            "DECOMPOSE_VALIDATION_FAILED",
            {
              stage: "decompose",
              storyId: sub.id,
            },
          );
        }
      }

      // AC-count check: retryable within shared maxReplanAttempts budget
      const violations = decompStories.filter(
        (sub) => sub.acceptanceCriteria && sub.acceptanceCriteria.length > maxAcCount,
      );
      if (violations.length === 0) break;

      const violationSummary = violations
        .map((v) => `"${v.id}" (${v.acceptanceCriteria.length} ACs, max ${maxAcCount})`)
        .join(", ");

      if (attempt + 1 >= maxReplanAttempts) {
        throw new NaxError(
          `Decompose AC repair failed after ${maxReplanAttempts} attempts. Oversized sub-stories: ${violationSummary}`,
          "DECOMPOSE_VALIDATION_FAILED",
          { stage: "decompose", storyId: options.storyId },
        );
      }

      repairHint = `REPAIR REQUIRED (attempt ${attempt + 1}/${maxReplanAttempts}): The following sub-stories exceeded maxAcCount of ${maxAcCount}: ${violationSummary}. Split each offending story further so every sub-story has at most ${maxAcCount} acceptance criteria.`;
      decompStories = undefined;
    }
  } finally {
    await rt.close().catch(() => {});
  }

  const subStoriesWithParent: UserStory[] = mapDecomposedStoriesToUserStories(
    // biome-ignore lint/style/noNonNullAssertion: loop guarantees decompStories is set
    decompStories!,
    options.storyId,
    targetStory.workdir,
  );

  const updatedStories = prd.userStories.map((s) =>
    s.id === options.storyId ? { ...s, status: "decomposed" as StoryStatus } : s,
  );

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
