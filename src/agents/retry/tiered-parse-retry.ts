import { getSafeLogger } from "@/logger";
import { looksLikeTruncatedJson } from "@/review";
import { ParseValidationError } from "./types";
import type { RetryStrategy } from "./types";

export interface TieredInspection<TKind extends string, TPartial = unknown> {
  readonly ok: boolean;
  readonly kind?: TKind;
  readonly message?: string;
  readonly partial?: TPartial;
}

export interface TieredParseRetryOpts<TOutput, TKind extends string, TPartial = unknown> {
  readonly reviewerKind: string;
  readonly maxAttempts: number;
  readonly inspect: (output: string) => TieredInspection<TKind, TPartial>;
  readonly buildRetryPrompt: (inspection: TieredInspection<TKind, TPartial>, isTruncated: boolean) => string;
  readonly exhaustedFallback: (inspection: TieredInspection<TKind, TPartial>, lastOutput: string) => TOutput;
  /** Injectable logger for testing. */
  readonly _logger?: { warn(kind: string, msg: string, data: Record<string, unknown>): void };
}

export function makeTieredParseRetryStrategy<TOutput, TKind extends string, TPartial = unknown>(
  opts: TieredParseRetryOpts<TOutput, TKind, TPartial>,
): RetryStrategy {
  return {
    shouldRetry(failure, attempt, ctx) {
      if (!(failure instanceof ParseValidationError)) return { retry: false };
      if (!ctx.lastOutput) return { retry: false };

      const inspection = opts.inspect(ctx.lastOutput);

      // Output is valid — no retry needed. Let op.parse() handle it.
      if (inspection.ok) return { retry: false };

      if (attempt >= opts.maxAttempts - 1) {
        return { retry: false, fallback: opts.exhaustedFallback(inspection, ctx.lastOutput) };
      }

      const isTruncated = looksLikeTruncatedJson(ctx.lastOutput);
      const logger = opts._logger ?? getSafeLogger();
      logger?.warn(opts.reviewerKind, `Parse retry — ${inspection.kind ?? "unknown"}`, {
        storyId: ctx.storyId,
        kind: inspection.kind,
        isTruncated,
        originalByteSize: ctx.lastOutput.length,
      });

      return { retry: true, delayMs: 0, nextPrompt: opts.buildRetryPrompt(inspection, isTruncated) };
    },
  };
}
