/**
 * Claude Code Agent - Completion API
 *
 * Standalone completion endpoint for simple prompts.
 */

import type { CompleteOptions } from "./types";
import { CompleteError } from "./types";

/**
 * Injectable dependencies for complete() — allows tests to intercept
 * Bun.spawn calls and verify correct CLI args without the claude binary.
 *
 * @internal
 */
export const _completeDeps = {
  spawn(
    cmd: string[],
    opts: { stdout: "pipe"; stderr: "pipe" | "inherit" },
  ): { stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; exited: Promise<number>; pid: number } {
    return Bun.spawn(cmd, opts) as unknown as {
      stdout: ReadableStream<Uint8Array>;
      stderr: ReadableStream<Uint8Array>;
      exited: Promise<number>;
      pid: number;
    };
  },
};

/**
 * Execute a simple completion request without starting a full agent session.
 *
 * @param binary - Path to claude binary
 * @param prompt - Prompt text
 * @param options - Completion options (model, tokens, format)
 * @returns Completion text output
 * @throws CompleteError if execution fails
 */
export async function executeComplete(binary: string, prompt: string, options?: CompleteOptions): Promise<string> {
  const cmd = [binary, "-p", prompt];

  if (options?.model) {
    cmd.push("--model", options.model);
  }

  if (options?.maxTokens !== undefined) {
    cmd.push("--max-tokens", String(options.maxTokens));
  }

  if (options?.jsonMode) {
    cmd.push("--output-format", "json");
  }

  const proc = _completeDeps.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const exitCode = await proc.exited;

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const trimmed = stdout.trim();

  if (exitCode !== 0) {
    const errorDetails = stderr.trim() || trimmed;
    const errorMessage = errorDetails || `complete() failed with exit code ${exitCode}`;
    throw new CompleteError(errorMessage, exitCode);
  }

  if (!trimmed) {
    throw new CompleteError("complete() returned empty output");
  }

  return trimmed;
}
