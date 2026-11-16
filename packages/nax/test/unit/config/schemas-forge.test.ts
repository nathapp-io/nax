/**
 * `forge.kind` root config schema (US-001).
 *
 * `forge` has no schema default: an absent block stays absent from
 * `DEFAULT_CONFIG`, so "the operator named a forge" is distinguishable from
 * "the default is github". A bad value is rejected at parse time rather than
 * ignored, because silently dropping it would leave detection to decide and
 * reproduce the very bug this key exists to fix.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, NaxConfigSchema } from "@/config";

describe("NaxConfigSchema — forge block", () => {
  test("AC-10: accepts forge.kind gitlab and keeps it in the parsed config", () => {
    const result = NaxConfigSchema.safeParse({ forge: { kind: "gitlab" } });

    expect(result.success).toBe(true);
    expect(result.data?.forge?.kind).toBe("gitlab");
  });

  test("AC-11: rejects forge.kind bitbucket and blames forge.kind", () => {
    const result = NaxConfigSchema.safeParse({ forge: { kind: "bitbucket" } });

    expect(result.success).toBe(false);
    const paths = result.error?.issues.map((issue) => issue.path) ?? [];
    expect(paths).toContainEqual(["forge", "kind"]);
  });

  test("no default forge block: an omitted forge stays absent from the derived defaults", () => {
    expect(NaxConfigSchema.parse({}).forge).toBeUndefined();
    expect(DEFAULT_CONFIG.forge).toBeUndefined();
  });
});
