import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
// biome-ignore lint/style/noRestrictedImports: the reader contract requires a relative leaf import, not the execution barrel.
import { readStatusFile, readStatusFileAt } from "../../../src/execution/status-file-read";

function validStatus() {
  return {
    version: 1,
    run: { id: "r-ok", status: "completed", pid: 123 },
    cost: { spent: 1, limit: null },
    progress: { passed: 1, total: 2 },
  };
}

let dir: string;
beforeEach(() => {
  dir = makeTempDir("status-reader-");
});
afterEach(() => {
  cleanupTempDir(dir);
});

describe("readStatusFile", () => {
  test("AC-1 returns the parsed version-1 file unchanged", async () => {
    const status = validStatus();
    await Bun.write(join(dir, "status.json"), JSON.stringify(status));
    expect(await readStatusFile(dir)).toEqual(status);
  });

  test("AC-2 returns null for a missing file", async () => {
    expect(await readStatusFile(dir)).toBeNull();
  });

  test("AC-3 returns null without throwing for invalid JSON", async () => {
    await Bun.write(join(dir, "status.json"), "not json");
    expect(await readStatusFile(dir)).toBeNull();
  });

  test.each([
    ["AC-4 version 2", { ...validStatus(), version: 2 }],
    ["AC-5 missing run.pid", { ...validStatus(), run: { id: "r-ok", status: "completed" } }],
    ["AC-6 string cost.limit", { ...validStatus(), cost: { spent: 1, limit: "5" } }],
    [
      "AC-7 missing acceptance.status",
      { ...validStatus(), postRun: { acceptance: {}, regression: { status: "passed" } } },
    ],
    ["missing regression.status", { ...validStatus(), postRun: { acceptance: { status: "passed" }, regression: {} } }],
    ["null postRun", { ...validStatus(), postRun: null }],
    ["null root", null],
    ["missing sections", {}],
  ])("returns null for %s", async (_name, status) => {
    await Bun.write(join(dir, "status.json"), JSON.stringify(status));
    expect(await readStatusFile(dir)).toBeNull();
  });

  test("preserves numeric limits and optional postRun statuses", async () => {
    const status = {
      ...validStatus(),
      cost: { spent: 1, limit: 5 },
      postRun: {
        acceptance: { status: "passed" },
        regression: { status: "not-run" },
      },
    };
    await Bun.write(join(dir, "status.json"), JSON.stringify(status));
    expect(await readStatusFile(dir)).toEqual(status);
  });
});

describe("readStatusFileAt", () => {
  test("AC-8 reads a valid file at an arbitrary path", async () => {
    const status = validStatus();
    const path = join(dir, "arbitrary.json");
    await Bun.write(path, JSON.stringify(status));
    expect(await readStatusFileAt(path)).toEqual(status);
  });
});
