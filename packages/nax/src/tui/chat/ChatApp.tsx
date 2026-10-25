import { errorMessage } from "@nathapp/nax-agent/internal";
import { Box } from "ink";
import { type ReactElement, useCallback, useEffect, useRef, useState } from "react";
import type { ChatHost } from "@/chat";
import { AskPrompt } from "./AskPrompt";
import { ChatStatusLine } from "./ChatStatusLine";
import { InputBox } from "./InputBox";
import { parseSlashCommand, runSlashCommand } from "./slash-commands";
import { appendChatEvent, Transcript, type TranscriptEntry } from "./Transcript";
import { useChatKeys } from "./useChatKeys";

export interface ChatAppProps {
  host: ChatHost;
}
const SANDBOX_WARNING = "sandbox unavailable: commands run outside the sandbox";

export function ChatApp({ host }: ChatAppProps): ReactElement {
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const [, refresh] = useState(0);
  const update = useCallback(() => refresh((revision) => revision + 1), []);
  const show = (text: string) => setEntries((rows) => [...rows, { kind: "message", text }]);
  const showError = (error: unknown) => show(errorMessage(error));
  const keys = useChatKeys({ host, running: sending, refresh: update, onError: showError });
  const ask = host.asks.pending()[0];
  useEffect(() => host.asks.onChange(update), [host, update]);
  const state = host.current();
  const notice = host.notice();
  const warn = state.mode === "full" && state.sandbox?.kind === "unavailable";
  useEffect(() => {
    if (notice) setEntries((rows) => [...rows, { kind: "message", text: notice }]);
  }, [notice]);
  useEffect(() => {
    if (warn) setEntries((rows) => [...rows, { kind: "message", text: SANDBOX_WARNING }]);
  }, [warn]);

  async function submit(message: string): Promise<void> {
    const command = parseSlashCommand(message);
    if (!command) return sendTurn(message);
    if (command.name === "quit") {
      if (sending.current) host.cancel();
      return keys.close();
    }
    if (sending.current) {
      show("wait for the turn to finish (Ctrl-C to interrupt)");
      return;
    }
    let featureMessage: string | undefined;
    const ready = await keys.runControl(async () => {
      featureMessage = await runSlashCommand(command, { host, show });
    });
    if (ready && featureMessage !== undefined) await sendTurn(featureMessage);
  }

  // Wait for send's metadata drain before reopening the session for a queued mode.
  async function sendTurn(message: string): Promise<void> {
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
      await keys.finishTurn();
      setBusy(false);
      refresh((revision) => revision + 1);
    }
  }
  return (
    <Box flexDirection="column">
      <Transcript entries={entries} />
      {ask && <AskPrompt key={ask.requestId} ask={ask} controller={host.asks} active={!keys.locked} />}
      <InputBox
        active={!ask && !keys.locked}
        busy={busy}
        onSubmit={(message) => {
          void submit(message);
        }}
      />
      <ChatStatusLine state={state} />
    </Box>
  );
}
