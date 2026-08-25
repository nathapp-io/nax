import { describe, expect, test } from "bun:test";
import { _bunDeps, importGrepFallback, MAX_GREP_TEST_FILES } from "@/verification/smart-runner";

describe("importGrepFallback", () => {
  test("caps the number of scanned test files at MAX_GREP_TEST_FILES", async () => {
    const many = Array.from({ length: 1000 }, (_, i) => `test/a${i}.test.ts`);
    // Patch glob to return 1000 files
    const origGlob = _bunDeps.glob;
    _bunDeps.glob = (() => ({
      async *scan() {
        for (const f of many) yield f;
      },
    })) as any;
    let reads = 0;
    const origFile = _bunDeps.file;
    _bunDeps.file = ((_p: string) => ({
      async text() {
        reads++;
        return "needle";
      },
      async exists() {
        return true;
      },
    })) as any;

    try {
      await importGrepFallback(["src/x.ts"], "/repo", ["test/**/*.test.ts"]);
      expect(reads).toBeLessThanOrEqual(MAX_GREP_TEST_FILES);
    } finally {
      _bunDeps.glob = origGlob;
      _bunDeps.file = origFile;
    }
  });

  test("honors an explicit maxScanFiles cap (config.execution.smartTestRunner.maxScanFiles)", async () => {
    const many = Array.from({ length: 1000 }, (_, i) => `test/a${i}.test.ts`);
    const origGlob = _bunDeps.glob;
    _bunDeps.glob = (() => ({
      async *scan() {
        for (const f of many) yield f;
      },
    })) as any;
    let reads = 0;
    const origFile = _bunDeps.file;
    _bunDeps.file = ((_p: string) => ({
      async text() {
        reads++;
        return "needle";
      },
      async exists() {
        return true;
      },
    })) as any;

    try {
      await importGrepFallback(["src/x.ts"], "/repo", ["test/**/*.test.ts"], 5);
      expect(reads).toBeLessThanOrEqual(5);
    } finally {
      _bunDeps.glob = origGlob;
      _bunDeps.file = origFile;
    }
  });
});
