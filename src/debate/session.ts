/**
 * DebateSession
 *
 * Orchestrates a multi-agent debate for a single pipeline stage.
 * Delegates one-shot, stateful, and plan execution to focused sub-modules.
 */

import type { NaxConfig } from "../config";
import { _debateSessionDeps } from "./session-helpers";
import { runHybrid } from "./session-hybrid";
import { runOneShot } from "./session-one-shot";
import { runPlan } from "./session-plan";
import { runStateful } from "./session-stateful";
import type { DebateResult, DebateStageConfig } from "./types";

// Re-export shared API so existing imports from "debate/session" continue to work.
export { _debateSessionDeps, resolveDebaterModel } from "./session-helpers";
export type { DebateSessionOptions } from "./session-helpers";

const DEFAULT_TIMEOUT_SECONDS = 600;

export class DebateSession {
  private readonly storyId: string;
  private readonly stage: string;
  private readonly stageConfig: DebateStageConfig;
  private readonly config: NaxConfig;
  private readonly workdir: string;
  private readonly featureName: string;
  private readonly timeoutSeconds: number;
  private get timeoutMs(): number {
    return this.timeoutSeconds * 1000;
  }

  constructor(opts: import("./session-helpers").DebateSessionOptions) {
    this.storyId = opts.storyId;
    this.stage = opts.stage;
    this.stageConfig = opts.stageConfig;
    this.config = opts.config;
    this.workdir = opts.workdir ?? process.cwd();
    this.featureName = opts.featureName ?? opts.stage;
    this.timeoutSeconds = opts.timeoutSeconds ?? opts.stageConfig.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  }

  async run(prompt: string): Promise<DebateResult> {
    const sessionMode = this.stageConfig.sessionMode ?? "one-shot";
    const mode = this.stageConfig.mode ?? "panel";

    // Route by mode
    if (mode === "hybrid") {
      if (sessionMode === "stateful") {
        return runHybrid(
          {
            storyId: this.storyId,
            stage: this.stage,
            stageConfig: this.stageConfig,
            config: this.config,
            workdir: this.workdir,
            featureName: this.featureName,
            timeoutSeconds: this.timeoutSeconds,
          },
          prompt,
        );
      }

      // Hybrid mode requires stateful session — fall back to one-shot with warning
      const logger = _debateSessionDeps.getSafeLogger();
      logger?.warn(
        "debate",
        `hybrid mode requires sessionMode: stateful, but got '${sessionMode}' — falling back to one-shot`,
      );

      return runOneShot(
        {
          storyId: this.storyId,
          stage: this.stage,
          stageConfig: this.stageConfig,
          config: this.config,
          timeoutMs: this.timeoutMs,
        },
        prompt,
      );
    }

    // Panel mode (default) — dispatch by sessionMode
    if (sessionMode === "stateful") {
      return runStateful(
        {
          storyId: this.storyId,
          stage: this.stage,
          stageConfig: this.stageConfig,
          config: this.config,
          workdir: this.workdir,
          featureName: this.featureName,
          timeoutSeconds: this.timeoutSeconds,
        },
        prompt,
      );
    }

    return runOneShot(
      {
        storyId: this.storyId,
        stage: this.stage,
        stageConfig: this.stageConfig,
        config: this.config,
        timeoutMs: this.timeoutMs,
      },
      prompt,
    );
  }

  /**
   * Run a plan-mode debate.
   *
   * Each debater calls adapter.plan() writing its PRD to a unique temp path under outputDir.
   * After all plans complete, the resolver picks the best PRD (or synthesises one).
   * Returns a DebateResult whose `output` field contains the winning PRD JSON string.
   *
   * @param basePrompt - Planning prompt WITHOUT a file-write instruction.
   * @param opts       - Plan options shared across all debaters.
   */
  async runPlan(
    basePrompt: string,
    opts: {
      workdir: string;
      feature: string;
      outputDir: string;
      timeoutSeconds?: number;
      dangerouslySkipPermissions?: boolean;
      maxInteractionTurns?: number;
    },
  ): Promise<DebateResult> {
    return runPlan(
      {
        storyId: this.storyId,
        stage: this.stage,
        stageConfig: this.stageConfig,
        config: this.config,
      },
      basePrompt,
      opts,
    );
  }
}
