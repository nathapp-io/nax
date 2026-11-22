/**
 * The chat screen's side of the full-screen agent view: which agent task is open, how that
 * silences the chat underneath, and how the view is mounted over it.
 *
 * The chat stays mounted while a view is open — hidden with `display: none`, never unmounted —
 * so its transcript, scroll position, input draft and message queue are exactly where the user
 * left them when escape closes the view. What "silenced" means is one fact, `hushes`: every key
 * and click handler of the chat consults it, so nothing behind the view can act.
 *
 * Kept out of `ChatApp`, whose cognitive complexity is at the gate's limit.
 */
import { type ReactElement, useCallback, useEffect, useRef, useState } from "react";
import type { ChatHost } from "@/chat";
import { AgentView } from "./AgentView";
import type { MouseEvents } from "./mouse-input";
import type { ChatTheme } from "./theme";

export interface AgentViewControl {
  /** The agent task being viewed, or undefined while the chat is showing. */
  readonly id: string | undefined;
  /** `display` for the chat's root: hidden while a view is open. */
  readonly display: "flex" | "none";
  open(id: string): void;
  close(): void;
  /** True when `other` holds or a view is open: the states in which the chat takes no input. */
  hushes(other: boolean): boolean;
  /** ctrl-c while a view is open closes it and reports true; with none open it reports false and does nothing. */
  closeForCtrlC(): boolean;
}

/** The open view's task id. A question or approval that needs an answer closes the view first. */
export function useAgentView(host: ChatHost): AgentViewControl {
  const [id, setState] = useState<string | undefined>(undefined);
  /** Ahead of React: a key batched behind the one that opened or closed the view reads the truth. */
  const openId = useRef<string | undefined>(undefined);
  const setId = useCallback((next: string | undefined) => {
    openId.current = next;
    setState(next);
  }, []);
  const close = useCallback(() => setId(undefined), [setId]);
  const ask = host.asks.pending()[0];
  // A card behind the view cannot be answered, so it brings the chat back.
  useEffect(() => {
    if (ask !== undefined) close();
  }, [ask, close]);
  return {
    id,
    display: id === undefined ? "flex" : "none",
    open: setId,
    close,
    hushes: (other) => other || id !== undefined,
    closeForCtrlC() {
      if (openId.current === undefined) return false;
      close();
      return true;
    },
  };
}

export interface AgentViewMount {
  readonly view: AgentViewControl;
  readonly host: ChatHost;
  readonly columns: number;
  readonly rows: number;
  readonly theme: ChatTheme;
  readonly mouse?: MouseEvents;
  readonly onCopy?: (text: string) => void;
}

/** The chat alone, or the chat (hidden) beside the view of the open agent task. */
export function withAgentView(chat: ReactElement, input: AgentViewMount): ReactElement {
  const { view, host } = input;
  if (view.id === undefined || host.tasks === undefined) return chat;
  return (
    <>
      {chat}
      <AgentView
        tasks={host.tasks}
        id={view.id}
        columns={input.columns}
        rows={input.rows}
        theme={input.theme}
        mouse={input.mouse}
        onCopy={input.onCopy}
        onClose={view.close}
      />
    </>
  );
}
