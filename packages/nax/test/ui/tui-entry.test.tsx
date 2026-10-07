/**
 * `src/tui/index.tsx` was invisible to the coverage gate (#2329): test/ui
 * renders subcomponents directly, so the entry module was only ever reached
 * through `import type`. This loads and exercises it.
 */
import { expect, test } from "bun:test";
import { PipelineEventEmitter } from "@/pipeline";
import { renderTui } from "@/tui";

test("renderTui renders the root app and unmounts cleanly", () => {
  const instance = renderTui({ feature: "tui-entry", stories: [], events: new PipelineEventEmitter() });
  expect(typeof instance.unmount).toBe("function");
  instance.unmount();
});
