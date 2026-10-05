/**
 * Raises approvals to the person through the session's events (spec 6.1).
 * askPerson is shared by the coding tools' AskLink and by embedder tools
 * whose approval is "always". Asks are serial in practice: the tool batch
 * runs one call at a time.
 */
import {
  type AskLink,
  type AskLinkOutcome,
  type AskResolver,
  chainAskLinks,
  maskForPrompt,
} from "#src/permissions/index";
import type { SessionEventBody } from "./agent-session-types.ts";
import type { PendingAskTable } from "./pending-asks.ts";
import type { SessionAskPort } from "./session-backend.ts";

export interface SessionAskDeps {
  readonly table: PendingAskTable;
  /** Emits on the running turn's event stream. */
  readonly emit: (body: SessionEventBody) => void;
  /** The tool call being answered right now, if any. */
  readonly currentCallId: () => string | undefined;
}

export interface ApprovalAsk {
  readonly tool: string;
  readonly summary: string;
  readonly command?: string;
  readonly reason: string;
  readonly callId?: string;
}

export async function askPerson(
  deps: SessionAskDeps,
  ask: ApprovalAsk,
  signal: AbortSignal | undefined,
): Promise<{ readonly decision: "allow" | "deny"; readonly decidedBy: "human" | "timeout" | "cancelled" }> {
  const { requestId, expiresAt, settled } = deps.table.issue("approval", signal);
  deps.emit({
    type: "approval_requested",
    requestId,
    ...(ask.callId !== undefined ? { callId: ask.callId } : {}),
    tool: ask.tool,
    summary: ask.summary,
    ...(ask.command !== undefined ? { command: ask.command } : {}),
    reason: ask.reason,
    expiresAt,
  });
  const settlement = await settled;
  const allowed = settlement.by === "human" && "decision" in settlement.reply && settlement.reply.decision === "allow";
  const decision = allowed ? "allow" : "deny";
  deps.emit({ type: "approval_resolved", requestId, decision, decidedBy: settlement.by });
  return { decision, decidedBy: settlement.by };
}

const UNSHOWABLE: AskLinkOutcome = { decision: "deny", decidedBy: "unshowable" };

export interface SessionAskLinkDeps {
  readonly port: SessionAskPort;
  /** The tool call being answered right now, if any. */
  readonly currentCallId: () => string | undefined;
}

export function createSessionAskLink(deps: SessionAskLinkDeps): AskLink {
  return {
    name: "agent-session",
    resolve(req, control) {
      // A request whose text could not be shown safely is never put in front of a person.
      if (req.unshowable === true) return Promise.resolve(UNSHOWABLE);
      // As nax's human link: the command is masked, and one whose secret cannot be masked safely is unshowable.
      const masked = req.command === undefined ? undefined : maskForPrompt(req.command);
      if (masked !== undefined && !masked.ok) return Promise.resolve(UNSHOWABLE);
      const callId = deps.currentCallId();
      return deps.port.requestApproval({
        tool: req.tool,
        summary: req.summary,
        ...(masked !== undefined ? { command: masked.masked } : {}),
        reason: req.reason ?? `matched ${req.rule}`,
        ...(callId !== undefined ? { callId } : {}),
        ...(control?.signal !== undefined ? { signal: control.signal } : {}),
      });
    },
  };
}

export function createSessionAskResolver(link: AskLink): AskResolver {
  const chain = chainAskLinks([link]);
  return { humanReachable: true, resolve: (req, control) => chain.resolve(req, control) };
}
