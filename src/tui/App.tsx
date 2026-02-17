/**
 * App — root TUI component.
 *
 * Orchestrates the layout, stories panel, and status bar.
 */

import { Box, Text } from "ink";
import { StoriesPanel } from "./components/StoriesPanel";
import { StatusBar } from "./components/StatusBar";
import { useLayout } from "./hooks/useLayout";
import { usePipelineEvents } from "./hooks/usePipelineEvents";
import type { TuiProps } from "./types";

/**
 * Root TUI application component.
 *
 * Renders the TUI with:
 * - Responsive layout (single/narrow/wide)
 * - Stories panel with status icons
 * - Status bar showing current story/stage
 * - Live updates via pipeline events
 *
 * @example
 * ```tsx
 * const emitter = new PipelineEventEmitter();
 *
 * render(
 *   <App
 *     feature="auth-system"
 *     stories={initialStories}
 *     totalCost={0}
 *     elapsedMs={0}
 *     events={emitter}
 *   />
 * );
 * ```
 */
export function App({ feature, stories: initialStories, events }: TuiProps) {
  const layout = useLayout();
  const state = usePipelineEvents(events, initialStories.map((s) => s.story));

  const currentRouting = state.currentStory?.routing;

  return (
    <Box flexDirection="column" height="100%">
      {/* Header */}
      <Box paddingX={1} borderStyle="single" borderBottom borderColor="cyan">
        <Text bold color="cyan">
          nax run — {feature}
        </Text>
      </Box>

      {/* Main content area */}
      <Box flexDirection={layout.mode === "single" ? "column" : "row"} flexGrow={1}>
        {/* Stories panel */}
        <StoriesPanel
          stories={state.stories}
          totalCost={state.totalCost}
          elapsedMs={state.elapsedMs}
          width={layout.mode === "single" ? layout.width : layout.storiesPanelWidth}
        />

        {/* Agent panel placeholder (Phase 3) */}
        {layout.mode !== "single" && (
          <Box flexGrow={1} borderStyle="single" borderColor="gray" paddingX={1}>
            <Text dimColor>[Agent output — Phase 3]</Text>
          </Box>
        )}
      </Box>

      {/* Status bar */}
      <StatusBar
        currentStory={state.currentStory}
        currentStage={state.currentStage}
        modelTier={currentRouting?.modelTier}
        testStrategy={currentRouting?.testStrategy}
      />
    </Box>
  );
}
