/**
 * Claude Code Agent Adapter
 */

import type { AgentAdapter, AgentCapabilities, AgentResult, AgentRunOptions, PlanOptions, PlanResult, DecomposeOptions, DecomposeResult, DecomposedStory, InteractiveRunOptions, PtyHandle } from "./types";
import { estimateCostFromOutput, estimateCostByDuration } from "./cost";

/**
 * Maximum characters to capture from agent stdout.
 *
 * Rationale:
 * - Claude Code agents can produce very large output (test results, diffs, stack traces)
 * - Capturing full output can consume excessive memory for long-running sessions
 * - Last 5000 chars typically contain the most relevant info (final status, summary, errors)
 * - Earlier output is usually verbose build logs or test details that aren't critical for result parsing
 *
 * This limit prevents memory bloat while preserving actionable output for debugging and cost estimation.
 */
const MAX_AGENT_OUTPUT_CHARS = 5000;

/**
 * Claude Code agent adapter implementation.
 *
 * Implements the AgentAdapter interface for Claude Code CLI,
 * supporting model routing, rate limit retry, and cost tracking.
 *
 * @example
 * ```ts
 * const adapter = new ClaudeCodeAdapter();
 * const installed = await adapter.isInstalled();
 *
 * if (installed) {
 *   const result = await adapter.run({
 *     prompt: "Add unit tests for src/utils.ts",
 *     workdir: "/path/to/project",
 *     modelTier: "balanced",
 *     modelDef: { model: "claude-sonnet-4.5", env: {} },
 *     timeoutSeconds: 600,
 *   });
 * }
 * ```
 */
export class ClaudeCodeAdapter implements AgentAdapter {
  readonly name = "claude";
  readonly displayName = "Claude Code";
  readonly binary = "claude";

  /**
   * Claude Code capability metadata.
   *
   * Supports all three model tiers (fast=Haiku, balanced=Sonnet, powerful=Opus),
   * has a 200k token context window, and handles all workflow features.
   */
  readonly capabilities: AgentCapabilities = {
    supportedTiers: ["fast", "balanced", "powerful"],
    maxContextTokens: 200_000,
    features: new Set(["tdd", "review", "refactor", "batch"]),
  };

  /**
   * Check if Claude Code CLI is installed on this machine.
   *
   * @returns true if the `claude` binary is available in PATH
   *
   * @example
   * ```ts
   * const adapter = new ClaudeCodeAdapter();
   * if (await adapter.isInstalled()) {
   *   console.log("Claude Code is ready");
   * }
   * ```
   */
  async isInstalled(): Promise<boolean> {
    try {
      const proc = Bun.spawn(["which", this.binary], { stdout: "pipe", stderr: "pipe" });
      const code = await proc.exited;
      return code === 0;
    } catch {
      return false;
    }
  }

  /**
   * Build the CLI command array for a given run.
   *
   * Constructs the `claude` command with model, permissions, and prompt flags.
   * Used for dry-run display and debugging.
   *
   * @param options - Agent run options
   * @returns Command array suitable for Bun.spawn()
   *
   * @example
   * ```ts
   * const cmd = adapter.buildCommand({
   *   prompt: "Fix bug in auth.ts",
   *   workdir: "/project",
   *   modelTier: "fast",
   *   modelDef: { model: "claude-haiku-4.5", env: {} },
   *   timeoutSeconds: 300,
   * });
   * console.log(cmd.join(" "));
   * // ["claude", "--model", "claude-haiku-4.5", "--dangerously-skip-permissions", "-p", "Fix bug in auth.ts"]
   * ```
   */
  buildCommand(options: AgentRunOptions): string[] {
    const model = options.modelDef.model;
    return [
      this.binary,
      "--model", model,
      "--dangerously-skip-permissions",
      "-p", options.prompt,
    ];
  }

