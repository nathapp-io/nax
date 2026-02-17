/**
 * useKeyboard hook — handle keyboard shortcuts for TUI controls.
 *
 * Listens for keyboard input when agent panel is NOT focused and dispatches
 * actions like PAUSE/ABORT/SKIP to the queue file.
 *
 * When agent panel IS focused, only Ctrl+] escapes back to TUI controls.
 */

import { useInput } from "ink";
import { PanelFocus } from "../types";
import type { UserStory } from "../../prd/types";

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
 * - All other keys: Forwarded to PTY (handled elsewhere)
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

    // When Agent panel is focused, only Ctrl+] escapes back to TUI
    if (focus === PanelFocus.Agent) {
      // Ctrl+] is key.ctrl === true and input === ']'
      if (key.ctrl && input === "]") {
        onAction({ type: "ESCAPE_AGENT" });
      }
      // All other input is routed to PTY (handled by caller)
      return;
    }

    // Stories panel is focused — handle TUI shortcuts
    // Tab key toggles focus
    if (key.tab) {
      onAction({ type: "TOGGLE_FOCUS" });
      return;
    }

    // Esc closes overlays
    if (key.escape) {
      onAction({ type: "CLOSE_OVERLAY" });
      return;
    }

    // Character-based shortcuts
    switch (input.toLowerCase()) {
      case "p":
        onAction({ type: "PAUSE" });
        break;
      case "a":
        onAction({ type: "ABORT" });
        break;
      case "s":
        // Skip requires a current story
        if (currentStory) {
          onAction({ type: "SKIP", storyId: currentStory.id });
        }
        break;
      case "q":
        onAction({ type: "QUIT" });
        break;
      case "?":
        onAction({ type: "SHOW_HELP" });
        break;
      case "c":
        onAction({ type: "SHOW_COST" });
        break;
      case "r":
        onAction({ type: "RETRY" });
        break;
      default:
        // Ignore unrecognized keys
        break;
    }
  });
}
