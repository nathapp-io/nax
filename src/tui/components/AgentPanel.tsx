/**
 * AgentPanel — displays PTY output from agent session.
 *
 * Renders a scrollable text buffer showing live agent output.
 * When focused, displays a border highlight.
 */

import { Box, Text } from "ink";

/**
 * Props for AgentPanel component.
 */
export interface AgentPanelProps {
  /** Whether the panel is focused (receives keyboard input) */
  focused?: boolean;
  /** PTY output lines (buffered) */
  outputLines?: string[];
}

/**
 * Maximum number of output lines to buffer.
 *
 * Prevents memory bloat from long-running agent sessions.
 * Last 500 lines typically contain all relevant info for debugging.
 */
const MAX_OUTPUT_LINES = 500;

/**
 * AgentPanel component.
 *
 * Displays PTY output from the agent session in a scrollable text buffer.
 * Shows a border highlight when focused to indicate keyboard input routing.
 *
 * @example
 * ```tsx
 * const [outputLines, setOutputLines] = useState<string[]>([]);
 *
 * <AgentPanel
 *   focused={agentFocused}
 *   outputLines={outputLines}
 *   onData={(data) => setOutputLines(prev => [...prev, data])}
 * />
 * ```
 */
export function AgentPanel({ focused = false, outputLines = [] }: AgentPanelProps) {
  const borderColor = focused ? "cyan" : "gray";

  // Buffer output lines (last N lines only)
  const bufferedLines = outputLines.length > MAX_OUTPUT_LINES
    ? outputLines.slice(-MAX_OUTPUT_LINES)
    : outputLines;

  const hasOutput = bufferedLines.length > 0;

  return (
    <Box flexDirection="column" flexGrow={1} borderStyle="single" borderColor={borderColor}>
      {/* Header */}
      <Box paddingX={1} borderStyle="single" borderBottom borderColor={borderColor}>
        <Text bold color={focused ? "cyan" : undefined}>
          Agent {focused && <Text dimColor>(focused)</Text>}
        </Text>
      </Box>

      {/* Output buffer */}
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        {hasOutput ? (
          bufferedLines.map((line, i) => (
            <Text key={i}>{line}</Text>
          ))
        ) : (
          <Text dimColor>Waiting for agent...</Text>
        )}
      </Box>
    </Box>
  );
}
