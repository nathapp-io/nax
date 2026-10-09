/**
 * nativeBackend's options (S4 spec 5.2): the native half of the facade's
 * createAgentSession options, validated here rather than by the facade. zod
 * checks the shape; the caller's own object is kept as `raw` (zod returns
 * copies, which would break identity for handlers the caller owns).
 */
import { z } from "zod";
import type { BashApprovalMode } from "#src/config/bash-approval";
import type { NativeCatalogOverrides } from "#src/native/client";
import type { CredentialSource } from "#src/native/credentials/session-source";
import { parseNativeModel } from "#src/native/models";
import { isInstructionFileName } from "#src/native/session/instruction-file-name";
import type { LoopHandlerSet } from "#src/native/session/loop-events/types";
import { AgentSessionError } from "./agent-session-errors.ts";
import type { AgentSessionHostPorts, AgentSessionProfile } from "./agent-session-types.ts";

export interface NativeBackendOptions {
  readonly model: string;
  /** Repository instruction basename; defaults to AGENTS.md. */
  readonly instructionFileName?: string;
  readonly credentials?: CredentialSource;
  readonly catalogOverrides?: NativeCatalogOverrides;
  readonly loopHandlers?: LoopHandlerSet;
  readonly hostPorts?: AgentSessionHostPorts;
  readonly bashApproval?: BashApprovalMode;
  readonly allowUnsandboxed?: boolean;
  /** Keep a resumed or continued conversation when the model differs (ACP server model switch, S5-3). */
  readonly carryHistoryAcrossModels?: boolean;
}

export interface ResolvedNativeOptions {
  /** The caller's object, unchanged. */
  readonly raw: NativeBackendOptions;
  readonly provider: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasMethods(names: readonly string[]): (value: unknown) => boolean {
  return (value) => isRecord(value) && names.every((name) => typeof value[name] === "function");
}

const isStringArray = (value: unknown): boolean =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const OptionsSchema = z.strictObject({
  model: z.string().min(1),
  instructionFileName: z
    .string()
    .refine(
      isInstructionFileName,
      "must be a nonhidden Markdown basename without path separators, colon or control characters",
    )
    .optional(),
  credentials: z
    .custom(
      (value) => isRecord(value) && (value.kind === "memory" || value.kind === "exec"),
      "must be a memory or exec source",
    )
    .optional(),
  catalogOverrides: z.array(z.custom(isRecord, "must be a catalog override object")).optional(),
  loopHandlers: z.array(z.custom(isRecord, "must be a loop handler entry")).optional(),
  hostPorts: z
    .strictObject({
      protectedPaths: z
        .custom(
          (value) =>
            isRecord(value) && isStringArray(value.gitExcludePathspecs) && isStringArray(value.gitIgnorePatterns),
          "must be a protected-paths policy with gitExcludePathspecs and gitIgnorePatterns string arrays",
        )
        .optional(),
      commandInterceptor: z.custom(hasMethods(["intercept"]), "must implement intercept").optional(),
    })
    .optional(),
  bashApproval: z.enum(["raw", "gated", "escalate"]).optional(),
  allowUnsandboxed: z.boolean().optional(),
  carryHistoryAcrossModels: z.boolean().optional(),
});

function invalid(message: string, context: Record<string, unknown> = {}): AgentSessionError {
  return new AgentSessionError(`Invalid agent session options: ${message}`, "AGENT_SESSION_INVALID_OPTIONS", context);
}

function checkShape(input: unknown): NativeBackendOptions {
  if (isRecord(input) && isRecord(input.hostPorts) && "runDeclaredCommand" in input.hostPorts) {
    throw invalid("hostPorts.runDeclaredCommand is deferred to a later release", {
      path: "backend.hostPorts.runDeclaredCommand",
    });
  }
  const parsed = OptionsSchema.safeParse(input);
  if (parsed.success) return input as NativeBackendOptions;
  const issue = parsed.error.issues[0];
  const path = issue === undefined || issue.path.length === 0 ? "backend" : `backend.${issue.path.join(".")}`;
  throw invalid(`${path}: ${issue?.message ?? "invalid"}`, { path });
}

function providerOf(model: string): string {
  try {
    return parseNativeModel(model).provider;
  } catch {
    throw invalid(`model: "${model}" is not "provider/model[effort]"`, { path: "backend.model" });
  }
}

export function parseNativeBackendOptions(input: unknown): ResolvedNativeOptions {
  const options = checkShape(input);
  return { raw: options, provider: providerOf(options.model) };
}

export function nativeProfileRules(
  profile: AgentSessionProfile,
  raw: NativeBackendOptions,
): { readonly bashApproval: BashApprovalMode; readonly allowUnsandboxed: boolean } {
  const tools = profile === "full" || profile === "ask";
  if (!tools && raw.bashApproval !== undefined) {
    throw invalid('bashApproval applies to profiles "ask" and "full" only', { path: "backend.bashApproval" });
  }
  if (!tools && raw.allowUnsandboxed !== undefined) {
    throw invalid('allowUnsandboxed applies to profiles "ask" and "full" only', { path: "backend.allowUnsandboxed" });
  }
  const bashApproval = raw.bashApproval ?? "gated";
  if (profile === "ask" && bashApproval !== "gated") {
    throw invalid('profile "ask" requires bashApproval "gated" (other modes run Bash without asking)', {
      path: "backend.bashApproval",
    });
  }
  if (raw.allowUnsandboxed === true && bashApproval !== "gated") {
    throw invalid('allowUnsandboxed requires bashApproval "gated"', { path: "backend.allowUnsandboxed" });
  }
  return { bashApproval, allowUnsandboxed: raw.allowUnsandboxed === true };
}
