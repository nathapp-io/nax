import { describe, expect, test } from "bun:test";
import { mapSourceToTests, _bunDeps } from "../../../src/verification/smart-runner";

describe("mapSourceToTests", () => {
  test("runs candidate existence checks concurrently", async () => {
    let active = 0, maxActive = 0;
    const origFile = _bunDeps.file;
    _bunDeps.file = ((p: string) => ({
      async exists() {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 2));
        active--;
        return p.includes("foo");
      },
      async text() { return ""; },
    })) as any;
    try {
      await mapSourceToTests(["src/foo.ts", "src/bar.ts", "src/baz.ts"], "/repo");
      expect(maxActive).toBeGreaterThan(1);
    } finally {
      _bunDeps.file = origFile;
    }
  });
});
