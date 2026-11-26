/**
 * The exposure guard: the posture a chat session pays for having read the web.
 *
 * A session that has read a web page may have read text an attacker wrote, and an instruction
 * planted in that text could ask for the few actions that turn "read a page" into "exfiltrate or
 * push". So once `exposure.isExposed()` is true, `assess` answers a `{ rule: "web-exposure",
 * reason }` decision for the shapes in the stop table, and the caller turns that decision into one
 * ask before the tool runs (US-012). Before exposure it answers nothing at all: the guard adds no
 * ask to a session that has not read anything, and the posture it had is the posture it keeps.
 *
 * Every row is a conservative shape test, not a proof of intent:
 *  - a `git push` anywhere in a Bash command, deliberately broad -- `git log --grep push` and
 *    `git commit -m "push"` fire it too, and a false positive costs exactly one ask. What it
 *    cannot see is a push hidden inside a script, an alias or another program, which the user
 *    accepted as a known limit (US-011 scope).
 *  - `network: "full"` (the Bash input US-013 adds): the one call that asks to leave the exposed
 *    session's network allowlist.
 *  - `unsandboxed: true`, and any command run with the sandbox already off: after exposure both
 *    mean "outside the filesystem and network fences", so both ask. There is no read-only command
 *    list to exempt the harmless ones with, and asking every time is the accepted cost.
 *  - a `web__fetch` of a URL the session has not been shown: an injected instruction must not be
 *    able to steer the session to an attacker's host in one step.
 *
 * There is deliberately NO row for a write outside the repository root: the tool policy already
 * denies every `Write`, `Edit` and `Delete` path outside the policy root in every mode
 * (`resolveWithin`, `tools/policy-paths-branch.ts`), so such a call never reaches this guard.
 *
 * The guard is deterministic and synchronous: same call, same exposure, same answer. It reads no
 * clock, no config and no cost data, which is what lets a caller ask it on every allowed call.
 */

import { namespacedToolName } from "#src/tools/provider-adapt";
import { BASH_TOOL_NAME, EXEC_TOOL_NAME } from "#src/tools/types";
import { normalizeWebUrl } from "./content.ts";
import type { WebExposure } from "./exposure.ts";
import { WEB_FETCH_TOOL, WEB_PROVIDER_ID } from "./provider.ts";

/** One call the guard is asked about, in the only terms its decisions need. */
export interface WebCallAssessment {
  /** The call name the runtime routed: `Bash`, `Exec`, `web__fetch`, ... */
  readonly tool: string;
  /** The call's own arguments, read field by field -- never the schema's defaulted shape. */
  readonly input: Record<string, unknown>;
  /** The policy root the call runs against. */
  readonly root: string;
  /** The paths the policy resolved for this call, as `resolveWithin` returned them. */
  readonly resolvedPaths: readonly string[];
  /** Whether this call will run inside the sandbox; false only when it is switched off. */
  readonly sandboxed: boolean;
}

/** What the guard answers for a call that has to ask first. */
export interface WebGuardDecision {
  /** The rule id the ask carries, so a reader can see which guard raised it. */
  readonly rule: "web-exposure";
  /** The sentence the person is asked with. */
  readonly reason: string;
}

/** The guard one chat session owns: built once, asked before every allowed call. */
export interface WebExposureGuard {
  /** The decision this call must ask for, or undefined when the call runs as it would have. */
  assess(call: WebCallAssessment): WebGuardDecision | undefined;
  /** The process-wide network ceiling after exposure; undefined beforehand. */
  exposedNetwork(): readonly string[] | undefined;
  /** Notify once on exposure (immediately if already exposed). */
  onExposed(listener: () => void): () => void;
}

/** What the guard is built from. */
export interface WebExposureGuardOptions {
  /** The session's exposure state, shared with the web tools rather than copied. */
  readonly exposure: WebExposure;
  /** The hosts an exposed session's sandbox keeps reachable (US-013 reads this). */
  readonly exposedAllowedDomains: readonly string[];
  /** The configured allowed domains, or undefined when the user set none (US-013 reads this). */
  readonly configuredAllowedDomains: readonly string[] | undefined;
}

