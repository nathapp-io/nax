/**
 * The session's pending approvals and questions (spec 4.2 answer, 6.1). Each
 * request settles once: by answer(), by its deadline, or by its turn signal.
 * Ids are kept for the session's lifetime, so a late click gets a status
 * rather than a throw; only a never-issued id or a kind mismatch throws.
 */
import { _agentSessionDeps } from "./agent-session-deps.ts";
import { AgentSessionError } from "./agent-session-errors.ts";
import type { AnswerReply, AnswerStatus } from "./agent-session-types.ts";

export type PendingAskKind = "approval" | "question";

export type AskSettlement =
  | { readonly by: "human"; readonly reply: AnswerReply }
  | { readonly by: "timeout" }
  | { readonly by: "cancelled" };

export interface IssuedAsk {
  readonly requestId: string;
  readonly expiresAt: string;
  readonly settled: Promise<AskSettlement>;
}

export interface PendingAskTable {
  /**
   * `validate` runs on a human answer while the entry is pending, after the
   * kind check; a reason rejects the answer and leaves the entry pending.
   */
  issue(
    kind: PendingAskKind,
    signal: AbortSignal | undefined,
    validate?: (reply: AnswerReply) => string | undefined,
  ): IssuedAsk;
  answer(requestId: string, reply: AnswerReply): AnswerStatus;
  /** Settles every pending request as cancelled. */
  cancelAll(): void;
  /** cancelAll; afterwards every answer() returns "unknown" and every issue() settles cancelled. */
  close(): void;
}

interface Entry {
  readonly kind: PendingAskKind;
  readonly state: "pending" | AskSettlement["by"];
  readonly validate?: (reply: AnswerReply) => string | undefined;
  readonly finish?: (settlement: AskSettlement) => void;
}

/** The kind a reply answers, or undefined for a malformed reply (callers may be plain JS). */
function replyKind(reply: AnswerReply): PendingAskKind | undefined {
  const value: unknown = reply;
  if (typeof value !== "object" || value === null) return undefined;
  if ("decision" in value) return value.decision === "allow" || value.decision === "deny" ? "approval" : undefined;
  return "text" in value && typeof value.text === "string" ? "question" : undefined;
}

function kindMismatch(requestId: string, kind: PendingAskKind): AgentSessionError {
  const expected = kind === "approval" ? "an approval: reply with { decision }" : "a question: reply with { text }";
  return new AgentSessionError(`Request "${requestId}" is ${expected}`, "AGENT_SESSION_INVALID_ANSWER", {
    requestId,
    kind,
  });
}

export function createPendingAskTable(timeoutMs: number): PendingAskTable {
  const entries = new Map<string, Entry>();
  let closed = false;

  function issue(
    kind: PendingAskKind,
    signal: AbortSignal | undefined,
    validate?: (reply: AnswerReply) => string | undefined,
  ): IssuedAsk {
    const requestId = _agentSessionDeps.randomUUID();
    const expiresAt = new Date(_agentSessionDeps.now() + timeoutMs).toISOString();
    const settled = new Promise<AskSettlement>((resolve) => {
      let timer: unknown;
      const onAbort = (): void => finish({ by: "cancelled" });
      function finish(settlement: AskSettlement): void {
        if (entries.get(requestId)?.state !== "pending") return;
        _agentSessionDeps.clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        entries.set(requestId, { kind, state: settlement.by });
        resolve(settlement);
      }
      entries.set(requestId, { kind, state: "pending", validate, finish });
      timer = _agentSessionDeps.setTimeout(() => finish({ by: "timeout" }), timeoutMs);
      if (closed || signal?.aborted === true) finish({ by: "cancelled" });
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
    return { requestId, expiresAt, settled };
  }

  function answer(requestId: string, reply: AnswerReply): AnswerStatus {
    if (closed) return "unknown";
    const entry = entries.get(requestId);
    if (entry === undefined) {
      throw new AgentSessionError(
        `No request "${requestId}" was issued by this session`,
        "AGENT_SESSION_INVALID_ANSWER",
        {
          requestId,
        },
      );
    }
    if (replyKind(reply) !== entry.kind) throw kindMismatch(requestId, entry.kind);
    if (entry.state === "pending") {
      // A validator's reason rejects this answer; the entry stays pending, so a
      // corrected answer is accepted.
      const reason = entry.validate?.(reply);
      if (reason !== undefined) {
        throw new AgentSessionError(reason, "AGENT_SESSION_INVALID_ANSWER", { requestId, kind: entry.kind });
      }
      entry.finish?.({ by: "human", reply });
      return "accepted";
    }
    return entry.state === "cancelled" ? "cancelled" : "expired";
  }

  function cancelAll(): void {
    for (const entry of [...entries.values()]) entry.finish?.({ by: "cancelled" });
  }

  function close(): void {
    cancelAll();
    closed = true;
  }

  return { issue, answer, cancelAll, close };
}
