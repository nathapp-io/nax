import { describe, expect, test } from "vitest";
import { EMPTY_OWNED_PATHS_POLICY } from "#src/index";

describe("owned-paths port on Node", () => {
  test("the empty policy is exported from the public entry and refuses nothing", () => {
    expect(EMPTY_OWNED_PATHS_POLICY.configRefusal("/r", "/r/.nax/config.json")).toBeUndefined();
    expect(EMPTY_OWNED_PATHS_POLICY.deniedEntries).toEqual([]);
  });
});