/** The reason each row of the stop table answers with. */
const GIT_PUSH_REASON = "git push after this session read web content";
const FULL_NETWORK_REASON = "full network after this session read web content";
const UNSANDBOXED_REASON = "running outside the sandbox after this session read web content";
const SANDBOX_OFF_REASON = "the sandbox is off and this session read web content";
const UNSEEN_URL_REASON = "fetching a URL this session has not seen";

/**
 * A `git push` in one shell segment. `[^\n;&|]` keeps the match inside a single segment, so a
 * `push` word in a neighbouring command does not fire it while `cd x && git -C y push` does.
 * Everything else about it is intentionally loose: the row costs one ask, never a refusal.
 */
const GIT_PUSH = /\bgit\b[^\n;&|]*\bpush\b/;

/** The one value the Bash `network` input accepts (US-013), spelled as the guard sees it. */
const FULL_NETWORK = "full";

/** The call name of the fetch tool, derived from the provider's own naming rather than retyped. */
const FETCH_CALL = namespacedToolName(WEB_PROVIDER_ID, WEB_FETCH_TOOL);

/** A decision under the one rule this story owns. */
function decision(reason: string): WebGuardDecision {
  return { rule: "web-exposure", reason };
}

/** The command a call carries, or `""` when the field is missing or not a string. */
function commandOf(input: Record<string, unknown>): string {
  return typeof input.command === "string" ? input.command : "";
}

/** True for the two tools whose call runs a command, and so has a sandbox of its own. */
function runsCommand(tool: string): boolean {
  return tool === BASH_TOOL_NAME || tool === EXEC_TOOL_NAME;
}

/**
 * A command-running call's row, in the order the table lists it: the narrower shape first, so a
 * call that is both unsandboxed and sandbox-off reports the more specific reason of the two.
 */
function commandReason(call: WebCallAssessment): string | undefined {
  const bash = call.tool === BASH_TOOL_NAME;
  if (bash && GIT_PUSH.test(commandOf(call.input))) return GIT_PUSH_REASON;
  if (bash && call.input.network === FULL_NETWORK) return FULL_NETWORK_REASON;
  // Exact `true`, the same reading the tools give the field: a stray "true" string is not an ask.
  if (call.input.unsandboxed === true) return UNSANDBOXED_REASON;
  if (!call.sandboxed) return SANDBOX_OFF_REASON;
  return undefined;
}

/**
 * The fetch row: a URL the session has not been shown. The comparison is the exposure's own
 * (`hasSeen` normalises), so `HTTPS://A.example/x#f` is the seen `https://a.example/x`.
 *
 * A destination that does not normalise is not an http(s) URL, and the fetch tool itself refuses
 * it before any request is made -- there is nothing to ask about, so it draws no decision.
 */
function fetchReason(call: WebCallAssessment, exposure: WebExposure): string | undefined {
  if (call.tool !== FETCH_CALL) return undefined;
  const url = typeof call.input.url === "string" ? call.input.url : "";
  if (normalizeWebUrl(url) === null) return undefined;
  return exposure.hasSeen(url) ? undefined : UNSEEN_URL_REASON;
}

/**
 * The guard for one session. It holds no state of its own: the exposure is the state, and asking
 * twice about one call is the same as asking once.
 */
export function createWebExposureGuard(p: WebExposureGuardOptions): WebExposureGuard {
  return {
    exposedNetwork() {
      if (!p.exposure.isExposed()) return undefined;
      const configured = p.configuredAllowedDomains;
      if (configured === undefined || configured.includes("*")) return p.exposedAllowedDomains;
      return p.exposedAllowedDomains.filter((domain) => configured.includes(domain));
    },
    onExposed(listener) {
      if (p.exposure.isExposed()) {
        listener();
        return () => {};
      }
      const unsubscribe = p.exposure.onChange(() => {
        if (!p.exposure.isExposed()) return;
        unsubscribe();
        listener();
      });
      return unsubscribe;
    },
    assess(call: WebCallAssessment): WebGuardDecision | undefined {
      // Nothing asks before the first web result: the guard exists for the posture that follows
      // one, and a session that has read nothing keeps the posture it started with.
      if (!p.exposure.isExposed()) return undefined;
      const reason = runsCommand(call.tool) ? commandReason(call) : fetchReason(call, p.exposure);
      return reason === undefined ? undefined : decision(reason);
    },
  };
}
