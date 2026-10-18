/**
 * session/request_permission by profile (S4 spec §6.4 layer 2). none and read
 * reject every request; review allows commands (kind execute) only when a
 * sandbox policy is present (fail closed) or an operator Bash rule allows the
 * command itself (shell-rules.ts, SPEC-cursor-pi-acp-read-only US-003), and
 * rejects the rest; under review and full a sandbox network request follows the sandbox
 * network policy (open: allow, allow-list: deny); full allows it; ask puts it in front of the caller through
 * asks.requestApproval and answer(). Only options the agent offered are chosen,
 * and only the *_once kinds: allow_always would outlive the session. Auto-decisions
 * are recorded with decidedBy "profile". Fail closed: a deny or deadline answers
 * reject_once; a turn abort, process death or ask-port failure answers
 * `cancelled`. Embedder tools are pre-approved at the adapter (S4-4), so they are
 * normally never asked about; if an agent asks anyway, the request is decided
 * like any other, because its title is display data (S4-4 D4-c).
 */
import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import type { AgentSessionProfile, SandboxPolicy, SessionAskPort } from "@nathapp/nax-agent";
import { editTargets, firstOutsidePolicy, OUTSIDE_WRITE_ROOTS_REASON, WRITE_KINDS } from "#src/client/edit-targets";
import { type AcpPermissionRules, NO_RULES } from "#src/client/rule-policy";
import { SHELL_RULE_REASON, shellCommandOf, shellRuleBlocks, shellRuleVerdict } from "#src/client/shell-rules";
import { isSandboxWrapped } from "#src/client/shell-sandbox";
import { isRecord } from "#src/client/text";
import { describeToolCall, type ToolCallDisplay } from "#src/client/tool-display";

export const NO_ALLOW_ONCE_REASON = "agent offered no allow-once option";
export const UNSHOWABLE_REASON = "the request could not be shown safely";
export const ASK_REASON = "the ACP agent asks permission";
export const FULL_REASON = 'profile "full" allows every permission request';
export const UNKNOWN_PROFILE_REASON = "unknown profile";
export const REVIEW_EXECUTE_REASON = 'profile "review" allows commands';
export const REVIEW_NO_SANDBOX_REASON = 'profile "review" runs commands only inside the sandbox';
export const REVIEW_UNWRAPPED_REASON = "the command did not arrive in nax's sandbox wrapper";
export const SHELL_RULE_BLOCKED_REASON = 'a "Bash" deny or ask rule matches the command';
export const NETWORK_OPEN_REASON = "the sandbox network is open";
export const NETWORK_LISTED_REASON = "the sandbox network is an allow-list";
/** claude-agent-acp 0.85.1 surfaces the SDK's sandbox network callback as a tool call titled with its tool name. */
const NETWORK_TOOL_TITLE = "SandboxNetworkAccess";

export function isNetworkRequest(toolCall: unknown): boolean {
  // title is agent-controlled display data: require the kind it renders with (absent or "other") too.
  return (
    isRecord(toolCall) &&
    toolCall.title === NETWORK_TOOL_TITLE &&
    (toolCall.kind === undefined || toolCall.kind === null || toolCall.kind === "other")
  );
}

export function readOnlyReason(profile: AgentSessionProfile): string {
  return `profile "${profile}" rejects every permission request`;
}

