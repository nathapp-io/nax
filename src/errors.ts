/**
 * Typed Error Classes for nax
 *
 * Replaces process.exit(1) patterns with structured errors that can be caught
 * and handled by the CLI layer or tests.
 */

/**
 * Base error class for all nax errors.
 */
export class NaxError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "NaxError";
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Agent not found or not installed.
 */
export class AgentNotFoundError extends NaxError {
  constructor(agentName: string, binary?: string) {
    super(`Agent "${agentName}" not found or not installed`, "AGENT_NOT_FOUND", { agentName, binary });
    this.name = "AgentNotFoundError";
  }
}

/**
 * Agent binary not in PATH.
 */
export class AgentNotInstalledError extends NaxError {
  constructor(agentName: string, binary: string) {
    super(`Agent "${agentName}" is not installed or not in PATH: ${binary}`, "AGENT_NOT_INSTALLED", {
      agentName,
      binary,
    });
    this.name = "AgentNotInstalledError";
  }
}

/**
 * Feature exceeds story limit.
 */
export class StoryLimitExceededError extends NaxError {
  constructor(totalStories: number, limit: number) {
    super(`Feature exceeds story limit: ${totalStories} stories (max: ${limit})`, "STORY_LIMIT_EXCEEDED", {
      totalStories,
      limit,
    });
    this.name = "StoryLimitExceededError";
  }
}

/**
 * Another nax process is already running.
 *
 * US-002: the refusal is shape-discriminated between the checkout lock and the
 * feature lock. Backwards-compatible shape preserved — `context` still carries
 * `workdir`. New `pid`/`host` describe the holder when available; `feature` +
 * `holderWorkdir` distinguish the feature-lock refusal.
 *
 * STUB: constructor accepts the new args shape so call sites and tests compile,
 * but still emits the single legacy message/context — the two distinguishable
 * message forms are the implementer's work.
 */
export class LockAcquisitionError extends NaxError {
  constructor(args: { workdir: string; pid?: number; host?: string; feature?: string; holderWorkdir?: string }) {
    super("Another nax process is already running in this directory", "LOCK_ACQUISITION_FAILED", {
      workdir: args.workdir,
    });
    this.name = "LockAcquisitionError";
  }
}
