/**
 * App — root TUI component.
 *
 * Orchestrates the layout, stories panel, agent panel, and status bar.
 */

import { Box, Text, useApp, useInput } from "ink";
import { useState } from "react";
import { StoriesPanel } from "./components/StoriesPanel";
import { AgentPanel } from "./components/AgentPanel";
import { StatusBar } from "./components/StatusBar";
import { HelpOverlay } from "./components/HelpOverlay";
import { CostOverlay } from "./components/CostOverlay";
import { useLayout, MIN_TERMINAL_WIDTH } from "./hooks/useLayout";
import { usePipelineEvents } from "./hooks/usePipelineEvents";
import { useKeyboard, type KeyboardAction } from "./hooks/useKeyboard";
import { usePty } from "./hooks/usePty";
import { PanelFocus } from "./types";
import type { TuiProps } from "./types";
import { writeQueueCommand } from "../utils/queue-writer";

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
export function App({ feature, stories: initialStories, events, queueFilePath, ptyOptions }: TuiProps) {
  const layout = useLayout();
  const state = usePipelineEvents(events, initialStories.map((s) => s.story));
  const { exit } = useApp();

  // Focus management (Tab toggles between Stories and Agent panels)
  const [focus, setFocus] = useState<PanelFocus>(PanelFocus.Stories);

  // Overlay state
  const [showHelp, setShowHelp] = useState(false);
  const [showCost, setShowCost] = useState(false);
  const [showQuitConfirm, setShowQuitConfirm] = useState(false);
  const [showAbortConfirm, setShowAbortConfirm] = useState(false);

  // Wire PTY hook for agent session
  const { outputLines: agentOutputLines, handle: ptyHandle } = usePty(ptyOptions ?? null);

  // Handle keyboard actions
  const handleKeyboardAction = async (action: KeyboardAction) => {
    switch (action.type) {
      case "TOGGLE_FOCUS":
        setFocus((prev) =>
          prev === PanelFocus.Stories ? PanelFocus.Agent : PanelFocus.Stories
        );
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
        if (state.currentStory) {
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
        if (state.currentStory) {
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
        // This would require tracking the last failed story and resetting its status
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
    currentStory: state.currentStory,
    onAction: handleKeyboardAction,
    disabled: showQuitConfirm || showAbortConfirm,
  });

  const currentRouting = state.currentStory?.routing;

  // Warn if terminal is too small
  const isTooSmall = layout.width < MIN_TERMINAL_WIDTH;

  return (
    <Box flexDirection="column" height="100%">
      {/* Header */}
      <Box paddingX={1} borderStyle="single" borderBottom borderColor="cyan">
        <Text bold color="cyan">
          nax run — {feature}
        </Text>
      </Box>

      {/* Warning for very small terminals */}
      {isTooSmall && (
        <Box paddingX={1} backgroundColor="yellow">
          <Text color="black">
            ⚠️  Terminal too narrow ({layout.width} cols). Minimum {MIN_TERMINAL_WIDTH} cols recommended.
          </Text>
        </Box>
      )}

      {/* Main content area */}
      <Box flexDirection={layout.mode === "single" ? "column" : "row"} flexGrow={1}>
        {/* Stories panel */}
        <StoriesPanel
          stories={state.stories}
          totalCost={state.totalCost}
          elapsedMs={state.elapsedMs}
          width={layout.mode === "single" ? layout.width : layout.storiesPanelWidth}
          compact={layout.mode === "single"}
          maxHeight={layout.mode === "single" ? 10 : undefined}
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

      {/* Overlays */}
      <HelpOverlay visible={showHelp} />
      <CostOverlay visible={showCost} stories={state.stories} totalCost={state.totalCost} />

      {/* Quit confirmation */}
      {showQuitConfirm && (
        <Box
          position="absolute"
          width="100%"
          height="100%"
          justifyContent="center"
          alignItems="center"
        >
          <Box
            flexDirection="column"
            borderStyle="double"
            borderColor="yellow"
            paddingX={2}
            paddingY={1}
            backgroundColor="black"
          >
            <Text color="yellow">⚠️  Story is running. Quit anyway?</Text>
            <Box paddingTop={1}>
              <Text dimColor>Press <Text color="yellow">y</Text> to confirm, <Text color="yellow">n</Text> to cancel</Text>
            </Box>
          </Box>
        </Box>
      )}

      {/* Abort confirmation */}
      {showAbortConfirm && (
        <Box
          position="absolute"
          width="100%"
          height="100%"
          justifyContent="center"
          alignItems="center"
        >
          <Box
            flexDirection="column"
            borderStyle="double"
            borderColor="red"
            paddingX={2}
            paddingY={1}
            backgroundColor="black"
          >
            <Text color="red">⚠️  Story is running. Abort anyway?</Text>
            <Box paddingTop={1}>
              <Text dimColor>Press <Text color="yellow">y</Text> to confirm, <Text color="yellow">n</Text> to cancel</Text>
            </Box>
          </Box>
        </Box>
      )}
    </Box>
  );
}
