/**
 * Approval round trips (S5 spec §4.3). A human approval becomes a
 * `session/request_permission`, and the chosen option is passed to `answer()`.
 * allow_always and reject_always are remembered for the session's life (M-12:
 * execute tools per first word of the command, never without one or after an
 * environment assignment). A remembered allow covers only a simple command: one
 * with shell metacharacters (chaining, substitution, redirection) is asked
 * again, so "always allow git" never approves `git status; rm -rf ~`. A
 * remembered reject applies by prefix regardless. When S3
 * settles a request itself (timeout, cancel), the client request is aborted and a
 * late reply is ignored. A failed client request is a deny (M-13).
 */
import type { PermissionOption, RequestPermissionResponse, ToolCallUpdate } from "@agentclientprotocol/sdk";
import type { AgentLogger, AnswerReply, AnswerStatus, SessionEvent } from "@nathapp/nax-agent";
import { stripControl, stripInvisible } from "#src/client/text";
import { type ClientPort, untilAborted } from "#src/server/client-port";
import { messageOf } from "#src/server/errors";
import { displayLine, toolKind } from "#src/server/translate/tool-kind";

export type Decision = "allow" | "deny";
export type ApprovalEvent = Extract<SessionEvent, { type: "approval_requested" }>;
export type Answer = (requestId: string, reply: AnswerReply) => AnswerStatus;

export const PERMISSION_OPTIONS: readonly PermissionOption[] = [
  { optionId: "allow_once", name: "Allow", kind: "allow_once" },
  { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
  { optionId: "reject_once", name: "Reject", kind: "reject_once" },
  { optionId: "reject_always", name: "Always reject", kind: "reject_always" },
];

export interface PermissionBroker {
  /** Starts the round trip for one human approval; never blocks the caller. */
  request(event: ApprovalEvent, toolCall: ToolCallUpdate | undefined): void;
  /** S3 resolved the request itself: stop waiting for the client. */
  settled(requestId: string): void;
  /** Cancel or turn end: stop waiting on every open request. */
  abortAll(): void;
  /** Resolves when every round trip started so far has finished. */
  drain(): Promise<void>;
}

export interface PermissionBrokerDeps {
  readonly port: ClientPort;
  readonly answer: Answer;
  readonly memory: Map<string, Decision>;
  readonly logger: AgentLogger;
}

interface Choice {
  readonly decision: Decision;
  readonly remember: boolean;
}

const DENY: Choice = { decision: "deny", remember: false };

/** Chaining, pipes, substitution, subshells, redirection and line breaks. */
const SHELL_METACHARACTERS = /[;&|`$()<>\n\r]/;

export function memoryKey(event: ApprovalEvent): string | undefined {
  if (toolKind(event.tool) !== "execute") return event.tool;
  const first = event.command?.trim().split(/\s+/)[0];
  if (first === undefined || first === "" || first.includes("=")) return undefined;
  return `${event.tool}:${first}`;
}

/** Whether a remembered decision may answer this request without asking. */
function memoryApplies(event: ApprovalEvent, decision: Decision): boolean {
  if (decision === "deny" || toolKind(event.tool) !== "execute") return true;
  return !SHELL_METACHARACTERS.test(event.command ?? "");
}

function choice(response: RequestPermissionResponse): Choice {
  const { outcome } = response;
  if (outcome.outcome !== "selected") return DENY;
  switch (PERMISSION_OPTIONS.find((option) => option.optionId === outcome.optionId)?.kind) {
    case "allow_once":
      return { decision: "allow", remember: false };
    case "allow_always":
      return { decision: "allow", remember: true };
    case "reject_always":
      return { decision: "deny", remember: true };
    default:
      return DENY;
  }
}

function fallbackToolCall(event: ApprovalEvent): ToolCallUpdate {
  return {
    toolCallId: event.callId ?? event.requestId,
    title: displayLine(event.summary),
    kind: toolKind(event.tool),
    status: "pending",
    ...(event.command !== undefined ? { rawInput: { command: stripInvisible(stripControl(event.command)) } } : {}),
  };
}

export function createPermissionBroker(deps: PermissionBrokerDeps): PermissionBroker {
  const open = new Map<string, AbortController>();
  const running = new Set<Promise<void>>();

  async function roundTrip(event: ApprovalEvent, toolCall: ToolCallUpdate, key: string | undefined): Promise<void> {
    const controller = new AbortController();
    open.set(event.requestId, controller);
    let reply: Choice;
    try {
      const ask = { toolCall, options: PERMISSION_OPTIONS };
      reply = choice(await untilAborted(deps.port.requestPermission(ask, controller.signal), controller.signal));
    } catch (error) {
      if (controller.signal.aborted) return;
      deps.logger.warn("permissions", "permission request failed; denying", { error: messageOf(error) });
      reply = DENY;
    } finally {
      open.delete(event.requestId);
    }
    if (controller.signal.aborted) return;
    if (reply.remember && key !== undefined) deps.memory.set(key, reply.decision);
    deps.answer(event.requestId, { decision: reply.decision });
  }

  return {
    request(event, toolCall) {
      const key = memoryKey(event);
      const remembered = key === undefined ? undefined : deps.memory.get(key);
      if (remembered !== undefined && memoryApplies(event, remembered)) {
        deps.answer(event.requestId, { decision: remembered });
        return;
      }
      const trip = roundTrip(event, toolCall ?? fallbackToolCall(event), key);
      running.add(trip);
      void trip.finally(() => running.delete(trip));
    },
    settled(requestId) {
      open.get(requestId)?.abort();
    },
    abortAll() {
      for (const controller of open.values()) controller.abort();
    },
    async drain() {
      await Promise.all([...running]);
    },
  };
}
