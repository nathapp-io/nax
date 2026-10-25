/**
 * Approval round trips (S5 spec §4.3). A human approval becomes a
 * `session/request_permission`, and the chosen option is passed to `answer()`.
 * allow_always and reject_always are remembered for the session's life (M-12).
 * Execute tools are keyed on the command plus its subcommand (`git status`,
 * `npm test`) when the second word is a plain word, and on the bare command
 * only when there is no second word (`ls`), so "always allow git status" never
 * approves `git push`. Never remembered: no command; a first or second word
 * that is not plain (quotes, escapes, globs, expansions, an environment
 * assignment), which must not widen the key; a second word that is a flag
 * (`rm -f x`, `git -C repo status`), which would widen the key to every use of
 * the command; a masked command (its visible words are not the real
 * command); a wrapper or interpreter, whose first word says nothing about what
 * runs. A remembered allow covers only a simple command: one with shell
 * metacharacters (chaining, substitution, redirection) is asked again, and so
 * is one with a flag or a non-plain word after the key (`git push origin
 * --force` under a remembered `git push`), since those change what runs (nax#2553). A
 * remembered reject applies to its key regardless. When S3 settles a request
 * itself (timeout, cancel), the client request is aborted and a late reply is
 * ignored. A failed client request is a deny (M-13).
 */
import type { PermissionOption, RequestPermissionResponse, ToolCallUpdate } from "@agentclientprotocol/sdk";
import {
  type AgentLogger,
  type AnswerReply,
  type AnswerStatus,
  approvalMemoryApplies,
  approvalMemoryKey,
  type SessionEvent,
} from "@nathapp/nax-agent";
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
      const key = approvalMemoryKey(event);
      const remembered = key === undefined ? undefined : deps.memory.get(key);
      if (remembered !== undefined && approvalMemoryApplies(event, remembered)) {
        deps.answer(event.requestId, { decision: remembered });
        return;
      }
      // Never rejects: a throwing answer() or logger must not become an unhandled rejection.
      const trip = roundTrip(event, toolCall ?? fallbackToolCall(event), key).catch((error: unknown) => {
        deps.logger.warn("permissions", "permission round trip failed", { error: messageOf(error) });
      });
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
