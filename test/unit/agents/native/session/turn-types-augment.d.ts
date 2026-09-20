/**
 * Ambient augmentation: adds the `loopEvents` field to `TurnDeps` so the
 * integration tests in `turn-loop-seam.test.ts` typecheck before the seam
 * is built. Like the sibling `.d.ts` next to it, this is a pre-implementation
 * scaffold for the test files in this directory — delete it once
 * `src/agents/native/session/turn-types.ts` exposes `loopEvents` directly.
 */
import type { LoopEventRegistry } from "@/agents/native/session/loop-events";

declare module "@/agents/native/session/turn-types" {
  interface TurnDeps {
    loopEvents?: LoopEventRegistry;
  }
}
