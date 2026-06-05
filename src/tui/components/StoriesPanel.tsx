/**
 * StoriesPanel — displays story list with status icons, tier indicators, and failure reasons.
 *
 * Supports scrolling for >15 stories and compact mode for single-column layout.
 */

import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import { COMPACT_MAX_VISIBLE_STORIES, MAX_VISIBLE_STORIES } from "../hooks/useLayout";
import type { PostRunPhaseState } from "../hooks/usePipelineBusEvents";
import type { PreRunPhaseState } from "../hooks/usePipelineEvents";
import type { StoryDisplayState } from "../types";

/**
 * Props for StoriesPanel component.
 */
export interface StoriesPanelProps {
  /** Stories to display */
  stories: StoryDisplayState[];
  /** Pre-run phase statuses keyed by stage name (e.g. "acceptance-setup") */
  preRunPhases?: Record<string, PreRunPhaseState>;
  /** Post-run phase statuses (acceptance, regression, review) */
  postRunPhases?: {
    acceptance?: PostRunPhaseState;
    regression?: PostRunPhaseState;
    review?: PostRunPhaseState;
  };
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
 * StoriesPanel component.
 *
 * Displays all stories with status icons, routing info, tier indicators, and failure reasons.
 * Supports scrolling for >15 stories (or >8 in compact mode) and shows scroll indicators.
 *
 * @example
 * ```tsx
 * <StoriesPanel
 *   stories={storyStates}
 *   width={30}
 *   compact={false}
 * />
 * ```
 */
export function StoriesPanel({ stories, preRunPhases, postRunPhases, width, compact = false, maxHeight }: StoriesPanelProps) {
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
  const visibleStories = needsScrolling ? stories.slice(scrollOffset, scrollOffset + maxVisible) : stories;

  const canScrollUp = scrollOffset > 0;
  const canScrollDown = scrollOffset + maxVisible < stories.length;

  return (
    <Box flexDirection="column" width={width} height={maxHeight} borderStyle="single" borderColor="gray">
      {/* Header */}
      <Box paddingX={1} borderStyle="single" borderBottom borderColor="gray">
        <Text bold>Progress</Text>
        {needsScrolling && <Text dimColor> ({stories.length} total)</Text>}
      </Box>

      {/* Pre-run phase rows */}
      {preRunPhases && Object.keys(preRunPhases).length > 0 && (
        <Box flexDirection="column" paddingX={1} paddingTop={1}>
          {Object.entries(preRunPhases).map(([name, phase]) => (
            <PreRunPhaseRow key={name} label={name} phase={phase} compact={compact} />
          ))}
        </Box>
      )}

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

          // Normal mode: icon, ID, routing info, tier suffix, and failure sub-line
          const routing = s.routing ? ` ${s.routing.complexity.slice(0, 3)}` : "";
          const shortTier = s.modelTier?.slice(0, 3);
          const tierSuffix =
            s.status === "retrying" && shortTier
              ? `→${shortTier}`
              : s.status === "running" && shortTier
                ? shortTier
                : "";
          const showFailureLine = (s.status === "failed" || s.status === "paused") && s.failureReason;
          return (
            <Box key={s.story.id} flexDirection="column">
              <Text>
                {icon} {s.story.id}
                <Text dimColor>{routing}</Text>
                {tierSuffix ? <Text dimColor> {tierSuffix}</Text> : null}
              </Text>
              {showFailureLine && <Text dimColor>{`  └ ${(s.failureReason as string).slice(0, 25)}`}</Text>}
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

      {/* Post-run phases */}
      {postRunPhases && (postRunPhases.acceptance || postRunPhases.regression || postRunPhases.review) && (
        <Box flexDirection="column" paddingX={1} paddingTop={1}>
          <Text dimColor>Post-Run</Text>
          {postRunPhases.acceptance && (
            <PostRunPhaseRow label="acceptance" phase={postRunPhases.acceptance} compact={compact} />
          )}
          {postRunPhases.regression && (
            <PostRunPhaseRow label="regression" phase={postRunPhases.regression} compact={compact} />
          )}
          {postRunPhases.review && <PostRunPhaseRow label="review" phase={postRunPhases.review} compact={compact} />}
        </Box>
      )}
    </Box>
  );
}

function PreRunPhaseRow({ label, phase, compact }: { label: string; phase: PreRunPhaseState; compact: boolean }) {
  const icon = phase.status === "running" ? "●" : phase.status === "passed" ? "✓" : "✗";
  const color = phase.status === "running" ? "yellow" : phase.status === "passed" ? "green" : "red";
  const displayLabel = compact ? label.slice(0, 6) : label;
  return (
    <Box>
      <Text color={color}>
        {icon} {displayLabel}
      </Text>
    </Box>
  );
}

function PostRunPhaseRow({ label, phase, compact }: { label: string; phase: PostRunPhaseState; compact: boolean }) {
  const icon = phase.status === "running" ? ">" : phase.status === "passed" ? "[OK]" : "[X]";
  const color = phase.status === "running" ? "cyan" : phase.status === "passed" ? "green" : "red";
  return (
    <Box>
      <Text color={color}>
        {icon} {compact ? label.slice(0, 3) : label}
      </Text>
    </Box>
  );
}
