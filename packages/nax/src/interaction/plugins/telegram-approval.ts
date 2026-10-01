import { NaxError } from "@/errors";
import type { InteractionRequest } from "../types";

/** Permission buttons must accompany the complete command a human approves. */
export function assertTelegramApprovalFitsOneMessage(request: InteractionRequest, chunks: readonly string[]): void {
  if (request.metadata?.approvalPrompt === true && chunks.length > 1) {
    throw new NaxError("Telegram approval prompt exceeds one message and is refused", "TELEGRAM_SEND_FAILED", {
      stage: "interaction",
      requestId: request.id,
    });
  }
}
