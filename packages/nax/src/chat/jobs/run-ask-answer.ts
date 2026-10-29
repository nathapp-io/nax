import type { ChatAnswer, ChatAskRecord } from "@/interaction";
import type { RunAskReply } from "./run-asks";

/** Agent approvals apply once; remembering is reserved for a human card. */
export function agentResponse(record: ChatAskRecord, reply: RunAskReply, now: Date): ChatAnswer | undefined {
  const { request } = record;
  const { answer, reason } = reply;
  if (answer === "allow-remember") return undefined;
  const response: ChatAnswer = {
    requestId: request.id,
    action: "input",
    value: answer,
    reason,
    respondedBy: "chat-agent",
    respondedAt: now.toISOString(),
  };
  if (request.type === "confirm") {
    if (answer !== "approve" && answer !== "reject") return undefined;
    response.action = answer;
    delete response.value;
  } else if (request.type === "choose") {
    if (!request.options?.some((option) => option.key === answer)) return undefined;
    response.action = "choose";
  } else if (request.type !== "input") return undefined;
  return response;
}
