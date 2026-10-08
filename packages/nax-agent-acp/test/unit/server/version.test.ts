import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { packageVersion } from "#src/server/version";

describe("packageVersion", () => {
  test("is the version in the package manifest", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
    expect(packageVersion()).toBe(manifest.version);
  });
});
