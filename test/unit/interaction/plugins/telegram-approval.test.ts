import { expect, test } from "bun:test";
import type { InteractionRequest } from "@/interaction";
import { assertTelegramApprovalFitsOneMessage } from "@/interaction/plugins/telegram-approval";

const REQUEST: InteractionRequest = {
  id: "tg-approval-too-long",
  type: "choose",
  featureName: "feature",
  stage: "execution",
  summary: "Bash approval required",
  fallback: "abort",
  createdAt: Date.now(),
  metadata: { approvalPrompt: true },
};

test("Telegram refuses an approval prompt that would require multiple messages", () => {
  expect(() => assertTelegramApprovalFitsOneMessage(REQUEST, ["first", "second"])).toThrow("approval prompt");
});
