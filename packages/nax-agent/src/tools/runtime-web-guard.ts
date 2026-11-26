/**
 * US-012: the web-exposure guard's one decision point in the tool runtime.
 *
 * A session that has read web content carries a posture it did not have before: an
 * instruction planted in the text it read could ask for the few actions that turn
 * "read a page" into "exfiltrate or push". `createWebExposureGuard` (US-011) decides
 * which calls those are; this module turns one of its decisions into the ask the
 * policy's own asks already use, so a flagged call costs exactly one approval and the
 * ledger, the reason and the allow-runs-it / deny-does-not behaviour are the existing
 * ones rather than a second mechanism beside them.
 *
 * Extracted from `runtime.ts` for two reasons, both deliberate:
 *  - `runtime.ts` is at its 600-line cap, and this is the whole of the story's
 *    runtime change: the caller keeps ONE call and no new branch.
 *  - The guard's two asymmetries are easier to see with the code in one place.
 *
 * Asymmetry 1 — it applies under EVERY `bashApproval`, `raw` included. It is not an
 * ask the mode routes (`asksOnAllow`); it is the posture the session is in because it
 * read something, so no mode exempts it.
 *
 * Asymmetry 2 — it fails CLOSED. The command-safety guard fails open (an unreachable
 * classifier must not freeze every command), but a web guard that cannot answer must
 * not silently let an exposed session push, so a throw becomes an ask whose reason
 * names the failure.
 *
 * Policy denials remain final. US-018 also assesses policy/command-safety asks so
 * their single approval carries the stronger exposure reason and cannot be
 * auto-approved by a full-mode host.
 */

import { errorMessage } from "#src/infra/errors";
import type { AskResolver } from "#src/permissions/index";
import type { WebExposurePort } from "#src/session/agent-session-types";
import type { CodingTool } from "./registry.ts";
import type { CodingToolOutcome, ToolCallContext } from "./runtime.ts";
import { type LogCallFn, type RunToolFn, resolveAskOutcome } from "./runtime-calltool.ts";

/** The rule every ask this module raises carries, so a reader can see who asked. */
const WEB_EXPOSURE_RULE = "web-exposure" as const;

/** The reason prefixed onto a guard that could not answer (fail closed, see the header). */
const GUARD_FAILED = "web exposure guard failed";

/**
 * The guard's answer for one call, with a throw converted into the fail-closed ask.
 * A port that answers `undefined` is the ordinary "no web decision" case: the call
 * runs exactly as it would have without a port at all.
 */
function assessOrFailClosed(p: {
  readonly port: WebExposurePort;
  readonly identity: string;
  readonly input: Record<string, unknown>;
  readonly root: string;
  readonly resolvedPaths: readonly string[];
  readonly sandboxed: boolean;
}): { readonly reason: string } | undefined {
  try {
    return p.port.assess({
      tool: p.identity,
      input: p.input,
      root: p.root,
      resolvedPaths: p.resolvedPaths,
      sandboxed: p.sandboxed,
    });
  } catch (err) {
    // Not logged here: the ask raised below carries this reason to the person, and
    // the ledger row records it. A second warn would say the same thing twice.
    return { reason: `${GUARD_FAILED}: ${errorMessage(err)}` };
  }
}

/**
 * The ask outcome for a flagged ALLOWED call, or undefined when the call runs as it
 * would have (no port, or no decision for this call). Undefined is the caller's signal
 * to execute the tool, which is why this returns the OUTCOME rather than a verdict:
 * `runtime.ts` then needs one call and no branch of its own.
 */
export async function resolveWebExposureDenial(p: {
  /** The session's guard, absent in every session that has no web tools (US-012 scope). */
  readonly port: WebExposurePort | undefined;
  /** Whether this call runs inside the sandbox; absent reads as NOT sandboxed (fail closed). */
  readonly sandboxed: boolean;
  /** The policy identity the call was checked under (`Bash`, `Exec`, `web__fetch`, ...). */
  readonly identity: string;
  readonly tool: CodingTool;
  readonly input: Record<string, unknown>;
  readonly context: ToolCallContext | undefined;
  /** What the policy resolved for the call; carried onto the ask so an approval admits it. */
  readonly resolvedPaths: readonly string[];
  readonly root: string;
  readonly askResolver: AskResolver;
  readonly stage: string | undefined;
  readonly storyId: string | undefined;
  readonly runtimeSignal: AbortSignal | undefined;
  readonly logCall: LogCallFn;
  readonly runTool: RunToolFn;
}): Promise<CodingToolOutcome | undefined> {
  if (p.port === undefined) return undefined;
  const decision = assessOrFailClosed({
    port: p.port,
    identity: p.identity,
    input: p.input,
    root: p.root,
    resolvedPaths: p.resolvedPaths,
    sandboxed: p.sandboxed,
  });
  if (decision === undefined) return undefined;
  return resolveAskOutcome({
    identity: p.identity,
    tool: p.tool,
    input: p.input,
    context: p.context,
    verdict: {
      allowed: false,
      outcome: "ask",
      breach: false,
      rule: WEB_EXPOSURE_RULE,
      reason: decision.reason,
      resolvedPaths: p.resolvedPaths,
    },
    runtimeSignal: p.runtimeSignal,
    askResolver: p.askResolver,
    stage: p.stage,
    storyId: p.storyId,
    root: p.root,
    logCall: p.logCall,
    runTool: p.runTool,
  });
}

/** Policy/command-safety asks remain ONE ask, with the stronger web reason when exposed. */
export function resolveWebAwareAskOutcome(
  p: Parameters<typeof resolveAskOutcome>[0] & {
    readonly port: WebExposurePort | undefined;
    readonly sandboxed: boolean;
  },
): Promise<CodingToolOutcome> {
  const decision =
    p.port === undefined
      ? undefined
      : assessOrFailClosed({
          port: p.port,
          identity: p.identity,
          input: p.input,
          root: p.root,
          resolvedPaths: p.verdict.resolvedPaths ?? [],
          sandboxed: p.sandboxed,
        });
  return resolveAskOutcome({
    ...p,
    verdict: decision === undefined ? p.verdict : { ...p.verdict, rule: WEB_EXPOSURE_RULE, reason: decision.reason },
  });
}
