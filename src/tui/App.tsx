/**
 * App — root TUI component.
 *
 * Orchestrates the layout, stories panel, live activity panel, and status bar.
 */

import { Box, Text, useApp, useInput } from "ink";
import { useState } from "react";
import { writeQueueCommand } from "../utils/queue-writer";
import { CostOverlay } from "./components/CostOverlay";
import { HelpOverlay } from "./components/HelpOverlay";
import { LiveActivityPanel } from "./components/LiveActivityPanel";
import { StatusBar } from "./components/StatusBar";
import { StoriesPanel } from "./components/StoriesPanel";
import { useAgentStreamEvents } from "./hooks/useAgentStreamEvents";
import { type KeyboardAction, useKeyboard } from "./hooks/useKeyboard";
import { COMPACT_MAX_VISIBLE_STORIES, MIN_TERMINAL_WIDTH, MAX_VISIBLE_STORIES, useLayout } from "./hooks/useLayout";
import { usePipelineBusEvents } from "./hooks/usePipelineBusEvents";
import { usePipelineEvents } from "./hooks/usePipelineEvents";
import { usePty } from "./hooks/usePty";
import { PanelFocus } from "./types";
import type { TuiProps } from "./types";

/**
 * Format elapsed milliseconds as "Nm Ns" string.
 */
