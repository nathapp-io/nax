/**
 * StoriesPanel — displays story list with status icons, cost, and elapsed time.
 *
 * Supports scrolling for >15 stories and compact mode for single-column layout.
 */

import { Box, Text } from "ink";
import { useState, useEffect } from "react";
import type { StoryDisplayState } from "../types";
import { MAX_VISIBLE_STORIES, COMPACT_MAX_VISIBLE_STORIES } from "../hooks/useLayout";

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
  /** Compact mode (fewer details, for single-column layout) */
  compact?: boolean;
  /** Maximum height in rows (for single-column mode) */
  maxHeight?: number;
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
 * Supports scrolling for >15 stories (or >8 in compact mode) and shows scroll indicators.
 *
 * @example
 * ```tsx
 * <StoriesPanel
 *   stories={storyStates}
 *   totalCost={0.42}
 *   elapsedMs={263000}
 *   width={30}
 *   compact={false}
 * />
 * ```
 */
export function StoriesPanel({
  stories,
  totalCost,
  elapsedMs,
  width,
  compact = false,
  maxHeight,
}: StoriesPanelProps) {
  // Determine max visible stories based on mode
  const maxVisible = compact ? COMPACT_MAX_VISIBLE_STORIES : MAX_VISIBLE_STORIES;
  const needsScrolling = stories.length > maxVisible;

  // Scroll position (0-indexed offset)
  const [scrollOffset, setScrollOffset] = useState(0);

  // Auto-scroll to keep the current running story in view
  useEffect(() => {
    const runningIndex = stories.findIndex((s) => s.status === "running");
    if (runningIndex !== -1 && needsScrolling) {
      // If running story is outside the visible window, scroll to it
      if (runningIndex < scrollOffset) {
        setScrollOffset(runningIndex);
      } else if (runningIndex >= scrollOffset + maxVisible) {
        setScrollOffset(runningIndex - maxVisible + 1);
      }
    }
  }, [stories, scrollOffset, maxVisible, needsScrolling]);

  // Get visible stories (either all or a scrolled window)
  const visibleStories = needsScrolling
    ? stories.slice(scrollOffset, scrollOffset + maxVisible)
    : stories;

  const canScrollUp = scrollOffset > 0;
  const canScrollDown = scrollOffset + maxVisible < stories.length;

  return (
    <Box
      flexDirection="column"
      width={width}
      height={maxHeight}
      borderStyle="single"
      borderColor="gray"
    >
      {/* Header */}
      <Box paddingX={1} borderStyle="single" borderBottom borderColor="gray">
        <Text bold>Stories</Text>
        {needsScrolling && (
          <Text dimColor> ({stories.length} total)</Text>
        )}
      </Box>

      {/* Scroll indicator (top) */}
      {needsScrolling && canScrollUp && (
        <Box paddingX={1}>
          <Text dimColor>▲ {scrollOffset} more above</Text>
        </Box>
      )}

      {/* Story list */}
      <Box flexDirection="column" paddingX={1} paddingY={1} flexGrow={1}>
        {visibleStories.map((s) => {
          const icon = getStatusIcon(s.status);

          if (compact) {
            // Compact mode: just icon and ID
            return (
              <Box key={s.story.id}>
                <Text>
                  {icon} {s.story.id}
                </Text>
              </Box>
            );
          }

          // Normal mode: icon, ID, and routing info
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

      {/* Scroll indicator (bottom) */}
      {needsScrolling && canScrollDown && (
        <Box paddingX={1}>
          <Text dimColor>▼ {stories.length - scrollOffset - maxVisible} more below</Text>
        </Box>
      )}

      {/* Footer — Cost and time */}
      <Box
        flexDirection="column"
        paddingX={1}
        paddingY={1}
        borderStyle="single"
        borderTop
        borderColor="gray"
      >
        {!compact && (
          <>
            <Text>
              Cost: <Text color="green">${totalCost.toFixed(4)}</Text>
            </Text>
            <Text>
              Time: <Text color="cyan">{formatElapsedTime(elapsedMs)}</Text>
            </Text>
          </>
        )}
        {compact && (
          <Text>
            ${totalCost.toFixed(2)} · {formatElapsedTime(elapsedMs)}
          </Text>
        )}
      </Box>
    </Box>
  );
}
