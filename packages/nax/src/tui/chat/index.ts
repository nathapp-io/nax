import { basename } from "node:path";
import { type Instance, render } from "ink";
import { createElement } from "react";
import { ENTER_ALT_SCREEN, LEAVE_ALT_SCREEN } from "./alt-screen";
import { ChatApp, type ChatAppProps } from "./ChatApp";
import { createMouseInput, DISABLE_MOUSE, ENABLE_MOUSE } from "./mouse-input";
import {
  chatTitle,
  chatTitleFrame,
  POP_TITLE,
  PUSH_TITLE,
  setTitleSequence,
  TITLE_FRAME_MS,
  titleFrames,
} from "./terminal-title";
import { resolveChatTheme } from "./theme";

export { ENTER_ALT_SCREEN, LEAVE_ALT_SCREEN } from "./alt-screen";
export { ChatApp, type ChatAppProps } from "./ChatApp";
export { formatChatExitSummary } from "./exit-summary";
export { type ChatTheme, resolveChatTheme } from "./theme";

export const _renderChatDeps = {
  render,
  stdin: (): NodeJS.ReadStream => process.stdin,
  createMouseInput,
  setTimeout: (handler: () => void, ms: number): unknown => setTimeout(handler, ms),
  clearTimeout: (handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>),
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

/** The glyphs a caller that passes no theme gets — the same default `ChatApp` resolves. */
const FALLBACK_GLYPHS = resolveChatTheme({ env: {}, colorLevel: 0 }).glyphs;

/**
 * The project the title names: the base name of the directory the chat was opened in, which
 * is the `cwd` the caller passed and, when it passed none, the repo root the host reports.
 */
function projectName(props: ChatAppProps): string {
  return basename(props.cwd ?? props.host.repoRoot);
}

/**
 * Mount the chat screen on the terminal's alternate screen.
 *
 * The escape sequence is written before the first frame so no drawn row is left behind on
 * the normal screen, and the restore runs at most once: on unmount, or from the process
 * `exit` handler when the process leaves without unmounting (an uncaught error). A renderer
 * that throws restores before the error escapes, so a broken screen does not strand the
 * user's terminal in the alternate buffer.
 *
 * On a TTY the mount also takes the terminal title (US-008): it saves the title the user had,
 * writes the project's name, and keeps it current as `ChatApp` reports its turns starting and
 * ending — a chat in a background tab then shows whether it is still working. The restore pops
 * the saved title, and only when it was saved: a render that threw first never took one.
 */
export function renderChat(props: ChatAppProps): Instance {
  const source = _renderChatDeps.stdin();
  const mouse = _renderChatDeps.createMouseInput(source);
  const isTTY = source.isTTY;
  const project = projectName(props);
  const glyphs = props.theme?.glyphs ?? FALLBACK_GLYPHS;
  _renderChatDeps.write(ENTER_ALT_SCREEN);
  let restored = false;
  let titleSaved = false;
  let removeExit: (() => void) | undefined;
  /**
   * The title the screen keeps current. A terminal with no title to take is never written to,
   * and neither is one whose title the restore already gave back: a callback that lands after
   * teardown must not overwrite the title the user's shell is using again.
   */
  const showTitle = (busy: boolean): void => {
    if (!isTTY || restored) return;
    _renderChatDeps.write(setTitleSequence(chatTitle(project, busy, glyphs)));
  };
  const frames = titleFrames(glyphs);
  let timer: unknown;
  let armed = 0;
  let frameIndex = 0;
  const stopFrames = (): void => {
    if (timer === undefined) return;
    _renderChatDeps.clearTimeout(timer);
    timer = undefined;
    armed += 1;
  };
  // A re-armed setTimeout, never setInterval: the handle must stay cancellable (forbidden-patterns-source).
  const armFrame = (): void => {
    armed += 1;
    const mine = armed;
    timer = _renderChatDeps.setTimeout(() => {
      // A tick whose timeout was cleared (or replaced) must neither write nor re-arm.
      if (restored || mine !== armed || timer === undefined) return;
      timer = undefined;
      const frame = frames[frameIndex % frames.length] as string;
      frameIndex += 1;
      _renderChatDeps.write(setTitleSequence(chatTitleFrame(project, frame)));
      armFrame();
    }, TITLE_FRAME_MS);
  };
  const onBusy = (busy: boolean): void => {
    if (!isTTY || restored) return;
    showTitle(busy);
    if (!busy) {
      stopFrames();
    } else if (timer === undefined) {
      frameIndex = 0;
      armFrame();
    }
  };
  const restore = (): void => {
    if (restored) return;
    restored = true;
    stopFrames();
    removeExit?.();
    if (isTTY) _renderChatDeps.write(DISABLE_MOUSE);
    _renderChatDeps.write(LEAVE_ALT_SCREEN);
    if (titleSaved) _renderChatDeps.write(POP_TITLE);
    mouse.dispose();
  };
  try {
    const instance = _renderChatDeps.render(
      createElement(ChatApp, { ...props, mouse: mouse.events, ...(isTTY ? { onBusyChange: onBusy } : {}) }),
      {
        exitOnCtrlC: false,
        // Rewrite only the rows that changed. The standard path erases and redraws the
        // whole frame on every render, which blinks wherever synchronized output is not
        // honoured. Ink 6.7's incremental path drew one row low (#2717); the root
        // `patches/ink@6.7.0.patch` backports Ink 8's fix, and ink is pinned to match.
        incrementalRendering: true,
        stdin: mouse.stdin,
      },
    );
    if (isTTY) {
      _renderChatDeps.write(ENABLE_MOUSE);
      _renderChatDeps.write(PUSH_TITLE);
      titleSaved = true;
      showTitle(false);
    }
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
