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
		super(
			`Agent "${agentName}" not found or not installed`,
			"AGENT_NOT_FOUND",
			{ agentName, binary },
		);
		this.name = "AgentNotFoundError";
	}
}

/**
 * Agent binary not in PATH.
 */
export class AgentNotInstalledError extends NaxError {
	constructor(agentName: string, binary: string) {
		super(
			`Agent "${agentName}" is not installed or not in PATH: ${binary}`,
			"AGENT_NOT_INSTALLED",
			{ agentName, binary },
		);
		this.name = "AgentNotInstalledError";
	}
}

/**
 * Feature exceeds story limit.
 */
export class StoryLimitExceededError extends NaxError {
	constructor(totalStories: number, limit: number) {
		super(
			`Feature exceeds story limit: ${totalStories} stories (max: ${limit})`,
			"STORY_LIMIT_EXCEEDED",
			{ totalStories, limit },
		);
		this.name = "StoryLimitExceededError";
	}
}

/**
 * Another nax process is already running.
 */
export class LockAcquisitionError extends NaxError {
	constructor(workdir: string) {
		super(
			"Another nax process is already running in this directory",
			"LOCK_ACQUISITION_FAILED",
			{ workdir },
		);
		this.name = "LockAcquisitionError";
	}
}
