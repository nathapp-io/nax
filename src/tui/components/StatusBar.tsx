/**
 * StatusBar — displays current story and pipeline stage information.
 */

import { Box, Text } from "ink";
import type { UserStory } from "../../prd/types";

/**
 * Props for StatusBar component.
 */
export interface StatusBarProps {
  /** Current story being executed */
  currentStory?: UserStory;
  /** Current pipeline stage */
  currentStage?: string;
  /** Model tier for current story */
  modelTier?: string;
  /** Test strategy for current story */
  testStrategy?: string;
}

/**
 * StatusBar component.
 *
 * Displays a single line showing the current story ID, stage, model tier, and test strategy.
 *
 * @example
 * ```tsx
 * <StatusBar
 *   currentStory={story}
 *   currentStage="execution"
 *   modelTier="balanced"
 *   testStrategy="single-session"
 * />
 * ```
 */
export function StatusBar({
  currentStory,
  currentStage,
  modelTier,
  testStrategy,
}: StatusBarProps) {
  if (!currentStory) {
    return (
      <Box paddingX={1} borderStyle="single" borderColor="gray">
        <Text dimColor>Idle</Text>
      </Box>
    );
  }

  const storyInfo = `Story ${currentStory.id}`;
  const stageInfo = currentStage ? ` · ${currentStage}` : "";
  const tierInfo = modelTier ? ` · ${modelTier}` : "";
  const strategyInfo = testStrategy ? ` · ${testStrategy}` : "";

  return (
    <Box paddingX={1} borderStyle="single" borderColor="gray">
      <Text>
        <Text bold>{storyInfo}</Text>
        <Text dimColor>
          {stageInfo}
          {tierInfo}
          {strategyInfo}
        </Text>
      </Text>
    </Box>
  );
}
