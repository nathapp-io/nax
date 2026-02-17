/**
 * StoriesPanel — displays story list with status icons, cost, and elapsed time.
 */

import { Box, Text } from "ink";
import type { StoryDisplayState } from "../types";

/**
 * Props for StoriesPanel component.
 */
export interface StoriesPanelProps {
  /** Stories to display */
  stories: StoryDisplayState[];
  /** Total cost accumulated */
  totalCost: number;
  /** Elapsed time in milliseconds */
  elapsedMs: number;
  /** Panel width (columns) */
  width?: number;
}

/**
 * Get status icon for a story.
 */
function getStatusIcon(status: StoryDisplayState["status"]): string {
  switch (status) {
    case "pending":
      return "⬚";
    case "running":
      return "🔄";
    case "passed":
      return "✅";
    case "failed":
      return "❌";
    case "skipped":
      return "⏭️";
    case "retrying":
      return "🔁";
    case "paused":
      return "⏸️";
  }
}

/**
 * Format elapsed time as mm:ss.
 */
function formatElapsedTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

/**
 * StoriesPanel component.
 *
 * Displays all stories with status icons, routing info, cost total, and elapsed time.
 *
 * @example
 * ```tsx
 * <StoriesPanel
 *   stories={storyStates}
 *   totalCost={0.42}
 *   elapsedMs={263000}
 *   width={30}
 * />
 * ```
 */
export function StoriesPanel({ stories, totalCost, elapsedMs, width }: StoriesPanelProps) {
  return (
    <Box flexDirection="column" width={width} borderStyle="single" borderColor="gray">
      {/* Header */}
      <Box paddingX={1} borderStyle="single" borderBottom borderColor="gray">
        <Text bold>Stories</Text>
      </Box>

      {/* Story list */}
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        {stories.map((s) => {
          const icon = getStatusIcon(s.status);
          const routing = s.routing
            ? ` ${s.routing.complexity.slice(0, 3)} ${s.routing.modelTier}`
            : "";
          return (
            <Box key={s.story.id}>
              <Text>
                {icon} {s.story.id}
                <Text dimColor>{routing}</Text>
              </Text>
            </Box>
          );
        })}
      </Box>

      {/* Footer — Cost and time */}
      <Box
        flexDirection="column"
        paddingX={1}
        paddingY={1}
        borderStyle="single"
        borderTop
        borderColor="gray"
      >
        <Text>
          Cost: <Text color="green">${totalCost.toFixed(4)}</Text>
        </Text>
        <Text>
          Time: <Text color="cyan">{formatElapsedTime(elapsedMs)}</Text>
        </Text>
      </Box>
    </Box>
  );
}
