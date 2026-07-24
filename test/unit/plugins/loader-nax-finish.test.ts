import { afterEach, describe, expect, test } from "bun:test";
import { loadPlugins } from "@/plugins";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

describe("loader registers nax-finish post-run action", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await cleanupTempDir(dir);
    dir = "";
  });

  test("present by default", async () => {
    dir = await makeTempDir();
    const reg = await loadPlugins(dir, dir, [], dir, []);
    expect(reg.getPostRunActions().some((a) => a.name === "nax-finish")).toBe(true);
  });

  test("absent when disabled", async () => {
    dir = await makeTempDir();
    const reg = await loadPlugins(dir, dir, [], dir, ["nax-finish"]);
    expect(reg.getPostRunActions().some((a) => a.name === "nax-finish")).toBe(false);
  });
});
