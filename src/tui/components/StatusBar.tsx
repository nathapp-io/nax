/**
 * StatusBar — keybinding hints (left) and current story context (right).
 */

import { Box, Text } from "ink";

export interface StatusBarProps {
  currentStage?: string;
  currentStoryId?: string;
  modelTier?: string;
  runPaused?: boolean;
  runComplete?: boolean;
  isParallel?: boolean;
  activeCount?: number;
}

export function StatusBar({
  currentStage,
  currentStoryId,
  modelTier,
  runPaused,
  runComplete,
  isParallel,
  activeCount = 0,
}: StatusBarProps) {
  const hints = runComplete ? "q quit  c cost  ? help" : "p pause  a abort  s skip  c cost  ? help";

  let context: string;
  if (runComplete) {
    context = "done";
  } else if (runPaused) {
    context = "run paused";
  } else if (isParallel && activeCount > 0) {
    context = `parallel · ${activeCount} active`;
  } else if (currentStoryId) {
    const parts = [currentStoryId, currentStage, modelTier].filter(Boolean);
    context = parts.join(" · ");
  } else {
    context = "idle";
  }

  return (
    <Box paddingX={1} borderStyle="single" borderColor="gray" justifyContent="space-between">
      <Text dimColor>{hints}</Text>
      <Text dimColor>{context}</Text>
    </Box>
  );
}
