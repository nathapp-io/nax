/**
 * TUI entry point — renders the Ink-based terminal user interface.
 */

import { render } from "ink";
import { App } from "./App";
import type { TuiProps } from "./types";

/**
 * Render the TUI.
 *
 * Initializes Ink and renders the root App component.
 *
 * @param props - TUI props (feature, stories, events)
 * @returns Ink instance (for cleanup/unmounting)
 *
 * @example
 * ```ts
 * const emitter = new PipelineEventEmitter();
 *
 * const instance = renderTui({
 *   feature: "auth-system",
 *   stories: initialStories,
 *   totalCost: 0,
 *   elapsedMs: 0,
 *   events: emitter,
 * });
 *
 * // Later: cleanup
 * instance.unmount();
 * ```
 */
export function renderTui(props: TuiProps) {
  return render(<App {...props} />);
}

export type { TuiProps, StoryDisplayState, PanelFocus, PtySpawnOptions } from "./types";
export { PipelineEventEmitter } from "../pipeline/events";
