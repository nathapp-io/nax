import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { withTempDir } from "@test/helpers";
import type { FindingDisposition } from "@/finish";
import { parseDispositions, validateDispositions } from "@/finish/fix";

describe("parseDispositions", () => {
  test("parses fixed and rejected entries with evidence", () => {
    const d = parseDispositions(
      "## DISPOSITIONS\n[1] fixed\n[2] rejected — evidence: test/unit/config/loader.test.ts:42\n",
    );
    expect(d).toEqual([
      { index: 1, disposition: "fixed" },
      { index: 2, disposition: "rejected", evidence: "test/unit/config/loader.test.ts:42" },
    ]);
  });

  test("returns an empty list when the section is absent", () => {
    expect(parseDispositions('{"route":"proceed"}')).toEqual([]);
  });
});

describe("validateDispositions", () => {
  test("marks evidenceMissing only on a rejected disposition whose cited file is absent", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "real.ts"), "export const x = 1;\n");
      const dispositions: FindingDisposition[] = [
        { index: 1, disposition: "rejected", evidence: "real.ts:12" },
        { index: 2, disposition: "rejected", evidence: "missing.ts:3" },
      ];
      const out = await validateDispositions(dir, dispositions);
      expect(out[0].evidenceMissing).toBeUndefined();
      expect(out[1].evidenceMissing).toBe(true);
    });
  });

  test("leaves fixed dispositions untouched regardless of their evidence field", async () => {
    await withTempDir(async (dir) => {
      const dispositions: FindingDisposition[] = [
        { index: 1, disposition: "fixed", evidence: "missing.ts:3" },
        { index: 2, disposition: "fixed" },
      ];
      const out = await validateDispositions(dir, dispositions);
      expect(out).toEqual(dispositions);
      expect(out[0].evidenceMissing).toBeUndefined();
      expect(out[1].evidenceMissing).toBeUndefined();
    });
  });

  test("leaves a rejected disposition without evidence untouched", async () => {
    await withTempDir(async (dir) => {
      const dispositions: FindingDisposition[] = [{ index: 1, disposition: "rejected" }];
      const out = await validateDispositions(dir, dispositions);
      expect(out[0].evidenceMissing).toBeUndefined();
    });
  });
});
