/** Compare drawn host state once for every control path, without announcing mounts or resumes. */
import { useEffect, useRef } from "react";
import { acpModelLabel, type ChatHostState, isChatAcpModel, parseChatAcpModel } from "@/chat";
import type { TranscriptEntry } from "./transcript-model";

/** What a model is called in a notice: an ACP brain by its label, a native model by its last segment. */
function modelName(model: string): string {
  return isChatAcpModel(model) ? acpModelLabel(model) : model.slice(model.lastIndexOf("/") + 1);
}

/** The brain a model runs on: the ACP agent, a malformed ACP string as itself, or the native one. */
function brainOf(model: string): string {
  if (!isChatAcpModel(model)) return "native";
  try {
    return `acp:${parseChatAcpModel(model)?.agent}`;
  } catch {
    // A malformed stored string has no agent; it is its own brain so a switch away from it is still announced.
    return model;
  }
}

function modelNotices(from: string, to: string): TranscriptEntry[] {
  const notices: TranscriptEntry[] = [{ kind: "notice", text: `model: ${modelName(to)}` }];
  if (brainOf(from) !== brainOf(to)) {
    notices.push({ kind: "notice", text: `${modelName(to)} does not see ${modelName(from)}'s turns` });
  }
  return notices;
}

export function useSwitchNotices(state: ChatHostState, append: (entry: TranscriptEntry) => void): void {
  const { sessionId, model, mode } = state;
  const previous = useRef({ sessionId, model, mode });
  useEffect(() => {
    const last = previous.current;
    previous.current = { sessionId, model, mode };
    if (last.sessionId !== sessionId) return;
    if (last.model !== model) for (const entry of modelNotices(last.model, model)) append(entry);
    if (last.mode !== mode) append({ kind: "notice", text: `mode: ${mode}` });
  }, [sessionId, model, mode, append]);
}
