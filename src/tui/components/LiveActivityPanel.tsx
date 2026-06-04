/**
 * LiveActivityPanel — displays live agent call activity, escalations, run summary, and errors.
 *
 * Shows active agent calls with storyId, stage, model, and last tool name.
 * Displays run summary with passed/failed/skipped counts and cost when run completes.
 * Shows error banner when runErrored is set.
 * Shows recent escalation log entries.
 */

import { Box, Text } from "ink";
import type { ActiveCallState } from "../hooks/useAgentStreamEvents";
import type { EscalationEntry, RunSummary } from "../hooks/usePipelineBusEvents";

/**
 * Props for the LiveActivityPanel component.
 */
export interface LiveActivityPanelProps {
  /** Whether the panel is focused (receives keyboard input) */
  focused?: boolean;
  /** Active agent call states from stream events */
  activeCalls?: Map<string, ActiveCallState>;
  /** Run completion summary, set when run:completed fires */
  runSummary?: RunSummary;
  /** Error message string, set when the run errors */
  runErrored?: string;
  /** Log of escalation events from pipeline bus */
  escalationLog?: EscalationEntry[];
}

/**
 * Maximum number of escalation entries to display.
 */
const MAX_ESCALATION_DISPLAY = 5;

/**
 * LiveActivityPanel component.
 *
 * Renders a panel showing active agent calls, escalations, run summary, and errors.
 * Intended to replace AgentPanel with richer activity tracking.
 */
export function LiveActivityPanel({
  focused = false,
  activeCalls,
  runSummary,
  runErrored,
  escalationLog = [],
}: LiveActivityPanelProps) {
  const borderColor = focused ? "cyan" : "gray";
  const activeCallList = activeCalls ? Array.from(activeCalls.values()) : [];
  const hasActiveCalls = activeCallList.length > 0;
  const hasSummary = runSummary !== undefined;
  const hasError = runErrored !== undefined;
  const recentEscalations = escalationLog.slice(-MAX_ESCALATION_DISPLAY);
  const hasEscalations = recentEscalations.length > 0;

  return (
    <Box flexDirection="column" flexGrow={1} borderStyle="single" borderColor={borderColor}>
      {/* Header */}
      <Box paddingX={1} borderStyle="single" borderBottom borderColor={borderColor}>
        <Text bold color={focused ? "cyan" : undefined}>
          Live Activity {focused && <Text dimColor>(focused)</Text>}
        </Text>
      </Box>

      {/* Error banner */}
      {hasError && (
        <Box paddingX={1} paddingY={1}>
          <Text color="red">[FAIL] {runErrored}</Text>
        </Box>
      )}

      {/* Run summary */}
      {hasSummary && (
        <Box flexDirection="column" paddingX={1} paddingY={1}>
          <RunSummaryRow summary={runSummary} />
        </Box>
      )}

      {/* Active agent call rows */}
      {hasActiveCalls && (
        <Box flexDirection="column" paddingX={1} paddingY={1}>
          {activeCallList.map((call) => (
            <ActiveCallRow key={call.callId} call={call} />
          ))}
        </Box>
      )}

      {/* Escalation log */}
      {hasEscalations && (
        <Box flexDirection="column" paddingX={1}>
          <Text dimColor>Escalations:</Text>
          {recentEscalations.map((entry) => (
            <EscalationRow key={`${entry.storyId}-${entry.at}`} entry={entry} />
          ))}
        </Box>
      )}

      {/* Waiting state when nothing to show */}
      {!hasActiveCalls && !hasSummary && !hasError && (
        <Box paddingX={1} paddingY={1}>
          <Text dimColor>Waiting for agent...</Text>
        </Box>
      )}
    </Box>
  );
}

function ActiveCallRow({ call }: { call: ActiveCallState }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box flexDirection="row" gap={1}>
        <Text color="cyan">{call.agentName}</Text>
        {call.storyId && <Text>{call.storyId}</Text>}
        {call.stage && <Text dimColor>[{call.stage}]</Text>}
      </Box>
      <Box flexDirection="row" gap={1}>
        {call.model && <Text dimColor>model:{call.model}</Text>}
        {call.lastToolName && <Text dimColor>tool:{call.lastToolName}</Text>}
        <Text dimColor>
          tools:{call.toolCallUpdates} msg:{call.messageUpdates}
        </Text>
      </Box>
    </Box>
  );
}

function RunSummaryRow({ summary }: { summary: RunSummary }) {
  const cost = summary.totalCost !== undefined ? `$${summary.totalCost.toFixed(4)}` : null;

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Text bold>Run complete</Text>
        <Text color="green">{summary.passedStories} passed</Text>
        {summary.failedStories > 0 && <Text color="red">{summary.failedStories} failed</Text>}
        {summary.skippedStories > 0 && <Text dimColor>{summary.skippedStories} skipped</Text>}
        {cost && <Text dimColor>{cost}</Text>}
      </Box>
    </Box>
  );
}

function EscalationRow({ entry }: { entry: EscalationEntry }) {
  return (
    <Box flexDirection="row" gap={1}>
      <Text dimColor>{entry.storyId}</Text>
      <Text color="yellow">{entry.fromTier}</Text>
      <Text dimColor>-&gt;</Text>
      <Text color="cyan">{entry.toTier}</Text>
    </Box>
  );
}
