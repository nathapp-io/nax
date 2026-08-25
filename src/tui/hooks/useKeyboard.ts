/**
 * useKeyboard hook — handle keyboard shortcuts for TUI controls.
 *
 * Listens for keyboard input when agent panel is NOT focused and dispatches
 * actions like PAUSE/ABORT/SKIP to the queue file.
 *
 * When agent panel IS focused, only Ctrl+] escapes back to TUI controls.
 */

import { useInput } from "ink";
import type { UserStory } from "@/prd/types";
import { PanelFocus } from "../types";

/**
 * Keyboard action types.
 */
export type KeyboardAction =
  | { type: "PAUSE" }
  | { type: "ABORT" }
  | { type: "SKIP"; storyId: string }
  | { type: "TOGGLE_FOCUS" }
  | { type: "ESCAPE_AGENT" }
  | { type: "QUIT" }
  | { type: "SHOW_HELP" }
  | { type: "SHOW_COST" }
  | { type: "RETRY" }
  | { type: "CLOSE_OVERLAY" };

/**
 * Props for useKeyboard hook.
 */
export interface UseKeyboardProps {
  /** Current panel focus state */
  focus: PanelFocus;
  /** Current story being executed (for SKIP command) */
  currentStory?: UserStory;
  /** Callback when an action is triggered */
  onAction: (action: KeyboardAction) => void;
  /** Disable keyboard handling (e.g., during confirmation dialogs) */
  disabled?: boolean;
}

/**
 * Hook for handling keyboard shortcuts.
 *
 * Keybindings (when Stories panel is focused):
 * - p: PAUSE after current story
 * - a: ABORT run
 * - s: SKIP current story
 * - Tab: Toggle focus between Stories and Agent panels
 * - q: Quit TUI
 * - ?: Show help overlay
 * - c: Show cost breakdown overlay
 * - r: Retry last failed story
 * - Esc: Close overlay
 *
 * When Agent panel is focused:
 * - Ctrl+]: Escape back to TUI controls
 * - All other keys: Ignored (shortcuts resume once focus returns to Stories)
 *
 * @example
 * ```tsx
 * const [focus, setFocus] = useState(PanelFocus.Stories);
 * const [showHelp, setShowHelp] = useState(false);
 *
 * useKeyboard({
 *   focus,
 *   currentStory: state.currentStory,
 *   onAction: (action) => {
 *     if (action.type === "TOGGLE_FOCUS") {
 *       setFocus(prev => prev === PanelFocus.Stories ? PanelFocus.Agent : PanelFocus.Stories);
 *     } else if (action.type === "SHOW_HELP") {
 *       setShowHelp(true);
 *     } else if (action.type === "PAUSE") {
 *       writeQueueCommand({ type: "PAUSE" });
 *     }
 *   }
 * });
 * ```
 */
export function useKeyboard({ focus, currentStory, onAction, disabled = false }: UseKeyboardProps): void {
  useInput((input, key) => {
    // If disabled, don't process any input
    if (disabled) {
      return;
    }

    // BUG-4: `onAction` (App.tsx's handleKeyboardAction) is async and awaits
    // fallible FS writes, but `useInput`'s callback is synchronous and Ink
    // never observes the returned promise. A rejection (e.g. an unwritable
    // queue file) would otherwise escape as an unhandled rejection, which
    // the crash handler treats as a fatal run crash. `onAction` itself is
    // responsible for catching and surfacing failures inline (App.tsx); this
    // is a backstop so a caller that forgets to catch cannot take the run
    // down for want of a `.catch()`.
    const dispatch = (action: KeyboardAction) => {
      Promise.resolve(onAction(action)).catch(() => {});
    };

    // When Agent panel is focused, only Ctrl+] escapes back to TUI
    if (focus === PanelFocus.Agent) {
      // Ctrl+] is key.ctrl === true and input === ']'
      if (key.ctrl && input === "]") {
        dispatch({ type: "ESCAPE_AGENT" });
      }
      // All other keys are ignored while the Agent panel is focused; shortcuts
      // resume once focus returns to the Stories panel.
      return;
    }

    // Stories panel is focused — handle TUI shortcuts
    // Tab key toggles focus
    if (key.tab) {
      dispatch({ type: "TOGGLE_FOCUS" });
      return;
    }

    // Esc closes overlays
    if (key.escape) {
      dispatch({ type: "CLOSE_OVERLAY" });
      return;
    }

    // BUG-22: a Ctrl+<letter> combo shares its `input` character with the
    // plain letter (e.g. Ctrl+C and "c" are both input === "c"), so without
    // this guard Ctrl+C fell through to the "c" case below (SHOW_COST)
    // instead of being left for Ink's own Ctrl+C exit handling. Ctrl+] is
    // handled separately above (Agent-panel focus only); no other Ctrl
    // combo has meaning here.
    if (key.ctrl) {
      return;
    }

    // Character-based shortcuts
    switch (input.toLowerCase()) {
      case "p":
        dispatch({ type: "PAUSE" });
        break;
      case "a":
        dispatch({ type: "ABORT" });
        break;
      case "s":
        // Skip requires a current story
        if (currentStory) {
          dispatch({ type: "SKIP", storyId: currentStory.id });
        }
        break;
      case "q":
        dispatch({ type: "QUIT" });
        break;
      case "?":
        dispatch({ type: "SHOW_HELP" });
        break;
      case "c":
        dispatch({ type: "SHOW_COST" });
        break;
      case "r":
        dispatch({ type: "RETRY" });
        break;
      default:
        // Ignore unrecognized keys
        break;
    }
  });
}
