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
import { PidRegistry } from "../execution/pid-registry";
import { getLogger } from "../logger";
import { validatePlanOutput } from "../prd/schema";

// ─────────────────────────────────────────────────────────────────────────────
// Dependency injection (_deps) — override in tests
// ─────────────────────────────────────────────────────────────────────────────

export const _deps = {
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

  // Compute output path early — needed for interactive file-write prompt
  const branchName = options.branch ?? `feat/${options.feature}`;
  const outputDir = join(naxDir, "features", options.feature);
  const outputPath = join(outputDir, "prd.json");
  await _deps.mkdirp(outputDir);

  const agentName = config?.autoMode?.defaultAgent ?? "claude";

  // Timeout: from config, or default to 600 seconds (10 min)
  const timeoutSeconds = config?.execution?.sessionTimeoutSeconds ?? 600;

  // Route to auto (one-shot) or interactive (multi-turn) mode
  let rawResponse: string;
  if (options.auto) {
    // One-shot: use CLI adapter directly — simple completion doesn't need ACP session overhead
    const prompt = buildPlanningPrompt(specContent, codebaseContext);
    const cliAdapter = _deps.getAgent(agentName);
    if (!cliAdapter) throw new Error(`[plan] No agent adapter found for '${agentName}'`);
    rawResponse = await cliAdapter.complete(prompt, { jsonMode: true, workdir });
    // CLI adapter returns {"type":"result","result":"..."} envelope — unwrap it
    try {
      const envelope = JSON.parse(rawResponse) as Record<string, unknown>;
      if (envelope?.type === "result" && typeof envelope?.result === "string") {
        rawResponse = envelope.result;
      }
    } catch {
      // Not an envelope — use rawResponse as-is
    }
  } else {
    // Interactive: agent writes PRD JSON directly to outputPath (avoids output truncation)
    const prompt = buildPlanningPrompt(specContent, codebaseContext, outputPath);
    const adapter = _deps.getAgent(agentName, config);
    if (!adapter) throw new Error(`[plan] No agent adapter found for '${agentName}'`);
    const interactionBridge = createCliInteractionBridge();
    const pidRegistry = new PidRegistry(workdir);
    logger?.info("plan", "Starting interactive planning session...", { agent: agentName });
    try {
      await adapter.plan({
        prompt,
        workdir,
        interactive: true,
        timeoutSeconds,
        interactionBridge,
        config,
        modelTier: config?.plan?.model ?? "balanced",
        // Plan sessions always need approve-all — the agent must write prd.json to disk
        // (that's the entire purpose of the plan operation). User config cannot restrict this.
        dangerouslySkipPermissions: true,
        maxInteractionTurns: config?.agent?.maxInteractionTurns,
        featureName: options.feature,
        pidRegistry,
      });
    } finally {
      await pidRegistry.killAll().catch(() => {});
      logger?.info("plan", "Interactive session ended");
    }
    // Read back from file written by agent
    if (!_deps.existsSync(outputPath)) {
      throw new Error(`[plan] Agent did not write PRD to ${outputPath}. Check agent logs for errors.`);
    }
    rawResponse = await _deps.readFile(outputPath);
  }

  // Validate and normalize: handles markdown extraction, trailing commas, LLM quirks,
  // complexity normalization, dependency cross-ref, and forces status → pending.
  const finalPrd = validatePlanOutput(rawResponse, options.feature, branchName);

  // Override project with auto-detected name (validatePlanOutput fills feature/branchName already)
  finalPrd.project = projectName;

  // Write normalized PRD (overwrites agent-written file with validated/normalized version)
  await _deps.writeFile(outputPath, JSON.stringify(finalPrd, null, 2));

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

  const result = _deps.spawnSync(["git", "remote", "get-url", "origin"], { cwd: workdir });
  if (result.exitCode === 0) {
    const url = result.stdout.toString().trim();
    const match = url.match(/\/([^/]+?)(?:\.git)?$/);
    if (match?.[1]) return match[1];
  }

  return "unknown";
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
function buildPlanningPrompt(specContent: string, codebaseContext: string, outputFilePath?: string): string {
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
        "testStrategy": "test-after | tdd-simple | three-session-tdd | three-session-tdd-lite",
        "reasoning": "string — brief classification rationale"
      },
      "escalations": [],
      "attempts": 0
    }
  ]
}

## Complexity Classification Guide

- simple: ≤50 LOC, single-file change, purely additive, no new dependencies → test-after
- medium: 50–200 LOC, 2–5 files, standard patterns, clear requirements → tdd-simple
- complex: 200–500 LOC, multiple modules, new abstractions or integrations → three-session-tdd
- expert: 500+ LOC, architectural changes, cross-cutting concerns, high risk → three-session-tdd-lite

## Test Strategy Guide

- test-after: Simple changes with well-understood behavior. Write tests after implementation.
- tdd-simple: Medium complexity. Write key tests first, implement, then fill coverage.
- three-session-tdd: Complex stories. Full TDD cycle with separate test-writer and implementer sessions.
- three-session-tdd-lite: Expert/high-risk stories. Full TDD with additional verifier session.

${
  outputFilePath
    ? `Write the PRD JSON directly to this file path: ${outputFilePath}\nDo NOT output the JSON to the conversation. Write the file, then reply with a brief confirmation.`
    : "Output ONLY the JSON object. Do not wrap in markdown code blocks."
}`;
}
