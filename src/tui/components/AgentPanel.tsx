/**
 * AgentPanel — displays PTY output from agent session.
 *
 * Renders a scrollable text buffer showing live agent output.
 * When focused, displays a border highlight.
 */

import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type { ActiveCallState } from "../hooks/useAgentStreamEvents";

/**
 * Props for AgentPanel component.
 */
export interface AgentPanelProps {
  /** Whether the panel is focused (receives keyboard input) */
  focused?: boolean;
  /** PTY output lines (buffered) */
  outputLines?: string[];
  /** Active agent call states from stream events */
  activeCalls?: Map<string, ActiveCallState>;
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
export function AgentPanel({ focused = false, outputLines = [], activeCalls }: AgentPanelProps) {
  const borderColor = focused ? "cyan" : "gray";

  // Buffer output lines (last N lines only)
  const bufferedLines = outputLines.length > MAX_OUTPUT_LINES ? outputLines.slice(-MAX_OUTPUT_LINES) : outputLines;

  const activeCallList = activeCalls ? Array.from(activeCalls.values()) : [];
  const hasActiveCalls = activeCallList.length > 0;
  const hasOutput = bufferedLines.length > 0;

  return (
    <Box flexDirection="column" flexGrow={1} borderStyle="single" borderColor={borderColor}>
      {/* Header */}
      <Box paddingX={1} borderStyle="single" borderBottom borderColor={borderColor}>
        <Text bold color={focused ? "cyan" : undefined}>
          Agent {focused && <Text dimColor>(focused)</Text>}
        </Text>
      </Box>

      {/* Active agent stream rows */}
      {hasActiveCalls && (
        <Box flexDirection="column" paddingX={1} paddingY={1}>
          {activeCallList.map((call) => (
            <AgentCallRow key={call.callId} call={call} />
          ))}
        </Box>
      )}

      {/* PTY output buffer (shown when no stream events) */}
      {!hasActiveCalls && (
        <Box flexDirection="column" paddingX={1} paddingY={1}>
          {hasOutput ? (
            bufferedLines.map((line, i) => <Text key={`line-${i}-${line.slice(0, 20)}`}>{line}</Text>)
          ) : (
            <Text dimColor>
              <Spinner type="dots" /> Waiting for agent...
            </Text>
          )}
        </Box>
      )}
    </Box>
  );
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${Math.floor(ms / 1000)}s`;
}

function AgentCallRow({ call }: { call: ActiveCallState }) {
  const now = Date.now();
  const elapsedMs = now - call.startedAt;
  const idleMs = now - call.lastActivityAt;

  return (
    <Box flexDirection="row" gap={1}>
      <Text color="cyan">{call.agentName}</Text>
      {call.storyId && <Text dimColor>{call.storyId}</Text>}
      {call.stage && <Text dimColor>[{call.stage}]</Text>}
      <Text> elapsed:{formatMs(elapsedMs)}</Text>
      <Text> idle:{formatMs(idleMs)}</Text>
      <Text> msg:{call.messageUpdates}</Text>
      <Text> think:{call.thinkingUpdates}</Text>
      <Text> usage:{call.usageUpdates}</Text>
    </Box>
  );
}
