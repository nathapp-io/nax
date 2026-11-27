/**
 * The runtime's ONE decision about a full-network Bash call (US-002, #3053).
 *
 * `network: "full"` asks to leave the exposed session's network allowlist, so
 * the call runs OUTSIDE the OS sandbox — and the person who approves it has to
 * be told that. Before this module the runtime never decided it: `Bash` read
 * `fullNetwork.isExposed()` again at LAUNCH, so a call assessed while the
 * session was unexposed and approved after it became exposed launched unwrapped
 * with nobody told. Two reads of one mutable fact is the defect; the decision
 * is therefore taken here, once, before the policy, and carried on
 * `ToolRunContext.fullNetworkUnwrapped`.
 *
 * Lives beside `runtime.ts` rather than inside it because that file is at its
 * 600-line cap; its exports are the seam, so the two ask routes and the launch
 * cannot disagree about what was decided.
 */

import type { BashApprovalMode } from "#src/config/bash-approval";
import type { WebExposurePort } from "#src/session/agent-session-types";
import { UNSANDBOXED_PREFIX } from "./ask-request.ts";
import type { CodingTool } from "./registry.ts";
import type { CodingToolOutcome } from "./runtime.ts";
import { resolveUnsandboxedCall, type UnsandboxedCall } from "./runtime-calltool.ts";
import { resolveWebAwareAskOutcome } from "./runtime-web-guard.ts";
import { BASH_TOOL_NAME } from "./types.ts";

/**
 * The clause an ask carries when the runtime decided this call runs unwrapped
 * WITHOUT the model asking for an `unsandboxed` escape: the exposure made the
 * decision, and the approver is told the command leaves the sandbox. Composed
 * from the shared prefix so it reads exactly like `unsandboxedReasonSuffix`'s
 * clause.
 */
export const FULL_NETWORK_UNSANDBOXED_SUFFIX = `${UNSANDBOXED_PREFIX}full network requested`;

/**
 * Whether this call runs outside the sandbox BECAUSE it asked for the full
 * network under an exposed session.
 *
 * `Bash` only: `Exec` has no `network` input, so a RunCommand argv call can
 * never be routed here (the guard's own `network` row is `Bash`-only for the
 * same reason). The port answers `exposedNetwork()` only once the session has
 * read web content, and a port without it is a session that never opted into
 * the escape at all — both read as "not unwrapped".
 */
export function fullNetworkUnwrapped(
  identity: string,
  input: Record<string, unknown>,
  port: WebExposurePort | undefined,
): boolean {
  return identity === BASH_TOOL_NAME && input.network === "full" && port?.exposedNetwork?.() !== undefined;
}

/**
 * The spread every ask route receives: the escape clause for THIS call, when
 * there is one. Empty for an ordinary call, which is what keeps every existing
 * ask byte-identical.
 */
export type AskSandboxOption = { readonly unsandboxed?: { readonly suffix: string } };

/** What one call's sandbox answer is: the escape request, its clause, and the launch decision. */
export interface CallSandbox {
  /**
   * Exactly what `resolveUnsandboxedCall` answers today, `{ kind: "error" }`
   * included. Only this feeds `resolveAskVerdict` and the pre-policy refusal —
   * so an explicit `unsandboxed: true` keeps its allow-to-ask conversion, and a
   * full-network call (which is never an `UnsandboxedCall`) never gets one.
   */
  readonly call?: UnsandboxedCall;
  /** The escape clause to spread onto every ask this call can raise. */
  readonly askOption: AskSandboxOption;
  /** The launch decision `Bash` reads from its run context. */
  readonly fullNetworkUnwrapped: boolean;
}

/**
 * The clause an ask carries, in the order the two escapes rank: an explicit
 * `unsandboxed: true` names the model's own reason, a full-network call names
 * the exposure's decision. Neither applies → nothing to spread.
 */
function sandboxOption(call: UnsandboxedCall | undefined, full: boolean): AskSandboxOption {
  if (call?.kind === "unsandboxed") return { unsandboxed: { suffix: call.suffix } };
  if (full) return { unsandboxed: { suffix: FULL_NETWORK_UNSANDBOXED_SUFFIX } };
  return {};
}

/**
 * `callTool`'s sandbox decision, read ONCE before the policy loop.
 *
 * Split out of the call site (§ "Lives beside runtime.ts") so the decision and
 * the clause computed from it are one value: a route that wasn't handed the
 * decision or that re-read the port would be the defect this story fixes.
 */
export function resolveCallSandbox(p: {
  readonly identity: string;
  readonly tool: CodingTool;
  readonly input: Record<string, unknown>;
  readonly opts: {
    readonly unsandboxed?: {
      readonly enabled: boolean;
      readonly bashApproval: BashApprovalMode;
      readonly alwaysAsk?: boolean;
    };
    readonly webExposure?: WebExposurePort;
  };
}): CallSandbox {
  const call = resolveUnsandboxedCall({
    identity: p.identity,
    tool: p.tool,
    input: p.input,
    option: p.opts.unsandboxed,
  });
  const full = fullNetworkUnwrapped(p.identity, p.input, p.opts.webExposure);
  return {
    ...(call !== undefined ? { call } : {}),
    askOption: sandboxOption(call, full),
    fullNetworkUnwrapped: full,
  };
}

/**
 * The policy-ask route: the exposure guard's assessment folded into the ask the
 * policy already raised, with this call's escape clause spread on.
 *
 * A plain pass-through on purpose — it exists so `runtime.ts` (at its 600-line
 * cap) can keep one ask branch while every route receives the same option.
 */
export function askThroughGuard(
  p: Parameters<typeof resolveWebAwareAskOutcome>[0] & { readonly askOption: AskSandboxOption },
): Promise<CodingToolOutcome> {
  const { askOption, ...route } = p;
  return resolveWebAwareAskOutcome({ ...route, ...askOption });
}
