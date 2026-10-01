/**
 * Base error class for nax and nax-agent. Lives in the move set (spec R2);
 * `src/errors.ts` re-exports it so every `instanceof NaxError` check matches
 * one class.
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
