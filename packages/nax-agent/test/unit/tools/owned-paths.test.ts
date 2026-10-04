import { describe, expect, test } from "bun:test";
import { EMPTY_OWNED_PATHS_POLICY } from "#src/tools/owned-paths";

describe("EMPTY_OWNED_PATHS_POLICY", () => {
  test("refuses nothing and denies nothing", () => {
    const p = EMPTY_OWNED_PATHS_POLICY;
    expect(p.writeRefusal("Write", ".nax/config.json", { optIns: new Set() })).toBeUndefined();
    expect(p.configRefusal("/r", "/r/.nax/config.json")).toBeUndefined();
    expect(
      p.bashRefusal("Bash", ".queue.txt", [{ lexical: "/r/.queue.txt", rel: ".queue.txt" }], {
        root: "/r",
        verb: "redirects into",
        sandboxWrapped: false,
      }),
    ).toBeUndefined();
    expect(p.deniedEntries).toEqual([]);
    expect(p.rootWriteDenies).toEqual([]);
    expect(p.scratchpadEntry).toBeUndefined();
    expect([...p.writeOptIns("/r", [".nax/rules"])]).toEqual([]);
  });
});
