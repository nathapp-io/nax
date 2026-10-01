import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { destinationOf, isInMoveSet, loadMoveManifest, parseMoveManifest } from "@scripts/lib/agent-move-manifest";

const SAMPLE = {
  entries: [
    { from: "src/tools/", to: "tools/" },
    { from: "src/agents/session-types.ts", to: "session/session-types.ts" },
  ],
};

describe("parseMoveManifest", () => {
  test("accepts directory and file entries", () => {
    expect(parseMoveManifest(SAMPLE).entries).toHaveLength(2);
  });

  test("rejects an entry outside src/", () => {
    expect(() => parseMoveManifest({ entries: [{ from: "scripts/x.ts", to: "x.ts" }] })).toThrow(
      "must start with src/",
    );
  });

  test("rejects a directory entry whose destination is not a directory", () => {
    expect(() => parseMoveManifest({ entries: [{ from: "src/tools/", to: "tools.ts" }] })).toThrow("directory");
  });

  test("rejects a file entry that is not a .ts file", () => {
    expect(() => parseMoveManifest({ entries: [{ from: "src/a.json", to: "a.json" }] })).toThrow(".ts");
  });

  test("rejects duplicate sources", () => {
    const dup = { entries: [SAMPLE.entries[0], SAMPLE.entries[0]] };
    expect(() => parseMoveManifest(dup)).toThrow("duplicate");
  });

  test("rejects a file entry already covered by a directory entry", () => {
    const covered = {
      entries: [
        { from: "src/tools/", to: "tools/" },
        { from: "src/tools/git.ts", to: "tools/git.ts" },
      ],
    };
    expect(() => parseMoveManifest(covered)).toThrow("already covered");
  });
});

describe("membership and destination", () => {
  const m = parseMoveManifest(SAMPLE);

  test("a file under a directory entry is in the set", () => {
    expect(isInMoveSet(m, "src/tools/git.ts")).toBe(true);
    expect(destinationOf(m, "src/tools/git-flags/index.ts")).toBe("tools/git-flags/index.ts");
  });

  test("a single-file entry maps exactly", () => {
    expect(isInMoveSet(m, "src/agents/session-types.ts")).toBe(true);
    expect(destinationOf(m, "src/agents/session-types.ts")).toBe("session/session-types.ts");
  });

  test("a sibling with a shared prefix is not in the set", () => {
    expect(isInMoveSet(m, "src/tools-extra/a.ts")).toBe(false);
    expect(isInMoveSet(m, "src/agents/session-types-old.ts")).toBe(false);
    expect(destinationOf(m, "src/agents/types.ts")).toBeUndefined();
  });
});

describe("committed manifest", () => {
  test("loads and every entry exists on disk", () => {
    const pkgRoot = join(import.meta.dir, "../../..");
    const m = loadMoveManifest(join(pkgRoot, "scripts/s1-move-manifest.json"));
    const missing = m.entries.map((e) => e.from).filter((from) => !existsSync(join(pkgRoot, from)));
    expect(missing).toEqual([]);
    expect(isInMoveSet(m, "src/agents/native/adapter.ts")).toBe(true);
    expect(isInMoveSet(m, "src/agents/tool-preamble.ts")).toBe(false);
  });
});