  /**
   * Run the Claude Code agent with automatic retry on transient failures.
   *
   * Retries up to 3 times with exponential backoff for rate limits and transient errors.
   * Captures stdout, stderr, exit code, duration, and cost estimate.
   *
   * @param options - Agent run configuration
   * @returns Agent execution result with success status, output, and cost
   * @throws Error if all 3 retry attempts fail
   *
   * @example
   * ```ts
   * const result = await adapter.run({
   *   prompt: "Implement feature X",
   *   workdir: "/project",
   *   modelTier: "balanced",
   *   modelDef: { model: "claude-sonnet-4.5", env: {} },
   *   timeoutSeconds: 600,
   * });
   *
   * if (result.success) {
   *   console.log(`Cost: $${result.estimatedCost.toFixed(4)}`);
   * } else if (result.rateLimited) {
   *   console.log("Rate limited after retries");
   * }
   * ```
   */
  async run(options: AgentRunOptions): Promise<AgentResult> {
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await this.runOnce(options, attempt);

        // If rate limited, retry with exponential backoff
        if (result.rateLimited && attempt < maxRetries) {
          const backoffMs = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
          console.warn(`Rate limited, retrying in ${backoffMs / 1000}s (attempt ${attempt}/${maxRetries})`);
          await Bun.sleep(backoffMs);
          continue;
        }

        // If transient error (non-zero exit but not timeout), retry with backoff
        if (!result.success && result.exitCode !== 124 && attempt < maxRetries) {
          const backoffMs = Math.pow(2, attempt) * 1000;
          console.warn(`Agent failed with exit code ${result.exitCode}, retrying in ${backoffMs / 1000}s (attempt ${attempt}/${maxRetries})`);
          await Bun.sleep(backoffMs);
          continue;
        }

        return result;
      } catch (error) {
        lastError = error as Error;
        if (attempt < maxRetries) {
          const backoffMs = Math.pow(2, attempt) * 1000;
          console.warn(`Agent error: ${lastError.message}, retrying in ${backoffMs / 1000}s (attempt ${attempt}/${maxRetries})`);
          await Bun.sleep(backoffMs);
        }
      }
    }

    // All retries failed
    throw lastError || new Error("Agent execution failed after all retries");
  }

  private async runOnce(options: AgentRunOptions, attempt: number): Promise<AgentResult> {
    const cmd = this.buildCommand(options);
    const startTime = Date.now();

    const proc = Bun.spawn(cmd, {
      cwd: options.workdir,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        ...options.modelDef.env,
        ...options.env,
      },
    });

    // Set up timeout
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
    }, options.timeoutSeconds * 1000);

    const exitCode = await proc.exited;
    clearTimeout(timeoutId);

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const durationMs = Date.now() - startTime;

    // Detect rate limiting from output
    const rateLimited =
      stderr.includes("rate limit") ||
      stderr.includes("429") ||
      stdout.includes("rate limit") ||
      stdout.includes("Too many requests");

    // Try to parse token usage from output, fallback to pessimistic duration-based estimate (BUG-3)
    const fullOutput = stdout + stderr;
    let costEstimate = estimateCostFromOutput(options.modelTier, fullOutput);
    if (!costEstimate) {
      // Fallback to conservative duration-based estimate if tokens not found
      // Use 1.5x multiplier to account for parsing uncertainty
      const fallbackEstimate = estimateCostByDuration(options.modelTier, durationMs);
      costEstimate = {
        cost: fallbackEstimate.cost * 1.5,
        confidence: 'fallback',
      };
      console.warn(`[nax] Cost estimation fallback (duration-based) for ${options.modelTier} tier: ${costEstimate.cost.toFixed(4)} USD`);
    } else if (costEstimate.confidence === 'estimated') {
      console.warn(`[nax] Cost estimation using regex parsing (estimated confidence): ${costEstimate.cost.toFixed(4)} USD`);
    }
    const cost = costEstimate.cost;

    // Exit code 124 indicates timeout (convention), use 143 for SIGTERM
    const actualExitCode = timedOut ? 124 : exitCode;

    return {
      success: exitCode === 0 && !timedOut,
      exitCode: actualExitCode,
      output: stdout.slice(-MAX_AGENT_OUTPUT_CHARS),
      rateLimited,
      durationMs,
      estimatedCost: cost,
    };
  }

  /**
   * Run Claude Code in plan mode to generate a feature specification.
   *
   * Uses the `--plan` flag to spawn Claude Code in planning mode.
   * In interactive mode, the agent takes over the terminal and can ask questions.
   * In non-interactive mode, reads from an input file.
   *
   * @param options - Plan mode configuration
   * @returns Generated specification content and conversation log
   * @throws Error if plan mode fails
   *
   * @example
   * ```ts
   * const adapter = new ClaudeCodeAdapter();
   * const result = await adapter.plan({
   *   prompt: "Add URL shortener with analytics",
   *   workdir: "/project",
   *   interactive: true,
   *   codebaseContext: "File tree:\nsrc/\n  index.ts\n",
   * });
   * console.log(result.specContent);
   * ```
   */
  async plan(options: PlanOptions): Promise<PlanResult> {
    const cmd = this.buildPlanCommand(options);

    if (options.interactive) {
      // Interactive mode: inherit stdio
      const proc = Bun.spawn(cmd, {
        cwd: options.workdir,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        env: { ...process.env, ...(options.modelDef?.env || {}) },
      });
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        throw new Error(`Plan mode failed with exit code ${exitCode}`);
      }
      return { specContent: "", conversationLog: "" };
    }

    // Non-interactive: redirect stdout to temp file via Bun.file()
    const { join } = require("node:path");
    const { mkdtempSync, readFileSync, rmSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const tempDir = mkdtempSync(join(tmpdir(), "nax-plan-"));
    const outFile = join(tempDir, "stdout.txt");
    const errFile = join(tempDir, "stderr.txt");

    try {
      const proc = Bun.spawn(cmd, {
        cwd: options.workdir,
        stdin: "ignore",
        stdout: Bun.file(outFile),
        stderr: Bun.file(errFile),
        env: { ...process.env, ...(options.modelDef?.env || {}) },
      });
      const exitCode = await proc.exited;

      const specContent = readFileSync(outFile, "utf-8");
      const conversationLog = readFileSync(errFile, "utf-8");

      if (exitCode !== 0) {
        throw new Error(`Plan mode failed with exit code ${exitCode}: ${conversationLog || "unknown error"}`);
      }

      return { specContent, conversationLog };
    } finally {
      try { rmSync(tempDir, { recursive: true }); } catch {}
    }
  }

      return { specContent, conversationLog };
    } finally {
      try { rmSync(tempDir, { recursive: true }); } catch {}
    }
  }

  /**
   * Build the CLI command for plan mode.
   *
   * @param options - Plan mode options
   * @returns Command array for spawning the plan process
   */
  private buildPlanCommand(options: PlanOptions): string[] {
    const cmd = [this.binary, "--permission-mode", "plan"];

    // Add model if specified
    if (options.modelDef) {
      cmd.push("--model", options.modelDef.model);
    }

    // Add dangerously-skip-permissions for automation
    cmd.push("--dangerously-skip-permissions");

    // Add prompt with codebase context and input file if available
    let fullPrompt = options.prompt;
    if (options.codebaseContext) {
      fullPrompt = `${options.codebaseContext}\n\n${options.prompt}`;
    }

    // For non-interactive mode, include input file content in the prompt
    if (options.inputFile) {
      try {
        const inputContent = require("node:fs").readFileSync(
          require("node:path").resolve(options.workdir, options.inputFile),
          "utf-8",
        );
        fullPrompt = `${fullPrompt}\n\n## Input Requirements\n\n${inputContent}`;
      } catch (error) {
        throw new Error(`Failed to read input file ${options.inputFile}: ${(error as Error).message}`);
      }
    }

    if (!options.interactive) {
      cmd.push("-p", fullPrompt);
    } else {
      // Interactive mode: pass prompt as initial message, agent will ask follow-ups
      cmd.push("-p", fullPrompt);
    }

    return cmd;
  }

  /**
   * Run Claude Code in decompose mode to break spec into classified stories.
   *
   * Spawns the agent with a structured prompt that combines spec decomposition
   * and story classification into a single LLM call. Returns decomposed stories
   * with complexity, relevant files, risks, and estimated LOC.
   *
   * @param options - Decompose mode configuration
   * @returns Decomposed and classified user stories
   * @throws Error if decompose fails or output parsing fails
   *
   * @example
   * ```ts
   * const adapter = new ClaudeCodeAdapter();
   * const result = await adapter.decompose({
   *   specContent: "# Feature: URL Shortener\n\n## Requirements...",
   *   workdir: "/project",
   *   codebaseContext: "File tree:\nsrc/\n  index.ts\n",
   *   modelTier: "balanced",
   * });
   * console.log(result.stories);
   * ```
   */
  async decompose(options: DecomposeOptions): Promise<DecomposeResult> {
    const prompt = this.buildDecomposePrompt(options);

    const cmd = [
      this.binary,
      "--model", options.modelDef?.model || "claude-sonnet-4-5",
      "--dangerously-skip-permissions",
      "-p", prompt,
    ];

    const proc = Bun.spawn(cmd, {
      cwd: options.workdir,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        ...(options.modelDef?.env || {}),
      },
    });

    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    if (exitCode !== 0) {
      throw new Error(`Decompose failed with exit code ${exitCode}: ${stderr}`);
    }

    // Parse JSON output from stdout
    const stories = this.parseDecomposeOutput(stdout);

    return { stories };
  }

  /**
   * Build the decompose prompt combining spec content and codebase context.
   *
   * @param options - Decompose options
   * @returns Formatted prompt string
   */
  private buildDecomposePrompt(options: DecomposeOptions): string {
    return `You are a requirements analyst. Break down the following feature specification into user stories and classify each story's complexity.

CODEBASE CONTEXT:
${options.codebaseContext}

FEATURE SPECIFICATION:
${options.specContent}

Decompose this spec into user stories. For each story, provide:
1. id: Story ID (e.g., "US-001")
2. title: Concise story title
3. description: What needs to be implemented
4. acceptanceCriteria: Array of testable criteria
5. tags: Array of routing tags (e.g., ["security", "api"])
6. dependencies: Array of story IDs this depends on (e.g., ["US-001"])
7. complexity: "simple" | "medium" | "complex" | "expert"
8. relevantFiles: Array of file paths this story will likely touch
9. reasoning: Why this complexity level
10. estimatedLOC: Estimated lines of code to change
11. risks: Array of implementation risks

Complexity classification rules:
- simple: 1-3 files, <100 LOC, straightforward implementation, existing patterns
- medium: 3-6 files, 100-300 LOC, moderate logic, some new patterns
- complex: 6+ files, 300-800 LOC, architectural changes, cross-cutting concerns
- expert: Security/crypto/real-time/distributed systems, >800 LOC, new infrastructure

Consider:
1. Does infrastructure exist? (e.g., "add caching" when no cache layer exists = complex)
2. How many files will be touched?
3. Are there cross-cutting concerns (auth, validation, error handling)?
4. Does it require new dependencies or architectural decisions?

Respond with ONLY a JSON array (no markdown code fences):
[{
  "id": "US-001",
  "title": "Story title",
  "description": "Story description",
  "acceptanceCriteria": ["Criterion 1", "Criterion 2"],
  "tags": ["tag1"],
  "dependencies": [],
  "complexity": "medium",
  "relevantFiles": ["src/path/to/file.ts"],
  "reasoning": "Why this complexity level",
  "estimatedLOC": 150,
  "risks": ["Risk 1"]
}]`;
  }

  /**
   * Parse decompose output from agent stdout.
   *
   * Extracts JSON array from output, handles markdown code fences,
   * and validates structure.
   *
   * @param output - Agent stdout
   * @returns Array of decomposed stories
   * @throws Error if parsing fails or output is invalid
   */
  private parseDecomposeOutput(output: string): DecomposedStory[] {
    // Extract JSON from output (handles markdown code fences)
    const jsonMatch = output.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/);
    let jsonText = jsonMatch ? jsonMatch[1] : output;

    // Try to find JSON array directly if no code fence
    if (!jsonMatch) {
      const arrayMatch = output.match(/\[[\s\S]*\]/);
      if (arrayMatch) {
        jsonText = arrayMatch[0];
      }
    }

    // Parse JSON
    let parsed: any;
    try {
      parsed = JSON.parse(jsonText.trim());
    } catch (error) {
      throw new Error(`Failed to parse decompose output as JSON: ${(error as Error).message}\n\nOutput:\n${output.slice(0, 500)}`);
    }

    // Validate structure
    if (!Array.isArray(parsed)) {
      throw new Error("Decompose output is not an array");
    }

    // Map to DecomposedStory[] with validation
    const stories: DecomposedStory[] = parsed.map((item: any, index: number) => {
      if (!item.id || typeof item.id !== "string") {
        throw new Error(`Story at index ${index} missing valid 'id' field`);
      }
      if (!item.title || typeof item.title !== "string") {
        throw new Error(`Story ${item.id} missing valid 'title' field`);
      }

      return {
        id: item.id,
        title: item.title,
        description: String(item.description || item.title),
        acceptanceCriteria: Array.isArray(item.acceptanceCriteria) ? item.acceptanceCriteria : ["Implementation complete"],
        tags: Array.isArray(item.tags) ? item.tags : [],
        dependencies: Array.isArray(item.dependencies) ? item.dependencies : [],
        complexity: this.validateComplexity(item.complexity),
        relevantFiles: Array.isArray(item.relevantFiles) ? item.relevantFiles : [],
        reasoning: String(item.reasoning || "No reasoning provided"),
        estimatedLOC: Number(item.estimatedLOC) || 0,
        risks: Array.isArray(item.risks) ? item.risks : [],
      };
    });

    if (stories.length === 0) {
      throw new Error("Decompose returned empty story array");
    }

    return stories;
  }

  /**
   * Validate complexity value from decompose output.
   *
   * @param value - Complexity value from agent
   * @returns Valid Complexity type
   */
  private validateComplexity(value: any): "simple" | "medium" | "complex" | "expert" {
    if (value === "simple" || value === "medium" || value === "complex" || value === "expert") {
      return value;
    }
    // Default to medium if invalid
    return "medium";
  }

  /**
   * Run Claude Code in interactive PTY mode for TUI embedding.
   *
   * Spawns the agent in a PTY (without -p flag) and provides a handle
   * for writing input, resizing, and killing the process. Agent output
   * is streamed via onOutput callback, and exit is signaled via onExit.
   *
   * @param options - Interactive run options with PTY callbacks
   * @returns PTY handle for input/resize/kill
   *
   * @example
   * ```ts
   * const adapter = new ClaudeCodeAdapter();
   * const handle = adapter.runInteractive({
   *   prompt: "Add tests for auth.ts",
   *   workdir: "/project",
   *   modelTier: "balanced",
   *   modelDef: { model: "claude-sonnet-4.5", env: {} },
   *   timeoutSeconds: 600,
   *   onOutput: (data) => appendToTuiBuffer(data),
   *   onExit: (code) => markStoryComplete(code),
   * });
   *
   * // Send user input to agent
   * handle.write("y\n");
   *
   * // Cleanup on TUI exit
   * handle.kill();
   * ```
   */
  runInteractive(options: InteractiveRunOptions): PtyHandle {
    // Lazy load node-pty
    let nodePty: typeof import("node-pty");
    try {
      nodePty = require("node-pty");
    } catch (error) {
      throw new Error(`node-pty not available: ${(error as Error).message}`);
    }

    // Build command without -p flag (interactive mode)
    const model = options.modelDef.model;
    const cmd = [
      this.binary,
      "--model", model,
      options.prompt,
    ];

    // Spawn in PTY mode
    const ptyProc = nodePty.spawn(cmd[0], cmd.slice(1), {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: options.workdir,
      env: {
        ...process.env,
        ...options.modelDef.env,
        ...options.env,
      },
    });

    // Stream output to callback
    ptyProc.onData((data) => {
      options.onOutput(Buffer.from(data));
    });

    // Handle exit
    ptyProc.onExit((event) => {
      options.onExit(event.exitCode);
    });

    // Return handle
    return {
      write: (data: string) => ptyProc.write(data),
      resize: (cols: number, rows: number) => ptyProc.resize(cols, rows),
      kill: () => ptyProc.kill(),
      pid: ptyProc.pid,
    };
  }
}
