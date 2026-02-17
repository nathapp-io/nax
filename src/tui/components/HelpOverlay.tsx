/**
 * HelpOverlay — modal-style overlay listing all keybindings.
 *
 * Shown when ? is pressed, dismissed with Esc.
 */

import { Box, Text } from "ink";

/**
 * Props for HelpOverlay component.
 */
export interface HelpOverlayProps {
  /** Whether the overlay is visible */
  visible?: boolean;
}

/**
 * HelpOverlay component.
 *
 * Displays a modal-style overlay with keybinding reference.
 * Centered on screen with a border.
 *
 * @example
 * ```tsx
 * const [showHelp, setShowHelp] = useState(false);
 *
 * <HelpOverlay visible={showHelp} />
 *
 * // Close with Esc or by toggling state
 * ```
 */
export function HelpOverlay({ visible = false }: HelpOverlayProps) {
  if (!visible) {
    return null;
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor="cyan"
      paddingX={2}
      paddingY={1}
    >
        <Box paddingBottom={1}>
          <Text bold color="cyan">
            Keyboard Shortcuts
          </Text>
        </Box>

        {/* Stories panel shortcuts */}
        <Box flexDirection="column" paddingBottom={1}>
          <Text dimColor>Stories Panel (default):</Text>
          <Text>  <Text color="yellow">p</Text> — Pause after current story</Text>
          <Text>  <Text color="yellow">a</Text> — Abort run</Text>
          <Text>  <Text color="yellow">s</Text> — Skip current story</Text>
          <Text>  <Text color="yellow">Tab</Text> — Toggle focus to Agent panel</Text>
          <Text>  <Text color="yellow">q</Text> — Quit TUI</Text>
          <Text>  <Text color="yellow">?</Text> — Show this help</Text>
          <Text>  <Text color="yellow">c</Text> — Show cost breakdown</Text>
          <Text>  <Text color="yellow">r</Text> — Retry last failed story</Text>
          <Text>  <Text color="yellow">Esc</Text> — Close overlay</Text>
        </Box>

        {/* Agent panel shortcuts */}
        <Box flexDirection="column" paddingBottom={1}>
          <Text dimColor>Agent Panel (when focused):</Text>
          <Text>  <Text color="yellow">Ctrl+]</Text> — Escape back to Stories panel</Text>
          <Text>  <Text dimColor>All other keys</Text> — Forwarded to agent PTY</Text>
        </Box>

      {/* Footer */}
      <Box justifyContent="center" paddingTop={1} borderTop borderColor="gray">
        <Text dimColor>Press <Text color="yellow">Esc</Text> to close</Text>
      </Box>
    </Box>
  );
}
