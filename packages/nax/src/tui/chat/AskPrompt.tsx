import { Box, Text, useInput } from "ink";
import type { ReactElement } from "react";
import type { ChatAskController, ChatPendingAsk } from "@/chat";
import { InputBox } from "./InputBox";

export interface AskPromptProps {
  ask: ChatPendingAsk;
  controller: ChatAskController;
  active?: boolean;
}

/** Only the first pending request owns input; remount for each request id. */
export function AskPrompt({ ask, controller, active = true }: AskPromptProps): ReactElement {
  const remember = ask.type === "approval_requested" && controller.canRemember(ask);
  useInput(
    (input, key) => {
      if (ask.type !== "approval_requested" || key.ctrl || key.meta) return;
      if (input === "a") controller.resolve(ask.requestId, "allow_once");
      else if (input === "s" && remember) controller.resolve(ask.requestId, "allow_session");
      else if (input === "d") controller.resolve(ask.requestId, "deny");
    },
    { isActive: active },
  );
  if (ask.type === "question") {
    return (
      <Box flexDirection="column">
        <Text>{ask.text}</Text>
        <InputBox busy={false} active={active} onSubmit={(text) => controller.answerQuestion(ask.requestId, text)} />
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Text>
        {ask.tool}
        {ask.command ? ` ${ask.command}` : ""}
      </Text>
      <Text>{ask.reason}</Text>
      {ask.unsandboxed && <Text>outside the sandbox</Text>}
      <Text>a: allow once{remember ? " | s: allow for this session" : ""} | d: deny</Text>
    </Box>
  );
}
