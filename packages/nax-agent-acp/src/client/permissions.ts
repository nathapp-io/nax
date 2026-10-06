/**
 * session/request_permission by profile (S4 spec §6.4 layer 2). none and read
 * reject every request; full allows it; ask puts it in front of the caller through
 * asks.requestApproval and answer(). Only options the agent offered are chosen,
 * and only the *_once kinds: allow_always would outlive the session. Auto-decisions
 * are recorded with decidedBy "profile". Fail closed: a deny or deadline answers
 * reject_once; a turn abort, process death or ask-port failure answers
 * `cancelled`. Embedder tools never get here: they are pre-approved (S4-4).
 */
import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import type { AgentSessionProfile, SessionAskPort } from "@nathapp/nax-agent";
import { isRecord } from "#src/client/text";
import { describeToolCall, type ToolCallDisplay } from "#src/client/tool-display";

export const NO_ALLOW_ONCE_REASON = "agent offered no allow-once option";
export const UNSHOWABLE_REASON = "the request could not be shown safely";
export const ASK_REASON = "the ACP agent asks permission";
export const FULL_REASON = 'profile "full" allows every permission request';
export const UNKNOWN_PROFILE_REASON = "unknown profile";

export function readOnlyReason(profile: AgentSessionProfile): string {
  return `profile "${profile}" rejects every permission request`;
}

export interface PermissionContext {
  readonly profile: AgentSessionProfile;
  readonly asks: SessionAskPort;
  readonly secrets: readonly string[];
  /** Aborts when the turn's binding is released or the agent process exits (D3-d). */
  readonly signal: AbortSignal;
}

export interface OfferedOptions {
  readonly allowOnce?: string;
  readonly rejectOnce?: string;
}

function optionIdOf(options: readonly unknown[], kind: string): string | undefined {
  const found = options.find(
    (option) =>
      isRecord(option) && option.kind === kind && typeof option.optionId === "string" && option.optionId !== "",
  );
  return isRecord(found) && typeof found.optionId === "string" ? found.optionId : undefined;
}

export function offeredOptions(request: RequestPermissionRequest): OfferedOptions {
  const options: readonly unknown[] = Array.isArray(request.options) ? request.options : [];
  const allowOnce = optionIdOf(options, "allow_once");
  const rejectOnce = optionIdOf(options, "reject_once");
  return {
    ...(allowOnce === undefined ? {} : { allowOnce }),
    ...(rejectOnce === undefined ? {} : { rejectOnce }),
  };
}

const cancelled = (): RequestPermissionResponse => ({ outcome: { outcome: "cancelled" } });
const selected = (optionId: string): RequestPermissionResponse => ({ outcome: { outcome: "selected", optionId } });

/** A deny: the agent's reject_once, or `cancelled` when it offered none. */
export function rejectWith(offered: OfferedOptions): RequestPermissionResponse {
  return offered.rejectOnce === undefined ? cancelled() : selected(offered.rejectOnce);
}

/** The answer to a request outside the running turn (spec §6.3): a deny, never an event. */
export function rejectLocally(request: RequestPermissionRequest): RequestPermissionResponse {
  return rejectWith(offeredOptions(request));
}

type AutoDecide = (reason: string, decision: "allow" | "deny") => void;

function eventFields(display: ToolCallDisplay) {
  return {
    ...(display.callId === undefined ? {} : { callId: display.callId }),
    tool: display.tool,
    summary: display.summary,
  };
}

export async function decidePermission(
  request: RequestPermissionRequest,
  ctx: PermissionContext,
): Promise<RequestPermissionResponse> {
  // The turn was cancelled, timed out or lost its process: nothing is decided, no event (D3-d).
  if (ctx.signal.aborted) return cancelled();
  const offered = offeredOptions(request);
  const display = describeToolCall(request.toolCall, ctx.secrets);
  const auto: AutoDecide = (reason, decision) =>
    ctx.asks.recordAutoDecision({ ...eventFields(display), reason }, decision);
  switch (ctx.profile) {
    case "none":
    case "read":
      auto(readOnlyReason(ctx.profile), "deny");
      return rejectWith(offered);
    case "full":
      if (offered.allowOnce === undefined) return denyNoAllowOnce(offered, auto);
      auto(FULL_REASON, "allow");
      return selected(offered.allowOnce);
    case "ask":
      if (offered.allowOnce === undefined) return denyNoAllowOnce(offered, auto);
      if (!display.showable) {
        auto(UNSHOWABLE_REASON, "deny");
        return rejectWith(offered);
      }
      return askCaller(display, offered.allowOnce, offered, ctx);
    default:
      // A profile this build does not know: fail closed.
      auto(UNKNOWN_PROFILE_REASON, "deny");
      return rejectWith(offered);
  }
}

function denyNoAllowOnce(offered: OfferedOptions, auto: AutoDecide): RequestPermissionResponse {
  auto(NO_ALLOW_ONCE_REASON, "deny");
  return rejectWith(offered);
}

async function askCaller(
  display: ToolCallDisplay,
  allowOnce: string,
  offered: OfferedOptions,
  ctx: PermissionContext,
): Promise<RequestPermissionResponse> {
  try {
    const answer = await ctx.asks.requestApproval({
      ...eventFields(display),
      ...(display.command === undefined ? {} : { command: display.command }),
      reason: ASK_REASON,
      signal: ctx.signal,
    });
    if (answer.decision === "allow") return selected(allowOnce);
    return answer.decidedBy === "cancelled" ? cancelled() : rejectWith(offered);
  } catch {
    // The turn ended between routing and asking (the port's "no-turn"): fail closed (D3-f).
    return cancelled();
  }
}
