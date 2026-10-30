/** Compare drawn host state once for every control path, without announcing mounts or resumes. */
import { useEffect, useRef } from "react";
import { acpModelLabel, type ChatHostState, isChatAcpModel } from "@/chat";
import type { TranscriptEntry } from "./transcript-model";

/** What a model is called in a notice: an ACP brain by its label, a native model by its last segment. */
function modelName(model: string): string {
  return isChatAcpModel(model) ? acpModelLabel(model) : model.slice(model.lastIndexOf("/") + 1);
}

function modelNotices(to: string): TranscriptEntry[] {
  return [{ kind: "notice", text: `model: ${modelName(to)}` }];
}

export function useSwitchNotices(state: ChatHostState, append: (entry: TranscriptEntry) => void): void {
  const { sessionId, model, mode } = state;
  const previous = useRef({ sessionId, model, mode });
  useEffect(() => {
    const last = previous.current;
    previous.current = { sessionId, model, mode };
    if (last.sessionId !== sessionId) return;
    if (last.model !== model) for (const entry of modelNotices(model)) append(entry);
    if (last.mode !== mode) append({ kind: "notice", text: `mode: ${mode}` });
  }, [sessionId, model, mode, append]);
}
