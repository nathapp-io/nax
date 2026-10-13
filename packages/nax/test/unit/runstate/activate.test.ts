import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { activateRunState, activeKeepers } from "@/runstate";

let dir: string;

beforeEach(() => {
  dir = makeTempDir();
});

afterEach(() => {
  cleanupTempDir(dir);
});

describe("activateRunState (#2497)", () => {
  test("seeds prd.json, status.json and decisions.jsonl that exist; deactivate unregisters and unhooks", async () => {
    mkdirSync(join(dir, ".nax/features/f"), { recursive: true });
    writeFileSync(join(dir, ".nax/features/f/prd.json"), "{}");
    writeFileSync(join(dir, ".nax/features/f/decisions.jsonl"), "");
    const handle = await activateRunState({ runId: "r1", feature: "f", root: dir });
    expect(
      handle.keeper
        .files()
        .map((f) => f.kind)
        .sort(),
    ).toEqual(["decisions", "prd"]);
    expect(activeKeepers()).toContain(handle.keeper);
    handle.deactivate();
    expect(activeKeepers()).not.toContain(handle.keeper);
  });
});
