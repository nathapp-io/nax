/** Compare drawn host state once for every control path, without announcing mounts or resumes. */
import { useEffect, useRef } from "react";
import type { ChatHostState } from "@/chat";
import type { TranscriptEntry } from "./transcript-model";

export function useSwitchNotices(state: ChatHostState, append: (entry: TranscriptEntry) => void): void {
  const { sessionId, model, mode } = state;
  const previous = useRef({ sessionId, model, mode });
  useEffect(() => {
    const last = previous.current;
    previous.current = { sessionId, model, mode };
    if (last.sessionId !== sessionId) return;
    if (last.model !== model) append({ kind: "notice", text: `model: ${model.slice(model.lastIndexOf("/") + 1)}` });
    if (last.mode !== mode) append({ kind: "notice", text: `mode: ${mode}` });
  }, [sessionId, model, mode, append]);
}
