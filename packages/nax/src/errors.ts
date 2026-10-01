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
 * Two distinguishable message forms:
 *   checkout: "Another nax process is already running in <workdir> (PID <pid> on <host>)"
 *   feature:  "Feature \"<feature>\" is locked by another run (PID <pid> on <host>, workdir <holderWorkdir>)"
 *
 * The feature refusal takes precedence whenever `feature` is supplied on the
 * args — callers acquire the checkout lock first, so by the time we know we
 * are emitting the feature refusal both locks may have been attempted.
 *
 * AC3 mandates the checkout message name the working directory; "in this
 * directory" alone would be an anaphoric reference, not a path.
 */
export class LockAcquisitionError extends NaxError {
  constructor(args: { workdir: string; pid?: number; host?: string; feature?: string; holderWorkdir?: string }) {
    const message = LockAcquisitionError.buildMessage(args);
    super(message, "LOCK_ACQUISITION_FAILED", LockAcquisitionError.buildContext(args));
    this.name = "LockAcquisitionError";
  }

  private static buildMessage(args: {
    workdir: string;
    pid?: number;
    host?: string;
    feature?: string;
    holderWorkdir?: string;
  }): string {
    if (args.feature !== undefined) {
      const holderHost = args.host ?? "?";
      const holderPid = args.pid ?? 0;
      const holderWorkdir = args.holderWorkdir ?? "?";
      return `Feature "${args.feature}" is locked by another run (PID ${holderPid} on ${holderHost}, workdir ${holderWorkdir})`;
    }
    const holderHost = args.host ?? "?";
    const holderPid = args.pid ?? 0;
    // AC3: the message must name the working directory — "in this directory"
    // is an anaphoric reference, not a path. Embed the workdir explicitly so
    // the refusal self-identifies where to investigate.
    return `Another nax process is already running in ${args.workdir} (PID ${holderPid} on ${holderHost})`;
  }

  private static buildContext(args: {
    workdir: string;
    pid?: number;
    host?: string;
    feature?: string;
    holderWorkdir?: string;
  }): Record<string, unknown> {
    const context: Record<string, unknown> = { workdir: args.workdir };
    if (args.pid !== undefined) context.pid = args.pid;
    if (args.host !== undefined) context.host = args.host;
    if (args.feature !== undefined) context.feature = args.feature;
    if (args.holderWorkdir !== undefined) context.holderWorkdir = args.holderWorkdir;
    return context;
  }
}
