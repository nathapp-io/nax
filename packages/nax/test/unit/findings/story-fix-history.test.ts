/**
 * src/findings/story-fix-history.ts — the retained factory (US-004).
 *
 * The store's key builder and its iteration/decline writers went with the
 * findings fix cycle (B2b-3). What survives is the factory `createRuntime`
 * calls, so this guard pins its contract: an empty Map, reachable through the
 * `@/findings` barrel.
 */

import { describe, expect, test } from "bun:test";
import { createStoryFixHistory } from "@/findings";

describe("createStoryFixHistory — store shape (US-004)", () => {
  test("returns a Map instance", () => {
    const store = createStoryFixHistory();
    expect(store).toBeInstanceOf(Map);
    expect(store.size).toBe(0);
  });
});
