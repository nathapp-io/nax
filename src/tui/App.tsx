/**
 * App — root TUI component.
 *
 * Orchestrates the layout, stories panel, agent panel, and status bar.
 */

import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { StoriesPanel } from "./components/StoriesPanel";
import { AgentPanel } from "./components/AgentPanel";
import { StatusBar } from "./components/StatusBar";
import { useLayout } from "./hooks/useLayout";
import { usePipelineEvents } from "./hooks/usePipelineEvents";
import { PanelFocus } from "./types";
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

  // Focus management (Tab toggles between Stories and Agent panels)
  const [focus, setFocus] = useState<PanelFocus>(PanelFocus.Stories);

  // Agent output buffer (will be populated by PTY in future)
  const [agentOutputLines, _setAgentOutputLines] = useState<string[]>([]);

  // Keyboard input handling
  useInput((_input, key) => {
    // Tab key toggles focus
    if (key.tab) {
      setFocus((prev) =>
        prev === PanelFocus.Stories ? PanelFocus.Agent : PanelFocus.Stories
      );
      return;
    }

    // When Agent panel is focused, route input to PTY
    // (PTY handle will be wired in later when we integrate with execution runner)
    if (focus === PanelFocus.Agent) {
      // TODO: route input to PTY handle
      // For now, we just capture the fact that agent panel is focused
    }
  });

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

        {/* Agent panel */}
        <AgentPanel
          focused={focus === PanelFocus.Agent}
          outputLines={agentOutputLines}
        />
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