export interface PermissionContext {
  readonly profile: AgentSessionProfile;
  readonly asks: SessionAskPort;
  readonly secrets: readonly string[];
  /** Aborts when the turn's binding is released or the agent process exits (D3-d). */
  readonly signal: AbortSignal;
  /** nax#2500: the session sandbox policy (review/full on claude); drives the network and R4 path rules. */
  readonly sandbox?: SandboxPolicy;
  /** nax#2500: the session cwd, for resolving relative edit targets (R4). */
  readonly cwd?: string;
  /**
   * The ACP agent's name (US-003): which raw field carries a shell command. Absent
   * reads `rawInput.command`, the field every agent but pi and Cursor uses.
   */
  readonly agentName?: string;
  /** nax's rules for this stage (US-003). Absent: no Bash rule allows anything. */
  readonly rules?: AcpPermissionRules;
  readonly shellSandbox?: { prefix: string; verify: boolean; onUnwrapped: "rules" | "deny" };
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

/** A deny: `cancelled`, or a selected option the agent offered as a reject kind (nax#2582). */
export function isDenial(request: RequestPermissionRequest, response: RequestPermissionResponse): boolean {
  if (response.outcome.outcome === "cancelled") return true;
  const { optionId } = response.outcome;
  const options: readonly unknown[] = Array.isArray(request.options) ? request.options : [];
  const chosen = options.find((option) => isRecord(option) && option.optionId === optionId);
  return isRecord(chosen) && (chosen.kind === "reject_once" || chosen.kind === "reject_always");
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
  if (
    (ctx.profile === "review" || ctx.profile === "full") &&
    ctx.sandbox !== undefined &&
    isNetworkRequest(request.toolCall)
  ) {
    return decideNetwork(ctx.sandbox, offered, auto);
  }
  switch (ctx.profile) {
    case "none":
    case "read":
      auto(readOnlyReason(ctx.profile), "deny");
      return rejectWith(offered);
    case "review":
      return decideReview(request, display, offered, auto, ctx);
    case "full":
      return decideFull(request, display, offered, auto, ctx);
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

/**
 * review (SPEC-cursor-pi-acp-read-only US-003): a command may run when a sandbox
 * holds it (Claude, nax#2500) or when the operator's own Bash rules allow the
 * raw command. With no sandbox the rules are the whole decision — a command nax
 * cannot read, a redirect, an opaque token, no allow rule, or an ask rule all
 * deny — and everything that is not a command stays read-only.
 */
function decideReview(
  request: RequestPermissionRequest,
  display: ToolCallDisplay,
  offered: OfferedOptions,
  auto: AutoDecide,
  ctx: PermissionContext,
): RequestPermissionResponse {
  if (ctx.shellSandbox !== undefined) return decideSandboxedShell(request, display, offered, auto, ctx);
  if (ctx.sandbox !== undefined) {
    if (display.tool !== "execute") {
      auto(readOnlyReason(ctx.profile), "deny");
      return rejectWith(offered);
    }
    if (offered.allowOnce === undefined) return denyNoAllowOnce(offered, auto);
    auto(REVIEW_EXECUTE_REASON, "allow");
    return selected(offered.allowOnce);
  }
  const command = shellCommandOf(ctx.agentName ?? "", request.toolCall);
  if (command === undefined) {
    // An execute request with no derivable command fails closed; anything else was never a command.
    auto(display.tool === "execute" ? REVIEW_NO_SANDBOX_REASON : readOnlyReason(ctx.profile), "deny");
    return rejectWith(offered);
  }
  if (shellRuleVerdict(command, ctx.rules ?? NO_RULES) === "deny") {
    auto(REVIEW_NO_SANDBOX_REASON, "deny");
    return rejectWith(offered);
  }
  if (offered.allowOnce === undefined) return denyNoAllowOnce(offered, auto);
  auto(SHELL_RULE_REASON, "allow");
  return selected(offered.allowOnce);
}

/** Shell sandbox approvals precede the legacy sandbox/rule-only paths. */
export function decideSandboxedShell(
  request: RequestPermissionRequest,
  display: ToolCallDisplay,
  offered: OfferedOptions,
  auto: AutoDecide,
  ctx: PermissionContext,
): RequestPermissionResponse {
  const plan = ctx.shellSandbox;
  const command = shellCommandOf(ctx.agentName ?? "", request.toolCall);
  const deny = (reason: string): RequestPermissionResponse => {
    auto(reason, "deny");
    return rejectWith(offered);
  };
  if (command === undefined) {
    return deny(display.tool === "execute" ? REVIEW_NO_SANDBOX_REASON : readOnlyReason(ctx.profile));
  }
  if (offered.allowOnce === undefined) return denyNoAllowOnce(offered, auto);
  const wrapped = plan !== undefined && isSandboxWrapped(plan.prefix, command);
  // The verifier guarantees one quoted word; decode only its POSIX apostrophe escapes.
  const inner = wrapped && plan?.verify ? command.slice(plan.prefix.length + 1, -1).replaceAll("'\\''", "'") : command;
  if (shellRuleBlocks(inner, ctx.rules ?? NO_RULES)) return deny(SHELL_RULE_BLOCKED_REASON);
  if (plan !== undefined && (!plan.verify || wrapped)) {
    auto(REVIEW_EXECUTE_REASON, "allow");
    return selected(offered.allowOnce);
  }
  if (plan?.onUnwrapped === "deny") return deny(REVIEW_UNWRAPPED_REASON);
  if (shellRuleVerdict(command, ctx.rules ?? NO_RULES) === "deny") return deny(REVIEW_NO_SANDBOX_REASON);
  auto(SHELL_RULE_REASON, "allow");
  return selected(offered.allowOnce);
}

/**
 * ACP kinds exempt from the R4 path check (nax#2500 R5/R8): they do not write a path
 * the sandbox has to police. execute is the Bash sandbox's job. Every other kind,
 * including `other` and any unknown kind, is path-checked (fail closed).
 */
const READ_ONLY_KINDS: ReadonlySet<string> = new Set(["read", "search", "think", "fetch", "switch_mode"]);

/** full allows every request, except (nax#2500 R4/R5) a write whose target is outside the sandbox write roots. */
async function decideFull(
  request: RequestPermissionRequest,
  display: ToolCallDisplay,
  offered: OfferedOptions,
  auto: AutoDecide,
  ctx: PermissionContext,
): Promise<RequestPermissionResponse> {
  if (offered.allowOnce === undefined) return denyNoAllowOnce(offered, auto);
  const targets = editTargets(request.toolCall);
  const unknownWrite = ctx.sandbox !== undefined && WRITE_KINDS.has(display.tool) && targets.length === 0;
  const outside =
    ctx.sandbox !== undefined && display.tool !== "execute" && !READ_ONLY_KINDS.has(display.tool)
      ? await firstOutsidePolicy(targets, ctx.sandbox, ctx.cwd)
      : undefined;
  if (unknownWrite || outside !== undefined) {
    auto(OUTSIDE_WRITE_ROOTS_REASON, "deny");
    return rejectWith(offered);
  }
  auto(FULL_REASON, "allow");
  return selected(offered.allowOnce);
}

function decideNetwork(policy: SandboxPolicy, offered: OfferedOptions, auto: AutoDecide): RequestPermissionResponse {
  if (policy.network.allowedDomains !== undefined) {
    auto(NETWORK_LISTED_REASON, "deny");
    return rejectWith(offered);
  }
  if (offered.allowOnce === undefined) return denyNoAllowOnce(offered, auto);
  auto(NETWORK_OPEN_REASON, "allow");
  return selected(offered.allowOnce);
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
