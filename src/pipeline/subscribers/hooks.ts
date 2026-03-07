// RE-ARCH: keep
/**
 * Hooks Subscriber (ADR-005, Phase 3 US-P3-001)
 *
 * Maps pipeline events to nax lifecycle hooks (on-start, on-story-start,
 * on-story-complete, on-story-fail, on-pause, on-complete).
 *
 * Design:
 * - All hook calls are fire-and-forget (matching prior fireHook behavior)
 * - Errors in hooks are logged, never rethrown
 * - Returns unsubscribe function for cleanup
 */

import { hookCtx } from "../../execution/story-context";
import { type LoadedHooksConfig, fireHook } from "../../hooks";
import { getSafeLogger } from "../../logger";
import type { PipelineEventBus } from "../event-bus";

export type UnsubscribeFn = () => void;

/**
 * Wire pipeline lifecycle hooks to the event bus.
 *
 * @param bus       - The pipeline event bus
 * @param hooks     - Loaded hooks config (from nax.config)
 * @param workdir   - Working directory for hook script execution
 * @param feature   - Feature name (for hook context payload)
 * @returns Unsubscribe function (call to remove all subscriptions)
 */
export function wireHooks(
  bus: PipelineEventBus,
  hooks: LoadedHooksConfig,
  workdir: string,
  feature: string,
): UnsubscribeFn {
  const logger = getSafeLogger();

  const safe = (name: string, fn: () => Promise<void>) => {
    fn().catch((err) => logger?.warn("hooks-subscriber", `Hook "${name}" failed`, { error: String(err) }));
  };

  const unsubs: UnsubscribeFn[] = [];

  // run:started → on-start
  unsubs.push(
    bus.on("run:started", (ev) => {
      safe("on-start", () => fireHook(hooks, "on-start", hookCtx(feature, { status: "running" }), workdir));
    }),
  );

  // story:started → on-story-start
  unsubs.push(
    bus.on("story:started", (ev) => {
      safe("on-story-start", () =>
        fireHook(
          hooks,
          "on-story-start",
          hookCtx(feature, { storyId: ev.storyId, model: ev.modelTier, agent: ev.agent }),
          workdir,
        ),
      );
    }),
  );

  // story:completed → on-story-complete
  unsubs.push(
    bus.on("story:completed", (ev) => {
      safe("on-story-complete", () =>
        fireHook(
          hooks,
          "on-story-complete",
          hookCtx(feature, { storyId: ev.storyId, status: "passed", cost: ev.cost }),
          workdir,
        ),
      );
    }),
  );

  // story:failed → on-story-fail
  unsubs.push(
    bus.on("story:failed", (ev) => {
      safe("on-story-fail", () =>
        fireHook(
          hooks,
          "on-story-fail",
          hookCtx(feature, { storyId: ev.storyId, status: "failed", reason: ev.reason }),
          workdir,
        ),
      );
    }),
  );

  // story:paused → on-pause
  unsubs.push(
    bus.on("story:paused", (ev) => {
      safe("on-pause (story)", () =>
        fireHook(
          hooks,
          "on-pause",
          hookCtx(feature, { storyId: ev.storyId, reason: ev.reason, cost: ev.cost }),
          workdir,
        ),
      );
    }),
  );

  // run:paused → on-pause
  unsubs.push(
    bus.on("run:paused", (ev) => {
      safe("on-pause (run)", () =>
        fireHook(
          hooks,
          "on-pause",
          hookCtx(feature, { storyId: ev.storyId, reason: ev.reason, cost: ev.cost }),
          workdir,
        ),
      );
    }),
  );

  // run:completed → on-complete
  unsubs.push(
    bus.on("run:completed", (ev) => {
      safe("on-complete", () =>
        fireHook(hooks, "on-complete", hookCtx(feature, { status: "complete", cost: ev.totalCost ?? 0 }), workdir),
      );
    }),
  );

  // run:resumed → on-resume
  unsubs.push(
    bus.on("run:resumed", (ev) => {
      safe("on-resume", () => fireHook(hooks, "on-resume", hookCtx(feature, { status: "running" }), workdir));
    }),
  );

  // story:completed → on-session-end (passed)
  unsubs.push(
    bus.on("story:completed", (ev) => {
      safe("on-session-end (completed)", () =>
        fireHook(hooks, "on-session-end", hookCtx(feature, { storyId: ev.storyId, status: "passed" }), workdir),
      );
    }),
  );

  // story:failed → on-session-end (failed)
  unsubs.push(
    bus.on("story:failed", (ev) => {
      safe("on-session-end (failed)", () =>
        fireHook(hooks, "on-session-end", hookCtx(feature, { storyId: ev.storyId, status: "failed" }), workdir),
      );
    }),
  );

  // run:errored → on-error
  unsubs.push(
    bus.on("run:errored", (ev) => {
      safe("on-error", () => fireHook(hooks, "on-error", hookCtx(feature, { reason: ev.reason }), workdir));
    }),
  );

  return () => {
    for (const u of unsubs) u();
  };
}
