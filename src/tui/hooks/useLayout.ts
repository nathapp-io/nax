/**
 * useLayout hook — terminal width detection and breakpoint management.
 *
 * Provides responsive layout breakpoints for the TUI:
 * - < 80 cols: single column (stacked)
 * - 80-140 cols: 2-column layout
 * - > 140 cols: 2-column with wider agent panel
 */

import { useState, useEffect } from "react";

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
 *
 * @example
 * ```tsx
 * const layout = useLayout();
 *
 * return (
 *   <Box flexDirection={layout.mode === "single" ? "column" : "row"}>
 *     <StoriesPanel width={layout.storiesPanelWidth} />
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
    process.stdout.on("resize", handleResize);

    return () => {
      process.stdout.off("resize", handleResize);
    };
  }, []);

  return layout;
}

/**
 * Compute layout configuration based on current terminal size.
 */
function computeLayout(): LayoutConfig {
  const width = process.stdout.columns ?? 80;
  const height = process.stdout.rows ?? 24;

  let mode: LayoutMode;
  let storiesPanelWidth: number;

  if (width < 80) {
    // Single column mode (stacked)
    mode = "single";
    storiesPanelWidth = width;
  } else if (width < 140) {
    // Narrow 2-column mode
    mode = "narrow";
    storiesPanelWidth = 30; // Fixed width for stories panel
  } else {
    // Wide 2-column mode
    mode = "wide";
    storiesPanelWidth = 35; // Slightly wider stories panel
  }

  return { mode, width, height, storiesPanelWidth };
}
