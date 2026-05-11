import { ParseValidationError } from "../agents/retry";
import { debateConfigSelector } from "../config";
import type { DebateConfig } from "../config/selectors";
import type { FactsManifest } from "../debate/facts-manifest";
import { parseFactsManifest } from "../debate/facts-manifest";
import { NaxError } from "../errors";
import { getSafeLogger } from "../logger";
import { GrounderPromptBuilder } from "../prompts";
import { looksLikeTruncatedJson } from "../review/truncation";
import { parseLLMJson } from "../utils/llm-json";
import type { RunOperation } from "./types";

export interface GrounderInput {
  readonly specContent: string;
  readonly codebaseContext: string;
  readonly workdir: string;
}

function parseGrounderManifest(output: string): FactsManifest {
  let raw: unknown;
  try {
    raw = parseLLMJson(output);
  } catch {
    throw new NaxError("Grounder output failed schema validation: not valid JSON", "GROUNDER_PARSE_FAILED", {});
  }
  const result = parseFactsManifest(raw);
  if (!result.ok) {
    throw new NaxError(`Grounder output failed schema validation: ${result.error}`, "GROUNDER_PARSE_FAILED", {});
  }
  return result.manifest;
}

type GrounderFailureKind = "not-json" | "schema-invalid";

interface GrounderRetryInspection {
  readonly ok: boolean;
  readonly kind?: GrounderFailureKind;
  readonly message?: string;
  readonly usedNullOptionalField?: boolean;
}

function inspectGrounderOutput(output: string): GrounderRetryInspection {
  let raw: unknown;
  try {
    raw = parseLLMJson(output);
  } catch {
    return {
      ok: false,
      kind: "not-json",
      message: "Response was not valid JSON.",
      usedNullOptionalField: false,
    };
  }

  const result = parseFactsManifest(raw);
  if (result.ok) return { ok: true };

  return {
    ok: false,
    kind: "schema-invalid",
    message: buildGrounderSchemaMessage(result.error, raw),
    usedNullOptionalField: hasNullOptionalManifestField(raw),
  };
}

function hasNullOptionalManifestField(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;

  const manifest = raw as {
    specClaims?: Array<{ verification?: { factId?: unknown; evidence?: unknown } }>;
    gaps?: Array<{ evidence?: unknown }>;
  };

  const specClaims = manifest.specClaims ?? [];
  for (const claim of specClaims) {
    const verification = claim.verification;
    if (!verification) continue;
    if (verification.factId === null || verification.evidence === null) return true;
  }

  const gaps = manifest.gaps ?? [];
  for (const gap of gaps) {
    if (gap.evidence === null) return true;
  }

  return false;
}

function buildGrounderSchemaMessage(error: string, raw: unknown): string {
  const base = `Response was valid JSON but failed facts manifest schema validation: ${error}`;
  if (!hasNullOptionalManifestField(raw)) return base;
  return `${base} Optional fields must be omitted instead of set to null (for example verification.factId, verification.evidence, or gaps[].evidence).`;
}

function buildGrounderRetryPrompt(output: string, isTruncated: boolean): string {
  const inspection = inspectGrounderOutput(output);
  const reason =
    inspection.ok || !inspection.message
      ? "Response did not match the expected facts manifest schema."
      : isTruncated && inspection.kind === "not-json"
        ? `${inspection.message} The response also appears near the output cap and may be truncated.`
        : inspection.message;
  return GrounderPromptBuilder.jsonRepair(0, reason);
}

function createGrounderRetryStrategy(): NonNullable<RunOperation<GrounderInput, FactsManifest, DebateConfig>["retry"]> {
  return {
    shouldRetry(failure, attempt, ctx) {
      if (!(failure instanceof ParseValidationError)) return { retry: false };
      if (!ctx.lastOutput) return { retry: false };

      const inspection = inspectGrounderOutput(ctx.lastOutput);
      if (inspection.ok) return { retry: false };

      if (attempt >= 2) return { retry: false };

      const isTruncated = looksLikeTruncatedJson(ctx.lastOutput);
      const logger = getSafeLogger();

      if (inspection.kind === "not-json") {
        logger?.warn(
          "grounder",
          isTruncated ? "JSON parse retry — likely truncated" : "JSON parse retry — not valid JSON",
          {
            storyId: ctx.storyId,
            originalByteSize: ctx.lastOutput.length,
          },
        );
      } else {
        logger?.warn(
          "grounder",
          isTruncated
            ? "JSON parse retry — near output cap and invalid schema"
            : "JSON parse retry — valid JSON but invalid schema",
          {
            storyId: ctx.storyId,
            originalByteSize: ctx.lastOutput.length,
            schemaReason: inspection.message,
            usedNullOptionalField: inspection.usedNullOptionalField,
          },
        );
      }

      return {
        retry: true,
        delayMs: 0,
        nextPrompt: buildGrounderRetryPrompt(ctx.lastOutput, isTruncated),
      };
    },
  };
}

export const groundOp: RunOperation<GrounderInput, FactsManifest, DebateConfig> = {
  kind: "run",
  name: "ground",
  stage: "plan",
  session: { role: "grounder", lifetime: "fresh" },
  noFallback: true,
  config: debateConfigSelector,
  model: (_input, ctx) => ctx.config.debate?.grounder.model ?? "fast",
  timeoutMs: (_input, ctx) => (ctx.config.debate?.grounder.timeoutSeconds ?? 1800) * 1000,
  retry: createGrounderRetryStrategy(),
  hopBody: async (initialPrompt, ctx) => {
    const turn = await ctx.sendWithParseRetry(initialPrompt);
    parseGrounderManifest(turn.output);
    return turn;
  },
  build(input, _ctx) {
    return new GrounderPromptBuilder().build(input.specContent, input.codebaseContext, input.workdir);
  },
  parse(output, _input, _ctx) {
    return parseGrounderManifest(output);
  },
};
