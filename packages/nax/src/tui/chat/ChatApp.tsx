import { errorMessage } from "@nathapp/nax-agent/internal";
import { Box } from "ink";
import { type ReactElement, useEffect, useRef, useState } from "react";
import type { ChatHost } from "@/chat";
import { ChatStatusLine } from "./ChatStatusLine";
import { InputBox } from "./InputBox";
import { appendChatEvent, Transcript, type TranscriptEntry } from "./Transcript";

export interface ChatAppProps {
  host: ChatHost;
}
const SANDBOX_WARNING = "sandbox unavailable: commands run outside the sandbox";

export function ChatApp({ host }: ChatAppProps): ReactElement {
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const [, refresh] = useState(0);
  const state = host.current();
  const notice = host.notice();
  const warn = state.mode === "full" && state.sandbox?.kind === "unavailable";
  useEffect(() => {
    if (notice) setEntries((rows) => [...rows, { kind: "message", text: notice }]);
  }, [notice]);
  useEffect(() => {
    if (warn) setEntries((rows) => [...rows, { kind: "message", text: SANDBOX_WARNING }]);
  }, [warn]);

  // Slash dispatch will wrap this entry point; ask/global keys can own InputBox.active.
  async function submit(message: string): Promise<void> {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setEntries((rows) => [...rows, { kind: "message", text: `> ${message}` }]);
    try {
      await host.send(message, (event) => setEntries((rows) => appendChatEvent(rows, event)));
    } catch (error) {
      setEntries((rows) => [...rows, { kind: "message", text: errorMessage(error) }]);
    } finally {
      sending.current = false;
      setBusy(false);
      refresh((revision) => revision + 1);
    }
  }
  return (
    <Box flexDirection="column">
      <Transcript entries={entries} />
      <InputBox
        busy={busy}
        onSubmit={(message) => {
          void submit(message);
        }}
      />
      <ChatStatusLine state={state} />
    </Box>
  );
}
