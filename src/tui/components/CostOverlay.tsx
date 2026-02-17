/**
 * CostOverlay — modal-style overlay showing cost breakdown per story.
 *
 * Shown when c is pressed, dismissed with Esc.
 */

import { Box, Text } from "ink";
import type { StoryDisplayState } from "../types";

/**
 * Props for CostOverlay component.
 */
export interface CostOverlayProps {
  /** Whether the overlay is visible */
  visible?: boolean;
  /** All stories with cost data */
  stories?: StoryDisplayState[];
  /** Total accumulated cost */
  totalCost?: number;
}

/**
 * Format cost as USD with 4 decimal places.
 */
function formatCost(cost: number): string {
  return `$${cost.toFixed(4)}`;
}

/**
 * CostOverlay component.
 *
 * Displays a modal-style overlay with cost breakdown per story.
 * Shows story ID, status, and cost incurred.
 *
 * @example
 * ```tsx
 * const [showCost, setShowCost] = useState(false);
 *
 * <CostOverlay
 *   visible={showCost}
 *   stories={state.stories}
 *   totalCost={state.totalCost}
 * />
 * ```
 */
export function CostOverlay({ visible = false, stories = [], totalCost = 0 }: CostOverlayProps) {
  if (!visible) {
    return null;
  }

  // Only show stories that have been executed (cost > 0 or status !== pending)
  const executedStories = stories.filter(
    (s) => s.cost && s.cost > 0 || s.status !== "pending",
  );

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor="cyan"
      paddingX={2}
      paddingY={1}
      minWidth={60}
    >
        <Box paddingBottom={1}>
          <Text bold color="cyan">
            Cost Breakdown
          </Text>
        </Box>

        {/* Header row */}
        <Box paddingBottom={1} borderBottom borderColor="gray">
          <Box width={12}>
            <Text bold>Story ID</Text>
          </Box>
          <Box width={12}>
            <Text bold>Status</Text>
          </Box>
          <Box width={12}>
            <Text bold>Cost</Text>
          </Box>
        </Box>

        {/* Story rows */}
        <Box flexDirection="column" paddingY={1}>
          {executedStories.length > 0 ? (
            executedStories.map((story) => (
              <Box key={story.story.id}>
                <Box width={12}>
                  <Text>{story.story.id}</Text>
                </Box>
                <Box width={12}>
                  <Text color={story.status === "passed" ? "green" : story.status === "failed" ? "red" : undefined}>
                    {story.status}
                  </Text>
                </Box>
                <Box width={12}>
                  <Text>{formatCost(story.cost || 0)}</Text>
                </Box>
              </Box>
            ))
          ) : (
            <Text dimColor>No stories executed yet</Text>
          )}
        </Box>

        {/* Total row */}
        <Box paddingTop={1} borderTop borderColor="gray">
          <Box width={24}>
            <Text bold>Total Cost:</Text>
          </Box>
          <Box width={12}>
            <Text bold color="cyan">{formatCost(totalCost)}</Text>
          </Box>
        </Box>

      {/* Footer */}
      <Box justifyContent="center" paddingTop={1} borderTop borderColor="gray">
        <Text dimColor>Press <Text color="yellow">Esc</Text> to close</Text>
      </Box>
    </Box>
  );
}
