import { describe, expect, test } from "bun:test";
import { _bunDeps, mapSourceToTests } from "@/verification/smart-runner";

describe("mapSourceToTests", () => {
  test("runs candidate existence checks concurrently", async () => {
    let active = 0;
    let maxActive = 0;
    const origFile = _bunDeps.file;
    _bunDeps.file = (p: string) =>
      Object.assign(Bun.file(p), {
        async exists() {
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise((r) => setTimeout(r, 2));
          active--;
          return p.includes("foo");
        },
        async text() {
          return "";
        },
      });
    try {
      await mapSourceToTests(["src/foo.ts", "src/bar.ts", "src/baz.ts"], "/repo");
      expect(maxActive).toBeGreaterThan(1);
    } finally {
      _bunDeps.file = origFile;
    }
  });
});
