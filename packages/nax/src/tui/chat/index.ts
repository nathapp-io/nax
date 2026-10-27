import { type Instance, render } from "ink";
import { createElement } from "react";
import { ENTER_ALT_SCREEN, LEAVE_ALT_SCREEN } from "./alt-screen";
import { ChatApp, type ChatAppProps } from "./ChatApp";

export { ENTER_ALT_SCREEN, LEAVE_ALT_SCREEN } from "./alt-screen";
export { ChatApp, type ChatAppProps } from "./ChatApp";
export { formatChatExitSummary } from "./exit-summary";
export { type ChatTheme, resolveChatTheme } from "./theme";

export const _renderChatDeps = {
  render,
  write: (text: string): void => {
    process.stdout.write(text);
  },
  /** Register the process-exit guard; the returned remover must be called after the first restore. */
  onExit: (handler: () => void): (() => void) => {
    process.on("exit", handler);
    return () => {
      process.off("exit", handler);
    };
  },
};

/**
 * Mount the chat screen on the terminal's alternate screen.
 *
 * The escape sequence is written before the first frame so no drawn row is left behind on
 * the normal screen, and the restore runs at most once: on unmount, or from the process
 * `exit` handler when the process leaves without unmounting (an uncaught error). A renderer
 * that throws restores before the error escapes, so a broken screen does not strand the
 * user's terminal in the alternate buffer.
 */
export function renderChat(props: ChatAppProps): Instance {
  _renderChatDeps.write(ENTER_ALT_SCREEN);
  let restored = false;
  let removeExit: (() => void) | undefined;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    removeExit?.();
    _renderChatDeps.write(LEAVE_ALT_SCREEN);
  };
  try {
    const instance = _renderChatDeps.render(createElement(ChatApp, props), {
      exitOnCtrlC: false,
      incrementalRendering: true,
    });
    removeExit = _renderChatDeps.onExit(restore);
    return {
      ...instance,
      unmount: () => {
        try {
          // Ink flushes its final frame from unmount(); it belongs to the alternate screen.
          instance.unmount();
        } finally {
          restore();
        }
      },
    };
  } catch (error) {
    restore();
    throw error;
  }
}
