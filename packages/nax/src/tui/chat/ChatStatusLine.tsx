import { Text } from "ink";
import type { ReactElement } from "react";
import type { ChatHostState } from "@/chat";

const SESSION_ID_PREFIX_LENGTH = 8;
export function ChatStatusLine({ state }: { state: ChatHostState }): ReactElement {
  const sandbox =
    state.sandbox?.kind === "available" ? "on" : state.sandbox?.kind === "unavailable" ? "unavailable" : "off";
  return (
    <Text>{`${state.model} | ${state.mode} | ${state.sessionId.slice(0, SESSION_ID_PREFIX_LENGTH)} | $${(state.meta.costUsd ?? 0).toFixed(2)} | sandbox ${sandbox}`}</Text>
  );
}