function formatElapsed(ms: number): string {
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

/**
 * Format cost as USD with 4 decimal places.
 */
function formatCost(cost: number): string {
  return `$${cost.toFixed(4)}`;
}

/**
 * Root TUI application component.
 *
 * Renders the TUI with:
 * - Responsive layout (single/narrow/wide)
 * - Stories panel with status icons
 * - Live activity panel with agent call tracking
 * - Status bar showing current story/stage
 * - Live updates via pipeline bus events
 *
 * @example
 * ```tsx
 * const emitter = new PipelineEventEmitter();
 *
 * render(
 *   <App
 *     feature="auth-system"
 *     stories={initialStories}
 *     events={emitter}
 *   />
 * );
 * ```
 */
export function App({
  feature,
  stories: initialStories,
  events,
  queueFilePath,
  ptyOptions,
  agentStreamEvents,
}: TuiProps) {
  const layout = useLayout();
  const busState = usePipelineBusEvents(initialStories);
  const { currentStage } = usePipelineEvents(events);
  const { exit } = useApp();

  // Focus management (Tab toggles between Stories and Agent panels)
  const [focus, setFocus] = useState<PanelFocus>(PanelFocus.Stories);

  // Overlay state
  const [showHelp, setShowHelp] = useState(false);
  const [showCost, setShowCost] = useState(false);
  const [showQuitConfirm, setShowQuitConfirm] = useState(false);
  const [showAbortConfirm, setShowAbortConfirm] = useState(false);

  // Wire PTY hook for agent session
  const { handle: ptyHandle } = usePty(ptyOptions ?? null);

  // Wire agent stream events for live call metadata
  const { activeCalls } = useAgentStreamEvents(agentStreamEvents);

  // Derived state
  const isRunComplete = !!busState.runSummary;
  const runningStories = busState.stories.filter((s) => s.status === "running");
  const isParallel = runningStories.length > 1;
  const currentRunningStory = runningStories[0];

  // Adapt busState.runSummary (RunSummary) to RunCompletedEvent shape for LiveActivityPanel
  const runSummaryForPanel = busState.runSummary
    ? {
        type: "run:completed" as const,
        totalStories: busState.runSummary.totalStories,
        passedStories: busState.runSummary.passedStories,
        failedStories: busState.runSummary.failedStories,
        skippedStories: busState.runSummary.skippedStories,
        pausedStories: busState.runSummary.pausedStories,
        durationMs: busState.runSummary.durationMs,
        totalCost: busState.runSummary.totalCost,
      }
    : undefined;

  // Adapt busState.runErrored (boolean) to string | undefined for LiveActivityPanel
  const runErroredForPanel = busState.runErrored ? "Run encountered an error" : undefined;

  // Handle keyboard actions
  const handleKeyboardAction = async (action: KeyboardAction) => {
    switch (action.type) {
      case "TOGGLE_FOCUS":
        setFocus((prev) => (prev === PanelFocus.Stories ? PanelFocus.Agent : PanelFocus.Stories));
        break;

      case "ESCAPE_AGENT":
        setFocus(PanelFocus.Stories);
        break;

      case "SHOW_HELP":
        setShowHelp(true);
        break;

      case "SHOW_COST":
        setShowCost(true);
        break;

      case "CLOSE_OVERLAY":
        setShowHelp(false);
        setShowCost(false);
        setShowQuitConfirm(false);
        setShowAbortConfirm(false);
        break;

      case "QUIT":
        // If a story is running, show confirmation
        if (currentRunningStory) {
          setShowQuitConfirm(true);
        } else {
          exit();
        }
        break;

      case "PAUSE":
        if (queueFilePath) {
          await writeQueueCommand(queueFilePath, { type: "PAUSE" });
        }
        break;

      case "ABORT":
        // If a story is running, show confirmation
        if (currentRunningStory) {
          setShowAbortConfirm(true);
        } else if (queueFilePath) {
          await writeQueueCommand(queueFilePath, { type: "ABORT" });
        }
        break;

      case "SKIP":
        if (queueFilePath) {
          await writeQueueCommand(queueFilePath, { type: "SKIP", storyId: action.storyId });
        }
        break;

      case "RETRY":
        // TODO: Implement retry logic for last failed story
        break;

      default:
        break;
    }
  };

  // Custom input handler for confirmation dialogs and PTY routing
  useInput((input, key) => {
    // Handle confirmation dialogs
    if (showQuitConfirm || showAbortConfirm) {
      const inputKey = input.toLowerCase();
      if (inputKey === "y") {
        if (showQuitConfirm) {
          exit();
        } else if (showAbortConfirm && queueFilePath) {
          writeQueueCommand(queueFilePath, { type: "ABORT" });
          setShowAbortConfirm(false);
        }
      } else if (inputKey === "n" || input === "\x1b") {
        // n or Esc cancels
        setShowQuitConfirm(false);
        setShowAbortConfirm(false);
      }
      return;
    }

    // Route input to PTY when agent panel is focused
    if (focus === PanelFocus.Agent && ptyHandle) {
      // Ctrl+] escapes back to TUI controls (handled by useKeyboard)
      if (key.ctrl && input === "]") {
        return; // Let useKeyboard handle it
      }
      // All other input goes to PTY
      ptyHandle.write(input);
    }
  });

  // Wire keyboard hook (disabled during confirmation dialogs)
  useKeyboard({
    focus,
    currentStory: currentRunningStory?.story,
    onAction: handleKeyboardAction,
    disabled: showQuitConfirm || showAbortConfirm,
  });

  // Warn if terminal is too small
  const isTooSmall = layout.width < MIN_TERMINAL_WIDTH;

  // Header right side: "N running · $cost · elapsed"
  const activeCount = runningStories.length;
  const headerRight = [
    activeCount > 0 ? `${activeCount} running` : null,
    formatCost(busState.totalCost),
    formatElapsed(busState.elapsedMs),
  ]
    .filter(Boolean)
    .join("  ·  ");

  const maxHeight = layout.mode === "single" ? COMPACT_MAX_VISIBLE_STORIES : MAX_VISIBLE_STORIES;

  return (
    <Box flexDirection="column" height="100%">
      {/* Header */}
      <Box paddingX={1} borderStyle="single" borderBottom borderColor="cyan" justifyContent="space-between">
        <Text bold color="cyan">
          nax run — {feature}
        </Text>
        <Text dimColor>{headerRight}</Text>
      </Box>

      {/* Warning for very small terminals */}
      {isTooSmall && (
        <Box paddingX={1} backgroundColor="yellow">
          <Text color="black">
            Terminal too narrow ({layout.width} cols). Minimum {MIN_TERMINAL_WIDTH} cols recommended.
          </Text>
        </Box>
      )}

      {/* Main content area */}
      <Box flexDirection={layout.mode === "single" ? "column" : "row"} flexGrow={1}>
        {/* Stories panel */}
        <StoriesPanel
          stories={busState.stories}
          width={layout.mode === "single" ? layout.width : layout.storiesPanelWidth}
          compact={layout.mode === "single"}
          maxHeight={maxHeight}
        />

        {/* Live activity panel */}
        <LiveActivityPanel
          focused={focus === PanelFocus.Agent}
          activeCalls={activeCalls}
          runSummary={runSummaryForPanel}
          runErrored={runErroredForPanel}
          escalationLog={busState.escalationLog}
        />
      </Box>

      {/* Status bar */}
      <StatusBar
        currentStage={currentStage}
        currentStoryId={currentRunningStory?.story.id}
        modelTier={currentRunningStory?.modelTier}
        runPaused={busState.runPaused}
        runComplete={isRunComplete}
        isParallel={isParallel}
        activeCount={activeCount}
      />

      {/* Overlays */}
      <HelpOverlay visible={showHelp} />
      <CostOverlay visible={showCost} stories={busState.stories} totalCost={busState.totalCost} />

      {/* Quit confirmation */}
      {showQuitConfirm && (
        <Box position="absolute" width="100%" height="100%" justifyContent="center" alignItems="center">
          <Box
            flexDirection="column"
            borderStyle="double"
            borderColor="yellow"
            paddingX={2}
            paddingY={1}
            backgroundColor="black"
          >
            <Text color="yellow">Story is running. Quit anyway?</Text>
            <Box paddingTop={1}>
              <Text dimColor>
                Press <Text color="yellow">y</Text> to confirm, <Text color="yellow">n</Text> to cancel
              </Text>
            </Box>
          </Box>
        </Box>
      )}

      {/* Abort confirmation */}
      {showAbortConfirm && (
        <Box position="absolute" width="100%" height="100%" justifyContent="center" alignItems="center">
          <Box
            flexDirection="column"
            borderStyle="double"
            borderColor="red"
            paddingX={2}
            paddingY={1}
            backgroundColor="black"
          >
            <Text color="red">Story is running. Abort anyway?</Text>
            <Box paddingTop={1}>
              <Text dimColor>
                Press <Text color="yellow">y</Text> to confirm, <Text color="yellow">n</Text> to cancel
              </Text>
            </Box>
          </Box>
        </Box>
      )}
    </Box>
  );
}
