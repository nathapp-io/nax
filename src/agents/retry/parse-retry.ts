import type { AdapterFailure } from "../../context/engine";
import { getSafeLogger } from "../../logger";
import { looksLikeTruncatedJson } from "../../review/truncation";
import { tryParseLLMJson } from "../../utils/llm-json";
import { ParseValidationError } from "./types";
import type { RetryContext, RetryDecision, RetryStrategy } from "./types";

export interface ParseRetryOpts {
  readonly validate: (parsed: unknown) => boolean;
  readonly reviewerKind: string;
  readonly maxAttempts?: number;
  readonly prompts: {
    readonly invalid: () => string;
    readonly truncated: () => string;
  };
  readonly parse?: (output: string) => unknown;
  readonly looksTruncated?: (output: string) => boolean;
  /** Called when all retry attempts are exhausted — its return value is surfaced as RetryDecision.fallback. */
  readonly exhaustedFallback?: (lastOutput: string) => unknown;
  /**
   * Extra fields merged into every warn log call (e.g. `{ blockingThreshold: "error" }`).
   * `storyId` and `originalByteSize` are always present; fields here are appended after them.
   */
  readonly logContext?: Record<string, unknown>;
  /**
   * When set, the warn log includes an `outputPreview` field — the first N bytes
   * of the unparseable agent output (whitespace-collapsed). Without this, only
   * `originalByteSize` is logged and the actual content is invisible in the run
   * log, forcing a manual cross-reference against the prompt-audit files. Opt-in
   * because some reviewers emit large or sensitive payloads. Off by default.
   */
  readonly outputPreviewBytes?: number;
  /** Injectable logger for testing. */
  readonly _logger?: { warn(kind: string, msg: string, data: Record<string, unknown>): void };
}

/** Collapse whitespace and clip to `maxBytes` so the preview stays a single, log-friendly line. */
function previewOutput(output: string, maxBytes: number): string {
  const collapsed = output.replace(/\s+/g, " ").trim();
  return collapsed.length > maxBytes ? `${collapsed.slice(0, maxBytes)}…` : collapsed;
}

export function makeParseRetryStrategy(opts: ParseRetryOpts): RetryStrategy {
  const parse = opts.parse ?? tryParseLLMJson;
  const checkTruncated = opts.looksTruncated ?? looksLikeTruncatedJson;
  const maxAttempts = opts.maxAttempts ?? 2;

  return {
    shouldRetry(failure: AdapterFailure | Error, attempt: number, ctx: RetryContext): RetryDecision {
      if (!(failure instanceof ParseValidationError)) {
        return { retry: false };
      }

      if (!ctx.lastOutput) {
        if (ctx.site === "complete") {
          getSafeLogger()?.warn(
            opts.reviewerKind,
            "makeParseRetryStrategy: lastOutput is not populated on complete-kind ops — retry will never fire",
            { storyId: ctx.storyId },
          );
        }
        // Empty output: if exhaustedFallback is declared, surface it so callOp can
        // return a safe degraded value rather than throwing CALL_OP_NO_OUTPUT.
        //
        // For run-kind ops this branch is only reached after sendWithFileOutput in
        // call.ts synthesizes a fail-stale AdapterFailure for empty/whitespace output —
        // the manager-tier retry/swap runs first (via the `adapterFailure` signal), and
        // only after exhaustion does the hop body exit with rawOutput="", which then
        // triggers callOp's `!rawOutput` guard. The fallback captured here is what
        // callOp reads from retryFallback at that point.
        const fallback = opts.exhaustedFallback ? opts.exhaustedFallback("") : undefined;
        return { retry: false, ...(fallback !== undefined ? { fallback } : {}) };
      }

      let parsed: unknown;
      try {
        parsed = parse(ctx.lastOutput);
      } catch {
        parsed = null;
      }

      if (parsed != null && opts.validate(parsed)) {
        return { retry: false };
      }

      if (attempt >= maxAttempts - 1) {
        const fallback = opts.exhaustedFallback ? opts.exhaustedFallback(ctx.lastOutput) : undefined;
        return { retry: false, ...(fallback !== undefined ? { fallback } : {}) };
      }

      const isTruncated = checkTruncated(ctx.lastOutput);
      const nextPrompt = isTruncated ? opts.prompts.truncated() : opts.prompts.invalid();

      const logger = opts._logger ?? getSafeLogger();
      const preview =
        opts.outputPreviewBytes && opts.outputPreviewBytes > 0
          ? { outputPreview: previewOutput(ctx.lastOutput, opts.outputPreviewBytes) }
          : {};
      if (isTruncated) {
        logger?.warn(opts.reviewerKind, "JSON parse retry — likely truncated", {
          storyId: ctx.storyId,
          originalByteSize: ctx.lastOutput.length,
          ...preview,
          ...opts.logContext,
        });
      } else {
        logger?.warn(opts.reviewerKind, "JSON parse retry — invalid shape", {
          storyId: ctx.storyId,
          originalByteSize: ctx.lastOutput.length,
          ...preview,
          ...opts.logContext,
        });
      }

      return { retry: true, delayMs: 0, nextPrompt };
    },
  };
}
