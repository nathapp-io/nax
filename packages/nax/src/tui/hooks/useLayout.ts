/**
 * useLayout hook — terminal width detection and breakpoint management.
 *
 * Provides responsive layout breakpoints for the TUI:
 * - < 80 cols: single column (stacked)
 * - 80-140 cols: 2-column layout
 * - > 140 cols: 2-column with wider agent panel
 */

import { useEffect, useState } from "react";

/**
 * Layout mode based on terminal width.
 */
export type LayoutMode = "single" | "narrow" | "wide";

/**
 * Layout configuration for rendering.
 */
export interface LayoutConfig {
  /** Current layout mode */
  mode: LayoutMode;
  /** Terminal width in columns */
  width: number;
  /** Terminal height in rows */
  height: number;
  /** Stories panel width (columns) */
  storiesPanelWidth: number;
}

/**
 * Hook for responsive terminal layout.
 *
 * Detects terminal size and provides breakpoint-based layout config.
 * Handles SIGWINCH (terminal resize) events and cleans up listeners on unmount.
 *
 * Three breakpoints:
 * - < 80 cols: single-column (stacked)
 * - 80-140 cols: two-column (narrow)
 * - > 140 cols: two-column (wide)
 *
 * @example
 * ```tsx
 * const layout = useLayout();
 *
 * return (
 *   <Box flexDirection={layout.mode === "single" ? "column" : "row"}>
 *     <StoriesPanel width={layout.storiesPanelWidth} compact={layout.mode === "single"} />
 *     <AgentPanel />
 *   </Box>
 * );
 * ```
 */
export function useLayout(): LayoutConfig {
  const [layout, setLayout] = useState<LayoutConfig>(() => computeLayout());

  useEffect(() => {
    const handleResize = () => {
      setLayout(computeLayout());
    };

    // Listen for terminal resize (SIGWINCH)
    // Node.js/Bun emits 'resize' event on process.stdout when terminal size changes
    process.stdout.on("resize", handleResize);

    // Clean up listener on unmount to prevent memory leaks
    return () => {
      process.stdout.off("resize", handleResize);
    };
  }, []);

  return layout;
}

/**
 * Minimum terminal width for usable display.
 */
export const MIN_TERMINAL_WIDTH = 60;

/**
 * Breakpoint: below this width, use single-column layout.
 */
const BREAKPOINT_NARROW = 80;

/**
 * Breakpoint: above this width, use wide two-column layout.
 */
const BREAKPOINT_WIDE = 140;

/**
 * Stories panel width in narrow two-column mode.
 */
const PANEL_WIDTH_NARROW = 30;

/**
 * Stories panel width in wide two-column mode.
 */
const PANEL_WIDTH_WIDE = 35;

/**
 * Maximum stories to show in compact mode (single-column).
 */
export const COMPACT_MAX_VISIBLE_STORIES = 8;

/**
 * Maximum stories before scrolling kicks in (normal mode).
 */
export const MAX_VISIBLE_STORIES = 15;

/**
 * Compute layout configuration based on current terminal size.
 *
 * Breakpoints:
 * - < 80 cols: single-column (stacked), compact mode
 * - 80-140 cols: two-column, narrow stories panel (30 cols)
 * - > 140 cols: two-column, wide stories panel (35 cols)
 */
function computeLayout(): LayoutConfig {
  const width = process.stdout.columns ?? 80;
  const height = process.stdout.rows ?? 24;

  let mode: LayoutMode;
  let storiesPanelWidth: number;

  if (width < BREAKPOINT_NARROW) {
    mode = "single";
    storiesPanelWidth = width;
  } else if (width < BREAKPOINT_WIDE) {
    mode = "narrow";
    storiesPanelWidth = PANEL_WIDTH_NARROW;
  } else {
    mode = "wide";
    storiesPanelWidth = PANEL_WIDTH_WIDE;
  }

  return { mode, width, height, storiesPanelWidth };
}
